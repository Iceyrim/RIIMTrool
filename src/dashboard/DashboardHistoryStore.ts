import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TradeLogEntry } from "../engine/TradeLog.js";

export const DASHBOARD_HISTORY_MAX_BYTES = 25 * 1024 * 1024;
const RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_FILLS = 10_000;
const MAX_POINTS = Math.ceil(RETENTION_MS / (5 * 60_000));
const MAX_SESSIONS = 2_000;
const MAX_QUARANTINES = 3;

export interface HistoryPoint { timestamp: number; realizedPnlUsd: number; quoteVolume: number | null }
export interface SessionSummary { id: string; startedAt: number; lastSeenAt: number }
export interface HistorySnapshot {
  version: 1;
  sessions: SessionSummary[];
  points: HistoryPoint[];
  fills: TradeLogEntry[];
}
export interface HistoryStoreStatus {
  stale: boolean;
  error?: string;
  recoveredAt?: number;
  updatedAt?: number;
}

const emptySnapshot = (): HistorySnapshot => ({ version: 1, sessions: [], points: [], fills: [] });

export function fillIdentity(fill: TradeLogEntry): string {
  return fill.tradeId ?? [fill.exchangeOrderId, fill.timestamp, fill.market, fill.side, fill.price, fill.size].join(":");
}

/** Best-effort observability persistence. Every public method contains its own failures. */
export class DashboardHistoryStore {
  private data = emptySnapshot();
  private statusValue: HistoryStoreStatus = { stale: false };
  private readonly filePath: string;

  constructor(rootDir: string, venueMode: string) {
    const safeName = venueMode.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    this.filePath = join(rootDir, `${safeName}.json`);
    this.load();
  }

  snapshot(): { history: HistorySnapshot; status: HistoryStoreStatus } {
    return { history: structuredClone(this.data), status: { ...this.statusValue } };
  }

  startSession(id: string, now = Date.now()): void {
    this.mutate(() => this.data.sessions.push({ id, startedAt: now, lastSeenAt: now }), now);
  }

  recordFill(fill: TradeLogEntry, now = Date.now()): void {
    this.mutate(() => {
      const key = fillIdentity(fill);
      if (!this.data.fills.some((entry) => fillIdentity(entry) === key)) this.data.fills.push({ ...fill });
    }, now);
  }

  recordPoint(point: HistoryPoint): void {
    try {
      const last = this.data.points.at(-1);
      if (last && point.timestamp - last.timestamp < 5 * 60_000) return;
      this.data.points.push({ ...point });
      const session = this.data.sessions.at(-1);
      if (session) session.lastSeenAt = point.timestamp;
      this.prune(point.timestamp);
      this.persist(point.timestamp);
    } catch (error) { this.statusValue = { ...this.statusValue, stale: true, error: String(error) }; }
  }

  private mutate(change: () => void, now: number): void {
    try { change(); this.prune(now); this.persist(now); }
    catch (error) { this.statusValue = { ...this.statusValue, stale: true, error: String(error) }; }
  }

  private prune(now: number): void {
    const cutoff = now - RETENTION_MS;
    this.data.sessions = this.data.sessions.filter((x) => x.lastSeenAt >= cutoff).slice(-MAX_SESSIONS);
    this.data.points = this.data.points.filter((x) => x.timestamp >= cutoff).slice(-MAX_POINTS);
    this.data.fills = this.data.fills.filter((x) => x.timestamp >= cutoff).slice(-MAX_FILLS);
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      this.data = this.readValidated(this.filePath);
      this.prune(Date.now());
    } catch (error) {
      this.quarantine();
      try {
        this.data = this.readValidated(`${this.filePath}.bak`);
        this.prune(Date.now());
        this.statusValue = { stale: true, error: String(error), recoveredAt: Date.now() };
      } catch {
        this.statusValue = { stale: true, error: String(error) };
        this.data = emptySnapshot();
      }
    }
  }

  private readValidated(path: string): HistorySnapshot {
    if (statSync(path).size > DASHBOARD_HISTORY_MAX_BYTES) throw new Error("history exceeds 25 MiB limit");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as HistorySnapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.points) || !Array.isArray(parsed.fills)) throw new Error("invalid history schema");
    return parsed;
  }

  private persist(now: number): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const encoded = JSON.stringify(this.data);
    if (Buffer.byteLength(encoded) > DASHBOARD_HISTORY_MAX_BYTES) throw new Error("history exceeds 25 MiB limit");
    const temp = `${this.filePath}.tmp`;
    const writeFd = openSync(temp, "w");
    try { requireWrite(writeFd, encoded); fsyncSync(writeFd); } finally { closeSync(writeFd); }
    if (existsSync(this.filePath)) copyFileSync(this.filePath, `${this.filePath}.bak`);
    renameSync(temp, this.filePath);
    try { const dirFd = openSync(dirname(this.filePath), "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch { /* unsupported on some platforms */ }
    this.statusValue = { stale: false, updatedAt: now, recoveredAt: this.statusValue.recoveredAt };
  }

  private quarantine(): void {
    try {
      const dir = dirname(this.filePath); mkdirSync(dir, { recursive: true });
      for (let i = MAX_QUARANTINES - 1; i >= 1; i--) {
        const from = `${this.filePath}.corrupt.${i}`; const to = `${this.filePath}.corrupt.${i + 1}`;
        if (existsSync(from)) copyFileSync(from, to);
      }
      copyFileSync(this.filePath, `${this.filePath}.corrupt.1`);
      const overflow = `${this.filePath}.corrupt.${MAX_QUARANTINES + 1}`;
      if (existsSync(overflow)) unlinkSync(overflow);
    } catch { /* quarantine must also fail open */ }
  }
}

function requireWrite(fd: number, value: string): void {
  const buffer = Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}
