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
import { TradeLog, type TradeLogEntry } from "./TradeLog.js";
import type { EngineMarketConfig } from "./types.js";

export interface CycleSummary {
  market: string;
  reconciliation: ReconciliationResult;
  quotesPlaced: number;
  quotesAttempted: number;
  quotesCancelled: number;
  /** Count of this cycle's quote-ladder placement attempts that did not succeed (attempted minus
   * placed). Exists specifically so a cycle where every attempt fails is visible in the same log
   * line as quotesAttempted/quotesPlaced, rather than only inferable by comparing the two. */
  quotesFailed: number;
  /** Deduplicated, capped (max 5) failure messages from this cycle's failed placement attempts —
   * OrderLifecycle already logs each one to the console, but a systemic failure (e.g. every
   * attempt failing for the same reason) previously left zero trace in the per-cycle log file
   * itself, the one artifact a completed run actually leaves behind. */
  quoteFailureMessages: string[];
  reduceOnlyAction: "placed" | "repriced" | "held" | "skipped_duplicate" | "none";
  /** Set when the entire cycle skipped new placements (margin risk, degraded reconciliation) —
   * not just an individual order rejection. */
  blockedReason?: string;
}

export interface MarketEngineOptions {
  /** Per-market OrderRegistry snapshot file (SPEC.md Section 9.4). */
  stateFilePath: string;
  /** Per-market durable, append-only fill log (SPEC.md Section 7). */
  tradeLogFilePath: string;
  /** Forwarded straight into this market's TradeLog (see TradeLogOptions) — MarketEngine stays
   * alerting-agnostic, this is just a pass-through callback. */
  onFillRecorded?: (entry: TradeLogEntry) => void;
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
  readonly tradeLog: TradeLog;

  private sessionRealizedPnlUsd = 0;
  private started = false;
  // Defaults healthy: PaperRunner only ever calls markSessionPnlUnavailable() after a real
  // drain attempt fails, and startup (run-live.ts) aborts before any cycle runs if the initial
  // live PnL probe itself fails — so runCycle() is never reachable with this genuinely unknown.
  private sessionPnlUnavailable = false;
  private sessionPnlUnavailableReason?: string;

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly config: EngineMarketConfig,
    options: MarketEngineOptions,
  ) {
    this.registry = new OrderRegistry(config.symbol, options.stateFilePath);
    this.tradeLog = new TradeLog(options.tradeLogFilePath, {
      onFillRecorded: options.onFillRecorded,
    });
    this.lifecycle = new OrderLifecycle(adapter, this.registry, config.symbol, this.tradeLog);
    this.reconciliation = new Reconciliation(adapter, this.registry, config.symbol, this.tradeLog);
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

  /** Session-delta placeholder for realized PnL accumulation. Fills are now durably logged
   * (SPEC.md Section 7, see tradeLog) but this still isn't derived from that log — deriving
   * proper fill-level PnL accounting from it is separate future work. Callers apply deltas as
   * fills are processed. */
  recordRealizedPnl(deltaUsd: number): void {
    this.sessionRealizedPnlUsd += deltaUsd;
  }

  getSessionRealizedPnlUsd(): number {
    return this.sessionRealizedPnlUsd;
  }

  /** Called by PaperRunner when a cycle's RealizedPnlSource.drainRealizedPnlDeltaUsd() throws.
   * RiskManager's sessionLossCapUsd check only means anything if sessionRealizedPnlUsd is
   * actually current — trading on with a PnL feed known to be broken would let real losses
   * accrue past the cap in silence, exactly the gap that made run-live.ts's always-zero stub
   * unacceptable. Takes effect starting the NEXT runCycle() (this cycle has already run by the
   * time PaperRunner drains PnL) — the same one-cycle lag sessionRealizedPnlUsd itself already
   * has via recordRealizedPnl(). */
  markSessionPnlUnavailable(reason: string): void {
    this.sessionPnlUnavailable = true;
    this.sessionPnlUnavailableReason = reason;
  }

  /** Called by PaperRunner once a drain succeeds again after a prior failure — clears the block
   * so quoting/exits resume. A no-op when already healthy. */
  confirmSessionPnlHealthy(): void {
    this.sessionPnlUnavailable = false;
    this.sessionPnlUnavailableReason = undefined;
  }

  async runCycle(): Promise<CycleSummary> {
    if (!this.started) {
      throw new Error(
        `MarketEngine for ${this.config.symbol}: start() must be called before runCycle()`,
      );
    }

    const reconciliationResult = await this.reconciliation.checkAgainstExchange();
    // Reconciliation may have just resolved a vanished order straight into the registry (a real
    // fill explaining a LOCAL_ORDER_NOT_ON_EXCHANGE anomaly) — persist that immediately, since a
    // still-degraded cycle (e.g. a genuinely unexplained anomaly elsewhere) returns early below,
    // before the save() at the end of this method would otherwise run.
    this.registry.save();

    const summary: CycleSummary = {
      market: this.config.symbol,
      reconciliation: reconciliationResult,
      quotesPlaced: 0,
      quotesAttempted: 0,
      quotesCancelled: 0,
      quotesFailed: 0,
      quoteFailureMessages: [],
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

    // Session realized-PnL feeds RiskManager's sessionLossCapUsd check directly (see
    // manageQuoteLadder's canPlaceOrder call below) — if the last drain attempt failed, that
    // number is stale/unknown, so the loss cap can no longer be trusted to catch a real breach.
    // Blocks reduce-only exits too, same as the reconciliation-degraded block above: a reduce-
    // only exit is still a new placement, and there is no case where placing one is safer than
    // holding while the risk gate itself is unconfirmed.
    if (this.sessionPnlUnavailable) {
      summary.blockedReason =
        `Session realized-PnL unavailable for ${this.config.symbol} ` +
        `(${this.sessionPnlUnavailableReason}); holding all new placements this cycle`;
      return summary;
    }

    const position = this.adapter.getPositions(this.config.symbol)[0];
    const currentBaseSize = position?.baseSize ?? 0;

    // SPEC.md Section 5c: inventory management is a dedicated reduce-only exit, not a skew
    // applied to the normal ladder below.
    if (Math.abs(currentBaseSize) > this.config.inventoryReductionThresholdBase) {
      summary.reduceOnlyAction = await this.manageReduceOnlyExit(currentBaseSize);
    }

    const { placed, attempted, cancelled, failureMessages } = await this.manageQuoteLadder(
      position,
      reconciliationResult,
    );
    summary.quotesPlaced = placed;
    summary.quotesAttempted = attempted;
    summary.quotesCancelled = cancelled;
    summary.quotesFailed = attempted - placed;
    summary.quoteFailureMessages = failureMessages;

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
  ): Promise<{ placed: number; attempted: number; cancelled: number; failureMessages: string[] }> {
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
    const failureMessages: string[] = [];
    const MAX_FAILURE_MESSAGES = 5;

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
      if (result.success) {
        placed++;
      } else if (
        result.message !== undefined &&
        !failureMessages.includes(result.message) &&
        failureMessages.length < MAX_FAILURE_MESSAGES
      ) {
        failureMessages.push(result.message);
      }
    }

    return { placed, attempted, cancelled, failureMessages };
  }
}
