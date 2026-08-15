import type {
  ExchangeAdapter,
  NormalizedBalance,
  NormalizedMarginStatus,
} from "../adapters/ExchangeAdapter.js";
import type { ReconciliationAnomaly } from "../engine/Reconciliation.js";
import type { CycleSummary, MarketEngine } from "../engine/MarketEngine.js";
import type { LocalOrder } from "../engine/types.js";
import type { DashboardTelemetry, VolumeTelemetry } from "./DashboardTelemetry.js";
import type { TradeLogEntry } from "../engine/TradeLog.js";

export interface DashboardMarket {
  market: string;
  engine: MarketEngine;
  adapter: ExchangeAdapter;
  telemetry?: DashboardTelemetry;
}

export interface UnavailableMetric {
  available: false;
  value: null;
  sourceNeeded: string;
}

export interface AvailableMetric<T> {
  available: true;
  value: T;
}

export type DashboardMetric<T> = AvailableMetric<T> | UnavailableMetric;

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
  notionalUsd: number;
}

export interface MarketStatus {
  market: string;
  exchangeId: string;
  reconciliation: MarketReconciliationStatus;
  position: MarketPositionStatus | null;
  openOrders: LocalOrder[];
  fills: DashboardMetric<{ label: "current session"; entries: readonly TradeLogEntry[] }>;
  operations?: Pick<CycleSummary,
    | "positionBaseSize"
    | "inventoryReductionThresholdBase"
    | "reductionMode"
    | "reductionModeCancellation"
    | "reduceOnlyAction"
    | "exitState"
    | "exitDetails"
    | "quoteRefreshReason"
    | "quotesCancelled"
    | "riskSkippedLevels"
    | "riskSkipMessages"
    | "blockedReason"
    | "pnlOutageCancellation"
  >;
}

export interface DashboardAccountStatus {
  exchangeId: string;
  venue: "N1" | "RISEx" | "Unknown";
  mode: "LIVE" | "PAPER" | "UNKNOWN";
  label: string;
  balances: DashboardMetric<NormalizedBalance[]>;
  margin: DashboardMetric<NormalizedMarginStatus>;
  healthy: boolean;
  healthDetails: string[];
  uptimeMs: DashboardMetric<number>;
  sessionRealizedPnlUsd: number;
  sessionLossCapUsd: number;
  pnlAvailable: boolean;
  volumes: Record<"24h" | "7d" | "30d" | "allTime", DashboardMetric<VolumeTelemetry>>;
}

export interface DashboardStatus {
  generatedAt: number;
  totalExposureUsd: number;
  accountSessionRealizedPnlUsd: number;
  accountSessionLossCapUsd: number;
  accountPnlAvailable: boolean;
  accounts: DashboardAccountStatus[];
  markets: MarketStatus[];
  unavailableTelemetry: string[];
}

function unavailable(sourceNeeded: string): UnavailableMetric {
  return { available: false, value: null, sourceNeeded };
}

function cachedMetric<T>(read: () => T, source: string): DashboardMetric<T> {
  try {
    return { available: true, value: read() };
  } catch (error) {
    return unavailable(`${source}; cached read failed: ${String(error)}`);
  }
}

function venueMode(exchangeId: string): Pick<DashboardAccountStatus, "venue" | "mode" | "label"> {
  if (exchangeId === "n1") return { venue: "N1", mode: "LIVE", label: "N1 LIVE" };
  if (exchangeId === "n1-paper") return { venue: "N1", mode: "PAPER", label: "N1 PAPER" };
  if (exchangeId === "risex") return { venue: "RISEx", mode: "LIVE", label: "RISEx LIVE" };
  if (exchangeId === "risex-paper") {
    return { venue: "RISEx", mode: "PAPER", label: "RISEx PAPER" };
  }
  return { venue: "Unknown", mode: "UNKNOWN", label: exchangeId };
}

function buildMarketStatus({ market, engine, adapter, telemetry }: DashboardMarket): MarketStatus {
  const result = engine.reconciliation.getLastResult();
  const rawPosition = adapter.getPositions(market)[0];
  return {
    market,
    exchangeId: adapter.exchangeId,
    reconciliation: {
      healthy: result?.healthy ?? false,
      healthyStreak: engine.reconciliation.getHealthyStreak(),
      degradedStreak: engine.reconciliation.getDegradedStreak(),
      checkedAt: result?.checkedAt,
      anomalies: result?.anomalies ?? [],
    },
    position: rawPosition
      ? {
          baseSize: rawPosition.baseSize,
          markPrice: rawPosition.markPrice,
          unrealizedPnl: rawPosition.unrealizedPnl,
          notionalUsd: Math.abs(rawPosition.baseSize) * rawPosition.markPrice,
        }
      : null,
    openOrders: engine.registry.list(),
    fills: telemetry ? { available: true, value: { label: "current session", entries: telemetry.snapshot().fills.filter((fill) => fill.market === market) } } : unavailable(
      `An in-memory, deduplicated TradeLog fill snapshot for ${market}; placements and cancellations are not volume/fill sources.`,
    ),
    operations: engine.getLastCycleSummary(),
  };
}

function buildAccountStatus(
  exchangeId: string,
  accountMarkets: readonly DashboardMarket[],
  marketStatuses: readonly MarketStatus[],
): DashboardAccountStatus {
  const adapter = accountMarkets[0]!.adapter;
  const engine = accountMarkets[0]!.engine;
  const balances = cachedMetric(() => adapter.getBalances(), "adapter.getBalances() cached snapshot");
  const margin = cachedMetric(
    () => adapter.getMarginStatus(),
    "adapter.getMarginStatus() cached snapshot",
  );
  const relevantMarkets = marketStatuses.filter((market) => market.exchangeId === exchangeId);
  const healthDetails = relevantMarkets
    .filter((market) => !market.reconciliation.healthy)
    .map((market) => `${market.market} reconciliation degraded`);
  if (margin.available && margin.value.isAtBankruptcyRisk) healthDetails.push("Bankruptcy risk");
  if (!margin.available) healthDetails.push("Margin unavailable");
  const volumeSource = (window: string) =>
    unavailable(
      `Cached account-trade volume from adapter.getAccountVolume({ since, until }) for the ${window} window, aggregated from confirmed fills only.`,
    );
  const risk = engine.getAccountRiskState();
  const telemetry = accountMarkets.find((market) => market.telemetry)?.telemetry?.snapshot();
  const volumeMetric = (window: "24h" | "7d" | "30d" | "allTime"): DashboardMetric<VolumeTelemetry> => {
    const cached = telemetry?.volumes[window];
    return cached ? { available: true, value: cached } : volumeSource(window);
  };

  return {
    exchangeId,
    ...venueMode(exchangeId),
    balances,
    margin,
    healthy: healthDetails.length === 0,
    healthDetails,
    uptimeMs: telemetry?.uptimeMs !== undefined ? { available: true, value: telemetry.uptimeMs } : unavailable(
      "The owning runner's monotonic startedAt timestamp supplied to DashboardService.",
    ),
    sessionRealizedPnlUsd: engine.getSessionRealizedPnlUsd(),
    sessionLossCapUsd: risk.sessionLossCapUsd,
    pnlAvailable: risk.pnlAvailable,
    volumes: {
      "24h": volumeMetric("24h"),
      "7d": volumeMetric("7d"),
      "30d": volumeMetric("30d"),
      allTime: volumeMetric("allTime"),
    },
  };
}

/** Builds a status snapshot using cached/in-memory telemetry only. Every adapter read is
 * synchronous and no exchange method capable of I/O is called. */
export function buildDashboardStatus(markets: readonly DashboardMarket[]): DashboardStatus {
  const marketStatuses = markets.map((market) => {
    try {
      return buildMarketStatus(market);
    } catch {
      return {
        market: market.market,
        exchangeId: market.adapter.exchangeId,
        reconciliation: {
          healthy: false,
          healthyStreak: 0,
          degradedStreak: 0,
          anomalies: [],
        },
        position: null,
        openOrders: [],
        fills: unavailable(`An in-memory, deduplicated TradeLog fill snapshot for ${market.market}.`),
      } satisfies MarketStatus;
    }
  });
  const groups = new Map<string, DashboardMarket[]>();
  for (const market of markets) {
    const group = groups.get(market.adapter.exchangeId) ?? [];
    group.push(market);
    groups.set(market.adapter.exchangeId, group);
  }
  const accounts = [...groups].map(([exchangeId, accountMarkets]) =>
    buildAccountStatus(exchangeId, accountMarkets, marketStatuses),
  );
  const first = accounts[0];

  return {
    generatedAt: Date.now(),
    totalExposureUsd: marketStatuses.reduce(
      (sum, market) => sum + (market.position?.notionalUsd ?? 0),
      0,
    ),
    accountSessionRealizedPnlUsd: first?.sessionRealizedPnlUsd ?? 0,
    accountSessionLossCapUsd: first?.sessionLossCapUsd ?? 0,
    accountPnlAvailable: first?.pnlAvailable ?? false,
    accounts,
    markets: marketStatuses,
    unavailableTelemetry: [
      "Uptime: owning runner monotonic startedAt timestamp.",
      "Fills: in-memory deduplicated TradeLog fill snapshot.",
      "24h/7d/30d/all-time volume: cached adapter.getAccountVolume results from confirmed fills.",
    ],
  };
}
