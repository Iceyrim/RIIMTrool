import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPerplLiveCapacity,
  consumePerplLiveArmFile,
  estimatePerplRestingNotional,
  requirePerplLiveCliFlag,
} from "../../src/engine/PerplLiveStartup.js";
import { loadMarketsConfig } from "../../src/config/loadConfig.js";

describe("Perpl Live startup gates", () => {
  it("consumes a valid arm file exactly once", () => {
    const directory = join("/tmp", `perpl-live-arm-${process.pid}-${Date.now()}`);
    const path = join(directory, "ARMED");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, "2026-08-30\n");
    consumePerplLiveArmFile(path, "2026-08-30");
    expect(() => readFileSync(path)).toThrow();
    expect(() => consumePerplLiveArmFile(path, "2026-08-30")).toThrow(/not found/);
  });

  it("requires the explicit live-money flag", () => {
    expect(() => requirePerplLiveCliFlag([])).toThrow(/missing/);
    expect(() => requirePerplLiveCliFlag(["--i-understand-this-places-real-orders"])).not.toThrow();
  });

  it("blocks ladders that exceed collateral or worker capacity", () => {
    expect(() => assertPerplLiveCapacity({ availableBalance: 18, lockedBalance: 0, estimatedRestingNotional: 40, configuredOpenOrders: 4, workerOpenOrderCap: 4 })).toThrow(/insufficient/);
    expect(() => assertPerplLiveCapacity({ availableBalance: 100, lockedBalance: 0, estimatedRestingNotional: 40, configuredOpenOrders: 5, workerOpenOrderCap: 4 })).toThrow(/open-order cap/);
    expect(() => assertPerplLiveCapacity({ availableBalance: 100, lockedBalance: 0, estimatedRestingNotional: 40, configuredOpenOrders: 4, workerOpenOrderCap: 4 })).not.toThrow();
  });

  it("loads the production config and estimates both sides of every level", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config/markets.perpl-live.yaml"));
    expect(estimatePerplRestingNotional(config.markets, new Map([["BTCUSD", 75_000], ["ETHUSD", 2_500]]))).toBeCloseTo(3.47, 2);
  });
});
