import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMarketsConfig } from "../../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../../src/config/toEngineMarketConfig.js";

describe("toEngineMarketConfig", () => {
  it("applies the default reduce-only and quote-refresh policy when config omits them", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config", "markets.example.yaml"));
    const btc = config.markets.find((m) => m.symbol === "BTCUSD")!;
    const engineConfig = toEngineMarketConfig(btc);

    expect(engineConfig.reduceOnlyExit).toEqual({ minHoldMs: 45_000, maxHoldMs: 300_000 });
    expect(engineConfig.quoteMinimumLifetimeMs).toBe(30_000);
    expect(engineConfig.quoteRepriceThresholdBps).toBe(1);
    expect(engineConfig.quoteMaximumLifetimeMs).toBe(120_000);
    expect(engineConfig.symbol).toBe("BTCUSD");
    expect(engineConfig.accountSessionLossCapUsd).toBe(6);
  });

  it("drops adapter/orchestration-only fields (exchange, exchangeSymbol, enabled)", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config", "markets.example.yaml"));
    const engineConfig = toEngineMarketConfig(config.markets[0]!);
    expect(engineConfig).not.toHaveProperty("exchange");
    expect(engineConfig).not.toHaveProperty("exchangeSymbol");
    expect(engineConfig).not.toHaveProperty("enabled");
  });

  it("passes explicit quote-refresh policy values through to the engine", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config", "markets.example.yaml"));
    const engineConfig = toEngineMarketConfig({
      ...config.markets[0]!,
      quoteMinimumLifetimeMs: 12_000,
      quoteRepriceThresholdBps: 2.5,
      quoteMaximumLifetimeMs: 90_000,
    });

    expect(engineConfig.quoteMinimumLifetimeMs).toBe(12_000);
    expect(engineConfig.quoteRepriceThresholdBps).toBe(2.5);
    expect(engineConfig.quoteMaximumLifetimeMs).toBe(90_000);
  });
});
