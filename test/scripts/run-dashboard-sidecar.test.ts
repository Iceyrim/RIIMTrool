import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SIDECAR_HOST,
  DASHBOARD_SIDECAR_PORT,
  DASHBOARD_SNAPSHOT_DIRECTORY,
  sidecarOptions,
} from "../../scripts/run-dashboard-sidecar.js";

describe("dashboard sidecar launcher", () => {
  it("is fixed to its approved loopback port", () => {
    expect(sidecarOptions()).toEqual({ host: "127.0.0.1", port: 4400 });
    expect(DASHBOARD_SIDECAR_HOST).toBe("127.0.0.1");
    expect(DASHBOARD_SIDECAR_PORT).toBe(4400);
    expect(DASHBOARD_SNAPSHOT_DIRECTORY).toBe("/var/lib/riim-dashboard/state/dashboard/snapshots");
  });
});
