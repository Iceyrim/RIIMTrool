import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WindowLossCapTracker } from "../../src/engine/WindowLossCapTracker.js";
import type { RealizedPnlSource } from "../../src/paperRunner/PaperRunner.js";
import { WindowTrackingRealizedPnlSource } from "../../src/paperRunner/WindowTrackingRealizedPnlSource.js";

class FakePnlSource implements RealizedPnlSource {
  readonly scope = "account" as const;
  queued = 0;
  errorToThrow: Error | null = null;
  async drainRealizedPnlDeltaUsd(): Promise<number> {
    if (this.errorToThrow) {
      const err = this.errorToThrow;
      this.errorToThrow = null;
      throw err;
    }
    const value = this.queued;
    this.queued = 0;
    return value;
  }
}

function tempAnchorPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-window-decorator-test-"));
  return join(dir, "pnl-window-anchors.json");
}

describe("WindowTrackingRealizedPnlSource", () => {
  it("passes the drained delta through unchanged", async () => {
    const inner = new FakePnlSource();
    inner.queued = -3;
    const tracker = new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath: tempAnchorPath() });
    const wrapped = new WindowTrackingRealizedPnlSource(inner, tracker);

    const delta = await wrapped.drainRealizedPnlDeltaUsd("BTCUSD");
    expect(delta).toBe(-3);
  });

  it("feeds the drained delta into the tracker as a side effect", async () => {
    const inner = new FakePnlSource();
    inner.queued = -5;
    const tracker = new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath: tempAnchorPath() });
    const wrapped = new WindowTrackingRealizedPnlSource(inner, tracker);

    await wrapped.drainRealizedPnlDeltaUsd();
    expect(tracker.getState().dailyCapped).toBe(true);
  });

  it("propagates a drain failure untouched, without observing a phantom delta", async () => {
    const inner = new FakePnlSource();
    inner.errorToThrow = new Error("network blip");
    const tracker = new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath: tempAnchorPath() });
    const wrapped = new WindowTrackingRealizedPnlSource(inner, tracker);

    await expect(wrapped.drainRealizedPnlDeltaUsd()).rejects.toThrow("network blip");
    expect(tracker.getState().dailyCapped).toBe(false);
  });

  it("mirrors the inner source's scope", () => {
    const inner = new FakePnlSource();
    const tracker = new WindowLossCapTracker({ dailyLossCapUsd: 5, anchorFilePath: tempAnchorPath() });
    const wrapped = new WindowTrackingRealizedPnlSource(inner, tracker);
    expect(wrapped.scope).toBe("account");
  });
});
