import { describe, expect, it } from "vitest";
import { MarketRegistry } from "../../../src/adapters/n1/marketRegistry.js";
import {
  mapBalance,
  mapFill,
  mapMarginStatus,
  mapOpenOrder,
  mapPosition,
  orderTypeToFillMode,
  type N1CachedBalance,
  type N1CachedMargins,
  type N1CachedOrder,
  type N1CachedPosition,
} from "../../../src/adapters/n1/mappers.js";
import { FillMode, type TradeFromApi } from "@n1xyz/nord-ts";

function testRegistry(): MarketRegistry {
  const registry = new MarketRegistry([
    { symbol: "BTCUSD", exchangeSymbol: "BTCUSDC" },
    { symbol: "ETHUSD", exchangeSymbol: "ETHUSDC" },
  ]);
  registry.resolve([
    { marketId: 0, symbol: "BTCUSDC" },
    { marketId: 1, symbol: "ETHUSDC" },
  ]);
  return registry;
}

describe("mapPosition", () => {
  it("collapses isLong + baseSize into one signed number for a long position", () => {
    const raw: N1CachedPosition = {
      marketId: 0,
      openOrders: 2,
      actionId: 100,
      perp: {
        baseSize: 0.5,
        price: 60000,
        updatedFundingRateIndex: 1,
        fundingPaymentPnl: -1.5,
        sizePricePnl: 20,
        isLong: true,
      },
    };
    const position = mapPosition(raw, testRegistry());
    expect(position).toEqual({
      market: "BTCUSD",
      baseSize: 0.5,
      markPrice: 60000,
      unrealizedPnl: 18.5,
      openOrderCount: 2,
    });
  });

  it("collapses a short position into a negative baseSize", () => {
    const raw: N1CachedPosition = {
      marketId: 1,
      openOrders: 0,
      actionId: 101,
      perp: {
        baseSize: 2,
        price: 3000,
        updatedFundingRateIndex: 1,
        fundingPaymentPnl: 0,
        sizePricePnl: -5,
        isLong: false,
      },
    };
    const position = mapPosition(raw, testRegistry());
    expect(position?.baseSize).toBe(-2);
    expect(position?.unrealizedPnl).toBe(-5);
  });

  it("returns null when there is no perp sub-position", () => {
    const raw: N1CachedPosition = { marketId: 0, openOrders: 0, actionId: 1 };
    expect(mapPosition(raw, testRegistry())).toBeNull();
  });
});

describe("mapOpenOrder", () => {
  it("computes filledSize from originalOrderSize - remaining size, and omits unknown fields honestly", () => {
    const raw: N1CachedOrder = {
      orderId: 42,
      marketId: 0,
      side: "bid",
      size: 0.3, // remaining
      price: 59000,
      originalOrderSize: 0.5,
      clientOrderId: "7",
    };
    const order = mapOpenOrder(raw, testRegistry());
    expect(order.exchangeOrderId).toBe("42");
    expect(order.clientOrderId).toBe("7");
    expect(order.market).toBe("BTCUSD");
    expect(order.side).toBe("buy");
    expect(order.type).toBeUndefined();
    expect(order.filledSize).toBeCloseTo(0.2);
    expect(order.remainingSize).toBe(0.3);
    expect(order.isReduceOnly).toBe(false);
    expect(order.state).toBe("partiallyFilled");
  });

  it("reports state 'open' when nothing has filled yet", () => {
    const raw: N1CachedOrder = {
      orderId: 1,
      marketId: 1,
      side: "ask",
      size: 1,
      price: 3000,
      originalOrderSize: 1,
      clientOrderId: null,
    };
    const order = mapOpenOrder(raw, testRegistry());
    expect(order.side).toBe("sell");
    expect(order.clientOrderId).toBeUndefined();
    expect(order.state).toBe("open");
  });
});

describe("mapFill", () => {
  const baseTrade: TradeFromApi = {
    time: "2026-08-09T00:00:00Z",
    actionId: 1,
    tradeId: 555,
    takerId: 10,
    takerSide: "bid",
    makerId: 20,
    marketId: 0,
    marketMode: "clob",
    orderId: 42,
    price: 60000,
    baseSize: 0.1,
  };

  it("reports takerSide directly when our account was the taker", () => {
    const fill = mapFill(baseTrade, testRegistry(), 10);
    expect(fill.side).toBe("buy"); // takerSide "bid" -> buy
    expect(fill.tradeId).toBe("555");
    expect(fill.market).toBe("BTCUSD");
  });

  it("inverts takerSide when our account was the resting maker", () => {
    const fill = mapFill(baseTrade, testRegistry(), 20);
    // taker bought (bid) from our resting ask, so our side was sell
    expect(fill.side).toBe("sell");
  });
});

describe("mapBalance / mapMarginStatus", () => {
  it("maps balance fields directly", () => {
    const raw: N1CachedBalance = { accountId: 1, balance: 1234.5, symbol: "USDC" };
    expect(mapBalance(raw)).toEqual({ token: "USDC", amount: 1234.5 });
  });

  it("maps margin status fields to their normalized names", () => {
    const raw: N1CachedMargins = {
      omf: 1,
      mf: 2,
      imf: 3,
      cmf: 4,
      mmf: 5,
      pon: 6,
      pn: 7,
      bankruptcy: false,
    };
    expect(mapMarginStatus(raw)).toEqual({
      accountValue: 7,
      maintenanceMarginFraction: 5,
      initialMarginFraction: 3,
      isAtBankruptcyRisk: false,
    });
  });
});

describe("orderTypeToFillMode", () => {
  it("maps every OrderType to its FillMode", () => {
    expect(orderTypeToFillMode("limit")).toBe(FillMode.Limit);
    expect(orderTypeToFillMode("postOnly")).toBe(FillMode.PostOnly);
    expect(orderTypeToFillMode("immediateOrCancel")).toBe(FillMode.ImmediateOrCancel);
    expect(orderTypeToFillMode("fillOrKill")).toBe(FillMode.FillOrKill);
  });
});
