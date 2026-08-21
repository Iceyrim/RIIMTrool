import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AlertBus } from "../alerting/AlertBus.js";
import { utcDayWindowStart, utcWeekWindowStart } from "./utcCalendarWindows.js";

interface WindowAnchor {
  windowStartMs: number;
  realizedPnlUsd: number;
  capped: boolean;
  cappedSinceMs?: number;
  lastAlertAtMs?: number;
}

interface PersistedWindowAnchors {
  version: 1;
  daily: WindowAnchor;
  weekly: WindowAnchor;
}

export interface WindowLossCapTrackerConfig {
  dailyLossCapUsd?: number;
  weeklyLossCapUsd?: number;
  /** state/live/pnl-window-anchors.json — deliberately separate from pnl-session-anchor.json. */
  anchorFilePath: string;
  alertBus?: AlertBus;
}

export interface WindowLossCapState {
  dailyCapped: boolean;
  weeklyCapped: boolean;
  dailyLossCapReason?: string;
  weeklyLossCapReason?: string;
}

const REALERT_INTERVAL_MS = 30 * 60 * 1000;

function formatDurationMs(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

function freshAnchor(windowStartMs: number): WindowAnchor {
  return { windowStartMs, realizedPnlUsd: 0, capped: false };
}

/**
 * Account-wide daily/weekly realized-PnL loss caps — the only realized-PnL-based
 * placement-blocking risk control in this codebase. An earlier account-wide session loss cap
 * (a single non-resetting cap, cleared only by deleting its anchor file / restarting) was
 * deliberately removed entirely; see SPEC.md's account-wide PnL policy section: restarting the
 * bot no longer creates or resets any loss-control boundary. Persists to its own file
 * (state/live/pnl-window-anchors.json, distinct from N1RealizedPnlSource's pnl-session-anchor.json)
 * so this feature can be deleted cleanly: delete this file, WindowTrackingRealizedPnlSource, this
 * class, and the dailyLossCapped/weeklyLossCapped fields on RiskCheckContext/RiskManager, and
 * nothing else in the engine needs to change.
 *
 * A capped window here is only ever consulted from RiskManager.canPlaceOrder, which MarketEngine
 * calls exclusively from the quote-ladder path, never from manageReduceOnlyExit. So a capped
 * day/week blocks new ladder placement while leaving reduce-only exits completely unaffected, by
 * construction of where the check lives, not by an extra conditional anywhere.
 *
 * "Capped" is sticky for the remainder of the calendar window once tripped: a loss cap that could
 * be cleared by a subsequent partial win within the same day/week would be trivially gameable
 * right at the threshold. Once realizedPnlUsd crosses -capUsd, capped stays true regardless of
 * further deltas until the next UTC rollover resets the window.
 */
export class WindowLossCapTracker {
  private daily: WindowAnchor;
  private weekly: WindowAnchor;

  constructor(private readonly config: WindowLossCapTrackerConfig) {
    const persisted = this.loadPersistedAnchors();
    const nowMs = Date.now();
    this.daily = persisted?.daily ?? freshAnchor(utcDayWindowStart(nowMs));
    this.weekly = persisted?.weekly ?? freshAnchor(utcWeekWindowStart(nowMs));
    this.persistAnchors();
  }

  getState(): WindowLossCapState {
    return {
      dailyCapped: this.daily.capped,
      weeklyCapped: this.weekly.capped,
      dailyLossCapReason: this.daily.capped
        ? `daily realized loss $${(-this.daily.realizedPnlUsd).toFixed(2)} reached cap $${this.config.dailyLossCapUsd}`
        : undefined,
      weeklyLossCapReason: this.weekly.capped
        ? `weekly realized loss $${(-this.weekly.realizedPnlUsd).toFixed(2)} reached cap $${this.config.weeklyLossCapUsd}`
        : undefined,
    };
  }

  /** Call once per cycle with the same realized-PnL delta already applied to the account-wide
   * session total (see WindowTrackingRealizedPnlSource). Rolls over expired windows, applies the
   * delta, evaluates/persists capped state, and emits edge-triggered + periodic AlertBus events.
   * A deltaUsd of 0 still performs rollover/re-alert checks — this must be called every cycle,
   * not only when a nonzero delta occurs, for calendar rollover to be detected promptly. */
  observe(deltaUsd: number, nowMs = Date.now()): WindowLossCapState {
    this.rolloverIfNeeded("daily", utcDayWindowStart(nowMs));
    this.rolloverIfNeeded("weekly", utcWeekWindowStart(nowMs));

    this.daily.realizedPnlUsd += deltaUsd;
    this.weekly.realizedPnlUsd += deltaUsd;

    this.evaluateCap("daily", this.config.dailyLossCapUsd, nowMs);
    this.evaluateCap("weekly", this.config.weeklyLossCapUsd, nowMs);

    this.persistAnchors();
    return this.getState();
  }

  private rolloverIfNeeded(kind: "daily" | "weekly", currentWindowStartMs: number): void {
    const anchor = kind === "daily" ? this.daily : this.weekly;
    if (anchor.windowStartMs === currentWindowStartMs) return;

    const wasCapped = anchor.capped;
    const fresh = freshAnchor(currentWindowStartMs);
    if (kind === "daily") this.daily = fresh;
    else this.weekly = fresh;

    if (wasCapped) {
      const label = kind === "daily" ? "Daily" : "Weekly";
      this.config.alertBus?.emit({
        type: "error",
        message:
          `[ACCOUNT] ${label} realized-PnL loss cap cleared — new UTC ${kind === "daily" ? "day" : "week"} ` +
          `started at ${new Date(currentWindowStartMs).toISOString()}`,
      });
    }
  }

  private evaluateCap(kind: "daily" | "weekly", capUsd: number | undefined, nowMs: number): void {
    if (capUsd === undefined) return;
    const anchor = kind === "daily" ? this.daily : this.weekly;
    const label = kind === "daily" ? "Daily" : "Weekly";

    if (!anchor.capped) {
      if (anchor.realizedPnlUsd <= -capUsd) {
        anchor.capped = true;
        anchor.cappedSinceMs = nowMs;
        anchor.lastAlertAtMs = nowMs;
        this.config.alertBus?.emit({
          type: "error",
          message:
            `[ACCOUNT] ${label} realized-PnL loss cap of $${capUsd} reached ` +
            `($${(-anchor.realizedPnlUsd).toFixed(2)} realized loss); new ladder placement ` +
            `blocked account-wide until UTC ${kind === "daily" ? "daily" : "weekly"} rollover`,
        });
      }
      return;
    }

    const cappedSince = anchor.cappedSinceMs ?? nowMs;
    const lastAlertAt = anchor.lastAlertAtMs ?? cappedSince;
    if (nowMs - lastAlertAt >= REALERT_INTERVAL_MS) {
      anchor.lastAlertAtMs = nowMs;
      this.config.alertBus?.emit({
        type: "error",
        message:
          `[ACCOUNT] ${label} realized-PnL loss cap still in effect (capped for ` +
          `${formatDurationMs(nowMs - cappedSince)}, $${(-anchor.realizedPnlUsd).toFixed(2)} realized loss ` +
          `vs $${capUsd} cap); new ladder placement remains blocked account-wide`,
      });
    }
  }

  private loadPersistedAnchors(): PersistedWindowAnchors | undefined {
    if (!existsSync(this.config.anchorFilePath)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.config.anchorFilePath, "utf-8"));
    } catch (err) {
      throw new Error(
        `Failed to parse PnL window anchors at "${this.config.anchorFilePath}" — refusing to ` +
          "guess fresh daily/weekly boundaries, since that could silently under-count a real " +
          `loss. Delete the file deliberately to reset, if that's genuinely intended. (${String(err)})`,
      );
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      (raw as PersistedWindowAnchors).version !== 1 ||
      typeof (raw as PersistedWindowAnchors).daily !== "object" ||
      typeof (raw as PersistedWindowAnchors).weekly !== "object"
    ) {
      throw new Error(
        `PnL window anchors at "${this.config.anchorFilePath}" are malformed or an incompatible ` +
          "version. Delete the file deliberately to reset, if that's genuinely intended.",
      );
    }
    return raw as PersistedWindowAnchors;
  }

  private persistAnchors(): void {
    const anchors: PersistedWindowAnchors = { version: 1, daily: this.daily, weekly: this.weekly };
    mkdirSync(dirname(this.config.anchorFilePath), { recursive: true });
    writeFileSync(this.config.anchorFilePath, JSON.stringify(anchors, null, 2), "utf-8");
  }
}
