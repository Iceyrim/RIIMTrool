import { describe, expect, it } from "vitest";
import { PerplCanaryExecutor, type PerplExecutionTransport } from "../../../../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import { validateExecutionIntent, type PerplExecutionIntent } from "../../../../src/adapters/perpl/onchain/executionProtocol.js";

class FakeTransport implements PerplExecutionTransport {
  requests: PerplExecutionIntent[] = [];
  async request(intent: PerplExecutionIntent): Promise<unknown> {
    this.requests.push(intent);
    return {
      version: 1,
      id: intent.id,
      event: "confirmed",
      actionId: intent.actionId,
      exchangeOrderId: intent.action === "place" ? "47" : intent.exchangeOrderId,
    };
  }
}

describe("PerplCanaryExecutor", () => {
  it("maps pinned post-only placement and correlated cancellation", async () => {
    const transport = new FakeTransport();
    const executor = new PerplCanaryExecutor(transport);
    await expect(executor.place({
      market: "BTCUSD", side: "buy", price: 77_000, size: 0.00018,
      postOnly: true, reduceOnly: false, clientActionId: "place-1", leverage: 15,
    })).resolves.toEqual({ state: "confirmed", exchangeOrderId: "47" });
    await expect(executor.cancel({
      market: "BTCUSD", exchangeOrderId: "47", clientActionId: "cancel-1",
    })).resolves.toEqual({ state: "confirmed", exchangeOrderId: "47" });
    expect(transport.requests).toMatchObject([
      { action: "place", chainId: 143, accountId: 5198, perpetualId: 1, orderType: "postOnly", leverage: "15" },
      { action: "cancel", exchangeOrderId: "47", placementActionId: "place-1" },
    ]);
  });

  it("refuses cancellation when placement identity is unavailable", async () => {
    const executor = new PerplCanaryExecutor(new FakeTransport());
    await expect(executor.cancel({ market: "BTCUSD", exchangeOrderId: "47", clientActionId: "cancel-1" }))
      .resolves.toMatchObject({ state: "ambiguous" });
  });

  it("rejects secret fields, excess notional, and wrong identities", () => {
    const base = {
      version: 1, id: "x", action: "place", chainId: 143,
      exchange: "0x34b6552d57a35a1d042ccae1951bd1c370112a6f", accountId: 5198,
      market: "BTCUSD", perpetualId: 1, actionId: "place-1", side: "buy",
      orderType: "postOnly", price: "77000", size: "0.00018", reduceOnly: false, leverage: "1",
    } as const;
    expect(() => validateExecutionIntent({ ...base, signerKey: "forbidden" } as never)).toThrow(/Forbidden/);
    expect(() => validateExecutionIntent({ ...base, size: "1" })).toThrow(/limits/);
    expect(() => validateExecutionIntent({ ...base, perpetualId: 20 } as never)).toThrow(/identity/);
    expect(() => validateExecutionIntent({ ...base, leverage: "16" })).toThrow(/limits/);
    expect(() => validateExecutionIntent({ ...base, market: "ETHUSD", perpetualId: 20, leverage: "13" })).toThrow(/limits/);
    expect(() => validateExecutionIntent({ ...base, price: "100000.01", size: "0.00030" })).toThrow(/limits/);
    expect(() => validateExecutionIntent({ ...base, price: "100000", size: "0.00030" })).not.toThrow();
  });

  it("fails closed on unknown or mismatched outcome fields", async () => {
    const transport: PerplExecutionTransport = {
      request: async (intent) => ({
        version: 1, id: intent.id, event: "confirmed", actionId: "wrong",
        exchangeOrderId: "47", extra: true,
      }),
    };
    const executor = new PerplCanaryExecutor(transport);
    await expect(executor.place({
      market: "BTCUSD", side: "buy", price: 77_000, size: 0.00018,
      postOnly: true, reduceOnly: false, clientActionId: "place-1",
    })).rejects.toThrow(/unknown fields/);
  });
});
