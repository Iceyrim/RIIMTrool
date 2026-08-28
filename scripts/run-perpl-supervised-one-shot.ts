import { existsSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface SupervisedOneShotArgs {
  signer: string;
  signerKeyFile: string;
  sessionId: string;
  market: "BTCUSD" | "ETHUSD";
  side: "buy" | "sell";
  price: number;
  size: number;
  placementActionId: string;
  cancellationActionId: string;
  chainNonce: number;
  socketTimeoutMs: number;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((done) => setTimeout(done, milliseconds));

export function parseArgs(argv: string[]): SupervisedOneShotArgs {
  const values = new Map<string, string>();
  const allowed = new Set([
    "arm",
    "signer",
    "signer-key-file",
    "session-id",
    "market",
    "side",
    "price",
    "size",
    "placement-action-id",
    "cancellation-action-id",
    "chain-nonce",
    "socket-timeout-ms",
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
  if (get("arm") !== "EXECUTE REVIEWED PERPL ONE-SHOT")
    throw new Error("exact one-shot arming phrase required");
  const signer = get("signer");
  const sessionId = get("session-id");
  const market = get("market");
  const side = get("side");
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) throw new Error("invalid signer address");
  if (!/^\d{10,20}$/.test(sessionId)) throw new Error("invalid session id");
  if (!/^(BTCUSD|ETHUSD)$/.test(market) || !/^(buy|sell)$/.test(side))
    throw new Error("invalid market or side");
  const price = Number(get("price"));
  const size = Number(get("size"));
  const chainNonce = Number(get("chain-nonce"));
  const socketTimeoutMs = Number(values.get("socket-timeout-ms") ?? "180000");
  if (![price, size].every((value) => Number.isFinite(value) && value > 0) || price * size > 20)
    throw new Error("invalid price, size, or notional");
  if (!Number.isSafeInteger(chainNonce) || chainNonce < 0) throw new Error("invalid chain nonce");
  if (
    !Number.isSafeInteger(socketTimeoutMs) ||
    socketTimeoutMs < 30_000 ||
    socketTimeoutMs > 300_000
  )
    throw new Error("socket timeout must be 30000..300000 milliseconds");
  const placementActionId = get("placement-action-id");
  const cancellationActionId = get("cancellation-action-id");
  if (
    !/^[1-9]\d{0,19}$/.test(placementActionId) ||
    !/^[1-9]\d{0,19}$/.test(cancellationActionId) ||
    placementActionId === cancellationActionId
  )
    throw new Error("invalid action ids");
  return {
    signer,
    signerKeyFile: get("signer-key-file"),
    sessionId,
    market: market as SupervisedOneShotArgs["market"],
    side: side as SupervisedOneShotArgs["side"],
    price,
    size,
    placementActionId,
    cancellationActionId,
    chainNonce,
    socketTimeoutMs,
  };
}

export function buildInvocations(args: SupervisedOneShotArgs) {
  const state = resolve(`state/perpl-reviewed-one-shot/${args.sessionId}`);
  const socket = `/tmp/perpl-reviewed-one-shot-${args.sessionId}.sock`;
  return {
    state,
    socket,
    worker: [
      "rust/perpl-bridge/target/release/gated-execution-worker",
      [
        "--gate=mainnet",
        "--i-accept-mainnet-risk=yes",
        "--execution-mode=single-order",
        `--signer=${args.signer}`,
        `--signer-key-file=${args.signerKeyFile}`,
        `--journal-path=${state}/rust-worker.json`,
        `--socket-path=${socket}`,
        `--chain-nonce=${args.chainNonce}`,
        "--gas-limit=1300000",
        "--max-snapshot-lag-blocks=2",
      ],
    ] as const,
    runner: [
      "./node_modules/.bin/tsx",
      [
        "scripts/run-perpl-reviewed-one-shot.ts",
        "--arm=EXECUTE REVIEWED PERPL ONE-SHOT",
        `--socket-path=${socket}`,
        `--market=${args.market}`,
        `--side=${args.side}`,
        `--price=${args.price}`,
        `--size=${args.size}`,
        `--placement-action-id=${args.placementActionId}`,
        `--cancellation-action-id=${args.cancellationActionId}`,
        `--equity-journal=${state}/equity.json`,
        `--controller-journal=${state}/controller.json`,
        `--socket-timeout-ms=${args.socketTimeoutMs}`,
      ],
    ] as const,
  };
}

async function waitForSocket(path: string, worker: ChildProcess): Promise<void> {
  for (let elapsed = 0; elapsed < 120_000; elapsed += 100) {
    if (existsSync(path)) return;
    if (worker.exitCode !== null)
      throw new Error(`gated worker exited before socket readiness (${worker.exitCode})`);
    await sleep(100);
  }
  throw new Error("gated worker socket readiness timed out");
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("child process exit timed out")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

async function main(): Promise<void> {
  const invocation = buildInvocations(parseArgs(process.argv.slice(2)));
  if (existsSync(invocation.state) || existsSync(invocation.socket))
    throw new Error("one-shot session state or socket already exists; choose a new session id");
  mkdirSync(invocation.state, { recursive: true, mode: 0o700 });
  const worker = spawn(invocation.worker[0], invocation.worker[1], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let workerOutput = "";
  worker.stdout?.on("data", (chunk) => (workerOutput += String(chunk)));
  worker.stderr?.on("data", (chunk) => (workerOutput += String(chunk)));
  try {
    await waitForSocket(invocation.socket, worker);
    const runner = spawn(invocation.runner[0], invocation.runner[1], {
      stdio: "inherit",
      shell: false,
    });
    const runnerCode = await waitForExit(runner, 360_000);
    const workerCode = await waitForExit(worker, 60_000);
    console.log(
      JSON.stringify(
        {
          mode: "supervised-mainnet-one-shot",
          runnerCode,
          workerCode,
          workerOutput: workerOutput.trim(),
        },
        null,
        2,
      ),
    );
    if (runnerCode !== 0 || workerCode !== 0) process.exitCode = 1;
  } finally {
    if (worker.exitCode === null) worker.kill("SIGTERM");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
