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
accountRisk:
  sessionLossCapUsd: 6
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
    expect(config.markets[0]?.quoteMinimumLifetimeMs).toBe(30_000);
    expect(config.markets[0]?.quoteRepriceThresholdBps).toBe(1);
    expect(config.markets[0]?.quoteMaximumLifetimeMs).toBe(120_000);
  });

  it.each([
    ["negative minimum lifetime", "    quoteMinimumLifetimeMs: -1\n", /quoteMinimumLifetimeMs/],
    ["zero repricing threshold", "    quoteRepriceThresholdBps: 0\n", /quoteRepriceThresholdBps/],
    [
      "maximum lifetime below minimum lifetime",
      "    quoteMinimumLifetimeMs: 30000\n    quoteMaximumLifetimeMs: 29999\n",
      /quoteMaximumLifetimeMs/,
    ],
  ])("rejects %s", (_description, refreshConfig, expected) => {
    const invalid = validYaml.replace("    inventoryReductionThresholdBase: 0.003\n", `    inventoryReductionThresholdBase: 0.003\n${refreshConfig}`);
    expect(() => loadMarketsConfig(writeTempConfig(invalid))).toThrow(expected);
  });

  it("throws with field-level detail on missing required fields", () => {
    const badYaml = `
accountRisk: { sessionLossCapUsd: 6 }
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

  it("rejects a two-sided ladder plus exit slot that exceeds maxOpenOrders", () => {
    const overCapacity = validYaml.replace("maxOpenOrders: 12", "maxOpenOrders: 4");
    expect(() => loadMarketsConfig(writeTempConfig(overCapacity))).toThrow(/permitted exit slot/);
  });

  it("throws loudly on malformed YAML rather than silently merging values", () => {
    const corrupted = "markets: [this is not valid: yaml: at all: [[[";
    expect(() => loadMarketsConfig(writeTempConfig(corrupted))).toThrow();
  });

  it("throws on duplicate market symbols", () => {
    const duplicated = `
accountRisk: { sessionLossCapUsd: 6 }
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
`;
    expect(() => loadMarketsConfig(writeTempConfig(duplicated))).toThrow(/duplicate/);
  });

  it("rejects obsolete per-market loss caps instead of silently misreading them", () => {
    const legacy = validYaml.replace(
      "    inventoryReductionThresholdBase: 0.003\n",
      "    inventoryReductionThresholdBase: 0.003\n    sessionLossCapUsd: 15\n",
    );
    expect(() => loadMarketsConfig(writeTempConfig(legacy))).toThrow(/sessionLossCapUsd/);
  });
});
