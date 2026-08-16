import { ExchangeAdapterError } from "../AdapterError.js";
import { blockTimestamp, finiteNumber, scaledToNumber, timestampMs } from "./mappers.js";
import type { PerplCandleRaw, PerplContextRaw, PerplMarketRaw, PerplStreamKind, PerplSubscriptionRequest, PerplWireMessage } from "./types.js";

export const PERPL_REST_BASE_URL = "https://app.perpl.xyz/api";
export const PERPL_MARKET_DATA_WS_URL = "wss://app.perpl.xyz/ws/v1/market-data";
const CHAIN_ID = 143;

export interface PerplMarket { marketId: string; symbol: string; priceDecimals: number; sizeDecimals: number; minimumPostingSize: number; open: boolean }
export interface PerplBookLevel { price: number; size: number }
export interface PerplOrderBook { marketId: string; bids: PerplBookLevel[]; asks: PerplBookLevel[]; sequence: bigint; timestamp: number }
export interface PerplTrade { id: string; marketId: string; takerSide: "buy" | "sell"; price: number; size: number; timestamp: number; sequence: bigint }
export interface PerplMarketState { marketId: string; markPrice: number; indexPrice: number; open: boolean; timestamp: number; sequence: bigint }
export interface PerplFunding { marketId: string; rate: number; timestamp: number; sequence: bigint }
export interface PerplCandle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

export interface PerplMarketDataSource {
  connect(marketIds: readonly string[]): Promise<void>; disconnect(): Promise<void>; getMarkets(): Promise<PerplMarket[]>;
  getMarketState(marketId: string): PerplMarketState; getOrderBook(marketId: string): PerplOrderBook;
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
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ExchangeAdapterError(`Perpl ${label} is malformed`);
  return value;
}
function unsigned(value: unknown, field: string): bigint {
  if (!/^\d+$/.test(String(value))) throw new ExchangeAdapterError(`Perpl ${field} is malformed`);
  return BigInt(String(value));
}
function safeSequence(value: unknown): bigint {
  const sequence = unsigned(value, "sn");
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) throw new ExchangeAdapterError("Perpl sn is malformed");
  return sequence;
}
function scaled(value: unknown, decimals: number, field: string): number {
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") throw new ExchangeAdapterError(`Perpl ${field} is malformed`);
  return scaledToNumber(value, decimals, field);
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
  const minimumPostingSize = typeof minimumRaw === "string" && /^\d+$/.test(minimumRaw) ? scaledToNumber(minimumRaw, sizeDecimals, "minimum posting size") : finiteNumber(minimumRaw, "minimum posting size");
  const open = raw.config?.is_open ?? raw.is_open ?? ["open", "OPEN", "active"].includes(raw.status ?? "");
  if (minimumPostingSize < 0) throw new ExchangeAdapterError("Perpl minimum posting size must be non-negative");
  return { marketId: marketIdOf(raw), symbol, priceDecimals, sizeDecimals, minimumPostingSize, open };
}

export class RealPerplMarketDataSource implements PerplMarketDataSource {
  private markets = new Map<string, PerplMarket>();
  private states = new Map<string, PerplMarketState>();
  private books = new Map<string, PerplOrderBook>();
  private bookLevels = new Map<string, { bids: Map<bigint, bigint>; asks: Map<bigint, bigint> }>();
  private trades = new Map<string, PerplTrade[]>();
  private tradeSnapshotsReady = new Set<string>();
  private funding = new Map<string, PerplFunding>();
  private streamSequence = new Map<string, bigint>();
  private invalid = new Map<string, string>();
  private acknowledged = new Set<string>();
  private sidToStream = new Map<bigint, string>();
  private chainSid = new Map<PerplStreamKind, bigint>();
  private socket?: SocketLike;
  private connected = false;
  private deliberatelyClosed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private subscribedMarketIds: string[] = [];
  private expectedStreams = new Set<string>();
  private requestTimes: number[] = [];
  private generation = 0;

  constructor(
    private readonly restBaseUrl = PERPL_REST_BASE_URL, private readonly wsUrl = PERPL_MARKET_DATA_WS_URL,
    private readonly staleAfterMs = 15_000, private readonly fetchImpl: FetchLike = fetch,
    private readonly socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike,
    private readonly now: () => number = Date.now, private readonly random: () => number = Math.random,
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
    const raw = await this.json("v1/pub/context") as PerplContextRaw; const nested = raw.data;
    const list = raw.markets ?? (Array.isArray(nested) ? nested : nested?.markets);
    if (!Array.isArray(list) || list.length === 0) throw new ExchangeAdapterError("Perpl context contains no markets");
    const mapped = list.map(mapMarket); this.markets = new Map(mapped.map((market) => [market.marketId, market])); return mapped;
  }
  async connect(marketIds: readonly string[]): Promise<void> {
    if (2 + marketIds.length * 2 > 16) throw new ExchangeAdapterError("Perpl subscription limit exceeded (16)");
    for (const id of marketIds) if (!this.markets.has(id)) throw new ExchangeAdapterError(`Perpl market id ${id} was not dynamically discovered`);
    this.subscribedMarketIds = [...marketIds]; this.expectedStreams = new Set(this.subscriptionStreams()); this.deliberatelyClosed = false;
    await this.openSocket();
  }
  private subscriptionStreams(): string[] {
    return [`market-state@${CHAIN_ID}`, `funding@${CHAIN_ID}`, ...this.subscribedMarketIds.flatMap((id) => [`order-book@${id}`, `trades@${id}`])];
  }
  private clearRealtime(): void {
    this.states.clear(); this.books.clear(); this.bookLevels.clear(); this.trades.clear(); this.funding.clear(); this.streamSequence.clear();
    this.tradeSnapshotsReady.clear(); this.invalid.clear(); this.acknowledged.clear(); this.sidToStream.clear(); this.chainSid.clear();
  }
  private async openSocket(): Promise<void> {
    const generation = ++this.generation; this.clearRealtime();
    await new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(this.wsUrl); this.socket = socket;
      socket.addEventListener("open", () => { if (generation !== this.generation) return; this.connected = true; try { this.subscribe(socket); resolve(); } catch (error) { reject(error); } });
      socket.addEventListener("message", (event) => { if (generation !== this.generation) return; try { this.ingest(typeof event.data === "string" ? event.data : String(event.data)); } catch (error) { this.failAll(String(error)); } });
      socket.addEventListener("close", () => { if (generation !== this.generation) return; this.connected = false; this.failAll("disconnected"); if (!this.deliberatelyClosed) this.scheduleReconnect(generation); });
      socket.addEventListener("error", () => { if (generation === this.generation) { this.connected = false; this.failAll("socket error"); } });
    });
  }
  private subscribe(socket: SocketLike): void {
    const now = this.now(); this.requestTimes = this.requestTimes.filter((time) => now - time < 60_000);
    if (this.requestTimes.length >= 10) throw new ExchangeAdapterError("Perpl subscription request limit exceeded (10/minute)");
    this.requestTimes.push(now);
    const frame: PerplSubscriptionRequest = { mt: 5, subs: this.subscriptionStreams().map((stream) => ({ stream, subscribe: true })) };
    socket.send(JSON.stringify(frame));
  }
  private scheduleReconnect(generation: number): void {
    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000]; const base = delays[Math.min(this.reconnectAttempt++, delays.length - 1)]!;
    const delay = Math.round(base * (0.8 + this.random() * 0.4));
    this.reconnectTimer = setTimeout(() => { if (generation !== this.generation || this.deliberatelyClosed) return; void this.openSocket().catch(() => this.scheduleReconnect(this.generation)); }, delay);
  }
  async disconnect(): Promise<void> {
    this.deliberatelyClosed = true; this.connected = false; ++this.generation; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.clearRealtime(); this.socket?.close();
  }
  private failAll(reason: string): void { for (const id of this.subscribedMarketIds) this.invalid.set(id, reason); }

  /** Public solely for deterministic offline transport tests. */
  ingest(payload: string | PerplWireMessage): void {
    try { this.ingestValidated(typeof payload === "string" ? JSON.parse(payload) as PerplWireMessage : payload); }
    catch (error) { this.failAll(String(error)); throw error instanceof ExchangeAdapterError ? error : new ExchangeAdapterError(`Perpl message is malformed: ${String(error)}`); }
  }
  private ingestValidated(message: PerplWireMessage): void {
    const mt = finiteNumber(message.mt, "mt");
    if (mt === 6) { this.acknowledge(message); return; }
    if (![9, 10, 15, 16, 17, 18].includes(mt)) return;
    const sid = unsigned(message.sid, "sid"); const sequence = safeSequence(message.sn);
    if (mt === 9 || mt === 10) this.ingestChain(mt, sid, sequence, message.d);
    else this.ingestMarketStream(mt, sid, sequence, message);
  }
  private acknowledge(message: PerplWireMessage): void {
    unsigned(message.sn, "subscription acknowledgement sn"); const entries = array(message.subs, "subscription acknowledgement subs");
    for (const raw of entries) {
      const entry = record(raw, "subscription acknowledgement"); const stream = typeof entry.stream === "string" ? entry.stream : "";
      if (!this.expectedStreams.has(stream) || this.acknowledged.has(stream)) throw new ExchangeAdapterError(`Perpl unexpected subscription acknowledgement: ${stream}`);
      const status = record(entry.status, `subscription ${stream} status`); if (finiteNumber(status.code, `subscription ${stream} status code`) !== 0) throw new ExchangeAdapterError(`Perpl subscription failed for ${stream}: ${String(status.error ?? status.code)}`);
      const sid = unsigned(entry.sid, `subscription ${stream} sid`); this.acknowledged.add(stream);
      if (stream.startsWith("market-state@")) this.chainSid.set("market-state", sid);
      else if (stream.startsWith("funding@")) this.chainSid.set("funding", sid);
      else {
        const previous = this.sidToStream.get(sid); if (previous && previous !== stream) throw new ExchangeAdapterError(`Perpl SID ${sid} was bound to multiple streams`);
        this.sidToStream.set(sid, stream);
      }
    }
    if (entries.length !== this.expectedStreams.size || this.acknowledged.size !== this.expectedStreams.size) throw new ExchangeAdapterError("Perpl subscription acknowledgement is incomplete");
    this.reconnectAttempt = 0;
  }
  private ingestChain(mt: number, sid: bigint, sequence: bigint, rawData: unknown): void {
    const kind: PerplStreamKind = mt === 9 ? "market-state" : "funding"; const stream = `${kind}@${CHAIN_ID}`;
    if (!this.acknowledged.has(stream)) throw new ExchangeAdapterError(`Perpl ${stream} arrived before acknowledgement`);
    const bound = this.chainSid.get(kind); const otherKind: PerplStreamKind = mt === 9 ? "funding" : "market-state";
    if (bound !== undefined && bound !== sid && bound !== this.chainSid.get(otherKind)) throw new ExchangeAdapterError(`Perpl ${stream} used an unexpected SID`);
    this.chainSid.set(kind, sid); this.trackMonotonic(stream, sequence);
    const data = record(rawData, `${kind} data`); const staged: Array<[string, PerplMarketState | PerplFunding]> = [];
    for (const [marketId, raw] of Object.entries(data)) {
      if (!this.subscribedMarketIds.includes(marketId)) continue; const market = this.markets.get(marketId)!; const item = record(raw, `${kind} ${marketId}`); const at = blockTimestamp(item.at, `${kind}.at`);
      if (kind === "market-state") {
        const bid = scaled(item.bid, market.priceDecimals, "market-state bid"); const ask = scaled(item.ask, market.priceDecimals, "market-state ask");
        if (!(bid > 0 && ask > bid)) throw new ExchangeAdapterError(`Perpl market-state ${marketId} is crossed or invalid`);
        staged.push([marketId, { marketId, markPrice: scaled(item.mrk, market.priceDecimals, "mark price"), indexPrice: scaled(item.orl, market.priceDecimals, "oracle price"), open: market.open, timestamp: at.timestamp, sequence }]);
      } else {
        const divisor = finiteNumber(item.div, "funding divisor"); const rate = finiteNumber(item.rate, "funding rate");
        if (!Number.isInteger(rate) || !Number.isInteger(divisor) || divisor <= 0) throw new ExchangeAdapterError("Perpl funding rate is malformed");
        staged.push([marketId, { marketId, rate: rate / divisor / 1_000_000, timestamp: at.timestamp, sequence }]);
      }
    }
    for (const [id, value] of staged) { if (kind === "market-state") this.states.set(id, value as PerplMarketState); else this.funding.set(id, value as PerplFunding); this.invalid.delete(id); }
  }
  private ingestMarketStream(mt: number, sid: bigint, sequence: bigint, message: PerplWireMessage): void {
    const stream = this.sidToStream.get(sid); if (!stream || !this.acknowledged.has(stream)) throw new ExchangeAdapterError(`Perpl message used unbound SID ${sid}`);
    const split = stream.lastIndexOf("@"); const kind = stream.slice(0, split) as PerplStreamKind; const marketId = stream.slice(split + 1); const expectedMt = kind === "order-book" ? (mt === 15 || mt === 16) : (mt === 17 || mt === 18);
    if (!expectedMt) throw new ExchangeAdapterError(`Perpl mt ${mt} does not match ${stream}`);
    if (kind === "order-book") this.ingestBook(marketId, mt, sequence, message); else this.ingestTrades(marketId, mt, sequence, message.d);
  }
  private trackMonotonic(stream: string, sequence: bigint): void {
    const previous = this.streamSequence.get(stream); if (previous !== undefined && sequence <= previous) throw new ExchangeAdapterError(`Perpl non-increasing sequence for ${stream}`); this.streamSequence.set(stream, sequence);
  }
  private ingestBook(marketId: string, mt: number, sequence: bigint, message: PerplWireMessage): void {
    const stream = `order-book@${marketId}`; const previous = this.streamSequence.get(stream);
    if (mt === 16 && (previous === undefined || !this.bookLevels.has(marketId))) throw new ExchangeAdapterError(`Perpl ${stream} update arrived before snapshot`);
    if (mt === 16 && sequence <= previous!) throw new ExchangeAdapterError(`Perpl non-increasing sequence for ${stream}`);
    if (mt === 15 && previous !== undefined && sequence <= previous) throw new ExchangeAdapterError(`Perpl stale snapshot for ${stream}`);
    const at = blockTimestamp(message.at, "order-book.at"); const market = this.markets.get(marketId)!;
    const next = mt === 15 ? { bids: new Map<bigint, bigint>(), asks: new Map<bigint, bigint>() } : { bids: new Map(this.bookLevels.get(marketId)!.bids), asks: new Map(this.bookLevels.get(marketId)!.asks) };
    const apply = (raw: unknown, side: Map<bigint, bigint>, label: string) => { for (const value of array(raw, label)) { const level = record(value, `${label} level`); const p = unsigned(level.p, `${label} price`); const s = unsigned(level.s, `${label} size`); const orders = unsigned(level.o, `${label} order count`); if (p <= 0n) throw new ExchangeAdapterError(`Perpl ${label} price is invalid`); if (orders === 0n) side.delete(p); else { if (s <= 0n) throw new ExchangeAdapterError(`Perpl ${label} size is invalid`); side.set(p, s); } } };
    apply(message.bid, next.bids, "bid"); apply(message.ask, next.asks, "ask");
    if (next.bids.size === 0 || next.asks.size === 0) throw new ExchangeAdapterError("Perpl order book is incomplete");
    const bids = [...next.bids].map(([p, s]) => ({ price: scaledToNumber(p, market.priceDecimals, "book price"), size: scaledToNumber(s, market.sizeDecimals, "book size") })).sort((a, b) => b.price - a.price);
    const asks = [...next.asks].map(([p, s]) => ({ price: scaledToNumber(p, market.priceDecimals, "book price"), size: scaledToNumber(s, market.sizeDecimals, "book size") })).sort((a, b) => a.price - b.price);
    if (bids[0]!.price >= asks[0]!.price) throw new ExchangeAdapterError("Perpl order book is crossed");
    this.bookLevels.set(marketId, next); this.books.set(marketId, { marketId, bids, asks, sequence, timestamp: at.timestamp }); this.streamSequence.set(stream, sequence); this.invalid.delete(marketId);
  }
  private ingestTrades(marketId: string, mt: number, sequence: bigint, rawData: unknown): void {
    const stream = `trades@${marketId}`; const previous = this.streamSequence.get(stream);
    if (mt === 18 && previous === undefined) throw new ExchangeAdapterError(`Perpl ${stream} update arrived before snapshot`); this.trackMonotonic(stream, sequence);
    const market = this.markets.get(marketId)!; const mapped = array(rawData, "trades").map((raw): PerplTrade => {
      const trade = record(raw, "trade"); const at = record(trade.at, "trade.at"); const parsed = blockTimestamp(at, "trade.at");
      const tx = unsigned(at.tx, "trade.at.tx"); const txid = typeof at.txid === "string" && /^[0-9a-f]+$/i.test(at.txid) ? at.txid.toLowerCase() : "";
      const log = at.l === undefined ? undefined : unsigned(at.l, "trade.at.l"); if (!txid) throw new ExchangeAdapterError("Perpl trade has no stable transaction identity");
      const side = finiteNumber(trade.sd, "trade side"); if (side !== 1 && side !== 2) throw new ExchangeAdapterError("Perpl trade side is malformed");
      return { id: `${parsed.block}:${tx}:${txid}:${log === undefined ? "-" : log}`, marketId, takerSide: side === 1 ? "buy" : "sell", price: scaled(trade.p, market.priceDecimals, "trade price"), size: scaled(trade.s, market.sizeDecimals, "trade size"), timestamp: parsed.timestamp, sequence };
    });
    const base = mt === 17 ? [] : (this.trades.get(marketId) ?? []); const byId = new Map(base.map((trade) => [trade.id, trade])); for (const trade of mapped) byId.set(trade.id, trade);
    this.trades.set(marketId, [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)).slice(-1000));
    if (mt === 17) this.tradeSnapshotsReady.add(marketId);
    this.invalid.delete(marketId);
  }
  private requireFresh<T extends { timestamp: number }>(marketId: string, value: T | undefined, label: string): T {
    if (!this.connected) throw new ExchangeAdapterError("Perpl market data is disconnected"); const reason = this.invalid.get(marketId); if (reason) throw new ExchangeAdapterError(`Perpl market data invalid: ${reason}`);
    if (!value) throw new ExchangeAdapterError(`Perpl ${label} is incomplete`); if (this.now() - value.timestamp > this.staleAfterMs) throw new ExchangeAdapterError(`Perpl ${label} is stale`); return value;
  }
  getMarketState(id: string): PerplMarketState {
    if (!this.connected) throw new ExchangeAdapterError("Perpl market data is disconnected");
    if (!this.acknowledged.has(`market-state@${CHAIN_ID}`)) throw new ExchangeAdapterError("Perpl market state subscription is incomplete");
    const reason = this.invalid.get(id); if (reason) throw new ExchangeAdapterError(`Perpl market data invalid: ${reason}`);
    const state = this.states.get(id); if (!state) throw new ExchangeAdapterError("Perpl market state is incomplete"); return state;
  }
  getOrderBook(id: string): PerplOrderBook { return this.requireFresh(id, this.books.get(id), "order book"); }
  getFunding(id: string): PerplFunding {
    if (!this.connected) throw new ExchangeAdapterError("Perpl market data is disconnected");
    if (!this.acknowledged.has(`funding@${CHAIN_ID}`)) throw new ExchangeAdapterError("Perpl funding subscription is incomplete");
    const reason = this.invalid.get(id); if (reason) throw new ExchangeAdapterError(`Perpl market data invalid: ${reason}`);
    const funding = this.funding.get(id); if (!funding) throw new ExchangeAdapterError("Perpl funding is incomplete"); return funding;
  }
  getRecentTrades(id: string, after?: { timestamp: number; ids: ReadonlySet<string> }): PerplTrade[] {
    if (!this.connected) throw new ExchangeAdapterError("Perpl market data is disconnected");
    const reason = this.invalid.get(id); if (reason) throw new ExchangeAdapterError(`Perpl market data invalid: ${reason}`);
    if (!this.acknowledged.has(`trades@${id}`)) throw new ExchangeAdapterError("Perpl trades subscription is incomplete");
    if (!this.tradeSnapshotsReady.has(id)) throw new ExchangeAdapterError("Perpl trades snapshot is incomplete");
    return (this.trades.get(id) ?? []).filter((trade) => !after || trade.timestamp > after.timestamp || (trade.timestamp === after.timestamp && !after.ids.has(trade.id)));
  }
  async getCandles(marketId: string, params: { interval: string; fromMs: number; toMs: number }): Promise<PerplCandle[]> {
    if (!this.markets.has(marketId)) throw new ExchangeAdapterError("Perpl candle market was not discovered"); const raw = await this.json(`v1/market-data/${marketId}/candles/${params.interval}/${params.fromMs}-${params.toMs}`);
    const list = Array.isArray(raw) ? raw : (record(raw, "candles").data ?? record(raw, "candles").candles); if (!Array.isArray(list)) throw new ExchangeAdapterError("Perpl candles are malformed");
    return (list as PerplCandleRaw[]).map((c) => ({ timestamp: timestampMs(c.timestamp ?? c.time), open: finiteNumber(c.open, "candle open"), high: finiteNumber(c.high, "candle high"), low: finiteNumber(c.low, "candle low"), close: finiteNumber(c.close, "candle close"), volume: finiteNumber(c.volume, "candle volume") }));
  }
}
