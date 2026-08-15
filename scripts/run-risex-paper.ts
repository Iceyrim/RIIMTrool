/**
 * RiseXPaperAdapter soak-test runner (SPEC.md Section 11, build plan step 2).
 *
 * Connects to REAL RISEx mainnet public market data (read-only, unauthenticated —
 * RealRiseXMarketDataSource holds only a base URL, structurally cannot hold a private key/JWT)
 * and simulates execution entirely locally via RiseXPaperAdapter. No order this script places
 * ever reaches the real exchange, no wallet is ever constructed. Otherwise wires the exact same
 * MarketEngine, PaperRunner, DashboardService/createDashboardServer, and TradeLog code paths as
 * scripts/run-paper.ts and scripts/run-stub-paper.ts — the real test of this step is that none of
 * those needed to change to support RISEx.
 *
 * Usage:
 *   npx tsx scripts/run-risex-paper.ts
 *
 * Env vars (all optional):
 *   RISEX_MARKETS_CONFIG_PATH   — default: config/markets.risex-validation.yaml
 *   PAPER_STARTING_BALANCE_USDC — default: 10000
 *   PAPER_CYCLE_INTERVAL_MS     — default: 5000 (real mainnet REST — same cadence as
 *                                 run-paper.ts's real-exchange default, not run-stub-paper.ts's
 *                                 faster synthetic 1000ms)
 *   PAPER_DURATION_MS           — default: unset (runs until Ctrl-C)
 *   DASHBOARD_PORT              — default: 4200 (distinct from run-paper.ts's 4000 and
 *                                 run-stub-paper.ts's 4100, so all three can run at once)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — optional, see .env.example. Alerts are tagged
 *                                 "[RISEX]" so they're distinguishable from run-paper.ts /
 *                                 run-stub-paper.ts in a shared chat. Alerting is disabled
 *                                 (logged once, non-fatal) if either is unset.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RiseXPaperAdapter } from "../src/adapters/risex/RiseXPaperAdapter.js";
import { RealRiseXMarketDataSource } from "../src/adapters/risex/RiseXMarketDataSource.js";
import { createAlertBusFromEnv } from "../src/alerting/createAlertBusFromEnv.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import type { DashboardMarket } from "../src/dashboard/DashboardService.js";
import { DashboardTelemetry } from "../src/dashboard/DashboardTelemetry.js";
import { DashboardHistoryStore } from "../src/dashboard/DashboardHistoryStore.js";
import { MarketEngine } from "../src/engine/MarketEngine.js";
import { PaperRunner, type PaperRunnerMarket } from "../src/paperRunner/PaperRunner.js";

async function main(): Promise<void> {
  const startingBalanceUsdc = Number(process.env.PAPER_STARTING_BALANCE_USDC ?? "10000");
  const intervalMs = Number(process.env.PAPER_CYCLE_INTERVAL_MS ?? "5000");
  const durationMs = process.env.PAPER_DURATION_MS
    ? Number(process.env.PAPER_DURATION_MS)
    : undefined;
  const configPath =
    process.env.RISEX_MARKETS_CONFIG_PATH ??
    join(process.cwd(), "config", "markets.risex-validation.yaml");

  if (!existsSync(configPath)) {
    throw new Error(
      `No markets config found at "${configPath}". See config/markets.risex-validation.yaml.`,
    );
  }

  const config = loadMarketsConfig(configPath);
  const enabled = config.markets.filter((m) => m.enabled && m.exchange === "risex");
  if (enabled.length === 0) {
    throw new Error(`No enabled risex markets found in "${configPath}".`);
  }

  const marketData = new RealRiseXMarketDataSource();

  // ONE shared RiseXPaperAdapter across every configured market — same SPEC.md Section 4.3
  // shared-cross-margin-account reasoning as run-paper.ts's shared N1PaperAdapter.
  const paperAdapter = new RiseXPaperAdapter(marketData, {
    markets: enabled.map((m) => ({ symbol: m.symbol, exchangeSymbol: m.exchangeSymbol })),
    startingBalanceUsdc,
  });
  await paperAdapter.connect();

  const alertBus = createAlertBusFromEnv("RISEX");
  const history = new DashboardHistoryStore(join(process.cwd(), "state", "dashboard"), "risex-paper");
  const telemetry = new DashboardTelemetry(paperAdapter, false, 100, history, () => alertBus?.getDeliveryHealth() ?? { enabled: false, attempted: 0, delivered: 0, failed: 0, pending: 0 });

  const runnerMarkets: PaperRunnerMarket[] = enabled.map((marketConfig) => ({
    market: marketConfig.symbol,
    engine: new MarketEngine(paperAdapter, toEngineMarketConfig(marketConfig), {
      stateFilePath: join(process.cwd(), "state", "risex", `orders-${marketConfig.symbol}.json`),
      tradeLogFilePath: join(
        process.cwd(),
        "state",
        "risex",
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

  const dashboardMarkets: DashboardMarket[] = runnerMarkets.map(({ market, engine }) => ({
    market,
    engine,
    adapter: paperAdapter,
    telemetry,
  }));
  const dashboardPort = Number(process.env.DASHBOARD_PORT ?? "4200");
  const dashboardServer = createDashboardServer(dashboardMarkets, { port: dashboardPort });

  const logFilePath = join(
    process.cwd(),
    "state",
    "risex",
    "logs",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );

  const runner = new PaperRunner(runnerMarkets, { intervalMs, durationMs, logFilePath, alertBus, telemetry });

  const shutdown = (): void => {
    const report = runner.stop();
    dashboardServer.close();
    console.log("\n=== Soak report ===");
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Same reasoning as run-stub-paper.ts: PaperRunner's own durationMs timer stops the cycle loop
  // but never exits the process on its own (the dashboard's HTTP server keeps the event loop
  // alive), so a bounded soak run needs this to actually terminate.
  if (durationMs !== undefined) {
    setTimeout(shutdown, durationMs + 500);
  }

  console.log(`Starting RISEx paper run for markets: ${enabled.map((m) => m.symbol).join(", ")}`);
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
