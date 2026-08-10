import type { OrderSide } from "../ExchangeAdapter.js";

export interface SimulatedRestingOrder {
  exchangeOrderId: string;
  side: OrderSide;
  price: number;
  remainingSize: number;
}

export interface TradeTapePrint {
  tradeId: string;
  price: number;
  size: number;
  /** The side of the party that initiated (crossed into) this trade. */
  takerSide: OrderSide;
  timestamp: number;
}

export interface SimulatedFill {
  exchangeOrderId: string;
  tradeId: string;
  price: number;
  size: number;
  timestamp: number;
}

/**
 * Crosses real N1 trade-tape prints against our resting simulated orders, in print order.
 *
 * A resting BUY (bid) fills when a print shows a taker SELL at a price at or below our bid —
 * i.e. a real seller crossed at or through our level. A resting SELL (ask) fills symmetrically
 * against a taker BUY at or above our ask. A single print can partially fill an order (matched
 * to whichever is smaller: remaining print size or remaining order size) and, if size remains,
 * continue crossing our other eligible resting orders at that print.
 *
 * When more than one of our own resting orders is eligible for the same print, the
 * price-most-aggressive one (our highest bid / our lowest ask — the one a real matching engine
 * would reach first) is matched first. This does NOT model queue position among OTHER market
 * participants resting at the same price ahead of us — we have no visibility into that from
 * public trade-tape data, so this is a deliberately optimistic approximation, not a claim of
 * exact realism. Good enough to exercise the engine's real fill-handling logic against real
 * market timing; not a substitute for a true backtest against full order-book depth.
 */
export function simulateFills(
  restingOrders: readonly SimulatedRestingOrder[],
  prints: readonly TradeTapePrint[],
): SimulatedFill[] {
  const fills: SimulatedFill[] = [];
  const remaining = new Map(restingOrders.map((o) => [o.exchangeOrderId, o.remainingSize]));

  for (const print of prints) {
    let printSizeLeft = print.size;
    if (printSizeLeft <= 0) continue;

    // A taker SELL crosses our resting BUYs; a taker BUY crosses our resting SELLs.
    const eligibleSide: OrderSide = print.takerSide === "sell" ? "buy" : "sell";

    const candidates = restingOrders
      .filter((o) => o.side === eligibleSide)
      .filter((o) => (eligibleSide === "buy" ? print.price <= o.price : print.price >= o.price))
      .sort((a, b) => (eligibleSide === "buy" ? b.price - a.price : a.price - b.price));

    for (const order of candidates) {
      if (printSizeLeft <= 0) break;
      const left = remaining.get(order.exchangeOrderId) ?? 0;
      if (left <= 0) continue;

      const matched = Math.min(left, printSizeLeft);
      fills.push({
        exchangeOrderId: order.exchangeOrderId,
        tradeId: print.tradeId,
        price: order.price,
        size: matched,
        timestamp: print.timestamp,
      });
      remaining.set(order.exchangeOrderId, left - matched);
      printSizeLeft -= matched;
    }
  }

  return fills;
}
