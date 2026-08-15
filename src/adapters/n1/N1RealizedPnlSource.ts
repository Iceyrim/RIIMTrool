import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountPnlInfo, Nord } from "@n1xyz/nord-ts";
import type { RealizedPnlSource } from "../../paperRunner/PaperRunner.js";
import { ExchangeAdapterError } from "../AdapterError.js";
import type { ConfiguredMarket } from "./marketRegistry.js";

/** One market's resume point into N1's PnL history. `time` is an inclusive lower bound for the
 * next query; `keysAtTime` records every entry already summed at exactly that timestamp so a
 * repeat of the same boundary instant on the next drain doesn't get double-counted. Mirrors
 * RiseXPaperAdapter's (lastSeenTime, idsSeenAtThatTime) trade-tape cursor — N1's PnL history has
 * the same "timestamp alone isn't a unique sort key" property once ties are possible. */
interface AccountPnlCursor {
  time: string;
  keysAtTime: string[];
}

interface PersistedAnchor {
  version: 2;
  scope: "account";
  cursor: AccountPnlCursor;
}

export interface N1RealizedPnlSourceConfig {
  nord: Nord;
  accountId: number;
  /** Where the session anchor cursor is persisted (state/live/pnl-session-anchor.json in
   * scripts/run-live.ts). Session PnL is deliberately durable across restarts — only deleting
   * this file resets it. */
  anchorFilePath: string;
  /** Safety cap on drainRealizedPnlDeltaUsd()'s intra-call pagination, mirroring
   * RiseXAdapter's maxOrderFillsPages/maxVolumePages convention: throw rather than silently
   * truncate a backlog that's larger than expected. */
  maxPagesPerDrain?: number;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES_PER_DRAIN = 50;

function pnlEntryKey(entry: AccountPnlInfo): string {
  return `${entry.actionId}:${entry.subActionId}:${entry.marketId}`;
}

const MANUAL_ARCHIVE_COMMAND =
  'mv state/live/pnl-session-anchor.json "state/live/pnl-session-anchor.per-market.$(date -u +%Y%m%dT%H%M%SZ).json"';

/**
 * Real N1 realized-PnL source, replacing scripts/run-live.ts's former always-zero stub. Wraps
 * N1's own authoritative realized-PnL ledger (`Nord.getAccountPnl`) rather than deriving PnL
 * from locally-observed fills — the same "trust the exchange's own numbers" principle N1Adapter
 * already applies to positions/balances/margin.
 *
 * Sums only `tradingPnl` from each entry, deliberately EXCLUDING `settledFundingPnl` — this
 * matches paper-mode semantics, where N1PaperAdapter/StubAdapter/RiseXPaperAdapter's simulated
 * `drainRealizedPnlDeltaUsd()` only ever accounts for trade-driven PnL (RiseXPaperAdapter's
 * funding cash-settlement is the one deliberate exception, and it has no N1 live equivalent
 * wired here). RiskManager's sessionLossCapUsd is therefore a trading-loss cap, not an
 * all-in-PnL cap, in both paper and live mode alike — funding drag/income never trips or masks
 * it. If that ever needs to change, it must change for paper and live together, not just here.
 *
 * initialize() must be called once (after the owning N1Adapter has connect()-ed) before any
 * drain. It establishes a persisted per-market "session anchor" cursor — the pre-session PnL
 * history boundary — on a genuinely fresh process, or loads the existing one across a restart
 * (session PnL is deliberately durable; only deleting the anchor file resets it). Either way it
 * always makes a live probe call per market: a stale local file must never substitute for
 * confirming N1's PnL endpoint is actually reachable and returning well-formed data before a
 * human is asked to confirm live trading.
 *
 * Every failure mode here throws rather than returning 0 — a silent zero is exactly what let
 * run-live.ts's old stub quietly disable the session loss cap. Callers (PaperRunner) are
 * expected to catch and route into MarketEngine.markSessionPnlUnavailable(), which blocks all
 * new placement until a subsequent drain succeeds.
 */
export class N1RealizedPnlSource implements RealizedPnlSource {
  readonly scope = "account" as const;
  private cursor?: AccountPnlCursor;
  private readonly maxPagesPerDrain: number;
  private initialized = false;

  constructor(private readonly config: N1RealizedPnlSourceConfig) {
    this.maxPagesPerDrain = config.maxPagesPerDrain ?? DEFAULT_MAX_PAGES_PER_DRAIN;
  }

  async initialize(markets: ConfiguredMarket[]): Promise<void> {
    const persisted = this.loadPersistedAnchor();
    const nowIso = new Date().toISOString();
    if (markets.length === 0) throw new ExchangeAdapterError("At least one N1 market is required");
    await this.probe();
    this.cursor = persisted?.cursor ?? { time: nowIso, keysAtTime: [] };

    this.persistAnchor();
    this.initialized = true;
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.cursor) {
      throw new ExchangeAdapterError("N1RealizedPnlSource.initialize() must be called before use");
    }
  }

  /** Only ever called from initialize(), after this.registry is already assigned — does not
   * assert initialized itself since this runs before this.initialized flips true. */
  private async probe(): Promise<void> {
    // pageSize: 1 — this call exists purely to prove connectivity/auth/response-shape before
    // startup proceeds, not to fetch anything usable.
    await this.fetchAccountPnlPage({ pageSize: 1 });
  }

  private async fetchAccountPnlPage(
    query: { since?: string; until?: string; startInclusive?: string; pageSize?: number },
  ): Promise<{ items: AccountPnlInfo[]; nextStartInclusive?: string | null }> {
    let page: { items: AccountPnlInfo[]; nextStartInclusive?: string | null };
    try {
      page = await this.config.nord.getAccountPnl(this.config.accountId, query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ExchangeAdapterError(`N1 getAccountPnl() request failed: ${message}`, err, true);
    }
    if (!page || !Array.isArray(page.items)) {
      throw new ExchangeAdapterError(
        `N1 getAccountPnl() returned a malformed response: ${JSON.stringify(page)}`,
      );
    }
    return page;
  }

  /** Pages getAccountPnl forward from this market's cursor to now, sums fresh tradingPnl
   * entries (inclusive-boundary deduped against the cursor), and advances the cursor. Throws
   * on any network failure or malformed data — never substitutes 0. */
  async drainRealizedPnlDeltaUsd(): Promise<number> {
    this.assertInitialized();
    const cursor = this.cursor!;
    const until = new Date().toISOString();

    const items: AccountPnlInfo[] = [];
    let startInclusive: string | undefined;
    for (let page = 1; ; page++) {
      if (page > this.maxPagesPerDrain) {
        throw new ExchangeAdapterError(
          `N1RealizedPnlSource.drainRealizedPnlDeltaUsd(): exceeded maxPagesPerDrain ` +
            `(${this.maxPagesPerDrain}) without exhausting PnL history since ${cursor.time} — ` +
            "widen the cap or investigate an unexpectedly large backlog",
        );
      }
      const result = await this.fetchAccountPnlPage({
        since: cursor.time,
        until,
        startInclusive,
        pageSize: DEFAULT_PAGE_SIZE,
      });
      items.push(...result.items);
      if (!result.nextStartInclusive) break;
      startInclusive = result.nextStartInclusive;
    }

    const seenAtBoundary = new Set(cursor.keysAtTime);
    const fresh = items.filter(
      (item) => !(item.time === cursor.time && seenAtBoundary.has(pnlEntryKey(item))),
    );

    let maxTime = cursor.time;
    let keysAtMaxTime = [...cursor.keysAtTime];
    let delta = 0;

    for (const item of fresh) {
      if (typeof item.tradingPnl !== "number" || !Number.isFinite(item.tradingPnl)) {
        throw new ExchangeAdapterError(
          `N1RealizedPnlSource got a malformed tradingPnl entry: ` +
            JSON.stringify(item),
        );
      }
      delta += item.tradingPnl; // deliberately excludes settledFundingPnl — see class doc comment

      if (item.time > maxTime) {
        maxTime = item.time;
        keysAtMaxTime = [pnlEntryKey(item)];
      } else if (item.time === maxTime) {
        keysAtMaxTime.push(pnlEntryKey(item));
      }
    }

    this.cursor = { time: maxTime, keysAtTime: [...new Set(keysAtMaxTime)] };
    this.persistAnchor();
    return delta;
  }

  private loadPersistedAnchor(): PersistedAnchor | undefined {
    if (!existsSync(this.config.anchorFilePath)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.config.anchorFilePath, "utf-8"));
    } catch (err) {
      throw new ExchangeAdapterError(
        `Failed to parse PnL session anchor at "${this.config.anchorFilePath}" — refusing to ` +
          "guess a fresh boundary, since that could silently exclude or double-count real " +
          "session PnL. Delete the file deliberately to reset, if that's genuinely intended.",
        err,
      );
    }
    if (typeof raw !== "object" || raw === null || (raw as PersistedAnchor).version !== 2 ||
        (raw as PersistedAnchor).scope !== "account" || typeof (raw as PersistedAnchor).cursor !== "object") {
      throw new ExchangeAdapterError(
        `PnL session anchor at "${this.config.anchorFilePath}" is an incompatible per-market or ` +
          `malformed anchor. Refusing automatic conversion because it could omit or double-count ` +
          `account PnL. After directly confirming the account is flat, archive it with exactly:\n` +
          MANUAL_ARCHIVE_COMMAND,
      );
    }
    return raw as PersistedAnchor;
  }

  private persistAnchor(): void {
    const anchor: PersistedAnchor = { version: 2, scope: "account", cursor: this.cursor! };
    mkdirSync(dirname(this.config.anchorFilePath), { recursive: true });
    writeFileSync(this.config.anchorFilePath, JSON.stringify(anchor, null, 2), "utf-8");
  }
}
