/**
 * Pure UTC calendar-window boundary math for WindowLossCapTracker. Deliberately has no notion of
 * loss caps, persistence, or alerting — just "what UTC millisecond does this window start at" —
 * so it's trivially unit-testable and has nothing accounting-related to get wrong.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the UTC calendar day containing nowMs, as a unix-ms timestamp. */
export function utcDayWindowStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Start of the UTC calendar week (Monday 00:00) containing nowMs, as a unix-ms timestamp. */
export function utcWeekWindowStart(nowMs: number): number {
  const dayStart = utcDayWindowStart(nowMs);
  const dayOfWeek = new Date(dayStart).getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  return dayStart - daysSinceMonday * DAY_MS;
}
