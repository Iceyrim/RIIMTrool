import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PerplCanaryExecutor,
  type PerplExecutionTransport,
} from "../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import type { PerplExecutionIntent } from "../src/adapters/perpl/onchain/executionProtocol.js";
import { PerplAutomationSessionOrchestrator } from "../src/engine/PerplAutomationSessionOrchestrator.js";
import { PerplMainnetCanaryController } from "../src/engine/PerplMainnetCanaryController.js";
import type { DryRunPlan } from "../src/engine/MarketMakingDryRun.js";
import { rehearsalPlan } from "./run-perpl-execution-rehearsal.js";

export type AutomationRehearsalScenario =
  "healthy_requote" | "safety_cleanup" | "ambiguous_cleanup";

export interface AutomationRehearsalReport {
  mode: "offline-in-memory-automation-rehearsal";
  scenario: AutomationRehearsalScenario;
  actions: Array<"place" | "cancel">;
  steps: Array<{ cycle: number; action: string; controllerState: string; reason?: string }>;
  finalControllerState: string;
  flat: boolean;
}

export async function runPerplAutomationSessionRehearsal(
  scenario: AutomationRehearsalScenario,
): Promise<AutomationRehearsalReport> {
  const calls: PerplExecutionIntent[] = [];
  const transport: PerplExecutionTransport = {
    request: async (intent) => {
      calls.push(intent);
      if (scenario === "ambiguous_cleanup" && intent.action === "cancel") {
        return {
          version: 1,
          id: intent.id,
          event: "ambiguous",
          actionId: intent.actionId,
          reason: "offline receipt timeout",
        };
      }
      return {
        version: 1,
        id: intent.id,
        event: "confirmed",
        actionId: intent.actionId,
        exchangeOrderId: intent.action === "place" ? "47" : intent.exchangeOrderId,
      };
    },
  };
  const controller = new PerplMainnetCanaryController(new PerplCanaryExecutor(transport), {
    market: "BTCUSD",
    journalPath: join(
      mkdtempSync(join(tmpdir(), "perpl-automation-rehearsal-")),
      "controller.json",
    ),
    now: () => 1_000,
  });
  const orchestrator = new PerplAutomationSessionOrchestrator(
    controller,
    "BTCUSD",
    `offline-${scenario}`,
  );
  const plans =
    scenario === "healthy_requote"
      ? [healthyPlan(), healthyPlan(), healthyPlan(), healthyPlan()]
      : [healthyPlan(), haltedPlan(), haltedPlan()];
  const steps: AutomationRehearsalReport["steps"] = [];
  for (const [index, plan] of plans.entries()) {
    const result = await orchestrator.step(plan, index + 1);
    steps.push({
      cycle: result.cycle,
      action: result.action,
      controllerState: result.controller.state,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }
  const finalControllerState = controller.status().state;
  return {
    mode: "offline-in-memory-automation-rehearsal",
    scenario,
    actions: calls.map((call) => call.action),
    steps,
    finalControllerState,
    flat: finalControllerState === "idle" && calls.at(-1)?.action !== "place",
  };
}

function healthyPlan(): DryRunPlan {
  return rehearsalPlan();
}

function haltedPlan(): DryRunPlan {
  return {
    ...rehearsalPlan(),
    sessionEquityGuard: {
      state: "halted",
      healthy: false,
      haltReason: "offline session equity loss limit reached",
    },
    proposals: [],
  };
}

export async function runAllPerplAutomationRehearsals(): Promise<AutomationRehearsalReport[]> {
  return Promise.all(
    (["healthy_requote", "safety_cleanup", "ambiguous_cleanup"] as const).map((scenario) =>
      runPerplAutomationSessionRehearsal(scenario),
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAllPerplAutomationRehearsals()
    .then((reports) => console.log(JSON.stringify({ reports }, null, 2)))
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
