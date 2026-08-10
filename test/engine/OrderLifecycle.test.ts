import { beforeEach, describe, expect, it } from "vitest";
import { OrderLifecycle } from "../../src/engine/OrderLifecycle.js";
import { OrderRegistry } from "../../src/engine/OrderRegistry.js";
import type { LocalOrder } from "../../src/engine/types.js";
import { FakeExchangeAdapter } from "./fakeAdapter.js";

const MARKET = "BTCUSD";

describe("OrderLifecycle", () => {
  let adapter: FakeExchangeAdapter;
  let registry: OrderRegistry;
  let lifecycle: OrderLifecycle;

  beforeEach(() => {
    adapter = new FakeExchangeAdapter();
    registry = new OrderRegistry(MARKET, "/dev/null"); // never saved to disk in these tests
    lifecycle = new OrderLifecycle(adapter, registry, MARKET);
  });

  describe("placeQuote", () => {
    it("records a RESTING local order on success", async () => {
      const result = await lifecycle.placeQuote({
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60000,
      });
      expect(result.success).toBe(true);
      expect(result.order?.state).toBe("RESTING");
      expect(registry.list()).toHaveLength(1);
    });

    it("SPEC 5b: a resolved-but-unconfirmed placement is recorded as UNKNOWN, not dropped or assumed successful", async () => {
      adapter.placeOrderResults.push({
        success: false,
        reason: "UNRESOLVED_NOT_CONFIRMED",
        message: "N1 placeOrder() resolved without an orderId or any fills",
      });
      const result = await lifecycle.placeQuote({
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60000,
      });
      expect(result.success).toBe(false);
      expect(result.order?.state).toBe("UNKNOWN");
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0]?.state).toBe("UNKNOWN");
    });

    it("a definitively REJECTED order is not tracked locally at all", async () => {
      adapter.placeOrderResults.push({
        success: false,
        reason: "REJECTED",
        message: "insufficient margin",
      });
      const result = await lifecycle.placeQuote({
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60000,
      });
      expect(result.success).toBe(false);
      expect(registry.list()).toHaveLength(0);
    });
  });

  describe("placeReduceOnlyExit", () => {
    it("sends isReduceOnly: false to the exchange but records isReduceOnly: true locally", async () => {
      await lifecycle.placeReduceOnlyExit({
        side: "sell",
        type: "postOnly",
        size: 0.01,
        price: 60100,
      });
      expect(adapter.placeOrderCalls[0]?.isReduceOnly).toBe(false);
      expect(registry.list()[0]?.isReduceOnly).toBe(true);
    });

    it("SPEC 5c: refuses a duplicate placement while one reduce-only exit is already open", async () => {
      const first = await lifecycle.placeReduceOnlyExit({
        side: "sell",
        type: "postOnly",
        size: 0.01,
        price: 60100,
      });
      expect(first.success).toBe(true);

      const second = await lifecycle.placeReduceOnlyExit({
        side: "sell",
        type: "postOnly",
        size: 0.01,
        price: 60200,
      });
      expect(second.success).toBe(false);
      expect(second.message).toMatch(/already open/);
      expect(adapter.placeOrderCalls).toHaveLength(1); // second attempt never reached the adapter
    });

    it("shouldRepriceReduceOnlyExit respects the min-hold floor, eligible window, and max-hold ceiling", () => {
      const config = { minHoldMs: 45_000, maxHoldMs: 300_000 };
      const order: LocalOrder = {
        clientOrderId: "c1",
        exchangeOrderId: "e1",
        market: MARKET,
        side: "sell",
        type: "postOnly",
        price: 60100,
        size: 0.01,
        filledSize: 0,
        isReduceOnly: true,
        state: "RESTING",
        placedAt: 1_000_000,
        updatedAt: 1_000_000,
      };

      expect(lifecycle.shouldRepriceReduceOnlyExit(order, config, 1_000_000 + 10_000)).toBe("hold");
      expect(lifecycle.shouldRepriceReduceOnlyExit(order, config, 1_000_000 + 60_000)).toBe(
        "eligible",
      );
      expect(lifecycle.shouldRepriceReduceOnlyExit(order, config, 1_000_000 + 300_000)).toBe(
        "forced",
      );
    });
  });

  describe("cancelOrder — SPEC 5a race check", () => {
    it("resolves to FILLED when getOrderFills reveals a fill that landed in the race window", async () => {
      const placeResult = await lifecycle.placeQuote({
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60000,
      });
      const exchangeOrderId = placeResult.order!.exchangeOrderId!;
      adapter.fillsByOrderId.set(exchangeOrderId, [
        {
          exchangeOrderId,
          tradeId: "t1",
          market: MARKET,
          side: "buy",
          price: 60000,
          size: 0.01,
          timestamp: Date.now(),
        },
      ]);

      const result = await lifecycle.cancelOrder(placeResult.order!.clientOrderId);
      expect(result?.finalState).toBe("FILLED");
      expect(registry.get(placeResult.order!.clientOrderId)?.filledSize).toBe(0.01);
    });

    it("resolves to CANCELLED when no fill is found", async () => {
      const placeResult = await lifecycle.placeQuote({
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60000,
      });
      const result = await lifecycle.cancelOrder(placeResult.order!.clientOrderId);
      expect(result?.finalState).toBe("CANCELLED");
    });

    it("fails OPEN when the getOrderFills race-check lookup itself errors — resolves to CANCELLED rather than getting stuck", async () => {
      const placeResult = await lifecycle.placeQuote({
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60000,
      });
      adapter.getOrderFillsError = new Error("network hiccup");

      const result = await lifecycle.cancelOrder(placeResult.order!.clientOrderId);
      expect(result?.failedOpen).toBe(true);
      expect(result?.finalState).toBe("CANCELLED");
      expect(registry.get(placeResult.order!.clientOrderId)?.note).toMatch(/failed open/);
    });

    it("returns null for an order that was never confirmed on the exchange (no exchangeOrderId)", async () => {
      adapter.placeOrderResults.push({
        success: false,
        reason: "UNRESOLVED_NOT_CONFIRMED",
        message: "unresolved",
      });
      const placeResult = await lifecycle.placeQuote({
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60000,
      });
      const result = await lifecycle.cancelOrder(placeResult.order!.clientOrderId);
      expect(result).toBeNull();
    });
  });
});
