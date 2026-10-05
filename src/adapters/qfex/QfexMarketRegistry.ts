import { ExchangeAdapterError } from "../AdapterError.js";
import type { QfexConfiguredMarket } from "./types.js";

export class QfexMarketRegistry {
  private readonly byLogical = new Map<string, QfexConfiguredMarket>();
  private readonly byExchange = new Map<string, QfexConfiguredMarket>();
  constructor(markets: QfexConfiguredMarket[]) {
    for (const market of markets) {
      if (this.byLogical.has(market.symbol) || this.byExchange.has(market.exchangeSymbol))
        throw new ExchangeAdapterError("Duplicate QFEX market mapping");
      this.byLogical.set(market.symbol, market);
      this.byExchange.set(market.exchangeSymbol, market);
    }
  }
  exchangeSymbolFor(symbol: string): string {
    const market = this.byLogical.get(symbol);
    if (!market) throw new ExchangeAdapterError(`Unknown QFEX market "${symbol}"`);
    return market.exchangeSymbol;
  }
  logicalSymbolFor(exchangeSymbol: string): string {
    const market = this.byExchange.get(exchangeSymbol);
    if (!market) throw new ExchangeAdapterError(`Unconfigured QFEX symbol "${exchangeSymbol}"`);
    return market.symbol;
  }
  logicalSymbolForIfConfigured(exchangeSymbol: string): string | undefined {
    return this.byExchange.get(exchangeSymbol)?.symbol;
  }
  constraintsFor(symbol: string): QfexConfiguredMarket {
    const market = this.byLogical.get(symbol);
    if (!market) throw new ExchangeAdapterError(`Unknown QFEX market "${symbol}"`);
    return market;
  }
  exchangeSymbols(): string[] {
    return [...this.byExchange.keys()];
  }
}
