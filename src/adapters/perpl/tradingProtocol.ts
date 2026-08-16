import { ExchangeAdapterError } from "../AdapterError.js";

export type PerplRequestKind = "place" | "cancel";
export type PerplRequestResolution<T = unknown> = { state: "confirmed"; value: T } | { state: "rejected"; error: string } | { state: "ambiguous"; reason: string };
export interface PerplOutcome<T = unknown> { rq: string; ok: boolean; result?: T; error?: string; order_id?: string; client_order_id?: string }
export interface PerplCursor { timestamp: number; ids: ReadonlySet<string> }

interface Pending { kind: PerplRequestKind; clientOrderId?: string; orderId?: string; sent: boolean; resolution?: PerplRequestResolution }

export class PerplTradingProtocol {
  private nextRq = 1n;
  private lastFinalizedRq = 0n;
  private sequence?: bigint;
  private connected = false;
  private snapshotReady = false;
  private pending = new Map<string, Pending>();
  private clientOrderRq = new Map<string, string>();
  private pnlCursor?: PerplCursor;
  private fundingCursor?: PerplCursor;

  connect(): void { this.connected=true; this.snapshotReady=false; this.sequence=undefined; }
  acceptSnapshot(sn: string|number|bigint): void { if(!this.connected) throw new ExchangeAdapterError("Perpl authenticated stream is disconnected"); this.sequence=this.parseSn(sn); this.snapshotReady=true; }
  acceptUpdate(sn: string|number|bigint): void { if(!this.connected||!this.snapshotReady||this.sequence===undefined) throw new ExchangeAdapterError("Perpl authenticated update arrived before snapshot"); const next=this.parseSn(sn); if(next!==this.sequence+1n){this.snapshotReady=false;throw new ExchangeAdapterError("Perpl authenticated sequence gap is ambiguous");} this.sequence=next; }
  disconnect(): void { this.connected=false; this.snapshotReady=false; this.sequence=undefined; for(const item of this.pending.values()) if(item.sent&&!item.resolution)item.resolution={state:"ambiguous",reason:"disconnected before correlated outcome"}; }

  begin(kind: PerplRequestKind, params: { clientOrderId?: string; orderId?: string }={}): string {
    if(kind==="place"&&!params.clientOrderId) throw new ExchangeAdapterError("Perpl place requires client order id");
    if(params.clientOrderId){const existing=this.clientOrderRq.get(params.clientOrderId);if(existing)return existing;}
    const rq=String(this.nextRq++); this.pending.set(rq,{kind,...params,sent:false}); if(params.clientOrderId)this.clientOrderRq.set(params.clientOrderId,rq); return rq;
  }
  markSent(rq:string):void{const item=this.require(rq);item.sent=true;}
  correlate<T>(outcome:PerplOutcome<T>):PerplRequestResolution<T>{
    const item=this.require(outcome.rq); if(item.resolution)return item.resolution as PerplRequestResolution<T>;
    if(!item.sent)throw new ExchangeAdapterError("Perpl outcome preceded request send");
    if(item.clientOrderId&&outcome.client_order_id&&item.clientOrderId!==outcome.client_order_id)throw new ExchangeAdapterError("Perpl outcome client order correlation mismatch");
    if(item.kind==="cancel"&&item.orderId&&outcome.order_id&&item.orderId!==outcome.order_id)throw new ExchangeAdapterError("Perpl cancel outcome order correlation mismatch");
    item.resolution=outcome.ok?{state:"confirmed",value:outcome.result as T}:{state:"rejected",error:outcome.error??"rejected"}; return item.resolution as PerplRequestResolution<T>;
  }
  resolveCancelRace(rq:string, order:{open:boolean;filled:boolean}):PerplRequestResolution {
    const item=this.require(rq); if(item.kind!=="cancel")throw new ExchangeAdapterError("Perpl request is not a cancellation");
    if(order.filled)return item.resolution={state:"confirmed",value:{cancelled:false,filled:true}};
    if(!order.open)return item.resolution={state:"confirmed",value:{cancelled:true,filled:false}};
    return item.resolution={state:"ambiguous",reason:"order remains open after cancellation outcome"};
  }
  finalize(rq:string):PerplRequestResolution|undefined{const numeric=this.parseSn(rq);if(numeric<=this.lastFinalizedRq)return this.pending.get(rq)?.resolution;const item=this.require(rq);if(!item.resolution)return undefined;this.lastFinalizedRq=numeric;return item.resolution;}
  setPnlCursor(entries:readonly {id:string;timestamp:number}[]):void{this.pnlCursor=this.advance(this.pnlCursor,entries);}
  setFundingCursor(entries:readonly {id:string;timestamp:number}[]):void{this.fundingCursor=this.advance(this.fundingCursor,entries);}
  unseenPnl<T extends {id:string;timestamp:number}>(entries:readonly T[]):T[]{return this.unseen(this.pnlCursor,entries);}
  unseenFunding<T extends {id:string;timestamp:number}>(entries:readonly T[]):T[]{return this.unseen(this.fundingCursor,entries);}
  private advance(cursor:PerplCursor|undefined,entries:readonly {id:string;timestamp:number}[]):PerplCursor|undefined{if(!entries.length)return cursor;const timestamp=Math.max(...entries.map((entry)=>entry.timestamp));return{timestamp,ids:new Set(entries.filter((entry)=>entry.timestamp===timestamp).map((entry)=>entry.id))};}
  private unseen<T extends {id:string;timestamp:number}>(cursor:PerplCursor|undefined,entries:readonly T[]):T[]{return entries.filter((entry)=>!cursor||entry.timestamp>cursor.timestamp||(entry.timestamp===cursor.timestamp&&!cursor.ids.has(entry.id)));}
  private require(rq:string):Pending{const item=this.pending.get(rq);if(!item)throw new ExchangeAdapterError(`Perpl outcome has unknown rq ${rq}`);return item;}
  private parseSn(value:string|number|bigint):bigint{if(!/^\d+$/.test(String(value)))throw new ExchangeAdapterError("Perpl sequence is malformed");return BigInt(String(value));}
}
