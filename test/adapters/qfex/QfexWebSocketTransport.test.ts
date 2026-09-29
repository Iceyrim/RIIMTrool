import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildQfexAuth, isQfexAuthSuccess, QfexWebSocketTransport } from "../../../src/adapters/qfex/QfexWebSocketTransport.js";

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

class FakeSocket {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  failType?: string;
  private readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
  on(type: string, listener: (...args: any[]) => void): this {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
    return this;
  }
  once(type: string, listener: (...args: any[]) => void): this {
    const wrapped = (...args: any[]) => {
      this.handlers.set(type, (this.handlers.get(type) ?? []).filter((entry) => entry !== wrapped));
      listener(...args);
    };
    return this.on(type, wrapped);
  }
  emit(type: string, ...args: any[]): void {
    for (const listener of [...(this.handlers.get(type) ?? [])]) listener(...args);
  }
  open(): void { this.readyState = 1; this.emit("open"); }
  close(): void { this.readyState = 3; this.emit("close"); }
  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (message.type === this.failType) throw new Error("send failed");
    this.sent.push(message);
    if (message.type === "auth") this.emit("message", Buffer.from(JSON.stringify({ authenticated: true })));
    if (message.type === "get_user_orders") this.emit("message", Buffer.from(JSON.stringify({ all_orders_response: { orders: [] } })));
  }
}

describe("QFEX transport recovery", () => {
  it("serializes a reconnect before sending a new request", async () => {
    const sockets: FakeSocket[] = [];
    const transport = new QfexWebSocketTransport({ tradeUrl: "wss://trade.example", marketDataUrl: "wss://md.example", credentials: { publicKey: "public", secretKey: "secret" }, symbols: ["MU-USD"], timeoutMs: 50, socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket as never;
    } });
    await transport.connect();
    sockets[0]!.close();
    await expect(transport.request({ type: "get_user_orders" }, (message) => typeof message.all_orders_response === "object", "orders")).resolves.toMatchObject({ all_orders_response: { orders: [] } });
    expect(sockets).toHaveLength(4);
    await transport.disconnect();
  });
  it("rejects a failed send without leaving an unhandled waiter", async () => {
    const sockets: FakeSocket[] = [];
    const transport = new QfexWebSocketTransport({ tradeUrl: "wss://trade.example", marketDataUrl: "wss://md.example", credentials: { publicKey: "public", secretKey: "secret" }, symbols: ["MU-USD"], timeoutMs: 5, socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket as never;
    } });
    await transport.connect();
    sockets[0]!.failType = "get_user_orders";
    await expect(transport.request({ type: "get_user_orders" }, () => false, "orders")).rejects.toThrow(/send failed/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await transport.disconnect();
  });
});
