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
import { MarketRegistry, type ConfiguredMarket } from "./marketRegistry.js";
import { mapMarketPrice } from "./mappers.js";
import type { N1MarketDataSource } from "./N1MarketDataSource.js";
import {
  simulateFills,
  type SimulatedRestingOrder,
  type TradeTapePrint,
} from "../shared/paperFillSimulator.js";

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

export interface N1PaperAdapterConfig {
  markets: ConfiguredMarket[];
  startingBalanceUsdc: number;
}

/**
 * A full ExchangeAdapter implementation that pairs REAL N1 market data with entirely SIMULATED
 * execution — no order ever reaches the real exchange, no private key or NordUser is ever
 * constructed. MarketEngine cannot distinguish this from N1Adapter; that's the point (SPEC.md
 * Section 1b's abstraction actually being exercised, not just asserted to hold).
 *
 * Fill simulation replays N1's real trade tape (via N1MarketDataSource) and crosses it against
 * our resting simulated orders (see ../shared/paperFillSimulator.ts) — a resting order only fills when a
 * real trade printed through its price, not merely when mark price moved past it. This means
 * getOrderFills() returns genuine simulated fills through the same method OrderLifecycle's
 * Section 5a cancel race-check calls, so that code path gets real exercise here, not just an
 * isolated unit test double.
 */
export class N1PaperAdapter implements ExchangeAdapter {
  readonly exchangeId = "n1-paper";

  private readonly registry: MarketRegistry;
  private readonly balances = new Map<string, number>();
  private readonly positions = new Map<string, SimPosition>();
  private readonly openOrders = new Map<string, SimOrder>();
  private readonly fillsByOrderId = new Map<string, NormalizedFill[]>();
  private readonly lastSeenTradeId = new Map<string, number>();
  private readonly lastKnownMarkPrice = new Map<string, number>();

  private connected = false;
  private nextOrderId = 1;
  /** Per-market, not a single scalar: one N1PaperAdapter instance is meant to be SHARED across
   * every market an operator runs (matching N1's real single cross-margined account, SPEC.md
   * Section 4.3) — a shared scalar here would let whichever market's engine happens to drain
   * first in a cycle steal PnL that was actually realized on a different market. */
  private readonly accumulatedRealizedPnlUsd = new Map<string, number>();

  constructor(
    private readonly marketData: N1MarketDataSource,
    config: N1PaperAdapterConfig,
  ) {
    this.registry = new MarketRegistry(config.markets);
    this.balances.set("USDC", config.startingBalanceUsdc);
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new ExchangeAdapterError("N1PaperAdapter.connect() must be called before use");
    }
  }

  async connect(): Promise<void> {
    const markets = await this.marketData.getMarkets();
    this.registry.resolve(markets);
    this.connected = true;
  }

  async disconnect(): Promise<void> {}

  /** Realized PnL for one market, accumulated since the last call, then reset to zero. Callers
   * (the paper runner) drain this once per cycle per market and feed it to that market's
   * MarketEngine.recordRealizedPnl() so the session-loss-cap risk check gets exercised against
   * genuinely simulated fills. */
  async drainRealizedPnlDeltaUsd(market: string): Promise<number> {
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
  }

  private async processFillsForMarket(market: string): Promise<void> {
    const marketId = this.registry.marketIdFor(market);
    const cursor = this.lastSeenTradeId.get(market);
    const trades = await this.marketData.getRecentTrades(
      marketId,
      cursor !== undefined ? cursor + 1 : undefined,
    );
    if (trades.length === 0) return;

    const prints: TradeTapePrint[] = trades.map((t) => ({
      tradeId: String(t.tradeId),
      price: t.price,
      size: t.baseSize,
      takerSide: t.takerSide === "bid" ? "buy" : "sell",
      timestamp: Date.parse(t.time),
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

    const maxTradeId = Math.max(...trades.map((t) => t.tradeId));
    this.lastSeenTradeId.set(market, maxTradeId);
  }

  /**
   * Simple average-cost position accounting: same-direction fills blend the entry price;
   * opposite-direction fills realize PnL against the existing average entry, credited/debited to
   * the simulated USDC balance immediately (fees ignored). This is intentionally approximate —
   * good enough to exercise risk-cap behavior in paper mode, not a claim of exact accounting
   * (SPEC.md Section 7's real trade log is the eventual source of truth for that, once built).
   */
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
    // Deliberately simplified (same reasoning as RiskManager.checkMarginHealth's comment on the
    // real adapter): paper mode has no real cross-margin engine behind it, so this doesn't
    // fabricate one. isAtBankruptcyRisk only trips if simulated equity actually goes negative.
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
    // Validate the market is known before doing anything else — mirrors N1Adapter's behavior of
    // failing loudly on an unconfigured market rather than silently accepting it.
    this.registry.marketIdFor(params.market);

    if (!this.lastSeenTradeId.has(params.market)) {
      await this.primeTradeTapeCursor(params.market);
    }

    const exchangeOrderId = String(this.nextOrderId++);
    const order: SimOrder = {
      exchangeOrderId,
      clientOrderId: params.clientOrderId,
      market: params.market,
      side: params.side,
      type: params.type,
      price: params.price,
      size: params.size,
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
      price: params.price,
      size: params.size,
      filledSize: 0,
      remainingSize: params.size,
      isReduceOnly: params.isReduceOnly,
      state: "open",
    };
    return { success: true, order: normalized, fills: [] };
  }

  private async primeTradeTapeCursor(market: string): Promise<void> {
    const marketId = this.registry.marketIdFor(market);
    const recent = await this.marketData.getRecentTrades(marketId, undefined);
    this.lastSeenTradeId.set(
      market,
      recent.length > 0 ? Math.max(...recent.map((t) => t.tradeId)) : 0,
    );
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    this.assertConnected();
    // Process any fill that happened up to this instant BEFORE removing the order, so the real
    // OrderLifecycle race-check (which calls getOrderFills right after this resolves) can see
    // it — mirroring the live race window between a cancel landing and a fill having already
    // happened, per SPEC.md Section 5a.
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
    const stats = await this.marketData.getMarketStats(marketId);
    const result = mapMarketPrice(market, stats);
    this.lastKnownMarkPrice.set(market, result.mark);
    return result;
  }

  async getAccountVolume(params: {
    market?: string;
    since: string;
    until: string;
  }): Promise<AccountVolume[]> {
    this.assertConnected();
    // Derived from simulated fills — not a real exchange endpoint. Fine for paper-mode
    // testing/dashboards, not meant to resemble N1's real volume accounting.
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
