import "../../utils/polyfills.js";
import { Nord, NordUser, Side } from "@n1xyz/nord-ts";
import type { TradeFromApi } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import type {
  AccountVolume,
  CancelOrderResult,
  ExchangeAdapter,
  MarketPrice,
  NormalizedBalance,
  NormalizedFill,
  NormalizedMarginStatus,
  NormalizedOrder,
  NormalizedPosition,
  PlaceOrderParams,
  PlaceOrderResult,
} from "../ExchangeAdapter.js";
import { ExchangeAdapterError } from "../AdapterError.js";
import { MarketRegistry, type ConfiguredMarket } from "./marketRegistry.js";
import {
  mapBalance,
  mapFill,
  mapMarginStatus,
  mapMarketPrice,
  mapOpenOrder,
  mapPosition,
  n1SideToOrderSide,
  orderSideToN1Side,
  orderTypeToFillMode,
} from "./mappers.js";

export interface N1AdapterConfig {
  webServerUrl: string;
  appAddr: string;
  solanaRpcUrl: string;
  /** Raw private key material. Callers must source this from a real secret store / .env at the
   * process boundary — never hardcode it, never let it pass through an AI coding session
   * (SPEC.md Section 9.1). */
  privateKey: string;
  markets: ConfiguredMarket[];
}

/** How far ahead of a session's tracked expiry ensureSession() proactively renews it. The SDK's
 * own default session TTL is 30 days (SESSION_TTL), so this margin is deliberately generous
 * relative to it — renewal is cheap (one signed action) and checked every cycle via
 * refreshAccountState(), so there is no cost to erring on the early side. */
const SESSION_REFRESH_MARGIN_SEC = 3600n;
const MAX_CLIENT_ORDER_ID = 2n ** 63n;
const ACCOUNT_TRADES_PAGE_SIZE = 50;
/** Hard telemetry-only bound: at most 1,000 pages per maker/taker stream (100,000 rows before
 * cross-stream tradeId deduplication). Hitting it rejects the entire scan; partial totals are
 * never returned or cached. */
export const MAX_ACCOUNT_TRADE_PAGES_PER_STREAM = 1_000;

interface AccountTradeScan {
  until: string;
  trades: readonly TradeFromApi[];
}

interface AccountTradeCursor {
  role: 0 | 1;
  start?: number;
  pages: number;
  seenTradeIds: number[];
}

/** Walks an Error's `.cause` chain (bounded depth) and joins every message into one string, so a
 * doubly-wrapped SDK error (e.g. nord-ts's own `NordError("Failed to place order", { cause })`)
 * surfaces its real underlying reason instead of just the outer wrapper's generic message. */
function describeError(err: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < maxDepth && current !== undefined; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(": caused by: ");
}

/**
 * N1 (Nord) implementation of ExchangeAdapter. This is the ONLY file (along with mappers.ts and
 * marketRegistry.ts in this directory) permitted to import `@n1xyz/nord-ts` — SPEC.md Section 1b.
 *
 * v1 uses REST polling only: refreshAccountState() must be called once per market-loop cycle,
 * and getPositions/getOpenOrders/getBalances/getMarginStatus all read from that cached snapshot
 * rather than issuing their own request each time. This mirrors how NordUser itself actually
 * works (fetchInfo() populates .positions/.orders/.balances/.margins together, then those are
 * read synchronously) and avoids a torn read across a market-loop cycle.
 */
export class N1Adapter implements ExchangeAdapter {
  readonly exchangeId = "n1";

  private readonly registry: MarketRegistry;
  private nord?: Nord;
  private user?: NordUser;
  private accountId?: number;
  /** Server-clock (nord.getTimestamp()) unix-seconds expiry of the currently established
   * session, or undefined if no session has ever been established yet. Tracked so ensureSession()
   * can decide when to proactively renew without re-deriving it from the SDK each time. */
  private sessionExpiresAtSec?: bigint;
  private accountTradeScan?: AccountTradeScan;
  private accountTradeScanInFlight?: Promise<AccountTradeScan>;

  constructor(private readonly config: N1AdapterConfig) {
    this.registry = new MarketRegistry(config.markets);
  }

  private assertConnected(): void {
    if (!this.nord || !this.user || this.accountId === undefined) {
      throw new ExchangeAdapterError("N1Adapter.connect() must be called before use");
    }
  }

  /** Establishes a session on first call (SPEC.md line 223: one-time signature at connect()) and
   * proactively renews it once the tracked expiry comes within SESSION_REFRESH_MARGIN_SEC —
   * called every cycle via refreshAccountState() and defensively again in placeOrder() itself, so
   * a long-running live process never silently starts failing every placement again just because
   * its session aged out mid-run. Every signed session action (placeOrder, cancelOrder, ...)
   * requires this to have run first — the SDK's own checkSessionValidity() throws otherwise. */
  private async ensureSession(): Promise<void> {
    const now = await this.nord!.getTimestamp();
    if (this.sessionExpiresAtSec !== undefined && now + SESSION_REFRESH_MARGIN_SEC < this.sessionExpiresAtSec) {
      return;
    }
    const result = await this.user!.refreshSession();
    this.sessionExpiresAtSec = result.expiry;
  }

  async connect(): Promise<void> {
    const solanaConnection = new Connection(this.config.solanaRpcUrl);
    this.nord = await Nord.new({
      webServerUrl: this.config.webServerUrl,
      app: this.config.appAddr,
      solanaConnection,
    });

    // Explicit call even though Nord.new()'s internal init likely already does this — cheap,
    // idempotent, and removes any doubt that `nord.markets` is populated before we resolve
    // configured symbols against it.
    await this.nord.fetchNordInfo();
    this.registry.resolve(this.nord.markets);

    this.user = NordUser.fromPrivateKey(this.nord, this.config.privateKey);
    await this.user.updateAccountId();

    const accountId = this.user.accountIds?.[0];
    if (accountId === undefined) {
      throw new ExchangeAdapterError(
        "N1 account has no accountIds after updateAccountId() — is this wallet registered on N1?",
      );
    }
    this.accountId = accountId;

    // Establishes the signed session real order placement needs — a failure here must abort
    // startup, same as every other stage 4-7 failure in scripts/run-live.ts, never leave the
    // process running with an adapter that can read state but can never place an order.
    await this.ensureSession();

    await this.user.fetchInfo();
  }

  /** Exposes the underlying connected Nord client and accountId — not part of ExchangeAdapter,
   * N1-specific. Exists for callers that need N1 account-history endpoints beyond what
   * ExchangeAdapter's normalized surface covers (currently only N1RealizedPnlSource, wired up in
   * scripts/run-live.ts). */
  getNordClient(): Nord {
    this.assertConnected();
    return this.nord!;
  }

  getAccountId(): number {
    this.assertConnected();
    return this.accountId!;
  }

  async disconnect(): Promise<void> {
    // v1 is REST-polling only (no WebSocket subscriptions), so there is no live connection to
    // tear down. Kept as an explicit no-op so the interface stays symmetric for adapters (or a
    // future N1 WS-based revision) that do hold one.
  }

  async refreshAccountState(): Promise<void> {
    this.assertConnected();
    await this.ensureSession();
    await this.user!.fetchInfo();
  }

  getPositions(market?: string): NormalizedPosition[] {
    this.assertConnected();
    const raw = this.user!.positions[String(this.accountId)] ?? [];
    const mapped = raw
      .map((p) => mapPosition(p, this.registry))
      .filter((p): p is NormalizedPosition => p !== null);
    return market ? mapped.filter((p) => p.market === market) : mapped;
  }

  getOpenOrders(market?: string): NormalizedOrder[] {
    this.assertConnected();
    const raw = this.user!.orders[String(this.accountId)] ?? [];
    const mapped = raw.map((o) => mapOpenOrder(o, this.registry));
    return market ? mapped.filter((o) => o.market === market) : mapped;
  }

  getBalances(): NormalizedBalance[] {
    this.assertConnected();
    const raw = this.user!.balances[String(this.accountId)] ?? [];
    return raw.map(mapBalance);
  }

  getMarginStatus(): NormalizedMarginStatus {
    this.assertConnected();
    const raw = this.user!.margins[String(this.accountId)];
    if (!raw) {
      throw new ExchangeAdapterError(
        `No margin data cached for account ${this.accountId} — call refreshAccountState() first`,
      );
    }
    return mapMarginStatus(raw);
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    this.assertConnected();
    const marketId = this.registry.marketIdFor(params.market);

    let clientOrderId: bigint | undefined;
    if (params.clientOrderId !== undefined) {
      if (!/^\d+$/.test(params.clientOrderId)) {
        return {
          success: false,
          reason: "REJECTED",
          message: `clientOrderId "${params.clientOrderId}" is not a valid decimal integer`,
        };
      }
      try {
        clientOrderId = BigInt(params.clientOrderId);
      } catch (err) {
        return {
          success: false,
          reason: "REJECTED",
          message: `clientOrderId "${params.clientOrderId}" is not a valid integer`,
          raw: err,
        };
      }
      if (clientOrderId <= 0n || clientOrderId >= MAX_CLIENT_ORDER_ID) {
        return {
          success: false,
          reason: "REJECTED",
          message: `clientOrderId "${params.clientOrderId}" must be greater than zero and less than 2^63`,
        };
      }
    }

    try {
      // Defense in depth: refreshAccountState() already renews the session once per cycle, but
      // placeOrder() re-checks here too so the money-critical path never depends on that having
      // run first in the same cycle.
      await this.ensureSession();
      const result = await this.user!.placeOrder({
        marketId,
        side: orderSideToN1Side(params.side) === "bid" ? Side.Bid : Side.Ask,
        fillMode: orderTypeToFillMode(params.type),
        isReduceOnly: params.isReduceOnly,
        size: params.size,
        price: params.price,
        clientOrderId,
      });

      // SPEC.md Section 5b: a resolved call with neither an orderId nor any fills is a silent
      // no-op on N1's side. This must never be treated as success just because the promise
      // didn't reject — that exact gap is how a real reduction-mode exit order sat unmanaged
      // for ~12 hours in the predecessor system.
      if (result.orderId === undefined && result.fills.length === 0) {
        return {
          success: false,
          reason: "UNRESOLVED_NOT_CONFIRMED",
          message:
            "N1 placeOrder() resolved without an orderId or any fills — not confirmed on exchange",
          raw: result,
        };
      }

      // Fills reported synchronously here carry no tradeId (N1's placeOrder response type omits
      // it) — see NormalizedFill's doc comment. Trade-level detail with a real tradeId comes from
      // getOrderFills() once the order is resting.
      const fills: NormalizedFill[] = result.fills.map((f) => ({
        exchangeOrderId: String(f.orderId),
        market: params.market,
        side: params.side,
        price: f.price,
        size: f.size,
        timestamp: Date.now(),
      }));

      const filledSize = fills.reduce((sum, f) => sum + f.size, 0);
      const exchangeOrderId =
        result.orderId !== undefined ? String(result.orderId) : String(result.actionId);

      const order: NormalizedOrder = {
        exchangeOrderId,
        clientOrderId: params.clientOrderId,
        market: params.market,
        side: params.side,
        type: params.type,
        price: params.price,
        size: params.size,
        filledSize,
        remainingSize: Math.max(0, params.size - filledSize),
        isReduceOnly: params.isReduceOnly,
        state:
          result.orderId === undefined
            ? filledSize >= params.size
              ? "filled"
              : "partiallyFilled"
            : filledSize > 0
              ? "partiallyFilled"
              : "open",
      };

      return { success: true, order, fills };
    } catch (err) {
      return {
        success: false,
        reason: "REJECTED",
        // Flattens the .cause chain so a doubly-wrapped SDK error (e.g. nord-ts's own generic
        // "Failed to place order" wrapping a specific "Invalid or empty session ID..." cause)
        // surfaces the real underlying reason here, not just the outer wrapper's message.
        message: describeError(err),
        raw: err,
      };
    }
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    this.assertConnected();
    try {
      const result = await this.user!.cancelOrder(BigInt(exchangeOrderId));
      return { success: true, exchangeOrderId: String(result.orderId) };
    } catch (err) {
      throw new ExchangeAdapterError(
        `Failed to cancel order ${exchangeOrderId} on market ${market}`,
        err,
        true,
      );
    }
  }

  async getOrderFills(exchangeOrderId: string, _market: string): Promise<NormalizedFill[]> {
    this.assertConnected();
    // N1's getOrderTrades takes a `number` orderId; order ids observed in practice fit safely
    // in a JS number, but this is worth confirming against real account data before relying on
    // it for very large ids.
    const page = await this.nord!.getOrderTrades(Number(exchangeOrderId));
    return page.items.map((trade) => mapFill(trade, this.registry, this.accountId!));
  }

  async getMarketPrice(market: string): Promise<MarketPrice> {
    this.assertConnected();
    const marketId = this.registry.marketIdFor(market);
    const stats = await this.nord!.getMarketStats({ marketId });
    return mapMarketPrice(market, stats);
  }

  async getAccountVolume(params: {
    market?: string;
    since: string;
    until: string;
  }): Promise<AccountVolume[]> {
    this.assertConnected();
    const sinceMs = Date.parse(params.since);
    const untilMs = Date.parse(params.until);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) {
      throw new ExchangeAdapterError("Invalid N1 account-volume time window");
    }
    const requestedMarketId = params.market ? this.registry.marketIdFor(params.market) : undefined;
    const scan = await this.getCompleteAccountTradeScan(params.until);
    const totals = new Map<number, { base: number; quote: number }>();
    for (const trade of scan.trades) {
      const timeMs = Date.parse(trade.time);
      if (timeMs < sinceMs || timeMs >= untilMs) continue;
      if (requestedMarketId !== undefined && trade.marketId !== requestedMarketId) continue;
      const current = totals.get(trade.marketId) ?? { base: 0, quote: 0 };
      current.base += Math.abs(trade.baseSize);
      current.quote += Math.abs(trade.baseSize) * trade.price;
      if (!Number.isFinite(current.base) || !Number.isFinite(current.quote)) {
        throw new ExchangeAdapterError(`Non-finite N1 volume total for marketId ${trade.marketId}`);
      }
      totals.set(trade.marketId, current);
    }
    return [...totals.entries()].sort(([a], [b]) => a - b).map(([marketId, total]) => ({
      market: this.registry.symbolForVolume(marketId),
      marketId,
      since: params.since,
      until: params.until,
      baseVolume: total.base,
      quoteVolume: total.quote,
    }));
  }

  private getCompleteAccountTradeScan(until: string): Promise<AccountTradeScan> {
    if (this.accountTradeScan?.until === until) return Promise.resolve(this.accountTradeScan);
    if (this.accountTradeScanInFlight) return this.accountTradeScanInFlight.then((scan) => {
      if (scan.until !== until) return this.getCompleteAccountTradeScan(until);
      return scan;
    });
    const scan = this.scanAccountTrades(until);
    this.accountTradeScanInFlight = scan;
    void scan.then((complete) => { this.accountTradeScan = complete; }, () => undefined)
      .finally(() => { if (this.accountTradeScanInFlight === scan) this.accountTradeScanInFlight = undefined; });
    return scan;
  }

  private async scanAccountTrades(until: string): Promise<AccountTradeScan> {
    const byTradeId = new Map<number, TradeFromApi>();
    for (const role of ["makerId", "takerId"] as const) {
      let cursor: number | undefined;
      const seenCursors = new Set<number>();
      const seenTradeIds = new Set<number>();
      let exhausted = false;
      for (let pageNumber = 0; pageNumber < MAX_ACCOUNT_TRADE_PAGES_PER_STREAM; pageNumber++) {
        const response = await this.nord!.getTrades({
          [role]: this.accountId!,
          since: new Date(0).toISOString(),
          until,
          pageSize: ACCOUNT_TRADES_PAGE_SIZE,
          startInclusive: cursor,
          paginationMode: "tradeId",
        });
        if (!response || !Array.isArray(response.items)) {
          throw new ExchangeAdapterError(`Malformed N1 ${role} trade page`);
        }
        let previousTradeId: number | undefined;
        let newTradeCount = 0;
        for (const trade of response.items) {
          if (!this.isValidAccountTrade(trade)) {
            throw new ExchangeAdapterError(`Malformed N1 ${role} trade row`);
          }
          if (previousTradeId !== undefined && trade.tradeId > previousTradeId) {
            throw new ExchangeAdapterError(`Wrong-direction N1 ${role} trade page`);
          }
          previousTradeId = trade.tradeId;
          if (!seenTradeIds.has(trade.tradeId)) {
            seenTradeIds.add(trade.tradeId);
            newTradeCount++;
          }
          byTradeId.set(trade.tradeId, trade);
        }
        const next = response.nextStartInclusive ?? undefined;
        if (next === undefined) {
          if (pageNumber > 0 && newTradeCount === 0) {
            throw new ExchangeAdapterError(`Incomplete N1 ${role} trade scan: continuation page added no new trades`);
          }
          exhausted = true;
          break;
        }
        if (response.items.length === 0) {
          throw new ExchangeAdapterError(`Incomplete N1 ${role} trade scan: empty page has a continuation cursor`);
        }
        if (!Number.isSafeInteger(next) || next < 0) {
          throw new ExchangeAdapterError(`Invalid N1 ${role} trade cursor ${String(next)}`);
        }
        if (seenCursors.has(next) || (cursor !== undefined && next >= cursor)) {
          throw new ExchangeAdapterError(`Invalid or repeated N1 ${role} trade cursor ${String(next)}`);
        }
        if (pageNumber > 0 && newTradeCount === 0) {
          throw new ExchangeAdapterError(`Incomplete N1 ${role} trade scan: continuation page added no new trades`);
        }
        seenCursors.add(next);
        cursor = next;
      }
      if (!exhausted) {
        throw new ExchangeAdapterError(
          `Incomplete N1 ${role} trade scan: exceeded ${MAX_ACCOUNT_TRADE_PAGES_PER_STREAM}-page safety cap`,
        );
      }
    }
    return { until, trades: [...byTradeId.values()].sort((a, b) => a.tradeId - b.tradeId) };
  }

  async getAccountTradeHistoryPage(params: { since: string; until: string; cursor?: string }): Promise<{ trades: NormalizedFill[]; nextCursor?: string }> {
    this.assertConnected();
    const sinceMs = Date.parse(params.since), untilMs = Date.parse(params.until);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) throw new ExchangeAdapterError("Invalid N1 account-trade time window");
    let state: AccountTradeCursor = { role: 0, pages: 0, seenTradeIds: [] };
    if (params.cursor) {
      try { state = JSON.parse(params.cursor) as AccountTradeCursor; } catch (error) { throw new ExchangeAdapterError(`Malformed N1 trade cursor: ${String(error)}`); }
      if ((state.role !== 0 && state.role !== 1) || !Number.isSafeInteger(state.pages) || state.pages < 0 || !Array.isArray(state.seenTradeIds) || state.seenTradeIds.some((id) => !Number.isSafeInteger(id) || id < 0) || (state.start !== undefined && (!Number.isSafeInteger(state.start) || state.start < 0))) throw new ExchangeAdapterError("Malformed N1 trade cursor state");
    }
    if (state.pages >= MAX_ACCOUNT_TRADE_PAGES_PER_STREAM) throw new ExchangeAdapterError(`Incomplete N1 trade scan: exceeded ${MAX_ACCOUNT_TRADE_PAGES_PER_STREAM}-page safety cap`);
    const roles: Array<"takerId" | "makerId"> = ["takerId", "makerId"];
    const response = await this.nord!.getTrades({ [roles[state.role]!]: this.accountId!, since: params.since, until: params.until, startInclusive: state.start, pageSize: ACCOUNT_TRADES_PAGE_SIZE, paginationMode: "tradeId" });
    if (!response || !Array.isArray(response.items)) throw new ExchangeAdapterError("Malformed N1 trade page");
    const seen = new Set(state.seenTradeIds), trades: NormalizedFill[] = [];
    let previousTradeId: number | undefined, newTradeCount = 0;
    for (const trade of response.items) {
      if (!this.isValidAccountTrade(trade)) throw new ExchangeAdapterError("Malformed N1 account trade row");
      if (previousTradeId !== undefined && trade.tradeId > previousTradeId) throw new ExchangeAdapterError("Wrong-direction N1 account trade page");
      previousTradeId = trade.tradeId;
      if (seen.has(trade.tradeId)) continue;
      seen.add(trade.tradeId); newTradeCount++;
      const market = this.registry.symbolForVolume(trade.marketId);
      if (market !== null) trades.push(mapFill(trade, this.registry, this.accountId!));
      else { const n1Side = trade.takerId === this.accountId ? trade.takerSide : trade.takerSide === "bid" ? "ask" : "bid"; trades.push({ exchangeOrderId: String(trade.orderId), tradeId: String(trade.tradeId), market: `N1:${trade.marketId}`, side: n1SideToOrderSide(n1Side), price: trade.price, size: trade.baseSize, timestamp: Date.parse(trade.time) }); }
    }
    const nextStart = response.nextStartInclusive ?? undefined;
    if (nextStart !== undefined && (!Number.isSafeInteger(nextStart) || nextStart < 0 || (state.start !== undefined && nextStart >= state.start))) throw new ExchangeAdapterError(`Invalid or repeated N1 trade cursor ${String(nextStart)}`);
    if (nextStart !== undefined && response.items.length === 0) throw new ExchangeAdapterError("Incomplete N1 trade scan: empty page has a continuation cursor");
    if (state.start !== undefined && newTradeCount === 0) throw new ExchangeAdapterError("Incomplete N1 trade scan: continuation page added no new trades");
    const next: AccountTradeCursor | undefined = nextStart !== undefined ? { ...state, start: nextStart, pages: state.pages + 1, seenTradeIds: [...seen] } : state.role === 0 ? { role: 1, pages: 0, seenTradeIds: [...seen] } : undefined;
    return { trades, nextCursor: next ? JSON.stringify(next) : undefined };
  }

  private isValidAccountTrade(trade: TradeFromApi): boolean {
    return Number.isSafeInteger(trade.tradeId) && trade.tradeId >= 0
      && Number.isSafeInteger(trade.marketId) && trade.marketId >= 0
      && Number.isFinite(Date.parse(trade.time))
      && Number.isFinite(trade.price) && trade.price >= 0
      && Number.isFinite(trade.baseSize) && trade.baseSize >= 0
      && Number.isSafeInteger(trade.makerId) && Number.isSafeInteger(trade.takerId)
      && (trade.makerId === this.accountId || trade.takerId === this.accountId);
  }
}
