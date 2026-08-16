import { describe,expect,it } from "vitest";
import { mapAuthSnapshot,mapAuthUpdate } from "../../../src/adapters/perpl/authMappers.js";

const scaling={priceDecimals:2,sizeDecimals:3,collateralDecimals:6};
const snapshot={mt:"snapshot" as const,sn:"40",balances:[{asset:"USD",total:"12500000",available:"12000000"}],positions:[{market_id:"7",base_size:"-125",entry_price:"250050",mark_price:"249950",unrealized_pnl:"12500"}],orders:[{order_id:"order-a",client_order_id:"client-a",market_id:"7",side:1,type:"post_only",price:"249900",size:"200",filled_size:"50",status:"open"}],fills:[{fill_id:"fill-a",order_id:"order-a",market_id:"7",price:"249900",size:"50",fee:"1250",timestamp:1700000000}],pnl:[{id:"pnl-a",market_id:"7",amount:"-5000",timestamp:1700000001}],funding:[{id:"fund-a",market_id:"7",amount:"2500",rate:"125",timestamp:1700000002}]};

describe("Perpl authenticated mappers",()=>{
  it("strictly maps and scales a complete snapshot",()=>{const mapped=mapAuthSnapshot(snapshot,scaling);expect(mapped.sequence).toBe(40n);expect(mapped.balances[0]).toEqual({asset:"USD",total:12.5,available:12});expect(mapped.positions[0]?.baseSize).toBe(-0.125);expect(mapped.orders[0]).toMatchObject({side:"buy",type:"postOnly",price:2499,size:.2,filledSize:.05,remainingSize:.15});expect(mapped.funding[0]?.rate).toBe(.000125);});
  it("maps sparse updates without silently fabricating collections",()=>{expect(mapAuthUpdate({mt:"update",sn:"41",orders:[]},scaling)).toEqual({sequence:41n,orders:[]});});
  it("rejects missing, additional, and invalid scaled fields",()=>{expect(()=>mapAuthSnapshot({...snapshot,unexpected:true} as never,scaling)).toThrow(/schema mismatch/);expect(()=>mapAuthSnapshot({...snapshot,balances:[{asset:"USD",total:"1.2",available:"1"}]} as never,scaling)).toThrow(/total is malformed/);expect(()=>mapAuthSnapshot({...snapshot,orders:[{...snapshot.orders[0],filled_size:"201"}]} as never,scaling)).toThrow(/exceeds size/);});
});
