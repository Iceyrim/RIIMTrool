import { describe, expect, it } from "vitest";
import { ExchangeAdapterError } from "../../../src/adapters/AdapterError.js";
import { RiseXMarketRegistry } from "../../../src/adapters/risex/marketRegistry.js";
import type { RiseXMarket } from "../../../src/adapters/risex/RiseXMarketDataSource.js";

function market(overrides: Partial<RiseXMarket> = {}): RiseXMarket {
  return {
    marketId: 1,
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

const riseXMarkets = [
  market({ marketId: 1, symbol: "BTC/USDC" }),
  market({ marketId: 2, symbol: "ETH/USDC", stepPrice: 0.01, stepSize: 0.0001, minOrderSize: 0.001 }),
];

describe("RiseXMarketRegistry", () => {
  it("resolves configured logical symbols to RISEx marketIds and step config", () => {
    const registry = new RiseXMarketRegistry([
      { symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" },
      { symbol: "ETHUSD", exchangeSymbol: "ETH/USDC" },
    ]);
    registry.resolve(riseXMarkets);

    expect(registry.marketIdFor("BTCUSD")).toBe(1);
    expect(registry.marketIdFor("ETHUSD")).toBe(2);
    expect(registry.symbolFor(1)).toBe("BTCUSD");
    expect(registry.symbolFor(2)).toBe("ETHUSD");
    expect(registry.stepConfigFor("BTCUSD")).toEqual({
      stepSize: 0.000001,
      stepPrice: 0.1,
      minOrderSize: 0.0001,
    });
    expect(registry.stepConfigFor("ETHUSD")).toEqual({
      stepSize: 0.0001,
      stepPrice: 0.01,
      minOrderSize: 0.001,
    });
  });

  it("throws loudly at resolve() when a configured exchangeSymbol has no match", () => {
    const registry = new RiseXMarketRegistry([{ symbol: "SOLUSD", exchangeSymbol: "SOL/USDC" }]);
    expect(() => registry.resolve(riseXMarkets)).toThrow(ExchangeAdapterError);
    expect(() => registry.resolve(riseXMarkets)).toThrow(/SOL\/USDC/);
  });

  it("throws for an unknown symbol lookup after a successful resolve", () => {
    const registry = new RiseXMarketRegistry([{ symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" }]);
    registry.resolve(riseXMarkets);
    expect(() => registry.marketIdFor("ETHUSD")).toThrow(ExchangeAdapterError);
    expect(() => registry.symbolFor(2)).toThrow(ExchangeAdapterError);
    expect(() => registry.stepConfigFor("ETHUSD")).toThrow(ExchangeAdapterError);
  });
});
