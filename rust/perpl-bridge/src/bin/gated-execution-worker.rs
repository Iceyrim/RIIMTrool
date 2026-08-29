use std::{
    collections::BTreeMap, os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc, time::Duration,
};

use alloy::{
    network::EthereumWallet,
    primitives::{Address, U256},
    providers::{Provider, ProviderBuilder},
    rpc::client::RpcClient,
    transports::layers::{RetryBackoffLayer, ThrottleLayer},
};
use perpl_sdk::{Chain, state::SnapshotBuilder, types::AccountAddressOrID};
use riim_perpl_bridge::{
    canary_support::FileSignerFactory,
    execution::{ExecutionWorker, WorkerState},
    execution_backend::{ExecutionEnablement, MainnetExecutionBackend},
    execution_port::{SdkMainnetTransactionPort, SdkMainnetTransactionPortConfig},
    protocol::{
        ExecutionIntent, MAINNET_CHAIN_ID, MAINNET_EXCHANGE, VERSION, decode_execution_intent,
    },
    tx::{self, MainnetAttestation, MainnetWalletWorker, SubmissionGate},
};
use serde::Serialize;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    sync::RwLock,
};

#[derive(Debug)]
struct Args {
    signer: Address,
    signer_key_file: PathBuf,
    journal_path: PathBuf,
    socket_path: PathBuf,
    chain_nonce: u64,
    gas_limit: u64,
    max_snapshot_lag_blocks: u64,
}

struct ExplicitEnablement;
impl ExecutionEnablement for ExplicitEnablement {
    fn is_enabled(&self) -> bool {
        true
    }
}

struct SocketGuard(PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Outcome {
    Confirmed {
        version: u8,
        id: String,
        #[serde(rename = "actionId")]
        action_id: String,
        #[serde(rename = "exchangeOrderId")]
        exchange_order_id: String,
    },
    Rejected {
        version: u8,
        id: String,
        #[serde(rename = "actionId")]
        action_id: String,
        reason: String,
    },
    Ambiguous {
        version: u8,
        id: String,
        #[serde(rename = "actionId")]
        action_id: String,
        reason: String,
    },
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("gated execution worker: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = parse_args(&std::env::args().skip(1).collect::<Vec<_>>())?;
    let attestation =
        MainnetAttestation::verify(MAINNET_CHAIN_ID, MAINNET_EXCHANGE).map_err(str::to_string)?;
    let client = RpcClient::builder()
        .layer(RetryBackoffLayer::new(5, 100, 200))
        .connect(tx::MAINNET_RPC)
        .await
        .map_err(|error| format!("RPC connection failed: {error}"))?;
    let readonly = ProviderBuilder::new().connect_client(client);
    let chain_id = tokio::time::timeout(Duration::from_secs(10), readonly.get_chain_id())
        .await
        .map_err(|_| "RPC chain-id check timed out".to_string())?
        .map_err(|error| format!("RPC chain-id check failed: {error}"))?;
    if chain_id != MAINNET_CHAIN_ID {
        return Err("RPC is not pinned Monad mainnet".into());
    }

    let signer = MainnetWalletWorker::initialize(
        attestation,
        SubmissionGate::explicitly_enabled(true),
        FileSignerFactory {
            key_file: args.signer_key_file.clone(),
        },
    )?
    .signer;
    if signer.address() != args.signer {
        return Err("signer key file does not match --signer".into());
    }
    let wallet = EthereumWallet::from(signer);
    let client = RpcClient::builder()
        .layer(ThrottleLayer::new(12))
        .layer(RetryBackoffLayer::new(5, 100, 200))
        .connect(tx::MAINNET_RPC)
        .await
        .map_err(|error| format!("wallet RPC connection failed: {error}"))?;
    let provider = ProviderBuilder::new().wallet(wallet).connect_client(client);
    let exchange_address: Address = MAINNET_EXCHANGE
        .parse()
        .map_err(|_| "invalid pinned exchange")?;
    let account =
        tx::read_account_setup_context(provider.clone(), exchange_address, args.signer).await?;
    if account.account_id != U256::from(5071u32) {
        return Err("signer is not mapped to pinned account 5071".into());
    }
    let chain = Chain::mainnet();
    let snapshot = SnapshotBuilder::new(&chain, readonly.clone())
        .with_perpetuals(vec![1, 20])
        .with_accounts(vec![AccountAddressOrID::ID(5071)])
        .build()
        .await
        .map_err(|error| format!("execution snapshot failed: {error}"))?;
    let port = SdkMainnetTransactionPort::new(SdkMainnetTransactionPortConfig {
        provider,
        state_provider: readonly,
        attestation,
        gate: SubmissionGate::explicitly_enabled(true),
        snapshot: Arc::new(RwLock::new(snapshot)),
        exchange_address,
        signer_address: args.signer,
        account_id: U256::from(5071u32),
        pending_nonce: args.chain_nonce,
        gas_limit: args.gas_limit,
        max_snapshot_lag_blocks: args.max_snapshot_lag_blocks,
    })?;
    let backend = MainnetExecutionBackend::new(
        port,
        ExplicitEnablement,
        MAINNET_CHAIN_ID,
        MAINNET_EXCHANGE,
        5071,
    )?;
    let worker = ExecutionWorker::open(backend, args.journal_path)?;
    serve(worker, args.socket_path).await
}

async fn serve<B: riim_perpl_bridge::execution::ExecutionBackend>(
    worker: ExecutionWorker<B>,
    socket_path: PathBuf,
) -> Result<(), String> {
    let listener = UnixListener::bind(&socket_path)
        .map_err(|error| format!("execution socket bind failed: {error}"))?;
    let _socket_guard = SocketGuard(socket_path.clone());
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("execution socket permissions failed: {error}"))?;
    let (connection, _) = listener
        .accept()
        .await
        .map_err(|error| format!("execution socket accept failed: {error}"))?;
    drop(listener);
    let (reader, mut writer) = connection.into_split();
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let intent = decode_execution_intent(&line)?;
        let (id, action_id) = identity(&intent);
        let before = worker.status().await.state;
        let outcome = if let WorkerState::Halted { reason } = before {
            Outcome::Ambiguous {
                version: VERSION,
                id,
                action_id,
                reason,
            }
        } else {
            let cancelled_order = match &intent {
                ExecutionIntent::Cancel {
                    exchange_order_id, ..
                } => Some(exchange_order_id.clone()),
                _ => None,
            };
            let result = match &intent {
                ExecutionIntent::Place { .. } => worker.place(&intent).await,
                ExecutionIntent::Cancel { .. } => worker.cancel(&intent).await,
            };
            match result {
                Err(reason) => Outcome::Rejected {
                    version: VERSION,
                    id,
                    action_id,
                    reason,
                },
                Ok(()) => map_state(worker.status().await.state, id, action_id, cancelled_order),
            }
        };
        let mut bytes = serde_json::to_vec(&outcome).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        writer
            .write_all(&bytes)
            .await
            .map_err(|error| error.to_string())?;
        writer.flush().await.map_err(|error| error.to_string())?;
    }
    match worker.status().await.state {
        WorkerState::Idle => Ok(()),
        _ => Err("execution client disconnected with unresolved worker state".into()),
    }
}

fn map_state(
    state: WorkerState,
    id: String,
    action_id: String,
    cancelled_order: Option<String>,
) -> Outcome {
    match state {
        WorkerState::Resting {
            exchange_order_id, ..
        } => Outcome::Confirmed {
            version: VERSION,
            id,
            action_id,
            exchange_order_id,
        },
        WorkerState::Idle => Outcome::Confirmed {
            version: VERSION,
            id,
            action_id,
            exchange_order_id: cancelled_order.unwrap_or_default(),
        },
        WorkerState::Halted { reason } => Outcome::Ambiguous {
            version: VERSION,
            id,
            action_id,
            reason,
        },
        _ => Outcome::Ambiguous {
            version: VERSION,
            id,
            action_id,
            reason: "worker retained unresolved pending state".into(),
        },
    }
}

fn identity(intent: &ExecutionIntent) -> (String, String) {
    match intent {
        ExecutionIntent::Place { id, action_id, .. }
        | ExecutionIntent::Cancel { id, action_id, .. } => (id.clone(), action_id.clone()),
    }
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut map = BTreeMap::new();
    for arg in args {
        let (key, value) = arg
            .strip_prefix("--")
            .and_then(|value| value.split_once('='))
            .ok_or("arguments must be --key=value")?;
        if map.insert(key, value).is_some() {
            return Err(format!("duplicate --{key}"));
        }
    }
    let required = |key| {
        map.get(key)
            .copied()
            .ok_or_else(|| format!("missing --{key}"))
    };
    if required("gate")? != "mainnet"
        || required("i-accept-mainnet-risk")? != "yes"
        || required("execution-mode")? != "single-order"
    {
        return Err("gated worker requires --gate=mainnet --i-accept-mainnet-risk=yes --execution-mode=single-order".into());
    }
    let known = [
        "gate",
        "i-accept-mainnet-risk",
        "execution-mode",
        "signer",
        "signer-key-file",
        "journal-path",
        "socket-path",
        "chain-nonce",
        "gas-limit",
        "max-snapshot-lag-blocks",
    ];
    if let Some(key) = map.keys().find(|key| !known.contains(key)) {
        return Err(format!("unknown --{key}"));
    }
    let signer = required("signer")?
        .parse()
        .map_err(|_| "invalid --signer")?;
    let signer_key_file = PathBuf::from(required("signer-key-file")?);
    let journal_path = PathBuf::from(required("journal-path")?);
    let socket_path = PathBuf::from(required("socket-path")?);
    if socket_path.as_os_str().is_empty() || socket_path.exists() {
        return Err("execution socket path must be non-empty and absent".into());
    }
    let chain_nonce = required("chain-nonce")?
        .parse()
        .map_err(|_| "invalid --chain-nonce")?;
    let gas_limit = required("gas-limit")?
        .parse()
        .map_err(|_| "invalid --gas-limit")?;
    if gas_limit == 0 || gas_limit > tx::MAINNET_MAX_GAS_LIMIT {
        return Err("invalid --gas-limit".into());
    }
    let max_snapshot_lag_blocks = required("max-snapshot-lag-blocks")?
        .parse()
        .map_err(|_| "invalid --max-snapshot-lag-blocks")?;
    if max_snapshot_lag_blocks == 0 || max_snapshot_lag_blocks > 5 {
        return Err("snapshot lag must be 1..5 blocks".into());
    }
    Ok(Args {
        signer,
        signer_key_file,
        journal_path,
        socket_path,
        chain_nonce,
        gas_limit,
        max_snapshot_lag_blocks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn valid() -> Vec<String> {
        vec![
            "--gate=mainnet",
            "--i-accept-mainnet-risk=yes",
            "--execution-mode=single-order",
            "--signer=0x1111111111111111111111111111111111111111",
            "--signer-key-file=/never/read",
            "--journal-path=/tmp/journal",
            "--socket-path=/tmp/riimtrool-never-created.sock",
            "--chain-nonce=1",
            "--gas-limit=1300000",
            "--max-snapshot-lag-blocks=2",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    }
    #[test]
    fn accepts_exact_gate_without_reading_key() {
        assert!(parse_args(&valid()).is_ok());
    }
    #[test]
    fn rejects_missing_or_wrong_gate() {
        for index in 0..3 {
            let mut args = valid();
            args[index].push_str("-wrong");
            assert!(parse_args(&args).is_err());
        }
    }
    #[test]
    fn rejects_unknown_duplicate_and_excess_limits() {
        let mut a = valid();
        a.push("--wallet=x".into());
        assert!(parse_args(&a).is_err());
        let mut a = valid();
        a.push("--gate=mainnet".into());
        assert!(parse_args(&a).is_err());
        let mut a = valid();
        a[8] = "--gas-limit=1300001".into();
        assert!(parse_args(&a).is_err());
    }
}
