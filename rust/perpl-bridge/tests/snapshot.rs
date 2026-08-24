use riim_perpl_bridge::perpl::validate_hello;
use riim_perpl_bridge::protocol::Market;

#[test]
fn snapshot_scope_pins_mainnet_account_and_markets() {
    let btc = [Market {
        symbol: "BTCUSD".into(),
        perpetual_id: 1,
    }];
    assert!(validate_hello("mainnet", "https://rpc.monad.xyz", &btc, &[5071]).is_ok());
    let eth = [Market {
        symbol: "ETHUSD".into(),
        perpetual_id: 2,
    }];
    assert!(validate_hello("mainnet", "https://rpc.monad.xyz", &eth, &[5071]).is_ok());
    assert!(validate_hello("testnet", "https://testnet-rpc.monad.xyz", &btc, &[5071]).is_err());
    assert!(validate_hello("mainnet", "https://rpc.monad.xyz", &btc, &[]).is_err());
    assert!(validate_hello("mainnet", "https://rpc.monad.xyz", &btc, &[7]).is_err());
    let testnet = [Market {
        symbol: "BTCUSD".into(),
        perpetual_id: 16,
    }];
    assert!(validate_hello("mainnet", "https://rpc.monad.xyz", &testnet, &[5071]).is_err());
}
