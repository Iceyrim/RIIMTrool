import { describe, expect, it, vi } from "vitest";
import { normalizeQfexOrder, QfexAdapter } from "../../../src/adapters/qfex/QfexAdapter.js";
import type { QfexMessage } from "../../../src/adapters/qfex/types.js";

class FakeTransport {
  listeners: Array<(message: QfexMessage) => void> = [];
  requests: QfexMessage[] = [];
  onMessage(listener: (message: QfexMessage) => void) { this.listeners.push(listener); return () => undefined; }
  emit(message: QfexMessage) { for (const listener of this.listeners) listener(message); }
  async connect() {
    this.emit({ type: "mark_price", symbol: "US500-USD", price: "6000" });
    this.emit({ balance_response: { deposit: 100, realised_pnl: 0, order_margin: 0, position_margin: 0, unrealised_pnl: 0, net_funding: 0, available_balance: 100, fees: 0 } });
    this.emit({ position_response: { symbol: "US500-USD", position: 0, realised_pnl: 0, unrealised_pnl: 0, open_orders: 0, initial_margin: 0.05, maintenance_margin: 0.03, leverage: 1 } });
  }
  async disconnect() {}
  async request(message: QfexMessage) {
    this.requests.push(message);
    if (message.type === "get_user_orders") return { all_orders_response: { orders: [] } };
    if (message.type === "add_order") {
      const params = message.params as Record<string, unknown>;
      return { order_response: { order_id: "o1", client_order_id: params.client_order_id, symbol: "US500-USD", status: "ACK", quantity: 0.001, quantity_remaining: 0.001, price: 5990, side: "BUY", type: "ALO" } };
    }
    if (message.type === "cancel_order") return { order_response: { order_id: "o1", symbol: "US500-USD", status: "CANCELLED", quantity: 0.001, quantity_remaining: 0.001, price: 5990, side: "BUY", type: "ALO" } };
    return { user_trades: [] };
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
});
