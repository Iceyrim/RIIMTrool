import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { rehearsalPlan } from "../../scripts/run-perpl-execution-rehearsal.js";
import { PerplCanaryExecutor } from "../../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import { PerplOperatorSocketTransport } from "../../src/adapters/perpl/onchain/PerplOperatorSocketTransport.js";
import { PerplMainnetCanaryController } from "../../src/engine/PerplMainnetCanaryController.js";
import { PerplOneShotCanaryRunner } from "../../src/engine/PerplOneShotCanaryRunner.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

async function setup(cancelEvent: "confirmed" | "ambiguous" = "confirmed") {
  const directory = mkdtempSync(join(tmpdir(), "perpl-one-shot-"));
  const socketPath = join(directory, "worker.sock");
  const actions: string[] = [];
  const server = createServer((connection) => {
    connection.on("error", () => undefined);
    createInterface({ input: connection, crlfDelay: Infinity }).on("line", (line) => {
      const intent = JSON.parse(line) as Record<string, unknown>;
      actions.push(String(intent.action));
      const response =
        intent.action === "cancel" && cancelEvent === "ambiguous"
          ? {
              version: 1,
              id: intent.id,
              event: "ambiguous",
              actionId: intent.actionId,
              reason: "offline timeout",
            }
          : {
              version: 1,
              id: intent.id,
              event: "confirmed",
              actionId: intent.actionId,
              exchangeOrderId: "47",
            };
      connection.write(`${JSON.stringify(response)}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) =>
    server.listen(socketPath, resolve).once("error", reject),
  );
  const transport = new PerplOperatorSocketTransport(socketPath);
  const controller = new PerplMainnetCanaryController(new PerplCanaryExecutor(transport), {
    market: "BTCUSD",
    journalPath: join(directory, "controller.json"),
    now: () => 1_000,
  });
  return {
    actions,
    controller,
    runner: new PerplOneShotCanaryRunner(controller, "BTCUSD"),
    transport,
  };
}

describe("PerplOneShotCanaryRunner", () => {
  it("completes exactly one correlated placement and cancellation", async () => {
    const { actions, runner, transport } = await setup();
    await expect(
      runner.run({
        plan: rehearsalPlan(),
        proposalIndex: 0,
        placementActionId: "2026082701",
        cancellationActionId: "2026082702",
      }),
    ).resolves.toMatchObject({
      state: "completed",
      exchangeOrderId: "47",
      controller: { state: "idle" },
    });
    expect(actions).toEqual(["place", "cancel"]);
    await expect(
      runner.run({
        plan: rehearsalPlan(),
        proposalIndex: 0,
        placementActionId: "3",
        cancellationActionId: "4",
      }),
    ).rejects.toThrow(/already been consumed/);
    transport.close();
  });

  it("halts after one ambiguous cancellation and never retries", async () => {
    const { actions, controller, runner, transport } = await setup("ambiguous");
    await expect(
      runner.run({
        plan: rehearsalPlan(),
        proposalIndex: 0,
        placementActionId: "2026082701",
        cancellationActionId: "2026082702",
      }),
    ).resolves.toMatchObject({ state: "halted", reason: expect.stringContaining("timeout") });
    expect(actions).toEqual(["place", "cancel"]);
    expect(controller.status().state).toBe("halted");
    transport.close();
  });

  it("rejects nonnumeric, matching, or overflowing action ids before the socket", async () => {
    for (const [placementActionId, cancellationActionId] of [
      ["not-numeric", "2"],
      ["2", "2"],
      ["18446744073709551616", "2"],
    ] as const) {
      const { actions, runner, transport } = await setup();
      await expect(
        runner.run({
          plan: rehearsalPlan(),
          proposalIndex: 0,
          placementActionId,
          cancellationActionId,
        }),
      ).rejects.toThrow();
      expect(actions).toEqual([]);
      transport.close();
    }
  });
});
