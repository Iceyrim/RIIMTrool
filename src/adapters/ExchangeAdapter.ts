/**
 * Exchange-agnostic adapter boundary (SPEC.md Section 1b).
 *
 * The engine, risk manager, reconciliation logic, and dashboard must all operate against this
 * interface and the normalized types below — never against a specific exchange SDK's raw types.
 * Only code inside an adapter's own directory (e.g. `src/adapters/n1/`) may import that
 * exchange's SDK.
 */

export type OrderSide = "buy" | "sell";

export type OrderType = "limit" | "postOnly" | "immediateOrCancel" | "fillOrKill";

export type OrderState =
  | "open" // resting, no fills yet
  | "partiallyFilled" // resting, some fills
  | "filled" // fully filled
  | "cancelled" // confirmed gone, no fill
  | "unresolved"; // placement call returned without confirming success or failure (see
// PlaceOrderResult below) — callers must treat this as "not known to be on
// the exchange," never as success

export interface NormalizedOrder {
  exchangeOrderId: string;
  clientOrderId?: string;
  market: string; // logical symbol from market config, e.g. "BTCUSD"
  side: OrderSide;
  /**
   * Order type as placed. Optional because not every exchange's "list my open orders" call
   * necessarily reports the original fill-mode back (N1's does not) — when reconstructing an
   * order from the exchange's live order-book view rather than from the placement response,
   * this may be unknown. Callers that placed the order themselves should already know it
   * locally and don't need to rely on this field.
   */
  type?: OrderType;
  price: number;
  size: number; // originally requested size
  filledSize: number;
  remainingSize: number;
  /**
   * Bookkeeping flag only. Some exchanges' "list my open orders" views do not report whether an
   * order was placed reduce-only (N1's does not); the caller's own local order registry is the
   * authoritative source for this, not the adapter. Defaults to false when the exchange doesn't
   * report it. See SPEC.md Section 5c.
   */
  isReduceOnly: boolean;
  state: OrderState;
}

export interface NormalizedFill {
  exchangeOrderId: string;
  /**
   * Absent for fills reported synchronously by placeOrder() itself — N1's placement response
   * reports price/size but no trade id. Present for fills fetched via getOrderFills().
   */
  tradeId?: string;
  market: string;
  side: OrderSide;
  price: number;
  size: number;
  timestamp: number; // unix ms
}

export interface NormalizedPosition {
  market: string;
  /** Signed: positive = long, negative = short, 0 = flat. Exchanges that report magnitude and
   * long/short as separate fields must be collapsed into this one signed number at the adapter
   * boundary — this is exactly the class of bug SPEC.md Section 1b describes (code assuming one
   * shape breaking against a differently-shaped response). */
  baseSize: number;
  markPrice: number;
  unrealizedPnl: number;
  openOrderCount: number;
}

export interface NormalizedBalance {
  token: string;
  amount: number;
}

/**
 * Account-wide, cross-margin health. Deliberately NOT per-market: SPEC.md Section 4.3 requires
 * margin usage to be visible as a shared, account-wide resource that all configured markets draw
 * from, even though positions/orders below are market-scoped.
 */
export interface NormalizedMarginStatus {
  accountValue: number;
  maintenanceMarginFraction: number;
  initialMarginFraction: number;
  isAtBankruptcyRisk: boolean;
}

export interface MarketPrice {
  market: string;
  mark: number;
  /** Not all exchanges expose index price separately from mark; N1 does. */
  index?: number;
}

export interface AccountVolume {
  market: string | null;
  marketId?: number;
  since: string; // RFC3339
  until: string; // RFC3339
  baseVolume: number;
  quoteVolume: number;
}

export interface PlaceOrderParams {
  market: string;
  side: OrderSide;
  type: OrderType;
  size: number;
  price: number;
  /** Exchange-enforced reduce-only intent. Genuine exits pass true; normal quotes pass false. */
  isReduceOnly: boolean;
  clientOrderId?: string;
}

/**
 * `success` is true ONLY when the exchange has confirmed the order is resting or filled.
 * Modeled directly on SPEC.md Section 5b: N1's real placeOrder() can resolve without throwing
 * and without an orderId or any fills. That case must produce `success: false` here — it must
 * never be inferred as success purely because the call didn't reject.
 */
export type PlaceOrderResult =
  | {
      success: true;
      order: NormalizedOrder;
      fills: NormalizedFill[];
    }
  | {
      success: false;
      reason: "UNRESOLVED_NOT_CONFIRMED" | "REJECTED";
      message: string;
      raw?: unknown;
    };

export interface CancelOrderResult {
  success: boolean;
  exchangeOrderId: string;
}

export interface ExchangeAdapter {
  readonly exchangeId: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /**
   * Refreshes the adapter's cached account snapshot (positions/orders/balances/margin). Where
   * the exchange supports it (N1 does), this should be a single round trip rather than one call
   * per data type, specifically to avoid a torn read across a market-loop cycle (e.g. a stale
   * position read next to a freshly-fetched order read). Reconciliation (SPEC.md Section 4.1)
   * calls this once per cycle before comparing local vs. exchange state.
   */
  refreshAccountState(): Promise<void>;

  getPositions(market?: string): NormalizedPosition[];
  getOpenOrders(market?: string): NormalizedOrder[];
  getBalances(): NormalizedBalance[];
  getMarginStatus(): NormalizedMarginStatus;

  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult>;
  cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult>;

  /**
   * Exists specifically to support the SPEC.md Section 5a fix: before the engine finalizes a
   * cancel as CANCELLED, it calls this to check whether a fill actually landed in the race
   * window between "cancel requested" and "cancel confirmed." Kept as its own primitive (not
   * folded into cancelOrder) so that decision stays visible and testable at the order-lifecycle
   * layer, per-market, rather than hidden inside the adapter. If this call itself errors, the
   * caller must fail open (proceed with treating the cancel as CANCELLED) per Section 5a — that
   * fail-open behavior is the engine's responsibility, not this adapter's.
   */
  getOrderFills(exchangeOrderId: string, market: string): Promise<NormalizedFill[]>;

  getMarketPrice(market: string): Promise<MarketPrice>;
  getAccountVolume(params: {
    market?: string;
    since: string;
    until: string;
  }): Promise<AccountVolume[]>;
}
