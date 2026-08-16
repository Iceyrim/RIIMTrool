/**
 * Fixture/contract tests for N1Adapter — the authenticated, real-order-placing N1 surface. These
 * mock the `@n1xyz/nord-ts` SDK boundary (Nord/NordUser) and prove the adapter sends/parses what
 * the SDK's own declared types describe. They do NOT prove anything about live N1 behavior under
 * real network/matching conditions — N1Adapter has never been run against a real endpoint (see
 * its class doc comment). This suite exists specifically because scripts/run-live.ts trusts this
 * class with real money; it closes the "no test coverage at all" gap that predated it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Nord, NordUser } from "@n1xyz/nord-ts";

const nordNew = vi.fn();
const nordUserFromPrivateKey = vi.fn();

vi.mock("@n1xyz/nord-ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@n1xyz/nord-ts")>();
  class FakeNord {
    static new = nordNew;
  }
  class FakeNordUser {
    static fromPrivateKey = nordUserFromPrivateKey;
  }
  return {
    ...actual,
    Nord: FakeNord as unknown as typeof actual.Nord,
    NordUser: FakeNordUser as unknown as typeof actual.NordUser,
  };
});

// Imported after vi.mock so N1Adapter picks up the mocked SDK exports above.
const { FillMode, Side } = await import("@n1xyz/nord-ts");
const { MAX_ACCOUNT_TRADE_PAGES_PER_STREAM, N1Adapter } = await import("../../../src/adapters/n1/N1Adapter.js");

const MARKET = "BTCUSD";
const MARKET_ID = 0;
const ACCOUNT_ID = 7;

interface FakeNordInstance {
  markets: { marketId: number; symbol: string }[];
  fetchNordInfo: ReturnType<typeof vi.fn>;
  getOrderTrades: ReturnType<typeof vi.fn>;
  getMarketStats: ReturnType<typeof vi.fn>;
  getAccountVolume: ReturnType<typeof vi.fn>;
  getTrades: ReturnType<typeof vi.fn>;
  getTimestamp: ReturnType<typeof vi.fn>;
}

interface FakeNordUserInstance {
  accountIds?: number[];
  positions: Record<string, unknown[]>;
  orders: Record<string, unknown[]>;
  balances: Record<string, unknown[]>;
  margins: Record<string, unknown>;
  updateAccountId: ReturnType<typeof vi.fn>;
  fetchInfo: ReturnType<typeof vi.fn>;
  placeOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
  refreshSession: ReturnType<typeof vi.fn>;
}

// Arbitrary fixed "now" (server-clock unix seconds) for session-expiry math in tests, and the
// SDK's real default session TTL (30 days) so expiry math below mirrors production behavior.
const FAKE_NOW_SEC = 1_000_000n;
const SESSION_TTL_SEC = 60n * 60n * 24n * 30n;

function makeFakeNord(overrides: Partial<FakeNordInstance> = {}): FakeNordInstance {
  return {
    markets: [{ marketId: MARKET_ID, symbol: "BTCUSDC" }],
    fetchNordInfo: vi.fn().mockResolvedValue(undefined),
    getOrderTrades: vi.fn(),
    getMarketStats: vi.fn(),
    getAccountVolume: vi.fn(),
    getTrades: vi.fn(),
    getTimestamp: vi.fn().mockResolvedValue(FAKE_NOW_SEC),
    ...overrides,
  };
}

function makeFakeNordUser(overrides: Partial<FakeNordUserInstance> = {}): FakeNordUserInstance {
  return {
    accountIds: [ACCOUNT_ID],
    positions: {},
    orders: {},
    balances: {},
    margins: {},
    updateAccountId: vi.fn().mockResolvedValue(undefined),
    fetchInfo: vi.fn().mockResolvedValue(undefined),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    refreshSession: vi.fn().mockResolvedValue({
      sessionId: 123n,
      expiry: FAKE_NOW_SEC + SESSION_TTL_SEC,
      refreshDeadline: undefined,
    }),
    ...overrides,
  };
}

function baseConfig() {
  return {
    webServerUrl: "https://example.invalid",
    appAddr: "app",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    privateKey: "fake-private-key",
    markets: [{ symbol: MARKET, exchangeSymbol: "BTCUSDC" }],
  };
}

describe("N1Adapter", () => {
  let fakeNord: FakeNordInstance;
  let fakeUser: FakeNordUserInstance;

  beforeEach(() => {
    fakeNord = makeFakeNord();
    fakeUser = makeFakeNordUser();
    nordNew.mockReset().mockResolvedValue(fakeNord as unknown as Nord);
    nordUserFromPrivateKey.mockReset().mockReturnValue(fakeUser as unknown as NordUser);
  });

  describe("connect", () => {
    it("resolves markets, derives accountId, establishes a session, and fetches initial account state", async () => {
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      expect(fakeNord.fetchNordInfo).toHaveBeenCalledTimes(1);
      expect(fakeUser.updateAccountId).toHaveBeenCalledTimes(1);
      expect(fakeUser.refreshSession).toHaveBeenCalledTimes(1);
      expect(fakeUser.fetchInfo).toHaveBeenCalledTimes(1);
      // Getters work post-connect, proving accountId was actually captured.
      expect(() => adapter.getPositions()).not.toThrow();
    });

    it("throws and never calls fetchInfo() if the wallet has no accountIds after updateAccountId()", async () => {
      fakeUser.accountIds = [];
      const adapter = new N1Adapter(baseConfig());

      await expect(adapter.connect()).rejects.toThrow(
        /N1 account has no accountIds after updateAccountId/,
      );
      expect(fakeUser.fetchInfo).not.toHaveBeenCalled();
    });

    it("throws if a configured market isn't in N1's live market list", async () => {
      fakeNord.markets = [{ marketId: 99, symbol: "SOMETHING_ELSE" }];
      const adapter = new N1Adapter(baseConfig());

      await expect(adapter.connect()).rejects.toThrow(/no market with symbol "BTCUSDC"/);
    });

    it("throws and never calls fetchInfo() if session establishment fails — must abort startup, never run with an adapter that can read but never place", async () => {
      fakeUser.refreshSession.mockRejectedValue(new Error("wallet signature rejected"));
      const adapter = new N1Adapter(baseConfig());

      await expect(adapter.connect()).rejects.toThrow(/wallet signature rejected/);
      expect(fakeUser.fetchInfo).not.toHaveBeenCalled();
    });
  });

  describe("session renewal", () => {
    it("refreshAccountState() does not re-establish the session when the tracked expiry is far away", async () => {
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      expect(fakeUser.refreshSession).toHaveBeenCalledTimes(1);

      await adapter.refreshAccountState();
      expect(fakeUser.refreshSession).toHaveBeenCalledTimes(1);
    });

    it("refreshAccountState() proactively renews the session once it comes within the safety margin of expiry", async () => {
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      expect(fakeUser.refreshSession).toHaveBeenCalledTimes(1);

      // Advance server time to inside the 1-hour renewal margin of the session established at
      // connect() (FAKE_NOW_SEC + 30-day TTL).
      fakeNord.getTimestamp.mockResolvedValue(FAKE_NOW_SEC + SESSION_TTL_SEC - 60n);
      await adapter.refreshAccountState();

      expect(fakeUser.refreshSession).toHaveBeenCalledTimes(2);
    });

    it("placeOrder() also proactively renews an about-to-expire session (defense in depth, independent of refreshAccountState)", async () => {
      fakeUser.placeOrder.mockResolvedValue({ actionId: 1n, orderId: 42n, fills: [] });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      expect(fakeUser.refreshSession).toHaveBeenCalledTimes(1);

      fakeNord.getTimestamp.mockResolvedValue(FAKE_NOW_SEC + SESSION_TTL_SEC - 60n);
      await adapter.placeOrder({
        market: MARKET,
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 59000,
        isReduceOnly: false,
      });

      expect(fakeUser.refreshSession).toHaveBeenCalledTimes(2);
    });
  });

  describe("getters before connect()", () => {
    it("throw a clear error rather than reading undefined state", () => {
      const adapter = new N1Adapter(baseConfig());
      expect(() => adapter.getPositions()).toThrow(
        "N1Adapter.connect() must be called before use",
      );
      expect(() => adapter.getBalances()).toThrow(
        "N1Adapter.connect() must be called before use",
      );
    });
  });

  describe("refreshAccountState / getters", () => {
    it("maps positions, orders, balances, and margin from NordUser's cached state, filtered per market", async () => {
      fakeUser.positions[String(ACCOUNT_ID)] = [
        {
          marketId: MARKET_ID,
          openOrders: 1,
          perp: {
            baseSize: 0.02,
            price: 60000,
            updatedFundingRateIndex: 0,
            fundingPaymentPnl: 1,
            sizePricePnl: 4,
            isLong: true,
          },
          actionId: 1,
        },
      ];
      fakeUser.orders[String(ACCOUNT_ID)] = [
        {
          orderId: 55,
          marketId: MARKET_ID,
          side: "bid",
          size: 0.01,
          price: 59000,
          originalOrderSize: 0.01,
          clientOrderId: null,
        },
      ];
      fakeUser.balances[String(ACCOUNT_ID)] = [
        { accountId: ACCOUNT_ID, balance: 12345, symbol: "USDC" },
      ];
      fakeUser.margins[String(ACCOUNT_ID)] = {
        omf: 50000,
        mf: 45000,
        imf: 5000,
        cmf: 2500,
        mmf: 900,
        pon: 15000,
        pn: 20000,
        bankruptcy: false,
      };

      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      await adapter.refreshAccountState();

      expect(fakeUser.fetchInfo).toHaveBeenCalledTimes(2); // once in connect(), once here

      const positions = adapter.getPositions(MARKET);
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({ market: MARKET, baseSize: 0.02, unrealizedPnl: 5 });

      expect(adapter.getPositions("ETHUSD")).toHaveLength(0);

      const orders = adapter.getOpenOrders(MARKET);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ exchangeOrderId: "55", side: "buy", state: "open" });

      expect(adapter.getBalances()).toEqual([{ token: "USDC", amount: 12345 }]);

      expect(adapter.getMarginStatus()).toEqual({
        accountValue: 50000, // omf, not pn (pn/pon are position-notional, not account equity)
        maintenanceMarginFraction: 0.02, // mmf/mf = 900/45000
        initialMarginFraction: 5000 / 50000, // imf/omf = 5000/50000
        isAtBankruptcyRisk: false,
      });
    });

    it("throws a clear error from getMarginStatus() when no margin is cached for the account", async () => {
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      expect(() => adapter.getMarginStatus()).toThrow(/No margin data cached for account 7/);
    });
  });

  describe("placeOrder", () => {
    it("maps post-only buy and sell orders identically except for the SDK side", async () => {
      fakeUser.placeOrder.mockResolvedValue({ actionId: 1n, orderId: 42n, fills: [] });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      await adapter.placeOrder({
        market: MARKET,
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 60_000,
        isReduceOnly: false,
      });
      await adapter.placeOrder({
        market: MARKET,
        side: "sell",
        type: "postOnly",
        size: 0.01,
        price: 60_000,
        isReduceOnly: false,
      });

      const buyCall = fakeUser.placeOrder.mock.calls[0]![0];
      const sellCall = fakeUser.placeOrder.mock.calls[1]![0];

      expect(buyCall).toMatchObject({ side: Side.Bid, fillMode: FillMode.PostOnly });
      expect(sellCall).toMatchObject({ side: Side.Ask, fillMode: FillMode.PostOnly });

      const { side: buySide, ...buyWithoutSide } = buyCall;
      const { side: sellSide, ...sellWithoutSide } = sellCall;
      expect([buySide, sellSide]).toEqual([Side.Bid, Side.Ask]);
      expect(buyWithoutSide).toEqual(sellWithoutSide);
    });

    it.each([true, false])("passes isReduceOnly=%s through to the N1 SDK", async (isReduceOnly) => {
      fakeUser.placeOrder.mockResolvedValue({ actionId: 1n, orderId: 42n, fills: [] });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      await adapter.placeOrder({
        market: MARKET,
        side: "sell",
        type: "postOnly",
        size: 0.01,
        price: 60_100,
        isReduceOnly,
      });

      expect(fakeUser.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ isReduceOnly }),
      );
    });

    it.each(["not-an-integer", "1.5", "-1", "0", (2n ** 63n).toString()])(
      "returns REJECTED without calling the SDK for invalid clientOrderId %s",
      async (clientOrderId) => {
        const adapter = new N1Adapter(baseConfig());
        await adapter.connect();

        const result = await adapter.placeOrder({
          market: MARKET,
          side: "buy",
          type: "postOnly",
          size: 0.01,
          price: 59000,
          isReduceOnly: false,
          clientOrderId,
        });

        expect(result).toMatchObject({ success: false, reason: "REJECTED" });
        expect(fakeUser.placeOrder).not.toHaveBeenCalled();
      },
    );

    it("converts a valid decimal clientOrderId to bigint for the SDK", async () => {
      fakeUser.placeOrder.mockResolvedValue({ actionId: 1n, orderId: 42n, fills: [] });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      await adapter.placeOrder({
        market: MARKET,
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 59000,
        isReduceOnly: false,
        clientOrderId: "9223372036854775807",
      });

      expect(fakeUser.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ clientOrderId: 9223372036854775807n }),
      );
    });

    it("returns success:false UNRESOLVED_NOT_CONFIRMED when the resolved call has neither an orderId nor fills", async () => {
      // SPEC.md Section 5b: this exact shape must never be treated as success.
      fakeUser.placeOrder.mockResolvedValue({
        actionId: 1n,
        orderId: undefined,
        fills: [],
        reducedOrders: [],
        selfTradeCancels: [],
      });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const result = await adapter.placeOrder({
        market: MARKET,
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 59000,
        isReduceOnly: false,
      });

      expect(result).toMatchObject({ success: false, reason: "UNRESOLVED_NOT_CONFIRMED" });
    });

    it("returns a resting open order when the exchange confirms an orderId with no fills yet", async () => {
      fakeUser.placeOrder.mockResolvedValue({
        actionId: 1n,
        orderId: 123n,
        fills: [],
        reducedOrders: [],
        selfTradeCancels: [],
      });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const result = await adapter.placeOrder({
        market: MARKET,
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 59000,
        isReduceOnly: false,
      });

      if (!result.success) throw new Error("expected success");
      expect(result.order).toMatchObject({
        exchangeOrderId: "123",
        filledSize: 0,
        remainingSize: 0.01,
        state: "open",
      });
      expect(result.fills).toHaveLength(0);
    });

    it("marks a partially filled resting order, deriving filledSize from synchronous fills", async () => {
      fakeUser.placeOrder.mockResolvedValue({
        actionId: 1n,
        orderId: 123n,
        fills: [{ orderId: 123n, price: 59000, size: 0.004, accountId: ACCOUNT_ID }],
        reducedOrders: [],
        selfTradeCancels: [],
      });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const result = await adapter.placeOrder({
        market: MARKET,
        side: "buy",
        type: "limit",
        size: 0.01,
        price: 59000,
        isReduceOnly: false,
      });

      if (!result.success) throw new Error("expected success");
      expect(result.order).toMatchObject({
        exchangeOrderId: "123",
        filledSize: 0.004,
        remainingSize: 0.006,
        state: "partiallyFilled",
      });
      expect(result.fills).toEqual([
        expect.objectContaining({ exchangeOrderId: "123", price: 59000, size: 0.004 }),
      ]);
    });

    it("falls back to actionId as the id when an IOC order fully fills with no orderId", async () => {
      fakeUser.placeOrder.mockResolvedValue({
        actionId: 42n,
        orderId: undefined,
        fills: [{ orderId: 0n, price: 59500, size: 0.01, accountId: ACCOUNT_ID }],
        reducedOrders: [],
        selfTradeCancels: [],
      });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const result = await adapter.placeOrder({
        market: MARKET,
        side: "buy",
        type: "immediateOrCancel",
        size: 0.01,
        price: 59500,
        isReduceOnly: false,
      });

      if (!result.success) throw new Error("expected success");
      expect(result.order).toMatchObject({ exchangeOrderId: "42", state: "filled" });
    });

    it("returns success:false REJECTED with the underlying message when the SDK call throws", async () => {
      fakeUser.placeOrder.mockRejectedValue(new Error("network hiccup"));
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const result = await adapter.placeOrder({
        market: MARKET,
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 59000,
        isReduceOnly: false,
      });

      expect(result).toMatchObject({
        success: false,
        reason: "REJECTED",
        message: "network hiccup",
      });
    });

    it("flattens a wrapped SDK error's .cause chain into the message, instead of just the outer wrapper's generic text — mirrors nord-ts's own NordError('Failed to place order', { cause })", async () => {
      const innerCause = new Error("Invalid or empty session ID. Please create or refresh your session.");
      const outerError = new Error("Failed to place order", { cause: innerCause });
      fakeUser.placeOrder.mockRejectedValue(outerError);
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const result = await adapter.placeOrder({
        market: MARKET,
        side: "buy",
        type: "postOnly",
        size: 0.01,
        price: 59000,
        isReduceOnly: false,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected failure");
      expect(result.message).toBe(
        "Failed to place order: caused by: Invalid or empty session ID. Please create or refresh your session.",
      );
    });
  });

  describe("cancelOrder", () => {
    it("returns success with the confirmed exchangeOrderId", async () => {
      fakeUser.cancelOrder.mockResolvedValue({ actionId: 1n, orderId: 55n, accountId: ACCOUNT_ID });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const result = await adapter.cancelOrder("55", MARKET);
      expect(result).toEqual({ success: true, exchangeOrderId: "55" });
    });

    it("throws a retryable ExchangeAdapterError when the SDK call fails", async () => {
      fakeUser.cancelOrder.mockRejectedValue(new Error("timeout"));
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      await expect(adapter.cancelOrder("55", MARKET)).rejects.toMatchObject({
        name: "ExchangeAdapterError",
        retryable: true,
      });
    });
  });

  describe("getOrderFills", () => {
    it("maps trade history for the order, attributing side correctly for a maker fill", async () => {
      fakeNord.getOrderTrades.mockResolvedValue({
        items: [
          {
            time: new Date(2026, 0, 1).toISOString(),
            actionId: 1,
            tradeId: 9,
            takerId: 999, // not us — we were the resting maker
            takerSide: "ask",
            makerId: ACCOUNT_ID,
            marketId: MARKET_ID,
            marketMode: "clob",
            orderId: 123,
            price: 59000,
            baseSize: 0.01,
          },
        ],
      });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const fills = await adapter.getOrderFills("123", MARKET);
      expect(fakeNord.getOrderTrades).toHaveBeenCalledWith(123);
      expect(fills).toEqual([
        expect.objectContaining({
          exchangeOrderId: "123",
          tradeId: "9",
          market: MARKET,
          side: "buy", // opposite of takerSide "ask", since we were maker
          price: 59000,
          size: 0.01,
        }),
      ]);
    });
  });

  describe("getMarketPrice", () => {
    it("delegates to getMarketStats and maps mark/index price", async () => {
      fakeNord.getMarketStats.mockResolvedValue({
        volumeBase24h: 0,
        volumeQuote24h: 0,
        indexPrice: 60000,
        perpStats: {
          mark_price: 60050,
          aggregated_funding_index: 0,
          funding_rate: 0,
          next_funding_time: new Date().toISOString(),
          open_interest: 0,
        },
      });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const price = await adapter.getMarketPrice(MARKET);
      expect(price).toEqual({ market: MARKET, mark: 60050, index: 60000 });
    });
  });

  describe("getAccountVolume", () => {
    const trade = (overrides: Record<string, unknown> = {}) => ({
      time: "2026-01-01T12:00:00.000Z", actionId: 1, tradeId: 1,
      takerId: 99, takerSide: "bid", makerId: ACCOUNT_ID, marketId: MARKET_ID,
      marketMode: "clob", orderId: 10, price: 100, baseSize: 2, ...overrides,
    });

    it("paginates maker and taker streams, deduplicates tradeIds, filters [since, until), and preserves unknown markets", async () => {
      fakeNord.getTrades.mockImplementation(async ({ makerId, startInclusive }) => {
        if (makerId !== undefined && startInclusive === undefined) {
          return { items: [trade({ tradeId: 3, marketId: 404, price: 25, baseSize: 4 }), trade({ tradeId: 2, time: "2026-01-01T00:00:00.000Z", price: 50, baseSize: 1 })], nextStartInclusive: 2 };
        }
        if (makerId !== undefined) {
          return { items: [trade({ tradeId: 2, time: "2026-01-01T00:00:00.000Z", price: 50, baseSize: 1 }), trade()] };
        }
        return { items: [trade({ tradeId: 4, takerId: ACCOUNT_ID, makerId: 88, time: "2026-01-02T00:00:00.000Z" }), trade()] };
      });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();

      const rows = await adapter.getAccountVolume({
        since: "2026-01-01T00:00:00Z",
        until: "2026-01-02T00:00:00Z",
      });

      expect(rows).toEqual([
        expect.objectContaining({ market: MARKET, marketId: MARKET_ID, baseVolume: 3, quoteVolume: 250 }),
        expect.objectContaining({ market: null, marketId: 404, baseVolume: 4, quoteVolume: 100 }),
      ]);
      expect(fakeNord.getTrades).toHaveBeenCalledTimes(3);
      expect(fakeNord.getTrades).toHaveBeenCalledWith(expect.objectContaining({ makerId: ACCOUNT_ID, pageSize: 50, paginationMode: "tradeId" }));
      expect(fakeNord.getAccountVolume).not.toHaveBeenCalled();
    });

    it("single-flights and caches one complete scan across concurrent volume windows", async () => {
      fakeNord.getTrades.mockResolvedValue({ items: [trade()] });
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      const until = "2026-01-02T00:00:00Z";
      await Promise.all(["2026-01-01T00:00:00Z", "2025-12-01T00:00:00Z", "1970-01-01T00:00:00Z"]
        .map((since) => adapter.getAccountVolume({ since, until })));
      expect(fakeNord.getTrades).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["malformed row", { items: [trade({ price: Number.NaN })] }, /Malformed N1/],
      ["empty continuation page", { items: [], nextStartInclusive: 2 }, /empty page/],
      ["malformed cursor", { items: [trade()], nextStartInclusive: 1.5 }, /Invalid N1/],
      ["boundary-mismatched cursor", { items: [trade({ tradeId: 2 })], nextStartInclusive: 1 }, /page boundary/],
      ["wrong-direction page", { items: [trade(), trade({ tradeId: 2 })] }, /Wrong-direction/],
    ])("rejects a %s without publishing partial totals", async (_label, response, message) => {
      fakeNord.getTrades.mockResolvedValue(response);
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      await expect(adapter.getAccountVolume({ since: "2026-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z" })).rejects.toThrow(message);
    });

    it("rejects a repeated cursor", async () => {
      fakeNord.getTrades.mockImplementation(async ({ startInclusive }) => ({
        items: startInclusive === undefined
          ? [trade({ tradeId: 2 })]
          : [trade({ tradeId: 2 }), trade()],
        nextStartInclusive: startInclusive === undefined ? 2 : 1,
      }));
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      await expect(adapter.getAccountVolume({ since: "2026-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z" })).rejects.toThrow(/repeated/);
    });

    it("rejects a duplicate-only continuation page", async () => {
      fakeNord.getTrades.mockImplementation(async ({ startInclusive }) => ({
        items: [trade({ tradeId: startInclusive ?? 2 })],
        ...(startInclusive === undefined ? { nextStartInclusive: 2 } : {}),
      }));
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      await expect(adapter.getAccountVolume({ since: "2026-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z" })).rejects.toThrow(/added no new trades/);
    });

    it("rejects safety-cap exhaustion", async () => {
      fakeNord.getTrades.mockImplementation(async ({ startInclusive }) => ({
        items: startInclusive === undefined
          ? [trade({ tradeId: MAX_ACCOUNT_TRADE_PAGES_PER_STREAM + 1 })]
          : [trade({ tradeId: startInclusive }), trade({ tradeId: startInclusive - 1 })],
        nextStartInclusive: startInclusive === undefined
          ? MAX_ACCOUNT_TRADE_PAGES_PER_STREAM + 1
          : startInclusive - 1,
      }));
      const adapter = new N1Adapter(baseConfig());
      await adapter.connect();
      await expect(adapter.getAccountVolume({ since: "1970-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z" }))
        .rejects.toThrow(`${MAX_ACCOUNT_TRADE_PAGES_PER_STREAM}-page safety cap`);
      expect(fakeNord.getTrades).toHaveBeenCalledTimes(MAX_ACCOUNT_TRADE_PAGES_PER_STREAM);
    });
  });
});

/**
 * Every other test in this file mocks NordUser.placeOrder as a bare `vi.fn()` — which structurally
 * cannot catch a regression where N1Adapter.connect() stops establishing a session, because a bare
 * mock has no notion of "session required" to begin with; it would resolve identically either way.
 * This suite closes that specific gap with a fake that actually enforces the real SDK's contract:
 * NordUser.placeOrder() throws (mirroring the real checkSessionValidity()) unless refreshSession()
 * was called first. It is still not a real network test — no live/authenticated call is made here
 * or anywhere in this file — but unlike the bare mocks above, it fails if connect()'s call to
 * ensureSession() (and therefore refreshSession()) is ever deleted.
 */
describe("session lifecycle contract (fake enforces real SDK session gating, not just a bare mock)", () => {
  function makeSessionEnforcingNordUser(): FakeNordUserInstance {
    let sessionEstablished = false;
    return {
      accountIds: [ACCOUNT_ID],
      positions: {},
      orders: {},
      balances: {},
      margins: {},
      updateAccountId: vi.fn().mockResolvedValue(undefined),
      fetchInfo: vi.fn().mockResolvedValue(undefined),
      cancelOrder: vi.fn(),
      refreshSession: vi.fn().mockImplementation(async () => {
        sessionEstablished = true;
        return {
          sessionId: 123n,
          expiry: FAKE_NOW_SEC + SESSION_TTL_SEC,
          refreshDeadline: undefined,
        };
      }),
      // Mirrors NordUser.checkSessionValidity(): throws unless a session has been established.
      placeOrder: vi.fn().mockImplementation(async () => {
        if (!sessionEstablished) {
          throw new Error("Invalid or empty session ID. Please create or refresh your session.");
        }
        return { actionId: 1n, orderId: 42n, fills: [] };
      }),
    };
  }

  it("sanity check: the fake itself rejects placeOrder() before any session has been established", async () => {
    const fake = makeSessionEnforcingNordUser();
    await expect(fake.placeOrder()).rejects.toThrow(/Invalid or empty session ID/);
  });

  it("N1Adapter.connect() establishes the session before placeOrder() becomes usable", async () => {
    const fake = makeSessionEnforcingNordUser();
    nordNew.mockReset().mockResolvedValue(makeFakeNord() as unknown as Nord);
    nordUserFromPrivateKey.mockReset().mockReturnValue(fake as unknown as NordUser);

    const adapter = new N1Adapter(baseConfig());
    await adapter.connect();

    const result = await adapter.placeOrder({
      market: MARKET,
      side: "buy",
      type: "postOnly",
      size: 0.01,
      price: 59000,
      isReduceOnly: false,
    });

    expect(result.success).toBe(true);
  });
});
