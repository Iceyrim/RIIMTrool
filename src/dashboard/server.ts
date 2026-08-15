import { createServer, type RequestListener, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDashboardStatus,
  type DashboardMarket,
  type DashboardStatus,
} from "./DashboardService.js";

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

export type DashboardStatusProvider = () => DashboardStatus;

function statusProvider(
  source: readonly DashboardMarket[] | DashboardStatusProvider,
): DashboardStatusProvider {
  return typeof source === "function" ? source : () => buildDashboardStatus(source);
}

/** Kept separate from listen() so failure containment can be tested without opening a socket. */
export function createDashboardRequestHandler(
  source: readonly DashboardMarket[] | DashboardStatusProvider,
): RequestListener {
  const readStatus = statusProvider(source);
  return (req, res) => {
    try {
      const url = req.url ?? "/";

      if (url === "/api/status") {
        const status = readStatus();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(status));
        return;
      }

      if (url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (url === "/readyz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ready" }));
        return;
      }

      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardHtml);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (error) {
      // The dashboard is observability-only: telemetry/render failures must not escape into the
      // process that owns the trading loop.
      console.error(`[Dashboard] request failed: ${String(error)}`);
      if (!res.headersSent) {
        res.writeHead(503, { "content-type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: "Dashboard unavailable" }));
      }
    }
  };
}

/**
 * SPEC.md Section 8: "one process, one status endpoint, all markets included natively, no
 * polling/aggregation needed at all." This server reads directly from the same MarketEngine /
 * ExchangeAdapter instances the caller's paper (or, eventually, live) run loop is already
 * driving — it never talks to an exchange itself, live or otherwise, and never places or cancels
 * an order. Status-only.
 */
export function createDashboardServer(
  source: readonly DashboardMarket[] | DashboardStatusProvider,
  options: DashboardServerOptions,
): Server {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("Dashboard server must bind to 127.0.0.1");
  }

  const server = createServer(createDashboardRequestHandler(source));

  server.on("error", (error) => {
    console.error(`[Dashboard] server error: ${String(error)}`);
  });

  server.listen(options.port, host);
  return server;
}
