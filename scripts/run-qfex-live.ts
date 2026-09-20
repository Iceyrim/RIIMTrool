/** QFEX UAT-first live runner. No connection is made merely by importing this module. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { QfexAdapter } from "../src/adapters/qfex/QfexAdapter.js";
import { QFEX_PRODUCTION_MDS_URL, QFEX_PRODUCTION_TRADE_URL, QFEX_UAT_MDS_URL, QFEX_UAT_TRADE_URL, QfexWebSocketTransport } from "../src/adapters/qfex/QfexWebSocketTransport.js";
import { createAlertBusFromEnv } from "../src/alerting/createAlertBusFromEnv.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { buildDashboardStatus, type DashboardMarket } from "../src/dashboard/DashboardService.js";
import { DashboardHistoryStore } from "../src/dashboard/DashboardHistoryStore.js";
import { DASHBOARD_SNAPSHOT_DIRECTORY, DashboardSnapshotPublisher } from "../src/dashboard/DashboardSnapshotSidecar.js";
import { DashboardTelemetry } from "../src/dashboard/DashboardTelemetry.js";
import { MarketEngine } from "../src/engine/MarketEngine.js";
import { WindowLossCapTracker } from "../src/engine/WindowLossCapTracker.js";
import { assertQfexPreflight, consumeQfexLiveArmFile, estimateQfexInitialMargin, planQfexFlattenChunks, requireQfexLiveCliFlag } from "../src/engine/QfexLiveStartup.js";
import { PaperRunner, type PaperRunnerMarket, type RealizedPnlSource } from "../src/paperRunner/PaperRunner.js";
import { WindowTrackingRealizedPnlSource } from "../src/paperRunner/WindowTrackingRealizedPnlSource.js";

async function confirm(phrase: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("QFEX Live requires a human at an interactive terminal");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if ((await rl.question(`\nType exactly: ${phrase}\n> `)) !== phrase) throw new Error("confirmation phrase did not match; QFEX Live NOT started");
  } finally { rl.close(); }
}

export class QfexEquityPnlSource implements RealizedPnlSource {
  readonly scope = "account" as const;
  private last?: number;
  constructor(private readonly adapter: QfexAdapter) {}
  arm(): void { this.last = this.adapter.getMarginStatus().accountValue; }
  async drainRealizedPnlDeltaUsd(): Promise<number> {
    const current = this.adapter.getMarginStatus().accountValue;
    if (!Number.isFinite(current) || current < 0) throw new Error("QFEX account equity is invalid");
    const previous = this.last;
    this.last = current;
    return previous === undefined ? 0 : current - previous;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const preflightOnly = argv.includes("--preflight-only");
  const allowed = new Set(["--preflight-only", "--i-understand-this-places-real-orders"]);
  const unknown = argv.find((arg) => !allowed.has(arg));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  if (!preflightOnly) requireQfexLiveCliFlag(argv);

  const publicKey = process.env.QFEX_API_KEY;
  const secretKey = process.env.QFEX_API_SECRET;
  if (!publicKey || !secretKey) throw new Error("QFEX_API_KEY and QFEX_API_SECRET must be supplied through the protected VPS credential environment");
  const environment = process.env.QFEX_ENV ?? "uat";
  if (!["uat", "production"].includes(environment)) throw new Error("QFEX_ENV must be uat or production");
  if (environment === "production" && process.env.QFEX_ALLOW_PRODUCTION !== "YES") throw new Error("production requires QFEX_ALLOW_PRODUCTION=YES");
  const source = resolve(process.env.QFEX_MARKETS_CONFIG_PATH ?? "config/markets.qfex-uat.yaml");
  const config = loadMarketsConfig(source);
  const enabled = config.markets.filter((market) => market.enabled && market.exchange === "qfex");
  if (!enabled.length) throw new Error("No enabled QFEX markets; choose verified UAT symbols and constraints first");
  const stateRoot = resolve("state/qfex-live", environment);
  mkdirSync(stateRoot, { recursive: true });
  if (!preflightOnly) consumeQfexLiveArmFile(resolve("state/qfex-live/ARMED"));

  const adapterMarkets = enabled.map(({ symbol, exchangeSymbol, priceTickSize, quantityStep, minimumOrderSize }) => {
    if (!priceTickSize || !quantityStep || !minimumOrderSize) {
      throw new Error("Enabled QFEX markets require priceTickSize, quantityStep and minimumOrderSize");
    }
    return { symbol, exchangeSymbol, priceTickSize, quantityStep, minimumOrderSize };
  });
  const transport = new QfexWebSocketTransport({
    tradeUrl: process.env.QFEX_TRADE_URL ?? (environment === "production" ? QFEX_PRODUCTION_TRADE_URL : QFEX_UAT_TRADE_URL),
    marketDataUrl: process.env.QFEX_MDS_URL ?? (environment === "production" ? QFEX_PRODUCTION_MDS_URL : QFEX_UAT_MDS_URL),
    credentials: { publicKey, secretKey, accountId: process.env.QFEX_ACCOUNT_ID },
    symbols: enabled.map((market) => market.exchangeSymbol),
    cancelOnDisconnect: !preflightOnly,
  });
  const adapter = new QfexAdapter(transport, adapterMarkets);
  await adapter.connect();
  const marks = new Map(await Promise.all(enabled.map(async (market) => [market.symbol, (await adapter.getMarketPrice(market.symbol)).mark] as const)));
  const positions = adapter.getPositions();
  const orders = adapter.getOpenOrders();
  const balances = adapter.getBalances();
  const margin = adapter.getMarginStatus();
  const estimatedInitialMargin = estimateQfexInitialMargin(enabled, marks);
  const blockers: string[] = [];
  try {
    assertQfexPreflight({ flat: positions.every((position) => position.baseSize === 0), openOrderCount: orders.length, availableCollateral: balances[0]?.amount ?? 0, estimatedInitialMargin, marginSafe: !margin.isAtBankruptcyRisk });
  } catch (error) { blockers.push(error instanceof Error ? error.message : String(error)); }

  console.log("\n=== [QFEX] Authenticated read-only preflight ===");
  console.log(`Environment: ${environment}`);
  console.log(`Markets: ${enabled.map((market) => market.symbol).join(", ")}`);
  console.log(`Balances: ${JSON.stringify(balances)}`);
  console.log(`Margin: ${JSON.stringify(margin)}`);
  console.log(`Positions: ${JSON.stringify(positions)}`);
  console.log(`Open orders: ${JSON.stringify(orders)}`);
  console.log(`Estimated initial margin: $${estimatedInitialMargin.toFixed(2)}`);
  console.log(`Preflight status: ${blockers.length ? "BLOCKED" : "READY"}`);
  for (const blocker of blockers) console.log(`Blocker: ${blocker}`);
  if (preflightOnly) {
    await adapter.disconnect();
    console.log("[QFEX] Read-only preflight complete; no order command was submitted.");
    return;
  }
  if (blockers.length) { await adapter.disconnect(); throw new Error("QFEX live preflight is blocked"); }
  await confirm(`CONFIRM LIVE QFEX ${environment.toUpperCase()} ${enabled.map((market) => market.symbol).join(",")}`);

  const alertBus = createAlertBusFromEnv("QFEX LIVE");
  const windows = new WindowLossCapTracker({ dailyLossCapUsd: config.accountRisk.dailyLossCapUsd, weeklyLossCapUsd: config.accountRisk.weeklyLossCapUsd, anchorFilePath: join(stateRoot, "pnl-window-anchors.json"), alertBus });
  const rawPnl = new QfexEquityPnlSource(adapter);
  rawPnl.arm();
  const pnlSource = new WindowTrackingRealizedPnlSource(rawPnl, windows);
  const history = new DashboardHistoryStore(resolve("state/dashboard"), `qfex-live-${environment}`);
  const telemetry = new DashboardTelemetry(adapter, true, 100, history);
  const markets: PaperRunnerMarket[] = enabled.map((market) => ({
    market: market.symbol,
    engine: new MarketEngine(adapter, toEngineMarketConfig(market), {
      stateFilePath: join(stateRoot, `orders-${market.symbol}.json`),
      tradeLogFilePath: join(stateRoot, `trades-${market.symbol}.jsonl`),
      windowLossCapProvider: windows,
      onFillRecorded: (entry) => telemetry.recordFill(entry),
    }),
    pnlSource,
  }));
  const dashboardMarkets: DashboardMarket[] = markets.map(({ market, engine }) => ({ market, engine, adapter, telemetry }));
  const publisher = new DashboardSnapshotPublisher(DASHBOARD_SNAPSHOT_DIRECTORY, "qfex-live", () => buildDashboardStatus(dashboardMarkets));
  publisher.start();
  const runner = new PaperRunner(markets, { intervalMs: Number(process.env.QFEX_LIVE_CYCLE_INTERVAL_MS ?? "5000"), runnerLabel: "QfexLiveRunner", logFilePath: join(stateRoot, "logs", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`), alertBus, telemetry });
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[QFEX] Shutting down: ${reason}`);
    const result = await runner.shutdown();
    const flattening: unknown[] = [];
    await adapter.refreshAccountState();
    for (const market of enabled) {
      const position = adapter.getPositions(market.symbol)[0]?.baseSize ?? 0;
      const confirmed: number[] = [];
      const failures: string[] = [];
      for (const size of planQfexFlattenChunks(position, market.riskLimits.maxOrderSize)) {
        const mark = (await adapter.getMarketPrice(market.symbol)).mark;
        const placed = await adapter.placeOrder({ market: market.symbol, side: position > 0 ? "sell" : "buy", type: "immediateOrCancel", price: position > 0 ? mark * 0.995 : mark * 1.005, size, isReduceOnly: true });
        if (!placed.success) { failures.push(placed.message); break; }
        confirmed.push(size);
        await adapter.refreshAccountState();
      }
      flattening.push({ market: market.symbol, initialBaseSize: position, confirmedChunks: confirmed, failures });
    }
    await adapter.refreshAccountState();
    const finalOrders = adapter.getOpenOrders();
    const finalPositions = adapter.getPositions();
    const flat = result.successful && finalOrders.length === 0 && finalPositions.every((position) => position.baseSize === 0) && (flattening as Array<{ failures: string[] }>).every((row) => !row.failures.length);
    publisher.stop(reason);
    await adapter.disconnect();
    console.log(JSON.stringify({ mode: "qfex-live", environment, reason, cleanup: result.cleanup, flattening, openOrders: finalOrders, positions: finalPositions, finalStatus: flat ? "completed-flat" : "manual-review-required" }, null, 2));
    process.exit(flat ? 0 : 1);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  console.log(`[QFEX] Starting ${environment} live run for ${enabled.map((market) => market.symbol).join(", ")}`);
  await runner.start();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main().catch((error) => { console.error(error); process.exitCode = 1; });
