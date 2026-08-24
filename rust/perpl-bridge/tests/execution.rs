use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use riim_perpl_bridge::{
    execution::{
        BackendFuture, ExecutionBackend, ExecutionBackendOutcome, ExecutionWorker, WorkerState,
    },
    protocol::{ExecutionIntent, decode_execution_intent},
};
use tokio::sync::{Mutex, Notify};

#[derive(Clone)]
struct FakeBackend {
    place_calls: Arc<AtomicUsize>,
    cancel_calls: Arc<AtomicUsize>,
    place_outcome: Arc<Mutex<ExecutionBackendOutcome>>,
    cancel_outcome: Arc<Mutex<ExecutionBackendOutcome>>,
    block_place: Arc<AtomicBool>,
    release: Arc<Notify>,
}

impl FakeBackend {
    fn new() -> Self {
        Self {
            place_calls: Arc::new(AtomicUsize::new(0)),
            cancel_calls: Arc::new(AtomicUsize::new(0)),
            place_outcome: Arc::new(Mutex::new(ExecutionBackendOutcome::Confirmed {
                exchange_order_id: "47".into(),
            })),
            cancel_outcome: Arc::new(Mutex::new(ExecutionBackendOutcome::Confirmed {
                exchange_order_id: "47".into(),
            })),
            block_place: Arc::new(AtomicBool::new(false)),
            release: Arc::new(Notify::new()),
        }
    }
}

impl ExecutionBackend for FakeBackend {
    fn place<'a>(&'a self, _intent: &'a ExecutionIntent) -> BackendFuture<'a> {
        Box::pin(async move {
            self.place_calls.fetch_add(1, Ordering::SeqCst);
            if self.block_place.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
            self.place_outcome.lock().await.clone()
        })
    }

    fn cancel<'a>(&'a self, _intent: &'a ExecutionIntent) -> BackendFuture<'a> {
        Box::pin(async move {
            self.cancel_calls.fetch_add(1, Ordering::SeqCst);
            self.cancel_outcome.lock().await.clone()
        })
    }
}

fn path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "riim-perpl-execution-{name}-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn place(action_id: &str) -> ExecutionIntent {
    decode_execution_intent(&format!(r#"{{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5071,"market":"BTCUSD","perpetualId":1,"actionId":"{action_id}","side":"buy","orderType":"postOnly","price":"77000","size":"0.00018","reduceOnly":false,"leverage":"1"}}"#)).unwrap()
}

fn cancel(action_id: &str, placement_action_id: &str, order_id: &str) -> ExecutionIntent {
    decode_execution_intent(&format!(r#"{{"version":1,"id":"y","action":"cancel","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5071,"market":"BTCUSD","perpetualId":1,"actionId":"{action_id}","exchangeOrderId":"{order_id}","placementActionId":"{placement_action_id}"}}"#)).unwrap()
}

#[tokio::test]
async fn confirms_one_placement_and_exact_cancellation() {
    let backend = FakeBackend::new();
    let worker = ExecutionWorker::open(backend.clone(), path("success")).unwrap();
    worker.place(&place("place-1")).await.unwrap();
    assert!(matches!(
        worker.status().await.state,
        WorkerState::Resting { .. }
    ));
    worker
        .cancel(&cancel("cancel-1", "place-1", "47"))
        .await
        .unwrap();
    assert_eq!(worker.status().await.state, WorkerState::Idle);
    assert_eq!(backend.place_calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.cancel_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejects_a_second_placement_until_exact_cancellation() {
    let worker = ExecutionWorker::open(FakeBackend::new(), path("one-at-a-time")).unwrap();
    worker.place(&place("place-1")).await.unwrap();
    assert!(
        worker
            .place(&place("place-2"))
            .await
            .unwrap_err()
            .contains("not idle")
    );
    assert!(
        worker
            .cancel(&cancel("cancel-1", "wrong", "47"))
            .await
            .unwrap_err()
            .contains("exact")
    );
}

#[tokio::test]
async fn ambiguous_placement_halts_and_is_never_retried() {
    let backend = FakeBackend::new();
    *backend.place_outcome.lock().await = ExecutionBackendOutcome::Ambiguous {
        reason: "timeout".into(),
    };
    let worker = ExecutionWorker::open(backend.clone(), path("ambiguous")).unwrap();
    worker.place(&place("place-1")).await.unwrap();
    assert!(matches!(
        worker.status().await.state,
        WorkerState::Halted { .. }
    ));
    assert!(worker.place(&place("place-2")).await.is_err());
    assert_eq!(backend.place_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn wrong_cancellation_identity_halts() {
    let backend = FakeBackend::new();
    let worker = ExecutionWorker::open(backend.clone(), path("wrong-cancel")).unwrap();
    worker.place(&place("place-1")).await.unwrap();
    *backend.cancel_outcome.lock().await = ExecutionBackendOutcome::Confirmed {
        exchange_order_id: "99".into(),
    };
    worker
        .cancel(&cancel("cancel-1", "place-1", "47"))
        .await
        .unwrap();
    assert!(matches!(
        worker.status().await.state,
        WorkerState::Halted { .. }
    ));
}

#[tokio::test]
async fn duplicate_action_ids_survive_a_completed_cycle() {
    let worker = ExecutionWorker::open(FakeBackend::new(), path("duplicate")).unwrap();
    worker.place(&place("place-1")).await.unwrap();
    worker
        .cancel(&cancel("cancel-1", "place-1", "47"))
        .await
        .unwrap();
    assert!(
        worker
            .place(&place("place-1"))
            .await
            .unwrap_err()
            .contains("duplicate")
    );
}

#[tokio::test]
async fn restart_with_unresolved_state_persists_a_halt() {
    let journal_path = path("restart");
    fs::write(&journal_path, r#"{"version":1,"state":{"state":"resting","market":"BTCUSD","placement_action_id":"place-1","exchange_order_id":"47"},"seen_action_ids":["place-1"]}"#).unwrap();
    let worker = ExecutionWorker::open(FakeBackend::new(), &journal_path).unwrap();
    assert!(matches!(
        worker.status().await.state,
        WorkerState::Halted { .. }
    ));
    let persisted = fs::read_to_string(journal_path).unwrap();
    assert!(persisted.contains("manual review required"));
}

#[tokio::test]
async fn rejects_concurrent_actions_before_a_second_backend_call() {
    let backend = FakeBackend::new();
    backend.block_place.store(true, Ordering::SeqCst);
    let worker = Arc::new(ExecutionWorker::open(backend.clone(), path("concurrent")).unwrap());
    let first_worker = worker.clone();
    let first = tokio::spawn(async move { first_worker.place(&place("place-1")).await });
    while backend.place_calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    assert!(
        worker
            .place(&place("place-2"))
            .await
            .unwrap_err()
            .contains("already in progress")
    );
    backend.release.notify_one();
    first.await.unwrap().unwrap();
    assert_eq!(backend.place_calls.load(Ordering::SeqCst), 1);
}
