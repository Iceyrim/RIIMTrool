//! One-shot testnet canary CLI. Parses operator-supplied arguments, enforces an
//! explicit submission gate that structurally cannot target anything but the
//! pinned Monad testnet deployment, and — only once that gate is satisfied —
//! wires straight into `riim_perpl_bridge::tx::run_testnet_canary` unchanged.
//!
//! Signer material is Rust-only: `--signer-key-file` names a local file
//! containing a hex-encoded private key, read directly by `FileSignerFactory`
//! (never through TypeScript/JSONL/stdout/stderr/the dashboard, never logged).
//! `FileSignerFactory::initialize` is only ever invoked by `WalletWorker`
//! after the testnet attestation and submission gate are both confirmed, so
//! the key file is never touched by a run whose gate isn't `testnet`.

use alloy::{
    network::EthereumWallet,
    primitives::Address,
    providers::ProviderBuilder,
    rpc::client::RpcClient,
    signers::local::PrivateKeySigner,
    transports::layers::{RetryBackoffLayer, ThrottleLayer},
};
use fastnum::UD64;
use perpl_sdk::{
    Chain,
    state::SnapshotBuilder,
    types::{OrderRequest, RequestType},
};
use riim_perpl_bridge::{protocol, tx};
use std::path::PathBuf;

/// Reads and parses a signer's private key from a local file. Never invoked
/// until after `WalletWorker::initialize` has confirmed the testnet
/// attestation and the explicit submission gate.
struct FileSignerFactory {
    key_file: PathBuf,
}

impl tx::SignerFactory for FileSignerFactory {
    type Signer = PrivateKeySigner;

    fn initialize(self) -> Result<Self::Signer, String> {
        let contents = std::fs::read_to_string(&self.key_file).map_err(|_| {
            format!(
                "unable to read --signer-key-file: {}",
                self.key_file.display()
            )
        })?;
        contents
            .trim()
            .parse::<PrivateKeySigner>()
            .map_err(|_| "signer key file does not contain a valid private key".to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Buy,
    Sell,
}

/// Which pinned deployment `--gate` selected. Mainnet is a second explicit
/// literal, never a boolean and never a replacement for the testnet literal -
/// see `parse_args`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Gate {
    Testnet,
    Mainnet,
}

/// Hard ceiling on mainnet canary order notional (price * size), in the same
/// USD-denominated units the exchange's `price`/`size` fields already use.
/// Approved scope for the mainnet canary: $20. Not applied to testnet.
const MAINNET_MAX_NOTIONAL_USD: u64 = 20;

#[derive(Clone, Debug)]
struct CanaryArgs {
    gate: Gate,
    signer_address: Address,
    signer_key_file: PathBuf,
    perpetual_id: u32,
    side: Side,
    price: UD64,
    size: UD64,
    leverage: UD64,
    order_request_id: u64,
    cancel_request_id: u64,
    gas_limit: u64,
    chain_nonce: u64,
}

const KNOWN_FLAGS: &[&str] = &[
    "gate",
    "i-accept-mainnet-risk",
    "signer",
    "signer-key-file",
    "perpetual-id",
    "side",
    "price",
    "size",
    "leverage",
    "order-request-id",
    "cancel-request-id",
    "gas-limit",
    "chain-nonce",
];

/// Pure, offline argument parser. The submission gate is checked first and
/// must be exactly `testnet` or `mainnet`; every other malformed, missing,
/// unknown, or duplicated argument fails closed with no partial result.
/// Mainnet additionally requires `--i-accept-mainnet-risk=yes` and enforces a
/// hard $20 order-notional ceiling; neither applies to testnet.
fn parse_args(args: &[String]) -> Result<CanaryArgs, String> {
    let mut map = std::collections::BTreeMap::new();
    for arg in args {
        let (key, value) = arg
            .strip_prefix("--")
            .and_then(|rest| rest.split_once('='))
            .ok_or_else(|| format!("malformed argument (expected --key=value): {arg}"))?;
        if map.insert(key.to_string(), value.to_string()).is_some() {
            return Err(format!("duplicate argument: --{key}"));
        }
    }

    let gate_value = map
        .get("gate")
        .ok_or("missing required --gate=testnet or --gate=mainnet")?;
    let gate = match gate_value.as_str() {
        "testnet" => Gate::Testnet,
        "mainnet" => Gate::Mainnet,
        other => {
            return Err(format!(
                "submission gate rejected: --gate must be exactly \"testnet\" or \"mainnet\", got {other:?}"
            ));
        }
    };

    match gate {
        Gate::Mainnet => {
            if map.get("i-accept-mainnet-risk").map(String::as_str) != Some("yes") {
                return Err("--gate=mainnet requires --i-accept-mainnet-risk=yes".into());
            }
        }
        Gate::Testnet => {
            if map.contains_key("i-accept-mainnet-risk") {
                return Err(
                    "--i-accept-mainnet-risk is only valid together with --gate=mainnet".into(),
                );
            }
        }
    }

    if let Some(unknown) = map.keys().find(|key| !KNOWN_FLAGS.contains(&key.as_str())) {
        return Err(format!("unknown argument: --{unknown}"));
    }

    let required = |key: &str| -> Result<&String, String> {
        map.get(key)
            .ok_or_else(|| format!("missing required --{key}"))
    };

    let signer_address: Address = required("signer")?
        .parse()
        .map_err(|_| "invalid --signer address".to_string())?;
    let signer_key_file = PathBuf::from(required("signer-key-file")?);
    let perpetual_id: u32 = required("perpetual-id")?
        .parse()
        .map_err(|_| "invalid --perpetual-id".to_string())?;
    match gate {
        Gate::Testnet => {
            if !matches!(perpetual_id, 16 | 32) {
                return Err(
                    "unlisted testnet perpetual; only 16 (BTCUSD) and 32 (ETHUSD) are permitted"
                        .into(),
                );
            }
        }
        Gate::Mainnet => {
            if !matches!(perpetual_id, 1 | 20) {
                return Err(
                    "unlisted mainnet perpetual; only 1 (BTC) and 20 (ETH) are permitted".into(),
                );
            }
        }
    }
    let side = match required("side")?.as_str() {
        "buy" => Side::Buy,
        "sell" => Side::Sell,
        other => return Err(format!("invalid --side (expected buy or sell): {other}")),
    };
    let price: UD64 = required("price")?
        .parse()
        .map_err(|_| "invalid --price".to_string())?;
    let size: UD64 = required("size")?
        .parse()
        .map_err(|_| "invalid --size".to_string())?;
    let leverage: UD64 = required("leverage")?
        .parse()
        .map_err(|_| "invalid --leverage".to_string())?;
    if price.is_zero() || size.is_zero() || leverage.is_zero() {
        return Err("price, size, and leverage must be positive".into());
    }
    if gate == Gate::Mainnet {
        let notional = price.mul(size);
        if notional > UD64::from(MAINNET_MAX_NOTIONAL_USD) {
            return Err(format!(
                "mainnet order notional ({notional}) exceeds the ${MAINNET_MAX_NOTIONAL_USD} canary ceiling"
            ));
        }
    }
    let order_request_id: u64 = required("order-request-id")?
        .parse()
        .map_err(|_| "invalid --order-request-id".to_string())?;
    let cancel_request_id: u64 = required("cancel-request-id")?
        .parse()
        .map_err(|_| "invalid --cancel-request-id".to_string())?;
    if order_request_id == cancel_request_id {
        return Err("--order-request-id and --cancel-request-id must differ".into());
    }
    let gas_limit: u64 = required("gas-limit")?
        .parse()
        .map_err(|_| "invalid --gas-limit".to_string())?;
    let chain_nonce: u64 = required("chain-nonce")?
        .parse()
        .map_err(|_| "invalid --chain-nonce".to_string())?;

    Ok(CanaryArgs {
        gate,
        signer_address,
        signer_key_file,
        perpetual_id,
        side,
        price,
        size,
        leverage,
        order_request_id,
        cancel_request_id,
        gas_limit,
        chain_nonce,
    })
}

fn build_order(args: &CanaryArgs) -> OrderRequest {
    let request_type = match args.side {
        Side::Buy => RequestType::OpenLong,
        Side::Sell => RequestType::OpenShort,
    };
    OrderRequest::new(
        args.order_request_id,
        args.perpetual_id,
        request_type,
        None,
        args.price,
        args.size,
        None,
        post_only_for_gate(args.gate),
        false,
        false,
        None,
        args.leverage,
        None,
        None,
        0,
    )
}

fn post_only_for_gate(gate: Gate) -> bool {
    gate == Gate::Mainnet
}

fn price_is_deliberately_passive(
    side: Side,
    price: UD64,
    best_bid: Option<UD64>,
    best_ask: Option<UD64>,
) -> bool {
    match side {
        Side::Buy => best_bid.is_some_and(|bid| price < bid),
        Side::Sell => best_ask.is_some_and(|ask| price > ask),
    }
}

fn validate_mainnet_non_crossing(
    args: &CanaryArgs,
    snapshot: &perpl_sdk::state::Exchange,
) -> Result<(), String> {
    let perp = snapshot
        .perpetuals()
        .get(&args.perpetual_id)
        .ok_or("mainnet canary perpetual missing from snapshot")?;
    let passive = price_is_deliberately_passive(
        args.side,
        args.price,
        perp.l3_book().best_bid().map(|(price, _)| price),
        perp.l3_book().best_ask().map(|(price, _)| price),
    );
    if !passive {
        return Err(
            "mainnet canary price is not deliberately passive against the refreshed order book; buys must be below best bid and sells above best ask"
                .into(),
        );
    }
    Ok(())
}

async fn run_testnet(args: CanaryArgs) -> Result<(), String> {
    let attestation =
        tx::TestnetAttestation::verify(protocol::TESTNET_CHAIN_ID, protocol::TESTNET_EXCHANGE)
            .map_err(|error| error.to_string())?;
    let gate = tx::SubmissionGate::explicitly_enabled(true);
    let worker = tx::WalletWorker::initialize(
        attestation,
        gate,
        FileSignerFactory {
            key_file: args.signer_key_file.clone(),
        },
    )?;
    let signer_address_from_key = worker.signer.address();
    if signer_address_from_key != args.signer_address {
        return Err(format!(
            "signer key file's address ({signer_address_from_key}) does not match --signer ({})",
            args.signer_address
        ));
    }
    let wallet = EthereumWallet::from(worker.signer.clone());

    let exchange_address: Address = protocol::TESTNET_EXCHANGE
        .parse()
        .map_err(|_| "invalid pinned testnet exchange address".to_string())?;
    let order = build_order(&args);

    let client = RpcClient::builder()
        .layer(ThrottleLayer::new(12))
        .layer(RetryBackoffLayer::new(5, 100, 200))
        .connect(tx::TESTNET_RPC)
        .await
        .map_err(|error| format!("RPC connection failed: {error}"))?;
    let provider = ProviderBuilder::new().wallet(wallet).connect_client(client);
    let chain = Chain::testnet();
    let snapshot_exchange = SnapshotBuilder::new(&chain, provider.clone())
        .with_perpetuals(vec![args.perpetual_id])
        .build()
        .await
        .map_err(|error| format!("snapshot failed: {error}"))?;
    let result = tx::run_testnet_canary(
        &worker,
        provider,
        gate,
        exchange_address,
        args.signer_address,
        &snapshot_exchange,
        order,
        args.order_request_id,
        args.perpetual_id,
        args.cancel_request_id,
        args.chain_nonce,
        args.gas_limit,
    )
    .await?;

    println!("account_id={}", result.account_id);
    println!("order_id={}", result.order_id);
    println!("order_tx={:#x}", result.order_tx);
    println!("cancel_tx={:#x}", result.cancel_tx);
    Ok(())
}

/// Mainnet counterpart of `run_testnet`. Fully duplicated (not shared) so the
/// testnet path above is untouched; calls only the `_mainnet`-suffixed
/// `tx::` functions, never the testnet ones. Reachable only once `parse_args`
/// has already confirmed `--gate=mainnet`, `--i-accept-mainnet-risk=yes`,
/// the mainnet perpetual allowlist, and the $20 notional ceiling.
async fn run_mainnet(args: CanaryArgs) -> Result<(), String> {
    let attestation =
        tx::MainnetAttestation::verify(protocol::MAINNET_CHAIN_ID, protocol::MAINNET_EXCHANGE)
            .map_err(|error| error.to_string())?;
    let gate = tx::SubmissionGate::explicitly_enabled(true);
    let worker = tx::MainnetWalletWorker::initialize(
        attestation,
        gate,
        FileSignerFactory {
            key_file: args.signer_key_file.clone(),
        },
    )?;
    let signer_address_from_key = worker.signer.address();
    if signer_address_from_key != args.signer_address {
        return Err(format!(
            "signer key file's address ({signer_address_from_key}) does not match --signer ({})",
            args.signer_address
        ));
    }
    let wallet = EthereumWallet::from(worker.signer.clone());

    let exchange_address: Address = protocol::MAINNET_EXCHANGE
        .parse()
        .map_err(|_| "invalid pinned mainnet exchange address".to_string())?;
    let order = build_order(&args);

    let client = RpcClient::builder()
        .layer(ThrottleLayer::new(12))
        .layer(RetryBackoffLayer::new(5, 100, 200))
        .connect(tx::MAINNET_RPC)
        .await
        .map_err(|error| format!("RPC connection failed: {error}"))?;
    let provider = ProviderBuilder::new().wallet(wallet).connect_client(client);
    let chain = Chain::mainnet();
    let snapshot_exchange = SnapshotBuilder::new(&chain, provider.clone())
        .with_perpetuals(vec![args.perpetual_id])
        .build()
        .await
        .map_err(|error| format!("snapshot failed: {error}"))?;
    validate_mainnet_non_crossing(&args, &snapshot_exchange)?;

    let result = tx::run_mainnet_canary(
        &worker,
        provider,
        gate,
        exchange_address,
        args.signer_address,
        &snapshot_exchange,
        order,
        args.order_request_id,
        args.perpetual_id,
        args.cancel_request_id,
        args.chain_nonce,
        args.gas_limit,
    )
    .await?;

    println!("account_id={}", result.account_id);
    println!("order_id={}", result.order_id);
    println!("order_tx={:#x}", result.order_tx);
    println!("cancel_tx={:#x}", result.cancel_tx);
    Ok(())
}

async fn run(args: CanaryArgs) -> Result<(), String> {
    match args.gate {
        Gate::Testnet => run_testnet(args).await,
        Gate::Mainnet => run_mainnet(args).await,
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let canary_args = match parse_args(&args) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("canary: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = run(canary_args).await {
        eprintln!("canary: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_args() -> Vec<String> {
        vec![
            "--gate=testnet".into(),
            "--signer=0x1111111111111111111111111111111111111111".into(),
            "--signer-key-file=/nonexistent/does-not-matter-for-parsing".into(),
            "--perpetual-id=16".into(),
            "--side=buy".into(),
            "--price=100".into(),
            "--size=1".into(),
            "--leverage=1".into(),
            "--order-request-id=1".into(),
            "--cancel-request-id=2".into(),
            "--gas-limit=1000000".into(),
            "--chain-nonce=0".into(),
        ]
    }

    #[test]
    fn accepts_a_fully_specified_testnet_request() {
        let parsed = parse_args(&valid_args()).unwrap();
        assert_eq!(parsed.perpetual_id, 16);
        assert_eq!(parsed.side, Side::Buy);
        assert_eq!(parsed.order_request_id, 1);
        assert_eq!(parsed.cancel_request_id, 2);
        assert_eq!(
            parsed.signer_key_file,
            PathBuf::from("/nonexistent/does-not-matter-for-parsing")
        );
    }

    #[test]
    fn rejects_missing_signer_key_file_flag() {
        let args: Vec<String> = valid_args()
            .into_iter()
            .filter(|arg| !arg.starts_with("--signer-key-file="))
            .collect();
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn rejects_missing_gate() {
        let args: Vec<String> = valid_args()
            .into_iter()
            .filter(|arg| !arg.starts_with("--gate="))
            .collect();
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn rejects_unrecognized_gate_literal() {
        for value in ["MAINNET", "TESTNET", "testnet ", "mainnet ", ""] {
            let mut args = valid_args();
            args[0] = format!("--gate={value}");
            assert!(
                parse_args(&args).is_err(),
                "expected rejection for gate={value:?}"
            );
        }
    }

    #[test]
    fn gate_is_checked_before_any_other_field() {
        // An invalid gate must be rejected even when every other field is also invalid.
        let args = vec!["--gate=sepolia".into(), "--signer=not-an-address".into()];
        let error = parse_args(&args).unwrap_err();
        assert!(error.contains("submission gate rejected"), "{error}");
    }

    #[test]
    fn rejects_unlisted_perpetual() {
        let mut args = valid_args();
        let idx = args
            .iter()
            .position(|arg| arg.starts_with("--perpetual-id="))
            .unwrap();
        args[idx] = "--perpetual-id=1".into();
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn rejects_malformed_argument() {
        let mut args = valid_args();
        args.push("not-a-flag".into());
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn rejects_unknown_argument() {
        let mut args = valid_args();
        args.push("--extra=1".into());
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn rejects_duplicate_argument() {
        let mut args = valid_args();
        args.push("--gate=testnet".into());
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn rejects_zero_price_size_or_leverage() {
        for flag in ["--price=", "--size=", "--leverage="] {
            let mut args = valid_args();
            let idx = args.iter().position(|arg| arg.starts_with(flag)).unwrap();
            args[idx] = format!("{flag}0");
            assert!(parse_args(&args).is_err(), "expected rejection for {flag}0");
        }
    }

    #[test]
    fn rejects_matching_order_and_cancel_request_ids() {
        let mut args = valid_args();
        let idx = args
            .iter()
            .position(|arg| arg.starts_with("--cancel-request-id="))
            .unwrap();
        args[idx] = "--cancel-request-id=1".into();
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn rejects_invalid_side() {
        let mut args = valid_args();
        let idx = args
            .iter()
            .position(|arg| arg.starts_with("--side="))
            .unwrap();
        args[idx] = "--side=hold".into();
        assert!(parse_args(&args).is_err());
    }

    fn valid_mainnet_args() -> Vec<String> {
        vec![
            "--gate=mainnet".into(),
            "--i-accept-mainnet-risk=yes".into(),
            "--signer=0x1111111111111111111111111111111111111111".into(),
            "--signer-key-file=/nonexistent/does-not-matter-for-parsing".into(),
            "--perpetual-id=1".into(),
            "--side=buy".into(),
            "--price=100".into(),
            "--size=0.1".into(),
            "--leverage=1".into(),
            "--order-request-id=1".into(),
            "--cancel-request-id=2".into(),
            "--gas-limit=1000000".into(),
            "--chain-nonce=0".into(),
        ]
    }

    #[test]
    fn accepts_a_fully_specified_mainnet_request_under_the_notional_ceiling() {
        let parsed = parse_args(&valid_mainnet_args()).unwrap();
        assert_eq!(parsed.gate, Gate::Mainnet);
        assert_eq!(parsed.perpetual_id, 1);
    }

    #[test]
    fn only_mainnet_orders_are_forced_post_only() {
        assert!(post_only_for_gate(Gate::Mainnet));
        assert!(!post_only_for_gate(Gate::Testnet));
    }

    #[test]
    fn passive_price_check_fails_closed_for_both_sides() {
        let bid: UD64 = "99".parse().unwrap();
        let ask: UD64 = "101".parse().unwrap();
        let passive_buy: UD64 = "98".parse().unwrap();
        let passive_sell: UD64 = "102".parse().unwrap();
        assert!(price_is_deliberately_passive(
            Side::Buy,
            passive_buy,
            Some(bid),
            Some(ask)
        ));
        assert!(price_is_deliberately_passive(
            Side::Sell,
            passive_sell,
            Some(bid),
            Some(ask)
        ));
        assert!(!price_is_deliberately_passive(
            Side::Buy,
            bid,
            Some(bid),
            Some(ask)
        ));
        assert!(!price_is_deliberately_passive(
            Side::Sell,
            ask,
            Some(bid),
            Some(ask)
        ));
        assert!(!price_is_deliberately_passive(
            Side::Buy,
            passive_buy,
            None,
            Some(ask)
        ));
        assert!(!price_is_deliberately_passive(
            Side::Sell,
            passive_sell,
            Some(bid),
            None
        ));
    }

    #[test]
    fn rejects_mainnet_gate_without_the_risk_acknowledgement() {
        let args: Vec<String> = valid_mainnet_args()
            .into_iter()
            .filter(|arg| !arg.starts_with("--i-accept-mainnet-risk="))
            .collect();
        let error = parse_args(&args).unwrap_err();
        assert!(error.contains("--i-accept-mainnet-risk=yes"), "{error}");
    }

    #[test]
    fn rejects_mainnet_gate_with_a_non_yes_risk_acknowledgement() {
        let mut args = valid_mainnet_args();
        let idx = args
            .iter()
            .position(|arg| arg.starts_with("--i-accept-mainnet-risk="))
            .unwrap();
        args[idx] = "--i-accept-mainnet-risk=true".into();
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn rejects_risk_acknowledgement_flag_under_testnet_gate() {
        let mut args = valid_args();
        args.push("--i-accept-mainnet-risk=yes".into());
        let error = parse_args(&args).unwrap_err();
        assert!(
            error.contains("only valid together with --gate=mainnet"),
            "{error}"
        );
    }

    #[test]
    fn rejects_unlisted_mainnet_perpetual() {
        let mut args = valid_mainnet_args();
        let idx = args
            .iter()
            .position(|arg| arg.starts_with("--perpetual-id="))
            .unwrap();
        args[idx] = "--perpetual-id=16".into();
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn accepts_the_real_mainnet_eth_perpetual() {
        let mut args = valid_mainnet_args();
        let idx = args
            .iter()
            .position(|arg| arg.starts_with("--perpetual-id="))
            .unwrap();
        args[idx] = "--perpetual-id=20".into();
        assert_eq!(parse_args(&args).unwrap().perpetual_id, 20);
    }

    #[test]
    fn rejects_mainnet_order_notional_over_the_20_dollar_ceiling() {
        let mut args = valid_mainnet_args();
        let price_idx = args.iter().position(|a| a.starts_with("--price=")).unwrap();
        let size_idx = args.iter().position(|a| a.starts_with("--size=")).unwrap();
        args[price_idx] = "--price=100".into();
        args[size_idx] = "--size=0.21".into(); // notional = 21 > 20
        let error = parse_args(&args).unwrap_err();
        assert!(error.contains("exceeds the $20"), "{error}");
    }

    #[test]
    fn accepts_mainnet_order_notional_exactly_at_the_20_dollar_ceiling() {
        let mut args = valid_mainnet_args();
        let price_idx = args.iter().position(|a| a.starts_with("--price=")).unwrap();
        let size_idx = args.iter().position(|a| a.starts_with("--size=")).unwrap();
        args[price_idx] = "--price=100".into();
        args[size_idx] = "--size=0.2".into(); // notional = exactly 20
        assert!(parse_args(&args).is_ok());
    }

    #[test]
    fn testnet_notional_is_never_checked_against_the_mainnet_ceiling() {
        let mut args = valid_args();
        let price_idx = args.iter().position(|a| a.starts_with("--price=")).unwrap();
        let size_idx = args.iter().position(|a| a.starts_with("--size=")).unwrap();
        args[price_idx] = "--price=1000000".into();
        args[size_idx] = "--size=5".into(); // notional = 5,000,000, fine on testnet
        assert!(parse_args(&args).is_ok());
    }

    // FileSignerFactory tests below use only a well-known, public, non-secret
    // placeholder scalar (0x...0001) to exercise parsing/error paths. This is
    // not key material for any real or intended-to-be-used account.
    use riim_perpl_bridge::tx::SignerFactory as _;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_key_file(contents: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "canary-test-key-{}-{unique}.txt",
            std::process::id()
        ));
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn file_signer_factory_parses_a_valid_hex_key() {
        let path =
            temp_key_file("0x0000000000000000000000000000000000000000000000000000000000000001");
        let result = (FileSignerFactory {
            key_file: path.clone(),
        })
        .initialize();
        std::fs::remove_file(&path).ok();
        let signer = result.unwrap();
        assert_ne!(signer.address(), Address::ZERO);
    }

    #[test]
    fn file_signer_factory_fails_closed_on_malformed_contents() {
        let path = temp_key_file("not-a-private-key");
        let result = (FileSignerFactory {
            key_file: path.clone(),
        })
        .initialize();
        std::fs::remove_file(&path).ok();
        assert!(result.is_err());
    }

    #[test]
    fn file_signer_factory_fails_closed_on_missing_file() {
        let path = std::env::temp_dir().join("canary-test-key-does-not-exist.txt");
        let result = (FileSignerFactory { key_file: path }).initialize();
        assert!(result.is_err());
    }
}
