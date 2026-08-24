import { describe, expect, it } from "vitest";
import { assertNoSignerInput, parseBridgeResponse, PERPL_MAINNET_EXCHANGE } from "../../../../src/adapters/perpl/onchain/protocol.js";

describe("Perpl on-chain IPC protocol", () => {
  it("accepts pinned mainnet state and rejects signer, testnet, and prepared data", () => {
    expect(parseBridgeResponse(JSON.stringify({ version: 1, id: "x", event: "state", chainId: 143, exchange: PERPL_MAINNET_EXCHANGE, snapshot: {} })).event).toBe("state");
    expect(() => parseBridgeResponse(JSON.stringify({ version: 1, id: "x", event: "state", chainId: 10143, exchange: "0x0", snapshot: {} }))).toThrow(/non-mainnet/);
    expect(() => parseBridgeResponse(JSON.stringify({ version: 1, id: "x", event: "prepared", chainId: 143, exchange: PERPL_MAINNET_EXCHANGE }))).toThrow(/unsupported/);
    expect(() => assertNoSignerInput({ wallet: "anything" })).toThrow(/Signer-related/);
  });
});
