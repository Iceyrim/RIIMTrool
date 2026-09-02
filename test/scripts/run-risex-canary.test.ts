import { describe, expect, it, vi } from "vitest";
import type { NormalizedOrder, NormalizedPosition } from "../../src/adapters/ExchangeAdapter.js";
import { executeRiseXCanary, planRiseXCanary } from "../../scripts/run-risex-canary.js";
import { FakeExchangeAdapter } from "../engine/fakeAdapter.js";

const market = { marketId: 1, symbol: "BTC/USDC", displayName: "BTC", markPrice: 60_000, indexPrice: 60_000, lastPrice: 60_000, stepSize: 0.00001, stepPrice: 0.1, minOrderSize: 0.00001, maxLeverage: 50, active: true };
const book = { marketId: 1, bids: [{ price: 60_000, quantity: 1, orderCount: 1 }], asks: [{ price: 60_001, quantity: 1, orderCount: 1 }] };
const plan = planRiseXCanary(market, book);
const flat: NormalizedPosition = { market: "BTCUSD", baseSize: 0, markPrice: 60_000, unrealizedPnl: 0, openOrderCount: 0 };

describe("RISEx one-shot canary", () => {
  it("plans one passive tick below bid within the hard cap", () => {
    expect(plan).toMatchObject({ bestBid: 60_000, price: 59_999.9, size: 0.00018 });
    expect(plan.notionalUsd).toBeLessThanOrEqual(15);
  });
  it("rejects a market whose minimum size breaks the approved size", () => {
    expect(() => planRiseXCanary({ ...market, minOrderSize: 0.001 }, book)).toThrow(/size is not valid/);
  });
  it("places once, cancels the exact authoritative order once, and finishes flat", async () => {
    const adapter = new FakeExchangeAdapter(); adapter.positions = [flat]; adapter.openOrders = [];
    const order: NormalizedOrder = { exchangeOrderId: "0xexact", market: "BTCUSD", side: "buy", type: "postOnly", price: plan.price, size: plan.size, filledSize: 0, remainingSize: plan.size, isReduceOnly: false, state: "open" };
    adapter.placeOrder = vi.fn(async () => { adapter.openOrders = [order]; return { success: true as const, order, fills: [] }; });
    adapter.cancelOrder = vi.fn(async (id) => { adapter.openOrders = []; return { success: true, exchangeOrderId: id }; });
    const report = await executeRiseXCanary(adapter, plan);
    expect(report.finalStatus).toBe("completed-flat");
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    expect(adapter.cancelOrder).toHaveBeenCalledWith("0xexact", "BTCUSD");
    expect(adapter.cancelOrder).toHaveBeenCalledTimes(1);
  });
  it("never retries an ambiguous placement", async () => {
    const adapter = new FakeExchangeAdapter(); adapter.positions = [flat];
    adapter.placeOrder = vi.fn(async () => ({ success: false as const, reason: "UNRESOLVED_NOT_CONFIRMED" as const, message: "timeout" }));
    await expect(executeRiseXCanary(adapter, plan)).rejects.toThrow(/ambiguous/);
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
  });
  it("fails when final reconciliation is not flat", async () => {
    const adapter = new FakeExchangeAdapter(); adapter.positions = [flat];
    const order: NormalizedOrder = { exchangeOrderId: "x", market: "BTCUSD", side: "buy", type: "postOnly", price: plan.price, size: plan.size, filledSize: 0, remainingSize: plan.size, isReduceOnly: false, state: "open" };
    adapter.placeOrder = vi.fn(async () => { adapter.openOrders = [order]; return { success: true as const, order, fills: [] }; });
    adapter.cancelOrder = vi.fn(async () => { adapter.openOrders = []; adapter.positions = [{ ...flat, baseSize: 0.00018 }]; return { success: true, exchangeOrderId: "x" }; });
    await expect(executeRiseXCanary(adapter, plan)).resolves.toMatchObject({ finalStatus: "manual-review-required" });
  });
});
