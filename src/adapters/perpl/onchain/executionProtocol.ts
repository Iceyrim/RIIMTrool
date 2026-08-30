import { ExchangeAdapterError } from "../../AdapterError.js";
import {
  PERPL_MAINNET_ACCOUNT_ID,
  PERPL_MAINNET_CHAIN_ID,
  PERPL_MAINNET_EXCHANGE,
} from "./protocol.js";

export const PERPL_EXECUTION_PROTOCOL_VERSION = 1 as const;

interface ExecutionEnvelope {
  version: 1;
  id: string;
  chainId: 143;
  exchange: typeof PERPL_MAINNET_EXCHANGE;
  accountId: 5071;
  market: "BTCUSD" | "ETHUSD";
  perpetualId: 1 | 20;
  actionId: string;
}

export interface PerplPlaceIntent extends ExecutionEnvelope {
  action: "place";
  side: "buy" | "sell";
  orderType: "postOnly";
  price: string;
  size: string;
  reduceOnly: boolean;
  leverage: string;
}

export interface PerplCancelIntent extends ExecutionEnvelope {
  action: "cancel";
  exchangeOrderId: string;
  placementActionId: string;
}

export type PerplExecutionIntent = PerplPlaceIntent | PerplCancelIntent;
export type PerplExecutionOutcome =
  | { version: 1; id: string; event: "confirmed"; actionId: string; exchangeOrderId: string }
  | { version: 1; id: string; event: "rejected" | "ambiguous"; actionId: string; reason: string };

const forbidden = /(private.?key|secret|seed|mnemonic|wallet|signer|keystore|nonce)/i;

export function assertNoExecutionSecrets(value: unknown, path = "intent"): void {
  if (Array.isArray(value))
    return value.forEach((item, index) => assertNoExecutionSecrets(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.test(key))
      throw new ExchangeAdapterError(`Forbidden execution input at ${path}.${key}`);
    assertNoExecutionSecrets(item, `${path}.${key}`);
  }
}

export function validateExecutionIntent(intent: PerplExecutionIntent): void {
  assertNoExecutionSecrets(intent);
  if (
    intent.version !== PERPL_EXECUTION_PROTOCOL_VERSION ||
    intent.chainId !== PERPL_MAINNET_CHAIN_ID ||
    intent.exchange !== PERPL_MAINNET_EXCHANGE ||
    intent.accountId !== PERPL_MAINNET_ACCOUNT_ID ||
    !intent.id ||
    !intent.actionId ||
    !(
      (intent.market === "BTCUSD" && intent.perpetualId === 1) ||
      (intent.market === "ETHUSD" && intent.perpetualId === 20)
    )
  )
    throw new ExchangeAdapterError("Perpl execution intent identity is invalid");
  if (intent.action === "place") {
    const price = Number(intent.price);
    const size = Number(intent.size);
    if (
      intent.orderType !== "postOnly" ||
      !/^\d+$/.test(intent.leverage) ||
      Number(intent.leverage) < 1 ||
      Number(intent.leverage) > (intent.market === "BTCUSD" ? 15 : 12) ||
      !Number.isFinite(price) ||
      !Number.isFinite(size) ||
      price <= 0 ||
      size <= 0 ||
      price * size > 20
    )
      throw new ExchangeAdapterError("Perpl placement intent violates canary limits");
  } else if (
    !intent.exchangeOrderId ||
    !intent.placementActionId ||
    intent.actionId === intent.placementActionId
  ) {
    throw new ExchangeAdapterError("Perpl cancellation identity is invalid");
  }
}

export function parseExecutionOutcome(
  value: unknown,
  expected: { id: string; actionId: string },
): PerplExecutionOutcome {
  assertNoExecutionSecrets(value);
  if (!value || typeof value !== "object")
    throw new ExchangeAdapterError("Malformed Perpl execution outcome");
  const outcome = value as Record<string, unknown>;
  const allowed =
    outcome.event === "confirmed"
      ? ["version", "id", "event", "actionId", "exchangeOrderId"]
      : ["version", "id", "event", "actionId", "reason"];
  if (Object.keys(outcome).some((key) => !allowed.includes(key)))
    throw new ExchangeAdapterError("Perpl execution outcome contains unknown fields");
  if (
    outcome.version !== 1 ||
    outcome.id !== expected.id ||
    outcome.actionId !== expected.actionId ||
    !["confirmed", "rejected", "ambiguous"].includes(String(outcome.event))
  )
    throw new ExchangeAdapterError("Perpl execution outcome identity is invalid");
  if (outcome.event === "confirmed" ? !outcome.exchangeOrderId : !outcome.reason)
    throw new ExchangeAdapterError("Perpl execution outcome is incomplete");
  return outcome as unknown as PerplExecutionOutcome;
}
