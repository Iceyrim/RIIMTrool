import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDashboardStatus, type DashboardMarket } from "../../src/dashboard/DashboardService.js";
import { MarketEngine } from "../../src/engine/MarketEngine.js";
import type { EngineMarketConfig } from "../../src/engine/types.js";
import type { NormalizedPosition } from "../../src/adapters/ExchangeAdapter.js";
import { FakeExchangeAdapter } from "./fakeAdapter.js";

const MARKET = "BTCUSD";
const MARK_PRICE = 60_000;

function testConfig(): EngineMarketConfig {
  return {
    symbol: MARKET,
    orderSize: { min: 0.00155, max: 0.00232 },
    spreadBps: { normal: 5, min: 4, max: 7.5 },
    exitSpreadBps: 2.5,
    quoteLevels: 5,
    levelSpacingBps: [2, 3, 4, 7, 10],
    inventoryReductionThresholdBase: 0.003,
    riskLimits: {
      maxLongPosition: 1,
      maxShortPosition: 1,
      maxOrderSize: 1,
      maxOrderNotionalUsd: 1_000_000,
      maxOpenOrders: 999,
    },
    accountSessionLossCapUsd: 1_000_000,
    reduceOnlyExit: { minHoldMs: 45_000, maxHoldMs: 300_000 },
    quoteMinimumLifetimeMs: 2_000,
  };
}

function tempPaths(): { stateFilePath: string; tradeLogFilePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-exposure-provenance-test-"));
  return {
    stateFilePath: join(dir, "orders.json"),
    tradeLogFilePath: join(dir, "trades.jsonl"),
  };
}

async function buildMarket(adapter: FakeExchangeAdapter): Promise<DashboardMarket> {
  const engine = new MarketEngine(adapter, testConfig(), tempPaths());
  await engine.start();
  return { market: MARKET, engine, adapter };
}

/** Deterministic seeded PRNG (mulberry32) — a failing randomized run must be reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Regression coverage for the four exposure-provenance invariants reviewed against tonight's live
 * N1 incident (an unauthenticated exposure-manufacturing bug: local registry state fabricated a
 * phantom position after a restart). The investigation found MarketEngine/RiskManager/
 * DashboardService already derive position/exposure exclusively from `adapter.getPositions()` —
 * never from OrderRegistry or TradeLog — so Reconciliation.ts's fill-replay/vanished-order
 * resolution (checkAgainstExchange -> resolveVanishedOrder, syncFromExchange) has no plumbing into
 * derived exposure at all. These tests assert that separation holds, including under an adversarial
 * randomized sequence of reconciliation activity, so a future change that accidentally wires the
 * registry/trade log into an exposure calculation fails loudly here.
 *
 * `riskManagerInputPosition` below is deliberately the exact expression MarketEngine.runCycle()
 * uses at src/engine/MarketEngine.ts:121 (`adapter.getPositions(market)[0]`) — this test doesn't
 * re-implement that logic, it reads the same value production code reads.
 */
describe("Exposure provenance invariants (ZERO / NONZERO / RECONCILIATION / PROVENANCE)", () => {
  let adapter: FakeExchangeAdapter;
  let market: DashboardMarket;

  beforeEach(async () => {
    adapter = new FakeExchangeAdapter();
    adapter.marketPrices.set(MARKET, { market: MARKET, mark: MARK_PRICE, index: MARK_PRICE });
    market = await buildMarket(adapter);
  });

  function derivedPositionSnapshot() {
    const status = buildDashboardStatus([market]);
    return {
      dashboardPosition: status.markets[0]?.position ?? null,
      totalExposureUsd: status.totalExposureUsd,
      riskManagerInputPosition: adapter.getPositions(MARKET)[0],
    };
  }

  it("ZERO: fill-replay resolving a vanished RESTING order never fabricates exposure when the exchange reports flat", async () => {
    // adapter.positions stays [] for the whole test — this is tonight's incident shape: a local
    // order-lifecycle event resolving while the exchange confirms zero position.
    market.engine.registry.upsert({
      clientOrderId: "c1",
      exchangeOrderId: "e1",
      market: MARKET,
      side: "buy",
      type: "postOnly",
      price: MARK_PRICE,
      size: 0.01,
      filledSize: 0,
      isReduceOnly: false,
      state: "RESTING",
      placedAt: Date.now(),
      updatedAt: Date.now(),
    });
    // The order fills and vanishes from the exchange's open-orders view -> resolveVanishedOrder fires.
    adapter.fillsByOrderId.set("e1", [
      {
        exchangeOrderId: "e1",
        tradeId: "t1",
        market: MARKET,
        side: "buy",
        price: MARK_PRICE,
        size: 0.01,
        timestamp: Date.now(),
      },
    ]);

    for (let i = 0; i < 10; i++) {
      const result = await market.engine.reconciliation.checkAgainstExchange();
      expect(result.healthy).toBe(true); // resolved via fill-replay, not left as an anomaly
      const snap = derivedPositionSnapshot();
      expect(snap.dashboardPosition).toBeNull();
      expect(snap.totalExposureUsd).toBe(0);
      expect(snap.riskManagerInputPosition).toBeUndefined();
    }
    // Confirm the fill really was recognized (registry + trade log) — it just must not leak into exposure.
    expect(market.engine.registry.get("c1")?.state).toBe("FILLED");
  });

  it("NONZERO: derived exposure exactly matches the exchange snapshot and never drifts across many reconciliation cycles", async () => {
    adapter.positions.push({
      market: MARKET,
      baseSize: 0.01,
      markPrice: MARK_PRICE,
      unrealizedPnl: 3,
      openOrderCount: 0,
    });
    const expectedNotional = 0.01 * MARK_PRICE;

    for (let i = 0; i < 20; i++) {
      // Interleave healthy cycles with anomaly-producing surprise orders — none of which touch
      // adapter.positions.
      if (i % 3 === 0) {
        adapter.openOrders.push({
          exchangeOrderId: `surprise-${i}`,
          market: MARKET,
          side: "buy",
          price: MARK_PRICE,
          size: 0.001,
          filledSize: 0,
          remainingSize: 0.001,
          isReduceOnly: false,
          state: "open",
        });
      }
      await market.engine.reconciliation.checkAgainstExchange();
      const snap = derivedPositionSnapshot();
      expect(snap.riskManagerInputPosition?.baseSize).toBe(0.01);
      expect(snap.dashboardPosition?.notionalUsd).toBeCloseTo(expectedNotional);
      expect(snap.totalExposureUsd).toBeCloseTo(expectedNotional);
    }
  });

  it("RECONCILIATION: checkAgainstExchange() never increases derived exposure beyond the exchange-confirmed value, even mid-resolution", async () => {
    // Exchange confirms a small position; a separate resting order resolves via fill-replay into
    // FILLED in the same cycle. If fill-replay incorrectly fed into exposure (the old-system bug
    // shape), this fill would double-count instead of already being reflected once in
    // adapter.positions.
    adapter.positions.push({
      market: MARKET,
      baseSize: 0.01,
      markPrice: MARK_PRICE,
      unrealizedPnl: 0,
      openOrderCount: 0,
    });
    market.engine.registry.upsert({
      clientOrderId: "c2",
      exchangeOrderId: "e2",
      market: MARKET,
      side: "buy",
      type: "postOnly",
      price: MARK_PRICE,
      size: 0.01,
      filledSize: 0,
      isReduceOnly: false,
      state: "RESTING",
      placedAt: Date.now(),
      updatedAt: Date.now(),
    });
    adapter.fillsByOrderId.set("e2", [
      {
        exchangeOrderId: "e2",
        tradeId: "t2",
        market: MARKET,
        side: "buy",
        price: MARK_PRICE,
        size: 0.01,
        timestamp: Date.now(),
      },
    ]);

    const before = derivedPositionSnapshot();
    const result = await market.engine.reconciliation.checkAgainstExchange();
    expect(result.healthy).toBe(true);
    expect(market.engine.registry.get("c2")?.state).toBe("FILLED"); // the fill really was replayed
    const after = derivedPositionSnapshot();

    expect(after.riskManagerInputPosition?.baseSize).toBe(before.riskManagerInputPosition?.baseSize);
    expect(after.totalExposureUsd).toBe(before.totalExposureUsd);
    expect(after.totalExposureUsd).toBeCloseTo(0.01 * MARK_PRICE); // exactly the exchange value, not doubled
  });

  it("PROVENANCE (adversarial): across 300 randomized reconciliation sequences, derived exposure only ever changes when the exchange snapshot itself changes", async () => {
    const rng = mulberry32(20260811);
    let orderCounter = 0;
    // Independently tracked ground truth — mutated ONLY in the "genuine exchange position change"
    // branch below, never by any local-order/reconciliation branch. The test fails if derived
    // exposure ever diverges from this, in either direction.
    let expectedPosition: NormalizedPosition | undefined;

    for (let i = 0; i < 300; i++) {
      const roll = rng();

      if (roll < 0.15) {
        // Genuine exchange position change — the only thing allowed to move derived exposure.
        const baseSize = Math.round((rng() - 0.5) * 2000) / 100_000; // e.g. -0.01..0.01, 5dp
        if (baseSize === 0) {
          adapter.positions = [];
          expectedPosition = undefined;
        } else {
          const p: NormalizedPosition = {
            market: MARKET,
            baseSize,
            markPrice: MARK_PRICE,
            unrealizedPnl: 0,
            openOrderCount: 0,
          };
          adapter.positions = [p];
          expectedPosition = p;
        }
      } else if (roll < 0.4) {
        // A local RESTING order that will vanish WITH real fill evidence -> fill-replay path.
        const id = `o${orderCounter++}`;
        market.engine.registry.upsert({
          clientOrderId: id,
          exchangeOrderId: id,
          market: MARKET,
          side: rng() < 0.5 ? "buy" : "sell",
          type: "postOnly",
          price: MARK_PRICE,
          size: 0.001,
          filledSize: 0,
          isReduceOnly: false,
          state: "RESTING",
          placedAt: Date.now(),
          updatedAt: Date.now(),
        });
        adapter.fillsByOrderId.set(id, [
          {
            exchangeOrderId: id,
            tradeId: `t${id}`,
            market: MARKET,
            side: "buy",
            price: MARK_PRICE,
            size: 0.001,
            timestamp: Date.now(),
          },
        ]);
      } else if (roll < 0.55) {
        // A local RESTING order that vanishes with NO fill evidence -> genuine anomaly, should
        // still leave exposure untouched.
        const id = `a${orderCounter++}`;
        market.engine.registry.upsert({
          clientOrderId: id,
          exchangeOrderId: id,
          market: MARKET,
          side: "buy",
          type: "postOnly",
          price: MARK_PRICE,
          size: 0.001,
          filledSize: 0,
          isReduceOnly: false,
          state: "RESTING",
          placedAt: Date.now(),
          updatedAt: Date.now(),
        });
      } else if (roll < 0.7) {
        // A surprise exchange order with no local record -> EXCHANGE_ORDER_NOT_LOCAL anomaly.
        adapter.openOrders.push({
          exchangeOrderId: `s${orderCounter++}`,
          market: MARKET,
          side: "buy",
          price: MARK_PRICE,
          size: 0.001,
          filledSize: 0,
          remainingSize: 0.001,
          isReduceOnly: false,
          state: "open",
        });
      } else if (roll < 0.85) {
        // Occasionally exercise the startup-sync path too — wholesale reseed, same provenance rule applies.
        await market.engine.reconciliation.syncFromExchange();
      }
      // else: no-op tick, just re-check the invariant against unchanged state.

      await market.engine.reconciliation.checkAgainstExchange();

      const snap = derivedPositionSnapshot();
      expect(snap.riskManagerInputPosition).toEqual(expectedPosition);
      expect(snap.totalExposureUsd).toBeCloseTo(
        Math.abs(expectedPosition?.baseSize ?? 0) * MARK_PRICE,
      );
    }
  });
});
