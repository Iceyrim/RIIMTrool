use std::{future::Future, pin::Pin};

use fastnum::UD64;
use perpl_sdk::types::{OrderRequest, RequestType};

use crate::{
    execution::{BackendFuture, ExecutionBackend, ExecutionBackendOutcome},
    protocol::{ExecutionIntent, validate_execution_intent},
    tx::{self, MainnetAttestation},
};

pub const MAINNET_ACCOUNT_ID: u32 = 5071;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionAudit {
    pub action_id: String,
    pub request_id: u64,
    pub market: String,
    pub perpetual_id: u32,
    pub exchange_order_id: Option<u64>,
    pub post_only: bool,
    pub leverage: String,
}

pub struct PreparedPlacement {
    pub request: OrderRequest,
    pub audit: ActionAudit,
}

pub struct PreparedCancellation {
    pub request: OrderRequest,
    pub audit: ActionAudit,
    pub placement_action_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransactionPortOutcome {
    Confirmed { exchange_order_id: String },
    Rejected { reason: String },
    Ambiguous { reason: String },
}

pub type TransactionPortFuture<'a> =
    Pin<Box<dyn Future<Output = TransactionPortOutcome> + Send + 'a>>;

pub trait MainnetTransactionPort: Send + Sync {
    fn place<'a>(&'a self, action: PreparedPlacement) -> TransactionPortFuture<'a>;
    fn cancel<'a>(&'a self, action: PreparedCancellation) -> TransactionPortFuture<'a>;
}

pub trait ExecutionEnablement: Send + Sync {
    fn is_enabled(&self) -> bool;
}

/// The only production enablement supplied by this module.
pub struct DisabledExecution;

impl ExecutionEnablement for DisabledExecution {
    fn is_enabled(&self) -> bool {
        false
    }
}

/// Maps validated intents into SDK requests, but reaches the injected port only when a separately
/// supplied enablement says so. This module supplies no enabled implementation and no real port.
pub struct MainnetExecutionBackend<P, E = DisabledExecution> {
    port: P,
    enablement: E,
    _attestation: MainnetAttestation,
}

impl<P: MainnetTransactionPort> MainnetExecutionBackend<P, DisabledExecution> {
    pub fn disabled(
        port: P,
        chain_id: u64,
        exchange: &str,
        account_id: u32,
    ) -> Result<Self, String> {
        Self::new(port, DisabledExecution, chain_id, exchange, account_id)
    }
}

impl<P: MainnetTransactionPort, E: ExecutionEnablement> MainnetExecutionBackend<P, E> {
    pub fn new(
        port: P,
        enablement: E,
        chain_id: u64,
        exchange: &str,
        account_id: u32,
    ) -> Result<Self, String> {
        let attestation = MainnetAttestation::verify(chain_id, exchange).map_err(str::to_string)?;
        if account_id != MAINNET_ACCOUNT_ID {
            return Err("execution backend account mismatch".into());
        }
        Ok(Self {
            port,
            enablement,
            _attestation: attestation,
        })
    }

    fn prepare_place(intent: &ExecutionIntent) -> Result<PreparedPlacement, String> {
        validate_execution_intent(intent)?;
        let ExecutionIntent::Place {
            market,
            perpetual_id,
            action_id,
            side,
            price,
            size,
            reduce_only,
            leverage,
            ..
        } = intent
        else {
            return Err("backend placement requires a placement intent".into());
        };
        let request_id = numeric_id(action_id, "placement action")?;
        let request_type = match (side.as_str(), *reduce_only) {
            ("buy", false) => RequestType::OpenLong,
            ("sell", false) => RequestType::OpenShort,
            ("buy", true) => RequestType::CloseShort,
            ("sell", true) => RequestType::CloseLong,
            _ => return Err("backend placement side is invalid".into()),
        };
        let price = price.parse::<UD64>().map_err(|_| "invalid backend price")?;
        let size = size.parse::<UD64>().map_err(|_| "invalid backend size")?;
        let leverage_value = leverage
            .parse::<UD64>()
            .map_err(|_| "invalid backend leverage")?;
        Ok(PreparedPlacement {
            request: OrderRequest::new(
                request_id,
                *perpetual_id,
                request_type,
                None,
                price,
                size,
                None,
                true,
                false,
                false,
                None,
                leverage_value,
                None,
                None,
                0,
            ),
            audit: ActionAudit {
                action_id: action_id.clone(),
                request_id,
                market: market.clone(),
                perpetual_id: *perpetual_id,
                exchange_order_id: None,
                post_only: true,
                leverage: leverage.clone(),
            },
        })
    }

    fn prepare_cancel(intent: &ExecutionIntent) -> Result<PreparedCancellation, String> {
        validate_execution_intent(intent)?;
        let ExecutionIntent::Cancel {
            market,
            perpetual_id,
            action_id,
            exchange_order_id,
            placement_action_id,
            ..
        } = intent
        else {
            return Err("backend cancellation requires a cancellation intent".into());
        };
        let request_id = numeric_id(action_id, "cancellation action")?;
        numeric_id(placement_action_id, "placement action")?;
        let order_id = numeric_id(exchange_order_id, "exchange order")?;
        let protocol_order_id = u16::try_from(order_id)
            .map_err(|_| "exchange order id exceeds the protocol u16 range")?;
        Ok(PreparedCancellation {
            request: tx::cancel_request(request_id, *perpetual_id, protocol_order_id)?,
            audit: ActionAudit {
                action_id: action_id.clone(),
                request_id,
                market: market.clone(),
                perpetual_id: *perpetual_id,
                exchange_order_id: Some(order_id),
                post_only: false,
                leverage: "0".into(),
            },
            placement_action_id: placement_action_id.clone(),
        })
    }
}

impl<P: MainnetTransactionPort, E: ExecutionEnablement> ExecutionBackend
    for MainnetExecutionBackend<P, E>
{
    fn place<'a>(&'a self, intent: &'a ExecutionIntent) -> BackendFuture<'a> {
        Box::pin(async move {
            if !self.enablement.is_enabled() {
                return ExecutionBackendOutcome::Rejected {
                    reason: "mainnet execution backend is disabled".into(),
                };
            }
            let action = match Self::prepare_place(intent) {
                Ok(value) => value,
                Err(reason) => return ExecutionBackendOutcome::Rejected { reason },
            };
            map_outcome(self.port.place(action).await)
        })
    }

    fn cancel<'a>(&'a self, intent: &'a ExecutionIntent) -> BackendFuture<'a> {
        Box::pin(async move {
            if !self.enablement.is_enabled() {
                return ExecutionBackendOutcome::Rejected {
                    reason: "mainnet execution backend is disabled".into(),
                };
            }
            let action = match Self::prepare_cancel(intent) {
                Ok(value) => value,
                Err(reason) => return ExecutionBackendOutcome::Rejected { reason },
            };
            map_outcome(self.port.cancel(action).await)
        })
    }
}

fn numeric_id(value: &str, field: &str) -> Result<u64, String> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("{field} must be a numeric u64"))?;
    if parsed == 0 {
        return Err(format!("{field} must be nonzero"));
    }
    Ok(parsed)
}

fn map_outcome(outcome: TransactionPortOutcome) -> ExecutionBackendOutcome {
    match outcome {
        TransactionPortOutcome::Confirmed { exchange_order_id } => {
            ExecutionBackendOutcome::Confirmed { exchange_order_id }
        }
        TransactionPortOutcome::Rejected { reason } => ExecutionBackendOutcome::Rejected { reason },
        TransactionPortOutcome::Ambiguous { reason } => {
            ExecutionBackendOutcome::Ambiguous { reason }
        }
    }
}
