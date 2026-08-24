import { describe, expect, it } from "vitest";
import type { PerplBridgeTransport } from "../../../../src/adapters/perpl/onchain/PerplRustClient.js";
import { PerplOnchainAdapter } from "../../../../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import type {
  BridgeRequest,
  BridgeResponse,
} from "../../../../src/adapters/perpl/onchain/protocol.js";
import { PERPL_MAINNET_EXCHANGE } from "../../../../src/adapters/perpl/onchain/protocol.js";

class FakeBridge implements PerplBridgeTransport {
  async request(message: BridgeRequest): Promise<BridgeResponse> {
    return {
      version: 1,
      id: message.id,
      event: "ready",
      chainId: 143,
      exchange: PERPL_MAINNET_EXCHANGE,
      snapshot: {
        accountId: 5071,
        blockNumber: "12",
        blockTimestamp: 1,
        receivedAt: 1000,
        positions: [
          {
            symbol: "BTCUSD",
            baseSize: "0.01",
            markPrice: "65000",
            unrealizedPnl: "2",
            openOrderCount: 1,
          },
        ],
        orders: [
          {
            exchangeOrderId: "9",
            symbol: "BTCUSD",
            side: "sell",
            price: "65100",
            size: "0.01",
            filledSize: "0",
            reduceOnly: true,
          },
        ],
        markets: [
          {
            symbol: "BTCUSD",
            perpetualId: 1,
            markPrice: "65000",
            oraclePrice: "65000",
            lastPrice: "65000",
            paused: false,
            openInterest: "0",
          },
        ],
        books: [{ symbol: "BTCUSD", perpetualId: 1, totalOrders: 1 }],
        eventCount: 0,
        quiet: true,
      },
    };
  }
  async close(): Promise<void> {}
}

describe("PerplOnchainAdapter", () => {
  it("accepts the proven mainnet ETH perpetual id", () => {
    expect(
      () =>
        new PerplOnchainAdapter(new FakeBridge(), {
          rpcUrl: "https://rpc.monad.xyz",
          markets: [{ symbol: "ETHUSD", perpetualId: 20 }],
          accountIds: [5071],
        }),
    ).not.toThrow();
  });

  it("reads pinned mainnet state and rejects every mutation", async () => {
    const adapter = new PerplOnchainAdapter(
      new FakeBridge(),
      {
        rpcUrl: "https://rpc.monad.xyz",
        markets: [{ symbol: "BTCUSD", perpetualId: 1 }],
        accountIds: [5071],
      },
      () => 1000,
    );
    await adapter.connect();
    expect(adapter.getPositions()).toMatchObject([{ baseSize: 0.01, openOrderCount: 1 }]);
    expect(adapter.getOpenOrders()).toMatchObject([{ exchangeOrderId: "9", isReduceOnly: true }]);
    await expect(
      adapter.placeOrder({
        market: "BTCUSD",
        side: "buy",
        type: "postOnly",
        size: 1,
        price: 1,
        isReduceOnly: false,
      }),
    ).resolves.toMatchObject({ success: false, reason: "REJECTED" });
    await expect(adapter.cancelOrder("7", "BTCUSD")).resolves.toEqual({
      success: false,
      exchangeOrderId: "7",
    });
    expect(() => adapter.getMarginStatus()).toThrow(/does not expose/);
    await expect(adapter.prepareExecOrders([])).rejects.toThrow(/cannot prepare/);
  });

  it("rejects custom/mainnet and account configuration", () => {
    expect(
      () =>
        new PerplOnchainAdapter(new FakeBridge(), {
          rpcUrl: "http://remote.invalid",
          markets: [{ symbol: "BTCUSD", perpetualId: 1 }],
          accountIds: [5071],
        }),
    ).toThrow(/approved mainnet RPC/);
    expect(
      () =>
        new PerplOnchainAdapter(new FakeBridge(), {
          rpcUrl: "https://testnet-rpc.monad.xyz",
          markets: [{ symbol: "BTCUSD", perpetualId: 16 }],
          accountIds: [5071],
        }),
    ).toThrow(/approved mainnet RPC/);
    expect(
      () =>
        new PerplOnchainAdapter(new FakeBridge(), {
          rpcUrl: "https://rpc.monad.xyz",
          markets: [{ symbol: "BTCUSD", perpetualId: 1 }],
        }),
    ).toThrow(/account/);
    expect(
      () =>
        new PerplOnchainAdapter(new FakeBridge(), {
          rpcUrl: "https://rpc.monad.xyz",
          markets: [{ symbol: "BTCUSD", perpetualId: 1 }],
          accountIds: [7],
        }),
    ).toThrow(/account/);
  });
});
