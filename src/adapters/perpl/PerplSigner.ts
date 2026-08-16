import { createHash } from "node:crypto";
import * as ed25519 from "@noble/ed25519";
import type { PerplAuthHeaders, PerplSignedWsFrame } from "./authTypes.js";

const encoder = new TextEncoder();
ed25519.etc.sha512Sync = (...messages) => {
  const hash = createHash("sha512");
  for (const message of messages) hash.update(message);
  return hash.digest();
};

function hex(bytes: Uint8Array): string { return Buffer.from(bytes).toString("hex"); }

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

export function canonicalRestPayload(method: string, path: string, timestamp: string | number | bigint, body?: unknown): string {
  const normalizedMethod = method.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalizedMethod) || !path.startsWith("/") || path.includes("#")) throw new TypeError("Invalid REST signing input");
  return [normalizedMethod, path, String(timestamp), body === undefined ? "" : canonicalJson(body)].join("\n");
}

export function canonicalWsPayload<T extends Record<string, unknown>>(rq: string, timestamp: string | number | bigint, data: T): string {
  if (!rq) throw new TypeError("rq is required");
  return canonicalJson({ d: data, rq, ts: String(timestamp) });
}

export class PerplSigner {
  readonly publicKey: string;
  private readonly privateKey: Uint8Array;

  constructor(privateKey: Uint8Array, publicKey?: Uint8Array) {
    if (privateKey.length !== 32) throw new TypeError("Perpl Ed25519 private key must contain 32 bytes");
    this.privateKey = Uint8Array.from(privateKey);
    const derived = publicKey ?? ed25519.getPublicKey(this.privateKey);
    if (derived.length !== 32) throw new TypeError("Perpl Ed25519 public key must contain 32 bytes");
    this.publicKey = hex(derived);
  }

  private sign(payload: string): string {
    return hex(ed25519.sign(encoder.encode(payload), this.privateKey));
  }

  signRest(method: string, path: string, timestamp: string | number | bigint, body?: unknown): PerplAuthHeaders {
    return { "x-perpl-public-key": this.publicKey, "x-perpl-timestamp": String(timestamp), "x-perpl-signature": this.sign(canonicalRestPayload(method, path, timestamp, body)) };
  }

  signWs<T extends Record<string, unknown>>(rq: string, timestamp: string | number | bigint, data: T): PerplSignedWsFrame<T> {
    const ts = String(timestamp);
    return { rq, ts, pk: this.publicKey, d: data, sig: this.sign(canonicalWsPayload(rq, ts, data)) };
  }
}
