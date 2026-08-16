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
        finalAccountSessionRealizedPnlUsd: 0,
      },
      cleanup: [],
      successful: true,
      positionsFlattened: false,
      positionDisposition: "NOT_FLATTENED_REQUIRES_DIRECT_EXCHANGE_VERIFICATION_AND_MANUAL_CLOSURE",
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
          finalAccountSessionRealizedPnlUsd: 0,
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
        positionsFlattened: false,
        positionDisposition: "NOT_FLATTENED_REQUIRES_DIRECT_EXCHANGE_VERIFICATION_AND_MANUAL_CLOSURE",
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

  it("publishes, reports, and preserves the cleanup exit code when dashboard close fails", async () => {
    const result = {
      report: { startedAt: 0, endedAt: 1, cycles: 0, totalQuotesPlaced: 0, totalQuotesAttempted: 0, totalQuotesCancelled: 0, totalAnomalies: 0, finalAccountSessionRealizedPnlUsd: 0 },
      cleanup: [], successful: true, positionsFlattened: false,
      positionDisposition: "NOT_FLATTENED_REQUIRES_DIRECT_EXCHANGE_VERIFICATION_AND_MANUAL_CLOSURE",
    } satisfies PaperRunnerShutdownResult;
    const publishStopped = vi.fn();
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const handler = createLiveShutdownHandler({
      runner: { shutdown: vi.fn(async () => result) } as unknown as PaperRunner,
      publishStopped,
      closeDashboard: vi.fn(async () => { throw Object.assign(new Error("not running"), { code: "ERR_SERVER_NOT_RUNNING" }); }),
      exit, log, error,
    });

    await Promise.all([handler("SIGINT"), handler("SIGTERM")]);
    expect(publishStopped).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(" ")).toContain("Session report");
    expect(error.mock.calls.flat().join(" ")).toContain("Dashboard close failed");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
