/**
 * Fixture/contract tests for RiseXAdapter's authenticated surface (SPEC.md Section 11, build plan
 * step 3). These prove the adapter sends and parses what RISEx's DOCUMENTED OpenAPI reference
 * (developer.rise.trade/reference) describes — they do NOT prove anything about RISEx's real
 * matching behavior, fill timing, or error/edge cases under live conditions. RISEx has no public
 * testnet, so unlike RiseXMarketDataSource.test.ts (fixtures captured from real live mainnet
 * curls) and RiseXPaperAdapter's soak test (run against real live market data), there is no live
 * counterpart to this file and none is possible yet. See RiseXAdapter.ts's class doc comment for
 * the full explanation — do not treat a green run of this file as live-readiness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RiseXAdapter } from "../../../src/adapters/risex/RiseXAdapter.js";
import type { RiseXMarket } from "../../../src/adapters/risex/RiseXMarketDataSource.js";
import { FakeRiseXMarketDataSource } from "./fakeMarketDataSource.js";
import { FakeRiseXSigner } from "./fakeSigner.js";

const BASE_URL = "https://api.rise.trade";
const ACCOUNT = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const USDC_ADDRESS = "0xe436820ba0c69702c1d3e601d421c0ef38262739";

function envelope(data: unknown): unknown {
  return { data, request_id: "req-1" };
}

/** Narrow local stand-in for the DOM lib's RequestInit — avoids depending on that global type
 * existing in this project's lint environment (test-only concern, not a runtime one). */
interface FetchCallInit {
  headers?: Record<string, string>;
  body?: string;
}

function callInit(call: unknown[]): FetchCallInit {
  return call[1] as FetchCallInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function btcMarket(overrides: Partial<RiseXMarket> = {}): RiseXMarket {
  return {
    marketId: 1,
    symbol: "BTC/USDC",
    displayName: "BTC/USDC",
    markPrice: 60000,
    indexPrice: 60000,
    lastPrice: 60000,
    stepSize: 0.000001,
    stepPrice: 0.1,
    minOrderSize: 0.0001,
    maxLeverage: 20,
    active: true,
    ...overrides,
  };
}

describe("RiseXAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let signer: FakeRiseXSigner;
  let marketData: FakeRiseXMarketDataSource;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    signer = new FakeRiseXSigner();
    marketData = new FakeRiseXMarketDataSource();
    marketData.markets = [btcMarket()];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function newAdapter(overrides: Partial<ConstructorParameters<typeof RiseXAdapter>[2]> = {}) {
    return new RiseXAdapter(marketData, signer, {
      baseUrl: BASE_URL,
      account: ACCOUNT,
      usdcTokenAddress: USDC_ADDRESS,
      markets: [{ symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" }],
      ...overrides,
    });
  }

  function pathOf(call: unknown[]): string {
    return (call[0] as URL).pathname;
  }

  function mockLoginSequence(tokenOverrides: Partial<{ expires_in: number }> = {}) {
    fetchMock
      // GET /v1/auth/eip712-domain
      .mockResolvedValueOnce(
        jsonResponse(
          envelope({
            name: "RiseXAuthorization",
            version: "1",
            chain_id: "11155931",
            verifying_contract: "0xe465Cc9318B7b4b616F4604bFC1e4958C32dAb91",
          }),
        ),
      )
      // GET /v1/auth/nonce
      .mockResolvedValueOnce(jsonResponse(envelope({ nonce: "0x1a2b" })))
      // POST /v1/auth/login
      .mockResolvedValueOnce(
        jsonResponse(
          envelope({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
            token_type: "Bearer",
            ...tokenOverrides,
          }),
        ),
      );
  }

  describe("connect", () => {
    it("resolves the market registry, then runs the full EIP-712 Login handshake", async () => {
      mockLoginSequence();
      const adapter = newAdapter();

      await adapter.connect();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(pathOf(fetchMock.mock.calls[0]!)).toBe("/v1/auth/eip712-domain");
      expect(pathOf(fetchMock.mock.calls[1]!)).toBe("/v1/auth/nonce");
      expect(pathOf(fetchMock.mock.calls[2]!)).toBe("/v1/auth/login");

      // Neither the domain nor nonce calls carry a bearer token — no token exists yet.
      const domainHeaders = callInit(fetchMock.mock.calls[0]!).headers as Record<string, string>;
      expect(domainHeaders?.authorization).toBeUndefined();

      // The signer was called with the domain and nonce exactly as fetched.
      expect(signer.calls).toHaveLength(1);
      expect(signer.calls[0]).toMatchObject({
        domain: {
          name: "RiseXAuthorization",
          version: "1",
          chainId: "11155931",
          verifyingContract: "0xe465Cc9318B7b4b616F4604bFC1e4958C32dAb91",
        },
        account: ACCOUNT,
        nonce: "0x1a2b",
      });

      // The login POST body carries the signature the fake signer returned.
      const loginBody = JSON.parse(callInit(fetchMock.mock.calls[2]!).body as string);
      expect(loginBody).toMatchObject({ account: ACCOUNT, nonce: "0x1a2b", signature: expect.stringMatching(/^0x/) });
      expect(typeof loginBody.deadline).toBe("number");
    });

    it("propagates an ExchangeAdapterError if the configured market isn't in RISEx's live list", async () => {
      marketData.markets = [];
      const adapter = newAdapter();
      await expect(adapter.connect()).rejects.toThrow(/no market with symbol/);
    });
  });

  describe("token refresh", () => {
    it("reuses the access token within its lifetime — no extra auth calls on a second authenticated request", async () => {
      mockLoginSequence({ expires_in: 3600 });
      const adapter = newAdapter();
      await adapter.connect();

      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          envelope({
            account: ACCOUNT,
            summary: portfolioSummary(),
            positions: [],
          }),
        ),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse(envelope({ orders: [], market_id: "0", account: ACCOUNT, total_orders: "0" })));
      fetchMock.mockResolvedValueOnce(jsonResponse(envelope({ balance: "0" })));

      await adapter.refreshAccountState();

      // 3 calls for connect() + 3 for refreshAccountState(), no extra refresh call.
      expect(fetchMock).toHaveBeenCalledTimes(6);
      const bearerHeader = callInit(fetchMock.mock.calls[3]!).headers as Record<string, string>;
      expect(bearerHeader.authorization).toBe("Bearer access-1");
    });

    it("transparently refreshes an expired token before the next authenticated call", async () => {
      // expires_in negative guarantees the token is already past its margin the instant
      // connect() returns, regardless of real wall-clock time elapsed in the test itself.
      mockLoginSequence({ expires_in: -3600 });
      const adapter = newAdapter({ tokenRefreshMarginMs: 500 });
      await adapter.connect();

      fetchMock
        // POST /v1/auth/refresh
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "Bearer" }),
          ),
        )
        // GET /v1/portfolio/details
        .mockResolvedValueOnce(jsonResponse(envelope({ account: ACCOUNT, summary: portfolioSummary(), positions: [] })))
        // GET /v1/orders/open
        .mockResolvedValueOnce(jsonResponse(envelope({ orders: [], market_id: "0", account: ACCOUNT, total_orders: "0" })))
        // GET /v1/account/balance
        .mockResolvedValueOnce(jsonResponse(envelope({ balance: "0" })));

      await adapter.refreshAccountState();

      expect(pathOf(fetchMock.mock.calls[3]!)).toBe("/v1/auth/refresh");
      const refreshBody = JSON.parse(callInit(fetchMock.mock.calls[3]!).body as string);
      expect(refreshBody).toEqual({ refresh_token: "refresh-1" });

      const portfolioHeaders = callInit(fetchMock.mock.calls[4]!).headers as Record<string, string>;
      expect(portfolioHeaders.authorization).toBe("Bearer access-2");
    });

    it("throws if the token is expired and no refresh token is available", async () => {
      mockLoginSequence({ expires_in: -3600 });
      const adapter = newAdapter({ tokenRefreshMarginMs: 500 });
      await adapter.connect();
      // Simulate refresh_token itself having been invalidated server-side by making the refresh
      // call fail, then confirm the adapter surfaces a clear error rather than looping.
      fetchMock.mockResolvedValueOnce(jsonResponse({ code: 401, message: "invalid refresh token" }, 401));
      await expect(adapter.refreshAccountState()).rejects.toThrow(/RISEx returned HTTP 401/);
    });
  });

  describe("refreshAccountState / getters", () => {
    async function connectedAdapter() {
      mockLoginSequence();
      const adapter = newAdapter();
      await adapter.connect();
      return adapter;
    }

    it("throws a clear error from getters called before any refreshAccountState()", async () => {
      const adapter = await connectedAdapter();
      expect(() => adapter.getPositions()).toThrow(/before any refreshAccountState/);
      expect(() => adapter.getOpenOrders()).toThrow(/before any refreshAccountState/);
      expect(() => adapter.getBalances()).toThrow(/before any refreshAccountState/);
      expect(() => adapter.getMarginStatus()).toThrow(/before any refreshAccountState/);
    });

    it("maps portfolio/details positions, orders/open, and account/balance into normalized shapes", async () => {
      const adapter = await connectedAdapter();

      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              account: ACCOUNT,
              summary: portfolioSummary({
                total_account_value: "10500.25",
                cross_margin_balance: "10000",
                total_maintenance_margin: "500",
                total_initial_margin: "1000",
                margin_usage: "0.1",
                in_liquidation: false,
                risk_level: "NORMAL",
              }),
              positions: [
                {
                  market_id: "1",
                  market_name: "BTC-USD",
                  size: "0.0025",
                  side: 0,
                  margin_mode: 0,
                  avg_entry_price: "60000",
                  mark_price: "61000",
                  index_price: "61000",
                  leverage: "2",
                  unrealized_pnl: "2.5",
                  liquidation_price: "40000",
                  initial_margin_requirement: "50",
                  maintenance_margin_requirement: "25",
                },
              ],
            }),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              orders: [
                {
                  order_id: "0x123abc-100-0",
                  wide_order_id: "9223372036854775808",
                  resting_order_id: "1099511627776",
                  market_id: 1,
                  account: ACCOUNT,
                  side: 0,
                  size_steps: 1000,
                  price_ticks: 600000,
                  order_type: 1,
                  time_in_force: 0,
                  post_only: false,
                  reduce_only: false,
                  client_order_id: "12345",
                },
              ],
              market_id: "1",
              account: ACCOUNT,
              total_orders: "1",
            }),
          ),
        )
        .mockResolvedValueOnce(jsonResponse(envelope({ balance: "2500000000000000000000" })));

      await adapter.refreshAccountState();

      expect(adapter.getPositions()).toEqual([
        {
          market: "BTCUSD",
          baseSize: 0.0025,
          markPrice: 61000,
          unrealizedPnl: 2.5,
          openOrderCount: 1,
        },
      ]);

      expect(adapter.getOpenOrders()).toEqual([
        {
          exchangeOrderId: "0x123abc-100-0",
          clientOrderId: "12345",
          market: "BTCUSD",
          side: "buy",
          type: "limit",
          price: 60000, // 600000 ticks * 0.1 stepPrice
          size: 0.001, // 1000 steps * 0.000001 stepSize
          filledSize: 0,
          remainingSize: 0.001,
          isReduceOnly: false,
          state: "open",
        },
      ]);

      expect(adapter.getBalances()).toEqual([{ token: "USDC", amount: 2500 }]);

      expect(adapter.getMarginStatus()).toEqual({
        accountValue: 10500.25,
        maintenanceMarginFraction: 0.05, // 500 / 10000
        initialMarginFraction: 0.1, // reused directly from margin_usage
        isAtBankruptcyRisk: false,
      });
    });

    it("flags isAtBankruptcyRisk when RISEx reports in_liquidation", async () => {
      const adapter = await connectedAdapter();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              account: ACCOUNT,
              summary: portfolioSummary({ in_liquidation: true, risk_level: "LIQUIDATION" }),
              positions: [],
            }),
          ),
        )
        .mockResolvedValueOnce(jsonResponse(envelope({ orders: [], market_id: "0", account: ACCOUNT, total_orders: "0" })))
        .mockResolvedValueOnce(jsonResponse(envelope({ balance: "0" })));

      await adapter.refreshAccountState();
      expect(adapter.getMarginStatus().isAtBankruptcyRisk).toBe(true);
    });
  });

  describe("placeOrder", () => {
    async function connectedAdapter(overrides: Partial<ConstructorParameters<typeof RiseXAdapter>[2]> = {}) {
      mockLoginSequence();
      const adapter = newAdapter(overrides);
      await adapter.connect();
      return adapter;
    }

    it("quantizes price/size onto the tick/step grid and omits `permit` (JWT-bearer path)", async () => {
      const adapter = await connectedAdapter();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              order_id: "0xabc-101-0",
              tx_hash: "0xdeadbeef",
              block_number: "101",
              sc_order_id: "42",
              filled_quantity: "0",
            }),
          ),
        )
        .mockResolvedValueOnce(jsonResponse(envelope({ tx_hash: "0xdeadbeef", success: true })));

      const result = await adapter.placeOrder({
        market: "BTCUSD",
        side: "buy",
        type: "limit",
        size: 0.00155,
        price: 60000.03,
        isReduceOnly: false,
      });

      const placeCallIndex = 3;
      expect(pathOf(fetchMock.mock.calls[placeCallIndex]!)).toBe("/v1/orders/place");
      const body = JSON.parse(callInit(fetchMock.mock.calls[placeCallIndex]!).body as string);
      expect(body.permit).toBeUndefined();
      expect(body.price_ticks).toBe(600000); // 60000.03 / 0.1 rounded
      expect(body.size_steps).toBe(1550); // 0.00155 / 0.000001
      expect(body.order_type).toBe(1);
      expect(body.time_in_force).toBe(0);
      expect(body.post_only).toBe(false);
      expect(body.reduce_only).toBe(false);

      expect(pathOf(fetchMock.mock.calls[4]!)).toBe("/v1/tx/0xdeadbeef");

      expect(result).toEqual({
        success: true,
        order: {
          exchangeOrderId: "0xabc-101-0",
          clientOrderId: undefined,
          market: "BTCUSD",
          side: "buy",
          type: "limit",
          price: 60000, // requoted from ticks
          size: 0.00155,
          filledSize: 0,
          remainingSize: 0.00155,
          isReduceOnly: false,
          state: "open",
        },
        fills: [],
      });
    });

    it("maps a synchronously-filled IOC order's filled_quantity (WAD) into a best-effort fill", async () => {
      const adapter = await connectedAdapter();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              order_id: "0xabc-102-0",
              tx_hash: "0xfeedface",
              block_number: "102",
              sc_order_id: "43",
              filled_quantity: "1550000000000000", // 0.00155 in WAD (size steps are 1e-6, WAD is 1e18: 1550 steps * 1e-6 = 0.00155 -> * 1e18)
              message: "fully filled",
              filled_percent: "100.00",
            }),
          ),
        )
        .mockResolvedValueOnce(jsonResponse(envelope({ tx_hash: "0xfeedface", success: true })));

      const result = await adapter.placeOrder({
        market: "BTCUSD",
        side: "sell",
        type: "immediateOrCancel",
        size: 0.00155,
        price: 59999.9,
        isReduceOnly: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("unreachable");
      expect(result.order.filledSize).toBeCloseTo(0.00155, 9);
      expect(result.order.state).toBe("filled");
      expect(result.fills).toHaveLength(1);
      expect(result.fills[0]).toMatchObject({ exchangeOrderId: "0xabc-102-0", market: "BTCUSD", side: "sell" });
    });

    it("returns REJECTED with the decoded revert reason when decode-tx reports a reverted transaction", async () => {
      const adapter = await connectedAdapter();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              order_id: "0xabc-103-0",
              tx_hash: "0xbadtx",
              block_number: "103",
              sc_order_id: "44",
              filled_quantity: "0",
            }),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              tx_hash: "0xbadtx",
              success: false,
              error: {
                selector: "3af8647b",
                signature: "InsufficientMargin(uint256,uint256)",
                name: "InsufficientMargin",
                parameters: ["1000000000000000000", "500000000000000000"],
                message: "Account margin insufficient",
              },
            }),
          ),
        );

      const result = await adapter.placeOrder({
        market: "BTCUSD",
        side: "buy",
        type: "limit",
        size: 0.001,
        price: 60000,
        isReduceOnly: false,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.reason).toBe("REJECTED");
      expect(result.message).toMatch(/InsufficientMargin/);
      expect(result.message).toMatch(/Account margin insufficient/);
    });

    it("returns UNRESOLVED_NOT_CONFIRMED (not REJECTED) when decode-tx itself fails to resolve — SPEC 5b-equivalent fail-open", async () => {
      const adapter = await connectedAdapter();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              order_id: "0xabc-104-0",
              tx_hash: "0xflaky",
              block_number: "104",
              sc_order_id: "45",
              filled_quantity: "0",
            }),
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ code: 503, message: "temporarily unavailable" }, 503));

      const result = await adapter.placeOrder({
        market: "BTCUSD",
        side: "buy",
        type: "limit",
        size: 0.001,
        price: 60000,
        isReduceOnly: false,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.reason).toBe("UNRESOLVED_NOT_CONFIRMED");
      expect(result.message).toMatch(/0xflaky/);
    });

    it("returns REJECTED without any network call for an invalid clientOrderId", async () => {
      const adapter = await connectedAdapter();
      const callsBefore = fetchMock.mock.calls.length;

      const result = await adapter.placeOrder({
        market: "BTCUSD",
        side: "buy",
        type: "limit",
        size: 0.001,
        price: 60000,
        isReduceOnly: false,
        clientOrderId: "not-a-number",
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.reason).toBe("REJECTED");
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });
  });

  describe("cancelOrder", () => {
    async function connectedAdapter() {
      mockLoginSequence();
      const adapter = newAdapter();
      await adapter.connect();
      return adapter;
    }

    it("trusts cancelOrder's own `success` field directly — no decode-tx call", async () => {
      const adapter = await connectedAdapter();
      fetchMock.mockResolvedValueOnce(jsonResponse(envelope({ tx_hash: "0xcancel1", block_number: "200", success: true })));

      const result = await adapter.cancelOrder("0xabc-99-0", "BTCUSD");

      expect(result).toEqual({ success: true, exchangeOrderId: "0xabc-99-0" });
      expect(fetchMock).toHaveBeenCalledTimes(4); // 3 for connect() + 1 for cancel, no decode-tx
      const body = JSON.parse(callInit(fetchMock.mock.calls[3]!).body as string);
      expect(body.permit).toBeUndefined();
      expect(body.order_id).toBe("0xabc-99-0");
    });

    it("returns success:false when RISEx reports the cancel's receipt status was not 1", async () => {
      const adapter = await connectedAdapter();
      fetchMock.mockResolvedValueOnce(jsonResponse(envelope({ tx_hash: "0xcancel2", block_number: "201", success: false })));

      const result = await adapter.cancelOrder("0xabc-98-0", "BTCUSD");
      expect(result).toEqual({ success: false, exchangeOrderId: "0xabc-98-0" });
    });

    it("throws a retryable ExchangeAdapterError on a network failure", async () => {
      const adapter = await connectedAdapter();
      fetchMock.mockRejectedValueOnce(new TypeError("network down"));
      await expect(adapter.cancelOrder("0xabc-97-0", "BTCUSD")).rejects.toThrow(/Failed to cancel order/);
    });
  });

  describe("getOrderFills", () => {
    async function connectedAdapter() {
      mockLoginSequence();
      const adapter = newAdapter();
      await adapter.connect();
      return adapter;
    }

    it("filters trade-history client-side by order_id since RISEx has no server-side filter for it", async () => {
      const adapter = await connectedAdapter();
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          envelope({
            market_id: 1,
            wallet_address: ACCOUNT,
            page: 1,
            has_next_page: false,
            trades: [
              {
                id: "trade-1",
                market_id: 1,
                order_id: "0xabc-1-0",
                side: "BUY",
                price: "60000",
                size: "0.001",
                fee: "0.06",
                liquidity_indicator: "TAKER",
                time: "1786410000000000000",
              },
              {
                id: "trade-2",
                market_id: 1,
                order_id: "0xother-2-0",
                side: "SELL",
                price: "60001",
                size: "0.002",
                fee: "0.12",
                liquidity_indicator: "MAKER",
                time: "1786410001000000000",
              },
            ],
          }),
        ),
      );

      const fills = await adapter.getOrderFills("0xabc-1-0", "BTCUSD");
      expect(fills).toEqual([
        {
          exchangeOrderId: "0xabc-1-0",
          tradeId: "trade-1",
          market: "BTCUSD",
          side: "buy",
          price: 60000,
          size: 0.001,
          timestamp: 1786410000000,
        },
      ]);
    });

    it("pages forward, bounded by maxOrderFillsPages, until the order is found or pages run out", async () => {
      mockLoginSequence();
      const adapter = newAdapter({ maxOrderFillsPages: 2 });
      await adapter.connect();

      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({ market_id: 1, wallet_address: ACCOUNT, page: 1, has_next_page: true, trades: [] }),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              market_id: 1,
              wallet_address: ACCOUNT,
              page: 2,
              has_next_page: true, // there'd be a page 3, but maxOrderFillsPages caps at 2
              trades: [
                {
                  id: "trade-3",
                  market_id: 1,
                  order_id: "0xabc-1-0",
                  side: "SELL",
                  price: "59900",
                  size: "0.0005",
                  fee: "0.03",
                  liquidity_indicator: "MAKER",
                  time: "1786410002000000000",
                },
              ],
            }),
          ),
        );

      const fills = await adapter.getOrderFills("0xabc-1-0", "BTCUSD");
      expect(fetchMock).toHaveBeenCalledTimes(5); // 3 connect + 2 pages
      expect(fills).toHaveLength(1);
      expect(fills[0]!.tradeId).toBe("trade-3");
    });
  });

  describe("getAccountVolume", () => {
    it("aggregates base/quote volume across paginated trade-history, grouped by market", async () => {
      mockLoginSequence();
      const adapter = newAdapter();
      await adapter.connect();

      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              market_id: 0,
              wallet_address: ACCOUNT,
              page: 1,
              has_next_page: true,
              trades: [
                {
                  id: "t1",
                  market_id: 1,
                  order_id: "o1",
                  side: "BUY",
                  price: "60000",
                  size: "0.001",
                  fee: "0",
                  liquidity_indicator: "TAKER",
                  time: "1786410000000000000",
                },
              ],
            }),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            envelope({
              market_id: 0,
              wallet_address: ACCOUNT,
              page: 2,
              has_next_page: false,
              trades: [
                {
                  id: "t2",
                  market_id: 1,
                  order_id: "o2",
                  side: "SELL",
                  price: "61000",
                  size: "0.002",
                  fee: "0",
                  liquidity_indicator: "MAKER",
                  time: "1786410001000000000",
                },
              ],
            }),
          ),
        );

      const result = await adapter.getAccountVolume({
        since: "2026-08-01T00:00:00Z",
        until: "2026-08-11T00:00:00Z",
      });

      expect(result).toEqual([
        {
          market: "BTCUSD",
          since: "2026-08-01T00:00:00Z",
          until: "2026-08-11T00:00:00Z",
          baseVolume: 0.003,
          quoteVolume: 0.001 * 60000 + 0.002 * 61000,
        },
      ]);
    });

    it("throws rather than silently truncating when maxVolumePages is exceeded", async () => {
      mockLoginSequence();
      const adapter = newAdapter({ maxVolumePages: 1 });
      await adapter.connect();

      fetchMock.mockResolvedValueOnce(
        jsonResponse(envelope({ market_id: 0, wallet_address: ACCOUNT, page: 1, has_next_page: true, trades: [] })),
      );

      await expect(
        adapter.getAccountVolume({ since: "2026-08-01T00:00:00Z", until: "2026-08-11T00:00:00Z" }),
      ).rejects.toThrow(/exceeded maxVolumePages/);
    });
  });

  describe("getMarketPrice", () => {
    it("delegates to the public market data source and reuses the shared mapper", async () => {
      mockLoginSequence();
      const adapter = newAdapter();
      await adapter.connect();

      const price = await adapter.getMarketPrice("BTCUSD");
      expect(price).toEqual({ market: "BTCUSD", mark: 60000, index: 60000 });
    });
  });
});

function portfolioSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    total_account_value: "10000",
    usdc_balance: "10000",
    collateral_margin_balance: "10000",
    cross_margin_balance: "10000",
    free_collateral: "9000",
    total_unrealized_pnl: "0",
    realized_pnl: "0",
    total_initial_margin: "1000",
    total_maintenance_margin: "500",
    margin_usage: "0.1",
    margin_health: "0.9",
    account_leverage: "1",
    in_liquidation: false,
    risk_level: "NORMAL",
    total_notional: "10000",
    unsettled_usdc: "0",
    total_isolated_order_reserve: "0",
    ...overrides,
  };
}
