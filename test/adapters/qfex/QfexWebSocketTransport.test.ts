import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildQfexAuth, isQfexAuthSuccess } from "../../../src/adapters/qfex/QfexWebSocketTransport.js";

describe("QFEX authentication", () => {
  it("signs nonce:unix timestamp with HMAC-SHA256 and includes optional account scope", () => {
    const message = buildQfexAuth({ publicKey: "public", secretKey: "secret", accountId: "account" }, "abc123", 1234);
    const expected = createHmac("sha256", "secret").update("abc123:1234").digest("hex");
    expect(message).toEqual({ type: "auth", params: { hmac: { public_key: "public", nonce: "abc123", unix_ts: 1234, signature: expected }, account_id: "account" } });
    expect(JSON.stringify(message)).not.toContain('"secret"');
  });

  it("accepts the current production authentication acknowledgement", () => {
    expect(isQfexAuthSuccess({ authenticated: true })).toBe(true);
  });

  it("retains compatibility with the legacy authentication acknowledgement", () => {
    expect(isQfexAuthSuccess({ type: "auth", result: "success" })).toBe(true);
    expect(isQfexAuthSuccess({ authenticated: false })).toBe(false);
    expect(isQfexAuthSuccess({ type: "auth", result: "failed" })).toBe(false);
  });
});
