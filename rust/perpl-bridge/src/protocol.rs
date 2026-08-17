use serde::{Deserialize, Serialize};

pub const VERSION: u8 = 1;
pub const TESTNET_CHAIN_ID: u64 = 10_143;
pub const TESTNET_EXCHANGE: &str = "0x1964c32f0be608e7d29302aff5e61268e72080cc";

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
    PrepareExecOrders {
        version: u8,
        id: String,
        #[serde(rename = "revertOnFail")]
        revert_on_fail: bool,
        orders: Vec<PrepareOrder>,
    },
}

impl Request {
    pub fn id(&self) -> &str {
        match self {
            Self::Hello { id, .. } | Self::PrepareExecOrders { id, .. } => id,
        }
    }
    pub fn version(&self) -> u8 {
        match self {
            Self::Hello { version, .. } | Self::PrepareExecOrders { version, .. } => *version,
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
pub struct Snapshot {
    pub block_number: String,
    pub block_timestamp: u64,
    pub received_at: u64,
    pub positions: Vec<Position>,
    pub orders: Vec<serde_json::Value>,
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
    Prepared {
        version: u8,
        id: String,
        #[serde(rename = "chainId")]
        chain_id: u64,
        exchange: &'static str,
        #[serde(rename = "blockNumber")]
        block_number: String,
        calldata: String,
        #[serde(rename = "calldataHash")]
        calldata_hash: String,
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
