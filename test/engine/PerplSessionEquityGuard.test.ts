import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PerplSessionEquityGuard,
  type PerplEquityEvidence,
} from "../../src/engine/PerplSessionEquityGuard.js";

const NOW = 1_800_000_000_000;

function evidence(overrides: Partial<PerplEquityEvidence> = {}): PerplEquityEvidence {
  return {
    balance: "18",
    lockedBalance: "0",
    positionDeposit: "0",
    unrealizedPnl: "0",
    frozen: false,
    blockNumber: "100",
    observedAt: NOW,
    ...overrides,
  };
}

function journalPath(): string {
  return join(mkdtempSync(join(tmpdir(), "riimtrool-perpl-equity-")), "guard.json");
}

function guard(path = journalPath()): PerplSessionEquityGuard {
  return new PerplSessionEquityGuard(path, 6, 10_000, () => NOW);
}

describe("PerplSessionEquityGuard", () => {
  it("tracks conservative account equity without double-counting locked balance", () => {
    const subject = guard();
    expect(subject.arm(evidence())).toMatchObject({
      state: "active",
      healthy: true,
      baselineEquity: 18,
      currentEquity: 18,
      sessionChange: 0,
    });

    expect(
      subject.observe(
        evidence({
          balance: "17",
          lockedBalance: "8",
          positionDeposit: "1",
          unrealizedPnl: "-0.5",
          blockNumber: "101",
        }),
      ),
    ).toMatchObject({ currentEquity: 17.5, sessionChange: -0.5, healthy: true });
  });

  it("halts when the loss ceiling is reached exactly", () => {
    const subject = guard();
    subject.arm(evidence());
    expect(subject.observe(evidence({ balance: "12", blockNumber: "101" }))).toMatchObject({
      state: "halted",
      healthy: false,
      haltReason: "Perpl session equity loss limit reached",
    });
  });

  it.each([
    ["frozen", { frozen: true }, "Perpl account is frozen"],
    ["stale", { observedAt: NOW - 10_001 }, "equity evidence is stale or invalid"],
    ["malformed", { balance: "NaN" }, "invalid balance"],
    ["regressed", { blockNumber: "99" }, "equity evidence block regressed"],
  ] as const)("halts on %s evidence", (_case, overrides, reason) => {
    const subject = guard();
    subject.arm(evidence());
    expect(subject.observe(evidence(overrides))).toMatchObject({
      state: "halted",
      healthy: false,
      haltReason: expect.stringContaining(reason),
    });
  });

  it("halts when account classification changes within one block", () => {
    const subject = guard();
    subject.arm(evidence());
    expect(subject.observe(evidence({ lockedBalance: "1" }))).toMatchObject({
      state: "halted",
      haltReason: "equity evidence changed within the same block; classification is ambiguous",
    });
  });

  it("fails closed after restart until an exact manual reset", () => {
    const path = journalPath();
    const first = guard(path);
    first.arm(evidence());

    const restarted = guard(path);
    expect(restarted.status()).toMatchObject({
      state: "halted",
      healthy: false,
      haltReason: "restart found an unresolved active equity session; manual review required",
    });
    expect(() => restarted.arm(evidence())).toThrow(/must be idle/);
    expect(() => restarted.manualReset("RESET")).toThrow(/exact manual reset phrase/);
    expect(restarted.manualReset("RESET HALTED PERPL EQUITY SESSION")).toEqual({
      state: "idle",
      healthy: false,
    });
  });
});
