use riim_perpl_bridge::{
    perpl::validate_hello,
    protocol::{AccountEvidence, Fill, Position, Request, decode, decode_execution_intent},
};

#[test]
fn accepts_only_the_versioned_mainnet_read_only_hello() {
    let request = decode(r#"{"version":1,"id":"one","command":"hello","network":"mainnet","rpcUrl":"https://rpc.monad.xyz","markets":[{"symbol":"BTCUSD","perpetualId":1}],"accountIds":[5198]}"#).unwrap();
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
fn serializes_account_and_session_fill_evidence() {
    let account = serde_json::to_value(AccountEvidence {
        balance: "18.34".into(),
        locked_balance: "0".into(),
        available_balance: "18.34".into(),
        unrealized_pnl: "0".into(),
        position_deposit: "0".into(),
        maintenance_requirement: "0".into(),
        frozen: false,
    })
    .unwrap();
    assert_eq!(account["availableBalance"], "18.34");
    let position = serde_json::to_value(Position {
        symbol: "BTCUSD".into(),
        base_size: "0.01".into(),
        mark_price: "65000".into(),
        unrealized_pnl: "2".into(),
        deposit: "100".into(),
        maintenance_requirement: "50".into(),
        liquidation_price: "60000".into(),
        bankruptcy_price: "55000".into(),
        open_order_count: 0,
    })
    .unwrap();
    assert_eq!(position["liquidationPrice"], "60000");
    let fill = serde_json::to_value(Fill {
        exchange_order_id: "78".into(),
        trade_id: "0xabc:1".into(),
        symbol: "BTCUSD".into(),
        side: "buy".into(),
        price: "77000".into(),
        size: "0.00018".into(),
        timestamp: 1_000,
    })
    .unwrap();
    assert_eq!(fill["exchangeOrderId"], "78");
}

#[test]
fn rejects_testnet_custom_signer_and_prepare_fields() {
    assert!(decode(r#"{"version":1,"id":"one","command":"hello","network":"testnet","rpcUrl":"https://testnet-rpc.monad.xyz","markets":[{"symbol":"BTCUSD","perpetualId":16}],"accountIds":[7]}"#).and_then(|request| match request { Request::Hello { ref network, ref rpc_url, ref markets, ref account_ids, .. } => validate_hello(network, rpc_url, markets, account_ids).map(|_| request) }).is_err());
    assert!(decode(r#"{"version":1,"id":"one","command":"hello","network":"testnet","rpcUrl":"https://testnet-rpc.monad.xyz","markets":[{"symbol":"BTCUSD","perpetualId":16}],"accountIds":[],"privateKey":"forbidden"}"#).is_err());
    assert!(decode(r#"{"version":1,"id":"one","command":"prepare_exec_orders","revertOnFail":true,"orders":[]}"#).is_err());
}

#[test]
fn validates_unwired_mainnet_execution_intents_without_adding_them_to_bridge_requests() {
    let place = r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5198,"market":"BTCUSD","perpetualId":1,"actionId":"place-1","side":"buy","orderType":"postOnly","price":"77000","size":"0.00018","reduceOnly":false,"leverage":"1"}"#;
    decode_execution_intent(place).unwrap();
    decode_execution_intent(&place.replace(r#""leverage":"1""#, r#""leverage":"15""#)).unwrap();
    let eth = place
        .replace(
            r#""market":"BTCUSD","perpetualId":1"#,
            r#""market":"ETHUSD","perpetualId":20"#,
        )
        .replace(r#""leverage":"1""#, r#""leverage":"12""#);
    decode_execution_intent(&eth).unwrap();
    assert!(decode(place).is_err());
    let cancel = r#"{"version":1,"id":"y","action":"cancel","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5198,"market":"ETHUSD","perpetualId":20,"actionId":"cancel-1","exchangeOrderId":"47","placementActionId":"place-1"}"#;
    decode_execution_intent(cancel).unwrap();
}

#[test]
fn rejects_unsafe_or_unpinned_execution_intents() {
    let unsafe_cases = [
        r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5198,"market":"BTCUSD","perpetualId":1,"actionId":"place-1","side":"buy","orderType":"limit","price":"77000","size":"0.00018","reduceOnly":false,"leverage":"1"}"#,
        r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5198,"market":"BTCUSD","perpetualId":1,"actionId":"place-1","side":"buy","orderType":"postOnly","price":"77000","size":"1","reduceOnly":false,"leverage":"1"}"#,
        r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5198,"market":"BTCUSD","perpetualId":20,"actionId":"place-1","side":"buy","orderType":"postOnly","price":"77000","size":"0.00018","reduceOnly":false,"leverage":"1"}"#,
        r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5198,"market":"BTCUSD","perpetualId":1,"actionId":"place-1","side":"buy","orderType":"postOnly","price":"77000","size":"0.00018","reduceOnly":false,"leverage":"1","signerKey":"forbidden"}"#,
        r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5198,"market":"BTCUSD","perpetualId":1,"actionId":"place-1","side":"buy","orderType":"postOnly","price":"77000","size":"0.00018","reduceOnly":false,"leverage":"16"}"#,
        r#"{"version":1,"id":"x","action":"place","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5198,"market":"ETHUSD","perpetualId":20,"actionId":"place-1","side":"buy","orderType":"postOnly","price":"2500","size":"0.004","reduceOnly":false,"leverage":"13"}"#,
        r#"{"version":1,"id":"y","action":"cancel","chainId":143,"exchange":"0x34b6552d57a35a1d042ccae1951bd1c370112a6f","accountId":5198,"market":"BTCUSD","perpetualId":1,"actionId":"same","exchangeOrderId":"47","placementActionId":"same"}"#,
    ];
    for value in unsafe_cases {
        assert!(
            decode_execution_intent(value).is_err(),
            "accepted unsafe intent: {value}"
        );
    }
}
