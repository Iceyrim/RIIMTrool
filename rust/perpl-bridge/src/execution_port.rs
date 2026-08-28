use std::sync::Arc;

use alloy::{
    eips::BlockId,
    primitives::{Address, U256},
    providers::Provider,
};
use perpl_sdk::{
    Chain,
    state::{self, SnapshotBuilder},
    types::AccountAddressOrID,
};
use tokio::sync::{Mutex, RwLock};

use crate::{
    execution_backend::{
        MainnetTransactionPort, PreparedCancellation, PreparedPlacement, TransactionPortFuture,
        TransactionPortOutcome,
    },
    tx::{self, MainnetAttestation, SubmissionGate},
};

/// Dormant SDK transaction port. No binary constructs this type; the caller must inject an
/// already wallet-capable provider, attestation, explicit gate, signer, snapshot, and nonce.
pub struct SdkMainnetTransactionPort<P> {
    provider: P,
    attestation: MainnetAttestation,
    gate: SubmissionGate,
    snapshot: Arc<RwLock<state::Exchange>>,
    exchange_address: Address,
    signer_address: Address,
    account_id: U256,
    policy: Mutex<PortPolicy>,
}

pub struct SdkMainnetTransactionPortConfig<P> {
    pub provider: P,
    pub attestation: MainnetAttestation,
    pub gate: SubmissionGate,
    pub snapshot: Arc<RwLock<state::Exchange>>,
    pub exchange_address: Address,
    pub signer_address: Address,
    pub account_id: U256,
    pub pending_nonce: u64,
    pub gas_limit: u64,
    pub max_snapshot_lag_blocks: u64,
}

impl<P> SdkMainnetTransactionPort<P> {
    pub fn new(config: SdkMainnetTransactionPortConfig<P>) -> Result<Self, String> {
        let policy = PortPolicy::new(
            config.pending_nonce,
            config.gas_limit,
            config.max_snapshot_lag_blocks,
        )?;
        Ok(Self {
            provider: config.provider,
            attestation: config.attestation,
            gate: config.gate,
            snapshot: config.snapshot,
            exchange_address: config.exchange_address,
            signer_address: config.signer_address,
            account_id: config.account_id,
            policy: Mutex::new(policy),
        })
    }
}

impl<P: Provider + Clone + Send + Sync + 'static> SdkMainnetTransactionPort<P> {
    async fn refresh_snapshot(&self) -> Result<SnapshotRefreshEvidence, String> {
        let chain = Chain::mainnet();
        let refreshed = SnapshotBuilder::new(&chain, self.provider.clone())
            .with_perpetuals(vec![1, 20])
            .with_accounts(vec![AccountAddressOrID::ID(5071)])
            .build()
            .await
            .map_err(|error| format!("execution snapshot refresh failed: {error}"))?;
        *self.snapshot.write().await = refreshed;
        Ok(SnapshotRefreshEvidence(()))
    }

    async fn submit_place(&self, action: PreparedPlacement) -> Result<String, String> {
        let mut policy = self.policy.lock().await;
        let pending = self.pending_nonce().await?;
        let refreshed = self.refresh_snapshot().await?;
        let snapshot = self.snapshot.read().await;
        let current = self.current_safe_block().await?;
        policy.validate(
            refreshed,
            pending,
            current,
            snapshot.instant().block_number(),
        )?;
        let receipt = tx::submit_exec_orders_receipt_mainnet(
            self.provider.clone(),
            self.attestation,
            self.gate,
            &snapshot,
            self.exchange_address,
            self.signer_address,
            &[action.request],
            policy.next_nonce,
            policy.gas_limit,
        )
        .await?;
        if !receipt.status() {
            return Err("placement transaction was rejected".into());
        }
        let order_id = tx::extract_order_id(
            receipt.inner.logs(),
            self.exchange_address,
            action.audit.request_id,
            action.audit.perpetual_id,
        )?;
        policy.confirm()?;
        Ok(order_id.to_string())
    }

    async fn submit_cancel(&self, action: PreparedCancellation) -> Result<String, String> {
        let mut policy = self.policy.lock().await;
        let pending = self.pending_nonce().await?;
        let refreshed = self.refresh_snapshot().await?;
        let snapshot = self.snapshot.read().await;
        let current = self.current_safe_block().await?;
        policy.validate(
            refreshed,
            pending,
            current,
            snapshot.instant().block_number(),
        )?;
        let receipt = tx::submit_exec_orders_receipt_mainnet(
            self.provider.clone(),
            self.attestation,
            self.gate,
            &snapshot,
            self.exchange_address,
            self.signer_address,
            &[action.request],
            policy.next_nonce,
            policy.gas_limit,
        )
        .await?;
        let order_id = action
            .audit
            .exchange_order_id
            .ok_or("cancellation audit omitted order identity")?;
        let protocol_order_id =
            u16::try_from(order_id).map_err(|_| "cancellation order identity exceeds u16")?;
        tx::validate_cancel_receipt(
            &receipt,
            self.exchange_address,
            self.account_id,
            action.audit.request_id,
            action.audit.perpetual_id,
            protocol_order_id,
        )?;
        policy.confirm()?;
        Ok(order_id.to_string())
    }

    async fn pending_nonce(&self) -> Result<u64, String> {
        self.provider
            .get_transaction_count(self.signer_address)
            .pending()
            .await
            .map_err(|error| format!("pending nonce refresh failed: {error}"))
    }

    async fn current_safe_block(&self) -> Result<u64, String> {
        self.provider
            .get_block(BlockId::safe())
            .await
            .map_err(|error| format!("safe block refresh failed: {error}"))?
            .map(|block| block.header.number)
            .ok_or_else(|| "safe block refresh returned no block".to_string())
    }
}

/// Unforgeable outside this module: validation can only follow a successful refresh.
struct SnapshotRefreshEvidence(());

struct PortPolicy {
    next_nonce: u64,
    gas_limit: u64,
    max_snapshot_lag_blocks: u64,
}

impl PortPolicy {
    fn new(next_nonce: u64, gas_limit: u64, max_snapshot_lag_blocks: u64) -> Result<Self, String> {
        if gas_limit == 0 || gas_limit > tx::MAINNET_MAX_GAS_LIMIT {
            return Err("execution port gas limit is invalid".into());
        }
        if max_snapshot_lag_blocks == 0 {
            return Err("execution port snapshot lag limit is invalid".into());
        }
        Ok(Self {
            next_nonce,
            gas_limit,
            max_snapshot_lag_blocks,
        })
    }
    fn validate(
        &self,
        _refreshed: SnapshotRefreshEvidence,
        pending_nonce: u64,
        current_block: u64,
        snapshot_block: u64,
    ) -> Result<(), String> {
        tx::validate_pending_nonce(self.next_nonce, pending_nonce)?;
        if current_block < snapshot_block
            || current_block - snapshot_block > self.max_snapshot_lag_blocks
        {
            return Err("execution snapshot is stale or ahead of chain state".into());
        }
        Ok(())
    }
    fn confirm(&mut self) -> Result<(), String> {
        self.next_nonce = self
            .next_nonce
            .checked_add(1)
            .ok_or("execution nonce exhausted")?;
        Ok(())
    }
}

impl<P: Provider + Clone + Send + Sync + 'static> MainnetTransactionPort
    for SdkMainnetTransactionPort<P>
{
    fn place<'a>(&'a self, action: PreparedPlacement) -> TransactionPortFuture<'a> {
        Box::pin(async move { classify(self.submit_place(action).await) })
    }
    fn cancel<'a>(&'a self, action: PreparedCancellation) -> TransactionPortFuture<'a> {
        Box::pin(async move { classify(self.submit_cancel(action).await) })
    }
}

fn classify(result: Result<String, String>) -> TransactionPortOutcome {
    match result {
        Ok(exchange_order_id) => TransactionPortOutcome::Confirmed { exchange_order_id },
        Err(reason) if reason.contains("ambiguous") || reason.contains("timed out") => {
            TransactionPortOutcome::Ambiguous { reason }
        }
        Err(reason) => TransactionPortOutcome::Rejected { reason },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_definitive_and_ambiguous_results_without_retrying() {
        assert_eq!(
            classify(Ok("47".into())),
            TransactionPortOutcome::Confirmed {
                exchange_order_id: "47".into()
            }
        );
        assert!(matches!(
            classify(Err("receipt timed out; transaction is ambiguous".into())),
            TransactionPortOutcome::Ambiguous { .. }
        ));
        assert!(matches!(
            classify(Err("transaction rejected".into())),
            TransactionPortOutcome::Rejected { .. }
        ));
    }

    #[test]
    fn policy_requires_refresh_evidence_and_enforces_gas_nonce_and_snapshot() {
        assert!(PortPolicy::new(7, 0, 2).is_err());
        assert!(PortPolicy::new(7, tx::MAINNET_MAX_GAS_LIMIT + 1, 2).is_err());
        let mut policy = PortPolicy::new(7, tx::MAINNET_MAX_GAS_LIMIT, 2).unwrap();
        assert!(
            policy
                .validate(SnapshotRefreshEvidence(()), 8, 100, 100)
                .is_err()
        );
        assert!(
            policy
                .validate(SnapshotRefreshEvidence(()), 7, 100, 97)
                .is_err()
        );
        assert!(
            policy
                .validate(SnapshotRefreshEvidence(()), 7, 99, 100)
                .is_err()
        );
        policy
            .validate(SnapshotRefreshEvidence(()), 7, 100, 98)
            .unwrap();
        assert_eq!(policy.next_nonce, 7);
        policy.confirm().unwrap();
        assert_eq!(policy.next_nonce, 8);
    }
}
