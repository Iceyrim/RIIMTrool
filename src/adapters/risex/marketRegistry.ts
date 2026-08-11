import { ExchangeAdapterError } from "../AdapterError.js";
import type { RiseXMarket } from "./RiseXMarketDataSource.js";

export interface ConfiguredRiseXMarket {
  /** Logical symbol used everywhere outside the adapter, e.g. "BTCUSD". */
  symbol: string;
  /** RISEx's own market symbol, e.g. "BTC/USDC" — confirmed against real mainnet in Phase 1
   * (RiseXMarket.symbol comes from the raw `base_asset_symbol` field, which is the full pair,
   * not just the base asset). */
  exchangeSymbol: string;
}

export interface RiseXStepConfig {
  stepSize: number;
  stepPrice: number;
  minOrderSize: number;
}

/**
 * Resolves between this bot's logical market symbols and RISEx's numeric marketId, same division
 * of responsibility as N1's MarketRegistry (../n1/marketRegistry.ts) — built from explicit config
 * rather than guessed/fuzzy-matched. Also caches each market's step-grid config, since (unlike
 * N1) RiseXPaperAdapter must quantize order price/size to RISEx's real integer tick/step grid
 * before treating an order as valid (SPEC.md Section 11).
 */
export class RiseXMarketRegistry {
  private readonly symbolToMarketId = new Map<string, number>();
  private readonly marketIdToSymbol = new Map<number, string>();
  private readonly stepConfigBySymbol = new Map<string, RiseXStepConfig>();

  constructor(private readonly configuredMarkets: readonly ConfiguredRiseXMarket[]) {}

  /** Must be called once after fetching RISEx's live market list. Throws loudly if any
   * configured market can't be found — must never fail silently into "market missing, trading
   * skipped." */
  resolve(riseXMarkets: readonly RiseXMarket[]): void {
    for (const configured of this.configuredMarkets) {
      const match = riseXMarkets.find((m) => m.symbol === configured.exchangeSymbol);
      if (!match) {
        const available = riseXMarkets.map((m) => m.symbol).join(", ") || "(none returned)";
        throw new ExchangeAdapterError(
          `RISEx has no market with symbol "${configured.exchangeSymbol}" ` +
            `(configured for logical symbol "${configured.symbol}"). ` +
            `RISEx's live market symbols are: ${available}`,
        );
      }
      this.symbolToMarketId.set(configured.symbol, match.marketId);
      this.marketIdToSymbol.set(match.marketId, configured.symbol);
      this.stepConfigBySymbol.set(configured.symbol, {
        stepSize: match.stepSize,
        stepPrice: match.stepPrice,
        minOrderSize: match.minOrderSize,
      });
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
        `Unknown RISEx marketId ${marketId} — not present in this adapter's configured markets`,
      );
    }
    return symbol;
  }

  stepConfigFor(symbol: string): RiseXStepConfig {
    const stepConfig = this.stepConfigBySymbol.get(symbol);
    if (!stepConfig) {
      throw new ExchangeAdapterError(
        `Unknown market symbol "${symbol}" — not present in this adapter's configured markets`,
      );
    }
    return stepConfig;
  }
}
