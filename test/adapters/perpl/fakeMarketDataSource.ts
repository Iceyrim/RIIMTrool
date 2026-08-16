import type { PerplCandle, PerplFunding, PerplMarket, PerplMarketDataSource, PerplMarketState, PerplOrderBook, PerplTrade } from "../../../src/adapters/perpl/PerplMarketDataSource.js";

export class FakePerplMarketDataSource implements PerplMarketDataSource {
  markets: PerplMarket[]=[]; states=new Map<string,PerplMarketState>(); books=new Map<string,PerplOrderBook>(); trades=new Map<string,PerplTrade[]>(); funding=new Map<string,PerplFunding>(); connected=false;
  async connect():Promise<void>{this.connected=true;} async disconnect():Promise<void>{this.connected=false;} async getMarkets():Promise<PerplMarket[]>{return this.markets;}
  getMarketState(id:string):PerplMarketState{return this.states.get(id)!;} getOrderBook(id:string):PerplOrderBook{return this.books.get(id)!;} getFunding(id:string):PerplFunding{return this.funding.get(id)!;}
  getRecentTrades(id:string,after?:{timestamp:number;ids:ReadonlySet<string>}):PerplTrade[]{return(this.trades.get(id)??[]).filter((t)=>!after||t.timestamp>after.timestamp||(t.timestamp===after.timestamp&&!after.ids.has(t.id)));}
  async getCandles():Promise<PerplCandle[]>{return[];}
}
