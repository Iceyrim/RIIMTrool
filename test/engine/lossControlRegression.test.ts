/**
 * Regression coverage for the account-wide session loss cap's removal (see SPEC.md's
 * account-wide PnL policy section and CLAUDE.md's "Session loss cap removed" status entry).
 *
 * The old cap's defining weakness was that it was NOT restart-durable: sessionRealizedPnlUsd
 * lives only in an in-memory AccountRiskState object that a real process restart always
 * recreates from scratch (see MarketEngine's constructor / PaperRunner's constructor), so
 * restarting the bot was itself a way to clear a tripped cap — an operator (or an automated
 * process supervisor) restarting the process, deliberately or not, silently re-armed trading.
 * WindowLossCapTracker's daily/weekly caps fix this by persisting capped state to their own file
 * (state/live/pnl-window-anchors.json) that a restart reloads rather than recreates — only a real
 * UTC calendar rollover clears them, never a restart. These tests prove both halves of that
 * claim directly, plus the UTC-window-boundary tradeoff the new design explicitly accepts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MarketEngine } from "../../src/engine/MarketEngine.js";
import { RiskManager, type RiskCheckContext } from "../../src/engine/RiskManager.js";
import type { EngineMarketConfig } from "../../src/engine/types.js";
import { WindowLossCapTracker } from "../../src/engine/WindowLossCapTracker.js";
import { FakeExchangeAdapter } from "./fakeAdapter.js";

const MARKET = "BTCUSD";

function testConfig(overrides: Partial<EngineMarketConfig> = {}): EngineMarketConfig {
  return {
    symbol: MARKET,
    orderSize: { min: 0.00155, max: 0.00232 },
    spreadBps: { normal: 5, min: 4, max: 7.5 },
    exitSpreadBps: 2.5,
    quoteLevels: 5,
    levelSpacingBps: [2, 3, 4, 7, 10],
    inventoryReductionThresholdBase: 0.003,
    riskLimits: {
      maxLongPosition: 0.05,
      maxShortPosition: 0.05,
      maxOrderSize: 0.0025,
      maxOrderNotionalUsd: 160,
      maxOpenOrders: 12,
    },
    reduceOnlyExit: { minHoldMs: 45_000, maxHoldMs: 300_000 },
    quoteMinimumLifetimeMs: 30_000,
    quoteRepriceThresholdBps: 1,
    quoteMaximumLifetimeMs: 120_000,
    ...overrides,
  };
}

function tempPaths(): { stateFilePath: string; tradeLogFilePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-losscap-regression-test-"));
  return {
    stateFilePath: join(dir, `orders-${MARKET}.json`),
    tradeLogFilePath: join(dir, `trades-${MARKET}.jsonl`),
  };
}

function tempAnchorPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-losscap-regression-anchor-"));
  return join(dir, "pnl-window-anchors.json");
}

function newAdapter(): FakeExchangeAdapter {
  const adapter = new FakeExchangeAdapter();
  adapter.marketPrices.set(MARKET, { market: MARKET, mark: 60000, index: 60000 });
  return adapter;
}

describe("session loss cap removal: restart regression", () => {
  it("an arbitrarily large accumulated negative sessionRealizedPnlUsd never blocks placement, before or after a simulated restart", async () => {
    // "Before restart": one engine instance accumulates a catastrophic loss.
    const engine1 = new MarketEngine(newAdapter(), testConfig(), tempPaths());
    await engine1.start();
    engine1.recordRealizedPnl(-1_000_000);
    const before = await engine1.runCycle();
    expect(before.blockedReason).toBeUndefined();
    expect(before.quotesPlaced).toBeGreaterThan(0);

    // "After restart": a brand-new MarketEngine instance (fresh in-memory AccountRiskState, the
    // same way a real process restart recreates it — see PaperRunner's/MarketEngine's
    // constructors) — even re-fed the same catastrophic loss (as would genuinely happen in live
    // mode, since N1's own realized-PnL ledger doesn't reset on restart), placement is still not
    // blocked. There is no session-realized-PnL-based gate anywhere in this codebase to trip.
    const engine2 = new MarketEngine(newAdapter(), testConfig(), tempPaths());
    await engine2.start();
    engine2.recordRealizedPnl(-1_000_000);
    const after = await engine2.runCycle();
    expect(after.blockedReason).toBeUndefined();
    expect(after.quotesPlaced).toBeGreaterThan(0);
  });

  it("a tripped daily loss cap survives a simulated restart and still blocks new ladder placement, while leaving a reduce-only exit unaffected", async () => {
    const anchorFilePath = tempAnchorPath();

    // "Before restart": trip the daily cap and let it persist.
    const trackerBeforeRestart = new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath });
    const stateBeforeRestart = trackerBeforeRestart.observe(-6);
    expect(stateBeforeRestart.dailyCapped).toBe(true);

    // "After restart": a brand-new WindowLossCapTracker instance loading the same anchor file —
    // no observe() call needed; the persisted capped state is loaded straight from disk, unlike
    // sessionRealizedPnlUsd, which a restart always resets to 0.
    const trackerAfterRestart = new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath });
    expect(trackerAfterRestart.getState().dailyCapped).toBe(true);

    const adapter = newAdapter();
    const engine = new MarketEngine(adapter, testConfig(), {
      ...tempPaths(),
      windowLossCapProvider: trackerAfterRestart,
    });
    await engine.start();

    const summary = await engine.runCycle();
    expect(summary.quotesPlaced).toBe(0);
    expect(summary.quotesAttempted).toBe(0);
    expect(summary.riskSkipMessages.some((m) => /[Dd]aily.*loss cap/.test(m))).toBe(true);
    // The daily cap only ever reaches RiskManager.canPlaceOrder (the ladder path) — it must never
    // produce a whole-cycle blockedReason, which would also block a reduce-only exit.
    expect(summary.blockedReason).toBeUndefined();

    // A position requiring reduction still gets its reduce-only exit placed, unaffected by the
    // still-tripped daily cap — proving the cap's placement-only-scoped-to-the-ladder design.
    adapter.positions.push({
      market: MARKET,
      baseSize: 0.004, // exceeds inventoryReductionThresholdBase: 0.003
      markPrice: 60000,
      unrealizedPnl: 0,
      openOrderCount: 0,
    });
    const exitSummary = await engine.runCycle();
    expect(exitSummary.reductionMode).toBe(true);
    expect(exitSummary.exitState).toBe("placed");
  });
});

describe("session loss cap removal: accepted UTC-boundary-loss tradeoff", () => {
  it("a loss split across a UTC daily boundary (-$4.99 then -$4.99) trips neither the daily nor weekly cap, and placement remains allowed", () => {
    // 2026-08-21 (Fri) -> 2026-08-22 (Sat): same UTC week (Mon 2026-08-17 - Sun 2026-08-23).
    const justBeforeMidnight = Date.parse("2026-08-21T23:59:30.000Z");
    const justAfterMidnight = Date.parse("2026-08-22T00:00:30.000Z");

    const tracker = new WindowLossCapTracker({
      dailyLossCapUsd: 5,
      weeklyLossCapUsd: 20,
      anchorFilePath: tempAnchorPath(),
    });

    const beforeMidnight = tracker.observe(-4.99, justBeforeMidnight);
    expect(beforeMidnight.dailyCapped).toBe(false);
    expect(beforeMidnight.weeklyCapped).toBe(false);

    // Crosses the UTC daily rollover: the daily window resets, so this loss lands fresh on the
    // new day rather than compounding with the prior day's -$4.99. $9.98 was lost within a
    // minute of wall-clock time, but neither window independently exceeds its cap — this is the
    // explicitly accepted tradeoff of purely calendar-based caps (see SPEC.md), not a bug.
    const afterMidnight = tracker.observe(-4.99, justAfterMidnight);
    expect(afterMidnight.dailyCapped).toBe(false);
    expect(afterMidnight.weeklyCapped).toBe(false); // weekly total -$9.98, still under the $20 cap

    const rm = new RiskManager(new FakeExchangeAdapter());
    const ctx: RiskCheckContext = {
      market: MARKET,
      side: "buy",
      size: 0.001,
      price: 60000,
      limits: testConfig().riskLimits,
      currentPosition: undefined,
      lastReconciliation: { market: MARKET, healthy: true, openOrderCount: 0, anomalies: [], checkedAt: justAfterMidnight },
      progressiveOpenOrderCount: 0,
      openBuyQuantity: 0,
      openSellQuantity: 0,
      dailyLossCapped: afterMidnight.dailyCapped,
      weeklyLossCapped: afterMidnight.weeklyCapped,
    };
    expect(rm.canPlaceOrder(ctx).allowed).toBe(true);
  });
});
