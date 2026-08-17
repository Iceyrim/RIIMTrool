import { ExchangeAdapterError } from "../../AdapterError.js";

export const PERPL_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const PERPL_TESTNET_CHAIN_ID = 10_143 as const;
export const PERPL_TESTNET_EXCHANGE = "0x1964c32f0be608e7d29302aff5e61268e72080cc" as const;

export interface BridgeMarketConfig {
  symbol: string;
  perpetualId: number;
}

export interface BridgeHello {
  version: 1;
  id: string;
  command: "hello";
  network: "testnet";
  rpcUrl: string;
  markets: BridgeMarketConfig[];
  accountIds: number[];
}

export interface BridgePrepareOrder {
  requestId: string;
  symbol: string;
  perpetualId: number;
  side: "buy" | "sell";
  type: "limit" | "postOnly" | "immediateOrCancel" | "fillOrKill";
  price: string;
  size: string;
  reduceOnly: boolean;
  leverage: string;
}

export interface BridgePrepareExecOrders {
  version: 1;
  id: string;
  command: "prepare_exec_orders";
  revertOnFail: true;
  orders: BridgePrepareOrder[];
}

export type BridgeRequest = BridgeHello | BridgePrepareExecOrders;

export interface BridgeOrder {
  exchangeOrderId: string;
  clientOrderId?: string;
  symbol: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  filledSize: string;
}

export interface BridgePosition {
  symbol: string;
  baseSize: string;
  markPrice: string;
  unrealizedPnl: string;
  openOrderCount: number;
}

export interface BridgeSnapshot {
  blockNumber: string;
  blockTimestamp: number;
  receivedAt: number;
  positions: BridgePosition[];
  orders: BridgeOrder[];
}

export type BridgeResponse =
  | { version: 1; id: string; event: "ready"; chainId: 10143; exchange: string; snapshot: BridgeSnapshot }
  | { version: 1; id: string; event: "state"; chainId: 10143; exchange: string; snapshot: BridgeSnapshot }
  | { version: 1; id: string; event: "prepared"; chainId: 10143; exchange: string; blockNumber: string; calldata: string; calldataHash: string }
  | { version: 1; id: string; event: "fatal"; error: string };

const signerKey = /(private.?key|secret|seed|mnemonic|wallet|signer|keystore)/i;

export function assertNoSignerInput(value: unknown, path = "request"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSignerInput(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (signerKey.test(key)) throw new ExchangeAdapterError(`Signer-related input is forbidden at ${path}.${key}`);
    assertNoSignerInput(item, `${path}.${key}`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExchangeAdapterError(`Perpl bridge ${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

export function parseBridgeResponse(line: string): BridgeResponse {
  if (Buffer.byteLength(line) > 1_000_000) throw new ExchangeAdapterError("Perpl bridge message exceeds 1 MB");
  let value: unknown;
  try { value = JSON.parse(line); } catch (error) { throw new ExchangeAdapterError("Perpl bridge returned invalid JSON", error); }
  assertNoSignerInput(value, "response");
  const row = object(value, "response");
  if (row.version !== PERPL_BRIDGE_PROTOCOL_VERSION || typeof row.id !== "string") throw new ExchangeAdapterError("Perpl bridge protocol mismatch");
  if (!["ready", "state", "prepared", "fatal"].includes(String(row.event))) throw new ExchangeAdapterError("Perpl bridge event is unsupported");
  if (row.event !== "fatal") {
    if (row.chainId !== PERPL_TESTNET_CHAIN_ID || String(row.exchange).toLowerCase() !== PERPL_TESTNET_EXCHANGE) {
      throw new ExchangeAdapterError("Perpl bridge refused non-testnet deployment");
    }
  }
  return value as BridgeResponse;
}
