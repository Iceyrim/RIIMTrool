import { ExchangeAdapterError } from "../AdapterError.js";
import type { PerplMarket } from "./PerplMarketDataSource.js";

export interface ConfiguredPerplMarket { symbol: string; exchangeSymbol: string }

export class PerplMarketRegistry {
  private readonly bySymbol = new Map<string, PerplMarket>();
  private readonly symbolById = new Map<string, string>();
  constructor(private readonly configured: readonly ConfiguredPerplMarket[]) {}

  resolve(markets: readonly PerplMarket[]): void {
    this.bySymbol.clear(); this.symbolById.clear();
    for (const config of this.configured) {
      const market = markets.find((candidate) => candidate.symbol === config.exchangeSymbol);
      if (!market) throw new ExchangeAdapterError(`Perpl has no market "${config.exchangeSymbol}" for "${config.symbol}"`);
      if (!market.open) throw new ExchangeAdapterError(`Perpl market "${config.exchangeSymbol}" is not open`);
      this.bySymbol.set(config.symbol, market);
      this.symbolById.set(market.marketId, config.symbol);
    }
  }

  marketFor(symbol: string): PerplMarket {
    const market = this.bySymbol.get(symbol);
    if (!market) throw new ExchangeAdapterError(`Unknown Perpl market "${symbol}"`);
    return market;
  }

  symbolFor(marketId: string): string {
    const symbol = this.symbolById.get(marketId);
    if (!symbol) throw new ExchangeAdapterError(`Unknown Perpl market id "${marketId}"`);
    return symbol;
  }
}
