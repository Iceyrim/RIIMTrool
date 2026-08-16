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

export type PerplStreamKind = "market-state" | "funding" | "order-book" | "trades";

export interface PerplBlockTimestamp { b: number; t: number }
export interface PerplBlockTxLogTimestamp extends PerplBlockTimestamp { tx: number; txid: string; l?: number }
export interface PerplSubscription { stream: string; subscribe: true }
export interface PerplSubscriptionRequest { mt: 5; subs: PerplSubscription[] }
export interface PerplWireMessage { mt?: unknown; sid?: unknown; sn?: unknown; subs?: unknown; at?: unknown; d?: unknown; bid?: unknown; ask?: unknown }
