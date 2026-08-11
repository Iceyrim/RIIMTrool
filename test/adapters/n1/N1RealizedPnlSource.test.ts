/**
 * N1RealizedPnlSource replaces scripts/run-live.ts's former always-zero PnL stub — the change
 * this suite exists to prove correct is specifically: real network calls to N1's getAccountPnl()
 * ledger, a persisted session anchor that survives restarts without resetting or double-counting,
 * and "throw, never return 0" on every failure mode (a real realized loss must never be masked
 * as "no PnL this cycle" — see CLAUDE.md's now-resolved hard-prerequisite follow-up item).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AccountPnlInfo, Nord } from "@n1xyz/nord-ts";
import { N1RealizedPnlSource } from "../../../src/adapters/n1/N1RealizedPnlSource.js";

const BTC = "BTCUSD";
const ETH = "ETHUSD";
const BTC_ID = 1;
const ETH_ID = 2;
const ACCOUNT_ID = 7;
const CONFIGURED_MARKETS = [
  { symbol: BTC, exchangeSymbol: "BTCUSDC" },
  { symbol: ETH, exchangeSymbol: "ETHUSDC" },
];

function pnlEntry(
  time: string,
  actionId: number,
  subActionId: number,
  marketId: number,
  tradingPnl: number,
  settledFundingPnl = 0,
): AccountPnlInfo {
  return { time, actionId, subActionId, marketId, tradingPnl, settledFundingPnl } as AccountPnlInfo;
}

/** In-memory stand-in for N1's real /account/{id}/history/pnl endpoint: filters by since/until
 * (inclusive) and marketId the same way the real server is documented to, and paginates via an
 * opaque index-string cursor — close enough to real pagination semantics to exercise
 * N1RealizedPnlSource's own paging/dedup logic honestly, not just return canned pages. */
function makeFakeNord(
  ledger: AccountPnlInfo[],
  options: { serverPageSize?: number; markets?: { marketId: number; symbol: string }[] } = {},
): { markets: { marketId: number; symbol: string }[]; getAccountPnl: ReturnType<typeof vi.fn> } {
  const markets = options.markets ?? [
    { marketId: BTC_ID, symbol: "BTCUSDC" },
    { marketId: ETH_ID, symbol: "ETHUSDC" },
  ];
  const getAccountPnl = vi.fn(
    async (
      _accountId: number,
      query: {
        since?: string;
        until?: string;
        marketId?: number;
        startInclusive?: string;
        pageSize?: number;
      } = {},
    ) => {
      // Deliberately does NOT filter by `until` — test entries are synthesized at push time and
      // may legitimately sit a few milliseconds later than a `until` captured moments earlier in
      // the same drain call. Real N1 would never see "future" data past `until`; this fake only
      // needs to exercise `since`/marketId filtering and pagination honestly.
      const { since, marketId, startInclusive, pageSize } = query;
      const filtered = ledger
        .filter((e) => marketId === undefined || e.marketId === marketId)
        .filter((e) => since === undefined || e.time >= since)
        .sort((a, b) => (a.time === b.time ? a.subActionId - b.subActionId : a.time < b.time ? -1 : 1));

      const effectivePageSize = options.serverPageSize ?? pageSize ?? 200;
      const startIdx = startInclusive !== undefined ? Number(startInclusive) : 0;
      const items = filtered.slice(startIdx, startIdx + effectivePageSize);
      const nextIdx = startIdx + effectivePageSize;
      const nextStartInclusive = nextIdx < filtered.length ? String(nextIdx) : undefined;
      return { items, nextStartInclusive };
    },
  );
  return { markets, getAccountPnl };
}

function anchorPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-pnl-anchor-test-"));
  return join(dir, "pnl-session-anchor.json");
}

describe("N1RealizedPnlSource", () => {
  describe("initialize()", () => {
    it("resolves configured markets and live-probes each one, even with no persisted anchor", async () => {
      const fakeNord = makeFakeNord([]);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });

      await source.initialize(CONFIGURED_MARKETS);

      expect(fakeNord.getAccountPnl).toHaveBeenCalled();
      const calledMarketIds = fakeNord.getAccountPnl.mock.calls.map(
        (c: unknown[]) => (c[1] as { marketId: number }).marketId,
      );
      expect(calledMarketIds).toEqual(expect.arrayContaining([BTC_ID, ETH_ID]));
    });

    it("writes a persisted anchor file after a fresh initialize()", async () => {
      const path = anchorPath();
      const fakeNord = makeFakeNord([]);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: path,
      });

      await source.initialize(CONFIGURED_MARKETS);

      const persisted = JSON.parse(readFileSync(path, "utf-8"));
      expect(Object.keys(persisted.markets).sort()).toEqual([BTC, ETH].sort());
    });

    it("still makes a live probe call on restart, even though a persisted anchor already exists", async () => {
      const path = anchorPath();
      const fakeNord1 = makeFakeNord([]);
      const first = new N1RealizedPnlSource({
        nord: fakeNord1 as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: path,
      });
      await first.initialize(CONFIGURED_MARKETS);
      const persistedBefore = readFileSync(path, "utf-8");

      const fakeNord2 = makeFakeNord([]);
      const second = new N1RealizedPnlSource({
        nord: fakeNord2 as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: path,
      });
      await second.initialize(CONFIGURED_MARKETS);

      // A fresh network call happened on the "restart" instance too...
      expect(fakeNord2.getAccountPnl).toHaveBeenCalled();
      // ...but the persisted cursor itself was NOT reset to a new "now" boundary.
      expect(readFileSync(path, "utf-8")).toBe(persistedBefore);
    });

    it("throws, and never resolves, if the live probe call fails", async () => {
      const fakeNord = makeFakeNord([]);
      fakeNord.getAccountPnl.mockRejectedValueOnce(new Error("network down"));
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });

      await expect(source.initialize(CONFIGURED_MARKETS)).rejects.toThrow(/network down/);
    });

    it("throws if the persisted anchor file is corrupt JSON", async () => {
      const path = anchorPath();
      writeFileSync(path, "{not valid json", "utf-8");
      const fakeNord = makeFakeNord([]);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: path,
      });

      await expect(source.initialize(CONFIGURED_MARKETS)).rejects.toThrow(/Failed to parse/);
    });

    it("throws if the persisted anchor file is missing its markets object", async () => {
      const path = anchorPath();
      writeFileSync(path, JSON.stringify({ notMarkets: {} }), "utf-8");
      const fakeNord = makeFakeNord([]);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: path,
      });

      await expect(source.initialize(CONFIGURED_MARKETS)).rejects.toThrow(/malformed/);
    });
  });

  describe("drainRealizedPnlDeltaUsd()", () => {
    it("throws if called before initialize()", async () => {
      const fakeNord = makeFakeNord([]);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).rejects.toThrow(/initialize/);
    });

    it("throws for a market that was never passed to initialize()", async () => {
      const fakeNord = makeFakeNord([]);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize([CONFIGURED_MARKETS[0]!]); // BTC only

      await expect(source.drainRealizedPnlDeltaUsd(ETH)).rejects.toThrow(/not passed to initialize/);
    });

    it("sums a single profitable trade's tradingPnl", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      ledger.push(pnlEntry(new Date().toISOString(), 1, 0, BTC_ID, 42.5));

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(42.5);
    });

    it("sums a single losing trade's negative tradingPnl", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      ledger.push(pnlEntry(new Date().toISOString(), 1, 0, BTC_ID, -17.25));

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(-17.25);
    });

    it("excludes settledFundingPnl — only tradingPnl is summed", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      ledger.push(pnlEntry(new Date().toISOString(), 1, 0, BTC_ID, 10, /* settledFundingPnl */ 999));

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(10);
    });

    it("sums multiple entries in one drain (partial close across several fills)", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      const now = Date.now();
      ledger.push(
        pnlEntry(new Date(now + 1000).toISOString(), 1, 0, BTC_ID, 5),
        pnlEntry(new Date(now + 2000).toISOString(), 2, 0, BTC_ID, 3),
        pnlEntry(new Date(now + 3000).toISOString(), 3, 0, BTC_ID, -1.5),
      );

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(6.5);
    });

    it("models a position flip as a closing entry plus a zero-pnl opening entry, summing correctly", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      const now = Date.now();
      // Closing the old long realizes +8; the new short leg that immediately opens has no
      // realized pnl of its own yet.
      ledger.push(
        pnlEntry(new Date(now + 1000).toISOString(), 1, 0, BTC_ID, 8),
        pnlEntry(new Date(now + 1000).toISOString(), 1, 1, BTC_ID, 0),
      );

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(8);
    });

    it("keeps each market's realized PnL separate — draining one never leaks into another", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      const now = Date.now();
      ledger.push(
        pnlEntry(new Date(now + 1000).toISOString(), 1, 0, BTC_ID, 20),
        pnlEntry(new Date(now + 1000).toISOString(), 2, 0, ETH_ID, -6),
      );

      await expect(source.drainRealizedPnlDeltaUsd(ETH)).resolves.toBeCloseTo(-6);
      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(20);
    });

    it("excludes PnL history that predates the session anchor (pre-existing historical PnL)", async () => {
      const past = new Date(Date.now() - 60_000).toISOString(); // one minute before initialize()
      const ledger: AccountPnlInfo[] = [pnlEntry(past, 1, 0, BTC_ID, 500)];
      const fakeNord = makeFakeNord(ledger);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS); // anchor = "now", strictly after `past`

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBe(0);
    });

    it("does not double-count entries tied exactly at the cursor boundary across repeated drains", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      const tieTime = new Date(Date.now() + 1000).toISOString();
      ledger.push(
        pnlEntry(tieTime, 1, 0, BTC_ID, 4),
        pnlEntry(tieTime, 1, 1, BTC_ID, 6),
      );
      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(10);
      // A second drain immediately after, with no new data, must not re-sum the same two
      // entries just because the cursor's `since` still lands exactly on tieTime.
      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBe(0);

      // A genuinely new entry landing at that exact same tied timestamp is still counted.
      ledger.push(pnlEntry(tieTime, 1, 2, BTC_ID, 1.5));
      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(1.5);
    });

    it("restart does not reset or duplicate session PnL — a previously-drained entry is not re-summed, a new one after restart is", async () => {
      const path = anchorPath();
      const ledger: AccountPnlInfo[] = [];
      const fakeNord1 = makeFakeNord(ledger);
      const first = new N1RealizedPnlSource({
        nord: fakeNord1 as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: path,
      });
      await first.initialize(CONFIGURED_MARKETS);

      ledger.push(pnlEntry(new Date(Date.now() + 1000).toISOString(), 1, 0, BTC_ID, 15));
      await expect(first.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(15);

      // Simulate a process restart: brand new instance, same anchor file on disk.
      const fakeNord2 = makeFakeNord(ledger);
      const second = new N1RealizedPnlSource({
        nord: fakeNord2 as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: path,
      });
      await second.initialize(CONFIGURED_MARKETS);

      // The already-counted +15 must not reappear...
      await expect(second.drainRealizedPnlDeltaUsd(BTC)).resolves.toBe(0);

      // ...but a genuinely new fill realized after the restart is picked up normally.
      ledger.push(pnlEntry(new Date(Date.now() + 2000).toISOString(), 2, 0, BTC_ID, 3));
      await expect(second.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(3);
    });

    it("walks multiple pages within one drain when the server paginates below the requested pageSize", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger, { serverPageSize: 1 });
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      const now = Date.now();
      ledger.push(
        pnlEntry(new Date(now + 1000).toISOString(), 1, 0, BTC_ID, 1),
        pnlEntry(new Date(now + 2000).toISOString(), 2, 0, BTC_ID, 2),
        pnlEntry(new Date(now + 3000).toISOString(), 3, 0, BTC_ID, 3),
      );

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).resolves.toBeCloseTo(6);
      // getAccountPnl was called once for the initial probe (initialize) plus 3 pages this drain.
      expect(fakeNord.getAccountPnl.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it("throws rather than looping forever when a backlog exceeds maxPagesPerDrain", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger, { serverPageSize: 1 });
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
        maxPagesPerDrain: 2,
      });
      await source.initialize(CONFIGURED_MARKETS);

      const now = Date.now();
      ledger.push(
        pnlEntry(new Date(now + 1000).toISOString(), 1, 0, BTC_ID, 1),
        pnlEntry(new Date(now + 2000).toISOString(), 2, 0, BTC_ID, 1),
        pnlEntry(new Date(now + 3000).toISOString(), 3, 0, BTC_ID, 1),
      );

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).rejects.toThrow(/maxPagesPerDrain/);
    });

    it("throws — never returns 0 — when the network call fails", async () => {
      const fakeNord = makeFakeNord([]);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      fakeNord.getAccountPnl.mockRejectedValueOnce(new Error("timeout"));
      await expect(source.drainRealizedPnlDeltaUsd(BTC)).rejects.toThrow(/timeout/);
    });

    it("throws — never returns 0 — when an entry has a malformed tradingPnl field", async () => {
      const ledger: AccountPnlInfo[] = [];
      const fakeNord = makeFakeNord(ledger);
      const source = new N1RealizedPnlSource({
        nord: fakeNord as unknown as Nord,
        accountId: ACCOUNT_ID,
        anchorFilePath: anchorPath(),
      });
      await source.initialize(CONFIGURED_MARKETS);

      ledger.push({
        time: new Date(Date.now() + 1000).toISOString(),
        actionId: 1,
        subActionId: 0,
        marketId: BTC_ID,
        tradingPnl: Number.NaN,
        settledFundingPnl: 0,
      } as AccountPnlInfo);

      await expect(source.drainRealizedPnlDeltaUsd(BTC)).rejects.toThrow(/malformed tradingPnl/);
    });
  });
});
