/**
 * Raw RISEx REST response shapes, pinned to what `https://api.rise.trade` actually returns —
 * verified against live mainnet responses during Phase 1 development, not the (partially
 * inaccurate) hosted API docs. Deliberately kept separate from the normalized types this adapter
 * hands out (see RiseXMarketDataSource.ts), same reasoning as N1's mappers.ts doc comment: mixing
 * "what the exchange literally sends" with "what we normalize it to" is how a doc/reality drift
 * turns into a silent mapping bug.
 *
 * Every numeric price/size field on the wire is a decimal STRING, not a JSON number — RISEx's
 * amounts carry 18-decimal precision, which does not survive IEEE754 round-tripping. Every
 * timestamp field ("time", "start_time", "end_time", "next_funding_time", "block_time") is a
 * unix-NANOSECOND string — about 1e18, far past Number.MAX_SAFE_INTEGER (~9e15), so these must
 * never be parsed with `Number()` before being reduced to milliseconds.
 *
 * Every endpoint response is wrapped in a `{ data: ..., request_id: string }` envelope. This is
 * NOT what the hosted docs describe (they show the inner shape as if it were the top level) —
 * confirmed by a live curl against every endpoint below.
 */

export interface RiseXEnvelope<T> {
  data: T;
  request_id?: string;
}

export interface RiseXMarketConfigRaw {
  name: string;
  quote: string;
  step_size: string;
  step_price: string;
  maintenance_margin_factor: string;
  max_leverage: string;
  min_order_size: string;
  unlocked: boolean;
  open_interest_limit: string;
}

export interface RiseXMarketRaw {
  market_id: string;
  config: RiseXMarketConfigRaw;
  base_asset_symbol: string;
  quote_asset_symbol: string;
  underlying: string;
  display_name: string;
  quote_volume_24h: string;
  change_24h: string;
  high_24h: string;
  low_24h: string;
  last_price: string;
  mark_price: string;
  index_price: string;
  max_position_size: string;
  open_interest: string;
  funding_interval: string;
  next_funding_time: string;
  post_only: boolean;
  accumulated_funding: string;
  current_funding_rate: string;
  funding_rate_8h: string;
  active: boolean;
}

export interface RiseXMarketsResponse {
  markets: RiseXMarketRaw[];
  cached_at?: number;
}

export interface RiseXOrderbookLevelRaw {
  price: string;
  quantity: string;
  order_count: number;
}

export interface RiseXOrderbookRaw {
  market_id: string;
  bids: RiseXOrderbookLevelRaw[];
  asks: RiseXOrderbookLevelRaw[];
  total_bids: string;
  total_asks: string;
}

export interface RiseXTradeRaw {
  /** Composite id (maker+taker order refs), e.g. "0x...-0x...". NOT a sortable integer — unlike
   * N1's TradeFromApi.tradeId, this cannot be used as an incrementing pagination cursor. Cursor
   * on `time` instead (see getRecentTrades). */
  id: string;
  maker_side: "BUY" | "SELL";
  price: string;
  size: string;
  time: string;
  block_number: string;
  log_index: string;
}

export interface RiseXTradeHistoryRaw {
  market_id: string;
  trades: RiseXTradeRaw[];
}

export interface RiseXCandleRaw {
  market_id: string;
  interval: string;
  time: string;
  low: string;
  high: string;
  open: string;
  close: string;
  volume: string;
}

/** Double-nested on the wire: the envelope's `data` itself has a `data` array field. Confirmed
 * live, not a typo. */
export interface RiseXCandlesInner {
  data: RiseXCandleRaw[];
}

export interface RiseXFundingRecordRaw {
  funding_rate: string;
  accumulated_funding: string;
  index_price: string;
  start_time: string;
  end_time: string;
  block_number: string;
  block_time: string;
  tx_hash: string;
}

export interface RiseXFundingRateHistoryRaw {
  market_id: string;
  records: RiseXFundingRecordRaw[];
  page: number;
  has_next_page: boolean;
}
