import { describe, expect, it } from "vitest";
import {
  simulateFills,
  type SimulatedRestingOrder,
  type TradeTapePrint,
} from "../../../src/adapters/shared/paperFillSimulator.js";

function print(overrides: Partial<TradeTapePrint> = {}): TradeTapePrint {
  return { tradeId: "t1", price: 60000, size: 0.01, takerSide: "sell", timestamp: 1, ...overrides };
}

function order(overrides: Partial<SimulatedRestingOrder> = {}): SimulatedRestingOrder {
  return { exchangeOrderId: "e1", side: "buy", price: 60000, remainingSize: 0.01, ...overrides };
}

describe("simulateFills", () => {
  it("fully fills a resting bid when a taker sell prints at or below its price", () => {
    const fills = simulateFills([order()], [print({ takerSide: "sell", price: 60000 })]);
    expect(fills).toEqual([
      { exchangeOrderId: "e1", tradeId: "t1", price: 60000, size: 0.01, timestamp: 1 },
    ]);
  });

  it("fills a resting bid on a print BELOW its price (aggressive seller crossed through)", () => {
    const fills = simulateFills(
      [order({ price: 60000 })],
      [print({ takerSide: "sell", price: 59900 })],
    );
    expect(fills).toHaveLength(1);
    // Fill executes at OUR resting price, not the print's price — we're the passive maker.
    expect(fills[0]?.price).toBe(60000);
  });

  it("does not fill a resting bid when the print is above its price", () => {
    const fills = simulateFills(
      [order({ price: 60000 })],
      [print({ takerSide: "sell", price: 60100 })],
    );
    expect(fills).toHaveLength(0);
  });

  it("does not cross a resting bid against a taker BUY print (wrong side)", () => {
    const fills = simulateFills(
      [order({ side: "buy", price: 60000 })],
      [print({ takerSide: "buy", price: 60000 })],
    );
    expect(fills).toHaveLength(0);
  });

  it("fills a resting ask symmetrically against a taker buy", () => {
    const fills = simulateFills(
      [order({ side: "sell", price: 60100 })],
      [print({ takerSide: "buy", price: 60200 })],
    );
    expect(fills).toHaveLength(1);
    expect(fills[0]?.price).toBe(60100);
  });

  it("partially fills when the print is smaller than the resting order", () => {
    const fills = simulateFills([order({ remainingSize: 0.05 })], [print({ size: 0.02 })]);
    expect(fills).toEqual([
      { exchangeOrderId: "e1", tradeId: "t1", price: 60000, size: 0.02, timestamp: 1 },
    ]);
  });

  it("spills remaining print size across multiple eligible resting orders, best price first", () => {
    const orders = [
      order({ exchangeOrderId: "worse-bid", price: 59990, remainingSize: 0.01 }),
      order({ exchangeOrderId: "better-bid", price: 60000, remainingSize: 0.01 }),
    ];
    const fills = simulateFills(orders, [print({ price: 59990, size: 0.015 })]);
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ exchangeOrderId: "better-bid", tradeId: "t1", price: 60000 });
    expect(fills[0]?.size).toBeCloseTo(0.01);
    expect(fills[1]).toMatchObject({ exchangeOrderId: "worse-bid", tradeId: "t1", price: 59990 });
    expect(fills[1]?.size).toBeCloseTo(0.005);
  });

  it("applies multiple prints in order, exhausting an order's remaining size across them", () => {
    const fills = simulateFills(
      [order({ remainingSize: 0.03 })],
      [
        print({ tradeId: "t1", size: 0.01 }),
        print({ tradeId: "t2", size: 0.01 }),
        print({ tradeId: "t3", size: 0.01 }),
      ],
    );
    expect(fills.map((f) => f.tradeId)).toEqual(["t1", "t2", "t3"]);
    expect(fills.reduce((sum, f) => sum + f.size, 0)).toBeCloseTo(0.03);
  });

  it("stops matching an order once its remaining size is exhausted", () => {
    const fills = simulateFills(
      [order({ remainingSize: 0.01 })],
      [print({ tradeId: "t1", size: 0.01 }), print({ tradeId: "t2", size: 0.01 })],
    );
    expect(fills).toHaveLength(1);
    expect(fills[0]?.tradeId).toBe("t1");
  });
});
