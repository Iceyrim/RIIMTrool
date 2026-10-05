import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PerplCanaryExecutor } from "../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import { PerplDisabledExecutionTransport } from "../src/adapters/perpl/onchain/PerplDisabledExecutionTransport.js";

const allowedArgs = new Set(["--worker"]);
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--") && !allowedArgs.has(argument)) {
    throw new Error(`unsupported disabled rehearsal option ${argument}`);
  }
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const binaryPath = option(
  "--worker",
  resolve("rust/perpl-bridge/target/release/disabled-execution-worker"),
);
const journalPath = join(
  mkdtempSync(join(tmpdir(), "perpl-disabled-cross-language-")),
  "journal.json",
);
const placement = {
  market: "BTCUSD",
  side: "buy" as const,
  price: 77_000,
  size: 0.00018,
  postOnly: true as const,
  reduceOnly: false,
};

const firstTransport = new PerplDisabledExecutionTransport(binaryPath, journalPath);
let first;
try {
  first = await new PerplCanaryExecutor(firstTransport).place({
    ...placement,
    clientActionId: "2026082701",
  });
} finally {
  await firstTransport.close();
}

const restartedTransport = new PerplDisabledExecutionTransport(binaryPath, journalPath);
let restarted;
try {
  restarted = await new PerplCanaryExecutor(restartedTransport).place({
    ...placement,
    clientActionId: "2026082702",
  });
} finally {
  await restartedTransport.close();
}

console.log(
  JSON.stringify(
    {
      mode: "disabled-cross-language-rehearsal",
      first,
      restarted,
      transactionCapable: false,
    },
    null,
    2,
  ),
);
