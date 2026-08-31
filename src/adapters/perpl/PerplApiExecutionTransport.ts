import { randomBytes } from "node:crypto";
import { ExchangeAdapterError } from "../AdapterError.js";
import { PerplSigner } from "./PerplSigner.js";
import { mapAuthenticatedFrame } from "./authMappers.js";
import type { PerplOrder, PerplOrderRequest } from "./authTypes.js";
import type { NormalizedFill, NormalizedOrder } from "../ExchangeAdapter.js";
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
  timeoutMs?: number;
  socketFactory?: (url: string) => SocketLike;
  marketScales?: Readonly<Record<"BTCUSD" | "ETHUSD", MarketScale>>;
}

export interface PerplApiConnectionEvidence {
  chainId: number;
  accountId: number;
  walletAddress: string;
  lastForwardedRequestId: number;
}

export interface PerplApiLiveOrderSource {
  getOpenOrders(market?: string): NormalizedOrder[];
  getOrderFills(exchangeOrderId: string, market: string): Promise<NormalizedFill[]>;
}

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
  private readonly timeoutMs: number;
  private readonly socketFactory: (url: string) => SocketLike;
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
  private ordersSnapshotReady = false;
  private connectionEvidence?: PerplApiConnectionEvidence;

  constructor(options: PerplApiExecutionOptions) {
    this.accountId = options.accountId ?? 5071;
    this.chainId = options.chainId ?? 143;
    this.wsUrl = options.wsUrl ?? "wss://app.perpl.xyz/ws/v1/trading";
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
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

  async getOrderFills(exchangeOrderId: string, market: string): Promise<NormalizedFill[]> {
    const apiOrderId = this.apiOrderIdByContractId.get(exchangeOrderId);
    if (apiOrderId === undefined) return [];
    return (this.fillsByApiOrderId.get(apiOrderId) ?? [])
      .filter((fill) => fill.market === market)
      .map((fill) => ({ ...fill }));
  }

  close(): void {
    this.failAll("Perpl API transport closed before definitive order outcome");
    this.socket?.close();
    this.socket = undefined;
    this.ready = false;
    this.ordersSnapshotReady = false;
    this.connectionEvidence = undefined;
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
    if (price * (encodedSize / 10 ** this.scales[market].sizeDecimals) > 15)
      throw new ExchangeAdapterError("Perpl API quantized order exceeds the $15 maximum notional");
    return {
      ...common,
      t: intent.reduceOnly ? (intent.side === "sell" ? 3 : 4) : intent.side === "buy" ? 1 : 2,
      p: encodedPrice,
      s: encodedSize,
      fl: 1,
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
            : order.scid > 0 ? String(order.scid) : undefined;
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

  private tryBecomeReady(timer: NodeJS.Timeout, resolve: () => void): void {
    if (!this.connectionEvidence || !this.ordersSnapshotReady || this.ready) return;
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
