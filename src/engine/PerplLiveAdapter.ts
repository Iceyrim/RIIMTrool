import { randomBytes } from "node:crypto";
import type {
  AccountVolume, CancelOrderResult, ExchangeAdapter, MarketPrice, NormalizedBalance,
  NormalizedFill, NormalizedMarginStatus, NormalizedOrder, NormalizedPosition,
  PlaceOrderParams, PlaceOrderResult,
} from "../adapters/ExchangeAdapter.js";
import type { PerplCanaryExecutor } from "../adapters/perpl/onchain/PerplCanaryExecutor.js";
import { quantizePerplLimitPrice } from "../adapters/perpl/PerplApiExecutionTransport.js";
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
  ) {}

  connect(): Promise<void> { return this.alreadyConnected ? Promise.resolve() : this.readonlyAdapter.connect(); }
  disconnect(): Promise<void> { return this.readonlyAdapter.disconnect(); }
  refreshAccountState(): Promise<void> { return this.readonlyAdapter.refreshAccountState(); }
  getPositions(market?: string): NormalizedPosition[] { return this.readonlyAdapter.getPositions(market); }
  getOpenOrders(market?: string): NormalizedOrder[] { return this.readonlyAdapter.getOpenOrders(market); }
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
    if (params.type !== "postOnly") return { success: false, reason: "REJECTED", message: "Perpl Live permits post-only orders only" };
    const actionId = params.clientOrderId ?? numericActionId();
    const leverage = this.leverageByMarket[params.market] ?? 1;
    const priceDecimals = params.market === "BTCUSD" ? 1 : params.market === "ETHUSD" ? 2 : undefined;
    if (priceDecimals === undefined) return { success: false, reason: "REJECTED", message: `Unsupported Perpl market ${params.market}` };
    const executionPrice = quantizePerplLimitPrice(params.price, priceDecimals, params.side);
    if (!Number.isSafeInteger(leverage) || leverage <= 0) return { success: false, reason: "REJECTED", message: `Perpl leverage is invalid for ${params.market}` };
    const result = await this.executor.place({ market: params.market, side: params.side, price: executionPrice, size: params.size, postOnly: true, reduceOnly: params.isReduceOnly, clientActionId: actionId, leverage });
    if (result.state !== "confirmed") {
      if (result.state === "ambiguous") this.onAmbiguous(result.reason);
      return { success: false, reason: result.state === "ambiguous" ? "UNRESOLVED_NOT_CONFIRMED" : "REJECTED", message: result.reason };
    }
    return { success: true, order: { exchangeOrderId: result.exchangeOrderId, clientOrderId: actionId, market: params.market, side: params.side, type: "postOnly", price: executionPrice, size: params.size, filledSize: 0, remainingSize: params.size, isReduceOnly: params.isReduceOnly, state: "open" }, fills: [] };
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    const result = await this.executor.cancel({ market, exchangeOrderId, clientActionId: numericActionId() });
    if (result.state === "ambiguous") this.onAmbiguous(result.reason);
    return { success: result.state === "confirmed", exchangeOrderId };
  }

  getOrderFills(id: string, market: string): Promise<NormalizedFill[]> { return this.readonlyAdapter.getOrderFills(id, market); }
  getMarketPrice(market: string): Promise<MarketPrice> { return this.readonlyAdapter.getMarketPrice(market); }
  getAccountVolume(params: { market?: string; since: string; until: string }): Promise<AccountVolume[]> { return this.readonlyAdapter.getAccountVolume(params); }
  getAccountEvidence(): BridgeAccountEvidence { return this.readonlyAdapter.getAccountEvidence(); }
  getSessionEquityEvidence(): PerplEquityEvidence { return this.readonlyAdapter.getSessionEquityEvidence(); }
  getPositionSafetyEvidence(market?: string): PerplPositionSafetyEvidence[] { return this.readonlyAdapter.getPositionSafetyEvidence(market); }
  getBookEvidence(market: string): { bestBid: number; bestAsk: number } { return this.readonlyAdapter.getBookEvidence(market); }
  getFillCoverageStartBlock(): string { return this.readonlyAdapter.getFillCoverageStartBlock(); }
}
