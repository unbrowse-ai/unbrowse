//! Network route discovery, paying for a route's body, and receipts.
//!
//! Alongside its own routes, a search asks the peer network for the site the agent named (`peers`),
//! and otherwise queries the chain for entries other nodes listed, ranked by how well they match
//! the agent's words and by price, cheapest first: the role an index node plays.
//! A network route runs on the caller's own node: it fetches the route's body from a node that holds it, paying with a
//! body voucher the serving node checks against the chain before it releases the body (`share`), and the use's receipt
//! line goes to the contributor.
//!
//! Node ads live in a shared folder on devnet, standing in for each identity's ERC-8004 metadata
//! (`unbrowse.peerId`, `unbrowse.addrs`); on Arc they move on chain (`setMetadata`).

use std::path::PathBuf;
use std::sync::Mutex;

use alloy::primitives::{keccak256, Address, FixedBytes, Signature as PrimitiveSig, U256};
use alloy::signers::SignerSync;
use alloy::sol_types::{Eip712Domain, SolStruct};
use serde::{Deserialize, Serialize};
use unbrowse_core::KeyStore;

use crate::{chain, rank, store};
use crate::sync::Locked;

// ---- node discovery ----

/// Where nodes on this machine advertise their endpoints, so other nodes can find them.
pub fn network_dir() -> PathBuf {
    std::env::var_os("UNBROWSE_NETWORK_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            unbrowse_files::private::user_home().join(".unbrowse-network")
        })
}

/// What a node writes when it starts, so other nodes can reach it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct NodeAd {
    pub address: String,
    pub endpoint: String,
    pub name: String,
    pub at: u64,
    /// The node's peer ID in the peer network, once it has joined.
    #[serde(default)]
    pub peer_id: String,
    /// Where the node listens in the peer network.
    #[serde(default)]
    pub addrs: Vec<String>,
    /// Whether the node posts the reserve's listing roots (R2.20): a node with no gas sends its leaves to it.
    #[serde(default)]
    pub reserve: bool,
}

fn ad_path(address: &str) -> PathBuf {
    network_dir().join(format!("{}.json", address.to_lowercase().trim_start_matches("0x")))
}

/// Every node ad on this machine.
pub fn ads() -> Vec<NodeAd> {
    let Ok(dir) = std::fs::read_dir(network_dir()) else { return vec![] };
    dir.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| store::read_json::<NodeAd>(&e.path(), &unbrowse_files::NODE_AD))
        .filter(|ad| !ad.address.is_empty())
        .collect()
}

/// The ad of the node run by this address, if it has one.
pub fn ad_of(address: &str) -> Option<NodeAd> {
    let ad: NodeAd = store::read_json(&ad_path(address), &unbrowse_files::NODE_AD);
    Some(ad).filter(|a| !a.address.is_empty())
}

/// Announces this node's endpoint so other nodes on this machine can find it.
pub fn advertise(address: &str, port: u16, name: &str) -> Result<(), String> {
    keep_private(&network_dir())?;
    let addr = address.to_lowercase();
    let ad = NodeAd {
        address: addr.clone(),
        endpoint: format!("http://127.0.0.1:{port}"),
        name: name.into(),
        at: store::now(),
        reserve: crate::reserve::poster_on(),
        ..Default::default()
    };
    store::write_json(&ad_path(&addr), &unbrowse_files::NODE_AD, &ad)
}

/// Makes `dir`, the folder node ads are shared through, the owner's alone (0700), one made before as well: the nodes
/// that read it run as this user, and nobody else on the machine needs to see which nodes run here, or their ports.
/// Each ad in it is written the owner's alone too (`store::write_json`).
fn keep_private(dir: &std::path::Path) -> Result<(), String> {
    unbrowse_files::private::dir_at(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    unbrowse_files::private::narrow(dir).map_err(|e| format!("{}: {e}", dir.display()))
}

/// Adds the node's peer ID and listen addresses to its ad: on Arc, `setMetadata` with `unbrowse.peerId` and
/// `unbrowse.addrs` (R1.15).
pub fn advertise_peer(address: &str, peer_id: &str, addrs: &[String]) -> Result<(), String> {
    let mut ad = ad_of(address).ok_or("advertise the node first")?;
    ad.peer_id = peer_id.into();
    ad.addrs = addrs.to_vec();
    store::write_json(&ad_path(address), &unbrowse_files::NODE_AD, &ad)
}

/// Finds a node's HTTP endpoint by its on-chain address. An ad is only a file in a shared folder and an endpoint
/// only whatever holds that port now, so nothing is sent there until `proven` says it is that address's node.
pub fn find_endpoint(address: &str) -> Option<String> {
    ad_of(address).map(|ad| ad.endpoint).filter(|e| !e.is_empty())
}

/// What a node signs with its owner's key to show it is the node on `port`: a challenge the asker chose, so an old
/// answer is no answer, and the port, so a node can't be made to vouch for a listener on another.
pub fn endpoint_digest(port: u16, challenge: &FixedBytes<32>) -> FixedBytes<32> {
    keccak256([b"unbrowse/endpoint\n".as_slice(), &port.to_be_bytes(), challenge.as_slice()].concat())
}

/// Asks the node at `endpoint` to sign a fresh challenge, and checks the owner's key that signed it is `owner`'s.
pub async fn proven(endpoint: &str, owner: Address) -> Result<(), String> {
    let port = url::Url::parse(endpoint).ok().and_then(|u| u.port_or_known_default()).ok_or_else(|| format!("{endpoint} isn't an address"))?;
    let mut c = [0u8; 32];
    getrandom::fill(&mut c).map_err(|e| e.to_string())?;
    let challenge = FixedBytes::from(c);
    let answer: serde_json::Value = reqwest::Client::new()
        .get(format!("{endpoint}/v1/node/proof"))
        .query(&[("challenge", format!("{challenge:#x}")), ("key", format!("{owner:#x}"))])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("the node at {endpoint} didn't prove who it is: {e}"))?
        .json()
        .await
        .map_err(|e| format!("the node at {endpoint} didn't prove who it is: {e}"))?;
    let sig = answer.get("signature").and_then(|v| v.as_str()).unwrap_or_default();
    match recover_signer(&endpoint_digest(port, &challenge), sig) {
        Ok(a) if a == owner => Ok(()),
        _ => Err(format!("what answers at {endpoint} isn't the node of {owner:#x}")),
    }
}

// ---- network route search ----

/// A route available on the network from another node.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NetworkRoute {
    /// The entry's id on the chain (hex, `0x` prefix).
    pub entry_id: String,
    /// The domain the route serves.
    pub domain: String,
    /// What the route does, in the contributor's words.
    pub description: String,
    /// The contributor node's on-chain address (hex, `0x` prefix).
    pub contributor: String,
    /// The fee in USDC for one call.
    pub fee: f64,
}

/// What a network route is found by: its site and what it does. Its answer's fields aren't listed, so they don't count.
pub fn doc_of(r: &NetworkRoute) -> rank::Doc {
    rank::Doc::plain(&format!("{} {}", r.domain, r.description))
}

/// Searches the chain for live entries that match the query, excluding this node's own: best match first
/// (`rank`), the cheapest first among equals.
pub async fn search_network(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), query: &str) -> Result<Vec<NetworkRoute>, String> {
    let me = chain::owner_address(keys)?;
    let mut routes: Vec<NetworkRoute> = chain::listed_entries(chain)
        .await?
        .into_iter()
        .filter(|e| e.live && e.contributor != me)
        .map(|e| NetworkRoute {
            entry_id: format!("{:#x}", e.entry_id),
            domain: e.domain,
            description: e.description,
            contributor: format!("{:#x}", e.contributor),
            fee: e.fee,
        })
        .collect();
    routes.sort_by(|a, b| a.fee.total_cmp(&b.fee));
    Ok(rank::ranked(query, routes, doc_of))
}

// ---- paying for a body ----

alloy::sol! {
    /// One body fetch an agent pays for, as EIP-712 typed data under Settlement's domain (`chain::domain`). It names
    /// the entry and the content identifier of the body it buys, so one payment releases that body of that entry and
    /// no other. It is its own type, so its signature can never be redeemed as a running voucher, nor pass for a
    /// listing's.
    struct BodyFetch {
        address payer;
        address agent;
        bytes32 entryId;
        string contentId;
        uint256 amount;
        uint64 epoch;
        bytes32 nonce;
    }
}

/// What a caller presents to a body's server (R3.10, R7.5): its agent's signed word that it pays the entry's detail
/// fee for one body. The fee itself moves later, as the receipt line of the use (`chain::Reserved::network_line`); this
/// is what the server checks against the chain before it releases the body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BodyVoucher {
    pub payer: Address,
    pub agent: Address,
    pub entry_id: FixedBytes<32>,
    pub content_id: String,
    /// UNB in its smallest unit, as the contract counts it.
    pub amount: U256,
    pub epoch: u64,
    /// Unique per voucher, so a server refuses one it has already released a body for.
    pub nonce: FixedBytes<32>,
    pub signature: String,
}

impl BodyVoucher {
    fn signing_hash(&self, domain: &Eip712Domain) -> FixedBytes<32> {
        BodyFetch {
            payer: self.payer,
            agent: self.agent,
            entryId: self.entry_id,
            contentId: self.content_id.clone(),
            amount: self.amount,
            epoch: self.epoch,
            nonce: self.nonce,
        }
        .eip712_signing_hash(domain)
    }

    /// The bytes it travels as, in a body ask's payment.
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<BodyVoucher, String> {
        serde_json::from_slice(bytes).map_err(|_| "the payment isn't a body voucher".to_string())
    }
}

/// A nonce no other voucher from this node carries: the clock in nanoseconds, the process and a counter, hashed.
fn fresh_nonce() -> FixedBytes<32> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let n = COUNT.fetch_add(1, Ordering::Relaxed);
    keccak256([&nanos.to_be_bytes()[..], &std::process::id().to_be_bytes(), &n.to_be_bytes()].concat())
}

/// Signs, with the agent's key and under `domain`, a voucher paying `amount` for the body `content_id` of `entry_id`.
#[allow(clippy::too_many_arguments)]
pub fn sign_body_voucher(
    keys: &(dyn KeyStore + Sync),
    agent_index: u32,
    domain: &Eip712Domain,
    payer: Address,
    entry_id: FixedBytes<32>,
    content_id: &str,
    amount: U256,
    epoch: u64,
) -> Result<BodyVoucher, String> {
    let agent_key = chain::agent_signer(keys, agent_index)?;
    let mut v = BodyVoucher {
        payer,
        agent: agent_key.address(),
        entry_id,
        content_id: content_id.to_string(),
        amount,
        epoch,
        nonce: fresh_nonce(),
        signature: String::new(),
    };
    let sig = agent_key.sign_hash_sync(&v.signing_hash(domain)).map_err(|e| e.to_string())?;
    v.signature = format!("0x{}", hex::encode(sig.as_bytes()));
    Ok(v)
}

/// Recovers the signer's address from a message hash and a hex-encoded 65-byte signature.
fn recover_signer(hash: &FixedBytes<32>, sig_hex: &str) -> Result<Address, String> {
    let bytes = hex::decode(sig_hex.strip_prefix("0x").unwrap_or(sig_hex)).map_err(|e| format!("bad signature hex: {e}"))?;
    if bytes.len() != 65 {
        return Err(format!("signature must be 65 bytes, got {}", bytes.len()));
    }
    let v = bytes[64];
    let parity = if v >= 27 { (v - 27) != 0 } else { v != 0 };
    let sig = PrimitiveSig::from_bytes_and_parity(&bytes[..64], parity);
    sig.recover_address_from_prehash(hash).map_err(|e| format!("signature recovery: {e}"))
}

/// What a body voucher says, checked without the chain: its agent signed it under the deployment `d`'s domain (so not
/// for another chain or deployment), and it pays at least `fee` (in units of `d`'s USDC, as the chain holds it) for
/// `content_id` of `entry_id`. Anything else is a payment for something other than the body asked for, and buys
/// nothing.
pub fn check_body_voucher(v: &BodyVoucher, d: &chain::Deployment, entry_id: FixedBytes<32>, content_id: &str, fee: U256) -> Result<Address, String> {
    if recover_signer(&v.signing_hash(&chain::domain(d)), &v.signature)? != v.agent {
        return Err("the voucher isn't signed by the agent it names".into());
    }
    if v.entry_id != entry_id {
        return Err("the voucher pays for another entry".into());
    }
    if v.content_id != content_id {
        return Err("the voucher pays for another body".into());
    }
    if v.amount < fee {
        return Err(format!("the voucher pays {} USDC, under the fee of {}", d.usdc_f(v.amount), d.usdc_f(fee)));
    }
    Ok(v.agent)
}

/// A voucher this server released a body for: its agent and nonce, the epoch it was for and its amount. Kept while the
/// epoch is still accepted, so a voucher pays for one body, not for every ask it is resent with, and the bodies
/// released to one key in an epoch stay within what its cap can still pay. Kept on disk (`<chain>/spent-vouchers.json`):
/// a voucher's epoch outlasts the process, and one forgotten at a restart would buy a second body for a single line.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Spent {
    agent: Address,
    nonce: FixedBytes<32>,
    epoch: u64,
    amount: U256,
}

fn spent_path() -> PathBuf {
    chain::dir().join("spent-vouchers.json")
}

static SPENT: Mutex<()> = Mutex::new(());

/// Adds `v` to `spent`, unless it is there already, or unless the bodies this server has released to its agent in its
/// epoch and this one would come to more than `room`, what the key's cap can still pay that epoch (R1.22): the
/// contract would pay no line past it, so the body would be served for nothing. Entries are dropped only once a
/// witnessed epoch (`seen`, `chain::seen_epoch`) puts them past their window: one dropped on the one RPC's word would
/// let the same voucher buy a body again once that RPC goes back to the true epoch (R7 sweep). Without a witness they
/// are kept, bounded as the bodies released are (`reserve_served`).
fn spent_with(spent: &mut Vec<Spent>, v: &BodyVoucher, seen: Option<u64>, room: U256) -> Result<(), String> {
    spent.retain(|s| !past_by_witness(s.epoch, seen));
    if spent.iter().any(|s| s.agent == v.agent && s.nonce == v.nonce) {
        return Err("this voucher has already paid for a body".into());
    }
    let released = spent.iter().filter(|s| s.agent == v.agent && s.epoch == v.epoch).fold(U256::ZERO, |sum, s| sum.saturating_add(s.amount));
    if released.saturating_add(v.amount) > room {
        return Err("this voucher would take its agent past its cap for the epoch, so the contract wouldn't pay for the body".into());
    }
    spent.push(Spent { agent: v.agent, nonce: v.nonce, epoch: v.epoch, amount: v.amount });
    Ok(())
}

/// Whether a body voucher for epoch `voucher` may be served: in its window by the one RPC's epoch `primary`, and not
/// past it by any epoch a witness stood behind, read now (`seen`) or kept as the floor (`floor`, `chain::epoch_floor`),
/// whatever the one RPC says. With a witness named (`witness_named`) a reading of it is required: one that can't be had
/// now refuses. A spent voucher is forgotten only once the floor is past its window (`spent_with`), and from then on
/// the floor refuses it here, so the two together leave no voucher a second body (R8-CHAIN-2).
pub(crate) fn voucher_open(voucher: u64, primary: u64, seen: Option<u64>, floor: u64, witness_named: bool) -> Result<(), String> {
    let witnessed = seen.unwrap_or(0).max(floor);
    if voucher.saturating_add(1) < witnessed {
        return Err("the voucher's epoch is over".into());
    }
    if witness_named && seen.is_none() {
        return Err("no epoch a witness stands behind can be read now, so no voucher is served; try again".into());
    }
    if !claimable(voucher, primary) {
        return Err("the voucher's epoch is over".into());
    }
    Ok(())
}

/// Whether a voucher of epoch `voucher` is still in its window at the chain's finalized height read just now
/// (`rpc::finalized_now`), judged again right before a release reserves and serves (R11-CHAIN-1): a release's head is a
/// snapshot, and a reply held back across an epoch boundary must not serve a voucher the chain stopped paying since.
/// Refuses too when the release's head is past its life (`rpc::HEAD_LIFE`).
pub async fn still_open_now(chain: &chain::Chain, voucher: u64, head: &crate::rpc::Head) -> Result<(), String> {
    if !head.live() {
        return Err("the chain's head this release followed is too old to serve against; try again".into());
    }
    let d = chain.deployed()?;
    if let Some(at) = crate::rpc::finalized_now().await? {
        if voucher.saturating_add(1) < at / d.blocks_per_epoch() {
            return Err("the voucher's epoch is over".into());
        }
    }
    Ok(())
}

/// Marks a voucher spent (`spent_with`), before the body goes out. A record that can't be read or kept refuses the body:
/// the caller loses a try, and the other way the same voucher could buy again after a restart.
fn spend(v: &BodyVoucher, seen: Option<u64>, room: U256) -> Result<(), String> {
    let _one = SPENT.locked();
    let mut spent: Vec<Spent> = store::read_json_strict(&spent_path(), &unbrowse_files::SPENT_VOUCHERS)?;
    spent_with(&mut spent, v, seen, room)?;
    store::write_json(&spent_path(), &unbrowse_files::SPENT_VOUCHERS, &spent)
}

/// Checks a body voucher as a server must before it releases the body (R1.22, R3.11, R7.5): what it says
/// (`check_body_voucher`), that the payer authorised the agent and the key is neither revoked nor expired, that the
/// payer's deposit, less any withdrawal it asked for, covers the fee beside the lines its stream has signed and what it
/// owes this server (`chain::covers`), that its epoch is this one or the last, that the key's cap can still pay it with
/// the other bodies this server released to it that epoch, and that it hasn't paid for a body already. Then it is
/// spent.
///
/// `seen` is the epoch a witness stood behind for this release (`chain::witness_epoch`, read once by the caller), `None`
/// when none did: it raised the floor every decision here is held to.
///
/// `head` is that release's followed head (`rpc::Head`): the one head every witnessed and agreed value here is read at.
pub async fn verify_body_voucher(chain: &chain::Chain, v: &BodyVoucher, entry_id: FixedBytes<32>, content_id: &str, fee: U256, seen: Option<u64>, head: &crate::rpc::Head) -> Result<(), String> {
    let d = chain.deployed()?;
    check_body_voucher(v, &d, entry_id, content_id, fee)?;
    let floor = chain::epoch_floor()?;
    let now = chain::current_epoch(chain).await?;
    // A payer this server stopped serving (R3.22, spec §76.2 items 5 and 9): one whose signed counts contradict the lines
    // this server holds, or one that skips its backstop. *(client)*: a server isn't paid by a payer that skips its
    // backstop, so it gains by refusing. A refusal ends only by the witnessed floor, and early only on its line read paid
    // with a witness (R8-CHAIN-3): never on the one RPC's word.
    if let Some(r) = refusal(v.payer) {
        let paid = match r.line {
            Some(key) => chain::line_spent_witnessed(chain, key, head).await?,
            None => None,
        };
        held_by_refusal(v.payer, floor, paid)?;
    }
    if let Some((why, line)) = chain::backstop_overdue(chain, v.payer).await? {
        let why = format!("its backstop claim is overdue: {why}");
        refuse_until_paid(v.payer, &why, now.max(floor), line);
        return Err(format!("this server doesn't serve {:#x}: {why}", v.payer));
    }
    chain::check_agent(chain, v.payer, v.agent).await?;
    // The voucher's window, against the one RPC's epoch and, whatever it says, against every epoch a witness stood
    // behind (R8-CHAIN-2): read just now (a contradiction refused above), and the floor kept across restarts.
    // With a second RPC named, a voucher needs a witnessed epoch now: asking more of a named witness, never less.
    voucher_open(v.epoch, now, seen, floor, crate::rpc::second_url()?.is_some() || crate::rpc::chain_is_here())?;
    let room = chain::agent_room(chain, v.payer, v.agent, v.epoch, head).await?;
    // A deposit pays lines in the order they are claimed, so it must cover the stream's whole signed total and what
    // the payer's other streams owe this server, not this fee alone (issue #181).
    let (spendable, streams) = chain::exposure(chain, v.payer, &chain::owed_of(v.payer), Some((v.agent, v.epoch)), head).await?;
    chain::covers(spendable, room, &streams, (v.agent, v.epoch), v.amount)?;
    spend(v, chain::seen_epoch(), room)
}

/// A body released that a line may yet pay for: the serving node, the payer, its agent and the entry, with the epoch
/// the voucher was for. A line a payer's agent sends is kept only against one of these, so the lines a node keeps to
/// claim never outnumber the bodies it served, and each comes from a voucher already checked against the payer's
/// deposit. Kept on disk (`<chain>/served.json`): the line follows its body by as long as the use takes, and a node
/// that restarts in between has still served the body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Served {
    server: Address,
    payer: Address,
    agent: Address,
    entry: FixedBytes<32>,
    epoch: u64,
}

fn served_path() -> PathBuf {
    chain::dir().join("served.json")
}

static SERVED: Mutex<()> = Mutex::new(());

/// Notes that `server` released a body under `v`: the note is the place the line it may bring takes in the server's
/// books, reserved here before the body goes out (R7-CHAIN-1). It is the server's evidence of the release, which its
/// line is kept against, so notes are dropped only once a witnessed epoch (`chain::seen_epoch`) puts them past their
/// window, never on the one RPC's word (R7-CHAIN-2). Refused, and the body not released, when the books are full on a
/// chain only one RPC can read (`reserve_served_with`), or the note can't be kept.
/// `witnessed` is whether a witness stood behind a fresh head in this very release (`chain::witness_epoch` gave an
/// epoch): only that lifts the bounds, never a second RPC merely named (R9-CHAIN-1).
pub fn reserve_served(server: Address, v: &BodyVoucher, witnessed: bool) -> Result<(), String> {
    reserve_served_with(server, v, chain::seen_epoch(), witnessed)
}

/// Whether a record kept for voucher epoch `epoch` is past its window by `seen`, the latest epoch a witness stood behind:
/// never when none has (R7-CHAIN-2).
pub(crate) fn past_by_witness(epoch: u64, seen: Option<u64>) -> bool {
    seen.is_some_and(|w| epoch.saturating_add(1) < w)
}

/// `reserve_served`, given whether a witness can read the chain (`witnessed`). Under the ledger's lock (`chain::ledger`,
/// across processes) and the notes' own, so the count and the note are one step: the lines owed, the lines set aside
/// and every note still waiting together stay within `chain::MAX_HELD_LINES` where no witness can settle them. A line
/// is then kept only against a note, which it takes (`chain::owe`), so keeping it never adds to the count.
pub(crate) fn reserve_served_with(server: Address, v: &BodyVoucher, seen: Option<u64>, witnessed: bool) -> Result<(), String> {
    let _ledger = chain::hold_ledger()?;
    let _one = SERVED.locked();
    let mut all = store::read_json_strict::<Vec<Served>>(&served_path(), &unbrowse_files::SERVED)?;
    all.retain(|n| !past_by_witness(n.epoch, seen));
    // One payer, or one agent key, holds at most its share of the places no witness can free (R8-CHAIN-1): a peer that
    // takes bodies and sends no lines fills its own share, never every other payer's.
    if !witnessed {
        if let Err(e) = pending_room(&all, v.payer, v.agent) {
            store::tell_once(&chain::dir().join(format!("pinned-{:#x}", v.payer)), &format!("Payer {:#x} (agent {:#x}) {e}. It is refused paid bodies until its lines come or a second RPC (check_rpc in Settings) lets its notes age out; every other payer is still served.", v.payer, v.agent));
            return Err(format!("this server doesn't serve {:#x} now: it {e}", v.payer));
        }
    }
    if !chain::ledger_has_room(chain::held_lines_locked()? + all.len(), witnessed) {
        let most = most_pending(&all).map(|(p, n)| format!(" The payer holding the most places is {p:#x}, with {n}.")).unwrap_or_default();
        store::tell_once(&chain::dir().join("unwitnessed.json"), &format!("The node {}.{most}", chain::LEDGER_FULL));
        return Err(chain::LEDGER_FULL.into());
    }
    all.push(Served { server, payer: v.payer, agent: v.agent, entry: v.entry_id, epoch: v.epoch });
    store::write_json(&served_path(), &unbrowse_files::SERVED, &all)
}

/// The most places, of `chain::MAX_HELD_LINES`, one payer's bodies awaiting their lines may hold where no witness can
/// free them; and the same for one agent key, which may spend for more than one payer (R8-CHAIN-1).
pub const MAX_PENDING_PER_PAYER: usize = 500;
pub const MAX_PENDING_PER_AGENT: usize = 500;

/// Whether one more body may be released to `payer`'s `agent` beside the notes `all` still waiting: an error naming
/// what it holds when its payer or its key is at its share.
pub(crate) fn pending_room(all: &[Served], payer: Address, agent: Address) -> Result<(), String> {
    let by_payer = all.iter().filter(|n| n.payer == payer).count();
    if by_payer >= MAX_PENDING_PER_PAYER {
        return Err(format!("holds {by_payer} bodies whose lines never came, its share of what this node keeps"));
    }
    let by_agent = all.iter().filter(|n| n.agent == agent).count();
    if by_agent >= MAX_PENDING_PER_AGENT {
        return Err(format!("has an agent key holding {by_agent} bodies whose lines never came, its share of what this node keeps"));
    }
    Ok(())
}

/// The payer whose bodies hold the most places, and how many.
fn most_pending(all: &[Served]) -> Option<(Address, usize)> {
    let mut by: std::collections::HashMap<Address, usize> = std::collections::HashMap::new();
    for n in all {
        *by.entry(n.payer).or_default() += 1;
    }
    by.into_iter().max_by_key(|(_, n)| *n)
}

/// How many served notes wait for their lines.
pub(crate) fn served_notes() -> Result<usize, String> {
    Ok(store::read_json_strict::<Vec<Served>>(&served_path(), &unbrowse_files::SERVED)?.len())
}

/// Takes one of `server`'s served notes for a line paying `entry` from `payer`'s `agent`, if one is waiting.
fn take_served(server: Address, payer: Address, agent: Address, entry: FixedBytes<32>) -> bool {
    let _one = SERVED.locked();
    let Ok(mut all) = store::read_json_strict::<Vec<Served>>(&served_path(), &unbrowse_files::SERVED) else { return false };
    let Some(i) = all.iter().position(|n| n.server == server && n.payer == payer && n.agent == agent && n.entry == entry) else { return false };
    all.remove(i);
    store::write_json(&served_path(), &unbrowse_files::SERVED, &all).is_ok()
}

// ---- receipts for served calls ----

/// Checks a line a payer's agent sent for a call this node served, and keeps it: the running voucher's signature under
/// Settlement's domain, that its epoch can still be claimed, the agent's authorization, the line's proof, that the
/// voucher's total covers it when it passed, that it pays one of this node's live entries and at least that entry's
/// fee, and that it pays for a body this node served and has no line for yet. A passed line is kept to claim; a failed
/// one only to check the stream's signed counts against (`contradicts`) and its total (`chain::streams_of`).
pub async fn accept_receipt(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), paid: &chain::PaidLine) -> Result<(), String> {
    let d = chain.deployed()?;
    let (v, l) = (paid.voucher(), paid.line());
    let signer = recover_signer(&chain::voucher_digest(&d, &v), &format!("0x{}", hex::encode(&paid.signature)))?;
    if signer != v.agent {
        return Err("the voucher isn't signed by its agent".into());
    }
    let epoch = chain::current_epoch(chain).await?;
    if !claimable(v.epoch, epoch) {
        return Err("the voucher's epoch can't be claimed now".into());
    }
    within_voucher(paid, &chain::owed_of(v.payer))?;
    chain::check_voucher_key(chain, v.payer, v.agent, v.epoch).await?;
    if !chain::proves(v.receiptsRoot, chain::line_leaf(&l), &paid.proof) {
        return Err("the line isn't in the voucher".into());
    }
    // A failed line is kept too, though it pays nobody and is never claimed (`chain::claim_paid`): it is what the
    // stream's signed counts are checked against (`contradicts`).
    let lie = contradicts(paid, &chain::owed_of(v.payer));
    if let Some(why) = &lie {
        refuse(v.payer, why, epoch);
    }
    let me = chain::owner_address(keys)?;
    let wallet = crate::listing::lister_wallet(chain, keys).await?;
    // The line must pay a listing of this node's: credited to it and live, or one no claim has credited yet, which this
    // node holds in its book and serves at its listed price (R2.18, spec §76 item 2).
    let own = crate::listing::load_book(chain).of_entry(l.entryId).ok_or("the line pays no listing of this node")?;
    match chain::entry_by_hash(chain, l.entryId).await? {
        Some((contributor, e)) if (contributor == me || contributor == wallet) && e.live => {}
        None => {}
        _ => return Err("the line pays no live entry of this node".into()),
    }
    let by = crate::listing::identity_key(chain, &own.listing.agent_id).await?;
    let (fee, units) = crate::listing::price(chain, by, &own.listing).await?;
    if l.amount < units {
        return Err(format!("the line pays {} USDC, under the fee of {fee}", d.usdc_f(l.amount)));
    }
    let kept = chain::owe(paid.clone(), || take_served(me, v.payer, v.agent, l.entryId));
    // The line is kept even under counts that lie: what it pays doesn't rest on them.
    match lie {
        Some(why) => Err(format!("this server doesn't serve {:#x} any more: {why}", v.payer)),
        None => kept,
    }
}

/// Whether a claim could pay `paid` beside the lines of its stream in `held`. The voucher's total is its passed lines'
/// (`chain::voucher_over`) and a failed line is never claimed, so only a passed line is held to the total, beside the
/// passed lines of the stream this node keeps already. Every line is held to the bound on servers.
pub(crate) fn within_voucher(paid: &chain::PaidLine, held: &[chain::PaidLine]) -> Result<(), String> {
    if paid.passed && paid.amount > paid.cumulative {
        return Err("the line pays more than its voucher's total".into());
    }
    let same = |o: &&chain::PaidLine| (o.payer, o.agent, o.epoch) == (paid.payer, paid.agent, paid.epoch) && o.passed;
    let kept = held.iter().filter(same).fold(U256::ZERO, |sum, o| sum.saturating_add(o.amount));
    claimable_line(paid.holders.len(), if paid.passed { paid.amount } else { U256::ZERO }, paid.cumulative, kept)
}

/// The most servers a line this node takes may name. Settlement reads only the first (the line's server, whose identity
/// `CoinStakes.noteLine` compares with the payer's) and pays no server a share (`fees.server` = 0), but the line's leaf
/// hashes every holder it names, so each one past the first costs its claimer gas and earns nobody, and a long enough
/// list can't be claimed at all. A client bound, the one the contract held before route coins.
pub const MAX_SERVERS: usize = 16;

/// Whether a claim can pay a line naming `holders` servers and paying `amount`, under a voucher whose total is
/// `cumulative`, beside the `kept` its stream's other lines this node keeps already pay (external security review
/// round 3, 2026-11-04: the server took lines a claim could never pay, so it served for nothing).
pub(crate) fn claimable_line(holders: usize, amount: U256, cumulative: U256, kept: U256) -> Result<(), String> {
    if holders > MAX_SERVERS {
        return Err(format!("the line names {holders} servers, more than the {MAX_SERVERS} this node takes: no claim of it would be worth its gas"));
    }
    if kept.saturating_add(amount) > cumulative {
        return Err("the line and the others of its stream this node keeps come to more than the voucher's total, so a claim can't pay them all".into());
    }
    Ok(())
}

/// How long a server refuses a payer it caught (`refuse`), in epochs.
pub const REFUSED_FOR: u64 = 30;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Refused {
    why: String,
    until: u64,
    /// The line whose overdue backstop this refusal is for, by its spent key (`chain::spent_key`). None for a refusal
    /// nothing later can cure: counts that contradict, or a line whose window closed unpaid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line: Option<FixedBytes<32>>,
}

/// Whether a refusal holds in epoch `now`, with `paid` whether the line it names has been spent. A server stops waiting
/// on an overdue backstop before the line's window closes, and a watchtower claims in the last quarter of it
/// (`watchtower::tower_lead`): once the line is paid the server has lost nothing, so nothing is left to refuse the
/// payer for. Spec §76.2 item 9 stops a payer that skips its backstop, and one whose lines all get paid hasn't.
pub(crate) fn stands(r: &Refused, floor: u64, paid: bool) -> bool {
    refusal_stands(r.until, floor) && !(paid && r.line.is_some())
}

fn refused_path() -> PathBuf {
    chain::dir().join("refused-payers.json")
}

static REFUSED: Mutex<()> = Mutex::new(());

/// Stops serving `payer` for `REFUSED_FOR` epochs from `now`, saying why.
pub fn refuse(payer: Address, why: &str, now: u64) {
    keep_refusal(payer, why, now, None);
}

/// The same for a backstop overdue on `line`, a line's spent key: it ends early if the line is paid (`stands`).
fn refuse_until_paid(payer: Address, why: &str, now: u64, line: FixedBytes<32>) {
    keep_refusal(payer, why, now, Some(line));
}

fn keep_refusal(payer: Address, why: &str, now: u64, line: Option<FixedBytes<32>>) {
    // Counted from the later of the epoch given and the witnessed floor: an RPC that says the chain is behind can't make
    // a refusal end as soon as it is made.
    let now = now.max(chain::seen_epoch().unwrap_or(0));
    let _one = REFUSED.locked();
    let mut all: std::collections::BTreeMap<String, Refused> = store::read_json(&refused_path(), &unbrowse_files::REFUSED_PAYERS);
    prune_refusals(&mut all, chain::seen_epoch());
    all.insert(format!("{payer:#x}"), Refused { why: why.into(), until: now + REFUSED_FOR, line });
    let _ = store::write_json(&refused_path(), &unbrowse_files::REFUSED_PAYERS, &all);
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "This node".into(),
        site: String::new(),
        what: format!("Stopped serving {payer:#x}"),
        kind: "body".into(),
        result: "refused".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(format!("{why}; until epoch {}", now + REFUSED_FOR)),
    });
}

/// Lets go of refusals that ended, by `seen`, the latest epoch a witness stood behind: none on the one RPC's word, so
/// an epoch it puts far ahead ends no refusal on disk (R7 sweep).
fn prune_refusals(all: &mut std::collections::BTreeMap<String, Refused>, seen: Option<u64>) {
    if let Some(w) = seen {
        all.retain(|_, r| refusal_stands(r.until, w));
    }
}

/// Whether a refusal until epoch `until` still stands at `floor`, an epoch a witness stood behind (`chain::epoch_floor`):
/// until the floor reaches it. Never ended by the one RPC's epoch (R8-CHAIN-3); a deployment's refusals are set aside
/// with its other state when the chain's contracts change.
fn refusal_stands(until: u64, floor: u64) -> bool {
    floor < until
}

/// Whether this server's refusal of `payer` still holds it off, given the witnessed `floor` and its line's witnessed
/// reading (`paid`, `None` when no witness stood behind one): an error while it stands; lifted from disk once it doesn't.
/// Only a witnessed `Some(true)` ends a line's refusal early (R8-CHAIN-3).
pub(crate) fn held_by_refusal(payer: Address, floor: u64, paid: Option<bool>) -> Result<(), String> {
    let Some(r) = refusal(payer) else { return Ok(()) };
    if stands(&r, floor, paid == Some(true)) {
        return Err(format!("this server doesn't serve {payer:#x}: {}", r.why));
    }
    lift(payer);
    Ok(())
}

/// This server's refusal of `payer`, if it keeps one: whether it still stands is `stands`, by the witnessed floor.
fn refusal(payer: Address) -> Option<Refused> {
    let all: std::collections::BTreeMap<String, Refused> = store::read_json(&refused_path(), &unbrowse_files::REFUSED_PAYERS);
    all.get(&format!("{payer:#x}")).cloned()
}

/// Ends the refusal of `payer`, whose line was paid after all.
fn lift(payer: Address) {
    let _one = REFUSED.locked();
    let mut all: std::collections::BTreeMap<String, Refused> = store::read_json(&refused_path(), &unbrowse_files::REFUSED_PAYERS);
    if all.remove(&format!("{payer:#x}")).is_some() {
        let _ = store::write_json(&refused_path(), &unbrowse_files::REFUSED_PAYERS, &all);
    }
}

/// Whether the counts `paid`'s voucher signs contradict the lines of the same stream this server already holds
/// (spec §76.2 item 5): it counts fewer lines than the highest index it holds, or fewer failed lines than this server
/// holds failed below its count. The counts are the payer's own word, which the chain doesn't read; a server that
/// holds the lines can, and judges the payer by them itself.
pub fn contradicts(paid: &chain::PaidLine, held: &[chain::PaidLine]) -> Option<String> {
    let lines = paid.lines;
    let stream = stream_of(paid, held);
    let top = stream.iter().map(|o| o.index).max().unwrap_or_default();
    if U256::from(lines) <= top {
        return Some(format!("its voucher counts {lines} lines, and this server holds line {top} of it"));
    }
    let (signed, failed) = failed_counts(paid, &stream);
    if failed > signed {
        return Some(format!("its voucher counts {signed} failed lines, and this server holds {failed} failed lines of it"));
    }
    None
}

/// `paid` and the other lines of its stream (its payer's agent, its epoch) in `held`.
fn stream_of<'a>(paid: &'a chain::PaidLine, held: &'a [chain::PaidLine]) -> Vec<&'a chain::PaidLine> {
    let same = |o: &&chain::PaidLine| (o.payer, o.agent, o.epoch) == (paid.payer, paid.agent, paid.epoch) && o.index != paid.index;
    held.iter().filter(same).chain(std::iter::once(paid)).collect()
}

/// The failed lines `paid`'s voucher signs, and how many of `stream` failed below its line count.
fn failed_counts(paid: &chain::PaidLine, stream: &[&chain::PaidLine]) -> (u64, u64) {
    let failed = stream.iter().filter(|o| !o.passed && o.index < U256::from(paid.lines)).count() as u64;
    (paid.lines.saturating_sub(paid.passed_lines), failed)
}

/// Whether a voucher for epoch `voucher` can be claimed in epoch `now`: in its own epoch or the one after.
fn claimable(voucher: u64, now: u64) -> bool {
    voucher == now || voucher.checked_add(1) == Some(now)
}

/// Sends the contributor of a used entry the line paying for the use, under the agent's latest running voucher, so it
/// can claim it (the agent's own claims carry it too).
pub async fn send_receipt(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), agent_index: u32, epoch: u64, line: u64, contributor: &str) -> Result<(), String> {
    let endpoint = find_endpoint(contributor).ok_or_else(|| format!("can't reach the node at {contributor}"))?;
    proven(&endpoint, contributor.parse().map_err(|_| format!("bad address {contributor}"))?).await?;
    let run = chain::running_voucher(chain, keys, agent_index, epoch).await?.ok_or("no receipt lines to send")?;
    let paid = chain::PaidLine::of(&run, line as usize).ok_or("no such receipt line")?;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{endpoint}/v1/remote/receipt"))
        .json(&paid)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("sending the receipt: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the contributor's node refused the receipt: {}", resp.text().await.unwrap_or_default()));
    }
    Ok(())
}

/// Hands the line paying for a use to `peer`, the node that served its body, over the peer network
/// (`/unbrowse/tower/1`), for a node with no endpoint on this machine (`send_receipt`). The peer keeps a line paying
/// one of its listings to claim as its own, and holds any other as a watchtower; either way the contract checks the
/// signature and the proof, so the peer can't change what the line pays.
pub async fn hand_receipt(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), net: &unbrowse_net::Net, peer: unbrowse_net::PeerId, agent_index: u32, epoch: u64, line: u64) -> Result<(), String> {
    let run = chain::running_voucher(chain, keys, agent_index, epoch).await?.ok_or("no receipt lines to send")?;
    let paid = chain::PaidLine::of(&run, line as usize).ok_or("no such receipt line")?;
    let handed = serde_json::to_vec(&vec![paid]).map_err(|e| e.to_string())?;
    net.hand_over(peer, handed).await.map_err(|e| format!("handing the receipt to {peer}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The folder node ads are shared through, and each ad in it, are the owner's alone: one the node made before with
    /// the default mode is narrowed too.
    #[cfg(unix)]
    #[test]
    fn the_node_ad_folder_is_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("unbrowse-ads-private-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        keep_private(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700, "made private");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        keep_private(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700, "one made before is narrowed");
        let ad = dir.join("ab.json");
        store::write_json(&ad, &unbrowse_files::NODE_AD, &NodeAd { address: "0xab".into(), ..Default::default() }).unwrap();
        assert_eq!(mode(&ad), 0o600, "each ad is the owner's alone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// External security review round 3, 2026-11-04. A server takes no line a claim can never pay: one naming more
    /// servers than the node's bound, nor one the voucher's total can't cover beside the stream's lines it keeps already.
    #[test]
    fn a_server_takes_no_line_a_claim_could_never_pay() {
        let (one, ten) = (U256::from(1u64), U256::from(10u64));
        assert!(claimable_line(MAX_SERVERS, one, ten, U256::ZERO).is_ok());
        assert!(claimable_line(MAX_SERVERS + 1, one, ten, U256::ZERO).unwrap_err().contains("servers"));
        assert!(claimable_line(4_000, one, ten, U256::ZERO).is_err(), "a list no block could carry");
        assert!(claimable_line(1, one, ten, U256::from(9u64)).is_ok(), "exactly the total");
        assert!(claimable_line(1, one, ten, ten).unwrap_err().contains("voucher's total"));
    }

    /// A voucher's total is its passed lines' (`chain::voucher_over`), so a passed line that comes after failed ones is
    /// taken: the failed lines held count nothing against the total. A failed line is taken under a total that leaves
    /// it out, and a passed line past the total is still refused.
    #[test]
    fn a_passed_line_after_failed_ones_is_taken() {
        let quarter = U256::from(25u64);
        let line = |index: u64, passed: bool, cumulative: u64| chain::PaidLine {
            payer: Address::repeat_byte(1),
            agent: Address::repeat_byte(2),
            epoch: 9,
            cumulative: U256::from(cumulative),
            lines: index + 1,
            passed_lines: u64::from(passed),
            receipts_root: FixedBytes::ZERO,
            signature: Default::default(),
            index: U256::from(index),
            entry_id: FixedBytes::ZERO,
            amount: quarter,
            passed,
            holders: vec![],
            bounty: U256::ZERO,
            proof: vec![],
        };
        let failed: Vec<_> = (0..4).map(|i| line(i, false, 0)).collect();
        for (i, f) in failed.iter().enumerate() {
            assert_eq!(within_voucher(f, &failed[..i]), Ok(()), "a failed line under a total of nothing");
        }
        assert_eq!(within_voucher(&line(4, true, 25), &failed), Ok(()), "the fifth, passed, after four failed");
        assert!(within_voucher(&line(4, true, 20), &failed).unwrap_err().contains("voucher's total"));
        let mut held = failed.clone();
        held.push(line(4, true, 25));
        assert!(within_voucher(&line(5, true, 25), &held).unwrap_err().contains("voucher's total"), "two passed lines under a total of one");
    }

    /// A deployment on `chain_id` at `settlement`, its USDC of 18 decimals.
    fn domain(chain_id: u64, settlement: Address) -> chain::Deployment {
        chain::Deployment { settlement, chain_id, ..Default::default() }
    }

    const BODY: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

    fn signed(d: &chain::Deployment) -> BodyVoucher {
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let payer = chain::owner_address(&keys).unwrap();
        sign_body_voucher(&keys, 0, &chain::domain(d), payer, FixedBytes::repeat_byte(7), BODY, d.fee_units(0.5), 3).unwrap()
    }

    /// The fee `x` whole USDC as the chain holds it on `d`.
    fn fee(d: &chain::Deployment, x: f64) -> U256 {
        d.fee_units(x)
    }

    #[test]
    fn a_body_voucher_pays_for_the_body_and_entry_it_names() {
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        assert_eq!(check_body_voucher(&v, &d, FixedBytes::repeat_byte(7), BODY, fee(&d, 0.5)).unwrap(), v.agent);
        assert_eq!(BodyVoucher::from_bytes(&v.to_bytes()).unwrap(), v, "it travels as its bytes");
    }

    /// One payment can't fetch another body: a voucher shown for another entry, or for another body of the same
    /// entry, is refused, whatever it pays.
    #[test]
    fn a_body_voucher_never_pays_for_another_entry_or_body() {
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        assert!(check_body_voucher(&v, &d, FixedBytes::repeat_byte(8), BODY, fee(&d, 0.5)).unwrap_err().contains("another entry"));
        let other = format!("sha256:{}", "22".repeat(32));
        assert!(check_body_voucher(&v, &d, FixedBytes::repeat_byte(7), &other, fee(&d, 0.5)).unwrap_err().contains("another body"));
    }

    /// A refusal stands until the witnessed floor reaches its end, and ends there; a floor that lags (or none at all)
    /// only keeps it longer (R8-CHAIN-3).
    #[test]
    fn a_refusal_ends_only_when_the_witnessed_floor_reaches_it() {
        let until = 20_764 + REFUSED_FOR;
        assert!(refusal_stands(until, 20_765), "it stands on its own count");
        assert!(refusal_stands(until, 0), "no epoch witnessed yet: it stands");
        assert!(!refusal_stands(until, until), "and ends");
    }

    #[test]
    fn a_body_voucher_under_the_fee_is_refused() {
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        assert!(check_body_voucher(&v, &d, FixedBytes::repeat_byte(7), BODY, fee(&d, 0.6)).unwrap_err().contains("under the fee of 0.6"));
        assert!(check_body_voucher(&v, &d, FixedBytes::repeat_byte(7), BODY, fee(&d, 0.4)).is_ok(), "more than the fee pays it");
    }

    /// On a deployment whose USDC counts in 6 decimals, a voucher is signed for the fee's units in 6, and a voucher
    /// one unit under the fee is refused.
    #[test]
    fn a_body_voucher_is_in_units_of_the_deployments_usdc() {
        let d = chain::Deployment { usdc_decimals: 6, ..domain(5042, Address::repeat_byte(1)) };
        let v = signed(&d);
        assert_eq!(v.amount, U256::from(500_000u64));
        assert!(check_body_voucher(&v, &d, FixedBytes::repeat_byte(7), BODY, U256::from(500_000u64)).is_ok());
        let e = check_body_voucher(&v, &d, FixedBytes::repeat_byte(7), BODY, U256::from(500_001u64)).unwrap_err();
        assert!(e.contains("pays 0.5 USDC, under the fee of 0.500001"), "{e}");
    }

    /// Changing what a voucher says after it was signed (to point it at another body, or raise or lower it) breaks
    /// its signature, so it can't be made to pay for something else either.
    #[test]
    fn a_body_voucher_whose_terms_were_changed_is_refused() {
        let d = domain(5042, Address::repeat_byte(1));
        let changes: Vec<Box<dyn Fn(&mut BodyVoucher)>> = vec![
            Box::new(|v| v.entry_id = FixedBytes::repeat_byte(8)),
            Box::new(|v| v.content_id = format!("sha256:{}", "22".repeat(32))),
            Box::new(|v| v.amount = chain::usdc_fee_units(5.0, 18)),
            Box::new(|v| v.epoch = 4),
            Box::new(|v| v.payer = Address::repeat_byte(9)),
        ];
        for change in changes {
            let mut v = signed(&d);
            change(&mut v);
            let (entry, body, fee) = (v.entry_id, v.content_id.clone(), fee(&d, 0.1));
            assert!(check_body_voucher(&v, &d, entry, &body, fee).unwrap_err().contains("isn't signed"));
        }
    }

    #[test]
    fn a_body_voucher_signed_for_another_chain_or_settlement_is_refused() {
        let v = signed(&domain(5042002, Address::repeat_byte(1)));
        assert!(check_body_voucher(&v, &domain(5042, Address::repeat_byte(1)), v.entry_id, BODY, U256::ZERO).is_err(), "another chain");
        let v = signed(&domain(5042, Address::repeat_byte(1)));
        assert!(check_body_voucher(&v, &domain(5042, Address::repeat_byte(2)), v.entry_id, BODY, U256::ZERO).is_err(), "another deployment");
    }

    #[test]
    fn a_body_voucher_pays_for_one_body() {
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        let _home = crate::store::scratch_home("spent-once");
        spend(&v, Some(3), U256::MAX).unwrap();
        assert!(spend(&v, Some(3), U256::MAX).unwrap_err().contains("already paid"), "replayed");
        let fresh = signed(&d);
        assert!(spend(&fresh, Some(3), U256::MAX).is_ok(), "a fresh voucher from the same agent");
    }

    /// A server releases no body its agent's cap can't pay (R1.22): the bodies it released to one key in an epoch, and
    /// this one, stay within what the cap can still pay; another epoch's bodies don't count against it.
    #[test]
    fn a_server_releases_no_body_past_the_keys_cap() {
        let d = domain(5042, Address::repeat_byte(1));
        let n = std::cell::Cell::new(0u8);
        let at = |amount: u64, epoch: u64| {
            n.set(n.get() + 1);
            BodyVoucher { amount: U256::from(amount), epoch, nonce: FixedBytes::repeat_byte(n.get()), ..signed(&d) }
        };
        let first = at(6, 40);
        let agent = first.agent;
        let mine = |v: BodyVoucher| BodyVoucher { agent, ..v };
        let _home = crate::store::scratch_home("spent-cap");
        spend(&first, Some(40), U256::from(10)).unwrap();
        assert!(spend(&mine(at(5, 40)), Some(40), U256::from(10)).unwrap_err().contains("past its cap"), "6 + 5 over a room of 10");
        assert!(spend(&mine(at(4, 40)), Some(40), U256::from(10)).is_ok(), "6 + 4 fits");
        assert!(spend(&mine(at(5, 41)), Some(41), U256::from(10)).is_ok(), "another epoch starts again");
        assert!(spend(&mine(at(1, 40)), Some(41), U256::ZERO).unwrap_err().contains("past its cap"), "a cap already claimed in full pays nothing more");
    }

    /// A voucher pays for one body, and that doesn't end with the process that released it: its epoch is still accepted
    /// after a restart, and what it bought still counts against its key's cap. `spend` holds nothing in memory.
    #[test]
    fn a_voucher_spent_before_a_restart_buys_nothing_after_it() {
        let _home = crate::store::scratch_home("spent-restart");
        let d = domain(5042, Address::repeat_byte(1));
        let mut v = signed(&d);
        v.agent = Address::repeat_byte(0x71);
        v.epoch = 90;
        v.amount = U256::from(6);
        spend(&v, Some(90), U256::from(10)).unwrap();
        assert!(spend(&v, Some(90), U256::from(10)).unwrap_err().contains("already paid"), "the same voucher again");
        let fresh = BodyVoucher { nonce: FixedBytes::repeat_byte(0x72), ..v.clone() };
        assert!(spend(&fresh, Some(90), U256::from(10)).unwrap_err().contains("past its cap"), "6 released before the restart, 6 more over a room of 10");
    }

    /// A refusal past its epochs, by a witnessed epoch, is dropped at the next one kept, so the file doesn't grow for as
    /// long as the node runs; by the one RPC's epoch alone it stays (R7 sweep).
    #[test]
    fn a_refusal_past_its_epochs_is_dropped_when_the_next_is_kept() {
        let _home = crate::store::scratch_home("refused-pruned");
        let (old, new) = (Address::repeat_byte(0x81), Address::repeat_byte(0x82));
        refuse(old, "its counts contradict", 10);
        refuse(new, "its counts contradict", 10 + REFUSED_FOR);
        let all: std::collections::BTreeMap<String, Refused> = store::read_json(&refused_path(), &unbrowse_files::REFUSED_PAYERS);
        assert_eq!(all.len(), 2, "no witnessed epoch: nothing dropped");
        chain::note_seen_epoch(10 + REFUSED_FOR);
        refuse(new, "its counts contradict", 10 + REFUSED_FOR);
        let all: std::collections::BTreeMap<String, Refused> = store::read_json(&refused_path(), &unbrowse_files::REFUSED_PAYERS);
        assert_eq!(all.keys().cloned().collect::<Vec<_>>(), [format!("{new:#x}")]);
    }

    /// A note left by the process before this one still lets its line in: the body went out, so a restart between the
    /// body and its line must not cost the server the line.
    #[test]
    fn a_body_served_before_a_restart_still_takes_its_line() {
        let _home = crate::store::scratch_home("served-restart");
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        let me = Address::repeat_byte(0x0a);
        let left = serde_json::json!({"v": 1, "items": [{"server": me, "payer": v.payer, "agent": v.agent, "entry": v.entry_id, "epoch": 3}]});
        std::fs::create_dir_all(chain::dir()).unwrap();
        std::fs::write(chain::dir().join("served.json"), left.to_string()).unwrap();
        assert!(take_served(me, v.payer, v.agent, v.entry_id));
        assert!(!take_served(me, v.payer, v.agent, v.entry_id), "and only one line for it");
    }

    #[test]
    fn a_line_is_kept_only_for_a_body_this_node_served() {
        let _home = crate::store::scratch_home("served-note");
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        let (me, other) = (Address::repeat_byte(0x0a), Address::repeat_byte(0x0b));
        assert!(!take_served(me, v.payer, v.agent, v.entry_id), "nothing served yet");
        reserve_served_with(me, &v, None, true).unwrap();
        assert!(!take_served(me, v.payer, v.agent, FixedBytes::repeat_byte(9)), "another entry");
        assert!(!take_served(me, Address::repeat_byte(5), v.agent, v.entry_id), "another payer");
        assert!(!take_served(other, v.payer, v.agent, v.entry_id), "another node served it");
        assert!(take_served(me, v.payer, v.agent, v.entry_id));
        assert!(!take_served(me, v.payer, v.agent, v.entry_id), "one line per served body");
    }

    /// A served line `index` of epoch `epoch` from the payer and agent of `v`, on `v`'s entry.
    fn owed_line(v: &BodyVoucher, epoch: u64, index: u64) -> chain::PaidLine {
        chain::PaidLine {
            payer: v.payer,
            agent: v.agent,
            epoch,
            cumulative: U256::from(100u64),
            lines: 0,
            passed_lines: 0,
            receipts_root: FixedBytes::ZERO,
            signature: alloy::primitives::Bytes::new(),
            index: U256::from(index),
            entry_id: v.entry_id,
            amount: U256::from(1u64),
            passed: true,
            holders: vec![],
            bounty: U256::ZERO,
            proof: vec![],
        }
    }

    /// R7-CHAIN-1: a release reserves the place its line takes, so releases still waiting for their lines count against
    /// the bound, at once and under the ledger's lock: concurrent releases at the edge take only the room there is, a
    /// line that arrives later takes its reservation and never adds to the count, and a line already served is never
    /// refused for want of room.
    #[test]
    fn pending_releases_count_against_the_held_line_bound() {
        let home = crate::store::scratch_home("held-bound");
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        let me = Address::repeat_byte(0x0a);
        std::fs::create_dir_all(chain::dir()).unwrap();
        let held: Vec<chain::PaidLine> = (0..chain::MAX_HELD_LINES as u64 - 3).map(|i| owed_line(&v, 1, 1_000 + i)).collect();
        store::write_json(&chain::dir().join("owed.json"), &unbrowse_files::OWED, &held).unwrap();
        reserve_served_with(me, &v, None, false).unwrap();
        // Three more try at once, with room for two.
        let tries: Vec<_> = (0..3)
            .map(|_| {
                let (home, v) = (home.clone(), v.clone());
                std::thread::spawn(move || {
                    crate::store::use_home(&home);
                    reserve_served_with(me, &v, None, false).is_ok()
                })
            })
            .collect();
        let took = tries.into_iter().map(|t| t.join().unwrap()).filter(|ok| *ok).count();
        assert_eq!(took, 2, "only the room there is");
        assert_eq!(served_notes().unwrap(), 3);
        assert_eq!(reserve_served_with(me, &v, None, false).unwrap_err(), chain::LEDGER_FULL, "pending releases fill the books");
        assert!(chain::may_take_paid_lines(false).is_err(), "and the early check counts them too");
        // The line of a body served comes later: it takes its note and is kept, full or not, and the count is unchanged.
        chain::owe(owed_line(&v, 3, 7), || take_served(me, v.payer, v.agent, v.entry_id)).unwrap();
        assert_eq!(served_notes().unwrap(), 2);
        assert_eq!(chain::held_lines_now().unwrap(), chain::MAX_HELD_LINES);
        assert!(reserve_served_with(me, &v, None, false).is_err(), "still full");
        // A line with no note is never kept.
        assert!(chain::owe(owed_line(&v, 3, 8), || take_served(Address::repeat_byte(0x0b), v.payer, v.agent, v.entry_id)).is_err());
        // Where a witness can settle lines, the books drain, and nothing is held back.
        assert!(reserve_served_with(me, &v, None, true).is_ok());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// R8-CHAIN-1: one payer, or one agent key, can hold only its share of the places no witness can free: at its
    /// share it is refused while other payers are still served, its notes settle as its lines come, and the global
    /// ceiling stays hard.
    #[test]
    fn one_payer_can_pin_only_its_share_of_the_pending_places() {
        let _home = crate::store::scratch_home("pinned-share");
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        let me = Address::repeat_byte(0x0a);
        std::fs::create_dir_all(chain::dir()).unwrap();
        let note = |payer: Address, agent: Address, i: u8| Served { server: me, payer, agent, entry: FixedBytes::repeat_byte(i), epoch: 3 };
        let mut pinned: Vec<Served> = (0..MAX_PENDING_PER_PAYER).map(|i| note(v.payer, v.agent, (i % 250) as u8)).collect();
        store::write_json(&served_path(), &unbrowse_files::SERVED, &pinned).unwrap();
        assert!(reserve_served_with(me, &v, None, false).unwrap_err().contains("never came"), "the payer at its share is refused");
        let mut other = v.clone();
        other.payer = Address::repeat_byte(0x55);
        other.agent = Address::repeat_byte(0x56);
        reserve_served_with(me, &other, None, false).expect("another payer is still served");
        // The same agent key spending for another payer is held to the key's share too.
        let mut same_key = v.clone();
        same_key.payer = Address::repeat_byte(0x57);
        assert!(reserve_served_with(me, &same_key, None, false).is_err(), "one key can't pin past its share either");
        // A line comes and takes its note: the payer has room again.
        assert!(take_served(me, v.payer, v.agent, FixedBytes::repeat_byte(0)));
        reserve_served_with(me, &v, None, false).expect("its notes settle, and it is served again");
        // With a witness, notes age out and nothing is held back.
        assert!(reserve_served_with(me, &v, None, true).is_ok());
        // And the global ceiling stays hard: many payers, each under its share, fill it.
        pinned.clear();
        for i in 0..chain::MAX_HELD_LINES {
            pinned.push(note(Address::with_last_byte((i / MAX_PENDING_PER_PAYER) as u8), Address::with_last_byte((i / MAX_PENDING_PER_AGENT) as u8), 1));
        }
        store::write_json(&served_path(), &unbrowse_files::SERVED, &pinned).unwrap();
        let mut fresh = v.clone();
        fresh.payer = Address::repeat_byte(0x77);
        fresh.agent = Address::repeat_byte(0x78);
        assert_eq!(reserve_served_with(me, &fresh, None, false).unwrap_err(), chain::LEDGER_FULL);
    }

    /// R7-CHAIN-2: the note of a body released is the evidence its line is kept against, so it outlives any epoch the
    /// one RPC claims: a release made while that RPC says the chain is far ahead drops no note, the payer's line is
    /// still kept and claimable, and only a witnessed epoch past the note's window lets it go.
    #[test]
    fn a_far_future_epoch_on_one_rpc_erases_no_served_note() {
        let _home = crate::store::scratch_home("served-future");
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        let me = Address::repeat_byte(0x0a);
        std::fs::create_dir_all(chain::dir()).unwrap();
        reserve_served_with(me, &v, None, false).unwrap();
        // Another release while the one RPC says epoch 1,000,000: no witnessed epoch, so nothing is pruned.
        let mut later = v.clone();
        later.entry_id = FixedBytes::repeat_byte(9);
        reserve_served_with(me, &later, None, false).unwrap();
        assert_eq!(served_notes().unwrap(), 2, "the first note is kept");
        chain::owe(owed_line(&v, v.epoch, 1), || take_served(me, v.payer, v.agent, v.entry_id)).unwrap();
        assert_eq!(chain::owed_of(v.payer).len(), 1, "and its line is kept to claim");
        // A witness reads the chain past the other note's window: that one goes.
        reserve_served_with(me, &v, Some(v.epoch + 2), false).unwrap();
        assert!(!take_served(me, later.payer, later.agent, later.entry_id), "dropped by a witnessed epoch");
        assert!(!past_by_witness(v.epoch, None) && !past_by_witness(v.epoch, Some(v.epoch + 1)) && past_by_witness(v.epoch, Some(v.epoch + 2)));
    }

    /// R7 sweep: a spent voucher and a refusal are let go of only by a witnessed epoch. While only the one RPC speaks
    /// (however far ahead it says the chain is), a voucher that bought a body can't buy another, and a refusal stays.
    #[test]
    fn spent_vouchers_and_refusals_are_pruned_only_by_a_witnessed_epoch() {
        let _home = crate::store::scratch_home("spent-witnessed");
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        std::fs::create_dir_all(chain::dir()).unwrap();
        spend(&v, None, U256::MAX).unwrap();
        assert!(spend(&v, None, U256::MAX).unwrap_err().contains("already paid"), "kept with no witness");
        let mut spent: Vec<Spent> = store::read_json_strict(&spent_path(), &unbrowse_files::SPENT_VOUCHERS).unwrap();
        let mut other = v.clone();
        other.nonce = FixedBytes::repeat_byte(4);
        spent_with(&mut spent, &other, Some(v.epoch + 2), U256::MAX).unwrap();
        assert!(!spent.iter().any(|s| s.nonce == v.nonce), "a witnessed epoch past its window lets it go");
        let refused = |until| Refused { why: "x".into(), until, line: None };
        let mut all = std::collections::BTreeMap::from([("a".to_string(), refused(10))]);
        prune_refusals(&mut all, None);
        assert_eq!(all.len(), 1, "no witness: kept");
        prune_refusals(&mut all, Some(5));
        assert_eq!(all.len(), 1, "still running at a witnessed epoch");
        prune_refusals(&mut all, Some(10));
        assert!(all.is_empty(), "ended at a witnessed epoch");
    }

    /// R8-CHAIN-2: a voucher whose window a witness has seen close is never served again, whatever the one RPC says
    /// the epoch is, after its spent entry was let go and after a restart; a named witness that can't be read refuses.
    #[test]
    fn an_expired_voucher_is_never_served_again_whatever_the_rpc_says() {
        let _home = crate::store::scratch_home("voucher-floor");
        let d = domain(5042, Address::repeat_byte(1));
        let v = signed(&d);
        std::fs::create_dir_all(chain::dir()).unwrap();
        assert!(voucher_open(v.epoch, v.epoch, None, 0, false).is_ok(), "one RPC, nothing witnessed: its window by that RPC");
        spend(&v, chain::seen_epoch(), U256::MAX).unwrap();
        // A witness reads the chain two epochs on: the floor rises and is kept; the spent entry may then go.
        chain::note_seen_epoch(v.epoch + 2);
        let mut spent: Vec<Spent> = store::read_json_strict(&spent_path(), &unbrowse_files::SPENT_VOUCHERS).unwrap();
        let mut other = v.clone();
        other.nonce = FixedBytes::repeat_byte(4);
        spent_with(&mut spent, &other, chain::seen_epoch(), U256::MAX).unwrap();
        assert!(!spent.iter().any(|s| s.nonce == v.nonce), "pruned once the floor passed its window");
        // A restart: the floor comes back from disk, and a lower witnessed epoch never lowers it.
        chain::forget_seen_in_memory();
        chain::note_seen_epoch(v.epoch);
        chain::forget_seen_in_memory();
        assert_eq!(chain::epoch_floor().unwrap(), v.epoch + 2);
        // The one RPC rolls back to the voucher's own epoch: refused by the floor.
        assert!(voucher_open(v.epoch, v.epoch, None, chain::epoch_floor().unwrap(), false).unwrap_err().contains("over"));
        assert!(voucher_open(v.epoch, v.epoch, Some(v.epoch + 3), 0, true).is_err(), "a witnessed epoch read now, past its window");
        assert!(voucher_open(v.epoch, v.epoch, None, 0, true).unwrap_err().contains("witness"), "a named witness that can't be read refuses");
        // A floor file that doesn't read serves nothing old: it is an error, never no floor.
        std::fs::write(chain::dir().join("epoch-floor.json"), "not json").unwrap();
        assert!(chain::epoch_floor().is_err());
    }

    /// R8-CHAIN-3: a refusal for an overdue backstop is kept, and the payer refused, whatever the one RPC says of its
    /// line, until a witness reads the line paid; with one, it is lifted from disk.
    #[test]
    fn a_refusal_is_lifted_only_on_a_witnessed_paid_line() {
        let _home = crate::store::scratch_home("refusal-witnessed");
        std::fs::create_dir_all(chain::dir()).unwrap();
        let payer = Address::repeat_byte(0x91);
        refuse_until_paid(payer, "its backstop claim is overdue", 10, FixedBytes::repeat_byte(1));
        // The one RPC says the line is spent; no witness stands behind it.
        assert!(held_by_refusal(payer, 0, None).is_err(), "refused");
        assert!(refusal(payer).is_some(), "and the refusal kept on disk");
        assert!(held_by_refusal(payer, 0, Some(false)).is_err(), "a witness reads it unpaid");
        assert!(held_by_refusal(payer, 0, Some(true)).is_ok(), "a witness reads it paid");
        assert!(refusal(payer).is_none(), "lifted");
    }

    /// A refusal ends with its epochs, by the witnessed floor, and early only when it named a line and that line was
    /// read paid with a witness (the caller passes `paid` only for a witnessed `Some(true)`, R8-CHAIN-3).
    #[test]
    fn only_a_paid_line_ends_a_refusal_early() {
        let curable = Refused { why: "late".into(), until: 40, line: Some(FixedBytes::repeat_byte(1)) };
        let flat = Refused { why: "its counts contradict".into(), until: 40, line: None };
        assert!(stands(&curable, 39, false), "the line is still unpaid");
        assert!(!stands(&curable, 39, true), "the line was paid");
        assert!(stands(&flat, 39, true), "nothing a claim does cures counts that contradict");
        assert!(!stands(&flat, 40, false), "and the refusal ends with its epochs");
    }

    /// A server catches a payer whose signed failure counts contradict the lines it holds (spec §76.2 item 5):
    /// fewer lines than the highest it holds, or fewer failures than it holds failed. Honest counts pass.
    #[test]
    fn signed_counts_that_contradict_the_servers_lines_are_caught() {
        let line = |index: u64, passed: bool, lines: u64, passed_lines: u64| chain::PaidLine {
            payer: Address::repeat_byte(1),
            agent: Address::repeat_byte(2),
            epoch: 9,
            cumulative: U256::ZERO,
            lines,
            passed_lines,
            receipts_root: FixedBytes::ZERO,
            signature: Default::default(),
            index: U256::from(index),
            entry_id: FixedBytes::ZERO,
            amount: U256::ZERO,
            passed,
            holders: vec![],
            bounty: U256::ZERO,
            proof: vec![],
        };
        let held = vec![line(0, false, 1, 0), line(1, false, 2, 0)];
        assert_eq!(contradicts(&line(2, true, 3, 1), &held), None, "three lines, two failed: honest");
        assert!(contradicts(&line(2, true, 3, 3), &held).unwrap().contains("2 failed lines"), "it says none failed");
        assert!(contradicts(&line(2, true, 2, 1), &held).unwrap().contains("counts 2 lines"), "it counts too few lines");
        let mut other = line(0, true, 1, 1);
        other.agent = Address::repeat_byte(3);
        assert_eq!(contradicts(&other, &held), None, "another stream's lines say nothing");
        assert!(contradicts(&line(0, false, 1, 1), &[]).is_some(), "its own failed line, counted passed");
    }

    #[test]
    fn a_voucher_outside_its_claim_window_is_never_kept() {
        assert!(claimable(5, 5) && claimable(5, 6));
        assert!(!claimable(5, 7), "too old");
        assert!(!claimable(9, 5), "not yet");
        assert!(!claimable(u64::MAX, 5));
    }

    #[test]
    fn an_endpoint_proof_holds_for_its_port_and_challenge_only() {
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let owner = chain::owner_signer(&keys).unwrap();
        let c = FixedBytes::repeat_byte(3);
        let sig = |port, c| format!("0x{}", hex::encode(owner.sign_hash_sync(&endpoint_digest(port, &c)).unwrap().as_bytes()));
        assert_eq!(recover_signer(&endpoint_digest(7788, &c), &sig(7788, c)).unwrap(), owner.address());
        assert_ne!(recover_signer(&endpoint_digest(7789, &c), &sig(7788, c)).unwrap(), owner.address(), "another port");
        assert_ne!(recover_signer(&endpoint_digest(7788, &FixedBytes::repeat_byte(4)), &sig(7788, c)).unwrap(), owner.address(), "an old challenge");
    }

    #[test]
    fn two_vouchers_signed_at_once_differ() {
        assert_ne!(fresh_nonce(), fresh_nonce());
    }
}
