import { describe,expect,it } from "vitest";
import { PerplMarketRegistry } from "../../../src/adapters/perpl/marketRegistry.js";
const market=(id:string,symbol:string,open=true)=>({marketId:id,symbol,priceDecimals:2,sizeDecimals:3,minimumPostingSize:.001,open});
describe("PerplMarketRegistry",()=>{
  it("discovers IDs by configured exchange symbol",()=>{const r=new PerplMarketRegistry([{symbol:"BTCUSD",exchangeSymbol:"BTC-PERP"}]);r.resolve([market("dynamic-9","BTC-PERP")]);expect(r.marketFor("BTCUSD").marketId).toBe("dynamic-9");});
  it("fails closed for missing or closed markets",()=>{expect(()=>new PerplMarketRegistry([{symbol:"BTCUSD",exchangeSymbol:"BTC-PERP"}]).resolve([])).toThrow();expect(()=>new PerplMarketRegistry([{symbol:"BTCUSD",exchangeSymbol:"BTC-PERP"}]).resolve([market("1","BTC-PERP",false)])).toThrow(/not open/);});
});
