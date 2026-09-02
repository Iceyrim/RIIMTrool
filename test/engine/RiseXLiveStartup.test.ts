import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertRiseXPreflight, consumeRiseXLiveArmFile, estimateRiseXInitialMargin, planRiseXFlattenChunks, requireRiseXLiveCliFlag } from "../../src/engine/RiseXLiveStartup.js";

describe("RISEx live startup safety", () => {
  it("requires explicit CLI and one-use daily arm evidence", () => {
    expect(() => requireRiseXLiveCliFlag([])).toThrow(/missing/);
    requireRiseXLiveCliFlag(["--i-understand-this-places-real-orders"]);
    const root = join(tmpdir(), `risex-arm-${Date.now()}`); mkdirSync(root); const arm = join(root, "ARMED"); writeFileSync(arm, "2026-09-02\n");
    consumeRiseXLiveArmFile(arm, "2026-09-02");
    expect(() => consumeRiseXLiveArmFile(arm, "2026-09-02")).toThrow(/not found/);
  });
  it("calculates leverage-aware collateral and fails closed", () => {
    const markets = [{ symbol: "BTCUSD", leverage: 20, quoteLevels: 2, orderSize: { min: 0.001, max: 0.001 } }] as never;
    expect(estimateRiseXInitialMargin(markets, new Map([["BTCUSD", 60_000]]))).toBe(12);
    expect(() => assertRiseXPreflight({ flat: false, openOrderCount: 0, availableCollateral: 50, estimatedInitialMargin: 12, marginSafe: true })).toThrow(/flat/);
  });
  it("bounds shutdown chunks", () => {
    expect(planRiseXFlattenChunks(-0.01, 0.004)).toEqual([0.004, 0.004, 0.002]);
    expect(() => planRiseXFlattenChunks(1, 0.001, 2)).toThrow(/capacity/);
  });
});
