import { Nord, NordUser, Side } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
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
import { MarketRegistry, type ConfiguredMarket } from "./marketRegistry.js";
import {
  mapBalance,
  mapFill,
  mapMarginStatus,
  mapMarketPrice,
  mapOpenOrder,
  mapPosition,
  orderSideToN1Side,
  orderTypeToFillMode,
} from "./mappers.js";

export interface N1AdapterConfig {
  webServerUrl: string;
  appAddr: string;
  solanaRpcUrl: string;
  /** Raw private key material. Callers must source this from a real secret store / .env at the
   * process boundary — never hardcode it, never let it pass through an AI coding session
   * (SPEC.md Section 9.1). */
  privateKey: string;
  markets: ConfiguredMarket[];
}

/**
 * N1 (Nord) implementation of ExchangeAdapter. This is the ONLY file (along with mappers.ts and
 * marketRegistry.ts in this directory) permitted to import `@n1xyz/nord-ts` — SPEC.md Section 1b.
 *
 * v1 uses REST polling only: refreshAccountState() must be called once per market-loop cycle,
 * and getPositions/getOpenOrders/getBalances/getMarginStatus all read from that cached snapshot
 * rather than issuing their own request each time. This mirrors how NordUser itself actually
 * works (fetchInfo() populates .positions/.orders/.balances/.margins together, then those are
 * read synchronously) and avoids a torn read across a market-loop cycle.
 */
export class N1Adapter implements ExchangeAdapter {
  readonly exchangeId = "n1";

  private readonly registry: MarketRegistry;
  private nord?: Nord;
  private user?: NordUser;
  private accountId?: number;

  constructor(private readonly config: N1AdapterConfig) {
    this.registry = new MarketRegistry(config.markets);
  }

  private assertConnected(): void {
    if (!this.nord || !this.user || this.accountId === undefined) {
      throw new ExchangeAdapterError("N1Adapter.connect() must be called before use");
    }
  }

  async connect(): Promise<void> {
    const solanaConnection = new Connection(this.config.solanaRpcUrl);
    this.nord = await Nord.new({
      webServerUrl: this.config.webServerUrl,
      app: this.config.appAddr,
      solanaConnection,
    });

    // Explicit call even though Nord.new()'s internal init likely already does this — cheap,
    // idempotent, and removes any doubt that `nord.markets` is populated before we resolve
    // configured symbols against it.
    await this.nord.fetchNordInfo();
    this.registry.resolve(this.nord.markets);

    this.user = NordUser.fromPrivateKey(this.nord, this.config.privateKey);
    await this.user.updateAccountId();

    const accountId = this.user.accountIds?.[0];
    if (accountId === undefined) {
      throw new ExchangeAdapterError(
        "N1 account has no accountIds after updateAccountId() — is this wallet registered on N1?",
      );
    }
    this.accountId = accountId;

    await this.user.fetchInfo();
  }

  /** Exposes the underlying connected Nord client and accountId — not part of ExchangeAdapter,
   * N1-specific. Exists for callers that need N1 account-history endpoints beyond what
   * ExchangeAdapter's normalized surface covers (currently only N1RealizedPnlSource, wired up in
   * scripts/run-live.ts). */
  getNordClient(): Nord {
    this.assertConnected();
    return this.nord!;
  }

  getAccountId(): number {
    this.assertConnected();
    return this.accountId!;
  }

  async disconnect(): Promise<void> {
    // v1 is REST-polling only (no WebSocket subscriptions), so there is no live connection to
    // tear down. Kept as an explicit no-op so the interface stays symmetric for adapters (or a
    // future N1 WS-based revision) that do hold one.
  }

  async refreshAccountState(): Promise<void> {
    this.assertConnected();
    await this.user!.fetchInfo();
  }

  getPositions(market?: string): NormalizedPosition[] {
    this.assertConnected();
    const raw = this.user!.positions[String(this.accountId)] ?? [];
    const mapped = raw
      .map((p) => mapPosition(p, this.registry))
      .filter((p): p is NormalizedPosition => p !== null);
    return market ? mapped.filter((p) => p.market === market) : mapped;
  }

  getOpenOrders(market?: string): NormalizedOrder[] {
    this.assertConnected();
    const raw = this.user!.orders[String(this.accountId)] ?? [];
    const mapped = raw.map((o) => mapOpenOrder(o, this.registry));
    return market ? mapped.filter((o) => o.market === market) : mapped;
  }

  getBalances(): NormalizedBalance[] {
    this.assertConnected();
    const raw = this.user!.balances[String(this.accountId)] ?? [];
    return raw.map(mapBalance);
  }

  getMarginStatus(): NormalizedMarginStatus {
    this.assertConnected();
    const raw = this.user!.margins[String(this.accountId)];
    if (!raw) {
      throw new ExchangeAdapterError(
        `No margin data cached for account ${this.accountId} — call refreshAccountState() first`,
      );
    }
    return mapMarginStatus(raw);
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    this.assertConnected();
    const marketId = this.registry.marketIdFor(params.market);

    let clientOrderId: bigint | undefined;
    if (params.clientOrderId !== undefined) {
      try {
        clientOrderId = BigInt(params.clientOrderId);
      } catch (err) {
        return {
          success: false,
          reason: "REJECTED",
          message: `clientOrderId "${params.clientOrderId}" is not a valid integer`,
          raw: err,
        };
      }
    }

    try {
      const result = await this.user!.placeOrder({
        marketId,
        side: orderSideToN1Side(params.side) === "bid" ? Side.Bid : Side.Ask,
        fillMode: orderTypeToFillMode(params.type),
        isReduceOnly: params.isReduceOnly,
        size: params.size,
        price: params.price,
        clientOrderId,
      });

      // SPEC.md Section 5b: a resolved call with neither an orderId nor any fills is a silent
      // no-op on N1's side. This must never be treated as success just because the promise
      // didn't reject — that exact gap is how a real reduction-mode exit order sat unmanaged
      // for ~12 hours in the predecessor system.
      if (result.orderId === undefined && result.fills.length === 0) {
        return {
          success: false,
          reason: "UNRESOLVED_NOT_CONFIRMED",
          message:
            "N1 placeOrder() resolved without an orderId or any fills — not confirmed on exchange",
          raw: result,
        };
      }

      // Fills reported synchronously here carry no tradeId (N1's placeOrder response type omits
      // it) — see NormalizedFill's doc comment. Trade-level detail with a real tradeId comes from
      // getOrderFills() once the order is resting.
      const fills: NormalizedFill[] = result.fills.map((f) => ({
        exchangeOrderId: String(f.orderId),
        market: params.market,
        side: params.side,
        price: f.price,
        size: f.size,
        timestamp: Date.now(),
      }));

      const filledSize = fills.reduce((sum, f) => sum + f.size, 0);
      const exchangeOrderId =
        result.orderId !== undefined ? String(result.orderId) : String(result.actionId);

      const order: NormalizedOrder = {
        exchangeOrderId,
        clientOrderId: params.clientOrderId,
        market: params.market,
        side: params.side,
        type: params.type,
        price: params.price,
        size: params.size,
        filledSize,
        remainingSize: Math.max(0, params.size - filledSize),
        isReduceOnly: params.isReduceOnly,
        state:
          result.orderId === undefined
            ? filledSize >= params.size
              ? "filled"
              : "partiallyFilled"
            : filledSize > 0
              ? "partiallyFilled"
              : "open",
      };

      return { success: true, order, fills };
    } catch (err) {
      return {
        success: false,
        reason: "REJECTED",
        message: err instanceof Error ? err.message : String(err),
        raw: err,
      };
    }
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    this.assertConnected();
    try {
      const result = await this.user!.cancelOrder(BigInt(exchangeOrderId));
      return { success: true, exchangeOrderId: String(result.orderId) };
    } catch (err) {
      throw new ExchangeAdapterError(
        `Failed to cancel order ${exchangeOrderId} on market ${market}`,
        err,
        true,
      );
    }
  }

  async getOrderFills(exchangeOrderId: string, _market: string): Promise<NormalizedFill[]> {
    this.assertConnected();
    // N1's getOrderTrades takes a `number` orderId; order ids observed in practice fit safely
    // in a JS number, but this is worth confirming against real account data before relying on
    // it for very large ids.
    const page = await this.nord!.getOrderTrades(Number(exchangeOrderId));
    return page.items.map((trade) => mapFill(trade, this.registry, this.accountId!));
  }

  async getMarketPrice(market: string): Promise<MarketPrice> {
    this.assertConnected();
    const marketId = this.registry.marketIdFor(market);
    const stats = await this.nord!.getMarketStats({ marketId });
    return mapMarketPrice(market, stats);
  }

  async getAccountVolume(params: {
    market?: string;
    since: string;
    until: string;
  }): Promise<AccountVolume[]> {
    this.assertConnected();
    const marketId = params.market ? this.registry.marketIdFor(params.market) : undefined;
    const rows = await this.nord!.getAccountVolume({
      accountId: this.accountId!,
      since: params.since,
      until: params.until,
      marketId,
      // GetAccountVolumeQuery's type requires marketIds even though Nord.getAccountVolume only
      // actually destructures the deprecated singular `marketId` at runtime — the SDK's type
      // and its own implementation disagree here. Passing an empty array satisfies the type
      // without changing behavior.
      marketIds: marketId !== undefined ? [marketId] : [],
    });
    return rows.map((row) => ({
      market: this.registry.symbolFor(row.marketId),
      since: params.since,
      until: params.until,
      baseVolume: row.volumeBase,
      quoteVolume: row.volumeQuote,
    }));
  }
}
