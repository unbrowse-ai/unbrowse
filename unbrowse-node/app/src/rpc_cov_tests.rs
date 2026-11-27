//! UNB-208: the node's writes and witnessed reads, against a chain of the test's own: a small fake of one (blocks that
//! hash and link, transactions and receipts that prove against their headers' roots) on loopback, in place of Anvil,
//! which a coverage run doesn't have.

use super::*;
use alloy::consensus::{proofs, Header as ConsensusHeader, Receipt, ReceiptEnvelope, ReceiptWithBloom, Transaction as _};
use alloy::eips::eip2718::Decodable2718;
use alloy::primitives::{Bloom, Bytes, B256, U256};
use alloy::rpc::types::BlockTransactions;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The tests below set the process's chain (its RPC port is the environment's), which every other test of this binary
/// that asks `chain::url` would meet: each runs in a process of its own, this binary run again for it alone, and the
/// test that started it asks it passed.
fn alone(test: &str, module: &str) -> bool {
    if std::env::var_os("UNBROWSE_COV_ALONE").is_some() {
        return true;
    }
    let path = format!("{}::{test}", module.split_once("::").map(|(_, rest)| rest).unwrap_or(module));
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args([path.as_str(), "--exact", "--test-threads=1"])
        .env("UNBROWSE_COV_ALONE", "1")
        .output()
        .unwrap();
    let said = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success() && said.contains("1 passed"), "{path} in a process of its own:\n{said}");
    false
}

macro_rules! alone {
    ($test:literal) => {
        if !alone($test, module_path!()) {
            return;
        }
    };
}

const GWEI: u64 = 1_000_000_000;
const CHAIN_ID: u64 = 31_337;

struct Mined {
    header: ConsensusHeader,
    hash: B256,
    txs: Vec<TxEnvelope>,
    receipts: Vec<ReceiptEnvelope>,
}

/// What the fake chain holds, and what it is told to do wrong.
#[derive(Default)]
struct Fake {
    blocks: Vec<Mined>,
    calls: Vec<String>,
    sent: Vec<TxEnvelope>,
    /// Said to a raw transaction instead of taking it.
    refuse_send: Option<String>,
    /// With `refuse_send`, takes the transaction and mines it all the same: an RPC that says it already has it.
    refuse_mines: bool,
    /// Takes a raw transaction and mines nothing.
    hold: bool,
    /// Methods answered with null.
    null: Vec<&'static str>,
    /// Mines the transactions it takes as reverted.
    revert: bool,
    /// How many blocks the finalized one trails the latest.
    lag: u64,
    /// Methods answered with an error.
    fail: Vec<&'static str>,
    code: HashMap<Address, Bytes>,
    call_answer: Bytes,
    call_error: Option<String>,
    balance: U256,
    /// What a single receipt says of whether the write ran, when it isn't what the block says.
    lie_ran: Option<bool>,
    /// The chain ID it gives.
    chain_id: u64,
}

impl Fake {
    fn new() -> Fake {
        let mut f = Fake { chain_id: CHAIN_ID, balance: U256::from(10u64).pow(U256::from(24u64)), call_answer: Bytes::new(), ..Default::default() };
        for _ in 0..4 {
            f.mine(Vec::new());
        }
        f
    }

    fn mine(&mut self, txs: Vec<TxEnvelope>) {
        let number = self.blocks.len() as u64;
        let parent = self.blocks.last().map(|b| b.hash).unwrap_or_default();
        let ran = !self.revert;
        let receipts: Vec<ReceiptEnvelope> = (0..txs.len())
            .map(|i| ReceiptEnvelope::Eip1559(ReceiptWithBloom { receipt: Receipt { status: ran.into(), cumulative_gas_used: 21_000 * (i as u64 + 1), logs: vec![] }, logs_bloom: Bloom::ZERO }))
            .collect();
        let header = ConsensusHeader {
            number,
            parent_hash: parent,
            timestamp: 1_000 + number,
            gas_limit: 30_000_000,
            gas_used: 21_000 * txs.len() as u64,
            base_fee_per_gas: Some(GWEI),
            transactions_root: proofs::calculate_transaction_root(&txs),
            receipts_root: proofs::calculate_receipt_root(&receipts),
            ..Default::default()
        };
        let hash = header.hash_slow();
        self.blocks.push(Mined { header, hash, txs, receipts });
    }

    fn latest(&self) -> usize {
        self.blocks.len() - 1
    }

    fn finalized(&self) -> Option<usize> {
        self.latest().checked_sub(self.lag as usize)
    }

    fn which(&self, tag: &Value) -> Option<usize> {
        match tag.as_str()? {
            "latest" | "pending" => Some(self.latest()),
            "finalized" | "safe" => self.finalized(),
            hex => usize::from_str_radix(hex.trim_start_matches("0x"), 16).ok().filter(|n| *n < self.blocks.len()),
        }
    }

    fn rpc_tx(&self, n: usize, i: usize) -> alloy::rpc::types::Transaction {
        use alloy::consensus::transaction::SignerRecoverable;
        let b = &self.blocks[n];
        let tx = b.txs[i].clone();
        let from = tx.recover_signer().unwrap();
        alloy::rpc::types::Transaction { inner: alloy::consensus::transaction::Recovered::new_unchecked(tx, from), block_hash: Some(b.hash), block_number: Some(n as u64), transaction_index: Some(i as u64), effective_gas_price: Some(u128::from(GWEI)) }
    }

    fn block(&self, n: usize, full: bool) -> Value {
        let b = &self.blocks[n];
        let txs = if full { BlockTransactions::Full((0..b.txs.len()).map(|i| self.rpc_tx(n, i)).collect()) } else { BlockTransactions::Hashes(b.txs.iter().map(|t| *t.tx_hash()).collect()) };
        serde_json::to_value(alloy::rpc::types::Block::<alloy::rpc::types::Transaction>::new(alloy::rpc::types::Header::new(b.header.clone()), txs)).unwrap()
    }

    fn receipt(&self, n: usize, i: usize, lie: Option<bool>) -> Value {
        use alloy::consensus::transaction::SignerRecoverable;
        let b = &self.blocks[n];
        let tx = &b.txs[i];
        let ran = lie.unwrap_or_else(|| b.receipts[i].status());
        let to = tx.to().map(|t| json!(format!("{t:#x}"))).unwrap_or(Value::Null);
        json!({
            "transactionHash": format!("{:#x}", tx.tx_hash()), "transactionIndex": format!("{i:#x}"), "blockHash": format!("{:#x}", b.hash), "blockNumber": format!("{n:#x}"),
            "from": format!("{:#x}", tx.recover_signer().unwrap()), "to": to, "cumulativeGasUsed": format!("{:#x}", b.receipts[i].cumulative_gas_used()), "gasUsed": "0x5208", "contractAddress": null,
            "logs": [], "logsBloom": format!("0x{}", "0".repeat(512)), "status": if ran { "0x1" } else { "0x0" }, "effectiveGasPrice": format!("{GWEI:#x}"), "type": "0x2"
        })
    }

    fn find(&self, tx: &str) -> Option<(usize, usize)> {
        let hash: B256 = tx.parse().ok()?;
        self.blocks.iter().enumerate().find_map(|(n, b)| b.txs.iter().position(|t| *t.tx_hash() == hash).map(|i| (n, i)))
    }

    fn nonce_of(&self, who: &str) -> u64 {
        use alloy::consensus::transaction::SignerRecoverable;
        let who: Address = who.parse().unwrap_or_default();
        self.blocks.iter().flat_map(|b| b.txs.iter()).filter(|t| t.recover_signer().ok() == Some(who)).count() as u64
    }

    fn handle(&mut self, method: &str, p: &Value) -> Result<Value, String> {
        self.calls.push(method.to_string());
        if self.fail.contains(&method) {
            return Err(format!("{method} is down"));
        }
        if self.null.contains(&method) {
            return Ok(Value::Null);
        }
        let hex = |n: u64| json!(format!("{n:#x}"));
        Ok(match method {
            "eth_chainId" => hex(self.chain_id),
            "eth_blockNumber" => hex(self.latest() as u64),
            "eth_getBlockByNumber" => match self.which(&p[0]) {
                Some(n) => self.block(n, p[1].as_bool().unwrap_or(false)),
                None => Value::Null,
            },
            "eth_getBlockByHash" => {
                let hash: B256 = p[0].as_str().and_then(|h| h.parse().ok()).unwrap_or_default();
                match self.blocks.iter().position(|b| b.hash == hash) {
                    Some(n) => self.block(n, p[1].as_bool().unwrap_or(false)),
                    None => Value::Null,
                }
            }
            "eth_getBlockReceipts" => match self.which(&p[0]) {
                Some(n) => Value::Array((0..self.blocks[n].txs.len()).map(|i| self.receipt(n, i, None)).collect()),
                None => Value::Null,
            },
            "eth_getTransactionReceipt" => match self.find(p[0].as_str().unwrap_or("")) {
                Some((n, i)) => self.receipt(n, i, self.lie_ran),
                None => Value::Null,
            },
            "eth_getTransactionByHash" => match self.find(p[0].as_str().unwrap_or("")) {
                Some((n, i)) => serde_json::to_value(self.rpc_tx(n, i)).unwrap(),
                None => Value::Null,
            },
            "eth_getTransactionCount" => hex(self.nonce_of(p[0].as_str().unwrap_or(""))),
            "eth_getBalance" => json!(format!("{:#x}", self.balance)),
            "eth_estimateGas" => hex(21_000),
            "eth_maxPriorityFeePerGas" => hex(GWEI),
            "eth_gasPrice" => hex(2 * GWEI),
            "eth_getCode" => {
                let at: Address = p[0].as_str().and_then(|a| a.parse().ok()).unwrap_or_default();
                json!(self.code.get(&at).cloned().unwrap_or_default().to_string())
            }
            "eth_call" => match &self.call_error {
                Some(e) => return Err(e.clone()),
                None => json!(self.call_answer.to_string()),
            },
            "eth_sendRawTransaction" => {
                let raw: Bytes = p[0].as_str().and_then(|r| r.parse().ok()).ok_or("not hex")?;
                let tx = TxEnvelope::decode_2718(&mut raw.as_ref()).map_err(|e| e.to_string())?;
                let hash = *tx.tx_hash();
                if let Some(e) = self.refuse_send.clone() {
                    if self.refuse_mines {
                        self.mine(vec![tx]);
                    }
                    return Err(e);
                }
                self.sent.push(tx.clone());
                if !self.hold {
                    self.mine(vec![tx]);
                }
                json!(format!("{hash:#x}"))
            }
            other => return Err(format!("the fake chain has no {other}")),
        })
    }
}

/// Serves `fake` as an RPC on loopback; each request (or batch) is answered from it.
async fn serve(fake: Arc<Mutex<Fake>>) -> (reqwest::Url, u16) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut conn, _)) = listener.accept().await {
            let fake = fake.clone();
            tokio::spawn(async move {
                let mut got = Vec::new();
                let mut buf = vec![0u8; 64 * 1024];
                let body = loop {
                    let n = conn.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if got.len() >= end + 4 + len {
                            break got[end + 4..end + 4 + len].to_vec();
                        }
                    }
                };
                let ask: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let answer = |one: &Value| {
                    let r = fake.lock().unwrap().handle(one["method"].as_str().unwrap_or(""), &one["params"]);
                    match r {
                        Ok(v) => json!({ "jsonrpc": "2.0", "id": one["id"], "result": v }),
                        Err(e) => json!({ "jsonrpc": "2.0", "id": one["id"], "error": { "code": -32000, "message": e } }),
                    }
                };
                let reply = match &ask {
                    Value::Array(many) => Value::Array(many.iter().map(answer).collect()),
                    one => answer(one),
                }
                .to_string();
                let http = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len());
                let _ = conn.write_all(http.as_bytes()).await;
                let _ = conn.shutdown().await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}").parse().unwrap(), port)
}

/// A fake chain as the node's own chain: the process's chain port is its port, and the home is a scratch one. Holds the
/// guard every test that sets the process's chain holds.
struct OnChain {
    fake: Arc<Mutex<Fake>>,
    url: reqwest::Url,
    _env: crate::testchain::Env,
    _one: tokio::sync::MutexGuard<'static, ()>,
}

async fn on_chain(name: &str) -> OnChain {
    let one = crate::testchain::one_at_a_time().await;
    let _home = crate::store::scratch_home(name);
    let fake = Arc::new(Mutex::new(Fake::new()));
    let (url, port) = serve(fake.clone()).await;
    let env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", port.to_string())]);
    OnChain { fake, url, _env: env, _one: one }
}

fn methods(c: &OnChain, which: &str) -> usize {
    c.fake.lock().unwrap().calls.iter().filter(|m| *m == which).count()
}

/// A write the node signs lands in a block the chain has made final, at the fee and gas the node priced it at, and its
/// receipt is the one the block proves: the node signed it itself, with the nonce the chain gave, for the chain the RPC
/// is, once.
#[tokio::test]
async fn a_write_is_signed_priced_sent_once_and_proven_in_its_final_block() {
    alone!("a_write_is_signed_priced_sent_once_and_proven_in_its_final_block");
    let c = on_chain("write-lands").await;
    let key = PrivateKeySigner::random();
    let me = key.address();
    let p = ProviderBuilder::new().wallet(key).connect_http(c.url.clone());
    let to = Address::repeat_byte(0x42);
    let call = alloy::contract::CallBuilder::new_raw(p.clone(), Bytes::from_static(b"\x01\x02")).to(to);
    let receipt = send_write(&call, me, p.wallet(), None, "a test write").await.unwrap();
    assert!(receipt.status() && receipt.block_number == Some(4), "{receipt:?}");
    let fake = c.fake.lock().unwrap();
    assert_eq!(fake.sent.len(), 1, "sent once");
    let tx = &fake.sent[0];
    assert_eq!((tx.nonce(), tx.chain_id(), tx.to(), tx.input().as_ref()), (0, Some(CHAIN_ID), Some(to), &b"\x01\x02"[..]));
    // Twice the chain's base fee and its suggested tip; the gas it estimated and the room for the next block.
    assert_eq!((tx.max_fee_per_gas(), tx.max_priority_fee_per_gas()), (u128::from(3 * GWEI), Some(u128::from(GWEI))));
    assert_eq!(tx.gas_limit(), 21_000 + NEXT_BLOCK_GAS);
    assert_eq!(receipt.transaction_hash, *tx.tx_hash());
}

async fn write_to(c: &OnChain, key: &PrivateKeySigner, call_to: Address) -> Result<TransactionReceipt, String> {
    let p = ProviderBuilder::new().wallet(key.clone()).connect_http(c.url.clone());
    let call = alloy::contract::CallBuilder::new_raw(p.clone(), Bytes::from_static(b"\x07")).to(call_to);
    send_write(&call, key.address(), p.wallet(), None, "a test write").await
}

/// A write the chain turns away is an error that says it never left (the caller may send it again), and nothing was
/// mined; one the chain says it already holds is waited for like any other; a chain that can't say what the write
/// takes, or what nonce is next, sends nothing.
#[tokio::test]
async fn a_write_the_chain_turns_away_is_not_sent_and_one_it_already_holds_is_waited_for() {
    alone!("a_write_the_chain_turns_away_is_not_sent_and_one_it_already_holds_is_waited_for");
    let c = on_chain("write-refused").await;
    let key = PrivateKeySigner::random();
    let to = Address::repeat_byte(0x42);
    c.fake.lock().unwrap().refuse_send = Some("insufficient funds for gas".into());
    let e = write_to(&c, &key, to).await.unwrap_err();
    assert!(e.starts_with("a test write: ") && e.contains("insufficient funds") && !unsettled(&e), "{e}");
    assert_eq!(c.fake.lock().unwrap().blocks.len(), 4, "nothing was mined");
    // "already known": the RPC has it, so the write is waited for, and it lands.
    {
        let mut f = c.fake.lock().unwrap();
        f.refuse_send = Some("already known".into());
        f.refuse_mines = true;
    }
    let receipt = write_to(&c, &key, to).await.unwrap();
    assert_eq!(receipt.block_number, Some(4));
    {
        let mut f = c.fake.lock().unwrap();
        f.refuse_send = None;
        f.fail = vec!["eth_estimateGas"];
    }
    let e = write_to(&c, &key, to).await.unwrap_err();
    assert!(e.starts_with("a test write: ") && !unsettled(&e), "the estimate failed: {e}");
    {
        let mut f = c.fake.lock().unwrap();
        f.fail = vec!["eth_getTransactionCount"];
    }
    let before = c.fake.lock().unwrap().sent.len();
    let e = write_to(&c, &key, to).await.unwrap_err();
    assert!(e.starts_with("a test write: ") && !unsettled(&e), "no nonce: {e}");
    assert_eq!(c.fake.lock().unwrap().sent.len(), before, "nothing sent without a nonce");
}

/// A fee, a gas limit and a nonce the node set on the write itself (a replacement outbidding a stuck one) are kept as
/// they are, held to the owner's cap on the fee, and nothing is asked of the chain for them.
#[tokio::test]
async fn a_write_with_its_own_fee_gas_and_nonce_keeps_them_held_to_the_owners_cap() {
    alone!("a_write_with_its_own_fee_gas_and_nonce_keeps_them_held_to_the_owners_cap");
    let c = on_chain("write-own-fee").await;
    let key = PrivateKeySigner::random();
    let p = ProviderBuilder::new().wallet(key.clone()).connect_http(c.url.clone());
    let cap = crate::store::load_settings().max_gas_price_wei();
    let call = alloy::contract::CallBuilder::new_raw(p.clone(), Bytes::new()).to(Address::repeat_byte(1)).nonce(7).gas(30_000).max_fee_per_gas(5 * u128::from(GWEI)).max_priority_fee_per_gas(2 * u128::from(GWEI));
    send_write(&call, key.address(), p.wallet(), None, "a replacement").await.unwrap();
    let call = alloy::contract::CallBuilder::new_raw(p.clone(), Bytes::new()).to(Address::repeat_byte(1)).nonce(8).gas(30_000).max_fee_per_gas(cap.saturating_mul(10)).max_priority_fee_per_gas(cap.saturating_mul(10));
    send_write(&call, key.address(), p.wallet(), None, "a greedy replacement").await.unwrap();
    let f = c.fake.lock().unwrap();
    let (a, b) = (&f.sent[0], &f.sent[1]);
    assert_eq!((a.nonce(), a.gas_limit(), a.max_fee_per_gas(), a.max_priority_fee_per_gas()), (7, 30_000, 5 * u128::from(GWEI), Some(2 * u128::from(GWEI))));
    assert_eq!((b.nonce(), b.max_fee_per_gas(), b.max_priority_fee_per_gas()), (8, cap, Some(cap)), "the cap holds what the node set");
    assert!(!f.calls.contains(&"eth_estimateGas".to_string()) && !f.calls.contains(&"eth_getTransactionCount".to_string()));
}

/// A write that reverted in its final block is a receipt that says so (the caller reads its status), not an error; a
/// receipt that says it ran where the block's own say it didn't is no receipt at all: it stops every write.
#[tokio::test]
async fn a_reverted_write_says_so_and_a_receipt_the_block_contradicts_stops_every_write() {
    alone!("a_reverted_write_says_so_and_a_receipt_the_block_contradicts_stops_every_write");
    let c = on_chain("write-reverted").await;
    let key = PrivateKeySigner::random();
    let to = Address::repeat_byte(0x42);
    c.fake.lock().unwrap().revert = true;
    let receipt = write_to(&c, &key, to).await.unwrap();
    assert!(!receipt.status(), "it says it reverted");
    assert!(halted().is_none());
    {
        let mut f = c.fake.lock().unwrap();
        f.lie_ran = Some(true);
    }
    let e = write_to(&c, &key, to).await.unwrap_err();
    assert!(unsettled(&e) && e.contains("says true and its block says false"), "{e}");
    assert!(halted().is_some_and(|w| w.contains("The node stopped writing")), "every write stops");
    let e = write_to(&c, &key, to).await.unwrap_err();
    assert!(e.contains("stopped writing"), "and the next write isn't signed: {e}");
    unhalt();
}

/// A write whose block's receipts the chain won't give is sent and waited for, and then neither let go nor given back
/// its gas: it stays one that may still land,.
#[tokio::test]
async fn a_write_whose_block_cannot_be_proven_is_left_as_one_that_may_still_land() {
    alone!("a_write_whose_block_cannot_be_proven_is_left_as_one_that_may_still_land");
    let c = on_chain("write-unprovable").await;
    let key = PrivateKeySigner::random();
    c.fake.lock().unwrap().null = vec!["eth_getBlockReceipts"];
    let e = write_to(&c, &key, Address::repeat_byte(0x42)).await.unwrap_err();
    assert!(unsettled(&e) && e.contains("can't be proven against its block yet"), "{e}");
    // A proof the RPC refuses to answer is an error too, and stops nothing.
    {
        let mut f = c.fake.lock().unwrap();
        f.null.clear();
        f.fail = vec!["eth_getBlockReceipts"];
    }
    let e = write_to(&c, &key, Address::repeat_byte(0x42)).await.unwrap_err();
    assert!(unsettled(&e), "{e}");
    assert!(halted().is_none());
}

/// A write is signed only on the chain the node runs on and while writes aren't stopped: an RPC that says it is
/// another chain, or a halt, sends nothing.
#[tokio::test]
async fn a_write_goes_nowhere_while_writes_are_stopped_or_the_rpc_is_another_chain() {
    alone!("a_write_goes_nowhere_while_writes_are_stopped_or_the_rpc_is_another_chain");
    let c = on_chain("write-gate").await;
    let key = PrivateKeySigner::random();
    let p = ProviderBuilder::new().wallet(key.clone()).connect_http(c.url.clone());
    let call = alloy::contract::CallBuilder::new_raw(p.clone(), Bytes::new()).to(Address::repeat_byte(1));
    let e = send_write(&call, key.address(), p.wallet(), Some(1), "a write").await.unwrap_err();
    assert!(e.contains("says it is chain 31337, but this node runs on chain 1"), "{e}");
    halt("a test says so");
    let e = send_write(&call, key.address(), p.wallet(), None, "a write").await.unwrap_err();
    unhalt();
    assert!(e.starts_with("a write: ") && e.contains("a test says so"), "{e}");
    assert!(c.fake.lock().unwrap().sent.is_empty());
}

/// A write is waited for until its block is final: a chain whose finalized block trails the write's waits, and the
/// write lands when it catches up. A receipt that now names an earlier block than the one the write was mined in is
/// the chain's own, once that block is final.
#[tokio::test]
async fn a_write_in_a_block_not_yet_final_is_waited_for_until_it_is() {
    alone!("a_write_in_a_block_not_yet_final_is_waited_for_until_it_is");
    let c = on_chain("write-final").await;
    let key = PrivateKeySigner::random();
    c.fake.lock().unwrap().lag = 2;
    let fake = c.fake.clone();
    let later = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(800)).await;
        fake.lock().unwrap().lag = 0;
    });
    let receipt = write_to(&c, &key, Address::repeat_byte(0x42)).await.unwrap();
    later.await.unwrap();
    assert_eq!(receipt.block_number, Some(4));
    assert!(methods(&c, "eth_getBlockByNumber") >= 4, "the finalized block was looked at more than once");
    // The receipt the node was first given names block 3; the chain has the write in block 4, final.
    let p = ProviderBuilder::new().connect_http(c.url.clone());
    let stale: TransactionReceipt = {
        let f = c.fake.lock().unwrap();
        let mut r = f.receipt(4, 0, None);
        r["blockNumber"] = json!("0x3");
        r["blockHash"] = json!(format!("{:#x}", f.blocks[3].hash));
        serde_json::from_value(r).unwrap()
    };
    let got = finalized(&p, stale).await.unwrap();
    assert_eq!(got.block_number, Some(4), "the receipt as the chain has it now");
}

fn pair_of(to: Address) -> Vec<(Address, Bytes)> {
    vec![(to, Bytes::from_static(b"\x01")), (to, Bytes::from_static(b"\x02"))]
}

/// Calls go as one transaction through Arc's Multicall3From where the chain has it and runs it as a call from the key,
/// and one write a call everywhere else: where it is absent, where the key has code of its own, or where the chain
/// answers that the batch doesn't run; a chain that says nothing of whether it can is an error, never a batch sent
/// halfway.
#[tokio::test]
async fn calls_go_as_one_transaction_only_where_the_chain_runs_them_so() {
    alone!("calls_go_as_one_transaction_only_where_the_chain_runs_them_so");
    let c = on_chain("batch-fake").await;
    let key = PrivateKeySigner::random();
    let me = key.address();
    let p = ProviderBuilder::new().wallet(key).connect_http(c.url.clone());
    let calls = pair_of(Address::repeat_byte(0x42));
    let sent = || c.fake.lock().unwrap().sent.len();
    assert_eq!(batch(&p, calls.clone(), "two calls").await.unwrap().len(), 2, "no Multicall3From here");
    assert_eq!(sent(), 2);
    // Deployed, and the batch runs as a call: one transaction, to Multicall3From, carrying both.
    c.fake.lock().unwrap().code.insert(crate::arc::MULTICALL3_FROM, Bytes::from_static(&[0x00]));
    let receipts = batch(&p, calls.clone(), "two calls").await.unwrap();
    assert_eq!((receipts.len(), sent()), (1, 3));
    assert_eq!(c.fake.lock().unwrap().sent[2].to(), Some(crate::arc::MULTICALL3_FROM));
    assert_eq!(c.fake.lock().unwrap().sent[2].input(), &aggregate3(&calls));
    // The chain says the batch doesn't run: one write a call.
    c.fake.lock().unwrap().call_error = Some("execution reverted".into());
    assert_eq!(batch(&p, calls.clone(), "two calls").await.unwrap().len(), 2);
    assert_eq!(sent(), 5);
    // A key with code of its own is not batched for.
    {
        let mut f = c.fake.lock().unwrap();
        f.call_error = None;
        f.code.insert(me, Bytes::from_static(&[0x01]));
    }
    assert_eq!(batch(&p, calls.clone(), "two calls").await.unwrap().len(), 2);
    assert_eq!(sent(), 7);
    // A chain that can't say whether the code is there is an error and sends nothing.
    c.fake.lock().unwrap().fail = vec!["eth_getCode"];
    let e = batch(&p, calls, "two calls").await.unwrap_err();
    assert!(e.starts_with("two calls: "), "{e}");
    assert_eq!(sent(), 7);
}

/// The node's no-op takes a stuck write's nonce at twice the fee the chain asks now, never past the owner's cap; a kept
/// write that is old, has no receipt and sits at the chain's next nonce is stuck, and the no-op is what `unstick` sends.
#[tokio::test]
async fn a_stuck_write_is_replaced_by_the_nodes_own_no_op_at_twice_the_fee() {
    alone!("a_stuck_write_is_replaced_by_the_nodes_own_no_op_at_twice_the_fee");
    let c = on_chain("write-unstick").await;
    let key = PrivateKeySigner::random();
    let me = key.address();
    let p = ProviderBuilder::new().wallet(key).connect_http(c.url.clone());
    let hash = replace(&p, 0).await.unwrap();
    {
        let f = c.fake.lock().unwrap();
        let tx = &f.sent[0];
        assert_eq!(hash, format!("{:#x}", tx.tx_hash()));
        assert_eq!((tx.nonce(), tx.to(), tx.gas_limit(), tx.input().len(), tx.value()), (0, Some(me), NO_OP_GAS, 0, U256::ZERO));
        // The chain's own fee is 3 gwei (twice its base fee and a tip of 1), and the replacement asks twice that.
        assert_eq!((tx.max_fee_per_gas(), tx.max_priority_fee_per_gas()), (u128::from(6 * GWEI), Some(u128::from(2 * GWEI))));
    }
    // An old kept write at the chain's next nonce (1) that it holds no receipt for.
    crate::inflight::keep_for_test(crate::inflight::Sending {
        key: "stuck".into(),
        what: "a deposit".into(),
        signer: me,
        nonce: 1,
        tx: B256::repeat_byte(9),
        raw: Bytes::new(),
        at: 1,
        amount: 1.0,
        book: None,
        others: Vec::new(),
        told: false,
        watch: None,
    });
    let replaced = unstick(&p).await.unwrap().expect("the no-op is sent");
    let f = c.fake.lock().unwrap();
    assert_eq!(f.sent.len(), 2);
    assert_eq!((f.sent[1].nonce(), replaced), (1, format!("{:#x}", f.sent[1].tx_hash())));
}

/// The first RPC's reading of a block is the one a second RPC must agree with: readings both give and agree on are
/// read; a second that gives another answer stops every write, and one that gives none leaves the reading unmade.
#[tokio::test]
async fn a_reading_a_second_rpc_contradicts_stops_every_write() {
    alone!("a_reading_a_second_rpc_contradicts_stops_every_write");
    use alloy::sol_types::SolCall;
    let c = on_chain("read-agreed").await;
    let second = Arc::new(Mutex::new(Fake::new()));
    let (second_url, _) = serve(second.clone()).await;
    // Another host name for the same machine would be "one operator"; a read doesn't ask, a write does.
    crate::store::save_settings(&crate::store::Settings { check_rpc: Some(second_url.to_string()), ..crate::store::Settings::default() }).unwrap();
    let five = Bytes::from(U256::from(5u64).to_be_bytes::<32>().to_vec());
    c.fake.lock().unwrap().call_answer = five.clone();
    second.lock().unwrap().call_answer = five.clone();
    let p = ProviderBuilder::new().connect_http(c.url.clone());
    let usdc = Address::repeat_byte(0x55);
    let who = Address::repeat_byte(0x66);
    let call = crate::chain::USDC::balanceOfCall { account: who };
    assert_eq!(call_agreed(&p, usdc, &call).await.unwrap(), U256::from(5u64), "both say five");
    assert_eq!(read_agreed(&p, usdc, call.abi_encode().into()).await.unwrap(), five);
    let head = Head::follow(&p).await.unwrap();
    assert_eq!(head.call(&p, usdc, &call).await.unwrap(), Some(U256::from(5u64)), "a witnessed read at a head the second stands behind");
    assert_eq!(read_witnessed(&p, usdc, call.abi_encode().into()).await.unwrap(), Some(five.clone()));
    assert_eq!(call_witnessed(&p, usdc, &call).await.unwrap(), Some(U256::from(5u64)));
    second_agrees_on_balance(&p, who).await.unwrap();
    assert!(halted().is_none());
    // The first can't read at the head: no reading, not an error.
    c.fake.lock().unwrap().call_error = Some("execution reverted".into());
    assert_eq!(head.call(&p, usdc, &call).await.unwrap(), None);
    c.fake.lock().unwrap().call_error = None;
    // The second says another balance.
    second.lock().unwrap().balance = U256::from(1u64);
    let e = second_agrees_on_balance(&p, who).await.unwrap_err();
    assert!(e.contains("the balance of") && e.contains("the second RPC says"), "{e}");
    assert!(halted().is_some());
    unhalt();
    // The second says another answer to the call.
    second.lock().unwrap().call_answer = Bytes::from(U256::from(6u64).to_be_bytes::<32>().to_vec());
    let e = call_agreed(&p, usdc, &call).await.unwrap_err();
    assert!(e.contains("a read of") && e.contains("the second RPC says"), "{e}");
    assert!(halted().is_some());
    unhalt();
    let e = head.call(&p, usdc, &call).await.unwrap_err();
    assert!(e.contains("the second RPC says"), "{e}");
    unhalt();
    // The second doesn't answer.
    second.lock().unwrap().fail = vec!["eth_call", "eth_getBalance"];
    assert!(call_agreed(&p, usdc, &call).await.unwrap_err().contains("the second RPC didn't answer"));
    assert!(second_agrees_on_balance(&p, who).await.unwrap_err().contains("the second RPC didn't answer"));
    assert_eq!(head.call(&p, usdc, &call).await.unwrap(), None);
    unhalt();
}

/// A receipt the chain doesn't have yet is waited for, and given once it has it; a proof the RPC can't be asked for
/// is an error that settles nothing and stops nothing.
#[tokio::test]
async fn a_receipt_that_comes_late_is_given_and_a_proof_that_cannot_be_asked_settles_nothing() {
    alone!("a_receipt_that_comes_late_is_given_and_a_proof_that_cannot_be_asked_settles_nothing");
    let c = on_chain("receipt-late").await;
    let key = PrivateKeySigner::random();
    let p = ProviderBuilder::new().wallet(key.clone()).connect_http(c.url.clone());
    let mined = write_to(&c, &key, Address::repeat_byte(0x42)).await.unwrap();
    let tx = mined.transaction_hash;
    // Unknown until the chain is told of it again a moment later.
    let unknown = B256::repeat_byte(0xee);
    let fake = c.fake.clone();
    // The chain forgets it for now (as a node that hasn't yet seen the block would) and has it again half a second on.
    let sent = {
        let mut f = fake.lock().unwrap();
        let sent = f.blocks[4].txs[0].clone();
        f.blocks.truncate(4);
        sent
    };
    assert!(p.get_transaction_receipt(tx).await.unwrap().is_none());
    let later = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        fake.lock().unwrap().mine(vec![sent]);
    });
    let got = receipt_of(&p, unknown, Duration::from_millis(300)).await;
    assert!(got.unwrap_err().contains("no receipt for"), "never there");
    let got = receipt_of(&p, tx, Duration::from_secs(10)).await.unwrap();
    later.await.unwrap();
    assert_eq!(got.transaction_hash, tx);
    // The proof can't be asked for: the chain ID isn't answered.
    c.fake.lock().unwrap().fail = vec!["eth_chainId"];
    let spend = Spend::reserve(&Priced { gas: 21_000, max_fee: 1, tip: 1 }).unwrap();
    let e = settle_proven(&p, spend, tx, &mined, None).await.unwrap_err();
    assert!(e.contains("eth_chainId") || e.contains("down"), "{e}");
    assert!(halted().is_none());
    // A receipt naming no block can't be proven.
    c.fake.lock().unwrap().fail.clear();
    let unplaced = TransactionReceipt { block_number: None, ..mined };
    let spend = Spend::reserve(&Priced { gas: 21_000, max_fee: 1, tip: 1 }).unwrap();
    assert_eq!(settle_proven(&p, spend, tx, &unplaced, None).await.unwrap_err(), "the receipt names no block");
}

/// A head is followed only while writes aren't stopped, a head past its life is followed again, and a witnessed read
/// is made on a chain on this machine as its owner's own (no second RPC needed); a chain that can't be followed gives
/// no reading, and a halt is an error every reading meets.
#[tokio::test]
async fn a_witnessed_read_on_a_chain_here_needs_no_second_and_a_halt_stops_every_follow() {
    alone!("a_witnessed_read_on_a_chain_here_needs_no_second_and_a_halt_stops_every_follow");
    use alloy::sol_types::SolCall;
    let c = on_chain("read-here").await;
    let p = ProviderBuilder::new().connect_http(c.url.clone());
    let usdc = Address::repeat_byte(0x55);
    let call = crate::chain::USDC::balanceOfCall { account: Address::repeat_byte(0x66) };
    let seven = Bytes::from(U256::from(7u64).to_be_bytes::<32>().to_vec());
    c.fake.lock().unwrap().call_answer = seven.clone();
    assert_eq!(read_witnessed(&p, usdc, call.abi_encode().into()).await.unwrap(), Some(seven.clone()), "a chain here is witnessed");
    assert_eq!(call_witnessed(&p, usdc, &call).await.unwrap(), Some(U256::from(7u64)));
    assert_eq!(call_agreed(&p, usdc, &call).await.unwrap(), U256::from(7u64));
    // A head past its life is followed again.
    let mut head = Head::default();
    assert!(!head.live());
    head.renew(&p).await.unwrap();
    assert!(head.live() && head.latest().is_some());
    // The RPC that can't say which chain it is gives no head, and so no reading, and halts nothing.
    c.fake.lock().unwrap().fail = vec!["eth_chainId"];
    assert!(Head::follow(&p).await.is_err());
    assert_eq!(read_witnessed(&p, usdc, call.abi_encode().into()).await.unwrap(), None);
    c.fake.lock().unwrap().fail.clear();
    // Writes stopped: no head is followed, and the reading says why.
    halt("a test says so");
    let e = Head::follow(&p).await.unwrap_err();
    let read = read_witnessed(&p, usdc, call.abi_encode().into()).await;
    unhalt();
    assert!(e.contains("a test says so"), "{e}");
    assert!(read.is_err_and(|e| e.contains("a test says so")), "a halt is an error, not a missing reading");
}

/// A second RPC that doesn't answer a block's hash is said to be so, and one that has no such block is behind.
#[tokio::test]
async fn a_second_rpc_that_does_not_answer_a_blocks_hash_is_said_not_to_have() {
    alone!("a_second_rpc_that_does_not_answer_a_blocks_hash_is_said_not_to_have");
    let c = on_chain("second-block").await;
    let second = Arc::new(Mutex::new(Fake::new()));
    let (second_url, _) = serve(second.clone()).await;
    crate::store::save_settings(&crate::store::Settings { check_rpc: Some(second_url.to_string()), ..crate::store::Settings::default() }).unwrap();
    let hash = c.fake.lock().unwrap().blocks[2].hash;
    second_agrees_on_block(2, hash).await.unwrap();
    second.lock().unwrap().fail = vec!["eth_getBlockByNumber"];
    let e = second_agrees_on_block(2, hash).await.unwrap_err();
    assert!(e.contains("the second RPC didn't answer"), "{e}");
    second.lock().unwrap().fail.clear();
    let e = second_agrees_on_block(99, hash).await.unwrap_err();
    assert!(e.contains("hasn't reached block 99"), "{e}");
    assert!(halted().is_none());
}

/// Where the node stands on a second RPC reads off the owner's settings: a chain on this machine needs none, and a
/// once-only write is allowed there; a second RPC the owner names wrongly is "misnamed" with why.
#[tokio::test]
async fn a_chain_here_is_never_held_back_for_want_of_a_second_rpc() {
    alone!("a_chain_here_is_never_held_back_for_want_of_a_second_rpc");
    let _c = on_chain("second-state").await;
    assert_eq!(second_rpc_state(), ("not needed", None));
    assert!(once_allowed().is_ok());
    crate::store::save_settings(&crate::store::Settings { check_rpc: Some("ftp://elsewhere.example/".into()), ..crate::store::Settings::default() }).unwrap();
    assert!(once_allowed().is_err(), "a second RPC named wrongly is an error every write meets");
    assert_eq!(second_rpc_state_of(false, Ok(false)).0, "missing");
    assert!(second_rpc_state_of(false, Ok(false)).1.is_some_and(|w| w.contains("second, independent RPC")));
    assert_eq!(second_rpc_state_of(false, Ok(true)), ("named", None));
    assert_eq!(second_rpc_state_of(false, Err("why".into())), ("misnamed", Some("why".into())));
}

/// What a chain on this machine is asked for by the node's own cheats is asked of it, and its refusal is said with the
/// method's name; two RPCs once judged one operator's are judged again from what was kept for ten minutes.
#[tokio::test]
async fn a_devnet_cheat_is_asked_of_the_chain_here_and_a_judged_pair_is_kept() {
    alone!("a_devnet_cheat_is_asked_of_the_chain_here_and_a_judged_pair_is_kept");
    let c = on_chain("cheat-here").await;
    assert_eq!(devnet_cheat("eth_blockNumber", json!([])).await.unwrap(), json!("0x3"));
    let e = devnet_cheat("anvil_mine", json!([])).await.unwrap_err();
    assert!(e.starts_with("anvil_mine: ") && e.contains("no anvil_mine"), "{e}");
    let a: reqwest::Url = "https://rpc.same-operator.example/".parse().unwrap();
    let b: reqwest::Url = "https://rpc2.same-operator.example/".parse().unwrap();
    let first = independent(&a, &b).await.unwrap_err();
    assert_eq!(independent(&a, &b).await.unwrap_err(), first, "judged once, kept");
    assert!(first.contains("same domain"), "{first}");
    assert_eq!(methods(&c, "eth_blockNumber"), 1);
}
