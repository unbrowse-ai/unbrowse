//! What `proof` refuses and how it reads an RPC's answers, beyond its own tests: the rule on a block's lists, a bounded
//! read's every kind of answer, and a batch.

use super::*;
use alloy::consensus::{Receipt, ReceiptEnvelope, ReceiptWithBloom, SignableTransaction, TxEip1559};
use alloy::network::TxSignerSync;
use alloy::primitives::{Address, Bloom, TxKind};
use alloy::signers::local::PrivateKeySigner;

fn signed(nonce: u64) -> TxEnvelope {
    let key = PrivateKeySigner::random();
    let mut tx = TxEip1559 { chain_id: 1337, nonce, gas_limit: 100_000, max_fee_per_gas: 50, max_priority_fee_per_gas: 2, to: TxKind::Call(Address::repeat_byte(7)), ..Default::default() };
    let sig = key.sign_transaction_sync(&mut tx).unwrap();
    TxEnvelope::Eip1559(tx.into_signed(sig))
}

fn receipt(ran: bool, cumulative: u64) -> ReceiptEnvelope {
    ReceiptEnvelope::Eip1559(ReceiptWithBloom { receipt: Receipt { status: ran.into(), cumulative_gas_used: cumulative, logs: vec![] }, logs_bloom: Bloom::ZERO })
}

fn header_over(txs: &[TxEnvelope], receipts: &[ReceiptEnvelope], base: Option<u64>) -> alloy::consensus::Header {
    alloy::consensus::Header {
        number: 9,
        base_fee_per_gas: base,
        transactions_root: proofs::calculate_transaction_root(txs),
        receipts_root: proofs::calculate_receipt_root(receipts),
        ..Default::default()
    }
}

fn ours_id(tx: &TxEnvelope) -> B256 {
    keccak256(tx.encoded_2718())
}

#[test]
fn a_block_whose_transactions_do_not_cover_its_header_proves_nothing() {
    let (a, ours) = (signed(0), signed(1));
    let txs = vec![a.clone(), ours.clone()];
    let receipts = vec![receipt(true, 21_000), receipt(true, 40_000)];
    let header = header_over(&txs, &receipts, Some(20));
    // The RPC leaves a transaction out of the list it gives: the header's root doesn't cover what is shown.
    let shown = vec![ours.clone()];
    let e = prove(&header, header.hash_slow(), &shown, &receipts[1..], ours_id(&ours), None).unwrap_err();
    assert!(e.contains("transactions don't hash"), "{e}");
}

#[test]
fn a_transaction_first_in_its_block_costs_all_the_gas_its_receipt_counts() {
    let ours = signed(0);
    let txs = vec![ours.clone(), signed(1)];
    let receipts = vec![receipt(true, 30_000), receipt(true, 90_000)];
    let header = header_over(&txs, &receipts, Some(20));
    let p = prove(&header, header.hash_slow(), &txs, &receipts, ours_id(&ours), Some(signed_fee(&ours))).unwrap();
    assert_eq!((p.ran, p.gas_used, p.block, p.agreed), (true, 30_000, 9, false), "nothing before it to take away");
    assert_eq!(p.block_hash, header.hash_slow());
}

#[test]
fn receipts_that_are_not_one_a_transaction_are_refused() {
    let (a, ours) = (signed(0), signed(1));
    let txs = vec![a, ours.clone()];
    let receipts = vec![receipt(true, 21_000), receipt(true, 40_000)];
    let header = header_over(&txs, &receipts, Some(20));
    let e = prove(&header, header.hash_slow(), &txs, &receipts[..1], ours_id(&ours), None).unwrap_err();
    assert!(e.contains("receipts don't hash"), "{e}");
}

#[test]
fn receipts_that_count_gas_backwards_are_refused() {
    let (a, ours) = (signed(0), signed(1));
    let txs = vec![a, ours.clone()];
    let receipts = vec![receipt(true, 50_000), receipt(true, 20_000)];
    let header = header_over(&txs, &receipts, Some(20));
    let e = prove(&header, header.hash_slow(), &txs, &receipts, ours_id(&ours), None).unwrap_err();
    assert!(e.contains("backwards"), "{e}");
}

#[test]
fn what_a_write_cost_is_unknown_when_its_fee_was_not_the_nodes_own_and_capped_by_what_it_signed() {
    let ours = signed(0);
    let txs = vec![ours.clone()];
    let receipts = vec![receipt(true, 1_000)];
    let header = header_over(&txs, &receipts, Some(100));
    let me = ours_id(&ours);
    assert_eq!(prove(&header, header.hash_slow(), &txs, &receipts, me, None).unwrap().cost, None, "no fee signed here, no cost");
    // Base fee 100 plus a tip of 2 is over its most a unit (50): the most it signed is the price.
    let p = prove(&header, header.hash_slow(), &txs, &receipts, me, Some((50, 2))).unwrap();
    assert_eq!(p.cost, Some(U256::from(1_000u64 * 50)));
    // A header with no base fee counts it as nothing: only the tip is paid.
    let bare = header_over(&txs, &receipts, None);
    let p = prove(&bare, bare.hash_slow(), &txs, &receipts, me, Some((50, 2))).unwrap();
    assert_eq!(p.cost, Some(U256::from(1_000u64 * 2)));
}

#[test]
fn the_fee_a_node_signed_at_is_its_most_a_unit_and_its_tip() {
    assert_eq!(signed_fee(&signed(3)), (50, 2));
}

#[test]
fn an_rpc_that_turns_a_caller_away_for_its_rate_is_known_by_what_it_says() {
    assert!(turned_away(&serde_json::json!({"code": -32005, "message": "limit exceeded"})));
    assert!(turned_away(&serde_json::json!({"code": -32000, "message": "rate limit reached"})));
    assert!(!turned_away(&serde_json::json!({"code": -32601, "message": "the method does not exist"})));
    assert!(!turned_away(&serde_json::json!("not an error payload")));
}

fn rpc_body(result: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":1,"result":{result}}}"#)
}

#[tokio::test]
async fn a_read_tells_a_value_from_nothing_from_a_refusal() {
    let (url, taken) = crate::rpc::tests::scripted_rpc(vec![
        (200, rpc_body(r#""0x1""#)),
        (200, rpc_body("null")),
        (200, r#"{"jsonrpc":"2.0","id":1}"#.into()),
        (200, r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no such method"}}"#.into()),
    ])
    .await;
    let ask = || fetch(&url, "eth_x", serde_json::json!([]), 4_096);
    assert!(matches!(ask().await, Ok(Answer::Value(v)) if v == "0x1"));
    assert!(matches!(ask().await, Ok(Answer::Null)), "a null result");
    assert!(matches!(ask().await, Ok(Answer::Null)), "no result at all");
    assert!(matches!(ask().await, Ok(Answer::Refused(e)) if e.contains("no such method")), "a refusal that isn't for the rate is answered at once");
    assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 4, "each asked once");
}

#[tokio::test]
async fn an_answer_that_is_not_json_is_an_error_naming_the_method() {
    let (url, _) = crate::rpc::tests::scripted_rpc(vec![(200, "<html>bad gateway</html>".into())]).await;
    let e = fetch(&url, "eth_getBlockByNumber", serde_json::json!([]), 4_096).await.unwrap_err();
    assert!(e.starts_with("eth_getBlockByNumber:"), "{e}");
}

#[tokio::test]
async fn a_request_the_rpc_turned_away_with_429_is_sent_again_and_the_next_answer_is_used() {
    let (url, taken) = crate::rpc::tests::scripted_rpc(vec![(429, "slow down".into()), (200, rpc_body("7"))]).await;
    assert!(matches!(fetch(&url, "eth_x", serde_json::json!([]), 4_096).await, Ok(Answer::Value(v)) if v == 7));
    assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_block_read_is_nothing_when_the_rpc_has_none_and_an_error_when_it_refuses() {
    let (url, _) = crate::rpc::tests::scripted_rpc(vec![
        (200, rpc_body("null")),
        (200, r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}"#.into()),
        (200, rpc_body(r#"{"not":"a block"}"#)),
    ])
    .await;
    assert!(read_block(&url, serde_json::json!("latest"), false, 4_096).await.unwrap().is_none());
    assert!(read_block(&url, serde_json::json!("latest"), false, 4_096).await.unwrap_err().contains("nope"));
    assert!(read_block(&url, serde_json::json!("latest"), false, 4_096).await.unwrap_err().contains("the block doesn't read"));
}

fn calls(n: usize) -> Vec<(&'static str, serde_json::Value)> {
    (0..n).map(|i| ("eth_getBlockByNumber", serde_json::json!([format!("{i:#x}"), false]))).collect()
}

#[tokio::test]
async fn a_batch_of_nothing_is_not_sent() {
    let (url, taken) = crate::rpc::tests::scripted_rpc(vec![]).await;
    assert!(fetch_batch(&url, &[], 1_024).await.unwrap().is_empty());
    assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_batch_is_answered_call_by_call_in_the_order_asked_whatever_order_it_came_in() {
    let reply = r#"[{"jsonrpc":"2.0","id":2,"result":null},{"jsonrpc":"2.0","id":0,"result":"first"},{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"no"}},{"jsonrpc":"2.0","id":99,"result":"stray"},{"jsonrpc":"2.0","result":"no id"}]"#;
    let (url, _) = crate::rpc::tests::scripted_rpc(vec![(200, reply.into())]).await;
    let got = fetch_batch(&url, &calls(3), 4_096).await.unwrap();
    assert!(matches!(&got[0], Answer::Value(v) if v == "first"));
    assert!(matches!(&got[1], Answer::Refused(e) if e.contains("\"no\"")));
    assert!(matches!(&got[2], Answer::Null));
}

#[tokio::test]
async fn a_batch_with_no_answer_for_a_call_is_an_error_naming_the_call() {
    let (url, _) = crate::rpc::tests::scripted_rpc(vec![(200, r#"[{"jsonrpc":"2.0","id":0,"result":1}]"#.into())]).await;
    let e = fetch_batch(&url, &calls(2), 4_096).await.unwrap_err();
    assert!(e.contains("a batch of 2 eth_getBlockByNumber") && e.contains("no answer for call 1"), "{e}");
}

#[tokio::test]
async fn an_rpc_that_takes_no_batches_says_why_and_nothing_of_it_is_used() {
    let (url, _) = crate::rpc::tests::scripted_rpc(vec![
        (200, r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch unsupported"}}"#.into()),
        (200, r#"{"jsonrpc":"2.0","id":1,"result":1}"#.into()),
    ])
    .await;
    let e = fetch_batch(&url, &calls(2), 4_096).await.unwrap_err();
    assert!(e.contains("batch unsupported"), "{e}");
    let e = fetch_batch(&url, &calls(2), 4_096).await.unwrap_err();
    assert!(e.contains("not a batch answer"), "{e}");
}

#[tokio::test]
async fn a_batch_answer_past_its_byte_cap_is_refused_unread() {
    let big = format!(r#"[{{"jsonrpc":"2.0","id":0,"result":"{}"}}]"#, "a".repeat(10_000));
    let (url, _) = crate::rpc::tests::scripted_rpc(vec![(200, big)]).await;
    let e = fetch_batch(&url, &calls(1), 1_024).await.unwrap_err();
    assert!(e.contains("more than 1024 bytes"), "{e}");
}

#[tokio::test]
async fn a_batch_that_is_not_json_is_an_error() {
    let (url, _) = crate::rpc::tests::scripted_rpc(vec![(200, "nope".into())]).await;
    assert!(fetch_batch(&url, &calls(1), 1_024).await.unwrap_err().starts_with("a batch of 1 eth_getBlockByNumber:"));
}
