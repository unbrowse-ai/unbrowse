use super::*;

fn sending(key: &str) -> Sending {
    Sending { key: key.into(), what: "the deposit".into(), signer: Address::ZERO, nonce: 7, tx: B256::ZERO, raw: Bytes::new(), at: 1, amount: 5.0, book: None, others: Vec::new(), told: false, watch: None }
}

fn ok(result: &str) -> (u16, String) {
    (200, format!(r#"{{"jsonrpc":"2.0","id":0,"result":{result}}}"#))
}

fn receipt(tx: B256) -> String {
    format!(
        r#"{{"transactionHash":"{tx:#x}","transactionIndex":"0x0","blockHash":"0x{}","blockNumber":"0x5","from":"0x{z40}","to":"0x{z40}","cumulativeGasUsed":"0x5208","gasUsed":"0x5208","contractAddress":null,"logs":[],"logsBloom":"0x{}","status":"0x1","effectiveGasPrice":"0x1","type":"0x2"}}"#,
        "1".repeat(64),
        "0".repeat(512),
        z40 = "0".repeat(40)
    )
}

/// Block 5 at the hash `receipt` names; `extra` is more JSON fields (a base fee).
fn block(extra: &str) -> (u16, String) {
    ok(&format!(
        r#"{{"hash":"0x{h}","number":"0x5","parentHash":"0x{z}","sha3Uncles":"0x{z}","miner":"0x{z40}","stateRoot":"0x{z}","transactionsRoot":"0x{z}","receiptsRoot":"0x{z}","logsBloom":"0x{b}","difficulty":"0x0","gasLimit":"0x0","gasUsed":"0x0","timestamp":"0x0","extraData":"0x","mixHash":"0x{z}","nonce":"0x0000000000000000",{extra}"uncles":[],"transactions":[]}}"#,
        h = "1".repeat(64),
        z = "0".repeat(64),
        b = "0".repeat(512),
        z40 = "0".repeat(40)
    ))
}

fn told_count(key_what: &str) -> usize {
    store::read_activity(50).iter().filter(|a| a.what == format!("Looked again at {key_what}") && a.result == "waiting").count()
}

/// A write whose own receipt is in a final block the node can't prove against (the RPC has no latest block to check its
/// headers by) is neither landed nor let go: it waits, the owner is told once, and the record says they were.
#[tokio::test]
async fn a_receipt_that_cannot_be_proven_leaves_the_write_waiting_and_tells_the_owner_once() {
    let _one = crate::testchain::one_at_a_time().await;
    let _home = store::scratch_home("sending-cov-unprovable");
    keep(sending("deposit")).unwrap();
    for round in 0..2 {
        // Its receipt; the final block; its receipt again (still there); the chain id; and no latest block to prove by.
        let (url, taken) = rpc::tests::scripted_rpc(vec![ok(&receipt(B256::ZERO)), block(""), ok(&receipt(B256::ZERO)), ok("\"0x7b\""), ok("null")]).await;
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", url.port().unwrap().to_string())]);
        let settled = settle(&rpc::ProviderBuilder::new().connect_http(url), "deposit").await;
        assert!(matches!(settled, Ok(Settled::Waiting(_))), "round {round}: {settled:?}");
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 5, "round {round}");
        assert!(of("deposit").unwrap().unwrap().told, "the record says the owner was told");
    }
    assert_eq!(told_count("the deposit"), 1, "told once, not on every pass");
    assert_eq!(all().unwrap().len(), 1, "the record stays");
}

/// Another of the node's transactions at the write's nonce that can't be proven final doesn't free the write: it goes
/// on waiting, and its signed bytes go out again.
#[tokio::test]
async fn another_transaction_at_the_nonce_that_cannot_be_proven_does_not_free_the_write() {
    let _one = crate::testchain::one_at_a_time().await;
    let _home = store::scratch_home("sending-cov-other-unprovable");
    let other = B256::repeat_byte(9);
    keep(Sending { others: vec![other], raw: Bytes::from(vec![1, 2, 3]), ..sending("deposit") }).unwrap();
    let (url, taken) = rpc::tests::scripted_rpc(vec![ok("null"), ok(&receipt(other)), block(""), ok(&receipt(other)), ok("\"0x7b\""), ok("null"), ok("\"0x7\""), ok(&format!("\"{:#x}\"", B256::ZERO))]).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", url.port().unwrap().to_string())]);
    let settled = settle(&rpc::ProviderBuilder::new().connect_http(url), "deposit").await;
    assert!(matches!(settled, Ok(Settled::Waiting(_))), "{settled:?}");
    assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 8, "the nonce was read and the kept bytes sent again");
    assert_eq!(all().unwrap().len(), 1, "the record stays");
}

/// A write is signed as the node's provider would fill it: the next pending nonce, the chain the RPC names, the estimated
/// gas with the next-block margin over it, and the fee from the head's base fee and the suggested tip.
#[tokio::test]
async fn a_write_is_signed_at_the_next_nonce_with_the_estimated_gas_and_the_priced_fee() {
    let _one = crate::testchain::one_at_a_time().await;
    let _home = store::scratch_home("sending-cov-signed");
    let (url, taken) = rpc::tests::scripted_rpc(vec![ok("\"0x7b\""), ok("\"0x9\""), ok("\"0x5208\""), block(r#""baseFeePerGas":"0x3b9aca00","#), ok("\"0x1\"")]).await;
    let key = alloy::signers::local::PrivateKeySigner::random();
    let me = key.address();
    let provider = rpc::ProviderBuilder::new().wallet(key).connect_http(url);
    use alloy::providers::WalletProvider as _;
    let wallet = provider.wallet().clone();
    let target = Address::repeat_byte(3);
    let call = alloy::contract::CallBuilder::new_raw(provider.clone(), Bytes::from(vec![0xab])).to(target);
    let (tx, priced) = signed(&call, me, &wallet).await.unwrap();
    assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 5);
    use alloy::consensus::Transaction as _;
    assert_eq!((tx.nonce(), tx.chain_id(), tx.gas_limit()), (9, Some(0x7b), 21_000 + rpc::NEXT_BLOCK_GAS));
    assert_eq!(tx.to(), Some(target));
    assert_eq!(tx.input().as_ref(), &[0xab]);
    assert_eq!((priced.gas, priced.tip, priced.max_fee), (21_000 + rpc::NEXT_BLOCK_GAS, 1, 2_000_000_001));
    assert_eq!((tx.max_fee_per_gas(), tx.max_priority_fee_per_gas()), (priced.max_fee, Some(priced.tip)));
}
