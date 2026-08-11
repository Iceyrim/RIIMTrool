import { ExchangeAdapterError } from "../AdapterError.js";
import type {
  RiseXCandleRaw,
  RiseXCandlesInner,
  RiseXEnvelope,
  RiseXFundingRateHistoryRaw,
  RiseXFundingRecordRaw,
  RiseXMarketRaw,
  RiseXMarketsResponse,
  RiseXOrderbookLevelRaw,
  RiseXOrderbookRaw,
  RiseXTradeHistoryRaw,
  RiseXTradeRaw,
} from "./types.js";

/**
 * Verified live against real mainnet on 2026-08-11 (curl against every endpoint below returned
 * real BTC/USDC + ETH/USDC data). Not documented explicitly as "the mainnet REST base URL"
 * anywhere in RISEx's hosted docs — inferred from the ws.rise.trade / ws.testnet.rise.trade
 * mainnet/testnet WebSocket naming pattern and then confirmed by hitting it directly. If RISEx
 * ever changes this, RealRiseXMarketDataSource's constructor takes an override.
 */
export const RISEX_MAINNET_REST_BASE_URL = "https://api.rise.trade";

export interface RiseXMarket {
  marketId: number;
  /** e.g. "BTC/USDC" — RISEx's own symbol, not this bot's logical config symbol. Mapping between
   * the two is the future RiseXMarketRegistry's job (Phase 2/3), same division of responsibility
   * as N1's MarketRegistry. */
  symbol: string;
  displayName: string;
  markPrice: number;
  indexPrice: number;
  lastPrice: number;
  stepSize: number;
  stepPrice: number;
  minOrderSize: number;
  maxLeverage: number;
  active: boolean;
}

export interface RiseXOrderbookLevel {
  price: number;
  quantity: number;
  orderCount: number;
}

export interface RiseXOrderbook {
  marketId: number;
  bids: RiseXOrderbookLevel[];
  asks: RiseXOrderbookLevel[];
}

export interface RiseXTrade {
  /** Composite RISEx trade id, e.g. "0x...-0x...". Stable identity for dedup (TradeLog-style),
   * but NOT a sortable integer — do not use for ordering, only `timestamp`. */
  id: string;
  takerSide: "buy" | "sell";
  price: number;
  size: number;
  /** Unix ms (reduced from RISEx's native nanosecond timestamp). */
  timestamp: number;
}

export interface RiseXCandle {
  intervalLabel: string;
  timestamp: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RiseXFundingRecord {
  fundingRate: number;
  accumulatedFunding: number;
  indexPrice: number;
  startTime: number; // unix ms
  endTime: number; // unix ms
}

/**
 * The public, unauthenticated subset of RISEx's REST API (SPEC.md Section 11, build plan step 1).
 * Deliberately narrow and read-only: no auth headers, no signing, no order/account/position
 * methods exist here at all — mirrors N1MarketDataSource's structural guarantee that this class
 * cannot touch a real account even if handed credentials, because it never accepts any.
 */
export interface RiseXMarketDataSource {
  getMarkets(): Promise<RiseXMarket[]>;
  getOrderbook(marketId: number, limit?: number): Promise<RiseXOrderbook>;
  /** Trades with timestamp >= sinceMs (inclusive), oldest first, single page. Omit sinceMs to
   * fetch the most recent page — used to prime a market's trade-tape cursor on first use, same
   * calling convention as N1MarketDataSource.getRecentTrades. Unlike N1's integer tradeId
   * cursor, RISEx's trade `id` isn't sortable, so this cursors on `time` instead; callers that
   * need dedup across overlapping pages should key on `id`, not on array position. */
  getRecentTrades(marketId: number, sinceMs?: number, opts?: { page?: number; limit?: number }): Promise<RiseXTrade[]>;
  getCandles(
    marketId: number,
    params: { intervalMs: number; fromMs?: number; toMs?: number },
  ): Promise<RiseXCandle[]>;
  getFundingRateHistory(
    marketId: number,
    opts?: { sinceMs?: number; untilMs?: number; page?: number; limit?: number },
  ): Promise<RiseXFundingRecord[]>;
}

function decimal(s: string): number {
  const n = Number(s);
  if (Number.isNaN(n)) {
    throw new ExchangeAdapterError(`RISEx returned a non-numeric decimal string: "${s}"`);
  }
  return n;
}

/** RISEx timestamps are unix nanoseconds as strings (~1e18) — far past
 * Number.MAX_SAFE_INTEGER (~9e15) — so the ns->ms reduction must go through BigInt. */
function nsStringToMs(ns: string): number {
  return Number(BigInt(ns) / 1_000_000n);
}

function msToNsString(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

function mapMarket(raw: RiseXMarketRaw): RiseXMarket {
  return {
    marketId: Number(raw.market_id),
    symbol: raw.base_asset_symbol,
    displayName: raw.display_name,
    markPrice: decimal(raw.mark_price),
    indexPrice: decimal(raw.index_price),
    lastPrice: decimal(raw.last_price),
    stepSize: decimal(raw.config.step_size),
    stepPrice: decimal(raw.config.step_price),
    minOrderSize: decimal(raw.config.min_order_size),
    maxLeverage: decimal(raw.config.max_leverage),
    active: raw.active,
  };
}

function mapOrderbookLevel(raw: RiseXOrderbookLevelRaw): RiseXOrderbookLevel {
  return { price: decimal(raw.price), quantity: decimal(raw.quantity), orderCount: raw.order_count };
}

function mapTrade(raw: RiseXTradeRaw): RiseXTrade {
  // maker_side is the side of the RESTING order — like N1's TradeFromApi.takerSide, we want the
  // side of whoever crossed IN (the taker), which is the opposite side of the maker.
  const takerSide: "buy" | "sell" = raw.maker_side === "BUY" ? "sell" : "buy";
  return {
    id: raw.id,
    takerSide,
    price: decimal(raw.price),
    size: decimal(raw.size),
    timestamp: nsStringToMs(raw.time),
  };
}

function mapCandle(raw: RiseXCandleRaw): RiseXCandle {
  return {
    intervalLabel: raw.interval,
    timestamp: nsStringToMs(raw.time),
    open: decimal(raw.open),
    high: decimal(raw.high),
    low: decimal(raw.low),
    close: decimal(raw.close),
    volume: decimal(raw.volume),
  };
}

function mapFundingRecord(raw: RiseXFundingRecordRaw): RiseXFundingRecord {
  return {
    fundingRate: decimal(raw.funding_rate),
    accumulatedFunding: decimal(raw.accumulated_funding),
    indexPrice: decimal(raw.index_price),
    startTime: nsStringToMs(raw.start_time),
    endTime: nsStringToMs(raw.end_time),
  };
}

/**
 * Real implementation, backed by plain `fetch` against RISEx's public REST API. Holds only a
 * base URL string — structurally cannot hold a private key, wallet, or any auth material, even
 * if a caller tried to hand one in (same guarantee as RealN1MarketDataSource, SPEC.md
 * Section 9.1: real credentials never touch an AI coding session).
 */
export class RealRiseXMarketDataSource implements RiseXMarketDataSource {
  constructor(
    private readonly baseUrl: string = RISEX_MAINNET_REST_BASE_URL,
    private readonly timeoutMs = 10_000,
  ) {}

  private async getJson<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (err) {
      throw new ExchangeAdapterError(`RISEx request to ${url} failed: ${String(err)}`, err, true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ExchangeAdapterError(
        `RISEx returned HTTP ${response.status} for ${url}: ${body.slice(0, 500)}`,
        undefined,
        response.status >= 500,
      );
    }

    const envelope = (await response.json()) as RiseXEnvelope<T>;
    return envelope.data;
  }

  async getMarkets(): Promise<RiseXMarket[]> {
    const data = await this.getJson<RiseXMarketsResponse>("/v1/markets");
    return data.markets.map(mapMarket);
  }

  async getOrderbook(marketId: number, limit?: number): Promise<RiseXOrderbook> {
    const data = await this.getJson<RiseXOrderbookRaw>("/v1/orderbook", { market_id: marketId, limit });
    return {
      marketId: Number(data.market_id),
      bids: data.bids.map(mapOrderbookLevel),
      asks: data.asks.map(mapOrderbookLevel),
    };
  }

  async getRecentTrades(
    marketId: number,
    sinceMs?: number,
    opts?: { page?: number; limit?: number },
  ): Promise<RiseXTrade[]> {
    const data = await this.getJson<RiseXTradeHistoryRaw>(`/v1/markets/id/${marketId}/trade-history`, {
      start_time: sinceMs !== undefined ? msToNsString(sinceMs) : undefined,
      page: opts?.page,
      limit: opts?.limit,
    });
    return data.trades.map(mapTrade);
  }

  async getCandles(
    marketId: number,
    params: { intervalMs: number; fromMs?: number; toMs?: number },
  ): Promise<RiseXCandle[]> {
    const inner = await this.getJson<RiseXCandlesInner>(`/v1/markets/id/${marketId}/trading-view-data`, {
      interval: msToNsString(params.intervalMs),
      from: params.fromMs !== undefined ? msToNsString(params.fromMs) : undefined,
      to: params.toMs !== undefined ? msToNsString(params.toMs) : undefined,
    });
    return inner.data.map(mapCandle);
  }

  async getFundingRateHistory(
    marketId: number,
    opts?: { sinceMs?: number; untilMs?: number; page?: number; limit?: number },
  ): Promise<RiseXFundingRecord[]> {
    const data = await this.getJson<RiseXFundingRateHistoryRaw>(
      `/v1/markets/id/${marketId}/funding-rate-history`,
      {
        start_time: opts?.sinceMs !== undefined ? msToNsString(opts.sinceMs) : undefined,
        end_time: opts?.untilMs !== undefined ? msToNsString(opts.untilMs) : undefined,
        page: opts?.page,
        limit: opts?.limit,
      },
    );
    return data.records.map(mapFundingRecord);
  }
}
