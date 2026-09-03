import { describe, expect, it, vi } from "vitest";
import { RiseXSessionAdapter } from "../../../src/adapters/risex/RiseXSessionAdapter.js";
import { FakeRiseXMarketDataSource } from "./fakeMarketDataSource.js";

const account = "0x0000000000000000000000000000000000000002";
const envelope = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
const summary = { total_account_value: "51", usdc_balance: "50", collateral_margin_balance: "50", cross_margin_balance: "50", free_collateral: "45", total_unrealized_pnl: "1", realized_pnl: "0", total_initial_margin: "5", total_maintenance_margin: "2", margin_usage: "0.1", margin_health: "0.9", account_leverage: "2", in_liquidation: false, risk_level: "NORMAL", total_notional: "10", unsettled_usdc: "0", total_isolated_order_reserve: "0" };

function marketData() {
  const source = new FakeRiseXMarketDataSource();
  source.markets = [{ marketId: 1, symbol: "BTC/USDC", displayName: "BTC/USDC", markPrice: 60_000, indexPrice: 60_001, lastPrice: 60_000, stepSize: 0.001, stepPrice: 0.1, minOrderSize: 0.001, maxLeverage: 50, active: true }];
  return source;
}

describe("RISEx session adapter", () => {
  it("refreshes authoritative account state and cancellation identities without authentication", async () => {
    const execution = { connect: vi.fn(), disconnect: vi.fn(), seedOpenOrderIdentities: vi.fn(), placeOrder: vi.fn(), cancelOrder: vi.fn() };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(envelope({ account, summary, positions: [{ market_id: "1", market_name: "BTC", size: "0.002", side: 0, margin_mode: 0, avg_entry_price: "59000", mark_price: "60000", index_price: "60001", leverage: "2", unrealized_pnl: "2", liquidation_price: "40000", initial_margin_requirement: "5", maintenance_margin_requirement: "2" }] }))
      .mockResolvedValueOnce(envelope({ orders: [{ order_id: "0xwide-7", wide_order_id: "7", resting_order_id: "99", market_id: 1, account, side: 1, size_steps: 2, price_ticks: 601000, order_type: 1, time_in_force: 0, post_only: true, reduce_only: false, client_order_id: "42" }], market_id: "1", account, total_orders: "1" })) as unknown as typeof fetch;
    const adapter = new RiseXSessionAdapter(marketData(), execution as never, { baseUrl: "https://offline.invalid", account, markets: [{ symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" }], fetchImpl });
    await adapter.connect();
    expect(adapter.getBalances()).toEqual([{ token: "USDC", amount: 50 }]);
    expect(adapter.getPositions("BTCUSD")[0]).toMatchObject({ baseSize: 0.002, openOrderCount: 1 });
    expect(adapter.getOpenOrders()[0]).toMatchObject({ exchangeOrderId: "0xwide-7", price: 60100, size: 0.002 });
    expect(execution.seedOpenOrderIdentities).toHaveBeenCalledWith([{ exchangeOrderId: "0xwide-7", restingOrderId: "99" }]);
  });

  it("keeps mutation disabled when constructed for read-only preflight", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(envelope({ account, summary, positions: [] }))
      .mockResolvedValueOnce(envelope({ orders: [], market_id: "0", account, total_orders: "0" })) as unknown as typeof fetch;
    const adapter = new RiseXSessionAdapter(marketData(), undefined, { baseUrl: "https://offline.invalid", account, markets: [{ symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" }], fetchImpl });
    await adapter.connect();
    await expect(adapter.placeOrder({ market: "BTCUSD", side: "buy", type: "postOnly", price: 59_000, size: 0.001, isReduceOnly: false })).resolves.toMatchObject({ success: false, reason: "REJECTED" });
    await expect(adapter.cancelOrder("x", "BTCUSD")).rejects.toThrow(/not armed/);
  });

  it("ignores flat unconfigured portfolio rows but rejects hidden exposure", async () => {
    const position = (size: string) => ({ market_id: "9", market_name: "OTHER", size, side: 0, margin_mode: 0, avg_entry_price: "1", mark_price: "1", index_price: "1", leverage: "1", unrealized_pnl: "0", liquidation_price: "0", initial_margin_requirement: "0", maintenance_margin_requirement: "0" });
    const open = { orders: [], market_id: "0", account, total_orders: "0" };
    const flatFetch = vi.fn().mockResolvedValueOnce(envelope({ account, summary, positions: [position("0")] })).mockResolvedValueOnce(envelope(open)) as unknown as typeof fetch;
    const flat = new RiseXSessionAdapter(marketData(), undefined, { baseUrl: "https://offline.invalid", account, markets: [{ symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" }], fetchImpl: flatFetch });
    await expect(flat.connect()).resolves.toBeUndefined();
    expect(flat.getPositions()).toEqual([]);
    const exposedFetch = vi.fn().mockResolvedValueOnce(envelope({ account, summary, positions: [position("2")] })).mockResolvedValueOnce(envelope(open)) as unknown as typeof fetch;
    const exposed = new RiseXSessionAdapter(marketData(), undefined, { baseUrl: "https://offline.invalid", account, markets: [{ symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" }], fetchImpl: exposedFetch });
    await expect(exposed.connect()).rejects.toThrow(/non-zero exposure 2 on unconfigured marketId 9/);
  });

  it("fetches bounded volume windows once, isolates all-time failure, and deduplicates fills", async () => {
    const time = String(BigInt(Date.parse("2026-09-03T00:00:00.000Z")) * 1_000_000n);
    const trade = { id: "fill-1", market_id: 1, order_id: "order", side: "BUY", price: "100", size: "2", fee: "0", liquidity_indicator: "MAKER", time };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(envelope({ account, summary, positions: [] }))
      .mockResolvedValueOnce(envelope({ orders: [], market_id: "0", account, total_orders: "0" }))
      .mockResolvedValueOnce(envelope({ market_id: 1, wallet_address: account, page: 1, has_next_page: false, trades: [trade, trade] }))
      .mockResolvedValueOnce(new Response("failed", { status: 503 })) as unknown as typeof fetch;
    const adapter = new RiseXSessionAdapter(marketData(), undefined, { baseUrl: "https://offline.invalid", account, markets: [{ symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" }], fetchImpl });
    await adapter.connect();
    const result = await adapter.getAccountVolumeWindows([
      { window: "24h", since: "2026-09-02T12:00:00.000Z", until: "2026-09-03T12:00:00.000Z" },
      { window: "7d", since: "2026-08-27T12:00:00.000Z", until: "2026-09-03T12:00:00.000Z" },
      { window: "30d", since: "2026-08-04T12:00:00.000Z", until: "2026-09-03T12:00:00.000Z" },
      { window: "allTime", since: "1970-01-01T00:00:00.000Z", until: "2026-09-03T12:00:00.000Z" },
    ]);
    await expect(adapter.getAccountVolume({ since: "1970-01-01T00:00:00.000Z", until: "2026-09-03T12:00:00.000Z" })).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result["24h"]?.[0]).toMatchObject({ baseVolume: 2, quoteVolume: 200 });
    expect(result["7d"]?.[0]).toMatchObject({ quoteVolume: 200 });
    expect(result["30d"]?.[0]).toMatchObject({ quoteVolume: 200 });
    expect(result.allTime).toBeUndefined();
  });
});
