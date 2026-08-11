import { describe, expect, it } from "vitest";
import {
  fromSteps,
  fromTicks,
  mapRiseXOrderType,
  orderSideToRiseXSide,
  orderTypeToRiseXFields,
  riseXSideToOrderSide,
  scaledIntToNumber,
  toSteps,
  toTicks,
  wadToNumber,
} from "../../../src/adapters/risex/riseXAuthMappers.js";

describe("wadToNumber", () => {
  it("converts a whole WAD integer string exactly", () => {
    expect(wadToNumber("5000000000000000000")).toBe(5);
  });

  it("converts a fractional WAD integer string without precision loss", () => {
    expect(wadToNumber("1500000000000000000")).toBe(1.5);
  });

  it("handles negative WAD values", () => {
    expect(wadToNumber("-1500000000000000000")).toBe(-1.5);
  });

  it("handles zero", () => {
    expect(wadToNumber("0")).toBe(0);
  });

  it("stays precise for a large whole-number amount that would round under plain Number()", () => {
    // 12345678901234 (14 digits) is well within Number.MAX_SAFE_INTEGER, but the raw WAD string
    // (that value * 1e18) is far past it — this is the exact case plain Number(wad) would corrupt.
    const wad = "12345678901234000000000000000000";
    expect(wadToNumber(wad)).toBe(12345678901234);
  });
});

describe("scaledIntToNumber", () => {
  it("converts an 18-decimal string", () => {
    expect(scaledIntToNumber("2500000000000000000", 18)).toBe(2.5);
  });

  it("converts a 6-decimal string (native USDC convention)", () => {
    expect(scaledIntToNumber("2500000", 6)).toBe(2.5);
  });

  it("converts with 0 decimals", () => {
    expect(scaledIntToNumber("42", 0)).toBe(42);
  });
});

describe("toTicks / fromTicks / toSteps / fromSteps", () => {
  it("round-trips a price through the tick grid", () => {
    const ticks = toTicks(63895.6, 0.1);
    expect(ticks).toBe(638956);
    expect(fromTicks(ticks, 0.1)).toBeCloseTo(63895.6, 6);
  });

  it("round-trips a size through the step grid", () => {
    const steps = toSteps(0.00155, 0.000001);
    expect(steps).toBe(1550);
    expect(fromSteps(steps, 0.000001)).toBeCloseTo(0.00155, 9);
  });

  it("rounds to the nearest tick rather than truncating", () => {
    expect(toTicks(63895.66, 0.1)).toBe(638957); // 638956.6 rounds up
  });
});

describe("orderSideToRiseXSide / riseXSideToOrderSide", () => {
  it("round-trips buy", () => {
    expect(riseXSideToOrderSide(orderSideToRiseXSide("buy"))).toBe("buy");
  });

  it("round-trips sell", () => {
    expect(riseXSideToOrderSide(orderSideToRiseXSide("sell"))).toBe("sell");
  });

  it("maps buy to RISEx's Buy=0 and sell to Sell=1", () => {
    expect(orderSideToRiseXSide("buy")).toBe(0);
    expect(orderSideToRiseXSide("sell")).toBe(1);
  });
});

describe("orderTypeToRiseXFields / mapRiseXOrderType round trip", () => {
  const cases: Array<Parameters<typeof orderTypeToRiseXFields>[0]> = [
    "limit",
    "postOnly",
    "immediateOrCancel",
    "fillOrKill",
  ];

  for (const type of cases) {
    it(`round-trips "${type}" through RISEx's order_type/time_in_force/post_only fields`, () => {
      const fields = orderTypeToRiseXFields(type);
      expect(mapRiseXOrderType(fields.order_type, fields.time_in_force, fields.post_only)).toBe(type);
    });
  }

  it("never produces RISEx's Market order_type (v1 scope is always priced Limit)", () => {
    for (const type of cases) {
      expect(orderTypeToRiseXFields(type).order_type).toBe(1); // Limit
    }
  });

  it("returns undefined for a GTT-timed order this adapter never produces", () => {
    expect(mapRiseXOrderType(1, 1, false)).toBeUndefined();
  });

  it("returns undefined for RISEx's Market order_type", () => {
    expect(mapRiseXOrderType(0, 0, false)).toBeUndefined();
  });
});
