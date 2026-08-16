import type { OrderSide, OrderType } from "../ExchangeAdapter.js";

export type PerplInteger = string | number | bigint;

export interface PerplAuthHeaders {
  "x-perpl-public-key": string;
  "x-perpl-timestamp": string;
  "x-perpl-signature": string;
}

export interface PerplSignedWsFrame<T extends Record<string, unknown>> {
  rq: string;
  ts: string;
  pk: string;
  d: T;
  sig: string;
}

export interface PerplAuthSnapshotRaw {
  mt: "snapshot";
  sn: PerplInteger;
  balances: unknown[];
  positions: unknown[];
  orders: unknown[];
  fills: unknown[];
  pnl: unknown[];
  funding: unknown[];
}

export interface PerplAuthUpdateRaw {
  mt: "update";
  sn: PerplInteger;
  balances?: unknown[];
  positions?: unknown[];
  orders?: unknown[];
  fills?: unknown[];
  pnl?: unknown[];
  funding?: unknown[];
}

export interface PerplBalance { asset: string; total: number; available: number }
export interface PerplPosition { marketId: string; baseSize: number; entryPrice: number; markPrice: number; unrealizedPnl: number }
export interface PerplAuthOrder {
  orderId: string; clientOrderId?: string; marketId: string; side: OrderSide; type: OrderType;
  price: number; size: number; filledSize: number; remainingSize: number;
  status: "open" | "filled" | "cancelled" | "rejected";
}
export interface PerplAuthFill { fillId: string; orderId: string; marketId: string; price: number; size: number; fee: number; timestamp: number }
export interface PerplPnlEntry { id: string; marketId: string; amount: number; timestamp: number }
export interface PerplFundingEntry { id: string; marketId: string; amount: number; rate: number; timestamp: number }
export interface PerplAuthState {
  sequence: bigint;
  balances: PerplBalance[];
  positions: PerplPosition[];
  orders: PerplAuthOrder[];
  fills: PerplAuthFill[];
  pnl: PerplPnlEntry[];
  funding: PerplFundingEntry[];
}

export interface PerplScaling { priceDecimals: number; sizeDecimals: number; collateralDecimals?: number }
