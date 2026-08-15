import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_PREVIEW_HOST,
  createDashboardPreviewHandler,
  dashboardPreviewOptions,
} from "../../scripts/run-dashboard-preview.js";

describe("dashboard preview launcher", () => {
  it("wires a synthetic handler without starting a server", () => {
    expect(createDashboardPreviewHandler()).toBeTypeOf("function");
    expect(dashboardPreviewOptions()).toEqual({ host: "127.0.0.1", port: 4200 });
    expect(DASHBOARD_PREVIEW_HOST).toBe("127.0.0.1");
  });

  it("imports no live subsystem", () => {
    const source = readFileSync(new URL("../../scripts/run-dashboard-preview.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']\.\.\/src\/(adapters|engine|config|paperRunner|alerting)\//);
  });

  it.each([0, 65_536, 1.5, Number.NaN])("rejects invalid port %s", (port) => {
    expect(() => dashboardPreviewOptions(port)).toThrow("Preview port");
  });
});
