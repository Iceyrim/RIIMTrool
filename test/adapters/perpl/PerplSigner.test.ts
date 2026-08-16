import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PerplSigner, canonicalJson, canonicalRestPayload, canonicalWsPayload } from "../../../src/adapters/perpl/PerplSigner.js";

const seed=Uint8Array.from({length:32},(_,index)=>index+1);
const spkiPrefix=Buffer.from("302a300506032b6570032100","hex");

describe("PerplSigner",()=>{
  it("canonicalizes objects recursively without mutating arrays",()=>{expect(canonicalJson({z:1,a:{y:2,x:[3,1]}})).toBe('{"a":{"x":[3,1],"y":2},"z":1}');});
  it("pins the REST preimage and produces a verifiable signature",()=>{const signer=new PerplSigner(seed);const body={size:"125",market_id:"7"};const payload=canonicalRestPayload("post","/orders?b=2&a=1",1700000000000,body);expect(payload).toBe('POST\n/orders?b=2&a=1\n1700000000000\n{"market_id":"7","size":"125"}');const headers=signer.signRest("post","/orders?b=2&a=1",1700000000000,body);const key=createPublicKey({key:Buffer.concat([spkiPrefix,Buffer.from(signer.publicKey,"hex")]),format:"der",type:"spki"});expect(verify(null,Buffer.from(payload),key,Buffer.from(headers["x-perpl-signature"],"hex"))).toBe(true);});
  it("signs the canonical WS envelope without embedding signature in its preimage",()=>{const signer=new PerplSigner(seed);const frame=signer.signWs("12",1700000000001,{op:"cancel",order_id:"safe-order"});expect(canonicalWsPayload(frame.rq,frame.ts,frame.d)).toBe('{"d":{"op":"cancel","order_id":"safe-order"},"rq":"12","ts":"1700000000001"}');expect(frame.sig).toMatch(/^[0-9a-f]{128}$/);});
  it("rejects values JSON cannot safely canonicalize",()=>{expect(()=>canonicalJson({value:Number.NaN})).toThrow(/non-finite/);expect(()=>canonicalJson(undefined)).toThrow(/cannot encode/);});
});
