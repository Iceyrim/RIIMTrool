/**
 * One-shot connectivity proof for RiseXMarketDataSource (SPEC.md Section 11, build plan step 1).
 *
 * Hits real RISEx mainnet public REST endpoints (no credentials, no signing, no order/account
 * calls) and prints what comes back. This is the "real RISEx mainnet market data flowing" bar
 * for Phase 1 before Phase 2 (RiseXPaperAdapter) starts consuming it — not a soak test, just a
 * live sanity check that the base URL and response mapping match reality outside of unit-test
 * fixtures.
 *
 * Usage:
 *   npx tsx scripts/probe-risex-market-data.ts [marketId]
 *
 * marketId defaults to 1 (BTC/USDC on mainnet, confirmed via GET /v1/markets).
 */
import { RealRiseXMarketDataSource } from "../src/adapters/risex/RiseXMarketDataSource.js";

async function main(): Promise<void> {
  const marketId = Number(process.argv[2] ?? "1");
  const source = new RealRiseXMarketDataSource();

  console.log(`Fetching RISEx mainnet market list...`);
  const markets = await source.getMarkets();
  console.log(`Got ${markets.length} markets. First few:`, markets.slice(0, 5));

  const market = markets.find((m) => m.marketId === marketId);
  if (!market) {
    throw new Error(`marketId ${marketId} not found in live market list`);
  }
  console.log(`\nUsing market ${marketId} (${market.symbol}): mark=${market.markPrice}`);

  console.log(`\nFetching orderbook...`);
  const book = await source.getOrderbook(marketId, 5);
  console.log("Top bids:", book.bids.slice(0, 3));
  console.log("Top asks:", book.asks.slice(0, 3));

  console.log(`\nFetching recent trades...`);
  const trades = await source.getRecentTrades(marketId, undefined, { limit: 5 });
  console.log(`Got ${trades.length} trades:`, trades);

  console.log(`\nFetching 1m candles for the last hour...`);
  const now = Date.now();
  const candles = await source.getCandles(marketId, {
    intervalMs: 60_000,
    fromMs: now - 60 * 60_000,
    toMs: now,
  });
  console.log(`Got ${candles.length} candles. Last one:`, candles.at(-1));

  console.log(`\nFetching funding rate history...`);
  const funding = await source.getFundingRateHistory(marketId, { limit: 3 });
  console.log(`Got ${funding.length} funding records:`, funding);

  console.log(`\nAll RiseXMarketDataSource calls succeeded against real RISEx mainnet data.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
