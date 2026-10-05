import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("disabled Perpl cross-language rehearsal safety surface", () => {
  it("exposes only a worker-path option and declares execution non-capable", () => {
    const source = readFileSync(
      resolve("scripts/run-perpl-disabled-cross-language-rehearsal.ts"),
      "utf8",
    );
    expect(source).toContain('const allowedArgs = new Set(["--worker"])');
    expect(source).toContain('mode: "disabled-cross-language-rehearsal"');
    expect(source).toContain("transactionCapable: false");
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/signer|wallet|private.?key|nonce|gas/i);
  });

  it("spawns only the compile-time disabled Rust worker", () => {
    const source = readFileSync(
      resolve("src/adapters/perpl/onchain/PerplDisabledExecutionTransport.ts"),
      "utf8",
    );
    expect(source).toContain("--journal-path=");
    expect(source).not.toMatch(/shell:\s*true/);
    expect(source).not.toMatch(/https?:\/\//);
  });
});
