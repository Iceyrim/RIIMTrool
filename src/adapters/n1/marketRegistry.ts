import type { Market } from "@n1xyz/nord-ts";
import { ExchangeAdapterError } from "../AdapterError.js";

export interface ConfiguredMarket {
  /** Logical symbol used everywhere outside the adapter, e.g. "BTCUSD". */
  symbol: string;
  /** The literal symbol N1 itself uses, e.g. "BTCUSDC". */
  exchangeSymbol: string;
}

/**
 * Resolves between this bot's logical market symbols and N1's numeric marketId + native symbol.
 * Built from explicit config (`exchangeSymbol`) rather than guessed/fuzzy-matched — see the
 * project's adapter design discussion: N1 quotes markets in USDC, so "BTCUSD" in config does not
 * literally match N1's own market symbol, and guessing that mapping risked silently trading the
 * wrong market.
 */
export class MarketRegistry {
  private readonly symbolToMarketId = new Map<string, number>();
  private readonly marketIdToSymbol = new Map<number, string>();

  constructor(private readonly configuredMarkets: readonly ConfiguredMarket[]) {}

  /**
   * Must be called once after fetching N1's live market list (`nord.markets`). Throws loudly if
   * any configured market can't be found — this must never fail silently into "market missing,
   * trading skipped."
   */
  resolve(nordMarkets: readonly Pick<Market, "marketId" | "symbol">[]): void {
    for (const configured of this.configuredMarkets) {
      const match = nordMarkets.find((m) => m.symbol === configured.exchangeSymbol);
      if (!match) {
        const available = nordMarkets.map((m) => m.symbol).join(", ") || "(none returned)";
        throw new ExchangeAdapterError(
          `N1 has no market with symbol "${configured.exchangeSymbol}" ` +
            `(configured for logical symbol "${configured.symbol}"). ` +
            `N1's live market symbols are: ${available}`,
        );
      }
      this.symbolToMarketId.set(configured.symbol, match.marketId);
      this.marketIdToSymbol.set(match.marketId, configured.symbol);
    }
  }

  marketIdFor(symbol: string): number {
    const marketId = this.symbolToMarketId.get(symbol);
    if (marketId === undefined) {
      throw new ExchangeAdapterError(
        `Unknown market symbol "${symbol}" — not present in this adapter's configured markets`,
      );
    }
    return marketId;
  }

  symbolFor(marketId: number): string {
    const symbol = this.marketIdToSymbol.get(marketId);
    if (symbol === undefined) {
      throw new ExchangeAdapterError(
        `Unknown N1 marketId ${marketId} — not present in this adapter's configured markets`,
      );
    }
    return symbol;
  }
}
