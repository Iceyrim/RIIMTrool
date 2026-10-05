import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../scripts/run-risex-live.ts", import.meta.url), "utf8");

describe("RISEx live runner safety contract", () => {
  it("keeps the session signer out of read-only preflight", () => {
    expect(source.indexOf("if (preflightOnly)")).toBeLessThan(source.indexOf("RISEX_SESSION_SIGNER_PRIVATE_KEY"));
    expect(source).toContain("no signer was opened and no transaction was submitted");
  });
  it("requires all three operator gates before loading the signer", () => {
    const flag = source.indexOf("requireRiseXLiveCliFlag(argv)");
    const arm = source.indexOf("consumeRiseXLiveArmFile(resolve");
    const confirmation = source.indexOf("await confirm(`CONFIRM LIVE RISEX");
    const signer = source.indexOf("RISEX_SESSION_SIGNER_PRIVATE_KEY");
    expect(flag).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(flag);
    expect(confirmation).toBeGreaterThan(arm);
    expect(signer).toBeGreaterThan(confirmation);
  });
  it("installs mandatory cleanup, bounded flattening, and final reconciliation", () => {
    expect(source).toContain("await runner!.shutdown()");
    expect(source).toContain("planRiseXFlattenChunks");
    expect(source).toContain('type: "immediateOrCancel"');
    expect(source).toContain("isReduceOnly: true");
    expect(source).toContain('finalStatus: flat ? "completed-flat" : "manual-review-required"');
    expect(source).toContain('process.once("SIGINT"');
    expect(source).toContain('process.once("SIGTERM"');
  });
  it("turns an equity halt into immediate runner-owned shutdown", () => {
    expect(source).toContain("private readonly onHalt");
    expect(source).toContain("this.onHalt(reason)");
    expect(source).toContain("publisher?.halt(reason)");
    expect(source).toContain("void shutdown(reason)");
    expect(source).toContain("publisher!.stop(reason)");
  });
});
