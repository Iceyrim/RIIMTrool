import type {
  AccountVolume,
  CancelOrderResult,
  ExchangeAdapter,
  MarketPrice,
  NormalizedBalance,
  NormalizedFill,
  NormalizedMarginStatus,
  NormalizedOrder,
  NormalizedPosition,
  PlaceOrderParams,
  PlaceOrderResult,
} from "../ExchangeAdapter.js";
import { ExchangeAdapterError } from "../AdapterError.js";
import type { RiseXEnvelope } from "./types.js";
import type {
  RiseXAccountTradeHistoryResponseRaw,
  RiseXAuthTokenRaw,
  RiseXBalanceResponseRaw,
  RiseXDecodeTxResponseRaw,
  RiseXEip712DomainRaw,
  RiseXLoginNonceRaw,
  RiseXLoginRequestRaw,
  RiseXOpenOrderRaw,
  RiseXOpenOrdersResponseRaw,
  RiseXOrderCancelRequestRaw,
  RiseXOrderCancelResponseRaw,
  RiseXOrderPlaceRequestRaw,
  RiseXOrderPlaceResponseRaw,
  RiseXPortfolioDetailsResponseRaw,
  RiseXPortfolioPositionRaw,
  RiseXPortfolioSummaryRaw,
  RiseXRefreshRequestRaw,
} from "./authTypes.js";
import type { RiseXSigner } from "./RiseXSigner.js";
import { RiseXMarketRegistry, type ConfiguredRiseXMarket } from "./marketRegistry.js";
import { decimal, nsStringToMs, type RiseXMarketDataSource } from "./RiseXMarketDataSource.js";
import { mapRiseXMarketPrice } from "./mappers.js";
import {
  fromSteps,
  fromTicks,
  mapRiseXOrderType,
  orderSideToRiseXSide,
  orderTypeToRiseXFields,
  riseXSideToOrderSide,
  scaledIntToNumber,
  toSteps,
  toTicks,
  wadToNumber,
} from "./riseXAuthMappers.js";

export interface RiseXAdapterConfig {
  baseUrl: string;
  /** 0x-prefixed account address this adapter trades on behalf of. */
  account: string;
  /** Token CONTRACT ADDRESS for the collateral asset getBalances() reports — RISEx's
   * /v1/account/balance takes an address, not a symbol, so this can't be inferred from the
   * logical "USDC" label alone. */
  usdcTokenAddress: string;
  /** Decimals /v1/account/balance's raw integer string is scaled by for usdcTokenAddress. NOT
   * documented per-endpoint by RISEx; 18 is inferred from the WAD (1e18) convention seen
   * elsewhere in RISEx's margin accounting, not confirmed against a real authenticated response
   * for this specific endpoint — see this class's doc comment on the live-readiness gate.
   * Defaults to 18. */
  usdcTokenDecimals?: number;
  markets: ConfiguredRiseXMarket[];
  /** EIP-712 Login signature deadline, seconds from now, sent as the `deadline` field of the
   * signed message. Must stay comfortably under the server-issued nonce's 5-minute expiry.
   * Defaults to 120. */
  loginDeadlineSeconds?: number;
  /** Proactively refresh the access token once fewer than this many ms remain before its
   * documented expires_in elapses. Defaults to 30s. */
  tokenRefreshMarginMs?: number;
  timeoutMs?: number;
  /** Safety cap on getOrderFills()'s client-side pagination (see its doc comment for why deep
   * paging normally isn't needed). Defaults to 5. */
  maxOrderFillsPages?: number;
  /** Safety cap on getAccountVolume()'s pagination. Exceeding this throws rather than silently
   * returning a truncated total. Defaults to 100. */
  maxVolumePages?: number;
}

type ResolvedConfig = Required<RiseXAdapterConfig>;

/**
 * RISEx's AUTHENTICATED surface: placeOrder/cancelOrder/getOrderFills/positions/margin/
 * getAccountVolume (SPEC.md Section 11, build plan step 3). This is the piece Phase 1
 * (RiseXMarketDataSource) and Phase 2 (RiseXPaperAdapter) were explicitly building toward but
 * could not themselves exercise, since both are structurally incapable of holding real
 * credentials.
 *
 * ============================================================================================
 * PROOF BAR — READ BEFORE TRUSTING THIS ADAPTER FOR ANYTHING
 * ============================================================================================
 * Unlike N1Adapter (proven via a real paper soak against live N1 in step 3) and RiseXPaperAdapter
 * (proven via a real soak against live RISEx market data in Phase 2), this class has NEVER been
 * exercised against a real RISEx endpoint. RISEx has no public testnet (SPEC.md Section 11 "No
 * public testnet") — the chain-level testnet is private-beta/access-gated — so there is currently
 * no way to run an authenticated call against RISEx without real funds and a real private key,
 * which this project's constraints (CLAUDE.md, SPEC.md Section 9) forbid doing from an AI coding
 * session regardless. Every request/response shape here is built against RISEx's documented
 * OpenAPI reference (developer.rise.trade/reference — the real API reference, distinct from the
 * marketing docs at docs.risechain.com which only link out to it), verified page-by-page during
 * development, NOT against a real captured response the way Phase 1's shapes were. Test coverage
 * is fixture/contract-level only: it proves this adapter sends and parses what the docs describe,
 * and nothing about RISEx's actual matching behavior, fill timing, or error/edge cases under real
 * conditions. Passing this test suite does NOT clear this adapter for live use — see SPEC.md
 * Section 11's "Live-readiness gate" for the required next step (real testnet access, or a
 * human-supervised minimal-size first live session — never run from an AI coding session).
 *
 * One specific unverified assumption worth flagging explicitly rather than burying in a code
 * comment: this class assumes authenticated responses are wrapped in the same `{ data,
 * request_id }` envelope Phase 1 proved live for RISEx's PUBLIC endpoints on the same host — the
 * documented schemas for the authenticated endpoints are shown unwrapped, which may just be the
 * doc generator eliding a wrapper that's actually universal across the API, or may mean these
 * endpoints genuinely don't wrap. See the private `request()` method. This is exactly the kind of
 * thing a real authenticated call would settle in minutes and that fixture tests, by construction,
 * cannot.
 *
 * Signing: only ONE real signature is ever needed — the one-time EIP-712 `Login` at connect()
 * (SPEC.md Section 11's locked "Auth" decision, JWT bearer thereafter). That signature is
 * obtained through the injected RiseXSigner interface (./RiseXSigner.ts), never performed inline
 * here — no real signing implementation exists anywhere in this codebase yet, by design; see that
 * file's doc comment.
 */
export class RiseXAdapter implements ExchangeAdapter {
  readonly exchangeId = "risex";

  private readonly registry: RiseXMarketRegistry;
  private readonly config: ResolvedConfig;

  private accessToken?: string;
  private refreshToken?: string;
  private tokenExpiresAtMs?: number;
  private connected = false;
  /** Dedupes concurrent refreshes: refreshAccountState() fires 3 authenticated calls via
   * Promise.all, and each independently calls ensureFreshToken() — without this guard, an
   * expired token would trigger 3 racing POST /v1/auth/refresh calls instead of 1, each rotating
   * the refresh_token out from under the others. */
  private refreshInFlight?: Promise<void>;

  private cachedPositions?: NormalizedPosition[];
  private cachedOpenOrders?: NormalizedOrder[];
  private cachedBalanceUsdc?: number;
  private cachedMargin?: NormalizedMarginStatus;

  constructor(
    private readonly marketData: RiseXMarketDataSource,
    private readonly signer: RiseXSigner,
    config: RiseXAdapterConfig,
  ) {
    this.registry = new RiseXMarketRegistry(config.markets);
    this.config = {
      ...config,
      usdcTokenDecimals: config.usdcTokenDecimals ?? 18,
      loginDeadlineSeconds: config.loginDeadlineSeconds ?? 120,
      tokenRefreshMarginMs: config.tokenRefreshMarginMs ?? 30_000,
      timeoutMs: config.timeoutMs ?? 10_000,
      maxOrderFillsPages: config.maxOrderFillsPages ?? 5,
      maxVolumePages: config.maxVolumePages ?? 100,
    };
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new ExchangeAdapterError("RiseXAdapter.connect() must be called before use");
    }
  }

  private requireRefreshed<T>(value: T | undefined, method: string): T {
    if (value === undefined) {
      throw new ExchangeAdapterError(
        `RiseXAdapter.${method}() called before any refreshAccountState() — no cached data`,
      );
    }
    return value;
  }

  private applyTokens(tokens: RiseXAuthTokenRaw): void {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.tokenExpiresAtMs = Date.now() + tokens.expires_in * 1000;
  }

  private async ensureFreshToken(): Promise<void> {
    if (!this.accessToken) {
      throw new ExchangeAdapterError("RiseXAdapter.connect() must be called before use");
    }
    if (
      this.tokenExpiresAtMs !== undefined &&
      Date.now() < this.tokenExpiresAtMs - this.config.tokenRefreshMarginMs
    ) {
      return;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.performRefresh().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new ExchangeAdapterError(
        "RiseXAdapter: access token expired and no refresh token is available — call connect() again",
      );
    }
    const tokens = await this.request<RiseXAuthTokenRaw>("POST", "/v1/auth/refresh", {
      body: { refresh_token: this.refreshToken } satisfies RiseXRefreshRequestRaw,
      auth: "none",
    });
    this.applyTokens(tokens);
  }

  /**
   * Shared HTTP helper for the authenticated surface — same shape as
   * RiseXMarketDataSource.getJson (timeout via AbortController, non-ok status -> retryable
   * ExchangeAdapterError), extended with JWT bearer attachment and POST body support. See this
   * class's doc comment for the flagged, unverified envelope-wrapping assumption below.
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      auth: "none" | "bearer";
    },
  ): Promise<T> {
    if (opts.auth === "bearer") {
      await this.ensureFreshToken();
    }

    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.auth === "bearer") headers["authorization"] = `Bearer ${this.accessToken}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new ExchangeAdapterError(`RISEx request to ${url} failed: ${String(err)}`, err, true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ExchangeAdapterError(
        `RISEx returned HTTP ${response.status} for ${method} ${url}: ${body.slice(0, 500)}`,
        undefined,
        response.status >= 500,
      );
    }

    // ASSUMPTION flagged in this class's doc comment: authenticated responses are wrapped in the
    // same envelope Phase 1 proved live for public endpoints. If a real authenticated call ever
    // shows otherwise, this is the one place to fix.
    const envelope = (await response.json()) as RiseXEnvelope<T>;
    return envelope.data;
  }

  async connect(): Promise<void> {
    const markets = await this.marketData.getMarkets();
    this.registry.resolve(markets);

    const domain = await this.request<RiseXEip712DomainRaw>("GET", "/v1/auth/eip712-domain", {
      auth: "none",
    });
    const nonce = await this.request<RiseXLoginNonceRaw>("GET", "/v1/auth/nonce", { auth: "none" });
    const deadline = Math.floor(Date.now() / 1000) + this.config.loginDeadlineSeconds;

    const signature = await this.signer.signLogin({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chain_id,
        verifyingContract: domain.verifying_contract,
      },
      account: this.config.account,
      nonce: nonce.nonce,
      deadline,
    });

    const loginBody: RiseXLoginRequestRaw = {
      account: this.config.account,
      nonce: nonce.nonce,
      deadline,
      signature,
    };
    const tokens = await this.request<RiseXAuthTokenRaw>("POST", "/v1/auth/login", {
      body: loginBody,
      auth: "none",
    });
    this.applyTokens(tokens);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.accessToken) {
      try {
        await this.request("POST", "/v1/auth/logout", { body: {}, auth: "bearer" });
      } catch {
        // Best-effort only — local token clearing below is what actually matters; a failed
        // logout call just means the token expires naturally server-side instead.
      }
    }
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.tokenExpiresAtMs = undefined;
    this.connected = false;
  }

  private mapOpenOrder(raw: RiseXOpenOrderRaw): NormalizedOrder {
    const market = this.registry.symbolFor(raw.market_id);
    const step = this.registry.stepConfigFor(market);
    const size = fromSteps(raw.size_steps, step.stepSize);
    return {
      exchangeOrderId: raw.order_id,
      clientOrderId: raw.client_order_id ? raw.client_order_id : undefined,
      market,
      side: riseXSideToOrderSide(raw.side),
      type: mapRiseXOrderType(raw.order_type, raw.time_in_force, raw.post_only),
      price: fromTicks(raw.price_ticks, step.stepPrice),
      size,
      // RISEx's open-orders view reports only the currently-resting size, with no separate
      // original/filled split (authTypes.ts's RiseXOpenOrderRaw doc comment) — filledSize is
      // always 0 here; callers needing real fill history must use getOrderFills(), not this view.
      // Same "document the real gap rather than fabricate a value" precedent as N1's
      // mapOpenOrder.
      filledSize: 0,
      remainingSize: size,
      isReduceOnly: raw.reduce_only,
      state: "open",
    };
  }

  private mapPosition(raw: RiseXPortfolioPositionRaw): NormalizedPosition {
    const market = this.registry.symbolFor(Number(raw.market_id));
    return {
      market,
      baseSize: decimal(raw.size),
      markPrice: decimal(raw.mark_price),
      unrealizedPnl: decimal(raw.unrealized_pnl),
      openOrderCount: (this.cachedOpenOrders ?? []).filter((o) => o.market === market).length,
    };
  }

  private mapMargin(summary: RiseXPortfolioSummaryRaw): NormalizedMarginStatus {
    const crossMarginBalance = decimal(summary.cross_margin_balance);
    const maintenanceMarginFraction =
      crossMarginBalance !== 0 ? decimal(summary.total_maintenance_margin) / crossMarginBalance : 0;
    return {
      accountValue: decimal(summary.total_account_value),
      maintenanceMarginFraction,
      // RISEx already computes this exact ratio server-side ("Initial margin / cross margin
      // balance ratio") — reused directly rather than recomputed, avoiding a second number that
      // could silently drift from RISEx's own definition.
      initialMarginFraction: decimal(summary.margin_usage),
      isAtBankruptcyRisk: summary.in_liquidation || summary.risk_level !== "NORMAL",
    };
  }

  /**
   * RISEx has no single combined snapshot endpoint the way N1's fetchInfo() is — three separate
   * calls (portfolio/details for positions+margin, orders/open, account/balance), run
   * concurrently to keep this as close to a torn-read-free single round trip as RISEx's real API
   * allows. This is an honest divergence from N1Adapter's doc comment ("should be a single round
   * trip"), not a shortcut — RISEx genuinely doesn't offer one.
   */
  async refreshAccountState(): Promise<void> {
    this.assertConnected();
    const [portfolio, openOrders, balance] = await Promise.all([
      this.request<RiseXPortfolioDetailsResponseRaw>("GET", "/v1/portfolio/details", {
        query: { account: this.config.account },
        auth: "bearer",
      }),
      this.request<RiseXOpenOrdersResponseRaw>("GET", "/v1/orders/open", {
        query: { account: this.config.account },
        auth: "bearer",
      }),
      this.request<RiseXBalanceResponseRaw>("GET", "/v1/account/balance", {
        query: { account: this.config.account, token: this.config.usdcTokenAddress },
        auth: "bearer",
      }),
    ]);

    this.cachedOpenOrders = openOrders.orders.map((o) => this.mapOpenOrder(o));
    this.cachedPositions = portfolio.positions.map((p) => this.mapPosition(p));
    this.cachedMargin = this.mapMargin(portfolio.summary);
    this.cachedBalanceUsdc = scaledIntToNumber(balance.balance, this.config.usdcTokenDecimals);
  }

  getPositions(market?: string): NormalizedPosition[] {
    const positions = this.requireRefreshed(this.cachedPositions, "getPositions");
    return market ? positions.filter((p) => p.market === market) : positions;
  }

  getOpenOrders(market?: string): NormalizedOrder[] {
    const orders = this.requireRefreshed(this.cachedOpenOrders, "getOpenOrders");
    return market ? orders.filter((o) => o.market === market) : orders;
  }

  getBalances(): NormalizedBalance[] {
    const amount = this.requireRefreshed(this.cachedBalanceUsdc, "getBalances");
    return [{ token: "USDC", amount }];
  }

  getMarginStatus(): NormalizedMarginStatus {
    return this.requireRefreshed(this.cachedMargin, "getMarginStatus");
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    this.assertConnected();
    const marketId = this.registry.marketIdFor(params.market);
    const step = this.registry.stepConfigFor(params.market);

    const priceTicks = toTicks(params.price, step.stepPrice);
    const sizeSteps = toSteps(params.size, step.stepSize);
    const fields = orderTypeToRiseXFields(params.type);

    let clientOrderId = "0";
    if (params.clientOrderId !== undefined) {
      if (!/^\d+$/.test(params.clientOrderId)) {
        return {
          success: false,
          reason: "REJECTED",
          message: `clientOrderId "${params.clientOrderId}" is not a valid RISEx uint64 client_order_id`,
        };
      }
      clientOrderId = params.clientOrderId;
    }

    const body: RiseXOrderPlaceRequestRaw = {
      market_id: marketId,
      size_steps: sizeSteps,
      price_ticks: priceTicks,
      side: orderSideToRiseXSide(params.side),
      post_only: fields.post_only,
      reduce_only: params.isReduceOnly,
      // ExpireMaker: on a self-cross, cancel our own resting order rather than the incoming one.
      // A conservative default — the locked design doesn't specify STP behavior, and canceling
      // our own resting side is the safer failure mode for a market maker.
      stp_mode: 0,
      order_type: fields.order_type,
      time_in_force: fields.time_in_force,
      builder_id: 0,
      client_order_id: clientOrderId,
      ttl_units: 0,
      builder_fee_bps: 0,
      // permit intentionally omitted — JWT bearer auth executes against the OperatorHub
      // allowance instead (SPEC.md Section 11's locked "Auth" decision; see this class's doc
      // comment).
    };

    let placed: RiseXOrderPlaceResponseRaw;
    try {
      placed = await this.request<RiseXOrderPlaceResponseRaw>("POST", "/v1/orders/place", {
        body,
        auth: "bearer",
      });
    } catch (err) {
      return {
        success: false,
        reason: "REJECTED",
        message: err instanceof Error ? err.message : String(err),
        raw: err,
      };
    }

    // RISEx's placeOrder response has no `success` field (authTypes.ts's
    // RiseXOrderPlaceResponseRaw doc comment) — 200 OK only means the transaction was submitted,
    // not that it didn't revert on-chain. This decode-tx call is the RISEx-flavored equivalent of
    // SPEC.md Section 5b's fix: never infer success from the absence of a thrown error.
    let decoded: RiseXDecodeTxResponseRaw;
    try {
      decoded = await this.request<RiseXDecodeTxResponseRaw>("GET", `/v1/tx/${placed.tx_hash}`, {
        auth: "none",
      });
    } catch (err) {
      // Fail toward UNRESOLVED, not REJECTED: the transaction WAS submitted (we have a tx_hash)
      // — a network hiccup decoding it doesn't mean the order failed, only that we can't yet
      // confirm it succeeded. Same "a verification step's own failure must not masquerade as the
      // underlying operation's failure" principle as SPEC.md Section 5a's fail-open rule.
      return {
        success: false,
        reason: "UNRESOLVED_NOT_CONFIRMED",
        message:
          `RiseXAdapter: order submitted (tx_hash ${placed.tx_hash}) but decode-tx failed to ` +
          `confirm it: ${err instanceof Error ? err.message : String(err)}`,
        raw: { placed, err },
      };
    }

    if (!decoded.success) {
      return {
        success: false,
        reason: "REJECTED",
        message: `RiseXAdapter: order transaction reverted — ${decoded.error?.name ?? "unknown error"}: ${decoded.error?.message ?? "no decoded message"}`,
        raw: { placed, decoded },
      };
    }

    const filledSize = wadToNumber(placed.filled_quantity);
    const quantizedPrice = fromTicks(priceTicks, step.stepPrice);
    const quantizedSize = fromSteps(sizeSteps, step.stepSize);

    // No per-fill price is available synchronously here — RISEx's placeOrder response reports
    // only aggregate filled_quantity/filled_percent (IOC orders only), never a per-trade price.
    // Same documented gap N1's NormalizedFill doc comment calls out for N1's own synchronous
    // fills, resolved the same way: best-effort using the order's own (quantized) price, with the
    // genuine per-trade price/tradeId available afterward via getOrderFills() once it posts to
    // trade-history.
    const fills: NormalizedFill[] =
      filledSize > 0
        ? [
            {
              exchangeOrderId: placed.order_id,
              market: params.market,
              side: params.side,
              price: quantizedPrice,
              size: filledSize,
              timestamp: Date.now(),
            },
          ]
        : [];

    const order: NormalizedOrder = {
      exchangeOrderId: placed.order_id,
      clientOrderId: params.clientOrderId,
      market: params.market,
      side: params.side,
      type: params.type,
      price: quantizedPrice,
      size: quantizedSize,
      filledSize,
      remainingSize: Math.max(0, quantizedSize - filledSize),
      isReduceOnly: params.isReduceOnly,
      state: filledSize <= 0 ? "open" : filledSize >= quantizedSize ? "filled" : "partiallyFilled",
    };

    return { success: true, order, fills };
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    this.assertConnected();
    const marketId = this.registry.marketIdFor(market);
    const body: RiseXOrderCancelRequestRaw = { market_id: marketId, order_id: exchangeOrderId };
    try {
      const result = await this.request<RiseXOrderCancelResponseRaw>("POST", "/v1/orders/cancel", {
        body,
        auth: "bearer",
      });
      // Unlike placeOrder, cancelOrder's own response already reports `success` (receipt-verified
      // server-side, per authTypes.ts's doc comment) — no separate decode-tx call needed here.
      return { success: result.success, exchangeOrderId };
    } catch (err) {
      throw new ExchangeAdapterError(
        `Failed to cancel order ${exchangeOrderId} on market ${market}`,
        err,
        true,
      );
    }
  }

  /**
   * RISEx's trade-history endpoint has no order_id filter (authTypes.ts's RiseXAccountTradeRaw
   * doc comment) — filter client-side. Bounded to maxOrderFillsPages most-recent pages: this is
   * called from SPEC.md Section 5a's cancel race-window check, for an order that was just active
   * moments ago, so its fills (if any) are necessarily very recent and will appear on the first
   * page(s) under the endpoint's default descending-time sort — deep pagination isn't needed for
   * this call's actual use case.
   */
  async getOrderFills(exchangeOrderId: string, market: string): Promise<NormalizedFill[]> {
    this.assertConnected();
    const marketId = this.registry.marketIdFor(market);
    const found: NormalizedFill[] = [];
    for (let page = 1; page <= this.config.maxOrderFillsPages; page++) {
      const response = await this.request<RiseXAccountTradeHistoryResponseRaw>(
        "GET",
        "/v1/trade-history",
        { query: { account: this.config.account, market_id: marketId, page, limit: 100 }, auth: "bearer" },
      );
      for (const trade of response.trades) {
        if (trade.order_id === exchangeOrderId) {
          found.push({
            exchangeOrderId,
            tradeId: trade.id,
            market,
            side: trade.side === "BUY" ? "buy" : "sell",
            price: decimal(trade.price),
            size: decimal(trade.size),
            timestamp: nsStringToMs(trade.time),
          });
        }
      }
      if (!response.has_next_page) break;
    }
    return found;
  }

  async getMarketPrice(market: string): Promise<MarketPrice> {
    this.assertConnected();
    const marketId = this.registry.marketIdFor(market);
    const markets = await this.marketData.getMarkets();
    const riseXMarket = markets.find((m) => m.marketId === marketId);
    if (!riseXMarket) {
      throw new ExchangeAdapterError(
        `RISEx no longer reports market "${market}" (marketId ${marketId}) in its live market list`,
      );
    }
    return mapRiseXMarketPrice(market, riseXMarket);
  }

  /**
   * Aggregates RISEx's Account Trade History endpoint over the requested since/until window —
   * the locked design decision (SPEC.md Section 11), same approach N1PaperAdapter.getAccountVolume
   * uses by precedent, rather than RISEx's dedicated Volume Stats endpoint (fixed relative
   * windows only, 1h-2w max, can't serve an arbitrary-range query). Never silently truncates: if
   * the range genuinely has more pages than maxVolumePages, this throws rather than returning a
   * partial total.
   */
  async getAccountVolume(params: {
    market?: string;
    since: string;
    until: string;
  }): Promise<AccountVolume[]> {
    this.assertConnected();
    const marketId = params.market ? this.registry.marketIdFor(params.market) : undefined;
    const sinceNs = String(BigInt(Date.parse(params.since)) * 1_000_000n);
    const untilNs = String(BigInt(Date.parse(params.until)) * 1_000_000n);

    const byMarket = new Map<number, { base: number; quote: number }>();
    for (let page = 1; page <= this.config.maxVolumePages; page++) {
      const response = await this.request<RiseXAccountTradeHistoryResponseRaw>(
        "GET",
        "/v1/trade-history",
        {
          query: {
            account: this.config.account,
            market_id: marketId,
            start_time: sinceNs,
            end_time: untilNs,
            page,
            limit: 1000,
            sorted_by: "time",
          },
          auth: "bearer",
        },
      );
      for (const trade of response.trades) {
        const agg = byMarket.get(trade.market_id) ?? { base: 0, quote: 0 };
        const size = decimal(trade.size);
        const price = decimal(trade.price);
        agg.base += size;
        agg.quote += size * price;
        byMarket.set(trade.market_id, agg);
      }
      if (!response.has_next_page) {
        return [...byMarket.entries()].map(([mid, agg]) => ({
          market: this.registry.symbolFor(mid),
          since: params.since,
          until: params.until,
          baseVolume: agg.base,
          quoteVolume: agg.quote,
        }));
      }
    }
    throw new ExchangeAdapterError(
      `RiseXAdapter.getAccountVolume: exceeded maxVolumePages (${this.config.maxVolumePages}) for ` +
        `range ${params.since}..${params.until} without exhausting trade-history — widen the page ` +
        `cap rather than silently returning a truncated total`,
    );
  }
}
