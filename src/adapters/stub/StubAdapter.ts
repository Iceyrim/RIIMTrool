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
  OrderSide,
  OrderType,
  PlaceOrderParams,
  PlaceOrderResult,
} from "../ExchangeAdapter.js";
import { ExchangeAdapterError } from "../AdapterError.js";
import { createSeededRng, type SeededRng } from "./rng.js";

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

/**
 * Deliberately NOT a single signed baseSize (that's N1PaperAdapter's shape). Long and short
 * exposure are tracked as two separate unsigned legs with their own average-entry prices — closer
 * to how some real exchanges report position state — and only collapsed into the interface's
 * signed `NormalizedPosition.baseSize` at the adapter boundary. This is exactly the class of "code
 * assumed one internal shape, broke against a differently-shaped one" bug SPEC.md Section 1b
 * describes; if anything outside this file ever had to know about longQty/shortQty, the
 * abstraction would have failed this test.
 */
interface SimPosition {
  longQty: number;
  longEntryPrice: number;
  shortQty: number;
  shortEntryPrice: number;
}

export interface StubAdapterMarketConfig {
  symbol: string;
  /** Starting synthetic mid price. Arbitrary — this exchange doesn't exist. */
  startPrice: number;
}

export interface StubAdapterConfig {
  markets: StubAdapterMarketConfig[];
  startingBalanceUsdc: number;
  /** Seeds every random choice this adapter makes (price walk, fill-size split, placement
   * ambiguity) so a soak run is exactly reproducible from a logged seed. */
  seed: number;
  /** Per-tick synthetic price drift, in bps. Default 0 (no directional bias). */
  driftBpsPerTick?: number;
  /** Per-tick synthetic price volatility, in bps (uniform +/-). Default 8. */
  volBpsPerTick?: number;
  /** Probability in [0, 1) that a given placeOrder() call resolves as
   * UNRESOLVED_NOT_CONFIRMED rather than success — simulating SPEC.md Section 5b's "placement
   * call returned without confirming success or failure" ambiguity, on a second adapter's own
   * terms rather than replaying N1's specific failure mode. Default 0.02. */
  unresolvedChance?: number;
}

/**
 * A second, independent ExchangeAdapter implementation whose only purpose is validating SPEC.md
 * Section 1b's abstraction boundary (build order step 7): no real exchange behind it, no network,
 * no shared code with N1PaperAdapter beyond the interface itself. Deliberately diverges from
 * N1PaperAdapter in every way SPEC.md Section 1b warns code might silently assume:
 *
 *  - internal position model: unsigned long/short legs (see SimPosition), not a signed scalar
 *  - fill timing: a seeded synthetic price random-walk crossing model, not a replayed real trade
 *    tape — and unlike N1PaperAdapter, placeOrder() can itself report a fill synchronously in its
 *    own response (the price walk advances once at placement time too, simulating confirmation
 *    latency), which N1PaperAdapter's placeOrder() never does (always returns fills: [])
 *  - market identification: markets are looked up directly by symbol string, no separate
 *    numeric-id resolution step (no MarketRegistry-equivalent)
 *  - connect(): pure local setup, no external round trip (N1PaperAdapter's connect() always does
 *    a real async fetch against N1's market list)
 *  - getMarketPrice(): never reports an index price (N1's mapMarketPrice always tries to)
 *  - error shape: getOrderFills() throws for a genuinely unrecognized order id (N1PaperAdapter
 *    never throws there, always returns []); cancelOrder() throws if the order is no longer
 *    resting by the time the race-window price tick lands (N1PaperAdapter's cancelOrder() always
 *    resolves success:true). Both exercise OrderLifecycle/Reconciliation's SPEC.md Section 5a
 *    fail-open handling against a genuinely different failure mode than N1's.
 *
 * All randomness (price walk, fill-size split, UNRESOLVED_NOT_CONFIRMED chance) is drawn from one
 * seeded RNG stream so a soak run is exactly reproducible from its logged seed.
 */
export class StubAdapter implements ExchangeAdapter {
  readonly exchangeId = "stub";

  private readonly rng: SeededRng;
  private readonly driftBpsPerTick: number;
  private readonly volBpsPerTick: number;
  private readonly unresolvedChance: number;

  private readonly configuredMarkets = new Set<string>();
  private readonly mid = new Map<string, number>();
  private readonly lastKnownMarkPrice = new Map<string, number>();
  private readonly balances = new Map<string, number>();
  private readonly positions = new Map<string, SimPosition>();
  private readonly restingOrders = new Map<string, SimOrder>();
  private readonly knownOrderIds = new Set<string>();
  private readonly fillsByOrderId = new Map<string, NormalizedFill[]>();
  private readonly accumulatedRealizedPnlUsd = new Map<string, number>();

  private connected = false;
  private nextOrderId = 1;
  private nextTradeId = 1;

  constructor(config: StubAdapterConfig) {
    this.rng = createSeededRng(config.seed);
    this.driftBpsPerTick = config.driftBpsPerTick ?? 0;
    this.volBpsPerTick = config.volBpsPerTick ?? 8;
    this.unresolvedChance = config.unresolvedChance ?? 0.02;
    this.balances.set("USDC", config.startingBalanceUsdc);
    for (const market of config.markets) {
      this.configuredMarkets.add(market.symbol);
      this.mid.set(market.symbol, market.startPrice);
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new ExchangeAdapterError("StubAdapter.connect() must be called before use");
    }
  }

  private assertKnownMarket(market: string): void {
    if (!this.configuredMarkets.has(market)) {
      throw new ExchangeAdapterError(`StubAdapter: unknown market "${market}"`);
    }
  }

  /** No external round trip at all — unlike N1PaperAdapter.connect(), which must fetch N1's real
   * market list before it can resolve configured symbols. */
  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {}

  /** Same drain-and-reset contract as N1PaperAdapter, kept per-market for the same SPEC.md
   * Section 4.3 reason (one adapter instance can be shared across every market on the account). */
  async drainRealizedPnlDeltaUsd(market: string): Promise<number> {
    const delta = this.accumulatedRealizedPnlUsd.get(market) ?? 0;
    this.accumulatedRealizedPnlUsd.set(market, 0);
    return delta;
  }

  async refreshAccountState(): Promise<void> {
    this.assertConnected();
    const marketsWithOrders = new Set([...this.restingOrders.values()].map((o) => o.market));
    for (const market of this.configuredMarkets) {
      if (marketsWithOrders.has(market)) this.advancePrice(market);
    }
  }

  /** Advances this market's synthetic mid one seeded step, then processes any resulting resting-
   * order crossings. Called from refreshAccountState() (every cycle), from placeOrder() (models
   * confirmation latency, and is the reason placeOrder() can itself report a synchronous fill),
   * and from cancelOrder() (the SPEC.md Section 5a race-window check). */
  private advancePrice(market: string): void {
    const mid = this.mid.get(market);
    if (mid === undefined) return;
    const moveBps = (this.rng() * 2 - 1) * this.volBpsPerTick + this.driftBpsPerTick;
    const newMid = mid * (1 + moveBps / 10_000);
    this.mid.set(market, newMid);
    this.processFillsForMarket(market, newMid);
  }

  /** A resting buy fills once the mid has walked down to or through its price; a resting sell
   * fills once the mid has walked up to or through its price — both fill at the order's own
   * (maker) price, not at the synthetic mid. Fill size is a seeded mix of full and partial fills,
   * not driven by a matched counter-trade size the way N1PaperAdapter's tape-replay is. */
  private processFillsForMarket(market: string, mid: number): void {
    for (const order of [...this.restingOrders.values()]) {
      if (order.market !== market) continue;
      const remaining = order.size - order.filledSize;
      if (remaining <= 0) continue;

      const crossed = order.side === "buy" ? mid <= order.price : mid >= order.price;
      if (!crossed) continue;

      const r = this.rng();
      const fillSize = r < 0.6 ? remaining : remaining * (0.2 + this.rng() * 0.6);
      this.recordFill(order, Math.min(fillSize, remaining));
    }
  }

  private recordFill(order: SimOrder, fillSize: number): void {
    order.filledSize += fillSize;
    const fill: NormalizedFill = {
      exchangeOrderId: order.exchangeOrderId,
      tradeId: `stub-fill-${this.nextTradeId++}`,
      market: order.market,
      side: order.side,
      price: order.price,
      size: fillSize,
      timestamp: Date.now(),
    };
    const existing = this.fillsByOrderId.get(order.exchangeOrderId) ?? [];
    existing.push(fill);
    this.fillsByOrderId.set(order.exchangeOrderId, existing);

    this.applyFillToPosition(order.market, order.side, order.price, fillSize);

    if (order.filledSize >= order.size) {
      this.restingOrders.delete(order.exchangeOrderId);
    }
  }

  /** Buy fills close short exposure first (realizing PnL against the short's average entry),
   * then open/increase long with whatever size remains; sell fills mirror this against long
   * exposure first. Two-legged by construction — see SimPosition's doc comment. */
  private applyFillToPosition(market: string, side: OrderSide, price: number, size: number): void {
    const pos = this.positions.get(market) ?? {
      longQty: 0,
      longEntryPrice: 0,
      shortQty: 0,
      shortEntryPrice: 0,
    };
    let remaining = size;
    let realizedPnl = 0;

    if (side === "buy") {
      if (pos.shortQty > 0) {
        const closing = Math.min(remaining, pos.shortQty);
        realizedPnl += (pos.shortEntryPrice - price) * closing;
        pos.shortQty -= closing;
        if (pos.shortQty === 0) pos.shortEntryPrice = 0;
        remaining -= closing;
      }
      if (remaining > 0) {
        const totalCost = pos.longQty * pos.longEntryPrice + remaining * price;
        pos.longQty += remaining;
        pos.longEntryPrice = pos.longQty > 0 ? totalCost / pos.longQty : 0;
      }
    } else {
      if (pos.longQty > 0) {
        const closing = Math.min(remaining, pos.longQty);
        realizedPnl += (price - pos.longEntryPrice) * closing;
        pos.longQty -= closing;
        if (pos.longQty === 0) pos.longEntryPrice = 0;
        remaining -= closing;
      }
      if (remaining > 0) {
        const totalCost = pos.shortQty * pos.shortEntryPrice + remaining * price;
        pos.shortQty += remaining;
        pos.shortEntryPrice = pos.shortQty > 0 ? totalCost / pos.shortQty : 0;
      }
    }

    this.positions.set(market, pos);
    if (realizedPnl !== 0) {
      this.accumulatedRealizedPnlUsd.set(
        market,
        (this.accumulatedRealizedPnlUsd.get(market) ?? 0) + realizedPnl,
      );
    }

    const usdcDelta = side === "buy" ? -size * price : size * price;
    this.balances.set("USDC", (this.balances.get("USDC") ?? 0) + usdcDelta);
  }

  getPositions(market?: string): NormalizedPosition[] {
    this.assertConnected();
    return [...this.positions.entries()]
      .filter(([m]) => !market || m === market)
      .map(([m, pos]) => {
        const mark = this.lastKnownMarkPrice.get(m) ?? this.mid.get(m) ?? 0;
        const baseSize = pos.longQty - pos.shortQty;
        const unrealizedPnl =
          (mark - pos.longEntryPrice) * pos.longQty + (pos.shortEntryPrice - mark) * pos.shortQty;
        return {
          market: m,
          baseSize,
          markPrice: mark,
          unrealizedPnl,
          openOrderCount: [...this.restingOrders.values()].filter((o) => o.market === m).length,
        };
      });
  }

  getOpenOrders(market?: string): NormalizedOrder[] {
    this.assertConnected();
    return [...this.restingOrders.values()]
      .filter((o) => !market || o.market === market)
      .map((o) => ({
        exchangeOrderId: o.exchangeOrderId,
        clientOrderId: o.clientOrderId,
        market: o.market,
        side: o.side,
        // Unlike N1's live open-orders view, the stub always knows and reports the original type
        // — showing this field really is per-adapter-optional, not "no adapter reports it."
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
    const usdc = this.balances.get("USDC") ?? 0;
    const unrealizedTotal = [...this.positions.entries()].reduce((sum, [m, pos]) => {
      const mark = this.lastKnownMarkPrice.get(m) ?? this.mid.get(m) ?? 0;
      return (
        sum + (mark - pos.longEntryPrice) * pos.longQty + (pos.shortEntryPrice - mark) * pos.shortQty
      );
    }, 0);
    const equity = usdc + unrealizedTotal;
    return {
      accountValue: equity,
      // Deliberately fixed nonzero constants, unlike N1PaperAdapter's always-0 — this stub has no
      // real cross-margin engine behind it either, but reporting nonzero here checks that nothing
      // downstream assumes these fractions are always exactly zero.
      maintenanceMarginFraction: 0.03,
      initialMarginFraction: 0.1,
      isAtBankruptcyRisk: equity < 0,
    };
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    this.assertConnected();
    this.assertKnownMarket(params.market);

    if (this.rng() < this.unresolvedChance) {
      return {
        success: false,
        reason: "UNRESOLVED_NOT_CONFIRMED",
        message:
          "StubAdapter: simulated placement ambiguity — order may or may not have reached the exchange",
      };
    }

    const exchangeOrderId = `stub-${this.nextOrderId++}`;
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
    this.restingOrders.set(exchangeOrderId, order);
    this.knownOrderIds.add(exchangeOrderId);

    // Models confirmation latency: enough "time" passes between submission and this response
    // resolving that the synthetic price can walk through the just-placed order's level, so
    // placeOrder() can itself report a fill synchronously — a path N1PaperAdapter's placeOrder()
    // never exercises (it always returns fills: []).
    this.advancePrice(params.market);

    const fills = this.fillsByOrderId.get(exchangeOrderId) ?? [];
    const state: NormalizedOrder["state"] =
      order.filledSize >= order.size ? "filled" : order.filledSize > 0 ? "partiallyFilled" : "open";

    const normalized: NormalizedOrder = {
      exchangeOrderId,
      clientOrderId: params.clientOrderId,
      market: params.market,
      side: params.side,
      type: params.type,
      price: params.price,
      size: params.size,
      filledSize: order.filledSize,
      remainingSize: params.size - order.filledSize,
      isReduceOnly: params.isReduceOnly,
      state,
    };
    return { success: true, order: normalized, fills };
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    this.assertConnected();
    // Same race-window intent as N1PaperAdapter's cancelOrder (SPEC.md Section 5a), different
    // mechanism: advancing the price walk here may fill-and-remove the order right in this call.
    this.advancePrice(market);

    const existed = this.restingOrders.delete(exchangeOrderId);
    if (!existed) {
      // Unlike N1PaperAdapter, which always resolves success:true, this throws when the order is
      // no longer resting (just filled above, or already gone) — a realistic "cancel on an
      // already-resolved order" exchange error. OrderLifecycle.cancelOrder() already treats this
      // call's outcome as non-authoritative and falls back to getOrderFills() regardless (see its
      // own doc comment), so this is a safe, meaningful divergence to exercise that fail-open path
      // against a second adapter's own failure mode, not just N1's.
      throw new ExchangeAdapterError(
        `StubAdapter: cancelOrder failed — order "${exchangeOrderId}" is not resting (already filled or unknown)`,
        undefined,
        false,
      );
    }
    return { success: true, exchangeOrderId };
  }

  async getOrderFills(exchangeOrderId: string, _market: string): Promise<NormalizedFill[]> {
    this.assertConnected();
    if (!this.knownOrderIds.has(exchangeOrderId)) {
      // Unlike N1PaperAdapter, which never throws here (always returns [] for an unrecognized
      // id), this throws for a genuinely unknown order — exercising OrderLifecycle/Reconciliation's
      // SPEC.md Section 5a fail-open handling against a different failure mode than N1's.
      throw new ExchangeAdapterError(
        `StubAdapter: no such order "${exchangeOrderId}" was ever placed through this adapter`,
      );
    }
    return this.fillsByOrderId.get(exchangeOrderId) ?? [];
  }

  async getMarketPrice(market: string): Promise<MarketPrice> {
    this.assertConnected();
    this.assertKnownMarket(market);
    const mark = this.mid.get(market)!;
    this.lastKnownMarkPrice.set(market, mark);
    // Deliberately no `index` field — unlike N1's mapMarketPrice, which always tries to supply
    // one. MarketPrice.index is documented as optional precisely because not every exchange
    // exposes it separately from mark; this adapter is the case where it genuinely doesn't.
    return { market, mark };
  }

  async getAccountVolume(params: {
    market?: string;
    since: string;
    until: string;
  }): Promise<AccountVolume[]> {
    this.assertConnected();
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
