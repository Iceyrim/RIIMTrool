import { randomBytes } from "node:crypto";
import type {
  ExchangeAdapter,
  NormalizedFill,
  OrderSide,
  OrderType,
} from "../adapters/ExchangeAdapter.js";
import type { OrderRegistry } from "./OrderRegistry.js";
import type { TradeLog } from "./TradeLog.js";
import { CANCEL_CONFIRM_GRACE_MS, type LocalOrder, type ReduceOnlyExitConfig } from "./types.js";

export interface PlaceQuoteResult {
  success: boolean;
  order?: LocalOrder;
  message?: string;
}

export interface CancelResult {
  finalState: "CANCELLED" | "FILLED" | "CANCEL_PENDING_CONFIRM";
  fillsApplied: NormalizedFill[];
  /** True only when the adapter explicitly confirmed cancellation. Capacity accounting must not
   * assume a failed-open local CANCELLED transition removed the exchange order. */
  cancellationConfirmed: boolean;
  /** True if the getOrderFills() race-check lookup itself errored and we proceeded anyway
   * (SPEC.md Section 5a: fail open, never let this check become a new stuck-order mode). */
  failedOpen: boolean;
}

export type ReduceOnlyRepriceDecision = "hold" | "eligible" | "forced";

function generateClientOrderId(registry: OrderRegistry): string {
  while (true) {
    const bytes = randomBytes(8);
    bytes[0] = bytes[0]! & 0x7f;
    const clientOrderId = bytes.readBigUInt64BE().toString(10);
    if (clientOrderId !== "0" && registry.get(clientOrderId) === undefined) {
      return clientOrderId;
    }
  }
}

/**
 * Owns the full order placement/cancellation flow for one market, implementing SPEC.md Sections
 * 5a (cancel race condition), 5b (silent placement failure), and 5c (reduce-only exit handling).
 */
export class OrderLifecycle {
  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly registry: OrderRegistry,
    private readonly market: string,
    private readonly tradeLog: TradeLog,
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
   *  - `isReduceOnly: true` is sent to the exchange and recorded locally, so the exchange itself
   *    prevents an exit from increasing or reversing exposure while the engine retains its
   *    duplicate guard and dedicated refresh behavior.
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
    return this.placeOrderInternal(params, { exchangeReduceOnly: true, localReduceOnly: true });
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
    const clientOrderId = generateClientOrderId(this.registry);
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
        console.warn(
          `[OrderLifecycle:${this.market}] placement UNRESOLVED_NOT_CONFIRMED ` +
            `(${params.side} ${params.size}@${params.price}, clientOrderId=${clientOrderId}): ` +
            `${result.message}`,
        );
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
      // REJECTED: the exchange definitively refused the order. Nothing to track locally — but the
      // failure itself must still be visible (this was previously a fully silent drop: 340
      // consecutive REJECTED placements in one real run produced zero console output and zero
      // anomalies, indistinguishable from "nothing to quote").
      console.error(
        `[OrderLifecycle:${this.market}] placement REJECTED ` +
          `(${params.side} ${params.size}@${params.price}, clientOrderId=${clientOrderId}): ` +
          `${result.message}`,
      );
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

    // Covers both a full fill and a partial fill reported synchronously at placement time —
    // SPEC.md Section 7 requires every real fill logged, not just ones that reach FILLED.
    for (const fill of result.fills) {
      this.tradeLog.record(fill, {
        isReduceOnly: options.localReduceOnly,
        clientOrderId,
        source: "placement",
      });
    }

    return { success: true, order: local };
  }

  /**
   * Cancels a resting order, implementing SPEC.md Section 5a's race-condition fix: before the
   * local state is finalized as CANCELLED, replay the order's trade history from the exchange to
   * check whether it actually filled in the gap between the cancel request landing and this
   * check running.
   *
   * This snapshot only catches a fill that landed *before* it runs. It cannot catch one that
   * lands *after* — in the gap between this snapshot and the exchange actually finishing the
   * cancel — because N1's cancelOrder() response carries no stronger confirmation than "the call
   * didn't throw" (the same shallow-confirmation shape placeOrder() had before the 5b fix, minus
   * any equivalent to getOrderFills() to double-check it). That residual gap is what produced a
   * real, observed drift: trades-ETHUSD.jsonl's net signed volume drifted to -0.887 base while the
   * live-logged real position stayed bounded within its ±0.15 risk limit the whole time — orphaned
   * covering buys on large, long-resting reduce-only exits, never BTC's tiny orders which rarely
   * hit the race window.
   *
   * So this snapshot alone can no longer safely finalize CANCELLED when it doesn't show a full
   * fill — that's left CANCEL_PENDING_CONFIRM for Reconciliation's grace-period recheck
   * (checkAgainstExchange()) to resolve over subsequent cycles. Only a fill-lookup that itself
   * errors fails open immediately here (SPEC.md Section 5a: this check must never become a new
   * stuck-order mode) — the Reconciliation-side recheck has bounded retries where this one call
   * does not.
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

    let cancellationConfirmed = false;
    try {
      const cancellation = await this.adapter.cancelOrder(exchangeOrderId, this.market);
      cancellationConfirmed = cancellation.success;
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

    for (const fill of fills) {
      this.tradeLog.record(fill, {
        isReduceOnly: local.isReduceOnly,
        clientOrderId,
        source: "cancel_race_check",
      });
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

    const now = Date.now();
    const finalState: "CANCELLED" | "FILLED" | "CANCEL_PENDING_CONFIRM" =
      totalFilled >= local.size
        ? "FILLED"
        : failedOpen
          ? "CANCELLED" // fail open per SPEC.md Section 5a — lookup itself errored, nothing more
          : "CANCEL_PENDING_CONFIRM"; // not fully filled by this snapshot, but not yet safely
    // terminal either — Reconciliation's grace-period recheck resolves it from here.

    local.filledSize = totalFilled;
    local.state = finalState;
    local.updatedAt = now;
    local.cancelGraceUntil = finalState === "CANCEL_PENDING_CONFIRM" ? now + CANCEL_CONFIRM_GRACE_MS : undefined;
    local.note = failedOpen
      ? "getOrderFills lookup failed during cancel race-check; failed open per SPEC.md Section 5a"
      : finalState === "CANCEL_PENDING_CONFIRM"
        ? "Cancel requested but not yet fill-confirmed gone from the exchange; awaiting Reconciliation's grace-period recheck"
        : undefined;
    this.registry.upsert(local);

    return { finalState, fillsApplied: fills, cancellationConfirmed, failedOpen };
  }
}
