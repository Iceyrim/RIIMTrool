import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPerplExecutionRehearsal } from "../../scripts/run-perpl-execution-rehearsal.js";
import { PerplMainnetCanaryController } from "../../src/engine/PerplMainnetCanaryController.js";

describe("offline Perpl execution rehearsal", () => {
  it("completes exactly one correlated placement and cancellation", async () => {
    const result = await runPerplExecutionRehearsal();
    expect(result.mode).toBe("offline-in-memory-rehearsal");
    expect(result.calls.map((call) => call.action)).toEqual(["place", "cancel"]);
    expect(result.states.map((state) => state.state)).toEqual(["idle", "resting", "idle"]);
    expect(result.finalState.state).toBe("idle");
  });

  it.each(["rejected", "ambiguous"] as const)("halts after a %s placement without retry", async (placementOutcome) => {
    const result = await runPerplExecutionRehearsal({ placementOutcome });
    expect(result.calls).toHaveLength(1);
    expect(result.finalState.state).toBe("halted");
  });

  it("halts after an ambiguous cancellation without retry", async () => {
    const result = await runPerplExecutionRehearsal({ cancellationOutcome: "ambiguous" });
    expect(result.calls).toHaveLength(2);
    expect(result.finalState.state).toBe("halted");
  });

  it("requires manual review after restart with unresolved state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpl-rehearsal-restart-"));
    const journalPath = join(directory, "journal.json");
    const first = await runPerplExecutionRehearsal({ cancellationOutcome: "ambiguous", journalPath });
    expect(first.finalState.state).toBe("halted");
    const executor = { place: async () => ({ state: "ambiguous", reason: "unused" } as const), cancel: async () => ({ state: "ambiguous", reason: "unused" } as const) };
    const restarted = new PerplMainnetCanaryController(executor, { market: "BTCUSD", journalPath, now: () => 1_000 });
    expect(restarted.status()).toMatchObject({ state: "halted", reason: expect.stringContaining("manual review") });
  });
});
