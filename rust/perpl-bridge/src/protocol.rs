use fastnum::UD128;
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, tag = "action", rename_all = "snake_case")]
pub enum ExecutionIntent {
    Place {
        version: u8,
        id: String,
        #[serde(rename = "chainId")]
        chain_id: u64,
        exchange: String,
        #[serde(rename = "accountId")]
        account_id: u32,
        market: String,
        #[serde(rename = "perpetualId")]
        perpetual_id: u32,
        #[serde(rename = "actionId")]
        action_id: String,
        side: String,
        #[serde(rename = "orderType")]
        order_type: String,
        price: String,
        size: String,
        #[serde(rename = "reduceOnly")]
        reduce_only: bool,
        leverage: String,
    },
    Cancel {
        version: u8,
        id: String,
        #[serde(rename = "chainId")]
        chain_id: u64,
        exchange: String,
        #[serde(rename = "accountId")]
        account_id: u32,
        market: String,
        #[serde(rename = "perpetualId")]
        perpetual_id: u32,
        #[serde(rename = "actionId")]
        action_id: String,
        #[serde(rename = "exchangeOrderId")]
        exchange_order_id: String,
        #[serde(rename = "placementActionId")]
        placement_action_id: String,
    },
}

pub fn decode_execution_intent(line: &str) -> Result<ExecutionIntent, String> {
    if line.len() > 16_384 {
        return Err("execution intent exceeds 16 KB".into());
    }
    let intent: ExecutionIntent = serde_json::from_str(line)
        .map_err(|error| format!("malformed execution intent: {error}"))?;
    validate_execution_intent(&intent)?;
    Ok(intent)
}

fn validate_execution_identity(
    version: u8,
    id: &str,
    chain_id: u64,
    exchange: &str,
    account_id: u32,
    market: &str,
    perpetual_id: u32,
    action_id: &str,
) -> Result<(), String> {
    if version != VERSION
        || id.is_empty()
        || action_id.is_empty()
        || chain_id != MAINNET_CHAIN_ID
        || !exchange.eq_ignore_ascii_case(MAINNET_EXCHANGE)
        || account_id != 5198
        || !matches!((market, perpetual_id), ("BTCUSD", 1) | ("ETHUSD", 20))
    {
        return Err("execution intent identity is invalid".into());
    }
    Ok(())
}

fn canonical_positive_decimal(value: &str, field: &str) -> Result<UD128, String> {
    if value.is_empty()
        || value.starts_with('+')
        || value.starts_with('-')
        || value.contains('e')
        || value.contains('E')
        || value
            .chars()
            .any(|character| !character.is_ascii_digit() && character != '.')
        || value.matches('.').count() > 1
    {
        return Err(format!("invalid execution {field}"));
    }
    let parsed = value
        .parse::<UD128>()
        .map_err(|_| format!("invalid execution {field}"))?;
    if parsed == UD128::ZERO {
        return Err(format!("execution {field} must be positive"));
    }
    Ok(parsed)
}

pub fn validate_execution_intent(intent: &ExecutionIntent) -> Result<(), String> {
    match intent {
        ExecutionIntent::Place {
            version,
            id,
            chain_id,
            exchange,
            account_id,
            market,
            perpetual_id,
            action_id,
            side,
            order_type,
            price,
            size,
            reduce_only: _,
            leverage,
        } => {
            validate_execution_identity(
                *version,
                id,
                *chain_id,
                exchange,
                *account_id,
                market,
                *perpetual_id,
                action_id,
            )?;
            let leverage_value = canonical_positive_decimal(leverage, "leverage")?;
            let maximum_leverage = if market == "BTCUSD" { 15u8 } else { 12u8 };
            if !matches!(side.as_str(), "buy" | "sell")
                || order_type != "postOnly"
                || leverage_value > UD128::from(maximum_leverage)
                || leverage.contains('.')
            {
                return Err(
                    "execution placement violates the market leverage or post-only limit".into(),
                );
            }
            let notional = canonical_positive_decimal(price, "price")?
                * canonical_positive_decimal(size, "size")?;
            if notional > UD128::from(20u8) {
                return Err("execution placement exceeds the $20 canary ceiling".into());
            }
        }
        ExecutionIntent::Cancel {
            version,
            id,
            chain_id,
            exchange,
            account_id,
            market,
            perpetual_id,
            action_id,
            exchange_order_id,
            placement_action_id,
        } => {
            validate_execution_identity(
                *version,
                id,
                *chain_id,
                exchange,
                *account_id,
                market,
                *perpetual_id,
                action_id,
            )?;
            if exchange_order_id.is_empty()
                || placement_action_id.is_empty()
                || action_id == placement_action_id
            {
                return Err("execution cancellation identity is invalid".into());
            }
        }
    }
    Ok(())
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
    pub deposit: String,
    pub maintenance_requirement: String,
    pub liquidation_price: String,
    pub bankruptcy_price: String,
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
