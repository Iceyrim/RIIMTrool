import type { WindowLossCapTracker } from "../engine/WindowLossCapTracker.js";
import type { RealizedPnlSource } from "./PaperRunner.js";

/**
 * Thin decorator around a real RealizedPnlSource (in practice, only N1RealizedPnlSource has
 * scope "account" today — see PaperRunner's accountPnlOwnerMarket) that feeds every drained
 * delta into a WindowLossCapTracker as a side effect, then returns the delta unchanged. Exists
 * so daily/weekly loss-cap tracking rides the exact same per-cycle drain cadence and dollar
 * amounts as the existing session-PnL accumulation, without PaperRunner or MarketEngine needing
 * to know this feature exists. A drain failure propagates untouched — PaperRunner's existing
 * markSessionPnlUnavailable() handling is unaffected, and the tracker simply isn't observed that
 * cycle (same "never substitute a silent 0" rule the wrapped source already follows).
 */
export class WindowTrackingRealizedPnlSource implements RealizedPnlSource {
  readonly scope: "market" | "account" | undefined;

  constructor(
    private readonly inner: RealizedPnlSource,
    private readonly tracker: WindowLossCapTracker,
  ) {
    this.scope = inner.scope;
  }

  async drainRealizedPnlDeltaUsd(market?: string): Promise<number> {
    const delta = await this.inner.drainRealizedPnlDeltaUsd(market);
    this.tracker.observe(delta);
    return delta;
  }
}
