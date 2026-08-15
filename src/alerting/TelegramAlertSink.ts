import type { AlertEvent, AlertSink } from "./AlertBus.js";

export interface TelegramAlertSinkOptions {
  botToken: string;
  chatId: string;
  /** Prefixed onto every formatted message, e.g. "[N1]". Market symbols can collide across
   * concurrently-running paper-mode entrypoint scripts (e.g. BTCUSD exists in both the N1 config
   * and the RISEx validation config) — this is what lets a human reading one shared Telegram chat
   * tell which script an alert came from. AlertEvent itself stays exchange/mode-agnostic; this is
   * purely a presentation-layer prefix, not a structured field. */
  modeLabel?: string;
  /** Override for tests only — defaults to the real Telegram Bot API host. */
  apiBaseUrl?: string;
}

export interface AlertDeliveryHealth {
  enabled: boolean;
  attempted: number;
  delivered: number;
  failed: number;
  pending: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastErrorCategory?: "http" | "network";
}

/**
 * Delivers AlertEvents to a Telegram chat via the Bot API's sendMessage endpoint. handle() is
 * synchronous (the AlertSink interface) so the network call itself runs detached — its rejection
 * or a non-2xx response is caught and logged inside send(), never propagated back out of handle().
 * AlertBus's own try/catch only guards a synchronous throw out of handle(), not a promise merely
 * started inside it, so this class must do its own catching to honor the same "a notification
 * failure must never touch trading" rule AlertBus.ts documents.
 */
export class TelegramAlertSink implements AlertSink {
  private readonly apiBaseUrl: string;
  private readonly health: AlertDeliveryHealth = { enabled: true, attempted: 0, delivered: 0, failed: 0, pending: 0 };

  constructor(private readonly options: TelegramAlertSinkOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
  }

  handle(event: AlertEvent): void {
    const prefix = this.options.modeLabel ? `[${this.options.modeLabel}] ` : "";
    void this.send(prefix + formatEvent(event));
  }

  getDeliveryHealth(): Readonly<AlertDeliveryHealth> { return Object.freeze({ ...this.health }); }

  private async send(text: string): Promise<void> {
    try { this.health.attempted++; this.health.pending++; this.health.lastAttemptAt = Date.now(); } catch { /* observability only */ }
    try {
      const url = `${this.apiBaseUrl}/bot${this.options.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.options.chatId, text }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error(`[TelegramAlertSink] Telegram API returned ${response.status}: ${body}`);
        try { this.health.failed++; this.health.lastFailureAt = Date.now(); this.health.lastErrorCategory = "http"; } catch { /* observability only */ }
      } else {
        try { this.health.delivered++; this.health.lastSuccessAt = Date.now(); delete this.health.lastErrorCategory; } catch { /* observability only */ }
      }
    } catch (err) {
      console.error(`[TelegramAlertSink] failed to deliver alert: ${String(err)}`);
      try { this.health.failed++; this.health.lastFailureAt = Date.now(); this.health.lastErrorCategory = "network"; } catch { /* observability only */ }
    } finally {
      try { this.health.pending = Math.max(0, this.health.pending - 1); } catch { /* observability only */ }
    }
  }
}

function formatEvent(event: AlertEvent): string {
  switch (event.type) {
    case "fill": {
      const tag = event.isReduceOnly ? " (reduce-only)" : "";
      return `[${event.market}] Fill: ${event.side.toUpperCase()} ${event.size} @ ${event.price}${tag}`;
    }
    case "reconciliation_degraded": {
      const kinds = event.anomalies.map((a) => a.kind).join(", ");
      return `[${event.market}] Reconciliation DEGRADED (${event.anomalies.length} anomaly): ${kinds}`;
    }
    case "reconciliation_recovered":
      return `[${event.market}] Reconciliation recovered`;
    case "halted":
      return `[${event.market}] HALTED: ${event.reason}`;
    case "resumed":
      return `[${event.market}] Resumed — placing orders again`;
    case "error":
      return `${event.market ? `[${event.market}] ` : ""}ERROR: ${event.message}`;
  }
}
