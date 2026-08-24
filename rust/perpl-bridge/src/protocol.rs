use serde::{Deserialize, Serialize};

pub const VERSION: u8 = 1;
pub const TESTNET_CHAIN_ID: u64 = 10_143;
pub const TESTNET_EXCHANGE: &str = "0x1964c32f0be608e7d29302aff5e61268e72080cc";
pub const MAINNET_CHAIN_ID: u64 = 143;
pub const MAINNET_EXCHANGE: &str = "0x34b6552d57a35a1d042ccae1951bd1c370112a6f";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, tag = "command", rename_all = "snake_case")]
pub enum Request {
    Hello {
        version: u8,
        id: String,
        network: String,
        #[serde(rename = "rpcUrl")]
        rpc_url: String,
        markets: Vec<Market>,
        #[serde(rename = "accountIds")]
        account_ids: Vec<u32>,
    },
}

impl Request {
    pub fn id(&self) -> &str {
        match self {
            Self::Hello { id, .. } => id,
        }
    }
    pub fn version(&self) -> u8 {
        match self {
            Self::Hello { version, .. } => *version,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Market {
    pub symbol: String,
    #[serde(rename = "perpetualId")]
    pub perpetual_id: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareOrder {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub symbol: String,
    #[serde(rename = "perpetualId")]
    pub perpetual_id: u32,
    pub side: String,
    #[serde(rename = "type")]
    pub order_type: String,
    pub price: String,
    pub size: String,
    #[serde(rename = "reduceOnly")]
    pub reduce_only: bool,
    pub leverage: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub symbol: String,
    pub base_size: String,
    pub mark_price: String,
    pub unrealized_pnl: String,
    pub open_order_count: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub exchange_order_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_order_id: Option<String>,
    pub symbol: String,
    pub side: String,
    pub price: String,
    pub size: String,
    pub filled_size: String,
    pub reduce_only: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEvidence {
    pub balance: String,
    pub locked_balance: String,
    pub available_balance: String,
    pub unrealized_pnl: String,
    pub position_deposit: String,
    pub maintenance_requirement: String,
    pub frozen: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    pub exchange_order_id: String,
    pub trade_id: String,
    pub symbol: String,
    pub side: String,
    pub price: String,
    pub size: String,
    pub timestamp: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub account_id: u32,
    pub account: AccountEvidence,
    pub fill_coverage_start_block: String,
    pub block_number: String,
    pub block_timestamp: u64,
    pub received_at: u64,
    pub positions: Vec<Position>,
    pub orders: Vec<Order>,
    pub fills: Vec<Fill>,
    pub markets: Vec<MarketState>,
    pub books: Vec<Book>,
    pub event_count: u32,
    pub quiet: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketState {
    pub symbol: String,
    pub perpetual_id: u32,
    pub mark_price: String,
    pub oracle_price: String,
    pub last_price: String,
    pub paused: bool,
    pub open_interest: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub symbol: String,
    pub perpetual_id: u32,
    pub best_bid: Option<BookLevel>,
    pub best_ask: Option<BookLevel>,
    pub total_orders: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookLevel {
    pub price: String,
    pub size: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Response {
    Ready {
        version: u8,
        id: String,
        #[serde(rename = "chainId")]
        chain_id: u64,
        exchange: &'static str,
        snapshot: Snapshot,
    },
    State {
        version: u8,
        id: String,
        #[serde(rename = "chainId")]
        chain_id: u64,
        exchange: &'static str,
        snapshot: Snapshot,
    },
    Fatal {
        version: u8,
        id: String,
        error: String,
    },
}

pub fn decode(line: &str) -> Result<Request, String> {
    if line.len() > 1_000_000 {
        return Err("request exceeds 1 MB".into());
    }
    let request: Request =
        serde_json::from_str(line).map_err(|error| format!("malformed request: {error}"))?;
    if request.version() != VERSION {
        return Err("protocol version mismatch".into());
    }
    Ok(request)
}
