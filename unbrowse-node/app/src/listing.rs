//! Signed listings and listing roots (protocol §2.3–2.4, R2.14–R2.19).
//!
//! A listing is the contributor's signed word that a body is theirs and on what terms: the route, the body's content
//! identifier (`recipe::content_id`), the contributor's identity, the version and the version it supersedes, and a
//! commitment to its terms (description, response shape, price). The identity's wallet's own key signs it as EIP-712
//! typed data under Settlement's domain (`chain::domain`), so a signature holds on one chain and for one deployment only.
//! Every node under one wallet lists under the wallet's identity (R1.12, R7.22): the node that holds the wallet's key
//! signs as it lists, and any other keeps each listing until the owner's wallet signs it (`to_sign`, `sign_waiting`).
//!
//! Listing writes nothing to the chain (R2.15). Before a listing spreads, a root holding its leaf is posted (`postRoot`):
//! by its node, when it pays its own gas (R2.19), or by the rewards reserve's poster, which posts one root an interval
//! over every leaf sent to it (R2.20), so a wallet with no gas lists too (spec §76 item 2). The root's block proves the
//! listing existed by then. The node keeps each root's leaf list with its listings and serves each listing with its
//! leaf, its place in the root and its proof. The chain learns of a listing only at its first claim, which carries it
//! (`Listings.showAndClaim`, R2.18) and credits the body's entry, `chain::content_entry_id`, to its contributor.
//!
//! A reader keeps a listing when the signature is the contributor identity's key and the leaf is under a posted root
//! (R2.15). The chain need hold no entry for it: no claim may have shown it yet. When it holds one, the entry must be
//! credited to this listing's contributor, live, and for its site. The chain credits the earliest listing *shown*, so
//! one credited to another contributor is a copy's until its contributor contests it ([`contest`]), which only that
//! contributor's node has any reason to do while the credit isn't final.
//!
//! The leaf of a listing is `keccak256(keccak256(digest))`, the digest being the listing's EIP-712 signing hash
//! (`Listings.leafOf`). Listing roots are positional trees (`Listings.rootOf`): a leaf's index is the path its proof
//! climbs, so a proof shows where in its root a leaf sits, which orders copies in one root (R2.18).

use alloy::primitives::{keccak256, Address, FixedBytes, Signature};
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::SignerSync;
use alloy::sol_types::{Eip712Domain, SolStruct};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unbrowse_core::KeyStore;

use crate::recipe::{self, Recipe};
use crate::{chain, erc8004, store};
use crate::sync::Locked;

mod typed {
    alloy::sol! {
        /// A listing as EIP-712 types it. Its own type under Settlement's domain, so its signature is never a voucher's.
        struct Listing { string routeId; string site; string contentId; string agentId; uint64 version; string supersedes; bytes32 terms; }
    }
}

/// How a listing is priced: by the contributor's detail fee on Settlement, one fee for every entry it lists, read at
/// call time, and never under `amount`, the listed price, in USDC's smallest unit as a decimal string: the least a use
/// pays, and what a check is held to (R6.29). The contract reads it from the terms in full (`Listings.priceOf`),
/// which canonical JSON puts first in the price object. A listing with no amount, from before, lists no price a check
/// can be held to, and its terms hash as they always did.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Price {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
    pub kind: String,
    pub currency: String,
}

impl Default for Price {
    fn default() -> Self {
        Self { amount: None, kind: "detail_fee".into(), currency: "USDC".into() }
    }
}

impl Price {
    /// The detail fee, listed at `amount` units of USDC.
    pub fn listed(amount: alloy::primitives::U256) -> Self {
        Self { amount: Some(amount.to_string()), ..Self::default() }
    }

    /// The listed price in USDC's smallest unit, if the listing names one.
    pub fn units(&self) -> Option<alloy::primitives::U256> {
        self.amount.as_deref().and_then(|a| a.parse().ok())
    }
}

/// What a listing offers: the contributor's description (a claim, read as data, R2.22, R2.25), the response's shape
/// and the price schedule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Terms {
    pub description: String,
    pub response: Option<Value>,
    pub price: Price,
}

/// A listing, signed by its contributor's owner key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SignedListing {
    pub route_id: String,
    /// The host the route calls: the on-chain entry's domain.
    pub site: String,
    pub content_id: String,
    /// The contributor's identity: its ERC-8004 `agentId` (decimal), or its wallet address on a devnet with no registry.
    pub agent_id: String,
    pub version: u64,
    /// The content identifier of the contributor's own version this one replaces.
    pub supersedes: Option<String>,
    pub terms: Terms,
    /// The owner key's signature over the digest, 65 bytes in hex.
    pub sig: String,
}

/// The most bytes a listing's response shape takes in its terms: listings travel many to a peer answer.
const MAX_SHAPE_BYTES: usize = 4096;

/// The shape as terms carry it: whole when small, else cut to the depth that fits, deeper values named only by kind.
pub fn bounded_shape(shape: Option<Value>) -> Option<Value> {
    fn cut(v: &Value, depth: usize) -> Value {
        match v {
            Value::Object(_) if depth == 0 => Value::String("object".into()),
            Value::Array(_) if depth == 0 => Value::String("array".into()),
            Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), cut(v, depth - 1))).collect()),
            Value::Array(xs) => Value::Array(xs.iter().map(|x| cut(x, depth - 1)).collect()),
            x => x.clone(),
        }
    }
    let shape = shape?;
    let fits = |v: &Value| recipe::canonical_json(v).len() <= MAX_SHAPE_BYTES;
    if fits(&shape) {
        return Some(shape);
    }
    (0..8).rev().map(|d| cut(&shape, d)).find(fits)
}

impl SignedListing {
    /// The terms in full, as their canonical bytes: what a check carries for the contract to read the price from.
    pub fn terms_bytes(&self) -> Vec<u8> {
        recipe::canonical_json(&serde_json::to_value(&self.terms).unwrap_or_default())
    }

    /// The commitment to the terms the signature covers: the hash of their canonical bytes.
    pub fn terms_hash(&self) -> FixedBytes<32> {
        keccak256(self.terms_bytes())
    }

    /// The EIP-712 digest the owner key signs.
    pub fn digest(&self, domain: &Eip712Domain) -> FixedBytes<32> {
        typed::Listing {
            routeId: self.route_id.clone(),
            site: self.site.clone(),
            contentId: self.content_id.clone(),
            agentId: self.agent_id.clone(),
            version: self.version,
            supersedes: self.supersedes.clone().unwrap_or_default(),
            terms: self.terms_hash(),
        }
        .eip712_signing_hash(domain)
    }

    /// The listing's leaf in a listing root.
    pub fn leaf(&self, domain: &Eip712Domain) -> FixedBytes<32> {
        keccak256(keccak256(self.digest(domain)))
    }

    /// The entry its body is paid under on the chain (`Listings.entryIdOf`).
    pub fn entry(&self) -> FixedBytes<32> {
        chain::content_entry_id(&self.content_id)
    }

    /// Whether it lists a skill: a skill names no site (R2.14, R4.9).
    pub fn is_skill(&self) -> bool {
        self.site.is_empty()
    }

    /// The key that signed it.
    pub fn signer(&self, domain: &Eip712Domain) -> Result<Address, String> {
        let bytes = hex::decode(self.sig.strip_prefix("0x").unwrap_or(&self.sig)).map_err(|_| "the listing's signature isn't hex")?;
        let sig = Signature::try_from(bytes.as_slice()).map_err(|e| format!("the listing's signature doesn't read: {e}"))?;
        sig.recover_address_from_prehash(&self.digest(domain)).map_err(|e| format!("the listing's signature doesn't recover: {e}"))
    }

    /// The same listing, signed by `key`.
    pub fn signed(mut self, key: &PrivateKeySigner, domain: &Eip712Domain) -> Result<SignedListing, String> {
        let sig = key.sign_hash_sync(&self.digest(domain)).map_err(|e| e.to_string())?;
        self.sig = format!("0x{}", hex::encode(sig.as_bytes()));
        Ok(self)
    }
}

/// What a contributor signs to withdraw its listing of a body (R2.16): the body's entry and content id, and when, after
/// a domain of its own and Settlement's EIP-712 domain separator, so no signature made for anything else, on any other
/// chain or deployment, reads as one.
pub fn withdrawal_digest(domain: &Eip712Domain, entry: FixedBytes<32>, content_id: &str, at: u64) -> FixedBytes<32> {
    keccak256([b"unbrowse/withdrawal/1".as_slice(), domain.separator().as_slice(), entry.as_slice(), content_id.as_bytes(), &at.to_be_bytes()].concat())
}

/// The withdrawal `key` signs, in hex.
pub fn sign_withdrawal(key: &PrivateKeySigner, domain: &Eip712Domain, entry: FixedBytes<32>, content_id: &str, at: u64) -> Result<String, String> {
    let sig = key.sign_hash_sync(&withdrawal_digest(domain, entry, content_id, at)).map_err(|e| e.to_string())?;
    Ok(format!("0x{}", hex::encode(sig.as_bytes())))
}

/// The key that signed a withdrawal, if it reads as one.
pub fn withdrawal_signer(sig: &str, domain: &Eip712Domain, entry: FixedBytes<32>, content_id: &str, at: u64) -> Result<Address, String> {
    let bytes = hex::decode(sig.strip_prefix("0x").unwrap_or(sig)).map_err(|_| "the withdrawal's signature isn't hex")?;
    let sig = Signature::try_from(bytes.as_slice()).map_err(|e| format!("the withdrawal's signature doesn't read: {e}"))?;
    sig.recover_address_from_prehash(&withdrawal_digest(domain, entry, content_id, at)).map_err(|e| format!("the withdrawal's signature doesn't recover: {e}"))
}

/// A listing as it spreads: with its leaf, the root holding it, its leaf's index there and the proof that it is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Proven {
    pub listing: SignedListing,
    pub leaf: FixedBytes<32>,
    pub root: FixedBytes<32>,
    /// The leaf's place in the root: the path its proof climbs (`Listings.rootOf`).
    #[serde(default)]
    pub index: u64,
    pub proof: Vec<FixedBytes<32>>,
}

/// The most levels a listing root's proof may climb (`Listings.MAX_DEPTH`).
pub const MAX_DEPTH: usize = 24;

impl Proven {
    /// Checks what needs no chain: the signature is `identity`'s key, and the leaf is this listing's and is at its
    /// index under the root. Returns the signer.
    pub fn check(&self, domain: &Eip712Domain, identity: Address) -> Result<Address, String> {
        let signer = self.listing.signer(domain)?;
        if signer != identity {
            return Err("the listing isn't signed by its contributor's key".into());
        }
        if self.leaf != self.listing.leaf(domain) {
            return Err("the leaf isn't this listing's".into());
        }
        if !climbs(self.root, self.leaf, self.index, &self.proof) {
            return Err("the listing isn't under the root it names".into());
        }
        Ok(signer)
    }

    /// The listing as `Listings.showAndClaim` takes it.
    pub fn shown(&self) -> Result<chain::ListingsDigest::Shown, String> {
        let l = &self.listing;
        Ok(chain::ListingsDigest::Shown {
            listing: chain::ListingsDigest::Listing {
                routeId: l.route_id.clone(),
                site: l.site.clone(),
                contentId: l.content_id.clone(),
                agentId: l.agent_id.clone(),
                version: l.version,
                supersedes: l.supersedes.clone().unwrap_or_default(),
                terms: l.terms_hash(),
            },
            sig: alloy::primitives::Bytes::from(hex::decode(l.sig.strip_prefix("0x").unwrap_or(&l.sig)).map_err(|_| "the listing's signature isn't hex")?),
            root: self.root,
            index: alloy::primitives::U256::from(self.index),
            proof: self.proof.clone(),
        })
    }
}

/// A positional Merkle tree over listing leaves, as `Listings.rootOf` climbs it: each pair hashed left then right, a
/// level's odd last node paired with zero. Returns the root and each leaf's proof, siblings from the leaf up.
pub fn positional(leaves: &[FixedBytes<32>]) -> (FixedBytes<32>, Vec<Vec<FixedBytes<32>>>) {
    let mut proofs: Vec<Vec<FixedBytes<32>>> = vec![Vec::new(); leaves.len()];
    if leaves.is_empty() {
        return (FixedBytes::ZERO, proofs);
    }
    let mut level: Vec<FixedBytes<32>> = leaves.to_vec();
    let mut at: Vec<usize> = (0..leaves.len()).collect();
    while level.len() > 1 {
        for (i, a) in at.iter_mut().enumerate() {
            let sib = *a ^ 1;
            proofs[i].push(level.get(sib).copied().unwrap_or(FixedBytes::ZERO));
            *a /= 2;
        }
        level = level.chunks(2).map(|c| keccak256([c[0].as_slice(), c.get(1).unwrap_or(&FixedBytes::ZERO).as_slice()].concat())).collect();
    }
    (level[0], proofs)
}

/// Whether `proof` climbs from `leaf` at `index` to `root` in a positional tree, as `Listings` checks it: at most
/// `MAX_DEPTH` levels, and an index no deeper than the proof, so one leaf can't be shown at two places.
pub fn climbs(root: FixedBytes<32>, leaf: FixedBytes<32>, index: u64, proof: &[FixedBytes<32>]) -> bool {
    if proof.len() > MAX_DEPTH || (proof.len() < 64 && index >> proof.len() != 0) {
        return false;
    }
    let mut i = index;
    let up = proof.iter().fold(leaf, |h, s| {
        let next = if i & 1 == 0 { keccak256([h.as_slice(), s.as_slice()].concat()) } else { keccak256([s.as_slice(), h.as_slice()].concat()) };
        i >>= 1;
        next
    });
    up == root
}

/// A listing this node read and checked against the chain.
#[derive(Clone, Debug)]
pub struct Verified {
    pub proven: Proven,
    /// The contributor's wallet: the key that signed, the identity's owner and, once a claim has shown a listing of
    /// the body, the entry's contributor.
    pub contributor: Address,
    /// What a use pays, in USDC: the contributor's fee on the chain, never under the price the listing lists.
    pub fee: f64,
    /// The same, in units of Settlement's USDC: what a voucher or line paying it is checked against.
    pub fee_units: alloy::primitives::U256,
    /// The block its root was first posted in: what orders copies of one body (R2.18).
    #[allow(dead_code)]
    pub root_block: u64,
    /// Whether a claim has shown a listing of the body yet: until one has, the chain holds no entry for it, and the
    /// first claim of a line on it carries this listing (`Listings.showAndClaim`).
    pub credited: bool,
}

impl Verified {
    /// The entry its body is paid under.
    pub fn entry(&self) -> FixedBytes<32> {
        self.proven.listing.entry()
    }
}

/// The wallet whose key speaks for an identity: on a chain with an ERC-8004 registry the identity's owner there; on a
/// devnet with none, the identity is the wallet itself.
pub async fn identity_key(chain: &chain::Chain, agent_id: &str) -> Result<Address, String> {
    match erc8004::registry_of(chain) {
        Some(net) => erc8004::owner_of(net.identity, agent_id).await,
        None => agent_id.parse().map_err(|_| format!("{agent_id} isn't a wallet address")),
    }
}

/// The identity this node lists under: its ERC-8004 `agentId` where the chain has a registry (registering it the first
/// time), else its wallet.
pub async fn own_identity(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), name: &str) -> Result<String, String> {
    match erc8004::registry_of(chain) {
        Some(_) => Ok(erc8004::ensure(chain, keys, name).await?.agent_id),
        None => Ok(format!("{:#x}", chain::owner_address(keys)?)),
    }
}

/// Who a node lists as, and the key it signs with (R2.14, R1.12, R7.22): the identity of the wallet the owner confirmed
/// for it (`link::confirmed`), so every node under one wallet lists, serves and earns under the wallet's one identity,
/// its reputation, bond and payouts the wallet's (R6.1); else, with no wallet linked, its own. A listing is signed by
/// the identity's wallet's own key, never a key the wallet granted (issue #184, `Listings.signedFor`): a node that
/// holds that key signs as it lists, and one that doesn't keeps the listing until the owner's wallet signs it
/// (`to_sign`, `sign_waiting`), as the wallet sends its own grants (`owner_nodes`).
pub struct Lister {
    pub agent_id: String,
    /// The wallet the identity's entries are credited to.
    pub wallet: Address,
    /// The wallet's own key, when this node holds it: `None` when the owner's wallet signs each listing itself.
    pub key: Option<PrivateKeySigner>,
}

pub async fn lister(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), name: &str) -> Result<Lister, String> {
    let key = chain::owner_signer(keys)?;
    if let Some((wallet, agent_id)) = wallet_identity(chain, keys, key.address()).await? {
        return Ok(Lister { agent_id, wallet, key: None });
    }
    Ok(Lister { agent_id: own_identity(chain, keys, name).await?, wallet: key.address(), key: Some(key) })
}

/// The wallet whose identity a node lists under, when it isn't the node's own (R1.12): the one the owner confirmed for
/// it, `confirmed`. Only a confirmed wallet: what lists under a wallet earns for it, and a link file is no more than
/// this user's other programs can write. A node whose own key is that wallet is the node that holds the wallet's key,
/// and lists as it always has.
pub fn shared_wallet(own: Address, confirmed: Option<Address>) -> Option<Address> {
    confirmed.filter(|w| *w != own)
}

/// The owner's wallet and its identity, when this node lists under them (`shared_wallet`). A wallet that holds no
/// identity yet has nothing to list under: the node lists under its own until the wallet registers one.
async fn wallet_identity(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), own: Address) -> Result<Option<(Address, String)>, String> {
    let Some(w) = shared_wallet(own, crate::link::confirmed(keys)) else { return Ok(None) };
    let agent_id = match erc8004::registry_of(chain) {
        Some(_) => erc8004::identity_of(chain, w).await?,
        None => Some(format!("{w:#x}")),
    };
    Ok(agent_id.map(|a| (w, a)))
}

/// The first version a node takes for a route under an identity (R2.14). The node that holds the identity's key starts
/// at 1. Every other node under the identity starts at a place of its own, drawn from its own address, so two nodes that
/// learned one route never sign two bodies under one version of it: that pair, signed by one wallet, is the fraud R6.15
/// (a) takes the wallet's whole bond for. Each place holds 2^32 versions and stays under 2^52, so a version still reads
/// exactly as a JavaScript number.
pub fn first_version(own: Address, shared: bool) -> u64 {
    if !shared {
        return 1;
    }
    let a = own.as_slice();
    let place = (u32::from_be_bytes([0, a[0], a[1], a[2]]) >> 4).max(1);
    (u64::from(place) << 32) + 1
}

/// Who can write a route's entry on the chain, read from the entry as the chain has it: `(contributor, live)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EntryStep {
    /// Nothing to write: the chain already has it so, or holds no entry yet (R2.18).
    Nothing,
    /// This node's own key writes it.
    Node,
    /// The contract takes it from that wallet alone, and the node holds no key of a linked wallet: the owner sends it.
    Wallet(Address),
    /// The entry is another contributor's: nothing of this node's can write it.
    Theirs,
}

/// What it takes for an entry on the chain to read `live`, when this node's key is `me` and it lists under `wallet`.
pub fn entry_step(on_chain: Option<(Address, bool)>, live: bool, me: Address, wallet: Address) -> EntryStep {
    match on_chain {
        None => EntryStep::Nothing,
        Some((by, _)) if by != me && by != wallet => EntryStep::Theirs,
        Some((_, now)) if now == live => EntryStep::Nothing,
        Some((by, _)) if by == me => EntryStep::Node,
        Some((by, _)) => EntryStep::Wallet(by),
    }
}

/// What a pass does about a route whose mark and chain entry disagree (`local_live` against `on_chain`), so the two can't
/// stay apart: a crash between a chain write and the record leaves them so, and a payer's claim shows a listing the owner
/// delisted before any claim had credited it, live again (`Listings.showAndClaim`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mend {
    Nothing,
    /// The owner delisted it and the chain shows it live: delist it again. A wallet's entry is left to the wallet.
    Delist,
    /// The chain took it out of the live set: the route stops reading as listed.
    MarkDelisted,
    /// The credit moved to another contributor's earlier listing (`Listings.Credited`), so a use of the entry pays them
    /// and this node's lines for it are refused: the route stops reading as listed, and the owner is told who holds it.
    Moved(Address),
}

pub fn mend(local_live: bool, on_chain: Option<(Address, bool)>, me: Address, wallet: Address) -> Mend {
    match on_chain {
        Some((by, true)) if !local_live && by == me => Mend::Delist,
        Some((by, false)) if local_live && (by == me || by == wallet) => Mend::MarkDelisted,
        Some((by, true)) if local_live && by != me && by != wallet => Mend::Moved(by),
        _ => Mend::Nothing,
    }
}

/// The wallet this node's listings are credited to (`lister`): the owner's wallet when the node lists under it, else
/// its own. Registers nothing.
pub async fn lister_wallet(chain: &chain::Chain, keys: &(dyn KeyStore + Sync)) -> Result<Address, String> {
    let own = chain::owner_address(keys)?;
    Ok(wallet_identity(chain, keys, own).await?.map_or(own, |(w, _)| w))
}

/// Checks a listing read from another node, or this node's own (R2.15): its signature is its contributor identity's
/// key and its leaf is at its place under a posted root. The chain need hold no entry for it: a listing is learned on
/// chain only at its first claim (R2.18), so a listing no claim has shown yet is good, and unclaimed. When the chain
/// holds the body's entry, it must be credited to this listing's contributor, live and for the site it names: a reader
/// holds to the chain's credit, the earliest listing shown, and a listing that is really earlier moves it by [`contest`].
pub async fn verify(chain: &chain::Chain, p: &Proven) -> Result<Verified, String> {
    judge(chain, p).await.map_err(Refused::said)
}

/// Why a listing wasn't kept: a rule turned it away, from the listing itself or from what the chain answered, which
/// the same listing would meet again; or a read went unanswered (the RPC failed, timed out or reverted), which says
/// nothing about the listing and may go otherwise when read again.
#[derive(Clone, Debug, PartialEq)]
pub enum Refused {
    Rule(String),
    Unread(String),
}

impl Refused {
    pub fn said(self) -> String {
        match self {
            Refused::Rule(s) | Refused::Unread(s) => s,
        }
    }
}

impl From<String> for Refused {
    /// What the listing's own checks say is a rule.
    fn from(s: String) -> Refused {
        Refused::Rule(s)
    }
}

/// [`verify`], with each refusal told apart by whether a rule made it or a read failed to answer.
async fn judge(chain: &chain::Chain, p: &Proven) -> Result<Verified, Refused> {
    let d = chain.deployed().map_err(Refused::Unread)?;
    let domain = chain::domain(&d);
    let signer = p.listing.signer(&domain)?;
    // What needs no chain first, then the reads that turn a forged listing away soonest, so one costs a single read.
    p.check(&domain, signer)?;
    let key = identity_key(chain, &p.listing.agent_id).await.map_err(Refused::Unread)?;
    let contributor = key;
    // The identity's wallet signed it itself, as the chain requires when a claim shows it (R2.14,
    // `Listings.signedFor`): a key the wallet granted signs no listing (issue #184).
    if signer != key {
        return Err(Refused::Rule("the listing isn't signed by its contributor's own key: a key its wallet granted signs no listing".into()));
    }
    let root_block = chain::root_block(chain, p.root).await.map_err(Refused::Unread)?;
    if root_block == 0 {
        return Err(Refused::Rule("the listing is in no posted root".into()));
    }
    let entry = chain::entry_by_hash(chain, p.listing.entry()).await.map_err(Refused::Unread)?;
    let credited = match entry {
        None => false,
        Some((by, entry)) => {
            if by != contributor {
                return Err(Refused::Rule("the body's entry is credited to another contributor's listing".into()));
            }
            if !entry.live {
                return Err(Refused::Rule("the entry is delisted".into()));
            }
            let site = if p.listing.is_skill() { FixedBytes::ZERO } else { chain::domain_hash(&p.listing.site) };
            if entry.domain_hash != site {
                return Err(Refused::Rule("the entry is for another site".into()));
            }
            true
        }
    };
    if !credited {
        sut_reachable!("a listing no claim has shown yet was read and kept", &serde_json::json!({ "content": p.listing.content_id }));
    }
    let (fee, fee_units) = price(chain, contributor, &p.listing).await.map_err(Refused::Unread)?;
    Ok(Verified { proven: p.clone(), contributor, fee, fee_units, root_block, credited })
}

/// How long a lookup's chain check of one listing stands when it found an answer (kept, or refused by a rule): long
/// enough that searching again and again reads the chain once for the same listings, short enough that a listing a
/// claim has since credited, delisted or repriced reads as it is now soon after. A check whose read went unanswered is
/// never kept: it said nothing about the listing, so a failing RPC can't leave an honest listing out of lookups past
/// the failure. Paying for a use checks afresh (`share::listing_of`), never from here.
const CHECK_FRESH: std::time::Duration = std::time::Duration::from_secs(30);
/// Checks remembered, at most.
const CHECKS_REMEMBERED: usize = 4096;
/// Chain-backed checks of listings that lookups read, node-wide: at most this many at once, and a burst of two whole
/// lookups' worth, then four a second. Each costs a few RPC reads, and peers choose what a lookup reads: past this a
/// listing is left out of that lookup, never kept unchecked.
const CHECKS_AT_ONCE: usize = 8;
const CHECK_BURST: f64 = 2.0 * MAX_CHECKED as f64;
const CHECKS_PER_SECOND: f64 = 4.0;

/// The chain checks lookups make (`verify_found`): what each found lately, by the listing exactly as it was signed and
/// proved, and the node's allowance for more. Only a listing that passed every check needing no chain gets here
/// (`checked_found`), so the lookup's own bounds and its turns by provider still come first.
pub struct ChainChecks {
    fresh: std::time::Duration,
    burst: f64,
    per_second: f64,
    done: std::sync::Mutex<std::collections::HashMap<FixedBytes<32>, (std::time::Instant, Result<Verified, String>)>>,
    allowance: std::sync::Mutex<Option<(f64, std::time::Instant)>>,
    at_once: tokio::sync::Semaphore,
}

impl ChainChecks {
    pub fn new(fresh: std::time::Duration, at_once: usize, burst: f64, per_second: f64) -> ChainChecks {
        ChainChecks {
            fresh,
            burst,
            per_second,
            done: Default::default(),
            allowance: std::sync::Mutex::new(None),
            at_once: tokio::sync::Semaphore::new(at_once),
        }
    }

    /// What checking the listing `key` names found, when it is fresh.
    fn found(&self, key: FixedBytes<32>, now: std::time::Instant) -> Option<Result<Verified, String>> {
        let done = self.done.locked();
        let (at, found) = done.get(&key)?;
        (now.saturating_duration_since(*at) < self.fresh).then(|| found.clone())
    }

    /// Takes one check from the allowance, if it has one.
    fn spend(&self, now: std::time::Instant) -> bool {
        let mut a = self.allowance.locked();
        let (left, at) = a.unwrap_or((self.burst, now));
        let left = (left + now.saturating_duration_since(at).as_secs_f64() * self.per_second).min(self.burst);
        if left < 1.0 {
            *a = Some((left, now));
            return false;
        }
        *a = Some((left - 1.0, now));
        true
    }

    fn keep(&self, key: FixedBytes<32>, found: Result<Verified, String>, now: std::time::Instant) {
        let mut done = self.done.locked();
        if !done.contains_key(&key) && done.len() >= CHECKS_REMEMBERED {
            let fresh = self.fresh;
            done.retain(|_, (at, _)| now.saturating_duration_since(*at) < fresh);
            if done.len() >= CHECKS_REMEMBERED {
                return;
            }
        }
        done.insert(key, (now, found));
    }

    /// The listing `key` names, checked by `run` unless a check of it is fresh. A new check waits for a place among
    /// those at once and needs the allowance; with none left the listing is left out, and that is not remembered. What
    /// the check found is remembered only if it answered (kept, or refused by a rule): one whose read failed is checked
    /// again by the next lookup that finds the listing, within the allowance.
    pub async fn check<F, Fut>(&self, key: FixedBytes<32>, run: F) -> Result<Verified, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Verified, Refused>>,
    {
        if let Some(found) = self.found(key, std::time::Instant::now()) {
            return found;
        }
        let _place = self.at_once.acquire().await.map_err(|e| e.to_string())?;
        // Another lookup may have checked it while this one waited.
        if let Some(found) = self.found(key, std::time::Instant::now()) {
            return found;
        }
        if !self.spend(std::time::Instant::now()) {
            return Err("the node has checked as many listings against the chain as it may for now".into());
        }
        let found = match run().await {
            Err(Refused::Unread(said)) => return Err(said),
            found => found.map_err(Refused::said),
        };
        self.keep(key, found.clone(), std::time::Instant::now());
        found
    }
}

/// The node's chain checks for lookups.
static CHAIN_CHECKS: std::sync::LazyLock<ChainChecks> =
    std::sync::LazyLock::new(|| ChainChecks::new(CHECK_FRESH, CHECKS_AT_ONCE, CHECK_BURST, CHECKS_PER_SECOND));

/// What names a listing for `ChainChecks`: the deployment it is checked against and the listing, signature, root and
/// proof exactly as sent, so no two listings that could check differently share one.
pub fn check_key(domain: &Eip712Domain, p: &Proven) -> FixedBytes<32> {
    let mut bytes = domain.separator().to_vec();
    bytes.extend(serde_json::to_vec(p).unwrap_or_default());
    keccak256(bytes)
}

/// [`verify`] for a listing a lookup read from peers, through the node's `ChainChecks`: a listing checked lately is
/// answered from that check, accepted or refused by a rule, and new checks share one node-wide bound.
pub async fn verify_found(chain: &chain::Chain, p: Proven) -> Result<Verified, String> {
    let key = check_key(&chain::domain(&chain.deployed()?), &p);
    CHAIN_CHECKS.check(key, || async move { judge(chain, &p).await }).await
}

/// Listings one lookup keeps, at most: counted over those that check, so a listing that doesn't takes no place.
pub const MAX_FOUND: usize = 64;
/// Listings one lookup checks against the chain, at most. The network hands them over every provider's first before
/// any provider's second (`unbrowse_net::Found`), so a provider that sends junk spends its own share of these.
pub const MAX_CHECKED: usize = 2 * MAX_FOUND;

/// Of the listings a lookup found for `site`, those that `check` (normally [`verify`]) passes, at most `MAX_FOUND`.
/// What needs no chain goes first and costs no check: a listing filed under another site or entry than its own, whose
/// signature doesn't recover, or whose leaf isn't under the root it names, is dropped as it is read. The rest are
/// checked in the order given, at most `MAX_CHECKED`. A listing is kept once, by its entry, signer and words, and only
/// a copy that checked has it kept: a forged copy that arrives first never stands in for a true one after it.
pub async fn checked_found<F, Fut>(found: Vec<unbrowse_net::Listing>, site: &str, domain: &Eip712Domain, mut check: F) -> Vec<Verified>
where
    F: FnMut(Proven) -> Fut,
    Fut: std::future::Future<Output = Result<Verified, String>>,
{
    let mut out = Vec::new();
    let mut kept = std::collections::HashSet::new();
    let mut checked = 0;
    for l in found {
        if out.len() >= MAX_FOUND || checked >= MAX_CHECKED {
            break;
        }
        let Some(p) = l.signed.and_then(|v| serde_json::from_value::<Proven>(v).ok()) else { continue };
        // The listing must be for the entry and site the answer files it under.
        if unbrowse_net::site_of(&p.listing.site).as_deref() != Some(site) || format!("{:#x}", p.listing.entry()) != l.entry_id.to_lowercase() {
            continue;
        }
        let Ok(signer) = p.listing.signer(domain) else { continue };
        if p.check(domain, signer).is_err() {
            continue;
        }
        let key = (p.listing.entry(), signer, p.listing.terms.description.clone());
        if kept.contains(&key) {
            continue;
        }
        checked += 1;
        if let Ok(v) = check(p).await {
            kept.insert(key);
            out.push(v);
        }
    }
    out
}

/// What a use of `listing` by `contributor` pays: the contributor's fee on the chain (`feeOf`), never under the price
/// the listing lists (R6.29). A wallet that lists with no gas never set a fee, so its listed price is the price; one
/// that lowers its fee below the listed price still lists that price, and a use at it is a check.
pub async fn price(chain: &chain::Chain, contributor: Address, listing: &SignedListing) -> Result<(f64, alloy::primitives::U256), String> {
    let d = chain.deployed()?;
    let fee = chain::fee_of_wallet(chain, contributor).await?;
    let units = fee.max(listing.terms.price.units().unwrap_or_default());
    Ok((d.usdc_f(units), units))
}

// ---- this node's own listings ----

/// One listing this node signed, with the root it was posted under once it is. A listing under an identity whose key
/// the node doesn't hold is kept with no signature until the owner's wallet signs it (`sign_waiting`): its leaf is
/// already its own, since the digest leaves the signature out, and it goes under no root before it is signed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Kept {
    pub listing: SignedListing,
    pub leaf: FixedBytes<32>,
    #[serde(default)]
    pub root: Option<FixedBytes<32>>,
}

impl Kept {
    /// Whether it carries its signature yet.
    pub fn signed(&self) -> bool {
        !self.listing.sig.is_empty()
    }
}

/// A root this node posted, with its leaf list.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Posted {
    pub root: FixedBytes<32>,
    pub leaves: Vec<FixedBytes<32>>,
    pub block: u64,
    pub tx: String,
}

/// This node's listings and the roots it posted for them, for one deployment of Settlement.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Book {
    pub listings: Vec<Kept>,
    pub roots: Vec<Posted>,
}

/// Listings are signed under one deployment's domain, so each deployment has its own book: a devnet made afresh, or
/// another network, starts with none.
fn book_path(d: &chain::Deployment) -> std::path::PathBuf {
    store::home().join(format!("listings-{}-{:#x}.json", d.chain_id, d.settlement))
}

/// Held while the book is read and written back.
static BOOK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The bodies this node lists under any deployment it keeps a book for. Bodies live in one store per home whatever the
/// chain, so a node moved to another network still serves, and still pins, what it lists on the one it left.
pub fn listed_bodies() -> std::collections::HashSet<String> {
    let Ok(files) = std::fs::read_dir(store::home()) else { return Default::default() };
    files
        .flatten()
        .filter(|f| f.file_name().to_string_lossy().starts_with("listings-"))
        .flat_map(|f| store::read_json::<Book>(&f.path(), &unbrowse_files::LISTINGS).listings)
        .map(|k| k.listing.content_id)
        .collect()
}

pub fn load_book(chain: &chain::Chain) -> Book {
    chain.deployed().map(|d| store::read_json(&book_path(&d), &unbrowse_files::LISTINGS)).unwrap_or_default()
}

/// Writes `book` as this node's for the chain's deployment, as `publish` leaves it: a test that needs listings of the
/// node's own without posting them.
#[cfg(test)]
pub(crate) fn keep_book(chain: &chain::Chain, book: &Book) {
    store::write_json(&book_path(&chain.deployed().unwrap()), &unbrowse_files::LISTINGS, book).unwrap();
}

impl Book {
    /// The version a listing of `content_id` for `route_id` takes, and the one it supersedes: the next after this
    /// node's latest for the route, or `None` when the latest already lists that very body. Listing goes by identity
    /// (`next_listing`, `latest_as`); this reads a book of one identity whole.
    #[cfg(test)]
    pub fn next_version(&self, route_id: &str, content_id: &str) -> Option<(u64, Option<String>)> {
        next_after(self.latest(route_id), content_id, 1)
    }

    /// The newest version this node signed, or keeps for the owner's wallet to sign, for a route under identity
    /// `agent_id`: a node that came to list under its owner's wallet starts that identity's versions afresh.
    pub fn latest_as(&self, route_id: &str, agent_id: &str) -> Option<&Kept> {
        self.listings.iter().filter(|k| k.listing.route_id == route_id && k.listing.agent_id == agent_id).max_by_key(|k| k.listing.version)
    }

    /// The newest version this node signed for a route.
    pub fn latest(&self, route_id: &str) -> Option<&Kept> {
        self.listings.iter().filter(|k| k.listing.route_id == route_id).max_by_key(|k| k.listing.version)
    }

    /// The newest version of each route, once its root is posted: what the node serves.
    pub fn current(&self) -> Vec<Proven> {
        let mut routes: Vec<&str> = self.listings.iter().map(|k| k.listing.route_id.as_str()).collect();
        routes.sort();
        routes.dedup();
        routes.into_iter().filter_map(|r| self.proven(self.latest(r)?)).collect()
    }

    /// Every listing of this node's own once its root is posted, superseded or not: a body an older version listed is
    /// still paid under its entry, and a copy of it is still a copy (`contest`).
    pub fn every_proven(&self) -> Vec<Proven> {
        self.listings.iter().filter_map(|k| self.proven(k)).collect()
    }

    /// A kept listing with its place and proof, from its root's leaf list.
    pub fn proven(&self, k: &Kept) -> Option<Proven> {
        if !k.signed() {
            return None;
        }
        let root = k.root?;
        let posted = self.roots.iter().find(|p| p.root == root)?;
        let at = posted.leaves.iter().position(|l| *l == k.leaf)?;
        let (r, proofs) = positional(&posted.leaves);
        (r == root).then(|| Proven { listing: k.listing.clone(), leaf: k.leaf, root, index: at as u64, proof: proofs[at].clone() })
    }

    /// The newest listing of this node's own of the body `entry` is paid under, once its root is posted.
    /// Whether this deployment's book holds a listing of `entry`, proven under a root yet or not.
    pub fn holds(&self, entry: FixedBytes<32>) -> bool {
        self.listings.iter().any(|k| k.listing.entry() == entry)
    }

    pub fn of_entry(&self, entry: FixedBytes<32>) -> Option<Proven> {
        self.listings.iter().filter(|k| k.listing.entry() == entry).filter_map(|k| self.proven(k)).max_by_key(|p| p.listing.version)
    }
}

/// Whether a listing of this node's at `mine`, in the chain's order (its root's block, its leaf's place in that root),
/// should take its body's credit from `by`, credited at `credited` (R2.18): nothing else's credit is this node's to move.
pub(crate) fn contests(by: Address, me: Address, mine: (u64, u64), credited: (u64, u64)) -> bool {
    by != Address::ZERO && by != me && mine < credited
}

/// The earliest of `held`, listings of one body at their places in the chain's order, that comes before the listing the
/// chain credits the body to at `credited` (`Listings._offer`): the one a claim carries so that the claim pays the
/// earliest listing it can show, never a later copy credited first. `None` when none comes before.
pub(crate) fn earliest_before(held: Vec<(Proven, (u64, u64))>, credited: (u64, u64)) -> Option<Proven> {
    held.into_iter().filter(|(_, at)| at.0 != 0 && (credited.0 == 0 || *at < credited)).min_by_key(|(_, at)| *at).map(|(p, _)| p)
}

/// Of the listings of `entry` this node holds, its own or read from others, the earliest that comes before the listing
/// the chain credits it to at `credited` (`earliest_before`). A listing whose root can't be read is passed over.
pub async fn earlier_held(chain: &chain::Chain, entry: FixedBytes<32>, credited: (u64, u64)) -> Option<Proven> {
    let d = chain.deployed().ok()?;
    let own = load_book(chain).every_proven().into_iter().filter(|p| p.listing.entry() == entry);
    let mut held = Vec::new();
    for p in own.chain(known_of(&d, entry)) {
        if let Ok(block) = chain::root_block(chain, p.root).await {
            let at = (block, p.index);
            held.push((p, at));
        }
    }
    earliest_before(held, credited)
}

/// Takes back the credit of every body of this node's that the chain credits to a later listing, a copy someone showed
/// first (R2.18, `Listings.correctCredit`): every listing of its own, the versions it superseded with the newest, since
/// a body an older version listed is still paid under its entry. A copy paid for a window of `CREDIT_FINAL_EPOCHS`
/// becomes final, and readers hold to the chain's credit, so nothing but this, or a claim that carries the earlier
/// listing (`chain::Claim::showing`), brings the original back. The moves it made.
/// One listing's failure is that listing's: every other is still looked at, and the failures are said together.
pub async fn contest(chain: &chain::Chain, keys: &(dyn KeyStore + Sync)) -> Result<u32, String> {
    contest_each(load_book(chain).every_proven(), |p| async move {
        let (by, block, leaf) = chain::place_of(chain, p.listing.entry()).await?;
        let me = identity_key(chain, &p.listing.agent_id).await?;
        let mine = (chain::root_block(chain, p.root).await?, p.index);
        Ok(contests(by, me, mine, (block, leaf)) && chain::correct_credit(chain, keys, &p).await?.is_some())
    })
    .await
}

/// Runs `one` on each of `listings` whatever the others came to: the credits it moved, or, once all were looked at, the
/// failures, each named by its listing, beside how many moved.
pub(crate) async fn contest_each<F, Fut>(listings: Vec<Proven>, one: F) -> Result<u32, String>
where
    F: Fn(Proven) -> Fut,
    Fut: std::future::Future<Output = Result<bool, String>>,
{
    let (mut moved, mut failed) = (0, Vec::new());
    for p in listings {
        let route = p.listing.route_id.clone();
        match one(p).await {
            Ok(true) => moved += 1,
            Ok(false) => {}
            Err(e) => failed.push(format!("{route}: {e}")),
        }
    }
    match failed.is_empty() {
        true => Ok(moved),
        false => Err(format!("{moved} credit(s) taken back; {} listing(s) couldn't be looked at: {}", failed.len(), failed.join("; "))),
    }
}

// ---- listings the owner's wallet signs ----

/// A listing waiting for the owner's wallet to sign it: this node lists under the wallet's identity and doesn't hold
/// its key (`lister`), so the wallet signs each listing itself, as it sends each grant (`owner_nodes`). The window
/// shows it in plain words, and the sign-in page has the wallet sign `typed_data`; a wallet of the owner's own signs
/// the same (`eth_signTypedData_v4`). Signing sends no transaction.
#[derive(Clone, Debug, Serialize)]
pub struct ToSign {
    /// The listing's leaf: what `sign_waiting` takes its signature by.
    pub id: String,
    pub route_id: String,
    pub site: String,
    pub description: String,
    pub version: u64,
    /// The least a use pays, in USDC, when it lists a price.
    pub price_usdc: Option<f64>,
    /// The wallet that signs it: the identity's.
    pub wallet: String,
    /// What signing it does, said plainly.
    pub what: String,
    /// The listing as EIP-712 typed data: what the wallet signs.
    pub typed_data: Value,
}

/// The listing's fields as EIP-712 types them (`typed::Listing`), in order.
const LISTING_FIELDS: [(&str, &str); 7] =
    [("routeId", "string"), ("site", "string"), ("contentId", "string"), ("agentId", "string"), ("version", "uint64"), ("supersedes", "string"), ("terms", "bytes32")];

/// `l` as the typed data a wallet signs (EIP-712, `eth_signTypedData_v4`) under deployment `d`'s domain: the digest
/// it makes is `l.digest`. The version goes as a decimal string, so no reader rounds it.
pub fn typed_data(l: &SignedListing, d: &chain::Deployment) -> Value {
    let domain = chain::domain(d);
    let field = |(name, kind): &(&str, &str)| serde_json::json!({ "name": name, "type": kind });
    let domain_fields: Vec<Value> = [("name", "string"), ("version", "string"), ("chainId", "uint256"), ("verifyingContract", "address")].iter().map(field).collect();
    let listing_fields: Vec<Value> = LISTING_FIELDS.iter().map(field).collect();
    serde_json::json!({
        "types": { "EIP712Domain": domain_fields, "Listing": listing_fields },
        "primaryType": "Listing",
        "domain": {
            "name": domain.name.as_deref(),
            "version": domain.version.as_deref(),
            "chainId": d.chain_id,
            "verifyingContract": format!("{:#x}", d.settlement),
        },
        "message": {
            "routeId": l.route_id,
            "site": l.site,
            "contentId": l.content_id,
            "agentId": l.agent_id,
            "version": l.version.to_string(),
            "supersedes": l.supersedes.clone().unwrap_or_default(),
            "terms": format!("{:#x}", l.terms_hash()),
        },
    })
}

/// What the owner is shown before signing `l`: the site and the route's words as the node keeps them, with nothing in
/// them that reads other than it shows (`owner_dialog::plain`), since an agent's words may be among them.
fn said(l: &SignedListing, price_usdc: Option<f64>, wallet: Address) -> String {
    let words: String = crate::owner_dialog::plain(&l.terms.description).replace('\n', " ").chars().take(120).collect();
    let site: String = crate::owner_dialog::plain(&l.site).replace('\n', " ").chars().take(80).collect();
    let price = price_usdc.map(|p| format!(", at {p} USDC or more a use")).unwrap_or_default();
    format!(
        "Share your route on {site}, \"{words}\"{price}, under your account. Other agents can then find it, and each use pays {wallet:#x}. Approving sends nothing and costs nothing; only you can approve it, never an agent key."
    )
}

/// The listings waiting for the owner's wallet to sign them: the newest of each route under the wallet's identity,
/// none signed yet. Empty when this node lists under no wallet but its own.
pub async fn to_sign(chain: &chain::Chain, keys: &(dyn KeyStore + Sync)) -> Result<Vec<ToSign>, String> {
    let Ok(d) = chain.deployed() else { return Ok(vec![]) };
    let Some((wallet, agent_id)) = wallet_identity(chain, keys, chain::owner_address(keys)?).await? else { return Ok(vec![]) };
    let book = load_book(chain);
    Ok(waiting_in(&book, &agent_id)
        .into_iter()
        .map(|k| {
            let l = &k.listing;
            let price_usdc = l.terms.price.units().map(|u| d.usdc_f(u));
            ToSign {
                id: format!("{:#x}", k.leaf),
                route_id: l.route_id.clone(),
                site: l.site.clone(),
                description: l.terms.description.clone(),
                version: l.version,
                price_usdc,
                wallet: wallet.to_checksum(None),
                what: said(l, price_usdc, wallet),
                typed_data: typed_data(l, &d),
            }
        })
        .collect())
}

/// The listings of `book` under `agent_id` that wait for a signature: each route's newest, when it has none. An older
/// version a newer one replaced before anyone signed it is never asked for.
fn waiting_in<'a>(book: &'a Book, agent_id: &str) -> Vec<&'a Kept> {
    let mut routes: Vec<&str> = book.listings.iter().filter(|k| !k.signed() && k.listing.agent_id == agent_id).map(|k| k.listing.route_id.as_str()).collect();
    routes.sort();
    routes.dedup();
    routes.into_iter().filter_map(|r| book.latest_as(r, agent_id)).filter(|k| !k.signed()).collect()
}

/// Whether a signature that recovers to `signer` signs a listing of the identity whose wallet is `wallet` (R2.14): only
/// the wallet's own key does. `granted` is whether `signer` is a key the wallet granted, an agent key: it only pays, up
/// to its cap (R1.20), so it never signs, and never approves, a listing (issue #184).
pub fn owner_signed(signer: Address, wallet: Address, granted: bool) -> Result<(), String> {
    match (signer == wallet, granted) {
        (true, _) => Ok(()),
        (false, true) => Err(format!("that signature is an agent key's ({signer:#x}): an agent key only pays, and can't sign or approve a listing. Sign it with your wallet {wallet:#x} itself")),
        (false, false) => Err(format!("that signature is {signer:#x}'s, not your wallet {wallet:#x}'s: only the wallet whose identity the listing names signs it")),
    }
}

/// `sig` as a listing carries it: hex with its 0x, and the recovery byte as 27 or 28, which the chain's check reads
/// (a wallet may answer 0 or 1).
fn listing_sig(sig: &str) -> Result<String, String> {
    let hex_part = sig.trim().strip_prefix("0x").unwrap_or(sig.trim());
    let mut bytes = hex::decode(hex_part).map_err(|_| "the signature isn't hex")?;
    if bytes.len() != 65 {
        return Err(format!("a signature is 65 bytes, this one {}", bytes.len()));
    }
    if bytes[64] < 27 {
        bytes[64] += 27;
    }
    Ok(format!("0x{}", hex::encode(bytes)))
}

/// Takes the owner's wallet's signature `sig` of the listing waiting under `id` (`to_sign`), and puts it under a root
/// as any listing of this node's is (`post_pending`). The signature must be the wallet's own (`owner_signed`), and the
/// node must still list under that wallet. Returns the listing as it now spreads, or `None` while it waits for a root.
pub async fn sign_waiting(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), id: &str, sig: &str) -> Result<Option<Proven>, String> {
    let d = chain.deployed()?;
    let domain = chain::domain(&d);
    let leaf: FixedBytes<32> = id.trim().parse().map_err(|_| format!("{id} isn't a listing's id"))?;
    let shared = wallet_identity(chain, keys, chain::owner_address(keys)?).await?;
    let _held = BOOK.lock().await;
    let mut book: Book = store::read_json_strict(&book_path(&d), &unbrowse_files::LISTINGS)?;
    let at = book
        .listings
        .iter()
        .position(|k| k.leaf == leaf && !k.signed())
        .ok_or_else(|| format!("no listing of this node's waits for a signature under {id}: it was signed already, or it isn't one of this node's"))?;
    let mut l = book.listings[at].listing.clone();
    if shared.as_ref().map(|(_, a)| a.as_str()) != Some(l.agent_id.as_str()) {
        return Err("this node no longer lists under the wallet whose identity that listing names, so it isn't signed".into());
    }
    l.sig = listing_sig(sig)?;
    let signer = l.signer(&domain)?;
    let wallet = identity_key(chain, &l.agent_id).await?;
    let granted = signer != wallet && chain::agent_terms(chain, wallet, signer).await?.is_some();
    owner_signed(signer, wallet, granted)?;
    book.listings[at].listing = l;
    store::write_json(&book_path(&d), &unbrowse_files::LISTINGS, &book)?;
    // Signed and kept: a root that can't be posted now is posted by the next pass (`adopt_reserve_roots`).
    post_pending(chain, keys, &mut book).await?;
    store::write_json(&book_path(&d), &unbrowse_files::LISTINGS, &book)?;
    Ok(book.proven(&book.listings[at]))
}

// ---- listings this node read from others, kept for the claims that first show them ----

/// The listings this node fetched bodies under, by entry, for one deployment: a payer's first claim of a line on an
/// entry no claim has credited yet carries the listing (`Listings.showAndClaim`, R2.18), and a payer holds the proof
/// of the listing it paid under (spec §76 item 2).
fn known_path(d: &chain::Deployment) -> std::path::PathBuf {
    store::home().join(format!("known-listings-{}-{:#x}.json", d.chain_id, d.settlement))
}

static KNOWN: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Keeps a listing this node read and checked, the newest version of its contributor's listing of its route: listings
/// of one body are one entry and only accumulate (R2.16), so each is kept beside the others of its entry.
pub fn remember(chain: &chain::Chain, p: &Proven) {
    let Ok(d) = chain.deployed() else { return };
    let _one = KNOWN.locked();
    let path = known_path(&d);
    let mut all: std::collections::BTreeMap<String, Proven> = store::read_json(&path, &unbrowse_files::KNOWN_LISTINGS);
    let key = format!("{:#x}/{}/{}", p.listing.entry(), p.listing.agent_id, p.listing.route_id);
    if all.get(&key).is_none_or(|k| k.listing.version <= p.listing.version) {
        all.insert(key, p.clone());
        let _ = store::write_json(&path, &unbrowse_files::KNOWN_LISTINGS, &all);
    }
}

/// The signed listing this node holds for `entry`: its own newest listing of the body, else one it read and kept.
pub fn held_listing(chain: &chain::Chain, entry: FixedBytes<32>) -> Option<Proven> {
    held_listing_at(&chain.deployed().ok()?, entry)
}

/// The site and words of every entry this node holds a listing of, read as `held_listing_at` reads one entry: its own
/// newest listing of the body, else the newest it read and kept.
pub fn held_names(d: &chain::Deployment) -> std::collections::HashMap<FixedBytes<32>, (String, String)> {
    let known: std::collections::BTreeMap<String, Proven> = store::read_json(&known_path(d), &unbrowse_files::KNOWN_LISTINGS);
    let book: Book = store::read_json(&book_path(d), &unbrowse_files::LISTINGS);
    let mut read: Vec<SignedListing> = known.into_values().map(|p| p.listing).collect();
    read.sort_by_key(|l| l.version);
    let mut own: Vec<SignedListing> = book.listings.into_iter().map(|k| k.listing).collect();
    own.sort_by_key(|l| l.version);
    read.into_iter().chain(own).map(|l| (l.entry(), (l.site, l.terms.description))).collect()
}

/// Every listing of `entry` this node read and kept, whoever's.
pub fn known_of(d: &chain::Deployment, entry: FixedBytes<32>) -> Vec<Proven> {
    let all: std::collections::BTreeMap<String, Proven> = store::read_json(&known_path(d), &unbrowse_files::KNOWN_LISTINGS);
    all.into_values().filter(|p| p.listing.entry() == entry).collect()
}

/// `held_listing`, for the deployment `d`.
pub fn held_listing_at(d: &chain::Deployment, entry: FixedBytes<32>) -> Option<Proven> {
    let book: Book = store::read_json(&book_path(d), &unbrowse_files::LISTINGS);
    book.of_entry(entry).or_else(|| {
        let all: std::collections::BTreeMap<String, Proven> = store::read_json(&known_path(d), &unbrowse_files::KNOWN_LISTINGS);
        all.into_values().filter(|p| p.listing.entry() == entry).max_by_key(|p| p.listing.version)
    })
}

/// Signs a listing of `recipe` for `route_id` (a new version when the route's body changed, R2.6) and keeps its body to
/// serve, writing nothing to the chain for it (R2.15). A root holding it is posted before anything spreads it: by this
/// node (R2.19), or, when it sends its leaves to the reserve's poster (`reserve::endpoint`), by the poster at its next
/// root (R2.20), and until then the listing waits, unspread. Listing the same body again changes nothing. Returns the
/// listing as it now spreads, or `None` while it waits for the reserve's root. `fee` prices it when the wallet has set
/// no fee on the chain, as a wallet that lists with no gas hasn't.
pub async fn publish(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), name: &str, route_id: &str, description: &str, recipe: &Recipe, fee: f64) -> Result<Option<Proven>, String> {
    publish_as(chain, keys, name, route_id, description, recipe, fee, false).await
}

/// `publish`, for a route its owner delisted and lists again: even the same body takes a new version. A node that
/// heard the withdrawal holds the version withdrawn, and only a later one tells it the listing is back (R2.16).
pub async fn republish(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), name: &str, route_id: &str, description: &str, recipe: &Recipe, fee: f64) -> Result<Option<Proven>, String> {
    publish_as(chain, keys, name, route_id, description, recipe, fee, true).await
}

/// The version after `latest` for `content_id`, and the one it supersedes: `first` when there is none, `None` when
/// `latest` already lists that very body.
fn next_after(latest: Option<&Kept>, content_id: &str, first: u64) -> Option<(u64, Option<String>)> {
    match latest {
        Some(k) if k.listing.content_id == content_id => None,
        Some(k) => Some((k.listing.version + 1, Some(k.listing.content_id.clone()))),
        None => Some((first, None)),
    }
}

/// The version a listing of `content_id` on `terms` takes for `route_id` under identity `agent_id`, and the one it
/// supersedes, or `None` when the latest already says all of it. `again` is a listing withdrawn and now put back;
/// `first` is where the node's versions of the route start under that identity (`first_version`).
fn next_listing(book: &Book, route_id: &str, content_id: &str, terms: &Terms, again: bool, agent_id: &str, first: u64) -> Option<(u64, Option<String>)> {
    let latest = book.latest_as(route_id, agent_id);
    next_after(latest, content_id, first).or_else(|| {
        let k = latest?;
        // The same body on terms that changed (a listing from before listed no price) is listed again as a new version.
        (again || k.listing.terms != *terms).then(|| (k.listing.version + 1, Some(k.listing.content_id.clone())))
    })
}

#[allow(clippy::too_many_arguments)] // Two callers, each `publish`'s own arguments and whether it lists again.
async fn publish_as(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), name: &str, route_id: &str, description: &str, recipe: &Recipe, fee: f64, again: bool) -> Result<Option<Proven>, String> {
    let d = chain.deployed()?;
    let domain = chain::domain(&d);
    let bytes = recipe::canonical(recipe);
    let content_id = recipe::save_body(&bytes)?;
    // A recipe calls a site, so it lists as a route, naming its site, never as a skill (a listing with no site): a
    // skill that calls a site is fraud (R6.15 (c), spec §76.2 item 7).
    if recipe.site.trim().is_empty() {
        return Err("a recipe calls a site, so it lists as a route naming that site, never as a skill".into());
    }
    let who = lister(chain, keys, name).await?;
    let agent_id = who.agent_id.clone();
    // The listed price: the least a use pays and what a check is held to (R6.29). The fee on the chain when the wallet
    // set one, else `fee`: a wallet that sends no transaction prices its routes in its listings alone.
    let on_chain = d.usdc_f(chain::fee_of_wallet(chain, who.wallet).await?);
    let fee = if on_chain > 0.0 { on_chain } else { fee };
    let price = if fee > 0.0 { Price::listed(d.fee_units(fee)) } else { Price::default() };
    let terms = Terms { description: description.into(), response: bounded_shape(recipe.response.clone()), price };
    let first = first_version(chain::owner_address(keys)?, who.key.is_none());
    let _held = BOOK.lock().await;
    let mut book: Book = store::read_json_strict(&book_path(&d), &unbrowse_files::LISTINGS)?;
    if let Some((version, supersedes)) = next_listing(&book, route_id, &content_id, &terms, again, &agent_id, first) {
        let listing = SignedListing {
            route_id: route_id.into(),
            site: recipe.site.clone(),
            content_id,
            agent_id,
            version,
            supersedes,
            terms,
            sig: String::new(),
        };
        // Signed now by the identity's own key when this node holds it; else kept for the owner's wallet to sign
        // (`to_sign`), and spread nowhere until it has.
        let listing = match &who.key {
            Some(key) => listing.signed(key, &domain)?,
            None => listing,
        };
        let leaf = listing.leaf(&domain);
        book.listings.push(Kept { listing, leaf, root: None });
        store::write_json(&book_path(&d), &unbrowse_files::LISTINGS, &book)?;
    }
    post_pending(chain, keys, &mut book).await?;
    store::write_json(&book_path(&d), &unbrowse_files::LISTINGS, &book)?;
    let latest = book.latest(route_id).ok_or("the listing wasn't kept")?;
    Ok(book.proven(latest))
}

/// Puts every listing not yet under a posted root under one: sends their leaves to the reserve's poster when this node
/// uses it, and takes any root it has posted holding them; else posts one root over them itself and records it with its
/// leaf list. A post that failed before is made again here, with whatever was signed since.
async fn post_pending(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), book: &mut Book) -> Result<(), String> {
    let leaves: Vec<FixedBytes<32>> = book.listings.iter().filter(|k| k.root.is_none() && k.signed()).map(|k| k.leaf).collect();
    if leaves.is_empty() {
        return Ok(());
    }
    if let Some(at) = crate::reserve::endpoint() {
        crate::reserve::send(chain, keys, &at, &leaves).await?;
        adopt(chain, book, &crate::reserve::fetch_roots(&at, 0).await?).await;
        return Ok(());
    }
    let (root, _) = positional(&leaves);
    let (tx, block) = chain::post_root(chain, keys, root).await?;
    for k in book.listings.iter_mut().filter(|k| k.root.is_none() && leaves.contains(&k.leaf)) {
        k.root = Some(root);
    }
    book.roots.push(Posted { root, leaves, block, tx });
    Ok(())
}

/// Takes, from `roots` someone else posted, each one holding a listing of the book's that has no root yet: its leaf
/// list makes the root it names, and the chain has it posted. Returns the listings it put under a root.
async fn adopt(chain: &chain::Chain, book: &mut Book, roots: &[Posted]) -> Vec<FixedBytes<32>> {
    let mut placed = Vec::new();
    for r in roots {
        if !book.listings.iter().any(|k| k.root.is_none() && k.signed() && r.leaves.contains(&k.leaf)) || positional(&r.leaves).0 != r.root {
            continue;
        }
        let Ok(block) = chain::root_block(chain, r.root).await else { continue };
        if block == 0 {
            continue;
        }
        for k in book.listings.iter_mut().filter(|k| k.root.is_none() && k.signed() && r.leaves.contains(&k.leaf)) {
            k.root = Some(r.root);
            placed.push(k.leaf);
        }
        if !book.roots.iter().any(|p| p.root == r.root) {
            book.roots.push(Posted { root: r.root, leaves: r.leaves.clone(), block, tx: r.tx.clone() });
        }
    }
    placed
}

/// The roots that now hold this node's listings waiting for one: each such listing is recorded under its root and
/// returned, ready to spread (`reserve::tick`). A listing can outlive its poster: sent to one that has since gone, it
/// would wait for good, shown as listed and spread by no one. With no poster left the node posts its own root
/// (`post_pending`), as it would have from the start (R2.19).
pub async fn adopt_reserve_roots(chain: &chain::Chain, keys: &(dyn KeyStore + Sync)) -> Result<Vec<Proven>, String> {
    let Ok(d) = chain.deployed() else { return Ok(vec![]) };
    let _held = BOOK.lock().await;
    let mut book: Book = store::read_json_strict(&book_path(&d), &unbrowse_files::LISTINGS)?;
    let waiting: Vec<FixedBytes<32>> = book.listings.iter().filter(|k| k.root.is_none() && k.signed()).map(|k| k.leaf).collect();
    if waiting.is_empty() {
        return Ok(vec![]);
    }
    let Some(at) = crate::reserve::endpoint() else {
        post_pending(chain, keys, &mut book).await?;
        store::write_json(&book_path(&d), &unbrowse_files::LISTINGS, &book)?;
        return Ok(book.listings.iter().filter(|k| waiting.contains(&k.leaf)).filter_map(|k| book.proven(k)).collect());
    };
    // A leaf the poster lost (a restart before it posted) is sent again: the poster takes each once.
    crate::reserve::send(chain, keys, &at, &waiting).await?;
    let placed = adopt(chain, &mut book, &crate::reserve::fetch_roots(&at, 0).await?).await;
    store::write_json(&book_path(&d), &unbrowse_files::LISTINGS, &book)?;
    Ok(book.listings.iter().filter(|k| placed.contains(&k.leaf)).filter_map(|k| book.proven(k)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A node moves a credit only off someone else, and only from a listing the chain orders first (R2.18).
    #[test]
    fn a_node_contests_only_a_later_listing_of_someone_else() {
        let (me, them) = (Address::repeat_byte(1), Address::repeat_byte(2));
        assert!(contests(them, me, (10, 4), (11, 0)), "an earlier root");
        assert!(contests(them, me, (10, 1), (10, 2)), "one root, an earlier leaf");
        assert!(!contests(them, me, (10, 2), (10, 2)), "the same place");
        assert!(!contests(them, me, (11, 0), (10, 9)), "a later root: this listing is the copy");
        assert!(!contests(me, me, (10, 0), (11, 0)), "its own credit");
        assert!(!contests(Address::ZERO, me, (10, 0), (0, 0)), "no credit yet: its first claim credits it");
    }

    /// A listing whose credit can't be read, or can't be taken back, stops nothing: every other listing of the book is
    /// still contested before a copy's credit goes final.
    #[tokio::test]
    async fn a_failed_contest_does_not_stop_the_next() {
        let proven = |route: &str| Proven {
            listing: SignedListing {
                route_id: route.into(),
                site: "shop.example".into(),
                content_id: String::new(),
                agent_id: String::new(),
                version: 1,
                supersedes: None,
                terms: Terms { description: String::new(), response: None, price: Price::default() },
                sig: String::new(),
            },
            leaf: FixedBytes::ZERO,
            root: FixedBytes::ZERO,
            index: 0,
            proof: vec![],
        };
        let looked = std::sync::Mutex::new(Vec::new());
        let r = contest_each(vec![proven("broken"), proven("copied"), proven("own")], |p| {
            looked.lock().unwrap().push(p.listing.route_id.clone());
            async move {
                match p.listing.route_id.as_str() {
                    "broken" => Err("its identity doesn't read".to_string()),
                    "copied" => Ok(true),
                    _ => Ok(false),
                }
            }
        })
        .await;
        assert_eq!(*looked.lock().unwrap(), vec!["broken", "copied", "own"], "every listing was looked at");
        let e = r.unwrap_err();
        assert!(e.starts_with("1 credit(s) taken back") && e.contains("broken"), "{e}");
    }

    /// A line pays whoever the chain credits its body to when it is claimed, so a claim on a body a later copy was
    /// credited first carries the earliest listing the claimant holds that the chain orders before the copy, and the
    /// claim moves the credit back as it pays (R2.18). A listing at or after the credited place, or in no posted root,
    /// is never carried.
    #[test]
    fn a_claim_on_a_body_a_later_copy_holds_carries_the_earlier_listing() {
        let d = domain(31337, Address::repeat_byte(0x11));
        let at = |v: u64| proven_alone(listing(v), &d);
        let copy = (12, 0);
        let held = vec![(at(1), (10, 3)), (at(2), (10, 1)), (at(3), (13, 0)), (at(4), (0, 0))];
        assert_eq!(earliest_before(held.clone(), copy).map(|p| p.listing.version), Some(2), "the earliest held before the copy");
        assert_eq!(earliest_before(vec![(at(1), (12, 0))], copy).map(|p| p.listing.version), None, "the credited listing itself");
        assert_eq!(earliest_before(vec![(at(1), (12, 4))], copy).map(|p| p.listing.version), None, "a later leaf of the same root");
        assert_eq!(earliest_before(vec![(at(1), (12, 4))], (12, 7)).map(|p| p.listing.version), Some(1), "an earlier leaf of one root");
        assert_eq!(earliest_before(vec![(at(4), (0, 0))], copy).map(|p| p.listing.version), None, "in no posted root");
        assert_eq!(earliest_before(Vec::new(), copy).map(|p| p.listing.version), None);
    }

    /// The node contests a copy of every body it listed, not only each route's newest version: a superseded version's
    /// body is still paid under its own entry, and a copy of it credited first would go final unwatched.
    #[test]
    fn every_listing_of_its_own_is_contested_not_only_the_newest() {
        let key = PrivateKeySigner::random();
        let d = domain(31337, Address::repeat_byte(0x11));
        let mut book = Book::default();
        for v in 1..=2u64 {
            let mut l = listing(v);
            l.content_id = format!("sha256:{v:064x}");
            let l = l.signed(&key, &d).unwrap();
            let leaf = l.leaf(&d);
            book.listings.push(Kept { listing: l, leaf, root: None });
        }
        let leaves: Vec<_> = book.listings.iter().map(|k| k.leaf).collect();
        let (root, _) = positional(&leaves);
        book.listings.iter_mut().for_each(|k| k.root = Some(root));
        book.roots.push(Posted { root, leaves, block: 9, tx: "0x".into() });
        assert_eq!(book.current().len(), 1, "one route, served at its newest version");
        let contested: Vec<u64> = book.every_proven().iter().map(|p| p.listing.version).collect();
        assert_eq!(contested, vec![1, 2], "both bodies are watched for copies");
    }

    /// What a lookup keeps is bounded over listings that check, never over what peers sent: listings that don't
    /// read cost no check, forged ones each cost one and take no place, and a forged copy of a true listing sent first
    /// (its signature real, under a root nobody posted) doesn't stand in for the true one after it.
    #[tokio::test]
    async fn a_lookups_bound_counts_only_listings_that_check() {
        let d = domain(31337, Address::repeat_byte(0x11));
        let honest_key = PrivateKeySigner::random();
        let honest = proven_alone(listing(1).signed(&honest_key, &d).unwrap(), &d);
        // The same signed listing under a root of the forger's own making.
        let (forged_root, proofs) = positional(&[honest.leaf, FixedBytes::repeat_byte(7)]);
        let forged = Proven { root: forged_root, index: 0, proof: proofs[0].clone(), ..honest.clone() };
        let on_wire = |p: &Proven| unbrowse_net::Listing {
            entry_id: format!("{:#x}", p.listing.entry()),
            site: p.listing.site.clone(),
            description: p.listing.terms.description.clone(),
            contributor: "0xh".into(),
            fee: 0.0,
            signed: Some(serde_json::to_value(p).unwrap()),
        };
        let unreadable = |n: usize| {
            let mut p = honest.clone();
            p.listing.sig = format!("0x{}", "00".repeat(65 + n % 3));
            on_wire(&p)
        };
        // Signed by keys of no identity, each under a root of its own: they read, and only the chain turns them away.
        let strangers: Vec<_> = (0..MAX_CHECKED - 2).map(|n| on_wire(&proven_alone(listing(2 + n as u64).signed(&PrivateKeySigner::random(), &d).unwrap(), &d))).collect();
        let mut found = vec![on_wire(&forged)];
        found.extend((0..500).map(unreadable));
        found.extend(strangers);
        found.push(on_wire(&honest));
        let (posted, dr) = (honest.root, &d);
        let checks = std::sync::atomic::AtomicUsize::new(0);
        let check = |p: Proven| {
            checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                if p.root != posted {
                    return Err("the listing is in no posted root".to_string());
                }
                let contributor = p.listing.signer(dr).unwrap();
                Ok(Verified { proven: p, contributor, fee: 0.0, fee_units: alloy::primitives::U256::ZERO, root_block: 1, credited: false })
            }
        };
        let kept = checked_found(found, "shop.example", &d, check).await;
        assert_eq!(kept.len(), 1, "the true listing is kept");
        assert_eq!(kept[0].proven, honest);
        assert_eq!(checks.load(std::sync::atomic::Ordering::SeqCst), MAX_CHECKED, "the forged and the strangers' each cost one check; the unreadable none");

        // Past what it keeps, a lookup stops: every listing here checks.
        let many: Vec<_> = (0..MAX_FOUND + 10).map(|_| on_wire(&proven_alone(listing(1).signed(&PrivateKeySigner::random(), &d).unwrap(), &d))).collect();
        let all = |p: Proven| async move {
            let contributor = p.listing.signer(dr).unwrap();
            Ok(Verified { proven: p, contributor, fee: 0.0, fee_units: alloy::primitives::U256::ZERO, root_block: 1, credited: false })
        };
        assert_eq!(checked_found(many, "shop.example", &d, all).await.len(), MAX_FOUND);
    }

    /// Listings that pass every check needing no chain and that the chain turns away cost one chain check each, once:
    /// a lookup that finds them again while the check stands reads nothing, whatever the check found, and once it is
    /// old they are read again.
    #[tokio::test]
    async fn a_repeated_lookup_of_failing_listings_reads_the_chain_once() {
        let d = domain(31337, Address::repeat_byte(0x11));
        let checks = ChainChecks::new(CHECK_FRESH, CHECKS_AT_ONCE, 1e9, 1e9);
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let strangers: Vec<Proven> = (0..MAX_CHECKED).map(|n| proven_alone(listing(2 + n as u64).signed(&PrivateKeySigner::random(), &d).unwrap(), &d)).collect();
        let lookup = || {
            let found = strangers.iter().map(on_wire).collect();
            checked_found(found, "shop.example", &d, |p: Proven| {
                let key = check_key(&d, &p);
                checks.check(key, || async {
                    reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err::<Verified, _>(Refused::Rule("the listing is in no posted root".to_string()))
                })
            })
        };
        assert!(lookup().await.is_empty());
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), MAX_CHECKED, "each costs one check");
        for _ in 0..5 {
            assert!(lookup().await.is_empty(), "still refused");
        }
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), MAX_CHECKED, "searching again reads nothing while the check stands");
        // A listing changed in any part (here its proof's root) is another listing, and is checked.
        let mut other = strangers[0].clone();
        other.index = 1;
        assert_ne!(check_key(&d, &other), check_key(&d, &strangers[0]));
        assert_ne!(check_key(&domain(1, Address::repeat_byte(0x11)), &strangers[0]), check_key(&d, &strangers[0]), "another deployment's check is its own");
        // The window passes.
        for (at, _) in checks.done.locked().values_mut() {
            *at -= CHECK_FRESH;
        }
        assert!(lookup().await.is_empty());
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 2 * MAX_CHECKED, "once old, read again");
    }

    /// Lookups at once share one bound on chain checks: never more running than CHECKS_AT_ONCE, never more in all
    /// than the allowance; a listing past it is left out (not kept unchecked) and is checked by a later lookup.
    #[tokio::test]
    async fn concurrent_lookups_stay_within_the_chain_check_budget() {
        let d = domain(31337, Address::repeat_byte(0x11));
        let burst = 50.0;
        let checks = ChainChecks::new(CHECK_FRESH, CHECKS_AT_ONCE, burst, 0.0);
        let (running, most, reads) = (std::sync::atomic::AtomicUsize::new(0), std::sync::atomic::AtomicUsize::new(0), std::sync::atomic::AtomicUsize::new(0));
        let run = || async {
            let now = running.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            most.fetch_max(now, std::sync::atomic::Ordering::SeqCst);
            reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            running.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            Err::<Verified, _>(Refused::Rule("the entry is delisted".to_string()))
        };
        let lookups = (0..16).map(|_| {
            let found: Vec<_> = (0..20).map(|n| on_wire(&proven_alone(listing(2 + n).signed(&PrivateKeySigner::random(), &d).unwrap(), &d))).collect();
            let (checks, d, run) = (&checks, &d, &run);
            async move { checked_found(found, "shop.example", d, |p: Proven| checks.check(check_key(d, &p), run)).await }
        });
        let kept = futures_util::future::join_all(lookups).await;
        assert!(kept.iter().all(Vec::is_empty));
        assert!(most.load(std::sync::atomic::Ordering::SeqCst) <= CHECKS_AT_ONCE, "at most {CHECKS_AT_ONCE} at once");
        assert!(most.load(std::sync::atomic::Ordering::SeqCst) > 1, "lookups do run together");
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), burst as usize, "never past the allowance");
        // A listing left out for want of allowance was not remembered as refused: it is checked once there is some.
        let key = check_key(&d, &proven_alone(listing(1).signed(&PrivateKeySigner::random(), &d).unwrap(), &d));
        assert!(checks.check(key, run).await.unwrap_err().contains("as many listings"));
        *checks.allowance.locked() = None;
        assert!(checks.check(key, run).await.unwrap_err().contains("delisted"));
    }

    /// A chain check whose read failed to answer is never remembered: the next lookup that finds the listing checks it
    /// again (within the allowance), so an honest listing checked while the RPC failed is kept once it answers. A
    /// refusal a rule made is remembered for the window, as an acceptance is.
    #[tokio::test]
    async fn a_failed_chain_read_is_not_remembered_but_a_rules_refusal_is() {
        let d = domain(31337, Address::repeat_byte(0x11));
        let checks = ChainChecks::new(CHECK_FRESH, CHECKS_AT_ONCE, 1e9, 1e9);
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let honest = proven_alone(listing(1).signed(&PrivateKeySigner::random(), &d).unwrap(), &d);
        let key = check_key(&d, &honest);
        let rpc_up = std::sync::atomic::AtomicBool::new(false);
        let run = || async {
            reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if !rpc_up.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(Refused::Unread("error sending request: connection reset".into()));
            }
            let contributor = honest.listing.signer(&d).unwrap();
            Ok(Verified { proven: honest.clone(), contributor, fee: 0.0, fee_units: alloy::primitives::U256::ZERO, root_block: 1, credited: false })
        };
        assert!(checks.check(key, run).await.unwrap_err().contains("connection reset"));
        assert!(checks.check(key, run).await.is_err(), "still failing");
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 2, "a failed read is read again, not answered from memory");
        assert!(checks.done.locked().is_empty(), "nothing remembered");
        rpc_up.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(checks.check(key, run).await.is_ok(), "kept as soon as the chain answers");
        assert!(checks.check(key, run).await.is_ok());
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 3, "an acceptance is remembered");

        // A rule's refusal stands for the window.
        let refused = proven_alone(listing(2).signed(&PrivateKeySigner::random(), &d).unwrap(), &d);
        let key = check_key(&d, &refused);
        let rule = || async {
            reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err::<Verified, _>(Refused::Rule("the entry is delisted".into()))
        };
        assert!(checks.check(key, rule).await.unwrap_err().contains("delisted"));
        assert!(checks.check(key, rule).await.unwrap_err().contains("delisted"));
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 4, "a rule's refusal is remembered");
    }

    fn on_wire(p: &Proven) -> unbrowse_net::Listing {
        unbrowse_net::Listing {
            entry_id: format!("{:#x}", p.listing.entry()),
            site: p.listing.site.clone(),
            description: p.listing.terms.description.clone(),
            contributor: "0xh".into(),
            fee: 0.0,
            signed: Some(serde_json::to_value(p).unwrap()),
        }
    }

    fn wallets() -> (Address, Address, Address) {
        (Address::repeat_byte(1), Address::repeat_byte(2), Address::repeat_byte(3))
    }

    /// A delist or a relist goes to whoever the chain takes it from, and never reads as done by a key the chain refuses.
    #[test]
    fn an_entry_is_written_by_the_key_the_chain_takes_it_from() {
        let (me, wallet, other) = wallets();
        assert_eq!(entry_step(Some((me, true)), false, me, wallet), EntryStep::Node);
        assert_eq!(entry_step(Some((wallet, true)), false, me, wallet), EntryStep::Wallet(wallet), "a wallet's entry stays live until the wallet says");
        assert_eq!(entry_step(Some((me, false)), true, me, wallet), EntryStep::Node);
        assert_eq!(entry_step(Some((wallet, false)), true, me, wallet), EntryStep::Wallet(wallet));
        assert_eq!(entry_step(Some((other, false)), true, me, wallet), EntryStep::Theirs);
        assert_eq!(entry_step(Some((wallet, false)), false, me, wallet), EntryStep::Nothing, "already so");
        assert_eq!(entry_step(None, false, me, wallet), EntryStep::Nothing, "no claim credited it yet");
    }

    /// The owner's delist stands when a claim brings the entry back, and a record never reads listed past what the chain
    /// says of this node's own entry.
    #[test]
    fn a_routes_mark_and_its_entry_are_brought_back_together() {
        let (me, wallet, other) = wallets();
        assert_eq!(mend(false, Some((me, true)), me, wallet), Mend::Delist, "shown live by a claim after the owner delisted it");
        assert_eq!(mend(false, Some((wallet, true)), me, wallet), Mend::Nothing, "the node can't send a wallet's");
        assert_eq!(mend(true, Some((me, false)), me, wallet), Mend::MarkDelisted);
        assert_eq!(mend(true, Some((wallet, false)), me, wallet), Mend::MarkDelisted);
        assert_eq!(mend(true, Some((other, false)), me, wallet), Mend::Nothing);
        assert_eq!(mend(true, Some((other, true)), me, wallet), Mend::Moved(other), "an earlier listing took the credit");
        assert_eq!(mend(false, Some((other, true)), me, wallet), Mend::Nothing, "already reads as not listed");
        assert_eq!(mend(true, Some((me, true)), me, wallet), Mend::Nothing);
        assert_eq!(mend(true, None, me, wallet), Mend::Nothing, "no claim credited it yet");
    }

    /// A body listed again after its withdrawal takes a new version: a node that heard the withdrawal reads a later
    /// one as the listing put back, and the same version as the listing it already took back (R2.16).
    #[test]
    fn a_listing_put_back_takes_a_new_version_of_the_same_body() {
        let terms = Terms { description: "search".into(), response: None, price: Price::default() };
        let listing = SignedListing { route_id: "r1".into(), site: "shop.example".into(), content_id: "sha256:ab".into(), agent_id: "7".into(), version: 2, supersedes: None, terms: terms.clone(), sig: String::new() };
        let book = Book { listings: vec![Kept { listing, leaf: FixedBytes::ZERO, root: None }], ..Book::default() };
        assert_eq!(next_listing(&book, "r1", "sha256:ab", &terms, false, "7", 1), None, "listing it again changes nothing");
        assert_eq!(next_listing(&book, "r1", "sha256:ab", &terms, true, "7", 1), Some((3, Some("sha256:ab".into()))));
    }

    /// A withdrawal recovers to the key that signed it, and only for the entry, body and time it names.
    #[test]
    fn a_withdrawal_recovers_to_its_signer_only_for_what_it_names() {
        let key = PrivateKeySigner::random();
        let domain = chain::domain(&chain::Deployment::default());
        let (entry, other) = (FixedBytes::<32>::repeat_byte(1), FixedBytes::<32>::repeat_byte(2));
        let sig = sign_withdrawal(&key, &domain, entry, "sha256:aa", 100).unwrap();
        assert_eq!(withdrawal_signer(&sig, &domain, entry, "sha256:aa", 100), Ok(key.address()));
        for (e, c, at) in [(other, "sha256:aa", 100), (entry, "sha256:bb", 100), (entry, "sha256:aa", 101)] {
            assert_ne!(withdrawal_signer(&sig, &domain, e, c, at).ok(), Some(key.address()), "{e} {c} {at}");
        }
        assert!(withdrawal_signer("0xzz", &domain, entry, "sha256:aa", 100).is_err());
    }

    fn domain(chain_id: u64, settlement: Address) -> Eip712Domain {
        chain::domain(&chain::Deployment { chain_id, settlement, ..Default::default() })
    }

    fn listing(version: u64) -> SignedListing {
        SignedListing {
            route_id: "a1b2c3".into(),
            site: "shop.example".into(),
            content_id: format!("sha256:{}", "ab".repeat(32)),
            agent_id: "42".into(),
            version,
            supersedes: None,
            terms: Terms { description: "Search the shop".into(), response: Some(serde_json::json!({ "items": [{ "id": "number" }] })), price: Price::default() },
            sig: String::new(),
        }
    }

    fn proven_alone(l: SignedListing, d: &Eip712Domain) -> Proven {
        let leaf = l.leaf(d);
        Proven { listing: l, leaf, root: leaf, index: 0, proof: vec![] }
    }

    /// A signed listing checks against its contributor's key; changing any field it carries, or checking it on another
    /// chain or deployment, fails.
    #[test]
    fn a_listing_with_any_field_changed_fails_its_signature() {
        let key = PrivateKeySigner::random();
        let d = domain(5042002, Address::repeat_byte(0x11));
        let signed = listing(1).signed(&key, &d).unwrap();
        assert_eq!(signed.signer(&d).unwrap(), key.address());
        assert_eq!(proven_alone(signed.clone(), &d).check(&d, key.address()).unwrap(), key.address());
        let changes: Vec<Box<dyn Fn(&mut SignedListing)>> = vec![
            Box::new(|l| l.route_id.push('x')),
            Box::new(|l| l.site = "other.example".into()),
            Box::new(|l| l.content_id = format!("sha256:{}", "cd".repeat(32))),
            Box::new(|l| l.agent_id = "43".into()),
            Box::new(|l| l.version = 2),
            Box::new(|l| l.supersedes = Some("sha256:00".into())),
            Box::new(|l| l.terms.description.push('!')),
            Box::new(|l| l.terms.response = None),
            Box::new(|l| l.terms.price.currency = "UNB".into()),
        ];
        for change in changes {
            let mut l = signed.clone();
            change(&mut l);
            assert_ne!(l.signer(&d).ok(), Some(key.address()));
            let mut p = proven_alone(signed.clone(), &d);
            change(&mut p.listing);
            assert!(p.check(&d, key.address()).is_err());
        }
        assert_ne!(signed.signer(&domain(1, Address::repeat_byte(0x11))).ok(), Some(key.address()), "another chain");
        assert_ne!(signed.signer(&domain(5042002, Address::repeat_byte(0x22))).ok(), Some(key.address()), "another deployment");
        assert!(proven_alone(signed, &d).check(&d, PrivateKeySigner::random().address()).is_err(), "someone else's identity");
    }

    /// A listing spreads with the root its node posted and its proof from the leaf list kept with it; the proof holds
    /// for each listing under the root and for no listing outside it.
    #[test]
    fn a_listing_is_proven_under_the_root_its_node_posted() {
        let key = PrivateKeySigner::random();
        let d = domain(31337, Address::repeat_byte(0x11));
        let mut book = Book::default();
        for (i, r) in ["r1", "r2", "r3"].into_iter().enumerate() {
            let mut l = listing(1);
            l.route_id = r.into();
            l.content_id = format!("sha256:{:064x}", i);
            let l = l.signed(&key, &d).unwrap();
            let leaf = l.leaf(&d);
            book.listings.push(Kept { listing: l, leaf, root: None });
        }
        let leaves: Vec<_> = book.listings.iter().map(|k| k.leaf).collect();
        let (root, _) = positional(&leaves);
        book.listings.iter_mut().for_each(|k| k.root = Some(root));
        book.roots.push(Posted { root, leaves, block: 9, tx: "0x".into() });
        let current = book.current();
        assert_eq!(current.len(), 3);
        for p in &current {
            assert_eq!(p.root, root);
            p.check(&d, key.address()).unwrap();
        }
        // Moved under another root, or with another listing's proof, it fails.
        let mut wrong = current[0].clone();
        wrong.proof = current[1].proof.clone();
        assert!(wrong.check(&d, key.address()).is_err());
        let mut other_root = current[0].clone();
        other_root.root = FixedBytes::repeat_byte(7);
        assert!(other_root.check(&d, key.address()).is_err());
        // Signed but not yet under a posted root: not served.
        let mut l = listing(1);
        l.route_id = "r4".into();
        let l = l.signed(&key, &d).unwrap();
        let leaf = l.leaf(&d);
        book.listings.push(Kept { listing: l, leaf, root: None });
        assert_eq!(book.current().len(), 3);
    }

    /// Positional roots climb as `Listings.rootOf` does: each pair left then right, a level's odd node with zero, a
    /// leaf's index its path; a proof at another index, past its depth, or for another leaf fails.
    #[test]
    fn a_positional_proof_climbs_to_its_root_from_its_place() {
        let leaves: Vec<FixedBytes<32>> = (0..5u8).map(FixedBytes::repeat_byte).collect();
        let (root, proofs) = positional(&leaves);
        let pair = |a: FixedBytes<32>, b: FixedBytes<32>| keccak256([a.as_slice(), b.as_slice()].concat());
        let l1 = [pair(leaves[0], leaves[1]), pair(leaves[2], leaves[3]), pair(leaves[4], FixedBytes::ZERO)];
        let l2 = [pair(l1[0], l1[1]), pair(l1[2], FixedBytes::ZERO)];
        assert_eq!(root, pair(l2[0], l2[1]), "built by hand");
        for (i, p) in proofs.iter().enumerate() {
            assert!(climbs(root, leaves[i], i as u64, p), "leaf {i}");
            assert!(!climbs(root, leaves[i], (i as u64 + 1) % 5, p), "leaf {i} at another place");
        }
        assert!(!climbs(root, leaves[0], 8, &proofs[0]), "an index past the proof's depth");
        assert!(!climbs(root, FixedBytes::repeat_byte(9), 0, &proofs[0]), "another leaf");
        let (one, none) = positional(&leaves[..1]);
        assert_eq!((one, none[0].len()), (leaves[0], 0), "one leaf is its own root");
    }

    /// A new body for a route of the node's own is a new version that records the one it supersedes; the same body
    /// again is no new listing.
    #[test]
    fn a_changed_body_is_a_new_version_superseding_the_last() {
        let mut book = Book::default();
        assert_eq!(book.next_version("r1", "sha256:aa"), Some((1, None)));
        let mut l = listing(1);
        l.route_id = "r1".into();
        l.content_id = "sha256:aa".into();
        book.listings.push(Kept { listing: l.clone(), leaf: FixedBytes::ZERO, root: None });
        assert_eq!(book.next_version("r1", "sha256:aa"), None);
        assert_eq!(book.next_version("r1", "sha256:bb"), Some((2, Some("sha256:aa".into()))));
        l.version = 2;
        l.content_id = "sha256:bb".into();
        book.listings.push(Kept { listing: l, leaf: FixedBytes::ZERO, root: None });
        assert_eq!(book.latest("r1").unwrap().listing.content_id, "sha256:bb");
        assert_eq!(book.next_version("r2", "sha256:aa"), Some((1, None)), "versions are per route");
    }

    #[test]
    fn a_large_response_shape_is_cut_to_fit_the_terms() {
        let small = serde_json::json!({ "a": { "b": "string" } });
        assert_eq!(bounded_shape(Some(small.clone())), Some(small));
        let wide: serde_json::Map<String, Value> = (0..400).map(|i| (format!("field_{i}"), serde_json::json!({ "x": "string", "y": "number" }))).collect();
        let deep = serde_json::json!({ "data": Value::Object(wide) });
        let cut = bounded_shape(Some(deep)).unwrap();
        assert!(recipe::canonical_json(&cut).len() <= MAX_SHAPE_BYTES);
        assert_eq!(cut, serde_json::json!({ "data": "object" }));
    }

    /// A node lists under the wallet its owner confirmed, whichever node it is, so every node of the wallet lists under
    /// one identity (R1.12, R7.22); the node whose own key is that wallet, and a node with no wallet confirmed, list as
    /// themselves.
    #[test]
    fn two_nodes_under_one_wallet_list_under_one_identity() {
        let (a, b, w) = (Address::repeat_byte(0xa1), Address::repeat_byte(0xb2), Address::repeat_byte(0xc3));
        assert_eq!((shared_wallet(a, Some(w)), shared_wallet(b, Some(w))), (Some(w), Some(w)), "both under the wallet");
        assert_eq!(shared_wallet(w, Some(w)), None, "the node holding the wallet's key lists as it always has");
        assert_eq!(shared_wallet(a, None), None, "no wallet confirmed: its own");
    }

    /// Two nodes under one wallet that learned one route never sign two bodies under one version of it, which would be
    /// the wallet's equivocation (R6.15 (a)): each starts at a place of its own, 2^32 versions from any other's and from
    /// the wallet node's own, and every version still reads exactly as a JavaScript number.
    #[test]
    fn two_nodes_under_one_wallet_never_take_one_version_of_a_route() {
        let (a, b) = (Address::repeat_byte(0xa1), Address::repeat_byte(0xb2));
        let (fa, fb) = (first_version(a, true), first_version(b, true));
        assert_eq!(first_version(a, false), 1, "the wallet's own node, or a node listing as itself");
        assert!(fa.abs_diff(fb) >= 1 << 32 && fa > 1 << 32 && fb > 1 << 32, "{fa} {fb}");
        assert!(fa < 1 << 53 && fb < 1 << 53, "{fa} {fb}");
        assert!(first_version(Address::ZERO, true) > 1 << 32, "no address takes the wallet node's place");
        // Versions run on from the node's own place, per identity: one listed as itself before starts afresh.
        let terms = Terms { description: "search".into(), response: None, price: Price::default() };
        let mut own = listing(3);
        own.agent_id = "7".into();
        let book = Book { listings: vec![Kept { listing: own, leaf: FixedBytes::ZERO, root: None }], ..Book::default() };
        assert_eq!(next_listing(&book, "a1b2c3", "sha256:ff", &terms, false, "9", fa), Some((fa, None)), "the wallet's first");
        assert_eq!(next_listing(&book, "a1b2c3", "sha256:ff", &terms, false, "7", 1).map(|v| v.0), Some(4), "its own goes on");
    }

    /// Only the wallet's own key signs a listing: a key the wallet granted (an agent key) neither signs nor approves one,
    /// and nor does any other key (issue #184).
    #[test]
    fn an_agent_key_can_never_sign_or_approve_a_listing() {
        let (wallet, agent) = (PrivateKeySigner::random(), PrivateKeySigner::random());
        let d = domain(5042002, Address::repeat_byte(0x11));
        let by_agent = listing(1).signed(&agent, &d).unwrap().signer(&d).unwrap();
        assert!(owner_signed(by_agent, wallet.address(), true).unwrap_err().contains("agent key"));
        assert!(owner_signed(by_agent, wallet.address(), false).is_err(), "nor any key the wallet never granted");
        let by_wallet = listing(1).signed(&wallet, &d).unwrap().signer(&d).unwrap();
        assert_eq!(owner_signed(by_wallet, wallet.address(), false), Ok(()));
        // A wallet's answer with its recovery byte as 0 or 1 reads as the chain takes it.
        let sig = listing(1).signed(&wallet, &d).unwrap().sig;
        let mut low = hex::decode(&sig[2..]).unwrap();
        low[64] -= 27;
        assert_eq!(listing_sig(&hex::encode(low)).unwrap(), sig);
        assert!(listing_sig("0x1234").is_err());
    }

    /// A listing waiting for the owner's wallet goes under no root and never spreads; only each route's newest is asked
    /// for, and once signed it is a listing like any other.
    #[test]
    fn a_node_without_the_wallets_key_never_signs_a_listing_and_waits_for_the_owner() {
        let d = domain(31337, Address::repeat_byte(0x11));
        let waiting = |route: &str, v: u64| {
            let mut l = listing(v);
            l.route_id = route.into();
            l.agent_id = "9".into();
            l.content_id = format!("sha256:{:064x}", v);
            let leaf = l.leaf(&d);
            Kept { listing: l, leaf, root: Some(leaf) }
        };
        let mut book = Book { listings: vec![waiting("r1", 1), waiting("r1", 2), waiting("r2", 1)], ..Book::default() };
        book.roots = book.listings.iter().map(|k| Posted { root: k.leaf, leaves: vec![k.leaf], block: 1, tx: "0x".into() }).collect();
        assert!(book.listings.iter().all(|k| book.proven(k).is_none()), "no signature: never proven, whatever root it names");
        assert!(book.current().is_empty());
        let asked: Vec<(String, u64)> = waiting_in(&book, "9").iter().map(|k| (k.listing.route_id.clone(), k.listing.version)).collect();
        assert_eq!(asked, vec![("r1".into(), 2), ("r2".into(), 1)], "each route's newest");
        assert!(waiting_in(&book, "7").is_empty(), "another identity's are never asked for");
        let wallet = PrivateKeySigner::random();
        book.listings[1].listing = book.listings[1].listing.clone().signed(&wallet, &d).unwrap();
        assert!(book.proven(&book.listings[1]).is_some(), "signed, it is proven under its root");
        assert_eq!(waiting_in(&book, "9").len(), 1, "r2 still waits");
    }

    /// The typed data a wallet signs makes the listing's own digest: the same types, in order, and the same values,
    /// the version as a string no JavaScript number rounds.
    #[test]
    fn the_typed_data_a_wallet_signs_makes_the_listings_own_digest() {
        use std::borrow::Cow;
        let dep = chain::Deployment { chain_id: 5042002, settlement: Address::repeat_byte(0x11), ..Default::default() };
        let mut l = listing(first_version(Address::repeat_byte(0xab), true));
        l.supersedes = Some("sha256:00".into());
        let t = typed_data(&l, &dep);
        let fields = |name: &str| t["types"][name].as_array().unwrap().iter().map(|f| format!("{} {}", f["type"].as_str().unwrap(), f["name"].as_str().unwrap())).collect::<Vec<_>>().join(",");
        assert_eq!(format!("Listing({})", fields("Listing")), typed::Listing::eip712_encode_type());
        assert_eq!(fields("EIP712Domain"), "string name,string version,uint256 chainId,address verifyingContract");
        assert_eq!(t["primaryType"], "Listing");
        let (m, dm) = (&t["message"], &t["domain"]);
        let text = |v: &Value| v.as_str().unwrap().to_string();
        let rebuilt = typed::Listing {
            routeId: text(&m["routeId"]),
            site: text(&m["site"]),
            contentId: text(&m["contentId"]),
            agentId: text(&m["agentId"]),
            version: text(&m["version"]).parse().unwrap(),
            supersedes: text(&m["supersedes"]),
            terms: text(&m["terms"]).parse().unwrap(),
        };
        let domain = Eip712Domain::new(
            Some(Cow::Owned(text(&dm["name"]))),
            Some(Cow::Owned(text(&dm["version"]))),
            Some(alloy::primitives::U256::from(dm["chainId"].as_u64().unwrap())),
            Some(text(&dm["verifyingContract"]).parse().unwrap()),
            None,
        );
        assert_eq!(rebuilt.eip712_signing_hash(&domain), l.digest(&chain::domain(&dep)));
    }

    /// Anyone may publish a listing for any route (R2.14): two contributors who are not the route's first builder, each
    /// under an identity and key of their own, list the same route of the same site, one of them the very same body as
    /// the other, and every listing is accepted: each checks as its own contributor's, and a lookup keeps all of them
    /// beside the builder's. Nothing refuses a listing for a route someone else already listed, or a copy of a body.
    #[tokio::test]
    async fn two_unrelated_contributors_may_each_publish_an_entry_for_the_same_route() {
        let d = domain(31337, Address::repeat_byte(0x11));
        let (builder, first, second) = (PrivateKeySigner::random(), PrivateKeySigner::random(), PrivateKeySigner::random());
        let by = |key: &PrivateKeySigner, agent: &str, body: char, words: &str| {
            let mut l = listing(1);
            l.agent_id = agent.into();
            l.content_id = format!("sha256:{}", body.to_string().repeat(64));
            l.terms.description = words.into();
            l.signed(key, &d).unwrap()
        };
        let listed = [
            (by(&builder, "7", 'a', "Search the shop"), builder.address()),
            (by(&first, "8", 'b', "Find things in the shop"), first.address()),
            (by(&second, "9", 'b', "Find things in the shop"), second.address()),
        ];
        assert!(listed.iter().all(|(l, _)| l.route_id == listed[0].0.route_id && l.site == listed[0].0.site), "one route of one site");
        assert_eq!(listed[1].0.entry(), listed[2].0.entry(), "two contributors list one body");
        for (l, who) in &listed {
            assert_eq!(proven_alone(l.clone(), &d).check(&d, *who), Ok(*who), "each is its own contributor's, whoever listed the route first");
        }
        // A listing signed by one contributor's key never passes as another's: openness is not impersonation.
        assert!(proven_alone(listed[1].0.clone(), &d).check(&d, second.address()).is_err());
        let found: Vec<_> = listed.iter().map(|(l, _)| on_wire(&proven_alone(l.clone(), &d))).collect();
        let dr = &d;
        let kept = checked_found(found, "shop.example", &d, |p: Proven| async move {
            let contributor = p.listing.signer(dr).unwrap();
            Ok(Verified { proven: p, contributor, fee: 0.0, fee_units: alloy::primitives::U256::ZERO, root_block: 1, credited: false })
        })
        .await;
        assert_eq!(kept.iter().map(|v| v.contributor).collect::<Vec<_>>(), vec![builder.address(), first.address(), second.address()]);
        assert!(kept.iter().all(|v| v.proven.listing.route_id == "a1b2c3"));
    }
}
