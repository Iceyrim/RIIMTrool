use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use alloy::{primitives::keccak256, sol_types::SolCall};
use fastnum::UD64;
use perpl_sdk::{
    abi::dex::Exchange,
    state,
    types::{OrderRequest, RequestType},
};
use tokio::sync::RwLock;

use crate::protocol::{Market, Position, PrepareOrder, Snapshot};

pub type SharedExchange = Arc<RwLock<state::Exchange>>;

pub fn validate_hello(
    network: &str,
    rpc_url: &str,
    markets: &[Market],
    account_ids: &[u32],
) -> Result<(), String> {
    if network != "testnet" {
        return Err("only testnet is permitted".into());
    }
    if !(rpc_url.starts_with("https://") || rpc_url.starts_with("http://127.0.0.1")) {
        return Err("RPC URL must be HTTPS (or loopback for offline tests)".into());
    }
    if !account_ids.is_empty() {
        return Err("phase 1 does not accept account identifiers".into());
    }
    if markets.is_empty()
        || markets
            .iter()
            .any(|market| ![16, 32, 48, 64, 256].contains(&market.perpetual_id))
    {
        return Err("unlisted testnet perpetual".into());
    }
    Ok(())
}

pub fn snapshot(exchange: &state::Exchange, markets: &[Market]) -> Result<Snapshot, String> {
    let instant = exchange.instant();
    let positions = markets
        .iter()
        .map(|market| {
            let perp = exchange
                .perpetuals()
                .get(&market.perpetual_id)
                .ok_or_else(|| format!("perpetual {} is absent", market.perpetual_id))?;
            Ok(Position {
                symbol: market.symbol.clone(),
                base_size: "0".into(),
                mark_price: perp.mark_price().to_string(),
                unrealized_pnl: "0".into(),
                open_order_count: 0,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let received_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is invalid")?
        .as_millis()
        .try_into()
        .map_err(|_| "system time overflow")?;
    Ok(Snapshot {
        block_number: instant.block_number().to_string(),
        block_timestamp: instant.block_timestamp(),
        received_at,
        positions,
        orders: vec![],
    })
}

pub fn prepare(
    exchange: &state::Exchange,
    markets: &[Market],
    orders: &[PrepareOrder],
) -> Result<(String, String), String> {
    if orders.is_empty() {
        return Err("empty order batch".into());
    }
    let mut descs = Vec::with_capacity(orders.len());
    for order in orders {
        let market = markets
            .iter()
            .find(|market| {
                market.symbol == order.symbol && market.perpetual_id == order.perpetual_id
            })
            .ok_or("order market is not configured")?;
        let request_id = order
            .request_id
            .parse::<u64>()
            .map_err(|_| "request id must be u64")?;
        let price = order
            .price
            .parse::<UD64>()
            .map_err(|_| "price must be an unsigned decimal")?;
        let size = order
            .size
            .parse::<UD64>()
            .map_err(|_| "size must be an unsigned decimal")?;
        let leverage = order
            .leverage
            .parse::<UD64>()
            .map_err(|_| "leverage must be an unsigned decimal")?;
        if price.is_zero() || size.is_zero() || leverage.is_zero() {
            return Err("price, size, and leverage must be positive".into());
        }
        let request_type = match (order.side.as_str(), order.reduce_only) {
            ("buy", false) => RequestType::OpenLong,
            ("sell", false) => RequestType::OpenShort,
            ("sell", true) => RequestType::CloseLong,
            ("buy", true) => RequestType::CloseShort,
            _ => return Err("invalid order side".into()),
        };
        let (post_only, fill_or_kill, immediate_or_cancel) = match order.order_type.as_str() {
            "limit" => (false, false, false),
            "postOnly" => (true, false, false),
            "fillOrKill" => (false, true, false),
            "immediateOrCancel" => (false, false, true),
            _ => return Err("unsupported order type".into()),
        };
        let request = OrderRequest::new(
            request_id,
            market.perpetual_id,
            request_type,
            None,
            price,
            size,
            None,
            post_only,
            fill_or_kill,
            immediate_or_cancel,
            None,
            leverage,
            None,
            None,
            0,
        );
        descs.push(request.prepare(exchange));
    }
    let bytes = Exchange::execOrdersCall {
        orderDescs: descs,
        revertOnFail: true,
    }
    .abi_encode();
    Ok((
        format!("0x{}", hex::encode(&bytes)),
        format!("{:#x}", keccak256(&bytes)),
    ))
}
