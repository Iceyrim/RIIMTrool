import { beforeEach, describe, expect, it, vi } from "vitest";
import { RiseXPermitExecutionTransport } from "../../../src/adapters/risex/RiseXPermitExecutionTransport.js";
import type { RiseXPermitSigner } from "../../../src/adapters/risex/RiseXPermitSigner.js";
import { FakeRiseXMarketDataSource } from "./fakeMarketDataSource.js";

const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
const account = "0x0000000000000000000000000000000000000002";
const signer: RiseXPermitSigner = {
  address: "0x0000000000000000000000000000000000000004",
  signPlace: vi.fn(async (context) => ({ account, signer: "0x0000000000000000000000000000000000000004", nonce_anchor: context.nonce.nonceAnchor.toString(), nonce_bitmap_index: context.nonce.nonceBitmapIndex, deadline: context.deadline, signature: "AQ==" })),
  signCancel: vi.fn(async (context) => ({ account, signer: "0x0000000000000000000000000000000000000004", nonce_anchor: context.nonce.nonceAnchor.toString(), nonce_bitmap_index: context.nonce.nonceBitmapIndex, deadline: context.deadline, signature: "Ag==" })),
};

describe("RISEx permit execution transport", () => {
  beforeEach(() => vi.clearAllMocks());

  function transport(fetchImpl: typeof fetch) {
    const marketData = new FakeRiseXMarketDataSource();
    marketData.markets = [{
      marketId: 1,
      symbol: "BTC/USDC",
      displayName: "BTC/USDC",
      markPrice: 60_000,
      indexPrice: 60_000,
      lastPrice: 60_000,
      stepSize: 0.001,
      stepPrice: 0.1,
      minOrderSize: 0.001,
      maxLeverage: 50,
      active: true,
    }];
    return new RiseXPermitExecutionTransport(marketData, signer, {
      baseUrl: "https://offline.invalid", account, fetchImpl,
      markets: [{ symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" }],
    });
  }

  it("places with a fresh signed permit and confirms the transaction", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ name: "RISEx Auth", version: "1", chain_id: "11155931", verifying_contract: "0x0000000000000000000000000000000000000001" }))
      .mockResolvedValueOnce(response({ router: "0x0000000000000000000000000000000000000003" }))
      .mockResolvedValueOnce(response({ nonce_anchor: "7", current_bitmap_index: 4 }))
      .mockResolvedValueOnce(response({ order_id: "0xabc", tx_hash: "0xtx", block_number: "1", sc_order_id: "9", filled_quantity: "0" }))
      .mockResolvedValueOnce(response({ tx_hash: "0xtx", success: true })) as unknown as typeof fetch;
    const client = transport(fetchImpl);
    await client.connect();
    const result = await client.placeOrder({ market: "BTCUSD", side: "buy", type: "postOnly", price: 60000.04, size: 0.001, isReduceOnly: false, clientOrderId: "42" });
    expect(result.success).toBe(true);
    const body = JSON.parse((vi.mocked(fetchImpl).mock.calls[3]![1]!.body as string));
    expect(body.permit).toMatchObject({ nonce_anchor: "7", nonce_bitmap_index: 4, signature: "AQ==" });
    expect(body.price_ticks).toBe(600000);
  });

  it("requires authoritative resting identity and signs exact cancellation", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ name: "RISEx Auth", version: "1", chain_id: 1, verifying_contract: "0x0000000000000000000000000000000000000001" }))
      .mockResolvedValueOnce(response({ contracts: { router: "0x0000000000000000000000000000000000000003" } }))
      .mockResolvedValueOnce(response({ nonce_anchor: "8", current_bitmap_index: 2 }))
      .mockResolvedValueOnce(response({ tx_hash: "0xc", block_number: "2", success: true })) as unknown as typeof fetch;
    const client = transport(fetchImpl);
    await client.connect();
    await expect(client.cancelOrder("0xorder", "BTCUSD")).rejects.toThrow(/identity is unavailable/);
    client.seedOpenOrderIdentities([{ exchangeOrderId: "0xorder", restingOrderId: "123" }]);
    await expect(client.cancelOrder("0xorder", "BTCUSD")).resolves.toEqual({ success: true, exchangeOrderId: "0xorder" });
    expect(signer.signCancel).toHaveBeenCalledWith(expect.objectContaining({ nonce: { nonceAnchor: 8n, nonceBitmapIndex: 2 } }), { marketId: 1, restingOrderId: 123n });
  });

  it("rolls an exhausted bitmap to the next nonce anchor", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ name: "RISEx Auth", version: "1", chain_id: 1, verifying_contract: "0x0000000000000000000000000000000000000001" }))
      .mockResolvedValueOnce(response({ universal_router: "0x0000000000000000000000000000000000000003" }))
      .mockResolvedValueOnce(response({ nonce_anchor: "12", current_bitmap_index: 208 }))
      .mockResolvedValueOnce(response({ order_id: "0xabc", tx_hash: "0xtx", block_number: "1", sc_order_id: "9", filled_quantity: "0" }))
      .mockResolvedValueOnce(response({ tx_hash: "0xtx", success: true })) as unknown as typeof fetch;
    const client = transport(fetchImpl);
    await client.connect();
    await client.placeOrder({ market: "BTCUSD", side: "buy", type: "limit", price: 60000, size: 0.001, isReduceOnly: false });
    expect(signer.signPlace).toHaveBeenCalledWith(expect.objectContaining({ nonce: { nonceAnchor: 13n, nonceBitmapIndex: 0 } }), expect.anything());
  });

  it("classifies a submission timeout as ambiguous and never retries", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ name: "RISEx Auth", version: "1", chain_id: 1, verifying_contract: "0x0000000000000000000000000000000000000001" }))
      .mockResolvedValueOnce(response({ router: "0x0000000000000000000000000000000000000003" }))
      .mockResolvedValueOnce(response({ nonce_anchor: "1", current_bitmap_index: 0 }))
      .mockRejectedValueOnce(new TypeError("timeout")) as unknown as typeof fetch;
    const client = transport(fetchImpl);
    await client.connect();
    const result = await client.placeOrder({ market: "BTCUSD", side: "buy", type: "limit", price: 60000, size: 0.001, isReduceOnly: false });
    expect(result).toMatchObject({ success: false, reason: "UNRESOLVED_NOT_CONFIRMED" });
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(4);
  });
});
