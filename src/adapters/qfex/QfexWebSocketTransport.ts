import { createHmac, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { ExchangeAdapterError } from "../AdapterError.js";
import type { QfexCredentials, QfexMessage } from "./types.js";

export const QFEX_UAT_TRADE_URL = "wss://trade.qfex.io";
export const QFEX_UAT_MDS_URL = "wss://mds.qfex.io";
export const QFEX_PRODUCTION_TRADE_URL = "wss://trade.qfex.com";
export const QFEX_PRODUCTION_MDS_URL = "wss://mds.qfex.com";

export function buildQfexAuth(credentials: QfexCredentials, nonce = randomBytes(16).toString("hex"), unixTs = Math.floor(Date.now() / 1000)): QfexMessage {
  const signature = createHmac("sha256", credentials.secretKey).update(`${nonce}:${unixTs}`).digest("hex");
  return { type: "auth", params: { hmac: { public_key: credentials.publicKey, nonce, unix_ts: unixTs, signature }, ...(credentials.accountId ? { account_id: credentials.accountId } : {}) } };
}

export function isQfexAuthSuccess(message: QfexMessage): boolean {
  return message.authenticated === true || (message.type === "auth" && message.result === "success");
}

type Listener = (message: QfexMessage) => void;
type SocketFactory = (url: string) => WebSocket;
export interface QfexTransportConfig {
  tradeUrl: string;
  marketDataUrl: string;
  credentials: QfexCredentials;
  symbols: string[];
  timeoutMs?: number;
  socketFactory?: SocketFactory;
  cancelOnDisconnect?: boolean;
}

export class QfexWebSocketTransport {
  private trade?: WebSocket;
  private marketData?: WebSocket;
  private listeners = new Set<Listener>();
  private readonly timeoutMs: number;
  private readonly socketFactory: SocketFactory;
  constructor(private readonly config: QfexTransportConfig) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.socketFactory = config.socketFactory ?? ((url) => new WebSocket(url));
  }
  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(message: QfexMessage): void {
    for (const listener of this.listeners) listener(message);
  }
  private parse(data: WebSocket.RawData): void {
    try { this.emit(JSON.parse(data.toString()) as QfexMessage); } catch { /* ignore malformed frames */ }
  }
  private waitFor(predicate: (message: QfexMessage) => boolean, description: string): Promise<QfexMessage> {
    return new Promise((resolve, reject) => {
      let unsubscribe: () => void = () => {};
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new ExchangeAdapterError(`Timed out waiting for QFEX ${description}`, undefined, true));
      }, this.timeoutMs);
      unsubscribe = this.onMessage((message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(message);
      });
    });
  }
  private open(socket: WebSocket, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ExchangeAdapterError(`Timed out opening QFEX ${name}`, undefined, true)), this.timeoutMs);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(new ExchangeAdapterError(`QFEX ${name} failed: ${error.message}`, error, true)); });
      socket.on("message", (data) => this.parse(data));
    });
  }
  async connect(): Promise<void> {
    const tradeUrl = new URL(this.config.tradeUrl);
    tradeUrl.searchParams.set("api_key", this.config.credentials.publicKey);
    this.trade = this.socketFactory(tradeUrl.toString());
    this.marketData = this.socketFactory(this.config.marketDataUrl);
    await Promise.all([this.open(this.trade, "trade WebSocket"), this.open(this.marketData, "market-data WebSocket")]);
    const auth = this.waitFor(isQfexAuthSuccess, "authentication");
    this.sendTrade(buildQfexAuth(this.config.credentials));
    await auth;
    this.sendTrade({ type: "subscribe", params: { channels: ["order_responses", "fills", "balances", "positions"] } });
    if (this.config.cancelOnDisconnect !== false) {
      this.sendTrade({ type: "cancel_on_disconnect", params: { cancel_on_disconnect: true } });
    }
    this.sendMarketData({ type: "subscribe", channels: ["bbo", "mark_price"], symbols: this.config.symbols });
  }
  sendTrade(message: QfexMessage): void {
    if (!this.trade || this.trade.readyState !== WebSocket.OPEN) throw new ExchangeAdapterError("QFEX trade WebSocket is not connected");
    this.trade.send(JSON.stringify(message));
  }
  sendMarketData(message: QfexMessage): void {
    if (!this.marketData || this.marketData.readyState !== WebSocket.OPEN) throw new ExchangeAdapterError("QFEX market-data WebSocket is not connected");
    this.marketData.send(JSON.stringify(message));
  }
  request(message: QfexMessage, predicate: (response: QfexMessage) => boolean, description: string): Promise<QfexMessage> {
    const response = this.waitFor(predicate, description);
    this.sendTrade(message);
    return response;
  }
  async disconnect(): Promise<void> {
    for (const socket of [this.trade, this.marketData]) if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "client shutdown");
    this.trade = undefined;
    this.marketData = undefined;
  }
}
