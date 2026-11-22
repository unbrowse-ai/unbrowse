//! What the node can know of its own writes from the chain without taking one RPC's word for it (security round 2,
//! R2-CHAIN-1). A receipt an RPC hands back is only the RPC's word; a receipt proven here is the chain's, short of a
//! forged chain of headers:
//!
//! - the block's header, as the RPC gives its fields, hashes to the block the receipt names (`Header::hash_slow`), so
//!   its roots are the block's;
//! - the block's transactions hash to the header's `transactionsRoot`, and one of them is the very bytes the node
//!   signed, by their hash, which the node made itself;
//! - the block's receipts hash to the header's `receiptsRoot`, and the receipt at that transaction's place says whether
//!   it ran and how much gas it took (the difference of the cumulative gas there and before it).
//!
//! What it costs is then the node's own sum: that gas at the fee it signed, against the header's base fee. When an
//! owner names a second RPC (`check_rpc`), the block hash at that height is read there too, so a forged header has to be
//! forged by both. A chain whose headers this build can't rehash (`HEADERS`) has nothing proven, and the node falls back
//! to the slower rules `inflight` keeps for a write it can't prove.

use std::sync::RwLock;

use alloy::consensus::{proofs, Transaction as _, TxEnvelope};
use alloy::eips::eip2718::Encodable2718;
use alloy::primitives::{keccak256, B256, U256};
use alloy::providers::Provider;
use alloy::rpc::types::BlockTransactions;

use crate::sync::Shared;

/// A write of the node's, proven in a final block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Proven {
    /// Whether it ran (`status`), from the receipt at its place.
    pub ran: bool,
    pub gas_used: u64,
    /// What it cost, in the chain's native units: its gas at the fee it was signed at against the block's base fee.
    /// `None` when the fee it was signed at isn't known here (a transaction of the node's it didn't price itself).
    pub cost: Option<U256>,
    pub block: u64,
    pub block_hash: B256,
    /// Whether the checkpoint its block is anchored by was stood behind by more than the node's one RPC
    /// (`anchor::Witness::agrees`): what a once-only write's outcome and a gas refund need. Set by `prove_on`.
    pub agreed: bool,
}

/// The rule, on values already read: whether `header`, `txs` and `receipts`, as an RPC gave them, are the block
/// `claimed` and hold the node's transaction `ours`, and what it did. `signed` is the most fee a unit and the tip it was
/// signed at. An error is an answer that contradicts itself: a header that doesn't hash to its block, roots that don't
/// cover its lists, a transaction that isn't there.
pub fn prove(header: &alloy::consensus::Header, claimed: B256, txs: &[TxEnvelope], receipts: &[alloy::consensus::ReceiptEnvelope], ours: B256, signed: Option<(u128, u128)>) -> Result<Proven, String> {
    if header.hash_slow() != claimed {
        return Err("the block's header doesn't hash to the block the RPC names".into());
    }
    if proofs::calculate_transaction_root(txs) != header.transactions_root {
        return Err("the block's transactions don't hash to its header's transactions root".into());
    }
    let at = txs.iter().position(|t| keccak256(t.encoded_2718()) == ours).ok_or("the block doesn't hold the transaction the node signed")?;
    if receipts.len() != txs.len() || proofs::calculate_receipt_root(receipts) != header.receipts_root {
        return Err("the block's receipts don't hash to its header's receipts root".into());
    }
    let before = if at == 0 { 0 } else { receipts[at - 1].cumulative_gas_used() };
    let gas_used = receipts[at].cumulative_gas_used().checked_sub(before).ok_or("the block's receipts count gas backwards")?;
    let base = u128::from(header.base_fee_per_gas.unwrap_or(0));
    let cost = signed.map(|(max_fee, tip)| U256::from(gas_used) * U256::from(max_fee.min(base.saturating_add(tip))));
    Ok(Proven { ran: receipts[at].status(), gas_used, cost, block: header.number, block_hash: claimed, agreed: false })
}

/// Whether this chain's headers rehash here, by the chain the node signs on: learned from a block of the chain the first
/// time it is asked, and kept for the process. `false`: nothing on this chain can be proven by this build.
static HEADERS: RwLock<Option<(u64, bool)>> = RwLock::new(None);

/// What `prove_on` found.
#[derive(Clone, Debug, PartialEq)]
pub enum Inclusion {
    /// The write is in a final block, and this is what it did.
    Proven(Proven),
    /// What the proof needs isn't to be had here (the chain's headers don't rehash in this build, or its RPC serves no
    /// block receipts): only the RPC's word is.
    Unprovable(String),
}

/// The most bytes one answer a proof reads may hold: a full block with its transactions, or its receipts, is read up to
/// this and refused past it, before any of it is decoded, so an RPC can't make a proof take the node's memory.
pub const MAX_PROOF_BYTES: usize = 8 * 1024 * 1024;
/// The most bytes a header alone may take.
pub const MAX_HEADER_BYTES: usize = 64 * 1024;
/// The most transactions a block a proof reads may hold; its receipts must be as many.
pub const MAX_BLOCK_TXS: usize = 20_000;

/// What a bounded read (`fetch`) got: the answer, none (`null`), or the RPC's refusal of the method.
#[derive(Debug)]
pub enum Answer {
    Value(serde_json::Value),
    Null,
    Refused(String),
}

/// Sends `method` with `params` to `url` and reads its answer, at most `cap` bytes: a body said to be larger, or that
/// grows past it as it streams in, is refused there, and nothing of it is decoded. A request the RPC turned away for
/// its rate (`turned_away`) is sent again after a wait, as every provider's request is (`rpc::client`), and only the
/// last refusal is answered: a public RPC limits each caller, and the reads here (the headers between finalized heads,
/// a window of logs) come in bursts.
pub async fn fetch(url: &reqwest_url::Url, method: &str, params: serde_json::Value, cap: usize) -> Result<Answer, String> {
    let mut wait = std::time::Duration::from_millis(crate::rpc::RATE_LIMIT_BACKOFF_MS);
    let mut tries = 0;
    loop {
        let (answer, turned) = fetch_once(url, method, &params, cap).await?;
        if !turned || tries >= crate::rpc::RATE_LIMIT_RETRIES {
            return Ok(answer);
        }
        tries += 1;
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(RATE_LIMIT_WAIT_MOST);
    }
}

/// The longest wait between two sends of a request the RPC turned away for its rate.
const RATE_LIMIT_WAIT_MOST: std::time::Duration = std::time::Duration::from_secs(16);

/// Whether an RPC's refusal is for the caller's rate, read as the provider's retries read it (`ErrorPayload::is_retry_err`:
/// JSON-RPC -32005, 429, a provider's credit or request limit, a message that says "rate limit").
pub fn turned_away(error: &serde_json::Value) -> bool {
    serde_json::from_value::<alloy::rpc::json_rpc::ErrorPayload>(error.clone()).is_ok_and(|e| e.is_retry_err())
}

/// One send of `fetch`: the answer, and whether the RPC turned it away for its rate (an HTTP 429, or a refusal that
/// says so).
async fn fetch_once(url: &reqwest_url::Url, method: &str, params: &serde_json::Value, cap: usize) -> Result<(Answer, bool), String> {
    use alloy::transports::http::reqwest;
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder().timeout(crate::rpc::REQUEST_TIMEOUT).build().unwrap_or_else(|_| reqwest::Client::new())
    });
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let mut resp = CLIENT.post(url.clone()).json(&body).send().await.map_err(|e| format!("{method}: {e}"))?;
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Ok((Answer::Refused(format!("{method}: HTTP 429, too many requests")), true));
    }
    if resp.content_length().is_some_and(|n| n > cap as u64) {
        return Err(format!("{method}: the RPC's answer is more than {cap} bytes, so it wasn't read"));
    }
    let mut got = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{method}: {e}"))? {
        if got.len() + chunk.len() > cap {
            return Err(format!("{method}: the RPC's answer is more than {cap} bytes, so it wasn't read"));
        }
        got.extend_from_slice(&chunk);
    }
    let reply: serde_json::Value = serde_json::from_slice(&got).map_err(|e| format!("{method}: {e}"))?;
    if let Some(e) = reply.get("error") {
        return Ok((Answer::Refused(e.to_string()), turned_away(e)));
    }
    Ok((
        match reply.get("result") {
            None | Some(serde_json::Value::Null) => Answer::Null,
            Some(v) => Answer::Value(v.clone()),
        },
        false,
    ))
}

/// `calls` (each a method and its params) sent as one JSON-RPC batch to `url`, read within `cap` bytes in all as `fetch`
/// reads one: each call's answer, in the order asked, matched by id. A batch the RPC answers as one refusal (it takes no
/// batches, or turned this one away for its rate) is an error, and nothing of it is used.
pub async fn fetch_batch(url: &reqwest_url::Url, calls: &[(&str, serde_json::Value)], cap: usize) -> Result<Vec<Answer>, String> {
    use alloy::transports::http::reqwest;
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder().timeout(crate::rpc::REQUEST_TIMEOUT).build().unwrap_or_else(|_| reqwest::Client::new())
    });
    if calls.is_empty() {
        return Ok(Vec::new());
    }
    let body: Vec<serde_json::Value> =
        calls.iter().enumerate().map(|(i, (method, params))| serde_json::json!({ "jsonrpc": "2.0", "id": i, "method": method, "params": params })).collect();
    let what = format!("a batch of {} {}", calls.len(), calls[0].0);
    let mut resp = CLIENT.post(url.clone()).json(&body).send().await.map_err(|e| format!("{what}: {e}"))?;
    if resp.content_length().is_some_and(|n| n > cap as u64) {
        return Err(format!("{what}: the RPC's answer is more than {cap} bytes, so it wasn't read"));
    }
    let mut got = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{what}: {e}"))? {
        if got.len() + chunk.len() > cap {
            return Err(format!("{what}: the RPC's answer is more than {cap} bytes, so it wasn't read"));
        }
        got.extend_from_slice(&chunk);
    }
    let reply: serde_json::Value = serde_json::from_slice(&got).map_err(|e| format!("{what}: {e}"))?;
    let Some(items) = reply.as_array() else {
        let why = reply.get("error").map(|e| e.to_string()).unwrap_or_else(|| "not a batch answer".into());
        return Err(format!("{what}: {why}"));
    };
    let mut out: Vec<Option<Answer>> = (0..calls.len()).map(|_| None).collect();
    for item in items {
        let Some(i) = item.get("id").and_then(|v| v.as_u64()).map(|i| i as usize).filter(|i| *i < calls.len()) else { continue };
        out[i] = Some(match (item.get("error"), item.get("result")) {
            (Some(e), _) => Answer::Refused(e.to_string()),
            (None, None | Some(serde_json::Value::Null)) => Answer::Null,
            (None, Some(v)) => Answer::Value(v.clone()),
        });
    }
    out.into_iter().enumerate().map(|(i, a)| a.ok_or_else(|| format!("{what}: no answer for call {i}"))).collect()
}

mod reqwest_url {
    pub use alloy::transports::http::reqwest::Url;
}
pub use reqwest_url::Url;

/// Whether a block of `txs` transactions and `receipts` receipts is one a proof reads: at most `MAX_BLOCK_TXS`, and as
/// many receipts as transactions.
pub fn within_counts(txs: usize, receipts: usize) -> Result<(), String> {
    if txs > MAX_BLOCK_TXS {
        return Err(format!("the block holds {txs} transactions, more than a proof reads ({MAX_BLOCK_TXS})"));
    }
    if receipts != txs {
        return Err(format!("the block holds {txs} transactions and {receipts} receipts"));
    }
    Ok(())
}

/// A block read through `fetch`, decoded once it is in.
async fn read_block(url: &Url, number: serde_json::Value, full: bool, cap: usize) -> Result<Option<alloy::rpc::types::Block>, String> {
    match fetch(url, "eth_getBlockByNumber", serde_json::json!([number, full]), cap).await? {
        Answer::Value(v) => serde_json::from_value(v).map(Some).map_err(|e| format!("the block doesn't read: {e}")),
        Answer::Null => Ok(None),
        Answer::Refused(e) => Err(e),
    }
}

/// Proves the node's transaction `ours`, mined in block `number` per its receipt, against what the node's RPC
/// (`chain::url`) serves of that block (and, when the owner names one, what a second RPC says its hash is), every answer
/// read through `fetch`'s bound. An error is either an RPC that didn't answer (a timeout, a refused connection, a rate
/// limit past its retries), which stops nothing, or an answer that contradicts itself or the second RPC, which has
/// stopped every write (`rpc::halt`) where it was found, here or in `rpc::second_agrees_on_block` and `anchor`. A
/// caller never halts on the error itself (UNB-171).
pub async fn prove_on<P: Provider>(p: &P, ours: B256, number: u64, signed: Option<(u128, u128)>) -> Result<Inclusion, String> {
    let url = crate::chain::url();
    let chain = p.get_chain_id().await.map_err(|e| e.to_string())?;
    let known = *HEADERS.reading();
    let rehashes = match known {
        Some((c, ok)) if c == chain => ok,
        _ => {
            let Some(b) = read_block(&url, serde_json::json!("latest"), false, MAX_HEADER_BYTES).await? else {
                return Ok(Inclusion::Unprovable("the RPC has no latest block".into()));
            };
            let ok = b.header.inner.hash_slow() == b.header.hash;
            *HEADERS.writing() = Some((chain, ok));
            ok
        }
    };
    if !rehashes {
        return Ok(Inclusion::Unprovable("this chain's block headers don't rehash in this build".into()));
    }
    let Some(block) = read_block(&url, serde_json::json!(format!("{number:#x}")), true, MAX_PROOF_BYTES).await? else {
        return Ok(Inclusion::Unprovable(format!("the RPC has no block {number}")));
    };
    let BlockTransactions::Full(full) = &block.transactions else {
        return Ok(Inclusion::Unprovable("the RPC gave the block without its transactions".into()));
    };
    if full.len() > MAX_BLOCK_TXS {
        return Ok(Inclusion::Unprovable(format!("block {number} holds more transactions than a proof reads")));
    }
    let txs: Vec<TxEnvelope> = full.iter().map(|t| t.inner.inner().clone()).collect();
    let receipts: Vec<alloy::rpc::types::TransactionReceipt> = match fetch(&url, "eth_getBlockReceipts", serde_json::json!([format!("{number:#x}")]), MAX_PROOF_BYTES).await? {
        Answer::Value(v) => serde_json::from_value(v).map_err(|e| format!("the block's receipts don't read: {e}"))?,
        Answer::Null => return Ok(Inclusion::Unprovable(format!("the RPC has no receipts for block {number}"))),
        Answer::Refused(e) => return Ok(Inclusion::Unprovable(format!("the RPC serves no block receipts: {e}"))),
    };
    if let Err(e) = within_counts(txs.len(), receipts.len()) {
        return Ok(Inclusion::Unprovable(format!("block {number}: {e}")));
    }
    let receipts: Vec<_> = receipts.into_iter().map(|r| r.inner.into_primitives_receipt()).collect();
    // Every error `prove` gives is an answer that contradicts itself: that, and not an answer withheld, stops writes.
    let proven = prove(&block.header.inner, block.header.hash, &txs, &receipts, ours, signed).map_err(|e| {
        let why = format!("block {number}: {e}");
        crate::rpc::halt(&why);
        why
    })?;
    crate::rpc::second_agrees_on_block(number, proven.block_hash).await?;
    // A block that holds the write is not yet the chain's: it must be on the finalized chain the node has followed
    // itself, header by header (`anchor`).
    let followed = crate::anchor::advance(chain).await?;
    let anchored = match crate::anchor::anchored_at(&followed.anchored, number, proven.block_hash, &crate::anchor::FromRpc(url)).await {
        Ok(a) => a,
        Err(crate::anchor::Broken::Contradicts(e)) => {
            crate::rpc::halt(&e);
            return Err(e);
        }
        Err(crate::anchor::Broken::Unanswered(e)) => return Err(e),
    };
    let Some(agreed) = anchored else {
        return Ok(Inclusion::Unprovable(format!("block {number} isn't on the finalized chain the node has followed (before it began, in a gap it couldn't link, or not final yet)")));
    };
    Ok(Inclusion::Proven(Proven { agreed, ..proven }))
}

/// The fee `tx` was signed at: its most a unit and its tip, for a write of the node's own.
pub fn signed_fee(tx: &TxEnvelope) -> (u128, u128) {
    (tx.max_fee_per_gas(), tx.max_priority_fee_per_gas().unwrap_or(0))
}

#[cfg(test)]
mod tests {
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

    /// A block as a chain makes it: its header over its transactions and receipts.
    fn block(txs: &[TxEnvelope], receipts: &[ReceiptEnvelope]) -> alloy::consensus::Header {
        alloy::consensus::Header {
            number: 9,
            base_fee_per_gas: Some(20),
            transactions_root: proofs::calculate_transaction_root(txs),
            receipts_root: proofs::calculate_receipt_root(receipts),
            ..Default::default()
        }
    }

    /// An answer a proof reads is read up to its cap and refused past it, before any of it is decoded: a body said to be
    /// larger, or one that streams in larger, is never held whole; a block with more transactions than a proof reads,
    /// or receipts not one a transaction, is refused too.
    #[tokio::test]
    async fn a_proof_read_past_its_byte_cap_is_refused_before_it_is_read_whole() {
        let big = format!(r#"{{"jsonrpc":"2.0","id":1,"result":"{}"}}"#, "a".repeat(10_000));
        let (url, _) = crate::rpc::tests::scripted_rpc(vec![(200, big.clone()), (200, big)]).await;
        let e = fetch(&url, "eth_getBlockReceipts", serde_json::json!([]), 1_024).await.unwrap_err();
        assert!(e.contains("more than 1024 bytes"), "{e}");
        assert!(matches!(fetch(&url, "eth_getBlockReceipts", serde_json::json!([]), 20_000).await, Ok(Answer::Value(_))), "under its cap, it reads");
        assert!(within_counts(MAX_BLOCK_TXS + 1, MAX_BLOCK_TXS + 1).is_err(), "more transactions than a proof reads");
        assert!(within_counts(3, 2).is_err(), "a receipt short");
        assert!(within_counts(3, 3).is_ok());
    }

    /// A receipt the node acts on is the block's: proven against the header's roots, at the place of the very bytes
    /// the node signed, with its cost the node's own sum. A receipt an RPC made up (another status, less gas, another
    /// transaction's place, a header with other roots, a block of another hash) proves nothing, and the write it was for
    /// is neither let go nor its gas given back on it.
    #[test]
    fn unproved_rpc_receipt_cannot_clear_once_or_refund_gas_reservation() {
        let (a, ours) = (signed(0), signed(1));
        let txs = vec![a, ours.clone()];
        let receipts = vec![receipt(true, 21_000), receipt(false, 71_000)];
        let header = block(&txs, &receipts);
        let me = keccak256(ours.encoded_2718());
        let p = prove(&header, header.hash_slow(), &txs, &receipts, me, Some(signed_fee(&ours))).unwrap();
        assert_eq!((p.ran, p.gas_used, p.cost), (false, 50_000, Some(U256::from(50_000u64 * 22))), "it reverted, took 50,000 gas, at the base fee of 20 and its tip of 2");

        let said_it_ran = vec![receipt(true, 21_000), receipt(true, 71_000)];
        assert!(prove(&header, header.hash_slow(), &txs, &said_it_ran, me, None).is_err(), "a receipt that says it ran");
        let said_cheap = vec![receipt(true, 21_000), receipt(false, 21_001)];
        assert!(prove(&header, header.hash_slow(), &txs, &said_cheap, me, None).is_err(), "a receipt that says it cost nothing");
        let forged = block(&txs, &said_it_ran);
        assert!(prove(&forged, header.hash_slow(), &txs, &said_it_ran, me, None).is_err(), "a header made to fit, under the real block's hash");
        assert!(prove(&forged, forged.hash_slow(), &txs, &said_it_ran, me, None).is_ok(), "only a header of its own hash fits it, which the second RPC and the chain's own hashes then refute");
        assert!(prove(&header, header.hash_slow(), &txs, &receipts, keccak256(b"another"), None).is_err(), "a transaction the block doesn't hold");
        assert!(prove(&header, B256::repeat_byte(1), &txs, &receipts, me, None).is_err(), "a block of another hash");
    }
}
