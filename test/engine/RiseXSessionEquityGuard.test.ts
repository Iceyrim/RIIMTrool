import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RiseXSessionEquityGuard } from "../../src/engine/RiseXSessionEquityGuard.js";

const NOW = Date.UTC(2026, 8, 3, 12);
const journalPath = () => join("/tmp", `risex-equity-${process.pid}-${Math.random()}.json`);

describe("RiseXSessionEquityGuard", () => {
  it("halts at the durable daily cap", () => {
    const path = journalPath();
    const guard = new RiseXSessionEquityGuard(path, 10, 2, 5, () => NOW);
    guard.arm(35);
    expect(guard.observe(33)).toMatchObject({
      state: "halted",
      healthy: false,
      haltReason: expect.stringMatching(/daily/),
    });
    expect(new RiseXSessionEquityGuard(path, 10, 2, 5, () => NOW).status()).toMatchObject({
      state: "halted",
    });
  });

  it("preserves daily and weekly windows across a manual reset", () => {
    const path = journalPath();
    const first = new RiseXSessionEquityGuard(path, 2, 2, 5, () => NOW);
    first.arm(35);
    expect(first.observe(34)).toMatchObject({ dailyChange: -1, weeklyChange: -1 });
    const restarted = new RiseXSessionEquityGuard(path, 2, 2, 5, () => NOW);
    expect(restarted.manualReset("RESET HALTED RISEX EQUITY SESSION")).toMatchObject({
      state: "idle",
    });
    restarted.arm(34);
    expect(restarted.status()).toMatchObject({ dailyChange: -1, weeklyChange: -1 });
  });

  it("requires the exact reset phrase", () => {
    expect(() =>
      new RiseXSessionEquityGuard(journalPath(), 2, 2, 5, () => NOW).manualReset("reset"),
    ).toThrow(/exact/);
  });
});
