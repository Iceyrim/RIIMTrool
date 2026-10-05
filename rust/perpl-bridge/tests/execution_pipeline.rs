use riim_perpl_bridge::{
    execution::{ExecutionWorker, WorkerState},
    execution_backend::{
        ExecutionEnablement, MainnetExecutionBackend, MainnetTransactionPort, PreparedCancellation,
        PreparedPlacement, TransactionPortFuture, TransactionPortOutcome,
    },
    protocol::{ExecutionIntent, MAINNET_CHAIN_ID, MAINNET_EXCHANGE, decode_execution_intent},
};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::Mutex;

#[derive(Clone)]
struct FakePort {
    calls: Arc<AtomicUsize>,
    outcome: Arc<Mutex<TransactionPortOutcome>>,
}
impl FakePort {
    fn new() -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            outcome: Arc::new(Mutex::new(TransactionPortOutcome::Confirmed {
                exchange_order_id: "47".into(),
            })),
        }
    }
}
impl MainnetTransactionPort for FakePort {
    fn place<'a>(&'a self, _: PreparedPlacement) -> TransactionPortFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.outcome.lock().await.clone()
        })
    }
    fn cancel<'a>(&'a self, _: PreparedCancellation) -> TransactionPortFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.outcome.lock().await.clone()
        })
    }
}
struct Enabled;
impl ExecutionEnablement for Enabled {
    fn is_enabled(&self) -> bool {
        true
    }
}

fn path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "perpl-pipeline-{name}-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
fn place() -> ExecutionIntent {
    decode_execution_intent(r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5071,"market":"BTCUSD","perpetualId":1,"actionId":"2026082601","side":"buy","orderType":"postOnly","price":"77000","size":"0.00018","reduceOnly":false,"leverage":"1"}"#).unwrap()
}
fn cancel() -> ExecutionIntent {
    decode_execution_intent(r#"{"version":1,"id":"y","action":"cancel","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5071,"market":"BTCUSD","perpetualId":1,"actionId":"2026082602","exchangeOrderId":"47","placementActionId":"2026082601"}"#).unwrap()
}

#[tokio::test]
async fn production_disabled_pipeline_halts_without_touching_port() {
    let port = FakePort::new();
    let backend =
        MainnetExecutionBackend::disabled(port.clone(), MAINNET_CHAIN_ID, MAINNET_EXCHANGE, 5071)
            .unwrap();
    let worker = ExecutionWorker::open(backend, path("disabled")).unwrap();
    worker.place(&place()).await.unwrap();
    assert!(matches!(
        worker.status().await.state,
        WorkerState::Halted { .. }
    ));
    assert_eq!(port.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn fake_pipeline_completes_one_exact_cycle() {
    let port = FakePort::new();
    let backend = MainnetExecutionBackend::new(
        port.clone(),
        Enabled,
        MAINNET_CHAIN_ID,
        MAINNET_EXCHANGE,
        5071,
    )
    .unwrap();
    let worker = ExecutionWorker::open(backend, path("success")).unwrap();
    worker.place(&place()).await.unwrap();
    worker.cancel(&cancel()).await.unwrap();
    assert_eq!(worker.status().await.state, WorkerState::Idle);
    assert_eq!(port.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn ambiguous_pipeline_halt_survives_restart() {
    let journal = path("ambiguous");
    let port = FakePort::new();
    *port.outcome.lock().await = TransactionPortOutcome::Ambiguous {
        reason: "timeout".into(),
    };
    let backend = MainnetExecutionBackend::new(
        port.clone(),
        Enabled,
        MAINNET_CHAIN_ID,
        MAINNET_EXCHANGE,
        5071,
    )
    .unwrap();
    let worker = ExecutionWorker::open(backend, &journal).unwrap();
    worker.place(&place()).await.unwrap();
    assert!(matches!(
        worker.status().await.state,
        WorkerState::Halted { .. }
    ));
    let backend = MainnetExecutionBackend::disabled(
        FakePort::new(),
        MAINNET_CHAIN_ID,
        MAINNET_EXCHANGE,
        5071,
    )
    .unwrap();
    let restarted = ExecutionWorker::open(backend, &journal).unwrap();
    assert!(matches!(
        restarted.status().await.state,
        WorkerState::Halted { .. }
    ));
    assert!(
        fs::read_to_string(journal)
            .unwrap()
            .contains("manual review")
    );
}
