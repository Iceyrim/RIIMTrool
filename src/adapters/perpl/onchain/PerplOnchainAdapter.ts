import { ExchangeAdapterError } from "../../AdapterError.js";
import type {
  AccountVolume,
  CancelOrderResult,
  ExchangeAdapter,
  MarketPrice,
  NormalizedBalance,
  NormalizedFill,
  NormalizedMarginStatus,
  NormalizedOrder,
  NormalizedPosition,
  PlaceOrderParams,
  PlaceOrderResult,
} from "../../ExchangeAdapter.js";
import { mapBridgeFill, mapBridgeOrder, mapBridgePosition, validateSnapshot } from "./mappers.js";
import type { PerplBridgeTransport } from "./PerplRustClient.js";
import type { PerplEquityEvidence } from "../../../engine/PerplSessionEquityGuard.js";
import {
  PERPL_BRIDGE_PROTOCOL_VERSION,
  PERPL_MAINNET_ACCOUNT_ID,
  PERPL_MAINNET_RPC,
  resolvePerplMainnetRpc,
  type BridgeSnapshot,
  type BridgeAccountEvidence,
} from "./protocol.js";

export interface PerplOnchainAdapterConfig {
  rpcUrl: string;
  markets: Array<{ symbol: string; perpetualId: number }>;
  accountIds?: number[];
  staleAfterMs?: number;
}

export interface PerplPositionSafetyEvidence {
  market: string;
  baseSize: number;
  markPrice: number;
  deposit: number;
  maintenanceRequirement: number;
  liquidationPrice: number;
  bankruptcyPrice: number;
}

/** Public mainnet account state only; signing and mutations are impossible. */
export class PerplOnchainAdapter implements ExchangeAdapter {
  readonly exchangeId = "perpl-onchain-mainnet-readonly";
  private snapshot?: BridgeSnapshot;
  private block?: bigint;
  private connected = false;
  private nextId = 1;
  private readonly snapshotWaiters = new Set<{
    after: bigint;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly bridge: PerplBridgeTransport,
    private readonly config: PerplOnchainAdapterConfig,
    private readonly now = Date.now,
  ) {
    const [accountId] = config.accountIds ?? [];
    if (config.rpcUrl !== PERPL_MAINNET_RPC && !config.rpcUrl.startsWith("http://127.0.0.1/")) {
      try {
        resolvePerplMainnetRpc(config.rpcUrl);
      } catch {
        throw new ExchangeAdapterError("Perpl adapter accepts only the approved mainnet RPC");
      }
    }
    if (
      !config.markets.length ||
      config.markets.some(
        (market) =>
          !(
            (market.symbol === "BTCUSD" && market.perpetualId === 1) ||
            (market.symbol === "ETHUSD" && market.perpetualId === 20)
          ),
      )
    )
      throw new ExchangeAdapterError("Perpl adapter requires proven mainnet BTC/ETH mappings");
    if (config.accountIds?.length !== 1 || accountId !== PERPL_MAINNET_ACCOUNT_ID)
      throw new ExchangeAdapterError("Perpl adapter requires the pinned mainnet account id");
    bridge.onEvent?.((message) => {
      if (message.event === "state") this.acceptSnapshot(message.snapshot);
    });
  }

  async connect(): Promise<void> {
    const response = await this.bridge.request({
      version: PERPL_BRIDGE_PROTOCOL_VERSION,
      id: this.id(),
      command: "hello",
      network: "mainnet",
      rpcUrl: this.config.rpcUrl,
      markets: this.config.markets,
      accountIds: this.config.accountIds ?? [],
    });
    if (response.event !== "ready")
      throw new ExchangeAdapterError("Perpl bridge did not return a ready snapshot");
    this.acceptSnapshot(response.snapshot);
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.snapshot = undefined;
    for (const waiter of this.snapshotWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new ExchangeAdapterError("Perpl adapter disconnected while awaiting fresh state"));
    }
    this.snapshotWaiters.clear();
    await this.bridge.close();
  }
  async refreshAccountState(): Promise<void> {
    this.requireSnapshot();
  }

  /** Waits for exchange state from a strictly newer block. Used after live mutations so cleanup
   * can never treat a pre-transaction cached snapshot as proof that an order is gone. */
  waitForSnapshotAfter(blockNumber: string, timeoutMs = 15_000): Promise<void> {
    if (!/^\d+$/.test(blockNumber) || timeoutMs < 100 || timeoutMs > 60_000)
      return Promise.reject(new ExchangeAdapterError("Perpl fresh-snapshot request is invalid"));
    const after = BigInt(blockNumber);
    if ((this.block ?? 0n) > after) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        after,
        resolve: () => {
          clearTimeout(waiter.timer);
          this.snapshotWaiters.delete(waiter);
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          this.snapshotWaiters.delete(waiter);
          reject(new ExchangeAdapterError("Timed out awaiting a newer Perpl on-chain snapshot"));
        }, timeoutMs),
      };
      this.snapshotWaiters.add(waiter);
    });
  }
  getPositions(market?: string): NormalizedPosition[] {
    return this.requireSnapshot()
      .positions.map(mapBridgePosition)
      .filter((item) => !market || item.market === market);
  }
  getOpenOrders(market?: string): NormalizedOrder[] {
    return this.requireSnapshot()
      .orders.map(mapBridgeOrder)
      .filter((item) => !market || item.market === market);
  }
  getBalances(): NormalizedBalance[] {
    return [{ token: "AUSD", amount: Number(this.requireSnapshot().account.balance) }];
  }
  getAccountEvidence(): BridgeAccountEvidence {
    return this.requireSnapshot().account;
  }
  getSessionEquityEvidence(): PerplEquityEvidence {
    const snapshot = this.requireSnapshot();
    return {
      balance: snapshot.account.balance,
      lockedBalance: snapshot.account.lockedBalance,
      positionDeposit: snapshot.account.positionDeposit,
      unrealizedPnl: snapshot.account.unrealizedPnl,
      frozen: snapshot.account.frozen,
      blockNumber: snapshot.blockNumber,
      observedAt: snapshot.receivedAt,
    };
  }
  getFillCoverageStartBlock(): string {
    return this.requireSnapshot().fillCoverageStartBlock;
  }
  getBookEvidence(market: string): { bestBid: number; bestAsk: number } {
    const book = this.requireSnapshot().books.find((item) => item.symbol === market);
    const bestBid = Number(book?.bestBid?.price);
    const bestAsk = Number(book?.bestAsk?.price);
    if (
      !Number.isFinite(bestBid) ||
      !Number.isFinite(bestAsk) ||
      bestBid <= 0 ||
      bestAsk <= bestBid
    ) {
      throw new ExchangeAdapterError(`Perpl ${market} book evidence is unavailable or crossed`);
    }
    return { bestBid, bestAsk };
  }
  getPositionSafetyEvidence(market?: string): PerplPositionSafetyEvidence[] {
    return this.requireSnapshot()
      .positions.filter((position) => !market || position.symbol === market)
      .map((position) => ({
        market: position.symbol,
        baseSize: Number(position.baseSize),
        markPrice: Number(position.markPrice),
        deposit: Number(position.deposit),
        maintenanceRequirement: Number(position.maintenanceRequirement),
        liquidationPrice: Number(position.liquidationPrice),
        bankruptcyPrice: Number(position.bankruptcyPrice),
      }));
  }
  getMarginStatus(): NormalizedMarginStatus {
    throw new ExchangeAdapterError(
      "Phase-1 Perpl bridge does not expose authoritative margin status",
    );
  }
  async placeOrder(_params: PlaceOrderParams): Promise<PlaceOrderResult> {
    return {
      success: false,
      reason: "REJECTED",
      message:
        "Phase-1 Perpl on-chain adapter is read-only; use prepareExecOrders() for calldata preview",
    };
  }
  async cancelOrder(exchangeOrderId: string, _market: string): Promise<CancelOrderResult> {
    return { success: false, exchangeOrderId };
  }
  async getOrderFills(exchangeOrderId: string, market: string): Promise<NormalizedFill[]> {
    const fills = this.requireSnapshot()
      .fills.map(mapBridgeFill)
      .filter((fill) => fill.exchangeOrderId === exchangeOrderId && fill.market === market);
    if (!fills.length)
      throw new ExchangeAdapterError(
        "No maker fill was observed for this order since bridge startup; historical absence is not authoritative",
      );
    return fills;
  }
  async getMarketPrice(market: string): Promise<MarketPrice> {
    const position = this.getPositions(market)[0];
    if (!position) throw new ExchangeAdapterError(`Perpl snapshot has no mark for ${market}`);
    return { market, mark: position.markPrice };
  }
  async getAccountVolume(_params: {
    market?: string;
    since: string;
    until: string;
  }): Promise<AccountVolume[]> {
    throw new ExchangeAdapterError(
      "Phase-1 Perpl bridge does not expose authoritative account volume",
    );
  }

  async prepareExecOrders(
    _orders: import("./protocol.js").BridgePrepareOrder[],
  ): Promise<{ blockNumber: string; calldata: string; calldataHash: string }> {
    throw new ExchangeAdapterError("Mainnet read-only adapter cannot prepare transaction calldata");
  }

  private acceptSnapshot(snapshot: BridgeSnapshot): void {
    if (snapshot.accountId !== this.config.accountIds![0])
      throw new ExchangeAdapterError("Perpl bridge snapshot account does not match configuration");
    this.block = validateSnapshot(snapshot, this.block);
    this.snapshot = snapshot;
    for (const waiter of this.snapshotWaiters) {
      if (this.block > waiter.after) waiter.resolve();
    }
  }
  private requireSnapshot(): BridgeSnapshot {
    if (!this.connected && !this.snapshot)
      throw new ExchangeAdapterError("Perpl on-chain adapter is disconnected");
    const snapshot = this.snapshot!;
    validateSnapshot(snapshot, this.block);
    if (this.now() - snapshot.receivedAt > (this.config.staleAfterMs ?? 10_000))
      throw new ExchangeAdapterError("Perpl on-chain snapshot is stale");
    return snapshot;
  }
  private id(): string {
    return `riim-${this.nextId++}`;
  }
}
