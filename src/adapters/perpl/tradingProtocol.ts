import { ExchangeAdapterError } from "../AdapterError.js";

export type PerplRequestKind = "place" | "cancel" | "modify";
export type PerplResolution = { state: "confirmed"; status: number; reason: number } | { state: "rejected"; source: "gateway" | "order"; error: string; reason?: number } | { state: "ambiguous"; reason: string };
export interface PerplRequestIdentity { accountId: number; rq: number; sn: number }
export interface PerplGatewayStatus { cid?: number; status: { code: number; error: string } }
export interface PerplOrderOutcome { acc: number; rq: number; oid: number; st: number; sr: number }
export type PerplRetry = { action: "same-rq"; rq: number } | { action: "new-rq"; rq: number } | { action: "wait" } | { action: "none"; reason: string };

interface Pending extends PerplRequestIdentity { kind: PerplRequestKind; orderId?: number; lb: number; sent: boolean; gatewayAccepted?: boolean; reconnected: boolean; retriedForSr32: boolean; resolution?: PerplResolution; firstFailure?: PerplOrderOutcome }
interface AccountCounter { lfr: number; local: number }

const definitiveStatuses = new Set([2,3,4,5,8,9,10]);
function uint(value:number,field:string):number{if(!Number.isSafeInteger(value)||value<0)throw new ExchangeAdapterError(`Perpl ${field} is not a safe unsigned integer`);return value;}

export class PerplTradingProtocol {
  private nextSn=1;
  private lastHeartbeatSn?:number;
  private connected=false;
  private accounts=new Map<number,AccountCounter>();
  private pendingBySn=new Map<number,Pending>();
  private pendingByRequest=new Map<string,Pending>();

  connect():void{this.connected=true;this.lastHeartbeatSn=undefined;for(const pending of this.pendingBySn.values())if(pending.sent&&!pending.resolution)pending.reconnected=true;}
  acceptWalletSnapshot(sn:number,accounts:readonly {id:number;lfr:number}[]):void{if(!this.connected)throw new ExchangeAdapterError("Perpl authenticated stream is disconnected");this.lastHeartbeatSn=uint(sn,"wallet sequence");for(const account of accounts)this.updateAccount(account.id,account.lfr);}
  acceptAccountUpdate(accountId:number,lfr:number):void{this.updateAccount(accountId,lfr);}
  acceptHeartbeat(sn:number):void{if(!this.connected||this.lastHeartbeatSn===undefined)throw new ExchangeAdapterError("Perpl heartbeat arrived before wallet snapshot");const next=uint(sn,"heartbeat sequence");if(next!==this.lastHeartbeatSn+1){this.lastHeartbeatSn=undefined;throw new ExchangeAdapterError("Perpl heartbeat sequence gap requires reconnect");}this.lastHeartbeatSn=next;}
  disconnect():void{this.connected=false;this.lastHeartbeatSn=undefined;for(const pending of this.pendingBySn.values())if(pending.sent&&!pending.resolution){pending.reconnected=true;pending.resolution={state:"ambiguous",reason:"disconnected before definitive order outcome"};}}

  begin(accountId:number,kind:PerplRequestKind,params:{orderId?:number;lb?:number}={}):PerplRequestIdentity{
    const account=this.accounts.get(uint(accountId,"account id"));if(!account)throw new ExchangeAdapterError("Perpl account lfr is not initialized");
    const rq=Math.max(account.local,account.lfr)+1;uint(rq,"rq");account.local=rq;
    const sn=this.nextSn++;uint(sn,"outbound sn");const pending:Pending={accountId,rq,sn,kind,orderId:params.orderId,lb:uint(params.lb??0,"lb"),sent:false,reconnected:false,retriedForSr32:false};
    this.pendingBySn.set(sn,pending);this.pendingByRequest.set(this.key(accountId,rq),pending);return{accountId,rq,sn};
  }
  markSent(sn:number):void{this.bySn(sn).sent=true;}
  correlateGateway(status:PerplGatewayStatus):PerplResolution|undefined{
    if(status.cid===undefined)throw new ExchangeAdapterError("Perpl gateway status omitted cid");const pending=this.bySn(status.cid);if(!pending.sent)throw new ExchangeAdapterError("Perpl gateway status preceded request send");
    if(status.status.code===0){pending.gatewayAccepted=true;return undefined;}
    return pending.resolution={state:"rejected",source:"gateway",error:status.status.error||`status ${status.status.code}`};
  }
  correlateOrder(order:PerplOrderOutcome):PerplResolution|undefined{
    const pending=this.pendingByRequest.get(this.key(uint(order.acc,"order account"),uint(order.rq,"order rq")));if(!pending)return undefined;
    if(pending.resolution?.state==="confirmed")return pending.resolution;
    if(definitiveStatuses.has(order.st))return pending.resolution={state:"confirmed",status:order.st,reason:order.sr};
    if(order.st===7){if(!pending.firstFailure)pending.firstFailure=order;if(!pending.resolution)return pending.resolution={state:"rejected",source:"order",error:"order failed",reason:order.sr};}
    return pending.resolution;
  }
  retry(sn:number,head:number):PerplRetry{
    const pending=this.bySn(sn);uint(head,"head");
    if(pending.resolution?.state==="confirmed"||pending.resolution?.state==="rejected"&&pending.resolution.source==="gateway")return{action:"none",reason:"request already has a definitive outcome"};
    if(pending.firstFailure?.sr===32&&!pending.retriedForSr32){pending.retriedForSr32=true;return{action:"new-rq",rq:this.allocateRq(pending.accountId)};}
    if(!pending.firstFailure&&(pending.lb===0||head<pending.lb))return{action:"same-rq",rq:pending.rq};
    if(!pending.firstFailure&&pending.lb>0&&head>=pending.lb&&!pending.reconnected)return{action:"new-rq",rq:this.allocateRq(pending.accountId)};
    if(pending.reconnected)return{action:"none",reason:"disconnect made expiry observation ambiguous"};
    return{action:"wait"};
  }
  resolveCancellation(sn:number,order:{status:"open"|"filled"|"cancelled"|"absent"}):PerplResolution{
    const pending=this.bySn(sn);if(pending.kind!=="cancel")throw new ExchangeAdapterError("Perpl request is not a cancellation");
    if(order.status==="filled")return pending.resolution={state:"confirmed",status:4,reason:0};
    if(order.status==="cancelled")return pending.resolution={state:"confirmed",status:5,reason:28};
    return pending.resolution={state:"ambiguous",reason:order.status==="open"?"order remains open after cancellation":"absence alone does not prove cancellation"};
  }
  resolution(sn:number):PerplResolution|undefined{return this.bySn(sn).resolution;}
  private updateAccount(accountId:number,lfr:number):void{accountId=uint(accountId,"account id");lfr=uint(lfr,"account lfr");const current=this.accounts.get(accountId);this.accounts.set(accountId,{lfr,local:Math.max(current?.local??0,lfr)});}
  private allocateRq(accountId:number):number{const account=this.accounts.get(accountId);if(!account)throw new ExchangeAdapterError("Perpl account lfr is not initialized");const rq=Math.max(account.local,account.lfr)+1;uint(rq,"rq");account.local=rq;return rq;}
  private bySn(sn:number):Pending{const pending=this.pendingBySn.get(uint(sn,"cid"));if(!pending)throw new ExchangeAdapterError(`Perpl gateway status has unknown cid ${sn}`);return pending;}
  private key(accountId:number,rq:number):string{return`${accountId}:${rq}`;}
}
