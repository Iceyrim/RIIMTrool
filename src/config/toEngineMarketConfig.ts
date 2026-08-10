import type { EngineMarketConfig } from "../engine/types.js";
import type { MarketConfig } from "./schema.js";

/**
 * MarketConfig (as loaded from YAML) carries a few fields the engine has no use for
 * (exchange, exchangeSymbol, enabled — all adapter/orchestration concerns for routing and
 * filtering, not engine behavior). This picks exactly what EngineMarketConfig needs.
 */
export function toEngineMarketConfig(config: MarketConfig): EngineMarketConfig {
  return {
    symbol: config.symbol,
    orderSize: config.orderSize,
    spreadBps: config.spreadBps,
    exitSpreadBps: config.exitSpreadBps,
    quoteLevels: config.quoteLevels,
    levelSpacingBps: config.levelSpacingBps,
    inventoryReductionThresholdBase: config.inventoryReductionThresholdBase,
    riskLimits: config.riskLimits,
    sessionLossCapUsd: config.sessionLossCapUsd,
    reduceOnlyExit: config.reduceOnlyExit,
    quoteMinimumLifetimeMs: config.quoteMinimumLifetimeMs,
  };
}
