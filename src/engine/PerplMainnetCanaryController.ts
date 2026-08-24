import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DryRunPlan, DryRunProposal } from "./MarketMakingDryRun.js";

export type CanaryExecutionResult =
  | { state: "confirmed"; exchangeOrderId: string }
  | { state: "rejected"; reason: string }
  | { state: "ambiguous"; reason: string };

export interface PerplCanaryExecutor {
  place(input: {
    market: string;
    side: "buy" | "sell";
    price: number;
    size: number;
    postOnly: true;
    reduceOnly: boolean;
    clientActionId: string;
  }): Promise<CanaryExecutionResult>;
  cancel(input: {
    market: string;
    exchangeOrderId: string;
    clientActionId: string;
  }): Promise<CanaryExecutionResult>;
}

export type PerplCanaryJournal =
  | { version: 1; state: "idle"; updatedAt: number }
  | {
      version: 1;
      state: "placement_intent" | "resting" | "cancel_intent";
      market: string;
      clientActionId: string;
      exchangeOrderId?: string;
      updatedAt: number;
    }
  | { version: 1; state: "halted"; reason: string; updatedAt: number };

export interface PerplMainnetCanaryControllerOptions {
  market: string;
  journalPath: string;
  maxPlanAgeMs?: number;
  maxNotionalUsd?: number;
  now?: () => number;
}

/**
 * Fail-closed, single-order mainnet canary state machine. It has no production executor wiring;
 * callers must inject an executor explicitly. Every external action is journaled first, no
 * placement is retried, and any ambiguous outcome permanently halts this instance.
 */
export class PerplMainnetCanaryController {
  private journal: PerplCanaryJournal;
  private busy = false;
  private readonly now: () => number;
  private readonly maxPlanAgeMs: number;
  private readonly maxNotionalUsd: number;

  constructor(
    private readonly executor: PerplCanaryExecutor,
    private readonly options: PerplMainnetCanaryControllerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.maxPlanAgeMs = options.maxPlanAgeMs ?? 10_000;
    this.maxNotionalUsd = options.maxNotionalUsd ?? 20;
    if (!(this.maxPlanAgeMs > 0) || !(this.maxNotionalUsd > 0 && this.maxNotionalUsd <= 20))
      throw new Error("Perpl canary controller limits are invalid");
    this.journal = this.loadJournal();
    if (this.journal.state !== "idle") {
      this.persist(
        this.halted(
          `startup found unresolved journal state ${this.journal.state}; manual review required`,
        ),
      );
    }
  }

  status(): PerplCanaryJournal {
    return { ...this.journal };
  }

  async placeOne(plan: DryRunPlan, proposalIndex: number, clientActionId: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.journal.state !== "idle") throw new Error("Perpl canary controller is not idle");
      const proposal = this.validatePlacement(plan, proposalIndex, clientActionId);
      this.persist({
        version: 1,
        state: "placement_intent",
        market: plan.market,
        clientActionId,
        updatedAt: this.now(),
      });
      let result: CanaryExecutionResult;
      try {
        result = await this.executor.place({
          market: plan.market,
          side: proposal.side,
          price: proposal.price,
          size: proposal.size,
          postOnly: true,
          reduceOnly: proposal.reduceOnly,
          clientActionId,
        });
      } catch (error) {
        this.persist(this.halted(`placement threw after intent was persisted: ${String(error)}`));
        return;
      }
      if (result.state !== "confirmed" || !result.exchangeOrderId) {
        const detail = result.state === "confirmed" ? "empty order identity" : result.reason;
        this.persist(this.halted(`placement ${result.state}: ${detail}`));
        return;
      }
      this.persist({
        version: 1,
        state: "resting",
        market: plan.market,
        clientActionId,
        exchangeOrderId: result.exchangeOrderId,
        updatedAt: this.now(),
      });
    });
  }

  async cancelActive(clientActionId: string): Promise<void> {
    await this.exclusive(async () => {
      const active = this.journal;
      if (active.state !== "resting" || !active.exchangeOrderId)
        throw new Error("Perpl canary controller has no confirmed resting order");
      if (!clientActionId || clientActionId === active.clientActionId)
        throw new Error("cancellation requires a distinct non-empty action id");
      this.persist({
        version: 1,
        state: "cancel_intent",
        market: active.market,
        clientActionId,
        exchangeOrderId: active.exchangeOrderId,
        updatedAt: this.now(),
      });
      let result: CanaryExecutionResult;
      try {
        result = await this.executor.cancel({
          market: active.market,
          exchangeOrderId: active.exchangeOrderId,
          clientActionId,
        });
      } catch (error) {
        this.persist(this.halted(`cancellation threw after intent was persisted: ${String(error)}`));
        return;
      }
      if (
        result.state !== "confirmed" ||
        result.exchangeOrderId !== active.exchangeOrderId
      ) {
        const detail = result.state === "confirmed" ? "order identity mismatch" : result.reason;
        this.persist(this.halted(`cancellation ${result.state}: ${detail}`));
        return;
      }
      this.persist({ version: 1, state: "idle", updatedAt: this.now() });
    });
  }

  private validatePlacement(
    plan: DryRunPlan,
    proposalIndex: number,
    clientActionId: string,
  ): DryRunProposal {
    if (!clientActionId) throw new Error("placement requires a non-empty action id");
    if (plan.market !== this.options.market) throw new Error("canary plan market mismatch");
    if (this.now() - plan.generatedAt < 0 || this.now() - plan.generatedAt > this.maxPlanAgeMs)
      throw new Error("canary plan is stale");
    if (!plan.reconciliation.healthy || plan.reconciliation.anomalies.length)
      throw new Error("canary reconciliation is unhealthy");
    if (plan.observedOpenOrders.length || plan.proposedCancellations.length)
      throw new Error("canary requires zero existing or pending-cancellation orders");
    if (plan.accountEvidence?.frozen !== false)
      throw new Error("canary requires authoritative unfrozen account evidence");
    if (!plan.positionSafetyEvidence)
      throw new Error("canary requires position safety evidence");
    const safety = plan.positionSafetyEvidence;
    if (
      safety.baseSize !== 0 &&
      safety.liquidationPrice > 0 &&
      (safety.baseSize > 0
        ? safety.markPrice <= safety.liquidationPrice
        : safety.markPrice >= safety.liquidationPrice)
    )
      throw new Error("canary position is at or beyond its liquidation boundary");
    const proposal = plan.proposals[proposalIndex];
    if (!proposal || !proposal.allowed || proposal.type !== "postOnly")
      throw new Error("canary proposal is absent, blocked, or not post-only");
    const notional = proposal.price * proposal.size;
    if (
      !Number.isFinite(proposal.price) ||
      !Number.isFinite(proposal.size) ||
      proposal.price <= 0 ||
      proposal.size <= 0 ||
      !Number.isFinite(notional) ||
      notional > this.maxNotionalUsd
    )
      throw new Error("canary proposal exceeds numeric or notional limits");
    return proposal;
  }

  private async exclusive(action: () => Promise<void>): Promise<void> {
    if (this.busy) throw new Error("Perpl canary controller action already in progress");
    this.busy = true;
    try {
      await action();
    } finally {
      this.busy = false;
    }
  }

  private loadJournal(): PerplCanaryJournal {
    try {
      const parsed = JSON.parse(readFileSync(this.options.journalPath, "utf8")) as PerplCanaryJournal;
      if (parsed.version !== 1 || typeof parsed.state !== "string" || !Number.isFinite(parsed.updatedAt))
        throw new Error("invalid journal shape");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, state: "idle", updatedAt: this.now() };
      throw new Error(`Perpl canary journal could not be loaded: ${String(error)}`);
    }
  }

  private halted(reason: string): PerplCanaryJournal {
    return { version: 1, state: "halted", reason, updatedAt: this.now() };
  }

  private persist(journal: PerplCanaryJournal): void {
    mkdirSync(dirname(this.options.journalPath), { recursive: true });
    const temporary = `${this.options.journalPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(journal, null, 2), "utf8");
    renameSync(temporary, this.options.journalPath);
    this.journal = journal;
  }
}
