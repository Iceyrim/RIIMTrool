import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboardStatus, type DashboardMarket } from "./DashboardService.js";

const dashboardDir = dirname(fileURLToPath(import.meta.url));
// Read once at module load, not per-request — this is a static asset, not something that changes
// while the process runs.
const dashboardHtml = readFileSync(join(dashboardDir, "dashboard.html"), "utf-8");

export interface DashboardServerOptions {
  /** Defaults to 127.0.0.1: this serves in-process state for local/operator viewing, not meant
   * to be reachable off the host. */
  host?: string;
  port: number;
}

/**
 * SPEC.md Section 8: "one process, one status endpoint, all markets included natively, no
 * polling/aggregation needed at all." This server reads directly from the same MarketEngine /
 * ExchangeAdapter instances the caller's paper (or, eventually, live) run loop is already
 * driving — it never talks to an exchange itself, live or otherwise, and never places or cancels
 * an order. Status-only.
 */
export function createDashboardServer(
  markets: readonly DashboardMarket[],
  options: DashboardServerOptions,
): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/api/status") {
      const status = buildDashboardStatus(markets);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(dashboardHtml);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  server.listen(options.port, options.host ?? "127.0.0.1");
  return server;
}
