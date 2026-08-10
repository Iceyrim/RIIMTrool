import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MarketEngine } from "../../src/engine/MarketEngine.js";
import type { EngineMarketConfig } from "../../src/engine/types.js";
import { FakeExchangeAdapter } from "./fakeAdapter.js";

const MARKET = "BTCUSD";

function testConfig(overrides: Partial<EngineMarketConfig> = {}): EngineMarketConfig {
  return {
    symbol: MARKET,
    orderSize: { min: 0.00155, max: 0.00232 },
    spreadBps: { normal: 5, min: 4, max: 7.5 },
    exitSpreadBps: 2.5,
    quoteLevels: 5,
    levelSpacingBps: [2, 3, 4, 7, 10],
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

function tempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-engine-test-"));
  return join(dir, `orders-${MARKET}.json`);
}

describe("MarketEngine", () => {
  let adapter: FakeExchangeAdapter;

  beforeEach(() => {
    adapter = new FakeExchangeAdapter();
    adapter.marketPrices.set(MARKET, { market: MARKET, mark: 60000, index: 60000 });
  });

  it("start() seeds local state from exchange truth before any cycle runs", async () => {
    adapter.openOrders.push({
      exchangeOrderId: "e1",
      market: MARKET,
      side: "buy",
      price: 59900,
      size: 0.002,
      filledSize: 0,
      remainingSize: 0.002,
      isReduceOnly: false,
      state: "open",
    });

    const engine = new MarketEngine(adapter, testConfig(), tempStatePath());
    const startResult = await engine.start();
    expect(startResult.healthy).toBe(true);
    expect(engine.registry.list()).toHaveLength(1);
  });

  it("throws if runCycle() is called before start()", async () => {
    const engine = new MarketEngine(adapter, testConfig(), tempStatePath());
    await expect(engine.runCycle()).rejects.toThrow(/start\(\)/);
  });

  it("places quote-ladder orders on an empty book", async () => {
    const engine = new MarketEngine(adapter, testConfig(), tempStatePath());
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.quotesPlaced).toBeGreaterThan(0);
    expect(summary.blockedReason).toBeUndefined();
    // 5 bid + 5 ask levels configured — all should place on a flat book with plenty of headroom.
    expect(summary.quotesPlaced).toBe(10);
  });

  it("does not re-place quotes that are still within their minimum lifetime", async () => {
    const engine = new MarketEngine(adapter, testConfig(), tempStatePath());
    await engine.start();
    await engine.runCycle();
    const secondCycle = await engine.runCycle();
    expect(secondCycle.quotesPlaced).toBe(0);
    expect(secondCycle.quotesCancelled).toBe(0);
  });

  it("SPEC 5c: places a reduce-only exit once inventory exceeds the threshold, instead of skewing the normal ladder", async () => {
    adapter.positions.push({
      market: MARKET,
      baseSize: 0.004, // exceeds inventoryReductionThresholdBase of 0.003
      markPrice: 60000,
      unrealizedPnl: 0,
      openOrderCount: 0,
    });

    const engine = new MarketEngine(adapter, testConfig(), tempStatePath());
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.reduceOnlyAction).toBe("placed");
    const reduceOnlyOrder = engine.registry.list().find((o) => o.isReduceOnly);
    expect(reduceOnlyOrder).toBeDefined();
    expect(reduceOnlyOrder?.side).toBe("sell"); // long position -> exit by selling
  });

  it("blocks all new placements while reconciliation is degraded, without touching the exchange", async () => {
    const engine = new MarketEngine(adapter, testConfig(), tempStatePath());
    await engine.start();

    // Simulate a surprise exchange order appearing mid-run with no local record — a runtime
    // anomaly, not something startup sync would have seen.
    adapter.openOrders.push({
      exchangeOrderId: "surprise",
      market: MARKET,
      side: "buy",
      price: 59000,
      size: 0.001,
      filledSize: 0,
      remainingSize: 0.001,
      isReduceOnly: false,
      state: "open",
    });

    const summary = await engine.runCycle();
    expect(summary.reconciliation.healthy).toBe(false);
    expect(summary.blockedReason).toMatch(/degraded/);
    expect(summary.quotesPlaced).toBe(0);
  });

  it("blocks all new placements when the account is at bankruptcy risk", async () => {
    adapter.marginStatus = { ...adapter.marginStatus, isAtBankruptcyRisk: true };
    const engine = new MarketEngine(adapter, testConfig(), tempStatePath());
    await engine.start();
    const summary = await engine.runCycle();
    expect(summary.blockedReason).toMatch(/bankruptcy/);
    expect(summary.quotesPlaced).toBe(0);
  });
});
