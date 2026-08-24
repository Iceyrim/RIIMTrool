use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use alloy::{primitives::keccak256, sol_types::SolCall};
use fastnum::UD64;
use perpl_sdk::{
    abi::dex::Exchange,
    state,
    types::{OrderRequest, OrderSide, OrderType, RequestType},
};
use tokio::sync::RwLock;

use crate::protocol::{
    Book, BookLevel, Market, MarketState, Order, Position, PrepareOrder, Snapshot,
};

pub const TESTNET_RPC_URL: &str = "https://testnet-rpc.monad.xyz";

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
    if rpc_url != TESTNET_RPC_URL && !rpc_url.starts_with("http://127.0.0.1/") {
        return Err("only the approved Monad testnet RPC (or loopback tests) is permitted".into());
    }
    if account_ids.len() != 1 || account_ids[0] == 0 {
        return Err("exactly one nonzero testnet account id is required".into());
    }
    if markets.is_empty()
        || markets.iter().any(|market| {
            !matches!(
                (market.symbol.as_str(), market.perpetual_id),
                ("BTCUSD", 16) | ("ETHUSD", 32)
            )
        })
    {
        return Err("unlisted testnet perpetual".into());
    }
    Ok(())
}

pub fn snapshot(
    exchange: &state::Exchange,
    markets: &[Market],
    account_id: u32,
    event_count: u32,
) -> Result<Snapshot, String> {
    let instant = exchange.instant();
    let account = exchange
        .accounts()
        .get(&account_id)
        .ok_or_else(|| format!("account {account_id} is absent"))?;
    let positions = markets
        .iter()
        .map(|market| {
            let perp = exchange
                .perpetuals()
                .get(&market.perpetual_id)
                .ok_or_else(|| format!("perpetual {} is absent", market.perpetual_id))?;
            let position = account.positions().get(&market.perpetual_id);
            let base_size = match position {
                Some(position) if position.r#type().is_short() => format!("-{}", position.size()),
                Some(position) => position.size().to_string(),
                None => "0".into(),
            };
            let unrealized_pnl = position
                .map(|value| value.pnl().to_string())
                .unwrap_or_else(|| "0".into());
            let open_order_count = perp
                .l3_book()
                .all_orders()
                .values()
                .filter(|order| order.account_id() == account_id && !order.is_expired())
                .count()
                .try_into()
                .map_err(|_| "account order count overflow")?;
            Ok(Position {
                symbol: market.symbol.clone(),
                base_size,
                mark_price: perp.mark_price().to_string(),
                unrealized_pnl,
                open_order_count,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let received_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is invalid")?
        .as_millis()
        .try_into()
        .map_err(|_| "system time overflow")?;
    let mut market_states = Vec::with_capacity(markets.len());
    let mut books = Vec::with_capacity(markets.len());
    for market in markets {
        let perp = exchange
            .perpetuals()
            .get(&market.perpetual_id)
            .ok_or_else(|| format!("perpetual {} is absent", market.perpetual_id))?;
        let book = perp.l3_book();
        let level = |value: Option<(fastnum::UD64, fastnum::UD64)>| {
            value.map(|(price, size)| BookLevel {
                price: price.to_string(),
                size: size.to_string(),
            })
        };
        market_states.push(MarketState {
            symbol: market.symbol.clone(),
            perpetual_id: market.perpetual_id,
            mark_price: perp.mark_price().to_string(),
            oracle_price: perp.oracle_price().to_string(),
            last_price: perp.last_price().to_string(),
            paused: perp.is_paused(),
            open_interest: perp.open_interest().to_string(),
        });
        books.push(Book {
            symbol: market.symbol.clone(),
            perpetual_id: market.perpetual_id,
            best_bid: level(book.best_bid()),
            best_ask: level(book.best_ask()),
            total_orders: book
                .total_orders()
                .try_into()
                .map_err(|_| "book order count overflow")?,
        });
    }
    let mut orders = Vec::new();
    for market in markets {
        let perp = exchange
            .perpetuals()
            .get(&market.perpetual_id)
            .ok_or_else(|| format!("perpetual {} is absent", market.perpetual_id))?;
        for order in perp
            .l3_book()
            .all_orders()
            .values()
            .filter(|order| order.account_id() == account_id && !order.is_expired())
        {
            orders.push(Order {
                exchange_order_id: order.order_id().to_string(),
                client_order_id: order.client_order_id().map(|value| value.to_string()),
                symbol: market.symbol.clone(),
                side: match order.r#type().side() {
                    OrderSide::Bid => "buy",
                    OrderSide::Ask => "sell",
                }
                .into(),
                price: order.price().to_string(),
                size: order
                    .placed_size()
                    .unwrap_or_else(|| order.size())
                    .to_string(),
                filled_size: order
                    .filled_size()
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "0".into()),
                reduce_only: matches!(order.r#type(), OrderType::CloseLong | OrderType::CloseShort),
            });
        }
    }
    orders.sort_by(|left, right| {
        left.symbol
            .cmp(&right.symbol)
            .then_with(|| left.exchange_order_id.cmp(&right.exchange_order_id))
    });
    Ok(Snapshot {
        account_id,
        block_number: instant.block_number().to_string(),
        block_timestamp: instant.block_timestamp(),
        received_at,
        positions,
        orders,
        markets: market_states,
        books,
        event_count,
        quiet: event_count == 0,
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
