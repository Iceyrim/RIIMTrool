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
accountRisk: {}
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

  it("admits the shipped Perpl paper-only validation config", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config", "markets.perpl-validation.yaml"));
    expect(config.markets.every((market) => market.exchange === "perpl")).toBe(true);
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
accountRisk: {}
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

  it("accepts optional accountRisk.dailyLossCapUsd/weeklyLossCapUsd", () => {
    const withWindowCaps = validYaml.replace(
      "accountRisk: {}\n",
      "accountRisk:\n  dailyLossCapUsd: 5\n  weeklyLossCapUsd: 20\n",
    );
    const config = loadMarketsConfig(writeTempConfig(withWindowCaps));
    expect(config.accountRisk.dailyLossCapUsd).toBe(5);
    expect(config.accountRisk.weeklyLossCapUsd).toBe(20);
  });

  it("loads without dailyLossCapUsd/weeklyLossCapUsd configured (absence = no cap enforced)", () => {
    const config = loadMarketsConfig(writeTempConfig(validYaml));
    expect(config.accountRisk.dailyLossCapUsd).toBeUndefined();
    expect(config.accountRisk.weeklyLossCapUsd).toBeUndefined();
  });

  it("rejects weeklyLossCapUsd smaller than dailyLossCapUsd", () => {
    const inverted = validYaml.replace(
      "accountRisk: {}\n",
      "accountRisk:\n  dailyLossCapUsd: 20\n  weeklyLossCapUsd: 5\n",
    );
    expect(() => loadMarketsConfig(writeTempConfig(inverted))).toThrow(/weeklyLossCapUsd/);
  });

  it("rejects a stale top-level accountRisk.sessionLossCapUsd key instead of silently ignoring it", () => {
    const stale = validYaml.replace("accountRisk: {}\n", "accountRisk:\n  sessionLossCapUsd: 6\n");
    expect(() => loadMarketsConfig(writeTempConfig(stale))).toThrow(/sessionLossCapUsd/);
    expect(() => loadMarketsConfig(writeTempConfig(stale))).toThrow(/removed/);
  });

  it("rejects a stale accountRisk.sessionLossCapUsd key even alongside valid dailyLossCapUsd/weeklyLossCapUsd (not silently merged/ignored)", () => {
    const staleWithNewCaps = validYaml.replace(
      "accountRisk: {}\n",
      "accountRisk:\n  sessionLossCapUsd: 6\n  dailyLossCapUsd: 5\n  weeklyLossCapUsd: 20\n",
    );
    expect(() => loadMarketsConfig(writeTempConfig(staleWithNewCaps))).toThrow(/sessionLossCapUsd/);
  });

  it("throws on duplicate market symbols", () => {
    const duplicated = `
accountRisk: {}
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

  it("rejects an unrecognized per-market key (e.g. a stray legacy loss-cap field) instead of silently misreading it", () => {
    const legacy = validYaml.replace(
      "    inventoryReductionThresholdBase: 0.003\n",
      "    inventoryReductionThresholdBase: 0.003\n    sessionLossCapUsd: 15\n",
    );
    expect(() => loadMarketsConfig(writeTempConfig(legacy))).toThrow(/Unknown market configuration key/);
  });
});
