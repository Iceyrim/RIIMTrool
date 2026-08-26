import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PerplEquityEvidence {
  balance: string;
  lockedBalance: string;
  positionDeposit: string;
  unrealizedPnl: string;
  frozen: boolean;
  blockNumber: string;
  observedAt: number;
}

export interface PerplEquityStatus {
  state: "idle" | "active" | "halted";
  healthy: boolean;
  baselineEquity?: number;
  currentEquity?: number;
  sessionChange?: number;
  blockNumber?: string;
  haltReason?: string;
}

interface Journal extends PerplEquityStatus {
  version: 1;
  lastEvidenceKey?: string;
}

export class PerplSessionEquityGuard {
  private journal: Journal;
  constructor(
    private readonly filePath: string,
    private readonly maxSessionLoss: number,
    private readonly maxEvidenceAgeMs = 10_000,
    private readonly now = Date.now,
  ) {
    if (!(maxSessionLoss > 0) || !(maxEvidenceAgeMs > 0)) throw new Error("invalid Perpl equity guard limits");
    this.journal = this.load();
    if (this.journal.state === "active") this.halt("restart found an unresolved active equity session; manual review required");
  }

  status(): PerplEquityStatus {
    const { version: _, lastEvidenceKey: __, ...status } = this.journal;
    return { ...status };
  }

  arm(evidence: PerplEquityEvidence): PerplEquityStatus {
    if (this.journal.state !== "idle") throw new Error("equity guard must be idle before arming");
    const equity = this.validateEvidence(evidence);
    this.persist({
      version: 1,
      state: "active",
      healthy: true,
      baselineEquity: equity,
      currentEquity: equity,
      sessionChange: 0,
      blockNumber: evidence.blockNumber,
      lastEvidenceKey: this.key(evidence),
    });
    return this.status();
  }

  observe(evidence: PerplEquityEvidence): PerplEquityStatus {
    if (this.journal.state !== "active") return this.status();
    let equity: number;
    try {
      equity = this.validateEvidence(evidence);
    } catch (error) {
      this.halt(String(error));
      return this.status();
    }
    const previousBlock = BigInt(this.journal.blockNumber!);
    const block = BigInt(evidence.blockNumber);
    if (block < previousBlock) return this.halted("equity evidence block regressed");
    if (block === previousBlock && this.journal.lastEvidenceKey !== this.key(evidence)) {
      return this.halted("equity evidence changed within the same block; classification is ambiguous");
    }
    const baseline = this.journal.baselineEquity!;
    const change = equity - baseline;
    if (change <= -this.maxSessionLoss) return this.halted("Perpl session equity loss limit reached");
    this.persist({
      ...this.journal,
      healthy: true,
      currentEquity: equity,
      sessionChange: change,
      blockNumber: evidence.blockNumber,
      lastEvidenceKey: this.key(evidence),
    });
    return this.status();
  }

  manualReset(phrase: string): PerplEquityStatus {
    if (phrase !== "RESET HALTED PERPL EQUITY SESSION") throw new Error("exact manual reset phrase required");
    this.persist({ version: 1, state: "idle", healthy: false });
    return this.status();
  }

  private validateEvidence(evidence: PerplEquityEvidence): number {
    if (evidence.frozen) throw new Error("Perpl account is frozen");
    if (!/^\d+$/.test(evidence.blockNumber) || BigInt(evidence.blockNumber) <= 0n) {
      throw new Error("invalid equity evidence block");
    }
    const evidenceAge = this.now() - evidence.observedAt;
    if (
      !Number.isSafeInteger(evidence.observedAt) ||
      evidence.observedAt <= 0 ||
      evidenceAge < 0 ||
      evidenceAge > this.maxEvidenceAgeMs
    ) {
      throw new Error("equity evidence is stale or invalid");
    }
    const balance = decimal(evidence.balance, "balance", false);
    decimal(evidence.lockedBalance, "locked balance", false);
    const deposit = decimal(evidence.positionDeposit, "position deposit", false);
    const pnl = decimal(evidence.unrealizedPnl, "unrealized PnL", true);
    const equity = balance + deposit + pnl;
    if (!Number.isFinite(equity) || equity < 0) throw new Error("computed equity is invalid");
    return equity;
  }

  private key(evidence: PerplEquityEvidence): string {
    return [
      evidence.balance,
      evidence.lockedBalance,
      evidence.positionDeposit,
      evidence.unrealizedPnl,
      evidence.frozen,
    ].join("|");
  }

  private halted(reason: string): PerplEquityStatus {
    this.halt(reason);
    return this.status();
  }

  private halt(reason: string): void {
    this.persist({
      ...this.journal,
      version: 1,
      state: "halted",
      healthy: false,
      haltReason: reason,
    });
  }

  private load(): Journal {
    try {
      const value = JSON.parse(readFileSync(this.filePath, "utf8")) as Journal;
      if (value.version !== 1 || !["idle", "active", "halted"].includes(value.state)) {
        throw new Error("invalid journal");
      }
      if (
        value.state === "active" &&
        (typeof value.baselineEquity !== "number" ||
          typeof value.currentEquity !== "number" ||
          typeof value.sessionChange !== "number" ||
          typeof value.blockNumber !== "string" ||
          !/^\d+$/.test(value.blockNumber) ||
          typeof value.lastEvidenceKey !== "string")
      ) {
        throw new Error("invalid active journal");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, state: "idle", healthy: false };
      }
      throw new Error(`Perpl equity journal could not be loaded: ${String(error)}`);
    }
  }

  private persist(value: Journal): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporary, this.filePath);
    this.journal = value;
  }
}

function decimal(value: string, field: string, signed: boolean): number {
  const pattern = signed ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/ : /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
  if (!pattern.test(value)) throw new Error(`invalid ${field}`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid ${field}`);
  return number;
}
