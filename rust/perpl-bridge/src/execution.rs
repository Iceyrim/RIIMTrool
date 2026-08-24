use std::{
    fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::protocol::{ExecutionIntent, validate_execution_intent};

pub type BackendFuture<'a> = Pin<Box<dyn Future<Output = ExecutionBackendOutcome> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutionBackendOutcome {
    Confirmed { exchange_order_id: String },
    Rejected { reason: String },
    Ambiguous { reason: String },
}

pub trait ExecutionBackend: Send + Sync {
    fn place<'a>(&'a self, intent: &'a ExecutionIntent) -> BackendFuture<'a>;
    fn cancel<'a>(&'a self, intent: &'a ExecutionIntent) -> BackendFuture<'a>;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WorkerState {
    Idle,
    PlacementPending {
        market: String,
        action_id: String,
    },
    Resting {
        market: String,
        placement_action_id: String,
        exchange_order_id: String,
    },
    CancellationPending {
        market: String,
        action_id: String,
        placement_action_id: String,
        exchange_order_id: String,
    },
    Halted {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionJournal {
    version: u8,
    pub state: WorkerState,
    seen_action_ids: Vec<String>,
}

impl ExecutionJournal {
    fn idle() -> Self {
        Self {
            version: 1,
            state: WorkerState::Idle,
            seen_action_ids: Vec::new(),
        }
    }
}

/// Isolated execution state machine. No provider or signer implementation is wired to it.
pub struct ExecutionWorker<B: ExecutionBackend> {
    backend: B,
    journal_path: PathBuf,
    journal: Mutex<ExecutionJournal>,
    busy: AtomicBool,
}

impl<B: ExecutionBackend> ExecutionWorker<B> {
    pub fn open(backend: B, journal_path: impl Into<PathBuf>) -> Result<Self, String> {
        let journal_path = journal_path.into();
        let mut journal = load_journal(&journal_path)?;
        if journal.state != WorkerState::Idle {
            journal.state =
                halted("startup found unresolved execution state; manual review required");
            persist_journal(&journal_path, &journal)?;
        }
        Ok(Self {
            backend,
            journal_path,
            journal: Mutex::new(journal),
            busy: AtomicBool::new(false),
        })
    }

    pub async fn status(&self) -> ExecutionJournal {
        self.journal.lock().await.clone()
    }

    pub async fn place(&self, intent: &ExecutionIntent) -> Result<(), String> {
        self.enter()?;
        let result = self.place_inner(intent).await;
        self.busy.store(false, Ordering::Release);
        result
    }

    pub async fn cancel(&self, intent: &ExecutionIntent) -> Result<(), String> {
        self.enter()?;
        let result = self.cancel_inner(intent).await;
        self.busy.store(false, Ordering::Release);
        result
    }

    async fn place_inner(&self, intent: &ExecutionIntent) -> Result<(), String> {
        validate_execution_intent(intent)?;
        let ExecutionIntent::Place {
            market, action_id, ..
        } = intent
        else {
            return Err("placement worker requires a placement intent".into());
        };
        {
            let mut journal = self.journal.lock().await;
            require_idle_and_new_action(&journal, action_id)?;
            journal.seen_action_ids.push(action_id.clone());
            journal.state = WorkerState::PlacementPending {
                market: market.clone(),
                action_id: action_id.clone(),
            };
            self.persist(&journal)?;
        }
        let outcome = self.backend.place(intent).await;
        let mut journal = self.journal.lock().await;
        journal.state = match outcome {
            ExecutionBackendOutcome::Confirmed { exchange_order_id }
                if !exchange_order_id.is_empty() =>
            {
                WorkerState::Resting {
                    market: market.clone(),
                    placement_action_id: action_id.clone(),
                    exchange_order_id,
                }
            }
            ExecutionBackendOutcome::Confirmed { .. } => {
                halted("placement confirmed without an order identity")
            }
            ExecutionBackendOutcome::Rejected { reason } => {
                halted(&format!("placement rejected: {reason}"))
            }
            ExecutionBackendOutcome::Ambiguous { reason } => {
                halted(&format!("placement ambiguous: {reason}"))
            }
        };
        self.persist(&journal)
    }

    async fn cancel_inner(&self, intent: &ExecutionIntent) -> Result<(), String> {
        validate_execution_intent(intent)?;
        let ExecutionIntent::Cancel {
            market,
            action_id,
            exchange_order_id,
            placement_action_id,
            ..
        } = intent
        else {
            return Err("cancellation worker requires a cancellation intent".into());
        };
        {
            let mut journal = self.journal.lock().await;
            if journal.seen_action_ids.iter().any(|seen| seen == action_id) {
                return Err("duplicate execution action id".into());
            }
            match &journal.state {
                WorkerState::Resting {
                    market: active_market,
                    placement_action_id: active_placement,
                    exchange_order_id: active_order,
                } if active_market == market
                    && active_placement == placement_action_id
                    && active_order == exchange_order_id => {}
                WorkerState::Resting { .. } => {
                    return Err("cancellation does not match the exact resting order".into());
                }
                _ => return Err("cancellation requires a confirmed resting order".into()),
            }
            journal.seen_action_ids.push(action_id.clone());
            journal.state = WorkerState::CancellationPending {
                market: market.clone(),
                action_id: action_id.clone(),
                placement_action_id: placement_action_id.clone(),
                exchange_order_id: exchange_order_id.clone(),
            };
            self.persist(&journal)?;
        }
        let outcome = self.backend.cancel(intent).await;
        let mut journal = self.journal.lock().await;
        journal.state = match outcome {
            ExecutionBackendOutcome::Confirmed {
                exchange_order_id: confirmed,
            } if confirmed == *exchange_order_id => WorkerState::Idle,
            ExecutionBackendOutcome::Confirmed { .. } => {
                halted("cancellation confirmed the wrong order identity")
            }
            ExecutionBackendOutcome::Rejected { reason } => {
                halted(&format!("cancellation rejected: {reason}"))
            }
            ExecutionBackendOutcome::Ambiguous { reason } => {
                halted(&format!("cancellation ambiguous: {reason}"))
            }
        };
        self.persist(&journal)
    }

    fn enter(&self) -> Result<(), String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "execution worker action already in progress".into())
    }

    fn persist(&self, journal: &ExecutionJournal) -> Result<(), String> {
        persist_journal(&self.journal_path, journal)
    }
}

fn require_idle_and_new_action(journal: &ExecutionJournal, action_id: &str) -> Result<(), String> {
    if journal.state != WorkerState::Idle {
        return Err("execution worker is not idle".into());
    }
    if journal.seen_action_ids.iter().any(|seen| seen == action_id) {
        return Err("duplicate execution action id".into());
    }
    Ok(())
}

fn halted(reason: &str) -> WorkerState {
    WorkerState::Halted {
        reason: reason.into(),
    }
}

fn load_journal(path: &Path) -> Result<ExecutionJournal, String> {
    match fs::read_to_string(path) {
        Ok(contents) => {
            let journal: ExecutionJournal = serde_json::from_str(&contents)
                .map_err(|error| format!("execution journal is invalid: {error}"))?;
            if journal.version != 1 {
                return Err("execution journal version mismatch".into());
            }
            Ok(journal)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ExecutionJournal::idle()),
        Err(error) => Err(format!("execution journal read failed: {error}")),
    }
}

fn persist_journal(path: &Path, journal: &ExecutionJournal) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("execution journal directory failed: {error}"))?;
    }
    let temporary = path.with_extension("tmp");
    let contents = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("execution journal serialization failed: {error}"))?;
    fs::write(&temporary, contents)
        .map_err(|error| format!("execution journal write failed: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("execution journal commit failed: {error}"))
}
