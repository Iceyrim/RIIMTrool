import type {
  ExchangeAdapter,
  NormalizedBalance,
  NormalizedOrder,
  OrderSide,
} from "../adapters/ExchangeAdapter.js";
import { OrderRegistry } from "./OrderRegistry.js";
import { generateQuoteLadder, pickOrderSize, type QuoteLevel } from "./QuoteLadder.js";
import { Reconciliation, type ReconciliationResult } from "./Reconciliation.js";
import { RiskManager } from "./RiskManager.js";
import { TradeLog } from "./TradeLog.js";
import type { EngineMarketConfig } from "./types.js";

export interface DryRunProposal extends QuoteLevel {
  type: "postOnly";
  reduceOnly: boolean;
  allowed: boolean;
  blockedReason?: string;
}

export interface DryRunPlan {
  market: string;
  generatedAt: number;
  reconciliation: ReconciliationResult;
  positionBaseSize: number;
  markPrice: number;
  observedOpenOrders: NormalizedOrder[];
  balances: NormalizedBalance[];
  accountEvidence?: Record<string, string | boolean>;
  fillCoverageStartBlock?: string;
  proposedCancellations: string[];
  proposals: DryRunProposal[];
  executionReady: false;
  readinessBlockers: string[];
}

export interface MarketMakingDryRunOptions {
  stateFilePath: string;
  tradeLogFilePath: string;
}

/**
 * Read-only market-making planner. It reuses production reconciliation, quote-ladder, and
 * per-order risk logic, but deliberately has no method that can place, amend, or cancel an order.
 * Missing authoritative margin, realized-PnL, and fill history remain explicit readiness blockers.
 */
export class MarketMakingDryRun {
  private readonly registry: OrderRegistry;
  private readonly reconciliation: Reconciliation;
  private readonly risk: RiskManager;
  private started = false;

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly config: EngineMarketConfig,
    options: MarketMakingDryRunOptions,
  ) {
    this.registry = new OrderRegistry(config.symbol, options.stateFilePath);
    this.reconciliation = new Reconciliation(
      adapter,
      this.registry,
      config.symbol,
      new TradeLog(options.tradeLogFilePath),
    );
    this.risk = new RiskManager(adapter);
  }

  async start(): Promise<ReconciliationResult> {
    this.registry.load();
    const result = await this.reconciliation.syncFromExchange();
    this.started = true;
    return result;
  }

  async planCycle(): Promise<DryRunPlan> {
    if (!this.started) throw new Error(`Dry-run planner for ${this.config.symbol} must be started`);
    const reconciliation = await this.reconciliation.checkAgainstExchange();
    const position = this.adapter.getPositions(this.config.symbol)[0];
    const markPrice = (await this.adapter.getMarketPrice(this.config.symbol)).mark;
    const observedOpenOrders = this.adapter.getOpenOrders(this.config.symbol);
    const evidenceAdapter = this.adapter as ExchangeAdapter & {
      getAccountEvidence?: () => Record<string, string | boolean>;
      getFillCoverageStartBlock?: () => string;
    };
    const fillCoverageStartBlock = evidenceAdapter.getFillCoverageStartBlock?.();
    const proposedCancellations =
      Math.abs(position?.baseSize ?? 0) > this.config.inventoryReductionThresholdBase
        ? this.registry
            .list()
            .filter(
              (order) =>
                !order.isReduceOnly &&
                order.exchangeOrderId !== null &&
                observedOpenOrders.some((open) => open.exchangeOrderId === order.exchangeOrderId),
            )
            .map((order) => order.exchangeOrderId as string)
        : [];
    const proposals = reconciliation.healthy
      ? this.buildProposals(position?.baseSize ?? 0, markPrice, observedOpenOrders, reconciliation)
      : [];
    return {
      market: this.config.symbol,
      generatedAt: Date.now(),
      reconciliation,
      positionBaseSize: position?.baseSize ?? 0,
      markPrice,
      observedOpenOrders,
      balances: this.adapter.getBalances(),
      accountEvidence: evidenceAdapter.getAccountEvidence?.(),
      fillCoverageStartBlock,
      proposedCancellations,
      proposals,
      executionReady: false,
      readinessBlockers: [
        "authoritative mainnet margin status is unavailable",
        "authoritative session realized PnL is unavailable",
        `fill evidence is limited to maker fills observed since bridge startup${fillCoverageStartBlock ? ` at block ${fillCoverageStartBlock}` : ""}`,
        "execution remains disabled pending a separately approved canary-gated integration",
      ],
    };
  }

  private buildProposals(
    baseSize: number,
    markPrice: number,
    openOrders: NormalizedOrder[],
    reconciliation: ReconciliationResult,
  ): DryRunProposal[] {
    if (Math.abs(baseSize) > this.config.inventoryReductionThresholdBase) {
      const side: OrderSide = baseSize > 0 ? "sell" : "buy";
      const offset = markPrice * (this.config.exitSpreadBps / 10_000);
      return [
        {
          side,
          price: baseSize > 0 ? markPrice + offset : markPrice - offset,
          size: Math.min(Math.abs(baseSize), this.config.riskLimits.maxOrderSize),
          type: "postOnly",
          reduceOnly: true,
          allowed: reconciliation.openOrderCount < this.config.riskLimits.maxOpenOrders,
          blockedReason:
            reconciliation.openOrderCount >= this.config.riskLimits.maxOpenOrders
              ? "open-order capacity exhausted"
              : undefined,
        },
      ];
    }

    let progressiveOpenOrderCount = reconciliation.openOrderCount;
    let openBuyQuantity = openOrders
      .filter((order) => order.side === "buy")
      .reduce((sum, order) => sum + order.remainingSize, 0);
    let openSellQuantity = openOrders
      .filter((order) => order.side === "sell")
      .reduce((sum, order) => sum + order.remainingSize, 0);
    const size = pickOrderSize(this.config.orderSize);
    return generateQuoteLadder({
      reservationPrice: markPrice,
      levelSpacingBps: this.config.levelSpacingBps,
      sizePerLevel: size,
    }).map((quote) => {
      const check = this.risk.canPlaceOrder({
        market: this.config.symbol,
        side: quote.side,
        size: quote.size,
        price: quote.price,
        limits: this.config.riskLimits,
        currentPosition: this.adapter.getPositions(this.config.symbol)[0],
        lastReconciliation: reconciliation,
        progressiveOpenOrderCount,
        openBuyQuantity,
        openSellQuantity,
        sessionRealizedPnlUsd: 0,
        sessionLossCapUsd: this.config.accountSessionLossCapUsd ?? 6,
      });
      if (check.allowed) {
        progressiveOpenOrderCount++;
        if (quote.side === "buy") openBuyQuantity += quote.size;
        else openSellQuantity += quote.size;
      }
      return {
        ...quote,
        type: "postOnly" as const,
        reduceOnly: false,
        allowed: check.allowed,
        blockedReason: check.reason,
      };
    });
  }
}
