/** Perpl PAPER-only runner: public market data, entirely local simulated execution. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PerplPaperAdapter } from "../src/adapters/perpl/PerplPaperAdapter.js";
import { RealPerplMarketDataSource } from "../src/adapters/perpl/PerplMarketDataSource.js";
import { createAlertBusFromEnv } from "../src/alerting/createAlertBusFromEnv.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { DashboardHistoryStore } from "../src/dashboard/DashboardHistoryStore.js";
import { buildDashboardStatus, type DashboardMarket } from "../src/dashboard/DashboardService.js";
import { DASHBOARD_SNAPSHOT_DIRECTORY, DashboardSnapshotPublisher } from "../src/dashboard/DashboardSnapshotSidecar.js";
import { DashboardTelemetry } from "../src/dashboard/DashboardTelemetry.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { MarketEngine } from "../src/engine/MarketEngine.js";
import { PaperRunner, type PaperRunnerMarket } from "../src/paperRunner/PaperRunner.js";

async function main(): Promise<void> {
  const configPath = process.env.PERPL_MARKETS_CONFIG_PATH ?? join(process.cwd(), "config", "markets.perpl-validation.yaml");
  if (!existsSync(configPath)) throw new Error(`No Perpl markets config at "${configPath}"`);
  const enabled = loadMarketsConfig(configPath).markets.filter((market) => market.enabled && market.exchange === "perpl");
  if (!enabled.length) throw new Error(`No enabled Perpl markets in "${configPath}"`);
  const adapter = new PerplPaperAdapter(new RealPerplMarketDataSource(), { markets: enabled.map((market) => ({ symbol: market.symbol, exchangeSymbol: market.exchangeSymbol })), startingBalanceUsdc: Number(process.env.PAPER_STARTING_BALANCE_USDC ?? "10000") });
  await adapter.connect();
  const alertBus = createAlertBusFromEnv("PERPL PAPER");
  const history = new DashboardHistoryStore(join(process.cwd(), "state", "perpl", "dashboard"), "perpl-paper");
  const telemetry = new DashboardTelemetry(adapter, false, 100, history, () => alertBus?.getDeliveryHealth() ?? { enabled:false,attempted:0,delivered:0,failed:0,pending:0 });
  const runnerMarkets: PaperRunnerMarket[] = enabled.map((config) => ({ market: config.symbol, engine: new MarketEngine(adapter, toEngineMarketConfig(config), { stateFilePath: join(process.cwd(), "state", "perpl", `orders-${config.symbol}.json`), tradeLogFilePath: join(process.cwd(), "state", "perpl", `trades-${config.symbol}.jsonl`), onFillRecorded: (fill) => { telemetry.recordFill(fill); alertBus?.emit({ type:"fill", market:fill.market, side:fill.side, size:fill.size, price:fill.price, isReduceOnly:fill.isReduceOnly }); } }), pnlSource: adapter }));
  const dashboardMarkets: DashboardMarket[] = runnerMarkets.map(({market,engine}) => ({market,engine,adapter,telemetry}));
  const server = createDashboardServer(dashboardMarkets, { port: Number(process.env.DASHBOARD_PORT ?? "4300") });
  const snapshots = new DashboardSnapshotPublisher(join(DASHBOARD_SNAPSHOT_DIRECTORY, "perpl"), "perpl-paper", () => buildDashboardStatus(dashboardMarkets)); snapshots.start();
  const durationMs = process.env.PAPER_DURATION_MS ? Number(process.env.PAPER_DURATION_MS) : undefined;
  const runner = new PaperRunner(runnerMarkets, { intervalMs:Number(process.env.PAPER_CYCLE_INTERVAL_MS ?? "5000"), durationMs, logFilePath:join(process.cwd(),"state","perpl","logs",`run-${new Date().toISOString().replace(/[:.]/g,"-")}.jsonl`), alertBus, telemetry });
  let stopping: Promise<void> | undefined; const stop = () => stopping ??= (async()=>{const result=await runner.shutdown();snapshots.stop();await adapter.disconnect();await new Promise<void>((resolve)=>server.close(()=>resolve()));process.exitCode=result.successful?0:1;})();
  process.on("SIGINT",()=>void stop()); process.on("SIGTERM",()=>void stop()); if(durationMs!==undefined)setTimeout(()=>void stop(),durationMs+500);
  await runner.start();
}
main().catch((error:unknown)=>{console.error(error);process.exitCode=1;});
