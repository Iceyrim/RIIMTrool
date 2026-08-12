import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderLifecycle } from "../../src/engine/OrderLifecycle.js";
import { OrderRegistry } from "../../src/engine/OrderRegistry.js";
import { TradeLog, type TradeLogEntry } from "../../src/engine/TradeLog.js";
import type { LocalOrder } from "../../src/engine/types.js";
import { FakeExchangeAdapter } from "./fakeAdapter.js";

function tempTradeLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-lifecycle-tradelog-test-"));
  return join(dir, "trades.jsonl");
}

function readTradeLog(path: string): TradeLogEntry[] {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TradeLogEntry);
}

const MARKET = "BTCUSD";

describe("OrderLifecycle", () => {
  let adapter: FakeExchangeAdapter;
  let registry: OrderRegistry;
  let tradeLog: TradeLog;
  let lifecycle: OrderLifecycle;

  beforeEach(() => {
    adapter = new FakeExchangeAdapter();
    registry = new OrderRegistry(MARKET, "/dev/null"); // never saved to disk in these tests
    tradeLog = new TradeLog("/dev/null");
    lifecycle = new OrderLifecycle(adapter, registry, MARKET, tradeLog);
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

    it("logs a REJECTED placement to console.error — not tracked locally is not the same as invisible (regression: this was previously a fully silent drop)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        adapter.placeOrderResults.push({
          success: false,
          reason: "REJECTED",
          message: "insufficient margin",
        });
        await lifecycle.placeQuote({ side: "buy", type: "postOnly", size: 0.01, price: 60000 });

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0]?.[0]).toContain("insufficient margin");
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("logs an UNRESOLVED_NOT_CONFIRMED placement to console.warn", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        adapter.placeOrderResults.push({
          success: false,
          reason: "UNRESOLVED_NOT_CONFIRMED",
          message: "N1 placeOrder() resolved without an orderId or any fills",
        });
        await lifecycle.placeQuote({ side: "buy", type: "postOnly", size: 0.01, price: 60000 });

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain(
          "N1 placeOrder() resolved without an orderId or any fills",
        );
      } finally {
        warnSpy.mockRestore();
      }
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

  describe("trade logging (SPEC 7)", () => {
    it("logs a fill reported synchronously at placement, tagged with source and reduce-only status", async () => {
      const tradeLogPath = tempTradeLogPath();
      const loggingLifecycle = new OrderLifecycle(
        adapter,
        registry,
        MARKET,
        new TradeLog(tradeLogPath),
      );
      adapter.placeOrderResults.push({
        success: true,
        order: {
          exchangeOrderId: "e-filled",
          market: MARKET,
          side: "buy",
          price: 60000,
          size: 0.01,
          filledSize: 0.01,
          remainingSize: 0,
          isReduceOnly: false,
          state: "filled",
        },
        fills: [
          {
            exchangeOrderId: "e-filled",
            market: MARKET,
            side: "buy",
            price: 60000,
            size: 0.01,
            timestamp: 1_700_000_000_000,
          },
        ],
      });

      await loggingLifecycle.placeReduceOnlyExit({
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60000,
      });

      const entries = readTradeLog(tradeLogPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        market: MARKET,
        side: "buy",
        size: 0.01,
        price: 60000,
        isReduceOnly: true,
        source: "placement",
      });
    });

    it("logs a fill discovered by the cancel-order race check, and does not log it twice on a repeated call", async () => {
      const tradeLogPath = tempTradeLogPath();
      const loggingLifecycle = new OrderLifecycle(
        adapter,
        registry,
        MARKET,
        new TradeLog(tradeLogPath),
      );
      const placeResult = await loggingLifecycle.placeQuote({
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60000,
      });
      const exchangeOrderId = placeResult.order!.exchangeOrderId!;
      adapter.fillsByOrderId.set(exchangeOrderId, [
        {
          exchangeOrderId,
          tradeId: "t-race",
          market: MARKET,
          side: "buy",
          price: 60000,
          size: 0.01,
          timestamp: 1_700_000_000_000,
        },
      ]);

      await loggingLifecycle.cancelOrder(placeResult.order!.clientOrderId);
      // getOrderFills() reports full cumulative history on every call — calling cancelOrder again
      // on the same (now-terminal) order re-fetches the same fill and must not re-log it.
      await loggingLifecycle.cancelOrder(placeResult.order!.clientOrderId);

      const entries = readTradeLog(tradeLogPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        market: MARKET,
        side: "buy",
        size: 0.01,
        price: 60000,
        isReduceOnly: false,
        source: "cancel_race_check",
        tradeId: "t-race",
      });
    });
  });
});
