import type { DashboardStatus } from "./DashboardService.js";

const SYNTHETIC_NOW = Date.UTC(2025, 0, 1, 12, 0, 0);

/** A deterministic, in-memory preview fixture. It has no adapter, engine, or persistent state. */
export function buildSyntheticDashboardStatus(): DashboardStatus {
  return {
    generatedAt: SYNTHETIC_NOW,
    totalExposureUsd: 1_250,
    accountSessionRealizedPnlUsd: 12.5,
    accountSessionLossCapUsd: 100,
    accountPnlAvailable: true,
    accounts: [],
    markets: [
      {
        market: "SYNTH-USD",
        exchangeId: "synthetic-preview",
        reconciliation: {
          healthy: true,
          healthyStreak: 12,
          degradedStreak: 0,
          checkedAt: SYNTHETIC_NOW,
          anomalies: [],
        },
        position: {
          baseSize: 0.5,
          markPrice: 2_500,
          unrealizedPnl: 12.5,
          notionalUsd: 1_250,
        },
        openOrders: [],
        fills: {
          available: true,
          value: { label: "current session + durable history", entries: [] },
        },
      },
    ],
    unavailableTelemetry: [
      "Synthetic preview: no adapters, exchanges, credentials, or live state are connected.",
    ],
  };
}
