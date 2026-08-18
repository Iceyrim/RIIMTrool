import type {
  AccountVolume,
  ExchangeAdapter,
  NormalizedFill,
} from "../adapters/ExchangeAdapter.js";
import type { TradeLogEntry } from "../engine/TradeLog.js";
import type { AlertDeliveryHealth } from "../alerting/TelegramAlertSink.js";
import {
  fillIdentity,
  type DashboardHistoryStore,
  type HistoryPoint,
  type HistorySnapshot,
  type HistoryStoreStatus,
} from "./DashboardHistoryStore.js";

export type VolumeWindow = "24h" | "7d" | "30d" | "allTime";

export interface VolumeTelemetry {
  available: boolean;
  value: AccountVolume[] | null;
  updatedAt?: number;
  stale: boolean;
  partial?: boolean;
  error?: string;
  sourceNeeded?: string;
}

export interface DashboardTelemetrySnapshot {
  startedAt?: number;
  uptimeMs?: number;
  fills: readonly TradeLogEntry[];
  fillsLabel: "current session + durable history";
  volumes: Readonly<Record<VolumeWindow, VolumeTelemetry>>;
  history: HistorySnapshot;
  historyStatus: HistoryStoreStatus;
  alertHealth: AlertDeliveryHealth;
}

const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
const TIMEOUT_MS = 5_000;
const WINDOWS: readonly Exclude<VolumeWindow, "allTime">[] = ["24h", "7d", "30d"];
const WINDOW_MS = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

/** Runner-owned publisher. Dashboard readers only receive cloned, immutable cached snapshots. */
export class DashboardTelemetry {
  private startedAt?: number;
  private readonly fills: TradeLogEntry[] = [];
  private readonly volumes = new Map<VolumeWindow, VolumeTelemetry>();
  private refreshInFlight = false;
  private nextRefreshAt = 0;
  private nextAllTimeAt = 0;
  private nextAccountSampleAt = 0;
  private failureCount = 0;
  // Two independent cursor/cache pairs so a slow or failing all-time (epoch-anchored) scan can
  // never affect the 24h/7d/30d windows: recentTrade* is clamped to a 30-day floor (the widest
  // non-allTime window) and drives the normal refresh cadence; allTimeTrade* starts at epoch and
  // only advances on the existing hourly-gated cycles, isolated in its own try/catch.
  private readonly recentTradeCache = new Map<string, NormalizedFill>();
  private recentTradeCursor?: string;
  private recentTradeSince?: string;
  private readonly allTimeTradeCache = new Map<string, NormalizedFill>();
  private allTimeTradeCursor?: string;
  private allTimeTradeSince = new Date(0).toISOString();

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly supportsAllTime: boolean,
    private readonly maxRecentFills = 100,
    private readonly historyStore?: DashboardHistoryStore,
    private readonly readAlertHealth: () => AlertDeliveryHealth = () => ({
      enabled: false,
      attempted: 0,
      delivered: 0,
      failed: 0,
      pending: 0,
    }),
  ) {
    for (const window of WINDOWS)
      this.volumes.set(
        window,
        this.unavailable(`No cached ${window} volume has been published yet.`),
      );
    this.volumes.set(
      "allTime",
      supportsAllTime
        ? this.unavailable("No cached all-time volume has been published yet.")
        : this.unavailable(
            "All-time volume is unsupported: paper history is limited to the current process session.",
          ),
    );
    this.historyStore?.startSession(`${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  markStarted(now = Date.now()): void {
    if (this.startedAt === undefined) this.startedAt = now;
  }

  recordFill(entry: TradeLogEntry): void {
    try {
      this.fills.push(Object.freeze({ ...entry }));
      if (this.fills.length > this.maxRecentFills)
        this.fills.splice(0, this.fills.length - this.maxRecentFills);
      this.historyStore?.recordFill(entry);
    } catch (error) {
      console.error(`[DashboardTelemetry] fill publication failed: ${String(error)}`);
    }
  }

  sampleAccountIfDue(realizedPnlUsd: number, now = Date.now()): void {
    if (now < this.nextAccountSampleAt) return;
    this.nextAccountSampleAt = now + FIVE_MINUTES;
    const volume = this.volumes.get("24h");
    const quoteVolume = volume?.available
      ? (volume.value?.reduce((sum, row) => sum + row.quoteVolume, 0) ?? null)
      : null;
    const point: HistoryPoint = { timestamp: now, realizedPnlUsd, quoteVolume };
    try {
      this.historyStore?.recordPoint(point);
    } catch (error) {
      console.error(`[DashboardTelemetry] history publication failed: ${String(error)}`);
    }
  }

  /** Starts work and returns immediately. Trading cycles never await telemetry. */
  refreshIfDue(now = Date.now()): void {
    if (this.refreshInFlight || now < this.nextRefreshAt) return;
    this.refreshInFlight = true;
    void this.refresh(now).finally(() => {
      this.refreshInFlight = false;
    });
  }

  snapshot(now = Date.now()): DashboardTelemetrySnapshot {
    const copy = (window: VolumeWindow): VolumeTelemetry => {
      const value = this.volumes.get(window)!;
      return Object.freeze({
        ...value,
        value: value.value?.map((row) => Object.freeze({ ...row })) ?? null,
      });
    };
    const durable = this.historyStore?.snapshot() ?? {
      history: { version: 1 as const, sessions: [], points: [], fills: [] },
      status: { stale: false },
    };
    const merged = new Map(durable.history.fills.map((entry) => [fillIdentity(entry), entry]));
    for (const entry of this.fills) merged.set(fillIdentity(entry), entry);
    const fills = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-10_000);
    let alertHealth: AlertDeliveryHealth;
    try {
      alertHealth = { ...this.readAlertHealth() };
    } catch {
      alertHealth = { enabled: false, attempted: 0, delivered: 0, failed: 0, pending: 0 };
    }
    return Object.freeze({
      startedAt: this.startedAt,
      uptimeMs: this.startedAt === undefined ? undefined : Math.max(0, now - this.startedAt),
      fills: Object.freeze(fills.map((entry) => Object.freeze({ ...entry }))),
      fillsLabel: "current session + durable history" as const,
      volumes: Object.freeze({
        "24h": copy("24h"),
        "7d": copy("7d"),
        "30d": copy("30d"),
        allTime: copy("allTime"),
      }),
      history: Object.freeze(durable.history),
      historyStatus: Object.freeze({ ...durable.status }),
      alertHealth: Object.freeze(alertHealth),
    });
  }

  private async refresh(now: number): Promise<void> {
    if (this.adapter.getAccountTradeHistoryPage) {
      // Only the incremental N1 path throttles all-time scans to once per hour (nextAllTimeAt);
      // the fan-out fallback below keeps requesting all-time unconditionally every cycle, exactly
      // as before the port — it never rescans full history per call, so there's no cost to avoid.
      const includeAllTime = this.supportsAllTime && now >= this.nextAllTimeAt;
      await this.refreshFromTradeHistory(now, includeAllTime);
      return;
    }
    // Capability-gated fallback for adapters without paginated history (Stub, RiseX): still an
    // independent call per window, so the ordering-invariant check and the upfront `partial: true`
    // priming below both remain load-bearing here — unlike the N1 path, these 4 calls are not
    // derived from one shared, monotonically-nested cache, so a real divergence across concurrent
    // fetches is still possible.
    const includeAllTime = this.supportsAllTime;
    const until = new Date(now).toISOString();
    const requested: VolumeWindow[] = [...WINDOWS, ...(includeAllTime ? ["allTime" as const] : [])];
    for (const window of requested) {
      const previous = this.volumes.get(window)!;
      this.volumes.set(window, { ...previous, partial: true });
    }
    const reads = requested.map((window) =>
      this.adapter.getAccountVolume({
        since: new Date(window === "allTime" ? 0 : now - WINDOW_MS[window]).toISOString(),
        until,
      }),
    );
    const allReads = Promise.allSettled(reads);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const results = await Promise.race([
        allReads,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("volume refresh timed out after 5000ms"));
          }, TIMEOUT_MS);
        }),
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      const complete = results.map((result) => {
        if (result.status !== "fulfilled") throw new Error("volume read did not complete");
        return result.value;
      });
      const totals = complete.map((rows) => rows.reduce((sum, row) => sum + row.quoteVolume, 0));
      if (
        totals.some((total) => !Number.isFinite(total) || total < 0) ||
        totals.some((total, index) => index > 0 && total < totals[index - 1]!)
      ) {
        throw new Error("volume scan violated 24H <= 7D <= 30D <= All Time ordering");
      }
      requested.forEach((window, index) => {
        this.volumes.set(window, {
          available: true,
          value: complete[index]!,
          updatedAt: now,
          stale: false,
          partial: false,
        });
      });
      this.failureCount = 0;
      this.nextRefreshAt = now + FIVE_MINUTES;
    } catch (error) {
      const message = String(error);
      for (const window of requested) {
        const previous = this.volumes.get(window)!;
        this.volumes.set(
          window,
          previous.available
            ? { ...previous, stale: true, partial: true, error: message }
            : this.unavailable(`${window} volume unavailable: ${message}`, message),
        );
      }
      this.failureCount++;
      this.nextRefreshAt =
        now + Math.min(ONE_HOUR, FIVE_MINUTES * 2 ** Math.min(this.failureCount - 1, 4));
    } finally {
      if (timer) clearTimeout(timer);
      // A timeout reports failure at five seconds, but the single-flight gate remains held until
      // the underlying adapter promises settle; without cancellation support, releasing it here
      // could overlap a second refresh with calls that are still running.
      if (timedOut) await Promise.allSettled(reads);
    }
  }

  // Incremental, cursor-based path for adapters that expose getAccountTradeHistoryPage() (N1):
  // fetches one bounded page per refresh cycle instead of rescanning full account history from
  // scratch every cycle. Split into two independent scans (see field comments above) so the
  // epoch-anchored all-time backfill — which can legitimately be slow/expensive on a long-lived
  // account — can never delay or fail the 24h/7d/30d windows that drive the live dashboard.
  private async refreshFromTradeHistory(now: number, includeAllTime: boolean): Promise<void> {
    const until = new Date(now).toISOString();
    if (this.recentTradeSince === undefined) {
      this.recentTradeSince = new Date(Math.max(0, now - WINDOW_MS["30d"])).toISOString();
    }
    await this.refreshRecentTradeWindow(now, until);
    this.nextRefreshAt =
      this.failureCount === 0
        ? this.recentTradeCursor
          ? now
          : now + FIVE_MINUTES
        : now + Math.min(ONE_HOUR, FIVE_MINUTES * 2 ** Math.min(this.failureCount - 1, 4));

    if (includeAllTime) {
      await this.refreshAllTimeTradeWindow(now, until);
      this.nextAllTimeAt = now + ONE_HOUR;
    }
  }

  /** Drives the 24h/7d/30d windows. `since` is clamped to a 30-day floor at construction time —
   * never epoch — so this stays a cheap, bounded pull even on a very long-lived account. */
  private async refreshRecentTradeWindow(now: number, until: string): Promise<void> {
    const startedAt = Date.now();
    console.error(
      `[DashboardTelemetry] refreshRecentTradeWindow start since=${this.recentTradeSince} until=${until} cursor=${this.recentTradeCursor ? "present" : "none"}`,
    );
    try {
      const controller = new AbortController();
      const page = await this.withDeadline(
        this.adapter.getAccountTradeHistoryPage!({
          since: this.recentTradeSince!,
          until,
          cursor: this.recentTradeCursor,
          signal: controller.signal,
        }),
        controller,
      );
      console.error(
        `[DashboardTelemetry] refreshRecentTradeWindow getAccountTradeHistoryPage resolved in ${Date.now() - startedAt}ms trades=${page.trades.length} nextCursor=${page.nextCursor ? "present" : "none"}`,
      );
      for (const trade of page.trades) {
        const key =
          trade.tradeId ??
          `${trade.exchangeOrderId}:${trade.timestamp}:${trade.market}:${trade.size}:${trade.price}`;
        this.recentTradeCache.set(key, trade);
      }
      this.recentTradeCursor = page.nextCursor;
      if (!this.recentTradeCursor) {
        const newest = Math.max(
          ...[...this.recentTradeCache.values()].map((trade) => trade.timestamp),
          now,
        );
        this.recentTradeSince = new Date(Math.max(0, newest - 1)).toISOString();
      }
      for (const window of WINDOWS)
        this.setWindowFromCache(
          window,
          this.recentTradeCache,
          now,
          until,
          Boolean(this.recentTradeCursor),
        );
      this.failureCount = 0;
    } catch (error) {
      const message = String(error);
      console.error(
        `[DashboardTelemetry] refreshRecentTradeWindow failed after ${Date.now() - startedAt}ms: ${message}`,
      );
      for (const window of WINDOWS) {
        const previous = this.volumes.get(window)!;
        this.volumes.set(
          window,
          previous.available
            ? { ...previous, stale: true, error: message }
            : this.unavailable(`${window} volume unavailable: ${message}`, message),
        );
      }
      this.failureCount++;
    }
  }

  /** Drives the allTime window only. `since` starts at epoch and only ever advances on the
   * existing hourly-gated cycles (nextAllTimeAt) — a slow or failing page here only marks
   * `allTime` stale/unavailable, and never touches the 24h/7d/30d windows above. */
  private async refreshAllTimeTradeWindow(now: number, until: string): Promise<void> {
    const startedAt = Date.now();
    console.error(
      `[DashboardTelemetry] refreshAllTimeTradeWindow start since=${this.allTimeTradeSince} until=${until} cursor=${this.allTimeTradeCursor ? "present" : "none"}`,
    );
    try {
      const controller = new AbortController();
      const page = await this.withDeadline(
        this.adapter.getAccountTradeHistoryPage!({
          since: this.allTimeTradeSince,
          until,
          cursor: this.allTimeTradeCursor,
          signal: controller.signal,
        }),
        controller,
      );
      console.error(
        `[DashboardTelemetry] refreshAllTimeTradeWindow getAccountTradeHistoryPage resolved in ${Date.now() - startedAt}ms trades=${page.trades.length} nextCursor=${page.nextCursor ? "present" : "none"}`,
      );
      for (const trade of page.trades) {
        const key =
          trade.tradeId ??
          `${trade.exchangeOrderId}:${trade.timestamp}:${trade.market}:${trade.size}:${trade.price}`;
        this.allTimeTradeCache.set(key, trade);
      }
      this.allTimeTradeCursor = page.nextCursor;
      if (!this.allTimeTradeCursor) {
        const newest = Math.max(
          ...[...this.allTimeTradeCache.values()].map((trade) => trade.timestamp),
          now,
        );
        this.allTimeTradeSince = new Date(Math.max(0, newest - 1)).toISOString();
      }
      this.setWindowFromCache(
        "allTime",
        this.allTimeTradeCache,
        now,
        until,
        Boolean(this.allTimeTradeCursor),
      );
    } catch (error) {
      const message = String(error);
      console.error(
        `[DashboardTelemetry] refreshAllTimeTradeWindow failed after ${Date.now() - startedAt}ms: ${message}`,
      );
      const previous = this.volumes.get("allTime")!;
      this.volumes.set(
        "allTime",
        previous.available
          ? { ...previous, stale: true, error: message }
          : this.unavailable(`allTime volume unavailable: ${message}`, message),
      );
    }
  }

  private setWindowFromCache(
    window: VolumeWindow,
    cache: ReadonlyMap<string, NormalizedFill>,
    now: number,
    until: string,
    partial: boolean,
  ): void {
    const start = window === "allTime" ? 0 : now - WINDOW_MS[window];
    const byMarket = new Map<string, AccountVolume>();
    for (const trade of cache.values())
      if (trade.timestamp >= start && trade.timestamp < now) {
        const row = byMarket.get(trade.market) ?? {
          market: trade.market,
          since: new Date(start).toISOString(),
          until,
          baseVolume: 0,
          quoteVolume: 0,
        };
        row.baseVolume += trade.size;
        row.quoteVolume += trade.size * trade.price;
        byMarket.set(trade.market, row);
      }
    this.volumes.set(window, {
      available: true,
      value: [...byMarket.values()],
      updatedAt: now,
      stale: false,
      partial,
    });
  }

  private async withDeadline<T>(promise: Promise<T>, controller?: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            controller?.abort();
            reject(new Error("volume refresh timed out after 5000ms"));
          }, TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private unavailable(sourceNeeded: string, error?: string): VolumeTelemetry {
    return { available: false, value: null, stale: false, partial: false, sourceNeeded, error };
  }
}
