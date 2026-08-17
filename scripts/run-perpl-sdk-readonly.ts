/** Testnet-only Perpl SDK snapshot reader. It never enters the engine loop or prepares/sends an order. */
import { resolve } from "node:path";
import { PerplOnchainAdapter } from "../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import { PerplRustClient } from "../src/adapters/perpl/onchain/PerplRustClient.js";

const allowedArgs = new Set(["--bridge", "--rpc"]);
function option(name: "--bridge" | "--rpc", fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--") && !allowedArgs.has(argument)) throw new Error(`Unsupported option ${argument}; signer-related and custom-chain inputs are forbidden`);
}

const bridge = new PerplRustClient(option("--bridge", resolve("rust/perpl-bridge/target/release/riim-perpl-bridge")));
const adapter = new PerplOnchainAdapter(bridge, { rpcUrl: option("--rpc", "https://testnet-rpc.monad.xyz"), markets: [{ symbol: "BTCUSD", perpetualId: 16 }] });
try {
  await adapter.connect();
  console.log(JSON.stringify({ exchangeId: adapter.exchangeId, positions: adapter.getPositions(), openOrders: adapter.getOpenOrders() }, null, 2));
} finally { await adapter.disconnect(); }
