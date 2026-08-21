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
/**
 * CANCEL_PENDING_CONFIRM sits between PENDING_CANCEL and the terminal states: the cancel call has
 * resolved and an initial fill-replay snapshot has been taken (SPEC.md Section 5a), but that
 * snapshot didn't show a full fill, so the order isn't safely terminal yet — the exchange may
 * still be processing the cancel and a fill may land in that gap. Deliberately excluded from every
 * "is this order still live for placement-gating purposes" check (duplicate reduce-only guard,
 * existing-order lookup) so replacement placement isn't delayed by it — only Reconciliation's
 * grace-period recheck (and shutdown/PnL-outage cleanup sweeps) treat it as still-open.
 */
export type LocalOrderState =
  | "RESTING"
  | "PENDING_CANCEL"
  | "CANCEL_PENDING_CONFIRM"
  | "CANCELLED"
  | "FILLED"
  | "UNKNOWN";

/** How long an order may sit in CANCEL_PENDING_CONFIRM before Reconciliation fails it open to
 * CANCELLED (raising a CANCEL_CONFIRM_TIMEOUT anomaly rather than resolving silently). Sized well
 * under the reduce-only exit's 300s max-hold ceiling (SPEC.md Section 5c) and comfortably above
 * the ~5-20s per-market reconciliation cadence observed in live logs, so it absorbs the race
 * without stalling the exit-repricing cadence. */
export const CANCEL_CONFIRM_GRACE_MS = 60_000;

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
  /** Unix ms deadline for CANCEL_PENDING_CONFIRM; unset for every other state. Reconciliation
   * fails the order open to CANCELLED once now() passes this, per CANCEL_CONFIRM_GRACE_MS. */
  cancelGraceUntil?: number;
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
  /** Not part of SPEC.md Section 2's config shape (which only states the proven values 45s/5min
   * once, in prose) — surfaced as config here so it's not a hidden literal, matching Section 6's
   * "no hardcoded literal alongside a configurable system" lesson. */
  reduceOnlyExit: ReduceOnlyExitConfig;
  /** Normal (non-reduce-only) full-ladder refresh policy. */
  quoteMinimumLifetimeMs: number;
  /** Optional only for backward-compatible programmatic construction; parsed config supplies it. */
  quoteRepriceThresholdBps?: number;
  /** Optional only for backward-compatible programmatic construction; parsed config supplies it. */
  quoteMaximumLifetimeMs?: number;
}

export interface AccountRiskState {
  /** Running account-wide realized PnL total, sourced from RealizedPnlSource drains. Display-only
   * (dashboard) plus the feed for WindowLossCapTracker's daily/weekly windows — no cap is checked
   * against this running total itself; see SPEC.md's account-wide PnL policy section. */
  sessionRealizedPnlUsd: number;
  pnlAvailable: boolean;
  pnlUnavailableReason?: string;
}
