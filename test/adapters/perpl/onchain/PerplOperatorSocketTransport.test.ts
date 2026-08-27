import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { PerplCanaryExecutor } from "../../../../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import { PerplOperatorSocketTransport } from "../../../../src/adapters/perpl/onchain/PerplOperatorSocketTransport.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

async function socketServer(
  respond: (value: Record<string, unknown>) => Record<string, unknown> | undefined,
): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "perpl-operator-socket-")), "worker.sock");
  const server = createServer((connection) => {
    createInterface({ input: connection, crlfDelay: Infinity }).on("line", (line) => {
      const response = respond(JSON.parse(line) as Record<string, unknown>);
      if (response) connection.write(`${JSON.stringify(response)}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once("error", reject));
  return path;
}

describe("PerplOperatorSocketTransport", () => {
  it("correlates one local placement without process or wallet inputs", async () => {
    const path = await socketServer((intent) => ({
      version: 1,
      id: intent.id,
      event: "confirmed",
      actionId: intent.actionId,
      exchangeOrderId: "47",
    }));
    const transport = new PerplOperatorSocketTransport(path);
    const executor = new PerplCanaryExecutor(transport);
    await expect(
      executor.place({
        market: "BTCUSD",
        side: "buy",
        price: 77_000,
        size: 0.00018,
        postOnly: true,
        reduceOnly: false,
        clientActionId: "2026082701",
      }),
    ).resolves.toEqual({ state: "confirmed", exchangeOrderId: "47" });
    transport.close();
  });

  it("fails closed on timeout and permits only one pending action", async () => {
    const path = await socketServer(() => undefined);
    const transport = new PerplOperatorSocketTransport(path, 100);
    const executor = new PerplCanaryExecutor(transport);
    const first = executor.place({
      market: "BTCUSD",
      side: "buy",
      price: 77_000,
      size: 0.00018,
      postOnly: true,
      reduceOnly: false,
      clientActionId: "2026082701",
    });
    await expect(
      executor.place({
        market: "BTCUSD",
        side: "buy",
        price: 76_900,
        size: 0.00018,
        postOnly: true,
        reduceOnly: false,
        clientActionId: "2026082702",
      }),
    ).rejects.toThrow(/exactly one pending action/);
    await expect(first).rejects.toThrow(/timed out/);
  });
});
