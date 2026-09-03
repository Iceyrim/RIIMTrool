use std::{sync::Arc, time::Duration};

use alloy::{
    providers::{Provider, ProviderBuilder},
    rpc::client::RpcClient,
    transports::layers::{RetryBackoffLayer, ThrottleLayer},
};
use futures::StreamExt;
use perpl_sdk::{
    Chain,
    state::SnapshotBuilder,
    stream,
    types::{AccountAddressOrID, StateInstant},
};
use riim_perpl_bridge::{perpl, protocol};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, RwLock},
};

use protocol::{MAINNET_CHAIN_ID, MAINNET_EXCHANGE, Request, Response, VERSION};

const RPC_TIMEOUT: Duration = Duration::from_secs(10);

async fn emit(output: &Arc<Mutex<tokio::io::Stdout>>, response: &Response) -> Result<(), String> {
    let mut line = serde_json::to_vec(response).map_err(|error| error.to_string())?;
    line.push(b'\n');
    let mut output = output.lock().await;
    output
        .write_all(&line)
        .await
        .map_err(|error| error.to_string())?;
    output.flush().await.map_err(|error| error.to_string())
}

#[tokio::main]
async fn main() {
    let output = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let Ok(Some(first)) = lines.next_line().await else {
        return;
    };
    let request = match protocol::decode(&first) {
        Ok(value) => value,
        Err(error) => {
            let _ = emit(
                &output,
                &Response::Fatal {
                    version: VERSION,
                    id: "unknown".into(),
                    error,
                },
            )
            .await;
            return;
        }
    };
    let Request::Hello {
        id,
        network,
        rpc_url,
        markets,
        account_ids,
        ..
    } = request;
    if let Err(error) = perpl::validate_hello(&network, &rpc_url, &markets, &account_ids) {
        let _ = emit(
            &output,
            &Response::Fatal {
                version: VERSION,
                id,
                error,
            },
        )
        .await;
        return;
    }
    let account_id = account_ids[0];
    let client = match RpcClient::builder()
        .layer(ThrottleLayer::new(12))
        .layer(RetryBackoffLayer::new(5, 100, 200))
        .connect(&rpc_url)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            let _ = emit(
                &output,
                &Response::Fatal {
                    version: VERSION,
                    id,
                    error: format!("RPC connection failed: {error}"),
                },
            )
            .await;
            return;
        }
    };
    client.set_poll_interval(Duration::from_millis(500));
    let provider = ProviderBuilder::new().connect_client(client);
    let chain = Chain::mainnet();
    if chain.chain_id() != MAINNET_CHAIN_ID
        || format!("{:#x}", chain.exchange()).to_lowercase() != MAINNET_EXCHANGE
    {
        let _ = emit(
            &output,
            &Response::Fatal {
                version: VERSION,
                id,
                error: "pinned SDK mainnet deployment mismatch".into(),
            },
        )
        .await;
        return;
    }
    let actual_chain_id = match tokio::time::timeout(RPC_TIMEOUT, provider.get_chain_id()).await {
        Ok(Ok(value)) => value,
        _ => {
            let _ = emit(
                &output,
                &Response::Fatal {
                    version: VERSION,
                    id,
                    error: "RPC chain-id check failed or timed out".into(),
                },
            )
            .await;
            return;
        }
    };
    if actual_chain_id != MAINNET_CHAIN_ID {
        let _ = emit(
            &output,
            &Response::Fatal {
                version: VERSION,
                id,
                error: format!("RPC chain id {actual_chain_id} is not mainnet"),
            },
        )
        .await;
        return;
    }
    let exchange = match tokio::time::timeout(
        RPC_TIMEOUT,
        SnapshotBuilder::new(&chain, provider.clone())
            .with_perpetuals(markets.iter().map(|market| market.perpetual_id).collect())
            .with_accounts(vec![AccountAddressOrID::ID(account_id)])
            .with_orders_per_batch(perpl::SNAPSHOT_ITEMS_PER_BATCH)
            .with_positions_per_batch(perpl::SNAPSHOT_ITEMS_PER_BATCH)
            .build(),
    )
    .await
    {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            let _ = emit(
                &output,
                &Response::Fatal {
                    version: VERSION,
                    id,
                    error: format!("snapshot failed: {error}"),
                },
            )
            .await;
            return;
        }
        Err(_) => {
            let _ = emit(
                &output,
                &Response::Fatal {
                    version: VERSION,
                    id,
                    error: "snapshot timed out".into(),
                },
            )
            .await;
            return;
        }
    };
    let fill_coverage_start_block = exchange.instant().block_number();
    let initial = match perpl::snapshot(
        &exchange,
        &markets,
        account_id,
        fill_coverage_start_block,
        &[],
        0,
    ) {
        Ok(value) => value,
        Err(error) => {
            let _ = emit(
                &output,
                &Response::Fatal {
                    version: VERSION,
                    id,
                    error,
                },
            )
            .await;
            return;
        }
    };
    let from = StateInstant::new(exchange.instant().block_number() + 1, 0);
    let shared = Arc::new(RwLock::new(exchange));
    if emit(
        &output,
        &Response::Ready {
            version: VERSION,
            id,
            chain_id: MAINNET_CHAIN_ID,
            exchange: MAINNET_EXCHANGE,
            snapshot: initial,
        },
    )
    .await
    .is_err()
    {
        return;
    }
    let stream_exchange = shared.clone();
    let stream_output = output.clone();
    let stream_markets = markets.clone();
    let stream_chain = chain.clone();
    tokio::spawn(async move {
        let mut observed_fills = Vec::new();
        let mut events = Box::pin(stream::raw(
            &stream_chain,
            provider,
            from,
            tokio::time::sleep,
        ));
        while let Some(result) = events.next().await {
            let result = match result {
                Ok(value) => value,
                Err(error) => {
                    let _ = emit(
                        &stream_output,
                        &Response::Fatal {
                            version: VERSION,
                            id: "stream".into(),
                            error: format!("event stream failed: {error}"),
                        },
                    )
                    .await;
                    return;
                }
            };
            let snapshot = {
                let mut exchange = stream_exchange.write().await;
                let state_events = match exchange.apply_events(&result) {
                    Ok(events) => events,
                    Err(error) => {
                        let _ = emit(
                            &stream_output,
                            &Response::Fatal {
                                version: VERSION,
                                id: "stream".into(),
                                error: format!("event application failed: {error}"),
                            },
                        )
                        .await;
                        return;
                    }
                };
                if let Some(state_events) = state_events {
                    observed_fills.extend(perpl::observed_maker_fills(
                        &state_events,
                        &stream_markets,
                        account_id,
                    ));
                }
                if observed_fills.len() > 1_000 {
                    observed_fills.drain(..observed_fills.len() - 1_000);
                }
                let event_count = result.events().len().try_into().unwrap_or(u32::MAX);
                perpl::snapshot(
                    &exchange,
                    &stream_markets,
                    account_id,
                    fill_coverage_start_block,
                    &observed_fills,
                    event_count,
                )
            };
            match snapshot {
                Ok(snapshot) => {
                    if emit(
                        &stream_output,
                        &Response::State {
                            version: VERSION,
                            id: "stream".into(),
                            chain_id: MAINNET_CHAIN_ID,
                            exchange: MAINNET_EXCHANGE,
                            snapshot,
                        },
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    let _ = emit(
                        &stream_output,
                        &Response::Fatal {
                            version: VERSION,
                            id: "stream".into(),
                            error,
                        },
                    )
                    .await;
                    return;
                }
            }
        }
    });
    while let Ok(Some(line)) = lines.next_line().await {
        let request = match protocol::decode(&line) {
            Ok(value) => value,
            Err(error) => {
                let _ = emit(
                    &output,
                    &Response::Fatal {
                        version: VERSION,
                        id: "unknown".into(),
                        error,
                    },
                )
                .await;
                return;
            }
        };
        let Request::Hello { id, .. } = request;
        let _ = emit(
            &output,
            &Response::Fatal {
                version: VERSION,
                id,
                error: "duplicate hello".into(),
            },
        )
        .await;
        return;
    }
}
