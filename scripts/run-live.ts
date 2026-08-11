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
 * ============================================================================================
 * KNOWN GAP — session realized-PnL is NOT wired to a real N1 PnL source yet
 * ============================================================================================
 * RiskManager's per-market sessionLossCapUsd gate reads MarketEngine's sessionRealizedPnlUsd,
 * which PaperRunner only ever updates via a market's `RealizedPnlSource.drainRealizedPnlDeltaUsd()`
 * (see src/paperRunner/PaperRunner.ts). N1PaperAdapter implements that by simulating fills
 * locally. N1Adapter (the real adapter) has no equivalent today — there is no code anywhere in
 * this repo that derives realized PnL from N1's real account history. Rather than fabricate one
 * under time pressure for this script, LIVE_PNL_SOURCE below is an explicit always-zero stub, so
 * sessionRealizedPnlUsd stays at 0 for the whole run and RiskManager's session loss cap check
 * (`sessionRealizedPnlUsd > -sessionLossCapUsd`) can never trip — it is NOT a functioning safety
 * net for cumulative realized losses in this script yet, even though it looks identical to
 * paper mode's.
 *
 * Every OTHER RiskManager limit is unaffected and fully enforced: per-order size/notional caps,
 * max long/short position, max open orders, and the account-wide margin-bankruptcy check. Only
 * the cumulative *session realized loss* cap is silently inert.
 *
 * This is printed prominently at startup (STAGE 6, immediately before the confirmation prompt)
 * and sent as a one-time alert. Auditing sessionRealizedPnlUsd's accumulation path and wiring a
 * real N1 PnL source is a HARD PREREQUISITE before this script is used for real live trading —
 * not a background follow-up item. See CLAUDE.md's follow-up list.
 * ============================================================================================
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
 *   6. Pre-flight snapshot print (positions/balances/margin/risk limits) + PnL-gap warning
 *   7. Human confirmation gate (typed phrase, real TTY required)
 *   8. Alerting (mode label "LIVE") + one-time PnL-gap alert
 *   9. Construct MarketEngines against the real adapter, state under state/live/
 *  10. Dashboard (127.0.0.1 only)
 *  11. PaperRunner (unmodified orchestrator — exchange-agnostic despite its name)
 *  12. Signal handlers
 *  13. Banner + runner.start() — the only call that begins live order placement
 *
 * No timer or order-placing loop starts before stage 7 succeeds. If any stage 0-6 throws, the
 * process exits nonzero and stage 7's prompt is never reached.
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
import { createAlertBusFromEnv } from "../src/alerting/createAlertBusFromEnv.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import type { DashboardMarket } from "../src/dashboard/DashboardService.js";
import { MarketEngine } from "../src/engine/MarketEngine.js";
import { PaperRunner, type PaperRunnerMarket } from "../src/paperRunner/PaperRunner.js";

const PNL_GAP_WARNING =
  "Session realized-PnL is NOT wired to a real N1 PnL source in this script — " +
  "RiskManager's sessionLossCapUsd cap will NOT engage this session, no matter how much " +
  "realized loss actually accrues. Per-order/position/margin limits remain fully active. " +
  "Auditing this is a hard prerequisite before real reliance on the loss cap — see this " +
  "script's header comment and CLAUDE.md's follow-up list.";

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

/** STAGE 7 — the human-presence gate. Requires a real TTY (refuses any unattended/scripted
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

  // STAGE 6 — pre-flight snapshot, read-only. Printed before any confirmation is requested so
  // the human is deciding from real account state, not from what they assume it is.
  console.log("\n=== [LIVE] Pre-flight account snapshot (N1) ===");
  console.log(`Markets: ${enabled.map((m) => m.symbol).join(", ")}`);
  console.log(`Balances: ${JSON.stringify(adapter.getBalances())}`);
  console.log(`Margin: ${JSON.stringify(adapter.getMarginStatus())}`);
  for (const marketConfig of enabled) {
    const positions = adapter.getPositions(marketConfig.symbol);
    console.log(`Position [${marketConfig.symbol}]: ${JSON.stringify(positions)}`);
    console.log(
      `Risk limits [${marketConfig.symbol}]: ` +
        `maxOrderSize=${marketConfig.riskLimits.maxOrderSize} ` +
        `maxOrderNotionalUsd=${marketConfig.riskLimits.maxOrderNotionalUsd} ` +
        `maxLongPosition=${marketConfig.riskLimits.maxLongPosition} ` +
        `maxShortPosition=${marketConfig.riskLimits.maxShortPosition} ` +
        `maxOpenOrders=${marketConfig.riskLimits.maxOpenOrders} ` +
        `sessionLossCapUsd=${marketConfig.sessionLossCapUsd}`,
    );
  }
  console.log("\n=== [LIVE] KNOWN GAP ===");
  console.log(PNL_GAP_WARNING);

  // STAGE 7 — the only place this process ever blocks waiting on a human.
  const confirmPhrase = `CONFIRM LIVE ${enabled.map((m) => m.symbol).join(",")}`;
  await requireTypedConfirmation(confirmPhrase);

  // STAGE 8
  const alertBus = createAlertBusFromEnv("LIVE");
  alertBus?.emit({ type: "error", message: `[startup] ${PNL_GAP_WARNING}` });

  // STAGE 9 — one shared N1Adapter across every configured market, matching N1's real single
  // cross-margined account (SPEC.md Section 4.3), same as run-paper.ts. LIVE_PNL_SOURCE is the
  // always-zero stub documented at the top of this file — see the KNOWN GAP section.
  const LIVE_PNL_SOURCE = { drainRealizedPnlDeltaUsd: () => 0 };

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
    pnlSource: LIVE_PNL_SOURCE,
  }));

  // STAGE 10
  const dashboardMarkets: DashboardMarket[] = runnerMarkets.map(({ market, engine }) => ({
    market,
    engine,
    adapter,
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

  // STAGE 11
  const runner = new PaperRunner(runnerMarkets, { intervalMs, durationMs, logFilePath, alertBus });

  // STAGE 12
  const shutdown = (): void => {
    const report = runner.stop();
    dashboardServer.close();
    console.log("\n=== [LIVE] Session report ===");
    console.log(JSON.stringify(report, null, 2));
    console.log(
      "\n[LIVE] Reminder (SPEC.md Section 9 rule 4): before restarting this or any live " +
        "process, confirm genuinely flat state directly against the exchange — never assume " +
        "it from local files.",
    );
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // STAGE 13
  console.log(`\n[LIVE] Starting live run for markets: ${enabled.map((m) => m.symbol).join(", ")}`);
  console.log(
    `[LIVE] Cycle interval: ${intervalMs}ms${durationMs ? `, duration: ${durationMs}ms` : " (until Ctrl-C)"}`,
  );
  console.log(`[LIVE] Log file: ${logFilePath}`);
  console.log(`[LIVE] Dashboard: http://127.0.0.1:${dashboardPort}`);
  console.log(`[LIVE] ${PNL_GAP_WARNING}`);
  await runner.start();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
