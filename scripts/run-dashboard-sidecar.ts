import { join } from "node:path";
import { createDashboardServer } from "../src/dashboard/server.js";
import { aggregateDashboardSnapshots, readDashboardSnapshots } from "../src/dashboard/DashboardSnapshotSidecar.js";

export const DASHBOARD_SIDECAR_HOST = "127.0.0.1";
export const DASHBOARD_SIDECAR_PORT = 4400;

export function sidecarOptions() {
  return { host: DASHBOARD_SIDECAR_HOST, port: DASHBOARD_SIDECAR_PORT } as const;
}

export const DASHBOARD_SNAPSHOT_DIRECTORY = join(process.cwd(), "state", "dashboard", "snapshots");

if (import.meta.url === `file://${process.argv[1]}`) {
  createDashboardServer(
    () => aggregateDashboardSnapshots(readDashboardSnapshots(DASHBOARD_SNAPSHOT_DIRECTORY)),
    sidecarOptions(),
  );
  console.log(`Dashboard sidecar: http://${DASHBOARD_SIDECAR_HOST}:${DASHBOARD_SIDECAR_PORT}`);
}
