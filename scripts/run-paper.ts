/**
 * Paper-mode soak-test runner (SPEC.md Section 10 step 3 / Section 9.3).
 *
 * Connects to REAL N1 market data (read-only, unauthenticated — no private key, no NordUser is
 * ever constructed) and simulates execution entirely locally via N1PaperAdapter. No order this
 * script places ever reaches the real exchange.
 *
 * NOT executed as part of building this harness. .env still holds fake placeholder values for
 * N1_WEB_SERVER_URL / N1_APP_ADDR (see .env.example) — nothing here can reach a real endpoint
 * until you fill those in yourself, by hand, outside any AI coding session (SPEC.md Section
 * 9.1). Running this script for real is a manual step for you once those values exist.
 *
 * Usage (once .env has real values):
 *   cp config/markets.example.yaml config/markets.yaml   # then fill in real exchangeSymbol values
 *   node --env-file=.env $(npm bin)/tsx scripts/run-paper.ts
 *   # (or any equivalent way of loading .env into the environment before running tsx)
 *
 * Env vars:
 *   N1_WEB_SERVER_URL, N1_APP_ADDR   — required, see .env.example. N1_PRIVATE_KEY is NOT used.
 *   SOLANA_RPC_URL                   — default: https://api.mainnet-beta.solana.com
 *   MARKETS_CONFIG_PATH              — default: config/markets.yaml
 *   PAPER_STARTING_BALANCE_USDC      — default: 10000
 *   PAPER_CYCLE_INTERVAL_MS          — default: 5000
 *   PAPER_DURATION_MS                — default: unset (runs until Ctrl-C)
 *   DASHBOARD_PORT                   — default: 4000. Status-only HTTP server, bound to
 *                                      127.0.0.1 only (see src/dashboard/server.ts).
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — optional, see .env.example. Alerts are tagged "[N1]"
 *                                      so they're distinguishable from run-stub-paper.ts /
 *                                      run-risex-paper.ts in a shared chat. Alerting is disabled
 *                                      (logged once, non-fatal) if either is unset.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Nord } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import { N1PaperAdapter } from "../src/adapters/n1/N1PaperAdapter.js";
import { RealN1MarketDataSource } from "../src/adapters/n1/N1MarketDataSource.js";
import { createAlertBusFromEnv } from "../src/alerting/createAlertBusFromEnv.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { buildDashboardStatus, type DashboardMarket } from "../src/dashboard/DashboardService.js";
import { DASHBOARD_SNAPSHOT_DIRECTORY, DashboardSnapshotPublisher } from "../src/dashboard/DashboardSnapshotSidecar.js";
import { DashboardTelemetry } from "../src/dashboard/DashboardTelemetry.js";
import { DashboardHistoryStore } from "../src/dashboard/DashboardHistoryStore.js";
import { MarketEngine } from "../src/engine/MarketEngine.js";
import { PaperRunner, type PaperRunnerMarket } from "../src/paperRunner/PaperRunner.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. See .env.example for what's needed.`);
  }
  return value;
}

async function main(): Promise<void> {
  const webServerUrl = requiredEnv("N1_WEB_SERVER_URL");
  const app = requiredEnv("N1_APP_ADDR");
  const solanaRpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const startingBalanceUsdc = Number(process.env.PAPER_STARTING_BALANCE_USDC ?? "10000");
  const intervalMs = Number(process.env.PAPER_CYCLE_INTERVAL_MS ?? "5000");
  const durationMs = process.env.PAPER_DURATION_MS
    ? Number(process.env.PAPER_DURATION_MS)
    : undefined;
  const configPath =
    process.env.MARKETS_CONFIG_PATH ?? join(process.cwd(), "config", "markets.yaml");

  if (!existsSync(configPath)) {
    throw new Error(
      `No markets config found at "${configPath}". Copy config/markets.example.yaml to ` +
        `config/markets.yaml (or set MARKETS_CONFIG_PATH) and confirm real exchangeSymbol values.`,
    );
  }

  const config = loadMarketsConfig(configPath);
  const enabled = config.markets.filter((m) => m.enabled && m.exchange === "n1");
  if (enabled.length === 0) {
    throw new Error(`No enabled n1 markets found in "${configPath}".`);
  }

  const solanaConnection = new Connection(solanaRpcUrl);
  // Bare, unauthenticated Nord client — read-only market data only. No NordUser, no private key.
  const nord = await Nord.new({ webServerUrl, app, solanaConnection });
  const marketData = new RealN1MarketDataSource(nord);

  // ONE shared N1PaperAdapter across every configured market — matches N1's real single
  // cross-margined account (SPEC.md Section 4.3). A separate adapter (and separate starting
  // balance) per market would be a materially different, more optimistic simulation than what
  // actually running multiple markets on one account behaves like.
  const paperAdapter = new N1PaperAdapter(marketData, {
    markets: enabled.map((m) => ({ symbol: m.symbol, exchangeSymbol: m.exchangeSymbol })),
    startingBalanceUsdc,
  });
  await paperAdapter.connect();

  const alertBus = createAlertBusFromEnv("N1");
  const history = new DashboardHistoryStore(join(process.cwd(), "state", "dashboard"), "n1-paper");
  const telemetry = new DashboardTelemetry(paperAdapter, false, 100, history, () => alertBus?.getDeliveryHealth() ?? { enabled: false, attempted: 0, delivered: 0, failed: 0, pending: 0 });

  const runnerMarkets: PaperRunnerMarket[] = enabled.map((marketConfig) => ({
    market: marketConfig.symbol,
    engine: new MarketEngine(paperAdapter, toEngineMarketConfig(marketConfig), {
      stateFilePath: join(process.cwd(), "state", "paper", `orders-${marketConfig.symbol}.json`),
      tradeLogFilePath: join(
        process.cwd(),
        "state",
        "paper",
        `trades-${marketConfig.symbol}.jsonl`,
      ),
      onFillRecorded: (entry) => {
        telemetry.recordFill(entry);
        alertBus?.emit({
          type: "fill",
          market: entry.market,
          side: entry.side,
          size: entry.size,
          price: entry.price,
          isReduceOnly: entry.isReduceOnly,
        });
      },
    }),
    pnlSource: paperAdapter,
  }));

  // Same shared paperAdapter across every market (SPEC.md Section 4.3) — the dashboard reads
  // from it directly, never issuing its own exchange call.
  const dashboardMarkets: DashboardMarket[] = runnerMarkets.map(({ market, engine }) => ({
    market,
    engine,
    adapter: paperAdapter,
    telemetry,
  }));
  const dashboardPort = Number(process.env.DASHBOARD_PORT ?? "4000");
  const dashboardServer = createDashboardServer(dashboardMarkets, { port: dashboardPort });
  const snapshotPublisher = new DashboardSnapshotPublisher(
    DASHBOARD_SNAPSHOT_DIRECTORY,
    "n1-paper",
    () => buildDashboardStatus(dashboardMarkets),
  );
  snapshotPublisher.start();

  const logFilePath = join(
    process.cwd(),
    "state",
    "paper",
    "logs",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );

  const runner = new PaperRunner(runnerMarkets, { intervalMs, durationMs, logFilePath, alertBus, telemetry });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
    const result = await runner.shutdown();
    snapshotPublisher.stop();
    await new Promise<void>((resolve) => dashboardServer.close(() => resolve()));
    console.log("\n=== Soak report ===");
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.successful ? 0 : 1);
  })();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  console.log(`Starting paper run for markets: ${enabled.map((m) => m.symbol).join(", ")}`);
  console.log(
    `Cycle interval: ${intervalMs}ms${durationMs ? `, duration: ${durationMs}ms` : " (until Ctrl-C)"}`,
  );
  console.log(`Log file: ${logFilePath}`);
  console.log(`Dashboard: http://127.0.0.1:${dashboardPort}`);
  await runner.start();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
