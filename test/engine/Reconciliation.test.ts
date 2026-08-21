import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reconciliation } from "../../src/engine/Reconciliation.js";
import { OrderRegistry } from "../../src/engine/OrderRegistry.js";
import { TradeLog, type TradeLogEntry } from "../../src/engine/TradeLog.js";
import { CANCEL_CONFIRM_GRACE_MS, type LocalOrder } from "../../src/engine/types.js";
import { FakeExchangeAdapter } from "./fakeAdapter.js";

const MARKET = "BTCUSD";

function tempTradeLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-reconciliation-tradelog-test-"));
  return join(dir, "trades.jsonl");
}

function tempRegistryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-reconciliation-registry-test-"));
  return join(dir, "orders.json");
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
    registry = new OrderRegistry(MARKET, tempRegistryPath());
    reconciliation = new Reconciliation(adapter, registry, MARKET, new TradeLog("/dev/null"));
  });

  it("records a confirmed absent zero-fill managed order as CANCELLED", async () => {
    // Local file claims an order resting that the exchange has never heard of.
    registry.upsert(localOrder({ clientOrderId: "phantom", exchangeOrderId: "999" }));

    const result = await reconciliation.syncFromExchange();

    expect(result.healthy).toBe(true);
    expect(registry.get("phantom")?.state).toBe("CANCELLED");
  });

  it("flags but never adopts an exchange-only unmanaged order", async () => {
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
    expect(result.healthy).toBe(false);
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: "EXCHANGE_ORDER_NOT_LOCAL", exchangeOrderId: "e42" }),
    ]);
    expect(registry.findByExchangeOrderId("e42")).toBeUndefined();
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

  it("preserves an absent zero-fill managed order as CANCELLED after restart", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1" }));
    // no fills configured for e1
    await reconciliation.syncFromExchange();
    expect(registry.get("c1")?.state).toBe("CANCELLED");
  });

  it("keeps startup absence ambiguous when fill lookup fails", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "e1" }));
    adapter.getOrderFillsError = new Error("network blip");
    const result = await reconciliation.syncFromExchange();
    expect(result.healthy).toBe(false);
    expect(result.anomalies[0]?.kind).toBe("LOCAL_ORDER_NOT_ON_EXCHANGE");
    expect(registry.get("c1")?.state).toBe("RESTING");
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

  it("resolves a confirmed absent zero-fill managed order as CANCELLED", async () => {
    registry.upsert(localOrder({ clientOrderId: "c1", exchangeOrderId: "gone" }));
    // No fills configured for "gone" — adapter.getOrderFills() returns [] by default.
    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(result.anomalies).toHaveLength(0);
    expect(registry.get("c1")?.state).toBe("CANCELLED");
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

    adapter.openOrders = []; // exchange confirms absence; successful zero-fill replay resolves cancellation
    await reconciliation.checkAgainstExchange();
    expect(reconciliation.getHealthyStreak()).toBe(3);
    expect(reconciliation.getDegradedStreak()).toBe(0);
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

// Residual SPEC.md Section 5a gap: OrderLifecycle.cancelOrder()'s single fill-replay snapshot
// can't prove nothing fills in the gap between it running and the exchange actually finishing the
// cancel. That gap is what let real ETHUSD covering fills go missing from trades-ETHUSD.jsonl
// (net signed volume drifted to -0.887 base while the live-logged position stayed within its
// ±0.15 risk limit the whole time). These tests cover the grace-period recheck that replaces
// immediate CANCELLED-on-no-fill finalization.
describe("Reconciliation.checkAgainstExchange — CANCEL_PENDING_CONFIRM grace-period recheck", () => {
  let adapter: FakeExchangeAdapter;
  let registry: OrderRegistry;
  let reconciliation: Reconciliation;

  beforeEach(() => {
    vi.useFakeTimers();
    adapter = new FakeExchangeAdapter();
    registry = new OrderRegistry(MARKET, "/dev/null");
    reconciliation = new Reconciliation(adapter, registry, MARKET, new TradeLog("/dev/null"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function pendingOrder(overrides: Partial<LocalOrder> = {}): LocalOrder {
    return localOrder({
      state: "CANCEL_PENDING_CONFIRM",
      cancelGraceUntil: Date.now() + CANCEL_CONFIRM_GRACE_MS,
      ...overrides,
    });
  }

  it("leaves a CANCEL_PENDING_CONFIRM order pending, not an anomaly, while still open on the exchange and within grace", async () => {
    registry.upsert(pendingOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01 }));
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
    // No fills configured yet — adapter.getOrderFills() returns [].

    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(result.anomalies).toHaveLength(0);
    expect(registry.get("c1")?.state).toBe("CANCEL_PENDING_CONFIRM");
  });

  it("resolves a CANCEL_PENDING_CONFIRM order to FILLED — and logs the fill — once a fill lands after the initial cancel snapshot", async () => {
    const tradeLogPath = tempTradeLogPath();
    const loggingReconciliation = new Reconciliation(adapter, registry, MARKET, new TradeLog(tradeLogPath));
    registry.upsert(pendingOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01 }));
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
    // This fill wasn't visible to OrderLifecycle.cancelOrder()'s original snapshot — it lands in
    // the race window, discovered only on this later reconciliation pass.
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t-late",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.01,
        timestamp: Date.now(),
      },
    ]);

    const result = await loggingReconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(result.anomalies).toHaveLength(0);
    const resolved = registry.get("c1");
    expect(resolved?.state).toBe("FILLED");
    expect(resolved?.filledSize).toBe(0.01);
    expect(resolved?.cancelGraceUntil).toBeUndefined();
    expect(readTradeLog(tradeLogPath)).toEqual([
      expect.objectContaining({ tradeId: "t-late", source: "reconciliation" }),
    ]);
  });

  it("resolves a CANCEL_PENDING_CONFIRM order to CANCELLED, without an anomaly, once the exchange confirms it's genuinely gone", async () => {
    registry.upsert(pendingOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01 }));
    // Not in adapter.openOrders — the exchange no longer shows it, and no fills are configured.

    const result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(result.anomalies).toHaveLength(0);
    const resolved = registry.get("c1");
    expect(resolved?.state).toBe("CANCELLED");
    expect(resolved?.cancelGraceUntil).toBeUndefined();
  });

  it("fails a CANCEL_PENDING_CONFIRM order open to CANCELLED and raises CANCEL_CONFIRM_TIMEOUT once the grace period elapses while still ambiguous", async () => {
    registry.upsert(pendingOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01 }));
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

    // Still within grace: stays pending, no anomaly.
    let result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(registry.get("c1")?.state).toBe("CANCEL_PENDING_CONFIRM");

    // Grace expires with the exchange still showing it open and still no fill evidence.
    vi.advanceTimersByTime(CANCEL_CONFIRM_GRACE_MS + 1);
    result = await reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(false);
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: "CANCEL_CONFIRM_TIMEOUT", exchangeOrderId: "e1" }),
    ]);
    const resolved = registry.get("c1");
    expect(resolved?.state).toBe("CANCELLED");
    expect(resolved?.cancelGraceUntil).toBeUndefined();
  });

  it("does not double-log a fill recovered across two consecutive recheck cycles", async () => {
    const tradeLogPath = tempTradeLogPath();
    const loggingReconciliation = new Reconciliation(adapter, registry, MARKET, new TradeLog(tradeLogPath));
    registry.upsert(pendingOrder({ clientOrderId: "c1", exchangeOrderId: "e1", size: 0.01 }));
    adapter.openOrders.push({
      exchangeOrderId: "e1",
      market: MARKET,
      side: "buy",
      price: 60000,
      size: 0.005,
      filledSize: 0,
      remainingSize: 0.005,
      isReduceOnly: false,
      state: "open",
    });
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t-partial",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.005,
        timestamp: Date.now(),
      },
    ]);

    await loggingReconciliation.checkAgainstExchange(); // partial fill, still pending (0.005 < 0.01)
    adapter.openOrders = []; // now genuinely gone, getOrderFills() still reports the same one fill
    await loggingReconciliation.checkAgainstExchange(); // resolves CANCELLED

    expect(readTradeLog(tradeLogPath)).toHaveLength(1);
    expect(registry.get("c1")?.state).toBe("CANCELLED");
    expect(registry.get("c1")?.filledSize).toBe(0.005);
  });
});

describe("Reconciliation.checkAgainstExchange — state-aware EXCHANGE_ORDER_NOT_LOCAL", () => {
  let adapter: FakeExchangeAdapter;
  let registry: OrderRegistry;
  let reconciliation: Reconciliation;

  beforeEach(() => {
    adapter = new FakeExchangeAdapter();
    registry = new OrderRegistry(MARKET, "/dev/null");
    reconciliation = new Reconciliation(adapter, registry, MARKET, new TradeLog("/dev/null"));
  });

  // Mirror image of the CANCEL_PENDING_CONFIRM race, caught from the other direction: a local
  // record already finalized CANCELLED/FILLED (e.g. via a fail-open path) while the exchange
  // still shows it resting. Before this fix, findByExchangeOrderId() finding ANY local record —
  // regardless of its state — silently satisfied this check, exactly the kind of silence that let
  // fills go missing.
  it("flags LOCAL_TERMINAL_STILL_ON_EXCHANGE, and recovers a missed fill, when a locally CANCELLED order is still resting on the exchange", async () => {
    const tradeLogPath = tempTradeLogPath();
    const loggingReconciliation = new Reconciliation(adapter, registry, MARKET, new TradeLog(tradeLogPath));
    registry.upsert(
      localOrder({
        clientOrderId: "c1",
        exchangeOrderId: "e1",
        size: 0.01,
        filledSize: 0,
        state: "CANCELLED",
      }),
    );
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
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t-missed",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.01,
        timestamp: Date.now(),
      },
    ]);

    const result = await loggingReconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(false);
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: "LOCAL_TERMINAL_STILL_ON_EXCHANGE", exchangeOrderId: "e1" }),
    ]);
    const resolved = registry.get("c1");
    expect(resolved?.state).toBe("FILLED");
    expect(resolved?.filledSize).toBe(0.01);
    expect(readTradeLog(tradeLogPath)).toEqual([
      expect.objectContaining({ tradeId: "t-missed" }),
    ]);
  });

  it("still flags LOCAL_TERMINAL_STILL_ON_EXCHANGE even when no new fill is found (genuinely surprising state, stays visible)", async () => {
    registry.upsert(
      localOrder({
        clientOrderId: "c1",
        exchangeOrderId: "e1",
        size: 0.01,
        filledSize: 0,
        state: "CANCELLED",
      }),
    );
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
    expect(result.healthy).toBe(false);
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: "LOCAL_TERMINAL_STILL_ON_EXCHANGE", exchangeOrderId: "e1" }),
    ]);
    // No fill evidence recovered — local state is left untouched, still CANCELLED.
    expect(registry.get("c1")?.state).toBe("CANCELLED");
  });
});
