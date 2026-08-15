import { mkdtempSync, readFileSync } from "node:fs";
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
      maxLongPosition: 0.05,
      maxShortPosition: 0.05,
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

function tempPaths(): { stateFilePath: string; tradeLogFilePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-engine-test-"));
  return {
    stateFilePath: join(dir, `orders-${MARKET}.json`),
    tradeLogFilePath: join(dir, `trades-${MARKET}.jsonl`),
  };
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

    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    const startResult = await engine.start();
    expect(startResult.healthy).toBe(true);
    expect(engine.registry.list()).toHaveLength(1);
  });

  it("throws if runCycle() is called before start()", async () => {
    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    await expect(engine.runCycle()).rejects.toThrow(/start\(\)/);
  });

  it("places quote-ladder orders on an empty book", async () => {
    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.quotesPlaced).toBeGreaterThan(0);
    expect(summary.blockedReason).toBeUndefined();
    // 5 bid + 5 ask levels configured — all should place on a flat book with plenty of headroom.
    expect(summary.quotesPlaced).toBe(10);
  });

  it("surfaces placement failures in quotesFailed/quoteFailureMessages instead of dropping them (regression: a real live run had 340/340 REJECTED placements and zero visibility)", async () => {
    for (let i = 0; i < 10; i++) {
      adapter.placeOrderResults.push({
        success: false,
        reason: "REJECTED",
        message: "Invalid or empty session ID. Please create or refresh your session.",
      });
    }

    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.quotesAttempted).toBe(10);
    expect(summary.quotesPlaced).toBe(0);
    expect(summary.quotesFailed).toBe(10);
    expect(summary.quoteFailureMessages).toEqual([
      "Invalid or empty session ID. Please create or refresh your session.",
    ]);
  });

  it("starting with 5/12 market orders allows at most 7 successful additions", async () => {
    for (let i = 0; i < 5; i++) {
      adapter.openOrders.push({
        exchangeOrderId: `existing-${i}`,
        market: MARKET,
        side: i % 2 === 0 ? "buy" : "sell",
        price: 50_000 + i,
        size: 0.001,
        filledSize: 0,
        remainingSize: 0.001,
        isReduceOnly: false,
        state: "open",
      });
    }
    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.quotesPlaced).toBe(7);
    expect(adapter.getOpenOrders(MARKET)).toHaveLength(12);
    expect(summary.riskSkippedLevels.openOrderCapacity).toBe(3);
    expect(summary.riskSkipMessages.some((message) => message.includes("capacity"))).toBe(true);
  });

  it("increments capacity for successes but not rejected placements", async () => {
    for (let i = 0; i < 5; i++) {
      adapter.openOrders.push({
        exchangeOrderId: `existing-${i}`,
        market: MARKET,
        side: "buy",
        price: 50_000 + i,
        size: 0.001,
        filledSize: 0,
        remainingSize: 0.001,
        isReduceOnly: false,
        state: "open",
      });
    }
    adapter.placeOrderResults.push(
      { success: false, reason: "REJECTED", message: "offline rejection 1" },
      { success: false, reason: "REJECTED", message: "offline rejection 2" },
      { success: false, reason: "REJECTED", message: "offline rejection 3" },
    );
    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.quotesPlaced).toBe(7);
    expect(summary.quotesFailed).toBe(3);
    expect(summary.quotesAttempted).toBe(10);
  });

  it("uses aggregate market-scoped same-side exposure and does not net opposing orders", async () => {
    adapter.openOrders.push(
      {
        exchangeOrderId: "btc-buy",
        market: MARKET,
        side: "buy",
        price: 50_000,
        size: 0.004,
        filledSize: 0,
        remainingSize: 0.004,
        isReduceOnly: false,
        state: "open",
      },
      {
        exchangeOrderId: "btc-sell",
        market: MARKET,
        side: "sell",
        price: 70_000,
        size: 1,
        filledSize: 0,
        remainingSize: 1,
        isReduceOnly: false,
        state: "open",
      },
      {
        exchangeOrderId: "eth-buy",
        market: "ETHUSD",
        side: "buy",
        price: 3_000,
        size: 100,
        filledSize: 0,
        remainingSize: 100,
        isReduceOnly: false,
        state: "open",
      },
    );
    const engine = new MarketEngine(
      adapter,
      testConfig({
        orderSize: { min: 0.001, max: 0.001 },
        riskLimits: { ...testConfig().riskLimits, maxLongPosition: 0.005, maxShortPosition: 2 },
      }),
      tempPaths(),
    );
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.riskSkippedLevels.aggregateLongExposure).toBe(4);
    expect(summary.quotesPlaced).toBe(6);
    expect(adapter.placeOrderCalls.filter((call) => call.side === "buy")).toHaveLength(1);
    expect(adapter.placeOrderCalls.filter((call) => call.side === "sell")).toHaveLength(5);
  });

  it("does not let another market's orders consume this market's capacity", async () => {
    for (let i = 0; i < 20; i++) {
      adapter.openOrders.push({
        exchangeOrderId: `eth-${i}`,
        market: "ETHUSD",
        side: "buy",
        price: 3_000,
        size: 1,
        filledSize: 0,
        remainingSize: 1,
        isReduceOnly: false,
        state: "open",
      });
    }
    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.reconciliation.openOrderCount).toBe(0);
    expect(summary.quotesPlaced).toBe(10);
    expect(summary.riskSkippedLevels.openOrderCapacity).toBe(0);
  });

  it("counts an exit slot and preserves capacity for it", async () => {
    adapter.positions.push({
      market: MARKET,
      baseSize: 0.004,
      markPrice: 60_000,
      unrealizedPnl: 0,
      openOrderCount: 0,
    });
    const engine = new MarketEngine(
      adapter,
      testConfig({
        quoteLevels: 2,
        levelSpacingBps: [2, 3],
        orderSize: { min: 0.001, max: 0.001 },
        riskLimits: { ...testConfig().riskLimits, maxOpenOrders: 5 },
      }),
      tempPaths(),
    );
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.reduceOnlyAction).toBe("placed");
    expect(summary.quotesPlaced).toBe(4);
    expect(adapter.getOpenOrders(MARKET)).toHaveLength(5);
    expect(adapter.placeOrderCalls[0]?.isReduceOnly).toBe(true);
    expect(adapter.placeOrderCalls.slice(1).every((call) => !call.isReduceOnly)).toBe(true);
  });

  it("does not re-place quotes that are still within their minimum lifetime", async () => {
    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
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

    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    await engine.start();
    const summary = await engine.runCycle();

    expect(summary.reduceOnlyAction).toBe("placed");
    const reduceOnlyOrder = engine.registry.list().find((o) => o.isReduceOnly);
    expect(reduceOnlyOrder).toBeDefined();
    expect(reduceOnlyOrder?.side).toBe("sell"); // long position -> exit by selling
  });

  it("blocks all new placements while reconciliation is degraded, without touching the exchange", async () => {
    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
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

  it("resumes quoting once reconciliation resolves filled orders via fill-replay, instead of staying blocked forever", async () => {
    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    await engine.start();
    const first = await engine.runCycle();
    expect(first.quotesPlaced).toBe(10);

    // Two resting quotes fill and drop off the exchange's open-orders view between cycles —
    // exactly what the paper-run bug looked like: quotes vanish, but with real fill evidence
    // behind the disappearance. Picking the two outermost (10bps) levels, not the innermost ones:
    // the innermost levels' neighbor gap is numerically right at the ladder's own coverage
    // tolerance radius, which is an unrelated, pre-existing floating-point edge sensitivity in
    // manageQuoteLadder's alreadyCovered check, not something this fix touches.
    const resting = engine.registry.listByState("RESTING").slice(-2);
    const filledOne = resting[0];
    const filledTwo = resting[1];
    if (!filledOne || !filledTwo) throw new Error("expected two resting orders from cycle 1");
    for (const order of [filledOne, filledTwo]) {
      adapter.openOrders = adapter.openOrders.filter(
        (o) => o.exchangeOrderId !== order.exchangeOrderId,
      );
      adapter.fillsByOrderId.set(order.exchangeOrderId as string, [
        {
          exchangeOrderId: order.exchangeOrderId as string,
          tradeId: `t-${order.exchangeOrderId}`,
          market: MARKET,
          side: order.side,
          price: order.price,
          size: order.size,
          timestamp: Date.now(),
        },
      ]);
    }

    const second = await engine.runCycle();
    expect(second.reconciliation.healthy).toBe(true);
    expect(second.blockedReason).toBeUndefined();
    expect(second.quotesPlaced).toBe(2); // exactly the two vacated levels refilled
    expect(engine.registry.get(filledOne.clientOrderId)?.state).toBe("FILLED");
    expect(engine.registry.get(filledTwo.clientOrderId)?.state).toBe("FILLED");
  });

  it("persists a fill-replay-resolved order to disk even when the cycle stays blocked by a separate, unexplained anomaly", async () => {
    const paths = tempPaths();
    const engine = new MarketEngine(adapter, testConfig(), paths);
    await engine.start();
    await engine.runCycle();

    const resolvedOrder = engine.registry.listByState("RESTING")[0];
    if (!resolvedOrder) throw new Error("expected a resting order from cycle 1");
    adapter.openOrders = adapter.openOrders.filter(
      (o) => o.exchangeOrderId !== resolvedOrder.exchangeOrderId,
    );
    adapter.fillsByOrderId.set(resolvedOrder.exchangeOrderId as string, [
      {
        exchangeOrderId: resolvedOrder.exchangeOrderId as string,
        tradeId: "t-resolved",
        market: MARKET,
        side: resolvedOrder.side,
        price: resolvedOrder.price,
        size: resolvedOrder.size,
        timestamp: Date.now(),
      },
    ]);
    // A genuinely unexplained anomaly keeps this cycle degraded regardless of the resolution
    // above — the save() fix must still fire on the early-return path.
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

    const second = await engine.runCycle();
    expect(second.blockedReason).toMatch(/degraded/);

    const persisted = JSON.parse(readFileSync(paths.stateFilePath, "utf-8")) as Array<{
      clientOrderId: string;
      state: string;
    }>;
    const persistedResolved = persisted.find(
      (o) => o.clientOrderId === resolvedOrder.clientOrderId,
    );
    expect(persistedResolved?.state).toBe("FILLED");
  });

  it("blocks all new placements when the account is at bankruptcy risk", async () => {
    adapter.marginStatus = { ...adapter.marginStatus, isAtBankruptcyRisk: true };
    const engine = new MarketEngine(adapter, testConfig(), tempPaths());
    await engine.start();
    const summary = await engine.runCycle();
    expect(summary.blockedReason).toMatch(/bankruptcy/);
    expect(summary.quotesPlaced).toBe(0);
  });

  it("shared account bankruptcy state blocks both market engines", async () => {
    adapter.marketPrices.set("ETHUSD", { market: "ETHUSD", mark: 3_000, index: 3_000 });
    adapter.marginStatus = { ...adapter.marginStatus, isAtBankruptcyRisk: true };
    const btcEngine = new MarketEngine(adapter, testConfig(), tempPaths());
    const ethEngine = new MarketEngine(
      adapter,
      testConfig({ symbol: "ETHUSD" }),
      tempPaths(),
    );
    await btcEngine.start();
    await ethEngine.start();

    const [btc, eth] = await Promise.all([btcEngine.runCycle(), ethEngine.runCycle()]);
    expect(btc.blockedReason).toMatch(/bankruptcy/);
    expect(eth.blockedReason).toMatch(/bankruptcy/);
    expect(adapter.placeOrderCalls).toHaveLength(0);
  });

  describe("session PnL availability gate", () => {
    it("blocks all new placements, including a reduce-only exit, while session PnL is marked unavailable", async () => {
      // Position exceeds inventoryReductionThresholdBase (0.003) — without the PnL gate this
      // would otherwise place a reduce-only exit (see the SPEC 5c test above).
      adapter.positions.push({
        market: MARKET,
        baseSize: 0.004,
        markPrice: 60000,
        unrealizedPnl: 0,
        openOrderCount: 0,
      });

      const engine = new MarketEngine(adapter, testConfig(), tempPaths());
      await engine.start();
      engine.markSessionPnlUnavailable("N1 getAccountPnl() request failed: network hiccup");

      const summary = await engine.runCycle();

      expect(summary.blockedReason).toMatch(/Session realized-PnL unavailable/);
      expect(summary.blockedReason).toMatch(/network hiccup/);
      expect(summary.quotesPlaced).toBe(0);
      expect(summary.reduceOnlyAction).toBe("none");
      expect(engine.registry.list().find((o) => o.isReduceOnly)).toBeUndefined();
    });

    it("resumes normal placement once confirmSessionPnlHealthy() is called after a prior failure", async () => {
      const engine = new MarketEngine(adapter, testConfig(), tempPaths());
      await engine.start();
      engine.markSessionPnlUnavailable("drain failed");

      const blocked = await engine.runCycle();
      expect(blocked.blockedReason).toMatch(/Session realized-PnL unavailable/);
      expect(blocked.quotesPlaced).toBe(0);

      engine.confirmSessionPnlHealthy();
      const recovered = await engine.runCycle();
      expect(recovered.blockedReason).toBeUndefined();
      expect(recovered.quotesPlaced).toBeGreaterThan(0);
    });

    it("stays blocked across multiple cycles until explicitly confirmed healthy again", async () => {
      const engine = new MarketEngine(adapter, testConfig(), tempPaths());
      await engine.start();
      engine.markSessionPnlUnavailable("drain failed");

      const first = await engine.runCycle();
      const second = await engine.runCycle();
      expect(first.blockedReason).toMatch(/Session realized-PnL unavailable/);
      expect(second.blockedReason).toMatch(/Session realized-PnL unavailable/);
      expect(second.quotesPlaced).toBe(0);
    });
  });
});
