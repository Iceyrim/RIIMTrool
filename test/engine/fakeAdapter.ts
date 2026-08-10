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
} from "../../src/adapters/ExchangeAdapter.js";

/**
 * In-memory ExchangeAdapter test double. No network, no live/testnet connection — used purely
 * to drive engine unit tests against controllable, deterministic exchange behavior.
 */
export class FakeExchangeAdapter implements ExchangeAdapter {
  readonly exchangeId = "fake";

  positions: NormalizedPosition[] = [];
  openOrders: NormalizedOrder[] = [];
  balances: NormalizedBalance[] = [];
  marginStatus: NormalizedMarginStatus = {
    accountValue: 10_000,
    maintenanceMarginFraction: 0.02,
    initialMarginFraction: 0.1,
    isAtBankruptcyRisk: false,
  };
  marketPrices = new Map<string, MarketPrice>();
  fillsByOrderId = new Map<string, NormalizedFill[]>();

  /** Queue of canned results; shifted one per placeOrder() call. Falls back to a synthesized
   * success (a fresh resting order) once the queue is empty. */
  placeOrderResults: PlaceOrderResult[] = [];
  placeOrderCalls: PlaceOrderParams[] = [];
  cancelOrderCalls: { exchangeOrderId: string; market: string }[] = [];
  getOrderFillsError: Error | null = null;

  private nextOrderId = 1;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async refreshAccountState(): Promise<void> {}

  getPositions(market?: string): NormalizedPosition[] {
    return market ? this.positions.filter((p) => p.market === market) : this.positions;
  }

  getOpenOrders(market?: string): NormalizedOrder[] {
    return market ? this.openOrders.filter((o) => o.market === market) : this.openOrders;
  }

  getBalances(): NormalizedBalance[] {
    return this.balances;
  }

  getMarginStatus(): NormalizedMarginStatus {
    return this.marginStatus;
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    this.placeOrderCalls.push(params);
    const queued = this.placeOrderResults.shift();
    if (queued) return queued;

    const exchangeOrderId = String(this.nextOrderId++);
    const order: NormalizedOrder = {
      exchangeOrderId,
      clientOrderId: params.clientOrderId,
      market: params.market,
      side: params.side,
      type: params.type,
      price: params.price,
      size: params.size,
      filledSize: 0,
      remainingSize: params.size,
      isReduceOnly: params.isReduceOnly,
      state: "open",
    };
    this.openOrders.push(order);
    return { success: true, order, fills: [] };
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    this.cancelOrderCalls.push({ exchangeOrderId, market });
    this.openOrders = this.openOrders.filter((o) => o.exchangeOrderId !== exchangeOrderId);
    return { success: true, exchangeOrderId };
  }

  async getOrderFills(exchangeOrderId: string, _market: string): Promise<NormalizedFill[]> {
    if (this.getOrderFillsError) throw this.getOrderFillsError;
    return this.fillsByOrderId.get(exchangeOrderId) ?? [];
  }

  async getMarketPrice(market: string): Promise<MarketPrice> {
    const price = this.marketPrices.get(market);
    if (!price) throw new Error(`FakeExchangeAdapter: no market price configured for ${market}`);
    return price;
  }

  async getAccountVolume(): Promise<AccountVolume[]> {
    return [];
  }
}
