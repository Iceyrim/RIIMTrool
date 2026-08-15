import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSyntheticDashboardStatus } from "../../src/dashboard/syntheticStatus.js";

describe("buildSyntheticDashboardStatus", () => {
  it("returns deterministic synthetic-only status", () => {
    const first = buildSyntheticDashboardStatus();
    const second = buildSyntheticDashboardStatus();

    expect(first).toEqual(second);
    expect(first.markets).toHaveLength(1);
    expect(first.markets[0]?.exchangeId).toBe("synthetic-preview");
    expect(first.unavailableTelemetry.join(" ")).toContain("no adapters");
  });

  it("has no runtime imports from live subsystems", () => {
    const source = readFileSync(new URL("../../src/dashboard/syntheticStatus.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']\.\.\/(adapters|engine|config|paperRunner|alerting)\//);
  });
});
