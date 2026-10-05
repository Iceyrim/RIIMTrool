use alloy::sol_types::SolCall;
use perpl_sdk::abi::dex::Exchange;

#[test]
fn exec_orders_calldata_is_encoded_with_revert_on_fail() {
    let call = Exchange::execOrdersCall {
        orderDescs: vec![],
        revertOnFail: true,
    };
    let encoded = call.abi_encode();
    assert!(encoded.len() >= 68);
    assert_eq!(&encoded[..4], Exchange::execOrdersCall::SELECTOR);
    let decoded = Exchange::execOrdersCall::abi_decode(&encoded).unwrap();
    assert!(decoded.revertOnFail);
}
