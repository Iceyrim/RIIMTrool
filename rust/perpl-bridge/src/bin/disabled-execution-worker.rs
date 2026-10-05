use std::{future::Future, path::PathBuf, pin::Pin};

use riim_perpl_bridge::{
    execution::{ExecutionWorker, WorkerState},
    execution_backend::{
        MainnetExecutionBackend, MainnetTransactionPort, PreparedCancellation, PreparedPlacement,
        TransactionPortFuture, TransactionPortOutcome,
    },
    protocol::{
        ExecutionIntent, MAINNET_CHAIN_ID, MAINNET_EXCHANGE, VERSION, decode_execution_intent,
    },
};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct UnreachablePort;

impl MainnetTransactionPort for UnreachablePort {
    fn place<'a>(&'a self, _: PreparedPlacement) -> TransactionPortFuture<'a> {
        unreachable_future()
    }

    fn cancel<'a>(&'a self, _: PreparedCancellation) -> TransactionPortFuture<'a> {
        unreachable_future()
    }
}

fn unreachable_future<'a>() -> Pin<Box<dyn Future<Output = TransactionPortOutcome> + Send + 'a>> {
    Box::pin(async {
        TransactionPortOutcome::Ambiguous {
            reason: "disabled worker unexpectedly reached its transaction port".into(),
        }
    })
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
        eprintln!("disabled execution worker: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let journal_path = parse_journal_path()?;
    let backend = MainnetExecutionBackend::disabled(
        UnreachablePort,
        MAINNET_CHAIN_ID,
        MAINNET_EXCHANGE,
        5071,
    )?;
    let worker = ExecutionWorker::open(backend, journal_path)?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let intent = match decode_execution_intent(&line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("disabled execution worker rejected malformed input: {error}");
                continue;
            }
        };
        let (id, action_id) = identity(&intent);
        let outcome = match worker.status().await.state {
            WorkerState::Halted { reason } => Outcome::Ambiguous {
                version: VERSION,
                id,
                action_id,
                reason,
            },
            _ => {
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
                    Ok(()) => outcome_from_state(worker.status().await.state, id, action_id),
                }
            }
        };
        let mut encoded = serde_json::to_vec(&outcome).map_err(|error| error.to_string())?;
        encoded.push(b'\n');
        output
            .write_all(&encoded)
            .await
            .map_err(|error| error.to_string())?;
        output.flush().await.map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn outcome_from_state(state: WorkerState, id: String, action_id: String) -> Outcome {
    match state {
        WorkerState::Resting {
            exchange_order_id, ..
        } => Outcome::Confirmed {
            version: VERSION,
            id,
            action_id,
            exchange_order_id,
        },
        WorkerState::Idle => Outcome::Rejected {
            version: VERSION,
            id,
            action_id,
            reason: "disabled worker unexpectedly returned to idle".into(),
        },
        WorkerState::Halted { reason } if reason.contains("backend is disabled") => {
            Outcome::Rejected {
                version: VERSION,
                id,
                action_id,
                reason,
            }
        }
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
            reason: "disabled worker retained an unresolved pending state".into(),
        },
    }
}

fn identity(intent: &ExecutionIntent) -> (String, String) {
    match intent {
        ExecutionIntent::Place { id, action_id, .. }
        | ExecutionIntent::Cancel { id, action_id, .. } => (id.clone(), action_id.clone()),
    }
}

fn parse_journal_path() -> Result<PathBuf, String> {
    let mut arguments = std::env::args().skip(1);
    let argument = arguments
        .next()
        .ok_or("disabled worker requires --journal-path=PATH")?;
    if arguments.next().is_some() {
        return Err("disabled worker accepts exactly one argument".into());
    }
    let path = argument
        .strip_prefix("--journal-path=")
        .filter(|value| !value.is_empty())
        .ok_or("disabled worker requires --journal-path=PATH")?;
    Ok(PathBuf::from(path))
}
