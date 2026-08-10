import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMarketsConfig } from "../../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../../src/config/toEngineMarketConfig.js";

describe("toEngineMarketConfig", () => {
  it("applies the proven default reduceOnlyExit/quoteMinimumLifetimeMs values when config omits them", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config", "markets.example.yaml"));
    const btc = config.markets.find((m) => m.symbol === "BTCUSD")!;
    const engineConfig = toEngineMarketConfig(btc);

    expect(engineConfig.reduceOnlyExit).toEqual({ minHoldMs: 45_000, maxHoldMs: 300_000 });
    expect(engineConfig.quoteMinimumLifetimeMs).toBe(2_000);
    expect(engineConfig.symbol).toBe("BTCUSD");
  });

  it("drops adapter/orchestration-only fields (exchange, exchangeSymbol, enabled)", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config", "markets.example.yaml"));
    const engineConfig = toEngineMarketConfig(config.markets[0]!);
    expect(engineConfig).not.toHaveProperty("exchange");
    expect(engineConfig).not.toHaveProperty("exchangeSymbol");
    expect(engineConfig).not.toHaveProperty("enabled");
  });
});
