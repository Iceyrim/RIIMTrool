import { describe, expect, it } from "vitest";
import { RiskManager, type RiskCheckContext } from "../../src/engine/RiskManager.js";
import type { ReconciliationResult } from "../../src/engine/Reconciliation.js";
import type { RiskLimitsConfig } from "../../src/engine/types.js";
import { FakeExchangeAdapter } from "./fakeAdapter.js";

const MARKET = "BTCUSD";

const limits: RiskLimitsConfig = {
  maxLongPosition: 0.005,
  maxShortPosition: 0.005,
  maxOrderSize: 0.0025,
  maxOrderNotionalUsd: 160,
  maxOpenOrders: 12,
};

function healthyReconciliation(openOrderCount = 0): ReconciliationResult {
  return { market: MARKET, healthy: true, openOrderCount, anomalies: [], checkedAt: Date.now() };
}

function baseCtx(overrides: Partial<RiskCheckContext> = {}): RiskCheckContext {
  return {
    market: MARKET,
    side: "buy" as const,
    size: 0.001,
    price: 60000,
    limits,
    currentPosition: undefined,
    lastReconciliation: healthyReconciliation(),
    progressiveOpenOrderCount: 0,
    openBuyQuantity: 0,
    openSellQuantity: 0,
    ...overrides,
  };
}

describe("RiskManager.canPlaceOrder", () => {
  it("allows a well-formed order within all limits", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    expect(rm.canPlaceOrder(baseCtx()).allowed).toBe(true);
  });

  it("blocks when reconciliation is degraded, regardless of open-order count", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    const ctx = baseCtx({
      lastReconciliation: {
        market: MARKET,
        healthy: false,
        openOrderCount: 0,
        anomalies: [],
        checkedAt: Date.now(),
      },
    });
    const result = rm.canPlaceOrder(ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/degraded/);
  });

  it("SPEC 6: trusts a HEALTHY reconciliation's open-order count for the capacity check rather than re-deriving it", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    const atCapacity = rm.canPlaceOrder(baseCtx({
      lastReconciliation: healthyReconciliation(12),
      progressiveOpenOrderCount: 12,
    }));
    expect(atCapacity.allowed).toBe(false);
    expect(atCapacity.reason).toMatch(/maxOpenOrders/);

    const underCapacity = rm.canPlaceOrder(
      baseCtx({ lastReconciliation: healthyReconciliation(11), progressiveOpenOrderCount: 11 }),
    );
    expect(underCapacity.allowed).toBe(true);
  });

  it("blocks an order exceeding maxOrderSize", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    const result = rm.canPlaceOrder(baseCtx({ size: 0.01 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/maxOrderSize/);
  });

  it("blocks an order exceeding maxOrderNotionalUsd", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    const result = rm.canPlaceOrder(baseCtx({ size: 0.0025, price: 1_000_000 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/maxOrderNotionalUsd/);
  });

  it("blocks a buy that would push the position past maxLongPosition", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    const result = rm.canPlaceOrder(
      baseCtx({
        size: 0.002,
        currentPosition: {
          market: MARKET,
          baseSize: 0.004,
          markPrice: 60000,
          unrealizedPnl: 0,
          openOrderCount: 1,
        },
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/maxLongPosition/);
  });

  it("blocks a sell that would push the position past maxShortPosition", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    const result = rm.canPlaceOrder(
      baseCtx({
        side: "sell",
        size: 0.002,
        currentPosition: {
          market: MARKET,
          baseSize: -0.004,
          markPrice: 60000,
          unrealizedPnl: 0,
          openOrderCount: 1,
        },
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/maxShortPosition/);
  });

  it("includes resting same-side quantity without netting opposing orders", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    const buy = rm.canPlaceOrder(baseCtx({
      size: 0.001,
      openBuyQuantity: 0.0045,
      openSellQuantity: 100,
    }));
    expect(buy.allowed).toBe(false);
    expect(buy.deniedBy).toBe("aggregateLongExposure");

    const sell = rm.canPlaceOrder(baseCtx({
      side: "sell",
      size: 0.001,
      openSellQuantity: 0.0045,
    }));
    expect(sell.allowed).toBe(false);
    expect(sell.deniedBy).toBe("aggregateShortExposure");
  });

  it("allows exact size, notional, and aggregate exposure boundaries but rejects just-over values", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    expect(rm.canPlaceOrder(baseCtx({ size: 0.0025, price: 64_000 })).allowed).toBe(true);
    expect(rm.canPlaceOrder(baseCtx({ size: 0.002500001 })).deniedBy).toBe("orderSize");
    expect(rm.canPlaceOrder(baseCtx({ size: 0.0025, price: 64_000.01 })).deniedBy).toBe("orderNotional");
    expect(rm.canPlaceOrder(baseCtx({ size: 0.001, openBuyQuantity: 0.004 })).allowed).toBe(true);
    expect(rm.canPlaceOrder(baseCtx({ size: 0.001000001, openBuyQuantity: 0.004 })).deniedBy).toBe("aggregateLongExposure");
  });

  it("blocks placement when dailyLossCapped is set, independent of session PnL", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    const result = rm.canPlaceOrder(baseCtx({ dailyLossCapped: true, dailyLossCapReason: "daily realized loss $5.00 reached cap $5" }));
    expect(result.allowed).toBe(false);
    expect(result.deniedBy).toBe("dailyLoss");
    expect(result.reason).toMatch(/[Dd]aily.*loss cap/);
    expect(result.reason).toMatch(/daily realized loss \$5\.00/);
  });

  it("blocks placement when weeklyLossCapped is set, independent of session PnL", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    const result = rm.canPlaceOrder(baseCtx({ weeklyLossCapped: true }));
    expect(result.allowed).toBe(false);
    expect(result.deniedBy).toBe("weeklyLoss");
    expect(result.reason).toMatch(/[Ww]eekly.*loss cap/);
  });

  it("is unaffected by dailyLossCapped/weeklyLossCapped when both are absent (undefined)", () => {
    const rm = new RiskManager(new FakeExchangeAdapter());
    expect(rm.canPlaceOrder(baseCtx()).allowed).toBe(true);
  });

  it("no longer has any session-realized-PnL-based check: RiskCheckContext has no such field, and an unbounded loss never blocks on its own", () => {
    // There is no account-wide session loss cap in this codebase (see SPEC.md's account-wide
    // PnL policy section) — only dailyLossCapped/weeklyLossCapped (WindowLossCapTracker) can
    // block placement on realized-PnL grounds now.
    const rm = new RiskManager(new FakeExchangeAdapter());
    const ctx = baseCtx();
    expect(ctx).not.toHaveProperty("sessionRealizedPnlUsd");
    expect(ctx).not.toHaveProperty("sessionLossCapUsd");
    expect(rm.canPlaceOrder({ ...ctx, dailyLossCapped: false, weeklyLossCapped: false }).allowed).toBe(true);
  });
});

describe("RiskManager.checkMarginHealth", () => {
  it("blocks only on the exchange's own bankruptcy flag, not a fabricated formula", () => {
    const adapter = new FakeExchangeAdapter();
    const rm = new RiskManager(adapter);
    expect(rm.checkMarginHealth().allowed).toBe(true);

    adapter.marginStatus = { ...adapter.marginStatus, isAtBankruptcyRisk: true };
    const result = rm.checkMarginHealth();
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/bankruptcy/);
  });
});
