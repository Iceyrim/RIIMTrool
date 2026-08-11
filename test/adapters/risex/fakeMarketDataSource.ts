import type {
  RiseXCandle,
  RiseXFundingRecord,
  RiseXMarket,
  RiseXMarketDataSource,
  RiseXOrderbook,
  RiseXTrade,
} from "../../../src/adapters/risex/RiseXMarketDataSource.js";

/** In-memory test double for RiseXMarketDataSource — no network access. */
export class FakeRiseXMarketDataSource implements RiseXMarketDataSource {
  markets: RiseXMarket[] = [];
  tradesByMarketId = new Map<number, RiseXTrade[]>();
  fundingByMarketId = new Map<number, RiseXFundingRecord[]>();

  async getMarkets(): Promise<RiseXMarket[]> {
    return this.markets;
  }

  async getOrderbook(): Promise<RiseXOrderbook> {
    throw new Error("FakeRiseXMarketDataSource: getOrderbook not used by RiseXPaperAdapter");
  }

  async getRecentTrades(
    marketId: number,
    sinceMs?: number,
    opts?: { page?: number; limit?: number },
  ): Promise<RiseXTrade[]> {
    const all = this.tradesByMarketId.get(marketId) ?? [];
    const filtered = sinceMs === undefined ? all : all.filter((t) => t.timestamp >= sinceMs);
    return opts?.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;
  }

  async getCandles(): Promise<RiseXCandle[]> {
    throw new Error("FakeRiseXMarketDataSource: getCandles not used by RiseXPaperAdapter");
  }

  async getFundingRateHistory(
    marketId: number,
    opts?: { sinceMs?: number; untilMs?: number; page?: number; limit?: number },
  ): Promise<RiseXFundingRecord[]> {
    const all = this.fundingByMarketId.get(marketId) ?? [];
    const filtered = opts?.sinceMs === undefined ? all : all.filter((f) => f.endTime >= opts.sinceMs!);
    return opts?.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;
  }
}
