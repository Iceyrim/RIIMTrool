import { existsSync, readFileSync, rmSync } from "node:fs";
import type { MarketsConfig } from "../config/schema.js";

export interface QfexMarketPriceReader {
  getMarketPrice(market: string): Promise<{ mark: number }>;
}

export interface QfexConfirmedVolumeRow {
  quoteVolume: number;
}

export function qfexUtcDayWindow(now = new Date()): { since: string; until: string } {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid QFEX daily-volume timestamp");
  const day = now.toISOString().slice(0, 10);
  return { since: `${day}T00:00:00.000Z`, until: now.toISOString() };
}

export function totalQfexConfirmedVolume(rows: readonly QfexConfirmedVolumeRow[]): number {
  return rows.reduce((total, row) => {
    if (!Number.isFinite(row.quoteVolume) || row.quoteVolume < 0)
      throw new Error("invalid QFEX confirmed quote volume");
    return total + row.quoteVolume;
  }, 0);
}

export function isQfexDailyVolumeTargetReached(volumeUsd: number, targetUsd: number): boolean {
  if (!Number.isFinite(volumeUsd) || volumeUsd < 0 || !Number.isFinite(targetUsd) || targetUsd <= 0)
    throw new Error("invalid QFEX daily-volume target inputs");
  return volumeUsd >= targetUsd;
}

export async function waitForQfexMarketMarks(
  reader: QfexMarketPriceReader,
  markets: readonly string[],
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<Map<string, number>> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("invalid QFEX market readiness timing");
  }
  const pending = new Set(markets);
  const marks = new Map<string, number>();
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    for (const market of Array.from(pending)) {
      try {
        const { mark } = await reader.getMarketPrice(market);
        if (!Number.isFinite(mark) || mark <= 0) throw new Error(`invalid QFEX mark for ${market}`);
        marks.set(market, mark);
        pending.delete(market);
      } catch (error) {
        const retryable = error instanceof Error && "retryable" in error && (error as Error & { retryable?: unknown }).retryable === true;
        if (!retryable) throw error;
      }
    }
    if (pending.size === 0) return marks;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`Timed out waiting for fresh QFEX marks: ${Array.from(pending).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }
  return marks;
}

export function requireQfexLiveCliFlag(argv: readonly string[]): void {
  if (!argv.includes("--i-understand-this-places-real-orders")) throw new Error("missing --i-understand-this-places-real-orders");
}
export function consumeQfexLiveArmFile(path: string, today = new Date().toISOString().slice(0, 10)): void {
  if (!existsSync(path)) throw new Error(`QFEX live arm file not found at "${path}"`);
  const value = readFileSync(path, "utf8").trim();
  rmSync(path);
  if (value !== today) throw new Error(`QFEX live arm file contained "${value}", expected "${today}"; it was consumed`);
}
export function estimateQfexInitialMargin(markets: MarketsConfig["markets"], marks: ReadonlyMap<string, number>): number {
  return markets.reduce((total, market) => {
    const mark = marks.get(market.symbol);
    if (!mark || !Number.isFinite(mark)) throw new Error(`fresh mark unavailable for ${market.symbol}`);
    const leverage = market.leverage ?? 1;
    return total + (2 * market.quoteLevels * market.orderSize.max * mark) / leverage;
  }, 0);
}
export function assertQfexPreflight(input: { flat: boolean; openOrderCount: number; availableCollateral: number; estimatedInitialMargin: number; marginSafe: boolean }): void {
  if (!input.flat) throw new Error("startup requires flat configured markets");
  if (input.openOrderCount !== 0) throw new Error("startup requires no existing configured-market orders");
  if (!input.marginSafe) throw new Error("QFEX account margin status is unsafe");
  if (input.estimatedInitialMargin > input.availableCollateral) throw new Error(`insufficient collateral: ladder needs approximately $${input.estimatedInitialMargin.toFixed(2)}, available $${input.availableCollateral.toFixed(2)}`);
}
export function planQfexFlattenChunks(position: number, maxOrderSize: number, maxActions = 100): number[] {
  if (![position, maxOrderSize].every(Number.isFinite) || maxOrderSize <= 0 || !Number.isSafeInteger(maxActions) || maxActions < 1) throw new Error("invalid QFEX flattening inputs");
  let remaining = Math.abs(position);
  const chunks: number[] = [];
  while (remaining > 1e-12 && chunks.length < maxActions) {
    const size = Math.min(remaining, maxOrderSize);
    chunks.push(size);
    remaining -= size;
  }
  if (remaining > 1e-12) throw new Error("QFEX position exceeds bounded flattening action capacity");
  return chunks;
}
