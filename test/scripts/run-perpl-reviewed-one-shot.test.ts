import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/run-perpl-reviewed-one-shot.js";

const valid = [
  "--arm=EXECUTE REVIEWED PERPL ONE-SHOT",
  "--socket-path=/tmp/perpl.sock",
  "--market=BTCUSD",
  "--side=buy",
  "--price=77000",
  "--size=0.00018",
  "--placement-action-id=2026082701",
  "--cancellation-action-id=2026082702",
  "--equity-journal=state/equity.json",
  "--controller-journal=state/controller.json",
];

describe("reviewed Perpl one-shot CLI", () => {
  it("accepts only explicit reviewed execution inputs", () => {
    expect(parseArgs(valid)).toMatchObject({
      market: "BTCUSD",
      side: "buy",
      price: 77000,
      size: 0.00018,
      socketPath: "/tmp/perpl.sock",
      socketTimeoutMs: 180000,
    });
  });

  it.each([
    ["wrong arm", ["--arm=wrong", ...valid.slice(1)]],
    ["unknown input", [...valid, "--signer=forbidden"]],
    ["duplicate input", [...valid, "--market=ETHUSD"]],
    ["invalid price", valid.map((value) => (value.startsWith("--price=") ? "--price=0" : value))],
    ["unsafe timeout", [...valid, "--socket-timeout-ms=5000"]],
  ])("rejects %s before connecting", (_case, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it("contains no wallet, key, signer, nonce, gas, or process-spawn input", () => {
    const source = readFileSync(resolve("scripts/run-perpl-reviewed-one-shot.ts"), "utf8");
    expect(source).toContain('rpcUrl: "https://rpc.monad.xyz"');
    expect(source).toContain("getBookEvidence");
    expect(source).not.toMatch(/signer|wallet|private.?key|nonce|gas/i);
    expect(source).not.toMatch(/child_process|spawn\s*\(/);
  });
});
