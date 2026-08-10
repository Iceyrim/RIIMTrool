import type {
  ExchangeAdapter,
  NormalizedPosition,
  OrderSide,
} from "../adapters/ExchangeAdapter.js";
import type { ReconciliationResult } from "./Reconciliation.js";
import type { RiskLimitsConfig } from "./types.js";

export interface RiskCheckContext {
  market: string;
  side: OrderSide;
  size: number;
  price: number;
  limits: RiskLimitsConfig;
  currentPosition: NormalizedPosition | undefined;
  /** Consumed rather than independently re-fetched — SPEC.md Section 6: a HEALTHY reconciliation
   * result must be trusted for capacity/state decisions, not re-derived from a fresh raw count
   * that could race against an in-flight cancel/replace. */
  lastReconciliation: ReconciliationResult;
  /** Caller-computed running total for this market's session (negative = net loss). This is
   * intentionally simple for now — proper realized-PnL accounting arrives with trade logging
   * (SPEC.md Section 7, a later build step); until then this is whatever the engine sums from
   * applied fills. */
  sessionRealizedPnlUsd: number;
  sessionLossCapUsd: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Per-market limits plus account-wide margin awareness (SPEC.md Section 4.3: margin is a shared,
 * cross-margined resource across every market sharing this process — a large position in one
 * market reduces available margin for another, and that must be visible to "can I place this
 * order," not assumed away). canPlaceOrder() takes a market explicitly even though only one
 * market is driven through it in step 2, so step 4's multi-market extension is "call this per
 * market," not a redesign.
 */
export class RiskManager {
  constructor(private readonly adapter: ExchangeAdapter) {}

  canPlaceOrder(ctx: RiskCheckContext): RiskCheckResult {
    // SPEC.md Section 6: a reconciliation-confirmed HEALTHY at-capacity state is expected steady
    // state, not a failure to re-litigate — this only blocks NEW placement while at capacity, it
    // does not treat capacity itself as broken. A DEGRADED reconciliation, on the other hand,
    // blocks everything until resolved, regardless of count.
    if (!ctx.lastReconciliation.healthy) {
      return {
        allowed: false,
        reason: `Reconciliation for ${ctx.market} is degraded (streak irrelevant, current cycle unhealthy); refusing new placements until healthy`,
      };
    }
    if (ctx.lastReconciliation.openOrderCount >= ctx.limits.maxOpenOrders) {
      return {
        allowed: false,
        reason: `At maxOpenOrders (${ctx.limits.maxOpenOrders}) for ${ctx.market} per last healthy reconciliation`,
      };
    }

    if (ctx.size > ctx.limits.maxOrderSize) {
      return {
        allowed: false,
        reason: `Order size ${ctx.size} exceeds maxOrderSize ${ctx.limits.maxOrderSize} for ${ctx.market}`,
      };
    }

    const notionalUsd = ctx.size * ctx.price;
    if (notionalUsd > ctx.limits.maxOrderNotionalUsd) {
      return {
        allowed: false,
        reason: `Order notional $${notionalUsd.toFixed(2)} exceeds maxOrderNotionalUsd $${ctx.limits.maxOrderNotionalUsd} for ${ctx.market}`,
      };
    }

    const currentBaseSize = ctx.currentPosition?.baseSize ?? 0;
    const projected = ctx.side === "buy" ? currentBaseSize + ctx.size : currentBaseSize - ctx.size;
    if (projected > ctx.limits.maxLongPosition) {
      return {
        allowed: false,
        reason: `Order would bring ${ctx.market} position to ${projected}, exceeding maxLongPosition ${ctx.limits.maxLongPosition}`,
      };
    }
    if (projected < -ctx.limits.maxShortPosition) {
      return {
        allowed: false,
        reason: `Order would bring ${ctx.market} position to ${projected}, exceeding maxShortPosition ${ctx.limits.maxShortPosition}`,
      };
    }

    if (ctx.sessionRealizedPnlUsd <= -ctx.sessionLossCapUsd) {
      return {
        allowed: false,
        reason: `Session loss cap of $${ctx.sessionLossCapUsd} reached for ${ctx.market} ($${(-ctx.sessionRealizedPnlUsd).toFixed(2)} realized loss)`,
      };
    }

    return { allowed: true };
  }

  /**
   * Account-wide, not per-market — call in addition to canPlaceOrder(), not instead of it.
   *
   * Deliberately conservative: only hard-blocks on the exchange's own unambiguous bankruptcy
   * flag. N1's margin-fraction fields (omf/mf/imf/cmf/mmf/pon/pn) come with only a terse
   * description in the SDK ("MF as basis points, divide by pn") — not enough to safely derive a
   * specific numeric headroom threshold without confirming the exact formula against real
   * account data first. Fabricating a plausible-looking formula here would be exactly the kind
   * of unverified "it looks right" assumption SPEC.md Section 9.5 warns against. The raw fields
   * are returned via NormalizedMarginStatus (see getMarginStatus()) for the dashboard/operator to
   * read directly in the meantime.
   */
  checkMarginHealth(): RiskCheckResult {
    const margin = this.adapter.getMarginStatus();
    if (margin.isAtBankruptcyRisk) {
      return { allowed: false, reason: "Account is at bankruptcy risk per exchange margin status" };
    }
    return { allowed: true };
  }
}
