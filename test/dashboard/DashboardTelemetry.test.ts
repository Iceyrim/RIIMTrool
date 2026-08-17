import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ExchangeAdapter } from "../../src/adapters/ExchangeAdapter.js";
import { DashboardTelemetry } from "../../src/dashboard/DashboardTelemetry.js";
import { DashboardHistoryStore } from "../../src/dashboard/DashboardHistoryStore.js";
import { FakeExchangeAdapter } from "../engine/fakeAdapter.js";

describe("DashboardTelemetry", () => {
  it("keeps bounded current-session fills and returns immutable copies", () => {
    const telemetry = new DashboardTelemetry(new FakeExchangeAdapter(), false, 1);
    telemetry.recordFill({ timestamp: 1, market: "BTCUSD", side: "buy", size: 1, price: 2, isReduceOnly: false, clientOrderId: "c1", exchangeOrderId: "e1", source: "placement" });
    telemetry.recordFill({ timestamp: 2, market: "ETHUSD", side: "sell", size: 3, price: 4, isReduceOnly: false, clientOrderId: "c2", exchangeOrderId: "e2", source: "reconciliation" });
    const snapshot = telemetry.snapshot(10);
    expect(snapshot.fillsLabel).toBe("current session + durable history");
    expect(snapshot.fills).toHaveLength(1);
    expect(snapshot.fills[0]?.market).toBe("ETHUSD");
    expect(Object.isFrozen(snapshot.fills)).toBe(true);
    expect(snapshot.volumes.allTime.available).toBe(false);
  });

  it("publishes uptime and starts volume refresh without awaiting it", async () => {
    const adapter = new FakeExchangeAdapter();
    const pending = new Promise<never>(() => undefined);
    vi.spyOn(adapter, "getAccountVolume").mockReturnValue(pending);
    const telemetry = new DashboardTelemetry(adapter, false);
    telemetry.markStarted(100);
    telemetry.refreshIfDue(200);
    expect(telemetry.snapshot(350).uptimeMs).toBe(250);
    expect(adapter.getAccountVolume).toHaveBeenCalledTimes(3);
  });

  it("caches successful windows and suppresses refreshes for five minutes", async () => {
    const adapter = new FakeExchangeAdapter();
    vi.spyOn(adapter, "getAccountVolume").mockResolvedValue([{ market: "BTCUSD", since: "s", until: "u", baseVolume: 1, quoteVolume: 2 }]);
    const telemetry = new DashboardTelemetry(adapter, true);
    telemetry.refreshIfDue(1_000_000);
    await vi.waitFor(() => expect(telemetry.snapshot().volumes["24h"].available).toBe(true));
    expect(adapter.getAccountVolume).toHaveBeenCalledTimes(4);
    telemetry.refreshIfDue(1_000_000 + 299_999);
    expect(adapter.getAccountVolume).toHaveBeenCalledTimes(4);
  });

  it("requests the exact account-wide time windows from N1 telemetry", async () => {
    const adapter: ExchangeAdapter = new FakeExchangeAdapter();
    const read = vi.spyOn(adapter, "getAccountVolume").mockResolvedValue([]);
    const telemetry = new DashboardTelemetry(adapter, true);
    const now = Date.parse("2026-08-16T12:00:00.000Z");

    telemetry.refreshIfDue(now);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));

    expect(read.mock.calls.map(([params]) => params)).toEqual([
      { since: "2026-08-15T12:00:00.000Z", until: "2026-08-16T12:00:00.000Z" },
      { since: "2026-08-09T12:00:00.000Z", until: "2026-08-16T12:00:00.000Z" },
      { since: "2026-07-17T12:00:00.000Z", until: "2026-08-16T12:00:00.000Z" },
      { since: "1970-01-01T00:00:00.000Z", until: "2026-08-16T12:00:00.000Z" },
    ]);
  });

  it("marks locally derived totals partial until cursor backfill completes", async () => {
    const adapter = new FakeExchangeAdapter();
    const pages = [
      { trades: [{ tradeId: "t1", exchangeOrderId: "o1", market: "BTCUSD", side: "buy" as const, size: 1, price: 10, timestamp: 1 }], nextCursor: "next" },
      { trades: [], nextCursor: undefined },
    ];
    (adapter as ExchangeAdapter).getAccountTradeHistoryPage = vi.fn(async () => pages.shift()!);
    const telemetry = new DashboardTelemetry(adapter, true);
    telemetry.refreshIfDue(2_000);
    await vi.waitFor(() => expect(telemetry.snapshot().volumes["24h"].partial).toBe(true));
    telemetry.refreshIfDue(302_000);
    await vi.waitFor(() => expect(telemetry.snapshot().volumes["24h"].partial).toBe(false));
  });

  it("records at most one runner-owned account sample every five minutes", () => {
    const store = new DashboardHistoryStore(mkdtempSync(`${tmpdir()}/riimtrool-telemetry-`), "n1-paper");
    const telemetry = new DashboardTelemetry(new FakeExchangeAdapter(), false, 100, store);

    telemetry.sampleAccountIfDue(1, 1_000_000);
    telemetry.sampleAccountIfDue(2, 1_299_999);
    telemetry.sampleAccountIfDue(3, 1_300_000);

    expect(telemetry.snapshot().history.points).toEqual([
      { timestamp: 1_000_000, realizedPnlUsd: 1, quoteVolume: null },
      { timestamp: 1_300_000, realizedPnlUsd: 3, quoteVolume: null },
    ]);
  });
});
