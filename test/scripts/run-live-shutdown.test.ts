import { describe, expect, it, vi } from "vitest";
import { createLiveShutdownHandler } from "../../scripts/run-live.js";
import type { PaperRunner, PaperRunnerShutdownResult } from "../../src/paperRunner/PaperRunner.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("live one-shot shutdown handling", () => {
  it("does not duplicate cleanup and closes/exits only after cleanup resolves", async () => {
    const cleanup = deferred<PaperRunnerShutdownResult>();
    const runner = { shutdown: vi.fn(() => cleanup.promise) } as unknown as PaperRunner;
    const closeDashboard = vi.fn();
    const exit = vi.fn();
    const handler = createLiveShutdownHandler({
      runner,
      closeDashboard,
      exit,
      log: vi.fn(),
      error: vi.fn(),
    });

    const first = handler("SIGINT");
    const repeated = handler("SIGTERM");
    expect(runner.shutdown).toHaveBeenCalledTimes(1);
    expect(closeDashboard).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    cleanup.resolve({
      report: {
        startedAt: 0,
        endedAt: 1,
        cycles: 0,
        totalQuotesPlaced: 0,
        totalQuotesAttempted: 0,
        totalQuotesCancelled: 0,
        totalAnomalies: 0,
        finalSessionRealizedPnlUsd: {},
      },
      cleanup: [],
      successful: true,
    });
    await Promise.all([first, repeated]);
    expect(closeDashboard).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits nonzero after reporting unresolved managed IDs", async () => {
    const exit = vi.fn();
    const error = vi.fn();
    const runner = {
      shutdown: vi.fn(async () => ({
        report: {
          startedAt: 0,
          endedAt: 1,
          cycles: 0,
          totalQuotesPlaced: 0,
          totalQuotesAttempted: 0,
          totalQuotesCancelled: 0,
          totalAnomalies: 0,
          finalSessionRealizedPnlUsd: {},
        },
        cleanup: [
          {
            market: "BTCUSD",
            attempted: ["managed-1"],
            cancelled: [],
            terminal: [],
            failed: ["managed-1"],
            unresolved: ["managed-1"],
            successful: false,
          },
        ],
        successful: false,
      })),
    } as unknown as PaperRunner;
    const handler = createLiveShutdownHandler({
      runner,
      closeDashboard: vi.fn(),
      exit,
      log: vi.fn(),
      error,
    });
    await handler("SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(" ")).toContain("managed-1");
  });
});
