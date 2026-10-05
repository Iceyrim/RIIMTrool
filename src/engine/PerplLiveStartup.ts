import { existsSync, readFileSync, rmSync } from "node:fs";
import type { CancelOrderResult, NormalizedOrder } from "../adapters/ExchangeAdapter.js";
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

export interface PerplShutdownOrderSweepResult {
  attempted: string[];
  cancelled: string[];
  failed: string[];
  unresolved: string[];
  messages: string[];
  successful: boolean;
}

export async function cancelAllPerplConfiguredMarketOrders(input: {
  markets: readonly string[];
  source: { connect(): Promise<void>; getOpenOrders(market?: string): NormalizedOrder[] };
  canceller: { cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult>; refreshAccountState(): Promise<void> };
  maxAttempts?: number;
}): Promise<PerplShutdownOrderSweepResult> {
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new Error("invalid Perpl shutdown order-sweep attempt count");
  const attempted = new Set<string>();
  const cancelled = new Set<string>();
  const failed = new Set<string>();
  const messages: string[] = [];
  await input.source.connect();
  for (let round = 0; round < maxAttempts; round++) {
    const open = input.markets.flatMap((market) => input.source.getOpenOrders(market));
    if (open.length === 0) break;
    for (const order of open) {
      const key = order.market + ":" + order.exchangeOrderId;
      attempted.add(key);
      try {
        const result = await input.canceller.cancelOrder(order.exchangeOrderId, order.market);
        if (result.success) cancelled.add(key);
        else {
          failed.add(key);
          if (messages.length < 5) messages.push("Failed to cancel configured-market order " + key);
        }
      } catch (error) {
        failed.add(key);
        if (messages.length < 5) messages.push("Failed to cancel configured-market order " + key + ": " + String(error));
      }
    }
    try {
      await input.canceller.refreshAccountState();
    } catch (error) {
      if (messages.length < 5) messages.push("Failed to refresh after configured-market order sweep: " + String(error));
    }
  }
  const unresolved = input.markets.flatMap((market) =>
    input.source.getOpenOrders(market).map((order) => order.market + ":" + order.exchangeOrderId),
  );
  return {
    attempted: [...attempted],
    cancelled: [...cancelled],
    failed: [...failed],
    unresolved,
    messages,
    successful: unresolved.length === 0,
  };
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
  const maxActions = input.maxActions ?? 100;
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

export function assertPerplShutdownCapacity(input: {
  maxLongPosition: number;
  maxShortPosition: number;
  limitPrice: number;
  maxOrderSize: number;
  maxNotionalUsd: number;
  sizeDecimals: number;
  maxActions?: number;
}): void {
  for (const positionBaseSize of [input.maxLongPosition, -input.maxShortPosition])
    planPerplShutdownChunks({ ...input, positionBaseSize });
}
