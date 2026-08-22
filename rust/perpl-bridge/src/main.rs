use std::{sync::Arc, time::Duration};

use alloy::{
    providers::{Provider, ProviderBuilder},
    rpc::client::RpcClient,
    transports::layers::{RetryBackoffLayer, ThrottleLayer},
};
use futures::StreamExt;
use perpl_sdk::{Chain, state::SnapshotBuilder, stream, types::StateInstant};
use riim_perpl_bridge::{perpl, protocol};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, RwLock},
};

use protocol::{Request, Response, TESTNET_CHAIN_ID, TESTNET_EXCHANGE, VERSION};

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
    } = request
    else {
        let _ = emit(
            &output,
            &Response::Fatal {
                version: VERSION,
                id: request.id().into(),
                error: "hello must be first".into(),
            },
        )
        .await;
        return;
    };
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
    let chain = Chain::testnet();
    if chain.chain_id() != TESTNET_CHAIN_ID
        || format!("{:#x}", chain.exchange()).to_lowercase() != TESTNET_EXCHANGE
    {
        let _ = emit(
            &output,
            &Response::Fatal {
                version: VERSION,
                id,
                error: "pinned SDK testnet deployment mismatch".into(),
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
    if actual_chain_id != TESTNET_CHAIN_ID {
        let _ = emit(
            &output,
            &Response::Fatal {
                version: VERSION,
                id,
                error: format!("RPC chain id {actual_chain_id} is not testnet"),
            },
        )
        .await;
        return;
    }
    let exchange = match tokio::time::timeout(
        RPC_TIMEOUT,
        SnapshotBuilder::new(&chain, provider.clone())
            .with_perpetuals(markets.iter().map(|market| market.perpetual_id).collect())
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
    let initial = match perpl::snapshot(&exchange, &markets, 0) {
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
            chain_id: TESTNET_CHAIN_ID,
            exchange: TESTNET_EXCHANGE,
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
                if let Err(error) = exchange.apply_events(&result) {
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
                let event_count = result.events().len().try_into().unwrap_or(u32::MAX);
                perpl::snapshot(&exchange, &stream_markets, event_count)
            };
            match snapshot {
                Ok(snapshot) => {
                    if emit(
                        &stream_output,
                        &Response::State {
                            version: VERSION,
                            id: "stream".into(),
                            chain_id: TESTNET_CHAIN_ID,
                            exchange: TESTNET_EXCHANGE,
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
        match request {
            Request::Hello { id, .. } => {
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
            Request::PrepareExecOrders {
                id,
                revert_on_fail,
                orders,
                ..
            } => {
                if !revert_on_fail {
                    let _ = emit(
                        &output,
                        &Response::Fatal {
                            version: VERSION,
                            id,
                            error: "revertOnFail must be true".into(),
                        },
                    )
                    .await;
                    continue;
                }
                let exchange = shared.read().await;
                let block_number = exchange.instant().block_number().to_string();
                match perpl::prepare(&exchange, &markets, &orders) {
                    Ok((calldata, calldata_hash)) => {
                        let _ = emit(
                            &output,
                            &Response::Prepared {
                                version: VERSION,
                                id,
                                chain_id: TESTNET_CHAIN_ID,
                                exchange: TESTNET_EXCHANGE,
                                block_number,
                                calldata,
                                calldata_hash,
                            },
                        )
                        .await;
                    }
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
                    }
                }
            }
        }
    }
}
