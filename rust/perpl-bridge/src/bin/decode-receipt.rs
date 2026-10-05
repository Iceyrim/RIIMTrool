//! Read-only receipt decoder. Takes a mined transaction hash and prints every
//! log in its receipt, decoded against the pinned SDK's `ExchangeEvents`
//! ABI — the same decode path `tx::extract_order_id` uses. No signer, no
//! wallet, no broadcast capability: the provider is a plain HTTP read client.
//!
//! Usage: decode-receipt --rpc-url=<url> --tx-hash=<0x...>

use Exchange::ExchangeEvents;
use alloy::{primitives::TxHash, providers::ProviderBuilder, sol_types::SolEventInterface};
use perpl_sdk::abi::dex::Exchange;

fn parse_args(args: &[String]) -> Result<(String, TxHash), String> {
    let mut rpc_url = None;
    let mut tx_hash = None;
    for arg in args {
        let (key, value) = arg
            .strip_prefix("--")
            .and_then(|rest| rest.split_once('='))
            .ok_or_else(|| format!("malformed argument (expected --key=value): {arg}"))?;
        match key {
            "rpc-url" => rpc_url = Some(value.to_string()),
            "tx-hash" => {
                tx_hash =
                    Some(value.parse::<TxHash>().map_err(|_| "invalid --tx-hash".to_string())?)
            }
            other => return Err(format!("unknown argument: --{other}")),
        }
    }
    Ok((
        rpc_url.ok_or("missing --rpc-url")?,
        tx_hash.ok_or("missing --tx-hash")?,
    ))
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (rpc_url, tx_hash) = parse_args(&args)?;

    let url = rpc_url.parse().map_err(|_| "invalid --rpc-url".to_string())?;
    let provider = ProviderBuilder::new().connect_http(url);

    let receipt = alloy::providers::Provider::get_transaction_receipt(&provider, tx_hash)
        .await
        .map_err(|error| format!("RPC error fetching receipt: {error}"))?
        .ok_or("no receipt found for that hash (not mined, or pruned by this RPC node)")?;

    println!("status={} tx={:#x}", receipt.status(), tx_hash);
    for (i, log) in receipt.inner.logs().iter().enumerate() {
        println!(
            "log[{i}] address={:?} topic0={:?}",
            log.inner.address,
            log.inner.topics().first()
        );
        match ExchangeEvents::decode_log(&log.inner) {
            Ok(decoded) => println!("  decoded = {:?}", decoded.data),
            Err(error) => println!("  <could not decode against known ExchangeEvents: {error}>"),
        }
    }
    Ok(())
}
