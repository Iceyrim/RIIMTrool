import type { EngineMarketConfig } from "../engine/types.js";
import type { MarketsConfig } from "./schema.js";

/**
 * MarketConfig (as loaded from YAML) carries a few fields the engine has no use for
 * (exchange, exchangeSymbol, enabled — all adapter/orchestration concerns for routing and
 * filtering, not engine behavior). This picks exactly what EngineMarketConfig needs.
 */
export function toEngineMarketConfig(config: MarketsConfig["markets"][number]): EngineMarketConfig {
  return {
    symbol: config.symbol,
    orderSize: config.orderSize,
    spreadBps: config.spreadBps,
    exitSpreadBps: config.exitSpreadBps,
    quoteLevels: config.quoteLevels,
    levelSpacingBps: config.levelSpacingBps,
    inventoryReductionThresholdBase: config.inventoryReductionThresholdBase,
    riskLimits: config.riskLimits,
    accountSessionLossCapUsd: config.accountSessionLossCapUsd,
    reduceOnlyExit: config.reduceOnlyExit,
    quoteMinimumLifetimeMs: config.quoteMinimumLifetimeMs,
    quoteRepriceThresholdBps: config.quoteRepriceThresholdBps,
    quoteMaximumLifetimeMs: config.quoteMaximumLifetimeMs,
  };
}
