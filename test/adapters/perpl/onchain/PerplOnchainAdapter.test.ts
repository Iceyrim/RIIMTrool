import { describe, expect, it } from "vitest";
import type { PerplBridgeTransport } from "../../../../src/adapters/perpl/onchain/PerplRustClient.js";
import { PerplOnchainAdapter } from "../../../../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import type {
  BridgeRequest,
  BridgeResponse,
} from "../../../../src/adapters/perpl/onchain/protocol.js";
import { PERPL_MAINNET_EXCHANGE } from "../../../../src/adapters/perpl/onchain/protocol.js";

class FakeBridge implements PerplBridgeTransport {
  private listener?: (message: BridgeResponse) => void;
  onEvent(listener: (message: BridgeResponse) => void): void {
    this.listener = listener;
  }
  async request(message: BridgeRequest): Promise<BridgeResponse> {
    return {
      version: 1,
      id: message.id,
      event: "ready",
      chainId: 143,
      exchange: PERPL_MAINNET_EXCHANGE,
      snapshot: {
        accountId: 5071,
        account: {
          balance: "18.341694",
          lockedBalance: "0",
          availableBalance: "18.341694",
          unrealizedPnl: "2",
          positionDeposit: "1",
          maintenanceRequirement: "0.5",
          frozen: false,
        },
        fillCoverageStartBlock: "10",
        blockNumber: "12",
        blockTimestamp: 1,
        receivedAt: 1000,
        positions: [
          {
            symbol: "BTCUSD",
            baseSize: "0.01",
            markPrice: "65000",
            unrealizedPnl: "2",
            deposit: "100",
            maintenanceRequirement: "50",
            liquidationPrice: "60000",
            bankruptcyPrice: "55000",
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
        fills: [
          {
            exchangeOrderId: "9",
            tradeId: "0xabc:1",
            symbol: "BTCUSD",
            side: "sell",
            price: "65100",
            size: "0.002",
            timestamp: 1000,
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
        books: [
          {
            symbol: "BTCUSD",
            perpetualId: 1,
            bestBid: { price: "64990", size: "0.1" },
            bestAsk: { price: "65010", size: "0.1" },
            totalOrders: 1,
          },
        ],
        eventCount: 0,
        quiet: true,
      },
    };
  }
  async close(): Promise<void> {}
  async emitBlock(blockNumber: string): Promise<void> {
    const response = await this.request({ id: "event" } as BridgeRequest);
    if (response.event !== "ready") throw new Error("fake snapshot unavailable");
    this.listener?.({ ...response, event: "state", snapshot: { ...response.snapshot, blockNumber } });
  }
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
    expect(adapter.getBalances()).toEqual([{ token: "AUSD", amount: 18.341694 }]);
    expect(adapter.getPositionSafetyEvidence("BTCUSD")).toEqual([
      {
        market: "BTCUSD",
        baseSize: 0.01,
        markPrice: 65000,
        deposit: 100,
        maintenanceRequirement: 50,
        liquidationPrice: 60000,
        bankruptcyPrice: 55000,
      },
    ]);
    expect(adapter.getAccountEvidence()).toMatchObject({
      maintenanceRequirement: "0.5",
      frozen: false,
    });
    expect(adapter.getSessionEquityEvidence()).toEqual({
      balance: "18.341694",
      lockedBalance: "0",
      positionDeposit: "1",
      unrealizedPnl: "2",
      frozen: false,
      blockNumber: "12",
      observedAt: 1000,
    });
    expect(adapter.getFillCoverageStartBlock()).toBe("10");
    expect(adapter.getBookEvidence("BTCUSD")).toEqual({ bestBid: 64990, bestAsk: 65010 });
    await expect(adapter.getOrderFills("9", "BTCUSD")).resolves.toMatchObject([
      { tradeId: "0xabc:1", size: 0.002 },
    ]);
    await expect(adapter.getOrderFills("missing", "BTCUSD")).rejects.toThrow(/historical absence/);
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

  it("waits for a strictly newer snapshot before live cleanup trusts exchange state", async () => {
    const bridge = new FakeBridge();
    const adapter = new PerplOnchainAdapter(bridge, {
      rpcUrl: "https://rpc.monad.xyz",
      markets: [{ symbol: "BTCUSD", perpetualId: 1 }],
      accountIds: [5071],
    }, () => 1000);
    await adapter.connect();
    let resolved = false;
    const waiting = adapter.waitForSnapshotAfter("12", 1_000).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await bridge.emitBlock("13");
    await waiting;
    expect(resolved).toBe(true);
  });
});
