import type { DryRunPlan } from "./MarketMakingDryRun.js";
import {
  PerplMainnetCanaryController,
  type PerplCanaryJournal,
} from "./PerplMainnetCanaryController.js";

export interface PerplOneShotCanaryReport {
  state: "completed" | "halted";
  market: string;
  placementActionId: string;
  cancellationActionId: string;
  exchangeOrderId?: string;
  reason?: string;
  controller: PerplCanaryJournal;
}

/** Executes exactly one reviewed placement/cancellation lifecycle and can never be reused. */
export class PerplOneShotCanaryRunner {
  private consumed = false;

  constructor(
    private readonly controller: PerplMainnetCanaryController,
    private readonly market: string,
  ) {}

  async run(input: {
    plan: DryRunPlan;
    proposalIndex: number;
    placementActionId: string;
    cancellationActionId: string;
  }): Promise<PerplOneShotCanaryReport> {
    if (this.consumed) throw new Error("Perpl one-shot canary runner has already been consumed");
    this.consumed = true;
    this.validateActionIds(input.placementActionId, input.cancellationActionId);
    if (input.plan.market !== this.market) throw new Error("Perpl one-shot market mismatch");
    if (this.controller.status().state !== "idle") {
      throw new Error("Perpl one-shot controller must begin idle");
    }

    await this.controller.placeOne(input.plan, input.proposalIndex, input.placementActionId);
    const placed = this.controller.status();
    if (placed.state !== "resting") {
      return this.report(input, placed, undefined);
    }
    const exchangeOrderId = placed.exchangeOrderId;
    await this.controller.cancelActive(input.cancellationActionId);
    const final = this.controller.status();
    if (final.state !== "idle") return this.report(input, final, exchangeOrderId);
    return {
      state: "completed",
      market: this.market,
      placementActionId: input.placementActionId,
      cancellationActionId: input.cancellationActionId,
      exchangeOrderId,
      controller: final,
    };
  }

  private validateActionIds(placement: string, cancellation: string): void {
    if (!/^[1-9]\d{0,19}$/.test(placement) || !/^[1-9]\d{0,19}$/.test(cancellation)) {
      throw new Error("Perpl one-shot action ids must be nonzero numeric u64 values");
    }
    if (placement === cancellation) throw new Error("Perpl one-shot action ids must differ");
    if (
      BigInt(placement) > 18_446_744_073_709_551_615n ||
      BigInt(cancellation) > 18_446_744_073_709_551_615n
    ) {
      throw new Error("Perpl one-shot action id exceeds u64");
    }
  }

  private report(
    input: { placementActionId: string; cancellationActionId: string },
    controller: PerplCanaryJournal,
    exchangeOrderId?: string,
  ): PerplOneShotCanaryReport {
    const reason =
      controller.state === "halted"
        ? controller.reason
        : `unexpected controller state ${controller.state}`;
    return {
      state: "halted",
      market: this.market,
      placementActionId: input.placementActionId,
      cancellationActionId: input.cancellationActionId,
      ...(exchangeOrderId ? { exchangeOrderId } : {}),
      reason,
      controller,
    };
  }
}
