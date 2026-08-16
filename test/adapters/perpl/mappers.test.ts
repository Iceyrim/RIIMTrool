import { describe,expect,it } from "vitest";
import { numberToScaled, quantizeScaled, scaledToNumber } from "../../../src/adapters/perpl/mappers.js";
describe("Perpl scaled precision",()=>{
  it("uses bigint-backed runtime decimals without float scaling drift",()=>{expect(numberToScaled(123.456789,6)).toBe(123456789n);expect(scaledToNumber("123456789",6)).toBe(123.456789);expect(quantizeScaled(1.23456,3)).toBe(1.235);});
  it("rejects malformed and non-finite values",()=>{expect(()=>scaledToNumber("1.2",2)).toThrow(/scaled integer/);expect(()=>numberToScaled(Infinity,2)).toThrow(/finite/);});
});
