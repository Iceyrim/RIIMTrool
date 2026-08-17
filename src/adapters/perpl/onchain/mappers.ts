import { ExchangeAdapterError } from "../../AdapterError.js";
import type { NormalizedOrder, NormalizedPosition } from "../../ExchangeAdapter.js";
import type { BridgeOrder, BridgePosition, BridgeSnapshot } from "./protocol.js";

function decimal(value: string, field: string): number {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new ExchangeAdapterError(`Perpl bridge ${field} is not a canonical decimal`);
  const result = Number(value);
  if (!Number.isFinite(result)) throw new ExchangeAdapterError(`Perpl bridge ${field} is not finite`);
  return result;
}

export function mapBridgeOrder(order: BridgeOrder): NormalizedOrder {
  const size = decimal(order.size, "order size");
  const filledSize = decimal(order.filledSize, "filled size");
  if (size <= 0 || filledSize < 0 || filledSize > size) throw new ExchangeAdapterError("Perpl bridge order sizes are inconsistent");
  return { exchangeOrderId: order.exchangeOrderId, clientOrderId: order.clientOrderId, market: order.symbol, side: order.side, price: decimal(order.price, "order price"), size, filledSize, remainingSize: size - filledSize, isReduceOnly: false, state: filledSize > 0 ? "partiallyFilled" : "open" };
}

export function mapBridgePosition(position: BridgePosition): NormalizedPosition {
  if (!Number.isSafeInteger(position.openOrderCount) || position.openOrderCount < 0) throw new ExchangeAdapterError("Perpl bridge open-order count is invalid");
  return { market: position.symbol, baseSize: decimal(position.baseSize, "position size"), markPrice: decimal(position.markPrice, "mark price"), unrealizedPnl: decimal(position.unrealizedPnl, "unrealized PnL"), openOrderCount: position.openOrderCount };
}

export function validateSnapshot(snapshot: BridgeSnapshot, previousBlock?: bigint): bigint {
  if (!/^\d+$/.test(snapshot.blockNumber)) throw new ExchangeAdapterError("Perpl bridge block number is invalid");
  const block = BigInt(snapshot.blockNumber);
  if (block <= 0n || previousBlock !== undefined && block < previousBlock) throw new ExchangeAdapterError("Perpl bridge block regressed");
  if (!Number.isSafeInteger(snapshot.blockTimestamp) || snapshot.blockTimestamp <= 0 || !Number.isSafeInteger(snapshot.receivedAt) || snapshot.receivedAt <= 0) throw new ExchangeAdapterError("Perpl bridge snapshot time is invalid");
  snapshot.positions.map(mapBridgePosition); snapshot.orders.map(mapBridgeOrder);
  return block;
}
