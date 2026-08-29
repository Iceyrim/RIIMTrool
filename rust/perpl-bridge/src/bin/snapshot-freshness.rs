use std::time::Duration;

use alloy::providers::ProviderBuilder;
use riim_perpl_bridge::{
    execution_port::build_caught_up_mainnet_snapshot,
    tx,
};

#[tokio::main]
async fn main() -> Result<(), String> {
    let (checks, interval_ms) = parse_args(&std::env::args().skip(1).collect::<Vec<_>>())?;
    let url = tx::MAINNET_RPC
        .parse()
        .map_err(|_| "invalid pinned mainnet RPC".to_string())?;
    let provider = ProviderBuilder::new().connect_http(url);

    for check in 1..=checks {
        let (_, freshness) = build_caught_up_mainnet_snapshot(provider.clone(), 2).await?;
        println!(
            "{}",
            serde_json::json!({
                "mode": "mainnet-read-only-snapshot-freshness",
                "check": check,
                "snapshotBlock": freshness.snapshot_block,
                "safeBlock": freshness.safe_block,
                "lagBlocks": freshness.lag_blocks,
                "replayedBlocks": freshness.replayed_blocks,
                "transactionCapable": false,
            })
        );
        if freshness.lag_blocks > 2 {
            return Err("caught-up snapshot exceeded two safe blocks".into());
        }
        if check < checks {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
        }
    }
    Ok(())
}

fn parse_args(args: &[String]) -> Result<(u8, u64), String> {
    let mut checks = 3u8;
    let mut interval_ms = 1_000u64;
    for arg in args {
        let (key, value) = arg
            .strip_prefix("--")
            .and_then(|value| value.split_once('='))
            .ok_or("arguments must be --key=value")?;
        match key {
            "checks" => checks = value.parse().map_err(|_| "invalid --checks")?,
            "interval-ms" => {
                interval_ms = value.parse().map_err(|_| "invalid --interval-ms")?
            }
            _ => return Err(format!("unknown --{key}")),
        }
    }
    if checks == 0 || checks > 10 {
        return Err("checks must be 1..10".into());
    }
    if interval_ms < 100 || interval_ms > 60_000 {
        return Err("interval-ms must be 100..60000".into());
    }
    Ok((checks, interval_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bounded_read_only_checks() {
        assert_eq!(
            parse_args(&["--checks=3".into(), "--interval-ms=1000".into()]).unwrap(),
            (3, 1000)
        );
        assert!(parse_args(&["--checks=0".into()]).is_err());
        assert!(parse_args(&["--wallet=x".into()]).is_err());
    }
}
