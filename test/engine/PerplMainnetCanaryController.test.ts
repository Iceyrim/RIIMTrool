import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PerplMainnetCanaryController,
  type CanaryExecutionResult,
  type PerplCanaryExecutor,
} from "../../src/engine/PerplMainnetCanaryController.js";
import type { DryRunPlan } from "../../src/engine/MarketMakingDryRun.js";

class FakeExecutor implements PerplCanaryExecutor {
  placements: unknown[] = [];
  cancellations: unknown[] = [];
  placeResult: CanaryExecutionResult = { state: "confirmed", exchangeOrderId: "47" };
  cancelResult: CanaryExecutionResult = { state: "confirmed", exchangeOrderId: "47" };
  async place(input: unknown): Promise<CanaryExecutionResult> {
    this.placements.push(input);
    return this.placeResult;
  }
  async cancel(input: unknown): Promise<CanaryExecutionResult> {
    this.cancellations.push(input);
    return this.cancelResult;
  }
}

function plan(now = 1_000): DryRunPlan {
  return {
    market: "BTCUSD",
    generatedAt: now,
    reconciliation: {
      market: "BTCUSD",
      healthy: true,
      openOrderCount: 0,
      anomalies: [],
      checkedAt: now,
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
    readinessBlockers: ["execution remains disabled"],
  };
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "perpl-canary-controller-"));
  const executor = new FakeExecutor();
  const journalPath = join(directory, "journal.json");
  const controller = new PerplMainnetCanaryController(executor, {
    market: "BTCUSD",
    journalPath,
    now: () => 1_000,
  });
  return { controller, executor, journalPath };
}

describe("PerplMainnetCanaryController", () => {
  it("journals one post-only placement and requires confirmed cancellation before reuse", async () => {
    const { controller, executor } = setup();
    await controller.placeOne(plan(), 0, "place-1");
    expect(controller.status()).toMatchObject({ state: "resting", exchangeOrderId: "47" });
    expect(executor.placements).toEqual([
      expect.objectContaining({ postOnly: true, clientActionId: "place-1" }),
    ]);
    await expect(controller.placeOne(plan(), 0, "place-2")).rejects.toThrow(/not idle/);
    await controller.cancelActive("cancel-1");
    expect(controller.status().state).toBe("idle");
    expect(executor.cancellations).toEqual([
      expect.objectContaining({ exchangeOrderId: "47", clientActionId: "cancel-1" }),
    ]);
  });

  it.each([
    ["stale plan", { generatedAt: -10_000 }],
    ["unhealthy reconciliation", { reconciliation: { ...plan().reconciliation, healthy: false } }],
    ["frozen account", { accountEvidence: { frozen: true } }],
    ["halted equity guard", { sessionEquityGuard: { state: "halted", healthy: false } }],
    ["existing order", { observedOpenOrders: [{}] }],
    ["over-notional proposal", { proposals: [{ ...plan().proposals[0]!, size: 0.001 }] }],
    ["non-post-only proposal", { proposals: [{ ...plan().proposals[0]!, type: "limit" }] }],
  ])("rejects %s before calling the executor", async (_name, override) => {
    const { controller, executor } = setup();
    await expect(
      controller.placeOne({ ...plan(), ...override } as DryRunPlan, 0, "place-1"),
    ).rejects.toThrow();
    expect(executor.placements).toEqual([]);
  });

  it("halts on ambiguous placement and never retries", async () => {
    const { controller, executor } = setup();
    executor.placeResult = { state: "ambiguous", reason: "receipt timeout" };
    await controller.placeOne(plan(), 0, "place-1");
    expect(controller.status()).toMatchObject({
      state: "halted",
      reason: expect.stringContaining("timeout"),
    });
    await expect(controller.placeOne(plan(), 0, "place-2")).rejects.toThrow(/not idle/);
    expect(executor.placements).toHaveLength(1);
  });

  it("halts when cancellation confirms the wrong order identity", async () => {
    const { controller, executor } = setup();
    await controller.placeOne(plan(), 0, "place-1");
    executor.cancelResult = { state: "confirmed", exchangeOrderId: "99" };
    await controller.cancelActive("cancel-1");
    expect(controller.status()).toMatchObject({
      state: "halted",
      reason: expect.stringContaining("identity"),
    });
  });

  it("halts on restart with any unresolved journal state", () => {
    const directory = mkdtempSync(join(tmpdir(), "perpl-canary-controller-restart-"));
    const journalPath = join(directory, "journal.json");
    writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        state: "resting",
        market: "BTCUSD",
        clientActionId: "place-1",
        exchangeOrderId: "47",
        updatedAt: 900,
      }),
    );
    const controller = new PerplMainnetCanaryController(new FakeExecutor(), {
      market: "BTCUSD",
      journalPath,
      now: () => 1_000,
    });
    expect(controller.status()).toMatchObject({
      state: "halted",
      reason: expect.stringContaining("manual review"),
    });
  });
});
