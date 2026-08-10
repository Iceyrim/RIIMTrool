import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TradeLog, type TradeLogEntry } from "../../src/engine/TradeLog.js";

const MARKET = "BTCUSD";

function tempLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "riimtrool-tradelog-test-"));
  return join(dir, "trades.jsonl");
}

function readEntries(path: string): TradeLogEntry[] {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TradeLogEntry);
}

describe("TradeLog", () => {
  let path: string;
  let tradeLog: TradeLog;

  beforeEach(() => {
    path = tempLogPath();
    tradeLog = new TradeLog(path);
  });

  it("appends one JSONL line per fill with SPEC.md Section 7's minimum fields", () => {
    tradeLog.record(
      {
        exchangeOrderId: "e1",
        tradeId: "t1",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.01,
        timestamp: 1_700_000_000_000,
      },
      { isReduceOnly: false, clientOrderId: "c1", source: "placement" },
    );

    const entries = readEntries(path);
    expect(entries).toEqual([
      {
        timestamp: 1_700_000_000_000,
        market: MARKET,
        side: "buy",
        size: 0.01,
        price: 60000,
        isReduceOnly: false,
        clientOrderId: "c1",
        exchangeOrderId: "e1",
        tradeId: "t1",
        source: "placement",
      },
    ]);
  });

  it("appends multiple distinct fills as separate lines", () => {
    tradeLog.record(
      {
        exchangeOrderId: "e1",
        tradeId: "t1",
        market: MARKET,
        side: "buy",
        price: 60000,
        size: 0.01,
        timestamp: 1_700_000_000_000,
      },
      { isReduceOnly: false, clientOrderId: "c1", source: "placement" },
    );
    tradeLog.record(
      {
        exchangeOrderId: "e2",
        tradeId: "t2",
        market: MARKET,
        side: "sell",
        price: 60100,
        size: 0.02,
        timestamp: 1_700_000_001_000,
      },
      { isReduceOnly: true, clientOrderId: "c2", source: "reconciliation" },
    );

    expect(readEntries(path)).toHaveLength(2);
  });

  it("dedups by tradeId — the same fill recorded twice (e.g. a retried getOrderFills call) is logged once", () => {
    const fill = {
      exchangeOrderId: "e1",
      tradeId: "t1",
      market: MARKET,
      side: "buy" as const,
      price: 60000,
      size: 0.01,
      timestamp: 1_700_000_000_000,
    };
    tradeLog.record(fill, {
      isReduceOnly: false,
      clientOrderId: "c1",
      source: "cancel_race_check",
    });
    tradeLog.record(fill, {
      isReduceOnly: false,
      clientOrderId: "c1",
      source: "cancel_race_check",
    });

    expect(readEntries(path)).toHaveLength(1);
  });

  it("dedups fills without a tradeId by exchangeOrderId/timestamp/price/size", () => {
    const fill = {
      exchangeOrderId: "e1",
      market: MARKET,
      side: "buy" as const,
      price: 60000,
      size: 0.01,
      timestamp: 1_700_000_000_000,
    };
    tradeLog.record(fill, { isReduceOnly: false, clientOrderId: "c1", source: "placement" });
    tradeLog.record(fill, { isReduceOnly: false, clientOrderId: "c1", source: "placement" });

    expect(readEntries(path)).toHaveLength(1);
  });

  it("does not throw when the write itself fails — a logging failure must never block trading", () => {
    const unwritable = new TradeLog("/dev/null/not-a-real-path/trades.jsonl");
    expect(() =>
      unwritable.record(
        {
          exchangeOrderId: "e1",
          market: MARKET,
          side: "buy",
          price: 60000,
          size: 0.01,
          timestamp: Date.now(),
        },
        { isReduceOnly: false, clientOrderId: "c1", source: "placement" },
      ),
    ).not.toThrow();
  });
});
