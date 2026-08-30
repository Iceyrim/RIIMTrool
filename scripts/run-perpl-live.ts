/** Continuous Perpl mainnet market maker with the same operator lifecycle as scripts/run-live.ts. */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { PerplCanaryExecutor } from "../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import { PerplOnchainAdapter } from "../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import { PerplOperatorSocketTransport } from "../src/adapters/perpl/onchain/PerplOperatorSocketTransport.js";
import { PerplRustClient } from "../src/adapters/perpl/onchain/PerplRustClient.js";
import { createAlertBusFromEnv } from "../src/alerting/createAlertBusFromEnv.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { buildDashboardStatus, type DashboardMarket } from "../src/dashboard/DashboardService.js";
import { DashboardHistoryStore } from "../src/dashboard/DashboardHistoryStore.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import {
  DASHBOARD_SNAPSHOT_DIRECTORY,
  DashboardSnapshotPublisher,
} from "../src/dashboard/DashboardSnapshotSidecar.js";
import { DashboardTelemetry } from "../src/dashboard/DashboardTelemetry.js";
import { MarketEngine } from "../src/engine/MarketEngine.js";
import { PerplEquityPnlSource } from "../src/engine/PerplEquityPnlSource.js";
import { PerplLiveAdapter } from "../src/engine/PerplLiveAdapter.js";
import {
  assertPerplLiveCapacity,
  consumePerplLiveArmFile,
  estimatePerplRestingNotional,
  requirePerplLiveCliFlag,
} from "../src/engine/PerplLiveStartup.js";
import { PerplSessionEquityGuard } from "../src/engine/PerplSessionEquityGuard.js";
import { PaperRunner, type PaperRunnerMarket } from "../src/paperRunner/PaperRunner.js";

const RPC = "https://rpc.monad.xyz";
const ACCOUNT_ID = 5071;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function pendingNonce(address: string): Promise<number> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getTransactionCount",
      params: [address, "pending"],
      id: 1,
    }),
  });
  const payload = (await response.json()) as { result?: string; error?: unknown };
  if (!response.ok || !payload.result)
    throw new Error(`pending nonce unavailable: ${JSON.stringify(payload.error)}`);
  const nonce = Number(BigInt(payload.result));
  if (!Number.isSafeInteger(nonce)) throw new Error("pending nonce is invalid");
  return nonce;
}

async function confirm(phrase: string): Promise<void> {
  if (!process.stdin.isTTY)
    throw new Error("Perpl Live requires a human at an interactive terminal");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if ((await rl.question(`\nType exactly: ${phrase}\n> `)) !== phrase)
      throw new Error("confirmation phrase did not match; Perpl Live NOT started");
  } finally {
    rl.close();
  }
}

async function waitForSocket(path: string, worker: ChildProcess): Promise<void> {
  for (let elapsed = 0; elapsed < 180_000; elapsed += 100) {
    if (existsSync(path)) return;
    if (worker.exitCode !== null)
      throw new Error(`Perpl execution worker exited before readiness (${worker.exitCode})`);
    await sleep(100);
  }
  throw new Error("Perpl execution worker socket readiness timed out");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const preflightOnly = argv.includes("--preflight-only");
  const unknownArgs = argv.filter(
    (argument) =>
      argument !== "--preflight-only" && argument !== "--i-understand-this-places-real-orders",
  );
  if (unknownArgs.length) throw new Error(`Unknown argument: ${unknownArgs[0]}`);
  if (!preflightOnly) requirePerplLiveCliFlag(argv);
  const stateRoot = resolve("state/perpl-live");
  mkdirSync(stateRoot, { recursive: true });
  if (!preflightOnly) consumePerplLiveArmFile(join(stateRoot, "ARMED"));

  const signer = requiredEnv("PERPL_SIGNER_ADDRESS");
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) throw new Error("PERPL_SIGNER_ADDRESS is invalid");
  const configPath =
    process.env.PERPL_MARKETS_CONFIG_PATH ?? resolve("config/markets.perpl-live.yaml");
  const intervalMs = Number(process.env.PERPL_LIVE_CYCLE_INTERVAL_MS ?? "5000");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 60_000)
    throw new Error("PERPL_LIVE_CYCLE_INTERVAL_MS must be 5000..60000");
  const config = loadMarketsConfig(configPath);
  const enabled = config.markets.filter((market) => market.enabled && market.exchange === "perpl");
  if (!enabled.length) throw new Error("No enabled Perpl markets");
  const mappings = enabled.map((market) => ({
    symbol: market.symbol,
    perpetualId: market.symbol === "BTCUSD" ? 1 : market.symbol === "ETHUSD" ? 20 : 0,
  }));
  if (mappings.some((market) => market.perpetualId === 0))
    throw new Error("Perpl Live supports BTCUSD and ETHUSD only");

  // Signer-free preflight. The private key is not opened and the worker does not exist yet.
  const bridge = new PerplRustClient(resolve("rust/perpl-bridge/target/release/riim-perpl-bridge"));
  const readonly = new PerplOnchainAdapter(bridge, {
    rpcUrl: RPC,
    markets: mappings,
    accountIds: [ACCOUNT_ID],
  });
  await readonly.connect();
  const nonce = await pendingNonce(signer);
  const account = readonly.getAccountEvidence();
  const positions = enabled.flatMap((market) => readonly.getPositions(market.symbol));
  const orders = enabled.flatMap((market) => readonly.getOpenOrders(market.symbol));
  const marks = new Map(
    await Promise.all(
      enabled.map(
        async (market) =>
          [market.symbol, (await readonly.getMarketPrice(market.symbol)).mark] as const,
      ),
    ),
  );
  const configuredOpenOrders = enabled.reduce((sum, market) => sum + market.quoteLevels * 2, 0);
  const workerOpenOrderCap = enabled.reduce(
    (sum, market) => sum + market.riskLimits.maxOpenOrders,
    0,
  );
  const estimatedRestingNotional = estimatePerplRestingNotional(enabled, marks);
  const blockers: string[] = [];
  if (positions.some((position) => position.baseSize !== 0))
    blockers.push("startup requires flat configured markets");
  if (orders.length) blockers.push("startup requires no existing configured-market orders");
  try {
    assertPerplLiveCapacity({
      availableBalance: Number(account.availableBalance),
      lockedBalance: Number(account.lockedBalance),
      estimatedRestingNotional,
      configuredOpenOrders,
      workerOpenOrderCap,
    });
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  console.log("\n=== [PERPL LIVE] Pre-flight account snapshot ===");
  console.log(`Markets: ${enabled.map((m) => m.symbol).join(", ")}`);
  console.log(`Balances: ${JSON.stringify(readonly.getBalances())}`);
  console.log(`Account: ${JSON.stringify(account)}`);
  console.log(`Pending nonce: ${nonce}`);
  console.log(`Positions: ${JSON.stringify(positions)}`);
  console.log(`Open orders: ${JSON.stringify(orders)}`);
  console.log(`Configured resting quotes: ${configuredOpenOrders}/${workerOpenOrderCap}`);
  console.log(`Estimated 1x resting notional: $${estimatedRestingNotional.toFixed(2)}`);
  console.log(`Session equity-loss cap: $${config.accountRisk.sessionLossCapUsd}`);
  console.log(`Fill coverage begins at block: ${readonly.getFillCoverageStartBlock()}`);
  for (const market of enabled)
    console.log(
      `Book [${market.symbol}]: ${JSON.stringify(readonly.getBookEvidence(market.symbol))}`,
    );
  console.log(`Preflight status: ${blockers.length ? "BLOCKED" : "READY"}`);
  for (const blocker of blockers) console.log(`Blocker: ${blocker}`);

  if (preflightOnly) {
    await readonly.disconnect();
    console.log(
      "[PERPL LIVE] Read-only preflight complete; no signer was opened and no transaction was submitted.",
    );
    return;
  }
  if (blockers.length) throw new Error("Perpl Live preflight is blocked");

  await confirm(`CONFIRM LIVE PERPL ${enabled.map((m) => m.symbol).join(",")}`);
  const signerKeyFile = requiredEnv("PERPL_SIGNER_KEY_FILE");

  const socketPath = "/tmp/perpl-live.sock";
  if (existsSync(socketPath)) throw new Error(`execution socket already exists: ${socketPath}`);
  const worker = spawn(
    resolve("rust/perpl-bridge/target/release/gated-execution-worker"),
    [
      "--gate=mainnet",
      "--i-accept-mainnet-risk=yes",
      "--execution-mode=live-session",
      `--signer=${signer}`,
      `--signer-key-file=${signerKeyFile}`,
      `--journal-path=${join(stateRoot, "rust-worker.json")}`,
      `--socket-path=${socketPath}`,
      `--chain-nonce=${nonce}`,
      "--gas-limit=1300000",
      "--max-snapshot-lag-blocks=2",
      `--max-open-orders=${workerOpenOrderCap}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let workerOutput = "";
  worker.stdout?.on("data", (chunk) => {
    workerOutput += String(chunk);
  });
  worker.stderr?.on("data", (chunk) => {
    workerOutput += String(chunk);
  });
  await waitForSocket(socketPath, worker);
  const transport = new PerplOperatorSocketTransport(socketPath, 180_000);
  const executor = new PerplCanaryExecutor(transport);
  let runner: PaperRunner | undefined;
  let shuttingDown = false;
  const requestShutdown = (reason: string) => {
    console.error(`[PERPL LIVE] HALT: ${reason}`);
    if (runner && !shuttingDown) void shutdown(reason);
  };
  const liveAdapter = new PerplLiveAdapter(readonly, executor, requestShutdown, true);
  const equityGuard = new PerplSessionEquityGuard(
    join(stateRoot, "equity.json"),
    config.accountRisk.sessionLossCapUsd,
  );
  const pnlSource = new PerplEquityPnlSource(liveAdapter, equityGuard, requestShutdown);
  pnlSource.arm();
  const alertBus = createAlertBusFromEnv("PERPL LIVE");
  const history = new DashboardHistoryStore(resolve("state/dashboard"), "perpl-live");
  const telemetry = new DashboardTelemetry(
    liveAdapter,
    true,
    100,
    history,
    () =>
      alertBus?.getDeliveryHealth() ?? {
        enabled: false,
        attempted: 0,
        delivered: 0,
        failed: 0,
        pending: 0,
      },
  );
  const markets: PaperRunnerMarket[] = enabled.map((market) => ({
    market: market.symbol,
    engine: new MarketEngine(liveAdapter, toEngineMarketConfig(market), {
      stateFilePath: join(stateRoot, `orders-${market.symbol}.json`),
      tradeLogFilePath: join(stateRoot, `trades-${market.symbol}.jsonl`),
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
  const dashboardMarkets: DashboardMarket[] = markets.map(({ market, engine }) => ({
    market,
    engine,
    adapter: liveAdapter,
    telemetry,
  }));
  const dashboardPort = Number(process.env.PERPL_DASHBOARD_PORT ?? "4310");
  const dashboardServer = createDashboardServer(dashboardMarkets, { port: dashboardPort });
  const snapshotPublisher = new DashboardSnapshotPublisher(
    DASHBOARD_SNAPSHOT_DIRECTORY,
    "perpl",
    () => buildDashboardStatus(dashboardMarkets),
  );
  snapshotPublisher.start();
  runner = new PaperRunner(markets, {
    intervalMs,
    logFilePath: join(
      stateRoot,
      "logs",
      `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
    ),
    alertBus,
    telemetry,
  });

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[PERPL LIVE] Shutting down: ${reason}`);
    const result = await runner!.shutdown();
    snapshotPublisher.stop();
    await new Promise<void>((done) => dashboardServer.close(() => done()));
    transport.close();
    await readonly.disconnect();
    await Promise.race([
      new Promise<void>((done) => worker.once("exit", () => done())),
      sleep(10_000),
    ]);
    const finalBridge = new PerplRustClient(
      resolve("rust/perpl-bridge/target/release/riim-perpl-bridge"),
    );
    const finalAdapter = new PerplOnchainAdapter(finalBridge, {
      rpcUrl: RPC,
      markets: mappings,
      accountIds: [ACCOUNT_ID],
    });
    await finalAdapter.connect();
    const finalOrders = enabled.flatMap((market) => finalAdapter.getOpenOrders(market.symbol));
    const finalPositions = enabled.flatMap((market) => finalAdapter.getPositions(market.symbol));
    const finalAccount = finalAdapter.getAccountEvidence();
    const reconciled =
      result.successful &&
      finalOrders.length === 0 &&
      finalPositions.every((position) => position.baseSize === 0) &&
      Number(finalAccount.lockedBalance) === 0;
    await finalAdapter.disconnect();
    if (reconciled) equityGuard.manualReset("RESET HALTED PERPL EQUITY SESSION");
    console.log(
      JSON.stringify(
        {
          mode: "perpl-live",
          reason,
          cleanup: result.cleanup,
          pendingNonce: await pendingNonce(signer),
          openOrders: finalOrders,
          positions: finalPositions,
          lockedBalance: finalAccount.lockedBalance,
          finalStatus: reconciled ? "completed-flat" : "manual-review-required",
          workerOutput: workerOutput.trim(),
        },
        null,
        2,
      ),
    );
    process.exit(reconciled ? 0 : 1);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  console.log(
    `\n[PERPL LIVE] Starting continuous live run: ${enabled.map((m) => m.symbol).join(", ")}`,
  );
  console.log(`[PERPL LIVE] Dashboard: http://127.0.0.1:${dashboardPort}`);
  console.log(
    `[PERPL LIVE] Press Ctrl-C for mandatory managed-order cleanup and final reconciliation.`,
  );
  await runner.start();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
