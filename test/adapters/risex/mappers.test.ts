import { describe, expect, it } from "vitest";
import { mapRiseXMarketPrice, quantizeToStep } from "../../../src/adapters/risex/mappers.js";
import type { RiseXMarket } from "../../../src/adapters/risex/RiseXMarketDataSource.js";

describe("quantizeToStep", () => {
  it("rounds to the nearest multiple of step", () => {
    expect(quantizeToStep(60123.456, 0.1)).toBeCloseTo(60123.5);
    expect(quantizeToStep(60123.44, 0.1)).toBeCloseTo(60123.4);
    expect(quantizeToStep(0.0012345, 0.000001)).toBeCloseTo(0.001235);
  });

  it("leaves the value unchanged when step is zero or negative", () => {
    expect(quantizeToStep(60123.456, 0)).toBe(60123.456);
    expect(quantizeToStep(60123.456, -1)).toBe(60123.456);
  });
});

describe("mapRiseXMarketPrice", () => {
  it("carries mark and index price through", () => {
    const riseXMarket: RiseXMarket = {
      marketId: 1,
      symbol: "BTC/USDC",
      displayName: "BTC/USDC",
      markPrice: 60000,
      indexPrice: 59990,
      lastPrice: 60010,
      stepSize: 0.000001,
      stepPrice: 0.1,
      minOrderSize: 0.0001,
      maxLeverage: 20,
      active: true,
    };
    expect(mapRiseXMarketPrice("BTCUSD", riseXMarket)).toEqual({
      market: "BTCUSD",
      mark: 60000,
      index: 59990,
    });
  });
});
