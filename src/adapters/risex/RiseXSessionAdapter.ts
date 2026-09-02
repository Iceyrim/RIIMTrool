import { ExchangeAdapterError } from "../AdapterError.js";
import type {
  AccountVolume, CancelOrderResult, ExchangeAdapter, MarketPrice, NormalizedBalance,
  NormalizedFill, NormalizedMarginStatus, NormalizedOrder, NormalizedPosition,
  PlaceOrderParams, PlaceOrderResult,
} from "../ExchangeAdapter.js";
import type {
  RiseXAccountTradeHistoryResponseRaw, RiseXOpenOrderRaw, RiseXOpenOrdersResponseRaw,
  RiseXPortfolioDetailsResponseRaw,
} from "./authTypes.js";
import { decimal, nsStringToMs, type RiseXMarketDataSource } from "./RiseXMarketDataSource.js";
import { RiseXMarketRegistry, type ConfiguredRiseXMarket } from "./marketRegistry.js";
import { fromSteps, fromTicks, mapRiseXOrderType, riseXSideToOrderSide } from "./riseXAuthMappers.js";
import type { RiseXPermitExecutionTransport } from "./RiseXPermitExecutionTransport.js";

interface Envelope<T> { data: T }

export interface RiseXSessionAdapterConfig {
  baseUrl: string;
  account: string;
  markets: ConfiguredRiseXMarket[];
  timeoutMs?: number;
  maxTradeHistoryPages?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Session-signer live adapter. Account truth is refreshed independently from account-scoped
 * read endpoints; only place/cancel crosses the injected permit execution boundary.
 */
export class RiseXSessionAdapter implements ExchangeAdapter {
  readonly exchangeId = "risex-session-live";
  private readonly registry: RiseXMarketRegistry;
  private readonly timeoutMs: number;
  private readonly maxTradeHistoryPages: number;
  private readonly fetchImpl: typeof fetch;
  private connected = false;
  private positions?: NormalizedPosition[];
  private orders?: NormalizedOrder[];
  private balance?: number;
  private margin?: NormalizedMarginStatus;

  constructor(
    private readonly marketData: RiseXMarketDataSource,
    private readonly execution: RiseXPermitExecutionTransport | undefined,
    private readonly config: RiseXSessionAdapterConfig,
  ) {
    this.registry = new RiseXMarketRegistry(config.markets);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxTradeHistoryPages = config.maxTradeHistoryPages ?? 100;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async connect(): Promise<void> {
    this.registry.resolve(await this.marketData.getMarkets());
    await this.execution?.connect();
    this.connected = true;
    await this.refreshAccountState();
  }

  async disconnect(): Promise<void> {
    this.execution?.disconnect();
    this.connected = false;
  }

  async refreshAccountState(): Promise<void> {
    this.assertConnected();
    const [portfolio, open] = await Promise.all([
      this.request<RiseXPortfolioDetailsResponseRaw>("/v1/portfolio/details", { account: this.config.account }),
      this.request<RiseXOpenOrdersResponseRaw>("/v1/orders/open", { account: this.config.account }),
    ]);
    this.orders = open.orders.map((order) => this.mapOrder(order));
    this.execution?.seedOpenOrderIdentities(open.orders.map((order) => ({
      exchangeOrderId: order.order_id,
      restingOrderId: order.resting_order_id,
    })));
    this.positions = portfolio.positions.map((position) => {
      const market = this.registry.symbolFor(Number(position.market_id));
      return {
        market,
        baseSize: decimal(position.size),
        markPrice: decimal(position.mark_price),
        unrealizedPnl: decimal(position.unrealized_pnl),
        openOrderCount: this.orders!.filter((order) => order.market === market).length,
      };
    });
    const summary = portfolio.summary;
    this.balance = decimal(summary.usdc_balance);
    const cross = decimal(summary.cross_margin_balance);
    this.margin = {
      accountValue: decimal(summary.total_account_value),
      maintenanceMarginFraction: cross === 0 ? 0 : decimal(summary.total_maintenance_margin) / cross,
      initialMarginFraction: decimal(summary.margin_usage),
      isAtBankruptcyRisk: summary.in_liquidation || summary.risk_level !== "NORMAL",
    };
  }

  getPositions(market?: string): NormalizedPosition[] {
    const rows = this.require(this.positions, "positions");
    return market ? rows.filter((row) => row.market === market) : rows;
  }
  getOpenOrders(market?: string): NormalizedOrder[] {
    const rows = this.require(this.orders, "open orders");
    return market ? rows.filter((row) => row.market === market) : rows;
  }
  getBalances(): NormalizedBalance[] { return [{ token: "USDC", amount: this.require(this.balance, "balance") }]; }
  getMarginStatus(): NormalizedMarginStatus { return this.require(this.margin, "margin"); }
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    if (!this.execution) return Promise.resolve({ success: false, reason: "REJECTED", message: "RISEx execution is not armed" });
    return this.execution.placeOrder(params);
  }
  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    if (!this.execution) throw new ExchangeAdapterError("RISEx execution is not armed");
    return this.execution.cancelOrder(exchangeOrderId, market);
  }

  async getOrderFills(exchangeOrderId: string, market: string): Promise<NormalizedFill[]> {
    const marketId = this.registry.marketIdFor(market);
    const rows = await this.tradeHistory({ market_id: marketId });
    return rows.filter((trade) => trade.order_id === exchangeOrderId).map((trade) => ({
      exchangeOrderId, tradeId: trade.id, market,
      side: trade.side === "BUY" ? "buy" : "sell",
      price: decimal(trade.price), size: decimal(trade.size), timestamp: nsStringToMs(trade.time),
    }));
  }

  async getMarketPrice(market: string): Promise<MarketPrice> {
    const marketId = this.registry.marketIdFor(market);
    const found = (await this.marketData.getMarkets()).find((row) => row.marketId === marketId);
    if (!found) throw new ExchangeAdapterError(`RISEx market ${market} is unavailable`);
    return { market, mark: found.markPrice, index: found.indexPrice };
  }

  async getAccountVolume(params: { market?: string; since: string; until: string }): Promise<AccountVolume[]> {
    const marketId = params.market ? this.registry.marketIdFor(params.market) : undefined;
    const trades = await this.tradeHistory({
      market_id: marketId,
      start_time: String(BigInt(Date.parse(params.since)) * 1_000_000n),
      end_time: String(BigInt(Date.parse(params.until)) * 1_000_000n),
    });
    const totals = new Map<number, { base: number; quote: number }>();
    for (const trade of trades) {
      const current = totals.get(trade.market_id) ?? { base: 0, quote: 0 };
      const size = decimal(trade.size);
      current.base += size;
      current.quote += size * decimal(trade.price);
      totals.set(trade.market_id, current);
    }
    return [...totals].map(([id, total]) => ({ market: this.registry.symbolFor(id), marketId: id, since: params.since, until: params.until, baseVolume: total.base, quoteVolume: total.quote }));
  }

  private async tradeHistory(query: Record<string, string | number | undefined>) {
    const collected: RiseXAccountTradeHistoryResponseRaw["trades"] = [];
    for (let page = 1; page <= this.maxTradeHistoryPages; page++) {
      const result = await this.request<RiseXAccountTradeHistoryResponseRaw>("/v1/trade-history", { account: this.config.account, ...query, page, limit: 1000, sorted_by: "time" });
      collected.push(...result.trades);
      if (!result.has_next_page) return collected;
    }
    throw new ExchangeAdapterError("RISEx trade history exceeded the configured page safety cap");
  }

  private mapOrder(raw: RiseXOpenOrderRaw): NormalizedOrder {
    const market = this.registry.symbolFor(raw.market_id);
    const step = this.registry.stepConfigFor(market);
    const size = fromSteps(raw.size_steps, step.stepSize);
    return { exchangeOrderId: raw.order_id, clientOrderId: raw.client_order_id || undefined, market,
      side: riseXSideToOrderSide(raw.side), type: mapRiseXOrderType(raw.order_type, raw.time_in_force, raw.post_only),
      price: fromTicks(raw.price_ticks, step.stepPrice), size, filledSize: 0, remainingSize: size,
      isReduceOnly: raw.reduce_only, state: "open" };
  }

  private assertConnected(): void { if (!this.connected) throw new ExchangeAdapterError("RISEx session adapter is disconnected"); }
  private require<T>(value: T | undefined, name: string): T { if (value === undefined) throw new ExchangeAdapterError(`RISEx ${name} snapshot is unavailable`); return value; }
  private async request<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new ExchangeAdapterError(`RISEx returned HTTP ${response.status} for ${path}`);
      const parsed = await response.json() as T | Envelope<T>;
      return parsed && typeof parsed === "object" && "data" in parsed ? (parsed as Envelope<T>).data : parsed as T;
    } catch (error) {
      if (error instanceof ExchangeAdapterError) throw error;
      throw new ExchangeAdapterError(`RISEx account read failed for ${path}: ${String(error)}`, error, true);
    } finally { clearTimeout(timer); }
  }
}
