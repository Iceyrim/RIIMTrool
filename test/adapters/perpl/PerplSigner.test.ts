import { createPublicKey,verify } from "node:crypto";
import { describe,expect,it } from "vitest";
import { PerplSigner,canonicalRestPayload,canonicalWsPayload } from "../../../src/adapters/perpl/PerplSigner.js";
const seed=Uint8Array.from({length:32},(_,i)=>i+1);const prefix=Buffer.from("302a300506032b6570032100","hex");
function verifies(payload:string,signature:string):boolean{const noble=requirePublic();const key=createPublicKey({key:Buffer.concat([prefix,Buffer.from(noble,"hex")]),format:"der",type:"spki"});return verify(null,Buffer.from(payload),key,Buffer.from(signature,"base64url"));}
function requirePublic():string{return "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664";}
describe("PerplSigner",()=>{
 it("signs the six-field REST preimage using the raw body",()=>{const body='{"size":"125","market_id":7}';const payload=canonicalRestPayload(143,"post","/v1/trading/fills?count=1","1700000000000","AQID",body);expect(payload).toBe("143\nPOST\n/v1/trading/fills?count=1\n1700000000000\nAQID\n55763991247128b63845e0ebddd8621ecdc71d437dfcf3dcad24a205bfbfb94b");const headers=new PerplSigner(seed,"opaque-key",143).signRest("post","/v1/trading/fills?count=1","1700000000000","AQID",body);expect(headers["X-API-Key"]).toBe("opaque-key");expect(verifies(payload,headers["X-API-Signature"])).toBe(true);});
 it("creates the documented mt:29 sign-in frame",()=>{const signer=new PerplSigner(seed,"opaque-key",143);const frame=signer.signWs("1700000000001","nonce");const payload=canonicalWsPayload(143,frame.timestamp,frame.nonce);expect(frame).toMatchObject({mt:29,chain_id:143,api_key:"opaque-key",timestamp:"1700000000001",nonce:"nonce"});expect(verifies(payload,frame.signature)).toBe(true);});
});
