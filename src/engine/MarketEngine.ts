import type {
  ExchangeAdapter,
  NormalizedPosition,
  OrderSide,
} from "../adapters/ExchangeAdapter.js";
import { OrderLifecycle } from "./OrderLifecycle.js";
import { OrderRegistry } from "./OrderRegistry.js";
import { Reconciliation, type ReconciliationResult } from "./Reconciliation.js";
import { generateQuoteLadder, pickOrderSize } from "./QuoteLadder.js";
import { RiskManager } from "./RiskManager.js";
import type { EngineMarketConfig } from "./types.js";

export interface CycleSummary {
  market: string;
  reconciliation: ReconciliationResult;
  quotesPlaced: number;
  quotesAttempted: number;
  quotesCancelled: number;
  reduceOnlyAction: "placed" | "repriced" | "held" | "skipped_duplicate" | "none";
  /** Set when the entire cycle skipped new placements (margin risk, degraded reconciliation) —
   * not just an individual order rejection. */
  blockedReason?: string;
}

/**
 * Drives one market end-to-end against ExchangeAdapter: refresh -> runtime reconciliation ->
 * margin check -> inventory-triggered reduce-only exit management -> quote ladder management.
 * Built to be driven by a single call per cycle (runCycle()) so a future multi-market loop
 * (SPEC.md Section 4) can iterate several MarketEngine instances and isolate failures between
 * them without any change to this class.
 */
export class MarketEngine {
  readonly registry: OrderRegistry;
  readonly lifecycle: OrderLifecycle;
  readonly reconciliation: Reconciliation;
  readonly riskManager: RiskManager;

  private sessionRealizedPnlUsd = 0;
  private started = false;

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly config: EngineMarketConfig,
    stateFilePath: string,
  ) {
    this.registry = new OrderRegistry(config.symbol, stateFilePath);
    this.lifecycle = new OrderLifecycle(adapter, this.registry, config.symbol);
    this.reconciliation = new Reconciliation(adapter, this.registry, config.symbol);
    this.riskManager = new RiskManager(adapter);
  }

  /** Must be called once before the first runCycle(). Loads whatever local state exists on
   * disk, then immediately overrides it with exchange truth (SPEC.md Section 9.4: never restart
   * while holding a position without confirming genuinely flat/accurate state directly against
   * the exchange, not from local files). */
  async start(): Promise<ReconciliationResult> {
    this.registry.load();
    const result = await this.reconciliation.syncFromExchange();
    this.started = true;
    return result;
  }

  /** Placeholder for realized PnL accumulation until trade logging (SPEC.md Section 7) lands
   * with proper fill-level accounting. Callers apply deltas as fills are processed. */
  recordRealizedPnl(deltaUsd: number): void {
    this.sessionRealizedPnlUsd += deltaUsd;
  }

  getSessionRealizedPnlUsd(): number {
    return this.sessionRealizedPnlUsd;
  }

  async runCycle(): Promise<CycleSummary> {
    if (!this.started) {
      throw new Error(
        `MarketEngine for ${this.config.symbol}: start() must be called before runCycle()`,
      );
    }

    const reconciliationResult = await this.reconciliation.checkAgainstExchange();

    const summary: CycleSummary = {
      market: this.config.symbol,
      reconciliation: reconciliationResult,
      quotesPlaced: 0,
      quotesAttempted: 0,
      quotesCancelled: 0,
      reduceOnlyAction: "none",
    };

    const marginCheck = this.riskManager.checkMarginHealth();
    if (!marginCheck.allowed) {
      summary.blockedReason = marginCheck.reason;
      return summary;
    }

    if (!reconciliationResult.healthy) {
      summary.blockedReason =
        `Reconciliation degraded (streak ${this.reconciliation.getDegradedStreak()}); ` +
        `holding all new placements for ${this.config.symbol} this cycle`;
      return summary;
    }

    const position = this.adapter.getPositions(this.config.symbol)[0];
    const currentBaseSize = position?.baseSize ?? 0;

    // SPEC.md Section 5c: inventory management is a dedicated reduce-only exit, not a skew
    // applied to the normal ladder below.
    if (Math.abs(currentBaseSize) > this.config.inventoryReductionThresholdBase) {
      summary.reduceOnlyAction = await this.manageReduceOnlyExit(currentBaseSize);
    }

    const { placed, attempted, cancelled } = await this.manageQuoteLadder(
      position,
      reconciliationResult,
    );
    summary.quotesPlaced = placed;
    summary.quotesAttempted = attempted;
    summary.quotesCancelled = cancelled;

    this.registry.save();
    return summary;
  }

  private computeExitPrice(currentBaseSize: number, markPrice: number): number {
    // Exiting a long means selling, so price slightly above mark to still capture the exit
    // spread as a maker; exiting a short means buying, so slightly below. Anchored once at
    // placement time by the caller — SPEC.md Section 5c requires this NOT be re-derived while
    // an exit order is still within its minimum hold window.
    const offset = markPrice * (this.config.exitSpreadBps / 10_000);
    return currentBaseSize > 0 ? markPrice + offset : markPrice - offset;
  }

  private async manageReduceOnlyExit(
    currentBaseSize: number,
  ): Promise<CycleSummary["reduceOnlyAction"]> {
    const existing = this.registry
      .list()
      .find((o) => o.isReduceOnly && (o.state === "RESTING" || o.state === "PENDING_CANCEL"));

    if (existing) {
      const decision = this.lifecycle.shouldRepriceReduceOnlyExit(
        existing,
        this.config.reduceOnlyExit,
      );
      if (decision === "hold") return "held";

      if (decision === "eligible") {
        // SPEC.md Section 5c specifies the min/max hold times exactly but not a fixed
        // "how far did price move" threshold in between — using exitSpreadBps as that threshold
        // here, since it's the config value already governing how this order is priced. Only
        // reprice early (before the forced ceiling) if the market has drifted past it.
        const marketPrice = await this.adapter.getMarketPrice(this.config.symbol);
        const target = this.computeExitPrice(currentBaseSize, marketPrice.mark);
        const driftBps = (Math.abs(target - existing.price) / existing.price) * 10_000;
        if (driftBps < this.config.exitSpreadBps) return "held";
      }

      // "forced" (past the max-hold ceiling) always reprices; "eligible" reprices only on
      // sufficient drift, handled above.
      await this.lifecycle.cancelOrder(existing.clientOrderId);
      // Deliberately one action per cycle: placement of the replacement happens next cycle, once
      // manageReduceOnlyExit sees no existing order. Keeps each cycle's action observable/simple.
      return "repriced";
    }

    const marketPrice = await this.adapter.getMarketPrice(this.config.symbol);
    const exitPrice = this.computeExitPrice(currentBaseSize, marketPrice.mark);
    const side: OrderSide = currentBaseSize > 0 ? "sell" : "buy";
    const size = Math.min(Math.abs(currentBaseSize), this.config.riskLimits.maxOrderSize);

    const result = await this.lifecycle.placeReduceOnlyExit({
      side,
      type: "postOnly",
      size,
      price: exitPrice,
    });
    if (!result.success) {
      return result.message?.includes("already open") ? "skipped_duplicate" : "none";
    }
    return "placed";
  }

  private async manageQuoteLadder(
    position: NormalizedPosition | undefined,
    reconciliationResult: ReconciliationResult,
  ): Promise<{ placed: number; attempted: number; cancelled: number }> {
    const now = Date.now();
    const restingQuotes = this.registry.listByState("RESTING").filter((o) => !o.isReduceOnly);

    let cancelled = 0;
    const stale = restingQuotes.filter(
      (o) => now - o.placedAt >= this.config.quoteMinimumLifetimeMs,
    );
    for (const order of stale) {
      const result = await this.lifecycle.cancelOrder(order.clientOrderId);
      if (result) cancelled++;
    }

    // Re-read what's still resting after cancellation so we don't double up on levels that are
    // still fresh from a previous cycle.
    const stillResting = this.registry.listByState("RESTING").filter((o) => !o.isReduceOnly);

    const marketPrice = await this.adapter.getMarketPrice(this.config.symbol);
    const size = pickOrderSize(this.config.orderSize);
    const ladder = generateQuoteLadder({
      reservationPrice: marketPrice.mark,
      levelSpacingBps: this.config.levelSpacingBps,
      sizePerLevel: size,
    });

    const nearestLevelBps = this.config.levelSpacingBps[0] ?? 1;

    let placed = 0;
    let attempted = 0;

    for (const level of ladder) {
      const alreadyCovered = stillResting.some(
        (o) =>
          o.side === level.side &&
          Math.abs(o.price - level.price) / level.price < nearestLevelBps / 10_000 / 2,
      );
      if (alreadyCovered) continue;

      const riskCheck = this.riskManager.canPlaceOrder({
        market: this.config.symbol,
        side: level.side,
        size: level.size,
        price: level.price,
        limits: this.config.riskLimits,
        currentPosition: position,
        lastReconciliation: reconciliationResult,
        sessionRealizedPnlUsd: this.sessionRealizedPnlUsd,
        sessionLossCapUsd: this.config.sessionLossCapUsd,
      });
      if (!riskCheck.allowed) continue;

      attempted++;
      const result = await this.lifecycle.placeQuote({
        side: level.side,
        type: "postOnly",
        size: level.size,
        price: level.price,
      });
      if (result.success) placed++;
    }

    return { placed, attempted, cancelled };
  }
}
