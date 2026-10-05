import type {
  AccountVolume, CancelOrderResult, ExchangeAdapter, MarketPrice, NormalizedBalance,
  NormalizedFill, NormalizedMarginStatus, NormalizedOrder, NormalizedPosition,
  PlaceOrderParams, PlaceOrderResult,
} from "../ExchangeAdapter.js";
import { ExchangeAdapterError } from "../AdapterError.js";
import { QfexMarketRegistry } from "./QfexMarketRegistry.js";
import type { QfexBalanceRaw, QfexConfiguredMarket, QfexFillRaw, QfexMessage, QfexOrderRaw, QfexPositionRaw } from "./types.js";
import type { QfexWebSocketTransport } from "./QfexWebSocketTransport.js";

const OPEN = new Set(["ACK", "OPEN", "PARTIALLY_FILLED", "PARTIAL_FILL", "MODIFIED"]);
const REJECTED = new Set(["REJECTED", "INVALID", "ERROR"]);
const n = (value: unknown, field: string): number => {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new ExchangeAdapterError(`Invalid QFEX ${field}`);
  return result;
};
const fillTimestampMs = (value: unknown): number => {
  const timestamp = n(value, "fill timestamp");
  return timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000;
};
const TRADE_HISTORY_PAGE_SIZE = 200;
const MAX_TRADE_HISTORY_PAGES = 1_000;

export function normalizeQfexOrder(params: Pick<PlaceOrderParams, "market" | "side" | "price" | "size">, constraints: QfexConfiguredMarket): { price: number; size: number } {
  const ticks = params.price / constraints.priceTickSize;
  const priceTicks = params.side === "buy" ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9);
  const price = Number((priceTicks * constraints.priceTickSize).toFixed(12));
  const sizeSteps = Math.floor((params.size + constraints.quantityStep * 1e-9) / constraints.quantityStep);
  const size = Number((sizeSteps * constraints.quantityStep).toFixed(12));
  if (size + 1e-12 < constraints.minimumOrderSize) {
    throw new ExchangeAdapterError("QFEX order size normalizes below configured minimum");
  }
  return { price, size };
}

export class QfexAdapter implements ExchangeAdapter {
  readonly exchangeId = "qfex-live";
  private readonly registry: QfexMarketRegistry;
  private readonly orders = new Map<string, QfexOrderRaw>();
  private readonly terminalOrders = new Set<string>();
  private readonly positions = new Map<string, QfexPositionRaw>();
  private readonly fills = new Map<string, QfexFillRaw[]>();
  private readonly marks = new Map<string, number>();
  private balance?: QfexBalanceRaw;
  private unsubscribe?: () => void;
  private connected = false;
  private tradeHistoryTail: Promise<void> = Promise.resolve();

  constructor(private readonly transport: QfexWebSocketTransport, markets: QfexConfiguredMarket[]) {
    this.registry = new QfexMarketRegistry(markets);
  }

  private handle = (message: QfexMessage): void => {
    const order = message.order_response;
    if (order) {
      if (OPEN.has(order.status.toUpperCase()) && n(order.quantity_remaining, "remaining quantity") > 0) {
        this.terminalOrders.delete(order.order_id);
        this.orders.set(order.order_id, order);
      } else {
        this.orders.delete(order.order_id);
        this.terminalOrders.add(order.order_id);
      }
    }
    const fill = message.fill_response;
    if (fill) {
      const rows = this.fills.get(fill.order_id) ?? [];
      if (!rows.some((row) => row.trade_id === fill.trade_id)) rows.push(fill);
      this.fills.set(fill.order_id, rows);
    }
    if (message.position_response) this.positions.set(message.position_response.symbol, message.position_response);
    if (message.balance_response) this.balance = message.balance_response;
    if (message.type === "mark_price" && typeof message.symbol === "string") this.marks.set(message.symbol, n(message.price, "mark price"));
    if (message.type === "bbo" && typeof message.symbol === "string" && !this.marks.has(message.symbol)) {
      const bid = Array.isArray(message.bid) ? message.bid[0] : undefined;
      const ask = Array.isArray(message.ask) ? message.ask[0] : undefined;
      if (Array.isArray(bid) && Array.isArray(ask)) this.marks.set(message.symbol, (n(bid[0], "bid") + n(ask[0], "ask")) / 2);
    }
  };

  async connect(): Promise<void> {
    this.unsubscribe = this.transport.onMessage(this.handle);
    await this.transport.connect();
    this.connected = true;
    await this.refreshAccountState();
  }
  async disconnect(): Promise<void> {
    this.unsubscribe?.();
    await this.transport.disconnect();
    this.connected = false;
  }
  private assertConnected(): void {
    if (!this.connected) throw new ExchangeAdapterError("QfexAdapter.connect() must be called first");
  }

  async refreshAccountState(): Promise<void> {
    this.assertConnected();
    const response = await this.transport.request(
      { type: "get_user_orders", params: { limit: 1000, offset: 0 } },
      (message) => typeof message.all_orders_response === "object",
      "open-order snapshot",
    );
    const snapshot = response.all_orders_response as { orders?: QfexOrderRaw[] };
    const previouslyOpen = new Set(this.orders.keys());
    this.orders.clear();
    for (const order of snapshot.orders ?? []) {
      if (OPEN.has(order.status.toUpperCase()) && n(order.quantity_remaining, "remaining quantity") > 0) {
        this.terminalOrders.delete(order.order_id);
        previouslyOpen.delete(order.order_id);
        this.orders.set(order.order_id, order);
      } else {
        this.terminalOrders.add(order.order_id);
        previouslyOpen.delete(order.order_id);
      }
    }
    for (const orderId of previouslyOpen) this.terminalOrders.add(orderId);
  }

  private mapOrder(row: QfexOrderRaw): NormalizedOrder {
    const quantity = n(row.quantity, "order quantity");
    const remaining = n(row.quantity_remaining, "remaining quantity");
    const status = row.status.toUpperCase();
    return {
      exchangeOrderId: row.order_id,
      clientOrderId: row.client_order_id || undefined,
      market: this.registry.logicalSymbolFor(row.symbol),
      side: row.side === "BUY" ? "buy" : "sell",
      type: (row.type ?? row.order_type) === "ALO" ? "postOnly" : "limit",
      price: n(row.price, "order price"),
      size: quantity,
      filledSize: Math.max(0, quantity - remaining),
      remainingSize: remaining,
      isReduceOnly: row.reduce_only === true || row.reduce_only === 1,
      state: status.includes("PARTIAL") ? "partiallyFilled" : "open",
    };
  }

  getPositions(market?: string): NormalizedPosition[] {
    this.assertConnected();
    const symbols = market ? [market] : this.registry.exchangeSymbols().map((symbol) => this.registry.logicalSymbolFor(symbol));
    return symbols.map((logical) => {
      const exchange = this.registry.exchangeSymbolFor(logical);
      const row = this.positions.get(exchange);
      return { market: logical, baseSize: row ? n(row.position, "position") : 0, markPrice: this.marks.get(exchange) ?? 0, unrealizedPnl: row ? n(row.unrealised_pnl, "unrealised PnL") : 0, openOrderCount: row ? n(row.open_orders, "open orders") : 0 };
    });
  }
  getOpenOrders(market?: string): NormalizedOrder[] {
    this.assertConnected();
    return [...this.orders.values()].filter((row) => !market || row.symbol === this.registry.exchangeSymbolFor(market)).map((row) => this.mapOrder(row));
  }
  getBalances(): NormalizedBalance[] {
    this.assertConnected();
    if (!this.balance) throw new ExchangeAdapterError("QFEX balance snapshot has not arrived");
    return [{ token: "USD", amount: n(this.balance.available_balance, "available balance") }];
  }
  getMarginStatus(): NormalizedMarginStatus {
    this.assertConnected();
    if (!this.balance) throw new ExchangeAdapterError("QFEX balance snapshot has not arrived");
    const reserved = n(this.balance.order_margin, "order margin") + n(this.balance.position_margin, "position margin");
    const available = n(this.balance.available_balance, "available balance");
    const accountValue = available + reserved;
    const maintenance = [...this.positions.values()].reduce((sum, row) => sum + n(row.maintenance_margin, "maintenance margin"), 0);
    return { accountValue, maintenanceMarginFraction: accountValue > 0 ? maintenance / accountValue : 1, initialMarginFraction: accountValue > 0 ? reserved / accountValue : 1, isAtBankruptcyRisk: accountValue <= maintenance };
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    this.assertConnected();
    const clientOrderId = params.clientOrderId ?? crypto.randomUUID();
    const exchangeSymbol = this.registry.exchangeSymbolFor(params.market);
    let normalized: { price: number; size: number };
    try {
      normalized = normalizeQfexOrder(params, this.registry.constraintsFor(params.market));
    } catch (error) {
      return { success: false, reason: "REJECTED", message: error instanceof Error ? error.message : String(error) };
    }
    const response = await this.transport.request(
      { type: "add_order", params: { symbol: exchangeSymbol, side: params.side === "buy" ? "BUY" : "SELL", order_type: params.type === "postOnly" ? "ALO" : "LIMIT", order_time_in_force: params.type === "immediateOrCancel" ? "IOC" : params.type === "fillOrKill" ? "FOK" : "GTC", quantity: normalized.size, price: normalized.price, take_profit: 0, stop_loss: 0, reduce_only: params.isReduceOnly, client_order_id: clientOrderId } },
      (message) => message.order_response?.client_order_id === clientOrderId,
      "order acknowledgement",
    );
    const row = { ...response.order_response!, reduce_only: params.isReduceOnly };
    if (REJECTED.has(row.status.toUpperCase())) return { success: false, reason: "REJECTED", message: `QFEX rejected order: ${row.status}` };
    if (!row.order_id) return { success: false, reason: "UNRESOLVED_NOT_CONFIRMED", message: "QFEX acknowledgement omitted order ID" };
    this.handle(response);
    return { success: true, order: this.mapOrder(row), fills: this.mapFills(this.fills.get(row.order_id) ?? []) };
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    this.assertConnected();
    const response = await this.transport.request(
      { type: "cancel_order", params: { order_id: exchangeOrderId, symbol: this.registry.exchangeSymbolFor(market), cancel_order_id_type: "order_id" } },
      (message) => message.order_response?.order_id === exchangeOrderId,
      "cancel acknowledgement",
    );
    const success = response.order_response?.status.toUpperCase() === "CANCELLED";
    if (success) {
      this.orders.delete(exchangeOrderId);
      this.terminalOrders.add(exchangeOrderId);
    }
    return { success, exchangeOrderId };
  }

  private mapFills(rows: QfexFillRaw[]): NormalizedFill[] {
    return rows.map((row) => ({ exchangeOrderId: row.order_id, tradeId: row.trade_id, market: this.registry.logicalSymbolFor(row.symbol), side: (row.side ?? row.aggressor_side) === "BUY" ? "buy" : "sell", price: n(row.price, "fill price"), size: n(row.quantity, "fill quantity"), timestamp: fillTimestampMs(row.timestamp) }));
  }
  private enqueueUserTrades(params: Record<string, unknown>, description: string): Promise<QfexFillRaw[]> {
    const run = this.tradeHistoryTail.then(async () => {
      const response = await this.transport.request(
        { type: "get_user_trades", params },
        (message) => Array.isArray(message.user_trades_response) || Array.isArray(message.user_trades),
        description,
      );
      return response.user_trades_response ?? response.user_trades ?? [];
    });
    this.tradeHistoryTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async getUserTradesWindow(params: { since: string; until: string }): Promise<QfexFillRaw[]> {
    const startTs = Date.parse(params.since);
    const endTs = Date.parse(params.until);
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || startTs > endTs) {
      throw new ExchangeAdapterError("Invalid QFEX trade-history window");
    }
    const unique = new Map<string, QfexFillRaw>();
    for (let page = 0; page < MAX_TRADE_HISTORY_PAGES; page++) {
      const rows = await this.enqueueUserTrades(
        {
          limit: TRADE_HISTORY_PAGE_SIZE,
          offset: page * TRADE_HISTORY_PAGE_SIZE,
          // QFEX production expects unix milliseconds, not seconds.
          start_ts: startTs,
          end_ts: endTs,
        },
        `account trades page ${page + 1}`,
      );
      const before = unique.size;
      for (const row of rows) unique.set(row.trade_id, row);
      if (rows.length < TRADE_HISTORY_PAGE_SIZE) return [...unique.values()];
      if (unique.size === before) {
        throw new ExchangeAdapterError("QFEX trade-history pagination repeated without progress");
      }
    }
    throw new ExchangeAdapterError("QFEX trade-history pagination exceeded the safety limit");
  }

  async getOrderFills(exchangeOrderId: string): Promise<NormalizedFill[]> {
    this.assertConnected();
    const cached = this.fills.get(exchangeOrderId) ?? [];
    // A terminal update or authenticated snapshot already proved this order is no longer live.
    // Return realtime fill evidence immediately instead of queueing behind volume-history reads.
    if (this.terminalOrders.has(exchangeOrderId)) return this.mapFills(cached);
    try {
      const rows = await this.enqueueUserTrades(
        { limit: 1000, offset: 0 },
        "order fills",
      );
      const merged = new Map<string, QfexFillRaw>();
      for (const row of cached) merged.set(row.trade_id, row);
      for (const row of rows) if (row.order_id === exchangeOrderId) merged.set(row.trade_id, row);
      return this.mapFills([...merged.values()]);
    } catch (error) {
      if (cached.length > 0) return this.mapFills(cached);
      throw error;
    }
  }
  async getMarketPrice(market: string): Promise<MarketPrice> {
    this.assertConnected();
    const exchange = this.registry.exchangeSymbolFor(market);
    const mark = this.marks.get(exchange);
    if (!mark) throw new ExchangeAdapterError("No fresh QFEX mark for " + market, undefined, true);
    return { market, mark };
  }
  private volumeRows(rows: QfexFillRaw[], params: { market?: string; since: string; until: string }): AccountVolume[] {
    const exchange = params.market ? this.registry.exchangeSymbolFor(params.market) : undefined;
    const sinceMs = Date.parse(params.since);
    const untilMs = Date.parse(params.until);
    const configuredSymbols = new Set(this.registry.exchangeSymbols());
    const selected = rows.filter((row) => {
      if (exchange ? row.symbol !== exchange : !configuredSymbols.has(row.symbol)) return false;
      // Production history rows omit timestamps. In that case the server-side millisecond
      // window used by getUserTradesWindow() is authoritative. Retain client-side filtering for
      // real-time/test rows that do carry timestamps.
      if (row.timestamp === undefined) return true;
      const timestampMs = fillTimestampMs(row.timestamp);
      return timestampMs >= sinceMs && timestampMs <= untilMs;
    });
    return [{ market: params.market ?? null, since: params.since, until: params.until, baseVolume: selected.reduce((sum, row) => sum + n(row.quantity, "trade quantity"), 0), quoteVolume: selected.reduce((sum, row) => sum + n(row.quantity, "trade quantity") * n(row.price, "trade price"), 0) }];
  }
  async getAccountVolume(params: { market?: string; since: string; until: string }): Promise<AccountVolume[]> {
    this.assertConnected();
    const rows = await this.getUserTradesWindow(params);
    return this.volumeRows(rows, params);
  }
  async getAccountVolumeWindows(requests: Array<{ window: string; since: string; until: string }>): Promise<Record<string, AccountVolume[]>> {
    this.assertConnected();
    const result: Record<string, AccountVolume[]> = {};
    // Production history rows have no timestamp, so each window must be filtered by QFEX rather
    // than partitioned locally from one broad response.
    for (const request of requests) {
      result[request.window] = await this.getAccountVolume(request);
    }
    return result;
  }
}
