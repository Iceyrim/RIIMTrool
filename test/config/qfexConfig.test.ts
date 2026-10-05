import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMarketsConfig } from "../../src/config/loadConfig.js";

describe("QFEX UAT configuration", () => {
  it("loads the approved production MU and MSFT constraints", () => {
    const config = loadMarketsConfig(join(process.cwd(), "config/markets.qfex-uat.yaml"));
    expect(config.markets).toHaveLength(2);
    expect(config.markets[0]).toMatchObject({ exchange: "qfex", exchangeSymbol: "MU-USD", enabled: true, priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.01, leverage: 10, orderSize: { min: 0.09, max: 0.134 }, inventoryReductionThresholdBase: 0.045, riskLimits: { maxLongPosition: 0.268, maxShortPosition: 0.268, maxOrderSize: 0.134, maxOrderNotionalUsd: 144, maxOpenOrders: 3 } });
    expect(config.markets[1]).toMatchObject({ exchange: "qfex", exchangeSymbol: "MSFT-USD", enabled: true, priceTickSize: 0.01, quantityStep: 0.001, minimumOrderSize: 0.02, leverage: 10, orderSize: { min: 0.194, max: 0.289 }, inventoryReductionThresholdBase: 0.096, riskLimits: { maxLongPosition: 0.578, maxShortPosition: 0.578, maxOrderSize: 0.289, maxOrderNotionalUsd: 144, maxOpenOrders: 3 } });
    expect(config.accountRisk).toMatchObject({ dailyVolumeTargetUsd: 5000, weeklyVolumeTargetUsd: 100000 });
  });
});
