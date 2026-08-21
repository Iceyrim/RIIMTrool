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
  /** Progressive, market-scoped count: reconciled open orders adjusted for confirmed in-cycle
   * cancellations and successful placements. */
  progressiveOpenOrderCount: number;
  /** Remaining market-scoped quantities already capable of filling on each side, including
   * successful placements earlier in this cycle. Opposing sides are deliberately not netted. */
  openBuyQuantity: number;
  openSellQuantity: number;
  /** Account-wide daily/weekly realized-PnL loss caps (WindowLossCapTracker) — the only
   * realized-PnL-based placement gate in this codebase (the former account-wide session loss
   * cap was removed; restarting the bot no longer creates or resets any loss-control boundary,
   * see SPEC.md). Optional so every existing caller/fixture that never sets them just behaves as
   * "not capped". Deliberately only reached from the quote-ladder path (manageQuoteLadder), never
   * from manageReduceOnlyExit — see RiskManager.canPlaceOrder's doc comment. */
  dailyLossCapped?: boolean;
  weeklyLossCapped?: boolean;
  dailyLossCapReason?: string;
  weeklyLossCapReason?: string;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  deniedBy?: "openOrderCapacity" | "orderSize" | "orderNotional" | "aggregateLongExposure" | "aggregateShortExposure" | "reconciliation" | "dailyLoss" | "weeklyLoss";
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
        deniedBy: "reconciliation",
      };
    }
    if (ctx.progressiveOpenOrderCount >= ctx.limits.maxOpenOrders) {
      return {
        allowed: false,
        reason: `At maxOpenOrders (${ctx.limits.maxOpenOrders}) for ${ctx.market} using progressive in-cycle count ${ctx.progressiveOpenOrderCount}`,
        deniedBy: "openOrderCapacity",
      };
    }

    if (ctx.size > ctx.limits.maxOrderSize) {
      return {
        allowed: false,
        reason: `Order size ${ctx.size} exceeds maxOrderSize ${ctx.limits.maxOrderSize} for ${ctx.market}`,
        deniedBy: "orderSize",
      };
    }

    const notionalUsd = ctx.size * ctx.price;
    if (notionalUsd > ctx.limits.maxOrderNotionalUsd) {
      return {
        allowed: false,
        reason: `Order notional $${notionalUsd.toFixed(2)} exceeds maxOrderNotionalUsd $${ctx.limits.maxOrderNotionalUsd} for ${ctx.market}`,
        deniedBy: "orderNotional",
      };
    }

    const currentBaseSize = ctx.currentPosition?.baseSize ?? 0;
    const worstCaseLong = currentBaseSize + ctx.openBuyQuantity + (ctx.side === "buy" ? ctx.size : 0);
    const worstCaseShort = currentBaseSize - ctx.openSellQuantity - (ctx.side === "sell" ? ctx.size : 0);
    if (worstCaseLong > ctx.limits.maxLongPosition) {
      return {
        allowed: false,
        reason: `Order would bring ${ctx.market} worst-case long exposure to ${worstCaseLong}, exceeding maxLongPosition ${ctx.limits.maxLongPosition}`,
        deniedBy: "aggregateLongExposure",
      };
    }
    if (worstCaseShort < -ctx.limits.maxShortPosition) {
      return {
        allowed: false,
        reason: `Order would bring ${ctx.market} worst-case short exposure to ${worstCaseShort}, exceeding maxShortPosition ${ctx.limits.maxShortPosition}`,
        deniedBy: "aggregateShortExposure",
      };
    }

    // Daily/weekly caps (WindowLossCapTracker) deliberately only reach this per-level ladder
    // check — manageReduceOnlyExit() never calls canPlaceOrder(), so a capped day/week never
    // blocks a reduce-only exit, only new ladder placement.
    if (ctx.dailyLossCapped) {
      return {
        allowed: false,
        reason: `Daily realized-PnL loss cap reached${ctx.dailyLossCapReason ? ` (${ctx.dailyLossCapReason})` : ""}; new ladder placement blocked for ${ctx.market} until UTC daily rollover`,
        deniedBy: "dailyLoss",
      };
    }
    if (ctx.weeklyLossCapped) {
      return {
        allowed: false,
        reason: `Weekly realized-PnL loss cap reached${ctx.weeklyLossCapReason ? ` (${ctx.weeklyLossCapReason})` : ""}; new ladder placement blocked for ${ctx.market} until UTC weekly rollover`,
        deniedBy: "weeklyLoss",
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
