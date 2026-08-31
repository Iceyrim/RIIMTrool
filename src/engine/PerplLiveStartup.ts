import { existsSync, readFileSync, rmSync } from "node:fs";
import type { MarketsConfig } from "../config/schema.js";

export function consumePerplLiveArmFile(path: string, todayUtc = new Date().toISOString().slice(0, 10)): void {
  if (!existsSync(path)) throw new Error(`Perpl Live arm file not found at "${path}"`);
  const value = readFileSync(path, "utf8").trim();
  rmSync(path);
  if (value !== todayUtc) throw new Error(`Perpl Live arm file contained "${value}", expected "${todayUtc}"; it was consumed`);
}

export function requirePerplLiveCliFlag(argv: readonly string[]): void {
  if (!argv.includes("--i-understand-this-places-real-orders")) throw new Error("missing --i-understand-this-places-real-orders");
}

export function estimatePerplRestingNotional(
  markets: MarketsConfig["markets"],
  marks: ReadonlyMap<string, number>,
): number {
  return markets.reduce((total, market) => {
    const mark = marks.get(market.symbol);
    if (!mark || !Number.isFinite(mark)) throw new Error(`fresh mark unavailable for ${market.symbol}`);
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
  if (input.configuredOpenOrders > input.workerOpenOrderCap) throw new Error("configured quote ladder exceeds worker open-order cap");
  if (input.estimatedRestingNotional > input.availableBalance) {
    throw new Error(`insufficient 1x collateral: ladder needs approximately $${input.estimatedRestingNotional.toFixed(2)}, available $${input.availableBalance.toFixed(2)}`);
  }
}

export function estimatePerplGasReserveMon(
  gasPriceWei: bigint,
  gasLimit: bigint,
  minimumActions: number,
): number {
  if (gasPriceWei <= 0n || gasLimit <= 0n || !Number.isSafeInteger(minimumActions) || minimumActions < 1)
    throw new Error("invalid Perpl gas-reserve inputs");
  return Number(gasPriceWei * gasLimit * BigInt(minimumActions)) / 1e18;
}

export function planPerplShutdownChunks(input: {
  positionBaseSize: number;
  limitPrice: number;
  maxOrderSize: number;
  maxNotionalUsd: number;
  sizeDecimals: number;
  maxActions?: number;
}): number[] {
  const { positionBaseSize, limitPrice, maxOrderSize, maxNotionalUsd, sizeDecimals } = input;
  const maxActions = input.maxActions ?? 10;
  if (
    ![positionBaseSize, limitPrice, maxOrderSize, maxNotionalUsd].every(Number.isFinite) ||
    limitPrice <= 0 || maxOrderSize <= 0 || maxNotionalUsd <= 0 ||
    !Number.isSafeInteger(sizeDecimals) || sizeDecimals < 0 || sizeDecimals > 8 ||
    !Number.isSafeInteger(maxActions) || maxActions < 1
  ) throw new Error("invalid Perpl shutdown flattening limits");
  const unit = 10 ** sizeDecimals;
  let remainingUnits = Math.round(Math.abs(positionBaseSize) * unit);
  const maxUnits = Math.floor(Math.min(maxOrderSize, maxNotionalUsd / limitPrice) * unit + 1e-9);
  if (remainingUnits === 0) return [];
  if (maxUnits < 1) throw new Error("Perpl shutdown flattening cap is below one size unit");
  const chunks: number[] = [];
  while (remainingUnits > 0 && chunks.length < maxActions) {
    const units = Math.min(remainingUnits, maxUnits);
    chunks.push(units / unit);
    remainingUnits -= units;
  }
  if (remainingUnits > 0)
    throw new Error("Perpl shutdown position exceeds bounded flattening action capacity");
  return chunks;
}
