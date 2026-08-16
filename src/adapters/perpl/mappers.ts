import { ExchangeAdapterError } from "../AdapterError.js";

const integerPattern = /^-?\d+$/;

export function scaleFactor(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new ExchangeAdapterError(`Perpl returned invalid decimals: ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

export function scaledToNumber(value: string | number | bigint, decimals: number, field = "value"): number {
  const text = String(value);
  if (!integerPattern.test(text)) throw new ExchangeAdapterError(`Perpl ${field} is not a scaled integer: ${text}`);
  const result = Number(BigInt(text)) / Number(scaleFactor(decimals));
  if (!Number.isFinite(result)) throw new ExchangeAdapterError(`Perpl ${field} is not finite`);
  return result;
}

export function numberToScaled(value: number, decimals: number, field = "value"): bigint {
  if (!Number.isFinite(value)) throw new ExchangeAdapterError(`Perpl ${field} is not finite`);
  const factor = scaleFactor(decimals);
  const text = value.toFixed(decimals);
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace("-", "").split(".");
  const result = BigInt(whole) * factor + BigInt(fraction.padEnd(decimals, "0") || "0");
  return negative ? -result : result;
}

export function quantizeScaled(value: number, decimals: number): number {
  return scaledToNumber(numberToScaled(value, decimals), decimals);
}

export function finiteNumber(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result)) throw new ExchangeAdapterError(`Perpl ${field} is malformed`);
  return result;
}

export function timestampMs(value: unknown, field = "timestamp"): number {
  const raw = finiteNumber(value, field);
  const result = raw > 10_000_000_000 ? raw : raw * 1000;
  if (!Number.isSafeInteger(Math.trunc(result)) || result <= 0) {
    throw new ExchangeAdapterError(`Perpl ${field} is invalid`);
  }
  return Math.trunc(result);
}

export interface ParsedBlockTimestamp { block: bigint; timestamp: number }

export function blockTimestamp(value: unknown, field = "at"): ParsedBlockTimestamp {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExchangeAdapterError(`Perpl ${field} is malformed`);
  }
  const at = value as Record<string, unknown>;
  if (!/^\d+$/.test(String(at.b)) || !/^\d+$/.test(String(at.t))) {
    throw new ExchangeAdapterError(`Perpl ${field} is malformed`);
  }
  const block = BigInt(String(at.b));
  if (block <= 0n) throw new ExchangeAdapterError(`Perpl ${field}.b is invalid`);
  return { block, timestamp: timestampMs(at.t, `${field}.t`) };
}
