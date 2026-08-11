import type { OrderSide } from "../adapters/ExchangeAdapter.js";
import type { ReconciliationAnomaly } from "../engine/Reconciliation.js";

/**
 * Generic, exchange/transport-agnostic events the operational-alerting layer cares about.
 * Deliberately has no notion of Telegram (or any other sink) — PaperRunner/TradeLog emit these,
 * and only a concrete AlertSink implementation (e.g. TelegramAlertSink) knows how to deliver
 * them, keeping that separation-of-concerns discipline consistent with the rest of this codebase.
 */
export type AlertEvent =
  | {
      type: "fill";
      market: string;
      side: OrderSide;
      size: number;
      price: number;
      isReduceOnly: boolean;
    }
  | {
      type: "reconciliation_degraded";
      market: string;
      anomalies: ReconciliationAnomaly[];
    }
  | {
      type: "reconciliation_recovered";
      market: string;
    }
  | {
      type: "halted";
      market: string;
      reason: string;
    }
  | {
      type: "resumed";
      market: string;
    }
  | {
      type: "error";
      market?: string;
      message: string;
    };

export interface AlertSink {
  handle(event: AlertEvent): void;
}

/**
 * In-process pub/sub. A sink throwing (e.g. a network error inside a sink that forgot to catch
 * it) must never propagate back into trading code — caught and logged here, same "a notification
 * failure must never interfere with trading logic" rule the predecessor bots' Telegram integration
 * followed.
 */
export class AlertBus {
  private readonly sinks: AlertSink[] = [];

  subscribe(sink: AlertSink): void {
    this.sinks.push(sink);
  }

  emit(event: AlertEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.handle(event);
      } catch (err) {
        console.error(`[AlertBus] sink threw handling "${event.type}": ${String(err)}`);
      }
    }
  }
}
