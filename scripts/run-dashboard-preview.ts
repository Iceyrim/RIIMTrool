import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDashboardRequestHandler,
  createDashboardServer,
  type DashboardServerOptions,
} from "../src/dashboard/server.js";
import { buildSyntheticDashboardStatus } from "../src/dashboard/syntheticStatus.js";

export const DASHBOARD_PREVIEW_HOST = "127.0.0.1";
export const DASHBOARD_PREVIEW_DEFAULT_PORT = 4200;

export function createDashboardPreviewHandler() {
  return createDashboardRequestHandler(buildSyntheticDashboardStatus);
}

export function dashboardPreviewOptions(port = DASHBOARD_PREVIEW_DEFAULT_PORT): DashboardServerOptions {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Preview port must be an integer from 1 to 65535");
  }
  return { host: DASHBOARD_PREVIEW_HOST, port };
}

export function startDashboardPreview(port = DASHBOARD_PREVIEW_DEFAULT_PORT) {
  return createDashboardServer(buildSyntheticDashboardStatus, dashboardPreviewOptions(port));
}

function readPort(args: readonly string[]): number {
  if (args.length === 0) return DASHBOARD_PREVIEW_DEFAULT_PORT;
  if (args.length !== 2 || args[0] !== "--port") {
    throw new Error("Usage: npm run dashboard:preview -- [--port <port>]");
  }
  return Number(args[1]);
}

const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const port = readPort(process.argv.slice(2));
  startDashboardPreview(port);
  console.log(`Synthetic dashboard preview: http://${DASHBOARD_PREVIEW_HOST}:${port}`);
}
