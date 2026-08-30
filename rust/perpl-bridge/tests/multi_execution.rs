use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use riim_perpl_bridge::{
    execution::{BackendFuture, ExecutionBackend, ExecutionBackendOutcome},
    multi_execution::MultiOrderExecutionWorker,
    protocol::{ExecutionIntent, MAINNET_EXCHANGE},
};

struct FakeBackend {
    outcomes: Mutex<Vec<ExecutionBackendOutcome>>,
}

fn journal_path() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let root = std::env::temp_dir().join(format!(
        "riim-perpl-multi-execution-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    root.join("journal.json")
}

impl FakeBackend {
    fn confirmed(ids: &[&str]) -> Self {
        Self {
            outcomes: Mutex::new(
                ids.iter()
                    .rev()
                    .map(|id| ExecutionBackendOutcome::Confirmed {
                        exchange_order_id: (*id).into(),
                    })
                    .collect(),
            ),
        }
    }

    fn next(&self) -> ExecutionBackendOutcome {
        self.outcomes.lock().unwrap().pop().unwrap()
    }
}

impl ExecutionBackend for FakeBackend {
    fn place<'a>(&'a self, _intent: &'a ExecutionIntent) -> BackendFuture<'a> {
        Box::pin(async move { self.next() })
    }

    fn cancel<'a>(&'a self, _intent: &'a ExecutionIntent) -> BackendFuture<'a> {
        Box::pin(async move { self.next() })
    }
}

fn place(action: &str) -> ExecutionIntent {
    ExecutionIntent::Place {
        version: 1,
        id: format!("request-{action}"),
        chain_id: 143,
        exchange: MAINNET_EXCHANGE.into(),
        account_id: 5071,
        market: "BTCUSD".into(),
        perpetual_id: 1,
        action_id: action.into(),
        side: "buy".into(),
        order_type: "postOnly".into(),
        price: "75000".into(),
        size: "0.00018".into(),
        reduce_only: false,
        leverage: "1".into(),
    }
}

fn cancel(action: &str, placement: &str, order: &str) -> ExecutionIntent {
    ExecutionIntent::Cancel {
        version: 1,
        id: format!("request-{action}"),
        chain_id: 143,
        exchange: MAINNET_EXCHANGE.into(),
        account_id: 5071,
        market: "BTCUSD".into(),
        perpetual_id: 1,
        action_id: action.into(),
        exchange_order_id: order.into(),
        placement_action_id: placement.into(),
    }
}

#[tokio::test]
async fn tracks_multiple_orders_and_exact_independent_cleanup() {
    let worker = MultiOrderExecutionWorker::open(
        FakeBackend::confirmed(&["47", "48", "47", "48"]),
        journal_path(),
        4,
    )
    .unwrap();
    assert_eq!(worker.place(&place("101")).await.unwrap(), "47");
    assert_eq!(worker.place(&place("102")).await.unwrap(), "48");
    assert_eq!(worker.status().await.orders.len(), 2);
    assert!(worker.cancel(&cancel("103", "101", "48")).await.is_err());
    assert_eq!(
        worker.cancel(&cancel("104", "101", "47")).await.unwrap(),
        "47"
    );
    assert_eq!(
        worker.cancel(&cancel("105", "102", "48")).await.unwrap(),
        "48"
    );
    assert!(worker.status().await.is_idle());
}

#[tokio::test]
async fn ambiguous_action_halts_without_dropping_managed_orders() {
    let backend = FakeBackend {
        outcomes: Mutex::new(vec![
            ExecutionBackendOutcome::Ambiguous {
                reason: "receipt timeout".into(),
            },
            ExecutionBackendOutcome::Confirmed {
                exchange_order_id: "47".into(),
            },
        ]),
    };
    let worker = MultiOrderExecutionWorker::open(backend, journal_path(), 4).unwrap();
    worker.place(&place("201")).await.unwrap();
    assert!(worker.cancel(&cancel("202", "201", "47")).await.is_err());
    let status = worker.status().await;
    assert_eq!(status.orders.len(), 1);
    assert!(status.halted_reason.unwrap().contains("timeout"));
}

#[tokio::test]
async fn restart_with_managed_orders_halts_for_review() {
    let path = journal_path();
    let worker =
        MultiOrderExecutionWorker::open(FakeBackend::confirmed(&["47"]), &path, 4).unwrap();
    worker.place(&place("301")).await.unwrap();
    drop(worker);
    let restarted = MultiOrderExecutionWorker::open(FakeBackend::confirmed(&[]), &path, 4).unwrap();
    assert!(restarted.status().await.halted_reason.is_some());
}
