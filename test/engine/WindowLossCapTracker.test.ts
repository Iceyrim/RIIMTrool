import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlertBus, type AlertEvent, type AlertSink } from "../../src/alerting/AlertBus.js";
import { WindowLossCapTracker } from "../../src/engine/WindowLossCapTracker.js";

class FakeAlertSink implements AlertSink {
  events: AlertEvent[] = [];
  handle(event: AlertEvent): void {
    this.events.push(event);
  }
}

function tempAnchorPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-window-cap-test-"));
  return join(dir, "pnl-window-anchors.json");
}

// A Friday, well inside both a UTC day and UTC week.
const T0 = Date.parse("2026-08-21T12:00:00.000Z");

describe("WindowLossCapTracker", () => {
  it("is not capped before any loss accrues", () => {
    const tracker = new WindowLossCapTracker({
      dailyLossCapUsd: 5,
      weeklyLossCapUsd: 20,
      anchorFilePath: tempAnchorPath(),
    });
    const state = tracker.observe(0, T0);
    expect(state.dailyCapped).toBe(false);
    expect(state.weeklyCapped).toBe(false);
  });

  it("trips the daily cap once accumulated realized loss reaches it, and fires an edge alert", () => {
    const sink = new FakeAlertSink();
    const alertBus = new AlertBus();
    alertBus.subscribe(sink);
    const tracker = new WindowLossCapTracker({
      dailyLossCapUsd: 5,
      weeklyLossCapUsd: 20,
      anchorFilePath: tempAnchorPath(),
      alertBus,
    });

    tracker.observe(-2, T0);
    expect(sink.events).toHaveLength(0);

    const state = tracker.observe(-3, T0 + 1000);
    expect(state.dailyCapped).toBe(true);
    expect(state.weeklyCapped).toBe(false); // weekly cap of 20 not reached yet
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.type).toBe("error");
    expect((sink.events[0] as { message: string }).message).toMatch(/Daily/);
    expect((sink.events[0] as { message: string }).message).toMatch(/\$5/);
  });

  it("does not re-fire the edge alert on subsequent observe() calls while still capped, until the re-alert interval elapses", () => {
    const sink = new FakeAlertSink();
    const alertBus = new AlertBus();
    alertBus.subscribe(sink);
    const tracker = new WindowLossCapTracker({
      dailyLossCapUsd: 5,
      anchorFilePath: tempAnchorPath(),
      alertBus,
    });

    tracker.observe(-5, T0);
    expect(sink.events).toHaveLength(1);

    tracker.observe(0, T0 + 5000);
    tracker.observe(0, T0 + 10_000);
    expect(sink.events).toHaveLength(1); // no re-alert yet

    // 30 minutes later: due for periodic re-alert.
    tracker.observe(0, T0 + 30 * 60 * 1000);
    expect(sink.events).toHaveLength(2);
    expect((sink.events[1] as { message: string }).message).toMatch(/still in effect/);
  });

  it("stays capped for the rest of the window even if a later win partially offsets the loss", () => {
    const tracker = new WindowLossCapTracker({
      dailyLossCapUsd: 5,
      anchorFilePath: tempAnchorPath(),
    });
    expect(tracker.observe(-6, T0).dailyCapped).toBe(true);
    // A subsequent win brings realizedPnlUsd back above -capUsd, but capped stays sticky.
    const state = tracker.observe(4, T0 + 1000);
    expect(state.dailyCapped).toBe(true);
  });

  it("clears the daily cap on UTC daily rollover and fires a recovery alert", () => {
    const sink = new FakeAlertSink();
    const alertBus = new AlertBus();
    alertBus.subscribe(sink);
    const tracker = new WindowLossCapTracker({
      dailyLossCapUsd: 5,
      anchorFilePath: tempAnchorPath(),
      alertBus,
    });

    tracker.observe(-6, T0);
    expect(sink.events).toHaveLength(1);

    const nextDay = Date.parse("2026-08-22T00:00:01.000Z");
    const state = tracker.observe(0, nextDay);
    expect(state.dailyCapped).toBe(false);
    expect(sink.events).toHaveLength(2);
    expect((sink.events[1] as { message: string }).message).toMatch(/cleared/);
  });

  it("does not clear the weekly cap on a daily rollover within the same week", () => {
    const tracker = new WindowLossCapTracker({
      weeklyLossCapUsd: 20,
      anchorFilePath: tempAnchorPath(),
    });
    tracker.observe(-25, T0); // Friday
    const nextDaySameWeek = Date.parse("2026-08-22T00:00:01.000Z"); // Saturday, same UTC week
    const state = tracker.observe(0, nextDaySameWeek);
    expect(state.weeklyCapped).toBe(true);
  });

  it("clears the weekly cap on UTC weekly (Monday) rollover", () => {
    const tracker = new WindowLossCapTracker({
      weeklyLossCapUsd: 20,
      anchorFilePath: tempAnchorPath(),
    });
    tracker.observe(-25, T0); // Friday 2026-08-21
    const nextMonday = Date.parse("2026-08-24T00:00:01.000Z");
    const state = tracker.observe(0, nextMonday);
    expect(state.weeklyCapped).toBe(false);
  });

  it("treats an unconfigured cap as never-capped regardless of loss magnitude", () => {
    const tracker = new WindowLossCapTracker({
      dailyLossCapUsd: 5,
      // weeklyLossCapUsd intentionally omitted
      anchorFilePath: tempAnchorPath(),
    });
    const state = tracker.observe(-1000, T0);
    expect(state.dailyCapped).toBe(true);
    expect(state.weeklyCapped).toBe(false);
  });

  it("persists anchors to its own dedicated file and survives reconstruction across a restart", () => {
    const anchorFilePath = tempAnchorPath();
    const tracker = new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath });
    tracker.observe(-5, T0);

    const persisted = JSON.parse(readFileSync(anchorFilePath, "utf-8"));
    expect(persisted.version).toBe(1);
    expect(persisted.daily.capped).toBe(true);

    const restarted = new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath });
    expect(restarted.getState().dailyCapped).toBe(true);
  });

  it("throws on a malformed anchor file rather than silently resetting", () => {
    const anchorFilePath = tempAnchorPath();
    writeFileSync(anchorFilePath, "{ not json", "utf-8");
    expect(() => new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath })).toThrow();
  });

  it("throws on an anchor file with an incompatible version rather than silently resetting", () => {
    const anchorFilePath = tempAnchorPath();
    writeFileSync(anchorFilePath, JSON.stringify({ version: 99 }), "utf-8");
    expect(() => new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath })).toThrow();
  });
});
