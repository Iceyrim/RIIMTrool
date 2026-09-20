import { existsSync, readFileSync, rmSync } from "node:fs";
import type { MarketsConfig } from "../config/schema.js";

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
