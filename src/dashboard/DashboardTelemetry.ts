import type { AccountVolume, ExchangeAdapter } from "../adapters/ExchangeAdapter.js";
import type { TradeLogEntry } from "../engine/TradeLog.js";
import type { AlertDeliveryHealth } from "../alerting/TelegramAlertSink.js";
import { fillIdentity, type DashboardHistoryStore, type HistoryPoint, type HistorySnapshot, type HistoryStoreStatus } from "./DashboardHistoryStore.js";

export type VolumeWindow = "24h" | "7d" | "30d" | "allTime";

export interface VolumeTelemetry {
  available: boolean;
  value: AccountVolume[] | null;
  updatedAt?: number;
  stale: boolean;
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
const WINDOW_MS = { "24h": 24 * 60 * 60_000, "7d": 7 * 24 * 60 * 60_000, "30d": 30 * 24 * 60 * 60_000 };

/** Runner-owned publisher. Dashboard readers only receive cloned, immutable cached snapshots. */
export class DashboardTelemetry {
  private startedAt?: number;
  private readonly fills: TradeLogEntry[] = [];
  private readonly volumes = new Map<VolumeWindow, VolumeTelemetry>();
  private refreshInFlight = false;
  private nextRefreshAt = 0;
  private nextAccountSampleAt = 0;
  private failureCount = 0;

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly supportsAllTime: boolean,
    private readonly maxRecentFills = 100,
    private readonly historyStore?: DashboardHistoryStore,
    private readonly readAlertHealth: () => AlertDeliveryHealth = () => ({ enabled: false, attempted: 0, delivered: 0, failed: 0, pending: 0 }),
  ) {
    for (const window of WINDOWS) this.volumes.set(window, this.unavailable(`No cached ${window} volume has been published yet.`));
    this.volumes.set("allTime", supportsAllTime
      ? this.unavailable("No cached all-time volume has been published yet.")
      : this.unavailable("All-time volume is unsupported: paper history is limited to the current process session."));
    this.historyStore?.startSession(`${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  markStarted(now = Date.now()): void {
    if (this.startedAt === undefined) this.startedAt = now;
  }

  recordFill(entry: TradeLogEntry): void {
    try {
      this.fills.push(Object.freeze({ ...entry }));
      if (this.fills.length > this.maxRecentFills) this.fills.splice(0, this.fills.length - this.maxRecentFills);
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
      ? volume.value?.reduce((sum, row) => sum + row.quoteVolume, 0) ?? null
      : null;
    const point: HistoryPoint = { timestamp: now, realizedPnlUsd, quoteVolume };
    try { this.historyStore?.recordPoint(point); }
    catch (error) { console.error(`[DashboardTelemetry] history publication failed: ${String(error)}`); }
  }

  /** Starts work and returns immediately. Trading cycles never await telemetry. */
  refreshIfDue(now = Date.now()): void {
    if (this.refreshInFlight || now < this.nextRefreshAt) return;
    this.refreshInFlight = true;
    void this.refresh(now).finally(() => { this.refreshInFlight = false; });
  }

  snapshot(now = Date.now()): DashboardTelemetrySnapshot {
    const copy = (window: VolumeWindow): VolumeTelemetry => {
      const value = this.volumes.get(window)!;
      return Object.freeze({ ...value, value: value.value?.map((row) => Object.freeze({ ...row })) ?? null });
    };
    const durable = this.historyStore?.snapshot() ?? { history: { version: 1 as const, sessions: [], points: [], fills: [] }, status: { stale: false } };
    const merged = new Map(durable.history.fills.map((entry) => [fillIdentity(entry), entry]));
    for (const entry of this.fills) merged.set(fillIdentity(entry), entry);
    const fills = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-10_000);
    let alertHealth: AlertDeliveryHealth;
    try { alertHealth = { ...this.readAlertHealth() }; } catch { alertHealth = { enabled: false, attempted: 0, delivered: 0, failed: 0, pending: 0 }; }
    return Object.freeze({
      startedAt: this.startedAt,
      uptimeMs: this.startedAt === undefined ? undefined : Math.max(0, now - this.startedAt),
      fills: Object.freeze(fills.map((entry) => Object.freeze({ ...entry }))),
      fillsLabel: "current session + durable history" as const,
      volumes: Object.freeze({ "24h": copy("24h"), "7d": copy("7d"), "30d": copy("30d"), allTime: copy("allTime") }),
      history: Object.freeze(durable.history),
      historyStatus: Object.freeze({ ...durable.status }),
      alertHealth: Object.freeze(alertHealth),
    });
  }

  private async refresh(now: number): Promise<void> {
    const until = new Date(now).toISOString();
    const requested: VolumeWindow[] = [...WINDOWS, ...(this.supportsAllTime ? ["allTime" as const] : [])];
    const batched = this.adapter as ExchangeAdapter & {
      getAccountVolumeWindows?: (requests: Array<{ window: VolumeWindow; since: string; until: string }>) => Promise<Partial<Record<VolumeWindow, AccountVolume[]>>>;
    };
    const requests = requested.map((window) => ({
      window,
      since: new Date(window === "allTime" ? 0 : now - WINDOW_MS[window]).toISOString(),
      until,
    }));
    if (batched.getAccountVolumeWindows) {
      await this.refreshBatched(batched as Required<Pick<typeof batched, "getAccountVolumeWindows">> & ExchangeAdapter, requests, now);
      return;
    }
    const reads = requests.map(({ since, until: requestUntil }) => this.adapter.getAccountVolume({ since, until: requestUntil }));
    const allReads = Promise.allSettled(reads);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const results = await Promise.race([
        allReads,
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error("volume refresh timed out after 5000ms")); }, TIMEOUT_MS); }),
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      const complete = results.map((result) => {
        if (result.status !== "fulfilled") throw new Error("volume read did not complete");
        return result.value;
      });
      const totals = complete.map((rows) => rows.reduce((sum, row) => sum + row.quoteVolume, 0));
      if (totals.some((total) => !Number.isFinite(total) || total < 0)
        || totals.some((total, index) => index > 0 && total < totals[index - 1]!)) {
        throw new Error("volume scan violated 24H <= 7D <= 30D <= All Time ordering");
      }
      requested.forEach((window, index) => {
        this.volumes.set(window, { available: true, value: complete[index]!, updatedAt: now, stale: false });
      });
      this.failureCount = 0;
      this.nextRefreshAt = now + FIVE_MINUTES;
    } catch (error) {
      const message = String(error);
      for (const window of requested) {
        const previous = this.volumes.get(window)!;
        this.volumes.set(window, previous.available
          ? { ...previous, stale: true, error: message }
          : this.unavailable(`${window} volume unavailable: ${message}`, message));
      }
      this.failureCount++;
      this.nextRefreshAt = now + Math.min(ONE_HOUR, FIVE_MINUTES * 2 ** Math.min(this.failureCount - 1, 4));
    } finally {
      if (timer) clearTimeout(timer);
      // A timeout reports failure at five seconds, but the single-flight gate remains held until
      // the underlying adapter promises settle; without cancellation support, releasing it here
      // could overlap a second refresh with calls that are still running.
      if (timedOut) await Promise.allSettled(reads);
    }
  }

  private async refreshBatched(
    adapter: ExchangeAdapter & { getAccountVolumeWindows: (requests: Array<{ window: VolumeWindow; since: string; until: string }>) => Promise<Partial<Record<VolumeWindow, AccountVolume[]>>> },
    requests: Array<{ window: VolumeWindow; since: string; until: string }>,
    now: number,
  ): Promise<void> {
    const bounded = requests.filter(({ window }) => window !== "allTime");
    const allTime = requests.find(({ window }) => window === "allTime");
    const boundedJob = this.withTimeout(adapter.getAccountVolumeWindows(bounded));
    const allTimeJob = allTime
      ? this.withTimeout(this.adapter.getAccountVolume({ since: allTime.since, until: allTime.until }))
      : Promise.resolve(undefined);
    const [boundedResult, allTimeResult] = await Promise.allSettled([boundedJob, allTimeJob]);
    let failures = 0;
    if (boundedResult.status === "fulfilled") {
      for (const { window } of bounded) {
        const rows = boundedResult.value[window];
        if (rows) this.volumes.set(window, { available: true, value: rows, updatedAt: now, stale: false });
        else { failures++; this.applyVolumeFailure(window, "RISEx API did not return this volume window", now); }
      }
    } else {
      failures += bounded.length;
      for (const { window } of bounded) this.applyVolumeFailure(window, String(boundedResult.reason), now);
    }
    if (allTime) {
      if (allTimeResult.status === "fulfilled" && allTimeResult.value)
        this.volumes.set("allTime", { available: true, value: allTimeResult.value, updatedAt: now, stale: false });
      else {
        failures++;
        this.applyVolumeFailure("allTime", allTimeResult.status === "rejected" ? String(allTimeResult.reason) : "RISEx API did not return all-time volume", now);
      }
    }
    this.failureCount = failures ? this.failureCount + 1 : 0;
    this.nextRefreshAt = now + (failures ? Math.min(ONE_HOUR, FIVE_MINUTES * 2 ** Math.min(this.failureCount - 1, 4)) : FIVE_MINUTES);
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("volume refresh timed out after 5000ms")), TIMEOUT_MS)),
    ]);
  }

  private applyVolumeFailure(window: VolumeWindow, message: string, now: number): void {
    const previous = this.volumes.get(window)!;
    if (previous.available) {
      this.volumes.set(window, { ...previous, stale: true, error: message });
      return;
    }
    const durable = this.durableVolume(window, now);
    this.volumes.set(window, durable.length
      ? { available: true, value: durable, updatedAt: now, stale: true, error: `Durable confirmed-fill fallback (up to 90 days): ${message}` }
      : this.unavailable(`${window} volume unavailable: ${message}`, message));
  }

  private durableVolume(window: VolumeWindow, now: number): AccountVolume[] {
    const sinceMs = window === "allTime" ? now - 90 * 24 * 60 * 60_000 : now - WINDOW_MS[window];
    const fills = this.historyStore?.snapshot().history.fills ?? [];
    const unique = new Map<string, TradeLogEntry>();
    for (const fill of fills)
      if (fill.timestamp >= sinceMs && fill.timestamp <= now) unique.set(fillIdentity(fill), fill);
    const totals = new Map<string, { base: number; quote: number }>();
    for (const fill of unique.values()) {
      const total = totals.get(fill.market) ?? { base: 0, quote: 0 };
      total.base += Math.abs(fill.size);
      total.quote += Math.abs(fill.size * fill.price);
      totals.set(fill.market, total);
    }
    return [...totals].map(([market, total]) => ({
      market,
      since: new Date(sinceMs).toISOString(),
      until: new Date(now).toISOString(),
      baseVolume: total.base,
      quoteVolume: total.quote,
    }));
  }

  private unavailable(sourceNeeded: string, error?: string): VolumeTelemetry {
    return { available: false, value: null, stale: false, sourceNeeded, error };
  }
}
