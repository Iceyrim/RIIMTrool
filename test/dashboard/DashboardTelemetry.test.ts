import { describe, expect, it, vi } from "vitest";
import { DashboardTelemetry } from "../../src/dashboard/DashboardTelemetry.js";
import { FakeExchangeAdapter } from "../engine/fakeAdapter.js";

describe("DashboardTelemetry", () => {
  it("keeps bounded current-session fills and returns immutable copies", () => {
    const telemetry = new DashboardTelemetry(new FakeExchangeAdapter(), false, 1);
    telemetry.recordFill({ timestamp: 1, market: "BTCUSD", side: "buy", size: 1, price: 2, isReduceOnly: false, clientOrderId: "c1", exchangeOrderId: "e1", source: "placement" });
    telemetry.recordFill({ timestamp: 2, market: "ETHUSD", side: "sell", size: 3, price: 4, isReduceOnly: false, clientOrderId: "c2", exchangeOrderId: "e2", source: "reconciliation" });
    const snapshot = telemetry.snapshot(10);
    expect(snapshot.fillsLabel).toBe("current session");
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
});
