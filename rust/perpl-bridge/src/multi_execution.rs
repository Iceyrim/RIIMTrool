use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::{
    execution::{ExecutionBackend, ExecutionBackendOutcome},
    protocol::{ExecutionIntent, validate_execution_intent},
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagedExecutionOrder {
    pub market: String,
    pub placement_action_id: String,
    pub exchange_order_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PendingAction {
    Place {
        market: String,
        action_id: String,
    },
    Cancel {
        market: String,
        action_id: String,
        placement_action_id: String,
        exchange_order_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MultiExecutionJournal {
    version: u8,
    pub halted_reason: Option<String>,
    pub orders: Vec<ManagedExecutionOrder>,
    pending: Option<PendingAction>,
    seen_action_ids: Vec<String>,
}

impl MultiExecutionJournal {
    fn empty() -> Self {
        Self {
            version: 1,
            halted_reason: None,
            orders: Vec::new(),
            pending: None,
            seen_action_ids: Vec::new(),
        }
    }

    pub fn is_idle(&self) -> bool {
        self.halted_reason.is_none() && self.pending.is_none() && self.orders.is_empty()
    }
}

/// Durable multi-order execution state machine for the explicitly gated Perpl live worker.
/// Actions remain serialized and every intent is persisted before the backend is called.
pub struct MultiOrderExecutionWorker<B: ExecutionBackend> {
    backend: B,
    journal_path: PathBuf,
    max_open_orders: usize,
    journal: Mutex<MultiExecutionJournal>,
    busy: AtomicBool,
}

impl<B: ExecutionBackend> MultiOrderExecutionWorker<B> {
    pub fn open(
        backend: B,
        journal_path: impl Into<PathBuf>,
        max_open_orders: usize,
    ) -> Result<Self, String> {
        if max_open_orders == 0 || max_open_orders > 12 {
            return Err("multi-order execution capacity must be 1..12".into());
        }
        let journal_path = journal_path.into();
        let mut journal = load_journal(&journal_path)?;
        if journal.pending.is_some() || !journal.orders.is_empty() {
            journal.halted_reason = Some(
                "startup found unresolved multi-order execution state; manual review required"
                    .into(),
            );
            persist_journal(&journal_path, &journal)?;
        }
        Ok(Self {
            backend,
            journal_path,
            max_open_orders,
            journal: Mutex::new(journal),
            busy: AtomicBool::new(false),
        })
    }

    pub async fn status(&self) -> MultiExecutionJournal {
        self.journal.lock().await.clone()
    }

    pub async fn place(&self, intent: &ExecutionIntent) -> Result<String, String> {
        self.enter()?;
        let result = self.place_inner(intent).await;
        self.busy.store(false, Ordering::Release);
        result
    }

    pub async fn cancel(&self, intent: &ExecutionIntent) -> Result<String, String> {
        self.enter()?;
        let result = self.cancel_inner(intent).await;
        self.busy.store(false, Ordering::Release);
        result
    }

    async fn place_inner(&self, intent: &ExecutionIntent) -> Result<String, String> {
        validate_execution_intent(intent)?;
        let ExecutionIntent::Place {
            market, action_id, ..
        } = intent
        else {
            return Err("multi-order placement requires a placement intent".into());
        };
        {
            let mut journal = self.journal.lock().await;
            require_healthy_new_action(&journal, action_id)?;
            if journal.orders.len() >= self.max_open_orders {
                return Err("multi-order execution capacity is exhausted".into());
            }
            journal.seen_action_ids.push(action_id.clone());
            journal.pending = Some(PendingAction::Place {
                market: market.clone(),
                action_id: action_id.clone(),
            });
            self.persist(&journal)?;
        }
        let outcome = self.backend.place(intent).await;
        let mut journal = self.journal.lock().await;
        journal.pending = None;
        match outcome {
            ExecutionBackendOutcome::Confirmed { exchange_order_id }
                if !exchange_order_id.is_empty()
                    && !journal
                        .orders
                        .iter()
                        .any(|order| order.exchange_order_id == exchange_order_id) =>
            {
                journal.orders.push(ManagedExecutionOrder {
                    market: market.clone(),
                    placement_action_id: action_id.clone(),
                    exchange_order_id: exchange_order_id.clone(),
                });
                self.persist(&journal)?;
                Ok(exchange_order_id)
            }
            ExecutionBackendOutcome::Confirmed { .. } => {
                self.halt(
                    &mut journal,
                    "placement returned an invalid or duplicate order identity",
                )?;
                Err("placement outcome is ambiguous".into())
            }
            ExecutionBackendOutcome::Rejected { reason } => {
                self.halt(&mut journal, &format!("placement rejected: {reason}"))?;
                Err(format!("placement rejected: {reason}"))
            }
            ExecutionBackendOutcome::Ambiguous { reason } => {
                self.halt(&mut journal, &format!("placement ambiguous: {reason}"))?;
                Err(format!("placement ambiguous: {reason}"))
            }
        }
    }

    async fn cancel_inner(&self, intent: &ExecutionIntent) -> Result<String, String> {
        validate_execution_intent(intent)?;
        let ExecutionIntent::Cancel {
            market,
            action_id,
            exchange_order_id,
            placement_action_id,
            ..
        } = intent
        else {
            return Err("multi-order cancellation requires a cancellation intent".into());
        };
        {
            let mut journal = self.journal.lock().await;
            require_healthy_new_action(&journal, action_id)?;
            if !journal.orders.iter().any(|order| {
                order.market == *market
                    && order.exchange_order_id == *exchange_order_id
                    && order.placement_action_id == *placement_action_id
            }) {
                return Err("cancellation does not match an exact managed order".into());
            }
            journal.seen_action_ids.push(action_id.clone());
            journal.pending = Some(PendingAction::Cancel {
                market: market.clone(),
                action_id: action_id.clone(),
                placement_action_id: placement_action_id.clone(),
                exchange_order_id: exchange_order_id.clone(),
            });
            self.persist(&journal)?;
        }
        let outcome = self.backend.cancel(intent).await;
        let mut journal = self.journal.lock().await;
        journal.pending = None;
        match outcome {
            ExecutionBackendOutcome::Confirmed {
                exchange_order_id: confirmed,
            } if confirmed == *exchange_order_id => {
                journal.orders.retain(|order| {
                    !(order.exchange_order_id == *exchange_order_id
                        && order.placement_action_id == *placement_action_id)
                });
                self.persist(&journal)?;
                Ok(confirmed)
            }
            ExecutionBackendOutcome::Confirmed { .. } => {
                self.halt(
                    &mut journal,
                    "cancellation confirmed the wrong order identity",
                )?;
                Err("cancellation outcome is ambiguous".into())
            }
            ExecutionBackendOutcome::Rejected { reason } => {
                self.halt(&mut journal, &format!("cancellation rejected: {reason}"))?;
                Err(format!("cancellation rejected: {reason}"))
            }
            ExecutionBackendOutcome::Ambiguous { reason } => {
                self.halt(&mut journal, &format!("cancellation ambiguous: {reason}"))?;
                Err(format!("cancellation ambiguous: {reason}"))
            }
        }
    }

    fn enter(&self) -> Result<(), String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "multi-order execution action already in progress".into())
    }

    fn halt(&self, journal: &mut MultiExecutionJournal, reason: &str) -> Result<(), String> {
        journal.halted_reason = Some(reason.into());
        self.persist(journal)
    }

    fn persist(&self, journal: &MultiExecutionJournal) -> Result<(), String> {
        persist_journal(&self.journal_path, journal)
    }
}

fn require_healthy_new_action(
    journal: &MultiExecutionJournal,
    action_id: &str,
) -> Result<(), String> {
    if let Some(reason) = &journal.halted_reason {
        return Err(format!("multi-order execution is halted: {reason}"));
    }
    if journal.pending.is_some() {
        return Err("multi-order execution already has a pending action".into());
    }
    if journal.seen_action_ids.iter().any(|seen| seen == action_id) {
        return Err("duplicate multi-order execution action id".into());
    }
    Ok(())
}

fn load_journal(path: &Path) -> Result<MultiExecutionJournal, String> {
    match fs::read_to_string(path) {
        Ok(contents) => {
            let journal: MultiExecutionJournal = serde_json::from_str(&contents)
                .map_err(|error| format!("multi-order journal is invalid: {error}"))?;
            if journal.version != 1 {
                return Err("multi-order journal version mismatch".into());
            }
            Ok(journal)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(MultiExecutionJournal::empty())
        }
        Err(error) => Err(format!("multi-order journal read failed: {error}")),
    }
}

fn persist_journal(path: &Path, journal: &MultiExecutionJournal) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("multi-order journal directory failed: {error}"))?;
    }
    let temporary = path.with_extension("tmp");
    let contents = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("multi-order journal serialization failed: {error}"))?;
    fs::write(&temporary, contents)
        .map_err(|error| format!("multi-order journal write failed: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("multi-order journal commit failed: {error}"))
}
