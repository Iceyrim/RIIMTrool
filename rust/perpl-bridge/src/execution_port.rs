use std::{collections::HashMap, sync::Arc, time::Duration};

use alloy::{
    eips::BlockId,
    primitives::{Address, U256},
    providers::Provider,
    rpc::types::Filter,
    sol_types::SolEventInterface,
};
use futures::StreamExt;
use perpl_sdk::{
    Chain,
    abi::dex::Exchange::ExchangeEvents,
    state::{self, SnapshotBuilder},
    stream::{RawBlockEvents, RawEvent},
    types::AccountAddressOrID,
    types::StateInstant,
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
pub struct SdkMainnetTransactionPort<P, S> {
    provider: P,
    state_provider: S,
    attestation: MainnetAttestation,
    gate: SubmissionGate,
    snapshot: Arc<RwLock<state::Exchange>>,
    exchange_address: Address,
    signer_address: Address,
    account_id: U256,
    policy: Mutex<PortPolicy>,
}

pub struct SdkMainnetTransactionPortConfig<P, S> {
    pub provider: P,
    pub state_provider: S,
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

impl<P, S> SdkMainnetTransactionPort<P, S> {
    pub fn new(config: SdkMainnetTransactionPortConfig<P, S>) -> Result<Self, String> {
        let policy = PortPolicy::new(
            config.pending_nonce,
            config.gas_limit,
            config.max_snapshot_lag_blocks,
        )?;
        Ok(Self {
            provider: config.provider,
            state_provider: config.state_provider,
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

impl<P, S> SdkMainnetTransactionPort<P, S>
where
    P: Provider + Clone + Send + Sync + 'static,
    S: Provider + Clone + Send + Sync + 'static,
{
    async fn refresh_snapshot(
        &self,
        max_lag_blocks: u64,
        perpetual_id: u32,
    ) -> Result<SnapshotRefreshEvidence, String> {
        let (refreshed, freshness) = build_caught_up_mainnet_snapshot(
            self.state_provider.clone(),
            vec![perpetual_id],
            max_lag_blocks,
        )
        .await?;
        *self.snapshot.write().await = refreshed;
        Ok(SnapshotRefreshEvidence {
            snapshot_block: freshness.snapshot_block,
            safe_block: freshness.safe_block,
        })
    }

    async fn submit_place(&self, action: PreparedPlacement) -> Result<String, String> {
        let mut policy = self.policy.lock().await;
        let pending = self.pending_nonce().await?;
        let refreshed = self
            .refresh_snapshot(policy.max_snapshot_lag_blocks, action.audit.perpetual_id)
            .await?;
        let snapshot = self.snapshot.read().await;
        policy.validate(refreshed, pending, snapshot.instant().block_number())?;
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
        let refreshed = self
            .refresh_snapshot(policy.max_snapshot_lag_blocks, action.audit.perpetual_id)
            .await?;
        let snapshot = self.snapshot.read().await;
        policy.validate(refreshed, pending, snapshot.instant().block_number())?;
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
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SnapshotFreshness {
    pub snapshot_block: u64,
    pub safe_block: u64,
    pub lag_blocks: u64,
    pub replayed_blocks: u64,
}

/// Builds the pinned mainnet execution snapshot and replays every safe block needed to
/// preserve the strict freshness limit. This is read-only and never constructs a signer.
pub async fn build_caught_up_mainnet_snapshot<P>(
    provider: P,
    perpetual_ids: Vec<u32>,
    max_lag_blocks: u64,
) -> Result<(state::Exchange, SnapshotFreshness), String>
where
    P: Provider + Clone + Send + Sync + 'static,
{
    if max_lag_blocks == 0 {
        return Err("snapshot catch-up lag limit is invalid".into());
    }
    if !matches!(perpetual_ids.as_slice(), [1] | [20]) {
        return Err("snapshot catch-up perpetual scope is invalid".into());
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let chain = Chain::mainnet();
    let mut snapshot = tokio::time::timeout_at(
        deadline,
        SnapshotBuilder::new(&chain, provider.clone())
            .with_perpetuals(perpetual_ids)
            .with_accounts(vec![AccountAddressOrID::ID(5198)])
            .with_orders_per_batch(crate::perpl::SNAPSHOT_ITEMS_PER_BATCH)
            .with_positions_per_batch(crate::perpl::SNAPSHOT_ITEMS_PER_BATCH)
            .build(),
    )
    .await
    .map_err(|_| "execution snapshot build timed out".to_string())?
    .map_err(|error| format!("execution snapshot failed: {error}"))?;
    let initial_block = snapshot.instant().block_number();

    loop {
        let safe_block = provider
            .get_block(BlockId::safe())
            .await
            .map_err(|error| format!("safe block refresh failed: {error}"))?
            .map(|block| block.header.number)
            .ok_or_else(|| "safe block refresh returned no block".to_string())?;
        let snapshot_block = snapshot.instant().block_number();
        if safe_block < snapshot_block {
            return Err("execution snapshot is ahead of safe chain state".into());
        }
        let lag_blocks = safe_block - snapshot_block;
        if lag_blocks <= max_lag_blocks {
            return Ok((
                snapshot,
                SnapshotFreshness {
                    snapshot_block,
                    safe_block,
                    lag_blocks,
                    replayed_blocks: snapshot_block - initial_block,
                },
            ));
        }

        replay_safe_range(
            provider.clone(),
            &chain,
            &mut snapshot,
            safe_block,
            deadline,
        )
        .await?;
    }
}

async fn replay_safe_range<P>(
    provider: P,
    chain: &Chain,
    snapshot: &mut state::Exchange,
    target_block: u64,
    deadline: tokio::time::Instant,
) -> Result<(), String>
where
    P: Provider + Clone + Send + Sync + 'static,
{
    let first_block = snapshot.instant().next().block_number();
    if first_block > target_block {
        return Ok(());
    }
    let filter = Filter::new()
        .address(chain.exchange())
        .from_block(first_block)
        .to_block(target_block);
    let logs = tokio::time::timeout_at(deadline, provider.get_logs(&filter))
        .await
        .map_err(|_| "execution snapshot log catch-up timed out".to_string())?
        .map_err(|error| format!("execution snapshot log catch-up failed: {error}"))?;
    let mut events_by_block: HashMap<u64, Vec<RawEvent>> = HashMap::new();
    for log in logs {
        let block_number = log
            .block_number
            .ok_or_else(|| "execution snapshot catch-up log omitted block number".to_string())?;
        let event = RawEvent::new(
            log.transaction_hash.unwrap_or_default(),
            log.transaction_index.unwrap_or_default(),
            log.log_index.unwrap_or_default(),
            ExchangeEvents::decode_log(&log.inner)
                .map_err(|error| format!("execution snapshot event decode failed: {error}"))?
                .data,
        );
        events_by_block.entry(block_number).or_default().push(event);
    }
    for events in events_by_block.values_mut() {
        events.sort_by_key(|event| event.log_index());
    }

    let mut headers = futures::stream::iter(first_block..=target_block)
        .map(|block_number| {
            let provider = provider.clone();
            async move {
                let block = provider
                    .get_block(BlockId::number(block_number))
                    .await
                    .map_err(|error| format!("safe block {block_number} fetch failed: {error}"))?
                    .ok_or_else(|| format!("safe block {block_number} is unavailable"))?;
                Ok::<_, String>((block_number, block.header.timestamp))
            }
        })
        .buffer_unordered(24)
        .collect::<Vec<_>>();
    let mut headers = tokio::time::timeout_at(deadline, &mut headers)
        .await
        .map_err(|_| "execution snapshot header catch-up timed out".to_string())?
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    headers.sort_unstable_by_key(|(block_number, _)| *block_number);

    for (block_number, timestamp) in headers {
        let events = events_by_block.remove(&block_number).unwrap_or_default();
        snapshot
            .apply_events(&RawBlockEvents::new(
                StateInstant::new(block_number, timestamp),
                events,
            ))
            .map_err(|error| format!("execution snapshot event apply failed: {error}"))?;
    }
    Ok(())
}

/// Unforgeable outside this module: validation can only follow a successful refresh.
struct SnapshotRefreshEvidence {
    snapshot_block: u64,
    safe_block: u64,
}

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
        refreshed: SnapshotRefreshEvidence,
        pending_nonce: u64,
        snapshot_block: u64,
    ) -> Result<(), String> {
        tx::validate_pending_nonce(self.next_nonce, pending_nonce)?;
        if refreshed.snapshot_block != snapshot_block
            || refreshed.safe_block < refreshed.snapshot_block
            || refreshed.safe_block - refreshed.snapshot_block > self.max_snapshot_lag_blocks
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

impl<P, S> MainnetTransactionPort for SdkMainnetTransactionPort<P, S>
where
    P: Provider + Clone + Send + Sync + 'static,
    S: Provider + Clone + Send + Sync + 'static,
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
                .validate(
                    SnapshotRefreshEvidence {
                        snapshot_block: 100,
                        safe_block: 100,
                    },
                    8,
                    100,
                )
                .is_err()
        );
        assert!(
            policy
                .validate(
                    SnapshotRefreshEvidence {
                        snapshot_block: 97,
                        safe_block: 100,
                    },
                    7,
                    97,
                )
                .is_err()
        );
        assert!(
            policy
                .validate(
                    SnapshotRefreshEvidence {
                        snapshot_block: 100,
                        safe_block: 99,
                    },
                    7,
                    100,
                )
                .is_err()
        );
        policy
            .validate(
                SnapshotRefreshEvidence {
                    snapshot_block: 98,
                    safe_block: 100,
                },
                7,
                98,
            )
            .unwrap();
        assert_eq!(policy.next_nonce, 7);
        policy.confirm().unwrap();
        assert_eq!(policy.next_nonce, 8);
    }
}
