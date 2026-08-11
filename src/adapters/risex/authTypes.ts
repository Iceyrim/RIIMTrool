/**
 * Raw wire shapes for RISEx's AUTHENTICATED REST surface (SPEC.md Section 11, build plan step 3),
 * pinned to the real OpenAPI-derived reference at developer.rise.trade/reference — NOT the
 * marketing docs at docs.risechain.com, which only link out to this. Fetched and cross-checked
 * page by page during Phase 3 development; there is no live account to capture real authenticated
 * responses from (no public testnet — SPEC.md Section 11 "No public testnet"), so unlike
 * types.ts's public shapes (verified against real mainnet curls in Phase 1), these are verified
 * against DOCUMENTED schemas only. That is the entire reason this adapter is fixture/contract
 * tested rather than soak tested — see RiseXAdapter.ts's class doc comment.
 *
 * Same deliberate split as types.ts: raw wire shapes here, normalized ExchangeAdapter types
 * elsewhere, mapping only inside RiseXAdapter.ts / riseXAuthMappers.ts.
 */

/** GET /v1/auth/eip712-domain response. */
export interface RiseXEip712DomainRaw {
  name: string;
  version: string;
  chain_id: string;
  verifying_contract: string;
}

/** GET /v1/auth/nonce response. Nonce expires after 5 minutes, single-use. */
export interface RiseXLoginNonceRaw {
  nonce: string;
}

/** POST /v1/auth/login request. `nonce` is the hex string from RiseXLoginNonceRaw, parsed
 * base-16 into a uint256 for the EIP-712 message per the docs' explicit note. */
export interface RiseXLoginRequestRaw {
  account: string;
  nonce: string;
  deadline: number;
  signature: string;
}

/** Shared response shape for both POST /v1/auth/login and POST /v1/auth/refresh. */
export interface RiseXAuthTokenRaw {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** POST /v1/auth/refresh request. Refresh token is rotated — the response's refresh_token
 * invalidates the one sent here. */
export interface RiseXRefreshRequestRaw {
  refresh_token: string;
}

/**
 * EIP-712 permit for the signature-based auth path (per-call signing). The locked design
 * (SPEC.md Section 11) uses JWT bearer instead, so this adapter never populates or sends this —
 * kept here only because RiseXOrderPlaceRequestRaw's `permit` field is typed against it (and
 * omitted, per the docs: "with a JWT... no per-order signature is needed — omit permit").
 */
export interface RiseXPermitRaw {
  account: string;
  signer: string;
  nonce_anchor: string;
  nonce_bitmap_index: number;
  deadline: number;
  signature: string;
}

/** RISEx's order_type field. Distinct from this adapter's abstract OrderType (limit/postOnly/
 * immediateOrCancel/fillOrKill) — every one of those maps to Limit here; Market exists on the
 * wire but this adapter's v1 scope (SPEC.md Section 11 locked decision) never sends it, since
 * PlaceOrderParams always carries an explicit price. */
export const RISEX_ORDER_TYPE = { MARKET: 0, LIMIT: 1 } as const;

/** RISEx's time_in_force field. */
export const RISEX_TIME_IN_FORCE = { GTC: 0, GTT: 1, FOK: 2, IOC: 3 } as const;

export const RISEX_SIDE = { BUY: 0, SELL: 1 } as const;

/** POST /v1/orders/place request. price_ticks/size_steps are integers on the market's tick/step
 * grid (SPEC.md Section 11's "integer tick/step price representation"), NOT decimal price/size —
 * a genuinely different wire representation from RiseXPaperAdapter's quantize-then-send-decimal
 * approach, since that adapter simulates locally and never actually serializes an order onto
 * RISEx's real grid-integer wire format. */
export interface RiseXOrderPlaceRequestRaw {
  market_id: number;
  size_steps: number;
  price_ticks: number;
  side: number;
  post_only: boolean;
  reduce_only: boolean;
  stp_mode: number;
  order_type: number;
  time_in_force: number;
  builder_id: number;
  client_order_id: string;
  ttl_units: number;
  builder_fee_bps: number;
  permit?: RiseXPermitRaw;
}

/**
 * POST /v1/orders/place response. Deliberately has NO `success` field — unlike cancelOrder's
 * response, this only reports that the transaction was submitted, not that it didn't revert
 * on-chain. `filled_quantity` is a WAD (1e18 fixed-point) decimal string; `message`/
 * `filled_percent` are populated for IOC orders only. Confirming this order is genuinely resting
 * or filled (not silently reverted) requires decoding `tx_hash` via GET /v1/tx/{tx_hash} — see
 * RiseXAdapter.placeOrder()'s doc comment for why, which is the RISEx-flavored equivalent of
 * SPEC.md Section 5b's "resolved without throwing != confirmed" fix.
 */
export interface RiseXOrderPlaceResponseRaw {
  order_id: string;
  tx_hash: string;
  block_number: string;
  sc_order_id: string;
  filled_quantity: string;
  message?: string;
  filled_percent?: string;
}

/** POST /v1/orders/cancel request. Same JWT-omits-permit convention as place. */
export interface RiseXOrderCancelRequestRaw {
  market_id: number;
  order_id: string;
  permit?: RiseXPermitRaw;
}

/** POST /v1/orders/cancel response. Unlike place, this DOES report `success` directly ("True if
 * receipt status equals 1") — RISEx has already verified the on-chain receipt server-side for
 * this endpoint, so no separate decode-tx call is needed here. */
export interface RiseXOrderCancelResponseRaw {
  tx_hash: string;
  block_number: string;
  success: boolean;
}

/** GET /v1/orders/open response entry. */
export interface RiseXOpenOrderRaw {
  order_id: string;
  wide_order_id: string;
  resting_order_id: string;
  market_id: number;
  account: string;
  side: number;
  size_steps: number;
  price_ticks: number;
  order_type: number;
  time_in_force: number;
  post_only: boolean;
  reduce_only: boolean;
  client_order_id: string;
}

export interface RiseXOpenOrdersResponseRaw {
  orders: RiseXOpenOrderRaw[];
  market_id: string;
  account: string;
  total_orders: string;
}

/** GET /v1/tx/{tx_hash} response — the "Decode Transaction" revert-check endpoint. */
export interface RiseXDecodeTxErrorRaw {
  selector: string;
  signature: string;
  name: string;
  parameters: string[];
  message: string;
}

export interface RiseXDecodeTxResponseRaw {
  tx_hash: string;
  success: boolean;
  error?: RiseXDecodeTxErrorRaw;
}

/** GET /v1/portfolio/details response. Bundles positions + account-wide cross-margin summary in
 * one call — the closest RISEx equivalent to N1's single fetchInfo() round trip, though it still
 * doesn't cover open orders or plain token balance (see RiseXAdapter.refreshAccountState()'s doc
 * comment for why those need two more calls). */
export interface RiseXPortfolioSummaryRaw {
  total_account_value: string;
  usdc_balance: string;
  collateral_margin_balance: string;
  cross_margin_balance: string;
  free_collateral: string;
  total_unrealized_pnl: string;
  realized_pnl: string;
  total_initial_margin: string;
  total_maintenance_margin: string;
  margin_usage: string;
  margin_health: string;
  account_leverage: string;
  in_liquidation: boolean;
  risk_level: "NORMAL" | "LIQUIDATION" | "ADL";
  total_notional: string;
  unsettled_usdc: string;
  total_isolated_order_reserve: string;
}

export interface RiseXPortfolioPositionRaw {
  market_id: string;
  market_name: string;
  size: string;
  side: number;
  margin_mode: number;
  avg_entry_price: string;
  mark_price: string;
  index_price: string;
  leverage: string;
  unrealized_pnl: string;
  liquidation_price: string;
  initial_margin_requirement: string;
  maintenance_margin_requirement: string;
}

export interface RiseXPortfolioDetailsResponseRaw {
  account: string;
  summary: RiseXPortfolioSummaryRaw;
  positions: RiseXPortfolioPositionRaw[];
}

/** GET /v1/account/balance response. Takes a `token` query param (contract address, not a
 * symbol) — this adapter resolves the USDC address from its own config rather than the public
 * market list, see RiseXAdapterConfig.usdcTokenAddress's doc comment. */
export interface RiseXBalanceResponseRaw {
  balance: string;
}

/**
 * GET /v1/trade-history response entry, AUTHENTICATED variant (queried with `account`, used for
 * getOrderFills/getAccountVolume). Structurally the same endpoint the public
 * RiseXMarketDataSource probes with a bare market_id (no account) — RISEx does not separate these
 * into different paths. `order_id` is present here (needed for getOrderFills's client-side
 * filter, since the endpoint itself has no order_id query param) even though the public-facing
 * RiseXTradeRaw in types.ts omits it, since that consumer never needed it.
 */
export interface RiseXAccountTradeRaw {
  id: string;
  market_id: number;
  order_id: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  fee: string;
  liquidity_indicator: "TAKER" | "MAKER";
  time: string;
  client_order_id?: string;
}

export interface RiseXAccountTradeHistoryResponseRaw {
  market_id: number;
  wallet_address: string;
  page: number;
  has_next_page: boolean;
  trades: RiseXAccountTradeRaw[];
}
