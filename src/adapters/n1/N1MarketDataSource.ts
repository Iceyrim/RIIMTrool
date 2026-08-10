import type { Market, MarketStats, Nord, TradeFromApi } from "@n1xyz/nord-ts";

/**
 * The subset of N1's real, read-only market-data API that N1PaperAdapter depends on. Kept as
 * its own seam (rather than N1PaperAdapter holding a `Nord` directly) for the same reason
 * MarketEngine depends on ExchangeAdapter rather than a concrete adapter: it lets paper-mode
 * fill simulation be tested against a fake data source with zero network access, and keeps the
 * one real network dependency (RealN1MarketDataSource) as a thin, swappable seam.
 *
 * Deliberately narrow: no authentication, no account/order/balance methods exist here at all —
 * N1PaperAdapter must be structurally incapable of touching a real account through this
 * interface, only public market data.
 */
export interface N1MarketDataSource {
  getMarkets(): Promise<Array<Pick<Market, "marketId" | "symbol">>>;
  getMarketStats(marketId: number): Promise<MarketStats>;
  /** Trades with tradeId >= sinceTradeId (inclusive), oldest first. Omit sinceTradeId to fetch
   * the most recent page, used only to prime a market's trade-tape cursor on first use. */
  getRecentTrades(marketId: number, sinceTradeId?: number): Promise<TradeFromApi[]>;
}

/**
 * Real implementation, backed by an actual `Nord` client. Deliberately takes a bare `Nord`
 * instance, never a `NordUser` — constructing this requires no private key and no wallet, only
 * the public webServerUrl/app/solanaConnection config (SPEC.md Section 9.1: real credentials
 * never touch an AI coding session; this class structurally can't use one even if handed one).
 */
export class RealN1MarketDataSource implements N1MarketDataSource {
  constructor(private readonly nord: Nord) {}

  async getMarkets(): Promise<Array<Pick<Market, "marketId" | "symbol">>> {
    await this.nord.fetchNordInfo();
    return this.nord.markets;
  }

  async getMarketStats(marketId: number): Promise<MarketStats> {
    return this.nord.getMarketStats({ marketId });
  }

  async getRecentTrades(marketId: number, sinceTradeId?: number): Promise<TradeFromApi[]> {
    const response = await this.nord.getTrades({
      marketId,
      startInclusive: sinceTradeId,
      pageSize: 100,
      paginationMode: "tradeId",
    });
    return response.items;
  }
}
