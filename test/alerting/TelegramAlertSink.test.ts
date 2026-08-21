import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertEvent } from "../../src/alerting/AlertBus.js";
import { TelegramAlertSink } from "../../src/alerting/TelegramAlertSink.js";

const BASE_URL = "https://api.telegram.org";
const BOT_TOKEN = "fake-bot-token";
const CHAT_ID = "fake-chat-id";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function callInit(call: unknown[]): FetchCallInit {
  return call[1] as FetchCallInit;
}

describe("TelegramAlertSink", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function newSink(overrides: Partial<ConstructorParameters<typeof TelegramAlertSink>[0]> = {}) {
    return new TelegramAlertSink({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      apiBaseUrl: BASE_URL,
      ...overrides,
    });
  }

  it("handle() is synchronous and does not await the network call itself", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    const sink = newSink();
    expect(() => sink.handle({ type: "reconciliation_recovered", market: "BTCUSD" })).not.toThrow();
  });

  it("POSTs to the correct sendMessage URL with chat_id and formatted text in the body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const sink = newSink();

    sink.handle({ type: "halted", market: "BTCUSD", reason: "margin check failed" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/bot${BOT_TOKEN}/sendMessage`);

    const init = callInit(fetchMock.mock.calls[0]!);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    const body = JSON.parse(init.body!) as { chat_id: string; text: string };
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.text).toContain("BTCUSD");
    expect(body.text).toContain("HALTED");
    expect(body.text).toContain("margin check failed");
  });

  it("prefixes the formatted text with [modeLabel] when configured", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const sink = newSink({ modeLabel: "RISEX" });

    sink.handle({ type: "reconciliation_recovered", market: "ETHUSD" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const init = callInit(fetchMock.mock.calls[0]!);
    const body = JSON.parse(init.body!) as { text: string };
    expect(body.text.startsWith("[RISEX] ")).toBe(true);
  });

  it("omits the prefix entirely when modeLabel is not configured", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const sink = newSink();

    sink.handle({ type: "reconciliation_recovered", market: "ETHUSD" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const init = callInit(fetchMock.mock.calls[0]!);
    const body = JSON.parse(init.body!) as { text: string };
    // formatEvent() itself brackets the market symbol (e.g. "[ETHUSD] ..."), so the absence of a
    // modeLabel prefix has to be checked against the exact expected text, not just "starts with
    // [" — that would also match the market-symbol bracket and pass even with a bug.
    expect(body.text).toBe("[ETHUSD] Reconciliation recovered");
  });

  const formattingCases: Array<{ event: AlertEvent; expectSubstrings: string[] }> = [
    {
      event: { type: "fill", market: "BTCUSD", side: "buy", size: 0.01, price: 60000, isReduceOnly: false },
      expectSubstrings: ["BTCUSD", "BUY", "0.01", "60000"],
    },
    {
      event: { type: "fill", market: "BTCUSD", side: "sell", size: 0.02, price: 61000, isReduceOnly: true },
      expectSubstrings: ["reduce-only"],
    },
    {
      event: {
        type: "reconciliation_degraded",
        market: "ETHUSD",
        anomalies: [{ kind: "EXCHANGE_ORDER_NOT_LOCAL", exchangeOrderId: "e1", detail: "surprise order" }],
      },
      expectSubstrings: ["ETHUSD", "DEGRADED", "EXCHANGE_ORDER_NOT_LOCAL"],
    },
    {
      event: { type: "reconciliation_recovered", market: "ETHUSD" },
      expectSubstrings: ["ETHUSD", "recovered"],
    },
    {
      event: { type: "halted", market: "BTCUSD", reason: "daily realized-PnL loss cap reached" },
      expectSubstrings: ["BTCUSD", "HALTED", "daily realized-PnL loss cap reached"],
    },
    {
      event: { type: "resumed", market: "BTCUSD" },
      expectSubstrings: ["BTCUSD", "Resumed"],
    },
    {
      event: { type: "error", market: "BTCUSD", message: "adapter threw" },
      expectSubstrings: ["BTCUSD", "ERROR", "adapter threw"],
    },
    {
      event: { type: "error", message: "unrelated to any single market" },
      expectSubstrings: ["ERROR", "unrelated to any single market"],
    },
  ];

  it.each(formattingCases)(
    "formats a $event.type event with the expected content",
    async ({ event, expectSubstrings }) => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const sink = newSink();

      sink.handle(event);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const init = callInit(fetchMock.mock.calls[0]!);
      const body = JSON.parse(init.body!) as { text: string };
      for (const substring of expectSubstrings) {
        expect(body.text).toContain(substring);
      }
    },
  );

  it("does not throw when the Telegram API returns a non-2xx response — logged, not propagated", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, description: "bad request" }, 400));
    const sink = newSink();

    expect(() => sink.handle({ type: "resumed", market: "BTCUSD" })).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("does not throw when fetch itself rejects (network error) — logged, not propagated", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const sink = newSink();

    expect(() => sink.handle({ type: "resumed", market: "BTCUSD" })).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sink.getDeliveryHealth()).toMatchObject({ attempted: 1, failed: 1, pending: 0, lastErrorCategory: "network" }));
  });

  it("publishes delivery health without credentials or message contents", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const sink = newSink();
    sink.handle({ type: "error", message: "sensitive message" });
    await vi.waitFor(() => expect(sink.getDeliveryHealth().delivered).toBe(1));
    const serialized = JSON.stringify(sink.getDeliveryHealth());
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain(CHAT_ID);
    expect(serialized).not.toContain("sensitive message");
  });
});
