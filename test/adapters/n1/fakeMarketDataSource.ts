import type { MarketStats, TradeFromApi } from "@n1xyz/nord-ts";
import type { N1MarketDataSource } from "../../../src/adapters/n1/N1MarketDataSource.js";

/** In-memory test double for N1MarketDataSource — no network access. */
export class FakeN1MarketDataSource implements N1MarketDataSource {
  markets: Array<{ marketId: number; symbol: string }> = [];
  statsByMarketId = new Map<number, MarketStats>();
  /** Full historical tape per market, in ascending tradeId order. */
  tradesByMarketId = new Map<number, TradeFromApi[]>();

  async getMarkets(): Promise<Array<{ marketId: number; symbol: string }>> {
    return this.markets;
  }

  async getMarketStats(marketId: number): Promise<MarketStats> {
    const stats = this.statsByMarketId.get(marketId);
    if (!stats)
      throw new Error(`FakeN1MarketDataSource: no stats configured for market ${marketId}`);
    return stats;
  }

  async getRecentTrades(marketId: number, sinceTradeId?: number): Promise<TradeFromApi[]> {
    const all = this.tradesByMarketId.get(marketId) ?? [];
    return sinceTradeId === undefined ? all : all.filter((t) => t.tradeId >= sinceTradeId);
  }
}
