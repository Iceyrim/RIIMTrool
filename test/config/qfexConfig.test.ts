import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMarketsConfig } from "../../src/config/loadConfig.js";

describe("QFEX UAT configuration", () => {
  it("loads the approved production MU and MSFT constraints", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config/markets.qfex-uat.yaml"));
    expect(config.markets).toHaveLength(2);
    expect(config.markets[0]).toMatchObject({ exchange: "qfex", exchangeSymbol: "MU-USD", enabled: true, priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.01, leverage: 10, orderSize: { min: 0.08, max: 0.119 } });
    expect(config.markets[1]).toMatchObject({ exchange: "qfex", exchangeSymbol: "MSFT-USD", enabled: true, priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.02, leverage: 10, orderSize: { min: 0.162, max: 0.242 } });
    expect(config.accountRisk).toMatchObject({ dailyLossCapUsd: 5, weeklyLossCapUsd: 15, dailyVolumeTargetUsd: 100000, weeklyVolumeTargetUsd: 100000 });
  });
});
