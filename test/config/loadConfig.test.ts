import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMarketsConfig } from "../../src/config/loadConfig.js";

function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-config-test-"));
  const filePath = join(dir, "markets.yaml");
  writeFileSync(filePath, contents, "utf-8");
  return filePath;
}

const validYaml = `
markets:
  - symbol: BTCUSD
    exchange: n1
    exchangeSymbol: BTCUSDC
    enabled: true
    orderSize: { min: 0.001, max: 0.002 }
    spreadBps: { normal: 5, min: 4, max: 7.5 }
    exitSpreadBps: 2.5
    quoteLevels: 2
    levelSpacingBps: [2, 3]
    inventoryReductionThresholdBase: 0.003
    riskLimits: { maxLongPosition: 0.005, maxShortPosition: 0.005, maxOrderSize: 0.0025, maxOrderNotionalUsd: 160, maxOpenOrders: 12 }
    sessionLossCapUsd: 15
`;

describe("loadMarketsConfig", () => {
  it("loads the shipped example config without errors", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config", "markets.example.yaml"));
    expect(config.markets.map((m) => m.symbol)).toEqual(["BTCUSD", "ETHUSD"]);
  });

  it("loads a valid minimal config", () => {
    const config = loadMarketsConfig(writeTempConfig(validYaml));
    expect(config.markets).toHaveLength(1);
    expect(config.markets[0]?.exchangeSymbol).toBe("BTCUSDC");
  });

  it("throws with field-level detail on missing required fields", () => {
    const badYaml = `
markets:
  - symbol: BTCUSD
    exchange: n1
    exchangeSymbol: BTCUSDC
    enabled: true
`;
    expect(() => loadMarketsConfig(writeTempConfig(badYaml))).toThrow(/orderSize/);
  });

  it("throws when levelSpacingBps length doesn't match quoteLevels", () => {
    const mismatched = validYaml.replace("quoteLevels: 2", "quoteLevels: 3");
    expect(() => loadMarketsConfig(writeTempConfig(mismatched))).toThrow(/levelSpacingBps/);
  });

  it("throws loudly on malformed YAML rather than silently merging values", () => {
    const corrupted = "markets: [this is not valid: yaml: at all: [[[";
    expect(() => loadMarketsConfig(writeTempConfig(corrupted))).toThrow();
  });

  it("throws on duplicate market symbols", () => {
    const duplicated = `
markets:
  - symbol: BTCUSD
    exchange: n1
    exchangeSymbol: BTCUSDC
    enabled: true
    orderSize: { min: 0.001, max: 0.002 }
    spreadBps: { normal: 5, min: 4, max: 7.5 }
    exitSpreadBps: 2.5
    quoteLevels: 1
    levelSpacingBps: [2]
    inventoryReductionThresholdBase: 0.003
    riskLimits: { maxLongPosition: 0.005, maxShortPosition: 0.005, maxOrderSize: 0.0025, maxOrderNotionalUsd: 160, maxOpenOrders: 12 }
    sessionLossCapUsd: 15
  - symbol: BTCUSD
    exchange: n1
    exchangeSymbol: BTCUSDC2
    enabled: true
    orderSize: { min: 0.001, max: 0.002 }
    spreadBps: { normal: 5, min: 4, max: 7.5 }
    exitSpreadBps: 2.5
    quoteLevels: 1
    levelSpacingBps: [2]
    inventoryReductionThresholdBase: 0.003
    riskLimits: { maxLongPosition: 0.005, maxShortPosition: 0.005, maxOrderSize: 0.0025, maxOrderNotionalUsd: 160, maxOpenOrders: 12 }
    sessionLossCapUsd: 15
`;
    expect(() => loadMarketsConfig(writeTempConfig(duplicated))).toThrow(/duplicate/);
  });
});
