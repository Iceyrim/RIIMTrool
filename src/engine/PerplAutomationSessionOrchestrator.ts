import type { DryRunPlan } from "./MarketMakingDryRun.js";
import {
  PerplMainnetCanaryController,
  type PerplCanaryJournal,
} from "./PerplMainnetCanaryController.js";

export interface PerplAutomationStepResult {
  cycle: number;
  action: "placed" | "cancelled_for_requote" | "cleaned_after_halt" | "blocked" | "halted";
  reason?: string;
  controller: PerplCanaryJournal;
}

/**
 * Offline-only automation rehearsal coordinator. It deliberately performs at most one injected
 * executor action per cycle and has no production construction path. Unsafe plans trigger cleanup
 * of a confirmed resting order, while ambiguous controller outcomes remain permanently halted.
 */
export class PerplAutomationSessionOrchestrator {
  private lastCycle = 0;

  constructor(
    private readonly controller: PerplMainnetCanaryController,
    private readonly market: string,
    private readonly sessionId: string,
  ) {
    if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error("Perpl automation rehearsal session id is invalid");
    }
  }

  async step(plan: DryRunPlan, cycle: number): Promise<PerplAutomationStepResult> {
    if (!Number.isSafeInteger(cycle) || cycle !== this.lastCycle + 1) {
      throw new Error("Perpl automation rehearsal cycles must increase exactly once");
    }
    this.lastCycle = cycle;
    if (plan.market !== this.market) throw new Error("Perpl automation rehearsal market mismatch");

    const before = this.controller.status();
    if (before.state === "halted") {
      return this.result(cycle, "halted", before.reason);
    }

    const blocker = this.blocker(plan);
    if (before.state === "resting") {
      await this.controller.cancelActive(
        `${this.sessionId}-${cycle}-${blocker ? "safety-cleanup" : "requote-cancel"}`,
      );
      const after = this.controller.status();
      if (after.state === "halted") return this.result(cycle, "halted", after.reason);
      return this.result(cycle, blocker ? "cleaned_after_halt" : "cancelled_for_requote", blocker);
    }

    if (before.state !== "idle") {
      return this.result(cycle, "blocked", `controller state ${before.state} requires review`);
    }
    if (blocker) return this.result(cycle, "blocked", blocker);

    const proposalIndex = plan.proposals.findIndex((proposal) => proposal.allowed);
    if (proposalIndex < 0) return this.result(cycle, "blocked", "plan has no allowed proposal");
    await this.controller.placeOne(plan, proposalIndex, `${this.sessionId}-${cycle}-place`);
    const after = this.controller.status();
    if (after.state === "halted") return this.result(cycle, "halted", after.reason);
    return this.result(cycle, "placed");
  }

  private blocker(plan: DryRunPlan): string | undefined {
    if (plan.sessionEquityGuard?.state !== "active" || !plan.sessionEquityGuard.healthy) {
      return (
        plan.sessionEquityGuard?.haltReason ?? "session equity guard is not active and healthy"
      );
    }
    if (!plan.reconciliation.healthy || plan.reconciliation.anomalies.length) {
      return "reconciliation is unhealthy";
    }
    if (plan.accountEvidence?.frozen !== false) return "account evidence is frozen or unavailable";
    if (plan.observedOpenOrders.length || plan.proposedCancellations.length) {
      return "plan contains unmanaged or pending-cancellation orders";
    }
    return undefined;
  }

  private result(
    cycle: number,
    action: PerplAutomationStepResult["action"],
    reason?: string,
  ): PerplAutomationStepResult {
    return {
      cycle,
      action,
      ...(reason ? { reason } : {}),
      controller: this.controller.status(),
    };
  }
}
