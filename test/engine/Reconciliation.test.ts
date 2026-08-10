import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Reconciliation } from "../../src/engine/Reconciliation.js";
import { OrderRegistry } from "../../src/engine/OrderRegistry.js";
import { TradeLog, type TradeLogEntry } from "../../src/engine/TradeLog.js";
import type { LocalOrder } from "../../src/engine/types.js";
import { FakeExchangeAdapter } from "./fakeAdapter.js";

const MARKET = "BTCUSD";

function tempTradeLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-reconciliation-tradelog-test-"));
  return join(dir, "trades.jsonl");
}

function readTradeLog(path: string): TradeLogEntry[] {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TradeLogEntry);
}

function localOrder(overrides: Partial<LocalOrder> = {}): LocalOrder {
  return {
    clientOrderId: "c1",
    exchangeOrderId: "e1",
    market: MARKET,
    side: "buy",
    type: "postOnly",
    price: 60000,
    size: 0.01,
    filledSize: 0,
    isReduceOnly: false,
    state: "RESTING",
    placedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("Reconciliation.syncFromExchange (startup)", () => {
  let adapter: FakeExchangeAdapter;
  let registry: OrderRegistry;
  let reconciliation: Reconciliation;

  beforeEach(() => {
    adapter = new FakeExchangeAdapter();
    registry = new OrderRegistry(MARKET, "/dev/null");
    reconciliation = new Reconciliation(adapter, registry, MARKET, new TradeLog("/dev/null"));
  });

  it("discards stale local content that disagrees with exchange truth", async () => {
    // Local file claims an order resting that the exchange has never heard of.
    registry.upsert(localOrder({ clientOrderId: "phantom", exchangeOrderId: "999" }));

    const result = await reconciliation.syncFromExchange();

    expect(result.healthy).toBe(true);
    expect(registry.get("phantom")).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  it("adopts an order the exchange shows resting even if local had no record of it at all", async () => {
    adapter.openOrders.push({
      exchangeOrderId: "e42",
      market: MARKET,
      side: "buy",
      price: 60000,
      size: 0.01,
      filledSize: 0,
      remainingSize: 0.01,
      isReduceOnly: false,
      state: "open",
    });

    const result = await reconciliation.syncFromExchange();
    expect(result.openOrderCount).toBe(1);
    expect(registry.findByExchangeOrderId("e42")?.state).toBe("RESTING");
  });

  it("resolves a local-only order via fill-replay: a discovered fill becomes FILLED/CANCELLED, not silently kept as RESTING", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01 }));
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t1",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.01,
        timestamp: Date.now(),
      },
    ]);

    await reconciliation.syncFromExchange();
    const resolved = registry.get("c1");
    expect(resolved?.state).toBe("FILLED");
  });

  it("drops a local-only order with no fill history at all — genuinely never happened", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1" }));
    // no fills configured for e1
    await reconciliation.syncFromExchange();
    expect(registry.get("c1")).toBeUndefined();
  });

  it("logs the resolved fill to the trade log (SPEC 7), tagged with source and reduce-only status", async () => {
    const tradeLogPath = tempTradeLogPath();
    const loggingReconciliation = new Reconciliation(
      adapter,
      registry,
      MARKET,
      new TradeLog(tradeLogPath),
    );
    registry.upsert(
      localOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01, isReduceOnly: true }),
    );
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t1",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.01,
        timestamp: 1_700_000_000_000,
      },
    ]);

    await loggingReconciliation.syncFromExchange();

    const entries = readTradeLog(tradeLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      market: MARKET,
      side: "buy",
      size: 0.01,
      price: 60000,
      isReduceOnly: true,
      source: "reconciliation",
      tradeId: "t1",
    });
  });
});

describe("Reconciliation.checkAgainstExchange (runtime)", () => {
  let adapter: FakeExchangeAdapter;
  let registry: OrderRegistry;
  let reconciliation: Reconciliation;

  beforeEach(() => {
    adapter = new FakeExchangeAdapter();
    registry = new OrderRegistry(MARKET, "/dev/null");
    reconciliation = new Reconciliation(adapter, registry, MARKET, new TradeLog("/dev/null"));
  });

  it("is healthy when local and exchange state agree", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1" }));
    adapter.openOrders.push({
      exchangeOrderId: "e1",
      market: MARKET,
      side: "buy",
      price: 60000,
      size: 0.01,
      filledSize: 0,
      remainingSize: 0.01,
      isReduceOnly: false,
      state: "open",
    });

    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(result.anomalies).toHaveLength(0);
  });

  it("flags, rather than silently adopts, an exchange order with no local record", async () => {
    adapter.openOrders.push({
      exchangeOrderId: "surprise",
      market: MARKET,
      side: "buy",
      price: 60000,
      size: 0.01,
      filledSize: 0,
      remainingSize: 0.01,
      isReduceOnly: false,
      state: "open",
    });

    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(false);
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: "EXCHANGE_ORDER_NOT_LOCAL", exchangeOrderId: "surprise" }),
    ]);
    // Strict compare: the local registry is NOT auto-repaired here (unlike startup sync).
    expect(registry.findByExchangeOrderId("surprise")).toBeUndefined();
  });

  it("flags a local RESTING order the exchange no longer shows, with no fill evidence at all", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "gone" }));
    // No fills configured for "gone" — adapter.getOrderFills() returns [] by default.
    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(false);
    expect(result.anomalies[0]?.kind).toBe("LOCAL_ORDER_NOT_ON_EXCHANGE");
    // Genuinely unexplained: the registry entry is left untouched, still RESTING.
    expect(registry.get("c1")?.state).toBe("RESTING");
  });

  it("resolves a local RESTING order into FILLED, not an anomaly, when it fully filled before vanishing", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01 }));
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t1",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.01,
        timestamp: Date.now(),
      },
    ]);

    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(result.anomalies).toHaveLength(0);
    const resolved = registry.get("c1");
    expect(resolved?.state).toBe("FILLED");
    expect(resolved?.filledSize).toBe(0.01);
  });

  it("resolves a local RESTING order into CANCELLED, not an anomaly, when it partially filled before vanishing", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01 }));
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t1",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.004,
        timestamp: Date.now(),
      },
    ]);

    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(result.anomalies).toHaveLength(0);
    const resolved = registry.get("c1");
    expect(resolved?.state).toBe("CANCELLED");
    expect(resolved?.filledSize).toBe(0.004);
  });

  it("still flags a vanished local RESTING order as an anomaly when the fill-replay lookup itself fails", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1" }));
    adapter.getOrderFillsError = new Error("network blip");

    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(false);
    expect(result.anomalies[0]?.kind).toBe("LOCAL_ORDER_NOT_ON_EXCHANGE");
    // Fail open to "still an anomaly", not to a guessed resolution — registry untouched.
    expect(registry.get("c1")?.state).toBe("RESTING");
  });

  it("recovers the healthy/degraded streak once a vanished order resolves via fill-replay", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1" }));
    adapter.openOrders.push({
      exchangeOrderId: "e1",
      market: MARKET,
      side: "buy",
      price: 60000,
      size: 0.01,
      filledSize: 0,
      remainingSize: 0.01,
      isReduceOnly: false,
      state: "open",
    });

    await reconciliation.checkAgainstExchange();
    expect(reconciliation.getHealthyStreak()).toBe(1);

    // The order fills and drops off the exchange's open-orders view.
    adapter.openOrders = [];
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t1",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.01,
        timestamp: Date.now(),
      },
    ]);

    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(reconciliation.getHealthyStreak()).toBe(2);
    expect(reconciliation.getDegradedStreak()).toBe(0);
  });

  it("tracks healthy/degraded streaks across cycles", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1" }));
    adapter.openOrders.push({
      exchangeOrderId: "e1",
      market: MARKET,
      side: "buy",
      price: 60000,
      size: 0.01,
      filledSize: 0,
      remainingSize: 0.01,
      isReduceOnly: false,
      state: "open",
    });

    await reconciliation.checkAgainstExchange();
    await reconciliation.checkAgainstExchange();
    expect(reconciliation.getHealthyStreak()).toBe(2);

    adapter.openOrders = []; // exchange order vanishes without local knowing
    await reconciliation.checkAgainstExchange();
    expect(reconciliation.getHealthyStreak()).toBe(0);
    expect(reconciliation.getDegradedStreak()).toBe(1);
  });

  it("logs a fill resolved via resolveVanishedOrder to the trade log (SPEC 7)", async () => {
    const tradeLogPath = tempTradeLogPath();
    const loggingReconciliation = new Reconciliation(
      adapter,
      registry,
      MARKET,
      new TradeLog(tradeLogPath),
    );
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01 }));
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t1",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.01,
        timestamp: 1_700_000_000_000,
      },
    ]);

    await loggingReconciliation.checkAgainstExchange();

    const entries = readTradeLog(tradeLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      market: MARKET,
      side: "buy",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
      source: "reconciliation",
      tradeId: "t1",
    });
  });
});
