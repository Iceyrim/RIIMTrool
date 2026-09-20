import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertQfexPreflight, consumeQfexLiveArmFile, estimateQfexInitialMargin, planQfexFlattenChunks, requireQfexLiveCliFlag } from "../../src/engine/QfexLiveStartup.js";

describe("QFEX live startup safety", () => {
  it("requires explicit CLI and consumes a one-use daily arm marker", () => {
    expect(() => requireQfexLiveCliFlag([])).toThrow(/missing/);
    requireQfexLiveCliFlag(["--i-understand-this-places-real-orders"]);
    const root = join(tmpdir(), `qfex-arm-${Date.now()}`);
    mkdirSync(root);
    const arm = join(root, "ARMED");
    writeFileSync(arm, "2026-09-19\n");
    consumeQfexLiveArmFile(arm, "2026-09-19");
    expect(() => consumeQfexLiveArmFile(arm, "2026-09-19")).toThrow(/not found/);
  });
  it("calculates leverage-aware margin and rejects unsafe startup", () => {
    const markets = [{ symbol: "US500USD", leverage: 2, quoteLevels: 1, orderSize: { min: 0.001, max: 0.001 } }] as never;
    expect(estimateQfexInitialMargin(markets, new Map([["US500USD", 6000]]))).toBe(6);
    expect(() => assertQfexPreflight({ flat: false, openOrderCount: 0, availableCollateral: 100, estimatedInitialMargin: 6, marginSafe: true })).toThrow(/flat/);
  });
  it("bounds flatten actions", () => {
    expect(planQfexFlattenChunks(-0.003, 0.002)).toEqual([0.002, 0.001]);
    expect(() => planQfexFlattenChunks(1, 0.001, 2)).toThrow(/capacity/);
  });
});
