use riim_perpl_bridge::perpl::validate_hello;
use riim_perpl_bridge::protocol::Market;

#[test]
fn snapshot_scope_rejects_accounts_and_unlisted_markets() {
    let btc = [Market {
        symbol: "BTCUSD".into(),
        perpetual_id: 16,
    }];
    assert!(validate_hello("testnet", "https://testnet-rpc.monad.xyz", &btc, &[]).is_ok());
    assert!(validate_hello("testnet", "https://testnet-rpc.monad.xyz", &btc, &[1]).is_err());
    let mainnet = [Market {
        symbol: "BTCUSD".into(),
        perpetual_id: 1,
    }];
    assert!(validate_hello("testnet", "https://testnet-rpc.monad.xyz", &mainnet, &[]).is_err());
}
