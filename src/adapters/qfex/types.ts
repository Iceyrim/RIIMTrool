export interface QfexCredentials {
  publicKey: string;
  secretKey: string;
  accountId?: string;
}
export interface QfexConfiguredMarket {
  symbol: string;
  exchangeSymbol: string;
  priceTickSize: number;
  quantityStep: number;
  minimumOrderSize: number;
}
export interface QfexOrderRaw {
  order_id: string;
  client_order_id?: string;
  symbol: string;
  status: string;
  quantity: number;
  quantity_remaining: number;
  price: number;
  side: "BUY" | "SELL";
  type?: string;
  order_type?: string;
  time_in_force?: string;
  reduce_only?: boolean | number;
}
export interface QfexFillRaw {
  trade_id: string;
  symbol: string;
  price: number;
  quantity: number;
  side?: "BUY" | "SELL";
  aggressor_side?: "BUY" | "SELL";
  order_id: string;
  client_order_id?: string;
  /** Present on real-time fills; production trade-history rows may omit it. */
  timestamp?: number;
}
export interface QfexPositionRaw {
  symbol: string;
  position: number;
  realised_pnl: number;
  unrealised_pnl: number;
  open_orders: number;
  initial_margin: number;
  maintenance_margin: number;
  leverage: number;
}
export interface QfexBalanceRaw {
  deposit: number;
  realised_pnl: number;
  order_margin: number;
  position_margin: number;
  unrealised_pnl: number;
  net_funding: number;
  available_balance: number;
  fees: number;
}
export type QfexMessage = Record<string, unknown> & {
  type?: string;
  result?: string;
  order_response?: QfexOrderRaw;
  fill_response?: QfexFillRaw;
  position_response?: QfexPositionRaw;
  balance_response?: QfexBalanceRaw;
  user_orders?: QfexOrderRaw[];
  user_trades?: QfexFillRaw[];
  user_trades_response?: QfexFillRaw[];
  all_orders_response?: { orders?: QfexOrderRaw[] };
};
