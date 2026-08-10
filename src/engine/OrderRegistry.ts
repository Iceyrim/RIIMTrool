import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LocalOrder, LocalOrderState } from "./types.js";

/**
 * Per-market local order state, persisted to disk. Implements the three fixes from SPEC.md
 * Section 6's "local order-registry files went stale or corrupted repeatedly" lesson:
 *  (a) atomic writes — temp file + rename, never write-in-place
 *  (b) load falls back to an empty/safe state with a loud warning on any corruption, rather than
 *      crashing or retrying indefinitely
 *  (c) prune() removes old terminal (FILLED/CANCELLED) entries on a schedule
 *
 * A registry instance is scoped to exactly one market (SPEC.md Section 4.5: order registries
 * must be keyed by market, never a single flat list assumed to belong to one market).
 */
export class OrderRegistry {
  private orders = new Map<string, LocalOrder>();

  constructor(
    private readonly market: string,
    private readonly filePath: string,
  ) {}

  list(): LocalOrder[] {
    return [...this.orders.values()];
  }

  listByState(state: LocalOrderState): LocalOrder[] {
    return this.list().filter((o) => o.state === state);
  }

  get(clientOrderId: string): LocalOrder | undefined {
    return this.orders.get(clientOrderId);
  }

  findByExchangeOrderId(exchangeOrderId: string): LocalOrder | undefined {
    return this.list().find((o) => o.exchangeOrderId === exchangeOrderId);
  }

  upsert(order: LocalOrder): void {
    if (order.market !== this.market) {
      throw new Error(
        `OrderRegistry for market "${this.market}" received an order for market "${order.market}"`,
      );
    }
    this.orders.set(order.clientOrderId, order);
  }

  remove(clientOrderId: string): void {
    this.orders.delete(clientOrderId);
  }

  /** Wholesale replace — used only by startup reconciliation, which is the one place local
   * state is allowed to be discarded and reseeded wholesale from exchange truth rather than
   * incrementally reconciled. */
  replaceAll(orders: LocalOrder[]): void {
    for (const order of orders) {
      if (order.market !== this.market) {
        throw new Error(
          `OrderRegistry for market "${this.market}" received replaceAll() containing market "${order.market}"`,
        );
      }
    }
    this.orders = new Map(orders.map((o) => [o.clientOrderId, o]));
  }

  load(): void {
    try {
      const contents = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(contents) as LocalOrder[];
      this.orders = new Map(parsed.map((o) => [o.clientOrderId, o]));
    } catch (err) {
      console.warn(
        `[OrderRegistry:${this.market}] failed to load state from "${this.filePath}", ` +
          `starting from empty state: ${String(err)}. ` +
          `Startup reconciliation will reseed truth from the exchange regardless.`,
      );
      this.orders = new Map();
    }
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.list(), null, 2), "utf-8");
    renameSync(tmpPath, this.filePath);
  }

  /** Removes terminal (FILLED/CANCELLED) entries older than `olderThanMs`. Returns the count
   * removed. Callers are responsible for calling save() afterward if persistence is desired. */
  prune(olderThanMs: number, now: number = Date.now()): number {
    let removed = 0;
    for (const [clientOrderId, order] of this.orders) {
      const isTerminal = order.state === "CANCELLED" || order.state === "FILLED";
      if (isTerminal && now - order.updatedAt > olderThanMs) {
        this.orders.delete(clientOrderId);
        removed++;
      }
    }
    return removed;
  }
}
