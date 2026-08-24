import { describe, expect, it } from "vitest";
import { mapBridgeOrder, validateSnapshot } from "../../../../src/adapters/perpl/onchain/mappers.js";

describe("Perpl on-chain mappers", () => {
  it("maps canonical decimals and rejects block regression", () => {
    expect(mapBridgeOrder({ exchangeOrderId: "7", symbol: "BTCUSD", side: "buy", price: "65000.5", size: "0.01", filledSize: "0.002", reduceOnly: true })).toMatchObject({ remainingSize: 0.008, isReduceOnly: true, state: "partiallyFilled" });
    const snapshot = { accountId: 7, blockNumber: "12", blockTimestamp: 1, receivedAt: 1, positions: [], orders: [], markets: [], books: [], eventCount: 0, quiet: true };
    expect(validateSnapshot(snapshot)).toBe(12n);
    expect(() => validateSnapshot({ ...snapshot, blockNumber: "11" }, 12n)).toThrow(/regressed/);
  });
});
