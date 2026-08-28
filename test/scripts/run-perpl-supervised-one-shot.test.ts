import { describe, expect, it } from "vitest";
import {
  buildInvocations,
  parseArgs,
} from "../../scripts/run-perpl-supervised-one-shot.js";

const valid = [
  "--arm=EXECUTE REVIEWED PERPL ONE-SHOT",
  "--signer=0xa89bC210BaB1156113571F2a9193c5282efBF78a",
  "--signer-key-file=canary-wallet.key",
  "--session-id=202608280201",
  "--market=BTCUSD",
  "--side=buy",
  "--price=78950",
  "--size=0.00018",
  "--placement-action-id=20260828020101",
  "--cancellation-action-id=20260828020102",
  "--chain-nonce=13",
];

describe("supervised Perpl one-shot CLI", () => {
  it("builds one isolated worker and runner without a shell", () => {
    const parsed = parseArgs(valid);
    const invocation = buildInvocations(parsed);
    expect(parsed.socketTimeoutMs).toBe(180_000);
    expect(invocation.state).toContain("state/perpl-reviewed-one-shot/202608280201");
    expect(invocation.worker[1]).toContain("--gate=mainnet");
    expect(invocation.worker[1]).toContain("--chain-nonce=13");
    expect(invocation.runner[1]).toContain("--socket-timeout-ms=180000");
  });

  it.each([
    ["wrong arm", ["--arm=wrong", ...valid.slice(1)]],
    [
      "reused session shape",
      valid.map((value) =>
        value.startsWith("--session-id=") ? "--session-id=../old" : value,
      ),
    ],
    [
      "excess notional",
      valid.map((value) => (value.startsWith("--size=") ? "--size=1" : value)),
    ],
    ["unsafe timeout", [...valid, "--socket-timeout-ms=5000"]],
    ["duplicate", [...valid, "--market=ETHUSD"]],
  ])("rejects %s", (_name, argv) => expect(() => parseArgs(argv)).toThrow());
});
