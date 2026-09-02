/** Continuous RISEx session-signer market maker. Live execution requires every explicit gate. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { RealRiseXMarketDataSource } from "../src/adapters/risex/RiseXMarketDataSource.js";
import { RiseXPermitExecutionTransport } from "../src/adapters/risex/RiseXPermitExecutionTransport.js";
import { EthersRiseXPermitSigner } from "../src/adapters/risex/RiseXPermitSigner.js";
import { RiseXSessionAdapter } from "../src/adapters/risex/RiseXSessionAdapter.js";
import { createAlertBusFromEnv } from "../src/alerting/createAlertBusFromEnv.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { buildDashboardStatus, type DashboardMarket } from "../src/dashboard/DashboardService.js";
import { DashboardHistoryStore } from "../src/dashboard/DashboardHistoryStore.js";
import { DASHBOARD_SNAPSHOT_DIRECTORY, DashboardSnapshotPublisher } from "../src/dashboard/DashboardSnapshotSidecar.js";
import { DashboardTelemetry } from "../src/dashboard/DashboardTelemetry.js";
import { MarketEngine } from "../src/engine/MarketEngine.js";
import { assertRiseXPreflight, consumeRiseXLiveArmFile, estimateRiseXInitialMargin, planRiseXFlattenChunks, requireRiseXLiveCliFlag } from "../src/engine/RiseXLiveStartup.js";
import { PaperRunner, type PaperRunnerMarket, type RealizedPnlSource } from "../src/paperRunner/PaperRunner.js";

const BASE_URL = process.env.RISEX_API_BASE_URL ?? "https://api.rise.trade";

async function confirm(phrase: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("RISEx Live requires a human at an interactive terminal");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { if ((await rl.question(`\nType exactly: ${phrase}\n> `)) !== phrase) throw new Error("confirmation phrase did not match; RISEx Live NOT started"); }
  finally { rl.close(); }
}

class RiseXEquityPnlSource implements RealizedPnlSource {
  readonly scope = "account" as const;
  private last?: number;
  constructor(private readonly adapter: RiseXSessionAdapter) {}
  arm(): void { this.last = this.adapter.getMarginStatus().accountValue; }
  async drainRealizedPnlDeltaUsd(): Promise<number> {
    const current = this.adapter.getMarginStatus().accountValue;
    if (!Number.isFinite(current) || current < 0) throw new Error("RISEx account equity is invalid");
    const previous = this.last; this.last = current;
    return previous === undefined ? 0 : Math.min(0, current - previous);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const preflightOnly = argv.includes("--preflight-only");
  const allowed = new Set(["--preflight-only", "--i-understand-this-places-real-orders"]);
  const unknown = argv.find((arg) => !allowed.has(arg));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  if (!preflightOnly) requireRiseXLiveCliFlag(argv);
  const account = process.env.RISEX_ACCOUNT_ADDRESS;
  if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error("RISEX_ACCOUNT_ADDRESS is missing or invalid");

  const stateRoot = resolve("state/risex-live", account.toLowerCase());
  mkdirSync(stateRoot, { recursive: true });
  if (!preflightOnly) consumeRiseXLiveArmFile(resolve("state/risex-live/ARMED"));
  const config = loadMarketsConfig(process.env.RISEX_MARKETS_CONFIG_PATH ?? resolve("config/markets.risex-live.yaml"));
  const enabled = config.markets.filter((market) => market.enabled && market.exchange === "risex");
  if (!enabled.length) throw new Error("No enabled RISEx live markets");
  const configured = enabled.map((market) => ({ symbol: market.symbol, exchangeSymbol: market.exchangeSymbol }));
  const marketData = new RealRiseXMarketDataSource(BASE_URL);

  // Signer-free preflight. No private key is read and the execution transport does not exist.
  const readonly = new RiseXSessionAdapter(marketData, undefined, { baseUrl: BASE_URL, account, markets: configured });
  await readonly.connect();
  const positions = readonly.getPositions();
  const orders = readonly.getOpenOrders();
  const balances = readonly.getBalances();
  const margin = readonly.getMarginStatus();
  const marks = new Map(await Promise.all(enabled.map(async (market) => [market.symbol, (await readonly.getMarketPrice(market.symbol)).mark] as const)));
  const estimatedInitialMargin = estimateRiseXInitialMargin(enabled, marks);
  const blockers: string[] = [];
  try { assertRiseXPreflight({ flat: positions.every((position) => position.baseSize === 0), openOrderCount: orders.length, availableCollateral: balances[0]?.amount ?? 0, estimatedInitialMargin, marginSafe: !margin.isAtBankruptcyRisk }); }
  catch (error) { blockers.push(error instanceof Error ? error.message : String(error)); }

  console.log("\n=== [RISEX LIVE] Pre-flight account snapshot ===");
  console.log(`Account: ${account}`);
  console.log(`Markets: ${enabled.map((market) => market.symbol).join(", ")}`);
  console.log(`Balances: ${JSON.stringify(balances)}`);
  console.log(`Margin: ${JSON.stringify(margin)}`);
  console.log(`Positions: ${JSON.stringify(positions)}`);
  console.log(`Open orders: ${JSON.stringify(orders)}`);
  console.log(`Configured resting quotes: ${enabled.reduce((sum, market) => sum + 2 * market.quoteLevels, 0)}`);
  console.log(`Estimated initial margin: $${estimatedInitialMargin.toFixed(2)}`);
  console.log(`Session equity-loss cap: $${config.accountRisk.sessionLossCapUsd}`);
  console.log(`Preflight status: ${blockers.length ? "BLOCKED" : "READY"}`);
  for (const blocker of blockers) console.log(`Blocker: ${blocker}`);
  if (preflightOnly) { await readonly.disconnect(); console.log("[RISEX LIVE] Read-only preflight complete; no signer was opened and no transaction was submitted."); return; }
  if (blockers.length) { await readonly.disconnect(); throw new Error("RISEx Live preflight is blocked"); }
  await confirm(`CONFIRM LIVE RISEX ${enabled.map((market) => market.symbol).join(",")}`);

  // The session signer key is intentionally loaded only after preflight and human confirmation.
  const privateKey = process.env.RISEX_SESSION_SIGNER_PRIVATE_KEY;
  if (!privateKey) { await readonly.disconnect(); throw new Error("RISEX_SESSION_SIGNER_PRIVATE_KEY is missing"); }
  const signer = new EthersRiseXPermitSigner(privateKey);
  const expectedSigner = process.env.RISEX_SESSION_SIGNER_ADDRESS;
  if (expectedSigner && signer.address.toLowerCase() !== expectedSigner.toLowerCase()) throw new Error("RISEx session signer address does not match the configured key");
  await readonly.disconnect();
  const execution = new RiseXPermitExecutionTransport(marketData, signer, { baseUrl: BASE_URL, account, markets: configured });
  const adapter = new RiseXSessionAdapter(marketData, execution, { baseUrl: BASE_URL, account, markets: configured });
  await adapter.connect();
  const pnlSource = new RiseXEquityPnlSource(adapter); pnlSource.arm();
  const alertBus = createAlertBusFromEnv("RISEX LIVE");
  const history = new DashboardHistoryStore(resolve("state/dashboard"), `risex-live-${account.toLowerCase()}`);
  const telemetry = new DashboardTelemetry(adapter, true, 100, history, () => alertBus?.getDeliveryHealth() ?? { enabled: false, attempted: 0, delivered: 0, failed: 0, pending: 0 });
  const markets: PaperRunnerMarket[] = enabled.map((market) => ({ market: market.symbol, engine: new MarketEngine(adapter, toEngineMarketConfig(market), {
    stateFilePath: join(stateRoot, `orders-${market.symbol}.json`), tradeLogFilePath: join(stateRoot, `trades-${market.symbol}.jsonl`),
    onFillRecorded: (entry) => { telemetry.recordFill(entry); alertBus?.emit({ type: "fill", market: entry.market, side: entry.side, size: entry.size, price: entry.price, isReduceOnly: entry.isReduceOnly }); },
  }), pnlSource }));
  const dashboardMarkets: DashboardMarket[] = markets.map(({ market, engine }) => ({ market, engine, adapter, telemetry }));
  const publisher = new DashboardSnapshotPublisher(DASHBOARD_SNAPSHOT_DIRECTORY, "risex-live", () => buildDashboardStatus(dashboardMarkets)); publisher.start();
  const runner = new PaperRunner(markets, { intervalMs: Number(process.env.RISEX_LIVE_CYCLE_INTERVAL_MS ?? "5000"), runnerLabel: "RiseXLiveRunner", logFilePath: join(stateRoot, "logs", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`), alertBus, telemetry });
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return; shuttingDown = true;
    console.log(`\n[RISEX LIVE] Shutting down: ${reason}`);
    const result = await runner.shutdown();
    const flattening: unknown[] = [];
    await adapter.refreshAccountState();
    for (const market of enabled) {
      const position = adapter.getPositions(market.symbol)[0]?.baseSize ?? 0;
      const confirmed: number[] = []; const failures: string[] = [];
      for (const size of planRiseXFlattenChunks(position, market.riskLimits.maxOrderSize)) {
        const price = (await adapter.getMarketPrice(market.symbol)).mark;
        const placed = await adapter.placeOrder({ market: market.symbol, side: position > 0 ? "sell" : "buy", type: "immediateOrCancel", price: position > 0 ? price * 0.995 : price * 1.005, size, isReduceOnly: true });
        if (!placed.success) { failures.push(placed.message); break; } confirmed.push(size);
        await adapter.refreshAccountState();
      }
      flattening.push({ market: market.symbol, initialBaseSize: position, confirmedChunks: confirmed, failures });
    }
    await adapter.refreshAccountState();
    const finalOrders = adapter.getOpenOrders(); const finalPositions = adapter.getPositions();
    const flat = result.successful && finalOrders.length === 0 && finalPositions.every((position) => position.baseSize === 0) && (flattening as Array<{ failures: string[] }>).every((row) => row.failures.length === 0);
    publisher.stop(); await adapter.disconnect();
    console.log(JSON.stringify({ mode: "risex-live", reason, cleanup: result.cleanup, flattening, openOrders: finalOrders, positions: finalPositions, finalStatus: flat ? "completed-flat" : "manual-review-required" }, null, 2));
    process.exit(flat ? 0 : 1);
  };
  process.once("SIGINT", () => void shutdown("SIGINT")); process.once("SIGTERM", () => void shutdown("SIGTERM"));
  console.log(`\n[RISEX LIVE] Starting continuous live run: ${enabled.map((market) => market.symbol).join(", ")}`);
  console.log("[RISEX LIVE] Press Ctrl-C for mandatory cancellation, reduce-only flattening, and final reconciliation.");
  await runner.start();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main().catch((error) => { console.error(error); process.exitCode = 1; });
