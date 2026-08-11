import type {
  AccountVolume,
  CancelOrderResult,
  ExchangeAdapter,
  NormalizedBalance,
  NormalizedFill,
  NormalizedMarginStatus,
  NormalizedOrder,
  NormalizedPosition,
  OrderSide,
  OrderType,
  MarketPrice,
  PlaceOrderParams,
  PlaceOrderResult,
} from "../ExchangeAdapter.js";
import { ExchangeAdapterError } from "../AdapterError.js";
import { simulateFills, type SimulatedRestingOrder, type TradeTapePrint } from "../shared/paperFillSimulator.js";
import { mapRiseXMarketPrice, quantizeToStep } from "./mappers.js";
import { RiseXMarketRegistry, type ConfiguredRiseXMarket } from "./marketRegistry.js";
import type { RiseXMarketDataSource } from "./RiseXMarketDataSource.js";

interface SimOrder {
  exchangeOrderId: string;
  clientOrderId?: string;
  market: string;
  side: OrderSide;
  type: OrderType;
  price: number;
  size: number;
  filledSize: number;
  isReduceOnly: boolean;
}

interface SimPosition {
  baseSize: number;
  /** Average-cost entry price. 0 when flat. */
  entryPrice: number;
}

export interface RiseXPaperAdapterConfig {
  markets: ConfiguredRiseXMarket[];
  startingBalanceUsdc: number;
}

/**
 * ExchangeAdapter pairing REAL RISEx public market data (RiseXMarketDataSource) with entirely
 * SIMULATED execution — no order ever reaches the real exchange, no wallet/private key/JWT is
 * ever constructed. Same shape as N1PaperAdapter (signed baseSize position model, average-cost
 * accounting, trade-tape-crossing fill simulation reusing ../shared/paperFillSimulator.ts) —
 * this is the real proof of the ExchangeAdapter abstraction against RISEx's actual market
 * structure (SPEC.md Section 11, build plan step 2), so it deliberately mirrors N1PaperAdapter's
 * structure rather than diverging the way StubAdapter intentionally does.
 *
 * Three places genuinely differ from N1PaperAdapter, all driven by real RISEx characteristics:
 *
 *  - price/size quantization: placeOrder() rounds to RISEx's real integer tick/step grid
 *    (stepPrice/stepSize/minOrderSize from the live market list) before accepting an order, and
 *    rejects an order that quantizes below minOrderSize — N1 has no grid at all, so this is a
 *    genuinely new PlaceOrderResult failure path this adapter alone exercises.
 *  - trade-tape cursoring: RISEx trade `id` isn't a sortable integer (Phase 1's
 *    RiseXMarketDataSource doc comment), so the cursor is (lastSeenTime, idsSeenAtThatTime) with
 *    inclusive-boundary dedup by id, not N1's simple `maxTradeId + 1`.
 *  - funding: real RISEx funding-rate history is cash-settled against the simulated USDC balance
 *    whenever a position is open and a new funding record has closed — proving real RISEx funding
 *    data flows all the way through, which N1PaperAdapter's design has no equivalent of (N1
 *    itself has no live-fetchable funding *history* endpoint this codebase uses).
 */
export class RiseXPaperAdapter implements ExchangeAdapter {
  readonly exchangeId = "risex-paper";

  private readonly registry: RiseXMarketRegistry;
  private readonly balances = new Map<string, number>();
  private readonly positions = new Map<string, SimPosition>();
  private readonly openOrders = new Map<string, SimOrder>();
  private readonly fillsByOrderId = new Map<string, NormalizedFill[]>();
  private readonly lastKnownMarkPrice = new Map<string, number>();

  /** RISEx trade `id` is not sortable (see class doc comment) — cursor on timestamp instead, with
   * the id set at that exact timestamp retained to dedupe the inclusive lower-bound boundary. */
  private readonly lastSeenTradeTime = new Map<string, number>();
  private readonly lastSeenTradeIdsAtTime = new Map<string, Set<string>>();
  private readonly lastAppliedFundingEndTime = new Map<string, number>();

  private connected = false;
  private nextOrderId = 1;
  /** Per-market, not a single scalar — same SPEC.md Section 4.3 reasoning as N1PaperAdapter: one
   * instance is meant to be shared across every market an operator runs on this account. */
  private readonly accumulatedRealizedPnlUsd = new Map<string, number>();

  constructor(
    private readonly marketData: RiseXMarketDataSource,
    config: RiseXPaperAdapterConfig,
  ) {
    this.registry = new RiseXMarketRegistry(config.markets);
    this.balances.set("USDC", config.startingBalanceUsdc);
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new ExchangeAdapterError("RiseXPaperAdapter.connect() must be called before use");
    }
  }

  async connect(): Promise<void> {
    const markets = await this.marketData.getMarkets();
    this.registry.resolve(markets);
    this.connected = true;
  }

  async disconnect(): Promise<void> {}

  /** Same drain-and-reset contract as N1PaperAdapter, same per-market reason. */
  drainRealizedPnlDeltaUsd(market: string): number {
    const delta = this.accumulatedRealizedPnlUsd.get(market) ?? 0;
    this.accumulatedRealizedPnlUsd.set(market, 0);
    return delta;
  }

  async refreshAccountState(): Promise<void> {
    this.assertConnected();
    const marketsWithOrders = new Set([...this.openOrders.values()].map((o) => o.market));
    for (const market of marketsWithOrders) {
      await this.processFillsForMarket(market);
    }
    // Funding must keep accruing even once a position has no resting orders left — unlike fills,
    // this loop is keyed on open positions, not open orders.
    for (const market of this.positions.keys()) {
      await this.applyFundingForMarket(market);
    }
  }

  /** Primes both the trade-tape cursor and the funding cursor to "now" (the latest trade/funding
   * record already on the tape) the first time a market is touched — mirrors N1PaperAdapter's
   * primeTradeTapeCursor reasoning: a freshly placed order must never retroactively fill against,
   * or a freshly opened position never retroactively accrue funding from, history that predates
   * it. */
  private async primeCursors(market: string): Promise<void> {
    const marketId = this.registry.marketIdFor(market);

    const recentTrades = await this.marketData.getRecentTrades(marketId, undefined);
    const maxTime = recentTrades.length > 0 ? Math.max(...recentTrades.map((t) => t.timestamp)) : 0;
    this.lastSeenTradeTime.set(market, maxTime);
    this.lastSeenTradeIdsAtTime.set(
      market,
      new Set(recentTrades.filter((t) => t.timestamp === maxTime).map((t) => t.id)),
    );

    const recentFunding = await this.marketData.getFundingRateHistory(marketId, { limit: 1 });
    const maxEndTime =
      recentFunding.length > 0 ? Math.max(...recentFunding.map((f) => f.endTime)) : 0;
    this.lastAppliedFundingEndTime.set(market, maxEndTime);
  }

  private async processFillsForMarket(market: string): Promise<void> {
    const marketId = this.registry.marketIdFor(market);
    const sinceMs = this.lastSeenTradeTime.get(market);
    const trades = await this.marketData.getRecentTrades(marketId, sinceMs);
    if (trades.length === 0) return;

    const seenAtBoundary = this.lastSeenTradeIdsAtTime.get(market) ?? new Set<string>();
    const newTrades = trades.filter((t) => !(t.timestamp === sinceMs && seenAtBoundary.has(t.id)));
    if (newTrades.length === 0) return;

    const prints: TradeTapePrint[] = [...newTrades]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((t) => ({
        tradeId: t.id,
        price: t.price,
        size: t.size,
        takerSide: t.takerSide,
        timestamp: t.timestamp,
      }));

    const restingForMarket: SimulatedRestingOrder[] = [...this.openOrders.values()]
      .filter((o) => o.market === market)
      .map((o) => ({
        exchangeOrderId: o.exchangeOrderId,
        side: o.side,
        price: o.price,
        remainingSize: o.size - o.filledSize,
      }));

    const fills = simulateFills(restingForMarket, prints);
    for (const fill of fills) {
      const order = this.openOrders.get(fill.exchangeOrderId);
      if (!order) continue;

      order.filledSize += fill.size;
      const existing = this.fillsByOrderId.get(fill.exchangeOrderId) ?? [];
      existing.push({
        exchangeOrderId: fill.exchangeOrderId,
        tradeId: fill.tradeId,
        market,
        side: order.side,
        price: fill.price,
        size: fill.size,
        timestamp: fill.timestamp,
      });
      this.fillsByOrderId.set(fill.exchangeOrderId, existing);

      this.applyFillToPosition(market, order.side, fill.price, fill.size);

      if (order.filledSize >= order.size) {
        this.openOrders.delete(fill.exchangeOrderId);
      }
    }

    const maxTime = Math.max(...newTrades.map((t) => t.timestamp));
    this.lastSeenTradeTime.set(market, maxTime);
    this.lastSeenTradeIdsAtTime.set(
      market,
      new Set(newTrades.filter((t) => t.timestamp === maxTime).map((t) => t.id)),
    );
  }

  /** Cash-settles real RISEx funding-rate history against the simulated USDC balance for any
   * market with an open position. Real perp convention: a positive funding rate means longs pay
   * shorts, so a long (positive baseSize) position's payment is negative when the rate is
   * positive. Folded straight into realized PnL, same "funding is just another PnL component"
   * treatment N1's own mapPosition gives fundingPaymentPnl (see ../n1/mappers.ts). */
  private async applyFundingForMarket(market: string): Promise<void> {
    const pos = this.positions.get(market);
    if (!pos || pos.baseSize === 0) return;

    const sinceMs = this.lastAppliedFundingEndTime.get(market);
    if (sinceMs === undefined) return; // never primed — no order has ever been placed on this market

    const marketId = this.registry.marketIdFor(market);
    const records = await this.marketData.getFundingRateHistory(marketId, { sinceMs });
    const newRecords = records.filter((r) => r.endTime > sinceMs);
    if (newRecords.length === 0) return;

    let totalFundingUsd = 0;
    for (const record of newRecords) {
      totalFundingUsd += -pos.baseSize * record.indexPrice * record.fundingRate;
    }

    this.balances.set("USDC", (this.balances.get("USDC") ?? 0) + totalFundingUsd);
    this.accumulatedRealizedPnlUsd.set(
      market,
      (this.accumulatedRealizedPnlUsd.get(market) ?? 0) + totalFundingUsd,
    );

    const maxEndTime = Math.max(...newRecords.map((r) => r.endTime));
    this.lastAppliedFundingEndTime.set(market, maxEndTime);
  }

  /** Simple average-cost position accounting — identical approach to N1PaperAdapter's (see its
   * own doc comment): good enough to exercise risk-cap behavior in paper mode, not a claim of
   * exact accounting. */
  private applyFillToPosition(market: string, side: OrderSide, price: number, size: number): void {
    const pos = this.positions.get(market) ?? { baseSize: 0, entryPrice: 0 };
    const signedDelta = side === "buy" ? size : -size;
    const newBaseSize = pos.baseSize + signedDelta;
    const isIncreasingOrOpening =
      pos.baseSize === 0 || Math.sign(pos.baseSize) === Math.sign(signedDelta);

    let newEntryPrice = pos.entryPrice;
    if (isIncreasingOrOpening) {
      const totalCost = Math.abs(pos.baseSize) * pos.entryPrice + size * price;
      const totalSize = Math.abs(pos.baseSize) + size;
      newEntryPrice = totalSize > 0 ? totalCost / totalSize : price;
    } else {
      const closingSize = Math.min(Math.abs(signedDelta), Math.abs(pos.baseSize));
      const realizedPnl =
        side === "buy"
          ? (pos.entryPrice - price) * closingSize
          : (price - pos.entryPrice) * closingSize;
      this.accumulatedRealizedPnlUsd.set(
        market,
        (this.accumulatedRealizedPnlUsd.get(market) ?? 0) + realizedPnl,
      );
      if (newBaseSize !== 0 && Math.sign(newBaseSize) !== Math.sign(pos.baseSize)) {
        newEntryPrice = price; // flipped through flat — new position starts at this fill's price
      }
    }

    this.positions.set(market, {
      baseSize: newBaseSize,
      entryPrice: newBaseSize === 0 ? 0 : newEntryPrice,
    });

    const usdcDelta = -signedDelta * price; // buying spends USDC, selling receives it (fees ignored)
    this.balances.set("USDC", (this.balances.get("USDC") ?? 0) + usdcDelta);
  }

  getPositions(market?: string): NormalizedPosition[] {
    this.assertConnected();
    return [...this.positions.entries()]
      .filter(([m]) => !market || m === market)
      .map(([m, pos]) => {
        const markPrice = this.lastKnownMarkPrice.get(m) ?? pos.entryPrice;
        const unrealizedPnl = pos.baseSize === 0 ? 0 : (markPrice - pos.entryPrice) * pos.baseSize;
        return {
          market: m,
          baseSize: pos.baseSize,
          markPrice,
          unrealizedPnl,
          openOrderCount: [...this.openOrders.values()].filter((o) => o.market === m).length,
        };
      });
  }

  getOpenOrders(market?: string): NormalizedOrder[] {
    this.assertConnected();
    return [...this.openOrders.values()]
      .filter((o) => !market || o.market === market)
      .map((o) => ({
        exchangeOrderId: o.exchangeOrderId,
        clientOrderId: o.clientOrderId,
        market: o.market,
        side: o.side,
        type: o.type,
        price: o.price,
        size: o.size,
        filledSize: o.filledSize,
        remainingSize: o.size - o.filledSize,
        isReduceOnly: o.isReduceOnly,
        state: o.filledSize > 0 ? "partiallyFilled" : "open",
      }));
  }

  getBalances(): NormalizedBalance[] {
    this.assertConnected();
    return [...this.balances.entries()].map(([token, amount]) => ({ token, amount }));
  }

  getMarginStatus(): NormalizedMarginStatus {
    this.assertConnected();
    // Deliberately simplified, same reasoning as N1PaperAdapter's getMarginStatus: paper mode has
    // no real cross-margin engine behind it (and per SPEC.md Section 11's locked decision, even
    // the future authenticated RiseXAdapter only models cross-margin, never RISEx's native
    // per-position isolated margin).
    const usdc = this.balances.get("USDC") ?? 0;
    const unrealizedTotal = [...this.positions.entries()].reduce((sum, [m, pos]) => {
      const mark = this.lastKnownMarkPrice.get(m) ?? pos.entryPrice;
      return sum + (mark - pos.entryPrice) * pos.baseSize;
    }, 0);
    const equity = usdc + unrealizedTotal;
    return {
      accountValue: equity,
      maintenanceMarginFraction: 0,
      initialMarginFraction: 0,
      isAtBankruptcyRisk: equity < 0,
    };
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    this.assertConnected();
    // Validate the market is known before doing anything else, same as N1PaperAdapter.
    const stepConfig = this.registry.stepConfigFor(params.market);

    if (!this.lastSeenTradeTime.has(params.market)) {
      await this.primeCursors(params.market);
    }

    const quantizedPrice = quantizeToStep(params.price, stepConfig.stepPrice);
    const quantizedSize = quantizeToStep(params.size, stepConfig.stepSize);

    if (quantizedSize < stepConfig.minOrderSize) {
      return {
        success: false,
        reason: "REJECTED",
        message:
          `RiseXPaperAdapter: requested size ${params.size} quantizes to ${quantizedSize} on ` +
          `market "${params.market}"'s step grid (stepSize ${stepConfig.stepSize}), which is ` +
          `below its minOrderSize ${stepConfig.minOrderSize}`,
      };
    }

    const exchangeOrderId = `risex-${this.nextOrderId++}`;
    const order: SimOrder = {
      exchangeOrderId,
      clientOrderId: params.clientOrderId,
      market: params.market,
      side: params.side,
      type: params.type,
      price: quantizedPrice,
      size: quantizedSize,
      filledSize: 0,
      isReduceOnly: params.isReduceOnly,
    };
    this.openOrders.set(exchangeOrderId, order);

    const normalized: NormalizedOrder = {
      exchangeOrderId,
      clientOrderId: params.clientOrderId,
      market: params.market,
      side: params.side,
      type: params.type,
      price: quantizedPrice,
      size: quantizedSize,
      filledSize: 0,
      remainingSize: quantizedSize,
      isReduceOnly: params.isReduceOnly,
      state: "open",
    };
    return { success: true, order: normalized, fills: [] };
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    this.assertConnected();
    // Process any fill that happened up to this instant before removing the order — same SPEC.md
    // Section 5a race-window reasoning as N1PaperAdapter's cancelOrder.
    await this.processFillsForMarket(market);
    this.openOrders.delete(exchangeOrderId);
    return { success: true, exchangeOrderId };
  }

  async getOrderFills(exchangeOrderId: string, _market: string): Promise<NormalizedFill[]> {
    this.assertConnected();
    return this.fillsByOrderId.get(exchangeOrderId) ?? [];
  }

  async getMarketPrice(market: string): Promise<MarketPrice> {
    this.assertConnected();
    const marketId = this.registry.marketIdFor(market);
    // RiseXMarketDataSource has no single-market endpoint (Phase 1's public surface is markets/
    // orderbook/trades/candles/funding only) — fetch the live list and pick this market out of it,
    // same round trip getMarkets() itself already does internally.
    const markets = await this.marketData.getMarkets();
    const riseXMarket = markets.find((m) => m.marketId === marketId);
    if (!riseXMarket) {
      throw new ExchangeAdapterError(
        `RISEx no longer reports market "${market}" (marketId ${marketId}) in its live market list`,
      );
    }
    const result = mapRiseXMarketPrice(market, riseXMarket);
    this.lastKnownMarkPrice.set(market, result.mark);
    return result;
  }

  async getAccountVolume(params: {
    market?: string;
    since: string;
    until: string;
  }): Promise<AccountVolume[]> {
    this.assertConnected();
    // Derived from simulated fills — not a real exchange endpoint. Same approach as
    // N1PaperAdapter.getAccountVolume(); the real Account Trade History aggregation SPEC.md
    // Section 11 locks in is for the future authenticated RiseXAdapter (Phase 3), not this one.
    const relevant = [...this.fillsByOrderId.values()]
      .flat()
      .filter((f) => !params.market || f.market === params.market);
    const byMarket = new Map<string, { base: number; quote: number }>();
    for (const fill of relevant) {
      const agg = byMarket.get(fill.market) ?? { base: 0, quote: 0 };
      agg.base += fill.size;
      agg.quote += fill.size * fill.price;
      byMarket.set(fill.market, agg);
    }
    return [...byMarket.entries()].map(([market, agg]) => ({
      market,
      since: params.since,
      until: params.until,
      baseVolume: agg.base,
      quoteVolume: agg.quote,
    }));
  }
}
