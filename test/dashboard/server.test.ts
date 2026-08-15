import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDashboardRequestHandler,
  createDashboardServer,
} from "../../src/dashboard/server.js";
import type { DashboardMarket } from "../../src/dashboard/DashboardService.js";
import { MarketEngine } from "../../src/engine/MarketEngine.js";
import type { EngineMarketConfig } from "../../src/engine/types.js";
import { FakeExchangeAdapter } from "../engine/fakeAdapter.js";

describe("dashboard static safety", () => {
  const source = readFileSync(new URL("../../src/dashboard/dashboard.html", import.meta.url), "utf8");

  it("uses only the approved cached venue filters and no unsafe HTML interpolation", () => {
    expect(source.match(/<option value="(?:n1-live|risex-paper)">/g)).toHaveLength(2);
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("implements locked controls as accessible disabled elements", () => {
    expect(source).toContain("disabled aria-describedby=\"bot-lock-help\"");
    expect(source).toContain("button.disabled=true");
    expect(source).toContain("dashboard is read only");
  });

  it("renders distinct pending and unknown order warning states", () => {
    expect(source).toContain("state-pending");
    expect(source).toContain("state-unknown");
    expect(source).toContain('x.state!=="FILLED"&&x.state!=="CANCELLED"');
  });
});

function testConfig(symbol: string): EngineMarketConfig {
  return {
    symbol,
    orderSize: { min: 0.00155, max: 0.00232 },
    spreadBps: { normal: 5, min: 4, max: 7.5 },
    exitSpreadBps: 2.5,
    quoteLevels: 5,
    levelSpacingBps: [2, 3, 4, 7, 10],
    inventoryReductionThresholdBase: 0.003,
    riskLimits: {
      maxLongPosition: 0.005,
      maxShortPosition: 0.005,
      maxOrderSize: 0.0025,
      maxOrderNotionalUsd: 160,
      maxOpenOrders: 12,
    },
    accountSessionLossCapUsd: 15,
    reduceOnlyExit: { minHoldMs: 45_000, maxHoldMs: 300_000 },
    quoteMinimumLifetimeMs: 2_000,
  };
}

function tempPaths(symbol: string): { stateFilePath: string; tradeLogFilePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-server-test-"));
  return {
    stateFilePath: join(dir, `orders-${symbol}.json`),
    tradeLogFilePath: join(dir, `trades-${symbol}.jsonl`),
  };
}

describe("createDashboardServer", () => {
  let adapter: FakeExchangeAdapter;
  let server: Server;
  let baseUrl: string;
  let markets: DashboardMarket[];

  beforeEach(async () => {
    adapter = new FakeExchangeAdapter();
    adapter.marketPrices.set("BTCUSD", { market: "BTCUSD", mark: 60000, index: 60000 });

    const engine = new MarketEngine(adapter, testConfig("BTCUSD"), tempPaths("BTCUSD"));
    await engine.start();
    markets = [{ market: "BTCUSD", engine, adapter }];

    server = createDashboardServer(markets, { port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    server.close();
  });

  it("only binds to 127.0.0.1 by default", () => {
    const { address } = server.address() as AddressInfo;
    expect(address).toBe("127.0.0.1");
  });

  it("rejects a non-loopback listener before opening it", () => {
    expect(() => createDashboardServer(markets, { host: "0.0.0.0", port: 4100 })).toThrow(
      "must bind to 127.0.0.1",
    );
  });

  it("contains status-building failures instead of throwing into the owning process", async () => {
    vi.spyOn(markets[0]!.engine, "getSessionRealizedPnlUsd").mockImplementation(() => {
      throw new Error("telemetry failure");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await fetch(`${baseUrl}/api/status`);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Dashboard unavailable" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("telemetry failure"));
    error.mockRestore();
  });

  it("serves the dashboard HTML at /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<html");
  });

  it("serves live JSON status at /api/status", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const status = (await res.json()) as { markets: Array<{ market: string }> };
    expect(status.markets).toHaveLength(1);
    expect(status.markets[0]?.market).toBe("BTCUSD");
  });

  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("dashboard health handlers", () => {
  it.each([
    ["/healthz", { status: "ok" }],
    ["/readyz", { status: "ready" }],
  ])("serves %s without reading or disclosing dashboard status", (url, expected) => {
    const readStatus = vi.fn(() => { throw new Error("must not be read"); });
    const handler = createDashboardRequestHandler(readStatus);
    const req = { url };
    const responseBody: string[] = [];
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((body: string) => responseBody.push(body)),
    };

    handler(req as never, res as never);

    expect(readStatus).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });
    expect(JSON.parse(responseBody[0]!)).toEqual(expected);
    expect(responseBody[0]).not.toMatch(/market|order|position|balance|pnl/i);
  });
});
