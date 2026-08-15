import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSyntheticDashboardStatus } from "../../src/dashboard/syntheticStatus.js";

describe("buildSyntheticDashboardStatus", () => {
  it("returns deterministic, clearly synthetic account and market data", () => {
    const status = buildSyntheticDashboardStatus();
    expect(status).toEqual(buildSyntheticDashboardStatus());
    expect(status.accounts.map(({ label }) => label)).toEqual(["N1 LIVE (SYNTHETIC)", "RISEx PAPER (SYNTHETIC)"]);
    expect(status.markets.map(({ exchangeId, market }) => [exchangeId, market])).toEqual([
      ["synthetic-n1-live", "BTCUSD"], ["synthetic-n1-live", "ETHUSD"],
      ["synthetic-risex-paper", "BTCUSD"], ["synthetic-risex-paper", "ETHUSD"],
    ]);
    expect(status.markets.some(({ market }) => market === "SYNTH-USD")).toBe(false);
    expect(status.accountSessionLossCapUsd).toBe(6);
    expect(status.accounts.every(({ sessionLossCapUsd }) => sessionLossCapUsd === 6)).toBe(true);
  });

  it("covers preview telemetry and operational states", () => {
    const status = buildSyntheticDashboardStatus();
    for (const account of status.accounts) {
      expect(account.balances.available && account.balances.value.length).toBeGreaterThan(0);
      expect(account.margin.available).toBe(true);
      expect(account.uptimeMs.available).toBe(true);
      expect(Object.keys(account.volumes)).toEqual(["24h", "7d", "30d", "allTime"]);
      expect(account.history.available && account.history.value.sessions.length).toBeGreaterThan(0);
      expect(account.history.available && account.history.value.points.length).toBeGreaterThan(0);
      expect(account.alertHealth.available && account.alertHealth.value.delivered).toBe(7);
    }
    expect(status.markets.every(({ fills }) => fills.available && fills.value.entries.length === 2)).toBe(true);
    expect(status.markets.flatMap(({ reconciliation }) => reconciliation.anomalies)).not.toHaveLength(0);
    expect(status.markets.map(({ operations }) => operations?.quoteRefreshReason)).toEqual([
      "below-threshold hold", "threshold refresh", "maximum-age refresh", "empty ladder placement",
    ]);
    expect(status.markets.map(({ operations }) => operations?.exitState)).toEqual(["held", "placed", "blocked", "no_position"]);
    expect(status.markets.some(({ operations }) => (operations?.riskSkippedLevels.openOrderCapacity ?? 0) > 0)).toBe(true);
    expect(status.unavailableTelemetry.join(" ")).toContain("Synthetic preview only");
  });

  it("has no runtime imports from live subsystems", () => {
    const source = readFileSync(new URL("../../src/dashboard/syntheticStatus.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']\.\.\/(adapters|engine|config|paperRunner|alerting)\//);
  });
});
