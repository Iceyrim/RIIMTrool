import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MarketEngine } from "../../src/engine/MarketEngine.js";
import type { EngineMarketConfig } from "../../src/engine/types.js";
import { PaperRunner, type RealizedPnlSource } from "../../src/paperRunner/PaperRunner.js";
import { FakeExchangeAdapter } from "../engine/fakeAdapter.js";

class FakePnlSource implements RealizedPnlSource {
  queued = 0;
  drainRealizedPnlDeltaUsd(_market: string): number {
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

function tempStatePath(symbol: string): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-paperrunner-test-"));
  return join(dir, `orders-${symbol}.json`);
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
    const btcEngine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempStatePath("BTCUSD"));
    const ethEngine = new MarketEngine(ethAdapter, testConfig("ETHUSD"), tempStatePath("ETHUSD"));

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
      tempStatePath("BTCUSD"),
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
    const btcEngine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempStatePath("BTCUSD"));
    const ethEngine = new MarketEngine(ethAdapter, testConfig("ETHUSD"), tempStatePath("ETHUSD"));
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

  it("writes an append-only JSON-lines log file when configured", async () => {
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempStatePath("BTCUSD"));
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
    const engine = new MarketEngine(btcAdapter, testConfig("BTCUSD"), tempStatePath("BTCUSD"));
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
