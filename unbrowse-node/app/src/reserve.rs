//! Listing roots posted by the rewards reserve (R2.20, spec §76 item 2), so a wallet with no gas lists.
//!
//! A listing spreads only once a root holding its leaf is posted (R2.19). A node that pays its own gas posts its own;
//! one that won't front the gas sends its leaves to the reserve's root poster instead, which posts one root over every
//! leaf sent to it each `listing.reserve_root_interval` (an hour), and publishes the root's leaf list. The contributor's
//! node reads the list back, checks the root is posted on chain, and records the root in its book with its own leaf's
//! place; only then does it spread the listing. The listing wallet sends no transaction: its node signs the listing and
//! the leaf, and its first claim, sent by whoever claims (a payer, `showAndClaim`), credits its entry.
//!
//! What the poster gets is a leaf and its sender's signature over it, never the listing: a leaf hides the body, so the
//! poster can't copy a listing ahead of the root that would precede the copy. It takes leaves only from a key that
//! signed them for this deployment, at most `PER_SENDER` an interval, so a sender can't flood the leaf list it
//! publishes. A root costs the poster one `postRoot` whatever it holds. *(client)*: the poster is any node run with
//! `UNBROWSE_RESERVE_POSTER=1`, on the devnet the operator's; the reserve's repayment of its gas in UNB (R9.14) isn't
//! built, so the poster pays its own. A peer gains by following: a contributor that waits for the reserve's root spends
//! nothing, and one that posts its own spreads sooner; a poster that refuses leaves only stops being used.
//!
//! Mixed versions: a node from before this one posts its own root, as it always did, and reads roots the reserve posted
//! like any other (a root is a root). A node that knows no poster posts its own.

use alloy::primitives::{keccak256, Address, FixedBytes};
use alloy::signers::SignerSync;
use serde::{Deserialize, Serialize};
use unbrowse_core::KeyStore;

use crate::listing::{self, Posted};
use crate::{chain, network, store, Node};
use crate::sync::Locked;

/// The most leaves one sender's key may send the poster in an interval.
pub const PER_SENDER: usize = 64;

/// Whether this node posts the reserve's roots: `UNBROWSE_RESERVE_POSTER=1`.
pub fn poster_on() -> bool {
    std::env::var("UNBROWSE_RESERVE_POSTER").is_ok_and(|v| v.trim() == "1")
}

/// How often the poster posts a root, in seconds (`listing.reserve_root_interval`, one hour), unless
/// `UNBROWSE_RESERVE_INTERVAL` names another, as a devnet's does to see a root within a minute.
pub fn interval() -> u64 {
    std::env::var("UNBROWSE_RESERVE_INTERVAL").ok().and_then(|v| v.trim().parse().ok()).filter(|s| *s > 0).unwrap_or(3_600)
}

/// Where this node sends its leaves: `UNBROWSE_RESERVE_URL`, else a node on this machine that advertises itself as the
/// reserve's poster (the devnet's network folder), else none, and the node posts its own roots.
pub fn endpoint() -> Option<String> {
    if let Some(u) = std::env::var("UNBROWSE_RESERVE_URL").ok().filter(|u| !u.trim().is_empty()) {
        return Some(u.trim().trim_end_matches('/').to_string());
    }
    if poster_on() {
        return None;
    }
    network::ads().into_iter().filter(|a| a.reserve && !a.endpoint.is_empty()).max_by_key(|a| a.at).map(|a| a.endpoint)
}

/// What a sender signs (EIP-191) to send `leaf` to the poster of the deployment `d`.
pub fn leaf_digest(d: &chain::Deployment, leaf: FixedBytes<32>) -> FixedBytes<32> {
    let h = keccak256([b"unbrowse/reserve-leaf".as_slice(), &d.chain_id.to_be_bytes(), d.settlement.as_slice(), leaf.as_slice()].concat());
    alloy::primitives::eip191_hash_message(h)
}

/// A leaf as it is sent to the poster.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sent {
    pub leaf: FixedBytes<32>,
    pub from: Address,
    pub sig: String,
}

/// The poster's book for one deployment: the leaves waiting for the next root, who sent each and when, and the roots
/// it posted, each with its leaf list.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Book {
    pending: Vec<(FixedBytes<32>, Address, u64)>,
    posted: Vec<Posted>,
    last: u64,
}

fn book_path(d: &chain::Deployment) -> std::path::PathBuf {
    store::home().join(format!("reserve-roots-{}-{:#x}.json", d.chain_id, d.settlement))
}

static BOOK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Takes a leaf for the next root: signed for this deployment by the key it names, a key with an ERC-8004 identity (R2.20,
/// spec §76.2 item 8; on a devnet with no registry, a devnet identity: a node that advertises itself, `network::ads`),
/// at most `PER_SENDER` from that key since the last root, once.
pub async fn accept(chain: &chain::Chain, s: &Sent) -> Result<(), String> {
    if !poster_on() {
        return Err("this node doesn't post the reserve's roots".into());
    }
    let d = chain.deployed()?;
    let bytes = hex::decode(s.sig.strip_prefix("0x").unwrap_or(&s.sig)).map_err(|_| "the signature isn't hex")?;
    let sig = alloy::primitives::Signature::try_from(bytes.as_slice()).map_err(|e| format!("the signature doesn't read: {e}"))?;
    if sig.recover_address_from_prehash(&leaf_digest(&d, s.leaf)).ok() != Some(s.from) {
        return Err("the leaf isn't signed by the key it names".into());
    }
    let identity = match crate::erc8004::registry_of(chain) {
        Some(_) => crate::erc8004::identity_of(chain, s.from).await?.is_some(),
        None => network::ad_of(&format!("{:#x}", s.from)).is_some(),
    };
    if !identity {
        return Err("the reserve's poster takes leaves only from a sender with an ERC-8004 identity".into());
    }
    take_leaf(&book_path(&d), s)
}

/// The poster's book as the file at `path` holds it. Strict: its roots' leaf lists exist nowhere else, and contributors
/// adopt from them, so a file that doesn't read is an error and is left for the owner, never written over as empty.
fn book_at(path: &std::path::Path) -> Result<Book, String> {
    store::read_json_strict(path, &unbrowse_files::RESERVE_ROOTS)
}

/// Keeps `s` for the next root in the book at `path`, once, and at most `PER_SENDER` from a sender.
fn take_leaf(path: &std::path::Path, s: &Sent) -> Result<(), String> {
    let _one = BOOK.locked();
    let mut b = book_at(path)?;
    if b.pending.iter().any(|(l, _, _)| *l == s.leaf) || b.posted.iter().any(|p| p.leaves.contains(&s.leaf)) {
        return Ok(());
    }
    if b.pending.iter().filter(|(_, f, _)| *f == s.from).count() >= PER_SENDER {
        return Err(format!("at most {PER_SENDER} leaves a sender in a root"));
    }
    b.pending.push((s.leaf, s.from, store::now()));
    store::write_json(path, &unbrowse_files::RESERVE_ROOTS, &b)
}

/// The roots the poster posted from `since` (a block) on, each with its leaf list.
pub fn roots(chain: &chain::Chain, since: u64) -> Vec<Posted> {
    let Ok(d) = chain.deployed() else { return vec![] };
    let b: Book = store::read_json(&book_path(&d), &unbrowse_files::RESERVE_ROOTS);
    b.posted.into_iter().filter(|p| p.block >= since).collect()
}

/// The poster's turn: once an interval, one root over every leaf waiting, posted and recorded with its leaf list. A
/// post that fails leaves the leaves waiting for the next turn.
pub async fn post_due(chain: &chain::Chain, keys: &(dyn KeyStore + Sync)) -> Result<Option<Posted>, String> {
    let d = chain.deployed()?;
    let leaves: Vec<FixedBytes<32>> = {
        let _one = BOOK.locked();
        let b = book_at(&book_path(&d))?;
        if b.pending.is_empty() || store::now() < b.last.saturating_add(interval()) {
            return Ok(None);
        }
        b.pending.iter().map(|(l, _, _)| *l).collect()
    };
    let (root, _) = listing::positional(&leaves);
    let (tx, block) = chain::post_root(chain, keys, root).await?;
    let posted = Posted { root, leaves: leaves.clone(), block, tx };
    let _one = BOOK.locked();
    let mut b = book_at(&book_path(&d))?;
    b.pending.retain(|(l, _, _)| !leaves.contains(l));
    b.posted.push(posted.clone());
    b.last = store::now();
    store::write_json(&book_path(&d), &unbrowse_files::RESERVE_ROOTS, &b)?;
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "Node".into(),
        site: "Settlement".into(),
        what: format!("Posted the reserve's listing root over {} leaf{}", leaves.len(), if leaves.len() == 1 { "" } else { "s" }),
        kind: "list".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: Some(posted.tx.clone()),
        note: Some("One root an interval for contributors that send their leaves instead of posting (R2.20)".into()),
    });
    Ok(Some(posted))
}

/// Sends the poster at `endpoint` each of `leaves`, signed by this node's owner key. A poster's refusal is about one
/// leaf (its sender's limit for the root, say), so it is said and the rest still go, and a pass goes on to read the
/// roots that hold the leaves it took. Only a poster that can't be reached is an error.
pub async fn send(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), endpoint: &str, leaves: &[FixedBytes<32>]) -> Result<(), String> {
    let d = chain.deployed()?;
    let key = chain::owner_signer(keys)?;
    let client = reqwest::Client::new();
    for leaf in leaves {
        let sig = key.sign_hash_sync(&leaf_digest(&d, *leaf)).map_err(|e| e.to_string())?;
        let body = Sent { leaf: *leaf, from: key.address(), sig: format!("0x{}", hex::encode(sig.as_bytes())) };
        let r = client
            .post(format!("{endpoint}/v1/remote/reserve/leaf"))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("sending a leaf to the reserve's poster: {e}"))?;
        if !r.status().is_success() {
            eprintln!("listing: the reserve's poster refused leaf {leaf:#x}, sent again next pass: {}", r.text().await.unwrap_or_default());
        }
    }
    Ok(())
}

/// The roots the poster at `endpoint` says it posted since `since`.
pub async fn fetch_roots(endpoint: &str, since: u64) -> Result<Vec<Posted>, String> {
    reqwest::Client::new()
        .get(format!("{endpoint}/v1/remote/reserve/roots"))
        .query(&[("since", since.to_string())])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("reading the reserve's roots: {e}"))?
        .json()
        .await
        .map_err(|e| format!("reading the reserve's roots: {e}"))
}

/// Once a pass: the poster posts its root when one is due; a contributor that sent leaves adopts the roots that hold
/// them, and spreads each listing that now has one.
pub async fn tick(node: &Node) {
    let Ok(keys) = node.key() else { return };
    if poster_on() {
        match post_due(&node.chain, keys).await {
            Ok(Some(p)) => eprintln!("reserve: posted root {:#x} over {} leaves in block {}", p.root, p.leaves.len(), p.block),
            Ok(None) => {}
            Err(e) => eprintln!("reserve: couldn't post the root, tried again next pass: {e}"),
        }
    }
    match listing::adopt_reserve_roots(&node.chain, keys).await {
        Ok(spread) => {
            for p in spread {
                crate::peers::provide(node, &p.listing.site).await;
                crate::share::provide(node, &p.listing.content_id, true).await;
                eprintln!("listing: {} is under the reserve's root {:#x} and spreads now", p.listing.route_id, p.root);
            }
        }
        Err(e) => eprintln!("listing: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The book holds the only copy of its roots' leaf lists: one that doesn't read is left as it is, and no leaf is
    /// taken over it.
    #[test]
    fn a_book_that_wont_read_is_never_written_over() {
        let home = store::scratch_home("reserve-book");
        let path = home.join("reserve-roots.json");
        std::fs::write(&path, "{ not a book").unwrap();
        let s = Sent { leaf: FixedBytes::repeat_byte(7), from: Address::repeat_byte(1), sig: String::new() };
        assert!(take_leaf(&path, &s).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not a book");
    }

    /// A poster that refuses one leaf doesn't keep the node from sending the next, or from reading the roots after.
    #[tokio::test]
    async fn a_refused_leaf_holds_up_no_other() {
        use std::io::{Read, Write};
        let _home = store::scratch_home("reserve-refused");
        let poster = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = format!("http://{}", poster.local_addr().unwrap());
        let served = std::thread::spawn(move || {
            let mut seen = 0;
            for answer in ["403 Forbidden", "200 OK"] {
                let Ok((mut c, _)) = poster.accept() else { break };
                let mut buf = [0u8; 4096];
                let _ = c.read(&mut buf);
                seen += 1;
                let _ = write!(c, "HTTP/1.1 {answer}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            }
            seen
        });
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let chain = chain::Chain::default();
        *chain.deployment.locked() = Some(chain::Deployment::default());
        send(&chain, &keys, &at, &[FixedBytes::repeat_byte(1), FixedBytes::repeat_byte(2)]).await.expect("a refusal is about one leaf");
        assert_eq!(served.join().unwrap(), 2, "the second leaf went");
    }

    /// A sender signs each leaf for one deployment: the signature recovers to it there, and to no one on another
    /// chain or deployment, so a leaf can't be sent under another's key or replayed to another poster.
    #[test]
    fn a_leaf_is_signed_for_one_deployment() {
        let key = alloy::signers::local::PrivateKeySigner::random();
        let d = chain::Deployment { chain_id: 31337, settlement: Address::repeat_byte(1), ..Default::default() };
        let leaf = FixedBytes::repeat_byte(7);
        let sig = key.sign_hash_sync(&leaf_digest(&d, leaf)).unwrap();
        assert_eq!(sig.recover_address_from_prehash(&leaf_digest(&d, leaf)).unwrap(), key.address());
        let other = chain::Deployment { settlement: Address::repeat_byte(2), ..d.clone() };
        assert_ne!(sig.recover_address_from_prehash(&leaf_digest(&other, leaf)).ok(), Some(key.address()));
        let elsewhere = chain::Deployment { chain_id: 5042002, ..d.clone() };
        assert_ne!(sig.recover_address_from_prehash(&leaf_digest(&elsewhere, leaf)).ok(), Some(key.address()));
        assert_ne!(sig.recover_address_from_prehash(&leaf_digest(&d, FixedBytes::repeat_byte(8))).ok(), Some(key.address()));
    }
}
