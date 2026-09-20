import { describe, expect, it } from "vitest";
import { QfexMarketRegistry } from "../../../src/adapters/qfex/QfexMarketRegistry.js";

describe("QfexMarketRegistry", () => {
  it("maps logical and exchange symbols without guessing", () => {
    const registry = new QfexMarketRegistry([{ symbol: "US500USD", exchangeSymbol: "US500-USD", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }]);
    expect(registry.exchangeSymbolFor("US500USD")).toBe("US500-USD");
    expect(registry.logicalSymbolFor("US500-USD")).toBe("US500USD");
    expect(() => registry.exchangeSymbolFor("UNKNOWN")).toThrow(/Unknown QFEX/);
  });
  it("rejects ambiguous mappings", () => {
    expect(() => new QfexMarketRegistry([{ symbol: "A", exchangeSymbol: "X", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }, { symbol: "A", exchangeSymbol: "Y", priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.001 }])).toThrow(/Duplicate/);
  });
});
