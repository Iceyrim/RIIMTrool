/** Bounded, signer-free Perpl mainnet observation and market-making planning. */
import { join, resolve } from "node:path";
import { PerplOnchainAdapter } from "../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import { PerplRustClient } from "../src/adapters/perpl/onchain/PerplRustClient.js";
import { loadMarketsConfig } from "../src/config/loadConfig.js";
import { toEngineMarketConfig } from "../src/config/toEngineMarketConfig.js";
import { MarketMakingDryRun } from "../src/engine/MarketMakingDryRun.js";

const allowedArgs = new Set(["--bridge", "--config", "--cycles", "--interval-ms"]);
function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--") && !allowedArgs.has(argument)) {
    throw new Error(
      `Unsupported option ${argument}; signer, wallet, and custom-RPC inputs are forbidden`,
    );
  }
}

const cycles = Number(option("--cycles", "1"));
const intervalMs = Number(option("--interval-ms", "5000"));
if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 100)
  throw new Error("--cycles must be 1..100");
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60_000)
  throw new Error("--interval-ms must be 1000..60000");

const configPath = option("--config", resolve("config/markets.perpl-mainnet-canary.yaml"));
const markets = loadMarketsConfig(configPath).markets.filter(
  (market) => market.enabled && market.exchange === "perpl",
);
if (!markets.length) throw new Error("Dry-run config has no enabled Perpl markets");
const marketIds: Record<string, number> = { BTCUSD: 1, ETHUSD: 20 };
if (markets.some((market) => marketIds[market.symbol] === undefined))
  throw new Error("Dry-run config contains an unlisted mainnet market");

const bridge = new PerplRustClient(
  option("--bridge", resolve("rust/perpl-bridge/target/release/riim-perpl-bridge")),
);
const adapter = new PerplOnchainAdapter(bridge, {
  rpcUrl: "https://rpc.monad.xyz",
  markets: markets.map((market) => ({
    symbol: market.symbol,
    perpetualId: marketIds[market.symbol]!,
  })),
  accountIds: [5071],
});

try {
  await adapter.connect();
  const planners = markets.map(
    (market) =>
      new MarketMakingDryRun(adapter, toEngineMarketConfig(market), {
        stateFilePath: join(
          process.cwd(),
          "state",
          "perpl-mainnet-dry-run",
          `orders-${market.symbol}.json`,
        ),
        tradeLogFilePath: join(
          process.cwd(),
          "state",
          "perpl-mainnet-dry-run",
          `trades-${market.symbol}.jsonl`,
        ),
      }),
  );
  for (const planner of planners) await planner.start();
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const plans = [];
    for (const planner of planners) plans.push(await planner.planCycle());
    console.log(JSON.stringify({ mode: "mainnet-read-only-dry-run", cycle, plans }, null, 2));
    if (cycle < cycles) await new Promise<void>((done) => setTimeout(done, intervalMs));
  }
} finally {
  await adapter.disconnect();
}
