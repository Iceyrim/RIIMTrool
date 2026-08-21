import { describe, expect, it } from "vitest";
import { utcDayWindowStart, utcWeekWindowStart } from "../../src/engine/utcCalendarWindows.js";

describe("utcDayWindowStart", () => {
  it("returns UTC midnight for a timestamp mid-day", () => {
    const nowMs = Date.parse("2026-08-21T14:37:02.123Z");
    expect(new Date(utcDayWindowStart(nowMs)).toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });

  it("is idempotent on an exact UTC midnight timestamp", () => {
    const nowMs = Date.parse("2026-08-21T00:00:00.000Z");
    expect(utcDayWindowStart(nowMs)).toBe(nowMs);
  });
});

describe("utcWeekWindowStart", () => {
  it("returns the preceding UTC Monday 00:00 for a mid-week timestamp (Friday)", () => {
    // 2026-08-21 is a Friday.
    const nowMs = Date.parse("2026-08-21T14:37:02.123Z");
    expect(new Date(utcWeekWindowStart(nowMs)).toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("returns the same-day Monday 00:00 when nowMs is already Monday", () => {
    const nowMs = Date.parse("2026-08-17T09:00:00.000Z");
    expect(new Date(utcWeekWindowStart(nowMs)).toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("rolls a Sunday back to the prior Monday", () => {
    // 2026-08-23 is a Sunday.
    const nowMs = Date.parse("2026-08-23T23:59:59.000Z");
    expect(new Date(utcWeekWindowStart(nowMs)).toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });
});
