import { ExchangeAdapterError } from "../AdapterError.js";
import type { AccountVolume, CancelOrderResult, ExchangeAdapter, MarketPrice, NormalizedBalance, NormalizedFill, NormalizedMarginStatus, NormalizedOrder, NormalizedPosition, OrderSide, OrderType, PlaceOrderParams, PlaceOrderResult } from "../ExchangeAdapter.js";
import { simulateFills, type SimulatedRestingOrder } from "../shared/paperFillSimulator.js";
import { quantizeScaled } from "./mappers.js";
import { PerplMarketRegistry, type ConfiguredPerplMarket } from "./marketRegistry.js";
import type { PerplMarketDataSource } from "./PerplMarketDataSource.js";

interface SimOrder { exchangeOrderId: string; clientOrderId?: string; market: string; side: OrderSide; type: OrderType; price: number; size: number; filledSize: number; isReduceOnly: boolean }
interface SimPosition { baseSize: number; entryPrice: number }
export interface PerplPaperAdapterConfig { markets: ConfiguredPerplMarket[]; startingBalanceUsdc: number }

/** Public market data plus local-only balances, positions, orders, fills and funding. */
export class PerplPaperAdapter implements ExchangeAdapter {
  readonly exchangeId = "perpl-paper";
  private readonly registry: PerplMarketRegistry;
  private readonly balances = new Map([["USDC", 0]]);
  private readonly positions = new Map<string, SimPosition>();
  private readonly orders = new Map<string, SimOrder>();
  private readonly fills = new Map<string, NormalizedFill[]>();
  private readonly cursors = new Map<string, { timestamp: number; ids: Set<string> }>();
  private readonly fundingCursor = new Map<string, number>();
  private readonly marks = new Map<string, number>();
  private readonly pnl = new Map<string, number>();
  private connected = false; private nextId = 1;

  constructor(private readonly source: PerplMarketDataSource, config: PerplPaperAdapterConfig) {
    this.registry = new PerplMarketRegistry(config.markets); this.balances.set("USDC", config.startingBalanceUsdc);
  }
  private ready(): void { if (!this.connected) throw new ExchangeAdapterError("PerplPaperAdapter is disconnected"); }
  async connect(): Promise<void> { const markets = await this.source.getMarkets(); this.registry.resolve(markets); await this.source.connect(markets.filter((m) => { try { this.registry.symbolFor(m.marketId); return true; } catch { return false; } }).map((m) => m.marketId)); this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; await this.source.disconnect(); }
  async drainRealizedPnlDeltaUsd(market: string): Promise<number> { const value = this.pnl.get(market) ?? 0; this.pnl.set(market, 0); return value; }

  private async prime(market: string): Promise<void> {
    const id = this.registry.marketFor(market).marketId; const trades = this.source.getRecentTrades(id);
    const timestamp = trades.at(-1)?.timestamp ?? 0; this.cursors.set(market, { timestamp, ids: new Set(trades.filter((t) => t.timestamp === timestamp).map((t) => t.id)) });
    this.fundingCursor.set(market, this.source.getFunding(id).timestamp);
  }
  private applyFill(market: string, side: OrderSide, price: number, size: number): void {
    const old = this.positions.get(market) ?? { baseSize: 0, entryPrice: 0 }; const delta = side === "buy" ? size : -size; const next = old.baseSize + delta;
    let entry = old.entryPrice;
    if (old.baseSize === 0 || Math.sign(old.baseSize) === Math.sign(delta)) entry = (Math.abs(old.baseSize) * old.entryPrice + size * price) / (Math.abs(old.baseSize) + size);
    else { const closed = Math.min(Math.abs(delta), Math.abs(old.baseSize)); const realized = side === "buy" ? (old.entryPrice - price) * closed : (price - old.entryPrice) * closed; this.pnl.set(market, (this.pnl.get(market) ?? 0) + realized); if (next !== 0 && Math.sign(next) !== Math.sign(old.baseSize)) entry = price; }
    this.positions.set(market, { baseSize: next, entryPrice: next === 0 ? 0 : entry }); this.balances.set("USDC", (this.balances.get("USDC") ?? 0) - delta * price);
  }
  private process(market: string): void {
    const id = this.registry.marketFor(market).marketId; const cursor = this.cursors.get(market); if (!cursor) throw new ExchangeAdapterError("Perpl trade cursor is incomplete");
    const trades = this.source.getRecentTrades(id, cursor); const resting: SimulatedRestingOrder[] = [...this.orders.values()].filter((o) => o.market === market).map((o) => ({ exchangeOrderId: o.exchangeOrderId, side: o.side, price: o.price, remainingSize: o.size - o.filledSize }));
    for (const fill of simulateFills(resting, trades.map((t) => ({ tradeId: t.id, takerSide: t.takerSide, price: t.price, size: t.size, timestamp: t.timestamp })))) { const order = this.orders.get(fill.exchangeOrderId); if (!order) continue; order.filledSize += fill.size; const list = this.fills.get(order.exchangeOrderId) ?? []; list.push({ exchangeOrderId: order.exchangeOrderId, tradeId: fill.tradeId, market, side: order.side, price: fill.price, size: fill.size, timestamp: fill.timestamp }); this.fills.set(order.exchangeOrderId, list); this.applyFill(market, order.side, fill.price, fill.size); if (order.filledSize >= order.size) this.orders.delete(order.exchangeOrderId); }
    if (trades.length) { const timestamp = Math.max(...trades.map((t) => t.timestamp)); this.cursors.set(market, { timestamp, ids: new Set(trades.filter((t) => t.timestamp === timestamp).map((t) => t.id)) }); }
  }
  async refreshAccountState(): Promise<void> { this.ready(); for (const market of new Set([...this.orders.values()].map((o) => o.market))) this.process(market); for (const [market, position] of this.positions) { if (!position.baseSize) continue; const funding = this.source.getFunding(this.registry.marketFor(market).marketId); const cursor = this.fundingCursor.get(market); if (cursor !== undefined && funding.timestamp > cursor) { const mark = this.source.getMarketState(funding.marketId).markPrice; const amount = -position.baseSize * mark * funding.rate; this.balances.set("USDC", (this.balances.get("USDC") ?? 0) + amount); this.pnl.set(market, (this.pnl.get(market) ?? 0) + amount); this.fundingCursor.set(market, funding.timestamp); } } }
  getPositions(market?: string): NormalizedPosition[] { this.ready(); return [...this.positions].filter(([m]) => !market || m === market).map(([m,p]) => { const mark = this.marks.get(m) ?? p.entryPrice; return { market: m, baseSize: p.baseSize, markPrice: mark, unrealizedPnl: (mark-p.entryPrice)*p.baseSize, openOrderCount: [...this.orders.values()].filter((o) => o.market===m).length }; }); }
  getOpenOrders(market?: string): NormalizedOrder[] { this.ready(); return [...this.orders.values()].filter((o) => !market || o.market===market).map((o) => ({ ...o, remainingSize: o.size-o.filledSize, state: o.filledSize ? "partiallyFilled" : "open" })); }
  getBalances(): NormalizedBalance[] { this.ready(); return [...this.balances].map(([token,amount]) => ({ token, amount })); }
  getMarginStatus(): NormalizedMarginStatus { this.ready(); const accountValue = this.balances.get("USDC") ?? 0; return { accountValue, maintenanceMarginFraction: 0, initialMarginFraction: 0, isAtBankruptcyRisk: accountValue < 0 }; }
  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> { this.ready(); const market = this.registry.marketFor(params.market); this.source.getMarketState(market.marketId); this.source.getOrderBook(market.marketId); if (!this.cursors.has(params.market)) await this.prime(params.market); const price=quantizeScaled(params.price,market.priceDecimals), size=quantizeScaled(params.size,market.sizeDecimals); if (!(price>0) || size<market.minimumPostingSize) return { success:false, reason:"REJECTED", message:`Perpl paper order is below minimum posting size ${market.minimumPostingSize}` }; const exchangeOrderId=`perpl-${this.nextId++}`; const order:SimOrder={exchangeOrderId,clientOrderId:params.clientOrderId,market:params.market,side:params.side,type:params.type,price,size,filledSize:0,isReduceOnly:params.isReduceOnly}; this.orders.set(exchangeOrderId,order); return { success:true, order:{...order,remainingSize:size,state:"open"},fills:[] }; }
  async cancelOrder(exchangeOrderId:string,market:string):Promise<CancelOrderResult>{this.ready();this.process(market);this.orders.delete(exchangeOrderId);return{success:true,exchangeOrderId};}
  async getOrderFills(id:string,_market:string):Promise<NormalizedFill[]>{this.ready();return this.fills.get(id)??[];}
  async getMarketPrice(market:string):Promise<MarketPrice>{this.ready();const state=this.source.getMarketState(this.registry.marketFor(market).marketId);this.marks.set(market,state.markPrice);return{market,mark:state.markPrice,index:state.indexPrice};}
  async getAccountVolume(params:{market?:string;since:string;until:string}):Promise<AccountVolume[]>{this.ready();const by=new Map<string,{base:number;quote:number}>();for(const fill of [...this.fills.values()].flat().filter((f)=>(!params.market||f.market===params.market)&&f.timestamp>=Date.parse(params.since)&&f.timestamp<=Date.parse(params.until))){const a=by.get(fill.market)??{base:0,quote:0};a.base+=fill.size;a.quote+=fill.size*fill.price;by.set(fill.market,a);}return[...by].map(([market,a])=>({market,since:params.since,until:params.until,baseVolume:a.base,quoteVolume:a.quote}));}
}
