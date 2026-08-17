import { describe, expect, it } from "vitest";
import { mapBridgeOrder, validateSnapshot } from "../../../../src/adapters/perpl/onchain/mappers.js";

describe("Perpl on-chain mappers", () => {
  it("maps canonical decimals and rejects block regression", () => {
    expect(mapBridgeOrder({ exchangeOrderId: "7", symbol: "BTCUSD", side: "buy", price: "65000.5", size: "0.01", filledSize: "0.002" })).toMatchObject({ remainingSize: 0.008, state: "partiallyFilled" });
    const snapshot = { blockNumber: "12", blockTimestamp: 1, receivedAt: 1, positions: [], orders: [] };
    expect(validateSnapshot(snapshot)).toBe(12n);
    expect(() => validateSnapshot({ ...snapshot, blockNumber: "11" }, 12n)).toThrow(/regressed/);
  });
});
