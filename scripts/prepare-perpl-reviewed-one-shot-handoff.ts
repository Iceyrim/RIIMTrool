import { pathToFileURL } from "node:url";

export interface ReviewedHandoffInput {
  signer: string;
  socketPath: string;
  market: "BTCUSD" | "ETHUSD";
  side: "buy" | "sell";
  price: number;
  size: number;
  bestBid: number;
  bestAsk: number;
  placementActionId: string;
  cancellationActionId: string;
  chainNonce: number;
}

export function prepareReviewedHandoff(input: ReviewedHandoffInput) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.signer)) throw new Error("invalid signer address");
  if (!["BTCUSD", "ETHUSD"].includes(input.market) || !["buy", "sell"].includes(input.side))
    throw new Error("invalid market or side");
  if (!input.socketPath.startsWith("/") || /[\0\r\n]/.test(input.socketPath))
    throw new Error("invalid socket path");
  if (
    ![input.price, input.size, input.bestBid, input.bestAsk].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new Error("invalid numeric input");
  if (input.price * input.size > 20) throw new Error("reviewed order exceeds $20");
  if (input.side === "buy" ? input.price >= input.bestBid : input.price <= input.bestAsk)
    throw new Error("reviewed order is not passive");
  if (
    !/^\d+$/.test(input.placementActionId) ||
    !/^\d+$/.test(input.cancellationActionId) ||
    input.placementActionId === input.cancellationActionId
  )
    throw new Error("invalid action ids");
  if (!Number.isSafeInteger(input.chainNonce) || input.chainNonce < 0)
    throw new Error("invalid pending nonce");
  const state = "state/perpl-reviewed-one-shot";
  const worker = [
    "rust/perpl-bridge/target/release/gated-execution-worker",
    "--gate=mainnet",
    "--i-accept-mainnet-risk=yes",
    "--execution-mode=single-order",
    `--signer=${input.signer}`,
    "--signer-key-file=SIGNER_KEY_FILE",
    `--journal-path=${state}/rust-worker.json`,
    `--socket-path=${input.socketPath}`,
    `--chain-nonce=${input.chainNonce}`,
    "--gas-limit=1300000",
    "--max-snapshot-lag-blocks=2",
  ];
  const runner = [
    "./node_modules/.bin/tsx",
    "scripts/run-perpl-reviewed-one-shot.ts",
    "--arm=EXECUTE REVIEWED PERPL ONE-SHOT",
    `--socket-path=${input.socketPath}`,
    `--market=${input.market}`,
    `--side=${input.side}`,
    `--price=${input.price}`,
    `--size=${input.size}`,
    `--placement-action-id=${input.placementActionId}`,
    `--cancellation-action-id=${input.cancellationActionId}`,
    `--equity-journal=${state}/equity.json`,
    `--controller-journal=${state}/controller.json`,
  ];
  return {
    mode: "operator-review-only",
    executable: false as const,
    review: { ...input, notionalUsd: Number((input.price * input.size).toFixed(12)) },
    terminal1WorkerTemplate: worker.map(shellQuote).join(" "),
    terminal2Runner: runner.map(shellQuote).join(" "),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseCli(argv: string[]): ReviewedHandoffInput {
  const values = new Map<string, string>();
  for (const item of argv) {
    const [key, value] = item.startsWith("--") ? item.slice(2).split(/=(.*)/s, 2) : [];
    if (!key || value === undefined || values.has(key))
      throw new Error(`invalid argument: ${item}`);
    values.set(key, value);
  }
  const get = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`missing --${key}`);
    return value;
  };
  const allowed = [
    "signer",
    "socket-path",
    "market",
    "side",
    "price",
    "size",
    "best-bid",
    "best-ask",
    "placement-action-id",
    "cancellation-action-id",
    "chain-nonce",
  ];
  if ([...values.keys()].some((key) => !allowed.includes(key)))
    throw new Error("unknown handoff argument");
  return {
    signer: get("signer"),
    socketPath: get("socket-path"),
    market: get("market") as ReviewedHandoffInput["market"],
    side: get("side") as ReviewedHandoffInput["side"],
    price: Number(get("price")),
    size: Number(get("size")),
    bestBid: Number(get("best-bid")),
    bestAsk: Number(get("best-ask")),
    placementActionId: get("placement-action-id"),
    cancellationActionId: get("cancellation-action-id"),
    chainNonce: Number(get("chain-nonce")),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(prepareReviewedHandoff(parseCli(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
