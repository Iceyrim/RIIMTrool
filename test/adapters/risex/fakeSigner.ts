import type { RiseXSigner } from "../../../src/adapters/risex/RiseXSigner.js";

/**
 * Deterministic fake signer for fixture tests — NEVER performs real EIP-712 signing or touches a
 * real private key, per SPEC.md Section 9's "never sign anything with a real private key during
 * development" constraint. Records the params it was called with so tests can assert the adapter
 * built the Login message correctly.
 */
export class FakeRiseXSigner implements RiseXSigner {
  calls: Parameters<RiseXSigner["signLogin"]>[0][] = [];

  async signLogin(params: Parameters<RiseXSigner["signLogin"]>[0]): Promise<string> {
    this.calls.push(params);
    return "0x" + "ab".repeat(65);
  }
}
