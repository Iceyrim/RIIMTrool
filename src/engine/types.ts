import type { OrderSide, OrderType } from "../adapters/ExchangeAdapter.js";

/**
 * Local (engine-side) order lifecycle state. Distinct from the adapter's OrderState: this is
 * what WE believe about an order we placed, not what a single exchange call just reported.
 *
 * UNKNOWN is not a generic catch-all — it is the literal state named in SPEC.md Section 5b's bug
 * description: a placement call that resolved without confirming success or failure. An order in
 * this state is neither trusted to be resting nor safely assumed gone; only reconciliation
 * (against exchange truth) can resolve it into RESTING or removed.
 */
export type LocalOrderState = "RESTING" | "PENDING_CANCEL" | "CANCELLED" | "FILLED" | "UNKNOWN";

export interface LocalOrder {
  /** Our own generated id. Always present, regardless of whether the exchange ever confirmed
   * the order — this is what the registry is keyed by, specifically so an UNKNOWN order (which
   * may have no exchangeOrderId at all) is still trackable. */
  clientOrderId: string;
  /** Null only while state is UNKNOWN and the exchange never returned an id for this attempt. */
  exchangeOrderId: string | null;
  market: string;
  side: OrderSide;
  type: OrderType;
  /** Anchored at placement time. Lifecycle code must never overwrite this while an order is
   * resting (SPEC.md Section 5c: reduce-only exit prices must not be re-derived every cycle). */
  price: number;
  size: number;
  filledSize: number;
  isReduceOnly: boolean;
  state: LocalOrderState;
  placedAt: number; // unix ms
  updatedAt: number; // unix ms, last state transition
  /** Free-text diagnostic, e.g. the UNRESOLVED_NOT_CONFIRMED message, or why a cancel/reconcile
   * decision was made. Not authoritative, purely for operator debugging. */
  note?: string;
}

export interface RiskLimitsConfig {
  maxLongPosition: number;
  maxShortPosition: number;
  maxOrderSize: number;
  maxOrderNotionalUsd: number;
  maxOpenOrders: number;
}

export interface ReduceOnlyExitConfig {
  minHoldMs: number;
  maxHoldMs: number;
}

export interface EngineMarketConfig {
  symbol: string;
  orderSize: { min: number; max: number };
  spreadBps: { normal: number; min: number; max: number };
  exitSpreadBps: number;
  quoteLevels: number;
  levelSpacingBps: number[];
  inventoryReductionThresholdBase: number;
  riskLimits: RiskLimitsConfig;
  sessionLossCapUsd: number;
  /** Not part of SPEC.md Section 2's config shape (which only states the proven values 45s/5min
   * once, in prose) — surfaced as config here so it's not a hidden literal, matching Section 6's
   * "no hardcoded literal alongside a configurable system" lesson. */
  reduceOnlyExit: ReduceOnlyExitConfig;
  /** Normal (non-reduce-only) quote refresh cadence, ms. SPEC.md Section 6 (5c root cause):
   * proven value ~2000ms, but must be a named config value, not a bare literal reused for both
   * quote types. */
  quoteMinimumLifetimeMs: number;
}
