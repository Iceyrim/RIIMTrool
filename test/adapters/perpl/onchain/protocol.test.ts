import { describe, expect, it } from "vitest";
import {
  assertNoSignerInput,
  parseBridgeResponse,
  PERPL_MAINNET_EXCHANGE,
  PERPL_MAINNET_RPC,
  resolvePerplMainnetRpc,
} from "../../../../src/adapters/perpl/onchain/protocol.js";

describe("Perpl on-chain IPC protocol", () => {
  it("accepts pinned mainnet state and rejects signer, testnet, and prepared data", () => {
    expect(
      parseBridgeResponse(
        JSON.stringify({
          version: 1,
          id: "x",
          event: "state",
          chainId: 143,
          exchange: PERPL_MAINNET_EXCHANGE,
          snapshot: {},
        }),
      ).event,
    ).toBe("state");
    expect(() =>
      parseBridgeResponse(
        JSON.stringify({
          version: 1,
          id: "x",
          event: "state",
          chainId: 10143,
          exchange: "0x0",
          snapshot: {},
        }),
      ),
    ).toThrow(/non-mainnet/);
    expect(() =>
      parseBridgeResponse(
        JSON.stringify({
          version: 1,
          id: "x",
          event: "prepared",
          chainId: 143,
          exchange: PERPL_MAINNET_EXCHANGE,
        }),
      ),
    ).toThrow(/unsupported/);
    expect(() => assertNoSignerInput({ wallet: "anything" })).toThrow(/Signer-related/);
  });

  it("accepts a secret HTTPS mainnet RPC override and rejects unsafe network URLs", () => {
    expect(resolvePerplMainnetRpc(undefined)).toBe(PERPL_MAINNET_RPC);
    expect(resolvePerplMainnetRpc("  ")).toBe(PERPL_MAINNET_RPC);
    expect(resolvePerplMainnetRpc("https://monad-mainnet.example/v2/secret")).toBe(
      "https://monad-mainnet.example/v2/secret",
    );
    expect(() => resolvePerplMainnetRpc("http://monad-mainnet.example/key")).toThrow(/HTTPS/);
    expect(() => resolvePerplMainnetRpc("https://monad-testnet.example/key")).toThrow(/mainnet/);
    expect(() => resolvePerplMainnetRpc("https://user:pass@monad.example/key")).toThrow(/mainnet/);
  });
});
