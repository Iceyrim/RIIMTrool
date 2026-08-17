import { describe, expect, it } from "vitest";
import { assertNoSignerInput, parseBridgeResponse, PERPL_TESTNET_EXCHANGE } from "../../../../src/adapters/perpl/onchain/protocol.js";

describe("Perpl on-chain IPC protocol", () => {
  it("accepts testnet responses and rejects signer/mainnet data", () => {
    expect(parseBridgeResponse(JSON.stringify({ version: 1, id: "x", event: "prepared", chainId: 10143, exchange: PERPL_TESTNET_EXCHANGE, blockNumber: "10", calldata: "0x12", calldataHash: `0x${"00".repeat(32)}` })).event).toBe("prepared");
    expect(() => parseBridgeResponse(JSON.stringify({ version: 1, id: "x", event: "prepared", chainId: 143, exchange: "0x0" }))).toThrow(/non-testnet/);
    expect(() => assertNoSignerInput({ wallet: "anything" })).toThrow(/Signer-related/);
  });
});
