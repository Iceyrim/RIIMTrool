import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { DashboardStatus } from "./DashboardService.js";

export type SnapshotLifecycle = "running" | "stopped";

export interface DashboardSessionSnapshot {
  version: 1;
  sessionId: string;
  exchangeId: string;
  lifecycle: SnapshotLifecycle;
  startedAt: number;
  publishedAt: number;
  status: DashboardStatus;
}

export interface DashboardSidecarStatus extends DashboardStatus {
  snapshotSources: Array<Pick<DashboardSessionSnapshot, "sessionId" | "exchangeId" | "lifecycle" | "startedAt" | "publishedAt"> & { stale: boolean }>;
  snapshotConflicts: Array<{ exchangeId: string; sessionIds: string[] }>;
}

export const SNAPSHOT_PUBLISH_INTERVAL_MS = 2_000;
export const SNAPSHOT_FRESH_MS = 10_000;
export const SNAPSHOT_MAX_FILES_PER_EXCHANGE = 20;
export const SNAPSHOT_FILE_MODE = 0o640;
export const SNAPSHOT_DIRECTORY_MODE = 0o2770;

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isSnapshot(value: unknown): value is DashboardSessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<DashboardSessionSnapshot>;
  return row.version === 1 && typeof row.sessionId === "string" &&
    typeof row.exchangeId === "string" && (row.lifecycle === "running" || row.lifecycle === "stopped") &&
    typeof row.startedAt === "number" && typeof row.publishedAt === "number" &&
    !!row.status && typeof row.status === "object" && Array.isArray(row.status.accounts) &&
    Array.isArray(row.status.markets);
}

/** Publishes cached runner state only. Writes are atomic and never call an adapter. */
export class DashboardSnapshotPublisher {
  readonly sessionId: string;
  private readonly startedAt: number;
  private readonly filePath: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly directory: string,
    private readonly exchangeId: string,
    private readonly readStatus: () => DashboardStatus,
    options: { sessionId?: string; startedAt?: number } = {},
  ) {
    this.startedAt = options.startedAt ?? Date.now();
    this.sessionId = options.sessionId ?? `${this.startedAt}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.filePath = join(directory, `${safePart(exchangeId)}--${safePart(this.sessionId)}.json`);
  }

  start(): void {
    this.publish("running");
    this.timer = setInterval(() => this.publish("running"), SNAPSHOT_PUBLISH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.publish("stopped");
  }

  publish(lifecycle: SnapshotLifecycle, now = Date.now()): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: SNAPSHOT_DIRECTORY_MODE });
      const snapshot: DashboardSessionSnapshot = {
        version: 1,
        sessionId: this.sessionId,
        exchangeId: this.exchangeId,
        lifecycle,
        startedAt: this.startedAt,
        publishedAt: now,
        status: this.readStatus(),
      };
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: SNAPSHOT_FILE_MODE });
      chmodSync(temporary, SNAPSHOT_FILE_MODE);
      renameSync(temporary, this.filePath);
      this.prune();
    } catch (error) {
      console.error(`[DashboardSnapshot] publication failed: ${String(error)}`);
    }
  }

  private prune(): void {
    const prefix = `${safePart(this.exchangeId)}--`;
    const files = readdirSync(this.directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .map((name) => ({ path: join(this.directory, name), modified: statSync(join(this.directory, name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    for (const old of files.slice(SNAPSHOT_MAX_FILES_PER_EXCHANGE)) unlinkSync(old.path);
  }
}

export function readDashboardSnapshots(directory: string): DashboardSessionSnapshot[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json") && !basename(name).includes(".tmp"))
      .flatMap((name) => {
        try {
          const parsed: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
          return isSnapshot(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function aggregateDashboardSnapshots(
  snapshots: readonly DashboardSessionSnapshot[],
  now = Date.now(),
): DashboardSidecarStatus {
  const groups = new Map<string, DashboardSessionSnapshot[]>();
  for (const snapshot of snapshots) {
    const group = groups.get(snapshot.exchangeId) ?? [];
    group.push(snapshot);
    groups.set(snapshot.exchangeId, group);
  }

  const selected: DashboardSessionSnapshot[] = [];
  const snapshotConflicts: DashboardSidecarStatus["snapshotConflicts"] = [];
  for (const [exchangeId, group] of groups) {
    const freshRunning = group.filter((entry) => entry.lifecycle === "running" && now - entry.publishedAt <= SNAPSHOT_FRESH_MS);
    if (freshRunning.length > 1) {
      snapshotConflicts.push({ exchangeId, sessionIds: freshRunning.map((entry) => entry.sessionId).sort() });
      continue;
    }
    const newest = [...group].sort((a, b) => b.startedAt - a.startedAt || b.publishedAt - a.publishedAt)[0];
    if (freshRunning.length === 1 && freshRunning[0]!.startedAt >= (newest?.startedAt ?? 0)) selected.push(freshRunning[0]!);
    else if (newest) selected.push(newest);
  }

  const accounts = selected.flatMap((entry) => entry.status.accounts);
  const markets = selected.flatMap((entry) => entry.status.markets);
  const first = accounts[0];
  return {
    generatedAt: now,
    totalExposureUsd: markets.reduce((sum, market) => sum + (market.position?.notionalUsd ?? 0), 0),
    accountSessionRealizedPnlUsd: first?.sessionRealizedPnlUsd ?? 0,
    accountSessionLossCapUsd: first?.sessionLossCapUsd ?? 0,
    accountPnlAvailable: first?.pnlAvailable ?? false,
    accounts,
    markets,
    unavailableTelemetry: [
      ...new Set(selected.flatMap((entry) => entry.status.unavailableTelemetry)),
      ...snapshotConflicts.map(({ exchangeId }) => `${exchangeId}: conflicting fresh running sessions; neither snapshot is displayed.`),
      ...selected.filter((entry) => entry.lifecycle === "running" && now - entry.publishedAt > SNAPSHOT_FRESH_MS)
        .map((entry) => `${entry.exchangeId}: running snapshot is stale.`),
    ],
    snapshotSources: selected.map((entry) => ({
      sessionId: entry.sessionId,
      exchangeId: entry.exchangeId,
      lifecycle: entry.lifecycle,
      startedAt: entry.startedAt,
      publishedAt: entry.publishedAt,
      stale: entry.lifecycle === "running" && now - entry.publishedAt > SNAPSHOT_FRESH_MS,
    })),
    snapshotConflicts,
  };
}
