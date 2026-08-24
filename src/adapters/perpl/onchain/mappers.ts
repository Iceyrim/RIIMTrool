import { ExchangeAdapterError } from "../../AdapterError.js";
import type { NormalizedFill, NormalizedOrder, NormalizedPosition } from "../../ExchangeAdapter.js";
import type { BridgeFill, BridgeOrder, BridgePosition, BridgeSnapshot } from "./protocol.js";

function decimal(value: string, field: string): number {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new ExchangeAdapterError(`Perpl bridge ${field} is not a canonical decimal`);
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new ExchangeAdapterError(`Perpl bridge ${field} is not finite`);
  return result;
}

export function mapBridgeOrder(order: BridgeOrder): NormalizedOrder {
  const size = decimal(order.size, "order size");
  const filledSize = decimal(order.filledSize, "filled size");
  if (size <= 0 || filledSize < 0 || filledSize > size)
    throw new ExchangeAdapterError("Perpl bridge order sizes are inconsistent");
  return {
    exchangeOrderId: order.exchangeOrderId,
    clientOrderId: order.clientOrderId,
    market: order.symbol,
    side: order.side,
    price: decimal(order.price, "order price"),
    size,
    filledSize,
    remainingSize: size - filledSize,
    isReduceOnly: order.reduceOnly,
    state: filledSize > 0 ? "partiallyFilled" : "open",
  };
}

export function mapBridgePosition(position: BridgePosition): NormalizedPosition {
  if (!Number.isSafeInteger(position.openOrderCount) || position.openOrderCount < 0)
    throw new ExchangeAdapterError("Perpl bridge open-order count is invalid");
  return {
    market: position.symbol,
    baseSize: decimal(position.baseSize, "position size"),
    markPrice: decimal(position.markPrice, "mark price"),
    unrealizedPnl: decimal(position.unrealizedPnl, "unrealized PnL"),
    openOrderCount: position.openOrderCount,
  };
}

export function mapBridgeFill(fill: BridgeFill): NormalizedFill {
  if (
    !fill.exchangeOrderId ||
    !fill.tradeId ||
    !Number.isSafeInteger(fill.timestamp) ||
    fill.timestamp <= 0
  )
    throw new ExchangeAdapterError("Perpl bridge fill identity is invalid");
  const price = decimal(fill.price, "fill price");
  const size = decimal(fill.size, "fill size");
  if (price <= 0 || size <= 0)
    throw new ExchangeAdapterError("Perpl bridge fill values are invalid");
  return {
    exchangeOrderId: fill.exchangeOrderId,
    tradeId: fill.tradeId,
    market: fill.symbol,
    side: fill.side,
    price,
    size,
    timestamp: fill.timestamp,
  };
}

export function validateSnapshot(snapshot: BridgeSnapshot, previousBlock?: bigint): bigint {
  if (!Number.isSafeInteger(snapshot.accountId) || snapshot.accountId <= 0)
    throw new ExchangeAdapterError("Perpl bridge account identity is invalid");
  if (
    !/^\d+$/.test(snapshot.fillCoverageStartBlock) ||
    BigInt(snapshot.fillCoverageStartBlock) <= 0n
  )
    throw new ExchangeAdapterError("Perpl bridge fill coverage is invalid");
  const account = snapshot.account;
  const nonnegative = [
    account.balance,
    account.lockedBalance,
    account.availableBalance,
    account.positionDeposit,
    account.maintenanceRequirement,
  ];
  if (
    nonnegative.some((value) => decimal(value, "account evidence") < 0) ||
    typeof account.frozen !== "boolean"
  )
    throw new ExchangeAdapterError("Perpl bridge account evidence is invalid");
  decimal(account.unrealizedPnl, "account unrealized PnL");
  if (!/^\d+$/.test(snapshot.blockNumber))
    throw new ExchangeAdapterError("Perpl bridge block number is invalid");
  const block = BigInt(snapshot.blockNumber);
  if (block <= 0n || (previousBlock !== undefined && block < previousBlock))
    throw new ExchangeAdapterError("Perpl bridge block regressed");
  if (
    !Number.isSafeInteger(snapshot.blockTimestamp) ||
    snapshot.blockTimestamp <= 0 ||
    !Number.isSafeInteger(snapshot.receivedAt) ||
    snapshot.receivedAt <= 0
  )
    throw new ExchangeAdapterError("Perpl bridge snapshot time is invalid");
  snapshot.positions.map(mapBridgePosition);
  snapshot.orders.map(mapBridgeOrder);
  snapshot.fills.map(mapBridgeFill);
  if (
    !Number.isSafeInteger(snapshot.eventCount) ||
    snapshot.eventCount < 0 ||
    snapshot.quiet !== (snapshot.eventCount === 0)
  )
    throw new ExchangeAdapterError("Perpl bridge event evidence is invalid");
  if (
    snapshot.markets.length !== snapshot.positions.length ||
    snapshot.books.length !== snapshot.positions.length
  )
    throw new ExchangeAdapterError("Perpl bridge market evidence is incomplete");
  snapshot.markets.forEach((market) => {
    if (!(
      (market.symbol === "BTCUSD" && market.perpetualId === 1) ||
      (market.symbol === "ETHUSD" && market.perpetualId === 20)
    ))
      throw new ExchangeAdapterError("Perpl bridge market identity is invalid");
  });
  snapshot.books.forEach((book) => {
    if (
      !(
        (book.symbol === "BTCUSD" && book.perpetualId === 1) ||
        (book.symbol === "ETHUSD" && book.perpetualId === 20)
      ) ||
      !Number.isSafeInteger(book.totalOrders) ||
      book.totalOrders < 0
    )
      throw new ExchangeAdapterError("Perpl bridge book evidence is invalid");
  });
  return block;
}
