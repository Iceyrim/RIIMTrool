import { randomBytes } from "node:crypto";
import { ExchangeAdapterError } from "../AdapterError.js";
import { PerplSigner } from "./PerplSigner.js";
import { mapAuthenticatedFrame } from "./authMappers.js";
import type { PerplOrder, PerplOrderRequest, PerplPosition } from "./authTypes.js";
import type { AccountVolume, NormalizedFill, NormalizedOrder, NormalizedPosition } from "../ExchangeAdapter.js";
import type { PerplExecutionTransport } from "./onchain/PerplCanaryExecutor.js";
import type { PerplExecutionIntent, PerplExecutionOutcome } from "./onchain/executionProtocol.js";
import { PerplTradingProtocol, type PerplResolution } from "./tradingProtocol.js";

interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

interface MarketScale { priceDecimals: number; sizeDecimals: number }
interface PendingRequest {
  intent: PerplExecutionIntent;
  sn: number;
  rq: number;
  resolve: (outcome: PerplExecutionOutcome) => void;
  timer: NodeJS.Timeout;
}

export interface PerplApiExecutionOptions {
  apiKey: string;
  apiKeySecret: string;
  accountId?: number;
  chainId?: number;
  wsUrl?: string;
  apiUrl?: string;
  timeoutMs?: number;
  socketFactory?: (url: string) => SocketLike;
  fetchFn?: typeof fetch;
  marketScales?: Readonly<Record<"BTCUSD" | "ETHUSD", MarketScale>>;
}

export interface PerplApiConnectionEvidence {
  chainId: number;
  accountId: number;
  walletAddress: string;
  lastForwardedRequestId: number;
}

export interface PerplApiLiveOrderSource {
  connect(): Promise<void>;
  getOpenOrders(market?: string): NormalizedOrder[];
  getPositions(market?: string): NormalizedPosition[];
  getPositionEvidence(market: string): { position?: NormalizedPosition; blockNumber?: number };
  waitForPositionSettled(market: string, timeoutMs?: number, previousBaseSize?: number): Promise<void>;
  getOrderFills(exchangeOrderId: string, market: string): Promise<NormalizedFill[]>;
  getAccountVolume(params: { market?: string; since: string; until: string }): Promise<AccountVolume[]>;
}

interface FillHistoryRecord {
  at: { b?: number; t?: number; tx?: number; txid?: string; l?: number };
  mkt: number;
  acc: number;
  oid: number;
  t: number;
  l: number;
  p?: number;
  s: number;
  f: string;
}

interface FillHistoryPage { d: FillHistoryRecord[]; np: string }
interface HistoricalFill { id: string; market: "BTCUSD" | "ETHUSD"; timestamp: number; size: number; price: number }

const OPEN = 1;

function scaled(value: string, decimals: number, field: string, mode: "exact" | "floor" | "ceil" = "exact"): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new ExchangeAdapterError(`${field} is malformed`);
  const [whole, fraction = ""] = value.split(".");
  const retained = fraction.slice(0, decimals).padEnd(decimals, "0");
  const discarded = fraction.slice(decimals);
  if (mode === "exact" && /[1-9]/.test(discarded)) throw new ExchangeAdapterError(`${field} exceeds market precision`);
  let result = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(retained || "0");
  if (mode === "ceil" && /[1-9]/.test(discarded)) result += 1n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ExchangeAdapterError(`${field} exceeds safe integer range`);
  return Number(result);
}

export function quantizePerplLimitPrice(value: string | number, decimals: number, side: "buy" | "sell"): number {
  const factor = 10 ** decimals;
  return scaled(String(value), decimals, "Perpl API price", side === "buy" ? "floor" : "ceil") / factor;
}

function secretBytes(secret: string): Uint8Array {
  const hex = secret.replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new ExchangeAdapterError("PERPL_API_KEY_SECRET must be a 32-byte hex Ed25519 key");
  return Buffer.from(hex, "hex");
}

/** Trade-scoped Perpl API transport. It never receives or uses the wallet private key. */
export class PerplApiExecutionTransport implements PerplExecutionTransport {
  private readonly protocol = new PerplTradingProtocol();
  private readonly signer: PerplSigner;
  private readonly accountId: number;
  private readonly chainId: number;
  private readonly wsUrl: string;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly socketFactory: (url: string) => SocketLike;
  private readonly fetchFn: typeof fetch;
  private readonly scales: Readonly<Record<"BTCUSD" | "ETHUSD", MarketScale>>;
  private socket?: SocketLike;
  private connecting?: Promise<void>;
  private ready = false;
  private pending = new Map<number, PendingRequest>();
  /** The engine/on-chain bridge identifies orders by scid, while One-Click cancellation requests
   * require the API-facing oid. Keep the identities paired instead of conflating them. */
  private readonly apiOrderIdByContractId = new Map<string, number>();
  private readonly openOrdersByContractId = new Map<string, NormalizedOrder>();
  private readonly fillsByApiOrderId = new Map<number, NormalizedFill[]>();
  private readonly positionsByMarket = new Map<"BTCUSD" | "ETHUSD", NormalizedPosition>();
  private readonly positionBlockByMarket = new Map<"BTCUSD" | "ETHUSD", number>();
  private readonly unsettledPositionMarkets = new Set<"BTCUSD" | "ETHUSD">();
  private ordersSnapshotReady = false;
  private positionsSnapshotReady = false;
  private connectionEvidence?: PerplApiConnectionEvidence;
  private historyCache?: { loadedAt: number; fills: HistoricalFill[] };
  private historyLoad?: Promise<HistoricalFill[]>;

  constructor(options: PerplApiExecutionOptions) {
    this.accountId = options.accountId ?? 5198;
    this.chainId = options.chainId ?? 143;
    this.wsUrl = options.wsUrl ?? "wss://app.perpl.xyz/ws/v1/trading";
    this.apiUrl = (options.apiUrl ?? "https://app.perpl.xyz/api").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.fetchFn = options.fetchFn ?? fetch;
    this.scales = options.marketScales ?? {
      BTCUSD: { priceDecimals: 1, sizeDecimals: 5 },
      ETHUSD: { priceDecimals: 2, sizeDecimals: 3 },
    };
    this.signer = new PerplSigner(secretBytes(options.apiKeySecret), options.apiKey, this.chainId);
  }

  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(this.wsUrl);
      this.socket = socket;
      const timer = setTimeout(() => reject(new ExchangeAdapterError("Perpl API authentication timed out")), this.timeoutMs);
      socket.addEventListener("open", () => {
        const timestamp = Date.now().toString();
        const nonce = randomBytes(16).toString("base64url");
        socket.send(JSON.stringify(this.signer.signWs(timestamp, nonce)));
        this.protocol.connect();
      });
      socket.addEventListener("message", (event) => {
        try {
          const raw = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (raw.mt === 19) {
            const frame = mapAuthenticatedFrame(raw);
            if (frame.mt !== 19) return;
            const accounts = frame.as ?? [];
            const account = accounts.find((item) => item.id === this.accountId);
            if (!account) throw new ExchangeAdapterError(`Perpl API wallet snapshot omitted account ${this.accountId}`);
            this.protocol.acceptWalletSnapshot(frame.sn, accounts);
            this.connectionEvidence = {
              chainId: this.chainId,
              accountId: account.id,
              walletAddress: frame.addr,
              lastForwardedRequestId: account.lfr,
            };
            this.tryBecomeReady(timer, resolve);
            return;
          }
          this.ingest(raw);
          this.tryBecomeReady(timer, resolve);
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          this.failAll(`authenticated stream error: ${error instanceof Error ? error.message : String(error)}`);
          socket.close();
        }
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        this.ready = false;
        this.ordersSnapshotReady = false;
        this.positionsSnapshotReady = false;
        this.protocol.disconnect();
        this.failAll("trading websocket disconnected before definitive order outcome");
        reject(new ExchangeAdapterError("Perpl API trading websocket closed before authentication"));
      });
      socket.addEventListener("error", () => {
        if (!this.ready) reject(new ExchangeAdapterError("Perpl API trading websocket failed"));
      });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async request(intent: PerplExecutionIntent): Promise<unknown> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== OPEN || !this.ready)
      throw new ExchangeAdapterError("Perpl API trading websocket is not ready");
    const apiOrderId = intent.action === "cancel"
      ? this.apiOrderIdByContractId.get(intent.exchangeOrderId)
      : undefined;
    if (intent.action === "cancel" && apiOrderId === undefined)
      throw new ExchangeAdapterError(
        `Perpl API has no verified One-Click order identity for contract order ${intent.exchangeOrderId}`,
      );
    const identity = this.protocol.begin(this.accountId, intent.action, {
      orderId: apiOrderId,
      lb: 0,
    });
    const request = this.frame(intent, identity.sn, identity.rq, apiOrderId);
    return new Promise<PerplExecutionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(identity.sn);
        resolve(this.outcome(intent, "ambiguous", "timed out before definitive Perpl order update"));
      }, this.timeoutMs);
      this.pending.set(identity.sn, { intent, sn: identity.sn, rq: identity.rq, resolve, timer });
      this.socket!.send(JSON.stringify(request));
      this.protocol.markSent(identity.sn);
    });
  }

  getConnectionEvidence(): PerplApiConnectionEvidence {
    if (!this.ready || !this.connectionEvidence)
      throw new ExchangeAdapterError("Perpl API connection evidence is unavailable");
    return { ...this.connectionEvidence };
  }

  getOpenOrders(market?: string): NormalizedOrder[] {
    if (!this.ready || !this.ordersSnapshotReady)
      throw new ExchangeAdapterError("Perpl API open-order snapshot is unavailable");
    return [...this.openOrdersByContractId.values()]
      .filter((order) => !market || order.market === market)
      .map((order) => ({ ...order }));
  }

  getPositions(market?: string): NormalizedPosition[] {
    if (!this.ready || !this.positionsSnapshotReady)
      throw new ExchangeAdapterError("Perpl API position snapshot is unavailable");
    const requested = market === "BTCUSD" || market === "ETHUSD" ? market : undefined;
    if (market && !requested) throw new ExchangeAdapterError(`Unsupported Perpl position market ${market}`);
    const unsettled = requested
      ? this.unsettledPositionMarkets.has(requested)
      : this.unsettledPositionMarkets.size > 0;
    if (unsettled)
      throw new ExchangeAdapterError("Perpl API position evidence has not caught up to confirmed fills");
    return [...this.positionsByMarket.values()]
      .filter((position) => !requested || position.market === requested)
      .map((position) => ({ ...position }));
  }

  getPositionEvidence(market: string): { position?: NormalizedPosition; blockNumber?: number } {
    const requested = market === "BTCUSD" || market === "ETHUSD" ? market : undefined;
    if (!requested) throw new ExchangeAdapterError(`Unsupported Perpl position market ${market}`);
    const position = this.getPositions(requested)[0];
    return {
      ...(position ? { position: { ...position } } : {}),
      blockNumber: this.positionBlockByMarket.get(requested),
    };
  }

  async waitForPositionSettled(market: string, timeoutMs = 10_000, previousBaseSize?: number): Promise<void> {
    const requested = market === "BTCUSD" || market === "ETHUSD" ? market : undefined;
    if (
      !requested || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 ||
      (previousBaseSize !== undefined && !Number.isFinite(previousBaseSize))
    )
      throw new ExchangeAdapterError("Perpl position-settlement wait is invalid");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (!this.positionsSnapshotReady)
        throw new ExchangeAdapterError("Perpl API position snapshot is unavailable");
      const currentBaseSize = this.positionsByMarket.get(requested)?.baseSize ?? 0;
      if (
        !this.unsettledPositionMarkets.has(requested) &&
        (previousBaseSize === undefined || currentBaseSize !== previousBaseSize)
      ) return;
      if (Date.now() >= deadline)
        throw new ExchangeAdapterError(`Timed out awaiting authoritative Perpl ${requested} position evidence`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async getOrderFills(exchangeOrderId: string, market: string): Promise<NormalizedFill[]> {
    const apiOrderId = this.apiOrderIdByContractId.get(exchangeOrderId);
    if (apiOrderId === undefined) return [];
    return (this.fillsByApiOrderId.get(apiOrderId) ?? [])
      .filter((fill) => fill.market === market)
      .map((fill) => ({ ...fill }));
  }

  async getAccountVolume(params: { market?: string; since: string; until: string }): Promise<AccountVolume[]> {
    const since = Date.parse(params.since);
    const until = Date.parse(params.until);
    if (!Number.isFinite(since) || !Number.isFinite(until) || since > until)
      throw new ExchangeAdapterError("Perpl account-volume time window is invalid");
    if (params.market && params.market !== "BTCUSD" && params.market !== "ETHUSD")
      throw new ExchangeAdapterError(`Unsupported Perpl volume market ${params.market}`);
    const fills = await this.loadHistoricalFills();
    const totals = new Map<string, { baseVolume: number; quoteVolume: number }>();
    for (const fill of fills) {
      if (fill.timestamp < since || fill.timestamp > until || (params.market && fill.market !== params.market)) continue;
      const total = totals.get(fill.market) ?? { baseVolume: 0, quoteVolume: 0 };
      total.baseVolume += fill.size;
      total.quoteVolume += fill.size * fill.price;
      totals.set(fill.market, total);
    }
    return [...totals].map(([market, total]) => ({
      market,
      since: params.since,
      until: params.until,
      baseVolume: total.baseVolume,
      quoteVolume: total.quoteVolume,
    }));
  }

  close(): void {
    this.failAll("Perpl API transport closed before definitive order outcome");
    this.socket?.close();
    this.socket = undefined;
    this.ready = false;
    this.ordersSnapshotReady = false;
    this.positionsSnapshotReady = false;
    this.connectionEvidence = undefined;
  }

  private loadHistoricalFills(): Promise<HistoricalFill[]> {
    if (this.historyCache && Date.now() - this.historyCache.loadedAt < 60_000)
      return Promise.resolve(this.historyCache.fills.map((fill) => ({ ...fill })));
    if (this.historyLoad) return this.historyLoad;
    this.historyLoad = this.fetchHistoricalFills()
      .then((fills) => {
        this.historyCache = { loadedAt: Date.now(), fills };
        return fills.map((fill) => ({ ...fill }));
      })
      .finally(() => { this.historyLoad = undefined; });
    return this.historyLoad;
  }

  private async fetchHistoricalFills(): Promise<HistoricalFill[]> {
    const fills = new Map<string, HistoricalFill>();
    const seenCursors = new Set<string>();
    let page = "";
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const query = new URLSearchParams({ count: "100" });
      if (page) query.set("page", page);
      const target = `/v1/trading/fills?${query.toString()}`;
      const timestamp = Date.now().toString();
      const nonce = randomBytes(16).toString("base64url");
      const response = await this.fetchFn(`${this.apiUrl}${target}`, {
        method: "GET",
        headers: { ...this.signer.signRest("GET", target, timestamp, nonce) },
      });
      if (!response.ok)
        throw new ExchangeAdapterError(`Perpl fill-history request failed with HTTP ${response.status}`);
      const body = this.parseFillHistoryPage(await response.json());
      for (const fill of body.d) {
        if (fill.acc !== this.accountId) continue;
        const market = fill.mkt === 1 ? "BTCUSD" : fill.mkt === 20 ? "ETHUSD" : undefined;
        if (!market || fill.p === undefined) continue;
        const scale = this.scales[market];
        const rawTimestamp = fill.at.t;
        if (!Number.isFinite(rawTimestamp)) throw new ExchangeAdapterError("Perpl fill history omitted its timestamp");
        const timestampMs = rawTimestamp! < 1_000_000_000_000 ? rawTimestamp! * 1_000 : rawTimestamp!;
        const price = fill.p / 10 ** scale.priceDecimals;
        const size = fill.s / 10 ** scale.sizeDecimals;
        if (![timestampMs, price, size].every(Number.isFinite) || timestampMs < 0 || price <= 0 || size <= 0)
          throw new ExchangeAdapterError("Perpl fill history contains invalid numeric evidence");
        const id = fill.at.txid && fill.at.l !== undefined
          ? `${fill.at.txid}:${fill.at.l}`
          : `${fill.at.b ?? ""}:${fill.at.tx ?? ""}:${fill.at.l ?? ""}:${fill.oid}`;
        if (id === ":::0" || fills.has(id)) continue;
        fills.set(id, { id, market, timestamp: timestampMs, price, size });
      }
      if (!body.np) return [...fills.values()];
      if (seenCursors.has(body.np)) throw new ExchangeAdapterError("Perpl fill-history pagination repeated a cursor");
      seenCursors.add(body.np);
      page = body.np;
    }
    throw new ExchangeAdapterError("Perpl fill-history pagination exceeded 100 pages");
  }

  private parseFillHistoryPage(value: unknown): FillHistoryPage {
    if (!value || typeof value !== "object") throw new ExchangeAdapterError("Perpl fill-history response is malformed");
    const body = value as { d?: unknown; np?: unknown };
    if (!Array.isArray(body.d) || typeof body.np !== "string")
      throw new ExchangeAdapterError("Perpl fill-history response is malformed");
    for (const item of body.d) {
      if (!item || typeof item !== "object") throw new ExchangeAdapterError("Perpl fill-history row is malformed");
      const fill = item as Partial<FillHistoryRecord>;
      if (!fill.at || typeof fill.at !== "object" || !Number.isSafeInteger(fill.mkt) || !Number.isSafeInteger(fill.acc) ||
          !Number.isSafeInteger(fill.oid) || !Number.isSafeInteger(fill.t) || !Number.isSafeInteger(fill.l) ||
          !Number.isSafeInteger(fill.s) || typeof fill.f !== "string" ||
          (fill.p !== undefined && !Number.isSafeInteger(fill.p)))
        throw new ExchangeAdapterError("Perpl fill-history row is malformed");
    }
    return body as FillHistoryPage;
  }

  private frame(intent: PerplExecutionIntent, sn: number, rq: number, apiOrderId?: number): PerplOrderRequest {
    const market = intent.market;
    const common = { mt: 22 as const, sn, rq, mkt: intent.perpetualId, acc: intent.accountId, lb: 0 };
    if (intent.action === "cancel") {
      if (apiOrderId === undefined || !Number.isSafeInteger(apiOrderId) || apiOrderId <= 0)
        throw new ExchangeAdapterError("Perpl API cancellation order ID is invalid");
      const oid = apiOrderId;
      return { ...common, oid, t: 5, s: 0, fl: 0, lv: 0 };
    }
    const price = quantizePerplLimitPrice(intent.price, this.scales[market].priceDecimals, intent.side);
    const encodedPrice = scaled(String(price), this.scales[market].priceDecimals, "Perpl API price");
    const encodedSize = scaled(intent.size, this.scales[market].sizeDecimals, "Perpl API size");
    if (price * (encodedSize / 10 ** this.scales[market].sizeDecimals) > 30)
      throw new ExchangeAdapterError("Perpl API quantized order exceeds the $30 maximum notional");
    return {
      ...common,
      t: intent.reduceOnly ? (intent.side === "sell" ? 3 : 4) : intent.side === "buy" ? 1 : 2,
      p: encodedPrice,
      s: encodedSize,
      fl: intent.orderType === "immediateOrCancel" ? 4 : 1,
      lv: Number(intent.leverage) * 100,
    };
  }

  private ingest(raw: Record<string, unknown>): void {
    if (raw.mt === 3) {
      const cid = typeof raw.cid === "number" ? raw.cid : undefined;
      const status = raw.status as { code?: unknown; error?: unknown } | undefined;
      const resolution = this.protocol.correlateGateway({
        cid,
        status: { code: Number(status?.code), error: String(status?.error ?? "") },
      });
      if (cid !== undefined && resolution) this.finish(cid, resolution);
      return;
    }
    if (raw.mt === 100) {
      this.protocol.acceptHeartbeat(Number(raw.sn));
      return;
    }
    const frame = mapAuthenticatedFrame(raw);
    if (frame.mt === 21) this.protocol.acceptAccountUpdate(frame.id, frame.lfr);
    if (frame.mt === 23) {
      this.openOrdersByContractId.clear();
      for (const order of frame.d) this.acceptOrderState(order);
      this.ordersSnapshotReady = true;
    }
    if (frame.mt === 24) for (const order of frame.d) this.acceptOrder(order);
    if (frame.mt === 25) for (const fill of frame.d) this.acceptFill(fill);
    if (frame.mt === 26) {
      this.positionsByMarket.clear();
      this.positionBlockByMarket.clear();
      for (const position of frame.d) this.acceptPosition(position);
      const snapshotBlock = frame.at.b;
      if (snapshotBlock !== undefined) {
        for (const market of ["BTCUSD", "ETHUSD"] as const)
          if (!this.positionBlockByMarket.has(market)) this.positionBlockByMarket.set(market, snapshotBlock);
      }
      this.positionsSnapshotReady = true;
      this.unsettledPositionMarkets.clear();
    }
    if (frame.mt === 27) for (const position of frame.d) this.acceptPosition(position);
  }

  private acceptOrder(order: PerplOrder): void {
    this.acceptOrderState(order);
    const resolution = this.protocol.correlateOrder(order);
    if (!resolution) return;
    for (const [sn, pending] of this.pending) {
      if (pending.intent.accountId === order.acc) {
        if (pending.rq === order.rq) {
          const exchangeOrderId = pending.intent.action === "cancel"
            ? pending.intent.exchangeOrderId
            : order.scid > 0
              ? String(order.scid)
              : pending.intent.orderType === "immediateOrCancel" && order.oid > 0
                ? `api:${order.oid}`
                : undefined;
          this.finish(sn, resolution, exchangeOrderId);
        }
      }
    }
  }

  private rememberOrderIdentity(order: PerplOrder): void {
    if (order.acc === this.accountId && order.oid > 0 && order.scid > 0)
      this.apiOrderIdByContractId.set(String(order.scid), order.oid);
  }

  private acceptOrderState(order: PerplOrder): void {
    this.rememberOrderIdentity(order);
    if (order.acc !== this.accountId || order.scid <= 0) return;
    const id = String(order.scid);
    if (order.st !== 2 && order.st !== 3) {
      this.openOrdersByContractId.delete(id);
      return;
    }
    const market = order.mkt === 1 ? "BTCUSD" : order.mkt === 20 ? "ETHUSD" : undefined;
    if (!market || order.p === undefined) return;
    const scale = this.scales[market];
    const filledSize = order.fs / 10 ** scale.sizeDecimals;
    const size = order.os / 10 ** scale.sizeDecimals;
    const side = order.t === 1 || order.t === 4 ? "buy" : "sell";
    this.openOrdersByContractId.set(id, {
      exchangeOrderId: id,
      market,
      side,
      type: "postOnly",
      price: order.p / 10 ** scale.priceDecimals,
      size,
      filledSize,
      remainingSize: Math.max(0, size - filledSize),
      isReduceOnly: order.t === 3 || order.t === 4,
      state: filledSize > 0 ? "partiallyFilled" : "open",
    });
  }

  private acceptFill(fill: import("./authTypes.js").PerplFill): void {
    if (fill.acc !== this.accountId || fill.p === undefined) return;
    const market = fill.mkt === 1 ? "BTCUSD" : fill.mkt === 20 ? "ETHUSD" : undefined;
    if (!market) return;
    this.unsettledPositionMarkets.add(market);
    const scale = this.scales[market];
    const rawTime = fill.at.t ?? Date.now();
    const normalized: NormalizedFill = {
      exchangeOrderId: "",
      tradeId: fill.at.txid ?? `${fill.oid}:${fill.at.l ?? rawTime}`,
      market,
      side: fill.t === 1 || fill.t === 4 ? "buy" : "sell",
      price: fill.p / 10 ** scale.priceDecimals,
      size: fill.s / 10 ** scale.sizeDecimals,
      timestamp: rawTime < 1_000_000_000_000 ? rawTime * 1_000 : rawTime,
    };
    const existing = this.fillsByApiOrderId.get(fill.oid) ?? [];
    if (!existing.some((item) => item.tradeId === normalized.tradeId)) existing.push(normalized);
    this.fillsByApiOrderId.set(fill.oid, existing);
    for (const [contractId, apiOrderId] of this.apiOrderIdByContractId) {
      if (apiOrderId === fill.oid) for (const item of existing) item.exchangeOrderId = contractId;
    }
  }

  private acceptPosition(position: PerplPosition): void {
    if (position.acc !== this.accountId) return;
    const market = position.mkt === 1 ? "BTCUSD" : position.mkt === 20 ? "ETHUSD" : undefined;
    if (!market) return;
    if (position.at.b !== undefined) this.positionBlockByMarket.set(market, position.at.b);
    if (position.st !== 1 || position.s === 0) {
      this.positionsByMarket.delete(market);
      this.unsettledPositionMarkets.delete(market);
      return;
    }
    if (position.sd !== 1 && position.sd !== 2)
      throw new ExchangeAdapterError("Perpl API open position has an invalid direction");
    const scale = this.scales[market];
    const size = position.s / 10 ** scale.sizeDecimals;
    const entryPrice = position.ep / 10 ** scale.priceDecimals;
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0)
      throw new ExchangeAdapterError("Perpl API open position contains invalid numeric evidence");
    this.positionsByMarket.set(market, {
      market,
      baseSize: position.sd === 1 ? size : -size,
      markPrice: entryPrice,
      unrealizedPnl: 0,
      openOrderCount: [...this.openOrdersByContractId.values()].filter((order) => order.market === market).length,
    });
    this.unsettledPositionMarkets.delete(market);
  }

  private tryBecomeReady(timer: NodeJS.Timeout, resolve: () => void): void {
    if (!this.connectionEvidence || !this.ordersSnapshotReady || !this.positionsSnapshotReady || this.ready) return;
    this.ready = true;
    clearTimeout(timer);
    resolve();
  }

  private finish(sn: number, resolution: PerplResolution, exchangeOrderId?: string): void {
    const pending = this.pending.get(sn);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(sn);
    if (resolution.state === "confirmed") {
      const id = exchangeOrderId ?? (pending.intent.action === "cancel" ? pending.intent.exchangeOrderId : undefined);
      if (!id) return pending.resolve(this.outcome(pending.intent, "ambiguous", "confirmed update omitted exchange order ID"));
      pending.resolve({ version: 1, id: pending.intent.id, event: "confirmed", actionId: pending.intent.actionId, exchangeOrderId: id });
    } else {
      pending.resolve(this.outcome(pending.intent, resolution.state, resolution.state === "rejected" ? resolution.error : resolution.reason));
    }
  }

  private failAll(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(this.outcome(pending.intent, "ambiguous", reason));
    }
    this.pending.clear();
  }

  private outcome(intent: PerplExecutionIntent, event: "rejected" | "ambiguous", reason: string): PerplExecutionOutcome {
    return { version: 1, id: intent.id, event, actionId: intent.actionId, reason };
  }
}
