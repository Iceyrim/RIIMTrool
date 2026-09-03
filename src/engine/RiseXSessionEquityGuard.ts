import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RiseXEquityStatus {
  state: "idle" | "active" | "halted";
  healthy: boolean;
  baselineEquity?: number;
  currentEquity?: number;
  sessionChange?: number;
  dailyChange?: number;
  weeklyChange?: number;
  haltReason?: string;
}

interface Window {
  key: string;
  baselineEquity: number;
  currentEquity: number;
}
interface Journal extends RiseXEquityStatus {
  version: 1;
  daily?: Window;
  weekly?: Window;
}

export class RiseXSessionEquityGuard {
  private journal: Journal;

  constructor(
    private readonly filePath: string,
    private readonly sessionLossCapUsd: number,
    private readonly dailyLossCapUsd: number,
    private readonly weeklyLossCapUsd: number,
    private readonly now = Date.now,
  ) {
    if (![sessionLossCapUsd, dailyLossCapUsd, weeklyLossCapUsd].every((value) => value > 0))
      throw new Error("invalid RISEx equity guard limits");
    this.journal = this.load();
    if (this.journal.state === "active")
      this.halt("restart found an unresolved active RISEx equity session; manual review required");
  }

  status(): RiseXEquityStatus {
    const { version: _, daily: __, weekly: ___, ...status } = this.journal;
    return { ...status };
  }

  arm(equity: number): RiseXEquityStatus {
    if (this.journal.state !== "idle")
      throw new Error("RISEx equity guard must be idle before arming");
    this.validate(equity);
    const windows = this.windows(equity);
    this.persist({
      version: 1,
      state: "active",
      healthy: true,
      baselineEquity: equity,
      currentEquity: equity,
      sessionChange: 0,
      dailyChange: equity - windows.daily.baselineEquity,
      weeklyChange: equity - windows.weekly.baselineEquity,
      ...windows,
    });
    return this.status();
  }

  observe(equity: number): RiseXEquityStatus {
    if (this.journal.state !== "active") return this.status();
    this.validate(equity);
    const sessionChange = equity - this.journal.baselineEquity!;
    const windows = this.windows(equity);
    const dailyChange = equity - windows.daily.baselineEquity;
    const weeklyChange = equity - windows.weekly.baselineEquity;
    if (sessionChange <= -this.sessionLossCapUsd)
      return this.halted("RISEx session equity loss limit reached");
    if (dailyChange <= -this.dailyLossCapUsd)
      return this.halted("RISEx daily equity loss limit reached");
    if (weeklyChange <= -this.weeklyLossCapUsd)
      return this.halted("RISEx weekly equity loss limit reached");
    this.persist({
      ...this.journal,
      healthy: true,
      currentEquity: equity,
      sessionChange,
      dailyChange,
      weeklyChange,
      ...windows,
    });
    return this.status();
  }

  manualReset(phrase: string): RiseXEquityStatus {
    if (phrase !== "RESET HALTED RISEX EQUITY SESSION")
      throw new Error("exact RISEx manual reset phrase required");
    this.persist({
      version: 1,
      state: "idle",
      healthy: false,
      daily: this.journal.daily,
      weekly: this.journal.weekly,
    });
    return this.status();
  }

  private windows(equity: number): { daily: Window; weekly: Window } {
    const instant = new Date(this.now());
    const dailyKey = instant.toISOString().slice(0, 10);
    const day = instant.getUTCDay() || 7;
    instant.setUTCDate(instant.getUTCDate() - day + 1);
    const weeklyKey = instant.toISOString().slice(0, 10);
    const daily =
      this.journal.daily?.key === dailyKey
        ? { ...this.journal.daily, currentEquity: equity }
        : { key: dailyKey, baselineEquity: equity, currentEquity: equity };
    const weekly =
      this.journal.weekly?.key === weeklyKey
        ? { ...this.journal.weekly, currentEquity: equity }
        : { key: weeklyKey, baselineEquity: equity, currentEquity: equity };
    return { daily, weekly };
  }

  private validate(equity: number): void {
    if (!Number.isFinite(equity) || equity < 0) throw new Error("RISEx account equity is invalid");
  }

  private halted(reason: string): RiseXEquityStatus {
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
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Journal;
      if (parsed.version !== 1 || !["idle", "active", "halted"].includes(parsed.state))
        throw new Error("invalid journal");
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT")
        throw new Error(`RISEx equity journal is unreadable: ${String(error)}`);
      return { version: 1, state: "idle", healthy: false };
    }
  }

  private persist(journal: Journal): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
    this.journal = journal;
  }
}
