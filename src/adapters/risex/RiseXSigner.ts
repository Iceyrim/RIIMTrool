/**
 * The one signing seam RiseXAdapter needs: a single EIP-712 `Login` signature at connect() time
 * (SPEC.md Section 11's locked "Auth" decision — JWT bearer, not per-call permit signing). Kept
 * as an injected interface, not a concrete implementation, deliberately: this project's
 * constraints (CLAUDE.md, SPEC.md Section 9.1) require that no real private key or signing ever
 * happens inside an AI coding session, and RISEx has no public testnet to safely exercise it
 * against even if one existed (SPEC.md Section 11 "No public testnet"). A real implementation
 * (e.g. wrapping a viem/ethers LocalAccount over a key sourced from `.env` at the process
 * boundary, mirroring how N1Adapter takes `privateKey` in its config) is future work for the
 * human operator to wire up outside this session — see CLAUDE.md's "When eventually going live"
 * section. Fixture tests use FakeRiseXSigner (test/adapters/risex/fakeSigner.ts) instead.
 */
export interface RiseXEip712Domain {
  name: string;
  version: string;
  chainId: string;
  verifyingContract: string;
}

export interface RiseXSigner {
  /** Returns a 0x-prefixed hex EIP-712 signature over the `Login(address account,uint256
   * nonce,uint32 deadline)` typed data, per the given domain. `nonce` is passed through exactly
   * as returned by GET /v1/auth/nonce (a hex string) — RISEx's docs specify it must be parsed
   * base-16 into a uint256 before signing, which is the signer implementation's responsibility,
   * not the adapter's. */
  signLogin(params: {
    domain: RiseXEip712Domain;
    account: string;
    nonce: string;
    deadline: number;
  }): Promise<string>;
}
