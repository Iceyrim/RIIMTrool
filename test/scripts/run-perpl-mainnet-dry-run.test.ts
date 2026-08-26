import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("run-perpl-mainnet-dry-run safety surface", () => {
  it("pins public mainnet identity and exposes no signer or transaction option", () => {
    const source = readFileSync(resolve("scripts/run-perpl-mainnet-dry-run.ts"), "utf8");
    expect(source).toContain('rpcUrl: "https://rpc.monad.xyz"');
    expect(source).toContain("accountIds: [5071]");
    expect(source).toContain('"--equity-session-action"');
    expect(source).toContain('"--i-confirm-equity-reset"');
    expect(source).toContain('equitySessionAction === "arm"');
    expect(source).toContain("adapter.getSessionEquityEvidence()");
    expect(source).toContain("sessionEquityGuard: equityGuard");
    expect(source).toContain("RESET-HALTED-PERPL-EQUITY-SESSION");
    expect(source).not.toMatch(/--(?:key|signer|wallet|nonce|gas)/);
    expect(source).not.toMatch(/placeOrder|cancelOrder|prepareExecOrders/);
  });
});
