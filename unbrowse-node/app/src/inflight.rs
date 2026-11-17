//! The writes that must not go twice. Most of the node's writes are safe to make again: a line is spent once, a root
//! posted once, a fee set to a value, so whoever made one sends it again on its next pass if it can't tell what became
//! of it. A deposit, a registration, a stake and a bounty stake aren't: the chain takes a second one as a second one,
//! and a write can be out of the node's sight and still land. It may be waiting in the chain's pool past `RECEIPT_TIMEOUT`,
//! its RPC may have dropped the connection after taking it, or the node may have stopped. A read of the chain then shows
//! nothing changed, and a pass that trusted it would pay again.
//!
//! So such a write is signed first and kept here, its hash, its nonce and its signed bytes, before it goes out
//! (`once!`). Until its record is gone, nothing sends that write again: whoever would asks `settle`, which reads the
//! chain. A record stays until what the write was for is written down (`done`), so a node that stops between the
//! chain taking it and its own book counting it finds it on the next pass. Sending the kept bytes again can't make a
//! second write: the same signed transaction is one transaction, and any other at its nonce rules it out.
//!
//! One file per chain (`<chain>/sending.json`). A file that doesn't read stops these writes, never the rest: it is the
//! only thing that says whether one is out.

use std::sync::Mutex;

use alloy::consensus::TxEnvelope;
use alloy::eips::eip2718::Encodable2718;
use alloy::network::{Ethereum, TransactionBuilder};
use alloy::primitives::{Address, Bytes, B256};
use alloy::providers::Provider;
use alloy::rpc::types::{TransactionReceipt, TransactionRequest};
use serde::{Deserialize, Serialize};

use crate::rpc::{self, NodeWallet};
use crate::store;
use crate::sync::Locked;

/// A write that is out, or about to be.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sending {
    /// What it is for, the same for every try: only one write of a key can be out.
    pub key: String,
    /// What the write is, as the owner is told.
    pub what: String,
    pub signer: Address,
    pub nonce: u64,
    pub tx: B256,
    /// The signed transaction: sent again as it is while the chain hasn't taken it.
    pub raw: Bytes,
    /// When it was signed, by this machine's clock.
    pub at: u64,
    /// What it moves, in the write's own token, for whoever counts it once it lands.
    #[serde(default)]
    pub amount: f64,
    /// The book that was to count it before the record went. Only the auto-stake book ever did, and it went with route
    /// stakes: no write names one now, and `pass` clears a record an older node kept for it like any other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book: Option<String>,
    /// The node's own other transactions signed at its nonce since (`note_nonce`): once one of them is final, this
    /// write can never land, and only then is it let go.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub others: Vec<B256>,
    /// Whether the owner was told that its nonce went to a transaction the node didn't sign.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub told: bool,
    /// The chain state the write changes, read at the final block before it was signed: what `settle` reads again
    /// before it ever lets the write go on an RPC's word alone. None in a record kept before it was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch: Option<Watch>,
}

/// A view of the chain a write changes: a contract, the calldata of a read of it, and what that read gave before.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Watch {
    pub to: Address,
    pub data: Bytes,
    pub before: Bytes,
}

/// Whether what an RPC answered to a signed write means it holds that nonce already: the write isn't refused, it may
/// be the one that took it.
pub fn holds_nonce(said: &str) -> bool {
    ["nonce too low", "replacement transaction underpriced", "already known", "already imported"].iter().any(|w| said.contains(w))
}

/// What a kept write's own receipt and its proof (`proof::prove_on`) come to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Proven to have run: it landed.
    Landed,
    /// Proven to have done nothing: it may be let go.
    Reverted,
    /// Nothing proven: it may still land, and nothing of its key is sent.
    Waiting,
    /// The RPC's receipt says one thing and the proof another: every write stops.
    Contradicted,
}

/// The rule, on plain values: `said` is what the RPC's receipt says (it ran or not), `proven` what the block proves
/// (`Some(ran)`), or `None` when nothing could be proven. Nothing lands, and nothing is let go, on the RPC's word alone:
/// an unprovable receipt that says it ran is no more a landing than one that says it didn't.
pub fn verdict(said: bool, proven: Option<bool>) -> Verdict {
    match proven {
        Some(ran) if ran != said => Verdict::Contradicted,
        Some(true) => Verdict::Landed,
        Some(false) => Verdict::Reverted,
        None => Verdict::Waiting,
    }
}

/// What `settle` found.
#[derive(Debug)]
pub enum Settled {
    /// No write of this key is out: it may be sent.
    Clear,
    /// The write landed, in this final receipt, and its record stays until whoever asked calls `done`.
    Landed(Sending, TransactionReceipt),
    /// It may still land: nothing of this key may be sent.
    Waiting(Sending),
}

/// One change to the file at a time.
static FILE: Mutex<()> = Mutex::new(());

fn path() -> std::path::PathBuf {
    crate::chain::dir().join("sending.json")
}

/// Every write kept. A file that doesn't read is an error: it is what says whether one is out.
pub fn all() -> Result<Vec<Sending>, String> {
    store::read_json_strict(&path(), &unbrowse_files::SENDING)
}

fn of(key: &str) -> Result<Option<Sending>, String> {
    Ok(all()?.into_iter().find(|s| s.key == key))
}

fn keep(s: Sending) -> Result<(), String> {
    let _one = FILE.locked();
    let _file = store::hold_money_file(&path(), store::MONEY_LOCK_WAIT)?;
    let mut kept = all()?;
    if let Some(there) = kept.iter().find(|k| k.key == s.key) {
        return Err(format!("{} is already out ({:#x}), so another wasn't sent", there.what, there.tx));
    }
    kept.push(s);
    store::write_json(&path(), &unbrowse_files::SENDING, &kept)
}

/// Lets go of the write of `key`, once what it was for is written down or it came to nothing.
pub fn done(key: &str) -> Result<(), String> {
    let _one = FILE.locked();
    let _file = store::hold_money_file(&path(), store::MONEY_LOCK_WAIT)?;
    let mut kept = all()?;
    let had = kept.len();
    kept.retain(|s| s.key != key);
    if kept.len() == had {
        return Ok(());
    }
    store::write_json(&path(), &unbrowse_files::SENDING, &kept)
}

/// Reads the chain for the write of `key`: what a caller does first, before it reads anything that write would change.
/// A write that came to nothing is let go here, and the owner told, so `Clear` is all the caller sees of it. One that
/// may still land is sent again as it was signed, in case the chain never had it.
///
/// It lands, or is let go, only on what is proven (`proof::prove_on`, `verdict`): its own receipt, proven to have run
/// or reverted, or the receipt of another transaction of the node's at its nonce, proven final. Nothing the RPC says
/// alone, and no length of time, does either; the owner, who has looked at the chain, may let it go
/// (`let_go_by_owner`). An RPC whose answers contradict a proof stops every write (`rpc::halt`).
pub async fn settle<P: Provider>(p: &P, key: &str) -> Result<Settled, String> {
    let Some(s) = of(key)? else { return Ok(Settled::Clear) };
    if let Some(r) = p.get_transaction_receipt(s.tx).await.map_err(|e| e.to_string())? {
        // A block that isn't final yet can still drop it, so it counts as waiting.
        let Ok(r) = rpc::finalized(p, r).await else { return Ok(Settled::Waiting(s)) };
        let at = r.block_number.ok_or("the receipt names no block")?;
        let proven = match crate::proof::prove_on(p, s.tx, at, None).await {
            // A once-only write's outcome needs more than the one RPC's word behind its block (`Proven::agreed`).
            Ok(crate::proof::Inclusion::Proven(proven)) if proven.agreed => Some(proven.ran),
            Ok(crate::proof::Inclusion::Proven(_)) => None,
            Ok(crate::proof::Inclusion::Unprovable(_)) => None,
            Err(e) => {
                rpc::halt(&e);
                return Ok(Settled::Waiting(s));
            }
        };
        match verdict(r.status(), proven) {
            Verdict::Landed => return Ok(Settled::Landed(s, r)),
            Verdict::Reverted => {
                done(key)?;
                tell(&s, "failed", "It never took effect (its block proves it reverted): nothing moved, and the node sends it again if it is still wanted");
                return Ok(Settled::Clear);
            }
            Verdict::Contradicted => {
                rpc::halt(&format!("the RPC's receipt for {:#x} says {} and its block says otherwise", s.tx, r.status()));
                return Ok(Settled::Waiting(s));
            }
            // A receipt the block can't be shown to hold, whatever it says: the write may still land, or may not have.
            Verdict::Waiting => {
                if !s.told {
                    tell(&s, "waiting", "Its receipt can't be proven against its block, so it isn't taken as landed or gone: nothing of it is sent again. The owner can let it go (`unbrowse-node chain kept`) once they have checked the chain");
                    mark_told(key)?;
                }
                return Ok(Settled::Waiting(s));
            }
        }
    }
    // Another of the node's own transactions at its nonce, proven final, rules it out for good.
    for h in &s.others {
        let Some(r) = p.get_transaction_receipt(*h).await.map_err(|e| e.to_string())? else { continue };
        let Ok(r) = rpc::finalized(p, r).await else { continue };
        let at = r.block_number.ok_or("the receipt names no block")?;
        match crate::proof::prove_on(p, *h, at, None).await {
            Ok(crate::proof::Inclusion::Proven(other)) if other.agreed => {
                done(key)?;
                tell(&s, "failed", "It never took effect: another of the node's own transactions, proven final, took its nonce. Nothing moved, and the node sends it again if it is still wanted");
                return Ok(Settled::Clear);
            }
            Ok(crate::proof::Inclusion::Proven(_)) | Ok(crate::proof::Inclusion::Unprovable(_)) => {}
            Err(e) => {
                rpc::halt(&e);
                return Ok(Settled::Waiting(s));
            }
        }
    }
    let used = p.get_transaction_count(s.signer).block_id(rpc::SETTLED).await.map_err(|e| e.to_string())? > s.nonce;
    if !used {
        // Kept alive: the same signed bytes, which can land once at most. A nonce nothing takes is taken by the node's
        // own no-op in time (`rpc::unstick`), whose proof then lets this go.
        let _ = p.send_raw_transaction(&s.raw).await;
        return Ok(Settled::Waiting(s));
    }
    // Its nonce went to a transaction nothing proves is the node's: this write may still land, or may never have. Only a
    // proof, or the owner who has looked at the chain (`let_go_by_owner`), lets it go: never time, and never one RPC's
    // word that its nonce is used and nothing changed.
    if !s.told {
        tell(&s, "waiting", "The chain says another transaction took this write's nonce, and nothing proves which: it isn't sent again while it may still land. Once you have checked on the chain that it never landed, let it go with `unbrowse-node chain kept release <key>`, which asks you first");
        mark_told(key)?;
    }
    Ok(Settled::Waiting(s))
}

/// What the read `data` of the contract `to` gives at the chain's final block.
pub async fn view<P: Provider>(p: &P, to: Address, data: &Bytes) -> Result<Bytes, String> {
    p.call(TransactionRequest::default().to(to).input(data.clone().into())).block(rpc::SETTLED).await.map_err(|e| format!("reading what a kept write changes: {e}"))
}

/// Keeps `s` as a test's write.
#[cfg(test)]
pub fn keep_for_test(s: Sending) {
    keep(s).unwrap();
}

/// Lets the kept write of `key` go on the owner's word, after they have looked at the chain: the one way other than a
/// proof (`settle`). Asked in the owner's dialog (`commands::asks_the_owner`), since a write let go that may still land
/// can be signed again and paid twice.
pub fn let_go_by_owner(key: &str) -> Result<Sending, String> {
    let s = of(key)?.ok_or_else(|| format!("no write of {key} is kept"))?;
    done(key)?;
    tell(&s, "failed", "Let go by the owner, who checked the chain: the node sends it again if it is still wanted");
    Ok(s)
}

/// A kept write as the owner is shown it.
#[derive(Clone, Debug, Serialize)]
pub struct KeptView {
    pub key: String,
    pub what: String,
    pub tx: String,
    pub nonce: u64,
    pub signed_at: u64,
    pub amount: f64,
    /// Whether what it would change reads otherwise at the final block than before it was signed, as the node's RPC
    /// reads it: a hint, never a proof. None when it can't be read, or the write names nothing to read.
    pub changed: Option<bool>,
}

/// Every kept write, with what its RPC reads of what it would change.
pub async fn kept_views<P: Provider>(p: &P) -> Result<Vec<KeptView>, String> {
    let mut out = Vec::new();
    for s in all()? {
        let changed = match &s.watch {
            Some(w) => view(p, w.to, &w.data).await.ok().map(|now| now != w.before),
            None => None,
        };
        out.push(KeptView { key: s.key, what: s.what, tx: format!("{:#x}", s.tx), nonce: s.nonce, signed_at: s.at, amount: s.amount, changed });
    }
    Ok(out)
}

fn mark_told(key: &str) -> Result<(), String> {
    let _one = FILE.locked();
    let _file = store::hold_money_file(&path(), store::MONEY_LOCK_WAIT)?;
    let mut kept = all()?;
    kept.iter_mut().filter(|s| s.key == key).for_each(|s| s.told = true);
    store::write_json(&path(), &unbrowse_files::SENDING, &kept)
}

/// Records that the node signed transaction `tx` at `signer`'s `nonce`: a kept write at that nonce can then be let go
/// once `tx` is final, since the two can't both land. Called for every write the node sends (`rpc::send_write`).
pub fn note_nonce(signer: Address, nonce: u64, tx: B256) -> Result<(), String> {
    let _one = FILE.locked();
    let _file = store::hold_money_file(&path(), store::MONEY_LOCK_WAIT)?;
    let mut kept = all()?;
    let mut changed = false;
    for s in kept.iter_mut().filter(|s| s.signer == signer && s.nonce == nonce && s.tx != tx && !s.others.contains(&tx)) {
        s.others.push(tx);
        changed = true;
    }
    if changed {
        store::write_json(&path(), &unbrowse_files::SENDING, &kept)?;
    }
    Ok(())
}

fn tell(s: &Sending, result: &str, note: &str) {
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "Node".into(),
        site: String::new(),
        what: format!("Looked again at {}", s.what),
        kind: "bond".into(),
        result: result.into(),
        ms: None,
        unb: None,
        tx: Some(format!("{:#x}", s.tx)),
        note: Some(note.into()),
    });
}

/// Run with each claim pass: what became of each kept write nothing else is waiting on, so a record never outlives the
/// write and the owner hears what became of one the node lost sight of.
pub async fn pass<P: Provider>(p: &P) {
    let Ok(kept) = all() else { return };
    for s in kept {
        if let Ok(Settled::Landed(s, _)) = settle(p, &s.key).await {
            if done(&s.key).is_ok() {
                tell(&s, "done", "It landed after the node stopped waiting for it");
            }
        }
    }
}

/// `call` as a signed transaction of `me`'s, filled as the node's provider fills every write: the next nonce by the
/// RPC's pending count, its own gas estimate with `rpc::NEXT_BLOCK_GAS` over it, and its fee estimate.
async fn signed<P, D>(call: &alloy::contract::CallBuilder<P, D>, me: Address, wallet: &NodeWallet) -> Result<(TxEnvelope, rpc::Priced), String>
where
    P: Provider + Clone,
    D: alloy::contract::CallDecoder + Clone,
{
    let p = &call.provider;
    let mut tx: TransactionRequest = call.as_ref().clone();
    tx.from = Some(me);
    // The chain the node runs on, which the RPC must agree it is (`rpc::same_chain`), never only its word.
    tx.chain_id = Some(rpc::same_chain(p, wallet.chain()).await?);
    tx.nonce = Some(p.get_transaction_count(me).pending().await.map_err(|e| e.to_string())?);
    let gas = p.estimate_gas(tx.clone()).await.map_err(|e| e.to_string())?.saturating_add(rpc::NEXT_BLOCK_GAS);
    let priced = rpc::priced(p, gas).await?;
    tx.gas = Some(priced.gas);
    tx.max_fee_per_gas = Some(priced.max_fee);
    tx.max_priority_fee_per_gas = Some(priced.tip);
    let signed = <TransactionRequest as TransactionBuilder<Ethereum>>::build(tx, wallet).await.map_err(|e| e.to_string())?;
    Ok((signed, priced))
}

/// What `once!` does on the node's turn to write: reads what the write changes (`watch`) at the final block, signs
/// `call`, keeps it, then sends it and waits, a bounded time, for its receipt and its block to be final. Refused before
/// it goes (no gas, a call that would revert, a file that can't be kept, writes stopped), nothing is kept. Anything after
/// it is kept leaves the record for `settle`, which lets it go only on what is proven: an RPC that turns the bytes away
/// may still have them, and one whose receipt says it reverted may say so of a write that landed. A write proven to
/// have reverted is let go here.
#[allow(clippy::too_many_arguments)]
pub async fn send<P, D>(call: &alloy::contract::CallBuilder<P, D>, me: Address, wallet: &NodeWallet, key: &str, amount: f64, book: Option<String>, watch: (Address, Bytes), what: &str) -> Result<TransactionReceipt, String>
where
    P: Provider + Clone,
    D: alloy::contract::CallDecoder + Clone,
{
    rpc::write_gate(&call.provider, wallet.chain(), rpc::Signs::Once).await.map_err(|e| format!("{what}: {e}"))?;
    if let Some(short) = crate::chain::short_of(call, me).await.map_err(|e| format!("{what}: {e}"))? {
        return Err(format!("{what}: {short}"));
    }
    let p = &call.provider;
    let before = view(p, watch.0, &watch.1).await.map_err(|e| format!("{what}: {e}"))?;
    let (signed, priced) = signed(call, me, wallet).await.map_err(|e| format!("{what}: {e}"))?;
    rpc::take_sub_budget(priced.most()).map_err(|e| format!("{what}: {e}"))?;
    let spend = rpc::Spend::reserve(&priced).map_err(|e| format!("{what}: {e}"))?;
    let tx = *signed.tx_hash();
    let raw: Bytes = signed.encoded_2718().into();
    let nonce = alloy::consensus::Transaction::nonce(&signed);
    let kept = Sending { key: key.into(), what: what.into(), signer: me, nonce, tx, raw: raw.clone(), at: store::now(), amount, book, others: Vec::new(), told: false, watch: Some(Watch { to: watch.0, data: watch.1, before }) };
    if let Err(e) = keep(kept) {
        spend.release();
        return Err(format!("{what}: {e}"));
    }
    if let Err(e) = p.send_raw_transaction(&raw).await {
        // Turned away, by the RPC's word: kept all the same, since the bytes may be out; `settle` sends them again.
        return Err(rpc::unsettled_error(what, e));
    }
    let mined = rpc::receipt_of(p, tx, rpc::RECEIPT_TIMEOUT).await.map_err(|e| rpc::unsettled_error(what, e))?;
    let receipt = rpc::finalized(p, mined).await.map_err(|e| rpc::unsettled_error(what, e))?;
    let proven = rpc::settle_proven(p, spend, tx, &receipt, Some(crate::proof::signed_fee(&signed))).await.map_err(|e| rpc::unsettled_error(what, e))?;
    match verdict(receipt.status(), proven.filter(|p| p.agreed).map(|p| p.ran)) {
        Verdict::Landed => Ok(receipt),
        Verdict::Reverted => {
            done(key)?;
            Ok(receipt)
        }
        // Kept: what the receipt says isn't taken until its block shows it (`settle`).
        Verdict::Waiting | Verdict::Contradicted => Err(rpc::unsettled_error(what, "its receipt can't be proven against its block yet")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sending(key: &str) -> Sending {
        Sending { key: key.into(), what: "the deposit".into(), signer: Address::ZERO, nonce: 7, tx: B256::ZERO, raw: Bytes::new(), at: 1, amount: 5.0, book: None, others: Vec::new(), told: false, watch: None }
    }

    /// Nothing lands, and nothing is let go, on an RPC's receipt alone: a receipt the block can't be shown to hold leaves
    /// the write waiting whether it says it ran or not, a proof decides, and a proof against the receipt stops writes.
    #[test]
    fn an_unproven_receipt_never_lands_a_once_only_write() {
        assert_eq!(verdict(true, None), Verdict::Waiting, "a receipt that says it ran, with nothing to prove it");
        assert_eq!(verdict(false, None), Verdict::Waiting, "or that it didn't");
        assert_eq!(verdict(true, Some(true)), Verdict::Landed);
        assert_eq!(verdict(false, Some(false)), Verdict::Reverted);
        assert_eq!(verdict(true, Some(false)), Verdict::Contradicted);
        assert_eq!(verdict(false, Some(true)), Verdict::Contradicted);
    }

    /// Every transaction the node signs at a kept write's nonce is noted on it, once, and only on writes of that
    /// signer at that nonce.
    #[test]
    fn a_transaction_at_a_kept_nonce_is_noted_on_the_write() {
        let _home = store::scratch_home("sending-nonce");
        keep(sending("deposit")).unwrap();
        let other = B256::repeat_byte(9);
        note_nonce(Address::ZERO, 7, other).unwrap();
        note_nonce(Address::ZERO, 7, other).unwrap();
        note_nonce(Address::ZERO, 8, B256::repeat_byte(8)).unwrap();
        note_nonce(Address::repeat_byte(1), 7, B256::repeat_byte(7)).unwrap();
        assert_eq!(of("deposit").unwrap().unwrap().others, vec![other]);
    }

    /// An RPC that says it holds the nonce hasn't refused the write: that may be the write itself.
    #[test]
    fn an_rpc_that_holds_the_nonce_has_not_refused_the_write() {
        assert!(holds_nonce("already known") && holds_nonce("nonce too low: next nonce 8, tx nonce 7"));
        assert!(!holds_nonce("max fee per gas less than block base fee"));
    }

    /// Only one write of a key is kept, and the file that says so is never read as empty.
    #[test]
    fn a_key_holds_one_write_and_a_spoiled_file_stops_the_next() {
        let _home = store::scratch_home("sending");
        keep(sending("deposit")).unwrap();
        assert!(keep(sending("deposit")).is_err(), "a second of the same key");
        keep(sending("identity")).unwrap();
        done("deposit").unwrap();
        assert_eq!(all().unwrap().len(), 1);
        std::fs::write(path(), b"{ not json").unwrap();
        assert!(all().is_err() && keep(sending("deposit")).is_err());
    }
}
