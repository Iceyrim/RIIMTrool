import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PerplCanaryExecutor } from "../../src/adapters/perpl/onchain/PerplCanaryExecutor.js";
import type { PerplOnchainAdapter } from "../../src/adapters/perpl/onchain/PerplOnchainAdapter.js";
import { PerplEquityPnlSource } from "../../src/engine/PerplEquityPnlSource.js";
import { PerplLiveAdapter } from "../../src/engine/PerplLiveAdapter.js";
import { PerplSessionEquityGuard, type PerplEquityEvidence } from "../../src/engine/PerplSessionEquityGuard.js";

function readonly(evidence: PerplEquityEvidence) {
  return {
    connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), refreshAccountState: vi.fn(async () => undefined),
    getPositions: vi.fn(() => []), getOpenOrders: vi.fn(() => []), getBalances: vi.fn(() => [{ token: "AUSD", amount: 20 }]),
    getAccountEvidence: vi.fn(() => ({ balance: evidence.balance, lockedBalance: evidence.lockedBalance, availableBalance: evidence.balance, unrealizedPnl: evidence.unrealizedPnl, positionDeposit: evidence.positionDeposit, maintenanceRequirement: "0", frozen: evidence.frozen })),
    getSessionEquityEvidence: vi.fn(() => evidence), waitForSnapshotAfter: vi.fn(async () => undefined), getPositionSafetyEvidence: vi.fn(() => []), getBookEvidence: vi.fn(() => ({ bestBid: 99, bestAsk: 101 })), getFillCoverageStartBlock: vi.fn(() => "1"),
    getOrderFills: vi.fn(async () => []), getMarketPrice: vi.fn(async () => ({ market: "BTCUSD", mark: 100 })), getAccountVolume: vi.fn(async () => []),
  } as unknown as PerplOnchainAdapter;
}

describe("PerplLiveAdapter", () => {
  it("maps confirmed placement and exact cancellation through the isolated executor", async () => {
    const evidence: PerplEquityEvidence = { balance: "20", lockedBalance: "0", positionDeposit: "0", unrealizedPnl: "0", frozen: false, blockNumber: "1", observedAt: Date.now() };
    const executor = { place: vi.fn(async () => ({ state: "confirmed", exchangeOrderId: "42" })), cancel: vi.fn(async () => ({ state: "confirmed", exchangeOrderId: "42" })) } as unknown as PerplCanaryExecutor;
    const adapter = new PerplLiveAdapter(readonly(evidence), executor, undefined, false, { BTCUSD: 15 });
    const placed = await adapter.placeOrder({ market: "BTCUSD", side: "buy", type: "postOnly", size: 0.001, price: 100, isReduceOnly: false, clientOrderId: "123" });
    expect(placed.success && placed.order.exchangeOrderId).toBe("42");
    expect(executor.place).toHaveBeenCalledWith(expect.objectContaining({ leverage: 15 }));
    expect((await adapter.cancelOrder("42", "BTCUSD")).success).toBe(true);
  });

  it("waits for state from a newer block before reconciliation", async () => {
    const evidence: PerplEquityEvidence = { balance: "20", lockedBalance: "0", positionDeposit: "0", unrealizedPnl: "0", frozen: false, blockNumber: "100", observedAt: Date.now() };
    const source = readonly(evidence);
    await new PerplLiveAdapter(source, {} as PerplCanaryExecutor).refreshAccountState();
    expect(source.refreshAccountState).toHaveBeenCalledOnce();
    expect(source.waitForSnapshotAfter).toHaveBeenCalledWith("100");
  });

  it("uses the authenticated API stream for immediate order and fill reconciliation", async () => {
    const evidence: PerplEquityEvidence = { balance: "20", lockedBalance: "0", positionDeposit: "0", unrealizedPnl: "0", frozen: false, blockNumber: "100", observedAt: Date.now() };
    const source = readonly(evidence);
    const api = {
      connect: vi.fn(async () => undefined),
      getOpenOrders: vi.fn(() => [{ exchangeOrderId: "47", market: "ETHUSD", side: "sell" as const, price: 2455.51, size: 0.004, filledSize: 0, remainingSize: 0.004, isReduceOnly: false, state: "open" as const }]),
      getPositions: vi.fn(() => [{ market: "ETHUSD", baseSize: -0.144, markPrice: 2455.51, unrealizedPnl: 0, openOrderCount: 1 }]),
      getPositionEvidence: vi.fn(() => ({ position: { market: "ETHUSD", baseSize: -0.144, markPrice: 2455.51, unrealizedPnl: 0, openOrderCount: 1 }, blockNumber: 101 })),
      waitForPositionSettled: vi.fn(async () => undefined),
      getOrderFills: vi.fn(async () => [{ exchangeOrderId: "47", market: "ETHUSD", side: "sell" as const, price: 2455.51, size: 0.004, timestamp: 1 }]),
      getAccountVolume: vi.fn(async () => [{ market: "ETHUSD", since: "s", until: "u", baseVolume: 0.004, quoteVolume: 9.82204 }]),
    };
    const adapter = new PerplLiveAdapter(source, {} as PerplCanaryExecutor, undefined, false, {}, api);
    expect(adapter.getOpenOrders("ETHUSD")[0]?.exchangeOrderId).toBe("47");
    expect(adapter.getPositions("ETHUSD")[0]?.baseSize).toBe(-0.144);
    expect((await adapter.getOrderFills("47", "ETHUSD"))[0]?.size).toBe(0.004);
    expect((await adapter.getAccountVolume({ since: "s", until: "u" }))[0]?.quoteVolume).toBe(9.82204);
    expect(source.getOpenOrders).not.toHaveBeenCalled();
    expect(source.getAccountVolume).not.toHaveBeenCalled();
  });

  it("refreshes an expired One-Click stream before startup reconciliation", async () => {
    const evidence: PerplEquityEvidence = { balance: "20", lockedBalance: "0", positionDeposit: "0", unrealizedPnl: "0", frozen: false, blockNumber: "100", observedAt: Date.now() };
    const source = readonly(evidence);
    const api = { connect: vi.fn(async () => undefined), getOpenOrders: vi.fn(() => []), getPositions: vi.fn(() => []), getPositionEvidence: vi.fn(() => ({ blockNumber: 101 })), waitForPositionSettled: vi.fn(async () => undefined), getOrderFills: vi.fn(async () => []), getAccountVolume: vi.fn(async () => []) };
    await new PerplLiveAdapter(source, {} as PerplCanaryExecutor, undefined, false, {}, api).refreshAccountState();
    expect(api.connect).toHaveBeenCalledOnce();
  });

  it("halts when caught-up on-chain and One-Click position evidence disagree", async () => {
    const evidence: PerplEquityEvidence = { balance: "20", lockedBalance: "0", positionDeposit: "0", unrealizedPnl: "0", frozen: false, blockNumber: "101", observedAt: Date.now() };
    const source = readonly(evidence);
    const halt = vi.fn();
    const api = {
      connect: vi.fn(async () => undefined), getOpenOrders: vi.fn(() => []),
      getPositions: vi.fn(() => [{ market: "ETHUSD", baseSize: -0.144, markPrice: 2465, unrealizedPnl: 0, openOrderCount: 0 }]),
      getPositionEvidence: vi.fn((market: string) => market === "ETHUSD" ? ({ position: { market: "ETHUSD", baseSize: -0.144, markPrice: 2465, unrealizedPnl: 0, openOrderCount: 0 }, blockNumber: 100 }) : ({ blockNumber: 100 })),
      waitForPositionSettled: vi.fn(async () => undefined), getOrderFills: vi.fn(async () => []), getAccountVolume: vi.fn(async () => []),
    };
    await expect(new PerplLiveAdapter(source, {} as PerplCanaryExecutor, halt, false, {}, api).refreshAccountState()).rejects.toThrow(/disagrees/);
    expect(halt).toHaveBeenCalledOnce();
  });

  it("permanently signals an ambiguous execution outcome", async () => {
    const evidence: PerplEquityEvidence = { balance: "20", lockedBalance: "0", positionDeposit: "0", unrealizedPnl: "0", frozen: false, blockNumber: "1", observedAt: Date.now() };
    const halt = vi.fn();
    const executor = { place: vi.fn(async () => ({ state: "ambiguous", reason: "receipt unknown" })) } as unknown as PerplCanaryExecutor;
    const result = await new PerplLiveAdapter(readonly(evidence), executor, halt).placeOrder({ market: "BTCUSD", side: "buy", type: "postOnly", size: 0.001, price: 100, isReduceOnly: false });
    expect(result).toMatchObject({ success: false, reason: "UNRESOLVED_NOT_CONFIRMED" });
    expect(halt).toHaveBeenCalledWith("receipt unknown");
  });

  it("reports the same directionally tick-rounded price sent to One-Click", async () => {
    const evidence: PerplEquityEvidence = { balance: "20", lockedBalance: "0", positionDeposit: "0", unrealizedPnl: "0", frozen: false, blockNumber: "1", observedAt: Date.now() };
    const source = readonly(evidence);
    vi.mocked(source.getBookEvidence).mockReturnValue({ bestBid: 78_001, bestAsk: 78_002 });
    const executor = { place: vi.fn(async () => ({ state: "confirmed", exchangeOrderId: "42" })) } as unknown as PerplCanaryExecutor;
    const result = await new PerplLiveAdapter(source, executor, undefined, false, { BTCUSD: 15 }).placeOrder({ market: "BTCUSD", side: "buy", type: "postOnly", size: 0.00018, price: 78_000.987, isReduceOnly: false });
    expect(executor.place).toHaveBeenCalledWith(expect.objectContaining({ price: 78_000.9 }));
    expect(result.success && result.order.price).toBe(78_000.9);
  });

  it("clamps normal quotes to the passive book side and permits only reduce-only IOC exits", async () => {
    const evidence: PerplEquityEvidence = { balance: "20", lockedBalance: "0", positionDeposit: "0", unrealizedPnl: "0", frozen: false, blockNumber: "1", observedAt: Date.now() };
    const source = readonly(evidence);
    vi.mocked(source.getBookEvidence).mockReturnValue({ bestBid: 100, bestAsk: 101 });
    const executor = { place: vi.fn(async () => ({ state: "confirmed", exchangeOrderId: "api:55" })) } as unknown as PerplCanaryExecutor;
    const adapter = new PerplLiveAdapter(source, executor, undefined, false, { BTCUSD: 15 });
    await adapter.placeOrder({ market: "BTCUSD", side: "buy", type: "postOnly", size: 0.00018, price: 102, isReduceOnly: false });
    expect(executor.place).toHaveBeenLastCalledWith(expect.objectContaining({ price: 100, postOnly: true }));
    await adapter.placeOrder({ market: "BTCUSD", side: "buy", type: "immediateOrCancel", size: 0.00018, price: 102, isReduceOnly: true });
    expect(executor.place).toHaveBeenLastCalledWith(expect.objectContaining({ price: 102, postOnly: false, immediateOrCancel: true, reduceOnly: true }));
    await expect(adapter.placeOrder({ market: "BTCUSD", side: "buy", type: "immediateOrCancel", size: 0.00018, price: 102, isReduceOnly: false })).resolves.toMatchObject({ success: false });
  });

  it("turns equity declines into conservative account loss and halts at the cap", async () => {
    let evidence: PerplEquityEvidence = { balance: "20", lockedBalance: "0", positionDeposit: "0", unrealizedPnl: "0", frozen: false, blockNumber: "1", observedAt: Date.now() };
    const sourceAdapter = readonly(evidence);
    vi.mocked(sourceAdapter.getSessionEquityEvidence).mockImplementation(() => evidence);
    const adapter = new PerplLiveAdapter(sourceAdapter, {} as PerplCanaryExecutor);
    const halt = vi.fn();
    const guard = new PerplSessionEquityGuard(join("/tmp", `perpl-live-equity-${process.pid}-${Date.now()}.json`), 3);
    const source = new PerplEquityPnlSource(adapter, guard, halt);
    source.arm();
    evidence = { ...evidence, balance: "19", blockNumber: "2", observedAt: Date.now() };
    expect(await source.drainRealizedPnlDeltaUsd()).toBe(-1);
    evidence = { ...evidence, balance: "16", blockNumber: "3", observedAt: Date.now() };
    await expect(source.drainRealizedPnlDeltaUsd()).rejects.toThrow(/loss limit/);
    expect(halt).toHaveBeenCalled();
  });
});
