use std::{num::NonZeroU16, time::Duration};

use Exchange::ExchangeEvents;
use alloy::{
    eips::BlockId,
    primitives::{Address, TxHash, U256},
    providers::Provider,
    rpc::types::{Log, TransactionReceipt},
    sol_types::SolEventInterface,
};
use perpl_sdk::{
    abi::{dex::Exchange, testing::TestToken},
    state,
    types::{OrderRequest, RequestType},
};

use crate::protocol::{MAINNET_CHAIN_ID, MAINNET_EXCHANGE, TESTNET_CHAIN_ID, TESTNET_EXCHANGE};

pub const TESTNET_RPC: &str = "https://testnet-rpc.monad.xyz";
pub const MAINNET_RPC: &str = "https://rpc.monad.xyz";

/// Gas ceiling for the mainnet canary path only, sized to real observed mainnet
/// `execOrders` gas usage (310,310-643,990 gas across live sampled transactions,
/// see the mainnet canary scoping notes) with roughly 2x headroom. Deliberately
/// far tighter than the testnet path's `150_000_000` cap, which stays unchanged.
pub const MAINNET_MAX_GAS_LIMIT: u64 = 1_300_000;

/// The on-chain account-creation inputs fetched before any setup transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountSetupContext {
    pub minimum_cns: U256,
    pub account_id: U256,
    pub collateral_token: Address,
    pub allowance_cns: U256,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountSetupAction {
    Existing { account_id: U256 },
    ApproveAndCreate { amount_cns: U256 },
    Create { amount_cns: U256 },
}

/// Plans account setup from values read from the attested exchange/token.
/// Zero is the pinned SDK sentinel for an address without an exchange account.
pub fn plan_account_setup(context: AccountSetupContext) -> Result<AccountSetupAction, String> {
    if context.minimum_cns.is_zero() {
        return Err("on-chain account minimum is zero".into());
    }
    if context.collateral_token.is_zero() {
        return Err("exchange returned zero collateral token".into());
    }
    if !context.account_id.is_zero() {
        return Ok(AccountSetupAction::Existing {
            account_id: context.account_id,
        });
    }
    if context.allowance_cns < context.minimum_cns {
        Ok(AccountSetupAction::ApproveAndCreate {
            amount_cns: context.minimum_cns,
        })
    } else {
        Ok(AccountSetupAction::Create {
            amount_cns: context.minimum_cns,
        })
    }
}

/// Read-only account setup context. This performs no signer initialization and
/// no transaction submission; callers must pass the result through the gate
/// before using any setup action.
pub async fn read_account_setup_context<P: Provider + Clone>(
    provider: P,
    exchange_address: Address,
    signer_address: Address,
) -> Result<AccountSetupContext, String> {
    let exchange = Exchange::new(exchange_address, provider.clone());
    let minimum = exchange
        .getMinAccountOpenCNS()
        .call()
        .await
        .map_err(|error| format!("minimum account collateral read failed: {error}"))?;
    let account = exchange
        .getAccountByAddr(signer_address)
        .call()
        .await
        .map_err(|error| format!("account identity read failed: {error}"))?;
    let info = exchange
        .getExchangeInfo()
        .call()
        .await
        .map_err(|error| format!("exchange collateral config read failed: {error}"))?;
    let allowance = TestToken::new(info.collateralToken, provider)
        .allowance(signer_address, exchange_address)
        .call()
        .await
        .map_err(|error| format!("collateral allowance read failed: {error}"))?;
    Ok(AccountSetupContext {
        minimum_cns: minimum,
        account_id: account.accountId,
        collateral_token: info.collateralToken,
        allowance_cns: allowance,
    })
}

/// Executes the planner's account setup actions. The caller must supply an
/// already-attested testnet provider and the next chain nonce. Every mutation
/// is gated, explicitly nonced, gas-bounded, receipt-confirmed, and never
/// retried after an ambiguous result.
#[allow(clippy::too_many_arguments)]
pub async fn execute_account_setup<P: Provider + Clone>(
    provider: P,
    attestation: TestnetAttestation,
    gate: SubmissionGate,
    exchange_address: Address,
    signer_address: Address,
    context: AccountSetupContext,
    chain_nonce: u64,
    gas_limit: u64,
) -> Result<U256, String> {
    if attestation
        != TestnetAttestation::verify(TESTNET_CHAIN_ID, TESTNET_EXCHANGE)
            .map_err(|error| error.to_string())?
    {
        return Err("testnet attestation mismatch".into());
    }
    if !gate.is_enabled() {
        return Err("transaction submission is disabled".into());
    }
    validate_gas(gas_limit, 150_000_000)?;
    let action = plan_account_setup(context)?;
    if let AccountSetupAction::Existing { account_id } = action {
        return Ok(account_id);
    }

    let mut nonce = reserve_nonce(chain_nonce, None).map_err(|error| error.to_string())?;
    if let AccountSetupAction::ApproveAndCreate { amount_cns } = action {
        let pending = TestToken::new(context.collateral_token, provider.clone())
            .approve(exchange_address, amount_cns)
            .from(signer_address)
            .nonce(nonce)
            .gas(gas_limit)
            .send()
            .await
            .map_err(|error| format!("collateral approval submission failed: {error}"))?;
        tokio::time::timeout(Duration::from_secs(15), pending.get_receipt())
            .await
            .map_err(|_| "approval receipt timed out; transaction is ambiguous".to_string())?
            .map_err(|error| format!("approval receipt failed; transaction is ambiguous: {error}"))
            .and_then(|receipt| {
                if receipt.status() {
                    Ok(())
                } else {
                    Err("collateral approval was rejected".into())
                }
            })?;
        nonce = nonce.checked_add(1).ok_or("nonce exhausted")?;
    }

    let amount_cns = match action {
        AccountSetupAction::ApproveAndCreate { amount_cns }
        | AccountSetupAction::Create { amount_cns } => amount_cns,
        AccountSetupAction::Existing { .. } => unreachable!(),
    };
    let pending = Exchange::new(exchange_address, provider.clone())
        .createAccount(amount_cns)
        .from(signer_address)
        .nonce(nonce)
        .gas(gas_limit)
        .send()
        .await
        .map_err(|error| format!("account creation submission failed: {error}"))?;
    tokio::time::timeout(Duration::from_secs(15), pending.get_receipt())
        .await
        .map_err(|_| "account creation receipt timed out; transaction is ambiguous".to_string())?
        .map_err(|error| {
            format!("account creation receipt failed; transaction is ambiguous: {error}")
        })
        .and_then(|receipt| {
            if receipt.status() {
                Ok(())
            } else {
                Err("account creation was rejected".into())
            }
        })?;

    let final_context =
        read_account_setup_context(provider, exchange_address, signer_address).await?;
    if final_context.account_id.is_zero()
        || final_context.collateral_token != context.collateral_token
    {
        return Err("account setup did not produce the expected account".into());
    }
    Ok(final_context.account_id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TestnetAttestation {
    pub chain_id: u64,
    pub exchange: &'static str,
}

impl TestnetAttestation {
    pub fn verify(chain_id: u64, exchange: &str) -> Result<Self, &'static str> {
        if chain_id != TESTNET_CHAIN_ID {
            return Err("wallet worker requires Monad testnet");
        }
        if exchange.to_ascii_lowercase() != TESTNET_EXCHANGE {
            return Err("wallet worker exchange mismatch");
        }
        Ok(Self {
            chain_id,
            exchange: TESTNET_EXCHANGE,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubmissionGate(bool);

impl SubmissionGate {
    pub const fn disabled() -> Self {
        Self(false)
    }
    pub const fn explicitly_enabled(value: bool) -> Self {
        Self(value)
    }
    pub const fn is_enabled(self) -> bool {
        self.0
    }
}

pub trait SignerFactory {
    type Signer;
    fn initialize(self) -> Result<Self::Signer, String>;
}

pub struct WalletWorker<S> {
    pub attestation: TestnetAttestation,
    pub signer: S,
    pub timeout: Duration,
}

impl<S> WalletWorker<S> {
    pub fn initialize<F>(
        attestation: TestnetAttestation,
        gate: SubmissionGate,
        factory: F,
    ) -> Result<Self, String>
    where
        F: SignerFactory<Signer = S>,
    {
        if !gate.is_enabled() {
            return Err("transaction submission is disabled".into());
        }
        // The factory is deliberately called only after testnet attestation and the explicit gate.
        Ok(Self {
            attestation,
            signer: factory.initialize()?,
            timeout: Duration::from_secs(15),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiptResolution {
    Confirmed,
    Rejected,
    Ambiguous,
}

pub fn reserve_nonce(chain_nonce: u64, local_nonce: Option<u64>) -> Result<u64, &'static str> {
    let next = local_nonce.map_or(chain_nonce, |nonce| {
        nonce.saturating_add(1).max(chain_nonce)
    });
    if next == u64::MAX {
        return Err("nonce exhausted");
    }
    Ok(next)
}

fn mainnet_submission_nonces(
    chain_nonce: u64,
    action: AccountSetupAction,
) -> Result<(u64, u64), &'static str> {
    let setup_txs = match action {
        AccountSetupAction::Existing { .. } => 0,
        AccountSetupAction::Create { .. } => 1,
        AccountSetupAction::ApproveAndCreate { .. } => 2,
    };
    let order = chain_nonce
        .checked_add(setup_txs)
        .ok_or("nonce exhausted")?;
    let cancel = order.checked_add(1).ok_or("nonce exhausted")?;
    Ok((order, cancel))
}

pub(crate) fn validate_pending_nonce(
    operator_nonce: u64,
    pending_nonce: u64,
) -> Result<u64, String> {
    if operator_nonce != pending_nonce {
        return Err(format!(
            "--chain-nonce ({operator_nonce}) does not match pending account nonce ({pending_nonce})"
        ));
    }
    Ok(pending_nonce)
}

pub fn validate_gas(gas_limit: u64, max_gas_limit: u64) -> Result<(), &'static str> {
    if gas_limit == 0 || gas_limit > max_gas_limit {
        return Err("gas limit outside policy");
    }
    Ok(())
}

pub fn resolve_receipt(receipt: Option<bool>) -> ReceiptResolution {
    match receipt {
        Some(true) => ReceiptResolution::Confirmed,
        Some(false) => ReceiptResolution::Rejected,
        None => ReceiptResolution::Ambiguous,
    }
}

pub fn extract_order_id(
    logs: &[Log],
    exchange_address: Address,
    expected_request_id: u64,
    expected_perpetual_id: u32,
) -> Result<u16, String> {
    let mut awaiting_outcome = false;
    let mut placed = Vec::new();
    for log in logs {
        if log.inner.address != exchange_address {
            continue;
        }
        let Ok(event) = ExchangeEvents::decode_log(&log.inner) else {
            continue;
        };
        match event.data {
            // Legacy pre-v1.1.7.4 event. Superseded on-chain by
            // `OrderRequestV2` below, but a testnet (or older) deployment may
            // still emit this instead, so both arms are kept and fed into the
            // same `requested` slot.
            ExchangeEvents::OrderRequest(event)
                if event.orderDescId == U256::from(expected_request_id)
                    && event.perpId == U256::from(expected_perpetual_id) =>
            {
                if awaiting_outcome {
                    return Err("ambiguous correlated order request sequence".into());
                }
                awaiting_outcome = true;
            }
            ExchangeEvents::OrderRequestV2(event)
                if event.orderDescId == U256::from(expected_request_id)
                    && event.perpId == U256::from(expected_perpetual_id) =>
            {
                if awaiting_outcome {
                    return Err("ambiguous correlated order request sequence".into());
                }
                awaiting_outcome = true;
            }
            ExchangeEvents::OrderPlaced(event) if awaiting_outcome => {
                placed.push(event.orderId);
                awaiting_outcome = false;
            }
            ExchangeEvents::OrderBatchCompleted(_) if awaiting_outcome => {
                return Err("correlated order request produced no OrderPlaced".into());
            }
            ExchangeEvents::OrderRequest(_) | ExchangeEvents::OrderRequestV2(_) => {
                // A different batch position starts a different event context.
                awaiting_outcome = false;
            }
            ExchangeEvents::OrderPlaced(_) => {
                // Outcome for a different request position.
            }
            _ => {
                if awaiting_outcome && matches!(event.data, ExchangeEvents::OrderPostFailed(_)) {
                    return Err("correlated order request failed to post".into());
                }
            }
        }
    }
    if placed.len() != 1 {
        return Err("receipt did not contain exactly one correlated OrderPlaced".into());
    }
    if placed[0] == U256::ZERO {
        return Err("order placed with zero order id".into());
    }
    placed[0]
        .try_into()
        .map_err(|_| "order id exceeds supported range".to_string())
}

pub fn cancel_request(
    request_id: u64,
    perpetual_id: u32,
    order_id: u16,
) -> Result<OrderRequest, String> {
    let order_id = NonZeroU16::new(order_id).ok_or("order id must be positive")?;
    Ok(OrderRequest::new(
        request_id,
        perpetual_id,
        RequestType::Cancel,
        Some(order_id),
        fastnum::UD64::ZERO,
        fastnum::UD64::ZERO,
        None,
        false,
        false,
        false,
        None,
        fastnum::UD64::ZERO,
        None,
        None,
        0,
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CanaryResult {
    pub account_id: U256,
    pub order_id: u16,
    pub order_tx: TxHash,
    pub cancel_tx: TxHash,
}

pub(crate) fn validate_cancel_receipt(
    receipt: &TransactionReceipt,
    exchange_address: Address,
    expected_account_id: U256,
    expected_request_id: u64,
    expected_perpetual_id: u32,
    expected_order_id: u16,
) -> Result<(), String> {
    if !receipt.status() {
        return Err("cancel transaction was rejected".into());
    }
    validate_cancel_logs(
        receipt.inner.logs(),
        exchange_address,
        expected_account_id,
        expected_request_id,
        expected_perpetual_id,
        expected_order_id,
    )
}

fn validate_cancel_logs(
    logs: &[Log],
    exchange_address: Address,
    expected_account_id: U256,
    expected_request_id: u64,
    expected_perpetual_id: u32,
    expected_order_id: u16,
) -> Result<(), String> {
    let mut correlated = false;
    let mut cancelled = 0usize;
    for log in logs {
        if log.inner.address != exchange_address {
            continue;
        }
        let Ok(event) = ExchangeEvents::decode_log(&log.inner).map(|decoded| decoded.data) else {
            continue;
        };
        match event {
            ExchangeEvents::OrderRequest(e)
                if e.accountId == expected_account_id
                    && e.orderDescId == U256::from(expected_request_id)
                    && e.perpId == U256::from(expected_perpetual_id)
                    && e.orderId == U256::from(expected_order_id) =>
            {
                correlated = true
            }
            ExchangeEvents::OrderRequestV2(e)
                if e.accountId == expected_account_id
                    && e.orderDescId == U256::from(expected_request_id)
                    && e.perpId == U256::from(expected_perpetual_id)
                    && e.orderId == U256::from(expected_order_id) =>
            {
                correlated = true
            }
            ExchangeEvents::OrderCancelled(_) if correlated => {
                cancelled += 1;
                correlated = false;
            }
            ExchangeEvents::OrderRequest(_) | ExchangeEvents::OrderRequestV2(_) => {
                correlated = false;
            }
            _ => {}
        }
    }
    if cancelled != 1 {
        return Err("cancel receipt missing or ambiguously contains OrderCancelled".into());
    }
    Ok(())
}

async fn verify_mainnet_order_cleanup<P: Provider + Clone>(
    provider: P,
    exchange_address: Address,
    account_id: U256,
    perpetual_id: u32,
    order_id: u16,
) -> Result<(), String> {
    let block_id = BlockId::number(
        provider
            .get_block_number()
            .await
            .map_err(|error| format!("post-cancel block refresh failed: {error}"))?,
    );
    let exchange = Exchange::new(exchange_address, provider);
    // The pinned ABI documents getOrderIdIndex as the authoritative set of
    // currently used IDs. The pinned SDK likewise calls getOrder only for IDs
    // present in this bitmap; it does not define a missing-order zero sentinel.
    // Query getOrder after cancellation as an additional refresh, but do not
    // infer absence from undocumented zero-field behaviour.
    let post_cancel_order = exchange
        .getOrder(U256::from(perpetual_id), U256::from(order_id))
        .block(block_id)
        .call()
        .await
        .map_err(|error| format!("post-cancel exact-order refresh failed: {error}"))?;
    let exact_index = exchange
        .getOrderIdIndex(U256::from(perpetual_id))
        .block(block_id)
        .call()
        .await
        .map_err(|error| format!("post-cancel order-index refresh failed: {error}"))?;
    let still_open = order_index_contains(&exact_index.leaves, order_id);
    if still_open {
        if indexed_order_belongs_to_account(&post_cancel_order, account_id, order_id)? {
            return Err(format!("cancelled order {order_id} is still open"));
        }
        // The 16-bit order id has already been reused by another account. The
        // target identity is absent, but the replacement remains part of the
        // allowlist-wide unexpected-order scan below.
    }

    for perp_id in [1u32, 20u32] {
        let index = exchange
            .getOrderIdIndex(U256::from(perp_id))
            .block(block_id)
            .call()
            .await
            .map_err(|error| {
                format!("post-cancel open-order refresh failed for perp {perp_id}: {error}")
            })?;
        for (leaf_index, leaf) in index.leaves.iter().enumerate() {
            for offset in 0..256usize {
                let candidate = leaf_index * 256 + offset;
                if candidate == 0 || candidate > u16::MAX as usize || !leaf.bit(offset) {
                    continue;
                }
                let order = exchange
                    .getOrder(U256::from(perp_id), U256::from(candidate))
                    .block(block_id)
                    .call()
                    .await
                    .map_err(|error| format!("post-cancel order refresh failed: {error}"))?;
                if order.orderId != candidate as u16 {
                    return Err(format!(
                        "open-order identity mismatch: perp={perp_id} index_id={candidate} returned_id={}",
                        order.orderId
                    ));
                }
                if U256::from(order.accountId) == account_id {
                    return Err(format!(
                        "unexpected open order for canary account: perp={perp_id} order={candidate}"
                    ));
                }
            }
        }
    }
    Ok(())
}

fn indexed_order_belongs_to_account(
    order: &Exchange::Order,
    account_id: U256,
    order_id: u16,
) -> Result<bool, String> {
    if order.orderId != order_id {
        return Err(format!(
            "indexed order id mismatch: expected {order_id}, got {}",
            order.orderId
        ));
    }
    Ok(U256::from(order.accountId) == account_id)
}

async fn verify_mainnet_order_placement<P: Provider + Clone>(
    provider: P,
    exchange_address: Address,
    account_id: U256,
    perpetual_id: u32,
    order_id: u16,
) -> Result<(), String> {
    let exchange = Exchange::new(exchange_address, provider);
    let index = exchange
        .getOrderIdIndex(U256::from(perpetual_id))
        .call()
        .await
        .map_err(|error| format!("pre-cancel order-index refresh failed: {error}"))?;
    if !order_index_contains(&index.leaves, order_id) {
        return Err(format!(
            "placed order {order_id} is not present in the refreshed order index"
        ));
    }
    let order = exchange
        .getOrder(U256::from(perpetual_id), U256::from(order_id))
        .call()
        .await
        .map_err(|error| format!("pre-cancel exact-order refresh failed: {error}"))?;
    validate_exact_order_identity(&order, account_id, order_id)
}

fn validate_exact_order_identity(
    order: &Exchange::Order,
    account_id: U256,
    order_id: u16,
) -> Result<(), String> {
    if order.orderId != order_id {
        return Err(format!(
            "exact-order id mismatch: expected {order_id}, got {}",
            order.orderId
        ));
    }
    if U256::from(order.accountId) != account_id {
        return Err(format!(
            "exact-order account mismatch for order {order_id}: expected {account_id}, got {}",
            order.accountId
        ));
    }
    Ok(())
}

fn order_index_contains(leaves: &[U256], order_id: u16) -> bool {
    let bit = usize::from(order_id);
    leaves
        .get(bit / 256)
        .is_some_and(|leaf| leaf.bit(bit % 256))
}

/// One-shot, testnet-only canary. The provider must already be configured with
/// the Rust-owned signer; no signer material is accepted from TypeScript.
#[allow(clippy::too_many_arguments)]
pub async fn run_testnet_canary<P: Provider + Clone, S>(
    worker: &WalletWorker<S>,
    provider: P,
    gate: SubmissionGate,
    exchange_address: Address,
    signer_address: Address,
    snapshot: &state::Exchange,
    order: OrderRequest,
    order_request_id: u64,
    perpetual_id: u32,
    cancel_request_id: u64,
    chain_nonce: u64,
    gas_limit: u64,
) -> Result<CanaryResult, String> {
    let context =
        read_account_setup_context(provider.clone(), exchange_address, signer_address).await?;
    let account_id = execute_account_setup(
        provider.clone(),
        worker.attestation,
        gate,
        exchange_address,
        signer_address,
        context,
        chain_nonce,
        gas_limit,
    )
    .await?;
    let order_receipt = submit_exec_orders_receipt(
        provider.clone(),
        worker.attestation,
        gate,
        snapshot,
        exchange_address,
        signer_address,
        &[order],
        gas_limit,
    )
    .await?;
    let order_id = extract_order_id(
        order_receipt.inner.logs(),
        exchange_address,
        order_request_id,
        perpetual_id,
    )?;
    let cancel = cancel_request(cancel_request_id, perpetual_id, order_id)?;
    let cancel_receipt = submit_exec_orders_receipt(
        provider.clone(),
        worker.attestation,
        gate,
        snapshot,
        exchange_address,
        signer_address,
        &[cancel],
        gas_limit,
    )
    .await?;
    validate_cancel_receipt(
        &cancel_receipt,
        exchange_address,
        account_id,
        cancel_request_id,
        perpetual_id,
        order_id,
    )?;
    let final_context =
        read_account_setup_context(provider, exchange_address, signer_address).await?;
    if final_context.account_id != account_id {
        return Err("post-canary account identity mismatch".into());
    }
    Ok(CanaryResult {
        account_id,
        order_id,
        order_tx: order_receipt.transaction_hash,
        cancel_tx: cancel_receipt.transaction_hash,
    })
}

/// The pinned SDK transaction path: `OrderRequest::prepare` -> generated
/// `Exchange::execOrders` -> Alloy `send` -> `get_receipt`.
/// This function is intentionally not wired into the read-only bridge.
#[allow(clippy::too_many_arguments)]
pub async fn submit_exec_orders<P: Provider + Clone>(
    provider: P,
    attestation: TestnetAttestation,
    gate: SubmissionGate,
    snapshot: &state::Exchange,
    exchange_address: Address,
    signer_address: Address,
    requests: &[OrderRequest],
    gas_limit: u64,
) -> Result<(TxHash, bool), String> {
    let receipt = submit_exec_orders_receipt(
        provider,
        attestation,
        gate,
        snapshot,
        exchange_address,
        signer_address,
        requests,
        gas_limit,
    )
    .await?;
    Ok((receipt.transaction_hash, receipt.status()))
}

#[allow(clippy::too_many_arguments)]
pub async fn submit_exec_orders_receipt<P: Provider + Clone>(
    provider: P,
    attestation: TestnetAttestation,
    gate: SubmissionGate,
    snapshot: &state::Exchange,
    exchange_address: Address,
    signer_address: Address,
    requests: &[OrderRequest],
    gas_limit: u64,
) -> Result<TransactionReceipt, String> {
    if attestation
        != TestnetAttestation::verify(TESTNET_CHAIN_ID, TESTNET_EXCHANGE)
            .map_err(|e| e.to_string())?
    {
        return Err("testnet attestation mismatch".into());
    }
    if !gate.is_enabled() {
        return Err("transaction submission is disabled".into());
    }
    validate_gas(gas_limit, 150_000_000)?;
    let descs = requests
        .iter()
        .map(|request| request.prepare(snapshot))
        .collect();
    let pending = Exchange::new(exchange_address, provider)
        .execOrders(descs, true)
        .from(signer_address)
        .gas(gas_limit)
        .send()
        .await
        .map_err(|error| format!("transaction submission failed: {error}"))?;
    let receipt = tokio::time::timeout(Duration::from_secs(15), pending.get_receipt())
        .await
        .map_err(|_| "receipt timed out; transaction is ambiguous".to_string())?
        .map_err(|error| format!("receipt lookup failed; transaction is ambiguous: {error}"))?;
    Ok(receipt)
}

/// Mainnet counterpart of [`TestnetAttestation`]. A distinct type by design:
/// nothing that only holds a `TestnetAttestation` can ever be mistaken for
/// mainnet-attested, and vice versa - the compiler enforces the separation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MainnetAttestation {
    pub chain_id: u64,
    pub exchange: &'static str,
}

impl MainnetAttestation {
    pub fn verify(chain_id: u64, exchange: &str) -> Result<Self, &'static str> {
        if chain_id != MAINNET_CHAIN_ID {
            return Err("wallet worker requires Monad mainnet");
        }
        if exchange.to_ascii_lowercase() != MAINNET_EXCHANGE {
            return Err("wallet worker exchange mismatch");
        }
        Ok(Self {
            chain_id,
            exchange: MAINNET_EXCHANGE,
        })
    }
}

/// Mainnet counterpart of [`WalletWorker`], duplicated rather than shared so the
/// testnet type/functions above are never touched by mainnet-path changes.
pub struct MainnetWalletWorker<S> {
    pub attestation: MainnetAttestation,
    pub signer: S,
    pub timeout: Duration,
}

impl<S> MainnetWalletWorker<S> {
    pub fn initialize<F>(
        attestation: MainnetAttestation,
        gate: SubmissionGate,
        factory: F,
    ) -> Result<Self, String>
    where
        F: SignerFactory<Signer = S>,
    {
        if !gate.is_enabled() {
            return Err("transaction submission is disabled".into());
        }
        // The factory is deliberately called only after mainnet attestation and the explicit gate.
        Ok(Self {
            attestation,
            signer: factory.initialize()?,
            timeout: Duration::from_secs(15),
        })
    }
}

/// Mainnet counterpart of [`execute_account_setup`]. Fully duplicated (not
/// shared/refactored) so the testnet function above is byte-for-byte
/// untouched. The only substantive differences are the attestation type
/// checked and the gas ceiling ([`MAINNET_MAX_GAS_LIMIT`] instead of
/// `150_000_000`).
#[allow(clippy::too_many_arguments)]
pub async fn execute_account_setup_mainnet<P: Provider + Clone>(
    provider: P,
    attestation: MainnetAttestation,
    gate: SubmissionGate,
    exchange_address: Address,
    signer_address: Address,
    context: AccountSetupContext,
    chain_nonce: u64,
    gas_limit: u64,
) -> Result<U256, String> {
    if attestation
        != MainnetAttestation::verify(MAINNET_CHAIN_ID, MAINNET_EXCHANGE)
            .map_err(|error| error.to_string())?
    {
        return Err("mainnet attestation mismatch".into());
    }
    if !gate.is_enabled() {
        return Err("transaction submission is disabled".into());
    }
    validate_gas(gas_limit, MAINNET_MAX_GAS_LIMIT)?;
    let action = plan_account_setup(context)?;
    if let AccountSetupAction::Existing { account_id } = action {
        return Ok(account_id);
    }

    let mut nonce = reserve_nonce(chain_nonce, None).map_err(|error| error.to_string())?;
    if let AccountSetupAction::ApproveAndCreate { amount_cns } = action {
        let pending = TestToken::new(context.collateral_token, provider.clone())
            .approve(exchange_address, amount_cns)
            .from(signer_address)
            .nonce(nonce)
            .gas(gas_limit)
            .send()
            .await
            .map_err(|error| format!("collateral approval submission failed: {error}"))?;
        tokio::time::timeout(Duration::from_secs(15), pending.get_receipt())
            .await
            .map_err(|_| "approval receipt timed out; transaction is ambiguous".to_string())?
            .map_err(|error| format!("approval receipt failed; transaction is ambiguous: {error}"))
            .and_then(|receipt| {
                if receipt.status() {
                    Ok(())
                } else {
                    Err("collateral approval was rejected".into())
                }
            })?;
        nonce = nonce.checked_add(1).ok_or("nonce exhausted")?;
    }

    let amount_cns = match action {
        AccountSetupAction::ApproveAndCreate { amount_cns }
        | AccountSetupAction::Create { amount_cns } => amount_cns,
        AccountSetupAction::Existing { .. } => unreachable!(),
    };
    let pending = Exchange::new(exchange_address, provider.clone())
        .createAccount(amount_cns)
        .from(signer_address)
        .nonce(nonce)
        .gas(gas_limit)
        .send()
        .await
        .map_err(|error| format!("account creation submission failed: {error}"))?;
    tokio::time::timeout(Duration::from_secs(15), pending.get_receipt())
        .await
        .map_err(|_| "account creation receipt timed out; transaction is ambiguous".to_string())?
        .map_err(|error| {
            format!("account creation receipt failed; transaction is ambiguous: {error}")
        })
        .and_then(|receipt| {
            if receipt.status() {
                Ok(())
            } else {
                Err("account creation was rejected".into())
            }
        })?;

    let final_context =
        read_account_setup_context(provider, exchange_address, signer_address).await?;
    if final_context.account_id.is_zero()
        || final_context.collateral_token != context.collateral_token
    {
        return Err("account setup did not produce the expected account".into());
    }
    Ok(final_context.account_id)
}

/// Mainnet counterpart of [`submit_exec_orders_receipt`]. Fully duplicated for
/// the same reason as [`execute_account_setup_mainnet`].
#[allow(clippy::too_many_arguments)]
pub async fn submit_exec_orders_receipt_mainnet<P: Provider + Clone>(
    provider: P,
    attestation: MainnetAttestation,
    gate: SubmissionGate,
    snapshot: &state::Exchange,
    exchange_address: Address,
    signer_address: Address,
    requests: &[OrderRequest],
    nonce: u64,
    gas_limit: u64,
) -> Result<TransactionReceipt, String> {
    if attestation
        != MainnetAttestation::verify(MAINNET_CHAIN_ID, MAINNET_EXCHANGE)
            .map_err(|e| e.to_string())?
    {
        return Err("mainnet attestation mismatch".into());
    }
    if !gate.is_enabled() {
        return Err("transaction submission is disabled".into());
    }
    validate_gas(gas_limit, MAINNET_MAX_GAS_LIMIT)?;
    let descs = requests
        .iter()
        .map(|request| request.prepare(snapshot))
        .collect();
    let pending = Exchange::new(exchange_address, provider)
        .execOrders(descs, true)
        .from(signer_address)
        .nonce(nonce)
        .gas(gas_limit)
        .send()
        .await
        .map_err(|error| format!("transaction submission failed: {error}"))?;
    let receipt = tokio::time::timeout(Duration::from_secs(15), pending.get_receipt())
        .await
        .map_err(|_| "receipt timed out; transaction is ambiguous".to_string())?
        .map_err(|error| format!("receipt lookup failed; transaction is ambiguous: {error}"))?;
    Ok(receipt)
}

/// Mainnet counterpart of [`run_testnet_canary`]. Fully duplicated for the same
/// reason as [`execute_account_setup_mainnet`]; calls only the `_mainnet`
/// gated functions above, never the testnet ones.
#[allow(clippy::too_many_arguments)]
pub async fn run_mainnet_canary<P: Provider + Clone, S>(
    worker: &MainnetWalletWorker<S>,
    provider: P,
    gate: SubmissionGate,
    exchange_address: Address,
    signer_address: Address,
    snapshot: &state::Exchange,
    order: OrderRequest,
    order_request_id: u64,
    perpetual_id: u32,
    cancel_request_id: u64,
    chain_nonce: u64,
    gas_limit: u64,
) -> Result<CanaryResult, String> {
    let pending_nonce = provider
        .get_transaction_count(signer_address)
        .pending()
        .await
        .map_err(|error| format!("pending nonce refresh failed: {error}"))?;
    let chain_nonce = validate_pending_nonce(chain_nonce, pending_nonce)?;
    let context =
        read_account_setup_context(provider.clone(), exchange_address, signer_address).await?;
    let account_id = execute_account_setup_mainnet(
        provider.clone(),
        worker.attestation,
        gate,
        exchange_address,
        signer_address,
        context,
        chain_nonce,
        gas_limit,
    )
    .await?;
    let (order_nonce, cancel_nonce) =
        mainnet_submission_nonces(chain_nonce, plan_account_setup(context)?)?;
    let order_receipt = submit_exec_orders_receipt_mainnet(
        provider.clone(),
        worker.attestation,
        gate,
        snapshot,
        exchange_address,
        signer_address,
        &[order],
        order_nonce,
        gas_limit,
    )
    .await?;
    let order_id = extract_order_id(
        order_receipt.inner.logs(),
        exchange_address,
        order_request_id,
        perpetual_id,
    )?;
    println!(
        "PLACEMENT RECORDED: order_tx={:#x}",
        order_receipt.transaction_hash
    );
    println!("PLACEMENT RECORDED: order_id={order_id}");
    use std::io::Write as _;
    std::io::stdout().flush().map_err(|error| {
        eprintln!(
            "*** MANUAL CLEANUP REQUIRED: order_tx={:#x} order_id={} perp_id={} ***",
            order_receipt.transaction_hash, order_id, perpetual_id
        );
        format!("failed to persist placement identifiers to stdout: {error}")
    })?;
    let cleanup = async {
        verify_mainnet_order_placement(
            provider.clone(),
            exchange_address,
            account_id,
            perpetual_id,
            order_id,
        )
        .await?;
        let cancel = cancel_request(cancel_request_id, perpetual_id, order_id)?;
        let cancel_receipt = submit_exec_orders_receipt_mainnet(
            provider.clone(),
            worker.attestation,
            gate,
            snapshot,
            exchange_address,
            signer_address,
            &[cancel],
            cancel_nonce,
            gas_limit,
        )
        .await?;
        validate_cancel_receipt(
            &cancel_receipt,
            exchange_address,
            account_id,
            cancel_request_id,
            perpetual_id,
            order_id,
        )?;
        verify_mainnet_order_cleanup(
            provider.clone(),
            exchange_address,
            account_id,
            perpetual_id,
            order_id,
        )
        .await?;
        Ok::<TransactionReceipt, String>(cancel_receipt)
    }
    .await;
    let cancel_receipt = cleanup.map_err(|error| {
        eprintln!(
            "*** MANUAL CLEANUP REQUIRED: order_tx={:#x} order_id={} perp_id={} ***",
            order_receipt.transaction_hash, order_id, perpetual_id
        );
        format!("{error}; MANUAL CLEANUP REQUIRED for order {order_id}")
    })?;
    let final_context = read_account_setup_context(provider, exchange_address, signer_address)
        .await
        .map_err(|error| {
            eprintln!("*** MANUAL CLEANUP REQUIRED: verify account/order state manually for order_id={} perp_id={} ***", order_id, perpetual_id);
            error
        })?;
    if final_context.account_id != account_id {
        eprintln!(
            "*** MANUAL CLEANUP REQUIRED: verify account/order state manually for order_id={} perp_id={} ***",
            order_id, perpetual_id
        );
        return Err("post-canary account identity mismatch".into());
    }
    Ok(CanaryResult {
        account_id,
        order_id,
        order_tx: order_receipt.transaction_hash,
        cancel_tx: cancel_receipt.transaction_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::{primitives::Log as PrimitiveLog, sol_types::SolEvent};

    fn rpc_log<E: SolEvent>(address: Address, event: E) -> Log {
        Log {
            inner: PrimitiveLog {
                address,
                data: event.encode_log_data(),
            },
            ..Default::default()
        }
    }

    fn request_event(request_id: u64, perp_id: u32) -> Exchange::OrderRequest {
        Exchange::OrderRequest {
            perpId: U256::from(perp_id),
            accountId: U256::from(1),
            orderDescId: U256::from(request_id),
            orderId: U256::ZERO,
            orderType: 0,
            pricePNS: U256::from(100),
            lotLNS: U256::from(1),
            expiryBlock: U256::ZERO,
            postOnly: true,
            fillOrKill: false,
            immediateOrCancel: false,
            maxMatches: U256::ZERO,
            leverageHdths: U256::from(1),
            lastExecutionBlock: U256::ZERO,
            amountCNS: U256::ZERO,
            maxNegPnlCollatBPS: U256::ZERO,
            gasLeft: U256::from(1),
        }
    }

    fn placed_event(order_id: u64) -> Exchange::OrderPlaced {
        Exchange::OrderPlaced {
            orderId: U256::from(order_id),
            lotLNS: U256::from(1),
            lockedBalanceCNS: U256::ZERO,
            amountCNS: alloy::primitives::I256::ZERO,
            balanceCNS: U256::ZERO,
        }
    }

    struct Factory;
    impl SignerFactory for Factory {
        type Signer = u8;
        fn initialize(self) -> Result<Self::Signer, String> {
            Ok(7)
        }
    }

    struct FailingFactory;
    impl SignerFactory for FailingFactory {
        type Signer = u8;
        fn initialize(self) -> Result<Self::Signer, String> {
            Err("signer initialization failed".into())
        }
    }

    #[test]
    fn attestation_precedes_gated_signer_initialization() {
        let attestation = TestnetAttestation::verify(TESTNET_CHAIN_ID, TESTNET_EXCHANGE).unwrap();
        assert!(
            WalletWorker::initialize(attestation, SubmissionGate::disabled(), Factory).is_err()
        );
        let worker = WalletWorker::initialize(
            attestation,
            SubmissionGate::explicitly_enabled(true),
            Factory,
        )
        .unwrap();
        assert_eq!(worker.signer, 7);
    }

    #[test]
    fn a_failing_factory_fails_the_worker_closed_without_a_signer() {
        let attestation = TestnetAttestation::verify(TESTNET_CHAIN_ID, TESTNET_EXCHANGE).unwrap();
        let result = WalletWorker::initialize(
            attestation,
            SubmissionGate::explicitly_enabled(true),
            FailingFactory,
        );
        match result {
            Err(error) => assert_eq!(error, "signer initialization failed"),
            Ok(_) => panic!("expected a failing factory to fail worker initialization"),
        }
    }

    #[test]
    fn a_disabled_gate_is_rejected_before_the_factory_ever_runs() {
        let attestation = TestnetAttestation::verify(TESTNET_CHAIN_ID, TESTNET_EXCHANGE).unwrap();
        let result =
            WalletWorker::initialize(attestation, SubmissionGate::disabled(), FailingFactory);
        match result {
            Err(error) => assert_eq!(error, "transaction submission is disabled"),
            Ok(_) => panic!("expected a disabled gate to reject before the factory ever runs"),
        }
    }

    #[test]
    fn nonce_gas_and_receipt_fail_closed() {
        assert_eq!(reserve_nonce(4, Some(6)).unwrap(), 7);
        assert!(validate_gas(0, 100).is_err());
        assert_eq!(resolve_receipt(None), ReceiptResolution::Ambiguous);
        assert_eq!(resolve_receipt(Some(false)), ReceiptResolution::Rejected);
    }

    #[test]
    fn order_identity_and_cancel_fail_closed_without_exact_logs() {
        assert!(extract_order_id(&[], Address::ZERO, 2, 16).is_err());
        assert!(cancel_request(2, 16, 0).is_err());
        assert!(cancel_request(2, 16, 9).is_ok());
    }

    #[test]
    fn placement_correlation_ignores_unrelated_contract_logs() {
        let exchange = Address::from([7u8; 20]);
        let unrelated = rpc_log(Address::from([8u8; 20]), placed_event(99));
        let request = rpc_log(exchange, request_event(42, 1));
        let placed = rpc_log(exchange, placed_event(9));
        assert_eq!(
            extract_order_id(&[unrelated, request, placed], exchange, 42, 1).unwrap(),
            9
        );
    }

    #[test]
    fn placement_correlation_rejects_zero_and_wrong_positions() {
        let exchange = Address::from([7u8; 20]);
        let request = || rpc_log(exchange, request_event(42, 1));
        let zero = rpc_log(exchange, placed_event(0));
        assert!(extract_order_id(&[request(), zero], exchange, 42, 1).is_err());
        let other_request = rpc_log(exchange, request_event(43, 20));
        let placed = rpc_log(exchange, placed_event(9));
        assert!(extract_order_id(&[request(), other_request, placed], exchange, 42, 1).is_err());
    }

    #[test]
    fn cancellation_is_positionally_correlated_and_ignores_unrelated_logs() {
        let exchange = Address::from([7u8; 20]);
        let unrelated = rpc_log(
            Address::from([8u8; 20]),
            Exchange::OrderCancelled {
                lockedBalanceCNS: U256::ZERO,
                amountCNS: alloy::primitives::I256::ZERO,
                balanceCNS: U256::ZERO,
            },
        );
        let mut request = request_event(43, 1);
        request.orderId = U256::from(9);
        request.orderType = 4;
        let request = rpc_log(exchange, request);
        let cancelled = || {
            rpc_log(
                exchange,
                Exchange::OrderCancelled {
                    lockedBalanceCNS: U256::ZERO,
                    amountCNS: alloy::primitives::I256::ZERO,
                    balanceCNS: U256::ZERO,
                },
            )
        };
        assert!(
            validate_cancel_logs(
                &[unrelated, request, cancelled()],
                exchange,
                U256::from(1),
                43,
                1,
                9
            )
            .is_ok()
        );
        assert!(validate_cancel_logs(&[], exchange, U256::from(1), 43, 1, 9).is_err());

        let mut wrong_account = request_event(43, 1);
        wrong_account.accountId = U256::from(2);
        wrong_account.orderId = U256::from(9);
        wrong_account.orderType = 4;
        assert!(
            validate_cancel_logs(
                &[rpc_log(exchange, wrong_account), cancelled()],
                exchange,
                U256::from(1),
                43,
                1,
                9
            )
            .is_err()
        );
    }

    #[test]
    fn post_cancel_identity_distinguishes_target_from_reused_id() {
        let order = |account_id, order_id| Exchange::Order {
            accountId: account_id,
            orderType: 0,
            priceONS: alloy::primitives::Uint::<24, 1>::ZERO,
            lotLNS: alloy::primitives::Uint::<40, 1>::ZERO,
            recycleFeeRaw: 0,
            expiryBlock: 0,
            leverageHdths: 0,
            orderId: order_id,
            prevOrderId: 0,
            nextOrderId: 0,
            maxNegPnlCollatBPS: 0,
        };
        let target = order(5071, 47);
        assert!(indexed_order_belongs_to_account(&target, U256::from(5071), 47).unwrap());

        let reused = order(25, 47);
        assert!(!indexed_order_belongs_to_account(&reused, U256::from(5071), 47).unwrap());

        let inconsistent = order(25, 48);
        assert!(indexed_order_belongs_to_account(&inconsistent, U256::from(5071), 47).is_err());
    }

    #[test]
    fn documented_order_index_bits_drive_exact_removal_check() {
        let mut leaves = vec![U256::ZERO];
        leaves[0].set_bit(9, true);
        assert!(order_index_contains(&leaves, 9));
        leaves[0].set_bit(9, false);
        assert!(!order_index_contains(&leaves, 9));
    }

    #[test]
    fn mainnet_place_and_cancel_nonces_follow_setup_transactions() {
        let existing = AccountSetupAction::Existing {
            account_id: U256::from(1),
        };
        let create = AccountSetupAction::Create {
            amount_cns: U256::from(1),
        };
        let approve = AccountSetupAction::ApproveAndCreate {
            amount_cns: U256::from(1),
        };
        assert_eq!(mainnet_submission_nonces(10, existing).unwrap(), (10, 11));
        assert_eq!(mainnet_submission_nonces(10, create).unwrap(), (11, 12));
        assert_eq!(mainnet_submission_nonces(10, approve).unwrap(), (12, 13));
        assert!(mainnet_submission_nonces(u64::MAX, existing).is_err());
        assert_eq!(validate_pending_nonce(10, 10).unwrap(), 10);
        assert!(validate_pending_nonce(10, 11).is_err());
    }

    #[test]
    fn account_setup_uses_only_current_on_chain_minimum() {
        let token = Address::from([1u8; 20]);
        let context = AccountSetupContext {
            minimum_cns: U256::from(123u64),
            account_id: U256::ZERO,
            collateral_token: token,
            allowance_cns: U256::from(122u64),
        };
        assert_eq!(
            plan_account_setup(context).unwrap(),
            AccountSetupAction::ApproveAndCreate {
                amount_cns: U256::from(123u64)
            }
        );
        assert_eq!(
            plan_account_setup(AccountSetupContext {
                allowance_cns: U256::from(999u64),
                ..context
            })
            .unwrap(),
            AccountSetupAction::Create {
                amount_cns: U256::from(123u64)
            }
        );
        assert_eq!(
            plan_account_setup(AccountSetupContext {
                account_id: U256::from(7u64),
                ..context
            })
            .unwrap(),
            AccountSetupAction::Existing {
                account_id: U256::from(7u64)
            }
        );
    }

    #[test]
    fn account_setup_rejects_unsafe_read_values() {
        let base = AccountSetupContext {
            minimum_cns: U256::from(1u64),
            account_id: U256::ZERO,
            collateral_token: Address::from([1u8; 20]),
            allowance_cns: U256::ZERO,
        };
        assert!(
            plan_account_setup(AccountSetupContext {
                minimum_cns: U256::ZERO,
                ..base
            })
            .is_err()
        );
        assert!(
            plan_account_setup(AccountSetupContext {
                collateral_token: Address::ZERO,
                ..base
            })
            .is_err()
        );
    }

    #[test]
    fn mainnet_attestation_precedes_gated_signer_initialization() {
        let attestation = MainnetAttestation::verify(MAINNET_CHAIN_ID, MAINNET_EXCHANGE).unwrap();
        assert!(
            MainnetWalletWorker::initialize(attestation, SubmissionGate::disabled(), Factory)
                .is_err()
        );
        let worker = MainnetWalletWorker::initialize(
            attestation,
            SubmissionGate::explicitly_enabled(true),
            Factory,
        )
        .unwrap();
        assert_eq!(worker.signer, 7);
    }

    #[test]
    fn mainnet_worker_fails_closed_on_a_failing_factory_or_disabled_gate() {
        let attestation = MainnetAttestation::verify(MAINNET_CHAIN_ID, MAINNET_EXCHANGE).unwrap();
        let result = MainnetWalletWorker::initialize(
            attestation,
            SubmissionGate::explicitly_enabled(true),
            FailingFactory,
        );
        match result {
            Err(error) => assert_eq!(error, "signer initialization failed"),
            Ok(_) => panic!("expected a failing factory to fail worker initialization"),
        }
        let result = MainnetWalletWorker::initialize(
            attestation,
            SubmissionGate::disabled(),
            FailingFactory,
        );
        match result {
            Err(error) => assert_eq!(error, "transaction submission is disabled"),
            Ok(_) => panic!("expected a disabled gate to reject before the factory ever runs"),
        }
    }

    #[test]
    fn mainnet_and_testnet_attestations_are_never_interchangeable() {
        assert!(MainnetAttestation::verify(TESTNET_CHAIN_ID, TESTNET_EXCHANGE).is_err());
        assert!(TestnetAttestation::verify(MAINNET_CHAIN_ID, MAINNET_EXCHANGE).is_err());
    }

    #[test]
    fn mainnet_gas_cap_is_far_tighter_than_testnets() {
        assert!(validate_gas(MAINNET_MAX_GAS_LIMIT, MAINNET_MAX_GAS_LIMIT).is_ok());
        assert!(validate_gas(MAINNET_MAX_GAS_LIMIT + 1, MAINNET_MAX_GAS_LIMIT).is_err());
        const _: () = assert!(MAINNET_MAX_GAS_LIMIT < 150_000_000);
    }
}
