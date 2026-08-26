import { pathToFileURL } from "node:url";

export interface CanaryHandoffInput {
  arm: "ARM PERPL ONE-SHOT MAINNET CANARY";
  signer: string;
  signerKeyFile: string;
  market: "BTCUSD" | "ETHUSD";
  side: "buy" | "sell";
  price: number;
  size: number;
  bestBid: number;
  bestAsk: number;
  orderRequestId: string;
  cancelRequestId: string;
  gasLimit: number;
  chainNonce: number;
}

export function preparePerplCanaryHandoff(input: CanaryHandoffInput) {
  if (input.arm !== "ARM PERPL ONE-SHOT MAINNET CANARY") throw new Error("exact arming phrase required");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.signer)) throw new Error("invalid signer address");
  if (!input.signerKeyFile || /[\0\r\n]/.test(input.signerKeyFile)) throw new Error("invalid signer key file path");
  const perpetualId = input.market === "BTCUSD" ? 1 : input.market === "ETHUSD" ? 20 : 0;
  if (!perpetualId) throw new Error("unlisted market");
  if (input.side !== "buy" && input.side !== "sell") throw new Error("invalid side");
  const numeric = [input.price, input.size, input.bestBid, input.bestAsk];
  if (numeric.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("prices and size must be positive finite values");
  if (input.price * input.size > 20) throw new Error("order exceeds the $20 canary ceiling");
  if (input.side === "buy" ? input.price >= input.bestBid : input.price <= input.bestAsk)
    throw new Error("order is not deliberately passive");
  if (!/^\d+$/.test(input.orderRequestId) || !/^\d+$/.test(input.cancelRequestId) || input.orderRequestId === input.cancelRequestId)
    throw new Error("request IDs must be distinct numeric values");
  if (!Number.isSafeInteger(input.gasLimit) || input.gasLimit <= 0 || input.gasLimit > 1_300_000)
    throw new Error("gas limit exceeds the mainnet canary ceiling");
  if (!Number.isSafeInteger(input.chainNonce) || input.chainNonce < 0) throw new Error("invalid pending nonce");
  const argv = [
    "rust/perpl-bridge/target/release/canary",
    "--gate=mainnet", "--i-accept-mainnet-risk=yes", `--signer=${input.signer}`,
    `--signer-key-file=${input.signerKeyFile}`, `--perpetual-id=${perpetualId}`,
    `--side=${input.side}`, `--price=${input.price}`, `--size=${input.size}`, "--leverage=1",
    `--order-request-id=${input.orderRequestId}`, `--cancel-request-id=${input.cancelRequestId}`,
    `--gas-limit=${input.gasLimit}`, `--chain-nonce=${input.chainNonce}`,
  ];
  return { mode: "operator-review-only", executable: false as const, market: input.market, notionalUsd: Number((input.price * input.size).toFixed(12)), argv, command: argv.map(shellQuote).join(" ") };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

function parseCli(args: string[]): CanaryHandoffInput {
  const known = new Set(["arm", "signer", "signer-key-file", "market", "side", "price", "size", "best-bid", "best-ask", "order-request-id", "cancel-request-id", "gas-limit", "chain-nonce"]);
  const values = new Map<string, string>();
  for (const arg of args) {
    const pair = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s, 2) : [];
    if (pair.length !== 2 || !pair[0]) throw new Error(`malformed argument: ${arg}`);
    const [key, value] = pair as [string, string];
    if (!known.has(key)) throw new Error(`unknown argument: --${key}`);
    if (values.has(key)) throw new Error(`duplicate argument: --${key}`);
    values.set(key, value);
  }
  const get = (key: string) => { const value = values.get(key); if (value === undefined) throw new Error(`missing --${key}`); return value; };
  return {
    arm: get("arm") as CanaryHandoffInput["arm"], signer: get("signer"), signerKeyFile: get("signer-key-file"),
    market: get("market") as CanaryHandoffInput["market"], side: get("side") as CanaryHandoffInput["side"],
    price: Number(get("price")), size: Number(get("size")), bestBid: Number(get("best-bid")), bestAsk: Number(get("best-ask")),
    orderRequestId: get("order-request-id"), cancelRequestId: get("cancel-request-id"),
    gasLimit: Number(get("gas-limit")), chainNonce: Number(get("chain-nonce")),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(preparePerplCanaryHandoff(parseCli(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
