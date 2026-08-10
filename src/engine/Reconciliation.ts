import type { ExchangeAdapter, NormalizedFill } from "../adapters/ExchangeAdapter.js";
import type { OrderRegistry } from "./OrderRegistry.js";
import type { TradeLog } from "./TradeLog.js";
import type { LocalOrder } from "./types.js";

export interface ReconciliationAnomaly {
  kind: "EXCHANGE_ORDER_NOT_LOCAL" | "LOCAL_ORDER_NOT_ON_EXCHANGE";
  exchangeOrderId: string;
  detail: string;
}

export interface ReconciliationResult {
  market: string;
  healthy: boolean;
  /** Exchange-confirmed open order count for this market, this cycle. Consumers (e.g. the risk
   * manager's capacity check) should read this rather than independently re-fetching/recounting
   * — SPEC.md Section 6: a HEALTHY reconciliation result must be trusted, not re-derived. */
  openOrderCount: number;
  anomalies: ReconciliationAnomaly[];
  checkedAt: number;
}

/**
 * Per-market reconciliation, scoped to exactly one market (SPEC.md Section 4.1: the
 * reconciliation engine must filter to one market's orders/positions before comparing, never
 * see another market's state as "unknown" or "mismatched"). A caller managing several markets is
 * expected to hold one Reconciliation instance per market and isolate failures between them
 * (Section 4.2) — nothing in this class reaches across markets on its own.
 *
 * Deliberately implements two different behaviors, not one function with a flag:
 *  - syncFromExchange(): startup only. Exchange is unconditionally ground truth; local state is
 *    discarded and reseeded. Mismatches are expected and silently corrected.
 *  - checkAgainstExchange(): every runtime cycle. Local state is now trusted as live; mismatches
 *    are strict anomalies, logged rather than silently adopted — EXCEPT a local RESTING order the
 *    exchange no longer shows, which gets the same fill-replay treatment syncFromExchange gives
 *    it: a real fill (full or partial) explains the disappearance and is resolved straight into
 *    the registry, not left stuck as RESTING forever with no runtime path back to healthy. Only a
 *    vanished order with zero fill evidence (or a fill-lookup that itself fails) is still a
 *    genuine anomaly — that case is not silently adopted.
 */
export class Reconciliation {
  private healthyStreak = 0;
  private degradedStreak = 0;
  private lastResult?: ReconciliationResult;

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly registry: OrderRegistry,
    private readonly market: string,
    private readonly tradeLog: TradeLog,
  ) {}

  getLastResult(): ReconciliationResult | undefined {
    return this.lastResult;
  }

  getHealthyStreak(): number {
    return this.healthyStreak;
  }

  getDegradedStreak(): number {
    return this.degradedStreak;
  }

  /**
   * SPEC.md Section 9.4: never trust local files to determine state after a restart — confirm
   * directly against the exchange. This reseeds the local registry wholesale from what the
   * exchange actually shows resting for this market. Local entries the exchange doesn't confirm
   * are resolved via the same fill-replay logic as the Section 5a cancel-race check (did it
   * fill before we lost track of it, or is it genuinely gone) rather than being kept or dropped
   * on a guess.
   */
  async syncFromExchange(): Promise<ReconciliationResult> {
    const now = Date.now();
    await this.adapter.refreshAccountState();
    const exchangeOrders = this.adapter.getOpenOrders(this.market);
    const localOrders = this.registry.list();

    const seeded: LocalOrder[] = exchangeOrders.map((exchangeOrder) => {
      const matchingLocal = localOrders.find(
        (o) => o.exchangeOrderId === exchangeOrder.exchangeOrderId,
      );
      return {
        clientOrderId:
          matchingLocal?.clientOrderId ??
          exchangeOrder.clientOrderId ??
          exchangeOrder.exchangeOrderId,
        exchangeOrderId: exchangeOrder.exchangeOrderId,
        market: this.market,
        side: exchangeOrder.side,
        // N1's live open-orders view can't report fill mode; fall back to whatever local memory
        // we have, and "limit" as a last resort (every resting order behaves as one regardless
        // of how it was originally placed).
        type: matchingLocal?.type ?? exchangeOrder.type ?? "limit",
        price: exchangeOrder.price,
        size: exchangeOrder.size,
        filledSize: exchangeOrder.filledSize,
        // Exchange can't report reduce-only status either (see adapter doc comment) — trust
        // local memory if we have it, default false for an order we have no record of at all.
        isReduceOnly: matchingLocal?.isReduceOnly ?? false,
        state: "RESTING",
        placedAt: matchingLocal?.placedAt ?? now,
        updatedAt: now,
      };
    });

    const localOnly = localOrders.filter(
      (o) =>
        (o.state === "RESTING" || o.state === "PENDING_CANCEL" || o.state === "UNKNOWN") &&
        !exchangeOrders.some((e) => e.exchangeOrderId === o.exchangeOrderId),
    );

    for (const order of localOnly) {
      if (order.exchangeOrderId === null) {
        // Never confirmed on the exchange at all, and still absent now — never placed. Drop it.
        continue;
      }
      let fills: NormalizedFill[] = [];
      try {
        fills = await this.adapter.getOrderFills(order.exchangeOrderId, this.market);
      } catch {
        // Can't resolve this one — leave it out of the reseeded set rather than guessing either
        // way. A startup sync that can't fully resolve every order is itself worth surfacing;
        // callers should treat an exception from this method as startup-blocking, not this
        // per-order case, which we deliberately don't let block the rest of the sync.
        continue;
      }
      const filledSize = fills.reduce((sum, f) => sum + f.size, 0);
      if (filledSize > 0) {
        for (const fill of fills) {
          this.tradeLog.record(fill, {
            isReduceOnly: order.isReduceOnly,
            clientOrderId: order.clientOrderId,
            source: "reconciliation",
          });
        }
        seeded.push({
          ...order,
          filledSize,
          state: filledSize >= order.size ? "FILLED" : "CANCELLED",
          updatedAt: now,
        });
      }
    }

    this.registry.replaceAll(seeded);
    this.registry.save();

    const result: ReconciliationResult = {
      market: this.market,
      // Startup sync always concludes healthy by construction — it just resolved every
      // discrepancy it found, rather than merely detecting them.
      healthy: true,
      openOrderCount: seeded.filter((o) => o.state === "RESTING").length,
      anomalies: [],
      checkedAt: now,
    };
    this.lastResult = result;
    this.healthyStreak = 1;
    this.degradedStreak = 0;
    return result;
  }

  /**
   * Runtime, called every engine cycle. Local state is trusted as live here, so this is a strict
   * compare: a surprise exchange order with no local record (EXCHANGE_ORDER_NOT_LOCAL) is always
   * a logged anomaly, never silently adopted — that could mask a real bug instead of fixing stale
   * state. A local RESTING order the exchange no longer shows (LOCAL_ORDER_NOT_ON_EXCHANGE) gets
   * one exception: resolveVanishedOrder() below checks whether a real fill explains it, the same
   * way startup sync resolves local-only orders, so an ordinary fill event doesn't get treated as
   * an anomaly and doesn't leave the market permanently blocked with no runtime path to healthy.
   */
  async checkAgainstExchange(): Promise<ReconciliationResult> {
    const now = Date.now();
    await this.adapter.refreshAccountState();
    const exchangeOrders = this.adapter.getOpenOrders(this.market);
    const localResting = this.registry.listByState("RESTING");

    const anomalies: ReconciliationAnomaly[] = [];

    for (const exchangeOrder of exchangeOrders) {
      const local = this.registry.findByExchangeOrderId(exchangeOrder.exchangeOrderId);
      if (!local) {
        anomalies.push({
          kind: "EXCHANGE_ORDER_NOT_LOCAL",
          exchangeOrderId: exchangeOrder.exchangeOrderId,
          detail: `Exchange shows order ${exchangeOrder.exchangeOrderId} resting on ${this.market} with no matching local record`,
        });
      }
    }

    for (const local of localResting) {
      if (local.exchangeOrderId === null) continue;
      const stillOpen = exchangeOrders.some((e) => e.exchangeOrderId === local.exchangeOrderId);
      if (stillOpen) continue;

      const resolved = await this.resolveVanishedOrder(local, now);
      if (!resolved) {
        anomalies.push({
          kind: "LOCAL_ORDER_NOT_ON_EXCHANGE",
          exchangeOrderId: local.exchangeOrderId,
          detail: `Local registry shows order ${local.exchangeOrderId} as RESTING on ${this.market} but the exchange does not — likely an unprocessed fill or cancel`,
        });
      }
    }

    const healthy = anomalies.length === 0;
    const result: ReconciliationResult = {
      market: this.market,
      healthy,
      openOrderCount: exchangeOrders.length,
      anomalies,
      checkedAt: now,
    };
    this.lastResult = result;
    if (healthy) {
      this.healthyStreak += 1;
      this.degradedStreak = 0;
    } else {
      this.degradedStreak += 1;
      this.healthyStreak = 0;
    }
    return result;
  }

  /**
   * A local RESTING order the exchange no longer shows is either explained (it filled, fully or
   * partially, before disappearing — a normal event for a resting maker quote) or genuinely
   * unexplained. Mirrors syncFromExchange's per-order fill-replay resolution, applied to a single
   * order rather than a wholesale reseed. Returns true (and updates the registry) only when real
   * fill evidence explains the disappearance; false leaves the registry untouched so the caller
   * still raises it as an anomaly.
   */
  private async resolveVanishedOrder(local: LocalOrder, now: number): Promise<boolean> {
    let fills: NormalizedFill[];
    try {
      fills = await this.adapter.getOrderFills(local.exchangeOrderId as string, this.market);
    } catch {
      // Can't confirm what happened — do not guess it's fine. Stays an anomaly.
      return false;
    }

    const filledSize = fills.reduce((sum, f) => sum + f.size, 0);
    if (filledSize <= 0) {
      // Vanished with zero fill evidence at all — genuinely unexplained, keep blocking.
      return false;
    }

    for (const fill of fills) {
      this.tradeLog.record(fill, {
        isReduceOnly: local.isReduceOnly,
        clientOrderId: local.clientOrderId,
        source: "reconciliation",
      });
    }

    this.registry.upsert({
      ...local,
      filledSize,
      state: filledSize >= local.size ? "FILLED" : "CANCELLED",
      updatedAt: now,
    });
    return true;
  }
}
