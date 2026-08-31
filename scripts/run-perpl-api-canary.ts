/** One placement, its exact cancellation, then fresh flat reconciliation. No retries. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPerplApiCredentials } from "../src/adapters/perpl/PerplApiCredentials.js";
import { PerplApiExecutionTransport } from "../src/adapters/perpl/PerplApiExecutionTransport.js";
import { PerplCanaryExecutor } from "../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import { PerplOnchainAdapter } from "../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import { PerplRustClient } from "../src/adapters/perpl/onchain/PerplRustClient.js";

const RPC = "https://rpc.monad.xyz";
const ACCOUNT_ID = 5198;
const SIZE = 0.00030;
const MAX_NOTIONAL = 30;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function passiveBtcBuyPrice(bestBid: number): number {
  if (!Number.isFinite(bestBid) || bestBid <= 0) throw new Error("BTC best bid is invalid");
  return Math.floor((bestBid * 0.998) / 0.1) * 0.1;
}

function adapter(): PerplOnchainAdapter {
  return new PerplOnchainAdapter(
    new PerplRustClient(resolve("rust/perpl-bridge/target/release/riim-perpl-bridge")),
    { rpcUrl: RPC, markets: [{ symbol: "BTCUSD", perpetualId: 1 }], accountIds: [ACCOUNT_ID] },
  );
}

async function freshEvidence() {
  const source = adapter();
  try {
    await source.connect();
    return {
      account: source.getAccountEvidence(),
      orders: source.getOpenOrders("BTCUSD"),
      position: source.getPositions("BTCUSD")[0],
      book: source.getBookEvidence("BTCUSD"),
    };
  } finally {
    await source.disconnect();
  }
}

async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--arm=EXECUTE ONE PERPL API CANARY")
    throw new Error("exact API canary arming phrase required");
  const before = await freshEvidence();
  if (before.orders.length || !before.position || before.position.baseSize !== 0 || Number(before.account.lockedBalance) !== 0)
    throw new Error("API canary requires an independently verified flat account with no open BTC orders");
  if (before.account.frozen) throw new Error("API canary account is frozen");
  const price = passiveBtcBuyPrice(before.book.bestBid);
  const notionalUsd = price * SIZE;
  if (notionalUsd > MAX_NOTIONAL) throw new Error("dynamic API canary exceeds the $30 maximum notional");
  const actionBase = BigInt(Date.now()) * 10n;
  const placementActionId = actionBase.toString();
  const cancellationActionId = (actionBase + 1n).toString();
  const credentials = loadPerplApiCredentials();
  const transport = new PerplApiExecutionTransport({ apiKey: credentials.apiKey, apiKeySecret: credentials.apiKeySecret, accountId: ACCOUNT_ID });
  const executor = new PerplCanaryExecutor(transport);
  let placement: Awaited<ReturnType<PerplCanaryExecutor["place"]>> | undefined;
  let cancellation: Awaited<ReturnType<PerplCanaryExecutor["cancel"]>> | undefined;
  try {
    await transport.connect();
    placement = await executor.place({ market: "BTCUSD", side: "buy", price, size: SIZE, postOnly: true, reduceOnly: false, clientActionId: placementActionId, leverage: 15 });
    if (placement.state === "confirmed")
      cancellation = await executor.cancel({ market: "BTCUSD", exchangeOrderId: placement.exchangeOrderId, clientActionId: cancellationActionId });
  } finally {
    transport.close();
  }

  let final = await freshEvidence();
  for (let attempt = 0; attempt < 12 && (final.orders.length || final.position?.baseSize !== 0 || Number(final.account.lockedBalance) !== 0); attempt++) {
    await sleep(5_000);
    final = await freshEvidence();
  }
  const flat = final.orders.length === 0 && final.position?.baseSize === 0 && Number(final.account.lockedBalance) === 0;
  const completedFlat = placement?.state === "confirmed" && cancellation?.state === "confirmed" && flat;
  console.log(JSON.stringify({
    mode: "perpl-api-one-shot-canary", price, size: SIZE, notionalUsd, placementActionId, cancellationActionId,
    placement, cancellation,
    finalEvidence: { openOrders: final.orders, position: final.position, lockedBalance: final.account.lockedBalance },
    finalStatus: completedFlat ? "completed-flat" : "manual-review-required",
  }, null, 2));
  if (!completedFlat) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
