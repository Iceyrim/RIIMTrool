import { randomUUID } from "node:crypto";
import type {
  ExchangeAdapter,
  NormalizedFill,
  OrderSide,
  OrderType,
} from "../adapters/ExchangeAdapter.js";
import type { OrderRegistry } from "./OrderRegistry.js";
import type { LocalOrder, ReduceOnlyExitConfig } from "./types.js";

export interface PlaceQuoteResult {
  success: boolean;
  order?: LocalOrder;
  message?: string;
}

export interface CancelResult {
  finalState: "CANCELLED" | "FILLED";
  fillsApplied: NormalizedFill[];
  /** True if the getOrderFills() race-check lookup itself errored and we proceeded anyway
   * (SPEC.md Section 5a: fail open, never let this check become a new stuck-order mode). */
  failedOpen: boolean;
}

export type ReduceOnlyRepriceDecision = "hold" | "eligible" | "forced";

/**
 * Owns the full order placement/cancellation flow for one market, implementing SPEC.md Sections
 * 5a (cancel race condition), 5b (silent placement failure), and 5c (reduce-only exit handling).
 */
export class OrderLifecycle {
  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly registry: OrderRegistry,
    private readonly market: string,
  ) {}

  /** Normal two-sided quote placement — NOT reduce-only, no duplicate guard (the quote ladder
   * manages its own set of resting orders directly). */
  async placeQuote(params: {
    side: OrderSide;
    type: OrderType;
    size: number;
    price: number;
  }): Promise<PlaceQuoteResult> {
    return this.placeOrderInternal(params, { exchangeReduceOnly: false, localReduceOnly: false });
  }

  /**
   * Places a reduce-only exit order. Two SPEC.md Section 5c behaviors live here:
   *  - duplicate-placement guard: refuses to place a second reduce-only exit while one is
   *    already open for this market
   *  - `isReduceOnly` sent to the exchange is deliberately `false`: exchange-enforced reduce-only
   *    is called out in Section 5c as its own separate decision requiring dedicated testing, not
   *    bundled into this fix. This order behaves as reduce-only purely through local bookkeeping
   *    (the duplicate guard above, and the caller only ever requesting a size that reduces the
   *    current position) — `isReduceOnly: true` is recorded locally so the rest of the engine
   *    (refresh cadence, hold-time logic below) can identify and specially handle it.
   */
  async placeReduceOnlyExit(params: {
    side: OrderSide;
    type: OrderType;
    size: number;
    price: number;
  }): Promise<PlaceQuoteResult> {
    if (this.hasOpenReduceOnlyExit()) {
      return {
        success: false,
        message:
          "A reduce-only exit order is already open for this market; skipping duplicate placement",
      };
    }
    return this.placeOrderInternal(params, { exchangeReduceOnly: false, localReduceOnly: true });
  }

  hasOpenReduceOnlyExit(): boolean {
    return this.registry
      .list()
      .some((o) => o.isReduceOnly && (o.state === "RESTING" || o.state === "PENDING_CANCEL"));
  }

  /**
   * Whether a resting reduce-only exit is eligible to be cancelled and repriced this cycle.
   * SPEC.md Section 5c's proven values: 45s minimum hold (never touch it before this), 5min
   * maximum ceiling (force exactly one reprice past this regardless of price movement). Between
   * the two, the caller decides based on how far the market has actually moved — that specific
   * movement threshold isn't spec'd as a fixed number, so it isn't invented here.
   */
  shouldRepriceReduceOnlyExit(
    order: LocalOrder,
    config: ReduceOnlyExitConfig,
    now: number = Date.now(),
  ): ReduceOnlyRepriceDecision {
    const age = now - order.placedAt;
    if (age >= config.maxHoldMs) return "forced";
    if (age < config.minHoldMs) return "hold";
    return "eligible";
  }

  private async placeOrderInternal(
    params: { side: OrderSide; type: OrderType; size: number; price: number },
    options: { exchangeReduceOnly: boolean; localReduceOnly: boolean },
  ): Promise<PlaceQuoteResult> {
    const clientOrderId = randomUUID();
    const now = Date.now();

    const result = await this.adapter.placeOrder({
      market: this.market,
      side: params.side,
      type: params.type,
      size: params.size,
      price: params.price,
      isReduceOnly: options.exchangeReduceOnly,
      clientOrderId,
    });

    if (!result.success) {
      if (result.reason === "UNRESOLVED_NOT_CONFIRMED") {
        // SPEC.md Section 5b: a resolved-but-unconfirmed placement must never be assumed
        // successful — but it also must not be silently dropped, since it may in fact have
        // landed. Recorded as UNKNOWN; only reconciliation against exchange truth resolves it.
        const local: LocalOrder = {
          clientOrderId,
          exchangeOrderId: null,
          market: this.market,
          side: params.side,
          type: params.type,
          price: params.price,
          size: params.size,
          filledSize: 0,
          isReduceOnly: options.localReduceOnly,
          state: "UNKNOWN",
          placedAt: now,
          updatedAt: now,
          note: result.message,
        };
        this.registry.upsert(local);
        return { success: false, message: result.message, order: local };
      }
      // REJECTED: the exchange definitively refused the order. Nothing to track locally.
      return { success: false, message: result.message };
    }

    const local: LocalOrder = {
      clientOrderId,
      exchangeOrderId: result.order.exchangeOrderId,
      market: this.market,
      side: result.order.side,
      type: result.order.type ?? params.type,
      price: result.order.price,
      size: result.order.size,
      filledSize: result.order.filledSize,
      isReduceOnly: options.localReduceOnly,
      state: result.order.state === "filled" ? "FILLED" : "RESTING",
      placedAt: now,
      updatedAt: now,
    };
    this.registry.upsert(local);
    return { success: true, order: local };
  }

  /**
   * Cancels a resting order, implementing SPEC.md Section 5a's race-condition fix: before the
   * local state is finalized as CANCELLED, replay the order's trade history from the exchange to
   * check whether it actually filled in the gap between the cancel request landing and this
   * check running. If the replay itself errors, fail open — proceed with CANCELLED rather than
   * getting stuck, since a fix for a race condition must never introduce a new stuck-order mode.
   *
   * Returns null if there's nothing to cancel (unknown clientOrderId, or the order was never
   * confirmed on the exchange in the first place — e.g. still UNKNOWN).
   */
  async cancelOrder(clientOrderId: string): Promise<CancelResult | null> {
    const local = this.registry.get(clientOrderId);
    if (!local || local.exchangeOrderId === null) return null;
    const exchangeOrderId = local.exchangeOrderId;

    local.state = "PENDING_CANCEL";
    local.updatedAt = Date.now();
    this.registry.upsert(local);

    try {
      await this.adapter.cancelOrder(exchangeOrderId, this.market);
    } catch {
      // The cancel call itself failing (e.g. "already filled/gone" on the exchange side) is not
      // fatal here — the fill-replay check below is what actually determines the correct final
      // state, not whether this call succeeded.
    }

    let fills: NormalizedFill[] = [];
    let failedOpen = false;
    try {
      fills = await this.adapter.getOrderFills(exchangeOrderId, this.market);
    } catch {
      failedOpen = true;
    }

    // getOrderFills() reports the order's full fill history, not just "new since last check" —
    // taking it as authoritative (rather than summing onto local.filledSize) avoids
    // double-counting across repeated calls, e.g. a retried cancel.
    const totalFilled = failedOpen
      ? local.filledSize
      : Math.max(
          local.filledSize,
          fills.reduce((sum, f) => sum + f.size, 0),
        );

    const finalState: "CANCELLED" | "FILLED" = totalFilled >= local.size ? "FILLED" : "CANCELLED";

    local.filledSize = totalFilled;
    local.state = finalState;
    local.updatedAt = Date.now();
    local.note = failedOpen
      ? "getOrderFills lookup failed during cancel race-check; failed open per SPEC.md Section 5a"
      : undefined;
    this.registry.upsert(local);

    return { finalState, fillsApplied: fills, failedOpen };
  }
}
