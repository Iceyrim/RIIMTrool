/** Mainnet-only Perpl SDK snapshot reader. It never enters the engine loop or prepares/sends an order. */
import { resolve } from "node:path";
import { PerplOnchainAdapter } from "../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import { PerplRustClient } from "../src/adapters/perpl/onchain/PerplRustClient.js";

const allowedArgs = new Set(["--bridge", "--rpc", "--duration-ms"]);
function option(name: "--bridge" | "--rpc" | "--duration-ms", fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--") && !allowedArgs.has(argument))
    throw new Error(
      `Unsupported option ${argument}; signer-related and custom-chain inputs are forbidden`,
    );
}
const durationMs = Number(option("--duration-ms", "10000"));
if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 60_000)
  throw new Error("--duration-ms must be 1..60000");

const bridge = new PerplRustClient(
  option("--bridge", resolve("rust/perpl-bridge/target/release/riim-perpl-bridge")),
);
const rpcUrl = option("--rpc", "https://rpc.monad.xyz");
if (rpcUrl !== "https://rpc.monad.xyz")
  throw new Error("--rpc must be the pinned Monad mainnet RPC");
const adapter = new PerplOnchainAdapter(bridge, {
  rpcUrl,
  markets: [
    { symbol: "BTCUSD", perpetualId: 1 },
    { symbol: "ETHUSD", perpetualId: 2 },
  ],
  accountIds: [5071],
});
try {
  await adapter.connect();
  console.log(
    JSON.stringify(
      {
        exchangeId: adapter.exchangeId,
        positions: adapter.getPositions(),
        openOrders: adapter.getOpenOrders(),
      },
      null,
      2,
    ),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
} finally {
  await adapter.disconnect();
}
