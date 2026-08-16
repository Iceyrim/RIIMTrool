import { ExchangeAdapterError } from "../AdapterError.js";
import { finiteNumber, scaledToNumber, timestampMs } from "./mappers.js";
import type { PerplCandleRaw, PerplChannel, PerplContextRaw, PerplMarketRaw, PerplWireMessage } from "./types.js";

export const PERPL_REST_BASE_URL = "https://app.perpl.xyz/api";
export const PERPL_MARKET_DATA_WS_URL = "wss://app.perpl.xyz/ws/v1/market-data";
const CHANNELS: readonly PerplChannel[] = ["market-state", "order-book", "trades", "funding"];

export interface PerplMarket {
  marketId: string; symbol: string; priceDecimals: number; sizeDecimals: number;
  minimumPostingSize: number; open: boolean;
}
export interface PerplBookLevel { price: number; size: number }
export interface PerplOrderBook { marketId: string; bids: PerplBookLevel[]; asks: PerplBookLevel[]; sequence: bigint; timestamp: number }
export interface PerplTrade { id: string; marketId: string; takerSide: "buy" | "sell"; price: number; size: number; timestamp: number; sequence: bigint }
export interface PerplMarketState { marketId: string; markPrice: number; indexPrice: number; open: boolean; timestamp: number; sequence: bigint }
export interface PerplFunding { marketId: string; rate: number; timestamp: number; sequence: bigint }
export interface PerplCandle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

export interface PerplMarketDataSource {
  connect(marketIds: readonly string[]): Promise<void>;
  disconnect(): Promise<void>;
  getMarkets(): Promise<PerplMarket[]>;
  getMarketState(marketId: string): PerplMarketState;
  getOrderBook(marketId: string): PerplOrderBook;
  getRecentTrades(marketId: string, after?: { timestamp: number; ids: ReadonlySet<string> }): PerplTrade[];
  getFunding(marketId: string): PerplFunding;
  getCandles(marketId: string, params: { interval: string; fromMs: number; toMs: number }): Promise<PerplCandle[]>;
}

interface SocketLike {
  readyState: number; send(data: string): void; close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}
type SocketFactory = (url: string) => SocketLike;
type FetchLike = typeof fetch;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExchangeAdapterError(`Perpl ${label} is malformed`);
  return value as Record<string, unknown>;
}
function scaledValue(value: unknown, field: string): string | number | bigint {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new ExchangeAdapterError(`Perpl ${field} is malformed`);
  }
  return value;
}
function marketIdOf(raw: PerplMarketRaw): string {
  const id = raw.market_id ?? raw.id;
  if (id === undefined || String(id).length === 0) throw new ExchangeAdapterError("Perpl context omitted market id");
  return String(id);
}
function mapMarket(raw: PerplMarketRaw): PerplMarket {
  const symbol = [raw.symbol, raw.name].find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
  if (!symbol) throw new ExchangeAdapterError("Perpl context omitted market symbol");
  const priceDecimals = finiteNumber(raw.config?.price_decimals ?? raw.price_decimals, "price_decimals");
  const sizeDecimals = finiteNumber(raw.config?.size_decimals ?? raw.size_decimals, "size_decimals");
  const minimumRaw = raw.config?.min_posting_amount ?? raw.min_posting_amount ?? raw.minimum_posting_size ?? raw.min_posting_size;
  if (minimumRaw === undefined) throw new ExchangeAdapterError("Perpl context omitted minimum posting size");
  const minimumPostingSize = typeof minimumRaw === "string" && /^\d+$/.test(minimumRaw)
    ? scaledToNumber(minimumRaw, sizeDecimals, "minimum posting size") : finiteNumber(minimumRaw, "minimum posting size");
  const open = raw.config?.is_open ?? raw.is_open ?? (raw.status === "open" || raw.status === "OPEN" || raw.status === "active");
  if (minimumPostingSize < 0) throw new ExchangeAdapterError("Perpl minimum posting size must be non-negative");
  return { marketId: marketIdOf(raw), symbol, priceDecimals, sizeDecimals, minimumPostingSize, open };
}

export class RealPerplMarketDataSource implements PerplMarketDataSource {
  private markets = new Map<string, PerplMarket>();
  private states = new Map<string, PerplMarketState>();
  private books = new Map<string, PerplOrderBook>();
  private trades = new Map<string, PerplTrade[]>();
  private funding = new Map<string, PerplFunding>();
  private sequences = new Map<string, bigint>();
  private invalid = new Map<string, string>();
  private socket?: SocketLike;
  private connected = false;
  private deliberatelyClosed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private subscribedMarketIds: string[] = [];
  private requestTimes: number[] = [];

  constructor(
    private readonly restBaseUrl = PERPL_REST_BASE_URL,
    private readonly wsUrl = PERPL_MARKET_DATA_WS_URL,
    private readonly staleAfterMs = 15_000,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  private async json(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(`${this.restBaseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    let response: Response;
    try { response = await this.fetchImpl(url, { method: "GET", credentials: "omit", redirect: "error" }); }
    catch (error) { throw new ExchangeAdapterError(`Perpl public GET failed: ${String(error)}`, error, true); }
    if (!response.ok) throw new ExchangeAdapterError(`Perpl public GET returned HTTP ${response.status}`, undefined, response.status >= 500);
    return response.json();
  }

  async getMarkets(): Promise<PerplMarket[]> {
    const raw = await this.json("v1/pub/context") as PerplContextRaw;
    const nested = raw.data;
    const list = raw.markets ?? (Array.isArray(nested) ? nested : nested?.markets);
    if (!Array.isArray(list) || list.length === 0) throw new ExchangeAdapterError("Perpl context contains no markets");
    const mapped = list.map(mapMarket);
    this.markets = new Map(mapped.map((market) => [market.marketId, market]));
    return mapped;
  }

  async connect(marketIds: readonly string[]): Promise<void> {
    if (marketIds.length * CHANNELS.length > 16) throw new ExchangeAdapterError("Perpl subscription limit exceeded (16)");
    for (const id of marketIds) if (!this.markets.has(id)) throw new ExchangeAdapterError(`Perpl market id ${id} was not dynamically discovered`);
    this.subscribedMarketIds = [...marketIds]; this.deliberatelyClosed = false;
    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(this.wsUrl); this.socket = socket;
      socket.addEventListener("open", () => { this.connected = true; this.reconnectAttempt = 0; try { this.subscribe(); resolve(); } catch (e) { reject(e); } });
      socket.addEventListener("message", (event) => { try { this.ingest(typeof event.data === "string" ? event.data : String(event.data)); } catch (e) { for (const id of this.subscribedMarketIds) this.invalid.set(id, String(e)); } });
      socket.addEventListener("close", () => { this.connected = false; for (const id of this.subscribedMarketIds) this.invalid.set(id, "disconnected"); if (!this.deliberatelyClosed) this.scheduleReconnect(); });
      socket.addEventListener("error", () => { this.connected = false; });
    });
  }

  private subscribe(): void {
    const now = this.now(); this.requestTimes = this.requestTimes.filter((time) => now - time < 60_000);
    if (this.requestTimes.length >= 10) throw new ExchangeAdapterError("Perpl subscription request limit exceeded (10/minute)");
    this.requestTimes.push(now);
    this.socket?.send(JSON.stringify({ op: "subscribe", subscriptions: this.subscribedMarketIds.flatMap((market_id) => CHANNELS.map((channel) => ({ channel, market_id }))) }));
  }

  private scheduleReconnect(): void {
    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
    const base = delays[Math.min(this.reconnectAttempt++, delays.length - 1)]!;
    const delay = Math.round(base * (0.8 + this.random() * 0.4));
    this.reconnectTimer = setTimeout(() => { void this.openSocket().catch(() => this.scheduleReconnect()); }, delay);
  }

  async disconnect(): Promise<void> { this.deliberatelyClosed = true; this.connected = false; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.socket?.close(); }

  /** Public solely for deterministic offline transport tests. */
  ingest(payload: string | PerplWireMessage): void {
    let marketId = "";
    try {
      const preview = typeof payload === "string" ? JSON.parse(payload) as PerplWireMessage : payload;
      marketId = String(preview.market_id ?? preview.marketId ?? "");
      this.ingestValidated(preview);
    } catch (error) {
      if (marketId) this.invalid.set(marketId, String(error));
      throw error instanceof ExchangeAdapterError ? error : new ExchangeAdapterError(`Perpl message is malformed: ${String(error)}`);
    }
  }

  private ingestValidated(message: PerplWireMessage): void {
    const channel = message.channel ?? message.type; const marketId = String(message.market_id ?? message.marketId ?? "");
    if (!CHANNELS.includes(channel as PerplChannel) || !this.markets.has(marketId)) throw new ExchangeAdapterError("Perpl message has unknown channel or market");
    const seqRaw = message.sequence ?? message.seq; if (seqRaw === undefined || !/^\d+$/.test(String(seqRaw))) throw new ExchangeAdapterError("Perpl message has malformed sequence");
    const sequence = BigInt(String(seqRaw)); const key = `${marketId}:${channel}`; const previous = this.sequences.get(key);
    if (previous !== undefined && sequence !== previous + 1n) { this.invalid.set(marketId, "sequence gap"); this.subscribe(); throw new ExchangeAdapterError(`Perpl sequence gap for ${key}`); }
    const timestamp = timestampMs(message.timestamp ?? message.ts); const data = record(message.data, `${channel} data`); const market = this.markets.get(marketId)!;
    this.sequences.set(key, sequence); this.invalid.delete(marketId);
    if (channel === "market-state") {
      const open = data.is_open ?? data.open; if (open !== true) throw new ExchangeAdapterError("Perpl market is not open");
      this.states.set(marketId, { marketId, markPrice: scaledToNumber(scaledValue(data.mark_price, "mark price"), market.priceDecimals, "mark price"), indexPrice: scaledToNumber(scaledValue(data.index_price, "index price"), market.priceDecimals, "index price"), open: true, timestamp, sequence });
    } else if (channel === "order-book") {
      const levels = (side: "bids" | "asks") => {
        const raw = data[side]; if (!Array.isArray(raw) || raw.length === 0) throw new ExchangeAdapterError(`Perpl ${side} are incomplete`);
        return raw.map((item) => { const level = Array.isArray(item) ? { price: item[0], size: item[1] } : record(item, "book level"); const price = scaledToNumber(scaledValue(level.price, "book price"), market.priceDecimals, "book price"); const size = scaledToNumber(scaledValue(level.size, "book size"), market.sizeDecimals, "book size"); if (!(price > 0 && size > 0)) throw new ExchangeAdapterError("Perpl book level is invalid"); return { price, size }; });
      };
      const bids = levels("bids").sort((a,b) => b.price-a.price), asks = levels("asks").sort((a,b) => a.price-b.price);
      if (bids[0]!.price >= asks[0]!.price) throw new ExchangeAdapterError("Perpl order book is crossed");
      this.books.set(marketId, { marketId, bids, asks, sequence, timestamp });
    } else if (channel === "trades") {
      const items = Array.isArray(data.trades) ? data.trades : [data]; const target = this.trades.get(marketId) ?? [];
      for (const item of items) { const trade = record(item, "trade"); const id = String(trade.id ?? trade.trade_id ?? ""); const side = String(trade.taker_side ?? trade.side).toLowerCase(); if (!id || (side !== "buy" && side !== "sell")) throw new ExchangeAdapterError("Perpl trade is malformed"); target.push({ id, marketId, takerSide: side, price: scaledToNumber(scaledValue(trade.price, "trade price"), market.priceDecimals, "trade price"), size: scaledToNumber(scaledValue(trade.size, "trade size"), market.sizeDecimals, "trade size"), timestamp: timestampMs(trade.timestamp ?? timestamp), sequence }); }
      this.trades.set(marketId, target.slice(-1000));
    } else this.funding.set(marketId, { marketId, rate: finiteNumber(data.rate ?? data.funding_rate, "funding rate"), timestamp, sequence });
  }

  private requireFresh<T extends { timestamp: number }>(marketId: string, value: T | undefined, label: string): T {
    if (!this.connected) throw new ExchangeAdapterError("Perpl market data is disconnected");
    const reason = this.invalid.get(marketId); if (reason) throw new ExchangeAdapterError(`Perpl market data invalid: ${reason}`);
    if (!value) throw new ExchangeAdapterError(`Perpl ${label} is incomplete`);
    if (this.now() - value.timestamp > this.staleAfterMs) throw new ExchangeAdapterError(`Perpl ${label} is stale`);
    return value;
  }
  getMarketState(id: string): PerplMarketState { return this.requireFresh(id, this.states.get(id), "market state"); }
  getOrderBook(id: string): PerplOrderBook { return this.requireFresh(id, this.books.get(id), "order book"); }
  getFunding(id: string): PerplFunding { return this.requireFresh(id, this.funding.get(id), "funding"); }
  getRecentTrades(id: string, after?: { timestamp: number; ids: ReadonlySet<string> }): PerplTrade[] { const all = this.trades.get(id); const latest = all?.at(-1); this.requireFresh(id, latest, "trades"); return (all ?? []).filter((t) => !after || t.timestamp > after.timestamp || (t.timestamp === after.timestamp && !after.ids.has(t.id))); }

  async getCandles(marketId: string, params: { interval: string; fromMs: number; toMs: number }): Promise<PerplCandle[]> {
    if (!this.markets.has(marketId)) throw new ExchangeAdapterError("Perpl candle market was not discovered");
    const raw = await this.json(`v1/market-data/${marketId}/candles/${params.interval}/${params.fromMs}-${params.toMs}`);
    const list = Array.isArray(raw) ? raw : (record(raw, "candles").data ?? record(raw, "candles").candles);
    if (!Array.isArray(list)) throw new ExchangeAdapterError("Perpl candles are malformed");
    return (list as PerplCandleRaw[]).map((c) => ({ timestamp: timestampMs(c.timestamp ?? c.time), open: finiteNumber(c.open, "candle open"), high: finiteNumber(c.high, "candle high"), low: finiteNumber(c.low, "candle low"), close: finiteNumber(c.close, "candle close"), volume: finiteNumber(c.volume, "candle volume") }));
  }
}
