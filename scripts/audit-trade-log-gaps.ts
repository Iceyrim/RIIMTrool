/**
 * Read-only audit for the residual SPEC.md Section 5a gap: OrderLifecycle.cancelOrder()'s single
 * fill-replay snapshot (before this fix) could finalize an order CANCELLED without ever seeing a
 * fill that landed in the gap between that snapshot and the exchange actually finishing the
 * cancel — and once terminal, Reconciliation never looked at that exchangeOrderId again. That's
 * the mechanism found for why trades-ETHUSD.jsonl's net signed volume drifted to -0.887 base
 * while the live-logged real position stayed within its ±0.15 risk limit the whole time (see
 * conversation / SPEC.md Section 5a).
 *
 * This script does NOT try to repair anything live. It:
 *   1. Reads the local durable trade log (state/live/trades-{MARKET}.jsonl) for each market.
 *   2. Pages N1's own account-wide trade history (N1Adapter.getAccountTradeHistoryPage() —
 *      the same account-wide, cursor-based mechanism N1RealizedPnlSource already uses for
 *      session-realized-PnL) across the local log's time range.
 *   3. Diffs tradeIds: real-exchange trades minus locally-logged trades = orphaned/missing fills.
 *   4. Writes anything found to a SEPARATE file, state/live/trades-{MARKET}.recovered-gaps.jsonl —
 *      it never rewrites or appends to the real trades-{MARKET}.jsonl. Merging recovered fills
 *      into the durable log is a deliberate, human-reviewed step, not something this script does.
 *
 * It does not use the local OrderRegistry at all — deliberately. Terminal (CANCELLED/FILLED)
 * registry entries get pruned on a schedule (OrderRegistry.prune()), so old exchangeOrderId->size
 * links for exactly the orders this audit cares about may already be gone. Diffing against N1's
 * own trade history sidesteps that entirely.
 *
 * getAccountTradeHistoryPage() is a READ call (it does not place or cancel any order), but it IS
 * an AUTHENTICATED N1 call — it requires N1_PRIVATE_KEY and a live adapter.connect() session, the
 * same as scripts/run-live.ts. Per this project's standing constraint, an AI session must never
 * perform any authenticated exchange action, so this script is written but has NEVER been run
 * from this session. A human operator runs it themselves, exactly like run-live.ts.
 *
 * Usage:
 *   npx tsx scripts/audit-trade-log-gaps.ts [BTCUSD,ETHUSD] [--since=ISO8601] [--until=ISO8601]
 *
 * Env (same as scripts/run-live.ts):
 *   N1_WEB_SERVER_URL, N1_APP_ADDR, N1_PRIVATE_KEY, SOLANA_RPC_URL (optional)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { N1Adapter } from "../src/adapters/n1/N1Adapter.js";
import type { NormalizedFill } from "../src/adapters/ExchangeAdapter.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import type { TradeLogEntry } from "../src/engine/TradeLog.js";

const MAX_AUDIT_PAGES = 2000; // safety cap on this script's own pagination loop, independent of
// N1Adapter.getAccountTradeHistoryPage()'s internal per-role cap — this is a read-only audit, not
// a hot path, so failing loud on an unexpectedly large backlog is preferable to looping forever.

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. See .env.example for what's needed.`);
  }
  return value;
}

function parseCliArgs(): { markets: string[]; since?: string; until?: string } {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = new Map(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--") && a.includes("="))
      .map((a) => {
        const [key, ...rest] = a.slice(2).split("=");
        return [key!, rest.join("=")];
      }),
  );
  const markets = positional[0] ? positional[0].split(",").map((s) => s.trim()) : ["BTCUSD", "ETHUSD"];
  return { markets, since: flags.get("since"), until: flags.get("until") };
}

function readLocalTradeLog(path: string): TradeLogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TradeLogEntry);
}

/** Pages getAccountTradeHistoryPage() to exhaustion across [since, until]. Throws rather than
 * silently truncating — same "never substitute 0/partial for a real answer" discipline as
 * N1RealizedPnlSource. */
async function fetchAllAccountTrades(
  adapter: N1Adapter,
  since: string,
  until: string,
): Promise<NormalizedFill[]> {
  if (!adapter.getAccountTradeHistoryPage) {
    throw new Error("This N1Adapter instance does not implement getAccountTradeHistoryPage()");
  }
  const trades: NormalizedFill[] = [];
  let cursor: string | undefined;
  for (let page = 1; ; page++) {
    if (page > MAX_AUDIT_PAGES) {
      throw new Error(
        `audit-trade-log-gaps: exceeded ${MAX_AUDIT_PAGES}-page safety cap without exhausting ` +
          `account trade history for [${since}, ${until}] — widen the cap or narrow the window`,
      );
    }
    const result = await adapter.getAccountTradeHistoryPage({ since, until, cursor });
    trades.push(...result.trades);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
    if (page % 10 === 0) {
      console.log(`  ...page ${page}, ${trades.length} account trades fetched so far`);
    }
  }
  return trades;
}

async function auditMarket(
  adapter: N1Adapter,
  market: string,
  sinceOverride: string | undefined,
  untilOverride: string | undefined,
): Promise<void> {
  const localPath = join(process.cwd(), "state", "live", `trades-${market}.jsonl`);
  const local = readLocalTradeLog(localPath);
  const localTradeIds = new Set(local.map((e) => e.tradeId).filter((id): id is string => !!id));

  const since = sinceOverride ?? new Date(Math.min(...local.map((e) => e.timestamp), Date.now())).toISOString();
  const until = untilOverride ?? new Date().toISOString();

  console.log(`\n=== ${market}: local=${local.length} fills, scanning exchange [${since}, ${until}] ===`);
  const accountTrades = await fetchAllAccountTrades(adapter, since, until);
  const marketTrades = accountTrades.filter((t) => t.market === market);
  console.log(`  exchange reports ${marketTrades.length} ${market} trades in that window`);

  const missing = marketTrades
    .filter((t) => t.tradeId !== undefined && !localTradeIds.has(t.tradeId))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (missing.length === 0) {
    console.log(`  no gap found for ${market} — local trade log matches exchange history`);
    return;
  }

  const netSignedMissing = missing.reduce(
    (sum, f) => sum + (f.side === "buy" ? f.size : -f.size),
    0,
  );
  console.log(
    `  FOUND ${missing.length} missing fill(s) — net signed size ${netSignedMissing.toFixed(6)} ` +
      `base, spanning ${new Date(missing[0]!.timestamp).toISOString()} to ` +
      `${new Date(missing.at(-1)!.timestamp).toISOString()}`,
  );

  const outPath = join(process.cwd(), "state", "live", `trades-${market}.recovered-gaps.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  const lines = missing.map((f) => JSON.stringify(f)).join("\n") + "\n";
  writeFileSync(outPath, lines, "utf-8");
  console.log(`  wrote recovered fills to ${outPath} (review before merging into the real log)`);
}

async function main(): Promise<void> {
  const { markets, since, until } = parseCliArgs();

  const webServerUrl = requiredEnv("N1_WEB_SERVER_URL");
  const appAddr = requiredEnv("N1_APP_ADDR");
  const privateKey = requiredEnv("N1_PRIVATE_KEY"); // never logged, never alerted
  const solanaRpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const configPath =
    process.env.MARKETS_CONFIG_PATH ?? join(process.cwd(), "config", "markets.yaml");

  const config = loadMarketsConfig(configPath);
  const enabled = config.markets.filter((m) => markets.includes(m.symbol) && m.exchange === "n1");
  if (enabled.length === 0) {
    throw new Error(`None of [${markets.join(", ")}] found as enabled n1 markets in "${configPath}".`);
  }

  const adapter = new N1Adapter({
    webServerUrl,
    appAddr,
    solanaRpcUrl,
    privateKey,
    markets: enabled.map((m) => ({ symbol: m.symbol, exchangeSymbol: m.exchangeSymbol })),
  });
  await adapter.connect(); // the only authenticated network contact this script makes — read-only
  // from here on (getAccountTradeHistoryPage() only; no placeOrder/cancelOrder call exists in
  // this file).

  for (const m of enabled) {
    await auditMarket(adapter, m.symbol, since, until);
  }

  console.log("\nAudit complete. Recovered-gaps files (if any) are separate from the real trade " +
    "log — review them, then decide whether/how to merge.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
