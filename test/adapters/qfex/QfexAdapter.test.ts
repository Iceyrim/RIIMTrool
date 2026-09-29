import { describe, expect, it, vi } from "vitest";
import { normalizeQfexOrder, QfexAdapter } from "../../../src/adapters/qfex/QfexAdapter.js";
import type { QfexFillRaw, QfexMessage } from "../../../src/adapters/qfex/types.js";

class FakeTransport {
  listeners: Array<(message: QfexMessage) => void> = [];
  requests: QfexMessage[] = [];
  userTrades: QfexFillRaw[] = [];
  onMessage(listener: (message: QfexMessage) => void) { this.listeners.push(listener); return () => undefined; }
  emit(message: QfexMessage) { for (const listener of this.listeners) listener(message); }
  async connect() {
    this.emit({ type: "mark_price", symbol: "US500-USD", price: "6000" });
    this.emit({ balance_response: { deposit: 100, realised_pnl: 0, order_margin: 0, position_margin: 0, unrealised_pnl: 0, net_funding: 0, available_balance: 100, fees: 0 } });
    this.emit({ position_response: { symbol: "US500-USD", position: 0, realised_pnl: 0, unrealised_pnl: 0, open_orders: 0, initial_margin: 0.05, maintenance_margin: 0.03, leverage: 1 } });
  }
  async disconnect() {}
  async request(message: QfexMessage): Promise<unknown> {
    this.requests.push(message);
    if (message.type === "get_user_orders") return { all_orders_response: { orders: [] } };
    if (message.type === "add_order") {
      const params = message.params as Record<string, unknown>;
      return { order_response: { order_id: "o1", client_order_id: params.client_order_id, symbol: "US500-USD", status: "ACK", quantity: 0.001, quantity_remaining: 0.001, price: 5990, side: "BUY", type: "ALO" } };
    }
    if (message.type === "cancel_order") return { order_response: { order_id: "o1", symbol: "US500-USD", status: "CANCELLED", quantity: 0.001, quantity_remaining: 0.001, price: 5990, side: "BUY", type: "ALO" } };
    return { user_trades_response: this.userTrades };
  }
}

describe("QfexAdapter", () => {
  it("normalizes account state and sends ALO with reduce-only intent intact", async () => {
    const transport = new FakeTransport();
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    expect(adapter.getBalances()).toEqual([{ token: "USD", amount: 100 }]);
    expect(adapter.getPositions()).toEqual([{ market: "US500USD", baseSize: 0, markPrice: 6000, unrealizedPnl: 0, openOrderCount: 0 }]);
    const placed = await adapter.placeOrder({ market: "US500USD", side: "buy", type: "postOnly", size: 0.001, price: 5990, isReduceOnly: true, clientOrderId: "client" });
    expect(placed).toMatchObject({ success: true, order: { exchangeOrderId: "o1", type: "postOnly", isReduceOnly: true } });
    expect(transport.requests.at(-1)).toMatchObject({ type: "add_order", params: { order_type: "ALO", reduce_only: true, client_order_id: "client" } });
  });
  it("fails closed while an account balance snapshot is unavailable", async () => {
    const transport = new FakeTransport();
    transport.connect = vi.fn(async () => transport.emit({ type: "mark_price", symbol: "US500-USD", price: "6000" }));
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    expect(() => adapter.getBalances()).toThrow(/has not arrived/);
  });
  it("rounds buy prices down, sell prices up, and quantities down to venue increments", () => {
    const constraints = { symbol: "MUUSD", exchangeSymbol: "MU-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.01 };
    expect(normalizeQfexOrder({ market: "MUUSD", side: "buy", price: 1004.567, size: 0.1199 }, constraints)).toEqual({ price: 1004.56, size: 0.119 });
    expect(normalizeQfexOrder({ market: "MUUSD", side: "sell", price: 1004.561, size: 0.1199 }, constraints)).toEqual({ price: 1004.57, size: 0.119 });
  });

  it("rejects quantities that normalize below the venue minimum", () => {
    const constraints = { symbol: "MUUSD", exchangeSymbol: "MU-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.01 };
    expect(() => normalizeQfexOrder({ market: "MUUSD", side: "buy", price: 1004.56, size: 0.0099 }, constraints)).toThrow(/below configured minimum/);
  });
  it("serializes trade-history reads so uncorrelated responses cannot cross-resolve", async () => {
    const transport = new FakeTransport();
    const original = transport.request.bind(transport);
    let active = 0;
    let maximumActive = 0;
    transport.request = vi.fn(async (message: QfexMessage) => {
      if (message.type !== "get_user_trades") return original(message);
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { user_trades_response: [] };
    });
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    await Promise.all([
      adapter.getOrderFills("order-1"),
      adapter.getAccountVolume({ since: "2026-09-19T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" }),
    ]);
    expect(maximumActive).toBe(1);
  });

  it("maps order fills and partitions a single batched volume response", async () => {
    const transport = new FakeTransport();
    transport.userTrades = [
      { trade_id: "t1", order_id: "order-1", symbol: "US500-USD", price: 100, quantity: 2, side: "BUY", timestamp: Date.parse("2026-09-20T00:00:00.000Z") / 1000 },
      { trade_id: "t2", order_id: "order-2", symbol: "US500-USD", price: 90, quantity: 1, side: "SELL", timestamp: Date.parse("2026-09-15T00:00:00.000Z") / 1000 },
      { trade_id: "t3", order_id: "order-3", symbol: "US500-USD", price: 50, quantity: 1, side: "BUY", timestamp: Date.parse("2026-09-20T01:00:00.000Z") },
    ];
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    expect(await adapter.getOrderFills("order-1")).toMatchObject([{ tradeId: "t1", market: "US500USD", size: 2 }]);
    expect(await adapter.getOrderFills("order-3")).toMatchObject([{ tradeId: "t3", timestamp: Date.parse("2026-09-20T01:00:00.000Z") }]);
    const fillRequest = transport.requests.filter((message) => message.type === "get_user_trades").at(-1);
    expect(fillRequest).toMatchObject({ params: { limit: 1000, offset: 0 } });
    expect(fillRequest?.params).not.toHaveProperty("order_id");
    const before = transport.requests.filter((message) => message.type === "get_user_trades").length;
    const windows = await adapter.getAccountVolumeWindows([
      { window: "24h", since: "2026-09-19T12:00:00.000Z", until: "2026-09-20T12:00:00.000Z" },
      { window: "7d", since: "2026-09-13T12:00:00.000Z", until: "2026-09-20T12:00:00.000Z" },
    ]);
    const after = transport.requests.filter((message) => message.type === "get_user_trades").length;
    expect(after - before).toBe(2);
    expect(windows["24h"]?.[0]?.quoteVolume).toBe(250);
    expect(windows["7d"]?.[0]?.quoteVolume).toBe(340);
  });
  it("uses millisecond windows, accepts timestamp-less history, paginates, and deduplicates trades", async () => {
    const transport = new FakeTransport();
    const rows: QfexFillRaw[] = Array.from({ length: 200 }, (_, index) => ({
      trade_id: `trade-${index}`,
      order_id: `order-${index}`,
      symbol: "US500-USD",
      price: 10,
      quantity: 1,
      side: "BUY",
    }));
    rows.push({ ...rows[199]! });
    rows.push({ ...rows[0]!, trade_id: "unconfigured", symbol: "META-USD", price: 999, quantity: 999 });
    const original = transport.request.bind(transport);
    transport.request = vi.fn(async (message: QfexMessage) => {
      if (message.type !== "get_user_trades") return original(message);
      transport.requests.push(message);
      const params = message.params as Record<string, number>;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 200;
      return { user_trades_response: rows.slice(offset, offset + limit) };
    });
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    const since = "2026-09-19T00:00:00.000Z";
    const until = "2026-09-20T00:00:00.000Z";
    await expect(adapter.getAccountVolume({ since, until })).resolves.toEqual([
      { market: null, since, until, baseVolume: 200, quoteVolume: 2000 },
    ]);
    const requests = transport.requests.filter((message) => message.type === "get_user_trades");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ params: { limit: 200, offset: 0, start_ts: Date.parse(since), end_ts: Date.parse(until) } });
    expect(requests[1]).toMatchObject({ params: { limit: 200, offset: 200 } });
  });
  it("accepts the legacy user_trades envelope while filtering fills to the requested order", async () => {
    const transport = new FakeTransport();
    transport.userTrades = [
      { trade_id: "wanted", order_id: "order-1", symbol: "US500-USD", price: 100, quantity: 2, side: "BUY", timestamp: 1 },
      { trade_id: "other", order_id: "order-2", symbol: "US500-USD", price: 90, quantity: 1, side: "SELL", timestamp: 1 },
    ];
    const original = transport.request.bind(transport);
    transport.request = vi.fn(async (message: QfexMessage) => {
      if (message.type !== "get_user_trades") return original(message);
      return { user_trades: transport.userTrades };
    });
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    expect(await adapter.getOrderFills("order-1")).toMatchObject([{ tradeId: "wanted", exchangeOrderId: "order-1" }]);
  });
  it("uses a confirmed real-time fill when trade-history replay fails", async () => {
    const transport = new FakeTransport();
    const original = transport.request.bind(transport);
    transport.request = vi.fn(async (message: QfexMessage) => {
      if (message.type === "get_user_trades") throw new Error("history unavailable");
      return original(message);
    });
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    transport.emit({ fill_response: { trade_id: "cached", order_id: "order-1", symbol: "US500-USD", price: 100, quantity: 2, side: "BUY", timestamp: 1 } });
    await expect(adapter.getOrderFills("order-1")).resolves.toMatchObject([{ tradeId: "cached", exchangeOrderId: "order-1" }]);
  });
  it("deduplicates a fill confirmed by both real-time and history sources", async () => {
    const transport = new FakeTransport();
    const fill = { trade_id: "same", order_id: "order-1", symbol: "US500-USD", price: 100, quantity: 2, side: "BUY" as const, timestamp: 1 };
    transport.userTrades = [fill];
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    transport.emit({ fill_response: fill });
    const fills = await adapter.getOrderFills("order-1");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.tradeId).toBe("same");
  });
  it("resolves terminal fill and cancel evidence without querying history", async () => {
    const transport = new FakeTransport();
    const original = transport.request.bind(transport);
    transport.request = vi.fn(async (message: QfexMessage) => {
      if (message.type === "get_user_trades") throw new Error("history must not be queried");
      return original(message);
    });
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    await adapter.placeOrder({ market: "US500USD", side: "buy", type: "postOnly", size: 0.001, price: 5990, isReduceOnly: false, clientOrderId: "terminal-fill" });
    transport.emit({ fill_response: { trade_id: "terminal-trade", order_id: "o1", symbol: "US500-USD", price: 5990, quantity: 0.001, side: "BUY", timestamp: 1 } });
    transport.emit({ order_response: { order_id: "o1", client_order_id: "terminal-fill", symbol: "US500-USD", status: "FILLED", quantity: 0.001, quantity_remaining: 0, price: 5990, side: "BUY", type: "ALO" } });
    await expect(adapter.getOrderFills("o1")).resolves.toMatchObject([{ tradeId: "terminal-trade" }]);
    await adapter.placeOrder({ market: "US500USD", side: "buy", type: "postOnly", size: 0.001, price: 5990, isReduceOnly: false, clientOrderId: "terminal-cancel" });
    await adapter.cancelOrder("o1", "US500USD");
    await expect(adapter.getOrderFills("o1")).resolves.toMatchObject([{ tradeId: "terminal-trade" }]);
    expect(transport.requests.filter((message) => message.type === "get_user_trades")).toHaveLength(0);
  });
  it("fails closed when history replay fails without cached fill evidence", async () => {
    const transport = new FakeTransport();
    const original = transport.request.bind(transport);
    transport.request = vi.fn(async (message: QfexMessage) => {
      if (message.type === "get_user_trades") throw new Error("history unavailable");
      return original(message);
    });
    const adapter = new QfexAdapter(transport as never, [{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    await adapter.connect();
    await expect(adapter.getOrderFills("order-1")).rejects.toThrow(/history unavailable/);
  });
});
