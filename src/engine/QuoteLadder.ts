import type { OrderSide } from "../adapters/ExchangeAdapter.js";

export interface QuoteLevel {
  side: OrderSide;
  price: number;
  size: number;
}

/**
 * SPEC.md Section 3: one bid + one ask per configured spacing value (5+5 for the proven values),
 * literal (non-adaptive) spacing from a flat reservation price, equal size per level — not
 * growing size at outer levels. Centered on mark price with no inventory skew: Section 2's
 * config has no skew/risk-aversion parameters, and inventory management is handled separately,
 * via inventoryReductionThresholdBase triggering a dedicated reduce-only exit (Section 5c), not
 * by skewing this ladder.
 */
export function generateQuoteLadder(params: {
  reservationPrice: number;
  levelSpacingBps: number[];
  sizePerLevel: number;
}): QuoteLevel[] {
  const levels: QuoteLevel[] = [];
  for (const bps of params.levelSpacingBps) {
    const offset = params.reservationPrice * (bps / 10_000);
    levels.push({
      side: "buy",
      price: params.reservationPrice - offset,
      size: params.sizePerLevel,
    });
    levels.push({
      side: "sell",
      price: params.reservationPrice + offset,
      size: params.sizePerLevel,
    });
  }
  return levels;
}

/**
 * SPEC.md Section 2 gives orderSize as a {min,max} range without detailing the exact sizing
 * strategy behind it. This picks one value uniformly at random within the range, once per engine
 * cycle, so every level in that cycle's ladder uses the same size — consistent with Section 3's
 * "equal size per level, not growing size." This is a reasonable interpretation, not something
 * SPEC.md spells out precisely; confirm it matches operator intent.
 */
export function pickOrderSize(range: { min: number; max: number }): number {
  return range.min + Math.random() * (range.max - range.min);
}
