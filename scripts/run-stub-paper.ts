/**
 * Stub-adapter soak-test runner (SPEC.md Section 10 step 7).
 *
 * Validates the ExchangeAdapter boundary by running a market entirely against StubAdapter
 * (src/adapters/stub/StubAdapter.ts) — a second, independent, deliberately-differently-shaped
 * adapter implementation with no real exchange behind it at all. No network, no .env, no
 * credentials of any kind. Otherwise wires the exact same MarketEngine, PaperRunner,
 * DashboardService/createDashboardServer, and TradeLog code paths as scripts/run-paper.ts — the
 * real test of this step is that none of those needed to change to support a second adapter.
 *
 * Usage:
 *   npx tsx scripts/run-stub-paper.ts
 *
 * Env vars (all optional):
 *   STUB_MARKETS_CONFIG_PATH   — default: config/markets.stub-validation.yaml
 *   STUB_SEED                  — default: 42. Logged at startup; rerun with the same seed to
 *                                 reproduce a run exactly, including every fill and price tick.
 *   PAPER_STARTING_BALANCE_USDC — default: 10000
 *   PAPER_CYCLE_INTERVAL_MS    — default: 1000
 *   PAPER_DURATION_MS          — default: unset (runs until Ctrl-C)
 *   DASHBOARD_PORT             — default: 4100 (distinct from run-paper.ts's 4000, so both can
 *                                 run at once without a port clash)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — optional, see .env.example. Alerts are tagged "[STUB]"
 *                                 so they're distinguishable from run-paper.ts / run-risex-paper.ts
 *                                 in a shared chat. Alerting is disabled (logged once, non-fatal)
 *                                 if either is unset.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StubAdapter } from "../src/adapters/stub/StubAdapter.js";
import { createAlertBusFromEnv } from "../src/alerting/createAlertBusFromEnv.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import type { DashboardMarket } from "../src/dashboard/DashboardService.js";
import { MarketEngine } from "../src/engine/MarketEngine.js";
import { PaperRunner, type PaperRunnerMarket } from "../src/paperRunner/PaperRunner.js";

/** Arbitrary — StubAdapter's market doesn't exist on any real exchange, so there's no real price
 * to seed from. Chosen so configured order sizes/notional limits are in a sane range together. */
const STUB_START_PRICE = 100;

async function main(): Promise<void> {
  const startingBalanceUsdc = Number(process.env.PAPER_STARTING_BALANCE_USDC ?? "10000");
  const intervalMs = Number(process.env.PAPER_CYCLE_INTERVAL_MS ?? "1000");
  const durationMs = process.env.PAPER_DURATION_MS
    ? Number(process.env.PAPER_DURATION_MS)
    : undefined;
  const seed = Number(process.env.STUB_SEED ?? "42");
  const configPath =
    process.env.STUB_MARKETS_CONFIG_PATH ??
    join(process.cwd(), "config", "markets.stub-validation.yaml");

  if (!existsSync(configPath)) {
    throw new Error(
      `No markets config found at "${configPath}". See config/markets.stub-validation.yaml.`,
    );
  }

  const config = loadMarketsConfig(configPath);
  const enabled = config.markets.filter((m) => m.enabled && m.exchange === "stub");
  if (enabled.length === 0) {
    throw new Error(`No enabled stub markets found in "${configPath}".`);
  }

  // ONE shared StubAdapter across every configured stub market — same SPEC.md Section 4.3
  // shared-cross-margin-account reasoning as run-paper.ts's shared N1PaperAdapter.
  const stubAdapter = new StubAdapter({
    markets: enabled.map((m) => ({ symbol: m.symbol, startPrice: STUB_START_PRICE })),
    startingBalanceUsdc,
    seed,
  });
  await stubAdapter.connect();

  const alertBus = createAlertBusFromEnv("STUB");

  const runnerMarkets: PaperRunnerMarket[] = enabled.map((marketConfig) => ({
    market: marketConfig.symbol,
    engine: new MarketEngine(stubAdapter, toEngineMarketConfig(marketConfig), {
      stateFilePath: join(process.cwd(), "state", "stub", `orders-${marketConfig.symbol}.json`),
      tradeLogFilePath: join(
        process.cwd(),
        "state",
        "stub",
        `trades-${marketConfig.symbol}.jsonl`,
      ),
      onFillRecorded: (entry) =>
        alertBus?.emit({
          type: "fill",
          market: entry.market,
          side: entry.side,
          size: entry.size,
          price: entry.price,
          isReduceOnly: entry.isReduceOnly,
        }),
    }),
    pnlSource: stubAdapter,
  }));

  const dashboardMarkets: DashboardMarket[] = runnerMarkets.map(({ market, engine }) => ({
    market,
    engine,
    adapter: stubAdapter,
  }));
  const dashboardPort = Number(process.env.DASHBOARD_PORT ?? "4100");
  const dashboardServer = createDashboardServer(dashboardMarkets, { port: dashboardPort });

  const logFilePath = join(
    process.cwd(),
    "state",
    "stub",
    "logs",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );

  const runner = new PaperRunner(runnerMarkets, { intervalMs, durationMs, logFilePath, alertBus });

  const shutdown = (): void => {
    const report = runner.stop();
    dashboardServer.close();
    console.log("\n=== Soak report ===");
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // PaperRunner's own durationMs timer stops the cycle loop but never exits the process — the
  // dashboard's HTTP server keeps the event loop alive regardless (same in run-paper.ts; not
  // something to fix there, since PaperRunner.ts must stay unmodified for this step). Mirror the
  // same shutdown here so a bounded stub-paper soak run actually terminates on its own.
  if (durationMs !== undefined) {
    setTimeout(shutdown, durationMs + 500);
  }

  console.log(`Starting STUB paper run for markets: ${enabled.map((m) => m.symbol).join(", ")}`);
  console.log(`Seed: ${seed} (rerun with STUB_SEED=${seed} to reproduce exactly)`);
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
