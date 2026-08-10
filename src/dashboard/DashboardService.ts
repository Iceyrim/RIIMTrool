import type { ExchangeAdapter } from "../adapters/ExchangeAdapter.js";
import type { ReconciliationAnomaly } from "../engine/Reconciliation.js";
import type { MarketEngine } from "../engine/MarketEngine.js";
import type { LocalOrder } from "../engine/types.js";

/**
 * One running market's engine + the adapter it trades through. Deliberately pairs them (rather
 * than reading the adapter off the engine) because MarketEngine keeps its adapter private, and in
 * both paper and live modes one adapter instance is shared across every market on the account
 * (SPEC.md Section 4.3) — the caller already has this pairing from wherever it constructed the
 * engines (see scripts/run-paper.ts), so no new engine API is needed to expose it here.
 */
export interface DashboardMarket {
  market: string;
  engine: MarketEngine;
  adapter: ExchangeAdapter;
}

export interface MarketReconciliationStatus {
  healthy: boolean;
  healthyStreak: number;
  degradedStreak: number;
  checkedAt?: number;
  anomalies: ReconciliationAnomaly[];
}

export interface MarketPositionStatus {
  baseSize: number;
  markPrice: number;
  unrealizedPnl: number;
  /** |baseSize| * markPrice — this market's contribution to totalExposureUsd below. */
  notionalUsd: number;
}

export interface MarketStatus {
  market: string;
  reconciliation: MarketReconciliationStatus;
  sessionRealizedPnlUsd: number;
  position: MarketPositionStatus | null;
  openOrders: LocalOrder[];
}

export interface DashboardStatus {
  generatedAt: number;
  /**
   * SPEC.md Section 8: the old aggregator computed this from a per-session trade counter that
   * reset on every restart and could silently show $0.00 despite real open positions. This sums
   * |position.baseSize * position.markPrice| straight from each adapter's live NormalizedPosition
   * snapshot, recomputed on every call — there is no accumulator or counter anywhere in this
   * value, so a restart (or a session PnL reset) cannot desync it from reality.
   */
  totalExposureUsd: number;
  markets: MarketStatus[];
  /** Section 8 also calls for real N1 volume (Nord.getAccountVolume()) and live control actions
   * (pause/shutdown, per-market and all-markets). Both are live-account features with nothing to
   * validate against yet (this repo currently runs paper-mode only, no live .env configured) — so
   * they're deliberately left out of this status payload rather than surfaced with placeholder or
   * simulated numbers. TODO: once a live account exists, add a volume section here backed by
   * adapter.getAccountVolume() (already implemented for live N1 in N1Adapter), and add control
   * actions once MarketEngine/PaperRunner grow a pause/stop primitive to call into.
   */
  todo: readonly string[];
}

const TODOS = [
  "Real N1 volume data (Nord.getAccountVolume()) — pending a live account to validate against.",
  "Control actions (pause/shutdown, per-market and all-markets) — pending a live account and an " +
    "engine-level pause/stop primitive to call into.",
] as const;

function buildMarketStatus({ market, engine, adapter }: DashboardMarket): MarketStatus {
  const reconciliationResult = engine.reconciliation.getLastResult();
  const reconciliation: MarketReconciliationStatus = {
    healthy: reconciliationResult?.healthy ?? false,
    healthyStreak: engine.reconciliation.getHealthyStreak(),
    degradedStreak: engine.reconciliation.getDegradedStreak(),
    checkedAt: reconciliationResult?.checkedAt,
    anomalies: reconciliationResult?.anomalies ?? [],
  };

  const rawPosition = adapter.getPositions(market)[0];
  const position: MarketPositionStatus | null = rawPosition
    ? {
        baseSize: rawPosition.baseSize,
        markPrice: rawPosition.markPrice,
        unrealizedPnl: rawPosition.unrealizedPnl,
        notionalUsd: Math.abs(rawPosition.baseSize) * rawPosition.markPrice,
      }
    : null;

  return {
    market,
    reconciliation,
    sessionRealizedPnlUsd: engine.getSessionRealizedPnlUsd(),
    position,
    openOrders: engine.registry.list(),
  };
}

/** Builds the full multi-market status snapshot. Reads only in-memory state each market's engine
 * cycle already populated (registry, last reconciliation result, adapter's cached account
 * snapshot) — never issues a new exchange call itself, so calling this is always safe/free to
 * poll from an HTTP handler. */
export function buildDashboardStatus(markets: readonly DashboardMarket[]): DashboardStatus {
  const marketStatuses = markets.map(buildMarketStatus);
  const totalExposureUsd = marketStatuses.reduce(
    (sum, m) => sum + (m.position?.notionalUsd ?? 0),
    0,
  );

  return {
    generatedAt: Date.now(),
    totalExposureUsd,
    markets: marketStatuses,
    todo: TODOS,
  };
}
