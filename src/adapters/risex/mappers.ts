import type { MarketPrice } from "../ExchangeAdapter.js";
import type { RiseXMarket } from "./RiseXMarketDataSource.js";

/**
 * Quantizes a value to the nearest multiple of `step` — RISEx's real integer tick/step price
 * representation (SPEC.md Section 11), which N1's plain-decimal prices have no equivalent of.
 * A real RISEx order is only valid on this grid; simulating that constraint here (rather than
 * accepting whatever float the engine computed) is the structurally new part of this adapter
 * relative to N1PaperAdapter.
 */
export function quantizeToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

/** Unlike N1's mapMarketPrice, RiseXMarket.markPrice/indexPrice are never optional — RISEx's
 * getMarkets() response always carries both decimal-string fields, and RiseXMarketDataSource's
 * own mapper (decimal()) already throws if either is missing/non-numeric on the wire. So there is
 * no "neither price available" case to guard here. */
export function mapRiseXMarketPrice(market: string, riseXMarket: RiseXMarket): MarketPrice {
  return { market, mark: riseXMarket.markPrice, index: riseXMarket.indexPrice };
}
