import { createHash } from "node:crypto";
import * as ed25519 from "@noble/ed25519";
import type { PerplApiKeySignIn, PerplAuthHeaders } from "./authTypes.js";

const encoder = new TextEncoder();
ed25519.etc.sha512Sync = (...messages) => {
  const hash = createHash("sha512");
  for (const message of messages) hash.update(message);
  return hash.digest();
};

function uint(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a safe unsigned integer`);
  return String(value);
}

function required(value: string, field: string): string {
  if (!value) throw new TypeError(`${field} is required`);
  return value;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function canonicalRestPayload(
  chainId: number,
  method: string,
  requestTarget: string,
  timestamp: string,
  nonce: string,
  rawBody = "",
): string {
  const normalizedMethod = method.toUpperCase();
  if (!/^[A-Z]+$/.test(normalizedMethod)) throw new TypeError("HTTP method is malformed");
  if (!requestTarget.startsWith("/") || requestTarget.includes("#")) throw new TypeError("request-target is malformed");
  if (!/^\d+$/.test(timestamp)) throw new TypeError("timestamp is malformed");
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  return [uint(chainId, "chain_id"), normalizedMethod, requestTarget, timestamp, required(nonce, "nonce"), bodyHash].join("\n");
}

export function canonicalWsPayload(chainId: number, timestamp: string, nonce: string): string {
  if (!/^\d+$/.test(timestamp)) throw new TypeError("timestamp is malformed");
  return [uint(chainId, "chain_id"), "trading-ws-signin", timestamp, required(nonce, "nonce")].join("\n");
}

export class PerplSigner {
  constructor(
    private readonly privateKey: Uint8Array,
    private readonly apiKey: string,
    private readonly chainId: number,
  ) {
    if (privateKey.length !== 32) throw new TypeError("Perpl Ed25519 private key must contain 32 bytes");
    this.privateKey = Uint8Array.from(privateKey);
    required(apiKey, "api_key");
    uint(chainId, "chain_id");
  }

  private sign(payload: string): string {
    return base64url(ed25519.sign(encoder.encode(payload), this.privateKey));
  }

  signRest(method: string, requestTarget: string, timestamp: string, nonce: string, rawBody = ""): PerplAuthHeaders {
    return {
      "X-API-Key": this.apiKey,
      "X-API-Timestamp": timestamp,
      "X-API-Nonce": nonce,
      "X-API-Signature": this.sign(canonicalRestPayload(this.chainId, method, requestTarget, timestamp, nonce, rawBody)),
    };
  }

  signWs(timestamp: string, nonce: string): PerplApiKeySignIn {
    return {
      mt: 29,
      chain_id: this.chainId,
      api_key: this.apiKey,
      timestamp,
      nonce,
      signature: this.sign(canonicalWsPayload(this.chainId, timestamp, nonce)),
    };
  }
}
