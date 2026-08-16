export interface PerplMarketRaw {
  id?: string | number;
  market_id?: string | number;
  symbol?: string;
  name?: string;
  ticker?: string;
  price_decimals?: number;
  size_decimals?: number;
  minimum_posting_size?: string | number;
  min_posting_size?: string | number;
  min_posting_amount?: string | number;
  status?: string;
  is_open?: boolean;
  config?: {
    price_decimals?: number;
    size_decimals?: number;
    min_posting_amount?: string | number;
    is_open?: boolean;
  };
}

export interface PerplContextRaw {
  markets?: PerplMarketRaw[];
  data?: { markets?: PerplMarketRaw[] } | PerplMarketRaw[];
}

export interface PerplCandleRaw {
  timestamp?: string | number;
  time?: string | number;
  open?: string | number;
  high?: string | number;
  low?: string | number;
  close?: string | number;
  volume?: string | number;
}

export type PerplChannel = "market-state" | "order-book" | "trades" | "funding";

export interface PerplWireMessage {
  channel?: string;
  type?: string;
  market_id?: string | number;
  marketId?: string | number;
  sequence?: string | number;
  seq?: string | number;
  timestamp?: string | number;
  ts?: string | number;
  data?: unknown;
}
