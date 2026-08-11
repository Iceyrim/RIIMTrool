import { AlertBus } from "./AlertBus.js";
import { TelegramAlertSink } from "./TelegramAlertSink.js";

/**
 * Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from the environment and, if both are present,
 * returns an AlertBus with a TelegramAlertSink already subscribed (tagged with modeLabel — see
 * TelegramAlertSinkOptions). Returns undefined (alerting disabled, logged once) if either is
 * missing, since alerting is optional and every paper-mode entrypoint script must keep running
 * without it. Shared by every entrypoint script instead of duplicating this parsing three times.
 */
export function createAlertBusFromEnv(modeLabel: string): AlertBus | undefined {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.log(
      "[alerting] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — Telegram alerting disabled",
    );
    return undefined;
  }
  const alertBus = new AlertBus();
  alertBus.subscribe(new TelegramAlertSink({ botToken, chatId, modeLabel }));
  return alertBus;
}
