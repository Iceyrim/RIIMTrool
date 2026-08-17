use riim_perpl_bridge::{
    perpl::validate_hello,
    protocol::{Request, decode},
};

#[test]
fn accepts_only_the_versioned_testnet_hello() {
    let request = decode(r#"{"version":1,"id":"one","command":"hello","network":"testnet","rpcUrl":"https://testnet-rpc.monad.xyz","markets":[{"symbol":"BTCUSD","perpetualId":16}],"accountIds":[]}"#).unwrap();
    let Request::Hello {
        network,
        rpc_url,
        markets,
        account_ids,
        ..
    } = request
    else {
        panic!("expected hello")
    };
    validate_hello(&network, &rpc_url, &markets, &account_ids).unwrap();
}

#[test]
fn rejects_mainnet_custom_and_signer_fields() {
    assert!(decode(r#"{"version":1,"id":"one","command":"hello","network":"mainnet","rpcUrl":"https://rpc.monad.xyz","markets":[{"symbol":"BTCUSD","perpetualId":1}],"accountIds":[]}"#).and_then(|request| match request { Request::Hello { ref network, ref rpc_url, ref markets, ref account_ids, .. } => validate_hello(network, rpc_url, markets, account_ids).map(|_| request), _ => unreachable!() }).is_err());
    assert!(decode(r#"{"version":1,"id":"one","command":"hello","network":"testnet","rpcUrl":"https://testnet-rpc.monad.xyz","markets":[{"symbol":"BTCUSD","perpetualId":16}],"accountIds":[],"privateKey":"forbidden"}"#).is_err());
}
