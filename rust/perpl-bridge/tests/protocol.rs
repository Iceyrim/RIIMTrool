use riim_perpl_bridge::{
    perpl::validate_hello,
    protocol::{Request, decode},
};

#[test]
fn accepts_only_the_versioned_mainnet_read_only_hello() {
    let request = decode(r#"{"version":1,"id":"one","command":"hello","network":"mainnet","rpcUrl":"https://rpc.monad.xyz","markets":[{"symbol":"BTCUSD","perpetualId":1}],"accountIds":[5071]}"#).unwrap();
    let Request::Hello {
        network,
        rpc_url,
        markets,
        account_ids,
        ..
    } = request;
    validate_hello(&network, &rpc_url, &markets, &account_ids).unwrap();
}

#[test]
fn rejects_testnet_custom_signer_and_prepare_fields() {
    assert!(decode(r#"{"version":1,"id":"one","command":"hello","network":"testnet","rpcUrl":"https://testnet-rpc.monad.xyz","markets":[{"symbol":"BTCUSD","perpetualId":16}],"accountIds":[7]}"#).and_then(|request| match request { Request::Hello { ref network, ref rpc_url, ref markets, ref account_ids, .. } => validate_hello(network, rpc_url, markets, account_ids).map(|_| request) }).is_err());
    assert!(decode(r#"{"version":1,"id":"one","command":"hello","network":"testnet","rpcUrl":"https://testnet-rpc.monad.xyz","markets":[{"symbol":"BTCUSD","perpetualId":16}],"accountIds":[],"privateKey":"forbidden"}"#).is_err());
    assert!(decode(r#"{"version":1,"id":"one","command":"prepare_exec_orders","revertOnFail":true,"orders":[]}"#).is_err());
}
