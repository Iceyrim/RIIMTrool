import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertQfexPreflight, consumeQfexLiveArmFile, estimateQfexInitialMargin, isQfexDailyVolumeTargetReached, planQfexFlattenChunks, qfexUtcDayWindow, requireQfexLiveCliFlag, totalQfexConfirmedVolume, waitForQfexMarketMarks } from "../../src/engine/QfexLiveStartup.js";

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
  it("uses UTC day boundaries and confirmed quote volume for the daily stop", () => {
    expect(qfexUtcDayWindow(new Date("2026-09-28T06:30:00.000Z"))).toEqual({
      since: "2026-09-28T00:00:00.000Z",
      until: "2026-09-28T06:30:00.000Z",
    });
    expect(totalQfexConfirmedVolume([{ quoteVolume: 2_400 }, { quoteVolume: 2_600 }])).toBe(5_000);
    expect(isQfexDailyVolumeTargetReached(4_999.99, 5_000)).toBe(false);
    expect(isQfexDailyVolumeTargetReached(5_000, 5_000)).toBe(true);
  });
  it("waits for a delayed fresh mark", async () => {
    let attempts = 0;
    const reader = { async getMarketPrice(): Promise<{ mark: number }> {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("not ready"), { retryable: true });
      return { mark: 101.25 };
    } };
    await expect(waitForQfexMarketMarks(reader, ["MUUSD"], { timeoutMs: 50, pollIntervalMs: 1 })).resolves.toEqual(new Map([["MUUSD", 101.25]]));
  });
  it("times out when a fresh mark never arrives", async () => {
    const reader = { async getMarketPrice(): Promise<{ mark: number }> { throw Object.assign(new Error("not ready"), { retryable: true }); } };
    await expect(waitForQfexMarketMarks(reader, ["MUUSD"], { timeoutMs: 5, pollIntervalMs: 1 })).rejects.toThrow(/Timed out.*MUUSD/);
  });
  it("waits for every configured market", async () => {
    const reader = { async getMarketPrice(market: string): Promise<{ mark: number }> {
      return { mark: market === "MUUSD" ? 100 : 500 };
    } };
    await expect(waitForQfexMarketMarks(reader, ["MUUSD", "MSFTUSD"])).resolves.toEqual(new Map([["MUUSD", 100], ["MSFTUSD", 500]]));
  });

});
