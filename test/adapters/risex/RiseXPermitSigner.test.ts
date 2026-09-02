import { describe, expect, it } from "vitest";
import { EthersRiseXPermitSigner, hashRiseXCancelAction, hashRiseXPlaceAction, packRiseXOrderData } from "../../../src/adapters/risex/RiseXPermitSigner.js";

const place = {
  marketId: 1, sizeSteps: 100, priceTicks: 50000, side: 0, postOnly: true,
  reduceOnly: false, stpMode: 0, orderType: 1, timeInForce: 0,
  builderId: 0, clientOrderId: 42n, ttlUnits: 0, builderFeeBps: 0,
};

describe("RISEx session permit signer", () => {
  it("packs the documented uint88 order layout and hashes deterministically", () => {
    expect(packRiseXOrderData(place)).toBe(
      (1n << 70n) | (100n << 38n) | (50000n << 14n) | (34n << 6n) | 2n,
    );
    expect(hashRiseXPlaceAction(place)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashRiseXPlaceAction(place)).toBe(hashRiseXPlaceAction({ ...place }));
  });

  it("hashes exact cancellation identity using market and resting order IDs", () => {
    expect(hashRiseXCancelAction({ marketId: 1, restingOrderId: 123n })).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashRiseXCancelAction({ marketId: 1, restingOrderId: 123n }))
      .not.toBe(hashRiseXCancelAction({ marketId: 1, restingOrderId: 124n }));
  });

  it("produces a base64 EIP-2098 signature without exposing the wallet key", async () => {
    const signer = new EthersRiseXPermitSigner("0x" + "11".repeat(32));
    const permit = await signer.signPlace({
      domain: { name: "RISEx Auth", version: "1", chainId: "11155931", verifyingContract: "0x0000000000000000000000000000000000000001" },
      account: "0x0000000000000000000000000000000000000002",
      router: "0x0000000000000000000000000000000000000003",
      nonce: { nonceAnchor: 7n, nonceBitmapIndex: 4 }, deadline: 2_000_000_000,
    }, place);
    expect(permit.signer).toBe(signer.address);
    expect(permit.nonce_anchor).toBe("7");
    expect(Buffer.from(permit.signature, "base64")).toHaveLength(64);
  });

  it("fails closed on an exhausted bitmap nonce", async () => {
    const signer = new EthersRiseXPermitSigner("0x" + "22".repeat(32));
    await expect(signer.signPlace({
      domain: { name: "RISEx Auth", version: "1", chainId: 1, verifyingContract: "0x0000000000000000000000000000000000000001" },
      account: "0x0000000000000000000000000000000000000002",
      router: "0x0000000000000000000000000000000000000003",
      nonce: { nonceAnchor: 1n, nonceBitmapIndex: 208 }, deadline: 2_000_000_000,
    }, place)).rejects.toThrow(/0\.\.207/);
  });
});

