import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NormalizedFill, OrderSide } from "../adapters/ExchangeAdapter.js";

/** Which code path recognized this fill — useful for tracing divergence, not required by
 * SPEC.md Section 7's minimum field list. */
export type TradeLogSource = "placement" | "cancel_race_check" | "reconciliation";

export interface TradeLogEntry {
  timestamp: number; // unix ms, from NormalizedFill.timestamp
  market: string;
  side: OrderSide;
  size: number;
  price: number;
  /** false = normal quoting, true = reduce-only exit (SPEC.md Section 7's required distinction). */
  isReduceOnly: boolean;
  clientOrderId: string;
  exchangeOrderId: string;
  /** Absent for fills reported synchronously by placeOrder() itself — see NormalizedFill. */
  tradeId?: string;
  source: TradeLogSource;
}

/**
 * Durable, append-only fill log (SPEC.md Section 7). One JSONL line per real fill, written from
 * inside OrderLifecycle and Reconciliation — the only places a fill is ever recognized — so every
 * market and every adapter (paper today, live and a second exchange later) logs identically with
 * no per-adapter or per-market code path that could silently diverge.
 */
export class TradeLog {
  // getOrderFills() reports an order's full fill history on every call, not just fills new since
  // the last call (see OrderLifecycle.cancelOrder's comment) — a retried cancel or a repeated
  // reconciliation pass can hand back a fill already logged. Deduping here, keyed by tradeId when
  // present, is what keeps this file exactly-once per fill despite that.
  private readonly seen = new Set<string>();

  constructor(private readonly filePath: string) {}

  record(
    fill: NormalizedFill,
    meta: { isReduceOnly: boolean; clientOrderId: string; source: TradeLogSource },
  ): void {
    const key =
      fill.tradeId ?? `${fill.exchangeOrderId}:${fill.timestamp}:${fill.price}:${fill.size}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    const entry: TradeLogEntry = {
      timestamp: fill.timestamp,
      market: fill.market,
      side: fill.side,
      size: fill.size,
      price: fill.price,
      isReduceOnly: meta.isReduceOnly,
      clientOrderId: meta.clientOrderId,
      exchangeOrderId: fill.exchangeOrderId,
      tradeId: fill.tradeId,
      source: meta.source,
    };

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      // A logging failure must never block trading or create a new stuck state (SPEC.md Section
      // 5a's "fail open" precedent) — loud but non-fatal.
      console.error(`[TradeLog] failed to append fill to "${this.filePath}": ${String(err)}`);
    }
  }
}
