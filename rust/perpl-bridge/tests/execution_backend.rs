use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use riim_perpl_bridge::{
    execution::{ExecutionBackend, ExecutionBackendOutcome},
    execution_backend::{
        ExecutionEnablement, MainnetExecutionBackend, MainnetTransactionPort, PreparedCancellation,
        PreparedPlacement, TransactionPortFuture, TransactionPortOutcome,
    },
    protocol::{ExecutionIntent, MAINNET_CHAIN_ID, MAINNET_EXCHANGE, decode_execution_intent},
};
use tokio::sync::Mutex;

#[derive(Clone)]
struct FakePort {
    place_calls: Arc<AtomicUsize>,
    cancel_calls: Arc<AtomicUsize>,
    placement_audits: Arc<Mutex<Vec<riim_perpl_bridge::execution_backend::ActionAudit>>>,
    cancellation_audits: Arc<Mutex<Vec<riim_perpl_bridge::execution_backend::ActionAudit>>>,
    outcome: Arc<Mutex<TransactionPortOutcome>>,
}

impl FakePort {
    fn new() -> Self {
        Self {
            place_calls: Arc::new(AtomicUsize::new(0)),
            cancel_calls: Arc::new(AtomicUsize::new(0)),
            placement_audits: Arc::new(Mutex::new(Vec::new())),
            cancellation_audits: Arc::new(Mutex::new(Vec::new())),
            outcome: Arc::new(Mutex::new(TransactionPortOutcome::Confirmed {
                exchange_order_id: "47".into(),
            })),
        }
    }
}

impl MainnetTransactionPort for FakePort {
    fn place<'a>(&'a self, action: PreparedPlacement) -> TransactionPortFuture<'a> {
        Box::pin(async move {
            self.place_calls.fetch_add(1, Ordering::SeqCst);
            self.placement_audits.lock().await.push(action.audit);
            self.outcome.lock().await.clone()
        })
    }

    fn cancel<'a>(&'a self, action: PreparedCancellation) -> TransactionPortFuture<'a> {
        Box::pin(async move {
            self.cancel_calls.fetch_add(1, Ordering::SeqCst);
            self.cancellation_audits.lock().await.push(action.audit);
            self.outcome.lock().await.clone()
        })
    }
}

struct EnabledForTest;
impl ExecutionEnablement for EnabledForTest {
    fn is_enabled(&self) -> bool {
        true
    }
}

fn place() -> ExecutionIntent {
    decode_execution_intent(r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5071,"market":"BTCUSD","perpetualId":1,"actionId":"2026082501","side":"buy","orderType":"postOnly","price":"77000","size":"0.00018","reduceOnly":false,"leverage":"1"}"#).unwrap()
}

fn cancel() -> ExecutionIntent {
    decode_execution_intent(r#"{"version":1,"id":"y","action":"cancel","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5071,"market":"BTCUSD","perpetualId":1,"actionId":"2026082502","exchangeOrderId":"47","placementActionId":"2026082501"}"#).unwrap()
}

#[tokio::test]
async fn production_disabled_mode_never_touches_the_port() {
    let port = FakePort::new();
    let backend =
        MainnetExecutionBackend::disabled(port.clone(), MAINNET_CHAIN_ID, MAINNET_EXCHANGE, 5071)
            .unwrap();
    assert!(matches!(
        backend.place(&place()).await,
        ExecutionBackendOutcome::Rejected { .. }
    ));
    assert!(matches!(
        backend.cancel(&cancel()).await,
        ExecutionBackendOutcome::Rejected { .. }
    ));
    assert_eq!(port.place_calls.load(Ordering::SeqCst), 0);
    assert_eq!(port.cancel_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn maps_exact_sdk_placement_and_cancellation_audits_with_a_fake_port() {
    let port = FakePort::new();
    let backend = MainnetExecutionBackend::new(
        port.clone(),
        EnabledForTest,
        MAINNET_CHAIN_ID,
        MAINNET_EXCHANGE,
        5071,
    )
    .unwrap();
    assert_eq!(
        backend.place(&place()).await,
        ExecutionBackendOutcome::Confirmed {
            exchange_order_id: "47".into()
        }
    );
    assert_eq!(
        backend.cancel(&cancel()).await,
        ExecutionBackendOutcome::Confirmed {
            exchange_order_id: "47".into()
        }
    );
    assert_eq!(
        port.placement_audits.lock().await.as_slice(),
        [riim_perpl_bridge::execution_backend::ActionAudit {
            action_id: "2026082501".into(),
            request_id: 2026082501,
            market: "BTCUSD".into(),
            perpetual_id: 1,
            exchange_order_id: None,
            post_only: true,
            leverage: "1".into(),
        }]
    );
    assert_eq!(
        port.cancellation_audits.lock().await[0].exchange_order_id,
        Some(47)
    );
}

#[tokio::test]
async fn rejects_nonnumeric_protocol_ids_before_the_port() {
    let port = FakePort::new();
    let backend = MainnetExecutionBackend::new(
        port.clone(),
        EnabledForTest,
        MAINNET_CHAIN_ID,
        MAINNET_EXCHANGE,
        5071,
    )
    .unwrap();
    let intent = decode_execution_intent(r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5071,"market":"BTCUSD","perpetualId":1,"actionId":"place-1","side":"buy","orderType":"postOnly","price":"77000","size":"0.00018","reduceOnly":false,"leverage":"1"}"#).unwrap();
    assert!(matches!(
        backend.place(&intent).await,
        ExecutionBackendOutcome::Rejected { .. }
    ));
    assert_eq!(port.place_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn preserves_rejected_and_ambiguous_results_without_retrying() {
    for outcome in [
        TransactionPortOutcome::Rejected {
            reason: "denied".into(),
        },
        TransactionPortOutcome::Ambiguous {
            reason: "timeout".into(),
        },
    ] {
        let port = FakePort::new();
        *port.outcome.lock().await = outcome;
        let backend = MainnetExecutionBackend::new(
            port.clone(),
            EnabledForTest,
            MAINNET_CHAIN_ID,
            MAINNET_EXCHANGE,
            5071,
        )
        .unwrap();
        let result = backend.place(&place()).await;
        assert!(matches!(
            result,
            ExecutionBackendOutcome::Rejected { .. } | ExecutionBackendOutcome::Ambiguous { .. }
        ));
        assert_eq!(port.place_calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn rejects_wrong_mainnet_attestation_or_account_before_construction() {
    assert!(
        MainnetExecutionBackend::disabled(FakePort::new(), 10143, MAINNET_EXCHANGE, 5071).is_err()
    );
    assert!(
        MainnetExecutionBackend::disabled(FakePort::new(), MAINNET_CHAIN_ID, MAINNET_EXCHANGE, 25)
            .is_err()
    );
}
