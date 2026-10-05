import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runAllPerplAutomationRehearsals,
  runPerplAutomationSessionRehearsal,
} from "../../scripts/run-perpl-automation-session-rehearsal.js";

describe("offline Perpl automation session rehearsal", () => {
  it("completes two exact place-cancel quote lifecycles", async () => {
    const report = await runPerplAutomationSessionRehearsal("healthy_requote");
    expect(report.actions).toEqual(["place", "cancel", "place", "cancel"]);
    expect(report.steps.map((step) => step.action)).toEqual([
      "placed",
      "cancelled_for_requote",
      "placed",
      "cancelled_for_requote",
    ]);
    expect(report).toMatchObject({ finalControllerState: "idle", flat: true });
  });

  it("cleans up once after a safety halt and blocks further placement", async () => {
    const report = await runPerplAutomationSessionRehearsal("safety_cleanup");
    expect(report.actions).toEqual(["place", "cancel"]);
    expect(report.steps.map((step) => step.action)).toEqual([
      "placed",
      "cleaned_after_halt",
      "blocked",
    ]);
    expect(report).toMatchObject({ finalControllerState: "idle", flat: true });
  });

  it("halts permanently after one ambiguous cleanup without retrying", async () => {
    const report = await runPerplAutomationSessionRehearsal("ambiguous_cleanup");
    expect(report.actions).toEqual(["place", "cancel"]);
    expect(report.steps.map((step) => step.action)).toEqual(["placed", "halted", "halted"]);
    expect(report).toMatchObject({ finalControllerState: "halted", flat: false });
    expect(report.steps[1]?.reason).toMatch(/timeout/);
  });

  it("runs all three deterministic scenarios without a production transport", async () => {
    const reports = await runAllPerplAutomationRehearsals();
    expect(reports.map((report) => report.scenario)).toEqual([
      "healthy_requote",
      "safety_cleanup",
      "ambiguous_cleanup",
    ]);
    const source = readFileSync(
      resolve("scripts/run-perpl-automation-session-rehearsal.ts"),
      "utf8",
    );
    expect(source).toContain('mode: "offline-in-memory-automation-rehearsal"');
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/signer|wallet|private.?key|nonce|gas/i);
  });
});
