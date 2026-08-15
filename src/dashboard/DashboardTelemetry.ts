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
  private nextAllTimeAt = 0;
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

  recordAccountPoint(point: HistoryPoint): void {
    try { this.historyStore?.recordPoint(point); }
    catch (error) { console.error(`[DashboardTelemetry] history publication failed: ${String(error)}`); }
  }

  /** Starts work and returns immediately. Trading cycles never await telemetry. */
  refreshIfDue(now = Date.now()): void {
    if (this.refreshInFlight || now < this.nextRefreshAt) return;
    this.refreshInFlight = true;
    const includeAllTime = this.supportsAllTime && now >= this.nextAllTimeAt;
    void this.refresh(now, includeAllTime).finally(() => { this.refreshInFlight = false; });
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

  private async refresh(now: number, includeAllTime: boolean): Promise<void> {
    const until = new Date(now).toISOString();
    const requested: VolumeWindow[] = [...WINDOWS, ...(includeAllTime ? ["allTime" as const] : [])];
    const reads = requested.map((window) => this.adapter.getAccountVolume({
      since: new Date(window === "allTime" ? 0 : now - WINDOW_MS[window]).toISOString(),
      until,
    }));
    const allReads = Promise.allSettled(reads);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const results = await Promise.race([
        allReads,
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error("volume refresh timed out after 5000ms")); }, TIMEOUT_MS); }),
      ]);
      let failed = false;
      requested.forEach((window, index) => {
        const result = results[index]!;
        if (result.status === "fulfilled") {
          this.volumes.set(window, { available: true, value: result.value, updatedAt: now, stale: false });
          return;
        }
        failed = true;
        const message = String(result.reason);
        const previous = this.volumes.get(window)!;
        this.volumes.set(window, window === "allTime"
          ? this.unavailable(`All-time volume unavailable: ${message}`, message)
          : previous.available ? { ...previous, stale: true, error: message } : this.unavailable(`${window} volume unavailable: ${message}`, message));
      });
      this.failureCount = failed ? this.failureCount + 1 : 0;
      this.nextRefreshAt = now + (failed
        ? Math.min(ONE_HOUR, FIVE_MINUTES * 2 ** Math.min(this.failureCount - 1, 4))
        : FIVE_MINUTES);
      if (includeAllTime) this.nextAllTimeAt = now + ONE_HOUR;
    } catch (error) {
      const message = String(error);
      for (const window of requested) {
        const previous = this.volumes.get(window)!;
        this.volumes.set(window, window === "allTime"
          ? this.unavailable(`All-time volume unavailable: ${message}`, message)
          : previous.available
          ? { ...previous, stale: true, error: message }
          : this.unavailable(`${window} volume unavailable: ${message}`, message));
      }
      this.failureCount++;
      this.nextRefreshAt = now + Math.min(ONE_HOUR, FIVE_MINUTES * 2 ** Math.min(this.failureCount - 1, 4));
      if (includeAllTime) this.nextAllTimeAt = now + ONE_HOUR;
    } finally {
      if (timer) clearTimeout(timer);
      // A timeout reports failure at five seconds, but the single-flight gate remains held until
      // the underlying adapter promises settle; without cancellation support, releasing it here
      // could overlap a second refresh with calls that are still running.
      if (timedOut) await Promise.allSettled(reads);
    }
  }

  private unavailable(sourceNeeded: string, error?: string): VolumeTelemetry {
    return { available: false, value: null, stale: false, sourceNeeded, error };
  }
}
