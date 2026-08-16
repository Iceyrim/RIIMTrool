import { describe, expect, it, vi } from "vitest";
import { PERPL_MARKET_DATA_WS_URL, PERPL_REST_BASE_URL, RealPerplMarketDataSource } from "../../../src/adapters/perpl/PerplMarketDataSource.js";

class Socket {
  readyState = 1; sent: string[] = []; listeners = new Map<string, (event: { data?: unknown }) => void>();
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) { this.listeners.set(type, listener); }
  send(value: string) { this.sent.push(value); }
  close() { this.listeners.get("close")?.({}); }
  open() { this.listeners.get("open")?.({}); }
  message(data: unknown) { this.listeners.get("message")?.({ data: JSON.stringify(data) }); }
}
const now = 1_786_881_926_000;
const context = { markets: [
  { market_id: "1", symbol: "BTC", config: { price_decimals: 1, size_decimals: 2, min_posting_amount: "0", is_open: true } },
  { market_id: "20", symbol: "ETH", config: { price_decimals: 2, size_decimals: 3, min_posting_amount: "0", is_open: true } },
] };
const response = { ok: true, status: 200, json: async () => context } as Response;
const subscriptions = [
  { stream: "market-state@143", sid: 3000, status: { code: 0 } },
  { stream: "funding@143", sid: 3000, status: { code: 0 } },
  { stream: "order-book@1", sid: 1000001, status: { code: 0 } },
  { stream: "trades@1", sid: 2000001, status: { code: 0 } },
  { stream: "order-book@20", sid: 1000020, status: { code: 0 } },
  { stream: "trades@20", sid: 2000020, status: { code: 0 } },
];
const at = { b: 96485253, t: now };

async function connected(ids: string[] = ["1", "20"]) {
  const socket = new Socket(); const source = new RealPerplMarketDataSource("https://local.invalid/api", "ws://local", 1_000, async () => response, () => socket, () => now, () => 0.5);
  await source.getMarkets(); const pending = source.connect(ids); socket.open(); await pending; return { source, socket };
}
function acknowledge(source: RealPerplMarketDataSource, count = subscriptions.length) { source.ingest({ mt: 6, sn: 1, subs: subscriptions.slice(0, count) }); }

describe("RealPerplMarketDataSource", () => {
  it("uses the official public endpoints and maps context metadata", async () => {
    expect(PERPL_REST_BASE_URL).toBe("https://app.perpl.xyz/api"); expect(PERPL_MARKET_DATA_WS_URL).toBe("wss://app.perpl.xyz/ws/v1/market-data");
    const fetchMock = vi.fn(async (_input: string | URL | Request) => response);
    const source = new RealPerplMarketDataSource("https://local.invalid/api", "ws://local", 1000, fetchMock as unknown as typeof fetch, () => new Socket());
    expect(await source.getMarkets()).toEqual([{ marketId: "1", symbol: "BTC", priceDecimals: 1, sizeDecimals: 2, minimumPostingSize: 0, open: true }, { marketId: "20", symbol: "ETH", priceDecimals: 2, sizeDecimals: 3, minimumPostingSize: 0, open: true }]);
  });

  it("sends the exact batched mt:5 chain-wide and per-market envelope", async () => {
    const { socket } = await connected(); expect(JSON.parse(socket.sent[0]!)).toEqual({ mt: 5, subs: subscriptions.map(({ stream }) => ({ stream, subscribe: true })) });
  });

  it("validates every acknowledgement and binds per-market SIDs", async () => {
    const { source } = await connected(); expect(() => acknowledge(source, 5)).toThrow(/incomplete/);
    const next = await connected(); expect(() => next.source.ingest({ mt: 6, sn: 1, subs: subscriptions.map((entry, index) => index === 3 ? { ...entry, status: { code: 404, error: "unknown stream" } } : entry) })).toThrow(/trades@1/);
    const valid = await connected(); acknowledge(valid.source); expect(() => valid.source.ingest({ mt: 15, sid: 2000001, sn: 2, at, bid: [], ask: [] })).toThrow(/does not match/);
  });

  it("routes keyed chain-wide state and funding with exact at.t and scaling", async () => {
    const { source } = await connected(); acknowledge(source);
    source.ingest({ mt: 9, sid: 3000, sn: 96485253, d: { "1": { at, orl: 629513, mrk: 629934, bid: 629888, ask: 629889 } } });
    source.ingest({ mt: 10, sid: 4000, sn: 96485253, d: { "1": { at, rate: 40, div: 1 } } });
    expect(source.getMarketState("1")).toMatchObject({ markPrice: 62993.4, indexPrice: 62951.3, timestamp: now });
    expect(source.getFunding("1").rate).toBe(0.00004); expect(() => source.getMarketState("20")).toThrow(/incomplete/);
  });

  it("applies atomic snapshots and upsert/deletion deltas and fails on gaps or crossing", async () => {
    const { source } = await connected(); acknowledge(source);
    source.ingest({ mt: 15, sid: 1000001, sn: 10, at, bid: [{ p: 1000, s: 100, o: 1 }, { p: 990, s: 50, o: 1 }], ask: [{ p: 1010, s: 200, o: 2 }] });
    source.ingest({ mt: 16, sid: 1000001, sn: 11, at, bid: [{ p: 1000, s: 0, o: 0 }], ask: [{ p: 1020, s: 300, o: 1 }] });
    expect(source.getOrderBook("1")).toMatchObject({ bids: [{ price: 99, size: 0.5 }], asks: [{ price: 101, size: 2 }, { price: 102, size: 3 }] });
    expect(() => source.ingest({ mt: 16, sid: 1000001, sn: 13, at, bid: [], ask: [] })).toThrow(/gap/); expect(() => source.getOrderBook("1")).toThrow(/invalid/);
    const crossed = await connected(["1"]); crossed.source.ingest({ mt: 6, sn: 1, subs: subscriptions.slice(0, 4) });
    expect(() => crossed.source.ingest({ mt: 15, sid: 1000001, sn: 1, at, bid: [{ p: 1010, s: 1, o: 1 }], ask: [{ p: 1000, s: 1, o: 1 }] })).toThrow(/crossed/);
  });

  it("ingests mt:17 trades with stable verified transaction identity and per-stream freshness", async () => {
    const { source } = await connected(); acknowledge(source);
    source.ingest({ mt: 17, sid: 2000001, sn: 20, d: [{ at: { ...at, tx: 6, txid: "8e2dd8da", l: 6 }, p: 629888, s: 329, sd: 2 }, { at: { ...at, tx: 6, txid: "8e2dd8da", l: 14 }, p: 629889, s: 1182, sd: 1 }] });
    const trades = source.getRecentTrades("1"); expect(trades).toHaveLength(2); expect(trades[0]!.id).not.toBe(trades[1]!.id); expect(trades.find((trade) => trade.takerSide === "sell")).toMatchObject({ price: 62988.8, size: 3.29, timestamp: now });
    expect(() => source.ingest({ mt: 18, sid: 2000001, sn: 20, d: [] })).toThrow(/non-increasing/);
  });

  it("clears readiness on disconnect and enforces the corrected subscription cap", async () => {
    const { source } = await connected(); acknowledge(source); source.ingest({ mt: 15, sid: 1000001, sn: 1, at, bid: [{ p: 1000, s: 1, o: 1 }], ask: [{ p: 1010, s: 1, o: 1 }] }); await source.disconnect(); expect(() => source.getOrderBook("1")).toThrow(/disconnected/);
    const many = new RealPerplMarketDataSource("https://local.invalid", "ws://local", 10, async () => ({ ok: true, status: 200, json: async () => ({ markets: Array.from({ length: 8 }, (_, i) => ({ ...context.markets[0], market_id: String(i), symbol: `M${i}` })) }) }) as Response, () => new Socket());
    await many.getMarkets(); await expect(many.connect(Array.from({ length: 8 }, (_, i) => String(i)))).rejects.toThrow(/16/);
  });

  it("uses the confirmed public candle path", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => response); const source = new RealPerplMarketDataSource("https://local.invalid/api", "ws://local", 1000, fetchMock as unknown as typeof fetch, () => new Socket()); await source.getMarkets(); fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] } as Response); await source.getCandles("1", { interval: "60", fromMs: 1000, toMs: 2000 }); expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://local.invalid/api/v1/market-data/1/candles/60/1000-2000");
  });
});
