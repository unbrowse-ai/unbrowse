//! The formats of the files the node writes. Each file carries its format's version, `"v": n`, so a node can tell a
//! file it knows how to read from one a newer node wrote.
//!
//! - A file of named fields (an object of the node's own) carries `v` beside them: `{"v": 1, "paused": false, ...}`.
//!   A reader that doesn't know `v` (the window, the SDKs, a node from before versions) reads the rest as it always
//!   did.
//! - A file holding a list, or a map keyed by names that aren't the node's (a jar's cookies), is wrapped:
//!   `{"v": 1, "items": [...]}`, so no item can be taken for the version.
//!
//! Version 0 is a file from before files carried versions: no `v`, or not wrapped. Each format lists its steps, one per
//! version: step `n` reads version `n` as version `n + 1`, so the number of steps is the version this build writes. A
//! reader runs every step from the file's version up to its own, so a file of any older version reads, and a step
//! never runs backwards. A file of a version past this build's own was written by a newer node: it is refused with a
//! message saying so, and never written over ([`Format::writable`]), so going back to the newer node finds it as it
//! was left.
//!
//! Going back the other way is recoverable too. Before a file is read forward from an older version, its bytes as they
//! were are kept beside it as `<file>.v<old>` (`vault.json.v0`), once and whole, with the file's own permissions
//! ([`kept_original`]). Every write checks for that copy first, so a file is never written in the new format before its
//! old bytes are kept. A copy already there is never touched, and the node never reads one: it is the owner's, to put
//! back by hand after running a build from before the change, which can't read the new format and may write over it.
//!
//! Every format is one entry in [`ALL`], named for its file. A file the node writes is added here, with a fixture of
//! the oldest form a node ever wrote it in under `fixtures/`, which its reader is tested on.

pub mod private;

use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

/// Reads one version of a format's contents as the next. The contents are the file without its version: the fields
/// without `v`, or the items unwrapped.
pub type Step = fn(Value) -> Result<Value, String>;

/// Version 1 of a format is the file as it was before files carried versions, with `v` added: nothing in it changes.
pub fn as_it_was(contents: Value) -> Result<Value, String> {
    Ok(contents)
}

/// How a format carries its version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// An object of the node's own fields, with `v` among them.
    Fields,
    /// Anything else, wrapped as `{"v": n, "items": ...}`.
    Items,
}

/// One file's format.
#[derive(Clone, Copy)]
pub struct Format {
    /// What the format is called, in messages and in its fixture's name.
    pub name: &'static str,
    /// Where the file is, under the node's home (`~/.unbrowse`) unless it says otherwise.
    pub file: &'static str,
    pub shape: Shape,
    /// The steps from each older version: `steps[n]` reads version `n` as version `n + 1`.
    pub steps: &'static [Step],
}

/// Why a file wasn't read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// A newer node wrote it: this one reads up to version `reads`.
    Newer { found: u64, reads: u64 },
    /// It isn't this format's JSON at all: torn, edited by hand, or something else.
    Unreadable(String),
    /// It is of an older version, and its bytes couldn't be kept beside it before it would be written over.
    Uncopied(String),
}

impl Refusal {
    /// What the owner is told about the file at `path`.
    pub fn message(&self, path: &Path) -> String {
        match self {
            Refusal::Newer { found, reads } => format!(
                "{} was written by a newer Unbrowse node (its format is version {found}; this node reads up to version {reads}). It is \
                 left as it is and never written over: update this node, or move the file aside to start it afresh",
                path.display()
            ),
            Refusal::Unreadable(e) => format!("{} doesn't read ({e})", path.display()),
            Refusal::Uncopied(e) => {
                format!("{0} is left as it is: its older version couldn't be kept as {0}.v<n> before it is written in the new one ({e})", path.display())
            }
        }
    }

    pub fn is_newer(&self) -> bool {
        matches!(self, Refusal::Newer { .. })
    }
}

impl Format {
    /// The version this build writes.
    pub const fn version(&self) -> u64 {
        self.steps.len() as u64
    }

    /// A file's version and its contents without it. A file without one is version 0.
    pub fn split(&self, file: Value) -> Result<(u64, Value), String> {
        match self.shape {
            Shape::Fields => {
                let Value::Object(mut fields) = file else { return Err(format!("{} is an object", self.name)) };
                match fields.remove("v") {
                    None => Ok((0, Value::Object(fields))),
                    Some(v) => v.as_u64().map(|n| (n, Value::Object(fields))).ok_or_else(|| format!("its version is a whole number, not {v}")),
                }
            }
            Shape::Items => match file {
                Value::Object(mut o) if o.len() == 2 && o.get("v").is_some_and(Value::is_u64) && o.contains_key("items") => {
                    let v = o.remove("v").and_then(|v| v.as_u64()).unwrap_or(0);
                    Ok((v, o.remove("items").unwrap_or(Value::Null)))
                }
                bare => Ok((0, bare)),
            },
        }
    }

    /// A file's contents as this build's version: an older one stepped forward, a newer one refused.
    pub fn decode(&self, bytes: &[u8]) -> Result<Value, Refusal> {
        let file: Value = serde_json::from_slice(bytes).map_err(|e| Refusal::Unreadable(e.to_string()))?;
        self.decode_value(file)
    }

    /// The same, for a file already parsed (a line of a log).
    pub fn decode_value(&self, file: Value) -> Result<Value, Refusal> {
        let (found, mut contents) = self.split(file).map_err(Refusal::Unreadable)?;
        if found > self.version() {
            return Err(Refusal::Newer { found, reads: self.version() });
        }
        for step in &self.steps[found as usize..] {
            contents = step(contents).map_err(Refusal::Unreadable)?;
        }
        Ok(contents)
    }

    /// A file's contents as `T`.
    pub fn read<T: DeserializeOwned>(&self, bytes: &[u8]) -> Result<T, Refusal> {
        serde_json::from_value(self.decode(bytes)?).map_err(|e| Refusal::Unreadable(e.to_string()))
    }

    /// `bytes`, read from the file at `path`, as `T`. A file of an older version has its bytes kept beside it first
    /// ([`kept_original`]); one that can't be is still read, since nothing is written over until a write has kept it.
    pub fn read_from<T: DeserializeOwned>(&self, path: &Path, bytes: &[u8]) -> Result<T, Refusal> {
        let file: Value = serde_json::from_slice(bytes).map_err(|e| Refusal::Unreadable(e.to_string()))?;
        if let Ok((found, _)) = self.split(file.clone()) {
            if found < self.version() {
                let _ = keep_original(path, bytes, found);
            }
        }
        serde_json::from_value(self.decode_value(file)?).map_err(|e| Refusal::Unreadable(e.to_string()))
    }

    /// The file at `path` as `T`: `None` when there is none.
    pub fn read_at<T: DeserializeOwned>(&self, path: &Path) -> Result<Option<T>, Refusal> {
        match std::fs::read(path) {
            Ok(bytes) => self.read_from(path, &bytes).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Refusal::Unreadable(e.to_string())),
        }
    }

    /// `value` as this build writes it: with its version.
    pub fn encode<T: Serialize + ?Sized>(&self, value: &T) -> Result<Value, String> {
        let contents = serde_json::to_value(value).map_err(|e| e.to_string())?;
        let v = Value::from(self.version());
        match self.shape {
            Shape::Fields => {
                let Value::Object(fields) = contents else { return Err(format!("{} is an object", self.name)) };
                if fields.contains_key("v") {
                    return Err(format!("{} has a field of its own named v", self.name));
                }
                let mut out = Map::with_capacity(fields.len() + 1);
                out.insert("v".into(), v);
                out.extend(fields);
                Ok(Value::Object(out))
            }
            Shape::Items => {
                let mut out = Map::with_capacity(2);
                out.insert("v".into(), v);
                out.insert("items".into(), contents);
                Ok(Value::Object(out))
            }
        }
    }

    /// The bytes of `value` as this build writes it, compact.
    pub fn to_vec<T: Serialize + ?Sized>(&self, value: &T) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&self.encode(value)?).map_err(|e| e.to_string())
    }

    /// The same, indented for the owner to read.
    pub fn to_vec_pretty<T: Serialize + ?Sized>(&self, value: &T) -> Result<Vec<u8>, String> {
        serde_json::to_vec_pretty(&self.encode(value)?).map_err(|e| e.to_string())
    }

    /// Whether the file at `path` may be written over: not when a newer node wrote it, and not when it is of an older
    /// version whose bytes can't be kept beside it first ([`kept_original`]). A file that is missing or doesn't read may
    /// be: there is nothing in it this node could be losing.
    pub fn writable(&self, path: &Path) -> Result<(), Refusal> {
        let Ok(bytes) = std::fs::read(path) else { return Ok(()) };
        let Ok(file) = serde_json::from_slice::<Value>(&bytes) else { return Ok(()) };
        match self.split(file) {
            Ok((found, _)) if found > self.version() => Err(Refusal::Newer { found, reads: self.version() }),
            Ok((found, _)) if found < self.version() => keep_original(path, &bytes, found).map_err(|e| Refusal::Uncopied(e.to_string())),
            _ => Ok(()),
        }
    }

    /// Writes `value` at `path` in this format, readable by the owner alone ([`private::write`]): not over a file a
    /// newer node wrote, and not before an older file's bytes are kept ([`Format::writable`]).
    pub fn write_at<T: Serialize + ?Sized>(&self, path: &Path, value: &T) -> Result<(), String> {
        self.writable(path).map_err(|r| r.message(path))?;
        let bytes = self.to_vec_pretty(value)?;
        private::write(path, &bytes).map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// Where the bytes the file at `path` held at version `v` are kept once it is read forward: `<file>.v<v>`, beside it.
pub fn kept_original(path: &Path, v: u64) -> std::path::PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(format!(".v{v}"));
    p.into()
}

/// Keeps `bytes`, what `path` held at version `found`, at [`kept_original`]: written whole beside it, given the file's
/// own permissions, then linked into place, which never replaces a copy already there. That first copy is the one
/// that holds what the file was before any node read it forward, so it is never touched again.
fn keep_original(path: &Path, bytes: &[u8], found: u64) -> std::io::Result<()> {
    use std::io::Write;
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let to = kept_original(path, found);
    if to.exists() {
        return Ok(());
    }
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp = to.as_os_str().to_owned();
    tmp.push(format!(".{}.{n}.tmp", std::process::id()));
    let tmp = std::path::PathBuf::from(tmp);
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    let kept = (|| {
        let mut f = open.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::set_permissions(&tmp, std::fs::metadata(path)?.permissions())?;
        match std::fs::hard_link(&tmp, &to) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            linked => linked,
        }
    })();
    let _ = std::fs::remove_file(&tmp);
    kept
}

const V1: &[Step] = &[as_it_was];

const fn fields(name: &'static str, file: &'static str) -> Format {
    Format { name, file, shape: Shape::Fields, steps: V1 }
}

const fn items(name: &'static str, file: &'static str) -> Format {
    Format { name, file, shape: Shape::Items, steps: V1 }
}

/// Settings version 2 turns off the bounty steps, which put the owner's stake behind the node's own acts: nodes before
/// the off default wrote it as on in every settings file, so a node that only upgraded kept it on (external security
/// review round 4, 2026-11-05). It is the owner's to turn on again. (The other setting this step turned off is gone:
/// version 5 drops it.)
fn risky_defaults_off(mut contents: Value) -> Result<Value, String> {
    let Some(fields) = contents.as_object_mut() else { return Err("settings is an object".into()) };
    if fields.contains_key("bounty_auto") {
        fields.insert("bounty_auto".into(), Value::Bool(false));
    }
    Ok(contents)
}

/// Bounty memory version 2 drops the releases named before a release needed the owner's yes and that no line carries
/// yet: those were named on an agent's word alone. A naming a line already carries is history, and stays.
fn unasked_namings_dropped(mut contents: Value) -> Result<Value, String> {
    if let Some(named) = contents.get_mut("named").and_then(Value::as_object_mut) {
        named.retain(|_, n| n.get("line").is_some_and(|l| !l.is_null()));
    }
    Ok(contents)
}

/// Bounty memory version 3 is route coins' (spec ch. 8): bounties are limit orders confirmed by their poster or released
/// by use, on another contract. What an older node kept (its agent's word on intents and reports, the namings its calls
/// carried) names bounties and reports of the removed `Bounties` contract, so none of it carries over: the memory starts
/// afresh, and the old contract's stakes are its own to wind up.
fn coin_bounties_start_afresh(_contents: Value) -> Result<Value, String> {
    Ok(Value::Object(Default::default()))
}

/// Settings version 3 is the file as it was: signed requests came with it, and an upgraded node takes them only, as a
/// new one does. Bearer tokens are the owner's to allow (`accept_bearer`, asked first).
fn signed_requests_only(contents: Value) -> Result<Value, String> {
    Ok(contents)
}

/// Settings version 4 turns bearer tokens off in a file a version-3 build wrote: that build turned them on for every
/// upgraded node without asking its owner (round-3 audit, 2026-11-10). The owner turns them on again, asked.
fn bearer_off_unless_asked(mut contents: Value) -> Result<Value, String> {
    let Some(fields) = contents.as_object_mut() else { return Err("settings is an object".into()) };
    if fields.contains_key("accept_bearer") {
        fields.insert("accept_bearer".into(), Value::Bool(false));
    }
    Ok(contents)
}

/// Settings version 5 drops the setting for domain witness duty: the owner removed proving a domain by HTTP witnesses
/// on 11 November 2026, so a domain is proven by DNSSEC only and the node has no such duty to turn on. Every other
/// setting stays as the file had it.
fn domain_witness_setting_dropped(mut contents: Value) -> Result<Value, String> {
    let Some(fields) = contents.as_object_mut() else { return Err("settings is an object".into()) };
    fields.remove("witness");
    Ok(contents)
}

// The node's own records (`app/src/store.rs`).
pub const SETTINGS: Format = Format {
    name: "settings",
    file: "settings.json",
    shape: Shape::Fields,
    steps: &[as_it_was, risky_defaults_off, signed_requests_only, bearer_off_unless_asked, domain_witness_setting_dropped],
};
pub const ROUTE: Format = fields("route", "routes/<id>.json");
/// One line of the activity log: the log is appended to, never written over, so each line carries its version.
pub const ACTIVITY: Format = fields("activity", "activity.jsonl (each line)");
/// One line of what each call cost (`app/src/run.rs`): the rung it reached, and whether a browser ran.
pub const MADE: Format = fields("made", "made.jsonl (each line)");
pub const PRICING: Format = fields("pricing", "pricing.json");
pub const HELD: Format = items("held", "held.json");
// Agents and the vault.
pub const AGENTS: Format = items("agents", "agents.json");
pub const VAULT: Format = items("vault", "vault.json");
/// The same format in each file a root key seals into: `vault.sealed.json` (a root key in a file) and
/// `vault.sealed.keychain.json` (a root key in the system's keystore).
pub const VAULT_SEALED: Format = items("vault-sealed", "vault.sealed.json");
pub const CARDS: Format = items("cards", "cards.json");
pub const PASSKEYS: Format = items("passkeys", "passkeys.json");
// The owner's choices and the node's own bookkeeping.
pub const TELEMETRY: Format = fields("telemetry", "telemetry.json");
/// The source tag the node was first started with (`unbrowse start --from <tag>`), kept once (`app/src/telemetry.rs`).
pub const FROM: Format = fields("from", "from.json");
pub const LINK: Format = fields("link", "owner.json");
pub const JOINED: Format = fields("joined", "joined.json");
pub const BROWSER: Format = fields("browser", "browser.json");
pub const REPORTS: Format = fields("reports", "reports.json");
pub const REPORTS_STATE: Format = fields("reports-state", "reports-state.json");
pub const REPORTS_QUEUE: Format = items("reports-queue", "reports-queue.json");
/// Agents' reports waiting for the owner to read and send them (`report::from_agent`).
pub const REPORTS_WAITING: Format = items("reports-waiting", "reports-waiting.json");
pub const AUTOLIST: Format = fields("autolist", "autolist.json");
/// The routes another node listed that the owner allowed to act in their session, by what they are (a hash of the body
/// and its graph), with the site each was allowed on (`app/src/run.rs`).
pub const SHARED_SESSIONS: Format = fields("shared-sessions", "shared-sessions.json");
pub const LISTINGS: Format = fields("listings", "listings-<chain>-<settlement>.json");
pub const KNOWN_LISTINGS: Format = items("known-listings", "known-listings-<chain>-<settlement>.json");
pub const RESERVE_ROOTS: Format = fields("reserve-roots", "reserve-roots-<chain>-<settlement>.json");
pub const RENEW_TOLD: Format = items("renew-told", "renew-told.json");
// Updates (`app/src/update.rs`).
pub const TRUST: Format = fields("trust", "trust.json");
pub const KEPT_MANIFEST: Format = fields("kept-manifest", "kept-manifest.json");
// The chain (`app/src/chain/`), under the chain's folder (`devnet/` on the devnet).
pub const DEVNET_NETWORK: Format = fields("devnet-network", "devnet/network.json");
pub const DEPLOYMENT: Format = fields("deployment", "<chain>/deployment.json");
pub const NETWORK: Format = fields("network", "networks/<network>.json");
/// What a `chain deploy` under way has made, so a rerun picks up where it stopped (`app/src/chain/deploy.rs`).
pub const DEPLOYING: Format = fields("deploying", "networks/<network>.deploying.json");
pub const RECEIPTS: Format = items("receipts", "<chain>/receipts/<agent>-<epoch>.json");
pub const OWED: Format = items("owed", "<chain>/owed.json");
/// What was paid out to the node's own address with no linked wallet, kept from the top-up until it is sent on
/// (`app/src/chain/wallet.rs`).
pub const PAID_OUT: Format = fields("paid-out", "<chain>/paid-out.json");
/// The bodies a server released and has no line for yet (`app/src/network.rs`).
pub const SERVED: Format = items("served", "<chain>/served.json");
/// The payers a server stopped serving, and why: signed failure counts that contradict its lines, or an overdue
/// backstop claim (spec §76.2 items 5 and 9).
pub const REFUSED_PAYERS: Format = items("refused-payers", "<chain>/refused-payers.json");
pub const SPENT_VOUCHERS: Format = items("spent-vouchers", "<chain>/spent-vouchers.json");
pub const WATCHING: Format = items("watching", "<chain>/watching.json");
/// The writes that must not go twice, from before each is sent until the chain says what became of it
/// (`app/src/inflight.rs`).
pub const SENDING: Format = items("sending", "<chain>/sending.json");
/// What the node's own key spent on network fees today, against the owner's daily budget (`app/src/rpc.rs`).
pub const GAS_SPENT: Format = fields("gas-spent", "<chain>/gas-spent.json");
/// Allowances the node set and couldn't confirm taken back, retried before any other approval (`app/src/chain/wallet.rs`).
/// What the watchtower spent of its own gas claiming each payer's lines this epoch (`app/src/watchtower.rs`).
/// The finalized heads the node has linked itself, header by header (`app/src/anchor.rs`).
pub const HEADER_CHAIN: Format = fields("header-chain", "<chain>/headers.json");
pub const TOWER_GAS: Format = fields("tower-gas", "<chain>/tower-gas.json");
/// Lines this node served whose window only its one RPC says closed (or that only it reads as paid), set aside from
/// `owed.json` and claimed or let go once a second RPC can read them (`app/src/chain/served.rs`, R5-CHAIN-1).
pub const UNWITNESSED: Format = items("unwitnessed", "<chain>/unwitnessed.json");
/// The highest voucher epoch a witness stood behind on this deployment, which only rises: no voucher older is served
/// (`app/src/chain/claims.rs`, R8-CHAIN-2).
pub const EPOCH_FLOOR: Format = fields("epoch-floor", "<chain>/epoch-floor.json");
pub const ALLOWANCE_RESETS: Format = items("allowance-resets", "<chain>/allowance-resets.json");
/// The launches the listing's first buy made and the stakes of what they bought (`app/src/chain/coins.rs`).
pub const COIN_FIRST_BUYS: Format = items("coin-first-buys", "<chain>/coin-first-buys.json");
/// What the owner's agent and the owner said about bounties, so it is never asked twice (`app/src/autobounty.rs`, spec
/// ch. 8).
pub const BOUNTY_AUTO: Format =
    Format { name: "bounty-auto", file: "<chain>/bounty-auto-<wallet>.json", shape: Shape::Fields, steps: &[as_it_was, unasked_namings_dropped, coin_bounties_start_afresh] };
pub const HANDED: Format = items("handed", "<chain>/handed.json");
pub const ERC8004: Format = fields("erc8004", "erc8004-<owner>.json");
// The peer network (`app/src/peers.rs`, `crates/net`).
pub const PEER_KEY: Format = fields("peer-key", "peer-key.json");
/// This node's remote MCP address: on or off, the gateway and the node's key there (`app/src/remote.rs`).
pub const REMOTE: Format = fields("remote", "remote.json");
/// The agent apps that have reached this node, by the name each gives at MCP `initialize` (`app/src/heard.rs`).
pub const HEARD: Format = fields("heard", "heard.json");
pub const PEER_PORT: Format = fields("peer-port", "peer-port.json");
pub const PEER_PUBLISHED: Format = fields("peer-published", "peer-published.json");
pub const PEER_TABLE: Format = items("peer-table", "peer-table.json");
pub const SET_ASIDE: Format = items("set-aside", "set-aside.json");
pub const DARK_ENTRIES: Format = items("dark-entries", "dark-entries.json");
pub const DEMOTED: Format = items("demoted", "demoted.json");
pub const WITHDRAWN: Format = items("withdrawn", "withdrawn.json");
/// A node's advertisement to the other nodes on this machine, in `~/.unbrowse-network` (`app/src/network.rs`).
pub const NODE_AD: Format = fields("node-ad", "~/.unbrowse-network/<address>.json");
// Leaked credentials (`app/src/leak.rs`): this node's findings, what it took down, and the last block it read.
pub const LEAKS: Format = fields("leaks", "leaks/leaks.json");
// The learner's session store (`crates/learn`), beside the node's records.
pub const JAR: Format = items("jar", "jars/<host>.json");
/// The door each site put in front of this node's walks (`unbrowse_learn::graph::Door`): the class it met, the
/// credential it issues and what earns a fresh one. This node's own record, and never shared.
pub const DOORS: Format = items("doors", "doors.json");
/// What a site needs done by hand before it answers (`unbrowse_learn::setup`): the owner's, never shared.
pub const SETUPS: Format = items("setups", "setups/<site>.json");

/// Every format, one entry per file.
pub const ALL: &[&Format] = &[
    &SETTINGS,
    &ROUTE,
    &ACTIVITY,
    &MADE,
    &PRICING,
    &HELD,
    &AGENTS,
    &VAULT,
    &VAULT_SEALED,
    &CARDS,
    &PASSKEYS,
    &TELEMETRY,
    &FROM,
    &LINK,
    &JOINED,
    &BROWSER,
    &REPORTS,
    &REPORTS_STATE,
    &REPORTS_QUEUE,
    &REPORTS_WAITING,
    &AUTOLIST,
    &SHARED_SESSIONS,
    &DOORS,
    &LISTINGS,
    &KNOWN_LISTINGS,
    &RESERVE_ROOTS,
    &RENEW_TOLD,
    &TRUST,
    &KEPT_MANIFEST,
    &DEVNET_NETWORK,
    &DEPLOYMENT,
    &NETWORK,
    &DEPLOYING,
    &RECEIPTS,
    &OWED,
    &PAID_OUT,
    &SERVED,
    &REFUSED_PAYERS,
    &SPENT_VOUCHERS,
    &WATCHING,
    &SENDING,
    &GAS_SPENT,
    &ALLOWANCE_RESETS,
    &COIN_FIRST_BUYS,
    &TOWER_GAS,
    &HEADER_CHAIN,
    &UNWITNESSED,
    &EPOCH_FLOOR,
    &BOUNTY_AUTO,
    &HANDED,
    &ERC8004,
    &PEER_KEY,
    &REMOTE,
    &HEARD,
    &PEER_PORT,
    &PEER_PUBLISHED,
    &PEER_TABLE,
    &SET_ASIDE,
    &LEAKS,
    &DARK_ENTRIES,
    &DEMOTED,
    &WITHDRAWN,
    &NODE_AD,
    &JAR,
    &SETUPS,
];

/// The fixture of the oldest form a node ever wrote a format's file in, which its reader is tested on:
/// `fixtures/<name>.json` in this crate.
pub fn fixture(format: &Format) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(format!("{}.json", format.name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn renamed(mut v: Value) -> Result<Value, String> {
        let o = v.as_object_mut().ok_or("an object")?;
        if let Some(old) = o.remove("old") {
            o.insert("new".into(), old);
        }
        Ok(v)
    }

    fn doubled(mut v: Value) -> Result<Value, String> {
        if let Some(n) = v.get("new").and_then(Value::as_u64) {
            v["new"] = json!(n * 2);
        }
        Ok(v)
    }

    const THREE: Format = Format { name: "three", file: "three.json", shape: Shape::Fields, steps: &[as_it_was, renamed, doubled] };
    const LIST: Format = Format { name: "list", file: "list.json", shape: Shape::Items, steps: &[as_it_was, as_it_was] };

    /// A file of every older version reads as the newest, each step run once and in order, never backwards.
    #[test]
    fn an_older_file_reads_through_every_step_forward() {
        let want = json!({ "new": 8 });
        assert_eq!(THREE.decode(br#"{"old": 4}"#).unwrap(), want, "from before versions");
        assert_eq!(THREE.decode(br#"{"v": 1, "old": 4}"#).unwrap(), want);
        assert_eq!(THREE.decode(br#"{"v": 2, "new": 4}"#).unwrap(), want);
        assert_eq!(THREE.decode(br#"{"v": 3, "new": 8}"#).unwrap(), want, "the newest is read as it is");
        assert_eq!(LIST.decode(b"[1, 2]").unwrap(), json!([1, 2]), "a bare list is from before versions");
        assert_eq!(LIST.decode(br#"{"v": 1, "items": [1, 2]}"#).unwrap(), json!([1, 2]));
    }

    /// A file a newer node wrote is refused, saying so, and may not be written over; an older one, a torn one or
    /// none at all may.
    #[test]
    fn a_newer_file_is_refused_and_never_written_over() {
        let newer = THREE.decode(br#"{"v": 4, "new": 8}"#).unwrap_err();
        assert_eq!(newer, Refusal::Newer { found: 4, reads: 3 });
        let said = newer.message(Path::new("/home/me/.unbrowse/three.json"));
        assert!(said.contains("newer Unbrowse node") && said.contains("version 4") && said.contains("never written over"), "{said}");
        assert_eq!(LIST.decode(br#"{"v": 3, "items": []}"#).unwrap_err(), Refusal::Newer { found: 3, reads: 2 });

        let dir = std::env::temp_dir().join(format!("unbrowse-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("three.json");
        assert!(THREE.writable(&path).is_ok(), "none there");
        std::fs::write(&path, br#"{"v": 4, "new": 8}"#).unwrap();
        assert!(THREE.writable(&path).unwrap_err().is_newer());
        assert!(THREE.read_at::<Value>(&path).unwrap_err().is_newer());
        std::fs::write(&path, br#"{"v": 2, "new": 8}"#).unwrap();
        assert!(THREE.writable(&path).is_ok(), "an older one");
        std::fs::write(&path, br#"{"v": 4, "ne"#).unwrap();
        assert!(THREE.writable(&path).is_ok(), "a torn one");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What a node writes carries its version, and reads back as what was written.
    #[test]
    fn a_written_file_carries_its_version_and_reads_back() {
        let bytes = THREE.to_vec(&json!({ "new": 8, "other": "x" })).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap()["v"], 3);
        assert_eq!(THREE.read::<Value>(&bytes).unwrap(), json!({ "new": 8, "other": "x" }));
        let bytes = LIST.to_vec(&[1, 2]).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!({ "v": 2, "items": [1, 2] }));
        assert!(THREE.encode(&json!({ "v": "mine" })).is_err(), "a field of its own named v would be taken for the version");
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("unbrowse-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A file read forward from an older version leaves its bytes as they were beside it, once, with its own
    /// permissions; a later read never rewrites that copy, and a file already at this version gets none.
    #[test]
    fn a_file_read_forward_keeps_its_old_bytes_beside_it_once() {
        let dir = scratch("kept");
        let path = dir.join("vault.json");
        let old = br#"[{"site":"shop.example","account":"me"}]"#;
        std::fs::write(&path, old).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        let read: Value = VAULT.read_at(&path).unwrap().unwrap();
        assert_eq!(read[0]["account"], "me");
        let copy = kept_original(&path, 0);
        assert_eq!(copy, dir.join("vault.json.v0"));
        assert_eq!(std::fs::read(&copy).unwrap(), old, "the copy is the file as it was");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777, 0o600, "as private as the file");
        }

        // An older build writes over the file; reading it again never touches the first copy.
        std::fs::write(&path, b"[]").unwrap();
        let _: Value = VAULT.read_at(&path).unwrap().unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), old, "the first copy stands");

        // A file at this version has nothing to keep.
        let current = dir.join("cards.json");
        std::fs::write(&current, CARDS.to_vec(&json!([{ "label": "visa" }])).unwrap()).unwrap();
        let _: Value = CARDS.read_at(&current).unwrap().unwrap();
        assert!(CARDS.writable(&current).is_ok());
        assert!(!kept_original(&current, 1).exists() && !kept_original(&current, 0).exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3, "no copy for it, and no temporary file left: {:?}", std::fs::read_dir(&dir).unwrap().collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file a writer would write over without having read it is kept first all the same, with the file's own mode.
    #[test]
    fn a_write_over_an_older_file_keeps_it_first() {
        let dir = scratch("kept-write");
        let path = dir.join("held.json");
        std::fs::write(&path, b"[1]").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o640)).unwrap();
        assert!(HELD.writable(&path).is_ok());
        assert_eq!(std::fs::read(kept_original(&path, 0)).unwrap(), b"[1]");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(kept_original(&path, 0)).unwrap().permissions().mode() & 0o777, 0o640);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A map whose keys aren't the node's, with a key named `v`, is wrapped, so its `v` is never read as a version.
    #[test]
    fn an_item_named_v_is_never_the_version() {
        let jar = json!({ "v": "cookie-value", "sid": "s" });
        let bytes = JAR.to_vec(&jar).unwrap();
        assert_eq!(JAR.read::<Value>(&bytes).unwrap(), jar);
        assert_eq!(JAR.decode(jar.to_string().as_bytes()).unwrap(), jar, "an old jar with a cookie named v reads as a jar");
    }

    /// A settings file a node wrote before the off defaults reads with the bounty steps off, whatever it said; one this
    /// build wrote keeps the owner's choice. Nothing else in it changes.
    #[test]
    fn an_upgraded_node_starts_with_bounty_steps_off() {
        let old = json!({ "v": 1, "paused": false, "bounty_auto": true, "max_fetch_usdc": 0.5 });
        let read = SETTINGS.decode(old.to_string().as_bytes()).unwrap();
        assert_eq!(read, json!({ "paused": false, "bounty_auto": false, "max_fetch_usdc": 0.5 }));
        assert_eq!(SETTINGS.decode(br#"{"paused": true}"#).unwrap(), json!({ "paused": true }), "a setting a file never had stays unset");
        let chosen = SETTINGS.to_vec(&json!({ "bounty_auto": true })).unwrap();
        assert_eq!(SETTINGS.decode(&chosen).unwrap(), json!({ "bounty_auto": true }), "turned on again after the upgrade");
    }

    /// The domain witness setting is gone with the duty: a file of any earlier version that has it, on or off, reads
    /// without it, and every other setting in it reads as it would have.
    #[test]
    fn an_old_settings_file_reads_without_the_removed_domain_witness_setting() {
        for v in 1..=4 {
            let old = json!({ "v": v, "paused": true, "witness": true, "bounty_auto": false, "max_fetch_usdc": 0.5 });
            assert_eq!(
                SETTINGS.decode(old.to_string().as_bytes()).unwrap(),
                json!({ "paused": true, "bounty_auto": false, "max_fetch_usdc": 0.5 }),
                "version {v}"
            );
        }
        let unversioned = json!({ "witness": false, "paused": false });
        assert_eq!(SETTINGS.decode(unversioned.to_string().as_bytes()).unwrap(), json!({ "paused": false }));
    }

    /// An upgraded node takes signed requests only, as a new one does, unless its owner turns bearer tokens on: a file
    /// from before signed requests reads with them off, and so does one a build that turned them on without asking
    /// wrote; a file this build wrote keeps the owner's choice.
    #[test]
    fn an_upgraded_node_takes_signed_requests_only_unless_its_owner_says() {
        let old = json!({ "v": 2, "paused": false });
        assert_eq!(SETTINGS.decode(old.to_string().as_bytes()).unwrap(), json!({ "paused": false }), "nothing turned on");
        let unasked = json!({ "v": 3, "accept_bearer": true });
        assert_eq!(SETTINGS.decode(unasked.to_string().as_bytes()).unwrap(), json!({ "accept_bearer": false }), "turned on unasked: off");
        let asked = SETTINGS.to_vec(&json!({ "accept_bearer": true })).unwrap();
        assert_eq!(SETTINGS.decode(&asked).unwrap(), json!({ "accept_bearer": true }), "the owner's on, asked, stays on");
        let off = SETTINGS.to_vec(&json!({ "accept_bearer": false })).unwrap();
        assert_eq!(SETTINGS.decode(&off).unwrap(), json!({ "accept_bearer": false }), "the owner's off stays off");
        let fresh = SETTINGS.to_vec(&json!({ "paused": false })).unwrap();
        assert_eq!(SETTINGS.decode(&fresh).unwrap(), json!({ "paused": false }), "a new install's file says nothing, and reads as off");
    }

    /// A release named on an agent's word before releases needed the owner's yes is dropped on upgrade; one a line
    /// already carries stays, as does everything else the memory holds.
    #[test]
    fn an_upgraded_node_drops_releases_named_on_an_agents_word() {
        let old = json!({ "v": 1, "told": ["4:2"], "named": {
            "4:2": { "bounty": 4, "report": 2, "entry": "0x00", "line": null, "by": "agent-1", "at": 1 },
            "5:1": { "bounty": 5, "report": 1, "entry": "0x00", "by": "agent-1", "at": 2 },
            "6:3": { "bounty": 6, "report": 3, "entry": "0x00", "line": [1, 9, 0], "by": "agent-1", "at": 3 } } });
        // The step itself: version 3 starts the memory afresh after it (`coin_bounties_start_afresh`).
        let read = unasked_namings_dropped(json!({ "told": old["told"].clone(), "named": old["named"].clone() })).unwrap();
        assert_eq!(read["told"], json!(["4:2"]));
        assert_eq!(read["named"].as_object().unwrap().keys().collect::<Vec<_>>(), vec!["6:3"]);
    }

    /// A bounty memory from before route coins starts afresh: it names bounties of a contract that is gone.
    #[test]
    fn an_old_bounty_memory_starts_afresh_under_route_coins() {
        let old = json!({ "v": 2, "routes": { "r 0x00": { "does": true, "by": "a", "at": 1 } }, "told": ["4:2"], "named": {} });
        assert_eq!(BOUNTY_AUTO.decode(old.to_string().as_bytes()).unwrap(), json!({}));
    }

    /// Every format the node writes has one entry, a version, and a fixture of its oldest form that reads.
    #[test]
    fn every_format_has_a_version_and_an_old_fixture_that_reads() {
        let mut names = std::collections::HashSet::new();
        for f in ALL {
            assert!(names.insert(f.name), "{} is named once", f.name);
            assert!(f.version() >= 1, "{}", f.name);
            let bytes = std::fs::read(fixture(f)).unwrap_or_else(|e| panic!("{}: {e}", fixture(f).display()));
            let (v, _) = f.split(serde_json::from_slice(&bytes).unwrap()).unwrap();
            assert!(v <= 1, "{}'s fixture is the oldest form: from before versions, or the first", f.name);
            assert!(f.decode(&bytes).is_ok(), "{}", f.name);
        }
    }
}
