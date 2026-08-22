import { describe, expect, it } from "vitest";
import type { PerplBridgeTransport } from "../../../../src/adapters/perpl/onchain/PerplRustClient.js";
import { PerplOnchainAdapter } from "../../../../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import type { BridgeRequest, BridgeResponse } from "../../../../src/adapters/perpl/onchain/protocol.js";
import { PERPL_TESTNET_EXCHANGE } from "../../../../src/adapters/perpl/onchain/protocol.js";

class FakeBridge implements PerplBridgeTransport {
  async request(message: BridgeRequest): Promise<BridgeResponse> {
    if (message.command === "hello") return { version: 1, id: message.id, event: "ready", chainId: 10143, exchange: PERPL_TESTNET_EXCHANGE, snapshot: { blockNumber: "12", blockTimestamp: 1, receivedAt: 1000, positions: [{ symbol: "BTCUSD", baseSize: "0", markPrice: "65000", unrealizedPnl: "0", openOrderCount: 0 }], orders: [], markets: [{ symbol: "BTCUSD", perpetualId: 16, markPrice: "65000", oraclePrice: "65000", lastPrice: "65000", paused: false, openInterest: "0" }], books: [{ symbol: "BTCUSD", perpetualId: 16, totalOrders: 0 }], eventCount: 0, quiet: true } };
    return { version: 1, id: message.id, event: "prepared", chainId: 10143, exchange: PERPL_TESTNET_EXCHANGE, blockNumber: "12", calldata: "0x1234", calldataHash: `0x${"00".repeat(32)}` };
  }
  async close(): Promise<void> {}
}

describe("PerplOnchainAdapter", () => {
  it("is testnet-only and rejects every mutation", async () => {
    const adapter = new PerplOnchainAdapter(new FakeBridge(), { rpcUrl: "https://testnet-rpc.monad.xyz", markets: [{ symbol: "BTCUSD", perpetualId: 16 }] }, () => 1000);
    await adapter.connect();
    await expect(adapter.placeOrder({ market: "BTCUSD", side: "buy", type: "postOnly", size: 1, price: 1, isReduceOnly: false })).resolves.toMatchObject({ success: false, reason: "REJECTED" });
    await expect(adapter.cancelOrder("7", "BTCUSD")).resolves.toEqual({ success: false, exchangeOrderId: "7" });
    expect(() => adapter.getMarginStatus()).toThrow(/does not expose/);
    await expect(adapter.prepareExecOrders([])).resolves.toMatchObject({ blockNumber: "12" });
  });

  it("rejects custom/mainnet and account configuration", () => {
    expect(() => new PerplOnchainAdapter(new FakeBridge(), { rpcUrl: "http://remote.invalid", markets: [{ symbol: "BTCUSD", perpetualId: 16 }] })).toThrow(/approved testnet RPC/);
    expect(() => new PerplOnchainAdapter(new FakeBridge(), { rpcUrl: "https://rpc.monad.xyz", markets: [{ symbol: "BTCUSD", perpetualId: 1 }] })).toThrow(/approved testnet RPC/);
    expect(() => new PerplOnchainAdapter(new FakeBridge(), { rpcUrl: "https://testnet-rpc.monad.xyz", markets: [{ symbol: "BTCUSD", perpetualId: 16 }], accountIds: [1] })).toThrow(/account/);
  });
});
