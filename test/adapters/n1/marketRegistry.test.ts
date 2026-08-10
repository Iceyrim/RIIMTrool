import { describe, expect, it } from "vitest";
import { MarketRegistry } from "../../../src/adapters/n1/marketRegistry.js";
import { ExchangeAdapterError } from "../../../src/adapters/AdapterError.js";

const nordMarkets = [
  { marketId: 0, symbol: "BTCUSDC" },
  { marketId: 1, symbol: "ETHUSDC" },
];

describe("MarketRegistry", () => {
  it("resolves configured logical symbols to N1 marketIds", () => {
    const registry = new MarketRegistry([
      { symbol: "BTCUSD", exchangeSymbol: "BTCUSDC" },
      { symbol: "ETHUSD", exchangeSymbol: "ETHUSDC" },
    ]);
    registry.resolve(nordMarkets);

    expect(registry.marketIdFor("BTCUSD")).toBe(0);
    expect(registry.marketIdFor("ETHUSD")).toBe(1);
    expect(registry.symbolFor(0)).toBe("BTCUSD");
    expect(registry.symbolFor(1)).toBe("ETHUSD");
  });

  it("throws loudly at resolve() when a configured exchangeSymbol has no match", () => {
    const registry = new MarketRegistry([{ symbol: "SOLUSD", exchangeSymbol: "SOLUSDC" }]);
    expect(() => registry.resolve(nordMarkets)).toThrow(ExchangeAdapterError);
    expect(() => registry.resolve(nordMarkets)).toThrow(/SOLUSDC/);
  });

  it("throws for an unknown symbol lookup after a successful resolve", () => {
    const registry = new MarketRegistry([{ symbol: "BTCUSD", exchangeSymbol: "BTCUSDC" }]);
    registry.resolve(nordMarkets);
    expect(() => registry.marketIdFor("ETHUSD")).toThrow(ExchangeAdapterError);
    expect(() => registry.symbolFor(1)).toThrow(ExchangeAdapterError);
  });
});
