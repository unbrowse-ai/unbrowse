//! The money, on a local chain (PRD §3 Figure 3, US-003, US-004, US-009, US-010, US-017, US-026; spec §27).
//!
//! The node runs Anvil with its state kept in `~/.unbrowse/devnet`, deploys the test USDC and UNB tokens, a stand-in
//! UNB/USDC pool seeded from the devnet's faucets, and then, from one key with nothing sent between them, the domain
//! proofs, the four route-coin contracts and the lean Settlement contract the first time, and signs every write with
//! the owner's root key. A new devnet forks Arc testnet (`arc`), so the real USDC and ERC-8004 registries sit at their
//! real addresses; it forks nothing when `UNBROWSE_DEVNET_FORK=none` or Arc testnet doesn't answer. Stock Anvil can't
//! reproduce Arc's own rules (the base fee's 20 Gwei floor, the blocklist, its precompiles): its fork lets the base fee
//! fall below the floor, so a devnet is cheaper than Arc, never dearer. The node never sets fees by hand; its
//! estimates are twice the base fee Arc reports plus a tip, which clears the floor. Agents' payments are real running
//! vouchers: each paid detail fetch adds a receipt line, the agent's key signs the voucher, and the node claims the
//! passed lines from the contract, which splits each one 65% to the entry's route coin, 30% to the site's escrow and
//! 5% bought and burned (R4.1, `coin.split`). The route's 65% goes to `CoinFetch`, which pays the coin's earlier staked,
//! checked holders their part of the fixed supply in USDC and buys the coin with the rest for the payer, staked for it
//! (`coin.fetch-pays`, `-buys`, `-stakes`; `chain::coins`). Fees settle in USDC and coins trade against UNB; the two
//! meet only in the pool Settlement names, where the fetch buys UNB and, once an epoch, the burn buffer buys UNB to
//! burn (`burnBatch`). There is no bond, no vesting and no fraud court (`bond.none`, `fraud.none`).
//! Arc testnet is the same contracts at another RPC URL.
//!
//! A node can instead run on a live Arc network (`chain` in Settings, or `UNBROWSE_CHAIN`): then no Anvil is started,
//! every call goes to the network's RPC, and the contracts are the ones every node on that network shares, read from
//! the network's file (`NetworkFile`). Gas is real there: each signer pays its own from the USDC it holds, and the
//! node never makes any.
//!
//! Devnet only: the faucet mints test UNB (on a live network only UNB's owner can), and "advance a day" moves the
//! chain's clock so withdrawals and exit delays can be seen without waiting.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use alloy::primitives::{keccak256, Address, Bytes, FixedBytes, U256};
use alloy::providers::{Provider, WalletProvider};
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::SignerSync;
use alloy::sol;
use serde::{Deserialize, Serialize};
use unbrowse_core::{KeyStore, RootKey};

use crate::arc;
use crate::rpc::ProviderBuilder;
use crate::store::{self, Activity};
use crate::sync::{Locked, Shared};

sol!(
    #[sol(rpc)]
    #[allow(clippy::too_many_arguments)]
    LeanSettlement,
    "contracts/LeanSettlement.json"
);
sol!(
    /// Where domains are proven by DNSSEC (R4.14), their escrow released and their site policy kept (R4.17):
    /// deployed first, naming the Settlement deployed after the coin contracts (`LeanSettlement.domains()`).
    #[sol(rpc)]
    #[allow(clippy::too_many_arguments)]
    Domains,
    "contracts/Domains.json"
);
sol!(
    #[sol(rpc)]
    UNB,
    "contracts/UNB.json"
);
sol!(
    #[sol(rpc)]
    USDC,
    "contracts/USDC.json"
);
sol!(
    #[sol(rpc)]
    UnbPool,
    "contracts/UnbPool.json"
);
sol!(
    #[sol(rpc)]
    V4UnbPool,
    "contracts/V4UnbPool.json"
);
sol! {
    /// What a deploy reads of a Uniswap v4 PoolManager: a word of its storage, to see that a pool's key names a pool
    /// before the adapter over it is sent.
    #[sol(rpc)]
    interface V4Manager {
        function extsload(bytes32 slot) external view returns (bytes32);
    }
}
sol! {
    /// What the node calls of `Listings` (made by Settlement's own constructor, at `listings()`): the EIP-712 digest a
    /// listing's contributor signs; showing listings at their first claim (`showAndClaim`), which credits an entry to
    /// the earliest listing of its content (R2.18); and where an entry's credited listing sits.
    #[sol(rpc)]
    #[allow(clippy::too_many_arguments)]
    interface ListingsDigest {
        struct Listing {
            string routeId;
            string site;
            string contentId;
            string agentId;
            uint64 version;
            string supersedes;
            bytes32 terms;
        }
        struct Shown {
            Listing listing;
            bytes sig;
            bytes32 root;
            uint256 index;
            bytes32[] proof;
        }
        struct Voucher {
            address payer;
            address agent;
            uint64 epoch;
            uint256 cumulative;
            uint64 lines;
            uint64 passedLines;
            bytes32 receiptsRoot;
        }
        struct Line {
            uint256 index;
            bytes32 entryId;
            uint256 amount;
            bool passed;
            address[] holders;
            uint256 bounty;
        }
        function digest(Listing calldata l) external view returns (bytes32);
        function show(Shown[] calldata shown) external;
        function correctCredit(Shown calldata shown) external;
        function showAndClaim(
            Shown[] calldata shown, bytes[] calldata terms, Voucher[] calldata vs, bytes[] calldata agentSigs,
            Line[] calldata lines, bytes32[][] calldata proofs
        ) external;
        function placeOf(bytes32 entryId) external view returns (address contributor, uint64 rootBlock, uint24 leaf);
        function entryIdOf(string calldata contentId) external pure returns (bytes32);
        event Credited(bytes32 indexed entryId, address indexed contributor, bytes32 indexed root, uint64 rootBlock, uint24 leaf, address previous);
    }
}
sol! {
    /// What the node reads of Settlement's DNSSEC verifier (`FixedDNSSEC`, made by Settlement's own constructor, so its
    /// code is part of Settlement's): the trust anchors it proves domains from.
    #[sol(rpc)]
    interface DnssecVerifier {
        function anchors() external view returns (bytes);
    }
}

/// The devnet's port; `UNBROWSE_DEVNET_PORT` moves it (tests run their own chain beside the app's).
fn port() -> u16 {
    std::env::var("UNBROWSE_DEVNET_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8546)
}
/// Spec values (§26, protocol/params.toml [claims]): a 24-hour epoch. `EPOCH` is what an epoch is meant to last, in
/// seconds: the chain counts it in blocks (`Deployment::epoch_blocks`, R1.28), so a rule that says when something
/// falls due counts blocks, and this only turns a count of blocks into a time to show or wait. Claims are paid whole:
/// there is no vesting and no bond (`bond.none`).
pub const EPOCH: u64 = 86_400;
/// A devnet's epoch, in blocks. Anvil mines a block per write, so it takes more writes than a test makes to cross one
/// by chance, and few enough that `advance_day` mines it in a moment and Anvil's saved state stays small.
pub(crate) const DEVNET_EPOCH_BLOCKS: u64 = 14_400;
/// The values the papers leave OPEN (owner) that the contracts take at deployment (R10.11): none any more. The domain
/// witnesses' deposit, fee and minority loss went with the witnesses (owner, 11 November 2026), and the juror stake
/// with the fraud court, so `chain deploy` asks for none.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OpenValues {}

impl OpenValues {
    /// Nothing to check: there is no open value left.
    pub(crate) fn units(&self) -> Result<(), String> {
        Ok(())
    }
}

/// The devnet's stand-in for the open values: there are none.
pub(crate) const DEVNET_OPEN: OpenValues = OpenValues {};
/// How many epochs after a domain's wallet is proven its escrow is released to it (`escrow.wait`), unless the deploy
/// names another (`escrow_wait`) (R4.14); two weeks gives a
/// domain's real owner time to notice a hijacked record and prove a newer one before any USDC moves.
pub const ESCROW_WAIT: u64 = 14;

/// The escrow wait a deploy gives Settlement (R4.14, `escrow.wait`): what the network's file names
/// (`escrow_wait`), else `UNBROWSE_ESCROW_WAIT`, else `ESCROW_WAIT`. It is a constructor argument, fixed for the
/// deployment's life, so choosing another means a new deployment.
pub fn escrow_wait(file: Option<u64>) -> Result<u64, String> {
    let w = match file {
        Some(w) => w,
        None => match std::env::var("UNBROWSE_ESCROW_WAIT").ok().filter(|v| !v.trim().is_empty()) {
            None => ESCROW_WAIT,
            Some(v) => v.trim().parse().map_err(|_| format!("UNBROWSE_ESCROW_WAIT={v} isn't a number of epochs"))?,
        },
    };
    Ok(w)
}
/// The DNSSEC trust anchors every Settlement this node deploys proves domains from (R4.14): the IANA root's DS records
/// for KSK-2017 (key tag 20326) and KSK-2024 (38696), algorithm 8, SHA-256, in the wire form ENS's verifier reads
/// (https://data.iana.org/root-anchors/root-anchors.xml). A live network's Settlement with other anchors is refused
/// (`usable`), so a test zone's root never decides a real domain's escrow.
pub const ROOT_ANCHORS: [u8; 94] = alloy::hex!(
    "00002b000100000e1000244f660802e06d44b80b8f1d39a95c0b0d7c65d08458e880409bbc683457104237c7f8ec8d"
    "00002b000100000e10002497280802683d2d0acb8c9b712a1948b27f741219298d0a450d612c483af444a4c0fb2b16"
);
/// What a stand-in pool is seeded with when its deployer mints both tokens, in whole tokens of each: one USDC a UNB,
/// deep enough that a day of a devnet's claims barely moves it (Settlement refuses a swap that would move it 1%).
const POOL_SEED: u64 = 1_000_000;

/// Where the node keeps what it signed and is owed on the chain it runs on: the devnet's folder, or one for each live
/// network, so a receipt made on one chain is never claimed on another.
pub(crate) fn dir() -> PathBuf {
    match live() {
        Some(l) => store::home().join(l.net.name),
        None => store::home().join("devnet"),
    }
}

/// Whether a file of a chain's folder holds through a new deployment on that chain: the chain's own keys, state and
/// the record of the deployment, and what is already set aside. `sending.json` is the chain's too: it says what is out
/// by nonce and hash, whatever contract the write was for. Named this way round so that state added later starts out
/// the deployment's, where a stale reading can't act on the new contracts.
fn outlasts_a_deployment(name: &str) -> bool {
    // The locks too: a lock moved aside while held is no lock, since the next process to ask makes a new file in its
    // place and takes that.
    matches!(name, "root.key" | "deployer.key" | "mark.key" | "deployment.json" | "network.json" | "state.json" | "sending.json") || name.starts_with("before-") || name.ends_with(".lock")
}

/// Makes `d` the deployment `dir()` holds the state of, recording it in `deployment.json`, on the devnet and on a live
/// network alike. A deployment restarts the chain's counts: bounty ids and the epochs of a line all
/// start over under the same names, and a record of the last one would be read as this one's: a receipt line already
/// paid by the last Settlement, signed again into this one's voucher, would be paid again. So state from another
/// deployment goes to `before-<settlement>-<time>/`, kept for the owner and read by nothing. A folder with no record
/// can't say whose its state is, so it is another deployment's too. `fresh` is for a deployment just made: a devnet
/// whose chain was wiped deploys at the same addresses, so only the deploying says it is new.
fn own_folder(d: &Deployment, fresh: bool) -> Result<(), String> {
    let record = dir().join("deployment.json");
    let kept: Option<Deployment> = store::read_json_opt(&record, &unbrowse_files::DEPLOYMENT);
    match kept {
        Some(old) if !fresh && old.settlement == d.settlement => {}
        Some(old) => set_aside(&format!("{:#x}", old.settlement))?,
        None => set_aside("unrecorded")?,
    }
    store::write_json(&record, &unbrowse_files::DEPLOYMENT, d)
}

/// Moves what `dir()` holds of the deployment `whose` names out of the way. Stops at the first file that won't move,
/// and `own_folder` then records nothing, so the next start finishes the job.
fn set_aside(whose: &str) -> Result<(), String> {
    let to = dir().join(format!("before-{whose}-{}", store::now()));
    let e = |e: std::io::Error| format!("couldn't set aside the last deployment's files: {e}");
    let mut moved = 0;
    for f in std::fs::read_dir(dir()).map_err(e)?.flatten() {
        if !outlasts_a_deployment(&f.file_name().to_string_lossy()) {
            std::fs::create_dir_all(&to).map_err(e)?;
            std::fs::rename(f.path(), to.join(f.file_name())).map_err(e)?;
            moved += 1;
        }
    }
    if moved > 0 {
        store::log_activity(&store::Activity {
            at: store::now(),
            who: "This node".into(),
            site: "Settlement".into(),
            what: "Started on a new deployment".into(),
            kind: "network".into(),
            result: "done".into(),
            ms: None,
            unb: None,
            tx: None,
            note: Some(format!("What this node kept of the last one ({whose}) is in {}", to.display())),
        });
    }
    Ok(())
}

// ---- which chain ----

/// A live network the node runs on, and the RPC it reaches it at.
#[derive(Clone, Debug)]
pub struct Live {
    pub net: &'static arc::Network,
    pub rpc: reqwest_url::Url,
}

/// The chain the node runs on: its own devnet, or a live Arc network.
#[derive(Clone, Debug)]
pub enum Mode {
    Devnet,
    Live(Live),
}

/// The chain's name as the setting writes it.
pub const DEVNET: &str = "devnet";

/// The names the setting takes: the devnet's, and each Arc network's.
pub fn names() -> Vec<&'static str> {
    std::iter::once(DEVNET).chain(arc::NETWORKS.iter().map(|n| n.name)).collect()
}

/// The chain this node runs on: `UNBROWSE_CHAIN` when set, else the `chain` setting; on a live network, the RPC
/// `UNBROWSE_RPC` names, else Unbrowse's gateway while the node holds a pass it hasn't refused (`gateway::url_for`),
/// else the network's public RPC from the table. Read once, when the chain starts.
pub fn chosen() -> Result<Mode, String> {
    let env = |k: &str| std::env::var(k).ok();
    choose(env("UNBROWSE_CHAIN").as_deref(), &store::load_settings().chain, env("UNBROWSE_RPC").as_deref(), crate::gateway::url_for)
}

fn choose(env: Option<&str>, setting: &str, rpc: Option<&str>, gateway: impl Fn(&str) -> Option<String>) -> Result<Mode, String> {
    fn given(v: Option<&str>) -> Option<&str> {
        v.map(str::trim).filter(|v| !v.is_empty())
    }
    let name = given(env).or(given(Some(setting))).unwrap_or(DEVNET);
    if name == DEVNET {
        return Ok(Mode::Devnet);
    }
    let net = arc::by_name(name).ok_or_else(|| format!("there's no chain named {name}: it is one of {}", names().join(", ")))?;
    let through = gateway(net.name);
    let rpc = given(rpc).or(through.as_deref()).unwrap_or(net.rpc);
    let rpc = rpc.parse().map_err(|e| format!("the RPC {rpc} isn't a URL: {e}"))?;
    Ok(Mode::Live(Live { net, rpc }))
}

/// The live network this process's chain started on, if it started on one. Every provider reads its RPC from here.
static LIVE: RwLock<Option<Live>> = RwLock::new(None);

pub fn live() -> Option<Live> {
    LIVE.reading().clone()
}

fn set_live(l: Option<Live>) {
    *LIVE.writing() = l;
}

/// The chain ID of the devnet this process started and proved its own (its mark, `devnet_mark`), as it said it then.
static DEVNET_CHAIN: RwLock<Option<u64>> = RwLock::new(None);

/// The chain ID every transaction and typed signature the node makes names (`rpc::signing_chain`): the live network's
/// own, from the build's table, or the devnet's as it answered when the node proved it its own. Never what an RPC says
/// later.
pub fn signing_chain_id() -> Option<u64> {
    match live() {
        Some(l) => Some(l.net.chain_id),
        None => *DEVNET_CHAIN.reading(),
    }
}

/// Back to the devnet, for a test that started a live chain.
#[cfg(test)]
pub fn forget_live() {
    set_live(None);
}

/// Whether a live network's RPC answers as the chain it is named for. Nothing goes on before it does: a node that
/// signed on the wrong chain would pay there.
async fn check_rpc(l: &Live) -> Result<(), String> {
    let p = ProviderBuilder::new().connect_http(l.rpc.clone());
    let at = crate::gateway::shown(l.rpc.as_str());
    match tokio::time::timeout(Duration::from_secs(10), p.get_chain_id()).await {
        Ok(Ok(id)) if id == l.net.chain_id => Ok(()),
        Ok(Ok(id)) => Err(format!("the RPC at {at} is chain {id}, not {} ({})", l.net.name, l.net.chain_id)),
        Ok(Err(e)) => Err(format!("{} doesn't answer at {at}: {}", l.net.name, crate::gateway::scrub(&e.to_string()))),
        Err(_) => Err(format!("{} didn't answer at {at} within 10 seconds", l.net.name)),
    }
}

/// `check_rpc` for the RPC the node chose. When that is Unbrowse's gateway and it fails, the node goes on with the
/// network's public RPC: for good when the gateway refused this node (not a member; the owner is told once), for this
/// start when it didn't answer (down, or its name doesn't resolve), so a renewed pass can take the gateway again. The
/// live network it ends on.
async fn check_or_public(l: Live) -> Result<Live, String> {
    let through = crate::gateway::is_gateway(l.rpc.as_str());
    check_or_public_from(l, through).await
}

async fn check_or_public_from(l: Live, through_gateway: bool) -> Result<Live, String> {
    let e = match check_rpc(&l).await {
        Ok(()) => return Ok(l),
        Err(e) if through_gateway => e,
        Err(e) => return Err(e),
    };
    let refused = crate::gateway::refusal(&e);
    if refused {
        crate::gateway::refuse(&e);
        store::tell_once(&dir().join("gateway-refused"), &crate::gateway::refused_note(&e));
    }
    let public = Live { net: l.net, rpc: l.net.rpc.parse().map_err(|e| format!("the RPC {} isn't a URL: {e}", l.net.rpc))? };
    set_live(Some(public.clone()));
    match check_rpc(&public).await {
        Ok(()) => {
            if !refused {
                eprintln!("chain: Unbrowse's RPC didn't answer ({e}): the node reads {}'s public RPC until its pass is renewed", l.net.name);
            }
            Ok(public)
        }
        Err(p) if refused => Err(p),
        Err(p) => Err(format!("{e}; and the public RPC: {p}")),
    }
}

/// What a deployment that recorded no decimals for its USDC counts in: every one made before they were recorded was a
/// test USDC of 18.
fn eighteen() -> u8 {
    18
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Deployment {
    pub usdc: Address,
    /// The decimals Settlement's USDC counts in, read from it once when the deployment is made (`decimals()`): every
    /// fee, deposit, cap, claim and earning on this deployment is in units of it.
    #[serde(default = "eighteen")]
    pub usdc_decimals: u8,
    pub unb: Address,
    /// The UNB/USDC pool Settlement swaps through (R9.27), fixed when it was deployed: nobody can name another.
    #[serde(default)]
    pub pool: Address,
    pub settlement: Address,
    /// Settlement's DNSSEC verifier (`LeanSettlement.dnssec()`), made by the domain proofs' constructor on `ROOT_ANCHORS`; zero in a
    /// deployment made before it existed.
    #[serde(default)]
    pub dnssec: Address,
    /// Where domains are proven and their escrow released (`LeanSettlement.domains()`, R4.14); zero in a
    /// deployment made before it existed.
    #[serde(default)]
    pub domains: Address,
    /// The epochs a proven domain waits before its escrow is released (`Domains.escrowWait()`).
    #[serde(default)]
    pub escrow_wait: u64,
    /// One epoch, in this chain's blocks (`LeanSettlement.epochBlocks()`, R1.28): the unit of every rule that says when
    /// something falls due. A live network's is the chain's word, read when the deployment is checked (`usable`).
    #[serde(default)]
    pub epoch_blocks: u64,
    /// The route-coin contracts Settlement pays the route share to and the node trades, stakes and posts bounties
    /// through (`chain::coins`): the object `script/DeployCoins.s.sol` prints, kept under `coins`. Zero addresses in a
    /// deployment made before route coins: such a deployment is not one this node runs on.
    #[serde(default)]
    pub coins: Coins,
    pub chain_id: u64,
    pub block: u64,
    /// The contracts' code this deployment was made from: when the node's contracts change, the devnet gets new ones.
    /// A live network is never judged by it: the node reads what runs there (`conform`).
    #[serde(default)]
    pub code: String,
}

impl Default for Deployment {
    fn default() -> Self {
        Deployment {
            usdc: Address::ZERO,
            usdc_decimals: eighteen(),
            unb: Address::ZERO,
            pool: Address::ZERO,
            settlement: Address::ZERO,
            dnssec: Address::ZERO,
            domains: Address::ZERO,
            escrow_wait: 0,
            epoch_blocks: 0,
            coins: Coins::default(),
            chain_id: 0,
            block: 0,
            code: String::new(),
        }
    }
}

impl Deployment {
    /// One epoch in blocks, never zero: every rule below divides by it, and a hand-written file may not say.
    pub fn blocks_per_epoch(&self) -> u64 {
        self.epoch_blocks.max(1)
    }

    /// A sum of this deployment's USDC moved or capped, in its units (`usdc_units`).
    pub fn usdc_units(&self, x: f64) -> U256 {
        usdc_units(x, self.usdc_decimals)
    }

    /// A fee in this deployment's USDC, in its units (`usdc_fee_units`).
    pub fn fee_units(&self, x: f64) -> U256 {
        usdc_fee_units(x, self.usdc_decimals)
    }

    /// Units of this deployment's USDC, as whole USDC.
    pub fn usdc_f(&self, x: U256) -> f64 {
        usdc_f(x, self.usdc_decimals)
    }
}

/// The route-coin contracts of a deployment, as `script/DeployCoins.s.sol` prints them (`unbrowse-settlement/script/
/// README-coins.md`): the factory and curves (`RouteCoins`) with the implementation every coin is a clone of, the
/// stakes, the fetch Settlement pays the route share to, and the bounties.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coins {
    #[serde(default)]
    pub route_coins: Address,
    #[serde(default)]
    pub route_coin_implementation: Address,
    #[serde(default)]
    pub coin_stakes: Address,
    #[serde(default)]
    pub coin_fetch: Address,
    #[serde(default)]
    pub coin_bounties: Address,
    /// What the deploy script prints beside the addresses: the chain and the head it ran against. Read and kept, never
    /// trusted: the deployment's own `chain_id` and `block` are the ones the node holds it to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<u64>,
}

impl Coins {
    /// Whether every coin contract a node trades, stakes and posts through is named.
    pub fn named(&self) -> bool {
        [self.route_coins, self.route_coin_implementation, self.coin_stakes, self.coin_fetch, self.coin_bounties].iter().all(|a| *a != Address::ZERO)
    }
}

/// What the node's contracts are, by their creation code.
fn code_hash() -> String {
    let mut all = LeanSettlement::BYTECODE.to_vec();
    // Every contract a deployment makes: `deploy_as` deploys Domains and the coin set with every Settlement, and
    // V4UnbPool where a v4 pool backs it, so a change to any is a new devnet too.
    for code in [
        &Domains::BYTECODE,
        &UNB::BYTECODE,
        &USDC::BYTECODE,
        &UnbPool::BYTECODE,
        &V4UnbPool::BYTECODE,
        &RouteCoins::BYTECODE,
        &CoinStakes::BYTECODE,
        &CoinFetch::BYTECODE,
        &CoinBounties::BYTECODE,
    ] {
        all.extend_from_slice(code);
    }
    format!("{:#x}", keccak256(&all))
}

/// Addresses a deployment fixed when it was made (its listings), by Settlement and name: read once a
/// run, since nothing changes them, rather than on every pass that needs them.
static FIXED: std::sync::Mutex<Vec<(Address, &'static str, Address)>> = std::sync::Mutex::new(Vec::new());

pub(crate) fn fixed(settlement: Address, name: &'static str) -> Option<Address> {
    FIXED.locked().iter().find(|(s, n, _)| *s == settlement && *n == name).map(|(_, _, a)| *a)
}

/// Records `at` as the deployment's `name`, over anything kept before: what the deployment check verified is the word.
pub(crate) fn pin_fixed(settlement: Address, name: &'static str, at: Address) {
    let mut all = FIXED.locked();
    all.retain(|(s, n, _)| !(*s == settlement && *n == name));
    all.push((settlement, name, at));
}

pub(crate) fn keep_fixed(settlement: Address, name: &'static str, at: Address) {
    let mut all = FIXED.locked();
    if !all.iter().any(|(s, n, _)| *s == settlement && *n == name) {
        all.push((settlement, name, at));
    }
}

pub struct Chain {
    anvil: Mutex<Option<Child>>,
    pub deployment: Mutex<Option<Deployment>>,
    /// The live network the chain started on; `None` on the devnet.
    live: Mutex<Option<Live>>,
    /// Where the network's registrations start, from its file (live only).
    registry_from: Mutex<Option<u64>>,
    /// Why Settlement can't be used on the live network, while it can't.
    unavailable: Mutex<Option<String>>,
}

impl Default for Chain {
    fn default() -> Self {
        Self {
            anvil: Mutex::new(None),
            deployment: Mutex::new(None),
            live: Mutex::new(None),
            registry_from: Mutex::new(None),
            unavailable: Mutex::new(None),
        }
    }
}

impl Drop for Chain {
    fn drop(&mut self) {
        if let Some(mut c) = self.anvil.locked().take() {
            let _ = c.kill();
        }
    }
}

/// The key that deploys the devnet's contracts and runs its faucet, made for each devnet and kept in it. Anvil's own
/// accounts are not used: their keys are public, and on a fork of Arc anyone may already have changed them (account
/// #0 carries an EIP-7702 delegation on Arc testnet, so the ERC-8004 registry refuses to mint to it).
fn deployer() -> Result<PrivateKeySigner, String> {
    let path = dir().join("deployer.key");
    if let Ok(hex) = std::fs::read_to_string(&path) {
        return hex.trim().parse().map_err(|e: alloy::signers::local::LocalSignerError| e.to_string());
    }
    let key = PrivateKeySigner::random();
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{:#x}", key.to_bytes())).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

/// The devnet's mark: an account only its own secret names, and the balance the node gives it on a chain it starts.
/// The secret is made with the devnet and kept in it, readable by this user only, so a listener the node didn't start
/// counts as this devnet only if it holds the mark: another process that took the port can't know where to look.
fn devnet_mark() -> Result<(Address, U256), String> {
    let path = dir().join("mark.key");
    let saved = std::fs::read_to_string(&path).ok().and_then(|h| hex::decode(h.trim()).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok());
    let secret = match saved {
        Some(s) => s,
        None => {
            let mut s = [0u8; 32];
            getrandom::fill(&mut s).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
            std::fs::write(&path, hex::encode(s)).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            s
        }
    };
    Ok(mark_of(&secret))
}

fn mark_of(secret: &[u8; 32]) -> (Address, U256) {
    let account = Address::from_slice(&keccak256([&secret[..], b"unbrowse/devnet-mark/account"].concat())[12..]);
    let balance = U256::from_be_slice(&keccak256([&secret[..], b"unbrowse/devnet-mark/balance"].concat())[..8]) + U256::from(1u64);
    (account, balance)
}

/// What a devnet forks, recorded when it is made.
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct DevnetNetwork {
    fork: Option<String>,
}

/// What this devnet forks, decided when it is made and kept for its life: Arc testnet, unless
/// `UNBROWSE_DEVNET_FORK=none`, or another Arc network named there, or nothing when that network doesn't answer. A
/// devnet made before this was recorded forks nothing.
async fn devnet_fork() -> Option<&'static arc::Network> {
    let path = dir().join("network.json");
    if path.exists() {
        let saved: DevnetNetwork = store::read_json(&path, &unbrowse_files::DEVNET_NETWORK);
        return saved.fork.as_deref().and_then(arc::by_name);
    }
    let wanted = if dir().join("state.json").exists() {
        None
    } else {
        match std::env::var("UNBROWSE_DEVNET_FORK").ok().as_deref() {
            Some("none") | Some("") => None,
            Some(name) => arc::by_name(name),
            None => Some(&arc::ARC_TESTNET),
        }
    };
    let fork = match wanted {
        Some(n) if answers(n).await => Some(n),
        _ => None,
    };
    let _ = store::write_json(&path, &unbrowse_files::DEVNET_NETWORK, &DevnetNetwork { fork: fork.map(|n| n.name.to_string()) });
    fork
}

/// Whether a network's RPC answers, as the chain it says it is.
async fn answers(n: &arc::Network) -> bool {
    let Ok(url) = n.rpc.parse() else { return false };
    let p = ProviderBuilder::new().connect_http(url);
    matches!(tokio::time::timeout(Duration::from_secs(5), p.get_chain_id()).await, Ok(Ok(id)) if id == n.chain_id)
}

fn anvil_bin() -> PathBuf {
    unbrowse_files::private::user_home().join(".foundry").join("bin").join(format!("anvil{}", std::env::consts::EXE_SUFFIX))
}

pub(crate) fn owner_signer(keys: &(dyn KeyStore + Sync)) -> Result<PrivateKeySigner, String> {
    let root = RootKey::load(keys).map_err(|e| e.to_string())?;
    PrivateKeySigner::from_slice(&*root.secret()).map_err(|e| e.to_string())
}

pub(crate) fn agent_signer(keys: &(dyn KeyStore + Sync), index: u32) -> Result<PrivateKeySigner, String> {
    let root = RootKey::load(keys).map_err(|e| e.to_string())?;
    PrivateKeySigner::from_slice(&*root.agent(index).secret()).map_err(|e| e.to_string())
}

/// The RPC every provider uses: the live network's, or the devnet's on loopback.
/// What a node on a live network with no deployment recorded says, wherever a chain write or read is refused: this
/// build runs only on the route-coin contracts (`decide.old-testnet-dropped`: the deployment from before them is no
/// longer read), so until they are deployed there it sends nothing there, and runs its identity and nothing else.
pub fn not_deployed(network: &str) -> String {
    format!(
        "{network} has no route-coin contracts yet: this build runs only on them (the deployment from before route coins is no longer used), so the node sends no transaction on {network} until they are deployed and recorded in its network file (`unbrowse-node chain deploy`)"
    )
}

/// Back onto Unbrowse's gateway at `url`, for a node that fell to the public RPC because the gateway refused it or
/// didn't answer: the live network to read from now on when the gateway answers there as that network (its owner
/// signed in since), `None` when the node is on the gateway already or the gateway still doesn't take it.
async fn retaken(l: &Live, url: &str) -> Option<Live> {
    if crate::gateway::is_gateway(l.rpc.as_str()) {
        return None;
    }
    let back = Live { net: l.net, rpc: url.parse().ok()? };
    check_rpc(&back).await.ok().map(|()| back)
}

/// `retaken` for the live network: true when the node reads through the gateway again from now on.
pub async fn retake(url: &str) -> bool {
    let Some(l) = live() else { return false };
    match retaken(&l, url).await {
        Some(back) => {
            set_live(Some(back));
            true
        }
        None => false,
    }
}

/// Whether the live network is read through Unbrowse's gateway.
pub fn on_gateway() -> bool {
    live().is_some_and(|l| crate::gateway::is_gateway(l.rpc.as_str()))
}

/// Points the live network's reads at `url` from now on (the gateway's, with a renewed pass): every provider made after
/// this reads there.
pub fn use_rpc(url: &str) {
    if let (Some(mut l), Ok(rpc)) = (live(), url.parse()) {
        l.rpc = rpc;
        set_live(Some(l));
    }
}

pub(crate) fn url() -> reqwest_url::Url {
    match live() {
        Some(l) => l.rpc,
        None => format!("http://127.0.0.1:{}", port()).parse().expect("static url"),
    }
}

mod reqwest_url {
    pub use alloy::transports::http::reqwest::Url;
}

impl Chain {
    /// Starts the chain the node runs on (`chosen`). The devnet always has its contracts; a live network may have none
    /// recorded yet, and the node runs without them.
    pub async fn start(&self) -> Result<Option<Deployment>, String> {
        match chosen()? {
            Mode::Devnet => self.start_devnet().await.map(Some),
            Mode::Live(l) => self.start_live(l).await,
        }
    }

    /// Joins a live network: its RPC must answer as the chain it is named for, and its contracts are the ones its file
    /// records. Nothing is started and no cheat is used. With none recorded the node still runs (its identity, the
    /// peer network), and only what needs Settlement says why it can't.
    async fn start_live(&self, l: Live) -> Result<Option<Deployment>, String> {
        // Named before the RPC is asked: a node waiting on its network's RPC is still on that network, so `dir` and `url`
        // must never answer with the devnet's folder and port meanwhile, however long the wait.
        set_live(Some(l.clone()));
        // One process signs from a chain's folder: a second, reading the same nonces, kept writes and gas count, would
        // sign beside it.
        store::hold_for_process(&dir())?;
        let l = check_or_public(l).await?;
        let file = network_file(l.net)?;
        // Told once at the start, not only when a write is held back: what one RPC alone holds back.
        if let (state @ ("missing" | "misnamed"), Some(held)) = crate::rpc::second_rpc_state() {
            store::tell_once(&dir().join("no-second-rpc"), &format!("Second RPC {state}: {held}"));
        }
        *self.live.locked() = Some(l.clone());
        *self.registry_from.locked() = file.registry_from;
        Ok(self.settle(&l, &file).await.ok())
    }

    /// Takes the Settlement `file` records on the live network `l`, if it can be used, or says why not.
    async fn settle(&self, l: &Live, file: &NetworkFile) -> Result<Deployment, Missing> {
        let p = ProviderBuilder::new().connect_http(l.rpc.clone());
        let found = match &file.deployment {
            Some(d) => usable(&p, l.net, d, file.epoch_blocks).await,
            None => Err(Missing::Absent(not_deployed(l.net.name))),
        };
        // A folder still holding another deployment's state is no state to run on: Settlement waits until it is moved.
        let found = found.and_then(|d| own_folder(&d, false).map(|()| d).map_err(Missing::Absent));
        match &found {
            Ok(d) => {
                *self.unavailable.locked() = None;
                set_line_decimals(d.usdc_decimals);
                *self.deployment.locked() = Some(d.clone());
            }
            Err(why) => *self.unavailable.locked() = Some(why.why().to_string()),
        }
        found
    }

    /// Looks for Settlement again on a live network where it couldn't be used when the chain started: the network's
    /// file read afresh, the contract it names checked again. A node that started while its RPC didn't answer takes
    /// Settlement once it does, with no restart. `Ok` once Settlement is usable, as it always is on the devnet once
    /// started.
    pub async fn find_settlement(&self) -> Result<(), Missing> {
        if self.deployed().is_ok() {
            return Ok(());
        }
        let Some(l) = self.live.locked().clone() else { return Err(Missing::Unreachable("the local chain is still starting".into())) };
        let file = network_file(l.net).map_err(Missing::Absent)?;
        *self.registry_from.locked() = file.registry_from;
        self.settle(&l, &file).await.map(|_| ())
    }

    /// Starts Anvil (or finds it running) and deploys the contracts if this chain has never seen them.
    async fn start_devnet(&self) -> Result<Deployment, String> {
        set_live(None);
        std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
        store::hold_for_process(&dir())?;
        let probe = ProviderBuilder::new().connect_http(url());
        let mut started = false;
        if probe.get_chain_id().await.is_err() {
            let bin = anvil_bin();
            if !bin.exists() {
                return Err("Anvil isn't installed (~/.foundry/bin/anvil); run foundryup".into());
            }
            let mut anvil = Command::new(bin);
            // Loopback only, and no CORS: a web page in a browser on this machine can't drive the chain the node
            // trusts for its agents' caps, its listings and its fees.
            anvil.args(["--host", "127.0.0.1", "--port", &port().to_string(), "--no-cors", "--silent", "--state-interval", "5"]);
            // Anvil's finalized block runs two epochs behind its head; with none, each block is final as it is made,
            // as Arc's are, so a write the devnet mines counts at once (`rpc::finalized`).
            anvil.args(["--slots-in-an-epoch", &devnet_epoch_slots()?.to_string()]);
            match devnet_fork().await {
                // The fork brings the network's chain ID, base fee and contracts.
                Some(n) => anvil.args(["--fork-url", n.rpc]),
                None => anvil.args(["--chain-id", &arc::LOCAL_CHAIN_ID.to_string(), "--base-fee", &arc::BASE_FEE_FLOOR.to_string()]),
            };
            let mut child = anvil
                .arg("--state")
                .arg(dir().join("state.json"))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("couldn't start Anvil: {e}"))?;
            // A fork reads its first state over the network.
            for _ in 0..300 {
                if probe.get_chain_id().await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            // An Anvil that couldn't take the port has stopped: what answers there is something else.
            if !matches!(child.try_wait(), Ok(None)) {
                return Err(format!("Anvil couldn't start on 127.0.0.1:{}: something else holds the port", port()));
            }
            *self.anvil.locked() = Some(child);
            started = true;
        }
        let (mark, balance) = devnet_mark()?;
        if started {
            let _: serde_json::Value = probe.raw_request("anvil_setBalance".into(), (mark, balance)).await.map_err(|e| e.to_string())?;
        } else if probe.get_balance(mark).await.ok() != Some(balance) {
            return Err(format!(
                "something on 127.0.0.1:{} answers as a chain but can't show it is this node's devnet; stop it, or set UNBROWSE_DEVNET_PORT",
                port()
            ));
        }
        // The devnet is proven this node's own: the chain it says it is now is the one every write names from here on.
        *DEVNET_CHAIN.writing() = Some(probe.get_chain_id().await.map_err(|e| e.to_string())?);
        let saved: Option<Deployment> = store::read_json_opt(&dir().join("deployment.json"), &unbrowse_files::DEPLOYMENT);
        if let Some(d) = saved {
            let code = probe.get_code_at(d.settlement).await.map_err(|e| e.to_string())?;
            // A record made on another chain is no deployment of this one: its domains would name that chain.
            if !code.is_empty() && d.code == code_hash() && Some(d.chain_id) == *DEVNET_CHAIN.reading() {
                set_line_decimals(d.usdc_decimals);
                *self.deployment.locked() = Some(d.clone());
                return Ok(d);
            }
        }
        // A new Anvil is at block 0, in epoch 0, which the contracts read as "never" in places: a chain they run on is
        // always past its first epoch (Arc is hundreds in), so a devnet starts past it too.
        if probe.get_block_number().await.map_err(|e| e.to_string())? < DEVNET_EPOCH_BLOCKS {
            mine_epochs(&probe, DEVNET_EPOCH_BLOCKS, 1).await?;
        }
        let d = deploy_as(deployer()?, DEPLOY_GAS, &Existing::default(), None, devnet_usdc_decimals()?, None, escrow_wait(None)?, DEVNET_EPOCH_BLOCKS, &DEVNET_OPEN, Progress::default(), &|_: &Progress| Ok(())).await?;
        own_folder(&d, true)?;
        set_line_decimals(d.usdc_decimals);
        *self.deployment.locked() = Some(d.clone());
        Ok(d)
    }

    pub fn deployed(&self) -> Result<Deployment, String> {
        if let Some(d) = self.deployment.locked().clone() {
            return Ok(d);
        }
        Err(self.unavailable.locked().clone().unwrap_or_else(|| "the local chain is still starting".into()))
    }

    /// The live network the chain started on; `None` on the devnet.
    pub fn network(&self) -> Option<&'static arc::Network> {
        self.live.locked().as_ref().map(|l| l.net)
    }

    /// The ID of the chain the node runs on, once it has started: a live network's, or the devnet's.
    pub fn chain_id(&self) -> Result<u64, String> {
        match self.network() {
            Some(net) => Ok(net.chain_id),
            None => self.deployed().map(|d| d.chain_id),
        }
    }

    /// The block to read ERC-8004 registrations from: on a live network the one its file names (else its
    /// deployment's), on the devnet its first.
    pub fn registry_from(&self) -> Result<u64, String> {
        match self.network() {
            Some(_) => Ok(self.registry_from.locked().or_else(|| self.deployed().ok().map(|d| d.block)).unwrap_or(0)),
            None => self.deployed().map(|d| d.block),
        }
    }

    /// Whether the chain the node reads runs on this machine, as the devnet's Anvil does: then only nodes on this
    /// machine share its registry, and the peer network stays on loopback.
    pub fn is_local(&self) -> bool {
        url().host_str().is_some_and(|h| h == "localhost" || h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()))
    }
}

fn tx_hash<T: std::fmt::Debug>(r: &alloy::rpc::types::TransactionReceipt<T>) -> String {
    format!("{:#x}", r.transaction_hash)
}

/// Sends a write and waits for it to be mined (`rpc::mined!`: one write at a time, each bounded), giving its hash.
macro_rules! send {
    ($call:expr, $what:expr) => {{
        let receipt = crate::rpc::mined!($call, $what);
        if !receipt.status() {
            return Err(format!("{} was reverted", $what));
        }
        tx_hash(&receipt)
    }};
}

mod network;
mod conform;
mod amounts;
mod deploy;
pub(crate) mod gas;
mod wallet;
pub mod coins;
mod claims;
mod listing;
mod grants;
mod served;
mod discovery;
mod reputation;
mod bounty;
pub use network::*;
pub use amounts::*;
pub use deploy::*;
pub use gas::*;
pub use wallet::*;
pub use coins::{CoinBounties, CoinFetch, CoinStakes, RouteCoins};
pub use claims::*;
pub use listing::*;
pub use grants::*;
pub use served::*;
pub use discovery::*;
pub use reputation::*;
pub use bounty::*;

#[cfg(test)]
mod tests;

/// The decimals a devnet's test USDC counts in: 18 unless `UNBROWSE_DEVNET_USDC_DECIMALS` names others, as a test of
/// a USDC with Arc's 6 does. Read when the devnet deploys its contracts.
fn devnet_usdc_decimals() -> Result<u8, String> {
    match std::env::var("UNBROWSE_DEVNET_USDC_DECIMALS").ok().filter(|v| !v.trim().is_empty()) {
        None => Ok(18),
        Some(v) => v.trim().parse().ok().filter(|d| *d <= 36).ok_or_else(|| format!("UNBROWSE_DEVNET_USDC_DECIMALS={v} isn't a number of decimals")),
    }
}

/// The slots in an epoch of the devnet's Anvil: 0, so its blocks are final as they are made, as Arc's are, unless
/// `UNBROWSE_DEVNET_EPOCH_SLOTS` names more, as a test of a chain whose blocks become final later does (Anvil's
/// finalized block is then two epochs behind its head). Read when the devnet's Anvil starts.
fn devnet_epoch_slots() -> Result<u64, String> {
    match std::env::var("UNBROWSE_DEVNET_EPOCH_SLOTS").ok().filter(|v| !v.trim().is_empty()) {
        None => Ok(0),
        Some(v) => v.trim().parse().map_err(|_| format!("UNBROWSE_DEVNET_EPOCH_SLOTS={v} isn't a number of slots")),
    }
}

/// Test only: a test USDC of `decimals` put at `at` on the Anvil at `rpc`, as a network whose own USDC sits at a fixed
/// address has it (Arc's, at `arc::Network::usdc`): the code of one deployed for it, and what its constructor stored.
/// Returns its owner, who mints it: the test stands in for the network's faucet.
#[cfg(test)]
pub(crate) async fn stand_in_usdc(rpc: &str, at: Address, decimals: u8) -> PrivateKeySigner {
    let owner = PrivateKeySigner::random();
    let p = ProviderBuilder::new().wallet(owner.clone()).connect_http(rpc.parse().unwrap());
    let _: serde_json::Value = p.raw_request("anvil_setBalance".into(), (owner.address(), gas_units(1.0))).await.unwrap();
    let made = USDC::deploy_builder(&p, decimals).send().await.unwrap().get_receipt().await.unwrap().contract_address.unwrap();
    let code = p.get_code_at(made).await.unwrap();
    let _: serde_json::Value = p.raw_request("anvil_setCode".into(), (at, code)).await.unwrap();
    // The ERC-20's name and symbol and the faucet's owner: every slot its constructor wrote is among the first few.
    for slot in 0..8u64 {
        let v = p.get_storage_at(made, U256::from(slot)).await.unwrap();
        if !v.is_zero() {
            let _: serde_json::Value = p.raw_request("anvil_setStorageAt".into(), (at, U256::from(slot), FixedBytes::<32>::from(v))).await.unwrap();
        }
    }
    owner
}

/// Test only: `amount` whole USDC minted to `to` by the owner of the stand-in USDC at `token`, in its own decimals.
#[cfg(test)]
pub(crate) async fn mint_stand_in(rpc: &str, owner: &PrivateKeySigner, token: Address, to: Address, amount: f64) {
    let p = ProviderBuilder::new().wallet(owner.clone()).connect_http(rpc.parse().unwrap());
    let t = USDC::new(token, &p);
    let units = usdc_units(amount, t.decimals().call().await.unwrap());
    assert!(t.faucet(to, units).send().await.unwrap().get_receipt().await.unwrap().status(), "minting the stand-in USDC");
}
