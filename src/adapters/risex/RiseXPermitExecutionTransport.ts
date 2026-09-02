import { ExchangeAdapterError } from "../AdapterError.js";
import type { CancelOrderResult, PlaceOrderParams, PlaceOrderResult } from "../ExchangeAdapter.js";
import type { RiseXMarketDataSource } from "./RiseXMarketDataSource.js";
import { RiseXMarketRegistry, type ConfiguredRiseXMarket } from "./marketRegistry.js";
import { fromSteps, fromTicks, orderSideToRiseXSide, orderTypeToRiseXFields, toSteps, toTicks, wadToNumber } from "./riseXAuthMappers.js";
import type { RiseXOrderCancelResponseRaw, RiseXOrderPlaceRequestRaw, RiseXOrderPlaceResponseRaw } from "./authTypes.js";
import type { RiseXPermitContext, RiseXPermitSigner } from "./RiseXPermitSigner.js";

interface Envelope<T> { data: T }
interface NonceStateRaw { nonce_anchor: string; current_bitmap_index: number }
interface DomainRaw { name: string; version: string; chain_id: string | number; verifying_contract: string }
interface SystemConfigRaw { router?: string; contracts?: { router?: string }; universal_router?: string }
interface DecodeRaw { tx_hash: string; success: boolean; error?: { name?: string; message?: string } }

export interface RiseXPermitExecutionConfig {
  baseUrl: string;
  account: string;
  markets: ConfiguredRiseXMarket[];
  timeoutMs?: number;
  permitDeadlineSeconds?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Dormant session-signer execution boundary. It intentionally owns no wallet key and performs no
 * automatic retries. Every action obtains fresh bitmap nonce evidence while holding one local
 * execution lock, and every cancellation requires a resting-order id learned from authoritative
 * exchange state.
 */
export class RiseXPermitExecutionTransport {
  private readonly registry: RiseXMarketRegistry;
  private readonly timeoutMs: number;
  private readonly permitDeadlineSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private domain?: DomainRaw;
  private router?: string;
  private connected = false;
  private executionTail: Promise<void> = Promise.resolve();
  private readonly restingOrderIds = new Map<string, bigint>();

  constructor(
    private readonly marketData: RiseXMarketDataSource,
    private readonly signer: RiseXPermitSigner,
    private readonly config: RiseXPermitExecutionConfig,
  ) {
    this.registry = new RiseXMarketRegistry(config.markets);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.permitDeadlineSeconds = config.permitDeadlineSeconds ?? 120;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async connect(): Promise<void> {
    this.registry.resolve(await this.marketData.getMarkets());
    const [domain, system] = await Promise.all([
      this.request<DomainRaw>("GET", "/v1/auth/eip712-domain"),
      this.request<SystemConfigRaw>("GET", "/v1/system/config"),
    ]);
    const router = system.router ?? system.contracts?.router ?? system.universal_router;
    if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router))
      throw new ExchangeAdapterError("RISEx system config did not provide a valid router address");
    this.domain = domain;
    this.router = router;
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.domain = undefined;
    this.router = undefined;
    this.restingOrderIds.clear();
  }

  /** Replace—not merge—the exact cancellation identities from the latest authoritative snapshot. */
  seedOpenOrderIdentities(rows: readonly { exchangeOrderId: string; restingOrderId: string }[]): void {
    const next = new Map<string, bigint>();
    for (const row of rows) {
      if (!/^\d+$/.test(row.restingOrderId))
        throw new ExchangeAdapterError(`RISEx resting order id for ${row.exchangeOrderId} is invalid`);
      next.set(row.exchangeOrderId, BigInt(row.restingOrderId));
    }
    this.restingOrderIds.clear();
    for (const [key, value] of next) this.restingOrderIds.set(key, value);
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    return this.serialized(async () => {
      this.assertConnected();
      const marketId = this.registry.marketIdFor(params.market);
      const step = this.registry.stepConfigFor(params.market);
      const priceTicks = toTicks(params.price, step.stepPrice);
      const sizeSteps = toSteps(params.size, step.stepSize);
      const fields = orderTypeToRiseXFields(params.type);
      const clientOrderId = params.clientOrderId ?? "0";
      if (!/^\d+$/.test(clientOrderId))
        return { success: false, reason: "REJECTED", message: "RISEx clientOrderId must be uint64 decimal" };
      const action = {
        marketId, sizeSteps, priceTicks, side: orderSideToRiseXSide(params.side),
        postOnly: fields.post_only, reduceOnly: params.isReduceOnly, stpMode: 0,
        orderType: fields.order_type, timeInForce: fields.time_in_force, builderId: 0,
        clientOrderId: BigInt(clientOrderId), ttlUnits: 0, builderFeeBps: 0,
      };
      const permit = await this.signer.signPlace(await this.permitContext(), action);
      const body: RiseXOrderPlaceRequestRaw = {
        market_id: marketId, size_steps: sizeSteps, price_ticks: priceTicks,
        side: action.side, post_only: action.postOnly, reduce_only: action.reduceOnly,
        stp_mode: 0, order_type: action.orderType, time_in_force: action.timeInForce,
        builder_id: 0, client_order_id: clientOrderId, ttl_units: 0,
        builder_fee_bps: 0, permit,
      };
      let placed: RiseXOrderPlaceResponseRaw;
      try {
        placed = await this.request("POST", "/v1/orders/place", body);
      } catch (error) {
        return { success: false, reason: "UNRESOLVED_NOT_CONFIRMED", message: String(error), raw: error };
      }
      let decoded: DecodeRaw;
      try {
        decoded = await this.request("GET", `/v1/tx/${placed.tx_hash}`);
      } catch (error) {
        return { success: false, reason: "UNRESOLVED_NOT_CONFIRMED", message: `RISEx placement ${placed.tx_hash} could not be confirmed`, raw: error };
      }
      if (!decoded.success)
        return { success: false, reason: "REJECTED", message: `${decoded.error?.name ?? "transaction reverted"}: ${decoded.error?.message ?? ""}`.trim(), raw: decoded };
      const filledSize = wadToNumber(placed.filled_quantity);
      const size = fromSteps(sizeSteps, step.stepSize);
      return {
        success: true,
        order: {
          exchangeOrderId: placed.order_id, clientOrderId: clientOrderId === "0" ? undefined : clientOrderId,
          market: params.market, side: params.side, type: params.type,
          price: fromTicks(priceTicks, step.stepPrice), size, filledSize,
          remainingSize: Math.max(0, size - filledSize), isReduceOnly: params.isReduceOnly,
          state: filledSize >= size ? "filled" : "open",
        },
        fills: [],
      };
    });
  }

  async cancelOrder(exchangeOrderId: string, market: string): Promise<CancelOrderResult> {
    return this.serialized(async () => {
      this.assertConnected();
      const restingOrderId = this.restingOrderIds.get(exchangeOrderId);
      if (restingOrderId === undefined)
        throw new ExchangeAdapterError(`RISEx exact cancellation identity is unavailable for ${exchangeOrderId}`);
      const marketId = this.registry.marketIdFor(market);
      const permit = await this.signer.signCancel(await this.permitContext(), { marketId, restingOrderId });
      let cancelled: RiseXOrderCancelResponseRaw;
      try {
        cancelled = await this.request("POST", "/v1/orders/cancel", { market_id: marketId, order_id: exchangeOrderId, permit });
      } catch (error) {
        throw new ExchangeAdapterError(`RISEx cancellation outcome is ambiguous for ${exchangeOrderId}`, error, false);
      }
      if (cancelled.success) this.restingOrderIds.delete(exchangeOrderId);
      return { success: cancelled.success, exchangeOrderId };
    });
  }

  private assertConnected(): void {
    if (!this.connected || !this.domain || !this.router)
      throw new ExchangeAdapterError("RISEx permit execution transport is not connected");
  }

  private async permitContext(): Promise<RiseXPermitContext> {
    this.assertConnected();
    const raw = await this.request<NonceStateRaw>("GET", `/v1/nonce-state/${this.config.account}`);
    let anchor = BigInt(raw.nonce_anchor);
    let bitmap = raw.current_bitmap_index;
    if (bitmap === 208) { anchor += 1n; bitmap = 0; }
    if (!Number.isSafeInteger(bitmap) || bitmap < 0 || bitmap > 207)
      throw new ExchangeAdapterError("RISEx returned an invalid bitmap nonce");
    return {
      domain: {
        name: this.domain!.name,
        version: this.domain!.version,
        chainId: this.domain!.chain_id,
        verifyingContract: this.domain!.verifying_contract,
      },
      account: this.config.account, router: this.router!,
      nonce: { nonceAnchor: anchor, nonceBitmapIndex: bitmap },
      deadline: Math.floor(Date.now() / 1000) + this.permitDeadlineSeconds,
    };
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.executionTail;
    let release!: () => void;
    this.executionTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try { return await operation(); } finally { release(); }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.config.baseUrl), {
        method, headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) throw new ExchangeAdapterError(`RISEx returned HTTP ${response.status} for ${method} ${path}`);
      const parsed = await response.json() as T | Envelope<T>;
      return parsed && typeof parsed === "object" && "data" in parsed ? (parsed as Envelope<T>).data : parsed as T;
    } catch (error) {
      if (error instanceof ExchangeAdapterError) throw error;
      throw new ExchangeAdapterError(`RISEx request failed for ${method} ${path}: ${String(error)}`, error, true);
    } finally { clearTimeout(timer); }
  }
}
