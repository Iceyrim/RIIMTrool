import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DASHBOARD_HISTORY_MAX_BYTES, DashboardHistoryStore } from "../../src/dashboard/DashboardHistoryStore.js";

const fill = (timestamp: number, tradeId = "t1") => ({ timestamp, market: "BTCUSD", side: "buy" as const, size: 1, price: 2, isReduceOnly: false, clientOrderId: "c", exchangeOrderId: "e", tradeId, source: "placement" as const });

describe("DashboardHistoryStore", () => {
  it("persists and deduplicates fills across instances", () => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-history-"));
    const first = new DashboardHistoryStore(root, "N1 PAPER");
    first.recordFill(fill(Date.now()));
    first.recordFill(fill(Date.now()));
    const second = new DashboardHistoryStore(root, "N1 PAPER");
    expect(second.snapshot().history.fills).toHaveLength(1);
    expect(readdirSync(root)).toContain("n1-paper.json");
  });

  it("rejects oversized input before parsing and bounds corrupt archives", () => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-history-"));
    mkdirSync(root, { recursive: true });
    const path = join(root, "stub-paper.json");
    for (let i = 0; i < 5; i++) {
      writeFileSync(path, i === 0 ? Buffer.alloc(DASHBOARD_HISTORY_MAX_BYTES + 1) : "not json");
      const store = new DashboardHistoryStore(root, "stub-paper");
      expect(store.snapshot().status.stale).toBe(true);
    }
    expect(readdirSync(root).filter((name) => name.includes(".corrupt.")).length).toBeLessThanOrEqual(3);
  });

  it("keeps persistence failures in observability state", () => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-history-"));
    writeFileSync(join(root, "blocked"), "file");
    const store = new DashboardHistoryStore(join(root, "blocked"), "n1-live");
    expect(() => store.recordFill(fill(Date.now()))).not.toThrow();
    expect(store.snapshot().status).toMatchObject({ stale: true });
  });

  it("recovers from the bounded last-valid backup", () => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-history-"));
    const store = new DashboardHistoryStore(root, "risex-paper");
    store.recordFill(fill(Date.now(), "first"));
    store.recordFill(fill(Date.now(), "second"));
    writeFileSync(join(root, "risex-paper.json"), "corrupt");
    const recovered = new DashboardHistoryStore(root, "risex-paper").snapshot();
    expect(recovered.history.fills.map((entry) => entry.tradeId)).toContain("first");
    expect(recovered.status).toMatchObject({ stale: true });
    expect(recovered.status.recoveredAt).toBeTypeOf("number");
  });
});
