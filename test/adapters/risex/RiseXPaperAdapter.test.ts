import { beforeEach, describe, expect, it } from "vitest";
import { RiseXPaperAdapter } from "../../../src/adapters/risex/RiseXPaperAdapter.js";
import type {
  RiseXFundingRecord,
  RiseXMarket,
  RiseXTrade,
} from "../../../src/adapters/risex/RiseXMarketDataSource.js";
import { FakeRiseXMarketDataSource } from "./fakeMarketDataSource.js";

const MARKET = "BTCUSD";
const MARKET_ID = 1;

function riseXMarket(overrides: Partial<RiseXMarket> = {}): RiseXMarket {
  return {
    marketId: MARKET_ID,
    symbol: "BTC/USDC",
    displayName: "BTC/USDC",
    markPrice: 60000,
    indexPrice: 60000,
    lastPrice: 60000,
    stepSize: 0.000001,
    stepPrice: 0.1,
    minOrderSize: 0.0001,
    maxLeverage: 20,
    active: true,
    ...overrides,
  };
}

function trade(overrides: Partial<RiseXTrade> = {}): RiseXTrade {
  return { id: "t1", takerSide: "sell", price: 60000, size: 0.01, timestamp: 1000, ...overrides };
}

function fundingRecord(overrides: Partial<RiseXFundingRecord> = {}): RiseXFundingRecord {
  return {
    fundingRate: 0.0001,
    accumulatedFunding: 0,
    indexPrice: 60000,
    startTime: 0,
    endTime: 1000,
    ...overrides,
  };
}

describe("RiseXPaperAdapter", () => {
  let marketData: FakeRiseXMarketDataSource;
  let adapter: RiseXPaperAdapter;

  beforeEach(async () => {
    marketData = new FakeRiseXMarketDataSource();
    marketData.markets = [riseXMarket()];
    marketData.tradesByMarketId.set(MARKET_ID, []);
    marketData.fundingByMarketId.set(MARKET_ID, []);
    adapter = new RiseXPaperAdapter(marketData, {
      markets: [{ symbol: MARKET, exchangeSymbol: "BTC/USDC" }],
      startingBalanceUsdc: 10_000,
    });
    await adapter.connect();
  });

  it("seeds the starting USDC balance and resolves configured markets", () => {
    expect(adapter.getBalances()).toEqual([{ token: "USDC", amount: 10_000 }]);
  });

  it("placeOrder() quantizes price/size to the market's real step grid before resting", async () => {
    const result = await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "limit",
      size: 0.0100004, // not an exact multiple of stepSize 0.000001
      price: 59000.03, // not an exact multiple of stepPrice 0.1
      isReduceOnly: false,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.order.size).toBeCloseTo(0.01);
    expect(result.order.price).toBeCloseTo(59000);
    expect(adapter.getOpenOrders(MARKET)).toHaveLength(1);
  });

  it("placeOrder() rejects an order that quantizes below minOrderSize, never resting it", async () => {
    const result = await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "limit",
      size: 0.00002, // quantizes to 0.00002, below minOrderSize 0.0001
      price: 59000,
      isReduceOnly: false,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected rejection");
    expect(result.reason).toBe("REJECTED");
    expect(adapter.getOpenOrders(MARKET)).toHaveLength(0);
  });

  it("does not retroactively fill a freshly placed order against trades that predate it", async () => {
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ id: "pre-existing", timestamp: 500, price: 59000, takerSide: "sell" }),
    ]);

    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "limit",
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
      type: "limit",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    if (!placeResult.success) throw new Error("expected placeOrder to succeed");
    const exchangeOrderId = placeResult.order.exchangeOrderId;

    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ id: "fill-1", timestamp: 2000, price: 60000, size: 0.01, takerSide: "sell" }),
    ]);
    await adapter.refreshAccountState();

    expect(adapter.getOpenOrders(MARKET)).toHaveLength(0); // fully filled, no longer resting
    const fills = await adapter.getOrderFills(exchangeOrderId, MARKET);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.size).toBe(0.01);

    const positions = adapter.getPositions(MARKET);
    expect(positions[0]?.baseSize).toBeCloseTo(0.01);
    expect(adapter.getBalances()[0]?.amount).toBeCloseTo(10_000 - 0.01 * 60000);
  });

  it("does not reprocess a trade sitting exactly at the cursor boundary on the next cycle", async () => {
    // Placed against an empty tape, so priming sets the cursor to timestamp 0 — the trade below
    // is added only afterward, mirroring how a real fill would arrive after order placement.
    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "limit",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ id: "fill-1", timestamp: 2000, price: 60000, size: 0.005, takerSide: "sell" }),
    ]);
    await adapter.refreshAccountState(); // cursor advances to timestamp 2000, id "fill-1" seen
    await adapter.refreshAccountState(); // must not reprocess "fill-1" again

    const openOrders = adapter.getOpenOrders(MARKET);
    expect(openOrders[0]?.remainingSize).toBeCloseTo(0.005); // only ONE partial fill applied
  });

  it("leaves a partially filled order resting with a reduced remaining size", async () => {
    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "limit",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ id: "fill-1", timestamp: 2000, price: 60000, size: 0.004, takerSide: "sell" }),
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
      type: "limit",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    if (!placeResult.success) throw new Error("expected placeOrder to succeed");
    const exchangeOrderId = placeResult.order.exchangeOrderId;

    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ id: "fill-1", timestamp: 2000, price: 60000, size: 0.01, takerSide: "sell" }),
    ]);

    await adapter.cancelOrder(exchangeOrderId, MARKET);

    const fills = await adapter.getOrderFills(exchangeOrderId, MARKET);
    expect(fills).toHaveLength(1); // the fill was discovered, not lost
    expect(adapter.getOpenOrders(MARKET)).toHaveLength(0);
  });

  it("tracks realized PnL via average-cost accounting when a position is closed at a profit", async () => {
    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "limit",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ id: "fill-1", timestamp: 2000, price: 60000, size: 0.01, takerSide: "sell" }),
    ]);
    await adapter.refreshAccountState();

    await adapter.placeOrder({
      market: MARKET,
      side: "sell",
      type: "limit",
      size: 0.01,
      price: 61000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ id: "fill-1", timestamp: 2000, price: 60000, size: 0.01, takerSide: "sell" }),
      trade({ id: "fill-2", timestamp: 3000, price: 61000, size: 0.01, takerSide: "buy" }),
    ]);
    await adapter.refreshAccountState();

    expect(adapter.getPositions(MARKET)[0]?.baseSize ?? 0).toBeCloseTo(0);
    expect(adapter.drainRealizedPnlDeltaUsd(MARKET)).toBeCloseTo(10);
    expect(adapter.drainRealizedPnlDeltaUsd(MARKET)).toBe(0); // drained, resets to zero
  });

  it("cash-settles real RISEx funding history against the balance while a position is open", async () => {
    // Open a 0.01 long.
    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "limit",
      size: 0.01,
      price: 60000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ id: "fill-1", timestamp: 2000, price: 60000, size: 0.01, takerSide: "sell" }),
    ]);
    await adapter.refreshAccountState();
    const balanceAfterOpen = adapter.getBalances()[0]!.amount;

    // A new funding record closes: positive rate means our long pays.
    marketData.fundingByMarketId.set(MARKET_ID, [
      fundingRecord({ fundingRate: 0.0001, indexPrice: 60000, startTime: 0, endTime: 5000 }),
    ]);
    await adapter.refreshAccountState();

    const expectedFundingPaymentUsd = -0.01 * 60000 * 0.0001; // -0.06
    expect(adapter.getBalances()[0]?.amount).toBeCloseTo(balanceAfterOpen + expectedFundingPaymentUsd);
    expect(adapter.drainRealizedPnlDeltaUsd(MARKET)).toBeCloseTo(expectedFundingPaymentUsd);

    // Same funding record must not be applied twice on the next cycle.
    const balanceAfterFunding = adapter.getBalances()[0]!.amount;
    await adapter.refreshAccountState();
    expect(adapter.getBalances()[0]?.amount).toBeCloseTo(balanceAfterFunding);
  });

  it("getMarketPrice() pulls the real configured mark price and caches it for position mark-to-market", async () => {
    const price = await adapter.getMarketPrice(MARKET);
    expect(price.mark).toBe(60000);

    await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "limit",
      size: 0.01,
      price: 59000,
      isReduceOnly: false,
    });
    marketData.tradesByMarketId.set(MARKET_ID, [
      trade({ id: "fill-1", timestamp: 2000, price: 59000, size: 0.01, takerSide: "sell" }),
    ]);
    await adapter.refreshAccountState();

    marketData.markets = [riseXMarket({ markPrice: 60000, indexPrice: 60000 })];
    await adapter.getMarketPrice(MARKET);
    const position = adapter.getPositions(MARKET)[0];
    expect(position?.unrealizedPnl).toBeCloseTo((60000 - 59000) * 0.01);
  });
});
