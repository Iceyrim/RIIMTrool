import { existsSync, readFileSync, rmSync } from "node:fs";
import type { MarketsConfig } from "../config/schema.js";

export function consumePerplLiveArmFile(
  path: string,
  todayUtc = new Date().toISOString().slice(0, 10),
): void {
  if (!existsSync(path)) throw new Error(`Perpl Live arm file not found at "${path}"`);
  const value = readFileSync(path, "utf8").trim();
  rmSync(path);
  if (value !== todayUtc)
    throw new Error(
      `Perpl Live arm file contained "${value}", expected "${todayUtc}"; it was consumed`,
    );
}

export function requirePerplLiveCliFlag(argv: readonly string[]): void {
  if (!argv.includes("--i-understand-this-places-real-orders"))
    throw new Error("missing --i-understand-this-places-real-orders");
}

export function estimatePerplRestingNotional(
  markets: MarketsConfig["markets"],
  marks: ReadonlyMap<string, number>,
): number {
  return markets.reduce((total, market) => {
    const mark = marks.get(market.symbol);
    if (!mark || !Number.isFinite(mark))
      throw new Error(`fresh mark unavailable for ${market.symbol}`);
    return total + (2 * market.quoteLevels * market.orderSize.max * mark) / (market.leverage ?? 1);
  }, 0);
}

export function assertPerplLiveCapacity(input: {
  availableBalance: number;
  lockedBalance: number;
  estimatedRestingNotional: number;
  configuredOpenOrders: number;
  workerOpenOrderCap: number;
}): void {
  if (input.lockedBalance !== 0) throw new Error("preflight requires zero locked balance");
  if (input.configuredOpenOrders > input.workerOpenOrderCap)
    throw new Error("configured quote ladder exceeds worker open-order cap");
  if (input.estimatedRestingNotional > input.availableBalance) {
    throw new Error(
      `insufficient 1x collateral: ladder needs approximately $${input.estimatedRestingNotional.toFixed(2)}, available $${input.availableBalance.toFixed(2)}`,
    );
  }
}
