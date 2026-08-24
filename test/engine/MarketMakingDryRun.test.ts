import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MarketMakingDryRun } from "../../src/engine/MarketMakingDryRun.js";
import type { EngineMarketConfig } from "../../src/engine/types.js";
import { FakeExchangeAdapter } from "./fakeAdapter.js";

function config(): EngineMarketConfig {
  return {
    symbol: "BTCUSD",
    orderSize: { min: 0.00018, max: 0.00018 },
    spreadBps: { normal: 5, min: 4, max: 7.5 },
    exitSpreadBps: 2.5,
    quoteLevels: 5,
    levelSpacingBps: [2, 3, 4, 7, 10],
    inventoryReductionThresholdBase: 0.00036,
    riskLimits: {
      maxLongPosition: 0.001,
      maxShortPosition: 0.001,
      maxOrderSize: 0.0002,
      maxOrderNotionalUsd: 20,
      maxOpenOrders: 12,
    },
    accountSessionLossCapUsd: 6,
    reduceOnlyExit: { minHoldMs: 45_000, maxHoldMs: 300_000 },
    quoteMinimumLifetimeMs: 30_000,
  };
}

function planner(adapter: FakeExchangeAdapter): MarketMakingDryRun {
  const directory = mkdtempSync(join(tmpdir(), "riimtrool-perpl-dry-run-"));
  return new MarketMakingDryRun(adapter, config(), {
    stateFilePath: join(directory, "orders.json"),
    tradeLogFilePath: join(directory, "trades.jsonl"),
  });
}

function seedMarket(adapter: FakeExchangeAdapter, baseSize = 0): void {
  adapter.positions = [
    { market: "BTCUSD", baseSize, markPrice: 77_000, unrealizedPnl: 0, openOrderCount: 0 },
  ];
  adapter.marketPrices.set("BTCUSD", { market: "BTCUSD", mark: 77_000 });
}

describe("MarketMakingDryRun", () => {
  it("generates a risk-checked two-sided canary ladder without mutations", async () => {
    const adapter = new FakeExchangeAdapter();
    seedMarket(adapter);
    const dryRun = planner(adapter);
    await dryRun.start();
    const plan = await dryRun.planCycle();
    expect(plan.proposals).toHaveLength(10);
    expect(plan.proposals.every((proposal) => proposal.allowed && !proposal.reduceOnly)).toBe(true);
    expect(plan.executionReady).toBe(false);
    expect(plan.balances).toEqual([]);
    expect(plan.proposedCancellations).toEqual([]);
    expect(plan.readinessBlockers).toContain("authoritative mainnet margin status is unavailable");
    expect(adapter.placeOrderCalls).toHaveLength(0);
    expect(adapter.cancelOrderCalls).toHaveLength(0);
  });

  it("plans one reduce-only inventory action without submitting it", async () => {
    const adapter = new FakeExchangeAdapter();
    seedMarket(adapter, 0.0005);
    const dryRun = planner(adapter);
    await dryRun.start();
    const plan = await dryRun.planCycle();
    expect(plan.proposals).toEqual([
      expect.objectContaining({ side: "sell", reduceOnly: true, type: "postOnly", size: 0.0002 }),
    ]);
    expect(adapter.placeOrderCalls).toHaveLength(0);
  });

  it("blocks proposals when reconciliation finds an unmanaged mainnet order", async () => {
    const adapter = new FakeExchangeAdapter();
    seedMarket(adapter);
    adapter.openOrders.push({
      exchangeOrderId: "47",
      market: "BTCUSD",
      side: "buy",
      price: 77_000,
      size: 0.00018,
      filledSize: 0,
      remainingSize: 0.00018,
      isReduceOnly: false,
      state: "open",
    });
    const dryRun = planner(adapter);
    const startup = await dryRun.start();
    expect(startup.healthy).toBe(false);
    const plan = await dryRun.planCycle();
    expect(plan.reconciliation.healthy).toBe(false);
    expect(plan.proposals).toEqual([]);
    expect(adapter.cancelOrderCalls).toHaveLength(0);
  });
});
