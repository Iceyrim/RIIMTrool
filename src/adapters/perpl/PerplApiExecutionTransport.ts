import { randomBytes } from "node:crypto";
import { ExchangeAdapterError } from "../AdapterError.js";
import { PerplSigner } from "./PerplSigner.js";
import { mapAuthenticatedFrame } from "./authMappers.js";
import type { PerplOrder, PerplOrderRequest } from "./authTypes.js";
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

const OPEN = 1;

function scaled(value: string, decimals: number, field: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new ExchangeAdapterError(`${field} is malformed`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new ExchangeAdapterError(`${field} exceeds market precision`);
  const result = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ExchangeAdapterError(`${field} exceeds safe integer range`);
  return Number(result);
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
            this.ready = true;
            clearTimeout(timer);
            resolve();
            return;
          }
          this.ingest(raw);
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
    const identity = this.protocol.begin(this.accountId, intent.action, {
      orderId: intent.action === "cancel" ? Number(intent.exchangeOrderId) : undefined,
      lb: 0,
    });
    const request = this.frame(intent, identity.sn, identity.rq);
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

  close(): void {
    this.failAll("Perpl API transport closed before definitive order outcome");
    this.socket?.close();
    this.socket = undefined;
    this.ready = false;
  }

  private frame(intent: PerplExecutionIntent, sn: number, rq: number): PerplOrderRequest {
    const market = intent.market;
    const common = { mt: 22 as const, sn, rq, mkt: intent.perpetualId, acc: intent.accountId, lb: 0 };
    if (intent.action === "cancel") {
      const oid = Number(intent.exchangeOrderId);
      if (!Number.isSafeInteger(oid) || oid <= 0) throw new ExchangeAdapterError("Perpl API cancellation order ID is invalid");
      return { ...common, oid, t: 5, s: 0, fl: 0, lv: 0 };
    }
    return {
      ...common,
      t: intent.reduceOnly ? (intent.side === "sell" ? 3 : 4) : intent.side === "buy" ? 1 : 2,
      p: scaled(intent.price, this.scales[market].priceDecimals, "Perpl API price"),
      s: scaled(intent.size, this.scales[market].sizeDecimals, "Perpl API size"),
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
    if (frame.mt === 24) for (const order of frame.d) this.acceptOrder(order);
  }

  private acceptOrder(order: PerplOrder): void {
    const resolution = this.protocol.correlateOrder(order);
    if (!resolution) return;
    for (const [sn, pending] of this.pending) {
      if (pending.intent.accountId === order.acc) {
        if (pending.rq === order.rq) this.finish(sn, resolution, String(order.oid));
      }
    }
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
