import { beforeEach, describe, expect, it } from "vitest";
import { StubAdapter } from "../../../src/adapters/stub/StubAdapter.js";
import type { PlaceOrderParams } from "../../../src/adapters/ExchangeAdapter.js";

const MARKET = "STUBUSD";

/** Ticks refreshAccountState() until every resting order for MARKET has resolved (or gives up
 * after a generous cap) — used instead of a fixed tick count so tests don't depend on hand-
 * computing this seed's exact RNG sequence. */
async function tickUntilResolved(adapter: StubAdapter, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks && adapter.getOpenOrders(MARKET).length > 0; i++) {
    await adapter.refreshAccountState();
  }
}

function buyParams(overrides: Partial<PlaceOrderParams> = {}): PlaceOrderParams {
  return {
    market: MARKET,
    side: "buy",
    type: "postOnly",
    size: 1,
    price: 100,
    isReduceOnly: false,
    ...overrides,
  };
}

describe("StubAdapter", () => {
  let adapter: StubAdapter;

  beforeEach(async () => {
    adapter = new StubAdapter({
      markets: [{ symbol: MARKET, startPrice: 100 }],
      startingBalanceUsdc: 10_000,
      seed: 7,
      driftBpsPerTick: 0,
      volBpsPerTick: 0,
      unresolvedChance: 0,
    });
    await adapter.connect();
  });

  it("seeds the starting USDC balance and connects with no external call", () => {
    expect(adapter.getBalances()).toEqual([{ token: "USDC", amount: 10_000 }]);
  });

  it("placeOrder() rejects an unconfigured market", async () => {
    await expect(adapter.placeOrder(buyParams({ market: "NOPE" }))).rejects.toThrow(/unknown market/);
  });

  it("getMarketPrice() returns the configured start price with no index field before any activity", async () => {
    const price = await adapter.getMarketPrice(MARKET);
    expect(price.mark).toBe(100);
    expect(price.index).toBeUndefined();
  });

  it("getOrderFills() throws for an order id that was never placed (diverges from N1PaperAdapter, which returns [])", async () => {
    await expect(adapter.getOrderFills("stub-999", MARKET)).rejects.toThrow(/no such order/);
  });

  it("cancelOrder() throws when the order is not resting (diverges from N1PaperAdapter, which always succeeds)", async () => {
    await expect(adapter.cancelOrder("stub-999", MARKET)).rejects.toThrow(/not resting/);
  });

  it("placeOrder() can report a fill synchronously in its own response (diverges from N1PaperAdapter, which always returns fills: [])", async () => {
    // Static price (vol=0, drift=0) at exactly the order's price means the placement-time
    // advancePrice() call crosses immediately.
    const result = await adapter.placeOrder(buyParams());
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.fills.length).toBeGreaterThan(0);
  });

  it("a resting order eventually fully fills via refreshAccountState() ticks and is removed from open orders", async () => {
    await adapter.placeOrder(buyParams());
    await tickUntilResolved(adapter);

    expect(adapter.getOpenOrders(MARKET)).toHaveLength(0);
    const positions = adapter.getPositions(MARKET);
    expect(positions[0]?.baseSize).toBeCloseTo(1);
  });

  it("UNRESOLVED_NOT_CONFIRMED: with unresolvedChance=1, placeOrder always resolves unconfirmed and creates no order", async () => {
    const alwaysUnresolved = new StubAdapter({
      markets: [{ symbol: MARKET, startPrice: 100 }],
      startingBalanceUsdc: 10_000,
      seed: 7,
      unresolvedChance: 1,
    });
    await alwaysUnresolved.connect();

    const result = await alwaysUnresolved.placeOrder(buyParams());
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("UNRESOLVED_NOT_CONFIRMED");
    expect(alwaysUnresolved.getOpenOrders(MARKET)).toHaveLength(0);
  });

  it("collapses dual long/short internal legs into a signed baseSize and realizes PnL correctly through a full close", async () => {
    await adapter.placeOrder(buyParams({ price: 100, size: 1 }));
    await tickUntilResolved(adapter);
    expect(adapter.getPositions(MARKET)[0]?.baseSize).toBeCloseTo(1);

    // Static mid stays at 100; a resting sell at 95 is already "through" the mid and fills there
    // (at the order's own price, i.e. a loss vs. the 100 entry) — exercises the short/closing leg
    // of applyFillToPosition without needing the price walk to move at all.
    await adapter.placeOrder(buyParams({ side: "sell", price: 95, size: 1 }));
    await tickUntilResolved(adapter);

    expect(adapter.getPositions(MARKET)[0]?.baseSize ?? 0).toBeCloseTo(0);
    expect(adapter.drainRealizedPnlDeltaUsd(MARKET)).toBeCloseTo(-5);
    expect(adapter.drainRealizedPnlDeltaUsd(MARKET)).toBe(0); // drained, resets to zero
  });

  it("is exactly reproducible from the same seed: two independently-run instances produce identical fills, positions, and balances", async () => {
    const config = {
      markets: [{ symbol: MARKET, startPrice: 100 }],
      startingBalanceUsdc: 10_000,
      seed: 1234,
      driftBpsPerTick: 3,
      volBpsPerTick: 40,
      unresolvedChance: 0.3,
    };

    async function runScenario(): Promise<{
      fills: unknown[];
      baseSize: number;
      balance: number;
      placeResults: boolean[];
    }> {
      const a = new StubAdapter(config);
      await a.connect();
      const placeResults: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await a.placeOrder(buyParams({ price: 100 - i, size: 0.5 }));
        placeResults.push(r.success);
      }
      for (let i = 0; i < 10; i++) {
        await a.refreshAccountState();
      }
      const fills = a.getOpenOrders(MARKET).length > 0 ? await a.getOrderFills(a.getOpenOrders(MARKET)[0]!.exchangeOrderId, MARKET) : [];
      return {
        fills,
        baseSize: a.getPositions(MARKET)[0]?.baseSize ?? 0,
        balance: a.getBalances()[0]?.amount ?? 0,
        placeResults,
      };
    }

    const runA = await runScenario();
    const runB = await runScenario();

    expect(runB).toEqual(runA);
  });
});
