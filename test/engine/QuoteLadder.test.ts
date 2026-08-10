import { describe, expect, it } from "vitest";
import { generateQuoteLadder, pickOrderSize } from "../../src/engine/QuoteLadder.js";

describe("generateQuoteLadder", () => {
  it("produces one bid + one ask per spacing value, symmetric around the reservation price", () => {
    const levels = generateQuoteLadder({
      reservationPrice: 60000,
      levelSpacingBps: [2, 3, 4, 7, 10],
      sizePerLevel: 0.002,
    });

    expect(levels).toHaveLength(10);
    const bids = levels.filter((l) => l.side === "buy");
    const asks = levels.filter((l) => l.side === "sell");
    expect(bids).toHaveLength(5);
    expect(asks).toHaveLength(5);

    // 2bps level
    expect(bids[0]?.price).toBeCloseTo(60000 - 60000 * (2 / 10_000));
    expect(asks[0]?.price).toBeCloseTo(60000 + 60000 * (2 / 10_000));
  });

  it("uses equal size across every level, not growing size at outer levels", () => {
    const levels = generateQuoteLadder({
      reservationPrice: 60000,
      levelSpacingBps: [2, 3, 4, 7, 10],
      sizePerLevel: 0.002,
    });
    expect(levels.every((l) => l.size === 0.002)).toBe(true);
  });
});

describe("pickOrderSize", () => {
  it("returns a value within the configured [min, max] range", () => {
    for (let i = 0; i < 50; i++) {
      const size = pickOrderSize({ min: 0.00155, max: 0.00232 });
      expect(size).toBeGreaterThanOrEqual(0.00155);
      expect(size).toBeLessThanOrEqual(0.00232);
    }
  });
});
