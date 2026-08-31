import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AlertBus } from "../alerting/AlertBus.js";
import type {
  CycleSummary,
  ManagedOrderCleanupResult,
  MarketEngine,
} from "../engine/MarketEngine.js";
import type { AccountRiskState } from "../engine/types.js";
import type { DashboardTelemetry } from "../dashboard/DashboardTelemetry.js";

/** Minimal structural interface PaperRunner needs from a paper adapter — deliberately narrower
 * than N1PaperAdapter itself, so tests can inject a trivial fake without constructing a full
 * paper adapter + market data source. Takes a market explicitly because one N1PaperAdapter
 * instance is meant to be SHARED across every market in a run (SPEC.md Section 4.3's shared
 * cross-margin account), so PnL must be drained per-market, not as a single pooled value. */
export interface RealizedPnlSource {
  /** Account sources are drained by exactly one designated market; market sources are aggregated
   * into the same runner-account total without acquiring N1 semantics. */
  readonly scope?: "market" | "account";
  /** Async because a real implementation (N1RealizedPnlSource) makes a live network call — it
   * must throw on failure, never resolve to 0 as a silent fallback (a real realized loss must
   * never be masked as "no PnL this cycle"). Paper adapters implement this as a trivial async
   * wrapper around their already-synchronous local simulation. */
  drainRealizedPnlDeltaUsd(market?: string): Promise<number>;
}

export interface PaperRunnerMarket {
  market: string;
  engine: MarketEngine;
  pnlSource: RealizedPnlSource;
}

export interface PaperRunnerConfig {
  intervalMs: number;
  /** Human-facing runtime identity; defaults to the historical generic name. */
  runnerLabel?: string;
  /** Total wall-clock duration to run before auto-stopping. Omit to run until stop() is called
   * explicitly (e.g. a SIGINT handler). */
  durationMs?: number;
  /** Append-only JSON-lines log of every cycle, in addition to console output. */
  logFilePath?: string;
  /** Optional operational alerting (src/alerting/AlertBus.ts). PaperRunner only emits the
   * transition-edge events it's positioned to detect — reconciliation_degraded/recovered and
   * halted/resumed — by comparing each cycle's CycleSummary against the previous one per market.
   * Fills are wired separately, straight from TradeLog's onFillRecorded callback at the
   * entrypoint-script level, since PaperRunner never sees individual fills itself. */
  alertBus?: AlertBus;
  /** Optional fail-open publisher. Refresh calls return immediately and are never awaited. */
  telemetry?: DashboardTelemetry;
}

export interface CycleLogEntry {
  timestamp: number;
  market: string;
  summary: CycleSummary;
  accountSessionRealizedPnlUsd: number;
}

/** Consecutive fully-failed quote-ladder cycles (attempted &gt; 0, placed === 0) before
 * detectPlacementFailures() alerts. A 100% placement failure rate is otherwise indistinguishable
 * from "nothing to quote" at the log level — see MarketEngine's CycleSummary.quotesFailed doc
 * comment. Threshold, not first-cycle, to avoid alerting on a single transient rejection. */
const PLACEMENT_FAILURE_ALERT_THRESHOLD = 3;

export interface SoakReport {
  startedAt: number;
  endedAt: number;
  cycles: number;
  totalQuotesPlaced: number;
  totalQuotesAttempted: number;
  totalQuotesCancelled: number;
  totalAnomalies: number;
  finalAccountSessionRealizedPnlUsd: number;
}

export interface PaperRunnerShutdownResult {
  report: SoakReport;
  cleanup: ManagedOrderCleanupResult[];
  successful: boolean;
  positionsFlattened: false;
  positionDisposition: "NOT_FLATTENED_REQUIRES_DIRECT_EXCHANGE_VERIFICATION_AND_MANUAL_CLOSURE";
}

/**
 * Drives one or more MarketEngines, logging every cycle and producing the soak-test report
 * SPEC.md Section 9.3 requires before any live change.
 *
 * SPEC.md Section 4.2 requires that a stuck/degraded market never blocks or delays another
 * market's loop — not just that a thrown error doesn't propagate. A single shared interval that
 * walks markets sequentially (`for (...) { await engine.runCycle() }`) fails that guarantee: a
 * cycle that never resolves (a hung adapter call, not a thrown error) stalls every market queued
 * behind it in that same callback. So the live loop (start()) gives each market its own
 * independent, self-rescheduling timer — a hang in one market's in-flight cycle just means that
 * market's own timer doesn't reschedule yet; it has no way to reach another market's timer
 * callback at all, since they're separate callbacks on separate timers, not sequential steps
 * inside one shared callback. Each market's timer also guards against overlapping cycles for
 * itself (skips and logs if the previous cycle for that market hasn't settled yet) — a stuck
 * market keeps skipping its own ticks forever, which is the correct isolated failure mode, rather
 * than stacking concurrent cycles for the same market or blocking anyone else.
 *
 * runOnce() (manual single-step, used by tests and soak-step tooling) runs every market's cycle
 * concurrently via Promise.all rather than sequentially, for the same reason.
 */
export class PaperRunner {
  private readonly marketTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private readonly activeCycles = new Set<Promise<CycleLogEntry | undefined>>();
  private running = false;
  private quiescing = false;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private cycleCount = 0;
  private startedAt = 0;
  private readonly log: CycleLogEntry[] = [];
  // Previous cycle's reconciliation-healthy / blocked state per market, for edge detection in
  // detectTransitions() — undefined means "no prior cycle observed yet for this market".
  private readonly prevHealthy = new Map<string, boolean>();
  private readonly prevBlocked = new Map<string, boolean>();
  // Previous cycle's PnL-drain-healthy state per market, for edge detection in drainPnl() — same
  // "alert on the transition, not every cycle spent broken" rule as detectTransitions().
  private readonly prevPnlHealthy = new Map<string, boolean>();
  // Consecutive fully-failed quote-ladder cycles per market, and whether an alert has already
  // fired for the current streak — see detectPlacementFailures().
  private readonly placementFailureStreak = new Map<string, number>();
  private readonly placementFailureAlerted = new Map<string, boolean>();
  private readonly accountRiskState: AccountRiskState;
  private readonly accountPnlOwnerMarket: string | undefined;

  private prefix(market: string): string {
    return `[${this.config.runnerLabel ?? "PaperRunner"}:${market}]`;
  }

  constructor(
    private readonly markets: readonly PaperRunnerMarket[],
    private readonly config: PaperRunnerConfig,
  ) {
    const cap = markets[0]?.engine.getAccountRiskState().sessionLossCapUsd ?? 6;
    this.accountRiskState = {
      sessionRealizedPnlUsd: 0,
      sessionLossCapUsd: cap,
      pnlAvailable: true,
    };
    for (const { engine } of markets) engine.setAccountRiskState(this.accountRiskState);
    this.accountPnlOwnerMarket = markets.find(({ pnlSource }) => pnlSource.scope === "account")?.market;
  }

  async start(): Promise<void> {
    for (const { engine } of this.markets) {
      await engine.start();
    }
    this.startedAt = Date.now();
    this.config.telemetry?.markStarted(this.startedAt);
    this.config.telemetry?.refreshIfDue(this.startedAt);
    this.quiescing = false;
    this.running = true;
    for (const entry of this.markets) {
      this.scheduleNextTick(entry);
    }
    if (this.config.durationMs !== undefined) {
      this.durationTimer = setTimeout(() => this.stop(), this.config.durationMs);
    }
  }

  /** Schedules this one market's next tick, independent of every other market's timer. */
  private scheduleNextTick(entry: PaperRunnerMarket): void {
    const timer = setTimeout(() => void this.tick(entry), this.config.intervalMs);
    this.marketTimers.set(entry.market, timer);
  }

  private async tick(entry: PaperRunnerMarket): Promise<void> {
    if (!this.running) return;

    if (this.inFlight.has(entry.market)) {
      console.warn(
        `${this.prefix(entry.market)} previous cycle still in flight (stuck/degraded?), ` +
          `skipping this tick — other markets are unaffected`,
      );
    } else {
      this.inFlight.add(entry.market);
      try {
        await this.trackCycle(entry);
      } finally {
        this.inFlight.delete(entry.market);
      }
    }

    if (this.running) this.scheduleNextTick(entry);
  }

  /** Runs exactly one cycle across every configured market, concurrently. Exposed publicly so
   * tests (and a manual single-step invocation) don't have to wait on real interval timing. */
  async runOnce(): Promise<CycleLogEntry[]> {
    if (this.quiescing) return [];
    const results = await Promise.all(this.markets.map((entry) => this.trackCycle(entry)));
    return results.filter((entry): entry is CycleLogEntry => entry !== undefined);
  }

  private trackCycle(entry: PaperRunnerMarket): Promise<CycleLogEntry | undefined> {
    const cycle = this.runMarketCycle(entry);
    this.activeCycles.add(cycle);
    void cycle.then(
      () => this.activeCycles.delete(cycle),
      () => this.activeCycles.delete(cycle),
    );
    return cycle;
  }

  /** Stops scheduling synchronously, closes every engine's placement gate, then awaits cycles. */
  async quiesce(): Promise<void> {
    if (!this.quiescing) {
      this.quiescing = true;
      this.running = false;
      for (const timer of this.marketTimers.values()) clearTimeout(timer);
      this.marketTimers.clear();
      if (this.durationTimer) clearTimeout(this.durationTimer);
      for (const { engine } of this.markets) engine.quiesce();
    }
    await Promise.allSettled([...this.activeCycles]);
  }

  /** Quiesces, verifies managed-order cleanup per market, persists state, and returns status. */
  async shutdown(): Promise<PaperRunnerShutdownResult> {
    await this.quiesce();
    const cleanup = await Promise.all(
      this.markets.map(async ({ market, engine }) => {
        try {
          return await engine.cleanupManagedOrders();
        } catch (err) {
          const managedIds = engine.registry
            .list()
            .filter((order) => order.exchangeOrderId !== null)
            .map((order) => order.exchangeOrderId as string);
          return {
            market,
            attempted: [],
            cancelled: [],
            terminal: [],
            failed: managedIds,
            unresolved: managedIds,
            successful: false,
            error: String(err),
          } satisfies ManagedOrderCleanupResult & { error: string };
        }
      }),
    );
    const report = this.stop();
    const result: PaperRunnerShutdownResult = {
      report,
      cleanup,
      successful: cleanup.every((entry) => entry.successful),
      positionsFlattened: false,
      positionDisposition:
        "NOT_FLATTENED_REQUIRES_DIRECT_EXCHANGE_VERIFICATION_AND_MANUAL_CLOSURE",
    };
    if (this.config.logFilePath) {
      const line = JSON.stringify({ timestamp: Date.now(), type: "shutdown_cleanup", ...result });
      mkdirSync(dirname(this.config.logFilePath), { recursive: true });
      appendFileSync(this.config.logFilePath, line + "\n", "utf-8");
    }
    return result;
  }

  /** Runs one cycle for exactly one market: engine.runCycle(), PnL drain, logging. A thrown error
   * from runCycle() is caught and logged here, not allowed to propagate — this is what isolates a
   * crashed market from whichever caller invoked this (runOnce()'s Promise.all, or this market's
   * own live timer). Returns undefined when the cycle threw, so callers can filter it out. */
  private async runMarketCycle(entry: PaperRunnerMarket): Promise<CycleLogEntry | undefined> {
    this.config.telemetry?.refreshIfDue();
    const { market, engine } = entry;
    let summary: CycleSummary;
    try {
      summary = await engine.runCycle();
    } catch (err) {
      console.error(
        `${this.prefix(market)} runCycle() threw, skipping this cycle: ${String(err)}`,
      );
      return undefined;
    }

    if (this.config.alertBus) {
      this.detectTransitions(this.config.alertBus, market, summary);
      this.detectPlacementFailures(this.config.alertBus, market, summary);
    }

    await this.drainPnl(entry);
    this.config.telemetry?.sampleAccountIfDue(engine.getSessionRealizedPnlUsd());

    this.cycleCount++;
    const logEntry: CycleLogEntry = {
      timestamp: Date.now(),
      market,
      summary,
      accountSessionRealizedPnlUsd: engine.getSessionRealizedPnlUsd(),
    };
    this.log.push(logEntry);
    this.emitLogLine(logEntry);
    return logEntry;
  }

  /** Drains this market's realized-PnL delta and applies it to the engine, or — if the drain
   * itself throws (a real N1RealizedPnlSource network/parse failure, never a paper adapter in
   * practice) — marks the engine's session PnL unavailable so runCycle() blocks all new
   * placement starting next cycle, instead of silently treating the failure as "$0 realized this
   * cycle" (exactly the always-zero-stub gap this wiring replaces). Never lets the drain failure
   * propagate: same isolation contract runMarketCycle already gives a thrown runCycle(). */
  private async drainPnl(entry: PaperRunnerMarket): Promise<void> {
    const { market, engine, pnlSource } = entry;
    if (pnlSource.scope === "account" && market !== this.accountPnlOwnerMarket) return;
    try {
      const pnlDelta = await pnlSource.drainRealizedPnlDeltaUsd(
        pnlSource.scope === "account" ? undefined : market,
      );
      for (const entry of this.markets) entry.engine.confirmSessionPnlHealthy();
      if (this.config.alertBus && this.prevPnlHealthy.get(market) === false) {
        this.config.alertBus.emit({
          type: "error",
          market,
          message: `[${market}] Session realized-PnL drain recovered`,
        });
      }
      this.prevPnlHealthy.set(market, true);
      if (pnlDelta !== 0) engine.recordRealizedPnl(pnlDelta);
    } catch (err) {
      const reason = `realized-PnL drain failed: ${String(err)}`;
      console.error(`${this.prefix(market)} ${reason}`);
      for (const entry of this.markets) entry.engine.markSessionPnlUnavailable(reason);
      if (this.config.alertBus && this.prevPnlHealthy.get(market) !== false) {
        this.config.alertBus.emit({ type: "error", market, message: `[${market}] ${reason}` });
      }
      this.prevPnlHealthy.set(market, false);
    }
  }

  /** Compares this cycle's CycleSummary against the previous one for this market and emits the
   * corresponding edge event exactly once per transition — not once per cycle a market happens to
   * spend degraded/halted, which would spam a Telegram chat every single tick. First-ever cycle
   * for a market has no prior state (the Maps start empty): a market observed already
   * degraded/halted on its very first cycle still alerts (there's no meaningful "previous healthy
   * state" to require), but a market observed already healthy/unblocked on its first cycle does
   * not spuriously fire "recovered"/"resumed" — there's nothing to have recovered from. */
  private detectTransitions(alertBus: AlertBus, market: string, summary: CycleSummary): void {
    const healthy = summary.reconciliation.healthy;
    const prevHealthy = this.prevHealthy.get(market);
    if (!healthy && prevHealthy !== false) {
      alertBus.emit({
        type: "reconciliation_degraded",
        market,
        anomalies: summary.reconciliation.anomalies,
      });
    } else if (healthy && prevHealthy === false) {
      alertBus.emit({ type: "reconciliation_recovered", market });
    }
    this.prevHealthy.set(market, healthy);

    const blocked = summary.blockedReason !== undefined;
    const prevBlocked = this.prevBlocked.get(market);
    if (blocked && prevBlocked !== true) {
      alertBus.emit({ type: "halted", market, reason: summary.blockedReason! });
    } else if (!blocked && prevBlocked === true) {
      alertBus.emit({ type: "resumed", market });
    }
    this.prevBlocked.set(market, blocked);
  }

  /** Tracks consecutive fully-failed quote-ladder cycles (every attempt this cycle failed) per
   * market and alerts once the streak crosses PLACEMENT_FAILURE_ALERT_THRESHOLD — independent of
   * reconciliation health, which correctly stays "healthy" here (nothing ever reached the
   * exchange to disagree about). A cycle with nothing attempted (all levels already covered, or
   * new placement blocked upstream) neither extends nor breaks the streak — only cycles that
   * actually tried to place something count. */
  private detectPlacementFailures(alertBus: AlertBus, market: string, summary: CycleSummary): void {
    if (summary.quotesAttempted === 0) return;

    const fullyFailed = summary.quotesPlaced === 0;
    const streak = fullyFailed ? (this.placementFailureStreak.get(market) ?? 0) + 1 : 0;
    this.placementFailureStreak.set(market, streak);

    const alreadyAlerted = this.placementFailureAlerted.get(market) === true;
    if (streak >= PLACEMENT_FAILURE_ALERT_THRESHOLD && !alreadyAlerted) {
      const reasons =
        summary.quoteFailureMessages.length > 0
          ? `; latest reason(s): ${summary.quoteFailureMessages.join("; ")}`
          : "";
      alertBus.emit({
        type: "error",
        market,
        message:
          `[${market}] Quote placement has failed on every attempt for ${streak} consecutive ` +
          `cycles${reasons}`,
      });
      this.placementFailureAlerted.set(market, true);
    } else if (!fullyFailed && alreadyAlerted) {
      alertBus.emit({
        type: "error",
        market,
        message: `[${market}] Quote placement recovered after repeated failures`,
      });
      this.placementFailureAlerted.set(market, false);
    }
  }

  private emitLogLine(entry: CycleLogEntry): void {
    const line = JSON.stringify(entry);
    console.log(line);
    if (this.config.logFilePath) {
      mkdirSync(dirname(this.config.logFilePath), { recursive: true });
      appendFileSync(this.config.logFilePath, line + "\n", "utf-8");
    }
  }

  stop(): SoakReport {
    this.running = false;
    for (const timer of this.marketTimers.values()) clearTimeout(timer);
    this.marketTimers.clear();
    if (this.durationTimer) clearTimeout(this.durationTimer);
    return {
      startedAt: this.startedAt,
      endedAt: Date.now(),
      cycles: this.cycleCount,
      totalQuotesPlaced: this.log.reduce((sum, e) => sum + e.summary.quotesPlaced, 0),
      totalQuotesAttempted: this.log.reduce((sum, e) => sum + e.summary.quotesAttempted, 0),
      totalQuotesCancelled: this.log.reduce((sum, e) => sum + e.summary.quotesCancelled, 0),
      totalAnomalies: this.log.reduce(
        (sum, e) => sum + e.summary.reconciliation.anomalies.length,
        0,
      ),
      finalAccountSessionRealizedPnlUsd: this.accountRiskState.sessionRealizedPnlUsd,
    };
  }
}
