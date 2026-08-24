use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use alloy::{primitives::keccak256, sol_types::SolCall};
use fastnum::{UD64, UD128};
use perpl_sdk::{
    abi::dex::Exchange,
    state,
    types::{OrderRequest, OrderSide, OrderType, RequestType},
};
use tokio::sync::RwLock;

use crate::protocol::{
    AccountEvidence, Book, BookLevel, Fill, Market, MarketState, Order, Position, PrepareOrder,
    Snapshot,
};

pub const MAINNET_RPC_URL: &str = "https://rpc.monad.xyz";
pub const MAINNET_ACCOUNT_ID: u32 = 5071;

pub type SharedExchange = Arc<RwLock<state::Exchange>>;

pub fn validate_hello(
    network: &str,
    rpc_url: &str,
    markets: &[Market],
    account_ids: &[u32],
) -> Result<(), String> {
    if network != "mainnet" {
        return Err("only the pinned mainnet read-only network is permitted".into());
    }
    if rpc_url != MAINNET_RPC_URL && !rpc_url.starts_with("http://127.0.0.1/") {
        return Err("only the approved Monad mainnet RPC (or loopback tests) is permitted".into());
    }
    if account_ids != [MAINNET_ACCOUNT_ID] {
        return Err("only the pinned mainnet account id is permitted".into());
    }
    if markets.is_empty()
        || markets.iter().any(|market| {
            !matches!(
                (market.symbol.as_str(), market.perpetual_id),
                ("BTCUSD", 1) | ("ETHUSD", 20)
            )
        })
    {
        return Err("unlisted mainnet perpetual".into());
    }
    Ok(())
}

pub fn snapshot(
    exchange: &state::Exchange,
    markets: &[Market],
    account_id: u32,
    fill_coverage_start_block: u64,
    fills: &[Fill],
    event_count: u32,
) -> Result<Snapshot, String> {
    let instant = exchange.instant();
    let account = exchange
        .accounts()
        .get(&account_id)
        .ok_or_else(|| format!("account {account_id} is absent"))?;
    let position_deposit: UD128 = account
        .positions()
        .values()
        .map(|position| position.deposit())
        .sum();
    let maintenance_requirement: UD128 = account
        .positions()
        .values()
        .map(|position| position.maintenance_margin_requirement())
        .sum();
    let account_evidence = AccountEvidence {
        balance: account.balance().to_string(),
        locked_balance: account.locked_balance().to_string(),
        available_balance: account.available_balance().to_string(),
        unrealized_pnl: account.unrealized_pnl().to_string(),
        position_deposit: position_deposit.to_string(),
        maintenance_requirement: maintenance_requirement.to_string(),
        frozen: account.frozen(),
    };
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
            let deposit = position
                .map(|value| value.deposit().to_string())
                .unwrap_or_else(|| "0".into());
            let position_maintenance_requirement = position
                .map(|value| value.maintenance_margin_requirement().to_string())
                .unwrap_or_else(|| "0".into());
            let liquidation_price = position
                .map(|value| value.liquidation_price().to_string())
                .unwrap_or_else(|| "0".into());
            let bankruptcy_price = position
                .map(|value| value.bankruptcy_price().to_string())
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
                deposit,
                maintenance_requirement: position_maintenance_requirement,
                liquidation_price,
                bankruptcy_price,
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
        account: account_evidence,
        fill_coverage_start_block: fill_coverage_start_block.to_string(),
        block_number: instant.block_number().to_string(),
        block_timestamp: instant.block_timestamp(),
        received_at,
        positions,
        orders,
        fills: fills.to_vec(),
        markets: market_states,
        books,
        event_count,
        quiet: event_count == 0,
    })
}

pub fn observed_maker_fills(
    events: &state::StateBlockEvents,
    markets: &[Market],
    account_id: u32,
) -> Vec<Fill> {
    let timestamp = events.instant().block_timestamp().saturating_mul(1_000);
    let mut fills = Vec::new();
    for context in events.events() {
        for event in context.event() {
            let Some(trade) = event.as_trade() else {
                continue;
            };
            let Some(market) = markets
                .iter()
                .find(|market| market.perpetual_id == trade.perpetual_id)
            else {
                continue;
            };
            let side = match trade.taker_side.opposite() {
                OrderSide::Bid => "buy",
                OrderSide::Ask => "sell",
            };
            for fill in trade
                .maker_fills
                .iter()
                .filter(|fill| fill.maker_account_id == account_id)
            {
                fills.push(Fill {
                    exchange_order_id: fill.maker_order_id.to_string(),
                    trade_id: format!("{:#x}:{}", context.tx_hash(), fill.log_index),
                    symbol: market.symbol.clone(),
                    side: side.into(),
                    price: fill.price.to_string(),
                    size: fill.size.to_string(),
                    timestamp,
                });
            }
        }
    }
    fills
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
