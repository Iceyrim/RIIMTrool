import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PerplCanaryExecutor } from "../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import { PerplOnchainAdapter } from "../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import { PerplOperatorSocketTransport } from "../src/adapters/perpl/onchain/PerplOperatorSocketTransport.js";
import { PerplRustClient } from "../src/adapters/perpl/onchain/PerplRustClient.js";
import type { DryRunPlan } from "../src/engine/MarketMakingDryRun.js";
import { PerplMainnetCanaryController } from "../src/engine/PerplMainnetCanaryController.js";
import { PerplOneShotCanaryRunner } from "../src/engine/PerplOneShotCanaryRunner.js";
import { PerplSessionEquityGuard } from "../src/engine/PerplSessionEquityGuard.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const perpetualId = args.market === "BTCUSD" ? 1 : 20;
  const bridge = new PerplRustClient(args.bridge);
  const adapter = new PerplOnchainAdapter(bridge, {
    rpcUrl: "https://rpc.monad.xyz",
    markets: [{ symbol: args.market, perpetualId }],
    accountIds: [5071],
  });
  let socket: PerplOperatorSocketTransport | undefined;

  try {
    await adapter.connect();
    const openOrders = adapter.getOpenOrders();
    const position = adapter.getPositions(args.market)[0];
    const account = adapter.getAccountEvidence();
    const safety = adapter.getPositionSafetyEvidence(args.market)[0];
    const book = adapter.getBookEvidence(args.market);
    if (openOrders.length) throw new Error("reviewed canary requires zero open Perpl orders");
    if (!position || position.baseSize !== 0)
      throw new Error("reviewed canary requires a flat position");
    if (!safety || account.frozen)
      throw new Error("reviewed canary requires unfrozen position safety evidence");
    if (args.side === "buy" ? args.price >= book.bestBid : args.price <= book.bestAsk) {
      throw new Error("reviewed canary price is no longer deliberately passive");
    }
    const notional = args.price * args.size;
    if (!Number.isFinite(notional) || notional <= 0 || notional > 20) {
      throw new Error("reviewed canary exceeds the $20 ceiling");
    }
    const guard = new PerplSessionEquityGuard(args.equityJournal, 6);
    const guardStatus = guard.arm(adapter.getSessionEquityEvidence());
    const now = Date.now();
    const plan: DryRunPlan = {
      market: args.market,
      generatedAt: now,
      reconciliation: {
        market: args.market,
        healthy: true,
        openOrderCount: 0,
        anomalies: [],
        checkedAt: now,
      },
      positionBaseSize: 0,
      markPrice: position.markPrice,
      observedOpenOrders: [],
      balances: adapter.getBalances(),
      accountEvidence: { ...account },
      positionSafetyEvidence: safety,
      sessionEquityGuard: guardStatus,
      fillCoverageStartBlock: adapter.getFillCoverageStartBlock(),
      proposedCancellations: [],
      proposals: [
        {
          side: args.side,
          price: args.price,
          size: args.size,
          type: "postOnly",
          reduceOnly: false,
          allowed: true,
        },
      ],
      executionReady: false,
      readinessBlockers: ["operator-approved one-shot socket execution only"],
    };
    socket = new PerplOperatorSocketTransport(args.socketPath, args.socketTimeoutMs);
    const controller = new PerplMainnetCanaryController(new PerplCanaryExecutor(socket), {
      market: args.market,
      journalPath: args.controllerJournal,
    });
    const report = await new PerplOneShotCanaryRunner(controller, args.market).run({
      plan,
      proposalIndex: 0,
      placementActionId: args.placementActionId,
      cancellationActionId: args.cancellationActionId,
    });
    console.log(
      JSON.stringify(
        { mode: "reviewed-mainnet-one-shot", book, notionalUsd: notional, report },
        null,
        2,
      ),
    );
    if (report.state !== "completed") process.exitCode = 1;
  } finally {
    socket?.close();
    await adapter.disconnect();
  }
}

export function parseArgs(argv: string[]) {
  const known = new Set([
    "arm",
    "socket-path",
    "market",
    "side",
    "price",
    "size",
    "placement-action-id",
    "cancellation-action-id",
    "equity-journal",
    "controller-journal",
    "bridge",
    "socket-timeout-ms",
  ]);
  const values = new Map<string, string>();
  for (const item of argv) {
    const [key, value] = item.startsWith("--") ? item.slice(2).split(/=(.*)/s, 2) : [];
    if (!key || value === undefined || !known.has(key) || values.has(key))
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
  const market = get("market");
  const side = get("side");
  if (!["BTCUSD", "ETHUSD"].includes(market) || !["buy", "sell"].includes(side))
    throw new Error("invalid market or side");
  const price = Number(get("price"));
  const size = Number(get("size"));
  if (![price, size].every((value) => Number.isFinite(value) && value > 0))
    throw new Error("invalid price or size");
  const socketTimeoutMs = Number(values.get("socket-timeout-ms") ?? "180000");
  if (
    !Number.isSafeInteger(socketTimeoutMs) ||
    socketTimeoutMs < 30_000 ||
    socketTimeoutMs > 300_000
  )
    throw new Error("socket timeout must be 30000..300000 milliseconds");
  return {
    socketPath: get("socket-path"),
    market: market as "BTCUSD" | "ETHUSD",
    side: side as "buy" | "sell",
    price,
    size,
    socketTimeoutMs,
    placementActionId: get("placement-action-id"),
    cancellationActionId: get("cancellation-action-id"),
    equityJournal: resolve(get("equity-journal")),
    controllerJournal: resolve(get("controller-journal")),
    bridge: resolve(values.get("bridge") ?? "rust/perpl-bridge/target/release/riim-perpl-bridge"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
