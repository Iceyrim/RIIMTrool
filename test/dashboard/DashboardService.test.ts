import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDashboardStatus,
  type DashboardMarket,
} from "../../src/dashboard/DashboardService.js";
import { MarketEngine } from "../../src/engine/MarketEngine.js";
import type { EngineMarketConfig } from "../../src/engine/types.js";
import { FakeExchangeAdapter } from "../engine/fakeAdapter.js";

function testConfig(symbol: string): EngineMarketConfig {
  return {
    symbol,
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
  };
}

function tempPaths(symbol: string): { stateFilePath: string; tradeLogFilePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-dashboard-test-"));
  return {
    stateFilePath: join(dir, `orders-${symbol}.json`),
    tradeLogFilePath: join(dir, `trades-${symbol}.jsonl`),
  };
}

async function buildMarket(symbol: string, adapter: FakeExchangeAdapter): Promise<DashboardMarket> {
  const engine = new MarketEngine(adapter, testConfig(symbol), tempPaths(symbol));
  await engine.start();
  return { market: symbol, engine, adapter };
}

describe("buildDashboardStatus", () => {
  let adapter: FakeExchangeAdapter;

  beforeEach(() => {
    adapter = new FakeExchangeAdapter();
    adapter.marketPrices.set("BTCUSD", { market: "BTCUSD", mark: 60000, index: 60000 });
    adapter.marketPrices.set("ETHUSD", { market: "ETHUSD", mark: 3000, index: 3000 });
  });

  it("reports a healthy, flat market with zero exposure on a fresh start", async () => {
    const market = await buildMarket("BTCUSD", adapter);
    const status = buildDashboardStatus([market]);

    expect(status.markets).toHaveLength(1);
    expect(status.markets[0]?.market).toBe("BTCUSD");
    expect(status.markets[0]?.reconciliation.healthy).toBe(true);
    expect(status.markets[0]?.position).toBeNull();
    expect(status.totalExposureUsd).toBe(0);
    expect(status.markets[0]?.sessionRealizedPnlUsd).toBe(0);
  });

  it("computes notional and total exposure straight from the adapter's live position, not a counter", async () => {
    adapter.positions.push({
      market: "BTCUSD",
      baseSize: 0.004,
      markPrice: 60000,
      unrealizedPnl: 12.5,
      openOrderCount: 0,
    });
    const market = await buildMarket("BTCUSD", adapter);
    const status = buildDashboardStatus([market]);

    const positionStatus = status.markets[0]?.position;
    expect(positionStatus).not.toBeNull();
    expect(positionStatus?.notionalUsd).toBeCloseTo(0.004 * 60000);
    expect(positionStatus?.unrealizedPnl).toBe(12.5);
    expect(status.totalExposureUsd).toBeCloseTo(0.004 * 60000);
  });

  it("sums exposure across multiple independent markets", async () => {
    adapter.positions.push(
      { market: "BTCUSD", baseSize: 0.002, markPrice: 60000, unrealizedPnl: 0, openOrderCount: 0 },
      { market: "ETHUSD", baseSize: -1, markPrice: 3000, unrealizedPnl: 0, openOrderCount: 0 },
    );
    const btc = await buildMarket("BTCUSD", adapter);
    const eth = await buildMarket("ETHUSD", adapter);
    const status = buildDashboardStatus([btc, eth]);

    expect(status.markets).toHaveLength(2);
    expect(status.totalExposureUsd).toBeCloseTo(0.002 * 60000 + 1 * 3000);
  });

  it("surfaces reconciliation anomalies and a degraded status without touching the exchange", async () => {
    const market = await buildMarket("BTCUSD", adapter);
    adapter.openOrders.push({
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
    await market.engine.runCycle();

    const status = buildDashboardStatus([market]);
    expect(status.markets[0]?.reconciliation.healthy).toBe(false);
    expect(status.markets[0]?.reconciliation.anomalies).toHaveLength(1);
    expect(status.markets[0]?.reconciliation.degradedStreak).toBe(1);
  });

  it("reflects open orders from the engine's local registry", async () => {
    const market = await buildMarket("BTCUSD", adapter);
    await market.engine.runCycle();

    const status = buildDashboardStatus([market]);
    expect(status.markets[0]?.openOrders.length).toBeGreaterThan(0);
  });

  it("always includes the not-yet-implemented TODO items", async () => {
    const market = await buildMarket("BTCUSD", adapter);
    const status = buildDashboardStatus([market]);
    expect(status.todo.length).toBeGreaterThan(0);
    expect(status.todo.some((t) => t.includes("volume"))).toBe(true);
  });

  it("stamps generatedAt on every call, not once at construction", async () => {
    const market = await buildMarket("BTCUSD", adapter);
    const first = buildDashboardStatus([market]);
    const second = buildDashboardStatus([market]);
    expect(second.generatedAt).toBeGreaterThanOrEqual(first.generatedAt);
  });
});
