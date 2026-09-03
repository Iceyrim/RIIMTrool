import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DashboardStatus } from "../../src/dashboard/DashboardService.js";
import {
  aggregateDashboardSnapshots,
  DashboardSnapshotPublisher,
  SNAPSHOT_MAX_FILES_PER_EXCHANGE,
  SNAPSHOT_FILE_MODE,
  type DashboardSessionSnapshot,
} from "../../src/dashboard/DashboardSnapshotSidecar.js";

const status = (exchangeId: string): DashboardStatus => ({
  generatedAt: 1, totalExposureUsd: 0, accountSessionRealizedPnlUsd: 0,
  accountSessionLossCapUsd: 6, accountPnlAvailable: true, accounts: [], markets: [],
  unavailableTelemetry: [exchangeId],
});
const snapshot = (sessionId: string, lifecycle: "running" | "stopped", startedAt: number, publishedAt = startedAt): DashboardSessionSnapshot => ({
  version: 1, sessionId, exchangeId: "n1-paper", lifecycle, startedAt, publishedAt,
  status: status(sessionId),
});

describe("dashboard snapshot sidecar", () => {
  it("atomically publishes running then final stopped lifecycle", () => {
    const directory = mkdtempSync(join(tmpdir(), "dashboard-snapshot-"));
    const publisher = new DashboardSnapshotPublisher(directory, "n1-paper", () => status("n1-paper"), { sessionId: "one", startedAt: 10 });
    publisher.publish("running", 20);
    publisher.stop();
    const files = readdirSync(directory);
    expect(files).toEqual(["n1-paper--one.json"]);
    expect(JSON.parse(readFileSync(join(directory, files[0]!), "utf8"))).toMatchObject({ lifecycle: "stopped", sessionId: "one" });
    expect(statSync(join(directory, files[0]!)).mode & 0o777).toBe(SNAPSHOT_FILE_MODE);
  });

  it("allows a newer running session to supersede a stopped predecessor", () => {
    const result = aggregateDashboardSnapshots([snapshot("old", "stopped", 100), snapshot("new", "running", 200)], 201);
    expect(result.snapshotSources).toMatchObject([{ sessionId: "new", lifecycle: "running" }]);
    expect(result.snapshotConflicts).toEqual([]);
  });

  it("prefers the sole fresh runner even when a stopped snapshot has a later start timestamp", () => {
    const running = snapshot("active", "running", 100, 300);
    const stopped = snapshot("short-lived", "stopped", 200, 250);
    const result = aggregateDashboardSnapshots([running, stopped], 301);

    expect(result.snapshotSources).toMatchObject([
      { sessionId: "active", lifecycle: "running", stale: false },
    ]);
    expect(result.unavailableTelemetry).not.toContain("n1-paper: running snapshot is stale.");
  });

  it("retains the last fresh account balance and margin in a stopped snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "dashboard-snapshot-"));
    let fresh = true;
    const readStatus = (): DashboardStatus => ({
      ...status("perpl"),
      accounts: [{
        exchangeId: "perpl-onchain-mainnet-live", venue: "Perpl", mode: "LIVE", label: "Perpl LIVE",
        balances: fresh ? { available: true as const, value: [{ token: "AUSD", amount: 52 }] } : { available: false as const, value: null, sourceNeeded: "stale" },
        margin: fresh ? { available: true as const, value: { accountValue: 52, maintenanceMarginFraction: 0, initialMarginFraction: 0, isAtBankruptcyRisk: false } } : { available: false as const, value: null, sourceNeeded: "stale" },
        healthy: fresh, healthDetails: fresh ? [] : ["Margin unavailable"],
        uptimeMs: { available: true as const, value: 1 }, sessionRealizedPnlUsd: 0,
        sessionLossCapUsd: 1.5, pnlAvailable: true,
        volumes: Object.fromEntries(["24h", "7d", "30d", "allTime"].map((key) => [key, { available: false as const, value: null, sourceNeeded: "test" }])) as never,
        history: { available: false as const, value: null, sourceNeeded: "test" },
        alertHealth: { available: false as const, value: null, sourceNeeded: "test" },
      }],
    });
    const publisher = new DashboardSnapshotPublisher(directory, "perpl", readStatus, { sessionId: "one", startedAt: 10 });
    publisher.publish("running", 20);
    fresh = false;
    publisher.stop();
    const saved = JSON.parse(readFileSync(join(directory, "perpl--one.json"), "utf8")) as DashboardSessionSnapshot;
    expect(saved.status.accounts[0]?.balances).toEqual({ available: true, value: [{ token: "AUSD", amount: 52 }] });
    expect(saved.status.accounts[0]?.margin.available).toBe(true);
    expect(saved.status.accounts[0]?.healthDetails).toEqual([]);
  });

  it("keeps two simultaneously fresh running sessions visible as a conflict", () => {
    const result = aggregateDashboardSnapshots([snapshot("a", "running", 100, 200), snapshot("b", "running", 150, 200)], 201);
    expect(result.snapshotSources).toEqual([]);
    expect(result.snapshotConflicts).toEqual([{ exchangeId: "n1-paper", sessionIds: ["a", "b"] }]);
    expect(result.unavailableTelemetry.join(" ")).toContain("conflicting fresh running sessions");
  });

  it("bounds retained session files per exchange", () => {
    const directory = mkdtempSync(join(tmpdir(), "dashboard-snapshot-"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let index = 0; index < SNAPSHOT_MAX_FILES_PER_EXCHANGE + 3; index++) {
      new DashboardSnapshotPublisher(directory, "n1-paper", () => status("n1-paper"), { sessionId: String(index), startedAt: index }).publish("stopped", index);
    }
    expect(readdirSync(directory)).toHaveLength(SNAPSHOT_MAX_FILES_PER_EXCHANGE);
  });
});
