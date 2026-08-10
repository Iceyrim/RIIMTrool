import type { MarketStats, TradeFromApi } from "@n1xyz/nord-ts";
import { beforeEach, describe, expect, it } from "vitest";
import { N1PaperAdapter } from "../../../src/adapters/n1/N1PaperAdapter.js";
import { FakeN1MarketDataSource } from "./fakeMarketDataSource.js";

const MARKET = "BTCUSD";
const MARKET_ID = 0;

function trade(overrides: Partial<TradeFromApi> = {}): TradeFromApi {
  return {
    time: new Date(2026, 0, 1).toISOString(),
    actionId: 1,
    tradeId: 1,
    takerId: 999,
    takerSide: "ask",
    makerId: 1,
    marketId: MARKET_ID,
    marketMode: "clob",
    orderId: 1,
    price: 60000,
    baseSize: 0.01,
    ...overrides,
  };
}

function stats(mark: number): MarketStats {
  return {
    volumeBase24h: 0,
    volumeQuote24h: 0,
    indexPrice: mark,
    perpStats: {
      mark_price: mark,
      aggregated_funding_index: 0,
      funding_rate: 0,
      next_funding_time: new Date().toISOString(),
      open_interest: 0,
    },
  };
}

describe("N1PaperAdapter", () => {
  let marketData: FakeN1MarketDataSource;
  let adapter: N1PaperAdapter;

  beforeEach(async () => {
    marketData = new FakeN1MarketDataSource();
    marketData.markets = [{ marketId: MARKET_ID, symbol: "BTCUSDC" }];
    marketData.statsByMarketId.set(MARKET_ID, stats(60000));
    marketData.tradesByMarketId.set(MARKET_ID, []);
    adapter = new N1PaperAdapter(marketData, {
      markets: [{ symbol: MARKET, exchangeSymbol: "BTCUSDC" }],
      startingBalanceUsdc: 10_000,
    });
    await adapter.connect();
  });

  it("seeds the starting USDC balance and resolves configured markets", () => {
    expect(adapter.getBalances()).toEqual([{ token: "USDC", amount: 10_000 }]);
  });

  it("placeOrder() rests the order and never touches the real exchange (fully in-memory)", async () => {
    const result = await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "postOnly",
      size: 0.01,
      price: 59000,
      isReduceOnly: false,
    });
    expect(result.success).toBe(true);
    expect(adapter.getOpenOrders(MARKET)).toHaveLength(1);
    expect(adapter.getOpenOrders(MARKET)[0]?.state).toBe("open");
  });

  it("does not retroactively fill a freshly placed order against trades that predate it", async () => {
    // Historical trade already on the tape before the order exists, at a crossing price.
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ tradeId: 1, price: 59000, takerSide: "ask" }),
    ]);

    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "postOnly",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    await adapter.refreshAccountState();

    expect(adapter.getOpenOrders(MARKET)[0]?.state).toBe("open");
    expect(adapter.getOpenOrders(MARKET)[0]?.filledSize).toBe(0);
  });

  it("fills a resting order via refreshAccountState() when a new crossing trade appears on the tape", async () => {
    const placeResult = await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "postOnly",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    if (!placeResult.success) throw new Error("expected placeOrder to succeed");
    const exchangeOrderId = placeResult.order.exchangeOrderId;

    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ tradeId: 1, price: 60000, baseSize: 0.01, takerSide: "ask" }),
    ]);
    await adapter.refreshAccountState();

    expect(adapter.getOpenOrders(MARKET)).toHaveLength(0); // fully filled, no longer resting
    const fills = await adapter.getOrderFills(exchangeOrderId, MARKET);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.size).toBe(0.01);

    const positions = adapter.getPositions(MARKET);
    expect(positions[0]?.baseSize).toBe(0.01);
    expect(adapter.getBalances()[0]?.amount).toBeCloseTo(10_000 - 0.01 * 60000);
  });

  it("leaves a partially filled order resting with a reduced remaining size", async () => {
    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "postOnly",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ tradeId: 1, price: 60000, baseSize: 0.004, takerSide: "ask" }),
    ]);
    await adapter.refreshAccountState();

    const openOrders = adapter.getOpenOrders(MARKET);
    expect(openOrders).toHaveLength(1);
    expect(openOrders[0]?.state).toBe("partiallyFilled");
    expect(openOrders[0]?.remainingSize).toBeCloseTo(0.006);
  });

  it("cancelOrder() honors a fill that happened in the same instant before removing the order (SPEC 5a exercised in paper mode)", async () => {
    const placeResult = await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "postOnly",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    if (!placeResult.success) throw new Error("expected placeOrder to succeed");
    const exchangeOrderId = placeResult.order.exchangeOrderId;

    // A fill lands on the tape but refreshAccountState() hasn't been called yet — simulating the
    // real race window between "we decided to cancel" and "a fill may have already happened."
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ tradeId: 1, price: 60000, baseSize: 0.01, takerSide: "ask" }),
    ]);

    await adapter.cancelOrder(exchangeOrderId, MARKET);

    const fills = await adapter.getOrderFills(exchangeOrderId, MARKET);
    expect(fills).toHaveLength(1); // the fill was discovered, not lost
    expect(adapter.getOpenOrders(MARKET)).toHaveLength(0);
  });

  it("tracks realized PnL via average-cost accounting when a position is closed at a profit", async () => {
    // Open long 0.01 @ 60000
    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "postOnly",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ tradeId: 1, price: 60000, baseSize: 0.01, takerSide: "ask" }),
    ]);
    await adapter.refreshAccountState();

    // Close it by selling 0.01 @ 61000 (1000/BTC profit * 0.01 = 10 USD)
    await adapter.placeOrder({
      market: MARKET,
      side: "sell",
      type: "postOnly",
      size: 0.01,
      price: 61000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ tradeId: 1, price: 60000, baseSize: 0.01, takerSide: "ask" }),
      trade({ tradeId: 2, price: 61000, baseSize: 0.01, takerSide: "bid" }),
    ]);
    await adapter.refreshAccountState();

    expect(adapter.getPositions(MARKET)[0]?.baseSize ?? 0).toBe(0);
    expect(adapter.drainRealizedPnlDeltaUsd(MARKET)).toBeCloseTo(10);
    expect(adapter.drainRealizedPnlDeltaUsd(MARKET)).toBe(0); // drained, resets to zero
  });

  it("keeps realized PnL isolated per market when one adapter instance is shared across markets (SPEC 4.3 shared account)", async () => {
    const ETH_MARKET_ID = 1;
    marketData.markets = [
      { marketId: MARKET_ID, symbol: "BTCUSDC" },
      { marketId: ETH_MARKET_ID, symbol: "ETHUSDC" },
    ];
    marketData.statsByMarketId.set(ETH_MARKET_ID, stats(3000));
    marketData.tradesByMarketId.set(ETH_MARKET_ID, []);

    const sharedAdapter = new N1PaperAdapter(marketData, {
      markets: [
        { symbol: "BTCUSD", exchangeSymbol: "BTCUSDC" },
        { symbol: "ETHUSD", exchangeSymbol: "ETHUSDC" },
      ],
      startingBalanceUsdc: 10_000,
    });
    await sharedAdapter.connect();

    // Realize a profit on BTCUSD only; ETHUSD never trades.
    await sharedAdapter.placeOrder({
      market: "BTCUSD",
      side: "buy",
      type: "postOnly",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ tradeId: 1, price: 60000, baseSize: 0.01, takerSide: "ask" }),
    ]);
    await sharedAdapter.refreshAccountState();
    await sharedAdapter.placeOrder({
      market: "BTCUSD",
      side: "sell",
      type: "postOnly",
      size: 0.01,
      price: 61000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ tradeId: 1, price: 60000, baseSize: 0.01, takerSide: "ask" }),
      trade({ tradeId: 2, price: 61000, baseSize: 0.01, takerSide: "bid" }),
    ]);
    await sharedAdapter.refreshAccountState();

    // Draining ETHUSD first must NOT steal BTCUSD's realized PnL.
    expect(sharedAdapter.drainRealizedPnlDeltaUsd("ETHUSD")).toBe(0);
    expect(sharedAdapter.drainRealizedPnlDeltaUsd("BTCUSD")).toBeCloseTo(10);
  });

  it("getMarketPrice() pulls the real configured mark price and caches it for position mark-to-market", async () => {
    const price = await adapter.getMarketPrice(MARKET);
    expect(price.mark).toBe(60000);

    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "postOnly",
      size: 0.01,
      price: 59000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ tradeId: 1, price: 59000, baseSize: 0.01, takerSide: "ask" }),
    ]);
    await adapter.refreshAccountState();

    marketData.statsByMarketId.set(MARKET_ID, stats(60000));
    await adapter.getMarketPrice(MARKET);
    const position = adapter.getPositions(MARKET)[0];
    expect(position?.unrealizedPnl).toBeCloseTo((60000 - 59000) * 0.01);
  });
});
