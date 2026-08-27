import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rehearsalPlan } from "../../scripts/run-perpl-execution-rehearsal.js";
import { PerplAutomationSessionOrchestrator } from "../../src/engine/PerplAutomationSessionOrchestrator.js";
import {
  PerplMainnetCanaryController,
  type CanaryExecutionResult,
  type PerplCanaryExecutor,
} from "../../src/engine/PerplMainnetCanaryController.js";
import type { DryRunPlan } from "../../src/engine/MarketMakingDryRun.js";

class FakeExecutor implements PerplCanaryExecutor {
  calls: Array<{ action: "place" | "cancel"; input: unknown }> = [];
  cancelResult: CanaryExecutionResult = { state: "confirmed", exchangeOrderId: "47" };

  async place(input: unknown): Promise<CanaryExecutionResult> {
    this.calls.push({ action: "place", input });
    return { state: "confirmed", exchangeOrderId: "47" };
  }

  async cancel(input: unknown): Promise<CanaryExecutionResult> {
    this.calls.push({ action: "cancel", input });
    return this.cancelResult;
  }
}

function setup() {
  const executor = new FakeExecutor();
  const controller = new PerplMainnetCanaryController(executor, {
    market: "BTCUSD",
    journalPath: join(mkdtempSync(join(tmpdir(), "perpl-automation-session-")), "journal.json"),
    now: () => 1_000,
  });
  const orchestrator = new PerplAutomationSessionOrchestrator(
    controller,
    "BTCUSD",
    "offline-session",
  );
  return { executor, controller, orchestrator };
}

function plan(override: Partial<DryRunPlan> = {}): DryRunPlan {
  return { ...rehearsalPlan(), ...override };
}

describe("PerplAutomationSessionOrchestrator", () => {
  it("alternates one placement and one cancellation per quote lifecycle", async () => {
    const { executor, orchestrator } = setup();
    await expect(orchestrator.step(plan(), 1)).resolves.toMatchObject({
      action: "placed",
      controller: { state: "resting" },
    });
    await expect(orchestrator.step(plan(), 2)).resolves.toMatchObject({
      action: "cancelled_for_requote",
      controller: { state: "idle" },
    });
    await expect(orchestrator.step(plan(), 3)).resolves.toMatchObject({ action: "placed" });
    expect(executor.calls.map((call) => call.action)).toEqual(["place", "cancel", "place"]);
  });

  it("cleans up a resting order when the equity guard halts", async () => {
    const { executor, orchestrator } = setup();
    await orchestrator.step(plan(), 1);
    const haltedPlan = plan({
      sessionEquityGuard: {
        state: "halted",
        healthy: false,
        haltReason: "Perpl session equity loss limit reached",
      },
      proposals: [],
    });
    await expect(orchestrator.step(haltedPlan, 2)).resolves.toMatchObject({
      action: "cleaned_after_halt",
      reason: "Perpl session equity loss limit reached",
      controller: { state: "idle" },
    });
    await expect(orchestrator.step(haltedPlan, 3)).resolves.toMatchObject({
      action: "blocked",
      controller: { state: "idle" },
    });
    expect(executor.calls.map((call) => call.action)).toEqual(["place", "cancel"]);
  });

  it("permanently halts when safety cleanup is ambiguous", async () => {
    const { executor, controller, orchestrator } = setup();
    await orchestrator.step(plan(), 1);
    executor.cancelResult = { state: "ambiguous", reason: "receipt timeout" };
    await expect(
      orchestrator.step(
        plan({
          sessionEquityGuard: { state: "halted", healthy: false, haltReason: "loss cap" },
          proposals: [],
        }),
        2,
      ),
    ).resolves.toMatchObject({ action: "halted", reason: expect.stringContaining("timeout") });
    expect(controller.status()).toMatchObject({ state: "halted" });
    await expect(orchestrator.step(plan(), 3)).resolves.toMatchObject({ action: "halted" });
    expect(executor.calls).toHaveLength(2);
  });

  it("rejects skipped or repeated cycles before any executor action", async () => {
    const { executor, orchestrator } = setup();
    await expect(orchestrator.step(plan(), 2)).rejects.toThrow(/cycles/);
    expect(executor.calls).toEqual([]);
  });
});
