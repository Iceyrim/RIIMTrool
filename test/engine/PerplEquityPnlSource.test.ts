import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PerplLiveAdapter } from "../../src/engine/PerplLiveAdapter.js";
import { PerplEquityPnlSource } from "../../src/engine/PerplEquityPnlSource.js";
import {
  PerplSessionEquityGuard,
  type PerplEquityEvidence,
} from "../../src/engine/PerplSessionEquityGuard.js";

const NOW = 1_800_000_000_000;
const journalPath = () => join("/tmp", `perpl-pnl-source-${process.pid}-${Math.random()}.json`);

function evidence(balance: number, blockNumber: number): PerplEquityEvidence {
  return {
    balance: String(balance),
    lockedBalance: "0",
    positionDeposit: "0",
    unrealizedPnl: "0",
    frozen: false,
    blockNumber: String(blockNumber),
    observedAt: NOW,
  };
}

function adapterAt(initial: PerplEquityEvidence): {
  adapter: PerplLiveAdapter;
  setEvidence: (next: PerplEquityEvidence) => void;
} {
  let current = initial;
  return {
    adapter: {
      getSessionEquityEvidence: () => current,
    } as unknown as PerplLiveAdapter,
    setEvidence: (next) => {
      current = next;
    },
  };
}

describe("PerplEquityPnlSource", () => {
  it("returns signed equity changes so recoveries offset declines", async () => {
    const { adapter, setEvidence } = adapterAt(evidence(100, 100));
    const guard = new PerplSessionEquityGuard(journalPath(), 10, 10_000, () => NOW);
    const source = new PerplEquityPnlSource(adapter, guard);
    source.arm();

    setEvidence(evidence(99, 101));
    expect(await source.drainRealizedPnlDeltaUsd()).toBe(-1);

    setEvidence(evidence(100, 102));
    expect(await source.drainRealizedPnlDeltaUsd()).toBe(1);
    expect(guard.status()).toMatchObject({ sessionChange: 0 });
  });

  it("still halts when net session equity reaches the configured loss cap", async () => {
    const { adapter, setEvidence } = adapterAt(evidence(100, 100));
    const guard = new PerplSessionEquityGuard(journalPath(), 2, 10_000, () => NOW);
    const onHalt = vi.fn();
    const source = new PerplEquityPnlSource(adapter, guard, onHalt);
    source.arm();

    setEvidence(evidence(98, 101));
    await expect(source.drainRealizedPnlDeltaUsd()).rejects.toThrow(
      "Perpl session equity loss limit reached",
    );
    expect(onHalt).toHaveBeenCalledWith("Perpl session equity loss limit reached");
    expect(guard.status()).toMatchObject({ state: "halted" });
  });
});
