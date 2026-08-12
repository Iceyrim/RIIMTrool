import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertBus, type AlertEvent, type AlertSink } from "../../src/alerting/AlertBus.js";
import { MarketEngine } from "../../src/engine/MarketEngine.js";
import type { EngineMarketConfig } from "../../src/engine/types.js";
import { PaperRunner, type RealizedPnlSource } from "../../src/paperRunner/PaperRunner.js";
import { FakeExchangeAdapter } from "../engine/fakeAdapter.js";

class FakeAlertSink implements AlertSink {
  events: AlertEvent[] = [];
  handle(event: AlertEvent): void {
    this.events.push(event);
  }
}

class FakePnlSource implements RealizedPnlSource {
  queued = 0;
  /** Set to make the next drain throw instead of resolving — self-clears after throwing once,
   * so tests can model "one failed drain, then recovery" without extra bookkeeping. */
  errorToThrow: Error | null = null;
  async drainRealizedPnlDeltaUsd(_market: string): Promise<number> {
    if (this.errorToThrow) {
      const err = this.errorToThrow;
      this.errorToThrow = null;
      throw err;
    }
    const value = this.queued;
    this.queued = 0;
    return value;
  }
}

function testConfig(
  symbol: string,
  overrides: Partial<EngineMarketConfig> = {},
): EngineMarketConfig {
  return {
    symbol,
    orderSize: { min: 0.001, max: 0.002 },
    spreadBps: { normal: 5, min: 4, max: 7.5 },
    exitSpreadBps: 2.5,
    quoteLevels: 2,
    levelSpacingBps: [2, 3],
    inventoryReductionThresholdBase: 0.003,
    riskLimits: {
      maxLongPosition: 0.005,
      maxShortPosition: 0.005,
      maxOrderSize: 0.0025,
      maxOrderNotionalUsd: 160,
      maxOpenOrders: 12,
    },
    sessionLossCapUsd: 15,
    reduceOnlyExit: { minHoldMs: 45_000, maxHoldMs: 300_000 },
    quoteMinimumLifetimeMs: 2_000,
    ...overrides,
  };
}

function tempPaths(symbol: string): { stateFilePath: string; tradeLogFilePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-paperrunner-test-"));
  return {
    stateFilePath: join(dir, `orders-${symbol}.json`),
    tradeLogFilePath: join(dir, `trades-${symbol}.jsonl`),
  };
}

describe("PaperRunner", () => {
  let btcAdapter: FakeExchangeAdapter;
  let ethAdapter: FakeExchangeAdapter;
  let btcPnl: FakePnlSource;
  let ethPnl: FakePnlSource;

  beforeEach(() => {
    btcAdapter = new FakeExchangeAdapter();
    btcAdapter.marketPrices.set("BTCUSD", { market: "BTCUSD", mark: 60000 });
    ethAdapter = new FakeExchangeAdapter();
    ethAdapter.marketPrices.set("ETHUSD", { market: "ETHUSD", mark: 3000 });
    btcPnl = new FakePnlSource();
    ethPnl = new FakePnlSource();
  });

  it("runOnce() calls start()-ed engines and logs one entry per market", async () => {
    const btcEngine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const ethEngine = new MarketEngine(ethAdapter, testConfig("ETHUSD"), tempPaths("ETHUSD"));

    const runner = new PaperRunner(
      [
        { market: "BTCUSD", engine: btcEngine, pnlSource: btcPnl },
        { market: "ETHUSD", engine: ethEngine, pnlSource: ethPnl },
      ],
      { intervalMs: 1000 },
    );

    await runner.start();
    const entries = await runner.runOnce();
    runner.stop();

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.market).sort()).toEqual(["BTCUSD", "ETHUSD"]);
    expect(entries[0]?.summary.quotesPlaced).toBeGreaterThan(0);
  });

  it("relays drained realized PnL into the engine's session PnL, feeding the loss-cap check", async () => {
    // quoteMinimumLifetimeMs: 0 so every cycle treats existing quotes as stale and genuinely
    // re-attempts placement (and re-hits the risk check) rather than skipping via the
    // "already covered by a still-fresh order" shortcut in manageQuoteLadder.
    const engine = new MarketEngine(
      btcAdapter,
      testConfig("BTCUSD", { quoteMinimumLifetimeMs: 0 }),
      tempPaths("BTCUSD"),
    );
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
    });
    await runner.start();

    btcPnl.queued = -20; // exceeds the configured $15 session loss cap
    const entries = await runner.runOnce();
    runner.stop();

    expect(entries[0]?.sessionRealizedPnlUsd).toBe(-20);
    // Next cycle's per-level risk check should now reject every placement attempt for this
    // market — the cap is enforced per-order inside manageQuoteLadder, not as a whole-cycle
    // blockedReason (that field is reserved for margin/reconciliation blocks).
    const nextEntries = await runner.runOnce();
    expect(nextEntries[0]?.summary.quotesAttempted).toBe(0);
    expect(nextEntries[0]?.summary.quotesPlaced).toBe(0);
  });

  it("isolates a market whose runCycle() throws — the other market's cycle still runs (SPEC 4.2)", async () => {
    const btcEngine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const ethEngine = new MarketEngine(ethAdapter, testConfig("ETHUSD"), tempPaths("ETHUSD"));
    await btcEngine.start();
    // ETH deliberately left un-start()-ed so its runCycle() throws.

    const runner = new PaperRunner(
      [
        { market: "BTCUSD", engine: btcEngine, pnlSource: btcPnl },
        { market: "ETHUSD", engine: ethEngine, pnlSource: ethPnl },
      ],
      { intervalMs: 1000 },
    );
    // Bypass start() (which would start() every engine) — simulate ETH already broken instead.
    const entries = await runner.runOnce();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.market).toBe("BTCUSD");
  });

  it("SPEC 4.2: a market whose cycle hangs forever does not block or delay the other market's independent live timer", async () => {
    vi.useFakeTimers();
    try {
      const btcEngine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
      const ethEngine = new MarketEngine(ethAdapter, testConfig("ETHUSD"), tempPaths("ETHUSD"));
      const dir = mkdtempSync(join(tmpdir(), "riimtrool-paperrunner-stuck-test-"));
      const logFilePath = join(dir, "cycles.jsonl");

      const runner = new PaperRunner(
        [
          { market: "BTCUSD", engine: btcEngine, pnlSource: btcPnl },
          { market: "ETHUSD", engine: ethEngine, pnlSource: ethPnl },
        ],
        { intervalMs: 1000, logFilePath },
      );
      await runner.start();

      // Simulate a genuinely stuck reconciliation loop: the adapter call never resolves and
      // never rejects — the failure mode the "runCycle() throws" test above does NOT cover, and
      // the one SPEC.md Section 4.2 is actually worried about ("stuck", not just "crashed").
      btcAdapter.refreshAccountState = () => new Promise<void>(() => {});

      await vi.advanceTimersByTimeAsync(1000 * 5);
      runner.stop();

      const lines = readFileSync(logFilePath, "utf-8").trim().split("\n").filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l) as { market: string });
      const ethCycles = entries.filter((e) => e.market === "ETHUSD").length;
      const btcCycles = entries.filter((e) => e.market === "BTCUSD").length;

      // ETH's own independent timer kept firing on schedule the whole time BTC was stuck —
      // proof this is about timer independence, not just try/catch around a synchronous throw.
      expect(ethCycles).toBeGreaterThanOrEqual(4);
      // BTC never completed a single cycle. That's expected — the guarantee under test is that
      // this never shows up as a delay or block on ETH, not that BTC recovers on its own.
      expect(btcCycles).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SPEC 4.2: a market degraded every cycle (but still resolving) does not block the other market's independent loop", async () => {
    vi.useFakeTimers();
    try {
      const btcEngine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
      const ethEngine = new MarketEngine(ethAdapter, testConfig("ETHUSD"), tempPaths("ETHUSD"));
      const dir = mkdtempSync(join(tmpdir(), "riimtrool-paperrunner-degraded-test-"));
      const logFilePath = join(dir, "cycles.jsonl");

      const runner = new PaperRunner(
        [
          { market: "BTCUSD", engine: btcEngine, pnlSource: btcPnl },
          { market: "ETHUSD", engine: ethEngine, pnlSource: ethPnl },
        ],
        { intervalMs: 1000, logFilePath },
      );
      await runner.start();

      // A surprise exchange order with no local record keeps BTC's reconciliation unhealthy
      // every cycle (SPEC 4.1 anomaly) — degraded, but each check still resolves normally. A
      // different failure mode than the hung-promise test above.
      btcAdapter.openOrders.push({
        exchangeOrderId: "surprise",
        market: "BTCUSD",
        side: "buy",
        price: 59000,
        size: 0.001,
        filledSize: 0,
        remainingSize: 0.001,
        isReduceOnly: false,
        state: "open",
      });

      await vi.advanceTimersByTimeAsync(1000 * 4);
      runner.stop();

      const lines = readFileSync(logFilePath, "utf-8").trim().split("\n").filter(Boolean);
      const entries = lines.map(
        (l) =>
          JSON.parse(l) as {
            market: string;
            summary: { blockedReason?: string; quotesPlaced: number };
          },
      );
      const btcEntries = entries.filter((e) => e.market === "BTCUSD");
      const ethEntries = entries.filter((e) => e.market === "ETHUSD");

      expect(btcEntries.length).toBeGreaterThanOrEqual(3);
      expect(btcEntries.every((e) => e.summary.blockedReason?.includes("degraded"))).toBe(true);
      expect(btcEntries.every((e) => e.summary.quotesPlaced === 0)).toBe(true);

      // ETH kept quoting normally on its own schedule the entire time, unaffected by BTC.
      expect(ethEntries.length).toBeGreaterThanOrEqual(3);
      expect(ethEntries.some((e) => e.summary.quotesPlaced > 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes an append-only JSON-lines log file when configured", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const dir = mkdtempSync(join(tmpdir(), "riimtrool-paperrunner-log-"));
    const logFilePath = join(dir, "nested", "cycles.jsonl");

    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
      logFilePath,
    });
    await runner.start();
    await runner.runOnce();
    await runner.runOnce();
    runner.stop();

    const lines = readFileSync(logFilePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it("stop() produces a soak report totaling every cycle's placed/cancelled/anomaly counts", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
    });
    await runner.start();
    await runner.runOnce();
    await runner.runOnce();
    const report = runner.stop();

    expect(report.cycles).toBe(2);
    expect(report.totalQuotesPlaced).toBeGreaterThan(0);
    expect(report.finalSessionRealizedPnlUsd).toEqual({ BTCUSD: 0 });
  });
});

describe("PaperRunner alertBus transition detection", () => {
  let btcAdapter: FakeExchangeAdapter;
  let btcPnl: FakePnlSource;
  let sink: FakeAlertSink;
  let alertBus: AlertBus;

  beforeEach(() => {
    btcAdapter = new FakeExchangeAdapter();
    btcAdapter.marketPrices.set("BTCUSD", { market: "BTCUSD", mark: 60000 });
    btcPnl = new FakePnlSource();
    sink = new FakeAlertSink();
    alertBus = new AlertBus();
    alertBus.subscribe(sink);
  });

  it("without an alertBus configured, no events are emitted and behavior is unaffected", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
    });
    await runner.start();
    await runner.runOnce();

    expect(sink.events).toHaveLength(0);
  });

  it("emits reconciliation_degraded on the first cycle already unhealthy, and does not repeat it while still degraded", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
      alertBus,
    });
    await runner.start();

    // A surprise exchange order with no local record — same anomaly setup as the SPEC 4.2
    // "degraded every cycle" test above.
    btcAdapter.openOrders.push({
      exchangeOrderId: "surprise",
      market: "BTCUSD",
      side: "buy",
      price: 59000,
      size: 0.001,
      filledSize: 0,
      remainingSize: 0.001,
      isReduceOnly: false,
      state: "open",
    });

    await runner.runOnce();
    await runner.runOnce();
    await runner.runOnce();

    const degradedEvents = sink.events.filter((e) => e.type === "reconciliation_degraded");
    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0]).toMatchObject({ market: "BTCUSD" });
    expect(sink.events.filter((e) => e.type === "reconciliation_recovered")).toHaveLength(0);
  });

  it("emits reconciliation_recovered exactly once when a degraded market becomes healthy again", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
      alertBus,
    });
    await runner.start();

    btcAdapter.openOrders.push({
      exchangeOrderId: "surprise",
      market: "BTCUSD",
      side: "buy",
      price: 59000,
      size: 0.001,
      filledSize: 0,
      remainingSize: 0.001,
      isReduceOnly: false,
      state: "open",
    });
    await runner.runOnce();
    expect(sink.events.filter((e) => e.type === "reconciliation_degraded")).toHaveLength(1);

    // The surprise order disappears from the exchange's own open-orders view — the next check
    // sees no anomaly at all, so reconciliation genuinely recovers.
    btcAdapter.openOrders.length = 0;
    await runner.runOnce();
    await runner.runOnce();

    const recoveredEvents = sink.events.filter((e) => e.type === "reconciliation_recovered");
    expect(recoveredEvents).toHaveLength(1);
    expect(recoveredEvents[0]).toMatchObject({ market: "BTCUSD" });
  });

  it("emits halted on the first cycle already blocked, and resumed exactly once when unblocked", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
      alertBus,
    });
    await runner.start();

    btcAdapter.marginStatus.isAtBankruptcyRisk = true;
    await runner.runOnce();
    await runner.runOnce();

    const haltedEvents = sink.events.filter((e) => e.type === "halted");
    expect(haltedEvents).toHaveLength(1);
    expect(haltedEvents[0]).toMatchObject({
      market: "BTCUSD",
      reason: expect.stringContaining("bankruptcy risk"),
    });

    btcAdapter.marginStatus.isAtBankruptcyRisk = false;
    await runner.runOnce();
    await runner.runOnce();

    const resumedEvents = sink.events.filter((e) => e.type === "resumed");
    expect(resumedEvents).toHaveLength(1);
    expect(resumedEvents[0]).toMatchObject({ market: "BTCUSD" });
  });

  it("halted/resumed (margin) and reconciliation_degraded/recovered are independent signals", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
      alertBus,
    });
    await runner.start();

    // Margin blocked, but reconciliation itself is perfectly healthy (no exchange anomaly).
    btcAdapter.marginStatus.isAtBankruptcyRisk = true;
    await runner.runOnce();

    expect(sink.events.filter((e) => e.type === "halted")).toHaveLength(1);
    expect(sink.events.filter((e) => e.type === "reconciliation_degraded")).toHaveLength(0);
  });
});

describe("PaperRunner placement-failure alerting", () => {
  let btcAdapter: FakeExchangeAdapter;
  let btcPnl: FakePnlSource;
  let sink: FakeAlertSink;
  let alertBus: AlertBus;

  beforeEach(() => {
    btcAdapter = new FakeExchangeAdapter();
    btcAdapter.marketPrices.set("BTCUSD", { market: "BTCUSD", mark: 60000 });
    btcPnl = new FakePnlSource();
    sink = new FakeAlertSink();
    alertBus = new AlertBus();
    alertBus.subscribe(sink);
  });

  // testConfig("BTCUSD") in this file configures quoteLevels: 2, levelSpacingBps: [2, 3] — 2 bid
  // + 2 ask = 4 quote-ladder placement attempts per cycle.
  function queueRejectedCycle(): void {
    for (let i = 0; i < 4; i++) {
      btcAdapter.placeOrderResults.push({
        success: false,
        reason: "REJECTED",
        message: "Invalid or empty session ID. Please create or refresh your session.",
      });
    }
  }

  it("alerts once after 3 consecutive fully-failed cycles, not every cycle spent failing (regression: this is exactly the real run — 340/340 REJECTED, zero anomalies, zero alerts)", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
      alertBus,
    });
    await runner.start();

    queueRejectedCycle();
    await runner.runOnce();
    expect(sink.events.filter((e) => e.type === "error")).toHaveLength(0);

    queueRejectedCycle();
    await runner.runOnce();
    expect(sink.events.filter((e) => e.type === "error")).toHaveLength(0);

    queueRejectedCycle();
    await runner.runOnce();

    const errorEvents = sink.events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      market: "BTCUSD",
      message: expect.stringContaining("3 consecutive"),
    });

    // Stays failing — must not repeat the alert every cycle.
    queueRejectedCycle();
    await runner.runOnce();
    expect(sink.events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("emits a recovery event once placement succeeds again after an alerted streak", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
      alertBus,
    });
    await runner.start();

    queueRejectedCycle();
    queueRejectedCycle();
    queueRejectedCycle();
    await runner.runOnce();
    await runner.runOnce();
    await runner.runOnce();
    expect(
      sink.events.filter((e) => e.type === "error" && e.message.includes("consecutive")),
    ).toHaveLength(1);

    // Queue is empty now — FakeExchangeAdapter synthesizes a success for every placement.
    await runner.runOnce();

    const recoveryEvents = sink.events.filter(
      (e) => e.type === "error" && e.message.includes("recovered"),
    );
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0]).toMatchObject({ market: "BTCUSD" });
  });

  it("a fully-blocked cycle (margin risk, zero attempted) does not break or extend the failure streak", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
      alertBus,
    });
    await runner.start();

    queueRejectedCycle();
    queueRejectedCycle();
    await runner.runOnce();
    await runner.runOnce();

    // A cycle blocked entirely upstream (margin risk) attempts nothing this cycle — must not
    // reset (or advance) the placement-failure streak, since it says nothing about placement.
    btcAdapter.marginStatus.isAtBankruptcyRisk = true;
    await runner.runOnce();
    btcAdapter.marginStatus.isAtBankruptcyRisk = false;

    queueRejectedCycle();
    await runner.runOnce();

    // Two rejected cycles, one skipped (blocked), one more rejected: streak reaches 3 only if the
    // blocked cycle didn't reset it.
    expect(sink.events.filter((e) => e.type === "error")).toHaveLength(1);
  });
});

describe("PaperRunner PnL-drain failure handling", () => {
  let btcAdapter: FakeExchangeAdapter;
  let btcPnl: FakePnlSource;

  beforeEach(() => {
    btcAdapter = new FakeExchangeAdapter();
    btcAdapter.marketPrices.set("BTCUSD", { market: "BTCUSD", mark: 60000 });
    btcPnl = new FakePnlSource();
  });

  it("marks session PnL unavailable when a drain throws, blocking the NEXT cycle's placement (including reduce-only exits)", async () => {
    const engine = new MarketEngine(
      btcAdapter,
      testConfig("BTCUSD", { quoteMinimumLifetimeMs: 0 }),
      tempPaths("BTCUSD"),
    );
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
    });
    await runner.start();

    const baseline = await runner.runOnce();
    expect(baseline[0]?.summary.blockedReason).toBeUndefined();
    expect(baseline[0]?.summary.quotesPlaced).toBeGreaterThan(0);

    btcPnl.errorToThrow = new Error("N1 getAccountPnl() request failed: network hiccup");
    // This cycle's own runCycle() already ran (and was healthy) before its drain throws — the
    // block only takes effect starting the cycle after, same one-cycle lag sessionRealizedPnlUsd
    // itself already has.
    await runner.runOnce();

    const blockedCycle = await runner.runOnce();
    expect(blockedCycle[0]?.summary.blockedReason).toMatch(/Session realized-PnL unavailable/);
    expect(blockedCycle[0]?.summary.blockedReason).toMatch(/network hiccup/);
    expect(blockedCycle[0]?.summary.quotesPlaced).toBe(0);
  });

  it("recovers once a subsequent drain succeeds after a prior failure", async () => {
    const engine = new MarketEngine(
      btcAdapter,
      testConfig("BTCUSD", { quoteMinimumLifetimeMs: 0 }),
      tempPaths("BTCUSD"),
    );
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
    });
    await runner.start();

    btcPnl.errorToThrow = new Error("boom");
    await runner.runOnce(); // this cycle's drain fails (errorToThrow self-clears after throwing)

    const blockedCycle = await runner.runOnce();
    expect(blockedCycle[0]?.summary.blockedReason).toMatch(/Session realized-PnL unavailable/);

    const recoveredCycle = await runner.runOnce(); // drain succeeded again last cycle
    expect(recoveredCycle[0]?.summary.blockedReason).toBeUndefined();
    expect(recoveredCycle[0]?.summary.quotesPlaced).toBeGreaterThan(0);
  });

  it("never substitutes $0 for a failed drain — sessionRealizedPnlUsd is unchanged by the failure itself", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
    });
    await runner.start();

    btcPnl.queued = 25;
    await runner.runOnce();
    expect(engine.getSessionRealizedPnlUsd()).toBeCloseTo(25);

    btcPnl.errorToThrow = new Error("boom");
    await runner.runOnce();
    // A failed drain must never apply a $0 delta on top of a real prior realized loss/gain —
    // session PnL stays exactly what it was before the failed drain.
    expect(engine.getSessionRealizedPnlUsd()).toBeCloseTo(25);
  });

  it("alerts once on the failure edge and once on the recovery edge, not every cycle spent broken", async () => {
    const sink = new FakeAlertSink();
    const alertBus = new AlertBus();
    alertBus.subscribe(sink);
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    const runner = new PaperRunner([{ market: "BTCUSD", engine, pnlSource: btcPnl }], {
      intervalMs: 1000,
      alertBus,
    });
    await runner.start();

    btcPnl.errorToThrow = new Error("boom");
    await runner.runOnce(); // fails once — errorToThrow self-clears
    await runner.runOnce(); // recovers
    await runner.runOnce(); // stays healthy — must not alert "recovered" again

    const failureAlerts = sink.events.filter(
      (e) => e.type === "error" && e.message.includes("boom"),
    );
    expect(failureAlerts).toHaveLength(1);
    const recoveryAlerts = sink.events.filter(
      (e) => e.type === "error" && e.message.includes("recovered"),
    );
    expect(recoveryAlerts).toHaveLength(1);
  });
});
