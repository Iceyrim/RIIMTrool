/**
 * LIVE trading runner — connects the real N1Adapter to a real account and places real orders.
 *
 * This is the only script in this project that can ever touch real money. Every other
 * entrypoint (run-paper.ts, run-stub-paper.ts, run-risex-paper.ts) is paper-mode only. Do not
 * add live order placement to any other script — this one exists specifically so "live" is
 * never one flag away from "paper" in the same file.
 *
 * RiseXAdapter is explicitly out of scope here and must never be wired into this script — RISEx
 * has no public testnet, so RiseXAdapter has only ever been fixture-tested (SPEC.md Section 11's
 * live-readiness gate is not met). This script is N1-only.
 *
 * Session realized-PnL is wired to N1RealizedPnlSource (src/adapters/n1/N1RealizedPnlSource.ts),
 * which sums N1's own authoritative getAccountPnl() trading-PnL ledger — replacing the
 * always-zero stub this script used to carry (see CLAUDE.md's now-resolved follow-up item).
 * RiskManager's account-wide session-loss gate is therefore live and
 * functioning: MarketEngine.runCycle() blocks ALL new placement, including reduce-only exits,
 * whenever a PnL drain fails (MarketEngine.markSessionPnlUnavailable()) rather than silently
 * treating a broken feed as "$0 realized this cycle." Excludes settledFundingPnl, matching
 * paper-mode semantics — see N1RealizedPnlSource's class doc comment.
 *
 * Usage (once .env has real values and you have deliberately decided to run live):
 *   date -u +%F > state/live/ARMED                         # same-day intent, single-use
 *   node --env-file=.env $(npm bin)/tsx scripts/run-live.ts --i-understand-this-places-real-orders
 *
 * Startup sequence (every stage fails toward a clean nonzero exit — see each stage's comment):
 *   0. CLI flag check
 *   1. Arm-file check (state/live/ARMED, today's UTC date, single-use)
 *   2. Env var validation (N1_WEB_SERVER_URL, N1_APP_ADDR, N1_PRIVATE_KEY, ...)
 *   3. Config load (enabled n1 markets only)
 *   4. Construct N1Adapter (no network yet)
 *   5. adapter.connect() (real network — the only stage that talks to N1 before confirmation)
 *   6. Construct + initialize() N1RealizedPnlSource (real network — live PnL probe; establishes
 *      or loads the persisted session anchor at state/live/pnl-session-anchor.json)
 *   7. Pre-flight snapshot print (positions/balances/margin/risk limits/PnL source status)
 *   8. Human confirmation gate (typed phrase, real TTY required)
 *   9. Alerting (mode label "LIVE")
 *  10. Construct MarketEngines against the real adapter, state under state/live/
 *  11. Dashboard (127.0.0.1 only)
 *  12. PaperRunner (unmodified orchestrator — exchange-agnostic despite its name)
 *  13. Signal handlers
 *  14. Banner + runner.start() — the only call that begins live order placement
 *
 * No timer or order-placing loop starts before stage 8 succeeds. If any stage 0-7 throws
 * (including N1RealizedPnlSource.initialize() at stage 6), the process exits nonzero and stage
 * 8's confirmation prompt is never reached.
 *
 * Env vars:
 *   N1_WEB_SERVER_URL, N1_APP_ADDR   — required, see .env.example.
 *   N1_PRIVATE_KEY                   — required. Read once, passed directly into N1Adapter's
 *                                      config, never logged, never included in any alert.
 *   SOLANA_RPC_URL                   — default: https://api.mainnet-beta.solana.com
 *   MARKETS_CONFIG_PATH              — default: config/markets.yaml
 *   LIVE_CYCLE_INTERVAL_MS           — default: 5000
 *   LIVE_DURATION_MS                 — default: unset (runs until Ctrl-C)
 *   DASHBOARD_PORT                   — default: 4300. Status-only HTTP server, 127.0.0.1 only.
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — optional. Alerts tagged "[LIVE]" — never "[N1]" or
 *                                      any paper-mode tag, so LIVE vs PAPER is never ambiguous
 *                                      in a shared chat.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { N1Adapter } from "../src/adapters/n1/N1Adapter.js";
import { N1RealizedPnlSource } from "../src/adapters/n1/N1RealizedPnlSource.js";
import { createAlertBusFromEnv } from "../src/alerting/createAlertBusFromEnv.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import type { DashboardMarket } from "../src/dashboard/DashboardService.js";
import { DashboardTelemetry } from "../src/dashboard/DashboardTelemetry.js";
import { DashboardHistoryStore } from "../src/dashboard/DashboardHistoryStore.js";
import { MarketEngine } from "../src/engine/MarketEngine.js";
import { PaperRunner, type PaperRunnerMarket } from "../src/paperRunner/PaperRunner.js";

export function createLiveShutdownHandler(options: {
  runner: PaperRunner;
  closeDashboard: () => void | Promise<void>;
  exit: (code: number) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): (signal: NodeJS.Signals) => Promise<void> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  let shutdownPromise: Promise<void> | undefined;

  return async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) {
      error(`[LIVE] ${signal} received during shutdown; cleanup is already in progress.`);
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      const result = await options.runner.shutdown();
      await options.closeDashboard();
      log("\n=== [LIVE] Session report ===");
      log(JSON.stringify(result, null, 2));
      if (!result.successful) {
        error("\n!!! [LIVE] CLEANUP INCOMPLETE — MANAGED ORDERS MAY REMAIN OPEN !!!");
        for (const market of result.cleanup.filter((entry) => !entry.successful)) {
          error(`[LIVE] ${market.market}: unresolved managed IDs: ${market.unresolved.join(", ")}`);
        }
      }
      log(
        "\n[LIVE] Positions were NOT flattened. Directly verify every position on the exchange " +
          "and close positions manually where required.",
      );
      log(
        "\n[LIVE] Reminder (SPEC.md Section 9 rule 4): before restarting this or any live " +
          "process, confirm genuinely flat state directly against the exchange — never assume " +
          "it from local files.",
      );
      options.exit(result.successful ? 0 : 1);
    })().catch(async (err: unknown) => {
      error(`\n!!! [LIVE] SHUTDOWN FAILED; CLEANUP MAY BE INCOMPLETE: ${String(err)} !!!`);
      await options.closeDashboard();
      options.exit(1);
    });
    return shutdownPromise;
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. See .env.example for what's needed.`);
  }
  return value;
}

/** STAGE 0 */
function requireCliFlag(): void {
  if (!process.argv.includes("--i-understand-this-places-real-orders")) {
    throw new Error(
      "Refusing to start: missing required flag --i-understand-this-places-real-orders. " +
        "This script places real orders on a real account.",
    );
  }
}

/** STAGE 1 — deliberate, same-day, single-use intent. Consumed (deleted) on read regardless of
 * whether the rest of startup succeeds, so a stale or leftover arm file can never be reused. */
function consumeArmFile(): void {
  const armFilePath = join(process.cwd(), "state", "live", "ARMED");
  if (!existsSync(armFilePath)) {
    throw new Error(
      `Arm file not found at "${armFilePath}". Live trading requires deliberate, same-day ` +
        `intent — run:\n\n  date -u +%F > ${armFilePath}\n\nimmediately before launching this ` +
        `script, then try again.`,
    );
  }
  const contents = readFileSync(armFilePath, "utf-8").trim();
  rmSync(armFilePath); // single-use: consumed now, before we even know if it was valid
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (contents !== todayUtc) {
    throw new Error(
      `Arm file contained "${contents}", expected today's UTC date "${todayUtc}". Live ` +
        `trading NOT armed — the arm file has been consumed; create a fresh one to retry.`,
    );
  }
}

/** STAGE 8 — the human-presence gate. Requires a real TTY (refuses any unattended/scripted
 * launch by construction) and an exact, case-sensitive phrase match. No default, no retry loop:
 * any mismatch aborts the whole process. */
async function requireTypedConfirmation(expectedPhrase: string): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Refusing to arm live trading: stdin is not an interactive TTY. This script must be " +
        "launched from a real terminal by a human present right now — it will never run " +
        "unattended, by design.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\nType exactly: ${expectedPhrase}\n> `);
    if (answer !== expectedPhrase) {
      throw new Error("Confirmation phrase did not match exactly. Live trading NOT armed.");
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  requireCliFlag();
  consumeArmFile();

  const webServerUrl = requiredEnv("N1_WEB_SERVER_URL");
  const appAddr = requiredEnv("N1_APP_ADDR");
  const privateKey = requiredEnv("N1_PRIVATE_KEY"); // never logged, never alerted
  const solanaRpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const intervalMs = Number(process.env.LIVE_CYCLE_INTERVAL_MS ?? "5000");
  const durationMs = process.env.LIVE_DURATION_MS
    ? Number(process.env.LIVE_DURATION_MS)
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

  // STAGE 4/5 — construct + connect. No confirmation has happened yet; this is the first and
  // only network contact with N1 before the human confirms.
  const adapter = new N1Adapter({
    webServerUrl,
    appAddr,
    solanaRpcUrl,
    privateKey,
    markets: enabled.map((m) => ({ symbol: m.symbol, exchangeSymbol: m.exchangeSymbol })),
  });
  await adapter.connect();

  // STAGE 6 — real N1 realized-PnL source. Constructed and probed live now, before any
  // confirmation is requested: RiskManager's sessionLossCapUsd gate is meaningless if session
  // PnL isn't actually being tracked, so a broken/unreachable PnL feed must abort startup here,
  // never degrade into a live run with a silently inert risk cap.
  const pnlAnchorFilePath = join(process.cwd(), "state", "live", "pnl-session-anchor.json");
  const pnlSource = new N1RealizedPnlSource({
    nord: adapter.getNordClient(),
    accountId: adapter.getAccountId(),
    anchorFilePath: pnlAnchorFilePath,
  });
  await pnlSource.initialize(
    enabled.map((m) => ({ symbol: m.symbol, exchangeSymbol: m.exchangeSymbol })),
  );

  // STAGE 7 — pre-flight snapshot, read-only. Printed before any confirmation is requested so
  // the human is deciding from real account state, not from what they assume it is.
  console.log("\n=== [LIVE] Pre-flight account snapshot (N1) ===");
  console.log(`Markets: ${enabled.map((m) => m.symbol).join(", ")}`);
  console.log(`Balances: ${JSON.stringify(adapter.getBalances())}`);
  console.log(`Margin: ${JSON.stringify(adapter.getMarginStatus())}`);
  console.log(
    `Account realized-PnL: live N1 account-wide source initialized OK (anchor: ${pnlAnchorFilePath}); ` +
      `account session loss cap is $${config.accountRisk.sessionLossCapUsd} and will block all new placement, including reduce-only ` +
      "exits, if a PnL drain ever fails mid-session.",
  );
  for (const marketConfig of enabled) {
    const positions = adapter.getPositions(marketConfig.symbol);
    const openOrders = adapter.getOpenOrders(marketConfig.symbol);
    console.log(`Position [${marketConfig.symbol}]: ${JSON.stringify(positions)}`);
    console.log(`Open orders [${marketConfig.symbol}]: ${JSON.stringify(openOrders)}`);
    console.log(
      `Risk limits [${marketConfig.symbol}]: ` +
        `maxOrderSize=${marketConfig.riskLimits.maxOrderSize} ` +
        `maxOrderNotionalUsd=${marketConfig.riskLimits.maxOrderNotionalUsd} ` +
        `maxLongPosition=${marketConfig.riskLimits.maxLongPosition} ` +
        `maxShortPosition=${marketConfig.riskLimits.maxShortPosition} ` +
        `maxOpenOrders=${marketConfig.riskLimits.maxOpenOrders}`,
    );
  }

  // STAGE 8 — the only place this process ever blocks waiting on a human.
  const confirmPhrase = `CONFIRM LIVE ${enabled.map((m) => m.symbol).join(",")}`;
  await requireTypedConfirmation(confirmPhrase);

  // STAGE 9
  const alertBus = createAlertBusFromEnv("LIVE");
  const history = new DashboardHistoryStore(join(process.cwd(), "state", "dashboard"), "n1-live");
  const telemetry = new DashboardTelemetry(adapter, true, 100, history, () => alertBus?.getDeliveryHealth() ?? { enabled: false, attempted: 0, delivered: 0, failed: 0, pending: 0 });

  // STAGE 10 — one shared N1Adapter across every configured market, matching N1's real single
  // cross-margined account (SPEC.md Section 4.3), same as run-paper.ts. pnlSource is likewise
  // one shared N1RealizedPnlSource instance, drained per-market (see its class doc comment).
  const runnerMarkets: PaperRunnerMarket[] = enabled.map((marketConfig) => ({
    market: marketConfig.symbol,
    engine: new MarketEngine(adapter, toEngineMarketConfig(marketConfig), {
      stateFilePath: join(process.cwd(), "state", "live", `orders-${marketConfig.symbol}.json`),
      tradeLogFilePath: join(
        process.cwd(),
        "state",
        "live",
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
    pnlSource,
  }));

  // STAGE 11
  const dashboardMarkets: DashboardMarket[] = runnerMarkets.map(({ market, engine }) => ({
    market,
    engine,
    adapter,
    telemetry,
  }));
  const dashboardPort = Number(process.env.DASHBOARD_PORT ?? "4300");
  const dashboardServer = createDashboardServer(dashboardMarkets, { port: dashboardPort });

  const logFilePath = join(
    process.cwd(),
    "state",
    "live",
    "logs",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );

  // STAGE 12
  const runner = new PaperRunner(runnerMarkets, { intervalMs, durationMs, logFilePath, alertBus, telemetry });

  // STAGE 13
  const shutdown = createLiveShutdownHandler({
    runner,
    closeDashboard: () =>
      new Promise<void>((resolve, reject) =>
        dashboardServer.close((err) => (err ? reject(err) : resolve())),
      ),
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", (signal) => void shutdown(signal));
  process.on("SIGTERM", (signal) => void shutdown(signal));

  // STAGE 14
  console.log(`\n[LIVE] Starting live run for markets: ${enabled.map((m) => m.symbol).join(", ")}`);
  console.log(
    `[LIVE] Cycle interval: ${intervalMs}ms${durationMs ? `, duration: ${durationMs}ms` : " (until Ctrl-C)"}`,
  );
  console.log(`[LIVE] Log file: ${logFilePath}`);
  console.log(`[LIVE] Dashboard: http://127.0.0.1:${dashboardPort}`);
  await runner.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
