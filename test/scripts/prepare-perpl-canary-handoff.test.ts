import { describe, expect, it } from "vitest";
import { preparePerplCanaryHandoff, type CanaryHandoffInput } from "../../scripts/prepare-perpl-canary-handoff.js";

const valid: CanaryHandoffInput = {
  arm: "ARM PERPL ONE-SHOT MAINNET CANARY", signer: "0xa89bC210BaB1156113571F2a9193c5282efBF78a",
  signerKeyFile: "canary-wallet.key", market: "BTCUSD", side: "buy", price: 77_000,
  size: 0.00018, bestBid: 77_100, bestAsk: 77_110, orderRequestId: "2026082601",
  cancelRequestId: "2026082602", gasLimit: 1_300_000, chainNonce: 12,
};

describe("Perpl canary operator handoff", () => {
  it("prints one review-only invocation of the existing canary", () => {
    const result = preparePerplCanaryHandoff(valid);
    expect(result).toMatchObject({ mode: "operator-review-only", executable: false, market: "BTCUSD", notionalUsd: 13.86 });
    expect(result.command).toContain("--gate=mainnet");
    expect(result.command).toContain("--perpetual-id=1");
    expect(result.argv[0]).toBe("rust/perpl-bridge/target/release/canary");
  });

  it.each([
    { arm: "wrong" }, { price: 77_100 }, { size: 1 },
    { orderRequestId: "same", cancelRequestId: "same" }, { gasLimit: 1_300_001 },
    { signerKeyFile: "bad\npath" },
  ])("rejects unsafe input before producing a command: %o", (override) => {
    expect(() => preparePerplCanaryHandoff({ ...valid, ...override } as CanaryHandoffInput)).toThrow();
  });

  it("maps ETH sell only when above the best ask", () => {
    const result = preparePerplCanaryHandoff({ ...valid, market: "ETHUSD", side: "sell", price: 2501, size: 0.004, bestBid: 2499, bestAsk: 2500 });
    expect(result.command).toContain("--perpetual-id=20");
  });
});
