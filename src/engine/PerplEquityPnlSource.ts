import type { RealizedPnlSource } from "../paperRunner/PaperRunner.js";
import type { PerplLiveAdapter } from "./PerplLiveAdapter.js";
import type { PerplSessionEquityGuard } from "./PerplSessionEquityGuard.js";

/** Conservatively treats every observed account-equity decrease as session loss. */
export class PerplEquityPnlSource implements RealizedPnlSource {
  readonly scope = "account" as const;
  private lastEquity?: number;
  constructor(
    private readonly adapter: PerplLiveAdapter,
    private readonly guard: PerplSessionEquityGuard,
    private readonly onHalt: (reason: string) => void = () => undefined,
  ) {}
  arm(): void {
    const evidence = this.adapter.getSessionEquityEvidence();
    this.guard.arm(evidence);
    this.lastEquity = equity(evidence);
  }
  async drainRealizedPnlDeltaUsd(): Promise<number> {
    const evidence = this.adapter.getSessionEquityEvidence();
    const status = this.guard.observe(evidence);
    if (status.state !== "active" || !status.healthy) {
      const reason = status.haltReason ?? "Perpl session equity guard halted";
      this.onHalt(reason);
      throw new Error(reason);
    }
    const current = equity(evidence);
    const previous = this.lastEquity;
    this.lastEquity = current;
    // Account equity is a signed net measure. Preserve recoveries so ordinary mark-to-market
    // oscillation cannot accumulate every downward tick into a fictitious realized loss.
    return previous === undefined ? 0 : current - previous;
  }
}

function equity(evidence: ReturnType<PerplLiveAdapter["getSessionEquityEvidence"]>): number {
  const value =
    Number(evidence.balance) + Number(evidence.positionDeposit) + Number(evidence.unrealizedPnl);
  if (!Number.isFinite(value) || value < 0) throw new Error("Perpl equity evidence is invalid");
  return value;
}
