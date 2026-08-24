import { describe, expect, it } from "vitest";
import {
  mapBridgeOrder,
  validateSnapshot,
} from "../../../../src/adapters/perpl/onchain/mappers.js";

describe("Perpl on-chain mappers", () => {
  it("maps canonical decimals and rejects block regression", () => {
    expect(
      mapBridgeOrder({
        exchangeOrderId: "7",
        symbol: "BTCUSD",
        side: "buy",
        price: "65000.5",
        size: "0.01",
        filledSize: "0.002",
        reduceOnly: true,
      }),
    ).toMatchObject({ remainingSize: 0.008, isReduceOnly: true, state: "partiallyFilled" });
    const snapshot = {
      accountId: 5071,
      blockNumber: "12",
      blockTimestamp: 1,
      receivedAt: 1,
      positions: [],
      orders: [],
      markets: [],
      books: [],
      eventCount: 0,
      quiet: true,
    };
    expect(validateSnapshot(snapshot)).toBe(12n);
    expect(() => validateSnapshot({ ...snapshot, blockNumber: "11" }, 12n)).toThrow(/regressed/);
  });

  it("accepts the proven mainnet ETH perpetual id", () => {
    const snapshot = {
      accountId: 5071,
      blockNumber: "12",
      blockTimestamp: 1,
      receivedAt: 1,
      positions: [
        {
          symbol: "ETHUSD",
          baseSize: "0",
          markPrice: "4000",
          unrealizedPnl: "0",
          openOrderCount: 0,
        },
      ],
      orders: [],
      markets: [
        {
          symbol: "ETHUSD",
          perpetualId: 20,
          markPrice: "4000",
          oraclePrice: "4000",
          lastPrice: "4000",
          paused: false,
          openInterest: "0",
        },
      ],
      books: [{ symbol: "ETHUSD", perpetualId: 20, totalOrders: 0 }],
      eventCount: 0,
      quiet: true,
    };
    expect(validateSnapshot(snapshot)).toBe(12n);
  });
});
