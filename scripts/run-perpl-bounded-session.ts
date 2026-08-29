/** Live-capable but explicitly gated, bounded Perpl market-making session. */
import { existsSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PerplCanaryExecutor } from "../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import { PerplOnchainAdapter } from "../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import { PerplOperatorSocketTransport } from "../src/adapters/perpl/onchain/PerplOperatorSocketTransport.js";
import { PerplRustClient } from "../src/adapters/perpl/onchain/PerplRustClient.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { MarketMakingDryRun, type DryRunPlan } from "../src/engine/MarketMakingDryRun.js";
import { PerplAutomationSessionOrchestrator } from "../src/engine/PerplAutomationSessionOrchestrator.js";
import { PerplMainnetCanaryController } from "../src/engine/PerplMainnetCanaryController.js";
import { PerplSessionEquityGuard } from "../src/engine/PerplSessionEquityGuard.js";
import { fetchPendingNonce, type FinalEvidence } from "./run-perpl-supervised-one-shot.js";

export interface BoundedSessionArgs {
  signer: string;
  signerKeyFile: string;
  sessionId: string;
  market: "BTCUSD" | "ETHUSD";
  cycles: number;
  intervalMs: number;
  chainNonce: number;
  maxNotionalUsd: number;
}

const sleep = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));

export function parseBoundedSessionArgs(argv: string[]): BoundedSessionArgs {
  const values = new Map<string, string>();
  const allowed = new Set([
    "arm",
    "signer",
    "signer-key-file",
    "session-id",
    "market",
    "cycles",
    "interval-ms",
    "chain-nonce",
    "max-notional-usd",
  ]);
  for (const item of argv) {
    const [key, value] = item.startsWith("--") ? item.slice(2).split(/=(.*)/s, 2) : [];
    if (!key || value === undefined || !allowed.has(key) || values.has(key))
      throw new Error(`invalid argument: ${item}`);
    values.set(key, value);
  }
  const get = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`missing --${key}`);
    return value;
  };
  if (get("arm") !== "EXECUTE BOUNDED PERPL SESSION")
    throw new Error("exact bounded-session arming phrase required");
  const signer = get("signer");
  const sessionId = get("session-id");
  const market = get("market");
  const cycles = Number(get("cycles"));
  const intervalMs = Number(get("interval-ms"));
  const chainNonce = Number(get("chain-nonce"));
  const maxNotionalUsd = Number(get("max-notional-usd"));
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) throw new Error("invalid signer address");
  if (!/^\d{10,20}$/.test(sessionId)) throw new Error("invalid session id");
  if (!/^(BTCUSD|ETHUSD)$/.test(market)) throw new Error("invalid market");
  if (!Number.isSafeInteger(cycles) || cycles < 2 || cycles > 20 || cycles % 2 !== 0)
    throw new Error("cycles must be an even value from 2 through 20");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 60_000)
    throw new Error("interval must be 5000..60000 milliseconds");
  if (!Number.isSafeInteger(chainNonce) || chainNonce < 0) throw new Error("invalid chain nonce");
  if (!Number.isFinite(maxNotionalUsd) || maxNotionalUsd <= 0 || maxNotionalUsd > 20)
    throw new Error("max notional must be positive and no more than $20");
  return {
    signer,
    signerKeyFile: get("signer-key-file"),
    sessionId,
    market: market as BoundedSessionArgs["market"],
    cycles,
    intervalMs,
    chainNonce,
    maxNotionalUsd,
  };
}

export function buildBoundedWorkerInvocation(args: BoundedSessionArgs) {
  const state = resolve(`state/perpl-bounded-session/${args.sessionId}`);
  const socket = `/tmp/perpl-bounded-session-${args.sessionId}.sock`;
  return {
    state,
    socket,
    command: "rust/perpl-bridge/target/release/gated-execution-worker",
    argv: [
      "--gate=mainnet",
      "--i-accept-mainnet-risk=yes",
      "--execution-mode=bounded-session",
      `--signer=${args.signer}`,
      `--signer-key-file=${args.signerKeyFile}`,
      `--journal-path=${state}/rust-worker.json`,
      `--socket-path=${socket}`,
      `--chain-nonce=${args.chainNonce}`,
      "--gas-limit=1300000",
      "--max-snapshot-lag-blocks=2",
      `--max-actions=${args.cycles}`,
    ],
  };
}

export function requirePassivePlan(
  plan: DryRunPlan,
  book: { bestBid: number; bestAsk: number },
  maxNotionalUsd: number,
): DryRunPlan {
  return {
    ...plan,
    proposals: plan.proposals.map((proposal) => {
      const passive =
        proposal.side === "buy" ? proposal.price < book.bestBid : proposal.price > book.bestAsk;
      const bounded = proposal.price * proposal.size <= maxNotionalUsd;
      return {
        ...proposal,
        allowed: proposal.allowed && passive && bounded,
        ...(!passive
          ? { blockedReason: "proposal is not passive against the fresh order book" }
          : !bounded
            ? { blockedReason: "proposal exceeds the bounded-session notional limit" }
            : {}),
      };
    }),
  };
}

async function waitForSocket(path: string, worker: ChildProcess): Promise<void> {
  for (let elapsed = 0; elapsed < 120_000; elapsed += 100) {
    if (existsSync(path)) return;
    if (worker.exitCode !== null) throw new Error("bounded worker exited before socket readiness");
    await sleep(100);
  }
  throw new Error("bounded worker socket readiness timed out");
}

function waitForExit(worker: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (worker.exitCode !== null) return Promise.resolve(worker.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("bounded worker exit timed out")), timeoutMs);
    worker.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

async function finalEvidence(args: BoundedSessionArgs): Promise<FinalEvidence> {
  const bridge = new PerplRustClient(resolve("rust/perpl-bridge/target/release/riim-perpl-bridge"));
  const adapter = new PerplOnchainAdapter(bridge, {
    rpcUrl: "https://rpc.monad.xyz",
    markets: [{ symbol: args.market, perpetualId: args.market === "BTCUSD" ? 1 : 20 }],
    accountIds: [5071],
  });
  try {
    await adapter.connect();
    return {
      pendingNonce: await fetchPendingNonce(args.signer),
      openOrderCount: adapter.getOpenOrders(args.market).length,
      positionBaseSize: adapter.getPositions(args.market)[0]?.baseSize ?? Number.NaN,
      lockedBalance: adapter.getAccountEvidence().lockedBalance,
    };
  } finally {
    await adapter.disconnect();
  }
}

async function main(): Promise<void> {
  const args = parseBoundedSessionArgs(process.argv.slice(2));
  const beforeNonce = await fetchPendingNonce(args.signer);
  if (beforeNonce !== args.chainNonce)
    throw new Error(`pending nonce changed: reviewed ${args.chainNonce}, current ${beforeNonce}`);
  const invocation = buildBoundedWorkerInvocation(args);
  if (existsSync(invocation.state) || existsSync(invocation.socket))
    throw new Error("bounded session state or socket already exists; choose a new session id");
  mkdirSync(invocation.state, { recursive: true, mode: 0o700 });
  const worker = spawn(invocation.command, invocation.argv, { stdio: ["ignore", "pipe", "pipe"] });
  let workerOutput = "";
  worker.stdout?.on("data", (chunk) => (workerOutput += String(chunk)));
  worker.stderr?.on("data", (chunk) => (workerOutput += String(chunk)));
  await waitForSocket(invocation.socket, worker);

  const bridge = new PerplRustClient(resolve("rust/perpl-bridge/target/release/riim-perpl-bridge"));
  const perpetualId = args.market === "BTCUSD" ? 1 : 20;
  const adapter = new PerplOnchainAdapter(bridge, {
    rpcUrl: "https://rpc.monad.xyz",
    markets: [{ symbol: args.market, perpetualId }],
    accountIds: [5071],
  });
  const socket = new PerplOperatorSocketTransport(invocation.socket, 180_000);
  const guard = new PerplSessionEquityGuard(join(invocation.state, "equity.json"), 6);
  const controller = new PerplMainnetCanaryController(new PerplCanaryExecutor(socket), {
    market: args.market,
    journalPath: join(invocation.state, "controller.json"),
    maxNotionalUsd: args.maxNotionalUsd,
  });
  const orchestrator = new PerplAutomationSessionOrchestrator(
    controller,
    args.market,
    args.sessionId,
  );
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  let confirmedActions = 0;
  let failure: unknown;
  let workerCode: number | null | undefined;

  try {
    await adapter.connect();
    if (
      adapter.getOpenOrders(args.market).length ||
      adapter.getPositions(args.market)[0]?.baseSize !== 0
    )
      throw new Error("bounded session requires a flat market with zero open orders");
    guard.arm(adapter.getSessionEquityEvidence());
    const marketConfig = loadMarketsConfig(
      resolve("config/markets.perpl-mainnet-canary.yaml"),
    ).markets.find((market) => market.enabled && market.symbol === args.market);
    if (!marketConfig) throw new Error("bounded session market config is unavailable");
    const planner = new MarketMakingDryRun(adapter, toEngineMarketConfig(marketConfig), {
      stateFilePath: join(invocation.state, `orders-${args.market}.json`),
      tradeLogFilePath: join(invocation.state, `trades-${args.market}.jsonl`),
      sessionEquityGuard: guard,
    });
    await planner.start();
    for (let cycle = 1; cycle <= args.cycles && !stopRequested; cycle++) {
      guard.observe(adapter.getSessionEquityEvidence());
      const plan = requirePassivePlan(
        await planner.planCycle(),
        adapter.getBookEvidence(args.market),
        args.maxNotionalUsd,
      );
      const step = await orchestrator.step(plan, cycle);
      if (["placed", "cancelled_for_requote", "cleaned_after_halt"].includes(step.action))
        confirmedActions += 1;
      console.log(JSON.stringify({ mode: "bounded-perpl-session", step }));
      if (step.action === "halted") throw new Error(step.reason ?? "bounded session halted");
      if (cycle < args.cycles && !stopRequested) await sleep(args.intervalMs);
    }
  } catch (error) {
    failure = error;
  } finally {
    const status = controller.status();
    if (status.state === "resting") {
      try {
        await controller.cancelActive(`${args.sessionId}-shutdown-cancel`);
        if (controller.status().state === "idle") confirmedActions += 1;
      } catch (error) {
        failure = failure ?? error;
      }
    }
    socket.close();
    await adapter.disconnect().catch(() => undefined);
    try {
      workerCode = await waitForExit(worker, 15_000);
    } catch (error) {
      failure = failure ?? error;
      if (worker.exitCode === null) worker.kill("SIGTERM");
      workerCode = await waitForExit(worker, 10_000).catch(() => undefined);
    }
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  }

  const evidence = await finalEvidence(args);
  const completedFlat =
    !failure &&
    workerCode === 0 &&
    controller.status().state === "idle" &&
    evidence.openOrderCount === 0 &&
    evidence.positionBaseSize === 0 &&
    Number(evidence.lockedBalance) === 0 &&
    evidence.pendingNonce === beforeNonce + confirmedActions;
  console.log(
    JSON.stringify(
      {
        mode: "bounded-perpl-session-final",
        status: completedFlat ? "completed-flat" : "halted-review-required",
        beforeNonce,
        confirmedActions,
        workerCode,
        evidence,
        controller: controller.status(),
        ...(failure ? { failure: String(failure) } : {}),
        workerOutput: workerOutput.trim(),
      },
      null,
      2,
    ),
  );
  if (!completedFlat) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
