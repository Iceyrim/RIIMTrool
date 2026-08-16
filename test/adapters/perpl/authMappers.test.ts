import {describe,expect,it} from "vitest";
import {mapAuthenticatedFrame} from "../../../src/adapters/perpl/authMappers.js";
const at={b:10,t:1700000000000};
describe("authenticated Perpl frames",()=>{
 it("maps mt19 and preserves decimal Amount strings",()=>{const frame=mapAuthenticatedFrame({mt:19,sn:7,at,addr:"0xabc",n:1,fl:0,as:[{in:1,id:12,fr:false,fw:true,ft:2,lfr:90,b:"12.500",lb:"0.125",h:[]}],sts:[{in:1,id:12,td:"1",tw:"0",tv:"2.50",tf:"0.01",trp:"-0.5",wr:5000,tt:2}]});expect(frame.mt).toBe(19);if(frame.mt===19)expect(frame.as?.[0]).toMatchObject({id:12,lfr:90,b:"12.500",lb:"0.125"});});
 it("maps confirmed mt23-28 frame bodies without scaling or invented ids",()=>{const order={at,c:at,rq:2,mkt:1,acc:12,oid:3,scid:4,st:2,sr:35,t:1,os:5,fp:6,fs:0,f:"0",fl:0,mm:10,lv:1000};expect(mapAuthenticatedFrame({mt:24,at,d:[order]})).toMatchObject({mt:24,d:[{rq:2,oid:3,f:"0"}]});expect(mapAuthenticatedFrame({mt:25,at,d:[{at,mkt:1,acc:12,oid:3,t:1,l:1,s:5,f:"-0.01"}]})).toMatchObject({mt:25,d:[{f:"-0.01"}]});});
 it("rejects unsafe uint64 values and non-string Amounts",()=>{expect(()=>mapAuthenticatedFrame({mt:21,in:1,id:Number.MAX_SAFE_INTEGER+1,fr:false,fw:true,ft:0,lfr:0,b:"0",lb:"0"})).toThrow(/safe/);expect(()=>mapAuthenticatedFrame({mt:21,in:1,id:1,fr:false,fw:true,ft:0,lfr:0,b:1,lb:"0"})).toThrow(/Amount/);});
});
