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
import type { AccountRiskState, EngineMarketConfig } from "./types.js";

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
  riskSkippedLevels: {
    openOrderCapacity: number;
    aggregateLongExposure: number;
    aggregateShortExposure: number;
    orderSize: number;
    orderNotional: number;
  };
  /** Deduplicated, capped reasons explaining ladder levels denied before placement. */
  riskSkipMessages: string[];
  /** Managed resting-order cleanup performed while session PnL is unavailable. */
  pnlOutageCancellation: {
    attempted: number;
    succeeded: number;
    failed: number;
    unresolved: number;
    messages: string[];
  };
  quoteRefreshReason?:
    | "empty ladder placement"
    | "below-minimum hold"
    | "below-threshold hold"
    | "threshold refresh"
    | "maximum-age refresh";
  reduceOnlyAction: "placed" | "repriced" | "held" | "skipped_duplicate" | "none";
  positionBaseSize: number;
  inventoryReductionThresholdBase: number;
  reductionMode: boolean;
  reductionModeCancellation: {
    attempted: number;
    succeeded: number;
    unresolved: number;
    messages: string[];
  };
  exitState:
    | "no_position"
    | "below_threshold"
    | "blocked"
    | "placed"
    | "held"
    | "repriced"
    | "placement_failed"
    | "unresolved";
  exitDetails?: {
    size?: number;
    price?: number;
    orderId?: string;
    ageMs?: number;
    driftBps?: number;
    cause?: string;
  };
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
  /** Shared by every engine belonging to one configured account. PaperRunner installs one
   * automatically; live construction may inject it before the runner exists. */
  accountRiskState?: AccountRiskState;
}

export interface ManagedOrderCleanupResult {
  market: string;
  attempted: string[];
  cancelled: string[];
  terminal: string[];
  failed: string[];
  unresolved: string[];
  successful: boolean;
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

  private accountRiskState: AccountRiskState;
  private started = false;
  // Defaults healthy: PaperRunner only ever calls markSessionPnlUnavailable() after a real
  // drain attempt fails, and startup (run-live.ts) aborts before any cycle runs if the initial
  // live PnL probe itself fails — so runCycle() is never reachable with this genuinely unknown.
  private quiescing = false;
  private quoteLadderReferencePrice?: number;
  private lastCycleSummary?: CycleSummary;

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly config: EngineMarketConfig,
    options: MarketEngineOptions,
  ) {
    this.accountRiskState = options.accountRiskState ?? {
      sessionRealizedPnlUsd: 0,
      sessionLossCapUsd:
        config.accountSessionLossCapUsd ??
        // Compatibility for programmatic test fixtures during the configuration migration.
        ((config as EngineMarketConfig & { sessionLossCapUsd?: number }).sessionLossCapUsd ?? 6),
      pnlAvailable: true,
    };
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
    this.accountRiskState.sessionRealizedPnlUsd += deltaUsd;
  }

  getSessionRealizedPnlUsd(): number {
    return this.accountRiskState.sessionRealizedPnlUsd;
  }

  setAccountRiskState(state: AccountRiskState): void {
    this.accountRiskState = state;
  }

  getAccountRiskState(): Readonly<AccountRiskState> {
    return this.accountRiskState;
  }

  getLastCycleSummary(): CycleSummary | undefined {
    return this.lastCycleSummary;
  }

  private finishSummary(summary: CycleSummary): CycleSummary {
    this.lastCycleSummary = summary;
    return summary;
  }

  /** Permanently prevents this engine instance from beginning another placement. */
  quiesce(): void {
    this.quiescing = true;
  }

  /**
   * Cancels only exchange-confirmed open orders that are also present in this engine's registry.
   * Each order is isolated from failures, and exchange truth is refreshed between bounded retry
   * rounds. Local state is persisted after the final verification.
   */
  async cleanupManagedOrders(maxAttempts = 3): Promise<ManagedOrderCleanupResult> {
    this.quiesce();
    const managed = new Map(
      this.registry
        .list()
        .filter(
          (order) =>
            order.exchangeOrderId !== null &&
            (order.state === "RESTING" ||
              order.state === "PENDING_CANCEL" ||
              order.state === "UNKNOWN"),
        )
        .map((order) => [order.exchangeOrderId as string, order]),
    );
    const attempted = new Set<string>();
    const cancelled = new Set<string>();
    const terminal = new Set<string>();
    const failed = new Set<string>();

    for (let round = 0; round < maxAttempts; round++) {
      try {
        await this.adapter.refreshAccountState();
      } catch {
        if (round + 1 < maxAttempts) continue;
      }

      const openIds = new Set(
        this.adapter.getOpenOrders(this.config.symbol).map((order) => order.exchangeOrderId),
      );
      for (const [exchangeOrderId, local] of managed) {
        if (!openIds.has(exchangeOrderId)) {
          await this.resolveCleanupTerminal(local, terminal, cancelled);
          continue;
        }
        attempted.add(exchangeOrderId);
        try {
          const result = await this.adapter.cancelOrder(exchangeOrderId, this.config.symbol);
          if (!result.success) failed.add(exchangeOrderId);
        } catch {
          failed.add(exchangeOrderId);
        }
      }
    }

    try {
      await this.adapter.refreshAccountState();
    } catch {
      // The final cached snapshot is still checked below and unresolved orders fail cleanup.
    }
    const finalOpenIds = new Set(
      this.adapter.getOpenOrders(this.config.symbol).map((order) => order.exchangeOrderId),
    );
    const unresolved: string[] = [];
    for (const [exchangeOrderId, local] of managed) {
      if (finalOpenIds.has(exchangeOrderId)) {
        unresolved.push(exchangeOrderId);
      } else {
        await this.resolveCleanupTerminal(local, terminal, cancelled);
      }
    }
    this.registry.save();
    return {
      market: this.config.symbol,
      attempted: [...attempted],
      cancelled: [...cancelled],
      terminal: [...terminal],
      failed: [...failed],
      unresolved,
      successful: unresolved.length === 0,
    };
  }

  private async resolveCleanupTerminal(
    local: import("./types.js").LocalOrder,
    terminal: Set<string>,
    cancelled: Set<string>,
  ): Promise<void> {
    const exchangeOrderId = local.exchangeOrderId as string;
    let filledSize = local.filledSize;
    try {
      const fills = await this.adapter.getOrderFills(exchangeOrderId, this.config.symbol);
      filledSize = Math.max(
        filledSize,
        fills.reduce((sum, fill) => sum + fill.size, 0),
      );
      for (const fill of fills) {
        this.tradeLog.record(fill, {
          isReduceOnly: local.isReduceOnly,
          clientOrderId: local.clientOrderId,
          source: "cancel_race_check",
        });
      }
    } catch {
      // Absence from the refreshed open-order view is terminal even if fill replay is unavailable.
    }
    local.filledSize = filledSize;
    local.state = filledSize >= local.size ? "FILLED" : "CANCELLED";
    local.updatedAt = Date.now();
    this.registry.upsert(local);
    terminal.add(exchangeOrderId);
    if (local.state === "CANCELLED") cancelled.add(exchangeOrderId);
  }

  /** Called by PaperRunner when a cycle's RealizedPnlSource.drainRealizedPnlDeltaUsd() throws.
   * RiskManager's sessionLossCapUsd check only means anything if sessionRealizedPnlUsd is
   * actually current — trading on with a PnL feed known to be broken would let real losses
   * accrue past the cap in silence, exactly the gap that made run-live.ts's always-zero stub
   * unacceptable. Takes effect starting the NEXT runCycle() (this cycle has already run by the
   * time PaperRunner drains PnL) — the same one-cycle lag sessionRealizedPnlUsd itself already
   * has via recordRealizedPnl(). */
  markSessionPnlUnavailable(reason: string): void {
    this.accountRiskState.pnlAvailable = false;
    this.accountRiskState.pnlUnavailableReason = reason;
  }

  /** Called by PaperRunner once a drain succeeds again after a prior failure — clears the block
   * so quoting/exits resume. A no-op when already healthy. */
  confirmSessionPnlHealthy(): void {
    this.accountRiskState.pnlAvailable = true;
    this.accountRiskState.pnlUnavailableReason = undefined;
  }

  async runCycle(): Promise<CycleSummary> {
    if (!this.started) {
      throw new Error(
        `MarketEngine for ${this.config.symbol}: start() must be called before runCycle()`,
      );
    }

    if (this.quiescing) {
      throw new Error(`MarketEngine for ${this.config.symbol}: quiescing; cycle refused`);
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
      riskSkippedLevels: {
        openOrderCapacity: 0,
        aggregateLongExposure: 0,
        aggregateShortExposure: 0,
        orderSize: 0,
        orderNotional: 0,
      },
      riskSkipMessages: [],
      pnlOutageCancellation: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        unresolved: 0,
        messages: [],
      },
      reduceOnlyAction: "none",
      positionBaseSize: 0,
      inventoryReductionThresholdBase: this.config.inventoryReductionThresholdBase,
      reductionMode: false,
      reductionModeCancellation: { attempted: 0, succeeded: 0, unresolved: 0, messages: [] },
      exitState: "no_position",
    };

    // A stale/unknown realized-PnL total invalidates the session loss cap. Reconciliation above
    // must still run first, but once the feed is known unavailable the safest state is no managed
    // resting exposure at all. This deliberately precedes the other early-return gates: margin or
    // reconciliation trouble must not leave our own confirmed-open orders resting.
    if (!this.accountRiskState.pnlAvailable) {
      summary.pnlOutageCancellation = await this.cancelManagedOrdersForPnlOutage();
      summary.blockedReason =
        `Account realized-PnL unavailable ` +
        `(${this.accountRiskState.pnlUnavailableReason}); holding all new placements this cycle`;
      return this.finishSummary(summary);
    }

    if (
      this.accountRiskState.sessionRealizedPnlUsd <=
      -this.accountRiskState.sessionLossCapUsd
    ) {
      summary.blockedReason =
        `Account-wide session loss cap of $${this.accountRiskState.sessionLossCapUsd} reached ` +
        `($${(-this.accountRiskState.sessionRealizedPnlUsd).toFixed(2)} realized loss); ` +
        "holding all new placements across the account";
      return this.finishSummary(summary);
    }

    const marginCheck = this.riskManager.checkMarginHealth();
    if (!marginCheck.allowed) {
      summary.blockedReason = marginCheck.reason;
      return this.finishSummary(summary);
    }

    if (!reconciliationResult.healthy) {
      summary.blockedReason =
        `Reconciliation degraded (streak ${this.reconciliation.getDegradedStreak()}); ` +
        `holding all new placements for ${this.config.symbol} this cycle`;
      return this.finishSummary(summary);
    }

    const position = this.adapter.getPositions(this.config.symbol)[0];
    const currentBaseSize = position?.baseSize ?? 0;
    summary.positionBaseSize = currentBaseSize;
    const exchangeOpenOrders = this.adapter.getOpenOrders(this.config.symbol);
    let progressiveOpenOrderCount = reconciliationResult.openOrderCount;
    let openBuyQuantity = exchangeOpenOrders
      .filter((order) => order.side === "buy")
      .reduce((sum, order) => sum + order.remainingSize, 0);
    let openSellQuantity = exchangeOpenOrders
      .filter((order) => order.side === "sell")
      .reduce((sum, order) => sum + order.remainingSize, 0);
    const exitRequired = Math.abs(currentBaseSize) > this.config.inventoryReductionThresholdBase;
    summary.reductionMode = exitRequired;
    summary.exitState = currentBaseSize === 0 ? "no_position" : "below_threshold";
    const existingExit = this.lifecycle.hasOpenReduceOnlyExit();
    let reserveExitSlot = exitRequired && !existingExit;

    // SPEC.md Section 5c: inventory management is a dedicated reduce-only exit, not a skew
    // applied to the normal ladder below.
    if (exitRequired) {
      summary.reductionModeCancellation = await this.cancelOrdinaryQuotesForReductionMode();
      if (summary.reductionModeCancellation.unresolved > 0) {
        summary.exitState = "blocked";
        summary.exitDetails = {
          cause: `${summary.reductionModeCancellation.unresolved} ordinary managed quote(s) remain unresolved`,
        };
        this.registry.save();
        return this.finishSummary(summary);
      }
      const exit = await this.manageReduceOnlyExit(currentBaseSize, progressiveOpenOrderCount);
      summary.reduceOnlyAction = exit.action;
      summary.exitState = exit.state;
      summary.exitDetails = exit.details;
      if (exit.placedOrder) {
        progressiveOpenOrderCount++;
        if (exit.placedOrder.side === "buy") openBuyQuantity += exit.placedOrder.size;
        else openSellQuantity += exit.placedOrder.size;
        reserveExitSlot = false;
      }
      this.registry.save();
      return this.finishSummary(summary);
    }

    const {
      placed,
      attempted,
      cancelled,
      failureMessages,
      riskSkippedLevels,
      riskSkipMessages,
      refreshReason,
    } =
      await this.manageQuoteLadder(position, reconciliationResult, {
        progressiveOpenOrderCount,
        openBuyQuantity,
        openSellQuantity,
        reserveExitSlot,
      });
    summary.quotesPlaced = placed;
    summary.quotesAttempted = attempted;
    summary.quotesCancelled = cancelled;
    summary.quotesFailed = attempted - placed;
    summary.quoteFailureMessages = failureMessages;
    summary.riskSkippedLevels = riskSkippedLevels;
    summary.riskSkipMessages = riskSkipMessages;
    summary.quoteRefreshReason = refreshReason;

    this.registry.save();
    return this.finishSummary(summary);
  }

  private async cancelOrdinaryQuotesForReductionMode(): Promise<CycleSummary["reductionModeCancellation"]> {
    const exchangeOpenIds = new Set(
      this.adapter.getOpenOrders(this.config.symbol).map((order) => order.exchangeOrderId),
    );
    const ordinary = this.registry.list().filter((order) =>
      !order.isReduceOnly && order.exchangeOrderId !== null &&
      (order.state === "RESTING" || order.state === "PENDING_CANCEL" || order.state === "UNKNOWN") &&
      exchangeOpenIds.has(order.exchangeOrderId),
    );
    const messages: string[] = [];
    for (const order of ordinary) {
      try {
        await this.lifecycle.cancelOrder(order.clientOrderId);
      } catch (err) {
        messages.push(`Failed to cancel ordinary quote ${order.exchangeOrderId}: ${String(err)}`);
      }
    }
    try {
      await this.adapter.refreshAccountState();
    } catch (err) {
      messages.push(`Failed to verify reduction-mode cancellations: ${String(err)}`);
    }
    const finalOpenIds = new Set(
      this.adapter.getOpenOrders(this.config.symbol).map((order) => order.exchangeOrderId),
    );
    const unresolved = ordinary.filter((order) => finalOpenIds.has(order.exchangeOrderId!)).length;
    if (unresolved > 0) messages.push(`${unresolved} ordinary managed quote(s) remain open and will be retried`);
    return { attempted: ordinary.length, succeeded: ordinary.length - unresolved, unresolved, messages: messages.slice(0, 5) };
  }

  private async cancelManagedOrdersForPnlOutage(): Promise<
    CycleSummary["pnlOutageCancellation"]
  > {
    const messages: string[] = [];
    const MAX_MESSAGES = 5;
    const openIds = new Set(
      this.adapter.getOpenOrders(this.config.symbol).map((order) => order.exchangeOrderId),
    );
    const managedActive = this.registry.list().filter(
      (order) =>
        order.exchangeOrderId !== null &&
        (order.state === "RESTING" ||
          order.state === "PENDING_CANCEL" ||
          order.state === "UNKNOWN"),
    );
    const managedOpen = managedActive.filter((order) =>
      openIds.has(order.exchangeOrderId as string),
    );

    // The cycle's reconciliation refresh already proved these IDs are no longer resting. Resolve
    // them without issuing a cancel; fill replay distinguishes filled from already-cancelled.
    for (const order of managedActive) {
      if (!openIds.has(order.exchangeOrderId as string)) {
        await this.resolveCleanupTerminal(order, new Set<string>(), new Set<string>());
      }
    }

    let failed = 0;
    for (const order of managedOpen) {
      const exchangeOrderId = order.exchangeOrderId as string;
      try {
        const result = await this.adapter.cancelOrder(exchangeOrderId, this.config.symbol);
        if (!result.success) {
          failed++;
          if (messages.length < MAX_MESSAGES) {
            messages.push(`Failed to cancel managed order ${exchangeOrderId}`);
          }
          continue;
        }
      } catch (err) {
        failed++;
        if (messages.length < MAX_MESSAGES) {
          messages.push(`Failed to cancel managed order ${exchangeOrderId}: ${String(err)}`);
        }
      }
    }

    try {
      await this.adapter.refreshAccountState();
    } catch (err) {
      if (messages.length < MAX_MESSAGES) {
        messages.push(`Failed to refresh after managed cancellation attempts: ${String(err)}`);
      }
    }
    const finalOpenIds = new Set(
      this.adapter.getOpenOrders(this.config.symbol).map((order) => order.exchangeOrderId),
    );
    let succeeded = 0;
    for (const order of managedOpen) {
      if (!finalOpenIds.has(order.exchangeOrderId as string)) {
        succeeded++;
        await this.resolveCleanupTerminal(order, new Set<string>(), new Set<string>());
      }
    }
    // Never claim the market is clean while a registry-managed ID remains exchange-open. Those
    // entries retain their prior state and are retried on the next blocked cycle.
    const unresolved = managedOpen.filter((order) =>
      finalOpenIds.has(order.exchangeOrderId as string),
    ).length;
    if (unresolved > 0 && messages.length < MAX_MESSAGES) {
      messages.push(`${unresolved} managed order(s) remain open and will be retried`);
    }
    this.registry.save();
    return {
      attempted: managedOpen.length,
      succeeded,
      failed,
      unresolved,
      messages,
    };
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
    progressiveOpenOrderCount: number,
  ): Promise<{ action: CycleSummary["reduceOnlyAction"]; state: CycleSummary["exitState"]; details?: CycleSummary["exitDetails"]; placedOrder?: { side: OrderSide; size: number } }> {
    const existing = this.registry
      .list()
      .find((o) => o.isReduceOnly && (o.state === "RESTING" || o.state === "PENDING_CANCEL"));

    if (existing) {
      const decision = this.lifecycle.shouldRepriceReduceOnlyExit(
        existing,
        this.config.reduceOnlyExit,
      );
      const ageMs = Date.now() - existing.placedAt;
      if (decision === "hold") return { action: "held", state: "held", details: { size: existing.size, price: existing.price, orderId: existing.exchangeOrderId ?? undefined, ageMs } };

      if (decision === "eligible") {
        // SPEC.md Section 5c specifies the min/max hold times exactly but not a fixed
        // "how far did price move" threshold in between — using exitSpreadBps as that threshold
        // here, since it's the config value already governing how this order is priced. Only
        // reprice early (before the forced ceiling) if the market has drifted past it.
        const marketPrice = await this.adapter.getMarketPrice(this.config.symbol);
        const target = this.computeExitPrice(currentBaseSize, marketPrice.mark);
        const driftBps = (Math.abs(target - existing.price) / existing.price) * 10_000;
        if (driftBps < this.config.exitSpreadBps) return { action: "held", state: "held", details: { size: existing.size, price: existing.price, orderId: existing.exchangeOrderId ?? undefined, ageMs, driftBps } };
      }

      // "forced" (past the max-hold ceiling) always reprices; "eligible" reprices only on
      // sufficient drift, handled above.
      await this.lifecycle.cancelOrder(existing.clientOrderId);
      // Deliberately one action per cycle: placement of the replacement happens next cycle, once
      // manageReduceOnlyExit sees no existing order. Keeps each cycle's action observable/simple.
      return { action: "repriced", state: "repriced", details: { size: existing.size, price: existing.price, orderId: existing.exchangeOrderId ?? undefined, ageMs } };
    }

    if (progressiveOpenOrderCount >= this.config.riskLimits.maxOpenOrders) {
      return { action: "none", state: "blocked", details: { cause: "open-order capacity exhausted" } };
    }

    const marketPrice = await this.adapter.getMarketPrice(this.config.symbol);
    const exitPrice = this.computeExitPrice(currentBaseSize, marketPrice.mark);
    const side: OrderSide = currentBaseSize > 0 ? "sell" : "buy";
    const size = Math.min(Math.abs(currentBaseSize), this.config.riskLimits.maxOrderSize);

    if (this.quiescing) return { action: "none", state: "blocked", details: { cause: "engine quiescing" } };
    const result = await this.lifecycle.placeReduceOnlyExit({
      side,
      type: "postOnly",
      size,
      price: exitPrice,
    });
    if (!result.success) {
      return {
        action: result.message?.includes("already open") ? "skipped_duplicate" : "none",
        state: result.order?.state === "UNKNOWN" ? "unresolved" : "placement_failed",
        details: { size, price: exitPrice, orderId: result.order?.exchangeOrderId ?? undefined, cause: result.message },
      };
    }
    return { action: "placed", state: "placed", details: { size, price: exitPrice, orderId: result.order?.exchangeOrderId ?? undefined, ageMs: 0 }, placedOrder: { side, size } };
  }

  private async manageQuoteLadder(
    position: NormalizedPosition | undefined,
    reconciliationResult: ReconciliationResult,
    riskState: {
      progressiveOpenOrderCount: number;
      openBuyQuantity: number;
      openSellQuantity: number;
      reserveExitSlot: boolean;
    },
  ): Promise<{
    placed: number;
    attempted: number;
    cancelled: number;
    failureMessages: string[];
    riskSkippedLevels: CycleSummary["riskSkippedLevels"];
    riskSkipMessages: string[];
    refreshReason?: CycleSummary["quoteRefreshReason"];
  }> {
    const now = Date.now();
    const restingQuotes = this.registry.listByState("RESTING").filter((o) => !o.isReduceOnly);
    const expectedQuoteCount = this.config.quoteLevels * 2;
    const hasManagedLadder = restingQuotes.length > 0;
    const marketPrice = await this.adapter.getMarketPrice(this.config.symbol);

    if (hasManagedLadder && this.quoteLadderReferencePrice === undefined) {
      this.quoteLadderReferencePrice =
        restingQuotes.reduce((sum, order) => sum + order.price, 0) / restingQuotes.length;
    }

    let refreshReason: CycleSummary["quoteRefreshReason"];
    let refreshTriggered = false;
    if (
      hasManagedLadder &&
      this.quoteLadderReferencePrice !== undefined
    ) {
      const oldestAgeMs = now - Math.min(...restingQuotes.map((order) => order.placedAt));
      const youngestAgeMs = now - Math.max(...restingQuotes.map((order) => order.placedAt));
      const movementBps =
        (Math.abs(marketPrice.mark - this.quoteLadderReferencePrice) /
          this.quoteLadderReferencePrice) *
        10_000;
      const maximumLifetimeMs = this.config.quoteMaximumLifetimeMs ?? 120_000;
      const repriceThresholdBps = this.config.quoteRepriceThresholdBps ?? 1;
      if (oldestAgeMs >= maximumLifetimeMs) {
        refreshReason = "maximum-age refresh";
        refreshTriggered = true;
      } else if (youngestAgeMs < this.config.quoteMinimumLifetimeMs) {
        refreshReason = "below-minimum hold";
      } else if (movementBps >= repriceThresholdBps - 1e-9) {
        refreshReason = "threshold refresh";
        refreshTriggered = true;
      } else {
        refreshReason = "below-threshold hold";
      }
    }

    const emptyRiskSkippedLevels: CycleSummary["riskSkippedLevels"] = {
      openOrderCapacity: 0,
      aggregateLongExposure: 0,
      aggregateShortExposure: 0,
      orderSize: 0,
      orderNotional: 0,
    };
    if (hasManagedLadder && !refreshTriggered) {
      return {
        placed: 0,
        attempted: 0,
        cancelled: 0,
        failureMessages: [],
        riskSkippedLevels: emptyRiskSkippedLevels,
        riskSkipMessages: [],
        refreshReason,
      };
    }

    let cancelled = 0;
    const stale = refreshTriggered ? restingQuotes : [];
    for (const order of stale) {
      const remainingBeforeCancel = Math.max(0, order.size - order.filledSize);
      const result = await this.lifecycle.cancelOrder(order.clientOrderId);
      if (result) {
        cancelled++;
        if (result.cancellationConfirmed || result.finalState === "FILLED") {
          riskState.progressiveOpenOrderCount = Math.max(0, riskState.progressiveOpenOrderCount - 1);
          if (order.side === "buy") riskState.openBuyQuantity = Math.max(0, riskState.openBuyQuantity - remainingBeforeCancel);
          else riskState.openSellQuantity = Math.max(0, riskState.openSellQuantity - remainingBeforeCancel);
        }
      }
    }

    // Re-read what's still resting after cancellation so we don't double up on levels that are
    // still fresh from a previous cycle.
    const stillResting = this.registry.listByState("RESTING").filter((o) => !o.isReduceOnly);

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
    const riskSkippedLevels = emptyRiskSkippedLevels;
    const riskSkipMessages: string[] = [];
    const MAX_RISK_MESSAGES = 5;

    for (const level of ladder) {
      const alreadyCovered = stillResting.some(
        (o) =>
          o.side === level.side &&
          Math.abs(o.price - level.price) / level.price < nearestLevelBps / 10_000 / 2,
      );
      if (alreadyCovered) continue;

      const ladderCapacity =
        this.config.riskLimits.maxOpenOrders - (riskState.reserveExitSlot ? 1 : 0);
      if (riskState.progressiveOpenOrderCount >= ladderCapacity) {
        riskSkippedLevels.openOrderCapacity++;
        const reason = `Reserved open-order capacity prevents ${level.side} ladder level ${level.size}@${level.price}; progressive count ${riskState.progressiveOpenOrderCount}, ladder capacity ${ladderCapacity}`;
        if (!riskSkipMessages.includes(reason) && riskSkipMessages.length < MAX_RISK_MESSAGES) riskSkipMessages.push(reason);
        continue;
      }

      const riskCheck = this.riskManager.canPlaceOrder({
        market: this.config.symbol,
        side: level.side,
        size: level.size,
        price: level.price,
        limits: this.config.riskLimits,
        currentPosition: position,
        lastReconciliation: reconciliationResult,
        progressiveOpenOrderCount: riskState.progressiveOpenOrderCount,
        openBuyQuantity: riskState.openBuyQuantity,
        openSellQuantity: riskState.openSellQuantity,
        sessionRealizedPnlUsd: this.accountRiskState.sessionRealizedPnlUsd,
        sessionLossCapUsd: this.accountRiskState.sessionLossCapUsd,
      });
      if (!riskCheck.allowed) {
        if (riskCheck.deniedBy === "openOrderCapacity") riskSkippedLevels.openOrderCapacity++;
        else if (riskCheck.deniedBy === "aggregateLongExposure") riskSkippedLevels.aggregateLongExposure++;
        else if (riskCheck.deniedBy === "aggregateShortExposure") riskSkippedLevels.aggregateShortExposure++;
        else if (riskCheck.deniedBy === "orderSize") riskSkippedLevels.orderSize++;
        else if (riskCheck.deniedBy === "orderNotional") riskSkippedLevels.orderNotional++;
        if (riskCheck.reason && !riskSkipMessages.includes(riskCheck.reason) && riskSkipMessages.length < MAX_RISK_MESSAGES) riskSkipMessages.push(riskCheck.reason);
        continue;
      }
      if (this.quiescing) break;

      attempted++;
      const result = await this.lifecycle.placeQuote({
        side: level.side,
        type: "postOnly",
        size: level.size,
        price: level.price,
      });
      if (result.success) {
        placed++;
        riskState.progressiveOpenOrderCount++;
        if (level.side === "buy") riskState.openBuyQuantity += level.size;
        else riskState.openSellQuantity += level.size;
      } else if (
        result.message !== undefined &&
        !failureMessages.includes(result.message) &&
        failureMessages.length < MAX_FAILURE_MESSAGES
      ) {
        failureMessages.push(result.message);
      }
    }

    const finalRestingQuotes = this.registry
      .listByState("RESTING")
      .filter((order) => !order.isReduceOnly);
    const replacedOriginalLadder = restingQuotes.every(
      (original) => !finalRestingQuotes.some((order) => order.clientOrderId === original.clientOrderId),
    );
    if (
      finalRestingQuotes.length === expectedQuoteCount &&
      (!refreshTriggered || replacedOriginalLadder)
    ) {
      this.quoteLadderReferencePrice = marketPrice.mark;
      // Start the next lifetime window after all adapter operations finish. A slow cancel/place
      // sequence therefore cannot consume the replacement ladder's lifetime before it rests.
    }

    if (!hasManagedLadder) refreshReason = "empty ladder placement";

    return {
      placed,
      attempted,
      cancelled,
      failureMessages,
      riskSkippedLevels,
      riskSkipMessages,
      refreshReason,
    };
  }
}
