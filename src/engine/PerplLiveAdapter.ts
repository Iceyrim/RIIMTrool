import { randomBytes } from "node:crypto";
import type {
  AccountVolume, CancelOrderResult, ExchangeAdapter, MarketPrice, NormalizedBalance,
  NormalizedFill, NormalizedMarginStatus, NormalizedOrder, NormalizedPosition,
  PlaceOrderParams, PlaceOrderResult,
} from "../adapters/ExchangeAdapter.js";
import type { PerplCanaryExecutor } from "../adapters/perpl/onchain/PerplCanaryExecutor.js";
import { quantizePerplLimitPrice } from "../adapters/perpl/PerplApiExecutionTransport.js";
import type { PerplApiLiveOrderSource } from "../adapters/perpl/PerplApiExecutionTransport.js";
import type { PerplOnchainAdapter, PerplPositionSafetyEvidence } from "../adapters/perpl/onchain/PerplOnchainAdapter.js";
import type { BridgeAccountEvidence } from "../adapters/perpl/onchain/protocol.js";
import type { PerplEquityEvidence } from "./PerplSessionEquityGuard.js";

function numericActionId(): string {
  const bytes = randomBytes(8);
  bytes[0] = bytes[0]! & 0x7f;
  const value = bytes.readBigUInt64BE();
  return value === 0n ? "1" : value.toString(10);
}

/** Live mutation facade: reads remain signer-free; writes cross the isolated operator socket. */
export class PerplLiveAdapter implements ExchangeAdapter {
  readonly exchangeId = "perpl-onchain-mainnet-live";

  constructor(
    private readonly readonlyAdapter: PerplOnchainAdapter,
    private readonly executor: PerplCanaryExecutor,
    private readonly onAmbiguous: (reason: string) => void = () => undefined,
    private readonly alreadyConnected = false,
    private readonly leverageByMarket: Readonly<Record<string, number>> = {},
    private readonly liveOrderSource?: PerplApiLiveOrderSource,
  ) {}

  connect(): Promise<void> { return this.alreadyConnected ? Promise.resolve() : this.readonlyAdapter.connect(); }
  disconnect(): Promise<void> { return this.readonlyAdapter.disconnect(); }
  async refreshAccountState(): Promise<void> {
    await this.liveOrderSource?.connect();
    const before = this.readonlyAdapter.getSessionEquityEvidence().blockNumber;
    await this.readonlyAdapter.refreshAccountState();
    await this.readonlyAdapter.waitForSnapshotAfter(before);
    if (this.liveOrderSource) {
      const onchainBlock = Number(this.readonlyAdapter.getSessionEquityEvidence().blockNumber);
      for (const market of ["BTCUSD", "ETHUSD"]) {
        const live = this.liveOrderSource.getPositionEvidence(market);
        if (live.blockNumber === undefined || onchainBlock < live.blockNumber) continue;
        const liveSize = live.position?.baseSize ?? 0;
        const onchainSize = this.readonlyAdapter.getPositions(market)[0]?.baseSize ?? 0;
        const tolerance = market === "BTCUSD" ? 0.00001 : 0.001;
        if (Math.abs(liveSize - onchainSize) >= tolerance) {
          const reason = `Perpl ${market} One-Click position ${liveSize} disagrees with caught-up on-chain position ${onchainSize}`;
          this.onAmbiguous(reason);
          throw new Error(reason);
        }
      }
    }
  }
  getPositions(market?: string): NormalizedPosition[] {
    if (!this.liveOrderSource) return this.readonlyAdapter.getPositions(market);
    const live = this.liveOrderSource.getPositions(market);
    return live.map((position) => {
      const onchain = this.readonlyAdapter.getPositions(position.market)[0];
      return {
        ...position,
        markPrice: onchain?.markPrice ?? position.markPrice,
        unrealizedPnl: onchain?.unrealizedPnl ?? position.unrealizedPnl,
        openOrderCount: this.liveOrderSource!.getOpenOrders(position.market).length,
      };
    });
  }
  getOpenOrders(market?: string): NormalizedOrder[] {
    return this.liveOrderSource?.getOpenOrders(market) ?? this.readonlyAdapter.getOpenOrders(market);
  }
  getBalances(): NormalizedBalance[] { return this.readonlyAdapter.getBalances(); }

  getMarginStatus(): NormalizedMarginStatus {
    const a = this.getAccountEvidence();
    const accountValue = Number(a.balance) + Number(a.positionDeposit) + Number(a.unrealizedPnl);
    const maintenance = Number(a.maintenanceRequirement);
    const locked = Number(a.lockedBalance);
    if (![accountValue, maintenance, locked].every(Number.isFinite) || accountValue <= 0) {
      return { accountValue, maintenanceMarginFraction: 1, initialMarginFraction: 1, isAtBankruptcyRisk: true };
    }
    return {
      accountValue,
      maintenanceMarginFraction: maintenance / accountValue,
      initialMarginFraction: locked / accountValue,
      isAtBankruptcyRisk: a.frozen || accountValue <= maintenance,
    };
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    if (
      params.type !== "postOnly" &&
      !(params.type === "immediateOrCancel" && params.isReduceOnly)
    ) return { success: false, reason: "REJECTED", message: "Perpl Live permits post-only quotes and reduce-only IOC exits only" };
    const actionId = params.clientOrderId ?? numericActionId();
    const leverage = this.leverageByMarket[params.market] ?? 1;
    const priceDecimals = params.market === "BTCUSD" ? 1 : params.market === "ETHUSD" ? 2 : undefined;
    if (priceDecimals === undefined) return { success: false, reason: "REJECTED", message: `Unsupported Perpl market ${params.market}` };
    const book = this.readonlyAdapter.getBookEvidence(params.market);
    const boundedPrice = params.type === "postOnly"
      ? params.side === "buy" ? Math.min(params.price, book.bestBid) : Math.max(params.price, book.bestAsk)
      : params.price;
    const executionPrice = quantizePerplLimitPrice(boundedPrice, priceDecimals, params.side);
    if (!Number.isSafeInteger(leverage) || leverage <= 0) return { success: false, reason: "REJECTED", message: `Perpl leverage is invalid for ${params.market}` };
    const result = await this.executor.place({ market: params.market, side: params.side, price: executionPrice, size: params.size, postOnly: params.type === "postOnly", immediateOrCancel: params.type === "immediateOrCancel", reduceOnly: params.isReduceOnly, clientActionId: actionId, leverage });
    if (result.state !== "confirmed") {
      if (result.state === "ambiguous") this.onAmbiguous(result.reason);
      return { success: false, reason: result.state === "ambiguous" ? "UNRESOLVED_NOT_CONFIRMED" : "REJECTED", message: result.reason };
    }
    const immediate = params.type === "immediateOrCancel";
    return { success: true, order: { exchangeOrderId: result.exchangeOrderId, clientOrderId: actionId, market: params.market, side: params.side, type: params.type, price: executionPrice, size: params.size, filledSize: immediate ? params.size : 0, remainingSize: immediate ? 0 : params.size, isReduceOnly: params.isReduceOnly, state: immediate ? "filled" : "open" }, fills: [] };
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    const result = await this.executor.cancel({ market, exchangeOrderId, clientActionId: numericActionId() });
    if (result.state === "ambiguous") this.onAmbiguous(result.reason);
    return { success: result.state === "confirmed", exchangeOrderId };
  }

  getOrderFills(id: string, market: string): Promise<NormalizedFill[]> {
    return this.liveOrderSource?.getOrderFills(id, market) ?? this.readonlyAdapter.getOrderFills(id, market);
  }
  getMarketPrice(market: string): Promise<MarketPrice> { return this.readonlyAdapter.getMarketPrice(market); }
  getAccountVolume(params: { market?: string; since: string; until: string }): Promise<AccountVolume[]> {
    return this.liveOrderSource?.getAccountVolume(params) ?? this.readonlyAdapter.getAccountVolume(params);
  }
  getAccountEvidence(): BridgeAccountEvidence { return this.readonlyAdapter.getAccountEvidence(); }
  getSessionEquityEvidence(): PerplEquityEvidence { return this.readonlyAdapter.getSessionEquityEvidence(); }
  getPositionSafetyEvidence(market?: string): PerplPositionSafetyEvidence[] { return this.readonlyAdapter.getPositionSafetyEvidence(market); }
  getBookEvidence(market: string): { bestBid: number; bestAsk: number } { return this.readonlyAdapter.getBookEvidence(market); }
  getFillCoverageStartBlock(): string { return this.readonlyAdapter.getFillCoverageStartBlock(); }
}
