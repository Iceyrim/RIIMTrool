import type {
  CanaryExecutionResult,
  PerplCanaryExecutor as ControllerExecutor,
} from "../../../engine/PerplMainnetCanaryController.js";
import {
  PERPL_EXECUTION_PROTOCOL_VERSION,
  parseExecutionOutcome,
  validateExecutionIntent,
  type PerplExecutionIntent,
  type PerplExecutionOutcome,
} from "./executionProtocol.js";
import {
  PERPL_MAINNET_ACCOUNT_ID,
  PERPL_MAINNET_CHAIN_ID,
  PERPL_MAINNET_EXCHANGE,
} from "./protocol.js";

export interface PerplExecutionTransport {
  request(intent: PerplExecutionIntent): Promise<unknown>;
}

/** Unwired transport adapter: no production code constructs this class. */
export class PerplCanaryExecutor implements ControllerExecutor {
  private nextId = 1;
  private readonly placementActions = new Map<string, string>();

  constructor(private readonly transport: PerplExecutionTransport) {}

  async place(input: Parameters<ControllerExecutor["place"]>[0]): Promise<CanaryExecutionResult> {
    const id = this.id();
    const perpetualId = this.perpetualId(input.market);
    const intent: PerplExecutionIntent = {
      version: PERPL_EXECUTION_PROTOCOL_VERSION,
      id,
      action: "place",
      chainId: PERPL_MAINNET_CHAIN_ID,
      exchange: PERPL_MAINNET_EXCHANGE,
      accountId: PERPL_MAINNET_ACCOUNT_ID,
      market: input.market as "BTCUSD" | "ETHUSD",
      perpetualId,
      actionId: input.clientActionId,
      side: input.side,
      orderType: input.immediateOrCancel ? "immediateOrCancel" : "postOnly",
      price: String(input.price),
      size: String(input.size),
      reduceOnly: input.reduceOnly,
      leverage: String(input.leverage ?? 1),
    };
    const outcome = await this.send(intent);
    if (outcome.event === "confirmed") this.placementActions.set(outcome.exchangeOrderId, input.clientActionId);
    return this.map(outcome);
  }

  async cancel(input: Parameters<ControllerExecutor["cancel"]>[0]): Promise<CanaryExecutionResult> {
    const placementActionId = this.placementActions.get(input.exchangeOrderId);
    if (!placementActionId) return { state: "ambiguous", reason: "placement identity is unavailable" };
    const id = this.id();
    const intent: PerplExecutionIntent = {
      version: 1,
      id,
      action: "cancel",
      chainId: 143,
      exchange: PERPL_MAINNET_EXCHANGE,
      accountId: 5198,
      market: input.market as "BTCUSD" | "ETHUSD",
      perpetualId: this.perpetualId(input.market),
      actionId: input.clientActionId,
      exchangeOrderId: input.exchangeOrderId,
      placementActionId,
    };
    return this.map(await this.send(intent));
  }

  private async send(intent: PerplExecutionIntent): Promise<PerplExecutionOutcome> {
    validateExecutionIntent(intent);
    return parseExecutionOutcome(await this.transport.request(intent), {
      id: intent.id,
      actionId: intent.actionId,
    });
  }

  private map(outcome: PerplExecutionOutcome): CanaryExecutionResult {
    return outcome.event === "confirmed"
      ? { state: "confirmed", exchangeOrderId: outcome.exchangeOrderId }
      : { state: outcome.event, reason: outcome.reason };
  }

  private perpetualId(market: string): 1 | 20 {
    if (market === "BTCUSD") return 1;
    if (market === "ETHUSD") return 20;
    throw new Error(`Unlisted Perpl canary market ${market}`);
  }

  private id(): string { return `perpl-exec-${this.nextId++}`; }
}
