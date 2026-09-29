import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = readFileSync(new URL("../../scripts/run-qfex-live.ts", import.meta.url), "utf8");
describe("QFEX live runner safety contract", () => {
  it("requires environment, production, arm, confirmation and cleanup gates", () => {
    expect(source).toContain('QFEX_ENV ?? "uat"');
    expect(source).toContain('QFEX_ALLOW_PRODUCTION');
    expect(source).toContain("consumeQfexLiveArmFile");
    expect(source).toContain("CONFIRM LIVE QFEX");
    expect(source).toContain("await runner.shutdown()");
    expect(source).toContain("isReduceOnly: true");
    expect(source).toContain("cancelOnDisconnect: !preflightOnly");
    expect(source).toContain('finalStatus: flat ? "completed-flat" : "manual-review-required"');
    expect(source).toContain("daily confirmed-fill volume target reached");
    expect(source).toContain("await adapter.getAccountVolume(qfexUtcDayWindow())");
    expect(source).toContain("clearInterval(dailyVolumeTimer)");
  });
  it("does not connect when imported", () => {
    expect(source).toContain('if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)');
  });
});
