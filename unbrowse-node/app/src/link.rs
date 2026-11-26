//! The owner's wallet, linked to this node, if they link one. Linking is optional: the node's own root key is an Arc
//! wallet (secp256k1, the same kind of key as any EVM wallet's), and a node joins the network on it (spec §86).
//!
//! A node is on the network from the first time it runs with the peer network on (`on_network_since`), with no
//! sign-in: it registers its ERC-8004 identity from its own wallet as it joins (`peers::start_serving`), grants its
//! agents' capped spending keys on the chain and keeps them renewed (`agents::keep_granted`), and lists the routes it
//! learns from then on by default, after showing which (`autolist`). A node the owner keeps off the network is local:
//! it learns and calls its owner's routes and shares nothing, whenever it went off: having joined once is a date, not
//! a standing, and what sends goes by `on_network` (on now), never `on_network_since`. Its chain work goes on: it still
//! claims what its agents paid for, stakes and tops up (`chain_pass_runs`, docs/NETWORK.md §10). A route
//! learned while the node was local stays on the node for good (R2.8).
//!
//! Linking a wallet adds that wallet; it is never needed to join. The owner signs one message naming this node's key
//! and a nonce only this node made, with Privy on the website (email or Google, an embedded wallet; the window's page
//! is served from a scheme Privy can't trust) or with any wallet of their own (`link_message`, `link_wallet`): the
//! message is EIP-191, so any wallet on any chain signs it. The node keeps the signature, never a key. A linked wallet
//! is where withdrawals go, and its deposit can pay for several nodes (`owner_nodes`).
//!
//! There is no sponsor and no faucet (spec §76): every write is paid by the node's own key, in USDC on Arc, which is
//! also Arc's gas. A node that only earns needs a few cents of USDC once, for its identity registration (`funding`
//! says how much and where to send it). Its listings need no gas: they are signed and travel between nodes, and a
//! payer's claim shows them on chain.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use alloy::primitives::{Address, Signature};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{store, St};
use crate::sync::{Locked, Shared};

/// How long a sign-in in the browser is waited for.
const WAIT: Duration = Duration::from_secs(15 * 60);
/// Woken when the owner signs in, so what waits for a sign-in (joining the peer network) goes on at once.
pub static SIGNED_IN: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// The websites, in the order tried: each serves the sign-in page and the short-lived relay it hands the signature back
/// through, and takes the node's events. UNBROWSE_SITE at run time puts one first, then the one the build names
/// (`build_config::site`), then the public sites.
pub fn sites() -> Vec<String> {
    sites_from(std::env::var("UNBROWSE_SITE").ok().as_deref(), crate::build_config::site())
}

fn sites_from(env: Option<&str>, built: Option<&str>) -> Vec<String> {
    let mut all: Vec<String> = env.into_iter().chain(built).map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect();
    all.extend(["https://unbrowse.ai".to_string(), "https://unbrowse.si".to_string()]);
    all.iter_mut().for_each(|s| *s = s.trim_end_matches('/').to_string());
    let mut seen = std::collections::HashSet::new();
    all.retain(|s| seen.insert(s.clone()));
    all
}

/// The sign-in page for this node and nonce, and with `fund`, the chain on which the node's key can't pay its gas yet:
/// the page then offers the owner one USDC transfer from their own wallet for it (spec §76). All in the fragment: the
/// page reads it, and it never reaches a server's log.
#[cfg(test)]
pub fn page(site: &str, node: &str, nonce: &str, fund: Option<u64>) -> String {
    page_with(site, node, nonce, fund, &[], false)
}

/// One agent grant the page asks the owner's wallet to send (spec §76.2 item 4): `authorizeAgent(agent, cap, expiry)`
/// to `settlement` on `chain_id`, the cap in the chain's USDC units. Written into the fragment as
/// `<chain id>:<settlement>:<agent>:<cap units>:<expiry>`, comma-separated, which the page reads back
/// (`unbrowse-landing` `src/link/grants.ts`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PageGrant {
    pub chain_id: u64,
    pub settlement: String,
    pub agent: String,
    pub cap_units: String,
    pub expiry: u64,
}

impl PageGrant {
    fn fragment(&self) -> String {
        format!("{}:{}:{}:{}:{}", self.chain_id, self.settlement.to_lowercase(), self.agent.to_lowercase(), self.cap_units, self.expiry)
    }
}

/// The sign-in page, and with `grants`, the agent grants the owner's wallet sends in the same flow as its signature, so
/// the node's agents pay from the wallet's deposit at once (§76.2 item 4). With `renew`, the page only sends the
/// grants: the node is linked already, and the owner renews its keys' grants in one step (§76.2 item 3).
pub fn page_with(site: &str, node: &str, nonce: &str, fund: Option<u64>, grants: &[PageGrant], renew: bool) -> String {
    let fund = fund.map(|id| format!("&fund={id}")).unwrap_or_default();
    let grants = if grants.is_empty() { String::new() } else { format!("&grants={}", grants.iter().map(PageGrant::fragment).collect::<Vec<_>>().join(",")) };
    let renew = if renew { "&renew=1" } else { "" };
    format!("{site}/link/#node={}&nonce={nonce}{fund}{grants}{renew}", node.to_lowercase())
}

/// The page that adds funds to this node (the landing's `/fund`, which mounts Circle's Arc Onramp Kit): the node's
/// address, the chain the USDC lands on, the smallest top-up that starts the node (`min`, USDC as a decimal) and a
/// nonce, all in the fragment like the sign-in page's, so none of it reaches a server's log. Card-bought USDC lands at
/// the node's address and the node's own top-up deposits it, keeping its gas (`crate::top_up`).
pub fn fund_page(site: &str, node: &str, chain_id: u64, min: &str, nonce: &str) -> String {
    format!("{site}/fund/#node={}&chain={chain_id}&min={min}&nonce={nonce}", node.to_lowercase())
}

/// A fresh nonce for a page the node opens.
pub fn nonce() -> Result<String, String> {
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    Ok(hex::encode(raw))
}

/// `add_funds`: the page that adds funds (`fund_page`), opened in the owner's browser, at the smallest top-up that
/// starts the node. Answers the page and whether it opened.
pub async fn add_funds(node: St<'_>) -> Result<Value, String> {
    let m = crate::money::of(node).await?;
    let url = m.add_funds_url.ok_or("payments aren't open on this network yet: there's nothing to add funds to")?;
    let opened = open(&url).is_ok();
    Ok(json!({ "url": url, "opened": opened }))
}

/// The first site whose sign-in page answers; the first site when none does, so the owner sees why in the browser.
async fn reachable_site() -> String {
    let client = reqwest::Client::new();
    let all = sites();
    for site in &all {
        let got = client.get(format!("{site}/link/")).timeout(Duration::from_secs(5)).send().await;
        if got.is_ok_and(|r| r.status().is_success()) {
            return site.clone();
        }
    }
    all[0].clone()
}

/// A link the owner's wallet signed: the proof, kept so anything the node sends can carry it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Link {
    pub owner: String,
    pub nonce: String,
    pub signature: String,
    pub linked: u64,
    /// The node's seal over the link (`seal`), made when the owner confirmed it: a link file another program wrote,
    /// which the owner never confirmed, has none, and its wallet gets no withdrawal until the owner confirms it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seal: Option<String>,
    /// The site's visitor id for the browser the owner signed in with (`ub_vid`, `v_` and 32 hex), when the site's
    /// consent rule let it keep one there and it handed it back with the signature (UNB-179). The node sends it back
    /// on its events to the site (`signed`), so the site can join that visit to this node; the site checks it against
    /// its own record of the sign-in, so a node can't name another visitor. None for a link made with the owner's own
    /// wallet (`link_wallet`), or a site that kept no id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vid: Option<String>,
}

/// Whether `v` is a visitor id as the site makes them (`v_` and 32 lower-case hex): anything else a relay sends is
/// dropped, so nothing but that id is ever kept or sent back.
fn is_vid(v: &str) -> bool {
    v.len() == 34 && v.starts_with("v_") && v[2..].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// What a link's seal is over: the node, the wallet and the wallet's signature.
fn sealed_words(node: &str, l: &Link) -> String {
    format!("unbrowse owner link v1 {} {} {} {}", node.to_lowercase(), l.owner.to_lowercase(), l.nonce, l.signature)
}

const SEAL_LABEL: &str = "owner-link";

/// `l`, sealed by the node whose root key is in `keys`: the owner confirmed it.
pub fn seal(keys: &dyn unbrowse_core::KeyStore, mut l: Link) -> Result<Link, String> {
    let root = unbrowse_core::RootKey::load(keys).map_err(|e| e.to_string())?;
    let node = unbrowse_core::identity::load_or_create(keys).map_err(|e| e.to_string())?.address.to_checksum();
    l.seal = Some(unbrowse_core::owner_pass::seal_text(&root, SEAL_LABEL, &sealed_words(&node, &l)));
    Ok(l)
}

/// Whether the node whose root key is in `keys` sealed `l`.
pub fn is_sealed(keys: &dyn unbrowse_core::KeyStore, l: &Link) -> bool {
    let (Ok(root), Ok(id)) = (unbrowse_core::RootKey::load(keys), unbrowse_core::identity::load_or_create(keys)) else {
        return false;
    };
    l.seal.as_deref().is_some_and(|mac| unbrowse_core::owner_pass::sealed_text(&root, SEAL_LABEL, &sealed_words(&id.address.to_checksum(), l), mac))
}

/// The wallet the owner confirmed for the node whose root key is in `keys`: the only one the node pays out to, lists
/// under or takes a payer from without asking. A link file is this user's to write, and the signature in it is only
/// that wallet's own say: a program that signs with a wallet of its own can make one that checks, so every use that
/// moves money reads the seal, which takes the root key to make. None for no link, or one the node didn't seal.
pub fn confirmed(keys: &dyn unbrowse_core::KeyStore) -> Option<Address> {
    let me = unbrowse_core::identity::load_or_create(keys).ok()?.address.to_checksum();
    let l = load(&me).filter(|l| is_sealed(keys, l))?;
    l.owner.parse().ok()
}

/// The wallet withdrawals go to: the linked one, once the owner confirmed it. A link the node didn't seal (its file was
/// written by something other than the node, or before links were sealed) is the wallet's signature alone, which
/// whoever holds that wallet can make: the owner is asked, showing the address, and only a yes seals it and pays out
/// there. A no withdraws nothing. No link: `None`, and the node keeps what it withdraws.
pub async fn payout(node: St<'_>) -> Result<Option<Address>, String> {
    let Some(l) = signed_in(node) else {
        return Ok(None);
    };
    let wallet: Address = l.owner.parse().map_err(|_| format!("the linked wallet {} isn't an address", l.owner))?;
    let keys = node.key()?;
    if is_sealed(keys, &l) {
        return Ok(Some(wallet));
    }
    let question = format!(
        "Send this Unbrowse node's withdrawals to this wallet?\n\n{}\n\nThe node has no record of you confirming it: its link was written by something other than the node, or before the node kept such a record. Check it is your own wallet's address, as your wallet shows it, and allow it only then.",
        l.owner
    );
    crate::owner_dialog::ask(Some(keys), question).await.map_err(|e| format!("the linked wallet {} isn't one you confirmed, so nothing was withdrawn ({e})", l.owner))?;
    store::write_json(&path(), &unbrowse_files::LINK, &seal(keys, l)?)?;
    Ok(Some(wallet))
}

/// What the owner's wallet signs. Addresses are lowercase, so the page, the node and the site's check write the same
/// bytes whatever casing each was handed.
pub fn message(node: &str, owner: &str, nonce: &str) -> String {
    format!("Unbrowse: link this node to my wallet.\n\nNode: {}\nOwner: {}\nNonce: {nonce}", node.to_lowercase(), owner.to_lowercase())
}

fn address(s: &str) -> Result<Address, String> {
    s.parse().map_err(|_| format!("not a wallet address: {s}"))
}

/// The address a 65-byte personal_sign signature over `msg` recovers to.
pub fn signer_of(msg: &str, sig_hex: &str) -> Result<Address, String> {
    let bytes = hex::decode(sig_hex.strip_prefix("0x").unwrap_or(sig_hex)).map_err(|_| "the signature isn't hex")?;
    if bytes.len() != 65 {
        return Err(format!("a signature is 65 bytes, this one {}", bytes.len()));
    }
    let v = bytes[64];
    let sig = Signature::from_bytes_and_parity(&bytes[..64], if v >= 27 { v - 27 != 0 } else { v != 0 });
    sig.recover_address_from_msg(msg).map_err(|e| format!("the signature recovers no key: {e}"))
}

/// Checks that `owner` signed the link of `node` under `nonce`.
pub fn verify(node: &str, owner: &str, nonce: &str, signature: &str) -> Result<(), String> {
    let owner_addr = address(owner)?;
    address(node)?;
    if signer_of(&message(node, owner, nonce), signature)? != owner_addr {
        return Err("the signature isn't the owner's".into());
    }
    Ok(())
}

fn path() -> std::path::PathBuf {
    store::home().join("owner.json")
}

/// The link this node keeps, if the owner has signed one for the key it runs under now: a restored or replaced root
/// key is another node, and the link names the old one.
pub fn load(node: &str) -> Option<Link> {
    let l: Link = store::read_json(&path(), &unbrowse_files::LINK);
    (!l.owner.is_empty() && verify(node, &l.owner, &l.nonce, &l.signature).is_ok()).then_some(l)
}

/// The owner's link, when they linked a wallet to this node. Joining needs none (`on_network`).
pub fn signed_in(node: St) -> Option<Link> {
    load(&crate::identity(node).ok()?.address)
}

/// When this node went on the network on its own wallet: the first run with the peer network on under this key.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Joined {
    pub node: String,
    pub since: u64,
}

fn joined_path() -> std::path::PathBuf {
    store::home().join("joined.json")
}

/// When the node whose address is `node` went on the network (spec §86): the earlier of when it first ran with the peer
/// network on under this key and when its owner linked a wallet. A node that has done neither and runs with the peer
/// network on now counts from now, until `note_joined` keeps that time. `None` while the owner keeps a node that never
/// joined off the network: it is local, and what it learns stays on it. Only a read: a window asking, or a command in
/// another process, starts no clock.
pub fn on_network_since(node: &str) -> Option<u64> {
    let linked = load(node).map(|l| l.linked);
    let joined = store::read_json_opt::<Joined>(&joined_path(), &unbrowse_files::JOINED)
        .filter(|j| j.node.eq_ignore_ascii_case(node))
        .map(|j| j.since);
    if let Some(t) = [linked, joined].into_iter().flatten().min() {
        return Some(t);
    }
    crate::network_on().then(store::now)
}

#[cfg(test)]
mod joined_tests {
    use super::*;

    /// A read of when the node went on the network starts no clock: asked before it ever ran with the network on, by a
    /// window or a command in another process, it says now and keeps nothing. The running node keeps the time, once.
    #[test]
    fn asking_when_the_node_joined_writes_nothing() {
        let home = store::scratch_home("joined-read");
        store::save_settings(&crate::terms::acknowledged(store::Settings::default(), false)).unwrap();
        let _ = on_network_since("0xabc");
        assert!(!joined_path().exists(), "a read wrote the clock");
        note_joined("0xabc");
        let kept = std::fs::read_to_string(joined_path()).unwrap();
        note_joined("0xabc");
        assert_eq!(std::fs::read_to_string(joined_path()).unwrap(), kept, "kept once");
        let _ = std::fs::remove_dir_all(home);
    }
}

/// The running node, with the peer network on under key `node`: the first time it is, that time is kept.
/// What it keeps is the earliest day it knows, a linked wallet's included, so a wallet unlinked later can't move it.
pub fn note_joined(node: &str) {
    if !crate::network_on() {
        return;
    }
    let Some(since) = on_network_since(node) else { return };
    let kept = store::read_json_opt::<Joined>(&joined_path(), &unbrowse_files::JOINED)
        .filter(|j| j.node.eq_ignore_ascii_case(node))
        .map(|j| j.since);
    if kept == Some(since) {
        return;
    }
    if let Err(e) = store::write_json(&joined_path(), &unbrowse_files::JOINED, &Joined { node: node.to_string(), since }) {
        eprintln!("network: couldn't keep when this node joined: {e}");
    }
}

/// When a node that joined at `since` joined, while it is on the network now. Joining once is no standing: an owner
/// who has since turned the peer network off, or not yet answered new terms, has a local node (R1.35), and a linked
/// wallet doesn't change that.
fn on_now(since: Option<u64>, network_on: bool) -> Option<u64> {
    since.filter(|_| network_on)
}

/// When this node joined, while it is on the network now: what anything that sends or writes goes by.
pub fn on_network(node: St) -> Option<u64> {
    on_now(on_network_since(&crate::identity(node).ok()?.address), crate::network_on())
}

/// `on_network`, for code with no node at hand: none before the node's key is read.
pub fn on_network_now() -> Option<u64> {
    on_now(joined_since(), crate::network_on())
}

/// `on_network_since` for this node, on or off now: for reading a route's record, whose `local` mark says the rest.
pub fn joined_since() -> Option<u64> {
    let me = NODE.reading().clone()?;
    on_network_since(&me)
}

/// This node's address, kept when its key is read (`set_node`), for code with no node at hand (a route's record as it
/// is learned, the listing plan).
pub(crate) static NODE: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

pub fn set_node(address: &str) {
    *NODE.writing() = Some(address.to_string());
}

pub fn forget() -> Result<(), String> {
    match std::fs::remove_file(path()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// The sign-in under way: its nonce, when it started, and why the last one failed.
#[derive(Default)]
struct Waiting {
    nonce: Option<String>,
    since: Option<Instant>,
    error: Option<String>,
    /// A bring-your-own-wallet sign-in under way (`link_message`): the wallet named, and the nonce the node drew.
    wallet: Option<(Address, String)>,
}

static WAITING: Mutex<Waiting> = Mutex::new(Waiting { nonce: None, since: None, error: None, wallet: None });

impl Waiting {
    /// A sign-in at the website began under `nonce`, in place of any earlier one. A wallet of the owner's own being
    /// signed with is another sign-in, and waits on: the signature it brings back still has its nonce to meet.
    fn began(&mut self, nonce: &str) {
        *self = Waiting { nonce: Some(nonce.into()), since: Some(Instant::now()), error: None, wallet: self.wallet.take() };
    }

    /// The sign-in under `nonce` ended, with `error` when it failed. Whether it was still the current one: a newer one
    /// that took over keeps its wait.
    fn ended(&mut self, nonce: &str, error: Option<&String>) -> bool {
        if self.nonce.as_deref() != Some(nonce) {
            return false;
        }
        *self = Waiting { error: error.cloned(), wallet: self.wallet.take(), ..Waiting::default() };
        true
    }
}

/// Held by a test that starts, ends or reads a sign-in: the sign-in under way is one for the whole process, so another
/// test's would end this one's.
#[cfg(test)]
pub(crate) static SIGN_IN_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn waiting() -> std::sync::MutexGuard<'static, Waiting> {
    WAITING.locked()
}

/// `link_status`: the linked owner, and whether a sign-in is waited on.
pub fn status(node: St) -> Result<Value, String> {
    let me = crate::identity(node)?.address;
    let w = waiting();
    let on = w.nonce.is_some() && w.since.is_some_and(|t| t.elapsed() < WAIT);
    Ok(json!({ "owner": load(&me).map(|l| l.owner), "waiting": on, "error": w.error }))
}

/// About what a node registering its identity needs for gas, in USDC: its registration and the metadata saying where
/// it is, two writes, at Arc's 20 Gwei floor with room. A few cents, once (spec §76).
pub const IDENTITY_USDC: f64 = 0.05;

/// `funding`: what this node's own key needs, in USDC on Arc, which is also its gas (spec §76: every write is its
/// writer's). On a live chain: the gas it has and about what a write needs, when it has less (`short`); what its
/// identity registration needs once (`identity_usdc`, a few cents: all a node that only earns ever needs); its deposit
/// against the floor it keeps, and about how much to send for the rest (`fund_usdc`). Null off a live chain, where the
/// devnet pays its own gas. `address` is where to send it.
pub async fn funding(node: St<'_>) -> Result<Value, String> {
    let short = needs_funds(node).await?;
    let live = node.chain.network().map(|n| n.name);
    let address = crate::identity(node)?.address;
    let floor = store::load_settings().deposit_floor_usdc;
    let (mut deposited, mut fund) = (None, None);
    if let (Some(_), Ok(keys)) = (live, node.key()) {
        if let Ok(me) = crate::chain::owner_address(keys) {
            deposited = crate::chain::spendable_usdc(&node.chain, me).await.ok();
            fund = match deposited {
                Some(have) if have + 1e-9 < floor => crate::chain::to_fund(&node.chain, me, floor - have).await,
                Some(_) => Some(0.0),
                None => None,
            };
        }
    }
    // USDC held on another chain reaches this address through Arc's own CCTP v2 or Gateway, minted here: no bridge of
    // the node's own (spec §75.4).
    let other_chains = node.chain.network().map(|n| json!({ "cctp_domain": crate::arc::CCTP_DOMAIN, "cctp_messenger": format!("{:#x}", n.cctp_messenger), "gateway_minter": format!("{:#x}", n.gateway_minter) }));
    Ok(json!({
        "live": live, "short": short, "site": sites()[0], "address": address,
        "identity_usdc": live.map(|_| IDENTITY_USDC), "deposit_floor_usdc": floor, "deposited_usdc": deposited, "fund_usdc": fund,
        "other_chains": other_chains,
    }))
}

/// On a live chain, what the node's key lacks for gas; `None` on the devnet or when it can pay.
async fn needs_funds(node: St<'_>) -> Result<Option<crate::chain::GasShort>, String> {
    if node.chain.network().is_none() {
        return Ok(None);
    }
    crate::chain::gas_short(node.key()?).await
}

/// `link_start`: a fresh nonce, the sign-in page opened in the owner's browser, and the node waiting for what the
/// owner signs there. Starting again drops the earlier wait.
pub async fn start(node: St<'_>) -> Result<Value, String> {
    let me = crate::identity(node)?.address;
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    let nonce = hex::encode(raw);
    // A node that can't pay its gas on a live chain asks the page to offer the owner one transfer for it.
    let fund = needs_funds(node).await.ok().flatten().map(|g| g.chain_id);
    // The relay is the page's own site, so the node waits on the site it opened.
    let site = reachable_site().await;
    // No agent grants ride on the sign-in: agents pay from the node's own balance by default. Paying from the owner's
    // account instead is an Advanced choice, which sends its grants from the same page on its own (`renew`).
    // The same visit links this node to the owner's account for apps signed in to the gateway's /mcp (ChatGPT, Claude):
    // the page names it (`own=`), and the node asks the owner in its own dialog before it is linked.
    let own = crate::remote::own_for_sign_in(&site).map(|p| format!("&own={p}")).unwrap_or_default();
    let url = format!("{}{own}", page_with(&site, &me, &nonce, fund, &[], false));
    waiting().began(&nonce);
    let opened = open(&url).is_ok();
    let n = node.clone();
    tokio::spawn(async move {
        let outcome = match collect(&site, &me, &nonce).await {
            Ok(link) => keep_once_confirmed(n.key().ok(), link).await,
            Err(e) => Err(e),
        };
        let current = waiting().ended(&nonce, outcome.as_ref().err());
        match outcome {
            // Kept, so it is said and acted on even when a newer sign-in began while the owner was asked about it.
            Ok(link) => linked(&n, &link),
            Err(_) if current => n.events.emit("identity", ()),
            Err(_) => {}
        }
    });
    Ok(json!({ "url": url, "opened": opened }))
}

/// `wallet_renew`: renews, in one step, the owner's wallet's grants to this node's agent keys before they run out
/// (§76.2 item 3): the sign-in page opened in the owner's browser in its renewal mode, which sends every grant the
/// node asks for from the wallet in one go, and the same calls for a wallet of the owner's own (`nodes renew`). The
/// grants keep their expiry: each runs until the key's own, 30 days on, and none is ever made without one.
pub async fn renew(node: St<'_>) -> Result<Value, String> {
    let me = crate::identity(node)?.address;
    let owner = payout(node).await?.ok_or("no linked wallet, so no wallet grant to renew: this node pays from its own wallet")?;
    let grants = crate::owner_nodes::page_grants(node, Some(owner)).await;
    let calls = crate::owner_nodes::grant(node).await?.calls;
    if grants.is_empty() {
        return Ok(json!({ "url": null, "opened": false, "calls": calls }));
    }
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    let site = reachable_site().await;
    let url = page_with(&site, &me, &hex::encode(raw), None, &grants, true);
    let opened = open(&url).is_ok();
    Ok(json!({ "url": url, "opened": opened, "calls": calls }))
}

/// The most listings one signing page asks the owner's wallet for: the page's address carries them all.
const SIGN_AT_ONCE: usize = 8;

/// The sign-in page in its signing mode (`unbrowse-landing` `src/link/sign.ts`): for each listing, the relay's nonce
/// its signature comes back under, its site, what signing it does and the typed data the wallet signs, as JSON in the
/// fragment, so none of it reaches a server's log. `wallet` is the one that must sign: the page refuses another.
pub fn sign_page(site: &str, node: &str, wallet: &str, items: &[(String, crate::listing::ToSign)]) -> String {
    let list: Vec<Value> = items.iter().map(|(nonce, t)| json!({ "nonce": nonce, "site": t.site, "what": t.what, "typed_data": t.typed_data })).collect();
    let text = serde_json::to_string(&list).unwrap_or_default();
    let sign = percent_encoding::utf8_percent_encode(&text, percent_encoding::NON_ALPHANUMERIC);
    format!("{site}/link/#node={}&wallet={}&sign={sign}", node.to_lowercase(), wallet.to_lowercase())
}

/// `listings_sign`: has the owner's wallet sign the listings this node keeps for it (`listings_to_sign`), the way it
/// sends its grants (`renew`): the sign-in page opens in the owner's browser in its signing mode, the wallet's provider
/// signs each listing there, and each signature comes back through the site's relay under a nonce of its own. The node
/// takes only the wallet's own signature (`listing::sign_waiting`), so the page, or whoever serves it, can't sign for
/// the wallet. A wallet of the owner's own signs the typed data `listings_to_sign` gives and hands it to `listing_sign`.
pub async fn sign_listings(node: St<'_>) -> Result<Value, String> {
    let me = crate::identity(node)?.address;
    let waiting = crate::owner_nodes::to_sign(node).await?;
    let Some(wallet) = waiting.first().map(|t| t.wallet.clone()) else {
        return Ok(json!({ "url": null, "opened": false, "asked": 0 }));
    };
    let mut items = Vec::new();
    for t in waiting.into_iter().take(SIGN_AT_ONCE) {
        items.push((nonce()?, t));
    }
    let site = reachable_site().await;
    let url = sign_page(&site, &me, &wallet, &items);
    let opened = open(&url).is_ok();
    let asked = items.len();
    let n = node.clone();
    let wanted: Vec<(String, String)> = items.into_iter().map(|(nonce, t)| (nonce, t.id)).collect();
    tokio::spawn(async move { collect_signatures(&n, &site, wanted, WAIT).await });
    Ok(json!({ "url": url, "opened": opened, "asked": asked }))
}

/// Asks the site's relay for each listing's signature, `(nonce, listing id)`, until every one is in or `wait` runs
/// out, and hands each to the node (`owner_nodes::sign_listing`), which takes only the wallet's own. A relay answer
/// that isn't one is said, and that listing keeps waiting for the owner.
async fn collect_signatures(node: St<'_>, site: &str, mut wanted: Vec<(String, String)>, wait: Duration) {
    let client = reqwest::Client::new();
    let started = Instant::now();
    while !wanted.is_empty() && started.elapsed() < wait {
        let mut left = Vec::new();
        for (nonce, id) in wanted {
            let got = client.get(format!("{site}/relay/{nonce}")).timeout(Duration::from_secs(10)).send().await;
            let signed = match got.ok().filter(|r| r.status().is_success()) {
                Some(r) => r.json::<Signed>().await.ok(),
                None => None,
            };
            match signed {
                Some(s) => {
                    if let Err(e) = crate::owner_nodes::sign_listing(node, &id, &s.signature).await {
                        eprintln!("listing: the signature the sign-in page handed back for {id} wasn't taken: {e}");
                    }
                }
                None => left.push((nonce, id)),
            }
        }
        wanted = left;
        if !wanted.is_empty() {
            tokio::time::sleep(Duration::from_secs(2).min(wait)).await;
        }
    }
    node.events.emit("activity", ());
}

/// What follows a link, by the site or by the owner's own wallet: the node is on the network from now on, if it wasn't (R1.35).
/// It tells the site (with telemetry on), says once what signing in does, and wakes what waited on it: joining the peer
/// network, which registers the identity; the agents' spending keys, granted on the chain; and listing.
pub fn linked(node: St, link: &Link) {
    tell(node, "owner_linked");
    let s = store::load_settings();
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "You".into(),
        site: String::new(),
        what: "Linked a wallet".into(),
        kind: "key".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(format!("Wallet {}. {}", short(&link.owner), signed_in_note(s.share_routes))),
    });
    SIGNED_IN.notify_waiters();
    crate::autolist::retry_now();
    if let Ok(rt) = tokio::runtime::Handle::try_current() {
        let n = node.clone();
        rt.spawn(async move { crate::agents::keep_granted(&n).await });
    }
    node.events.emit("identity", ());
    node.events.emit("activity", ());
}

fn short(a: &str) -> String {
    if a.len() > 10 {
        format!("{}…{}", &a[..6], &a[a.len() - 4..])
    } else {
        a.to_string()
    }
}

/// What signing in does, as the owner is told it once (R1.35, R2.8, R2.14a, R6.8).
pub fn signed_in_note(mode: store::ShareMode) -> String {
    let listing = match mode {
        store::ShareMode::Off => "Sharing is off, so nothing is listed until you turn it on.".to_string(),
        _ => "Withdrawals now go to your account, and the node lists and earns under it: every listing waits for you to approve it (Money in the window, or `listings_to_sign`), and nothing is shared until you do. Joining needed no sign-in: the node is on the network by itself, and lists the routes it learns there by default once they have proved themselves; they earn USDC when other agents use them, and routes learned while the node was off the network stay on it. Before the first listing the node shows which routes it will share (`unbrowse-node share`), and you can keep any of them private.".to_string(),
    };
    format!("{listing} {}", crate::autolist::EARNING_NOTE)
}

/// `link_message`: the message the owner's own wallet signs to sign in without the website (R1.13), with a nonce the
/// node draws now. Any wallet signs it as a plain message (EIP-191, `personal_sign`), on any chain.
pub fn link_message(node: St, owner: &str) -> Result<Value, String> {
    let me = crate::identity(node)?.address;
    let owner = address(owner)?;
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    let nonce = hex::encode(raw);
    waiting().wallet = Some((owner, nonce.clone()));
    Ok(json!({ "message": message(&me, &owner.to_checksum(None), &nonce), "nonce": nonce, "owner": owner.to_checksum(None) }))
}

/// `link_wallet`: signs the owner in with what their own wallet signed of `link_message`'s message: the wallet and
/// nonce must be the ones the node drew, and the signature the wallet's.
pub fn link_wallet(node: St, owner: &str, nonce: &str, signature: &str) -> Result<Value, String> {
    let me = crate::identity(node)?.address;
    let owner = address(owner)?;
    let drawn = waiting().wallet.clone();
    if drawn.as_ref() != Some(&(owner, nonce.to_string())) {
        return Err("that isn't the sign-in this node started: ask for the message again (`link_message`) and sign that".into());
    }
    verify(&me, &owner.to_checksum(None), nonce, signature)?;
    // `owner()` ran this only on the owner's yes to this wallet (`commands::asks_the_owner`), so the node seals it.
    let link = seal(node.key()?, Link { owner: owner.to_checksum(None), nonce: nonce.into(), signature: signature.into(), linked: store::now(), seal: None, vid: None })?;
    store::write_json(&path(), &unbrowse_files::LINK, &link)?;
    waiting().wallet = None;
    linked(node, &link);
    status(node)
}

/// `unlink`: forgets the owner's signature. The owner's wallet is untouched; signing in again links it again. Its
/// grants to this node's keys stay on the chain: Settlement takes `revokeAgent` only from the payer, so only the wallet
/// can revoke them (TRUST-03.6). The node stops naming the wallet as payer (`owner_nodes::follow`), so nothing here
/// draws on them, and the docs tell the owner to revoke from the wallet (docs/ONBOARDING.md §2).
pub fn unlink(node: St) -> Result<Value, String> {
    tell(node, "owner_unlinked");
    forget()?;
    node.events.emit("identity", ());
    Ok(json!({}))
}

/// Whether a linked node may tell the site anything: with its telemetry on, and on the network now. An event names the
/// owner's wallet, and off the network nothing leaves the machine, whatever the node did before (R1.35).
fn may_tell(telemetry: bool, on_network: Option<u64>) -> bool {
    telemetry && on_network.is_some()
}

/// Tells the site an event of a linked owner's node (`node_started`, `owner_linked`, `owner_unlinked`), signed by the
/// node's key and carrying the owner's link, so the site counts only what a node really sent and reads whose it is.
/// Only for a node whose owner linked it, since the owner told the site who they are by signing in, and only while
/// the node is on the network with its telemetry on (`may_tell`). Each event also carries this install's telemetry id
/// (`telemetry::install_id`) and the visitor id the sign-in handed back (`Link::vid`), so the site can join the visit,
/// the wallet, the node and the install's usage counts (UNB-179); the telemetry events themselves carry no wallet.
/// Never a site, route or input. Sent in the background: nothing waits on it and nothing fails because of it.
pub fn tell(node: St, ev: &str) {
    if !may_tell(crate::telemetry::on(), on_network(node)) {
        return;
    }
    let body = match signed(node, ev, &crate::telemetry::install_id()) {
        Ok(Some(b)) => b,
        Ok(None) => return,
        Err(e) => return eprintln!("link: {e}"),
    };
    // To the first site that answers at all; one that answers and refuses isn't asked again elsewhere.
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        for site in sites() {
            if client.post(format!("{site}/t")).json(&body).timeout(Duration::from_secs(10)).send().await.is_ok() {
                return;
            }
        }
    });
}

/// The event as the site reads it, `e` the exact text the node's key signed; `None` for a node no owner linked. `e`
/// names `install`, this install's telemetry id, and `vid`, the visitor id the sign-in handed back, when there is one.
fn signed(node: St, ev: &str, install: &str) -> Result<Option<Value>, String> {
    use alloy::signers::SignerSync;
    let me = crate::identity(node)?.address;
    let Some(l) = load(&me) else { return Ok(None) };
    let mut e = json!({ "ev": ev, "node": me.to_lowercase(), "ts": store::now(), "v": node.info.version, "os": std::env::consts::OS, "p": {}, "install": install });
    if let Some(vid) = l.vid.as_deref().filter(|v| is_vid(v)) {
        e["vid"] = json!(vid);
    }
    let e = e.to_string();
    let sig = crate::chain::owner_signer(node.key()?)?.sign_message_sync(e.as_bytes()).map_err(|e| e.to_string())?;
    let link = json!({ "owner": l.owner.to_lowercase(), "nonce": l.nonce, "sig": l.signature });
    Ok(Some(json!({ "e": e, "sig": format!("0x{}", hex::encode(sig.as_bytes())), "link": link })))
}

#[derive(Deserialize)]
struct Signed {
    owner: String,
    signature: String,
    /// The visitor id the site kept for the browser that signed, when its consent rule let it (UNB-179).
    #[serde(default)]
    vid: Option<String>,
}

/// Asks the site for what the owner signed under `nonce` until it's there, the wait runs out, or a newer sign-in
/// takes over, and checks it.
async fn collect(site: &str, me: &str, nonce: &str) -> Result<Link, String> {
    collect_for(site, me, nonce, WAIT).await
}

/// `collect`, waiting at most `wait`. An answer that never checks is refused: it is said when the wait ends.
async fn collect_for(site: &str, me: &str, nonce: &str, wait: Duration) -> Result<Link, String> {
    let client = reqwest::Client::new();
    let started = Instant::now();
    let mut last = None;
    while started.elapsed() < wait {
        if waiting().nonce.as_deref() != Some(nonce) {
            return Err("a newer sign-in took over".into());
        }
        let got = client.get(format!("{site}/relay/{nonce}")).timeout(Duration::from_secs(10)).send().await;
        if let Some(r) = got.ok().filter(|r| r.status().is_success()) {
            // An answer that doesn't read or doesn't check is one bad answer from the relay, which the owner can't see:
            // their wait goes on, and it is said if nothing better comes.
            match r.json::<Signed>().await.map_err(|e| format!("the site's answer: {e}")).and_then(|s| relayed(me, nonce, s)) {
                Ok(link) => return Ok(link),
                Err(e) => last = Some(e),
            }
        }
        tokio::time::sleep(Duration::from_secs(2).min(wait)).await;
    }
    Err(last.unwrap_or_else(|| "the sign-in wasn't finished in 15 minutes; start it again".into()))
}

/// The link a relay's answer makes, when what it carries is `me`'s link under `nonce`.
fn relayed(me: &str, nonce: &str, s: Signed) -> Result<Link, String> {
    verify(me, &s.owner, nonce, &s.signature)?;
    let vid = s.vid.filter(|v| is_vid(v));
    Ok(Link { owner: address(&s.owner)?.to_checksum(None), nonce: nonce.into(), signature: s.signature, linked: store::now(), seal: None, vid })
}

/// Keeps the link a sign-in page answered with, once the owner confirmed the wallet it names in a dialog the node opens
/// itself, showing that address. The signature alone can't say the wallet is the owner's: whoever serves the sign-in
/// page reads the nonce from it, so a site that isn't ours (`UNBROWSE_SITE`, or one that took the page over) can sign
/// with its own wallet, and the node would pay its withdrawals out to that. A link the owner didn't confirm is never
/// kept; a wallet the owner names themselves (`link_message`, `link_wallet`) needs no dialog.
async fn keep_once_confirmed(keys: Option<&(dyn unbrowse_core::KeyStore + Send + Sync)>, link: Link) -> Result<Link, String> {
    let question = format!(
        "Link this wallet to this Unbrowse node?\n\n{}\n\nThe node's withdrawals will go to it. Check it is your own wallet's address, as your wallet shows it, and allow it only then.",
        link.owner
    );
    crate::owner_dialog::ask(keys, question).await.map_err(|e| format!("the sign-in page answered with the wallet {}, which you didn't confirm, so it isn't linked ({e})", link.owner))?;
    let link = match keys {
        Some(k) => seal(k, link)?,
        None => link,
    };
    store::write_json(&path(), &unbrowse_files::LINK, &link)?;
    Ok(link)
}

/// Opens `url` in the owner's default browser. A test's node opens nothing: the test is the browser.
pub(crate) fn open(url: &str) -> std::io::Result<()> {
    if cfg!(test) {
        return Err(std::io::Error::other("a test opens no browser"));
    }
    let os = if cfg!(target_os = "macos") {
        Os::Mac
    } else if cfg!(windows) {
        Os::Windows
    } else {
        Os::Other
    };
    opener(os, url)?.spawn().map(|_| ())
}

/// The platforms the opener differs on.
#[derive(Clone, Copy, Debug)]
enum Os {
    Mac,
    Windows,
    Other,
}

/// The program that opens `url` in the owner's default browser on `os`, the URL handed to it as one argument and never
/// through a shell: a shell reads `&`, `|` and `^` in a URL as its own, and the rest of the URL would run as a command.
/// Only a web address is opened, written as the URL parser writes it, so nothing in it reads as one of the program's
/// own options.
fn opener(os: Os, url: &str) -> std::io::Result<std::process::Command> {
    let parsed = url::Url::parse(url).map_err(|e| std::io::Error::other(format!("{url}: {e}")))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(std::io::Error::other(format!("{url} isn't a web address: the node opens only those")));
    }
    let mut c = match os {
        Os::Mac => std::process::Command::new("open"),
        // The URL protocol handler itself, run with the URL as its argument: no `cmd /C start`, whose `&` ends the
        // command.
        Os::Windows => {
            let mut c = std::process::Command::new("rundll32.exe");
            c.arg("url.dll,FileProtocolHandler");
            c
        }
        Os::Other => std::process::Command::new("xdg-open"),
    };
    c.arg(parsed.as_str());
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::signers::local::PrivateKeySigner;
    use alloy::signers::SignerSync;

    use super::SIGN_IN_TESTS as RELAY_TESTS;

    /// The signing page carries each listing with a nonce of its own, the typed data its wallet signs whole, and the
    /// wallet that must sign, all in the fragment, which no server logs.
    #[test]
    fn the_signing_page_carries_each_listing_under_a_nonce_of_its_own() {
        let item = |id: &str| crate::listing::ToSign {
            id: id.into(),
            route_id: "r1".into(),
            site: "shop.example".into(),
            description: "Search & find: \"items\"".into(),
            version: 1,
            price_usdc: None,
            wallet: "0xFEED".into(),
            what: "Share your route".into(),
            typed_data: json!({ "primaryType": "Listing", "message": { "version": "4294967297" } }),
        };
        let items = vec![(nonce().unwrap(), item("0x01")), (nonce().unwrap(), item("0x02"))];
        let url = sign_page("https://unbrowse.ai", "0xABC", "0xFEED", &items);
        let (page, fragment) = url.split_once('#').unwrap();
        assert_eq!(page, "https://unbrowse.ai/link/");
        let field = |k: &str| fragment.split('&').find_map(|p| p.strip_prefix(&format!("{k}="))).unwrap().to_string();
        assert_eq!((field("node"), field("wallet")), ("0xabc".to_string(), "0xfeed".to_string()));
        let sign: Vec<Value> = serde_json::from_str(&percent_encoding::percent_decode_str(&field("sign")).decode_utf8().unwrap()).unwrap();
        assert_eq!(sign.len(), 2);
        assert_ne!(sign[0]["nonce"], sign[1]["nonce"], "one nonce each: the relay keeps one answer under each");
        assert_eq!(sign[0]["typed_data"], items[0].1.typed_data);
        assert_eq!(sign[0]["nonce"], items[0].0.as_str());
        assert!(!fragment.contains('"') && !fragment.contains(' '), "nothing in it that a browser reads otherwise");
    }

    fn signed(owner: &PrivateKeySigner, node: &str, nonce: &str) -> String {
        let sig = owner.sign_message_sync(message(node, &owner.address().to_string(), nonce).as_bytes()).unwrap();
        format!("0x{}", hex::encode(sig.as_bytes()))
    }

    #[test]
    fn the_owners_signature_links_the_node_it_names() {
        let owner = PrivateKeySigner::random();
        let node = PrivateKeySigner::random().address().to_string();
        let sig = signed(&owner, &node, "ab12");
        assert!(verify(&node, &owner.address().to_string(), "ab12", &sig).is_ok());
        // Casing is not part of what was signed.
        assert!(verify(&node.to_lowercase(), &owner.address().to_string().to_uppercase().replacen("0X", "0x", 1), "ab12", &sig).is_ok());
    }

    /// Signed in a browser with viem's signMessage over the sign-in page's text (the site's src/link/message.ts), keys
    /// 0x11…11 for the node and 0x22…22 for the owner: the page and the node write the same message.
    #[test]
    fn a_link_the_sign_in_page_signed_checks_here() {
        let sig = "0x52c571f1bbbad0dbfe6c5620a917643776d1315dbc4d2a062ab814673e5512f5225121b56ab039fb1f8a6ce0920b1323f9e3c6b0d9ca86d255bafbf5705c74a41c";
        assert!(verify("0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A", "0x1563915e194D8CfBA1943570603F7606A3115508", "0123456789abcdef0123456789abcdef", sig).is_ok());
    }

    /// The node asks the relay until the owner has signed, then takes the link only if it checks.
    #[tokio::test]
    async fn the_node_collects_what_the_owner_signed_once_it_is_there() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let owner = PrivateKeySigner::random();
        let node = PrivateKeySigner::random().address().to_string();
        let nonce = "00112233445566778899aabbccddeeff";
        let body = json!({ "owner": owner.address().to_string(), "signature": signed(&owner, &node, nonce) });
        let asked = Arc::new(AtomicUsize::new(0));
        let a = asked.clone();
        // Not signed yet on the first ask; signed from the second.
        let app = axum::Router::new().route(
            "/relay/{nonce}",
            axum::routing::get(move || {
                let (a, body) = (a.clone(), body.clone());
                async move {
                    if a.fetch_add(1, Ordering::SeqCst) == 0 { Err(axum::http::StatusCode::NOT_FOUND) } else { Ok(axum::Json(body)) }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let site = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let _turn = RELAY_TESTS.lock().await;
        waiting().nonce = Some(nonce.into());
        let link = collect(&site, &node, nonce).await.unwrap();
        assert_eq!(link.owner, owner.address().to_checksum(None));
        assert_eq!(asked.load(Ordering::SeqCst), 2);
        // A relay answering for another node's link is refused.
        let other = PrivateKeySigner::random().address().to_string();
        let refused = collect_for(&site, &other, nonce, Duration::from_millis(300)).await.unwrap_err();
        assert!(refused.contains("signature"), "{refused}");
        *waiting() = Waiting::default();
    }

    /// External security review round 2, 2026-11-04, item 6. Whoever answers for the sign-in site (`UNBROWSE_SITE`, or
    /// a site that took the page over) reads the nonce from the page it serves, so it can answer the relay with a link
    /// its own wallet signed, and the signature checks. The node keeps that wallet, where withdrawals go, only once the
    /// owner confirmed its address in the node's own dialog; no dialog, or a no, and nothing is linked.
    #[test]
    fn a_wallet_the_site_answers_with_is_linked_only_once_the_owner_confirms_it() {
        let home = crate::store::scratch_home("link-confirm");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let thief = PrivateKeySigner::random();
        let node = PrivateKeySigner::random().address().to_string();
        let nonce = "ffeeddccbbaa99887766554433221100";
        // What the relay answers: the thief's own wallet, signed over this node and the nonce the page showed it.
        let signature = signed(&thief, &node, nonce);
        verify(&node, &thief.address().to_string(), nonce, &signature).expect("the site's own signature checks: the dialog is what stops it");
        let link = Link { owner: thief.address().to_checksum(None), nonce: nonce.into(), signature, linked: store::now(), seal: None, vid: None };
        for answer in [None, Some(false)] {
            crate::owner_dialog::answer_in_test(answer);
            let refused = rt.block_on(keep_once_confirmed(None, link.clone())).unwrap_err();
            assert!(refused.contains(&link.owner) && refused.contains("isn't linked"), "{refused}");
            assert_eq!(load(&node), None, "nothing linked without the owner's yes");
        }
        assert!(crate::owner_dialog::asked_in_test().iter().all(|q| q.contains(&thief.address().to_checksum(None))), "the dialog shows the address");
        crate::owner_dialog::answer_in_test(Some(true));
        rt.block_on(keep_once_confirmed(None, link.clone())).unwrap();
        assert_eq!(load(&node).map(|l| l.owner), Some(thief.address().to_checksum(None)), "the owner said yes to it");
        let _ = std::fs::remove_dir_all(home);
    }

    /// External security review round 2, 2026-11-04, item 4. On a node with no screen, the wallet a sign-in page
    /// answered with is linked once the owner allows it with the owner passphrase on a terminal, and never without.
    #[test]
    fn a_node_with_no_screen_links_a_sites_wallet_only_on_the_owner_passphrase() {
        let home = crate::store::scratch_home("link-no-screen");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || crate::store::use_home(&h)).build().unwrap();
        let keys: &'static unbrowse_core::MemoryStore = Box::leak(Box::default());
        unbrowse_core::load_or_create(keys).unwrap();
        let owners = "the owner's own words";
        crate::owner_dialog::keep_passphrase(&unbrowse_core::owner_pass::Record::new_with(&unbrowse_core::RootKey::load(keys).unwrap(), owners, 10).unwrap()).unwrap();
        let wallet = PrivateKeySigner::random();
        let node = PrivateKeySigner::random().address().to_string();
        let nonce = "00112233445566778899aabbccddeeff";
        let link = Link { owner: wallet.address().to_checksum(None), nonce: nonce.into(), signature: signed(&wallet, &node, nonce), linked: store::now(), seal: None, vid: None };
        for passphrase in [None, Some(owners)] {
            let l = link.clone();
            let task = rt.spawn(async move { keep_once_confirmed(Some(keys), l).await });
            let since = std::time::Instant::now();
            let id = loop {
                if let Some(c) = crate::owner_dialog::confirmations().into_iter().find(|c| c.question.contains(&link.owner)) {
                    break c.id;
                }
                assert!(since.elapsed().as_secs() < 10, "the node with no screen never waited on the owner's passphrase");
                std::thread::sleep(std::time::Duration::from_millis(20));
            };
            rt.block_on(crate::owner_dialog::confirm(id, passphrase.map(String::from))).unwrap();
            let kept = rt.block_on(task).unwrap();
            match passphrase {
                None => {
                    assert!(kept.is_err());
                    assert_eq!(load(&node), None, "refused on the terminal: nothing linked");
                }
                Some(_) => {
                    kept.unwrap();
                    assert_eq!(load(&node).map(|l| l.owner), Some(link.owner.clone()), "the owner allowed it");
                }
            }
        }
        let _ = std::fs::remove_dir_all(home);
    }

    /// External security review round 3, 2026-11-04. A program running as the owner can write the link file itself,
    /// naming a wallet of its own with that wallet's own signature, which checks out. The node pays a withdrawal only to
    /// a wallet it sealed as the owner's when the owner confirmed it: a link it didn't seal waits on the owner's yes,
    /// showing the address, and a no withdraws nothing. Once allowed it is sealed and asks no more; a seal moved onto
    /// another wallet's link opens nothing.
    #[test]
    fn a_link_file_the_node_did_not_write_takes_no_withdrawal_until_the_owner_confirms_it() {
        let home = store::scratch_home("link-sealed");
        let node = crate::testchain::node("link-sealed");
        let me = crate::identity(&node).unwrap().address;
        let thief = PrivateKeySigner::random();
        let forged = Link { owner: thief.address().to_checksum(None), nonce: "n-1".into(), signature: signed(&thief, &me, "n-1"), linked: store::now(), seal: None, vid: None };
        store::write_json(&path(), &unbrowse_files::LINK, &forged).unwrap();
        assert!(signed_in(&node).is_some(), "the wallet's own signature checks out: only the node's seal tells it apart");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for answer in [None, Some(false)] {
            crate::owner_dialog::answer_in_test(answer);
            assert!(rt.block_on(payout(&node)).is_err(), "no yes, no withdrawal to {}", forged.owner);
        }
        assert!(crate::owner_dialog::asked_in_test().iter().all(|q| q.contains(&forged.owner)), "the question shows the wallet");
        crate::owner_dialog::answer_in_test(Some(true));
        assert_eq!(rt.block_on(payout(&node)).unwrap(), Some(thief.address()), "the owner's yes");
        crate::owner_dialog::answer_in_test(None);
        assert_eq!(rt.block_on(payout(&node)).unwrap(), Some(thief.address()), "sealed once allowed");
        assert_eq!(crate::owner_dialog::asked_in_test().len(), 3, "and not asked again");
        // The seal names its wallet: on another wallet's link it opens nothing.
        let other = PrivateKeySigner::random();
        let moved = Link { owner: other.address().to_checksum(None), signature: signed(&other, &me, "n-1"), ..load(&me).unwrap() };
        assert!(moved.seal.is_some());
        store::write_json(&path(), &unbrowse_files::LINK, &moved).unwrap();
        assert!(rt.block_on(payout(&node)).is_err(), "a moved seal");
        let _ = std::fs::remove_dir_all(home);
    }

    /// UNBROWSE_SITE at run time goes first, then the build's site, then the public ones, each once.
    #[test]
    fn the_site_set_at_run_time_then_the_builds_come_first() {
        assert_eq!(sites_from(None, None), ["https://unbrowse.ai", "https://unbrowse.si"]);
        assert_eq!(sites_from(None, Some("https://staging.unbrowse.ai/")), ["https://staging.unbrowse.ai", "https://unbrowse.ai", "https://unbrowse.si"]);
        assert_eq!(sites_from(Some("http://127.0.0.1:8787"), Some("https://staging.unbrowse.ai")), ["http://127.0.0.1:8787", "https://staging.unbrowse.ai", "https://unbrowse.ai", "https://unbrowse.si"]);
        assert_eq!(sites_from(Some("https://unbrowse.ai"), None), ["https://unbrowse.ai", "https://unbrowse.si"], "each once");
        assert_eq!(sites_from(Some(""), None).len(), 2, "an empty one is none");
    }

    /// The sign-in page names the node and the nonce, and the chain to fund the node on when it can't pay its gas,
    /// in the fragment only. Nothing asks the site for money: no sponsor and no grant (spec §76).
    #[test]
    fn the_sign_in_page_carries_the_node_the_nonce_and_what_to_fund() {
        let node = "0xAbC0000000000000000000000000000000000001";
        let url = page("https://unbrowse.ai", node, "n1", None);
        assert_eq!(url, "https://unbrowse.ai/link/#node=0xabc0000000000000000000000000000000000001&nonce=n1");
        let short = page("https://unbrowse.ai", node, "n1", Some(5042002));
        assert_eq!(short, "https://unbrowse.ai/link/#node=0xabc0000000000000000000000000000000000001&nonce=n1&fund=5042002");
        assert!(!short.split('#').next().unwrap().contains("fund"), "nothing of it before the fragment");
        assert!(!short.contains("sponsor") && !short.contains("grant"));
    }

    /// The page carries the grants the wallet sends with its signature, or alone to renew, in the fragment only.
    #[test]
    fn the_sign_in_page_carries_the_grants_the_wallet_sends() {
        let g = PageGrant { chain_id: 5042002, settlement: "0xAB00000000000000000000000000000000000001".into(), agent: "0xCD00000000000000000000000000000000000002".into(), cap_units: "5000000".into(), expiry: 1796090401 };
        let url = page_with("https://unbrowse.ai", "0xEF00000000000000000000000000000000000003", "n1", None, &[g.clone(), PageGrant { agent: "0xcd00000000000000000000000000000000000004".into(), ..g.clone() }], false);
        assert_eq!(url, "https://unbrowse.ai/link/#node=0xef00000000000000000000000000000000000003&nonce=n1&grants=5042002:0xab00000000000000000000000000000000000001:0xcd00000000000000000000000000000000000002:5000000:1796090401,5042002:0xab00000000000000000000000000000000000001:0xcd00000000000000000000000000000000000004:5000000:1796090401");
        let renew = page_with("https://unbrowse.ai", "0xEF00000000000000000000000000000000000003", "n2", None, &[g], true);
        assert!(renew.ends_with("&renew=1") && !renew.split('#').next().unwrap().contains("grants"));
    }

    /// A node the owner keeps off the network is local: it joins nothing and writes nothing to the chain, its first agent
    /// key working on this machine alone. With the peer network on it is on the network on its own wallet, with no
    /// sign-in (spec §86): it may join (which registers its identity from that wallet), and its agent key is granted on
    /// the chain with its cap, never shown to the owner. Linking a wallet after changes when it went on the network not
    /// at all.
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn a_node_goes_on_the_network_on_its_own_wallet_with_no_sign_in() {
        let _one = crate::testchain::one_at_a_time().await;
        crate::testchain::home("own-wallet");
        crate::testchain::keep_local();
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let node = crate::testchain::node("own-wallet");
        set_node(&crate::identity(&node).unwrap().address);
        node.chain.start().await.expect("the devnet");
        let keys = node.key().unwrap();
        crate::agents::ensure_first(keys, 0).unwrap().expect("the first key");
        assert!(on_network(&node).is_none());
        assert_eq!(crate::health::to_join(&node).unwrap_err(), crate::health::LOCAL, "a local node joins nothing");
        crate::agents::keep_granted(&node).await;
        assert_eq!(crate::chain::agent_grant(&node.chain, keys, 0).await.unwrap(), None, "nothing written while local");

        let mut s = store::load_settings();
        s.peer_network = true;
        store::save_settings(&s).unwrap();
        let since = on_network(&node).expect("on the network");
        assert!(signed_in(&node).is_none(), "no wallet linked");
        assert!(crate::health::to_join(&node).is_ok(), "on its own wallet, it joins");
        crate::agents::keep_granted(&node).await;
        let (cap, expiry) = crate::chain::agent_grant(&node.chain, keys, 0).await.unwrap().expect("granted on joining");
        assert_eq!(cap, crate::agents::AUTO_CAP_USDC);
        assert!(expiry > crate::store::now());
        assert!(crate::agents::list()[0].tx.is_some(), "its grant's transaction kept");

        // A wallet the node didn't draw a nonce for, or a signature over another nonce, links no one.
        let owner = PrivateKeySigner::random();
        let me = crate::identity(&node).unwrap().address;
        assert!(link_wallet(&node, &owner.address().to_string(), "00", &signed(&owner, &me, "00")).is_err(), "a nonce the node never drew");
        crate::testchain::sign_in(&node);
        assert!(signed_in(&node).expect("linked").linked >= since);
        assert_eq!(on_network(&node), Some(since), "linking doesn't move when it joined");
    }

    #[test]
    fn a_node_turned_off_after_joining_is_off_though_it_keeps_the_day_it_joined() {
        store::scratch_home("off-after-joining");
        let node = PrivateKeySigner::random().address().to_string();
        store::save_settings(&crate::terms::acknowledged(store::Settings::default(), false)).unwrap();
        note_joined(&node);
        let since = on_network_since(&node);
        assert!(since.is_some(), "on the network");
        assert_eq!(on_now(since, crate::network_on()), since, "on while the owner keeps it on");
        let mut s = store::load_settings();
        s.peer_network = false;
        store::save_settings(&s).unwrap();
        assert_eq!(on_network_since(&node), since, "the day it joined stands");
        assert_eq!(on_now(since, crate::network_on()), None, "and it counts as off");
    }

    #[test]
    fn a_node_off_the_network_tells_the_site_nothing() {
        assert!(may_tell(true, Some(1)));
        assert!(!may_tell(false, Some(1)), "telemetry off");
        assert!(!may_tell(true, None), "off the network, even linked");
    }

    #[test]
    fn unlinking_never_moves_the_day_a_node_joined() {
        store::scratch_home("unlink-keeps-the-day");
        let (owner, node) = (PrivateKeySigner::random(), PrivateKeySigner::random().address().to_string());
        let link = Link { owner: owner.address().to_string(), nonce: "ab12".into(), signature: signed(&owner, &node, "ab12"), linked: 1000, seal: None, vid: None };
        store::write_json(&path(), &unbrowse_files::LINK, &link).unwrap();
        store::save_settings(&crate::terms::acknowledged(store::Settings::default(), false)).unwrap();
        assert_eq!(on_network_since(&node), Some(1000), "joined when it linked");
        note_joined(&node);
        forget().unwrap();
        assert_eq!(on_network_since(&node), Some(1000));
    }

    /// UNB-179: the sign-in page's relay hands back the site's visitor id with the signature. The node keeps one only in
    /// the site's shape, and its signed events to the site name it and this install's telemetry id inside the text its
    /// key signed, so the site can join the visit to the node and the install; a link with no visitor id names none.
    #[test]
    fn a_signed_event_names_the_install_and_the_visitor_the_sign_in_handed_back() {
        use std::str::FromStr;
        let home = store::scratch_home("link-vid");
        let node = crate::testchain::node("vid");
        let me = crate::identity(&node).unwrap().address;
        set_node(&me);
        let owner = PrivateKeySigner::random();
        let nonce = "00112233445566778899aabbccddeeff";
        let vid = format!("v_{}", "0123456789abcdef".repeat(2));
        let relay = |v: Option<&str>| Signed { owner: owner.address().to_string(), signature: signed(&owner, &me, nonce), vid: v.map(String::from) };
        // Anything but the site's shape is dropped: never kept, never sent back.
        for bad in ["v_0123", "V_0123456789abcdef0123456789abcdef", &format!("v_{}", "0123456789ABCDEF".repeat(2)), &format!("{vid}0"), "https://example.com/?v_0123456789abcdef0123456789abcdef"] {
            assert_eq!(relayed(&me, nonce, relay(Some(bad))).unwrap().vid, None, "{bad}");
        }
        assert_eq!(relayed(&me, nonce, relay(None)).unwrap().vid, None, "a site that kept no id hands back none");
        let link = relayed(&me, nonce, relay(Some(&vid))).unwrap();
        assert_eq!(link.vid.as_deref(), Some(vid.as_str()));
        store::write_json(&path(), &unbrowse_files::LINK, &link).unwrap();
        assert_eq!(load(&me).unwrap().vid.as_deref(), Some(vid.as_str()), "kept with the link");

        let install = "ab".repeat(16);
        let body = super::signed(&node, "owner_linked", &install).unwrap().expect("a linked node's event");
        let text = body["e"].as_str().unwrap();
        let e: Value = serde_json::from_str(text).unwrap();
        assert_eq!(e["ev"], "owner_linked");
        assert_eq!(e["install"], install.as_str(), "the install's telemetry id");
        assert_eq!(e["vid"], vid.as_str(), "the visitor id the sign-in handed back");
        let by = Signature::from_str(body["sig"].as_str().unwrap()).unwrap().recover_address_from_msg(text.as_bytes()).unwrap();
        assert_eq!(by.to_checksum(None).to_lowercase(), me.to_lowercase(), "both inside what the node's key signed");
        assert_eq!(body["link"]["nonce"], nonce, "with the owner's link, by which the site finds its record of the sign-in");

        // A link file another program wrote with a visitor id off the site's shape: it isn't sent.
        store::write_json(&path(), &unbrowse_files::LINK, &Link { vid: Some("v_not-the-sites".into()), ..link.clone() }).unwrap();
        let e: Value = serde_json::from_str(super::signed(&node, "node_started", &install).unwrap().unwrap()["e"].as_str().unwrap()).unwrap();
        assert!(e.get("vid").is_none(), "{e}");
        // A link made without the site (the owner's own wallet) names no visitor; an old link file reads the same.
        store::write_json(&path(), &unbrowse_files::LINK, &Link { vid: None, ..link }).unwrap();
        let e: Value = serde_json::from_str(super::signed(&node, "node_started", &install).unwrap().unwrap()["e"].as_str().unwrap()).unwrap();
        assert!(e.get("vid").is_none(), "{e}");
        assert_eq!(e["install"], install.as_str());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn only_a_link_the_node_sealed_is_a_confirmed_wallet() {
        store::scratch_home("confirmed-wallet");
        let keys = unbrowse_core::MemoryStore::default();
        let me = unbrowse_core::load_or_create(&keys).unwrap().address.to_checksum();
        let attacker = PrivateKeySigner::random();
        let link = Link { owner: attacker.address().to_string(), nonce: "ab12".into(), signature: signed(&attacker, &me, "ab12"), linked: 1, seal: None, vid: None };
        store::write_json(&path(), &unbrowse_files::LINK, &link).unwrap();
        assert!(load(&me).is_some(), "the wallet's own signature checks");
        assert_eq!(confirmed(&keys), None, "and that is no confirmation");
        store::write_json(&path(), &unbrowse_files::LINK, &Link { seal: Some("00".repeat(32)), ..link.clone() }).unwrap();
        assert_eq!(confirmed(&keys), None, "nor is a seal another program made up");
        store::write_json(&path(), &unbrowse_files::LINK, &seal(&keys, link).unwrap()).unwrap();
        assert_eq!(confirmed(&keys), Some(attacker.address()), "the owner's yes is");
    }

    #[test]
    fn a_sign_in_that_loses_its_place_keeps_the_others_wait() {
        let wallet: Address = "0x00000000000000000000000000000000000000a1".parse().unwrap();
        let mut w = Waiting { wallet: Some((wallet, "cd34".into())), ..Waiting::default() };
        w.began("one");
        assert_eq!(w.wallet, Some((wallet, "cd34".into())), "a wallet being signed with is no earlier website sign-in");
        w.began("two");
        assert!(!w.ended("one", None), "a newer sign-in took over");
        assert_eq!(w.nonce.as_deref(), Some("two"), "and it keeps waiting");
        assert!(w.ended("two", Some(&"it failed".to_string())));
        assert_eq!((w.nonce, w.error, w.wallet), (None, Some("it failed".to_string()), Some((wallet, "cd34".into()))));
    }

    /// One bad answer from the relay never ends the owner's wait: the next good one is taken.
    #[tokio::test]
    async fn a_bad_answer_from_the_relay_leaves_the_wait_going() {
        use axum::routing::get;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (owner, me) = (PrivateKeySigner::random(), PrivateKeySigner::random().address().to_string());
        let good = json!({ "owner": owner.address().to_string(), "signature": signed(&owner, &me, "ef56") }).to_string();
        let asked = std::sync::Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new().route("/relay/ef56", get(move || {
            let n = asked.fetch_add(1, Ordering::SeqCst);
            let good = good.clone();
            async move { if n == 0 { "<html>not this</html>".to_string() } else { good } }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let site = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let _turn = RELAY_TESTS.lock().await;
        waiting().began("ef56");
        let link = collect(&site, &me, "ef56").await.expect("the good answer is taken");
        assert_eq!(link.owner, owner.address().to_checksum(None));
        *waiting() = Waiting::default();
    }

    #[test]
    fn a_link_for_another_node_nonce_or_owner_is_refused() {
        let owner = PrivateKeySigner::random();
        let node = PrivateKeySigner::random().address().to_string();
        let other = PrivateKeySigner::random().address().to_string();
        let sig = signed(&owner, &node, "ab12");
        assert!(verify(&other, &owner.address().to_string(), "ab12", &sig).is_err(), "another node");
        assert!(verify(&node, &owner.address().to_string(), "cd34", &sig).is_err(), "another nonce");
        assert!(verify(&node, &other, "ab12", &sig).is_err(), "someone else named as owner");
        assert!(verify(&node, &owner.address().to_string(), "ab12", "0x1234").is_err(), "not a signature");
    }

    /// A URL reaches the program that opens it whole, as one argument, on every platform: never through a shell, where
    /// the `&` between a sign-in page's values would end the command and run the rest. What isn't a web address isn't
    /// opened at all.
    #[test]
    fn a_url_with_ampersands_reaches_the_opener_whole() {
        let url = "https://unbrowse.ai/link#node=0xabc&nonce=12&fund=1|calc^&x";
        for os in [Os::Mac, Os::Windows, Os::Other] {
            let c = opener(os, url).unwrap();
            let program = c.get_program().to_string_lossy().to_ascii_lowercase();
            assert!(!["cmd", "cmd.exe", "sh", "bash", "powershell", "pwsh"].contains(&program.as_str()), "{os:?}: {program}");
            let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
            let last = args.last().cloned().unwrap_or_default();
            assert_eq!(url::Url::parse(&last).unwrap(), url::Url::parse(url).unwrap(), "{os:?}: the URL is one argument, whole: {args:?}");
            assert!(args.iter().filter(|a| a.contains("nonce=12")).count() == 1 && last.contains("&fund=1"), "{os:?}: {args:?}");
        }
        for not_web in ["-a Calculator", "file:///etc/passwd", "javascript:alert(1)", "x&calc"] {
            assert!(opener(Os::Windows, not_web).is_err() && opener(Os::Mac, not_web).is_err(), "{not_web}");
        }
    }
}
