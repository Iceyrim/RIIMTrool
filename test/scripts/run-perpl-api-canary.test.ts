import { describe, expect, it } from "vitest";
import { passiveBtcBuyPrice } from "../../scripts/run-perpl-api-canary.js";

describe("Perpl API canary", () => {
  it("chooses a tick-aligned buy two tenths of a percent below the observed bid", () => {
    const price = passiveBtcBuyPrice(77_734.5);
    expect(price).toBe(77_579);
    expect(price).toBeLessThan(77_734.5);
    expect(price * 0.00018).toBeLessThan(15);
  });
  it("rejects invalid book evidence", () => {
    expect(() => passiveBtcBuyPrice(0)).toThrow(/invalid/);
  });
});
