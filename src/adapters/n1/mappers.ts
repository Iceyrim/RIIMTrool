import { FillMode, type MarketStats, type TradeFromApi } from "@n1xyz/nord-ts";
import type {
  MarketPrice,
  NormalizedBalance,
  NormalizedFill,
  NormalizedMarginStatus,
  NormalizedOrder,
  NormalizedPosition,
  OrderSide,
  OrderType,
} from "../ExchangeAdapter.js";
import { ExchangeAdapterError } from "../AdapterError.js";
import type { MarketRegistry } from "./marketRegistry.js";

/**
 * These local interfaces mirror NordUser's cached `.positions` / `.orders` / `.balances` /
 * `.margins` field shapes exactly, as declared inline on the NordUser class (see
 * node_modules/@n1xyz/nord-ts/dist/client/NordUser.d.ts). They are deliberately NOT aliased to
 * nord-ts's openapi-generated types (e.g. `PerpPositionUpdate`, `OpenOrder`), which look similar
 * but are not identical — for example the openapi `PerpPositionUpdate` has a `tradingPnl` field
 * that NordUser's actual cached position does not; the cache has `sizePricePnl` instead. Mapping
 * from the wrong one of these two shapes is exactly the "assumed one N1 shape, broke against a
 * different one" bug pattern SPEC.md Section 1b calls out. Keeping the input types here pinned
 * to what NordUser's cache genuinely returns is the guard against that.
 */
export interface N1CachedPerpPosition {
  baseSize: number;
  price: number;
  updatedFundingRateIndex: number;
  fundingPaymentPnl: number;
  sizePricePnl: number;
  isLong: boolean;
}

export interface N1CachedPosition {
  marketId: number;
  openOrders: number;
  perp?: N1CachedPerpPosition;
  actionId: number;
}

export interface N1CachedOrder {
  orderId: number;
  marketId: number;
  side: "ask" | "bid";
  size: number;
  price: number;
  originalOrderSize: number;
  clientOrderId: string | null;
}

export interface N1CachedBalance {
  accountId: number;
  balance: number;
  symbol: string;
}

export interface N1CachedMargins {
  omf: number;
  mf: number;
  imf: number;
  cmf: number;
  mmf: number;
  pon: number;
  pn: number;
  bankruptcy: boolean;
}

export function n1SideToOrderSide(side: "ask" | "bid"): OrderSide {
  return side === "bid" ? "buy" : "sell";
}

export function orderSideToN1Side(side: OrderSide): "ask" | "bid" {
  return side === "buy" ? "bid" : "ask";
}

export function orderTypeToFillMode(type: OrderType): FillMode {
  switch (type) {
    case "limit":
      return FillMode.Limit;
    case "postOnly":
      return FillMode.PostOnly;
    case "immediateOrCancel":
      return FillMode.ImmediateOrCancel;
    case "fillOrKill":
      return FillMode.FillOrKill;
  }
}

/** Returns null for entries with no perp sub-position (e.g. never traded on that market). */
export function mapPosition(
  raw: N1CachedPosition,
  registry: MarketRegistry,
): NormalizedPosition | null {
  if (!raw.perp) return null;
  return {
    market: registry.symbolFor(raw.marketId),
    baseSize: raw.perp.isLong ? raw.perp.baseSize : -raw.perp.baseSize,
    markPrice: raw.perp.price,
    // sizePricePnl + fundingPaymentPnl are the two unrealized PnL components NordUser's cache
    // actually carries — see the N1CachedPerpPosition doc comment above.
    unrealizedPnl: raw.perp.sizePricePnl + raw.perp.fundingPaymentPnl,
    openOrderCount: raw.openOrders,
  };
}

export function mapOpenOrder(raw: N1CachedOrder, registry: MarketRegistry): NormalizedOrder {
  const filledSize = Math.max(0, raw.originalOrderSize - raw.size);
  return {
    exchangeOrderId: String(raw.orderId),
    clientOrderId: raw.clientOrderId ?? undefined,
    market: registry.symbolFor(raw.marketId),
    side: n1SideToOrderSide(raw.side),
    // type intentionally omitted: N1's live open-orders cache does not report the original fill
    // mode, so it can't be reconstructed here.
    price: raw.price,
    size: raw.originalOrderSize,
    filledSize,
    remainingSize: raw.size,
    // isReduceOnly intentionally always false: N1's live open-orders cache does not report it
    // either. The caller's own local order registry is authoritative for this (SPEC.md
    // Section 5c) — do not treat this field as ground truth when it came from getOpenOrders().
    isReduceOnly: false,
    state: filledSize > 0 ? "partiallyFilled" : "open",
  };
}

/**
 * `ourAccountId` is required to correctly attribute `side`: a Trade only records `takerSide`
 * (plus takerId/makerId), so if our order was the resting maker, our side is the OPPOSITE of
 * takerSide, not takerSide itself. Reporting takerSide directly regardless of which party we
 * were would silently mislabel every maker fill's side.
 */
export function mapFill(
  raw: TradeFromApi,
  registry: MarketRegistry,
  ourAccountId: number,
): NormalizedFill {
  const weWereTaker = raw.takerId === ourAccountId;
  const ourN1Side = weWereTaker ? raw.takerSide : raw.takerSide === "bid" ? "ask" : "bid";
  return {
    exchangeOrderId: String(raw.orderId),
    tradeId: String(raw.tradeId),
    market: registry.symbolFor(raw.marketId),
    side: n1SideToOrderSide(ourN1Side),
    price: raw.price,
    size: raw.baseSize,
    timestamp: Date.parse(raw.time),
  };
}

export function mapBalance(raw: N1CachedBalance): NormalizedBalance {
  return { token: raw.symbol, amount: raw.balance };
}

export function mapMarginStatus(raw: N1CachedMargins): NormalizedMarginStatus {
  return {
    accountValue: raw.pn,
    maintenanceMarginFraction: raw.mmf,
    initialMarginFraction: raw.imf,
    isAtBankruptcyRisk: raw.bankruptcy,
  };
}

/**
 * Shared between N1Adapter and N1PaperAdapter — both need identical mark/index price
 * extraction from N1's real getMarketStats() response. Throws rather than returning a
 * placeholder when neither price is available: a market-making engine with no price to quote
 * against should fail loudly, not silently substitute something misleading.
 */
export function mapMarketPrice(market: string, stats: MarketStats): MarketPrice {
  const mark = stats.perpStats?.mark_price ?? undefined;
  const index = stats.indexPrice ?? undefined;
  if (mark === undefined && index === undefined) {
    throw new ExchangeAdapterError(`N1 returned no mark or index price for market "${market}"`);
  }
  return { market, mark: mark ?? index!, index };
}
