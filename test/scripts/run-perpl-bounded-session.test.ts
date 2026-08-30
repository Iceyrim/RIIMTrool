import { describe, expect, it } from "vitest";
import type { DryRunPlan } from "../../src/engine/MarketMakingDryRun.js";
import {
  boundedActionId,
  buildBoundedWorkerInvocation,
  parseBoundedSessionArgs,
  requirePassivePlan,
} from "../../scripts/run-perpl-bounded-session.js";

const valid = [
  "--arm=EXECUTE BOUNDED PERPL SESSION",
  "--signer=0xa89bC210BaB1156113571F2a9193c5282efBF78a",
  "--signer-key-file=canary-wallet.key",
  "--session-id=202608290401",
  "--market=BTCUSD",
  "--cycles=20",
  "--interval-ms=5000",
  "--chain-nonce=15",
  "--max-notional-usd=15",
];

describe("bounded Perpl session", () => {
  it("builds an isolated worker with an exact 20-action ceiling", () => {
    const args = parseBoundedSessionArgs(valid);
    const invocation = buildBoundedWorkerInvocation(args);
    expect(invocation.argv).toContain("--execution-mode=bounded-session");
    expect(invocation.argv).toContain("--max-actions=20");
    expect(invocation.argv).toContain("--chain-nonce=15");
    expect(invocation.state).toContain("202608290401");
  });

  it("derives distinct numeric u64 action identities", () => {
    const place = boundedActionId("202608290601", 1, "place");
    const cancel = boundedActionId("202608290601", 2, "cancel");
    const cleanup = boundedActionId("202608290601", 99, "cleanup");
    expect([place, cancel, cleanup].every((id) => /^\d+$/.test(id))).toBe(true);
    expect(new Set([place, cancel, cleanup]).size).toBe(3);
    expect(BigInt(cleanup)).toBeLessThanOrEqual(18_446_744_073_709_551_615n);
  });

  it.each([
    ["wrong arm", ["--arm=wrong", ...valid.slice(1)]],
    ["odd cycles", valid.map((item) => (item.startsWith("--cycles=") ? "--cycles=19" : item))],
    ["excess cycles", valid.map((item) => (item.startsWith("--cycles=") ? "--cycles=22" : item))],
    [
      "fast interval",
      valid.map((item) => (item.startsWith("--interval-ms=") ? "--interval-ms=1000" : item)),
    ],
    [
      "excess notional",
      valid.map((item) =>
        item.startsWith("--max-notional-usd=") ? "--max-notional-usd=21" : item,
      ),
    ],
    ["duplicate", [...valid, "--market=ETHUSD"]],
  ])("rejects %s", (_name, argv) => expect(() => parseBoundedSessionArgs(argv)).toThrow());

  it("blocks crossing and over-limit proposals without changing their prices", () => {
    const plan = {
      market: "BTCUSD",
      generatedAt: 1,
      reconciliation: {
        market: "BTCUSD",
        healthy: true,
        openOrderCount: 0,
        anomalies: [],
        checkedAt: 1,
      },
      positionBaseSize: 0,
      markPrice: 100,
      observedOpenOrders: [],
      balances: [],
      proposedCancellations: [],
      proposals: [
        { side: "buy", price: 100, size: 0.1, type: "postOnly", reduceOnly: false, allowed: true },
        { side: "sell", price: 102, size: 0.2, type: "postOnly", reduceOnly: false, allowed: true },
        { side: "buy", price: 98, size: 0.1, type: "postOnly", reduceOnly: false, allowed: true },
      ],
      executionReady: false,
      readinessBlockers: [],
    } satisfies DryRunPlan;
    const bounded = requirePassivePlan(plan, { bestBid: 100, bestAsk: 101 }, 15);
    expect(bounded.proposals.map((proposal) => proposal.allowed)).toEqual([false, false, true]);
    expect(bounded.proposals.map((proposal) => proposal.price)).toEqual([100, 102, 98]);
  });
});
