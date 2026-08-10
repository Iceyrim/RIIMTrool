import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderRegistry } from "../../src/engine/OrderRegistry.js";
import type { LocalOrder } from "../../src/engine/types.js";

function makeOrder(overrides: Partial<LocalOrder> = {}): LocalOrder {
  return {
    clientOrderId: "c1",
    exchangeOrderId: "e1",
    market: "BTCUSD",
    side: "buy",
    type: "postOnly",
    price: 60000,
    size: 0.01,
    filledSize: 0,
    isReduceOnly: false,
    state: "RESTING",
    placedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("OrderRegistry", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "riimtrool-registry-test-"));
    filePath = join(dir, "orders-BTCUSD.json");
  });

  it("round-trips state through save() and load() atomically", () => {
    const registry = new OrderRegistry("BTCUSD", filePath);
    registry.upsert(makeOrder());
    registry.save();

    const reloaded = new OrderRegistry("BTCUSD", filePath);
    reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.get("c1")?.exchangeOrderId).toBe("e1");
  });

  it("save() never leaves a .tmp file behind (atomic rename)", () => {
    const registry = new OrderRegistry("BTCUSD", filePath);
    registry.upsert(makeOrder());
    registry.save();
    expect(() => writeFileSync(`${filePath}.tmp`, "", { flag: "wx" })).not.toThrow();
  });

  it("falls back to empty state with a loud warning on a corrupted file, rather than throwing", () => {
    writeFileSync(filePath, "{ this is not valid json [[[", "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const registry = new OrderRegistry("BTCUSD", filePath);
    expect(() => registry.load()).not.toThrow();
    expect(registry.list()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it("falls back to empty state when the file is simply missing", () => {
    const registry = new OrderRegistry("BTCUSD", join(dir, "does-not-exist.json"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.load();
    expect(registry.list()).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("prune() removes only terminal entries older than the threshold", () => {
    const registry = new OrderRegistry("BTCUSD", filePath);
    const now = 1_000_000;
    registry.upsert(
      makeOrder({ clientOrderId: "old-cancelled", state: "CANCELLED", updatedAt: now - 10_000 }),
    );
    registry.upsert(
      makeOrder({ clientOrderId: "recent-cancelled", state: "CANCELLED", updatedAt: now - 100 }),
    );
    registry.upsert(
      makeOrder({ clientOrderId: "old-resting", state: "RESTING", updatedAt: now - 10_000 }),
    );

    const removed = registry.prune(5_000, now);
    expect(removed).toBe(1);
    expect(registry.get("old-cancelled")).toBeUndefined();
    expect(registry.get("recent-cancelled")).toBeDefined();
    expect(registry.get("old-resting")).toBeDefined();
  });

  it("upsert() rejects an order for a different market", () => {
    const registry = new OrderRegistry("BTCUSD", filePath);
    expect(() => registry.upsert(makeOrder({ market: "ETHUSD" }))).toThrow();
  });
});
