import type { DashboardAccountStatus, DashboardStatus } from "./DashboardService.js";

const SYNTHETIC_NOW = Date.UTC(2025, 0, 1, 12, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const volumes = (exchangeId: string, scale: number): DashboardAccountStatus["volumes"] => {
  const volume = (index: number): DashboardAccountStatus["volumes"]["24h"] => ({
    available: true as const,
    value: {
      available: true,
      value: ["BTCUSD", "ETHUSD"].map((market, marketIndex) => ({
        market,
        since: new Date(SYNTHETIC_NOW - [DAY, 7 * DAY, 30 * DAY, 90 * DAY][index]!).toISOString(),
        until: new Date(SYNTHETIC_NOW).toISOString(),
        baseVolume: scale * (index + 1) * (marketIndex + 1),
        quoteVolume: scale * (index + 1) * (marketIndex + 1) * (market === "BTCUSD" ? 42_000 : 2_250),
      })),
      updatedAt: SYNTHETIC_NOW - 60_000,
      stale: false,
    },
  });

  return {
    "24h": volume(0),
    "7d": volume(1),
    "30d": volume(2),
    allTime: volume(3),
  };
};

const history = (label: string, scale: number) => ({
  available: true as const,
  value: {
    sessions: [
      { id: `synthetic-${label}-previous`, startedAt: SYNTHETIC_NOW - 2 * DAY, lastSeenAt: SYNTHETIC_NOW - DAY },
      { id: `synthetic-${label}-current`, startedAt: SYNTHETIC_NOW - 6 * HOUR, lastSeenAt: SYNTHETIC_NOW },
    ],
    points: [
      { timestamp: SYNTHETIC_NOW - 6 * HOUR, realizedPnlUsd: 0, quoteVolume: 0 },
      { timestamp: SYNTHETIC_NOW - 3 * HOUR, realizedPnlUsd: scale, quoteVolume: scale * 12_000 },
      { timestamp: SYNTHETIC_NOW, realizedPnlUsd: scale * 2, quoteVolume: scale * 25_000 },
    ],
    status: { stale: false, updatedAt: SYNTHETIC_NOW },
  },
});

const fill = (exchangeId: string, market: "BTCUSD" | "ETHUSD", offset: number) => ({
  timestamp: SYNTHETIC_NOW - offset * 60_000,
  market,
  side: offset % 2 ? "buy" as const : "sell" as const,
  size: market === "BTCUSD" ? 0.002 : 0.04,
  price: market === "BTCUSD" ? 42_000 + offset : 2_250 + offset,
  isReduceOnly: offset % 2 === 0,
  clientOrderId: `synthetic-${exchangeId}-${market.toLowerCase()}-${offset}`,
  exchangeOrderId: `synthetic-order-${exchangeId}-${market.toLowerCase()}-${offset}`,
  tradeId: `synthetic-trade-${exchangeId}-${market.toLowerCase()}-${offset}`,
  source: offset % 2 ? "placement" as const : "reconciliation" as const,
});

/** Deterministic preview data only: no adapters, engines, credentials, network, or persistence. */
export function buildSyntheticDashboardStatus(): DashboardStatus {
  const accounts: DashboardStatus["accounts"] = [
    { exchangeId: "synthetic-n1-live", venue: "N1", mode: "LIVE", label: "N1 LIVE (SYNTHETIC)", scale: 1 },
    { exchangeId: "synthetic-risex-paper", venue: "RISEx", mode: "PAPER", label: "RISEx PAPER (SYNTHETIC)", scale: 0.6 },
  ].map(({ exchangeId, venue, mode, label, scale }, accountIndex) => ({
    exchangeId, venue: venue as "N1" | "RISEx", mode: mode as "LIVE" | "PAPER", label,
    balances: { available: true, value: [{ token: "USD", amount: 10_000 * scale }, { token: "USDC", amount: 2_500 * scale }] },
    margin: { available: true, value: { accountValue: 12_500 * scale, maintenanceMarginFraction: 0.08, initialMarginFraction: 0.16, isAtBankruptcyRisk: false } },
    healthy: accountIndex === 0,
    healthDetails: accountIndex === 0 ? ["Synthetic preview telemetry is healthy"] : ["Synthetic preview warning state"],
    uptimeMs: { available: true, value: 6 * HOUR },
    sessionRealizedPnlUsd: accountIndex === 0 ? scale * 2 : -scale * 2,
    sessionLossCapUsd: 6,
    pnlAvailable: true,
    volumes: accountIndex === 0 ? volumes(exchangeId, scale) : {
      ...volumes(exchangeId, scale),
      "30d": { available: true, value: { ...volumes(exchangeId, scale)["30d"].value!, stale: true, error: "Synthetic preview stale-cache warning" } },
      allTime: { available: true, value: { available: false, value: null, stale: false, sourceNeeded: "Synthetic preview: authoritative all-time paper history is unavailable." } },
    },
    history: history(exchangeId, scale),
    alertHealth: { available: true, value: { enabled: true, attempted: 8, delivered: 7, failed: 1, pending: 0, lastAttemptAt: SYNTHETIC_NOW - 30_000, lastSuccessAt: SYNTHETIC_NOW - 60_000, lastFailureAt: SYNTHETIC_NOW - HOUR, lastErrorCategory: "network" } },
  }));

  const marketSpecs = [
    { exchangeId: "synthetic-n1-live", market: "BTCUSD" as const, offset: 5, exitState: "held" as const, refresh: "below-threshold hold" as const, anomaly: false },
    { exchangeId: "synthetic-n1-live", market: "ETHUSD" as const, offset: 10, exitState: "placed" as const, refresh: "threshold refresh" as const, anomaly: false },
    { exchangeId: "synthetic-risex-paper", market: "BTCUSD" as const, offset: 15, exitState: "blocked" as const, refresh: "maximum-age refresh" as const, anomaly: true },
    { exchangeId: "synthetic-risex-paper", market: "ETHUSD" as const, offset: 20, exitState: "no_position" as const, refresh: "empty ladder placement" as const, anomaly: false },
  ];

  return {
    generatedAt: SYNTHETIC_NOW,
    totalExposureUsd: 1_260,
    accountSessionRealizedPnlUsd: 3.2,
    accountSessionLossCapUsd: 6,
    accountPnlAvailable: true,
    accounts,
    markets: marketSpecs.map(({ exchangeId, market, offset, exitState, refresh, anomaly }) => ({
      market,
      exchangeId,
      reconciliation: {
        healthy: !anomaly, healthyStreak: anomaly ? 0 : 12, degradedStreak: anomaly ? 1 : 0,
        checkedAt: SYNTHETIC_NOW - offset * 1_000,
        anomalies: anomaly ? [{ kind: "LOCAL_ORDER_NOT_ON_EXCHANGE", exchangeOrderId: "synthetic-missing-order", detail: "Synthetic preview anomaly" }] : [],
      },
      position: exitState === "no_position" ? null : { baseSize: market === "BTCUSD" ? 0.01 : -0.2, markPrice: market === "BTCUSD" ? 42_000 : 2_250, unrealizedPnl: offset / 10, notionalUsd: 420 + offset },
      openOrders: [
        {
          clientOrderId: `synthetic-${exchangeId}-${market}-resting`, exchangeOrderId: `resting-${offset}`,
          market, side: "buy" as const, type: "postOnly" as const, price: market === "BTCUSD" ? 41_980 : 2_245,
          size: market === "BTCUSD" ? 0.002 : 0.04, filledSize: 0, isReduceOnly: false,
          state: "RESTING" as const, placedAt: SYNTHETIC_NOW - offset * 60_000, updatedAt: SYNTHETIC_NOW - offset * 60_000,
        },
        ...(offset === 5 ? [{
          clientOrderId: "synthetic-pending", exchangeOrderId: "pending-1", market, side: "sell" as const,
          type: "postOnly" as const, price: 42_040, size: 0.002, filledSize: 0, isReduceOnly: true,
          state: "PENDING_CANCEL" as const, placedAt: SYNTHETIC_NOW - 12 * 60_000, updatedAt: SYNTHETIC_NOW - 30_000,
        }, {
          clientOrderId: "synthetic-unknown", exchangeOrderId: null, market, side: "buy" as const,
          type: "postOnly" as const, price: 41_950, size: 0.001, filledSize: 0, isReduceOnly: false,
          state: "UNKNOWN" as const, placedAt: SYNTHETIC_NOW - 4 * 60_000, updatedAt: SYNTHETIC_NOW - 20_000,
          note: "Synthetic preview: confirmation unavailable",
        }] : []),
      ],
      fills: { available: true, value: { label: "current session + durable history", entries: [fill(exchangeId, market, offset), fill(exchangeId, market, offset + 120)] } },
      operations: {
        positionBaseSize: exitState === "no_position" ? 0 : market === "BTCUSD" ? 0.01 : -0.2,
        inventoryReductionThresholdBase: market === "BTCUSD" ? 0.008 : 0.15,
        reductionMode: exitState !== "no_position",
        reductionModeCancellation: { attempted: 1, succeeded: 1, unresolved: 0, messages: [] },
        reduceOnlyAction: exitState === "placed" ? "placed" : exitState === "held" ? "held" : "none",
        exitState,
        exitDetails: exitState === "blocked" ? { cause: "Synthetic preview risk block" } : exitState === "no_position" ? undefined : { size: market === "BTCUSD" ? 0.01 : 0.2, price: market === "BTCUSD" ? 42_010 : 2_255 },
        quoteRefreshReason: refresh,
        quotesCancelled: offset / 5,
        riskSkippedLevels: { openOrderCapacity: anomaly ? 2 : 0, aggregateLongExposure: market === "BTCUSD" ? 1 : 0, aggregateShortExposure: market === "ETHUSD" ? 1 : 0, orderSize: 0, orderNotional: 1 },
        riskSkipMessages: ["Synthetic preview: deterministic risk skip"],
        blockedReason: exitState === "blocked" ? "Synthetic preview reconciliation block" : undefined,
        pnlOutageCancellation: { attempted: 0, succeeded: 0, failed: 0, unresolved: 0, messages: [] },
      },
    })),
    unavailableTelemetry: ["Synthetic preview only: no adapters, exchanges, credentials, network, or live state are connected."],
  };
}
