import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CycleSummary, MarketEngine } from "../engine/MarketEngine.js";

/** Minimal structural interface PaperRunner needs from a paper adapter — deliberately narrower
 * than N1PaperAdapter itself, so tests can inject a trivial fake without constructing a full
 * paper adapter + market data source. Takes a market explicitly because one N1PaperAdapter
 * instance is meant to be SHARED across every market in a run (SPEC.md Section 4.3's shared
 * cross-margin account), so PnL must be drained per-market, not as a single pooled value. */
export interface RealizedPnlSource {
  drainRealizedPnlDeltaUsd(market: string): number;
}

export interface PaperRunnerMarket {
  market: string;
  engine: MarketEngine;
  pnlSource: RealizedPnlSource;
}

export interface PaperRunnerConfig {
  intervalMs: number;
  /** Total wall-clock duration to run before auto-stopping. Omit to run until stop() is called
   * explicitly (e.g. a SIGINT handler). */
  durationMs?: number;
  /** Append-only JSON-lines log of every cycle, in addition to console output. */
  logFilePath?: string;
}

export interface CycleLogEntry {
  timestamp: number;
  market: string;
  summary: CycleSummary;
  sessionRealizedPnlUsd: number;
}

export interface SoakReport {
  startedAt: number;
  endedAt: number;
  cycles: number;
  totalQuotesPlaced: number;
  totalQuotesAttempted: number;
  totalQuotesCancelled: number;
  totalAnomalies: number;
  finalSessionRealizedPnlUsd: Record<string, number>;
}

/**
 * Drives one or more MarketEngines on an interval, logging every cycle and producing the
 * soak-test report SPEC.md Section 9.3 requires before any live change. Each market's engine
 * runs independently within a cycle — a thrown error from one market's runCycle() is caught and
 * logged, not allowed to stop the others, the same per-market isolation principle Section 4.2
 * requires of the live engine loop.
 */
export class PaperRunner {
  private timer?: ReturnType<typeof setInterval>;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private cycleCount = 0;
  private startedAt = 0;
  private readonly log: CycleLogEntry[] = [];

  constructor(
    private readonly markets: readonly PaperRunnerMarket[],
    private readonly config: PaperRunnerConfig,
  ) {}

  async start(): Promise<void> {
    for (const { engine } of this.markets) {
      await engine.start();
    }
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.config.intervalMs);
    if (this.config.durationMs !== undefined) {
      this.durationTimer = setTimeout(() => this.stop(), this.config.durationMs);
    }
  }

  /** Runs exactly one cycle across every configured market. Exposed publicly so tests (and a
   * manual single-step invocation) don't have to wait on real interval timing. */
  async runOnce(): Promise<CycleLogEntry[]> {
    const entries: CycleLogEntry[] = [];
    for (const { market, engine, pnlSource } of this.markets) {
      let summary: CycleSummary;
      try {
        summary = await engine.runCycle();
      } catch (err) {
        console.error(
          `[PaperRunner:${market}] runCycle() threw, skipping this cycle: ${String(err)}`,
        );
        continue;
      }

      const pnlDelta = pnlSource.drainRealizedPnlDeltaUsd(market);
      if (pnlDelta !== 0) engine.recordRealizedPnl(pnlDelta);

      this.cycleCount++;
      const entry: CycleLogEntry = {
        timestamp: Date.now(),
        market,
        summary,
        sessionRealizedPnlUsd: engine.getSessionRealizedPnlUsd(),
      };
      this.log.push(entry);
      this.emitLogLine(entry);
      entries.push(entry);
    }
    return entries;
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
    if (this.timer) clearInterval(this.timer);
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
      finalSessionRealizedPnlUsd: Object.fromEntries(
        this.markets.map(({ market, engine }) => [market, engine.getSessionRealizedPnlUsd()]),
      ),
    };
  }
}
