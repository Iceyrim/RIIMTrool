import { describe, expect, it } from "vitest";
import { PerplApiExecutionTransport, quantizePerplLimitPrice } from "../../../src/adapters/perpl/PerplApiExecutionTransport.js";
import type { PerplPlaceIntent } from "../../../src/adapters/perpl/onchain/executionProtocol.js";
import { PERPL_MAINNET_EXCHANGE } from "../../../src/adapters/perpl/onchain/protocol.js";

class FakeSocket {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, Array<(event: any) => void>>();
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.mt === 29) queueMicrotask(() => this.message({
      mt: 19, sn: 10, at: {}, addr: "0xa89bC210BaB1156113571F2a9193c5282efBF78a", n: 1, fl: 0,
      as: [{ in: 1, id: 5071, fr: false, fw: true, ft: 0, lfr: 100, b: "18.34", lb: "0" }],
    }));
  }
  close(): void { this.emit("close", {}); }
  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  open(): void { this.emit("open", {}); }
  message(data: unknown): void { this.emit("message", { data: JSON.stringify(data) }); }
  private emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

const intent: PerplPlaceIntent = {
  version: 1, id: "x", action: "place", chainId: 143, exchange: PERPL_MAINNET_EXCHANGE,
  accountId: 5071, market: "BTCUSD", perpetualId: 1, actionId: "123", side: "buy",
  orderType: "postOnly", price: "78000", size: "0.00018", reduceOnly: false, leverage: "15",
};

describe("PerplApiExecutionTransport", () => {
  it("rounds maker prices away from crossing at each market tick", () => {
    expect(quantizePerplLimitPrice(78_000.987, 1, "buy")).toBe(78_000.9);
    expect(quantizePerplLimitPrice(78_000.901, 1, "sell")).toBe(78_001);
    expect(quantizePerplLimitPrice(2_453.5678, 2, "buy")).toBe(2_453.56);
    expect(quantizePerplLimitPrice(2_453.5601, 2, "sell")).toBe(2_453.57);
  });
  it("signs in first, allocates rq from account lfr, and waits for a definitive order update", async () => {
    const socket = new FakeSocket();
    const transport = new PerplApiExecutionTransport({
      apiKey: "opaque-token",
      apiKeySecret: "11".repeat(32),
      socketFactory: () => socket,
    });
    const connecting = transport.connect();
    socket.open();
    await connecting;

    expect(socket.sent[0]).toMatchObject({ mt: 29, chain_id: 143, api_key: "opaque-token" });
    expect(transport.getConnectionEvidence()).toEqual({
      chainId: 143,
      accountId: 5071,
      walletAddress: "0xa89bC210BaB1156113571F2a9193c5282efBF78a",
      lastForwardedRequestId: 100,
    });
    const outcomePromise = transport.request(intent);
    await Promise.resolve();
    const order = socket.sent[1]!;
    expect(order).toMatchObject({ mt: 22, rq: 101, mkt: 1, acc: 5071, t: 1, p: 780000, s: 18, fl: 1, lv: 1500, lb: 0 });
    socket.message({ mt: 3, sid: 100, sn: 11, cid: order.sn, status: { code: 0, error: "" } });
    let settled = false;
    void outcomePromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.message({ mt: 24, at: {}, d: [{
      at: {}, c: {}, rq: 101, mkt: 1, acc: 5071, oid: 44, scid: 44, st: 2, sr: 35,
      t: 1, p: 780000, os: 18, fp: 0, fs: 0, f: "0", fl: 1, mm: 0, lv: 1500,
    }] });
    await expect(outcomePromise).resolves.toEqual({ version: 1, id: "x", event: "confirmed", actionId: "123", exchangeOrderId: "44" });
    transport.close();
  });

  it("maps reduce-only sides to close-order types", async () => {
    const socket = new FakeSocket();
    const transport = new PerplApiExecutionTransport({ apiKey: "token", apiKeySecret: "22".repeat(32), socketFactory: () => socket, timeoutMs: 10 });
    const connecting = transport.connect(); socket.open(); await connecting;
    void transport.request({ ...intent, id: "sell", actionId: "124", side: "sell", reduceOnly: true });
    await Promise.resolve();
    expect(socket.sent[1]).toMatchObject({ t: 3 });
    transport.close();
  });

  it("returns a definitive exchange failure as rejected without waiting for timeout", async () => {
    const socket = new FakeSocket();
    const transport = new PerplApiExecutionTransport({ apiKey: "token", apiKeySecret: "33".repeat(32), socketFactory: () => socket });
    const connecting = transport.connect(); socket.open(); await connecting;
    const outcome = transport.request(intent); await Promise.resolve();
    const sent = socket.sent[1]!;
    socket.message({ mt: 3, sid: 100, sn: 11, cid: sent.sn, status: { code: 0, error: "" } });
    socket.message({ mt: 24, at: {}, d: [{
      at: {}, c: {}, rq: 101, mkt: 1, acc: 5071, oid: 0, scid: 0, st: 7, sr: 36,
      fr: 1, t: 1, p: 780000, os: 18, fp: 0, fs: 0, f: "0", fl: 1, mm: 0, lv: 1500,
    }] });
    await expect(outcome).resolves.toMatchObject({ event: "rejected", reason: "order failed" });
    transport.close();
  });
});
