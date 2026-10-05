import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PerplCanaryExecutor,
  type PerplExecutionTransport,
} from "../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import type { PerplExecutionIntent } from "../src/adapters/perpl/onchain/executionProtocol.js";
import { PerplMainnetCanaryController } from "../src/engine/PerplMainnetCanaryController.js";
import type { DryRunPlan } from "../src/engine/MarketMakingDryRun.js";

export interface RehearsalOptions {
  placementOutcome?: "confirmed" | "rejected" | "ambiguous";
  cancellationOutcome?: "confirmed" | "rejected" | "ambiguous";
  journalPath?: string;
}

export async function runPerplExecutionRehearsal(options: RehearsalOptions = {}) {
  const calls: PerplExecutionIntent[] = [];
  const transport: PerplExecutionTransport = {
    request: async (intent) => {
      calls.push(intent);
      const event =
        intent.action === "place"
          ? (options.placementOutcome ?? "confirmed")
          : (options.cancellationOutcome ?? "confirmed");
      return event === "confirmed"
        ? { version: 1, id: intent.id, event, actionId: intent.actionId, exchangeOrderId: "47" }
        : {
            version: 1,
            id: intent.id,
            event,
            actionId: intent.actionId,
            reason: `${event} rehearsal outcome`,
          };
    },
  };
  const journalPath =
    options.journalPath ??
    join(mkdtempSync(join(tmpdir(), "perpl-execution-rehearsal-")), "journal.json");
  const controller = new PerplMainnetCanaryController(new PerplCanaryExecutor(transport), {
    market: "BTCUSD",
    journalPath,
    now: () => 1_000,
  });
  const states = [controller.status()];
  await controller.placeOne(rehearsalPlan(), 0, "2026082601");
  states.push(controller.status());
  if (controller.status().state === "resting") {
    await controller.cancelActive("2026082602");
    states.push(controller.status());
  }
  return { mode: "offline-in-memory-rehearsal", calls, states, finalState: controller.status() };
}

export function rehearsalPlan(): DryRunPlan {
  return {
    market: "BTCUSD",
    generatedAt: 1_000,
    reconciliation: {
      market: "BTCUSD",
      healthy: true,
      openOrderCount: 0,
      anomalies: [],
      checkedAt: 1_000,
    },
    positionBaseSize: 0,
    markPrice: 77_000,
    observedOpenOrders: [],
    balances: [{ token: "AUSD", amount: 18 }],
    accountEvidence: { frozen: false },
    sessionEquityGuard: {
      state: "active",
      healthy: true,
      baselineEquity: 18,
      currentEquity: 18,
      sessionChange: 0,
      blockNumber: "100",
    },
    positionSafetyEvidence: {
      baseSize: 0,
      markPrice: 77_000,
      deposit: 0,
      maintenanceRequirement: 0,
      liquidationPrice: 0,
      bankruptcyPrice: 0,
    },
    proposedCancellations: [],
    proposals: [
      {
        side: "buy",
        price: 77_000,
        size: 0.00018,
        type: "postOnly",
        reduceOnly: false,
        allowed: true,
      },
    ],
    executionReady: false,
    readinessBlockers: ["offline rehearsal only"],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPerplExecutionRehearsal()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
