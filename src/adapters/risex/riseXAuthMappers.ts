import type { OrderSide, OrderType } from "../ExchangeAdapter.js";
import { decimal } from "./RiseXMarketDataSource.js";
import { RISEX_ORDER_TYPE, RISEX_SIDE, RISEX_TIME_IN_FORCE } from "./authTypes.js";
import type { RiseXStepConfig } from "./marketRegistry.js";

export { decimal };

/**
 * Converts a WAD (1e18 fixed-point) integer string to a JS number without the precision loss
 * plain `Number(wadString)` would cause once the integer part exceeds Number.MAX_SAFE_INTEGER
 * (~9e15) — the same class of problem RiseXMarketDataSource.nsStringToMs solves for nanosecond
 * timestamps, via the same whole/fractional BigInt split. Only `filled_quantity` on the
 * placeOrder response is documented as WAD (SPEC.md Section 11's "integer tick/step price
 * representation" is a different, unrelated integer encoding — see toTicks/toSteps below).
 * Handles negative values correctly via BigInt's truncating-toward-zero division/remainder.
 */
export function wadToNumber(wad: string): number {
  const scale = 1_000_000_000_000_000_000n;
  const bi = BigInt(wad);
  const whole = bi / scale;
  const frac = bi % scale;
  return Number(whole) + Number(frac) / 1e18;
}

/**
 * Generic scaled-integer-string to number, for the `/v1/account/balance` endpoint whose token
 * decimals are NOT documented (it's a generic any-ERC20-token endpoint, unlike WAD-scaled
 * margin/order-size fields elsewhere). `decimals` must be supplied by the caller from config —
 * see RiseXAdapterConfig.usdcTokenDecimals's doc comment for why this can't be safely hardcoded.
 */
export function scaledIntToNumber(raw: string, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const bi = BigInt(raw);
  const whole = bi / scale;
  const frac = bi % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

/** Converts a decimal price to RISEx's integer price_ticks wire representation — the count of
 * `stepPrice`-sized ticks, not the price itself. This is the real "integer tick/step price
 * representation" SPEC.md Section 11 calls out: RiseXPaperAdapter (Phase 2) only quantizes price
 * to the nearest step and keeps it decimal for its own local simulation; this adapter must
 * additionally convert that quantized decimal into the literal integer RISEx's wire format
 * expects. */
export function toTicks(price: number, stepPrice: number): number {
  return Math.round(price / stepPrice);
}

export function fromTicks(ticks: number, stepPrice: number): number {
  return ticks * stepPrice;
}

export function toSteps(size: number, stepSize: number): number {
  return Math.round(size / stepSize);
}

export function fromSteps(steps: number, stepSize: number): number {
  return steps * stepSize;
}

export function orderSideToRiseXSide(side: OrderSide): number {
  return side === "buy" ? RISEX_SIDE.BUY : RISEX_SIDE.SELL;
}

export function riseXSideToOrderSide(side: number): OrderSide {
  return side === RISEX_SIDE.BUY ? "buy" : "sell";
}

/**
 * Maps this adapter's abstract OrderType onto RISEx's orthogonal order_type/time_in_force/
 * post_only fields, entirely inside this mapper layer per SPEC.md Section 11's locked decision —
 * the ExchangeAdapter interface itself is untouched. v1 scope never sends RISEx's Market(0)
 * order_type: PlaceOrderParams always carries an explicit price, so every abstract type below is
 * a priced Limit order distinguished only by time_in_force/post_only, mirroring how N1's
 * orderTypeToFillMode (../n1/mappers.ts) maps the same four abstract types onto N1's FillMode
 * enum without needing an unpriced "market" concept either.
 */
export function orderTypeToRiseXFields(type: OrderType): {
  order_type: number;
  time_in_force: number;
  post_only: boolean;
} {
  switch (type) {
    case "limit":
      return { order_type: RISEX_ORDER_TYPE.LIMIT, time_in_force: RISEX_TIME_IN_FORCE.GTC, post_only: false };
    case "postOnly":
      return { order_type: RISEX_ORDER_TYPE.LIMIT, time_in_force: RISEX_TIME_IN_FORCE.GTC, post_only: true };
    case "immediateOrCancel":
      return { order_type: RISEX_ORDER_TYPE.LIMIT, time_in_force: RISEX_TIME_IN_FORCE.IOC, post_only: false };
    case "fillOrKill":
      return { order_type: RISEX_ORDER_TYPE.LIMIT, time_in_force: RISEX_TIME_IN_FORCE.FOK, post_only: false };
  }
}

/**
 * Inverse of orderTypeToRiseXFields, for reconstructing `type` on NormalizedOrder from GET
 * /v1/orders/open — which RISEx's open-orders view CAN report (order_type/time_in_force/
 * post_only are all present on the wire there), unlike N1's equivalent live-order cache, which
 * reports none of it (see N1's mapOpenOrder doc comment). Returns undefined for combinations this
 * adapter's own placeOrder() never produces (RISEx's Market order_type, or GTC/GTT time_in_force
 * with post_only true is covered by "postOnly" but GTT alone is not) — an order resting from some
 * other source (e.g. placed directly against RISEx outside this bot) rather than guessed at.
 */
export function mapRiseXOrderType(
  orderType: number,
  timeInForce: number,
  postOnly: boolean,
): OrderType | undefined {
  if (orderType !== RISEX_ORDER_TYPE.LIMIT) return undefined;
  if (timeInForce === RISEX_TIME_IN_FORCE.GTC) return postOnly ? "postOnly" : "limit";
  if (timeInForce === RISEX_TIME_IN_FORCE.IOC && !postOnly) return "immediateOrCancel";
  if (timeInForce === RISEX_TIME_IN_FORCE.FOK && !postOnly) return "fillOrKill";
  return undefined;
}

/** Re-exported so callers don't need a second import from marketRegistry.js just for the type. */
export type { RiseXStepConfig };
