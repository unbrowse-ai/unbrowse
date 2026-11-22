#[macro_use]
mod antithesis;
mod agents;
mod agent_user;
mod api;
mod apischema;
mod connect;
// The classifier of an older Unbrowse's entries, which `connect` shares with `unb`.
#[path = "bin/unb/legacy.rs"]
#[allow(dead_code)]
mod legacy;
mod signed_client;
mod solver;
mod applinks;
mod arc;
mod autobounty;
mod autolist;
mod browse;
mod browsers;
mod build_config;
mod chain;
mod checkout;
mod payhold;
mod quiet;
mod commands;
mod bounty;
mod domains;
mod erc8004;
#[cfg(test)]
mod formats;
mod frames;
mod gateway;
mod hands;
mod health;
mod import;
mod keychain_logins;
mod inflight;
mod leak;
mod learn;
mod listing;
mod link;
mod login;
mod onboard;
mod money;
mod network;
mod owner_authn;
mod owner_dialog;
mod tty;
mod owner_nodes;
mod optout;
mod earnings;
mod passkey;
mod peers;
#[cfg(test)]
mod primitives;
mod prune;
mod rank;
mod recipe;
mod remote;
mod report;
mod reserve;
mod routelink;
mod anchor;
mod proof;
mod rpc;
mod run;
mod setups;
mod share;
mod session_held;
mod socket;
mod challenge;
mod clearance;
mod outcome;
mod store;
mod telemetry;
mod terms;
#[cfg(test)]
mod testchain;
#[cfg(test)]
mod test_alloc;
mod update;
mod vault;
mod watchtower;
mod sitepolicy;
mod sync;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use unbrowse_core::{load_or_create, FileStore, KeyStore, KeychainStore};
use crate::sync::{Locked, Shared};

/// Dev builds keep their key under a separate Keychain item, so testing never touches a
/// real identity.
const DEV: bool = cfg!(debug_assertions);
const KEYCHAIN_SERVICE: &str = if DEV { "network.unbrowse.node.dev" } else { "network.unbrowse.node" };
const KEYCHAIN_ACCOUNT: &str = "root-key";

/// What the window may know about the identity: public values only.
#[derive(Clone, Serialize)]
struct IdentityView {
    address: String,
    created: bool,
}

#[derive(Clone, Serialize)]
struct NodeInfo {
    name: String,
    version: String,
    api_port: u16,
    dev: bool,
}

/// The node: everything the core holds for the window and for agents. Key material stays behind `keys`.
pub struct Node {
    keys: Box<dyn KeyStore + Send + Sync>,
    /// The owner's identity, once the Keychain has handed over the root key. `None` while macOS is still asking
    /// whether this build may read it: the window and the agent API run meanwhile and say what they're waiting on.
    identity: std::sync::RwLock<Option<Result<IdentityView, String>>>,
    info: NodeInfo,
    walks: learn::Walks,
    chain: chain::Chain,
    /// Why the chain isn't up, if it isn't.
    chain_error: std::sync::Mutex<Option<String>>,
    events: api::Events,
    /// The peer network, once the node has joined it.
    net: std::sync::OnceLock<unbrowse_net::Net>,
    /// Other nodes' bodies: which providers and entries this node sets aside, and the listings it checked.
    share: share::Share,
}

type St<'a> = &'a Arc<Node>;

/// Holds the first run's lock on this home while the key is made: `first-key.lock`, dropped with the file. Without it,
/// two programs starting for the first time (the node and `unb`, say) each find no key and each make one, and their
/// writes can interleave: the key of one beside the seed words of the other, and one of them running on a key the store
/// no longer holds. A lock that can't be had is no reason to refuse a key, so it is passed over.
fn first_run_lock() -> Option<std::fs::File> {
    let path = store::home().join("first-key.lock");
    std::fs::create_dir_all(store::home()).ok()?;
    let file = std::fs::File::options().create(true).truncate(false).write(true).open(path).ok()?;
    file.lock().ok()?;
    Some(file)
}

/// The root key's identity, making the key on a first run. `load_or_create` looks in the store again once it has the
/// lock, so whoever waited on another's first run takes that key. A key already there needs no lock.
fn first_key(store: &dyn KeyStore) -> Result<unbrowse_core::Identity, String> {
    let _first = matches!(store.get(), Ok(None)).then(first_run_lock);
    load_or_create(store).map_err(|e| e.to_string())
}

fn open_identity(store: &dyn KeyStore) -> Result<IdentityView, String> {
    let id = first_key(store)?;
    link::set_node(&id.address.to_checksum());
    Ok(IdentityView { address: id.address.to_checksum(), created: id.created })
}

/// Where the root key lives: the system's keystore in a release build. A dev build's key is the devnet's test
/// identity, kept in a file only this user can read: the Keychain asks for the login password again after every
/// rebuild of a dev binary, and the first read moves the old Keychain item into the file so the identity stays the
/// same. A Linux machine with no desktop session has no Secret Service to keep the key, so it is kept the same way;
/// once that file exists it is the key, so the identity never moves between the two.
///
/// A file is chosen before a keychain item is made: a home of the node's own (a scratch `UNBROWSE_HOME`, a test's)
/// has no default keychain to make one in, and making one to find that out would refuse a node that never needed it.
fn root_store() -> Result<Box<dyn KeyStore + Send + Sync>, String> {
    if root_in_file() {
        let file = if DEV { store::home().join("devnet").join("root.key") } else { store::home().join("root.key") };
        // The old item is taken over only from the owner's own folder: reading it is a convenience, so a keychain
        // that can't be opened here is passed over rather than refusing the file the key is already in.
        let migrate = if takes_keychain_key(&store::home(), &account_home()) {
            match KeychainStore::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
                Ok(keychain) => Some(keychain),
                Err(e) => {
                    eprintln!("unbrowse-node: reading the system's keystore: {e}");
                    None
                }
            }
        } else {
            None
        };
        return Ok(Box::new(FileStore::new(file, migrate)));
    }
    // A folder of the node's own can't always reach the keystore: say what else it can do.
    let hint = if takes_keychain_key(&store::home(), &account_home()) { "" } else { " (a node in a folder of its own can keep its key in a file instead: UNBROWSE_ROOT_KEY_FILE=1)" };
    // Read once a run and held (`vault.unlock-once`): the system's keystore asks the owner at most once, not on every
    // signature, seal or open. One store a process, so the read that opened the node is the one every later reader
    // has, whichever of them asked for the store.
    static HELD: std::sync::Mutex<std::collections::BTreeMap<String, Arc<unbrowse_core::Remembered<KeychainStore>>>> = std::sync::Mutex::new(std::collections::BTreeMap::new());
    let account = root_account();
    let mut held = HELD.locked();
    if let Some(store) = held.get(&account) {
        return Ok(Box::new(store.clone()));
    }
    let store = Arc::new(unbrowse_core::Remembered::new(KeychainStore::new(KEYCHAIN_SERVICE, &account).map_err(|e| format!("{e}{hint}"))?));
    held.insert(account, store.clone());
    Ok(Box::new(store))
}

/// This node's keystore account (`keychain_account`), its folder made first: a folder is named as the system resolves
/// it, and one not there yet would be named one way on its first run and another on every run after.
fn root_account() -> String {
    let home = store::home();
    let _ = unbrowse_files::private::dir_at(&home);
    keychain_account(&home, &account_home())
}

const HEADLESS_ON: &str = "on: nothing opens a window; a walk that would need one answers how: browse or says why it can't";
const HEADLESS_OFF: &str = "off: a walk a site refused may open a window, which passes doors a headless browser can't";

/// This user's home as the system has it, not as `$HOME` says: anything can set `$HOME`, and a process that points it at a
/// scratch folder is not the owner's node.
#[cfg(unix)]
fn account_home() -> std::path::PathBuf {
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0u8; 16_384];
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found = std::ptr::null_mut();
    // SAFETY: `pw` and `buf` outlive the call, and `dir` points into `buf`, read before either goes.
    let ok = unsafe { libc::getpwuid_r(libc::getuid(), &mut pw, buf.as_mut_ptr().cast(), buf.len(), &mut found) } == 0 && !found.is_null() && !pw.pw_dir.is_null();
    if !ok {
        return unbrowse_files::private::user_home();
    }
    let dir = unsafe { std::ffi::CStr::from_ptr(pw.pw_dir) };
    std::path::PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes()))
}

#[cfg(not(unix))]
fn account_home() -> std::path::PathBuf {
    unbrowse_files::private::user_home()
}

/// Whether a file-kept root key starts from the Keychain's: only in the owner's own data folder. The Keychain item is
/// one per user, not per folder, so a node run in a scratch folder (`UNBROWSE_HOME`) that took it would be the owner's
/// node under a second folder: one identity, two peer keys. It makes a key of its own instead.
fn takes_keychain_key(home: &std::path::Path, user_home: &std::path::Path) -> bool {
    home == user_home.join(".unbrowse")
}

/// Whether the node keeps its root key in a file rather than the system's keystore: a dev build, a node in a folder of
/// its own (a scratch `UNBROWSE_HOME`) that already holds the key's file or whose owner asked for one
/// (`UNBROWSE_ROOT_KEY_FILE=1`), or a Linux machine with the key's file already there or no Secret Service to keep it.
fn root_in_file() -> bool {
    // Decided once a run: on Linux the answer reads the keystore, and the vault asks on every sign-in. A file is used
    // when one is already there, or when the keystore can't round-trip a secret (it corrupts the key, or is absent) --
    // otherwise the node would write a root key it can never read back, with no way to notice or recover.
    static IN_FILE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *IN_FILE.get_or_init(|| {
        // A folder that isn't the owner's own (`~/.unbrowse`) has a keystore account of its own (`keychain_account`),
        // and may keep its key in itself instead: a machine with no default keychain in that folder refuses the
        // keystore outright. A plain file is a weaker place for a real key, so a release build does that only when
        // asked, or when the file is already there.
        let the_owners = takes_keychain_key(&store::home(), &account_home());
        let asked = std::env::var("UNBROWSE_ROOT_KEY_FILE").is_ok_and(|v| v.trim() == "1");
        let file = store::home().join("root.key");
        let has_file = file.exists();
        let in_file = root_goes_in_a_file(DEV, the_owners, asked, has_file, cfg!(target_os = "linux"), || cfg!(target_os = "linux") && !KeychainStore::reliable(KEYCHAIN_SERVICE));
        if let Some(warning) = ignored_key_file(DEV, the_owners, has_file, in_file, &file) {
            eprintln!("unbrowse-node: {warning}");
        }
        in_file
    })
}

/// The rule `root_in_file` decides by. A dev build's key is always a file. A release build's is in the system's
/// keystore, where another process of this user can't simply read or replace it, except: in a folder of the node's
/// own, where a key's file already there (`has_file`) is the key, as is one its owner asked for (`asked`); on Linux,
/// where a file already there is the key in the owner's folder too (it is where a machine with no keystore keeps
/// it); and on a machine with no keystore to keep it (`no_keystore`). In the owner's own folder off Linux the
/// keystore wins over a file: a file there could be anyone's (`ignored_key_file`).
fn root_goes_in_a_file(dev: bool, the_owners: bool, asked: bool, has_file: bool, linux: bool, no_keystore: impl FnOnce() -> bool) -> bool {
    dev || (!the_owners && (asked || has_file)) || (linux && has_file) || no_keystore()
}

/// What the node says of a root key's file it passes over: in the owner's own folder, where the keystore keeps the
/// key (`root_goes_in_a_file`), a `root.key` is not the key. Said once a run and by the file's path, so a key an
/// earlier build left there is found rather than lost.
fn ignored_key_file(dev: bool, the_owners: bool, has_file: bool, in_file: bool, file: &std::path::Path) -> Option<String> {
    (!dev && the_owners && has_file && !in_file).then(|| {
        format!(
            "{} is not this node's key and is not read: the key is the one in the system's keystore. Any program of yours can write that file, so it is never taken as the key here. If it holds a key you want (an earlier build kept one there), back it up before you remove it",
            file.display()
        )
    })
}

/// The keystore account a node in `home` keeps its root key under. The owner's own folder (`~/.unbrowse`) keeps the
/// account it always had. The keystore's item is one per account, not per folder, so any other folder gets an account
/// of its own, named for the folder as the system resolves it: a node there is never the owner's node under a second
/// name, and nothing it writes or replaces is an item of the owner's.
fn keychain_account(home: &std::path::Path, user_home: &std::path::Path) -> String {
    if takes_keychain_key(home, user_home) {
        return KEYCHAIN_ACCOUNT.to_string();
    }
    use sha2::Digest;
    let at = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    format!("{KEYCHAIN_ACCOUNT}@{}", hex::encode(&sha2::Sha256::digest(at.to_string_lossy().as_bytes())[..8]))
}

/// The keystore account a restore keeps the key it replaced under: beside the root key's own.
fn replaced_account(account: &str, previous: &str) -> String {
    format!("{account}.replaced.{previous}")
}

/// Where the vault keeps logins' secrets: sealed under the root key (`vault::Keep`, `vault.unlock-once`). Until the
/// node has its key the vault is locked: what needs it is told so, and nothing asks the owner from here.
pub fn vault_keep(keys: Result<&dyn KeyStore, String>) -> Result<vault::Keep, String> {
    let keys = keys.map_err(|why| format!("the vault opens once the node has its key: {why}"))?;
    if root_in_file() {
        return vault::Keep::sealed(keys, &store::home());
    }
    vault::Keep::sealed_beside_keystore(keys, &store::home())
}

/// The vault's store for a command run from a shell: the root key read as the node reads it, made if this is the
/// node's first run, so a headless machine can import before the node has ever started.
fn cli_vault_keep() -> Result<vault::Keep, String> {
    let keys = root_store()?;
    open_identity(keys.as_ref())?;
    vault_keep(Ok(keys.as_ref()))
}

/// The machine's name: the Mac's local host name, else what the system calls it.
fn host_name() -> String {
    let named = |s: String| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    let mac = cfg!(target_os = "macos").then(|| std::process::Command::new("scutil").args(["--get", "LocalHostName"]).output().ok()).flatten();
    mac.and_then(|o| String::from_utf8(o.stdout).ok()).and_then(named)
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().and_then(named))
        .or_else(|| std::env::var("COMPUTERNAME").ok().and_then(named))
        .or_else(|| std::env::var("HOSTNAME").ok().and_then(named))
        .unwrap_or_else(|| "this-node".into())
        .to_lowercase()
}

fn identity(node: St) -> Result<IdentityView, String> {
    node.identity.reading().clone().unwrap_or_else(|| Err(WAITING_FOR_KEY.into()))
}

pub const WAITING_FOR_KEY: &str = "Waiting for Keychain access: allow Unbrowse in the macOS dialog.";

/// Why the root key can't be used, from what reading it came to: only a read still under way is waiting on a dialog. One
/// that failed has none to allow, and says what failed.
fn why_locked(read: &Option<Result<IdentityView, String>>) -> String {
    match read {
        Some(Err(e)) => format!("The root key couldn't be read ({e}); the node tries again by itself."),
        _ => WAITING_FOR_KEY.into(),
    }
}

/// The first and the longest wait between tries of a key store that failed. Reading it can raise a dialog, so a try
/// that fails isn't repeated at the pace of a network that didn't answer.
const KEY_RETRY: std::time::Duration = std::time::Duration::from_secs(60);
const KEY_RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(3600);

/// Reads the root key until it opens, saying each try's result as it comes (`said`), with `wait` between tries: a store
/// that failed at boot (a locked Keychain, a keyring not up yet) comes back without a restart, and with it the claims
/// that have a window to be made in.
fn keep_opening(mut open: impl FnMut() -> Result<IdentityView, String>, mut said: impl FnMut(Result<IdentityView, String>), mut wait: impl FnMut(std::time::Duration)) {
    let mut gap = KEY_RETRY;
    loop {
        let read = open();
        let opened = read.is_ok();
        said(read);
        if opened {
            return;
        }
        wait(gap);
        gap = (gap * 2).min(KEY_RETRY_MAX);
    }
}

impl Node {
    /// Whether the root key can be read without a prompt. Everything that signs or checks a token waits for this.
    pub fn unlocked(&self) -> bool {
        matches!(*self.identity.reading(), Some(Ok(_)))
    }

    /// The peer network, while the node is on it. `net` stays set once it has joined, and a restart that couldn't go
    /// through leaves it set and stopped: nothing asked of a stopped network says anything about the peers it reached.
    pub fn peers(&self) -> Option<&unbrowse_net::Net> {
        self.net.get().filter(|n| !n.stopped())
    }

    /// The key store, once reading it can't stop on a dialog.
    pub fn key(&self) -> Result<&(dyn KeyStore + Send + Sync), String> {
        if self.unlocked() { Ok(self.keys.as_ref()) } else { Err(self.locked_because()) }
    }

    /// Why the key can't be used yet.
    pub fn locked_because(&self) -> String {
        why_locked(&self.identity.reading())
    }
}

/// What the node answers about itself. `terms_version` is what the windows compare the owner's acknowledgement with, so
/// neither keeps a copy of it.
#[derive(Serialize)]
struct NodeAnswer {
    #[serde(flatten)]
    info: NodeInfo,
    terms_version: &'static str,
}

fn node_info(node: St) -> NodeAnswer {
    NodeAnswer { info: node.info.clone(), terms_version: terms::TERMS_VERSION }
}

fn modified_secs(path: &Path) -> Option<u64> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_secs())
}

/// A profile or jar is named for its host; anything else in those folders is a scratch walk.
fn is_host(name: &str) -> bool {
    name.contains('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// A site the node's browser has walked: it keeps a persistent profile per host.
#[derive(Serialize)]
struct SiteView {
    host: String,
    walked: Option<u64>,
}

fn sites() -> Vec<SiteView> {
    let Ok(dir) = std::fs::read_dir(store::profiles_dir()) else { return Vec::new() };
    let mut out: Vec<SiteView> = dir
        .flatten()
        .filter_map(|e| {
            let host = e.file_name().into_string().ok()?;
            is_host(&host).then(|| SiteView { walked: modified_secs(&e.path()), host })
        })
        .collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.walked));
    out
}

/// A live session the node holds for a site. Only the count of cookies crosses into the window,
/// never a value: agents and the UI see references, the jar stays in the core.
#[derive(Serialize)]
struct SessionView {
    host: String,
    cookies: usize,
    updated: Option<u64>,
}

fn sessions() -> Vec<SessionView> {
    let Ok(dir) = std::fs::read_dir(store::jars_dir()) else { return Vec::new() };
    let mut out: Vec<SessionView> = dir
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().into_string().ok()?;
            let host = file.strip_suffix(".json")?.to_string();
            if !is_host(&host) {
                return None;
            }
            let jar: serde_json::Map<String, serde_json::Value> = store::read_json_opt(&e.path(), &unbrowse_files::JAR)?;
            Some(SessionView { host, cookies: jar.len(), updated: modified_secs(&e.path()) })
        })
        .collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.updated));
    out
}

/// Signs the node out of a site by dropping its jar and the host's browser profile; the next call to that site walks it
/// again. The profile holds the same session: left behind, the next walk would mint it straight back into the jar. A
/// browser open on the site holds it too, so it has to be closed first.
fn forget_session(host: String) -> Result<(), String> {
    if !is_host(&host) {
        return Err(format!("not a host: {host}"));
    }
    if browse::profile_in_use(&host).is_some() {
        return Err(format!("{host}'s browser is open and holds the session: close it first, then sign out"));
    }
    std::fs::remove_file(store::jar_path(&host)).map_err(|e| e.to_string())?;
    // What was forgotten is forgotten whole: how far the jar's cookies went goes with them.
    let _ = std::fs::remove_file(store::jar_scope_path(&host));
    match std::fs::remove_dir_all(store::profile_dir(&host)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("the session is gone from calls, but {host}'s browser profile stays: {e}")),
        _ => Ok(()),
    }
}

// ---- settings ----

fn settings() -> store::Settings {
    store::load_settings()
}

fn save_settings(mut settings: store::Settings) -> Result<store::Settings, String> {
    let _held = store::settings_held();
    // A window saves the whole object from its last read, which can predate an acknowledgement made from a shell.
    let kept = store::load_settings();
    settings.terms_accepted = kept.terms_accepted;
    // Keeping card security codes changes only through `keep_card_codes`, which asks the owner before it goes on and
    // forgets every code as it goes off: a save from a stale read turns it neither way.
    settings.keep_card_codes = kept.keep_card_codes;
    store::check_max_fetch(settings.max_fetch_usdc)?;
    if settings.coin_dev_buy_bps > 10_000 {
        return Err("the listing's first buy is a share of the wallet's UNB, in basis points: 0 (none) to 10,000 (all of it)".into());
    }
    for (what, v) in [("the deposit to keep", settings.deposit_floor_usdc), ("the gas to keep", settings.gas_reserve_usdc)] {
        if !(v.is_finite() && v >= 0.0) {
            return Err(format!("{what} is a sum of USDC, zero or more"));
        }
    }
    store::check_claim_gas_share(settings.claim_gas_share)?;
    if !(settings.max_gas_price_gwei.is_finite() && settings.max_gas_price_gwei > 0.0) {
        return Err("the most the node pays a unit of gas is a number of gwei above zero".into());
    }
    if !(settings.gas_budget_usdc_per_day.is_finite() && settings.gas_budget_usdc_per_day >= 0.0) {
        return Err("the network fees the node spends a day is a sum of USDC, zero or more".into());
    }
    store::save_settings(&settings)?;
    unbrowse_learn::egress::allow_private(settings.private_network);
    Ok(settings)
}

/// The owner answers the first-run screen. Only here and in `unbrowse-node terms accept` is an acknowledgement made.
fn accept_terms(keep_off: bool) -> Result<store::Settings, String> {
    let _held = store::settings_held();
    let s = terms::acknowledged(store::load_settings(), keep_off);
    store::save_settings(&s)?;
    Ok(s)
}

// ---- routes ----

fn routes() -> Vec<store::Route> {
    store::load_routes()
}

/// Deletes a route of the owner's. One live on the network goes through delisting first: its entry names this record,
/// peers pay for it, and with the record gone nothing here could delist it, so the entry would stay on the chain for good.
fn delete_route(id: String) -> Result<(), String> {
    if store::load_route(&id).is_some_and(|r| r.listing.is_some_and(|l| l.live)) {
        return Err("this route is live on the network: delist it first (Manage in My routes, the `delist_route` command, or `unbrowse-node share delist` for every route), then delete it".into());
    }
    store::delete_route(&id)
}

async fn call_route(node: St<'_>, id: String, inputs: HashMap<String, String>) -> Result<run::CallResult, String> {
    let route = store::load_route(&id).ok_or("no such route")?;
    // The owner runs a kept copy of another contributor's route only while it is still listed, as agents do.
    share::still_listed(node, &route).await.map_err(|n| n.why())?;
    // And only while its body keeps the owner's session on the route's own site, the check every agent call makes.
    share::bound(&route)?;
    share::may_run_kept(node, &route)?;
    crate::browse::know_vault(&unbrowse_learn::identity::site_of(&route.site), node.key()?)?;
    let inputs = vault::fill_inputs(&vault_keep(node.key().map(|k| k as &dyn KeyStore))?, node.key()?, &route, &inputs, false, store::load_settings().keep_card_codes)?;
    let started = run::CallEvent::start(&route, "You", None);
    node.events.emit("call", &started);
    let frames = api::heal_frames(node, &id);
    let kept = route.clone();
    let opener = node.clone();
    let r = tokio::task::spawn_blocking(move || run::call_watched(route, &inputs, "You", Some(frames), &[unbrowse_learn::fields::ALL.to_string()], Some(opener))).await.map_err(|e| e.to_string());
    let r = r.and_then(|r| r);
    node.events.emit("call", match &r {
        Ok(res) => started.end(res, None),
        Err(_) => started.failed(),
    });
    // Another contributor's route the rule refused was never sent: its body is set aside and the kept copy let go, as
    // for an agent's call (`api::call`), so the owner isn't handed it again either (R2.28).
    if let (Ok(res), Some(f)) = (&r, &kept.fetched) {
        match &res.refused {
            Some(why) if share::refused_for_what_it_says(&kept) => {
                node.share.set_aside(&f.content_id, why);
                share::drop_cached(node, &kept).await;
            }
            Some(why) => node.share.rest(&f.content_id, why),
            None => {}
        }
    }
    node.events.emit("activity", ());
    r
}

fn activity(limit: Option<usize>) -> Vec<store::Activity> {
    store::read_activity(limit.unwrap_or(200))
}

// ---- agents ----

fn agents_list() -> Vec<agents::Agent> {
    agents::list()
}

#[derive(Serialize)]
struct NewAgent {
    agent: agents::Agent,
    /// Shown once: how an agent connects. It names the agent, never its token (`agents::setup_for`).
    setup: String,
    /// The key's token, for a program of the owner's that hands it on itself (the SDK's `newAgent`, a test harness):
    /// only on this signed answer to the owner's token, never in `setup` and never shown by the window.
    token: String,
}

/// The token of agent `index`, read from the root key, for the one answer that hands it to the owner.
fn token_of_new(node: St<'_>, agent: &agents::Agent) -> Result<String, String> {
    let root = unbrowse_core::RootKey::load(node.key()?).map_err(|e| e.to_string())?;
    Ok(agents::token_of(&root, agent))
}

/// Creates the key and, once the node is on the network, sets its cap and expiry on the chain (authorizeAgent), so the
/// contract enforces them too. A local node writes nothing to the chain: joining grants it (`agents::keep_granted`).
async fn agent_create(node: St<'_>, name: String, cap_usdc: f64, days: u64) -> Result<NewAgent, String> {
    let (mut agent, setup) = agents::create(node.key()?, &name, cap_usdc, days, node.info.api_port)?;
    let token = token_of_new(node, &agent)?;
    if link::on_network(node).is_none() {
        node.events.emit("activity", ());
        return Ok(NewAgent { agent, setup, token });
    }
    match chain::authorize(&node.chain, node.key()?, agent.index, cap_usdc, agent.expires).await {
        Ok(tx) => {
            agents::set_tx(agent.index, &tx);
            agent.tx = Some(tx);
        }
        Err(e) => eprintln!("authorising {}: {e}", agent.name),
    }
    node.events.emit("activity", ());
    Ok(NewAgent { agent, setup, token })
}

/// Sets an agent key's cap (under Advanced), then grants it on the chain at once if the owner has signed in.
fn agent_set_cap(node: &Arc<Node>, index: u32, cap_usdc: f64) -> Result<agents::Agent, String> {
    let a = agents::set_cap(index, cap_usdc)?;
    if let Ok(rt) = tokio::runtime::Handle::try_current() {
        let n = node.clone();
        rt.spawn(async move { agents::keep_granted(&n).await });
    }
    node.events.emit("activity", ());
    Ok(a)
}

/// Revokes here first, whatever the chain does: from this moment the key's token opens nothing on this node, and the
/// node signs nothing more for it. Then on the chain (vouchers signed before
/// still pay, nothing signed after does, US-004); a chain that is down or no longer knows the key is said in the
/// log, and never leaves the key live here.
async fn agent_revoke(node: St<'_>, index: u32) -> Result<agents::Agent, String> {
    let a = agents::revoke(index)?;
    if a.tx.is_some() {
        let on_chain = match node.key() {
            Ok(keys) => chain::revoke(&node.chain, keys, index).await,
            Err(e) => Err(e),
        };
        if let Err(e) = on_chain {
            eprintln!("revoking {} on the chain: {e}", a.name);
            agents::owe_revoke(index);
            store::log_activity(&store::Activity {
                at: store::now(),
                who: "You".into(),
                site: "This node".into(),
                what: format!("Revoked {}'s key here; the chain didn't take the revoke, so the node tries again", a.name),
                kind: "key".into(),
                result: "failed".into(),
                ms: None,
                unb: None,
                tx: None,
                note: Some(e),
            });
        }
    }
    node.events.emit("activity", ());
    Ok(a)
}

// ---- vault ----

fn vault_list() -> Vec<vault::Login> {
    vault::list()
}

/// The vault's store for the window's commands, with the node's key once the Keychain has handed it over.
fn node_vault(node: St) -> Result<vault::Keep, String> {
    vault_keep(node.key().map(|k| k as &dyn KeyStore))
}

/// The window's import. A login saved in an app asks the web which site it belongs to, off the node's async threads.
async fn vault_import(node: St<'_>, text: String) -> Result<vault::Imported, String> {
    let keep = node_vault(node)?;
    let n = node.clone();
    let rt = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let mut apps = applinks::AppSites::new();
        // The owner confirms which site each app's logins go to, in the node's own question.
        vault::import_confirming_apps(&keep, &text, "You", &mut |a| apps.site(a), &mut |q| rt.block_on(owner_dialog::ask(n.key().ok(), q)))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn vault_add(node: St, site: String, account: String, kind: String, password: Option<String>) -> Result<vault::Login, String> {
    let login = vault::add(&node_vault(node)?, &site, &account, &kind, password.as_deref(), "You")?;
    // An agent waiting on the owner for this login (`vault:ask:`) goes on now: the vault holds it.
    hands::login_added(&login.site, &login.account);
    Ok(login)
}

/// The window's card, read as `vault card add` reads one: its security code is kept only while the vault keeps them
/// (`Settings::keep_card_codes`), whatever was sent. Nothing of the card is said back but its label and last four digits.
fn vault_card_add(node: St, label: &str, number: &str, expiry: &str, cvv: Option<&str>, name: &str) -> Result<vault::CardInfo, String> {
    let codes = store::load_settings().keep_card_codes;
    let cvv = cvv.map(str::trim).filter(|c| codes && !c.is_empty());
    let card = zeroize::Zeroizing::new(unbrowse_core::Card::read(number, expiry, cvv, name)?);
    vault::add_card(&node_vault(node)?, label, &card, codes, "You")
}

fn vault_remove(node: St, site: String, account: String) -> Result<(), String> {
    vault::remove(&node_vault(node)?, &site, &account)
}

fn vault_reveal(node: St, site: String, account: String) -> Result<String, String> {
    vault::reveal(&node_vault(node)?, node.key()?, &site, &account).map(|p| p.to_string())
}

fn vault_rotate(site: String, account: String) -> Result<vault::Login, String> {
    vault::rotate(&site, &account)
}

// ---- the recovery phrase ----

/// The node's recovery phrase, for the owner to write down and keep off this machine: 12 seed words for a node made
/// from them, which open this node's wallet in any wallet app, or 24 words for an older node, which bring back this
/// node only (its wallet goes into a wallet app through `wallet export`). The word count says which. Shown in the
/// window on the owner's ask; no agent can ask for it, and the shell never prints it.
fn wallet_phrase(node: St) -> Result<String, String> {
    let phrase = unbrowse_core::recovery::phrase(node.key()?).map_err(|e| e.to_string())?;
    log_key_event(match phrase {
        unbrowse_core::recovery::Phrase::Seed(_) => "Showed the recovery phrase (12 seed words)",
        unbrowse_core::recovery::Phrase::Key(_) => "Showed the recovery phrase (24 words of an older key)",
    });
    Ok(phrase.words().to_string())
}

#[derive(Serialize)]
struct RestoreView {
    address: String,
    /// The address of the key the restore replaced, now kept in the Keychain under its own name.
    previous: Option<String>,
}

/// Brings back the root key its words make: 12 seed words, or an older node's 24 words. The key it replaces is kept
/// in the Keychain first.
fn wallet_restore(node: St, words: String) -> Result<RestoreView, String> {
    let keys = node.key()?;
    let done = restore_root(keys, &words)?;
    *node.identity.writing() = Some(open_identity(keys));
    Ok(done)
}

/// Where a restore keeps the key it replaces: beside the root key, in the Keychain or in a file only its owner reads.
fn aside(previous: &unbrowse_core::Address) -> Result<Box<dyn KeyStore>, unbrowse_core::RecoveryError> {
    if root_in_file() {
        let dir = if DEV { store::home().join("devnet") } else { store::home() };
        return Ok(Box::new(FileStore::new(dir.join(format!("root.key.replaced.{previous}")), None)));
    }
    Ok(Box::new(KeychainStore::new(KEYCHAIN_SERVICE, &replaced_account(&root_account(), &previous.to_string()))?))
}

fn restored(done: unbrowse_core::Restored) -> RestoreView {
    match done {
        unbrowse_core::Restored::Same(a) => RestoreView { address: a.to_checksum(), previous: None },
        unbrowse_core::Restored::Replaced { address, previous } => RestoreView { address: address.to_checksum(), previous: Some(previous.to_checksum()) },
    }
}

/// What this home made under its root key and can't have under another, said for the owner. Each of these is derived
/// from or sealed under that key, or signed by it, so a different key doesn't bring them over: it leaves them behind,
/// reading wrong rather than gone. Agent keys aren't among them: each follows the root key (`agents::rekey`), and costs
/// only a new token, so a new install, restoring its owner's key before it has done anything, has none of this.
fn made_under_this_key(derived: usize, sealed: usize, passkeys: usize, listed: usize) -> Vec<String> {
    let said = |n: usize, one: &str, many: &str| match n {
        0 => None,
        1 => Some(format!("1 {one}")),
        n => Some(format!("{n} {many}")),
    };
    [
        said(derived, "login whose password is made from the key", "logins whose passwords are made from the key"),
        said(sealed, "secret sealed under the key", "secrets sealed under the key"),
        said(passkeys, "passkey sealed under the key", "passkeys sealed under the key"),
        said(listed, "route listed under the key", "routes listed under the key"),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Refuses to put `key` in place of a different root key in a home with anything made under the one there: the logins
/// would give other passwords, passkeys and sealed secrets would stop opening, and the node would go on naming the old
/// identity and listings. It fails closed, with nothing changed: the data matters more than the restore, and a home with
/// none of it, or the same key, goes on. The old key is kept aside by a restore, but that is no way back for what the
/// node wrote after it.
fn no_data_left_behind(keys: &dyn KeyStore, key: &[u8; 32]) -> Result<(), String> {
    let current = keys.get().map_err(|e| e.to_string())?;
    if current.is_none_or(|c| c.as_slice() == key.as_slice()) {
        return Ok(());
    }
    let listed = store::load_routes().iter().filter(|r| r.listing.as_ref().is_some_and(|l| l.live)).count();
    let tied = made_under_this_key(vault::list().iter().filter(|l| l.kind == "derived").count(), vault::sealed_count(!root_in_file()), passkey::list().len(), listed);
    if tied.is_empty() {
        return Ok(());
    }
    Err(format!(
        "nothing was changed: this is a different key from the one this node runs on, and this node holds {} that would stop working under it. To use that key, stop the node and move its folder ({}) aside, then restore it into a new one",
        tied.join(", "),
        store::home().display()
    ))
}

/// A different key is in place, in a home with nothing made under the old one (`no_data_left_behind`): what the node
/// keeps naming the old key goes by the new one, or is dropped. An agent's token is made from the root key, so a token
/// handed out before stops opening the node: the owner is told, not left to find out from an agent that stopped.
fn after_new_key(keys: &dyn KeyStore, view: &RestoreView) {
    if view.previous.is_some() {
        if let Err(e) = agents::rekey(keys) {
            eprintln!("restoring: the node's agent keys: {e}");
        }
        if agents::list().iter().any(|a| !a.revoked) {
            log_key_event("The node's agents need new tokens: those made under the old key no longer open it (`unbrowse connect`, or `unbrowse-node agent token`)");
        }
    }
}

fn restore_root(keys: &dyn KeyStore, words: &str) -> Result<RestoreView, String> {
    no_data_left_behind(keys, &unbrowse_core::recovery::key_of(words).map_err(|e| e.to_string())?.key)?;
    let view = restored(unbrowse_core::recovery::restore(keys, aside, words).map_err(|e| e.to_string())?);
    after_new_key(keys, &view);
    log_key_event(&match &view.previous {
        Some(p) => format!("Restored the root key from its recovery phrase; the key for {p} is kept beside it"),
        None => "Checked the recovery phrase: it is this node's key".into(),
    });
    Ok(view)
}

// ---- the encrypted backup ----

#[derive(Serialize)]
struct BackupView {
    /// The address the backup holds: this node's own wallet.
    address: String,
    /// The backup itself, an Ethereum keystore file (JSON), encrypted under the owner's passphrase.
    backup: String,
}

/// An encrypted backup of the node's key (spec §76.1 item 1.4): the root key, which is the node's wallet with its
/// identity, deposit, route coins and earnings, under the owner's passphrase, as an Ethereum keystore file that also opens in
/// any wallet that imports one. Shown to the owner only: no agent can ask for it.
fn wallet_export(node: St, passphrase: String) -> Result<BackupView, String> {
    let root = unbrowse_core::RootKey::load(node.key()?).map_err(|e| e.to_string())?;
    let v = export_root(&root, &passphrase)?;
    log_key_event("Exported an encrypted backup of the node's key");
    Ok(v)
}

fn export_root(root: &unbrowse_core::RootKey, passphrase: &str) -> Result<BackupView, String> {
    let backup = unbrowse_core::backup::export(root, passphrase).map_err(|e| e.to_string())?;
    Ok(BackupView { address: root.address().to_checksum(), backup })
}

/// Brings back the key an encrypted backup holds, on this machine or a new one, keeping the key it replaces. The node
/// is that node from here: its wallet, identity, deposit and agent keys. Its owner signs in again, since a sign-in names
/// the key it was made for.
fn wallet_import(node: St, backup: String, passphrase: String) -> Result<RestoreView, String> {
    let keys = node.key()?;
    let done = import_root(keys, &backup, &passphrase)?;
    *node.identity.writing() = Some(open_identity(keys));
    Ok(done)
}

fn import_root(keys: &dyn KeyStore, backup: &str, passphrase: &str) -> Result<RestoreView, String> {
    let key = unbrowse_core::backup::key_of(backup, passphrase).map_err(|e| e.to_string())?;
    no_data_left_behind(keys, &key)?;
    let view = restored(unbrowse_core::recovery::restore_key(keys, aside, &key).map_err(|e| e.to_string())?);
    after_new_key(keys, &view);
    log_key_event(&match &view.previous {
        Some(p) => format!("Restored the node's key from its backup; the key for {p} is kept beside it"),
        None => "Restored the node's key from its backup".into(),
    });
    Ok(view)
}

fn log_key_event(what: &str) {
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "You".into(),
        site: String::new(),
        what: what.into(),
        kind: "wallet".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
}

const WALLET_USAGE: &str = "usage: unbrowse-node wallet [--copy]           this node's address, its owner, network and gas
       unbrowse-node wallet address [--copy]   the address alone, to pipe
       unbrowse-node wallet restore            the 12 or 24 words on stdin (the recovery phrase is shown in the window, never here)
       unbrowse-node wallet export <file>      an encrypted backup of this node's key, under the passphrase on stdin
       unbrowse-node wallet import <file>      the key in that backup, on this machine or a new one; the passphrase on stdin";

/// `unbrowse-node wallet`: this node's own address, the key that signs its writes and pays their gas, read from the
/// root key store with no node running, and never anything secret. `wallet address` prints the address alone, so it
/// pipes; plain `wallet` adds the linked owner wallet, the network and the gas the address holds there (read with a
/// short bound, best effort), and where to get gas when it's short. `--copy` puts the address on the clipboard.
/// `wallet restore`: the root key from its 12 seed words or an older node's 24 words, read from stdin, for a machine
/// where no one opens the window.
/// With a node running it signs as the new key at once, since the key is read where it is kept, and restarts by itself
/// within a minute or so, once no call is under way, so its place on the network follows (`watch_what_it_took`).
fn wallet_cli(args: &[String]) -> i32 {
    let (copy, rest): (Vec<&String>, Vec<&String>) = args.iter().partition(|a| *a == "--copy");
    let copy = !copy.is_empty();
    match rest.iter().map(|s| s.as_str()).collect::<Vec<_>>()[..] {
        [] => return wallet_show(false, copy),
        ["address"] => return wallet_show(true, copy),
        ["export", file] if !copy => return backup_cli(true, file),
        ["import", file] if !copy => return backup_cli(false, file),
        ["restore"] if !copy => {}
        _ => {
            eprintln!("{WALLET_USAGE}");
            return 2;
        }
    }
    let mut words = zeroize::Zeroizing::new(String::new());
    if let Err(e) = std::io::Read::read_to_string(&mut std::io::stdin(), &mut words) {
        eprintln!("couldn't read the words from stdin: {e}");
        return 1;
    }
    match no_node_holds_the_key().and_then(|()| root_store()).and_then(|keys| restore_from_shell(keys.as_ref(), root_in_file(), &words)) {
        Ok(RestoreView { address, previous: Some(p) }) => {
            println!("restored {address}; the key for {p} is kept in the Keychain");
            0
        }
        Ok(RestoreView { address, previous: None }) => {
            println!("{address}: that is this node's key already");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// Whether the shell may write a backup of the key: it reads the key from its store with no node and no token, so a
/// key the OS keystore keeps from other programs (the macOS Keychain lets this program read it, and no other) goes
/// out only on the owner's yes in the node's own dialog, like `wallet_export`. A key kept in a file (`root_in_file`)
/// is open to this user's programs already, and the dialog would guard nothing.
fn shell_export_allowed(keys: &dyn KeyStore, key_in_file: bool) -> Result<(), String> {
    shell_owner_yes(keys, key_in_file, "Something on this computer is asking Unbrowse to write a backup of this node's key, which opens its wallet, to a file. Allow it only if you ran `unbrowse-node wallet export` yourself just now.")
}

/// The owner's yes for something a shell's command does with the node's key from its store, with no node and no token
/// (a backup written, the key replaced, a new agent key made): asked when the OS keystore keeps the key from other
/// programs, as the node asks for the same commands sent with its token. A key kept in a file (`key_in_file`) is open
/// to this user's programs already, and asking would guard nothing.
fn shell_owner_yes(keys: &dyn KeyStore, key_in_file: bool, question: &str) -> Result<(), String> {
    if key_in_file {
        return Ok(());
    }
    owner_dialog::ask_blocking(keys, question)
}

/// The owner command a shell's write is, with its arguments, for every shell write other than a setting that changes
/// what the owner's window would ask about (`commands::asks_the_owner`). `None` for anything else. A setting is asked
/// about where it is written, whatever command writes it (`store::ask_before_shell_writes`), so it needs no row here.
fn shell_write(argv: &[&str]) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::json;
    let bps = |bps: &str| bps.trim().parse::<u32>().ok();
    match argv {
        ["coin", "dev-buy", share] => Some(("coin_dev_buy", json!({ "bps": bps(share) }))),
        ["passkey", "remove", id] => Some(("passkey_remove", json!({ "id": id }))),
        ["session", "import", host] => Some(("import_session", json!({ "host": host }))),
        ["session", "import", host, "--from", file] => Some(("import_session", json!({ "host": host, "from": if *file == "-" { "what was typed in" } else { file } }))),
        ["vault", "remove", site, account] => Some(("vault_remove", json!({ "site": site, "account": account }))),
        ["vault", "rotate", site, account] => Some(("vault_rotate", json!({ "site": site, "account": account }))),
        ["vault", "card", "remove", card] => Some(("vault_card_remove", json!({ "card": card }))),
        ["checkout", "done", site] => Some(("checkout_release", json!({ "site": site, "how": "finished" }))),
        ["checkout", "dismiss", "all"] => Some(("checkout_release", json!({ "site": "*", "how": "dismissed" }))),
        ["checkout", "dismiss", site] => Some(("checkout_release", json!({ "site": site, "how": "dismissed" }))),
        _ => None,
    }
}

/// What the owner is asked before a shell's command writes `to` as the settings: the window's `save_settings` question
/// for the same change (`commands::asks_the_owner`), `None` when it loosens nothing.
fn shell_settings_question(to: &store::Settings) -> Option<String> {
    commands::asks_the_owner("save_settings", &serde_json::json!({ "settings": serde_json::to_value(to).ok()? }))
}

/// The owner's yes for a settings write from a shell (`store::ask_before_shell_writes`), asked as the window's
/// `save_settings` asks it (`shell_owner_yes`): nothing loosened, nothing asked.
fn shell_settings_yes(to: &store::Settings) -> Result<(), String> {
    let Some(question) = shell_settings_question(to) else { return Ok(()) };
    let keys = root_store()?;
    shell_owner_yes(keys.as_ref(), root_in_file(), &question)
}

/// The owner's yes for a shell's write (`shell_write`), asked as the window's command asks it (`shell_owner_yes`):
/// nothing to ask, nothing asked.
fn shell_write_allowed(argv: &[&str]) -> Result<(), String> {
    let Some((cmd, a)) = shell_write(argv) else { return Ok(()) };
    let Some(question) = commands::asks_the_owner(cmd, &a) else { return Ok(()) };
    let keys = root_store()?;
    shell_owner_yes(keys.as_ref(), root_in_file(), &question)
}

/// A shell replaces the node's key only while no node runs here: a running node holds the key it read from the system's
/// keystore from the first read of the run (`vault.unlock-once`), and would go on signing and sealing with the one
/// replaced. A key in a file is read from the file each time, so nothing holds it.
fn no_node_holds_the_key() -> Result<(), String> {
    if !root_in_file() && listening_here(store::api_port()) {
        return Err("the node is running here, and holds its key until it stops: stop it first (quit the app, or stop its service), then run this again".into());
    }
    Ok(())
}

/// `wallet restore`, from a shell: the key the words make, in the node's key's place, on the owner's yes.
fn restore_from_shell(keys: &dyn KeyStore, key_in_file: bool, words: &str) -> Result<RestoreView, String> {
    shell_owner_yes(keys, key_in_file, "Something on this computer is asking Unbrowse to replace this node's key with the one some recovery words make: the node would then earn and pay as that key. Allow it only if you ran `unbrowse-node wallet restore` yourself just now.")?;
    restore_root(keys, words)
}

/// `wallet import <file>`, from a shell: the key in a backup, in the node's key's place, on the owner's yes.
fn import_from_shell(keys: &dyn KeyStore, key_in_file: bool, backup: &str, passphrase: &str) -> Result<RestoreView, String> {
    shell_owner_yes(keys, key_in_file, "Something on this computer is asking Unbrowse to replace this node's key with the one in a backup: the node would then earn and pay as that key. Allow it only if you ran `unbrowse-node wallet import` yourself just now.")?;
    import_root(keys, backup, passphrase)
}

/// `wallet export <file>` and `wallet import <file>`, from a shell. An import into a running node's store acts as a
/// `wallet restore` does (`wallet_cli`). The passphrase is the first line on stdin, so it is never an
/// argument a shell's history keeps. An export never writes over a file, and only its owner can read what it writes.
fn backup_cli(export: bool, file: &str) -> i32 {
    eprintln!("{}", if export { "the backup's passphrase (at least 10 characters), then Enter:" } else { "the backup's passphrase, then Enter:" });
    let mut line = zeroize::Zeroizing::new(String::new());
    if let Err(e) = std::io::stdin().read_line(&mut line) {
        eprintln!("couldn't read the passphrase from stdin: {e}");
        return 1;
    }
    let pass = line.trim_end_matches(['\n', '\r']);
    let path = std::path::Path::new(file);
    if export {
        if let Err(e) = root_store().and_then(|keys| shell_export_allowed(keys.as_ref(), root_in_file())) {
            eprintln!("{e}");
            return 1;
        }
    }
    let done = root_store().and_then(|keys| {
        if export {
            if root_address(keys.as_ref())?.is_none() {
                return Err("this node has no key yet: start it once (`unbrowse-node` or the app) and it makes one".into());
            }
            let root = unbrowse_core::RootKey::load(keys.as_ref()).map_err(|e| e.to_string())?;
            let v = export_root(&root, pass)?;
            unbrowse_files::private::create_new(path, v.backup.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))?;
            log_key_event("Exported an encrypted backup of the node's key");
            Ok(format!("wrote an encrypted backup of {} to {file}: keep it, and its passphrase, off this machine", v.address))
        } else {
            no_node_holds_the_key()?;
            let backup = std::fs::read_to_string(path).map_err(|e| format!("{file}: {e}"))?;
            Ok(match import_from_shell(keys.as_ref(), root_in_file(), &backup, pass)? {
                RestoreView { address, previous: Some(p) } => format!("restored {address}; the key for {p} is kept beside it. Sign in again: a sign-in names the key it was made for"),
                RestoreView { address, previous: None } => format!("restored {address}"),
            })
        }
    });
    match done {
        Ok(said) => {
            println!("{said}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// The address of the root key in `keys`, if it has one: read, never made, so a look at the address never creates a
/// key. Nothing of the key leaves this function but its address.
fn root_address(keys: &dyn KeyStore) -> Result<Option<String>, String> {
    if keys.get().map_err(|e| e.to_string())?.is_none() {
        return Ok(None);
    }
    let id = first_key(keys)?;
    Ok(Some(id.address.to_checksum()))
}

/// `wallet` and `wallet address` (`wallet_cli`).
fn wallet_show(bare: bool, copy: bool) -> i32 {
    let me = match root_store().and_then(|k| root_address(k.as_ref())) {
        Ok(Some(a)) => a,
        Ok(None) => {
            eprintln!("this node has no key yet: start it once (`unbrowse-node` or the app) and it makes one");
            return 1;
        }
        Err(e) => {
            eprintln!("couldn't read this node's key: {e}");
            return 1;
        }
    };
    if bare {
        println!("{me}");
    } else {
        for line in wallet_lines(&me) {
            println!("{line}");
        }
    }
    if copy {
        match copy_to_clipboard(&me) {
            Ok(tool) => eprintln!("copied {me} to the clipboard ({tool})"),
            Err(why) => eprintln!("{why}; copy the address above by hand"),
        }
    }
    0
}

/// What plain `wallet` says, after the address: the linked owner, the network, and the address's gas there.
fn wallet_lines(me: &str) -> Vec<String> {
    let mut out = vec![
        format!("this node's wallet: {me}"),
        "  an Arc wallet made from the node's own key: the node joins the network with it, pays its gas and earns into it,".into(),
        "  with no sign-in. Send USDC on Arc here. `unbrowse-node wallet export` writes it out for another wallet app.".into(),
    ];
    out.push(match link::load(me) {
        Some(l) => format!("linked wallet: {} (withdrawals go there)", l.owner),
        None => "linked wallet: none; the node pays and earns with its own wallet (`unbrowse-node sign-in` links another)".into(),
    });
    let mode = match chain::chosen() {
        Ok(m) => m,
        Err(e) => {
            out.push(format!("network: {e}"));
            return out;
        }
    };
    let (name, rpc) = match &mode {
        chain::Mode::Devnet => ("devnet".to_string(), chain::url()),
        chain::Mode::Live(l) => (l.net.name.to_string(), l.rpc.clone()),
    };
    out.push(format!("network: {name}"));
    let who: alloy::primitives::Address = match me.parse() {
        Ok(a) => a,
        Err(_) => return out,
    };
    let read = async {
        use alloy::providers::Provider;
        let p = rpc::ProviderBuilder::new().connect_http(rpc.clone());
        let have = p.get_balance(who).await.map_err(|e| e.to_string())?;
        let price = crate::chain::gas_price(&p).await?;
        Ok::<_, String>((have, price))
    };
    let got = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())
        .and_then(|rt| rt.block_on(async { tokio::time::timeout(std::time::Duration::from_secs(5), read).await.map_err(|_| "no answer in 5 seconds".to_string()).and_then(|r| r) }));
    match (got, &mode) {
        (Ok((have, price)), mode) => {
            out.push(format!("gas: {} USDC", chain::gas_f(have)));
            let need = alloy::primitives::U256::from(price) * alloy::primitives::U256::from(chain::WRITE_GAS) * alloy::primitives::U256::from(2u64);
            match mode {
                chain::Mode::Live(l) if have < need => out.push(format!("  short of gas: {}; a node that only earns needs about {} USDC once, for its identity", chain::needs_gas(l.net, who, have, need), link::IDENTITY_USDC)),
                chain::Mode::Devnet => out.push("  the devnet tops up its own gas".into()),
                _ => {}
            }
        }
        (Err(e), _) => out.push(format!("gas: couldn't read it from {rpc} ({e})")),
    }
    out
}

/// Puts `text` on the clipboard with the system's own tool: pbcopy on macOS, wl-copy or xclip on Linux, clip on
/// Windows. Which tool did it, or why none could.
fn copy_to_clipboard(text: &str) -> Result<&'static str, String> {
    let tools: &[(&'static str, &[&str])] = if cfg!(target_os = "macos") {
        &[("pbcopy", &[])]
    } else if cfg!(windows) {
        &[("clip", &[])]
    } else {
        &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"])]
    };
    copy_with(tools, text)
}

fn copy_with(tools: &[(&'static str, &[&str])], text: &str) -> Result<&'static str, String> {
    use std::io::Write;
    for (tool, args) in tools {
        let Ok(mut child) = std::process::Command::new(tool).args(*args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn() else {
            continue;
        };
        let wrote = child.stdin.take().map(|mut i| i.write_all(text.as_bytes()));
        if matches!(wrote, Some(Ok(()))) && child.wait().is_ok_and(|s| s.success()) {
            return Ok(tool);
        }
    }
    Err(format!("no clipboard tool found (tried {})", tools.iter().map(|(t, _)| *t).collect::<Vec<_>>().join(", ")))
}

// ---- the chain ----

#[derive(Serialize)]
struct ChainStatus {
    up: bool,
    error: Option<String>,
    rpc: String,
    /// `devnet`, or the live network the node runs on.
    network: String,
    deployment: Option<chain::Deployment>,
    /// A live network that answers but has no Settlement this node can use: payments aren't open there yet. Never on
    /// the devnet, whose contracts the node deploys itself.
    settlement_missing: bool,
    /// Whether payments work (`money::payments`): the windows show this, and work out nothing of their own.
    payments: &'static str,
    /// The second RPC (`check_rpc`): "not needed" on the devnet or a chain on this machine, else "named", "missing" or
    /// "misnamed" (`rpc::second_rpc_state`).
    second_rpc: &'static str,
    /// What is held back until a second RPC is named, or why the one named can't be used; none when nothing is.
    held_back: Option<String>,
}

fn chain_status(node: St) -> ChainStatus {
    let d = node.chain.deployment.locked().clone();
    let mut error = node.chain_error.locked().clone();
    let mut settlement_missing = false;
    let live = node.chain.network().is_some();
    let (network, rpc) = match node.chain.network() {
        Some(net) => {
            // On a live network the chain can be up with no Settlement to use yet: that is why the money is down.
            settlement_missing = error.is_none() && d.is_none();
            error = error.or_else(|| node.chain.deployed().err());
            (net.name.to_string(), crate::gateway::shown(chain::url().as_str()))
        }
        None => (chain::DEVNET.to_string(), "Local devnet (Anvil)".into()),
    };
    let payments = money::payments(live, d.is_some(), settlement_missing, error.is_some());
    let (second_rpc, held_back) = if live { rpc::second_rpc_state() } else { ("not needed", None) };
    ChainStatus { up: d.is_some(), error, rpc, network, deployment: d, settlement_missing, payments, second_rpc, held_back }
}

async fn wallet(node: St<'_>) -> Result<chain::WalletView, String> {
    chain::wallet(&node.chain, node.key()?).await
}

async fn done(node: &Node, r: Result<String, String>) -> Result<String, String> {
    node.events.emit("activity", ());
    r
}

async fn faucet(node: St<'_>, amount: f64) -> Result<String, String> {
    done(node, chain::faucet(&node.chain, node.key()?, amount).await).await
}

async fn deposit(node: St<'_>, amount: f64) -> Result<String, String> {
    done(node, chain::deposit(&node.chain, node.key()?, amount).await).await
}

async fn request_withdraw(node: St<'_>, amount: f64) -> Result<String, String> {
    done(node, chain::request_withdraw(&node.chain, node.key()?, amount).await).await
}

async fn withdraw(node: St<'_>) -> Result<String, String> {
    // The owner's linked wallet, once confirmed, is where withdrawals go: earnings never wait at the node's own address.
    let to = link::payout(node).await?;
    done(node, chain::withdraw_to(&node.chain, node.key()?, to).await).await
}

/// Sends USDC from the node's own address on to one the owner names: the way out for a withdrawal or earnings paid
/// here with no linked wallet (`chain::send_usdc`).
async fn wallet_send(node: St<'_>, to: String, amount: f64) -> Result<String, String> {
    let to: alloy::primitives::Address = to.trim().parse().map_err(|_| format!("{} isn't an address", to.trim()))?;
    done(node, chain::send_usdc(&node.chain, node.key()?, to, amount).await).await
}

// ---- route coins (spec ch. 6; `chain::coins`) ----

/// An entry id as the owner names it, under `k`.
fn entry_arg(a: &serde_json::Value, k: &str) -> Result<alloy::primitives::FixedBytes<32>, OwnerError> {
    let s: String = arg(a, k)?;
    s.trim().parse().map_err(|_| OwnerError::Failed(format!("{k}: {} isn't an entry id (0x and 64 hex digits)", s.trim())))
}

async fn coin_done(node: &Node, r: Result<chain::coins::CoinDone, String>) -> Result<chain::coins::CoinDone, String> {
    node.events.emit("activity", ());
    r
}

/// The listing's first buy `coin_dev_buy_bps` (`decide.dev-buy-default-on`): a share of the wallet's UNB, in basis
/// points, 100 (1%) by default and 0 for none.
#[derive(Serialize)]
struct DevBuy {
    bps: u32,
}

fn set_coin_dev_buy(bps: u32) -> Result<DevBuy, String> {
    if bps > 10_000 {
        return Err("the listing's first buy is a share of the wallet's UNB in basis points, 0 (none) to 10,000 (all of it)".into());
    }
    let _held = store::settings_held();
    let mut s = store::load_settings();
    s.coin_dev_buy_bps = bps;
    store::save_settings(&s)?;
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "You".into(),
        site: String::new(),
        what: if bps > 0 { format!("Listing launches each entry's coin with a first buy of {}% of your UNB", f64::from(bps) / 100.0) } else { "Listing launches no coin by itself".into() },
        kind: "coin".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some("Once a claim credits an entry to this wallet, the node launches its coin with that share of the UNB the wallet holds then, and stakes the coins for you".into()),
    });
    Ok(DevBuy { bps })
}

async fn advance_day(node: St<'_>) -> Result<(), String> {
    chain::advance_day(&node.chain).await
}

/// The fee a node starts at when its owner hasn't set one: the client's suggested detail fee (`fees.suggested_detail`).
/// The protocol sets no price (R3.30); auto pricing moves it from here.
const STARTING_FEE: f64 = 0.01;

/// Lists the route at the node's fee. The price belongs to the node: one that has none yet starts at the suggested fee.
async fn list_route(node: St<'_>, id: String) -> Result<store::Route, String> {
    let route = store::load_route(&id).ok_or("no such route")?;
    // Listing needs the node on the network, and a route learned before it joined stays on this node for good (R1.35, R2.8).
    let Some(since) = link::on_network(node) else {
        return Err(match terms::standing(&store::load_settings()) {
            terms::Standing::TermsDue => terms::due(),
            _ => "this node is off the network, so routes stay on it (`unbrowse-node network on` joins on its own wallet)".into(),
        });
    };
    if route.local_since(Some(since)) {
        return Err("this route was learned while the node was off the network, so it stays on this node".into());
    }
    if route.fetched.is_some() {
        return Err("this route's body is another contributor's listing: it runs here, and only they list it".into());
    }
    // A site that opted out for Unbrowse in its robots rules (R4.32) has none of its routes listed.
    if let Some(why) = optout::refuses_async(&route).await {
        return Err(why);
    }
    // The body others will fetch, with nothing of the owner's in it; a route that can't be shared is refused here,
    // before anything is written to the chain.
    // The detector runs on the exact bytes a listing publishes (R6.36): a body it flags is refused. Only a devnet drive
    // of the leak path may list one anyway (`UNBROWSE_TEST_LIST_LEAKS`).
    let body = if leak::may_list_leaks() {
        let body = recipe::compile_with(&route, false)?;
        if let Err(e) = recipe::of_route(&route) {
            eprintln!("list: listing it anyway, as UNBROWSE_TEST_LIST_LEAKS asks (devnet only): {e}");
        }
        body
    } else {
        recipe::of_route(&route)?
    };
    // Signed and kept, with nothing written to the chain for it (R2.15): no `listEntry`, and no `setFee` (the listing
    // lists its price, `STARTING_FEE` while the wallet has set none). Under a posted root before the network hears of
    // it (R2.19): this node's, or the reserve's next one (R2.20), until which it waits unspread. The chain learns of it
    // at its first claim, which credits its body's entry (`Listings.showAndClaim`, R2.18).
    // A route delisted before takes a new version even of the same body, or a node that heard its withdrawal never
    // reads it as back (R2.16).
    let again = route.listing.as_ref().is_some_and(|l| !l.live);
    let listed = match again {
        true => listing::republish(&node.chain, node.key()?, &node.info.name, &id, &route.what, &body, STARTING_FEE).await?,
        false => listing::publish(&node.chain, node.key()?, &node.info.name, &id, &route.what, &body, STARTING_FEE).await?,
    };
    let content = listing::load_book(&node.chain).latest(&id).map(|k| k.listing.content_id.clone()).ok_or("the listing wasn't kept")?;
    // A body credited on the chain to this wallet and delisted before is put back in the live set (R2.16). One the chain
    // takes only from the owner's wallet, or one another contributor holds, isn't listed by saying so here: nothing
    // would spread it (`peers::ServedListings`).
    let entry = chain::content_entry_id(&content);
    let me = chain::owner_address(node.key()?)?;
    let wallet = listing::lister_wallet(&node.chain, node.key()?).await?;
    let on_chain = chain::entry_by_hash(&node.chain, entry).await?.map(|(by, e)| (by, e.live));
    let tx = match listing::entry_step(on_chain, true, me, wallet) {
        listing::EntryStep::Nothing => String::new(),
        listing::EntryStep::Node => chain::relist_entry(&node.chain, node.key()?, entry, &route.what).await?,
        listing::EntryStep::Wallet(by) => return Err(wallet_sends(node, by, entry, true)?),
        listing::EntryStep::Theirs => return Err("this body's entry on the chain is another contributor's, so it stays theirs to list".into()),
    };
    // Set on the record as it is now: a call that ran meanwhile keeps its stats.
    let listing = store::Listing { entry_id: format!("{entry:#x}"), tx, listed_at: store::now(), live: true };
    let route = store::update_route(&id, |r| r.listing = Some(listing))?.ok_or("the route was deleted while it was listed; delist the entry")?;
    match listed {
        Some(p) => {
            peers::provide(node, &route.site).await;
            // Its body is served from here: callers fetch it, pay for it and run it themselves (R7.1).
            share::provide(node, &p.listing.content_id, true).await;
        }
        // Under the owner's wallet, whose key this node doesn't hold: it waits for the wallet's signature
        // (`listings_to_sign`), and spreads once the owner signs it (`listing_sign`).
        None if listing::load_book(&node.chain).latest(&id).is_some_and(|k| !k.signed()) => {
            eprintln!("listing: {id} waits for your wallet to sign it before it spreads")
        }
        None => eprintln!("listing: {id} waits for the reserve's next root before it spreads"),
    }
    node.events.emit("activity", ());
    Ok(route)
}

/// The owner sets the node's fee, and whether it follows demand between a floor and a ceiling. Turning the auto
/// mode on starts its count afresh from this block.
async fn set_pricing(node: St<'_>, fee: f64, auto: bool, floor: f64, ceiling: f64) -> Result<store::Pricing, String> {
    if fee <= 0.0 || (auto && (floor <= 0.0 || ceiling < floor)) {
        return Err(if fee <= 0.0 { "set a fee above zero" } else { "set a floor above zero and a ceiling at or above it" }.into());
    }
    let fee = if auto { fee.clamp(floor, ceiling) } else { fee };
    let mut p = store::load_pricing();
    if auto && !p.auto {
        let block = chain::latest_block(&node.chain).await?;
        p.epoch = chain::current_epoch(&node.chain).await?;
        p.block = block;
        p.lines = 0;
    }
    p.auto = auto;
    if auto {
        p.floor = floor;
        p.ceiling = ceiling;
    }
    if (chain::fee_of(&node.chain, node.key()?).await? - fee).abs() > 1e-9 {
        done(node, chain::set_fee(&node.chain, node.key()?, fee, None).await).await?;
        share::announce_reprice(node);
    }
    store::save_pricing(&p)?;
    node.events.emit("activity", ());
    Ok(p)
}

/// The price each of this node's live routes lists, in whole USDC: 0 for one with no listing kept or no price in it.
fn live_prices(node: &Node) -> Result<Vec<f64>, String> {
    let d = node.chain.deployed()?;
    let book = listing::load_book(&node.chain);
    let price = |id: &str| book.latest(id).and_then(|k| k.listing.terms.price.units()).map(|u| d.usdc_f(u)).unwrap_or(0.0);
    Ok(store::load_routes().iter().filter(|r| r.listing.as_ref().is_some_and(|l| l.live)).map(|r| price(&r.id)).collect())
}

/// Once an epoch, an auto-priced node moves its fee with the paid fetches its routes drew since the last look. The
/// epoch is recorded before the fee is sent: a `setFee` that lands but answers an error, or a restart before the record,
/// then never moves the fee a second time in the epoch from the fee it already moved (one step at most an epoch). A
/// send that truly failed leaves the fee where it was until the next epoch's look.
async fn reprice(node: &Node) -> Result<(), String> {
    let mut p = store::load_pricing();
    if !p.auto {
        return Ok(());
    }
    let epoch = chain::current_epoch(&node.chain).await?;
    if !p.due(epoch) {
        return Ok(());
    }
    let (lines, block) = chain::paid_since(&node.chain, node.key()?, p.block).await?;
    let listed = store::load_routes().iter().any(|r| r.listing.as_ref().is_some_and(|l| l.live));
    let fee = chain::fee_of(&node.chain, node.key()?).await?;
    let market = peers::market_fee(node).await;
    let before = p.lines;
    let send = p.look(epoch, block, lines, fee, market, listed);
    store::save_pricing(&p)?;
    let prices = live_prices(node)?;
    if let Some(next) = send.filter(|next| store::moves_a_price(fee, *next, &prices)) {
        let others = market.map(|m| format!("; others charge {m} USDC for the same sites")).unwrap_or_default();
        let why = format!("{lines} paid fetch{} last epoch, {before} the one before{others}", if lines == 1 { "" } else { "es" });
        chain::set_fee(&node.chain, node.key()?, next, Some(why)).await?;
        share::announce_reprice(node);
        node.events.emit("activity", ());
    }
    Ok(())
}

/// What the owner's wallet has to send for `entry` to leave the chain's live set, or with `back` to rejoin it, said as a
/// failure of the command that needed it and kept in the activity log: this node can't write it, and no one else will.
fn wallet_sends(node: St<'_>, by: alloy::primitives::Address, entry: alloy::primitives::FixedBytes<32>, back: bool) -> Result<String, String> {
    let (to, data) = chain::entry_call(&node.chain, entry, back)?;
    let what = if back { "This entry is delisted on the chain, and only your wallet can list it again" } else { "This node stopped serving and spreading the route, but its entry stays live on the chain until your wallet delists it" };
    let call = format!("Send from {by:#x} to {to:#x} with data {data}");
    store::log_activity(&store::Activity { at: store::now(), who: "This node".into(), site: String::new(), what: what.into(), kind: "list".into(), result: "asked".into(), ms: None, unb: None, tx: None, note: Some(call.clone()) });
    Ok(format!("{what}. {call}"))
}

/// Delists the route, and keeps it off the network: the node never lists it again by itself until the owner shares
/// it again (`autolist::share_route`). An entry only the owner's wallet can delist answers an error saying what it sends:
/// the node has done its part, and the network still shows the entry.
async fn delist_route(node: St<'_>, id: String) -> Result<store::Route, String> {
    let route = store::load_route(&id).ok_or("no such route")?;
    // A body a claim has credited to this wallet is delisted on the chain. One no claim has shown yet has no entry: it
    // is withdrawn between nodes, by no longer serving or spreading it (R2.16).
    let entry = route.listing.as_ref().and_then(|l| l.entry_id.parse::<alloy::primitives::FixedBytes<32>>().ok());
    let me = chain::owner_address(node.key()?)?;
    let wallet = listing::lister_wallet(&node.chain, node.key()?).await?;
    let mut left_to = None;
    let tx = match entry {
        Some(e) => {
            let on_chain = chain::entry_by_hash(&node.chain, e).await?.map(|(by, v)| (by, v.live));
            match listing::entry_step(on_chain, false, me, wallet) {
                listing::EntryStep::Node => chain::delist_entry(&node.chain, node.key()?, e, &route.what).await?,
                listing::EntryStep::Wallet(by) => {
                    left_to = Some((by, e));
                    String::new()
                }
                _ => String::new(),
            }
        }
        None => String::new(),
    };
    let route = store::update_route(&id, |r| {
        r.share = Some(false);
        if let Some(l) = r.listing.as_mut() {
            l.live = false;
            l.tx = tx;
        }
    })?
    .ok_or("the entry is delisted; the route was deleted meanwhile")?;
    peers::listings_changed().await;
    share::stop_serving_own(node, &route.id).await;
    // The nodes that keep a copy or serve the site hear of it in seconds, and read the chain again.
    if let Some(e) = entry {
        share::announce_delist(node, &route.site, e).await;
    }
    node.events.emit("activity", ());
    match left_to {
        Some((by, e)) => Err(wallet_sends(node, by, e, false)?),
        None => Ok(route),
    }
}

/// How often the routes' marks are read against the chain (`mend_listings`): one read for each listed route.
const MEND_EVERY: std::time::Duration = std::time::Duration::from_secs(600);

/// When `mend_listings` last looked.
static MENDED: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

/// Brings each route's listing mark and its entry on the chain back together (`listing::mend`), from the background
/// pass: nothing else looks once a write has gone by.
async fn mend_listings(node: St<'_>) {
    {
        let mut last = MENDED.locked();
        if last.is_some_and(|t| t.elapsed() < MEND_EVERY) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    let Ok(keys) = node.key() else { return };
    let (Ok(me), Ok(wallet)) = (chain::owner_address(keys), listing::lister_wallet(&node.chain, keys).await) else { return };
    for r in store::load_routes() {
        let Some(l) = &r.listing else { continue };
        let Ok(entry) = l.entry_id.parse::<alloy::primitives::FixedBytes<32>>() else { continue };
        // A chain that didn't answer: the next look reads it again.
        let Ok(on_chain) = chain::entry_by_hash(&node.chain, entry).await else { continue };
        match listing::mend(l.live, on_chain.map(|(by, e)| (by, e.live)), me, wallet) {
            listing::Mend::Nothing => {}
            listing::Mend::Delist => match chain::delist_entry(&node.chain, keys, entry, &r.what).await {
                Ok(tx) => {
                    let _ = store::update_route(&r.id, |r| {
                        if let Some(l) = r.listing.as_mut() {
                            l.tx = tx;
                        }
                    });
                }
                Err(e) => eprintln!("listings: delisting {} again: {e}", r.id),
            },
            step @ (listing::Mend::MarkDelisted | listing::Mend::Moved(_)) => {
                if let listing::Mend::Moved(by) = step {
                    store::log_activity(&store::Activity {
                        at: store::now(),
                        who: "This node".into(),
                        site: r.site.clone(),
                        what: format!("{} is no longer this node's listing", r.what),
                        kind: "list".into(),
                        result: "refused".into(),
                        ms: None,
                        unb: None,
                        tx: None,
                        note: Some(format!("Its entry is credited to {by:#x}, under an earlier listing of the same body")),
                    });
                }
                let _ = store::update_route(&r.id, |r| {
                    if let Some(l) = r.listing.as_mut() {
                        l.live = false;
                    }
                });
                peers::listings_changed().await;
                share::stop_serving_own(node, &r.id).await;
                node.events.emit("activity", ());
            }
        }
    }
}

#[derive(Serialize)]
struct RouteChain {
    id: String,
    listed: bool,
    live: bool,
    fee: f64,
    /// Whether this node holds the route to serve for others (`held.json`; nothing on chain).
    held: bool,
    /// The entry's route coin, once launched (`coin.per-entry`), the coins of it the owner's wallet holds staked and
    /// unstaked, and the entry's rank (`rank.score`, in UNB; 0 is no rank).
    coin: Option<String>,
    staked: f64,
    held_coins: f64,
    rank: f64,
}

/// What the chain says about each route: listed, its fee, held by this node, and its coin, the owner's stake in it and
/// its rank.
async fn routes_on_chain(node: St<'_>) -> Result<Vec<RouteChain>, String> {
    let mut out = Vec::new();
    let held: std::collections::HashSet<String> = store::load_held().into_iter().map(|h| h.entry_id.to_ascii_lowercase()).collect();
    let mine = chain::coins::holdings(&node.chain, node.key()?).await.unwrap_or_default();
    let routes = store::load_routes();
    let ids: Vec<alloy::primitives::FixedBytes<32>> = routes
        .iter()
        .filter_map(|r| r.listing.as_ref().map(|l| l.entry_id.clone()).or_else(|| r.fetched.as_ref().map(|f| f.entry_id.clone())))
        .filter_map(|e| e.parse().ok())
        .collect();
    let ranks = chain::coins::ranks(&node.chain, &ids, chain::coins::RANK_WAIT).await;
    for r in routes {
        let entry = r.listing.as_ref().map(|l| l.entry_id.clone()).or_else(|| r.fetched.as_ref().map(|f| f.entry_id.clone()));
        let id = entry.as_deref().and_then(|e| e.parse::<alloy::primitives::FixedBytes<32>>().ok());
        let e = match id {
            Some(id) => chain::entry_by_hash(&node.chain, id).await?.map(|(_, e)| e),
            None => None,
        };
        let h = id.and_then(|id| mine.coins.iter().find(|h| h.entry.parse::<alloy::primitives::FixedBytes<32>>().ok() == Some(id)));
        out.push(RouteChain {
            id: r.id,
            listed: e.is_some(),
            live: e.as_ref().is_some_and(|e| e.live),
            fee: e.map(|e| e.fee).unwrap_or(0.0),
            held: entry.as_ref().is_some_and(|x| held.contains(&x.to_ascii_lowercase())),
            coin: h.map(|h| h.coin.clone()),
            staked: h.map_or(0.0, |h| h.lots.iter().map(|l| l.earning + l.pending).sum()),
            held_coins: h.map_or(0.0, |h| h.held),
            rank: id.and_then(|id| ranks.get(&id)).map_or(0.0, |r| r.score),
        });
    }
    Ok(out)
}

#[derive(Serialize)]
struct AgentSpend {
    index: u32,
    spent: f64,
    cap: f64,
}

async fn agents_spend(node: St<'_>) -> Result<Vec<AgentSpend>, String> {
    let mut out = Vec::new();
    let epoch = chain::current_epoch(&node.chain).await?;
    for a in agents::list() {
        if let Ok((spent, cap)) = chain::agent_spend(&node.chain, node.key()?, a.index, epoch).await {
            out.push(AgentSpend { index: a.index, spent, cap });
        }
    }
    Ok(out)
}

/// Claims every agent's passed lines for this epoch and the last (the claim window is one epoch), and the lines other
/// nodes' agents sent for calls this node served, and those it holds as a watchtower: now, when the owner asks, or once
/// they are worth their gas, as the claim loop does (`chain::ClaimWhen`), then the burn batch if this epoch's is due
/// (`chain::burn_batch`); and for the owner's own payers, the coin buys a fetch parked (`coins::complete_own_buys`),
/// route shares Settlement held (`coins::send_own_held`) and a sample of a held coin's price when one is due
/// (`coins::poke_due`). One claim that fails doesn't hold up the others: each is tried, and the first failure is
/// reported after.
async fn claim_all(node: &Node, when: chain::ClaimWhen) -> Result<u32, String> {
    let epoch = chain::current_epoch(&node.chain).await?;
    // The pass below visits only the windows still open. What closed unclaimed is said, or a node that was away never would.
    if let Err(e) = chain::tell_lapsed(&node.chain, node.key()?, epoch).await {
        eprintln!("claims: {e}");
    }
    let mut n = 0;
    let mut failed = None;
    let mut count = |r: Result<Option<String>, String>| match r {
        Ok(Some(_)) => n += 1,
        Ok(None) => {}
        Err(e) => {
            failed.get_or_insert(e);
        }
    };
    for a in agents::list() {
        for e in [epoch.saturating_sub(1), epoch] {
            count(chain::claim(&node.chain, node.key()?, a.index, e, when).await);
        }
    }
    count(chain::claim_owed(&node.chain, node.key()?, when).await);
    // The lines this node holds as a watchtower for payers whose nodes are away, in the last stretch of their window.
    count(watchtower::claim_watched(node, when).await);
    // The burn batch is no claim, so it isn't counted, but its failure is said like one.
    if let Err(e) = chain::burn_batch(&node.chain, node.key()?, when).await {
        failed.get_or_insert(e);
    }
    // A fetch's buy that couldn't run in its claim is parked for (coin, payer): the owner's own are completed here, as
    // the route shares Settlement held when the fetch's call failed are sent on, and the coins they buy are sampled for
    // the fetch's drift bound (`chain::coins`). None of these is a claim, so none is counted; a failure is said.
    if let Err(e) = chain::coins::send_own_held(&node.chain, node.key()?).await {
        failed.get_or_insert(e);
    }
    if let Err(e) = chain::coins::complete_own_buys(&node.chain, node.key()?).await {
        failed.get_or_insert(e);
    }
    if let Err(e) = chain::coins::poke_due(&node.chain, node.key()?).await {
        failed.get_or_insert(e);
    }
    if n > 0 {
        node.events.emit("activity", ());
    }
    failed.map_or(Ok(n), Err)
}

/// The owner's claim: every line that can be paid goes now, worth its gas or not.
async fn claim_now(node: St<'_>) -> Result<u32, String> {
    claim_all(node, chain::ClaimWhen::Now).await
}

async fn board(node: St<'_>) -> Result<Vec<chain::BoardRow>, String> {
    chain::board(&node.chain).await
}

/// `unbrowse-node agent new <name> [cap_usdc] [days]`: a key for an agent on a machine where no
/// one clicks Wallet, made from the same root key and authorised on the chain the same way. Prints the setup once.
fn agent_new(args: &[String]) -> i32 {
    const USAGE: &str = "usage: unbrowse-node agent new <name> [cap_usdc, 5 by default] [days]";
    let Some(name) = args.first() else {
        eprintln!("{USAGE}");
        return 2;
    };
    // A word that starts like a flag is one (`--help`), never a key's name: no key is made for it.
    if name.starts_with('-') {
        let help = matches!(name.as_str(), "--help" | "-h");
        if help {
            println!("{USAGE}");
        } else {
            eprintln!("{name} is not a name: {USAGE}");
        }
        return if help { 0 } else { 2 };
    }
    let num = |i: usize, d: f64| args.get(i).and_then(|v| v.parse().ok()).unwrap_or(d);
    let (cap, days) = (num(1, agents::AUTO_CAP_USDC), num(2, 30.0) as u64);
    let keys = match root_store() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    match new_agent_key(keys.as_ref(), name, cap, days) {
        Ok((_, setup)) => {
            println!("{setup}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// A new agent key from a shell, authorised on the chain when the node is on the network, with its one-time setup.
fn new_agent_key(keys: &(dyn KeyStore + Send + Sync), name: &str, cap: f64, days: u64) -> Result<(agents::Agent, String), String> {
    new_agent_key_in(keys, root_in_file(), name, cap, days)
}

/// `new_agent_key`, with `key_in_file` saying whether the root key is in a file this user's programs read already: when
/// it isn't, a new key that can spend waits on the owner's yes, as `agent_create` does.
fn new_agent_key_in(keys: &(dyn KeyStore + Send + Sync), key_in_file: bool, name: &str, cap: f64, days: u64) -> Result<(agents::Agent, String), String> {
    let shown = name.chars().take(60).collect::<String>();
    shell_owner_yes(keys, key_in_file, &format!("Something on this computer is asking Unbrowse to make a new agent key, \"{shown}\", that may spend up to {cap} USDC an epoch for {days} days, and to hand back its token. Allow it only if you ran `unbrowse-node` to make it yourself just now."))?;
    let _ = open_identity(keys);
    let (mut agent, setup) = agents::create(keys, name, cap, days, store::api_port())?;
    // A local node writes nothing to the chain (R1.35), as `agent_create` doesn't: joining grants the key
    // (`agents::keep_granted`).
    if link::on_network_now().is_none() {
        eprintln!("this agent uses this node's own and free routes now; once the node is on the network and its wallet holds USDC it pays for other people's routes too, up to its daily limit");
        return Ok((agent, setup));
    }
    let chain = chain::Chain::default();
    let authorised = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?.block_on(async {
        chain.start().await?;
        chain::authorize(&chain, keys, agent.index, cap, agent.expires).await
    });
    match authorised {
        Ok(tx) => {
            agents::set_tx(agent.index, &tx);
            agent.tx = Some(tx);
        }
        // The running node holds the chain's folder and signs for it: it grants the new key itself (`agents::keep_granted`).
        Err(e) if e.contains("another Unbrowse process is running") => eprintln!("the running node grants this key to pay within the hour: this command signs nothing beside it"),
        Err(e) => eprintln!("the key works for free routes; authorising it to pay failed: {e}"),
    }
    Ok((agent, setup))
}

/// `unbrowse-node agent token [index]`: the token of a live agent key, on its own line, for a program on this machine
/// that starts the node and then talks to it as that agent (the SDKs' `start`): agent `index`, else the first key the
/// node made itself (`agents::ensure_first`). Read from the root key, as `unb connect` reads it: the same owner's
/// secret, so this tells nothing the owner's account couldn't already read. Exits 3 while there's no such key yet (a
/// node starting for the first time makes its first one once its key is open).
fn agent_token_cli(args: &[String]) -> i32 {
    let index: Option<u32> = match args.first().map(|a| a.parse()) {
        None => None,
        Some(Ok(i)) => Some(i),
        Some(Err(_)) => {
            eprintln!("usage: unbrowse-node agent token [index]");
            return 2;
        }
    };
    let keys = match root_store() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("couldn't read the node's root key: {e}");
            return 1;
        }
    };
    match hand_out_token(keys.as_ref(), root_in_file(), index) {
        Ok(token) => {
            println!("{token}");
            0
        }
        Err(Handout::NoKey(why)) => {
            eprintln!("{why}");
            3
        }
        Err(Handout::Refused(why)) => {
            eprintln!("{why}");
            1
        }
    }
}

// ---- MCP clients: the window's Connect (`connect.rs`) ----

/// The node's address and the entry its Connect writes: `unb` beside this node, this node's own port.
fn client_entry(node: St<'_>) -> (String, serde_json::Value) {
    let base = format!("http://127.0.0.1:{}", node.info.api_port);
    let entry = connect::entry(std::path::Path::new(&agents::unb_program()), &base);
    (base, entry)
}

/// Where each connect run keeps what it changed, for `agent_connect_undo`.
fn connect_records() -> std::path::PathBuf {
    store::home().join("connect")
}

fn agent_clients(node: St<'_>) -> serde_json::Value {
    let (base, entry) = client_entry(node);
    serde_json::json!({ "clients": connect::clients(&legacy::Machine::here(&base), &entry) })
}

/// The agent `unb mcp --agent first` speaks for, as `hand_out_token` picks it: the key the node made itself, else the
/// first live one.
fn first_live_agent() -> Option<agents::Agent> {
    let now = store::now();
    let live: Vec<agents::Agent> = agents::list().into_iter().filter(|a| !a.revoked && a.expires > now && a.gateway.is_none()).collect();
    live.iter().find(|a| a.auto).or_else(|| live.first()).cloned()
}

/// The first agent's name when connecting a client would hand out its token for the first time, which the owner is asked
/// about (`commands::asks_the_owner`); `None` when its grant is already there or the root key is in a plain file.
fn connect_needs_yes() -> Option<String> {
    if root_in_file() {
        return None;
    }
    match first_live_agent() {
        Some(a) if agents::read_grant(a.index).is_some() && std::fs::read_to_string(agents::first_path()).ok().and_then(|f| f.trim().parse::<u32>().ok()) == Some(a.index) => None,
        Some(a) => Some(a.name),
        None => Some(agents::FIRST.to_string()),
    }
}

/// Connects the named clients: the first agent's grant is written (the owner's yes was asked for before this ran), then
/// `connect::connect` checks the entry answers and writes each client's config.
async fn agent_connect(node: St<'_>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    let chosen = ids.iter().map(|i| connect::Client::from_id(i).ok_or_else(|| format!("{}: not a client Unbrowse connects", i.chars().take(40).collect::<String>()))).collect::<Result<Vec<_>, _>>()?;
    if chosen.is_empty() {
        return Err("name the clients to connect".into());
    }
    let keys = node.key()?;
    let agent = match first_live_agent() {
        Some(a) => a,
        None => agents::ensure_first(keys, node.info.api_port)?.ok_or("this node has no live agent key: add one in Money, Agents, then connect")?,
    };
    let root = unbrowse_core::RootKey::load(keys).map_err(|e| format!("couldn't read the node's root key: {e}"))?;
    agents::write_grant(agent.index, &agents::token_of(&root, &agent), true)?;
    let (base, entry) = client_entry(node);
    let outcomes = tokio::task::spawn_blocking(move || {
        let m = legacy::Machine::here(&base);
        connect::connect(&m, &chosen, &entry, &connect_records(), &connect::stamp(store::now()), connect::find_claude(&m).as_deref(), &mut connect::verify)
    })
    .await
    .map_err(|e| e.to_string())?;
    let done: Vec<&str> = outcomes.iter().filter(|o| o.ok).map(|o| o.name).collect();
    if !done.is_empty() {
        store::log_activity(&store::Activity {
            at: store::now(),
            who: "You".into(),
            site: "This node".into(),
            what: format!("Connected {} as {}", done.join(", "), agent.name),
            kind: "key".into(),
            result: "done".into(),
            ms: None,
            unb: None,
            tx: None,
            note: None,
        });
    }
    Ok(serde_json::json!({ "results": outcomes }))
}

async fn agent_connect_undo() -> Result<serde_json::Value, String> {
    let restored = tokio::task::spawn_blocking(|| connect::undo(&connect_records())).await.map_err(|e| e.to_string())??;
    Ok(serde_json::json!({ "restored": restored.into_iter().map(|(c, p)| serde_json::json!({ "id": c.id(), "name": c.name(), "path": p.display().to_string() })).collect::<Vec<_>>() }))
}

/// Why an agent's token wasn't handed out.
#[derive(Debug)]
enum Handout {
    /// No live key by that number (or none yet): exit 3, which `unb connect` waits on while a node makes its first.
    NoKey(String),
    /// The owner said no, or the root key couldn't be read.
    Refused(String),
}

/// Agent `index`'s token (else the node's first key's), for a client of the owner's: the one way it leaves the node's
/// keystore outside the node. While the root key is in the OS keystore, which other programs of this user can't read,
/// the owner is asked the first time, in the node's dialog, naming the agent; the yes is kept as that agent's grant
/// (`agents::write_grant`, owner-only), which `unb mcp --agent <n>` reads and this returns from then on without asking,
/// until the key is revoked. Any other agent, the node's first key included, is asked about apart, so a process that
/// holds one agent's grant gets no other agent's token without the owner. A root key kept in a plain file is this
/// user's to read already: nothing is asked then, as for every command that uses it (`shell_owner_yes`).
fn hand_out_token(keys: &dyn unbrowse_core::KeyStore, key_in_file: bool, index: Option<u32>) -> Result<String, Handout> {
    let now = store::now();
    // A remote key is handed out by `remote`, never here: it opens the node only through its gateway.
    let live: Vec<agents::Agent> = agents::list().into_iter().filter(|a| !a.revoked && a.expires > now && a.gateway.is_none()).collect();
    let Some(agent) = (match index {
        Some(i) => live.iter().find(|a| a.index == i),
        None => live.iter().find(|a| a.auto).or_else(|| live.first()),
    }) else {
        return Err(Handout::NoKey(match index {
            Some(i) => format!("no live agent key {i}: add an agent in the Unbrowse app (Money, Agents) or with `unbrowse agent new <name>`"),
            None => "no live agent key yet: the node makes its first one once it has started".into(),
        }));
    };
    if let Some(token) = agents::read_grant(agent.index) {
        return Ok(token);
    }
    let question = format!(
        "Something on this computer is asking for the key of the agent \"{}\" (number {}), to act as that agent on this node and spend within its limit. Allow it only if you are setting that agent up just now (`unbrowse connect`, `unbrowse grant`, or its setup line).",
        agent.name, agent.index
    );
    shell_owner_yes(keys, key_in_file, &question).map_err(Handout::Refused)?;
    let root = unbrowse_core::RootKey::load(keys).map_err(|e| Handout::Refused(format!("couldn't read the node's root key: {e}")))?;
    let token = agents::token_of(&root, agent);
    agents::write_grant(agent.index, &token, index.is_none() || agent.auto).map_err(|e| Handout::Refused(format!("couldn't keep the grant: {e}")))?;
    Ok(token)
}

/// `unbrowse-node browser …`: the browser add-on, from a shell. The node needs it only to learn a page or to browse
/// one by hand; everything else runs without it.
///
///   unbrowse-node browser [status] [--json]          whether the node has its browser, and which parts it lacks
///   unbrowse-node browser install [--from <path>]    the browser program for this machine (from its release, or the
///                                                    program or package at <path>) and, when there's no Chromium,
///                                                    Chrome for Testing
///   unbrowse-node browser remove [--chromium]        the browser program the node installed (and the Chrome for
///                                                    Testing it downloaded)
///   unbrowse-node browser fetch [on|off]             whether the node fetches the browser itself when something needs it
///   unbrowse-node browser headless [on|off]          whether the node's browser stays headless whatever a site does
fn browser_cli(args: &[String]) -> i32 {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let said = |r: Result<Vec<String>, String>| match r {
        Ok(lines) => {
            lines.iter().for_each(|l| println!("{l}"));
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    };
    match words.as_slice() {
        [] | ["status"] | ["status", "--json"] | ["--json"] => {
            let v = browsers::view();
            if words.contains(&"--json") {
                println!("{}", serde_json::json!({ "state": v.state, "program": v.program, "chromium": v.using, "fetch": v.fetch, "missing": browsers::lacking(browsers::Need::Hands) }));
                return 0;
            }
            println!("browser: {}", v.state);
            println!("  program: {}", v.program.as_deref().unwrap_or("none"));
            println!("  chromium: {}", v.using.as_deref().unwrap_or("none"));
            println!("  fetches it when needed: {}", if v.fetch { "yes" } else { "no (unbrowse browser fetch on)" });
            if v.state == "missing" {
                println!("The node runs without it: search, call and the owner's commands work. Learning a page needs a Chromium, and browsing one by hand needs both: `{}` gets them.", browsers::INSTALL);
            }
            0
        }
        ["install"] => said(browsers::install(None)),
        ["install", "--from", from] => said(browsers::install(Some(std::path::Path::new(from)))),
        ["remove"] => said(browsers::remove(false)),
        ["remove", "--chromium"] => said(browsers::remove(true)),
        ["fetch"] => {
            println!("{}", if browsers::fetch_allowed() { "on: the node fetches its browser the first time something needs it" } else { "off: a goal that needs the browser answers browser_missing until it's installed" });
            0
        }
        ["fetch", on @ ("on" | "off")] => {
            let _held = store::settings_held();
            let mut s = store::load_settings();
            s.fetch_browser = *on == "on";
            match store::save_settings(&s) {
                Ok(()) => {
                    println!("{}", if s.fetch_browser { "on: the node fetches its browser the first time something needs it" } else { "off: the node never fetches its browser by itself" });
                    0
                }
                Err(e) => {
                    eprintln!("saving the setting: {e}");
                    1
                }
            }
        }
        ["headless"] => {
            println!("{}", if browsers::headless_only() { HEADLESS_ON } else { HEADLESS_OFF });
            0
        }
        ["headless", on @ ("on" | "off")] => {
            let _held = store::settings_held();
            let mut s = store::load_settings();
            s.headless_only = *on == "on";
            match store::save_settings(&s) {
                Ok(()) => {
                    println!("{}", if s.headless_only { HEADLESS_ON } else { HEADLESS_OFF });
                    0
                }
                Err(e) => {
                    eprintln!("saving the setting: {e}");
                    1
                }
            }
        }
        _ => {
            eprintln!("usage: unbrowse-node browser [status [--json] | install [--from <path>] | remove [--chromium] | fetch [on|off] | headless [on|off]]");
            2
        }
    }
}

/// `unbrowse-node money`: the balance in dollars, what agents can spend, what starts the node, each agent's daily
/// limit, earnings, and where to add funds (`money`).
fn money_cli() -> i32 {
    match owner_call("money", serde_json::json!({})) {
        Ok(v) => {
            let s = |k: &serde_json::Value| k.as_str().unwrap_or("0.00").to_string();
            match v["payments"].as_str() {
                Some("not_open") => println!("Payments aren't open on this network yet."),
                Some("offline") => println!("Payments offline: the node can't reach the network now; it tries again by itself."),
                Some("starting") => println!("Starting: the node is still connecting to the network."),
                _ => {
                    let test = if v["payments"] == "test" { " (test mode)" } else { "" };
                    println!("Balance: ${}{test}", s(&v["balance"]));
                    println!("Available to spend: ${}", s(&v["available_to_spend"]));
                    if s(&v["needed_to_start"]) != "0.00" {
                        println!("Add ${} to start.", s(&v["needed_to_start"]));
                    }
                }
            }
            for a in v["agents"].as_array().into_iter().flatten() {
                println!("  {}: ${} of a ${} daily limit spent today", a["name"].as_str().unwrap_or_default(), s(&a["spent_today"]), s(&a["daily_limit"]));
            }
            let e = &v["earnings"];
            println!("Earnings: ${} ready to take (`unbrowse-node coin` lists your route coins and what their stake earned)", s(&e["available"]));
            if let Some(url) = v["add_funds_url"].as_str() {
                println!("Add funds: {url}");
            }
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `unbrowse-node earnings`: what the wallet earned, by where it came from (`earnings::of`): its coin stakes, the fetch's
/// fallback as a contributor, and the route share its entries sent to their coins; each claimed and still to take.
fn earnings_cli() -> i32 {
    match owner_call("earnings", serde_json::json!({})) {
        Ok(v) => {
            let row = |name: &str, l: &serde_json::Value| {
                let n = |k: &str| l[k].as_f64().unwrap_or(0.0);
                println!("{name:<18} earned {:>10.6}  taken {:>10.6}  to take {:>10.6}", n("earned"), n("claimed"), n("to_claim"));
            };
            row("from staking", &v["staking"]);
            row("as contributor", &v["contributor"]);
            let n = |k: &str| v[k].as_f64().unwrap_or(0.0);
            println!("your entries' lines sent {} USDC to their coins, which pays whoever stakes them", money::usdc(n("routes_paid")));
            println!("in all: ${} to take to your account (collect_earnings, or the Money screen's Cash out)", money::usdc(n("to_claim")));
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `unbrowse-node nodes [grant]`: one wallet owning several nodes (spec §76.1 item 1.7).
/// - `nodes`: the owner's wallet, its deposit, and every key it granted, this node's marked;
/// - `nodes grant`: the calls the owner's wallet sends so this node's agents pay from its deposit, each as a `cast send`
///   line for a wallet of one's own. The node can't send them: a grant is the wallet's own.
fn nodes_cli(args: &[String]) -> i32 {
    let done = (|| -> Result<(), String> {
        match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
            [] => {
                let n = owner_call("owner_nodes", serde_json::json!({}))?;
                println!("your wallet {}: {} USDC in its deposit", n["wallet"].as_str().unwrap_or_default(), n["deposit_usdc"]);
                if let Some(by) = n["renew_by"].as_u64() {
                    println!("its grant to this node's agents runs out at {by} (unix time): `unbrowse-node nodes renew` renews it in one step");
                }
                let keys = n["keys"].as_array().cloned().unwrap_or_default();
                if keys.is_empty() {
                    println!("it has granted no node's key yet: `unbrowse-node nodes grant` says what to send");
                }
                println!("a key the wallet grants only pays, up to its cap: each node signs its listings with its own wallet's key");
                for k in keys {
                    let whose = if k["this_node"] == true { format!("this node, {}", k["name"].as_str().unwrap_or_default()) } else { "another node".into() };
                    let state = if k["revoked"] == true { "revoked".to_string() } else { format!("{} of {} USDC this epoch", k["spent_usdc"], k["cap_usdc"]) };
                    println!("  {} ({whose}): {state}", k["agent"].as_str().unwrap_or_default());
                }
            }
            ["grant"] => {
                let g = owner_call("wallet_grant", serde_json::json!({}))?;
                let calls = g["calls"].as_array().cloned().unwrap_or_default();
                if calls.is_empty() {
                    println!("your wallet {} grants every key on this node; they pay from its deposit ({} USDC)", g["wallet"].as_str().unwrap_or_default(), g["deposit_usdc"]);
                    return Ok(());
                }
                println!("send these from your wallet {} (the node can't: a grant is the wallet's own):", g["wallet"].as_str().unwrap_or_default());
                for c in calls {
                    println!("\n# {}\ncast send {} {} --rpc-url {}", c["what"].as_str().unwrap_or_default(), c["to"].as_str().unwrap_or_default(), c["data"].as_str().unwrap_or_default(), chain::url());
                }
                println!("\nthen fund the wallet's deposit (Settlement's deposit, from the wallet). The node takes the grants at its next pass, within the hour, or at once when you run `unbrowse-node nodes`; a key already paying this epoch moves at the next.");
            }
            ["renew"] => {
                let r = owner_call("wallet_renew", serde_json::json!({}))?;
                match r["url"].as_str() {
                    None => println!("your wallet's grants to this node's keys are current: nothing to renew"),
                    Some(url) => {
                        println!("renew in one step at {url}{}", if r["opened"] == true { " (opened in your browser)" } else { "" });
                        println!("or, from a wallet of your own:");
                        for c in r["calls"].as_array().cloned().unwrap_or_default() {
                            println!("cast send {} {} --rpc-url {}", c["to"].as_str().unwrap_or_default(), c["data"].as_str().unwrap_or_default(), chain::url());
                        }
                    }
                }
            }
            _ => return Err("usage: unbrowse-node nodes [grant | renew]".into()),
        }
        Ok(())
    })();
    match done {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `unbrowse-node agent cap <index> <usdc>`: under Advanced, what an agent key may spend an epoch (the node's own key
/// starts at 5 USDC, `agent.key_cap`). The running node keeps it at every renewal and grants it on the chain.
/// `agent bearer [on | off]`: whether the node takes an agent's or the owner's token sent as a plain bearer token, from
/// a client that doesn't sign its requests (`api/signed.rs`). On is asked about first (`shell_write`): a bearer token goes
/// to whatever answers at the node's address, and one that took or relays it keeps the token.
fn agent_bearer_cli(args: &[String]) -> i32 {
    let _held = store::settings_held();
    let mut s = store::load_settings();
    match args.first().map(String::as_str) {
        None => {}
        Some("on") => s.accept_bearer = true,
        Some("off") => s.accept_bearer = false,
        Some(_) => {
            eprintln!("usage: unbrowse-node agent bearer [on | off]");
            return 2;
        }
    }
    if !args.is_empty() {
        if let Err(e) = store::save_settings(&s) {
            eprintln!("{e}");
            return 1;
        }
    }
    if s.accept_bearer {
        println!("on: the node takes a token sent as a plain bearer token, from a client of a release before signed requests (an MCP client set up with an Authorization header). Whatever answers at the node's address while it is away gets such a token. `agent bearer off` once every client signs (`unbrowse connect` sets Claude Code up again).");
    } else {
        println!("off: the node takes signed requests only; a token is never sent. Clients of this release sign (the SDKs, `unb`, `unb mcp`, the window).");
    }
    0
}

fn agent_cap_cli(args: &[String]) -> i32 {
    let parsed = match args {
        [i, cap] => i.parse::<u32>().ok().zip(cap.parse::<f64>().ok()),
        _ => None,
    };
    let Some((index, cap)) = parsed else {
        eprintln!("usage: unbrowse-node agent cap <index> <dollars a day>   (agent indexes: the window's Access, or the SDK's agents())");
        return 2;
    };
    match owner_call("agent_set_cap", serde_json::json!({ "index": index, "cap_usdc": cap })) {
        Ok(a) => {
            println!("{}: a daily limit of ${}, kept at every renewal", a["name"].as_str().unwrap_or_default(), money::usdc(a["cap_usdc"].as_f64().unwrap_or(0.0)));
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// Whether the node joins the peer network: the current terms acknowledged, and the owner not keeping it off. What
/// joins, announces, lists, grants or reports goes by it; the chain pass (`claim_loop`) never does, by the owner's
/// rule (`chain_pass_runs`): off the network the node still claims, stakes and tops up.
pub fn network_on() -> bool {
    terms::standing(&store::load_settings()) == terms::Standing::Joins
}

/// `unbrowse-node update [channel [stable|canary|auto]]`: checks for a newer release now and, when there is one for the
/// node's channel, the running node restarts into it once no call is under way. With no node running, the release is
/// fetched and checked here, and the node runs it when it next starts. `channel` says or sets the channel the node
/// updates on; `auto` lets a hash of its identity place it (`update::choose`).
fn update_cli(args: &[String]) -> i32 {
    match args {
        [] => {}
        [c] if c == "channel" => {
            match store::load_settings().update_channel {
                Some(c) => println!("{c}: the owner picked it"),
                None => println!("auto: the node's identity places it on stable or, for a share of releases, canary"),
            }
            return 0;
        }
        [c, which] if c == "channel" && (which == "auto" || update::Channel::parse(which).is_some()) => {
            let _held = store::settings_held();
            let mut s = store::load_settings();
            s.update_channel = update::Channel::parse(which).map(|c| c.name().to_string());
            return match store::save_settings(&s) {
                Ok(()) => {
                    println!("{which}: the node's next check updates on it (`unbrowse update` checks now)");
                    0
                }
                Err(e) => {
                    eprintln!("saving the setting: {e}");
                    1
                }
            };
        }
        _ => {
            eprintln!("usage: unbrowse-node update [channel [stable|canary|auto]]");
            return 2;
        }
    }
    let said = |s: &update::Status| {
        if let Some(why) = &s.halted {
            println!("the rollout is halted ({why}): the node stays at {}", s.running);
        } else if let Some(v) = &s.ready {
            println!("{v} is ready: the node restarts into it once no call is under way");
        } else {
            println!("up to date: {} on {}", s.running, s.channel.as_deref().unwrap_or("stable"));
        }
    };
    match owner_ask("update_now", serde_json::json!({}), std::time::Duration::from_secs(600)) {
        Ok(v) => match serde_json::from_value::<serde_json::Value>(v) {
            Ok(v) => {
                let s = update::Status {
                    running: v["running"].as_str().unwrap_or_default().into(),
                    ready: v["ready"].as_str().map(String::from),
                    channel: v["channel"].as_str().map(String::from),
                    halted: v["halted"].as_str().map(String::from),
                    ..Default::default()
                };
                said(&s);
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        // No node to ask: check here, and the node runs what this fetched when it starts. A node that refused, or is
        // still checking past the wait, is running, and a second check beside it would fetch the release twice.
        Err(Unanswered::NoNode(_)) => {
            if !update::released() {
                eprintln!("this node was built from source, so it doesn't update itself");
                return 1;
            }
            match update::check_now(None) {
                Ok(_) => {
                    said(&update::status());
                    if update::status().ready.is_some() {
                        println!("the node isn't running: it runs the new release when it starts (`unbrowse start`)");
                    }
                    0
                }
                Err(e) => {
                    eprintln!("update: {e}");
                    1
                }
            }
        }
        Err(Unanswered::Node(e)) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `unbrowse-node restart`: the running node restarts once no call is under way, into the newest release unpacked
/// here, else the same one, so a setting read at start (the chain, the peer network) takes effect.
fn restart_cli(args: &[String]) -> i32 {
    if !args.is_empty() {
        eprintln!("usage: unbrowse-node restart");
        return 2;
    }
    match owner_ask("restart", serde_json::json!({}), std::time::Duration::from_secs(60)) {
        Ok(v) => {
            println!("restarting into {} once no call is under way", v["into"].as_str().unwrap_or(update::RUNNING));
            0
        }
        Err(Unanswered::NoNode(_)) => {
            eprintln!("the node isn't running: `unbrowse start` starts it");
            1
        }
        Err(Unanswered::Node(e)) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `unbrowse-node passphrase`: sets the owner passphrase, or changes it, typed on this terminal. A node with no screen
/// to show a dialog on takes it, typed on a terminal (`unbrowse-node confirm`), as the owner's yes for a command that
/// hands out a secret (`owner_dialog`). Changing it takes the one set now. The node keeps only its slow hash, sealed
/// with the root key, so this reads the key from its store (and makes it on a node that has never started).
fn passphrase_cli(args: &[String]) -> i32 {
    if !args.is_empty() {
        eprintln!("usage: unbrowse-node passphrase   set or change the owner passphrase, typed on this terminal");
        return 2;
    }
    match root_store().and_then(|keys| set_passphrase(keys.as_ref())) {
        Ok(said) => {
            println!("{said}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// The owner passphrase set or changed on this process's terminal, sealed with the key in `keys`.
fn set_passphrase(keys: &dyn KeyStore) -> Result<String, String> {
    if root_in_file() {
        open_identity(keys)?;
    }
    let root = unbrowse_core::RootKey::load(keys).map_err(|e| e.to_string())?;
    let had = owner_dialog::passphrase(keys);
    match &had {
        // Changing it takes the one set now, typed on this terminal.
        Ok(Some(record)) => {
            let now = tty::read_secret("The owner passphrase set now: ")?;
            if !owner_dialog::check(record, &now)? {
                return Err("that isn't the owner passphrase set now: nothing was changed".into());
            }
        }
        // Setting the first one (or one in place of a record the node refuses) is the owner's to do as well: a program
        // running as this user that set one would answer every question the node asks on a terminal. It takes the
        // owner's yes in the dialog, or with no screen a code shown on this terminal and typed back.
        _ => owner_dialog::ask_present(
            "Something on this computer is asking to set the owner passphrase of this Unbrowse node, which answers for you whenever the node can't show a dialog. Allow it only if you ran `unbrowse-node passphrase` yourself just now.",
        )
        .map_err(|e| format!("{e}: no passphrase was set"))?,
    }
    let min = unbrowse_core::owner_pass::MIN_CHARS;
    let new = tty::read_secret(&format!("A new owner passphrase ({min} characters or more; keep it in your head, never in a file an agent reads): "))?;
    let again = tty::read_secret("The same again: ")?;
    if *new != *again {
        return Err("the two didn't match: nothing was changed".into());
    }
    let record = unbrowse_core::owner_pass::Record::new(&root, &new).map_err(|e| e.to_string())?;
    owner_dialog::keep_passphrase(&record)?;
    Ok(match had {
        Ok(Some(_)) => "changed the owner passphrase".into(),
        _ => "set the owner passphrase: on a node with no screen, answer its questions with `unbrowse-node confirm` on this machine's terminal".into(),
    })
}

/// `unbrowse-node confirm [--wait <seconds>]`: answers, on this terminal, the questions a node with no screen waits on
/// the owner's yes for: each is shown, and the owner passphrase typed here allows it; Enter alone refuses it. With
/// nothing waiting, it waits for a question (two minutes, or `--wait`).
fn confirm_cli(args: &[String]) -> i32 {
    let wait = match args {
        [] => owner_dialog::WAIT_SECS,
        [flag, secs] if flag == "--wait" => match secs.parse::<u64>() {
            Ok(s) => s,
            Err(_) => {
                eprintln!("usage: unbrowse-node confirm [--wait <seconds>]");
                return 2;
            }
        },
        _ => {
            eprintln!("usage: unbrowse-node confirm [--wait <seconds>]");
            return 2;
        }
    };
    match confirm_on_terminal(wait, &|cmd, body| owner_call_within(cmd, body, std::time::Duration::from_secs(owner_dialog::WAIT_SECS + 30))) {
        Ok(said) => {
            println!("{said}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// The questions waiting on the node, answered on this terminal, through `call` (the node's owner door).
fn confirm_on_terminal(wait_secs: u64, call: &dyn Fn(&str, serde_json::Value) -> Result<serde_json::Value, String>) -> Result<String, String> {
    tty::say("")?;
    let started = std::time::Instant::now();
    let waiting: Vec<owner_dialog::Confirmation> = loop {
        let v = call("confirmations", serde_json::json!({}))?;
        let list: Vec<owner_dialog::Confirmation> = serde_json::from_value(v).map_err(|e| e.to_string())?;
        if !list.is_empty() {
            break list;
        }
        if started.elapsed().as_secs() >= wait_secs {
            return Ok("nothing is waiting on the owner's yes".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    };
    let mut said = Vec::new();
    for q in waiting {
        tty::say(&format!("\n{}\n({} seconds left)\n", q.question, q.seconds_left))?;
        loop {
            let typed = tty::read_secret("Type the owner passphrase to allow it, or press Enter to refuse: ")?;
            let passphrase = if typed.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(typed.to_string()) };
            match call("confirm", serde_json::json!({ "id": q.id, "passphrase": passphrase })) {
                Ok(v) => {
                    said.push(v.as_str().unwrap_or("answered").to_string());
                    break;
                }
                Err(e) if e.contains("more tries") => tty::say(&format!("{e}\n"))?,
                Err(e) => {
                    said.push(e);
                    break;
                }
            }
        }
    }
    Ok(said.join("\n"))
}

const AGENT_USER_USAGE: &str = "usage: unbrowse-node agent-user install [--agent <index>] [--revoke-found] [--yes]   make the agents' OS user, unbrowse-agent, with a key of its own
       unbrowse-node agent-user run -- <program> [args…]                            run an agent (claude, codex, a script) as that user
       unbrowse-node agent-user status                                             check, as that user, that none of the owner's secrets can be read
       unbrowse-node agent-user remove [--yes]                                     remove the user and its home";

const LEARN_WALK_USAGE: &str = "usage: UNBROWSE_LAB=1 unbrowse-node learn-walk <capture.jsonl> <url> <goal>";

/// The lab's own words, for measuring the engine, not for owners: run only with `UNBROWSE_LAB=1`, and left out of
/// `NODE_COMMAND_WORDS`, `--help` and the SDKs' command tables. Without it the word is a command the node doesn't have.
/// `None` when the words aren't a lab command (or the lab is off); `Some(code)` when one ran.
fn lab_cli(args: &[String]) -> Option<i32> {
    if !std::env::var("UNBROWSE_LAB").is_ok_and(|v| v.trim() == "1") {
        return None;
    }
    match args.get(1).map(String::as_str) {
        Some("learn-walk") => Some(learn_walk_cli(&args[2..])),
        _ => None,
    }
}

/// `UNBROWSE_LAB=1 unbrowse-node learn-walk <capture.jsonl> <url> <goal>`: learn the goal's route from a walk kept on
/// disk, with no browser and no site asked (`learn::learn_kept_walk`), and keep it in this home's routes. Prints the
/// route's id. A fresh home learns it with an empty jar, so whatever answers the route afterwards answers from the
/// route alone. The bank loop's measure (UNB-246, UNB-256); not an owner's command.
fn learn_walk_cli(args: &[String]) -> i32 {
    let [capture, url, goal] = args else {
        eprintln!("{LEARN_WALK_USAGE}");
        return 2;
    };
    match learn::learn_kept_walk(std::path::Path::new(capture), url, goal) {
        Ok(route) => {
            println!("{}", route.id);
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `unbrowse-node agent-user …`: agents as an OS user of their own (`agent_user`).
fn agent_user_cli(args: &[String]) -> i32 {
    let flag = |f: &str| args.iter().any(|a| a == f);
    let done = match args.first().map(String::as_str) {
        Some("install") => {
            let index = match args.iter().position(|a| a == "--agent").map(|i| args.get(i + 1).and_then(|v| v.parse::<u32>().ok())) {
                None => Ok(None),
                Some(Some(i)) => Ok(Some(i)),
                Some(None) => Err(AGENT_USER_USAGE.to_string()),
            };
            index.and_then(|i| agent_user_install(i, flag("--revoke-found"), flag("--yes")))
        }
        Some("run") => {
            let program: Vec<String> = args.iter().skip(1).skip_while(|a| *a == "--").cloned().collect();
            if program.is_empty() {
                Err(AGENT_USER_USAGE.to_string())
            } else {
                return agent_user_run(&program);
            }
        }
        Some("status") => agent_user_status(),
        Some("remove") => agent_user_remove(flag("--yes")),
        _ => {
            eprintln!("{AGENT_USER_USAGE}");
            return 2;
        }
    };
    match done {
        Ok(said) => {
            println!("{said}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// The owner's OS user name, as the system has it.
fn owner_user_name() -> Result<String, String> {
    if cfg!(windows) {
        return std::env::var("USERNAME").map_err(|_| "USERNAME isn't set".to_string());
    }
    let out = std::process::Command::new("id").arg("-un").output().map_err(|e| format!("id -un: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Whether the agents' OS user is there already.
fn agent_user_exists() -> bool {
    let mut c = if cfg!(windows) {
        let mut c = std::process::Command::new("net");
        c.args(["user", agent_user::NAME]);
        c
    } else {
        let mut c = std::process::Command::new("id");
        c.args(["-u", agent_user::NAME]);
        c
    };
    c.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
}

/// Runs `steps` in order, each one's stdin fed from its own `stdin`, stopping at the first that fails.
fn run_steps(steps: &[agent_user::Step]) -> Result<(), String> {
    use std::io::Write;
    for s in steps {
        eprintln!("- {}", s.what);
        let mut c = std::process::Command::new(&s.argv[0]);
        c.args(&s.argv[1..]).stdin(if s.stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::inherit() });
        let mut child = c.spawn().map_err(|e| format!("{}: {e}", s.argv[0]))?;
        if let (Some(text), Some(mut pipe)) = (&s.stdin, child.stdin.take()) {
            pipe.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("couldn't {} ({}: {status}): nothing after it was done", s.what, s.argv.join(" ")));
        }
    }
    Ok(())
}

/// Shows `steps` and asks the owner to go ahead, on the terminal, unless `yes`.
fn go_ahead(steps: &[agent_user::Step], yes: bool) -> Result<(), String> {
    let plan: String = steps.iter().map(|s| format!("  - {}\n", s.what)).collect();
    if yes {
        eprint!("{plan}");
        return Ok(());
    }
    let typed = tty::read_line(&format!("This will:\n{plan}Go ahead? [y/N] "))?;
    if matches!(typed.trim(), "y" | "Y" | "yes") { Ok(()) } else { Err("nothing was done".into()) }
}

/// The keystore item that keeps the agent user's Windows password, for `run`: in the owner's Credential Manager, which
/// the agent user can't read.
fn agent_user_password() -> Result<KeychainStore, String> {
    KeychainStore::new("unbrowse-agent-user", agent_user::NAME).map_err(|e| e.to_string())
}

fn agent_user_install(index: Option<u32>, revoke_found: bool, yes: bool) -> Result<String, String> {
    let os = agent_user::this_os();
    let owner = owner_user_name()?;
    let data = store::home();
    // An older node, or a copy, may have left the node's folder open to other users.
    let tightened = agent_user::keep_folder_private(&data)?;
    let keys = root_store()?;
    // A node that has never started makes its key here, as `agent new` does.
    open_identity(keys.as_ref())?;
    let root = unbrowse_core::RootKey::load(keys.as_ref()).map_err(|e| format!("the node's key: {e}"))?;
    let now = store::now();
    let live: Vec<agents::Agent> = agents::list().into_iter().filter(|a| !a.revoked && a.expires > now).collect();
    // Agents set up as the owner's user hold their tokens in the owner's files, where any program of that user reads them.
    let found: Vec<(std::path::PathBuf, agents::Agent)> = {
        let tokens: Vec<String> = live.iter().map(|a| agents::token_of(&root, a)).collect();
        agent_user::token_copies(&unbrowse_files::private::user_home(), &data, &tokens, 3)
            .into_iter()
            .filter_map(|p| {
                let text = std::fs::read_to_string(&p).ok()?;
                let a = live.iter().zip(&tokens).find(|(_, t)| text.contains(t.as_str()))?.0.clone();
                Some((p, a))
            })
            .collect()
    };
    let agent = match index {
        Some(i) => {
            let a = live.iter().find(|a| a.index == i).cloned().ok_or(format!("no live agent key {i}"))?;
            if found.iter().any(|(_, f)| f.index == i) {
                return Err(format!("agent key {i}'s token is in the owner's files already, where the owner's programs read it: give the agent user a new key (leave out --agent)"));
            }
            a
        }
        None => {
            let exposed: Vec<u32> = found.iter().map(|(_, a)| a.index).collect();
            match agent_user::own_key(live.iter().map(|a| (a.index, a.name.as_str())), &exposed).and_then(|i| live.iter().find(|a| a.index == i)) {
                Some(a) => a.clone(),
                None => new_agent_key(keys.as_ref(), &agent_user::key_name(), agents::AUTO_CAP_USDC, 365)?.0,
            }
        }
    };
    let env = agent_user::env_file(store::api_port(), &agents::token_of(&root, &agent));
    let there = agent_user_exists();
    let mac_id = if os == agent_user::Os::Mac {
        let list = |what: &[&str]| std::process::Command::new("dscl").args(what).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        let existing = there.then(|| std::process::Command::new("id").args(["-u", agent_user::NAME]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default());
        agent_user::mac_id(existing.as_deref(), &list(&[".", "-list", "/Users", "UniqueID"]), &list(&[".", "-list", "/Groups", "PrimaryGroupID"]))
    } else {
        None
    };
    let mut steps: Vec<agent_user::Step> = agent_user::install_steps(os, &owner, &env, mac_id)?.into_iter().filter(|s| !(there && s.make)).collect();
    if os == agent_user::Os::Windows && !there {
        let mut raw = [0u8; 24];
        getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
        let password = format!("Ub-{}", hex::encode(raw));
        agent_user_password()?.set(password.as_bytes()).map_err(|e| e.to_string())?;
        if let Some(s) = steps.first_mut() {
            s.stdin = Some(format!("{password}\n"));
        }
    }
    go_ahead(&steps, yes)?;
    run_steps(&steps)?;
    let mut said = vec![format!(
        "{} the OS user {} with agent key {} ({}). Run an agent as it: `unbrowse-node agent-user run -- <program>`. Check it: `unbrowse-node agent-user status`.",
        if there { "Refreshed" } else { "Made" },
        agent_user::NAME,
        agent.index,
        agent.name
    )];
    if !tightened.is_empty() {
        said.push(format!("Made {} paths in {} readable by you alone.", tightened.len(), data.display()));
    }
    if !found.is_empty() {
        said.push("These files of yours hold an agent key's token, which any program running as you can read. Remove the token from them, and set that agent up as the agent user instead:".into());
        for (p, a) in &found {
            said.push(format!("  {} (agent key {}, {})", p.display(), a.index, a.name));
        }
        if revoke_found {
            let mut indexes: Vec<u32> = found.iter().map(|(_, a)| a.index).collect();
            indexes.sort();
            indexes.dedup();
            for i in indexes {
                agents::revoke(i)?;
                said.push(format!("Revoked agent key {i}: its token no longer works."));
            }
        } else {
            said.push("`--revoke-found` revokes those keys once their agents run as the agent user.".into());
        }
    }
    Ok(said.join("\n"))
}

fn agent_user_run(program: &[String]) -> i32 {
    let status = if cfg!(windows) {
        let password = match agent_user_password().and_then(|k| k.get().map_err(|e| e.to_string())?.ok_or_else(|| "no password kept for the agent user: run `unbrowse-node agent-user install` first".to_string())) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("{e}");
                return 1;
            }
        };
        let child = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &agent_user::run_windows_script(program)])
            .stdin(std::process::Stdio::piped())
            .spawn();
        child.and_then(|mut c| {
            use std::io::Write;
            if let Some(mut pipe) = c.stdin.take() {
                pipe.write_all(&password)?;
                pipe.write_all(b"\n")?;
            }
            c.wait()
        })
    } else {
        let argv = agent_user::run_argv(program);
        std::process::Command::new(&argv[0]).args(&argv[1..]).status()
    };
    match status {
        Ok(s) => s.code().unwrap_or(1),
        Err(e) => {
            eprintln!("couldn't run it as {}: {e}", agent_user::NAME);
            1
        }
    }
}

fn agent_user_status() -> Result<String, String> {
    if !agent_user_exists() {
        return Err(format!("there is no OS user {}: `unbrowse-node agent-user install` makes it", agent_user::NAME));
    }
    let data = store::home();
    let paths = agent_user::owner_secrets(&data);
    let readable: Vec<String> = if cfg!(windows) {
        let list = paths.iter().map(|p| format!("'{}'", p.to_string_lossy().replace('\'', "''"))).collect::<Vec<_>>().join(",");
        let probe = format!("foreach ($f in @({list})) {{ try {{ if (Test-Path -PathType Container $f) {{ Get-ChildItem $f -ErrorAction Stop | Out-Null }} else {{ Get-Content $f -TotalCount 1 -ErrorAction Stop | Out-Null }}; Write-Output $f }} catch {{}} }}; Write-Output '{}'", agent_user::PROBED);
        // Written in the agent's own folder, which the owner reads too: the owner's temp folder is closed to it.
        let out = agent_user::home(agent_user::Os::Windows).join("probe.txt");
        let _ = std::fs::remove_file(&out);
        let code = agent_user_run(&["powershell".into(), "-NoProfile".into(), "-Command".into(), format!("& {{ {probe} }} | Out-File -Encoding utf8 '{}'", out.to_string_lossy())]);
        if code != 0 {
            return Err(format!("couldn't run the check as {} (exit {code})", agent_user::NAME));
        }
        let text: String = std::fs::read_to_string(&out).unwrap_or_default().lines().map(|l| format!("{}\n", l.trim_start_matches('\u{feff}').trim())).filter(|l| l.trim() != "").collect();
        agent_user::probed(&text).ok_or_else(|| format!("the check as {} didn't run to the end", agent_user::NAME))?
    } else {
        let argv = agent_user::probe_argv(&paths);
        let out = std::process::Command::new(&argv[0]).args(&argv[1..]).output().map_err(|e| e.to_string())?;
        match agent_user::probed(&String::from_utf8_lossy(&out.stdout)) {
            Some(read) if out.status.success() => read,
            _ => return Err(format!("couldn't run the check as {}: {} (is the sudoers rule there? `agent-user install` writes it)", agent_user::NAME, String::from_utf8_lossy(&out.stderr).trim())),
        }
    };
    if !readable.is_empty() {
        return Err(format!("{} can read these of the owner's:\n  {}\n`unbrowse-node agent-user install` makes them the owner's alone again", agent_user::NAME, readable.join("\n  ")));
    }
    Ok(format!("{} is there, and can read none of the {} paths in {} (the owner's token, keys and secrets)", agent_user::NAME, paths.len(), data.display()))
}

fn agent_user_remove(yes: bool) -> Result<String, String> {
    let steps = agent_user::remove_steps(agent_user::this_os());
    go_ahead(&steps, yes)?;
    run_steps(&steps)?;
    if cfg!(windows) {
        let _ = agent_user_password().and_then(|k| k.delete().map_err(|e| e.to_string()));
    }
    Ok(format!("Removed the OS user {}. Its agent key still works until you revoke it (the window's Money, Agents, or the SDK's agent_revoke).", agent_user::NAME))
}

/// `unbrowse-node network [on|off|light|full]`: whether the node joins the peer network, or turning that on or off, or
/// light mode on (`light`) or off (`full`). Turning it off, and either mode, take effect when the node next starts;
/// turning it on, as soon as the running node sees it.
/// `checkout list | done <site> | dismiss <site|all>`: the card checkouts held for the owner, and the owner's say that
/// one is finished or dismissed. A release was asked in the node's own dialog before this runs (`shell_write`).
fn checkout_cli(args: &[String]) -> i32 {
    // The record is the node's sealed one: read and written with the seal its key makes.
    payhold::seal_from(|| root_store().ok().and_then(|k| unbrowse_core::RootKey::load(k.as_ref()).ok()));
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] | ["list"] => match payhold::list() {
            Ok(holds) if holds.is_empty() => {
                println!("no checkout is held");
                0
            }
            Ok(holds) => {
                for h in holds {
                    let hosts = if h.hosts.is_empty() { String::new() } else { format!(" (and {})", h.hosts.join(", ")) };
                    println!("{}{hosts}: held since {} until you say it is finished or dismissed", h.site, h.since);
                    for w in &h.warnings {
                        println!("  warning: {w}");
                    }
                }
                0
            }
            Err(e) => {
                eprintln!("the record of checkouts doesn't read ({e}): every site is held until `unbrowse-node checkout dismiss all`");
                1
            }
        },
        ["done", site] | ["dismiss", site] => match payhold::release(if *site == "all" { "*" } else { site }) {
            Ok(0) => {
                println!("{site} wasn't held");
                0
            }
            Ok(_) => {
                println!("{site}: the checkout is over, and agents may act on the site again");
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        _ => {
            eprintln!("usage: unbrowse-node checkout [list] | done <site> | dismiss <site|all>");
            2
        }
    }
}

fn network_cli(args: &[String]) -> i32 {
    let _held = store::settings_held();
    let mut s = store::load_settings();
    let said = match args.first().map(String::as_str) {
        None => {
            let how = match terms::standing(&s) {
                terms::Standing::KeptOff => "off: the node stays off the peer network".into(),
                terms::Standing::TermsDue => format!("waiting: {}", terms::due()),
                terms::Standing::Joins if s.light => "on, light: the node asks the peer network, answers no lookups and seeds no body it fetched".into(),
                terms::Standing::Joins if s.serve_kept => "on: the node joins the peer network and seeds the route bodies it fetched".to_string(),
                terms::Standing::Joins => "on: the node joins the peer network and announces only the routes you list".to_string(),
            };
            println!("{how}");
            return 0;
        }
        Some("on") => {
            s.peer_network = true;
            if terms::standing(&s) == terms::Standing::TermsDue {
                "on, once the terms are acknowledged (`unbrowse-node terms show`, then `unbrowse-node terms accept`)"
            } else {
                "on: the node joins the peer network"
            }
        }
        Some("off") => {
            s.peer_network = false;
            "off: the node leaves the peer network once no call is under way"
        }
        // Light mode: the node still finds and fetches other nodes' routes, and serves its own listed routes' bodies.
        Some("light") => {
            s.light = true;
            "light: once no call is under way the node restarts, then only asks the peer network and seeds no body it fetched"
        }
        // Serving kept routes: whether the node tells the network which sites' routes it used, by announcing and serving
        // the copies it keeps for others. Off by default.
        Some("kept") if args.len() == 2 && matches!(args[1].as_str(), "on" | "off") => {
            s.serve_kept = args[1] == "on";
            if s.serve_kept {
                "kept on: the node announces and serves the routes it keeps for others, so they are found while their contributors are offline; peers can then see which sites' routes it used"
            } else {
                "kept off: the node announces only the routes you list; using a route says nothing to the network"
            }
        }
        // Where another machine reaches this node: for `unb mcp --peer` (graph `gateway.direct`).
        Some("addrs") => {
            let (peer, addrs) = peers::dial_addresses();
            let Some(peer) = peer else {
                println!("the node hasn't published where it is yet: it does once it has joined the peer network");
                return 0;
            };
            println!("peer {peer}");
            for a in &addrs {
                println!("{a}");
            }
            println!("From another machine: unb mcp --peer {peer}{}", addrs.iter().map(|a| format!(" --addr {a}")).collect::<String>());
            println!("with a key made for the peer network (`unbrowse-node remote peer key`): until there is one, the node takes no MCP over it");
            return 0;
        }
        Some("full") => {
            s.light = false;
            "full: once no call is under way the node restarts, then answers lookups (and seeds the route bodies it fetched, if you serve kept routes)"
        }
        _ => {
            eprintln!("usage: unbrowse-node network [on|off|light|full|kept on|kept off|addrs]");
            return 2;
        }
    };
    match store::save_settings(&s) {
        Ok(()) => {
            println!("{said}");
            0
        }
        Err(e) => {
            eprintln!("saving the setting: {e}");
            1
        }
    }
}

/// `unbrowse-node coin ...`: the owner's route coins (spec ch. 6), each through its owner command (`coin_*`):
/// - `coin` / `coin list`: what the wallet holds per coin, staked lots, earnings to claim and parked buys;
/// - `coin launch <entry> <unb>`: launches an entry of this wallet's with that first buy;
/// - `coin buy <entry> <unb>` / `coin sell <entry> <coins>`: a trade at the quote less 1%;
/// - `coin stake <entry> <coins> [<delay seconds>]`, `coin unstake <entry> <delay seconds> <coins>`,
///   `coin withdraw <entry> <delay seconds>`, `coin claim <entry>`;
/// - `coin delay [<seconds>]`: the exit delay a fetch's stake for this wallet uses;
/// - `coin dev-buy [<basis points>]`: the share of the wallet's UNB listing launches a newly credited entry's coin with
///   and stakes, 100 (1%) by default; 0 is none.
fn coin_cli(args: &[String]) -> i32 {
    use serde_json::json;
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let n = |x: &str| x.trim().parse::<f64>().ok();
    let secs = |x: &str| x.trim().parse::<u64>().ok();
    let call = match a.as_slice() {
        [] | ["list"] => ("coin_holdings", json!({})),
        ["launch", e, unb] => ("coin_launch", json!({ "entry": e, "unb": n(unb) })),
        ["buy", e, unb] => ("coin_buy", json!({ "entry": e, "unb": n(unb) })),
        ["sell", e, coins] => ("coin_sell", json!({ "entry": e, "coins": n(coins) })),
        ["stake", e, coins] => ("coin_stake", json!({ "entry": e, "coins": n(coins), "delay": null })),
        ["stake", e, coins, delay] => ("coin_stake", json!({ "entry": e, "coins": n(coins), "delay": secs(delay) })),
        ["unstake", e, delay, coins] => ("coin_unstake", json!({ "entry": e, "delay": secs(delay), "coins": n(coins) })),
        ["withdraw", e, delay] => ("coin_withdraw", json!({ "entry": e, "delay": secs(delay) })),
        ["claim", e] => ("coin_claim", json!({ "entry": e })),
        ["delay"] => ("coin_fetch_delay", json!({ "delay": null })),
        ["delay", d] => ("coin_fetch_delay", json!({ "delay": secs(d) })),
        ["dev-buy"] => ("coin_dev_buy", json!({ "bps": null })),
        ["dev-buy", bps] => ("coin_dev_buy", json!({ "bps": bps.trim().parse::<u32>().ok() })),
        _ => {
            eprintln!("usage: unbrowse-node coin [list | launch <entry> <unb> | buy <entry> <unb> | sell <entry> <coins> | stake <entry> <coins> [<delay s>] | unstake <entry> <delay s> <coins> | withdraw <entry> <delay s> | claim <entry> | delay [<s>] | dev-buy [<basis points>]]");
            return 2;
        }
    };
    match owner_call(call.0, call.1) {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `unbrowse-node max-fetch [usdc]`: the most the node pays to fetch one route another contributor lists, or setting
/// it. Agents spend up to it on their own, with nothing to approve; an entry over it is passed over. The running node
/// reads it at every call, so a change holds at once.
fn max_fetch_cli(args: &[String]) -> i32 {
    let _held = store::settings_held();
    let mut s = store::load_settings();
    let said = match args {
        [] => {
            let max = s.max_fetch();
            if max == 0.0 {
                println!("$0: the node pays for no fetch, and uses only free routes and its own");
            } else {
                println!("${}: the most the node pays to fetch one route; a route that costs more is passed over", money::usdc(max));
            }
            return 0;
        }
        [usdc] => match usdc.trim().parse::<f64>().map_err(|_| String::new()).and_then(store::check_max_fetch) {
            Ok(max) => {
                s.max_fetch_usdc = max;
                if max == 0.0 {
                    "$0: from now the node pays for no fetch, and uses only free routes and its own".to_string()
                } else {
                    format!("${}: from now the node pays at most this to fetch one route", money::usdc(max))
                }
            }
            Err(_) => {
                eprintln!("the most the node pays to fetch one route is a sum of dollars, zero or more (e.g. 0.05)");
                return 2;
            }
        },
        _ => {
            eprintln!("usage: unbrowse-node max-fetch [dollars]");
            return 2;
        }
    };
    match store::save_settings(&s) {
        Ok(()) => {
            println!("{said}");
            0
        }
        Err(e) => {
            eprintln!("saving the setting: {e}");
            1
        }
    }
}

/// `unbrowse-node share …`: which routes the node lists on the network by itself, from a shell.
///
///   unbrowse-node share [status]            the mode, today's listings against the cap, and where each route stands
///   unbrowse-node share used|all|off        list the routes agents keep using (the default), every route, or none
///   unbrowse-node share route <id> on|off   share one route, or keep it off the network (what is listed stays listed)
///   unbrowse-node share per-day <n>         the most routes the node lists by itself in a day
///   unbrowse-node share delist              delist every route this node lists, and keep each off until shared again
///
/// The running node reads the mode on every pass, so a change holds at once. Turning sharing off delists nothing.
fn share_cli(args: &[String]) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let done = match a.as_slice() {
        [] | ["status"] => share_show(),
        [mode] if build_config::share_mode(Some(mode)).is_some() => {
            let mode = build_config::share_mode(Some(mode)).expect("checked");
            let _held = store::settings_held();
            let mut s = store::load_settings();
            s.share_routes = mode;
            // Choosing a mode is the notice's point made: it needn't be shown again.
            s.share_notice_seen = true;
            store::save_settings(&s).map(|_| match mode {
                store::ShareMode::Used => println!(
                    "used: the node lists a route once your agents keep using it (passed on {} days or {} times), the most used first, at most {} a day",
                    autolist::DAYS_EARNED, autolist::RUNS_EARNED, s.list_per_day()
                ),
                store::ShareMode::All => println!("all: the node lists every route it learns once it has run successfully, at most {} a day", s.list_per_day()),
                store::ShareMode::Off => println!("off: the node lists nothing by itself; what is listed stays listed (`unbrowse-node share delist` delists it all)"),
            })
        }
        ["route", id, on @ ("on" | "off")] => share_route_cli(id, *on == "on"),
        ["per-day", n] => match n.trim().parse::<u32>() {
            Ok(n) => {
                let _held = store::settings_held();
                let mut s = store::load_settings();
                s.list_per_day = Some(n);
                store::save_settings(&s).map(|_| println!("from now the node lists at most {n} route{} a day by itself", if n == 1 { "" } else { "s" }))
            }
            Err(_) => Err("the most routes listed a day is a whole number, zero or more".into()),
        },
        ["delist"] => owner_call("delist_all", serde_json::json!({})).map(|v| {
            let n = v.as_array().map(Vec::len).unwrap_or(0);
            println!("delisted {n} route{}; each stays off the network until you share it again", if n == 1 { "" } else { "s" });
        }),
        _ => {
            eprintln!("usage: unbrowse-node share [status | used | all | off | route <id> on|off | per-day <n> | delist]");
            return 2;
        }
    };
    match done {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// What `share` says with no argument: the running node's view, with what stops it listing now, or the files' when
/// it isn't running.
fn share_show() -> Result<(), String> {
    let v = owner_call("share_status", serde_json::json!({})).or_else(|_| serde_json::to_value(autolist::view()).map_err(|e| e.to_string()))?;
    let mode = v["mode"].as_str().unwrap_or("used");
    let how = match mode {
        "used" => format!("the routes your agents keep using (passed on {} days or {} times), the most used first", autolist::DAYS_EARNED, autolist::RUNS_EARNED),
        "all" => "every route the node learns, once it has run successfully".into(),
        _ => "nothing by itself".into(),
    };
    println!("{mode}: the node lists {how}; {} of {} listings today", v["listed_today"], v["per_day"]);
    if let Some(b) = v["blocked"].as_object() {
        println!("waiting: {}", b.get("message").or(b.get("error")).and_then(|m| m.as_str()).unwrap_or_else(|| b.get("kind").and_then(|k| k.as_str()).unwrap_or("")));
    }
    for r in v["routes"].as_array().into_iter().flatten() {
        let why = match r["why"].as_str().unwrap_or_default() {
            "listed" => "shared".to_string(),
            "below_threshold" => format!("not yet: used on {} of {} days, {} of {} runs", r["days"], r["days_needed"], r["runs"], r["runs_needed"]),
            "cap_reached" => format!("waiting: today's {} listings are made", r["per_day"]),
            "blocked" => "waiting: the node can't list now".into(),
            "queued" => "next to be listed".into(),
            "opted_out" => "kept off by you".into(),
            "off" => "not shared: sharing is off".into(),
            "not_run_yet" => "not yet: it hasn't run successfully".into(),
            "excluded" => format!("not shared: {} is excluded", r["host"].as_str().unwrap_or_default()),
            "not_shareable" => format!("can't be shared: {}", r["reason"].as_str().unwrap_or_default()),
            "failed" => format!("listing failed, tried again later: {}", r["error"].as_str().unwrap_or_default()),
            other => other.to_string(),
        };
        println!("  {}  {} ({})  {why}", r["id"].as_str().unwrap_or_default(), r["what"].as_str().unwrap_or_default(), r["site"].as_str().unwrap_or_default());
    }
    Ok(())
}

/// One route's sharing: the route's record, which the running node changes, or a stopped node keeps until it starts.
/// Turning a route off delists nothing (R2.14a): a listing already made stays listed until the owner delists it (R2.16).
fn share_route_cli(id: &str, on: bool) -> Result<(), String> {
    let route = store::load_route(id).ok_or_else(|| format!("no route {id}"))?;
    let live = route.listing.as_ref().is_some_and(|l| l.live);
    if owner_call("share_route", serde_json::json!({ "id": id, "on": on })).is_err() {
        store::update_route(id, |r| r.share = Some(on))?;
    }
    println!(
        "{id}: {}",
        match (on, live) {
            (true, _) => "shared: the node lists it by itself, even before it has earned it",
            (false, true) => "kept off the network from now on; it stays listed until you delist it (`unbrowse-node share delist`)",
            (false, false) => "kept off the network",
        }
    );
    Ok(())
}

/// `sign-in`: links another wallet to this node, on the website with Privy, or with a wallet of their own, through the
/// headless sign-in (`login`), which needs no window. Never needed to join: the node is on the network with its own
/// wallet (spec §86). A linked wallet receives withdrawals, and its deposit can pay for several nodes.
/// - `sign-in` opens the website's sign-in (or, with no browser here, says its address) and waits for it;
/// - `sign-in --wallet <address>` prints the message that wallet signs, and its nonce;
/// - `sign-in --wallet <address> --nonce <nonce> --signature <0x…>` links it with what it signed;
/// - `sign-in --key-file <path>` signs with the wallet key in that file (the owner's alone), here: nothing else needed.
///
/// Then it says what linking does and shows which routes the node will share, which the first listing waits for.
fn sign_in_cli(args: &[String]) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let done = (|| -> Result<(), String> {
        let way = match a.as_slice() {
            [] => login::Way::Website,
            ["--wallet", owner] => login::Way::Message { owner: owner.to_string() },
            ["--wallet", owner, "--nonce", nonce, "--signature", sig] => login::Way::Signed { owner: owner.to_string(), nonce: nonce.to_string(), signature: sig.to_string() },
            ["--key-file", path] => login::Way::Key(login::key_from_file(std::path::Path::new(path))?),
            _ => return Err("usage: unbrowse-node sign-in [--wallet <address> [--nonce <nonce> --signature <0x…>] | --key-file <path>]".into()),
        };
        let said = &mut |step: login::Step| match step {
            login::Step::Page { url, opened } => {
                println!("sign in with email or Google at {url}");
                if opened {
                    println!("(opened in your browser)");
                }
            }
            login::Step::Waiting => println!("waiting for you to sign in…"),
            login::Step::Asking { owner } => println!("linking {owner}: allow it in the dialog the node opens, or, on a machine with no screen, with `unbrowse-node confirm` on its terminal"),
        };
        match login::sign_in(&owner_call_within, way, &login::Waits::default(), said)? {
            login::Done::ToSign { owner, message, nonce } => {
                println!("sign this message with {owner} (as a plain message, personal_sign):\n\n{message}\n");
                println!("then: unbrowse-node sign-in --wallet {owner} --nonce {nonce} --signature <0x…>");
                return Ok(());
            }
            login::Done::Linked { owner } => println!("linked {owner} to this node"),
        }
        println!("{}", link::signed_in_note(store::load_settings().share_routes));
        println!();
        share_show()
    })();
    match done {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `unbrowse-node chain …`: which chain the node runs on, from a shell.
///
///   unbrowse-node chain                 the chain, its RPC, and whether its Settlement is deployed
///   unbrowse-node chain <name>          devnet (the node's own Anvil), arc-testnet or arc-mainnet, from the next start
///   unbrowse-node chain kept           the writes that must not go twice whose fate the node can't prove yet
///   unbrowse-node chain kept release <key>
///                                       forgets one after you checked the chain (asked in your own dialog)
///   unbrowse-node chain deploy [--pool <usdc> <unb>]
///                                       deploys the domain proofs, the four route-coin contracts and Settlement (and
///                                       UNB and a pool where the network names none) to the live chain, signed by the
///                                       owner's key, and writes ~/.unbrowse/networks/<name>.json. The curves' fee
///                                       recipient comes from the operator's machine
///                                       (`UNBROWSE_<NET>_FEE_RECIPIENT`).
///   unbrowse-node chain deploy … --pool <usdc> <unb>
///                                       the same, seeding the stand-in pool with that much of each from the owner's
///                                       own (minted where the owner deployed the token): needed beside a network's
///                                       own USDC, whose seed is never assumed
fn chain_cli(args: &[String]) -> i32 {
    let done = match args.first().map(String::as_str) {
        None => chain_show(),
        Some("deploy") => deploy_args(&args[1..]).and_then(|(seed, open)| chain_deploy(seed, &open)),
        // Through the running node, which keeps them: letting one go asks in the owner's dialog.
        Some("kept") => match &args[1..] {
            [] => owner_call("chain_kept", serde_json::json!({})).map(|v| println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default())),
            [r, key] if r == "release" => owner_call("chain_kept_release", serde_json::json!({ "key": key })).map(|_| println!("let go: the node sends {key} again if it is still wanted")),
            _ => Err("unbrowse-node chain kept [release <key>]".into()),
        },
        Some(name) if args.len() == 1 && chain::names().contains(&name) => {
            let _held = store::settings_held();
            let mut s = store::load_settings();
            s.chain = name.into();
            store::save_settings(&s).map(|_| {
                println!("{name}: the node runs on it from its next start (`unbrowse restart` now)");
                if let Some(env) = std::env::var("UNBROWSE_CHAIN").ok().filter(|e| !e.trim().is_empty() && e != name) {
                    println!("UNBROWSE_CHAIN={env} is set in this shell, and a node started from it runs on {env} instead");
                }
            })
        }
        _ => {
            eprintln!(
                "usage: unbrowse-node chain [{} | deploy [--pool <usdc> <unb>]]",
                chain::names().join(" | ")
            );
            return 2;
        }
    };
    match done {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// What `chain` says with no argument. It reads the setting and the network's file, never the chain.
fn chain_show() -> Result<(), String> {
    let why = match std::env::var("UNBROWSE_CHAIN").ok().filter(|e| !e.trim().is_empty()) {
        Some(_) => "UNBROWSE_CHAIN",
        None => "the setting",
    };
    match chain::chosen()? {
        chain::Mode::Devnet => println!("devnet ({why}): the node's own Anvil on 127.0.0.1, with test UNB from its faucet"),
        chain::Mode::Live(l) => {
            println!("{} ({why}), chain {}, RPC {}", l.net.name, l.net.chain_id, l.rpc);
            let home = chain::home_network_file(l.net);
            let from = if home.exists() { home.display().to_string() } else { format!("the built-in networks/{}.json", l.net.name) };
            match chain::network_file(l.net)?.deployment {
                Some(d) => println!(
                    "Settlement {:#x}, USDC {:#x}, UNB {:#x}, pool {:#x}, from block {} ({from})",
                    d.settlement, d.usdc, d.unb, d.pool, d.block
                ),
                None => println!("{} ({from})", chain::not_deployed(l.net.name)),
            }
        }
    }
    Ok(())
}

/// `chain deploy`'s flags: the pool's seed, if any, and the open value, required (`chain::OpenValues`).
fn deploy_args(args: &[String]) -> Result<(Option<chain::PoolSeed>, chain::OpenValues), String> {
    let num = |flag: &str, v: Option<&String>| -> Result<f64, String> {
        v.and_then(|v| v.parse::<f64>().ok()).filter(|x| x.is_finite() && *x > 0.0).ok_or_else(|| format!("{flag} takes a number above zero"))
    };
    let mut seed = None;
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        match flag {
            "--pool" => {
                let (usdc, unb) = (num(flag, args.get(i + 1))?, num(flag, args.get(i + 2))?);
                seed = Some(chain::PoolSeed { usdc, unb });
                i += 3;
                continue;
            }
            other => return Err(format!("`chain deploy` doesn't take {other}")),
        }
    }
    let open = chain::OpenValues {};
    open.units()?;
    Ok((seed, open))
}

/// `chain deploy`: the shared contracts on the live chain, signed by the owner's key, then what to copy into the
/// repository so every node on the network uses them. `seed` is what a stand-in pool is seeded with; `open` the values
/// the papers leave to the owner.
fn chain_deploy(seed: Option<chain::PoolSeed>, open: &chain::OpenValues) -> Result<(), String> {
    let chain::Mode::Live(l) = chain::chosen()? else {
        return Err("`chain deploy` is for a live chain (`unbrowse-node chain arc-testnet` first); the devnet deploys its own contracts when it starts".into());
    };
    // The node writes with the key this deploy signs with (claims, stakes, its heartbeat). One of its writes landing
    // between the contracts that name each other takes a nonce the set counts on.
    if listening_here(store::api_port()) {
        return Err("the node is running here, and it writes with the key a deploy signs with: stop it first (quit the app, or stop its service), deploy, then start it again".into());
    }
    let keys = root_store()?;
    let owner = open_identity(keys.as_ref())?.address;
    println!("deploying the domain proofs, the route-coin contracts and Settlement, and the tokens and pool the network's file doesn't name, on {} ({}) as {owner}: its gas is paid from that address", l.net.name, l.rpc);
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let (path, file) = rt.block_on(chain::deploy_shared(&l, keys.as_ref(), seed, open))?;
    let d = file.deployment.as_ref().ok_or("the deployment wasn't recorded")?;
    println!(
        "deployed on {}: Settlement {:#x}, USDC {:#x} ({} decimals), UNB {:#x}, pool {:#x}, route coins {:#x}, in block {}",
        l.net.name,
        d.settlement,
        d.usdc,
        d.usdc_decimals,
        d.unb,
        d.pool,
        d.coins.route_coins,
        d.block
    );
    println!("wrote {}: this node uses it from its next start", path.display());
    println!("for every node on {}, put this in unbrowse-node/app/networks/{}.json:", l.net.name, l.net.name);
    println!("{}", serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?);
    Ok(())
}

/// Whether something takes connections on this machine's `port`: the node, when it is the node's API port.
fn listening_here(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), std::time::Duration::from_secs(1)).is_ok()
}

/// `unbrowse-node vault …`: the owner's logins from a shell, with no window: the same ones the window's Vault shows. Nothing here needs the node running. Revealing a password stays in the window: a shell's scrollback
/// and history are no place for one. What a command prints is references and counts, never a secret.
///
///   unbrowse-node vault list
///   unbrowse-node vault add <site> <account>            a derived password, made from the root key, never stored
///   unbrowse-node vault add <site> <account> --stored   the password read from stdin
///   unbrowse-node vault remove <site> <account>
///   unbrowse-node vault rotate <site> <account>         a new derived password; the old one is gone
///   unbrowse-node vault code <site> <account>           the one-time code key read from stdin (otpauth:// or secret)
///   unbrowse-node vault import <export | ->             a browser's or password manager's export: passwords from a
///                                                       CSV or JSON, and passkeys from a JSON that holds them
///
/// A site's cookies are `unbrowse-node session …`.
fn vault_cli(args: &[String]) -> i32 {
    let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
    let done = match (a(0), args.len()) {
        ("list", 1) => {
            for l in vault::list() {
                let code = if l.code { format!("\tvault:code:{}:{}", l.site, l.account) } else { String::new() };
                println!("vault:{}:{}\t{}{code}", l.site, l.account, l.kind);
            }
            for c in vault::cards() {
                println!("vault:card:{}:<field>\tcard ending {}", c.label, c.last4);
            }
            Ok(())
        }
        ("card", 3) if a(1) == "add" => card_add_cli(a(2)),
        ("card", 2 | 3) if a(1) == "codes" => card_codes_cli(args.get(2).map(String::as_str)),
        ("card", 2 | 3) if a(1) == "approver" => card_approver_cli(args.get(2).map(String::as_str)),
        ("card", 2) if a(1) == "limits" => cli_vault_keep().map(|k| {
            for l in vault::card_limits(&k) {
                println!("{} on {}: {} a payment, {} a day, {} today", l.card, l.site, l.per_payment, l.per_day, l.spent);
            }
        }),
        ("card", 5 | 6) if a(1) == "limit" => card_limit_cli(a(2), a(3), a(4), args.get(5).map(String::as_str)),
        ("card", 3) if a(1) == "remove" => cli_vault_keep().and_then(|k| vault::remove_card(&k, a(2), "You")).map(|_| println!("removed the card {}", a(2))),
        ("add", 3) => cli_vault_keep().and_then(|k| vault::add(&k, a(1), a(2), "derived", None, "You")).map(|l| println!("added vault:{}:{} (derived)", l.site, l.account)),
        ("add", 4) if a(3) == "--stored" => {
            let mut password = zeroize::Zeroizing::new(String::new());
            match std::io::stdin().read_line(&mut password) {
                Ok(_) => cli_vault_keep()
                    .and_then(|k| vault::add(&k, a(1), a(2), "stored", Some(password.trim_end_matches(['\n', '\r'])), "You").map(|l| (l, k.is_sealed())))
                    .map(|(l, sealed)| println!("added vault:{}:{} ({})", l.site, l.account, kept_where(sealed))),
                Err(e) => Err(format!("couldn't read the password from stdin: {e}")),
            }
        }
        ("remove", 3) => cli_vault_keep().and_then(|k| vault::remove(&k, a(1), a(2))).map(|_| println!("removed {} on {}", a(2), a(1))),
        ("rotate", 3) => vault::rotate(a(1), a(2)).map(|l| println!("rotated vault:{}:{}: the next password is new", l.site, l.account)),
        ("code", 3) => {
            let mut key = zeroize::Zeroizing::new(String::new());
            match std::io::stdin().read_line(&mut key) {
                Ok(_) => cli_vault_keep().and_then(|k| vault::set_code(&k, a(1), a(2), &key, "You")).map(|l| println!("kept the code key: agents fill vault:code:{}:{}", l.site, l.account)),
                Err(e) => Err(format!("couldn't read the key from stdin: {e}")),
            }
        }
        ("import", 2) => read_input(a(1)).and_then(|text| vault_import_cli(&text, a(1))),
        ("keychain", 1) => {
            let kept = vault::list();
            for s in keychain_logins::listed() {
                let held = if kept.iter().any(|l| l.site == s.server && l.account == s.account) { "in the vault" } else { "not in the vault yet" };
                println!("vault:{}:{}\t{held}", s.server, s.account);
            }
            Ok(())
        }
        ("keychain", 4) if a(1) == "take" => cli_vault_keep()
            .and_then(|k| vault::take_from_login_keychain(&k, a(2), a(3)))
            .map(|l| println!("kept vault:{}:{} from the login keychain (sealed in the vault)", l.site, l.account)),
        _ => {
            eprintln!("usage: unbrowse-node vault list | add <site> <account> [--stored] | keychain [take <site> <account>] (web logins saved in the macOS login keychain: listed, or kept in the vault now; any is kept on its first use anyway) | remove <site> <account> | rotate <site> <account> | code <site> <account> | import <export | -> | card add <label> | card remove <label> | card codes [on | off] (keep cards' security codes, which card rules (PCI DSS) forbid keeping after a payment is authorised; off by default) | card approver [sdk | dialog] (who approves a card payment: the dialog, or also the owner SDK, such as the daemon hub's Telegram bot; dialog by default) (a site's cookies: `unbrowse-node session import`)");
            return 2;
        }
    };
    match done {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `vault card add <label>`: a card from stdin, one line each: the number, the expiry (MM/YY), the security code (only
/// while the vault keeps them, `vault card codes on`) and the name on the card. Never from a command line, where it would sit in the shell's history and the process list.
/// `vault card limit <card> <site> <per payment> [per day]`. An agent can reach a shell, so this asks as the window does.
fn card_limit_cli(card: &str, site: &str, per_payment: &str, per_day: Option<&str>) -> Result<(), String> {
    let n = |v: &str| v.trim().parse::<f64>().map_err(|_| format!("{v} isn't an amount"));
    let (one, day) = (n(per_payment)?, per_day.map(n).transpose()?);
    let day = day.unwrap_or(one);
    let a = serde_json::json!({ "card": card, "site": site, "per_payment": one, "per_day": day });
    if let Some(question) = commands::asks_the_owner("card_limit", &a) {
        let keys = root_store()?;
        shell_owner_yes(keys.as_ref(), root_in_file(), &question)?;
    }
    match vault::set_card_limit(&cli_vault_keep()?, card, site, one, day, "You")? {
        Some(l) => println!("saved per-payment {} and per-day {} limits for {} on {}; card use still asks while charge amounts are unbound", l.per_payment, l.per_day, l.card, l.site),
        None => println!("removed the stored limit for {card} on {site}"),
    }
    Ok(())
}

fn card_add_cli(label: &str) -> Result<(), String> {
    // The security code is asked for only while the owner keeps card security codes (#185).
    let codes = store::load_settings().keep_card_codes;
    let asked: &[&str] = if codes { &["card number", "expiry (MM/YY)", "security code", "name on the card"] } else { &["card number", "expiry (MM/YY)", "name on the card"] };
    let mut lines = Vec::new();
    for what in asked {
        if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            eprint!("{what}: ");
        }
        let mut line = zeroize::Zeroizing::new(String::new());
        std::io::stdin().read_line(&mut line).map_err(|e| format!("couldn't read the {what} from stdin: {e}"))?;
        lines.push(line);
    }
    let t = |n: usize| lines[n].trim_end_matches(['\n', '\r']);
    let card = zeroize::Zeroizing::new(match codes {
        true => unbrowse_core::Card::read(t(0), t(1), Some(t(2)), t(3))?,
        false => unbrowse_core::Card::read(t(0), t(1), None, t(2))?,
    });
    let keep = cli_vault_keep()?;
    let c = vault::add_card(&keep, label, &card, codes, "You")?;
    let code = if c.code { "and :cvv, and each checkout asks you first" } else { "and each checkout asks you first; the vault keeps no security code, so you type it on the page (`unbrowse-node vault card codes` says how to keep them)" };
    println!("added the card {}, ending {} ({}): agents fill vault:card:{}:number, :expiry, :name {code}", c.label, c.last4, kept_where(keep.is_sealed()), c.label);
    Ok(())
}

/// `vault card codes [on | off]`: whether the vault keeps card security codes (#185), said with what keeping them
/// costs. On is asked about as the window asks, since an agent can reach a shell; off forgets every kept code at once.
fn card_codes_cli(on: Option<&str>) -> Result<(), String> {
    let on = match on {
        None => None,
        Some("on") => Some(true),
        Some("off") => Some(false),
        Some(w) => return Err(format!("{w}: say on or off")),
    };
    if let Some(question) = commands::asks_the_owner("keep_card_codes", &serde_json::json!({ "on": on })) {
        let keys = root_store()?;
        shell_owner_yes(keys.as_ref(), root_in_file(), &question)?;
    }
    let c = vault::set_keep_codes(&cli_vault_keep()?, on, "You")?;
    if c.on {
        println!("The vault keeps card security codes: `vault card add` asks for one, and agents pay with it where a checkout asks, within your limits. A card added before keeps none: remove it and add it again. `vault card codes off` forgets them all.");
    } else {
        println!("The vault keeps no card security codes: you type one at each checkout. `vault card codes on` keeps them, for agents to pay without you.");
    }
    if !c.forgotten.is_empty() {
        println!("Forgot the security code of {}.", c.forgotten.join(", "));
    }
    println!("{}", vault::KEEPING_CODES_COSTS);
    Ok(())
}

/// `vault card approver [sdk | dialog]`: who approves a card payment an agent waits on (`owner_dialog::PaymentApprover`).
/// `sdk` is asked about in the node's dialog (or by passphrase) every time, even with the key in a file, where the
/// shell's other owner steps ask nothing: it is a standing yes for payments to come, and the owner's own presence is
/// what turns it on, not a token or a shell an agent can reach. `dialog` asks nothing.
fn card_approver_cli(to: Option<&str>) -> Result<(), String> {
    let keys = root_store()?;
    if let Some(to) = to {
        if !matches!(to, "sdk" | "dialog") {
            return Err(format!("{to}: say sdk or dialog"));
        }
        if let Some(question) = commands::asks_the_owner("payment_approver", &serde_json::json!({ "approver": to })) {
            owner_dialog::ask_blocking(keys.as_ref(), &question)?;
        }
        owner_dialog::set_payment_approver(keys.as_ref(), to, "You")?;
    }
    match owner_dialog::payment_approver(Some(keys.as_ref())).approver {
        "sdk" => println!("Card payments an agent waits on can be approved through the owner SDK without the dialog (the daemon hub's Telegram bot asks you on your phone). Every other owner question still opens the dialog. `vault card approver dialog` turns it off."),
        _ => println!("Card payments an agent waits on are approved in the node's dialog on this screen, or by passphrase. `vault card approver sdk` lets the owner SDK approve them too (the daemon hub's Telegram bot), after your yes in the dialog."),
    }
    Ok(())
}

/// Where a stored password went, as the owner is told.
fn kept_where(sealed: bool) -> &'static str {
    if sealed { "sealed in the vault under this node's key" } else { "stored in the system's keystore" }
}

/// A file's text, or stdin's for `-`. Held in memory that is wiped when it is dropped: an export is every password.
fn read_input(path: &str) -> Result<zeroize::Zeroizing<String>, String> {
    let mut t = zeroize::Zeroizing::new(String::new());
    if path == "-" {
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut t).map_err(|e| format!("couldn't read stdin: {e}"))?;
    } else {
        let mut f = std::fs::File::open(path).map_err(|e| format!("couldn't read {path}: {e}"))?;
        std::io::Read::read_to_string(&mut f, &mut t).map_err(|e| format!("couldn't read {path}: {e}"))?;
    }
    Ok(t)
}

/// `vault import`: the logins in an export, and the passkeys a JSON export holds beside them. Says what it kept as
/// counts and references, and what it left out by why.
fn vault_import_cli(text: &str, path: &str) -> Result<(), String> {
    let json = vault::is_json(text);
    let passkeys = if json { passkey::count_in(text) } else { 0 };
    let keep = cli_vault_keep()?;
    let mut apps = applinks::AppSites::new();
    let keys = root_store()?;
    let logins = match vault::import_confirming_apps(&keep, text, "You", &mut |a| apps.site(a), &mut |q| owner_dialog::ask_blocking(keys.as_ref(), &q)) {
        Ok(done) => done,
        // A file of passkeys alone: the passkeys below are all it holds.
        Err(_) if passkeys > 0 => vault::Imported::default(),
        Err(e) => return Err(e),
    };
    let no_logins = logins.added + logins.known + logins.restored == 0 && logins.skipped.is_empty();
    if json && no_logins && passkeys == 0 {
        return Err(format!("nothing to import: no logins in this file, and {}", passkey::NONE_IN_FILE));
    }
    if !(json && no_logins) {
        println!(
            "imported {} logins ({}; {} with a one-time code key); {} already in the vault",
            logins.added,
            kept_where(keep.is_sealed()),
            logins.codes,
            logins.known
        );
        if logins.restored > 0 {
            println!("restored {} logins the vault couldn't read (an older build kept their passwords in the system's keystore)", logins.restored);
        }
        for s in &logins.skipped {
            println!("left out {}: {}", s.count, s.why);
        }
    }
    if passkeys > 0 {
        if passkey::enabled() {
            let keys = root_store()?;
            say_passkeys(&passkey::import(text, keys.as_ref(), "You")?);
        } else {
            println!("left out {passkeys} passkeys: {}", passkey::OFF);
        }
    }
    if path != "-" {
        println!("the export holds every secret in it in plain text: delete {path} now");
    }
    Ok(())
}

fn say_passkeys(done: &passkey::Imported) {
    println!("imported {} passkeys, sealed in the vault; {} already in the vault", done.added.len(), done.known);
    for p in &done.added {
        println!("  passkey {} on {}{}", p.id, p.site, if p.account.is_empty() { String::new() } else { format!(" for {}", p.account) });
    }
    for (why, n) in &done.skipped {
        println!("left out {n}: {why}");
    }
}

fn say_session(k: &import::Kept) {
    let host = &k.host;
    match &k.profile_error {
        None => println!("kept {} cookies for {host}: calls send them, and the node's browser opens the site signed in ({} profile{})", k.cookies, k.profiles, if k.profiles == 1 { "" } else { "s" }),
        Some(e) => println!("kept {} cookies for {host}: calls send them. The node's browser didn't take them ({e}); it signs in from the session the first time a call needs it", k.cookies),
    }
}

/// The node's browser sessions from a shell: the same one-site import the window offers, for scripts and headless
/// machines. Only the one host's cookies are kept, from the owner's browser (opened headless, so it decrypts them) or
/// from a cookie file, as the session calls send and in the node's browser profile for the host (`import.rs`).
///
///   unbrowse-node session list                  the sites the node holds a session for, and how many cookies each
///   unbrowse-node session import <host>         keep this browser's session for <host> as the node's
///   unbrowse-node session import <host> --from <file | ->
///                                               the same from a cookie file you exported (a cookie extension's JSON,
///                                               cookies.txt, a Playwright storage state, a Cookie header)
///   unbrowse-node session forget <host>         drop the node's session for <host>; the next call walks it again
fn session_cli(args: &[String]) -> i32 {
    let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
    let done = match (a(0), args.len()) {
        ("list", 1) => {
            for s in sessions() {
                println!("{}\t{} cookies", s.host, s.cookies);
            }
            Ok(())
        }
        ("import", 2) => import::session(a(1)).map(|k| say_session(&k)),
        ("import", 4) if a(2) == "--from" => read_input(a(3)).and_then(|text| import::session_from(a(1), &text)).map(|k| {
            say_session(&k);
            if a(3) != "-" {
                println!("the cookie file signs in as you: delete {} now", a(3));
            }
        }),
        ("forget", 2) => forget_session(a(1).to_string()).map(|_| println!("dropped the node's session for {}", a(1))),
        _ => {
            eprintln!("usage: unbrowse-node session list | import <host> [--from <cookie file | ->] | forget <host>");
            return 2;
        }
    };
    match done {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `unbrowse-node passkey …`: website passkeys in the vault (`passkey.rs`), on until the owner turns them off: a site
/// the node signs in to may get one. Enrolling and using one need the running node, whose browser holds the
/// authenticator; the rest reads the vault directly.
///
///   unbrowse-node passkey on | off
///   unbrowse-node passkey never <site> | allow <site>                no passkey on that site, or again
///   unbrowse-node passkey list                                       no credential, key or counter is shown
///   unbrowse-node passkey import <export | ->                        passkeys a password manager exported
///   unbrowse-node passkey remove <id>
///   unbrowse-node passkey enrol <site> [--cdp <address>] [--wait <seconds>]
///   unbrowse-node passkey use <site> --cdp <address>                 a browser the node doesn't run
fn passkey_cli(args: &[String]) -> i32 {
    let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
    let opt = |name: &str| args.iter().position(|x| x == name).and_then(|i| args.get(i + 1)).cloned();
    let done = match a(0) {
        "on" | "off" => passkey::set_enabled(a(0) == "on").map(|_| {
            if a(0) == "on" {
                println!("passkeys are on: a site this node signs in to with a vault login may get a passkey, which the node keeps and signs in with. Whoever controls this node can sign in as you on those sites. `passkey never <site>` keeps one site out");
            } else {
                println!("passkeys are off: the node no longer enrols or signs in with them (kept ones stay sealed in the vault; `passkey remove <id>` deletes one)");
            }
        }),
        "never" | "allow" if args.len() == 2 => passkey::set_never(a(1), a(0) == "never").map(|site| {
            if a(0) == "never" {
                println!("{site}: the node never enrols a passkey there, nor signs in with one it holds (`passkey list` shows any to remove)");
            } else {
                println!("{site}: passkeys allowed again");
            }
        }),
        "list" if args.len() == 1 => {
            for p in passkey::list() {
                let used = p.used.map(|u| format!("last used {u}")).unwrap_or_else(|| "never used".into());
                println!("{}\t{}\t{}\t{}\t{used}", p.id, p.site, if p.account.is_empty() { "-" } else { &p.account }, p.how.name());
            }
            if !passkey::enabled() {
                println!("({})", passkey::OFF);
            }
            let never = passkey::never();
            if !never.is_empty() {
                println!("(never on: {})", never.join(", "));
            }
            Ok(())
        }
        "remove" if args.len() == 2 => passkey::remove(a(1), "You").map(|m| println!("{m}")),
        "import" if args.len() == 2 => read_input(a(1)).and_then(|text| {
            if !passkey::enabled() {
                return Err(passkey::OFF.into());
            }
            let keys = root_store()?;
            open_identity(keys.as_ref())?;
            say_passkeys(&passkey::import(&text, keys.as_ref(), "You")?);
            if a(1) != "-" {
                println!("the export holds each passkey's private key in plain text: delete {} now", a(1));
            }
            Ok(())
        }),
        "enrol" | "enroll" if args.len() >= 2 => {
            let (minutes, wait) = enrol_span(opt("--wait").and_then(|w| w.parse().ok()).unwrap_or(600));
            let before: Vec<String> = passkey::list().into_iter().map(|p| p.id).collect();
            let body = serde_json::json!({ "site": a(1), "cdp": opt("--cdp"), "minutes": minutes });
            owner_call("passkey_enrol", body).and_then(|armed| {
                println!("waiting up to {wait}s: {}", armed["how"].as_str().unwrap_or_default());
                let until = std::time::Instant::now() + std::time::Duration::from_secs(wait);
                while std::time::Instant::now() < until {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    if let Some(p) = passkey::list().into_iter().find(|p| !before.contains(&p.id)) {
                        println!("enrolled passkey {} on {}{}", p.id, p.site, if p.account.is_empty() { String::new() } else { format!(" for {}", p.account) });
                        return Ok(());
                    }
                }
                Err("no passkey was made in time: nothing was kept".into())
            })
        }
        "use" if args.len() >= 2 => match opt("--cdp") {
            Some(cdp) => owner_call("passkey_use", serde_json::json!({ "site": a(1), "cdp": cdp })).map(|r| {
                println!("holding {} passkey(s) for {} in that browser while it runs; anything else driving it over DevTools can use them too", r["held"], a(1));
            }),
            None => Err("the node's own browser signs in by itself as it browses; `use` is for another browser: --cdp <address>".into()),
        },
        _ => {
            eprintln!("usage: unbrowse-node passkey on | off | never <site> | allow <site> | list | remove <id> | import <export | -> | enrol <site> [--cdp <address>] [--wait <seconds>] | use <site> --cdp <address>");
            return 2;
        }
    };
    match done {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// How long `passkey enrol` arms the site, in whole minutes as the node takes it (1 to 30, `passkey::arm`), and how long
/// the command waits, in seconds: the same span. A shorter wait would say nothing was kept while a passkey could still be.
fn enrol_span(asked: u64) -> (u64, u64) {
    let minutes = passkey::enrol_wait_secs(asked).div_ceil(60).max(1);
    (minutes, minutes * 60)
}

/// One owner command on the running node, as the window sends it.
fn owner_call(cmd: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    owner_call_within(cmd, body, std::time::Duration::from_secs(60))
}

/// The same, waiting up to `wait` for the answer.
fn owner_call_within(cmd: &str, body: serde_json::Value, wait: std::time::Duration) -> Result<serde_json::Value, String> {
    owner_ask(cmd, body, wait).map_err(String::from)
}

/// Why an owner command came back with no answer to use. Only `NoNode` says the node isn't running: a command that
/// does the work itself when there is no node (`update`) must never do it beside one that refused, or that is still on
/// it past the wait. Told apart by what the connection did, never by the words of the error.
#[derive(Debug)]
enum Unanswered {
    /// No node to ask: none has started here (no owner token), or nothing takes a connection on its port.
    NoNode(String),
    /// The node took the command: it refused it, its answer didn't read, or it is still on it past the wait.
    Node(String),
}

impl From<Unanswered> for String {
    fn from(a: Unanswered) -> String {
        match a {
            Unanswered::NoNode(e) | Unanswered::Node(e) => e,
        }
    }
}

/// One owner command on the running node, waiting up to `wait`, with why it failed told apart (`Unanswered`).
fn owner_ask(cmd: &str, body: serde_json::Value, wait: std::time::Duration) -> Result<serde_json::Value, Unanswered> {
    let token = std::fs::read_to_string(store::home().join("owner.token")).map_err(|_| Unanswered::NoNode("start the node first (`unbrowse-node` or the app)".into()))?;
    ask_at(&format!("http://127.0.0.1:{}/owner/{cmd}", store::api_port()), token.trim(), body, wait)
}

/// `body` posted to `url` with the owner's `token`. A connection refused is no node; one that times out reached a node
/// that is still busy (a timed-out connect included: something listens there), and any other failure happened after
/// the node took the command.
///
/// The request is signed with the token, which never leaves this process, and the answer is used only when the node
/// signed it (`signed_client`).
fn ask_at(url: &str, token: &str, body: serde_json::Value, wait: std::time::Duration) -> Result<serde_json::Value, Unanswered> {
    let bytes = serde_json::to_vec(&body).map_err(|e| Unanswered::Node(e.to_string()))?;
    let r = signed_client::send(reqwest::Method::POST, url, token, Some(&bytes), &[], Some(wait)).map_err(|e| match e {
        signed_client::Failed::Send(e) if e.is_timeout() => {
            Unanswered::Node(format!("the node hasn't answered in {}s: it is running, and may still be doing it", wait.as_secs()))
        }
        signed_client::Failed::Send(e) if e.is_connect() => Unanswered::NoNode("the node isn't answering: start it first (`unbrowse-node` or the app)".into()),
        signed_client::Failed::Send(e) => Unanswered::Node(format!("the node took the command but its answer never came: {e}")),
        signed_client::Failed::NotTheNodes(why) => Unanswered::Node(why),
        signed_client::Failed::Refused(status) => Unanswered::Node(signed_client::unsigned_refusal(status)),
    })?;
    let ok = (200..300).contains(&r.status);
    let v: serde_json::Value = serde_json::from_slice(&r.body).map_err(|e| Unanswered::Node(e.to_string()))?;
    if ok {
        Ok(v)
    } else {
        Err(Unanswered::Node(v["error"].as_str().unwrap_or("the node refused it").to_string()))
    }
}

/// The browser a passkey command acts in: the node's own for the site, or a DevTools address the owner named.
fn passkey_browser(cdp: Option<String>) -> passkey::Browser {
    match cdp.filter(|c| !c.trim().is_empty()) {
        Some(c) => passkey::Browser::At(c),
        None => passkey::Browser::Node,
    }
}

pub enum OwnerError {
    Unknown,
    Failed(String),
}

impl From<String> for OwnerError {
    fn from(m: String) -> Self {
        OwnerError::Failed(m)
    }
}

fn arg<T: serde::de::DeserializeOwned>(a: &serde_json::Value, k: &str) -> Result<T, OwnerError> {
    serde_json::from_value(a.get(k).cloned().unwrap_or(serde_json::Value::Null)).map_err(|e| OwnerError::Failed(format!("{k}: {e}")))
}

/// A secret argument (a card's number, its code): what was sent is never said back, as serde's own error would say it.
/// None when it wasn't sent.
fn secret_arg(a: &serde_json::Value, k: &str) -> Result<Option<zeroize::Zeroizing<String>>, OwnerError> {
    match a.get(k) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(zeroize::Zeroizing::new(s.clone()))),
        Some(_) => Err(OwnerError::Failed(format!("{k}: give it as text"))),
    }
}

/// A secret argument the command needs.
fn needed_secret(a: &serde_json::Value, k: &str) -> Result<zeroize::Zeroizing<String>, OwnerError> {
    secret_arg(a, k)?.ok_or_else(|| OwnerError::Failed(format!("{k}: it is needed")))
}

fn out<T: Serialize>(v: T) -> Result<serde_json::Value, OwnerError> {
    serde_json::to_value(v).map_err(|e| OwnerError::Failed(e.to_string()))
}

/// The window's commands, by name, with their arguments as a JSON object: what `POST /owner/{command}` runs. Each is
/// one entry in `commands::OWNER_COMMANDS`.
pub async fn owner(node: &Arc<Node>, cmd: &str, a: serde_json::Value) -> Result<serde_json::Value, OwnerError> {
    match commands::OWNER_COMMANDS.iter().find(|c| c.name == cmd) {
        Some(c) => {
            // A secret the node can't take back goes out only on the owner's yes in the node's own dialog: the token
            // that reached here proves only that the caller runs as this user. A call missing an argument such a
            // command needs is refused by name, with no dialog and without running.
            let a = commands::under_current_names(cmd, a);
            if let Some(question) = commands::asks_the_owner(cmd, &a) {
                if !c.has_its_arguments(&a) {
                    return Err(OwnerError::Failed(format!("{cmd} is missing an argument it needs: nothing was done")));
                }
                // A malformed entry id is refused by name before the dialog, not after the owner said yes.
                if a.get("entry").is_some() {
                    entry_arg(&a, "entry")?;
                }
                owner_dialog::ask(node.key().ok(), question).await.map_err(OwnerError::Failed)?;
            }
            c.run(node, &a).await
        }
        None => Err(OwnerError::Unknown),
    }
}

/// How long a boot step that failed waits before it is tried again, at first and at most.
const BOOT_RETRY: std::time::Duration = std::time::Duration::from_secs(2);
const BOOT_RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(120);

fn backoff(wait: &mut std::time::Duration) -> std::time::Duration {
    let now = *wait;
    *wait = (*wait * 2).min(BOOT_RETRY_MAX);
    now
}

/// How long the chain's start waits for the node's key to open before it reads the network's public RPC instead.
const GATEWAY_KEY_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Signs and holds the running node's pass for Unbrowse's RPC gateway on the network it runs on (`gateway`), before its
/// chain starts, and again every `gateway::RENEW`: the chain reads through the gateway while it takes the node, and the
/// network's public RPC otherwise. Nothing on the devnet, and nothing while `UNBROWSE_RPC` names an RPC by hand.
async fn hold_gateway_pass(n: &Arc<Node>) {
    let Ok(chain::Mode::Live(l)) = chain::chosen() else { return };
    if std::env::var("UNBROWSE_RPC").is_ok_and(|v| !v.trim().is_empty()) || crate::gateway::base().is_none() {
        return;
    }
    // The key opens beside the chain's start (the identity is read in parallel): wait for it a little, so a node whose
    // key opens a moment later still reads through the gateway, and say so when it never opens.
    let waited = std::time::Instant::now();
    let keys = loop {
        match n.key() {
            Ok(k) => break k,
            Err(e) if waited.elapsed() >= GATEWAY_KEY_WAIT => {
                eprintln!("rpc: no pass for Unbrowse's RPC, the node's key isn't open ({e}): the node reads the network's public RPC until it starts again");
                return;
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
        }
    };
    if let Err(e) = crate::gateway::hold(keys, l.net.name) {
        eprintln!("rpc: no pass for Unbrowse's RPC ({e}): the node reads the network's public RPC");
        return;
    }
    let node = n.clone();
    let network = l.net.name;
    tokio::spawn(async move {
        // Every RETAKE: a node off the gateway (refused before its owner signed in, or the gateway didn't answer) asks
        // it again and moves back when it answers; every RENEW the pass is renewed, and a node on the gateway reads
        // with the new one.
        let mut renewed_at = std::time::Instant::now();
        loop {
            tokio::time::sleep(crate::gateway::RETAKE).await;
            if renewed_at.elapsed() >= crate::gateway::RENEW {
                renewed_at = std::time::Instant::now();
                match node.key().and_then(|k| crate::gateway::hold(k, network)) {
                    Ok(()) if chain::on_gateway() => {
                        if let Some(url) = crate::gateway::url_for(network) {
                            chain::use_rpc(&url);
                        }
                    }
                    Ok(()) => {}
                    Err(e) => eprintln!("rpc: couldn't renew the pass for Unbrowse's RPC: {e}"),
                }
            }
            if chain::on_gateway() {
                continue;
            }
            if let Some(url) = crate::gateway::url_held(network) {
                if chain::retake(&url).await {
                    crate::gateway::unrefuse();
                    eprintln!("chain: {network} is read through Unbrowse's RPC again: it takes this node now");
                }
            }
        }
    });
}

/// Starts the chain, trying again until it starts: an RPC that doesn't answer yet, or a devnet that can't start yet,
/// is said in the chain's status meanwhile.
async fn start_chain(n: &Arc<Node>) {
    hold_gateway_pass(n).await;
    let mut wait = BOOT_RETRY;
    loop {
        match n.chain.start().await {
            Ok(d) => {
                *n.chain_error.locked() = None;
                if let Some(net) = n.chain.network() {
                    let settlement = d.map(|d| format!("Settlement {:#x}", d.settlement)).or_else(|| n.chain.deployed().err()).unwrap_or_default();
                    eprintln!("chain: {} at {}; {settlement}", net.name, crate::gateway::shown(chain::url().as_str()));
                }
                n.events.emit("chain", ());
                return;
            }
            Err(e) => {
                // The chain's status is read by anyone on this machine (`health`), and the log is kept: no pass in either.
                let e = crate::gateway::scrub(&e);
                eprintln!("chain: {e}; trying again in {}s", wait.as_secs());
                *n.chain_error.locked() = Some(e);
                n.events.emit("chain", ());
                tokio::time::sleep(backoff(&mut wait)).await;
            }
        }
    }
}

/// Joins the peer network once the identity is unlocked, the owner has acknowledged the current terms and keeps the
/// node on it (joined as soon as they do both), trying again until it has joined.
async fn join_peers(n: Arc<Node>, port: u16) {
    let mut said_off = false;
    let mut said_old = false;
    let mut said_waiting: Option<String> = None;
    let mut wait = BOOT_RETRY;
    loop {
        if !n.unlocked() || !network_on() {
            if terms::standing(&store::load_settings()) == terms::Standing::KeptOff && !said_off {
                eprintln!("peers: off, the owner keeps this node off the peer network (`unbrowse-node network on` joins)");
                said_off = true;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            continue;
        }
        if update::below_minimum() {
            if !said_old {
                eprintln!("peers: this node is older than the network takes ({}); it joins once it has updated", update::min_version().unwrap_or_default());
                said_old = true;
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            continue;
        }
        if let Ok(me) = identity(&n) {
            link::note_joined(&me.address);
        }
        // Not before it is ready: a node that couldn't be paid or couldn't sign announces and serves nothing.
        if let Err(why) = health::to_join(&n) {
            if said_waiting.as_deref() != Some(why.as_str()) {
                eprintln!("peers: not joining yet, {why}");
                said_waiting = Some(why);
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }
        let Ok(addr) = chain::owner_address(n.keys.as_ref()) else {
            tokio::time::sleep(backoff(&mut wait)).await;
            continue;
        };
        if let Err(e) = network::advertise(&format!("{addr:#x}"), port, &n.info.name) {
            eprintln!("network: couldn't advertise: {e}");
        }
        match peers::start(n.clone()).await {
            Ok(net) => {
                let _ = n.net.set(net);
                *health::JOIN_ERROR.locked() = None;
                return;
            }
            Err(e) => {
                eprintln!("peers: couldn't join the peer network yet, trying again in {}s: {e}", wait.as_secs());
                *health::JOIN_ERROR.locked() = Some(e.to_string());
                // A node that couldn't pay to register its identity tries again at its next retry, or at once when its wallet is funded or linked.
                tokio::select! {
                    _ = tokio::time::sleep(backoff(&mut wait)) => {}
                    _ = link::SIGNED_IN.notified() => wait = BOOT_RETRY,
                    _ = FUNDED.notified() => wait = BOOT_RETRY,
                }
            }
        }
    }
}

/// What the running node took at its start, and can't take back: the peer network's claim, peer key and registration
/// are made once, under the root key of that moment, and whether it seeds. The signer is read live, so a key swapped
/// under it (`wallet restore` from a shell, or the window's) signs at once while the network goes on as the old one.
#[derive(Clone, Debug, PartialEq)]
struct Took {
    /// The address the node read its key as.
    address: String,
    /// On the peer network, and whether it joined as light.
    joined: Option<bool>,
}

/// Why the running node has to start over, if it does, given what it took, the key now, and the settings now. Only a
/// restart carries a change to any of these through everything that took them: the agents' keys, the swarm, the claims.
fn restart_for(took: &Took, key_now: &str, kept_off: bool, light_now: bool) -> Option<&'static str> {
    if !took.address.eq_ignore_ascii_case(key_now) {
        return Some("the node's key changed, and it goes on the network as the new one");
    }
    match took.joined {
        Some(_) if kept_off => Some("the owner took the node off the peer network"),
        Some(light) if light != light_now => Some("the owner changed how the node takes part in the peer network"),
        _ => None,
    }
}

/// Follows what the running node took at its start, and restarts it, once no call is under way, when that changes.
async fn watch_what_it_took(n: &Arc<Node>) {
    let mut joined = None;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let Ok(view) = identity(n) else { continue };
        let Ok(now) = chain::owner_address(n.keys.as_ref()) else { continue };
        let settings = store::load_settings();
        joined = n.peers().map(|_| joined.unwrap_or(settings.light));
        if let Some(why) = restart_for(&Took { address: view.address, joined }, &format!("{now:#x}"), !network_on(), settings.light) {
            eprintln!("node: restarting: {why}");
            match update::restart(n) {
                Ok(_) => return,
                Err(e) => eprintln!("node: couldn't restart ({e}): `unbrowse restart` does it by hand"),
            }
        }
    }
}

/// Whether the chain pass (`claim_loop`) runs: whenever the identity is unlocked, on the peer network or off it. The
/// owner decided this (audit TRUST-03.6): switching the node off the network keeps what it shares on this machine, and
/// leaves its chain work running, since stopping it would lose what is already earned or staked. Claims of what agents
/// paid run before their window closes (and with them the coin buys a fetch parked for the owner's own payers),
/// and `top_up` keeps the deposit funded.
/// Every standing is named, so a new one has to say whether it stops the pass.
fn chain_pass_runs(unlocked: bool, standing: terms::Standing) -> bool {
    match standing {
        terms::Standing::Joins | terms::Standing::KeptOff | terms::Standing::TermsDue => unlocked,
    }
}

/// Claims what is due (`chain::claim_due`), reprices and holds once a minute, whenever `chain_pass_runs` says so and
/// Settlement can be used: on the peer network or off it (holding does nothing off it, finding no routes to hold).
/// Where Settlement couldn't be used at start, it is looked for again: soon after the RPC didn't answer, rarely after it
/// said there's none.
async fn claim_loop(n: &Arc<Node>) {
    const NONE_DEPLOYED_RETRY: std::time::Duration = std::time::Duration::from_secs(600);
    let mut wait = BOOT_RETRY;
    #[allow(unused_variables, unused_assignments)]
    let mut failed_before = false;
    loop {
        // The network switch is read here only to show it stops nothing (`chain_pass_runs`).
        if !chain_pass_runs(n.unlocked(), terms::standing(&store::load_settings())) {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }
        if n.chain.deployed().is_err() {
            match n.chain.find_settlement().await {
                Ok(()) => {
                    wait = BOOT_RETRY;
                    n.events.emit("chain", ());
                }
                Err(chain::Missing::Unreachable(_)) => {
                    tokio::time::sleep(backoff(&mut wait)).await;
                    continue;
                }
                // On a live network with no Settlement deployed there is nothing to claim or price.
                Err(chain::Missing::Absent(_)) => {
                    tokio::time::sleep(NONE_DEPLOYED_RETRY).await;
                    continue;
                }
            }
        }
        #[allow(unused_variables)]
        let started = std::time::Instant::now();
        // What became of the writes that must not go twice, and of a write holding back every one after it.
        // The finalized chain is followed each pass, so the checkpoints a proof walks from stay close together.
        if let Ok(id) = n.chain.chain_id() {
            let _ = crate::anchor::advance(id).await;
        }
        inflight::pass(&rpc::ProviderBuilder::new().connect_http(chain::url())).await;
        if let Ok(keys) = n.key() {
            if let Err(e) = chain::unstick(keys).await {
                eprintln!("writes: {e}");
            }
        }
        let claimed = claim_all(n, chain::ClaimWhen::Worth(store::load_settings().claim_gas_share())).await;
        // The claim pass completes once the chain answers again, whatever held up the one before.
        sut_sometimes!(claimed.is_ok() && failed_before, "a claim pass completed after the one before it failed");
        #[allow(unused_assignments)]
        {
            failed_before = claimed.is_err();
        }
        if let Err(e) = claimed {
            eprintln!("claims: {e}");
        }
        // What its agents signed goes to its watchtowers as it grows, so the lines are claimed if this node goes away.
        watchtower::hand_over(n).await;
        if let Err(e) = reprice(n).await {
            eprintln!("pricing: {e}");
        }
        peers::hold_tick(n).await;
        // The policies of the sites the node's routes call, at most once an epoch (R4.17).
        sitepolicy::refresh_all(&n.chain, store::load_routes().into_iter().map(|r| r.site)).await;
        share::check_kept(n).await;
        share::watch(n).await;
        share::trim(n).await;
        autolist::tick(n).await;
        mend_listings(n).await;
        // Bounties: the owner's agent's judgement asked, confirmations on the owner's yes, settling, releasing by use and
        // taking back after a deadline (spec ch. 8).
        autobounty::pass(n).await;
        // Roots for listings that wait on the reserve's poster, and, on the poster, its root when one is due (R2.20).
        reserve::tick(n).await;
        // The coin the listing's first buy launches for each newly credited entry and stakes for the owner
        // (`coin_dev_buy_bps`, 1% of the wallet's UNB by default, `decide.dev-buy-default-on`).
        if let Ok(keys) = n.key() {
            if let Err(e) = chain::coins::launch_listed(&n.chain, keys).await {
                eprintln!("coins: {e}");
            }
        }
        // Which deposit each key pays from, read again each pass: a wallet's deposit that ran dry moves its keys to the
        // node's own within a minute, not at the next hourly upkeep.
        owner_nodes::follow(n).await;
        top_up(n).await;
        // Every chain call it makes is bounded (rpc.rs), so a pass ends even while the chain doesn't answer.
        sut_reachable!("a node's background pass of claims, pricing and holding completed");
        sut_sometimes!(
            started.elapsed() > std::time::Duration::from_secs(120),
            "a background pass completed after the chain held it up for over two minutes",
            &serde_json::json!({ "seconds": started.elapsed().as_secs() })
        );
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
}

/// Woken when the node's own top-up deposits: a node that couldn't pay to register its identity (its first top-up)
/// tries to join again at once, so the first top-up also registers it.
pub static FUNDED: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Moves Settlement's USDC the wallet holds into the deposit while the deposit is below the owner's floor, at most once
/// a pass, for an owner who holds USDC of their own. Whether it deposited. It does this even while the owner's wallet
/// grants every key (spec §76.1): a key falls back to the node's own deposit whenever the wallet's can't cover a call
/// (`owner_nodes::pays_from_wallet`), so that deposit is kept filled. The gas the node needs stays in its wallet.
pub async fn top_up(n: &Node) -> bool {
    let Ok(keys) = n.key() else { return false };
    let s = store::load_settings();
    match chain::top_up(&n.chain, keys, s.deposit_floor_usdc, s.gas_reserve_usdc).await {
        Ok(Some(_)) => {
            n.events.emit("activity", ());
            FUNDED.notify_waiters();
            true
        }
        Ok(None) => false,
        Err(e) => {
            // Settlement not deployed yet, or no gas: the next pass asks again.
            if n.chain.deployed().is_ok() {
                eprintln!("deposit: {e}");
            }
            false
        }
    }
}

/// The node runs on its own, with no window: agents reach it on 127.0.0.1, and the owner's window (a separate,
/// native app) watches it over the same port with the owner's token. Closing the window leaves the node working.
// Links the Antithesis coverage runtime, which the sanitizer-coverage rustflags of antithesis/Dockerfile call into.
#[cfg(feature = "antithesis-coverage")]
use antithesis_instrumentation as _;

/// The words `main` runs a command for, in the order it checks them.
const NODE_COMMAND_WORDS: [&str; 31] = [
    "agent new", "agent token", "agent cap", "money", "earnings", "nodes", "browser", "vault", "terms", "checkout", "network", "remote", "coin", "max-fetch", "chain", "bounty", "domain",
    "passkey", "session", "wallet", "share", "sign-in", "onboard", "telemetry", "update", "restart", "reports", "passphrase", "confirm", "agent-user", "--help",
];

/// Whether the words after the program's name start the node, and the source tag they give: `Some(None)` for no
/// words, `Some(Some(tag))` for `--from <tag>` or `--from=<tag>` alone, `None` for anything else (a command, help, a
/// word it doesn't know). A `--from` with nothing after it still starts the node, with an empty tag for the start's
/// warning to name (`telemetry::offered_from`): a wrong tag is never fatal.
fn start_words(words: &[String]) -> Option<Option<String>> {
    match words {
        [] => Some(None),
        [flag] if flag == "--from" => Some(Some(String::new())),
        [flag, tag] if flag == "--from" => Some(Some(tag.clone())),
        [one] => one.strip_prefix("--from=").map(|t| Some(t.to_string())),
        _ => None,
    }
}

/// Holds glibc to two heaps for the whole node. By default each thread that allocates gets a heap of its own (up to eight
/// per core), and a heap keeps what was freed in it: the node's many worker threads each held the peak of the work they
/// last did, so its memory only ever rose (UNB-139, measured on a copy of a node's routes: three searches in a row took
/// it to 1,013, 1,425 and 1,710 MB with the default, and stayed near 1,110 MB with two heaps). An owner's own
/// `MALLOC_ARENA_MAX` wins.
fn few_heaps() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    if std::env::var_os("MALLOC_ARENA_MAX").is_none() {
        // SAFETY: mallopt only sets an allocator parameter; it is called before the node starts a thread.
        unsafe {
            libc::mallopt(libc::M_ARENA_MAX, 2);
        }
    }
}

fn main() {
    // Registers the harness's assertion catalog before anything can reach an assertion.
    #[cfg(feature = "antithesis")]
    antithesis_sdk::antithesis_init();
    few_heaps();
    let args: Vec<String> = std::env::args().collect();
    // `--from <tag>` alone runs the node, as no words do (`unbrowse start --from <tag>`): it is a start, not a command.
    let start = start_words(&args[1..]);
    // A shell's write the window's command would ask about is asked the same way, before it runs: an agent can reach a
    // shell, and the owner's yes is what the window's path asks for.
    if let Err(e) = shell_write_allowed(&args.iter().skip(1).map(String::as_str).collect::<Vec<_>>()) {
        eprintln!("{e}");
        std::process::exit(1);
    }
    // Any word but a start's `--from` makes this a shell's command, never the node: each settings write it makes that
    // the window's `save_settings` would ask about is asked about the same way, whichever command makes it.
    if start.is_none() {
        store::ask_before_shell_writes(shell_settings_yes);
    }
    if args.get(1).map(String::as_str) == Some("agent") && args.get(2).map(String::as_str) == Some("new") {
        std::process::exit(agent_new(&args[3..]));
    }
    if args.get(1).map(String::as_str) == Some("money") {
        std::process::exit(money_cli());
    }
    if args.get(1).map(String::as_str) == Some("earnings") {
        std::process::exit(earnings_cli());
    }
    if args.get(1).map(String::as_str) == Some("nodes") {
        std::process::exit(nodes_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("agent") && args.get(2).map(String::as_str) == Some("token") {
        std::process::exit(agent_token_cli(&args[3..]));
    }
    if args.get(1).map(String::as_str) == Some("browser") {
        std::process::exit(browser_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("agent") && args.get(2).map(String::as_str) == Some("bearer") {
        std::process::exit(agent_bearer_cli(&args[3..]));
    }
    if args.get(1).map(String::as_str) == Some("agent") && args.get(2).map(String::as_str) == Some("cap") {
        std::process::exit(agent_cap_cli(&args[3..]));
    }
    if args.get(1).map(String::as_str) == Some("vault") {
        std::process::exit(vault_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("terms") {
        std::process::exit(terms::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("checkout") {
        std::process::exit(checkout_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("network") {
        std::process::exit(network_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("remote") {
        std::process::exit(remote::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("coin") {
        std::process::exit(coin_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("max-fetch") {
        std::process::exit(max_fetch_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("chain") {
        std::process::exit(chain_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("bounty") {
        std::process::exit(bounty::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("domain") {
        std::process::exit(domains::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("passkey") {
        std::process::exit(passkey_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("session") {
        std::process::exit(session_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("wallet") {
        std::process::exit(wallet_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("share") {
        std::process::exit(share_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("sign-in") {
        std::process::exit(sign_in_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("onboard") {
        std::process::exit(onboard::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("telemetry") {
        std::process::exit(telemetry::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("update") {
        std::process::exit(update_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("restart") {
        std::process::exit(restart_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("reports") {
        std::process::exit(report::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("passphrase") {
        std::process::exit(passphrase_cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("confirm") {
        std::process::exit(confirm_cli(&args[2..]));
    }
    if let Some(code) = lab_cli(&args) {
        std::process::exit(code);
    }
    if args.get(1).map(String::as_str) == Some("agent-user") {
        std::process::exit(agent_user_cli(&args[2..]));
    }
    // Started with no words, or `--from <tag>` alone, it runs the node. Anything else is a command it doesn't have, or a
    // request for help: neither starts a node (a second one, behind the one already serving, fights it for the port).
    if let (None, Some(word)) = (&start, args.get(1)) {
        let help = matches!(word.as_str(), "--help" | "-h" | "help");
        let out = format!(
            "usage: unbrowse-node [--from <tag>]  run the node (the app starts it); the tag says where the install came from\n       unbrowse-node <command> …       one of: {}\n",
            NODE_COMMAND_WORDS.join(", ")
        );
        if help {
            print!("{out}");
            std::process::exit(0);
        }
        eprint!("unbrowse-node: no command {word:?}\n{out}");
        std::process::exit(2);
    }
    // One node to a home, held from before it reads its key: a second one started while the first is still coming up
    // (the window starting one each time nothing answers, while the first waits on the owner at the keystore's dialog)
    // stops here, rather than ask the owner everything again and fight the first for the port. One an update or a
    // restart starts waits for the node it replaces to let go.
    let wait = if update::handed_over() { std::time::Duration::from_secs(60) } else { std::time::Duration::ZERO };
    let _running = match store::hold_node(wait) {
        Ok(Ok(held)) => Some(held),
        Ok(Err(pid)) => {
            let who = pid.map(|p| format!(" (pid {p})")).unwrap_or_default();
            eprintln!("unbrowse-node: a node is already running or starting here{who}: that one serves, and this one stops");
            update::reached(&format!("it stopped: a node was already running or starting here{who}"));
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("unbrowse-node: couldn't take the node's lock on its home ({e}): starting without it");
            None
        }
    };
    // A newer release unpacked here runs instead of this one.
    update::run_newest();
    // A release on trial notes each step of its start, so a start that doesn't last can be said to have stopped there.
    update::reached("it started");
    // Settings a newer node wrote stop this one from starting: run on the defaults instead, it could turn back on
    // what the owner turned off there.
    if let Err(e) = store::settings_readable() {
        eprintln!("{e}");
        std::process::exit(1);
    }
    passkey::announce();
    autolist::announce();
    terms::announce();
    // The browsers a node of this home launched itself (walks, tries, a bridge's visit) close with it. A node that died
    // never closed those it had open, and nothing else will: they go before this one launches any.
    let reaped = agent_browser_core::cdp::launched::keep_records_in(&store::home().join("browsers-launched"));
    if reaped > 0 {
        eprintln!("unbrowse-node: closed {reaped} browsers a node of this home left running when it stopped");
    }
    let reaped = unbrowse_learn::mint::close_program_sessions(&store::home());
    if reaped > 0 {
        eprintln!("unbrowse-node: closed {reaped} browser program sessions a node of this home left running when it stopped");
    }
    // The browsers outlive a restart, and so do the pages that hold a secret and the tabs scripts ran in.
    browse::restore_holds();
    // While a card sits in a checkout of a site, nothing the node sends reaches that site (`unbrowse_learn::hold`).
    // A checkout hold outlives a restart: read back before anything is sent.
    payhold::seal_from(|| root_store().ok().and_then(|k| unbrowse_core::RootKey::load(k.as_ref()).ok()));
    payhold::restore();
    // The challenge tool's pictures left beyond their bound by the last run.
    challenge::tidy_shots();
    browse::hold_requests_where_a_card_sits();
    browse::find_browsers();
    unbrowse_learn::egress::allow_private(store::load_settings().private_network);
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    rt.block_on(async {
        let keys = match root_store() {
            Ok(k) => k,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };
        let port = store::api_port();
        let owner_token = match api::owner_token() {
            Ok(t) => t,
            Err(e) => {
                eprintln!("making the owner's token: {e}");
                std::process::exit(1);
            }
        };
        let node = Arc::new(Node {
            keys,
            identity: std::sync::RwLock::new(None),
            info: NodeInfo { name: host_name(), version: env!("CARGO_PKG_VERSION").into(), api_port: port, dev: DEV },
            walks: learn::Walks::default(),
            chain: chain::Chain::default(),
            chain_error: std::sync::Mutex::new(None),
            events: api::Events::default(),
            net: std::sync::OnceLock::new(),
            share: share::Share::kept(&store::home()),
        });
        // The browser walks and browsing launch, when there is one. None is fetched here: the browser is an add-on,
        // fetched the first time something needs it (`browsers::ensure`) or by `unbrowse browser install`, and the
        // node serves everything else without it.
        browsers::apply();
        // The owner's per-site egress pins: the browser and the browserless calls leave through one address each.
        store::apply_proxies();
        update::run(node.clone());
        // The first Keychain read can wait on a macOS dialog for as long as the owner takes, so it runs on its own
        // thread and nothing else holds for it.
        let n = node.clone();
        std::thread::spawn(move || {
            keep_opening(
                || open_identity(n.keys.as_ref()),
                |read| {
                    if read.is_ok() {
                        update::reached("it opened its key");
                    }
                    *n.identity.writing() = Some(read);
                    n.events.emit("identity", ());
                },
                std::thread::sleep,
            );
        });
        // Once the key is readable, the node says it started: signed by that key, and naming its owner if linked.
        let n = node.clone();
        tokio::spawn(async move {
            while !n.unlocked() {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            if n.unlocked() {
                if let Ok(me) = identity(&n) {
                    link::note_joined(&me.address);
                }
                link::tell(&n, "node_started");
                // The first agent key, made by the node itself so agents connect with no key for the owner to make
                // (`unb connect`); local, no chain write. Then its grants kept current, hourly.
                if let Ok(keys) = n.key() {
                    // Card security codes an older node kept, or kept before the owner turned keeping them off (#185).
                    if let Ok(keep) = vault_keep(Ok(keys as &dyn KeyStore)) {
                        vault::forget_unchosen_codes(&keep, store::load_settings().keep_card_codes);
                    }
                    match agents::ensure_first(keys, n.info.api_port) {
                        Ok(Some(a)) => eprintln!("agents: made the first agent key, {} (`unbrowse connect` registers it with Claude Code)", a.name),
                        Ok(None) => {}
                        Err(e) => eprintln!("agents: couldn't make the first agent key: {e}"),
                    }
                }
                sync::keep_running("agents", move || {
                    let n = n.clone();
                    async move {
                        loop {
                            agents::keep_granted(&n).await;
                            // A copy's credit goes final a week after its first paid use: an hourly look is ample.
                            if let Ok(keys) = n.key() {
                                if let Err(e) = listing::contest(&n.chain, keys).await {
                                    eprintln!("listing: contesting a credit: {e}");
                                }
                            }
                            tokio::select! {
                                _ = tokio::time::sleep(std::time::Duration::from_secs(3_600)) => {}
                                _ = link::SIGNED_IN.notified() => {}
                            }
                        }
                    }
                })
                .await;
            }
        });
        // Pages agents left open close once they go idle, whatever the chain is doing: a node whose chain doesn't answer
        // still runs browsers. Closing one waits on the site's browser, so it stays off the runtime's threads.
        tokio::spawn(async {
            loop {
                tokio::time::sleep(browse::SWEEP_EVERY).await;
                let _ = tokio::task::spawn_blocking(browse::sweep_idle).await;
            }
        });
        // What walks and browsing leave on disk is kept under its caps (`prune`): the walks' captures, the profiles'
        // caches. As the node starts, once the browsers a dead node left are closed, and hourly after.
        let n = node.clone();
        tokio::spawn(async move {
            loop {
                let needed = prune::needed_walks(&n.walks);
                let _ = tokio::task::spawn_blocking(move || prune::run(&needed)).await;
                tokio::time::sleep(prune::EVERY).await;
            }
        });
        // This node's own remote MCP address, while the owner has it on (`unbrowse-node remote on`). It needs no chain
        // and no peer network: it starts with the node, not after the chain.
        let remote = node.clone();
        tokio::spawn(sync::keep_running("remote", move || remote::keep_attached(remote.clone())));
        // A sign-in with a kept passkey that waits on the owner's yes asks them as any ask does (`passkey`).
        passkey::set_node(node.clone());
        // A sign-in's own request, read from the owner's browsing, is sealed in the vault under the node's key (`setups`).
        setups::set_node(node.clone());
        // The chain: start it, then claim what agents paid for, once a minute (FR-6b: claimed automatically,
        // batched, always inside the payer's window). Each step that can fail at boot is tried again until it
        // works, so a node that booted while its chain didn't answer comes all the way up once it does.
        let n = node.clone();
        tokio::spawn(async move {
            start_chain(&n).await;
            let peers = n.clone();
            tokio::spawn(sync::keep_running("peers", move || join_peers(peers.clone(), port)));
            let watched = n.clone();
            tokio::spawn(sync::keep_running("what the node took", move || {
                let n = watched.clone();
                async move { watch_what_it_took(&n).await }
            }));
            sync::keep_running("claims", move || {
                let n = n.clone();
                async move { claim_loop(&n).await }
            })
            .await;
        });
        eprintln!("unbrowse-node: agents and the window reach this node at 127.0.0.1:{port}");
        telemetry::start(&node.info.version, DEV, start.as_ref().and_then(|f| f.as_deref()));
        report::start(&node.info.version, DEV, &node.info.name);
        // A stop the owner or the system asks for (SIGTERM from a service stop or a logout, SIGINT from the terminal,
        // SIGHUP when it closes) is a clean one: the node tells its peers it is leaving before it goes, so it drops
        // out of every lookup at once rather than when its records lapse. A crash says nothing; the records' short
        // life covers it.
        tokio::select! {
            served = api::serve(node.clone(), port, owner_token) => {
                if let Err(e) = served {
                    eprintln!("agent API: {e}");
                    update::reached(&format!("it stopped: agent API: {e}"));
                    peers::leave(&node).await;
                    close_own_browsers();
                    std::process::exit(1);
                }
            }
            why = stop_asked() => {
                eprintln!("unbrowse-node: {why}: leaving the peer network and stopping");
                peers::leave(&node).await;
                close_own_browsers();
                std::process::exit(0);
            }
        }
    });
}

/// Closes every browser this node launched itself and still has open, before it exits: an exit runs no other thread's
/// close, so a walk or a try in flight would leave its browser running after the node.
fn close_own_browsers() {
    let closed = agent_browser_core::cdp::launched::close_all();
    if closed > 0 {
        eprintln!("unbrowse-node: closed the {closed} browsers its walks still had open");
    }
    // And the browser program's daemons its commands started, which outlive a command by design.
    let closed = unbrowse_learn::mint::close_program_sessions(&store::home());
    if closed > 0 {
        eprintln!("unbrowse-node: closed the {closed} browser program sessions it had started");
    }
}

/// Resolves when the owner or the system asks the node to stop, naming how.
async fn stop_asked() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup())) else {
            return std::future::pending().await;
        };
        tokio::select! {
            _ = term.recv() => "asked to stop (SIGTERM)",
            _ = int.recv() => "interrupted (SIGINT)",
            _ = hup.recv() => "its terminal closed (SIGHUP)",
        }
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        let (Ok(mut c), Ok(mut close), Ok(mut shutdown)) = (windows::ctrl_c(), windows::ctrl_close(), windows::ctrl_shutdown()) else {
            return std::future::pending().await;
        };
        tokio::select! {
            _ = c.recv() => "interrupted (Ctrl-C)",
            _ = close.recv() => "its console closed",
            _ = shutdown.recv() => "the system is shutting down",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `unbrowse start --from <tag>` reaches the node as `--from <tag>`: that alone starts it, with the tag, as no words
    /// do. A wrong or missing tag still starts it (the warning is telemetry's); anything more is a command, not a start.
    #[test]
    fn from_alone_starts_the_node() {
        let w = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(start_words(&w(&[])), Some(None));
        assert_eq!(start_words(&w(&["--from", "hn-e"])), Some(Some("hn-e".into())));
        assert_eq!(start_words(&w(&["--from=hn-e"])), Some(Some("hn-e".into())));
        assert_eq!(start_words(&w(&["--from", "Not A Tag"])), Some(Some("Not A Tag".into())), "a wrong tag still starts it");
        assert_eq!(start_words(&w(&["--from"])), Some(Some(String::new())), "no tag still starts it");
        for not_a_start in [&["telemetry"][..], &["--help"], &["--from", "hn", "wallet"], &["wallet", "--from", "hn"], &["--frm", "hn"], &["start"]] {
            assert_eq!(start_words(&w(not_a_start)), None, "{not_a_start:?}");
        }
    }

    /// While the root key is in the OS keystore, an agent's token leaves it only on the owner's yes, asked apart for each
    /// agent, the node's first key included: a no leaves nothing behind, a yes is kept as that agent's grant and isn't
    /// asked again, and holding one agent's grant gets no other agent's token. A revoked key's grant goes. A root key in
    /// a plain file is this user's already, and nothing is asked.
    #[test]
    fn agent_token_requires_owner_for_other_key() {
        let _home = store::scratch_home("handout");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let first = agents::ensure_first(&keys, 7788).unwrap().expect("the node's first key");
        let (other, _) = agents::create(&keys, "other", 1.0, 30, 7788).unwrap();

        owner_dialog::answer_in_test(Some(false));
        assert!(matches!(hand_out_token(&keys, false, Some(other.index)), Err(Handout::Refused(_))));
        assert!(agents::read_grant(other.index).is_none(), "a no keeps nothing");
        assert!(owner_dialog::asked_in_test().last().unwrap().contains("\"other\""), "the question names the agent");

        owner_dialog::answer_in_test(Some(true));
        let token = hand_out_token(&keys, false, Some(other.index)).unwrap();
        assert_eq!(agents::read_grant(other.index).as_deref(), Some(token.as_str()), "a yes is kept as the agent's grant");
        let asked = owner_dialog::asked_in_test().len();
        assert_eq!(hand_out_token(&keys, false, Some(other.index)).unwrap(), token);
        assert_eq!(owner_dialog::asked_in_test().len(), asked, "a granted agent isn't asked about again");

        // Holding one agent's grant gets no other: the node's first key, by number or as the first, is asked about apart.
        owner_dialog::answer_in_test(Some(false));
        assert!(hand_out_token(&keys, false, Some(first.index)).is_err());
        assert!(hand_out_token(&keys, false, None).is_err());
        assert!(agents::read_grant(first.index).is_none() && !agents::first_path().exists());

        agents::revoke(other.index).unwrap();
        assert!(agents::read_grant(other.index).is_none(), "a revoked key's grant goes");

        // A root key in a plain file: this user's programs read it already, and the answer doesn't change that.
        owner_dialog::answer_in_test(Some(false));
        assert!(hand_out_token(&keys, true, None).is_ok());
        assert!(agents::first_path().exists(), "the first key's grant says which key it is");
    }

    /// Two first runs at once make one key, with its own seed words: whoever waited takes the key the other made.
    #[test]
    fn two_first_runs_make_one_key_with_its_words() {
        let home = store::scratch_home("first-key");
        for round in 0..64 {
            let key = home.join(format!("root-{round}.key"));
            let both = std::sync::Barrier::new(2);
            let ids: Vec<String> = std::thread::scope(|s| {
                let run = || {
                    store::use_home(&home);
                    let keys = FileStore::new(key.clone(), None);
                    both.wait();
                    first_key(&keys).unwrap().address.to_checksum()
                };
                let (a, b) = (s.spawn(run), s.spawn(run));
                vec![a.join().unwrap(), b.join().unwrap()]
            });
            assert_eq!(ids[0], ids[1], "round {round}: each run took another key");
            let keys = FileStore::new(key, None);
            let words = keys.seed().unwrap().expect("its seed words");
            let made = unbrowse_core::seed::key_of(&words).unwrap();
            assert_eq!(made.as_slice(), keys.get().unwrap().unwrap().as_slice(), "round {round}: the words make the key beside them");
        }
    }

    /// Every shell write other than a setting that changes what the owner's window asks about maps to that command,
    /// and the owner is asked the same question: a coin listing default raised, a session from a file, deleting or moving a login, a card or a
    /// passkey, ending a checkout hold. A read asks nothing. (Settings are asked about where they are written:
    /// `a_shell_command_that_loosens_a_setting_asks_first_whichever_command_it_is`.)
    #[test]
    fn every_cli_write_asks_what_its_owner_command_asks() {
        let _home = store::scratch_home("cli-asks");
        let asks = |argv: &[&str]| shell_write(argv).and_then(|(cmd, a)| commands::asks_the_owner(cmd, &a));
        for argv in [
            &["coin", "dev-buy", "500"][..],
            &["passkey", "remove", "pk1"],
            &["session", "import", "shop.example"],
            &["session", "import", "shop.example", "--from", "cookies.txt"],
            &["vault", "remove", "shop.example", "me@x.example"],
            &["vault", "rotate", "shop.example", "me@x.example"],
            &["vault", "card", "remove", "visa"],
            &["checkout", "done", "shop.example"],
            &["checkout", "dismiss", "shop.example"],
            &["checkout", "dismiss", "all"],
        ] {
            assert!(asks(argv).is_some(), "{argv:?} asks the owner");
        }
        assert!(asks(&["session", "import", "shop.example", "--from", "cookies.txt"]).is_some_and(|q| q.contains("may not be you")));
        for argv in [&["coin", "dev-buy", "0"][..], &["vault", "list"], &["share"], &["update"], &["checkout", "list"]] {
            assert!(asks(argv).is_none(), "{argv:?} takes away or reads, and asks nothing");
        }
    }

    /// A shell's command that loosens a setting the window's `save_settings` asks about waits on the owner's yes,
    /// whichever command it is: the rule is at the write (`store::ask_before_shell_writes`), so the network and stake
    /// switches, the per-day listing count ask as surely as the money settings. On the owner's
    /// no nothing is written; one that only takes away asks nothing; on a yes it is written.
    #[test]
    fn a_shell_command_that_loosens_a_setting_asks_first_whichever_command_it_is() {
        let _home = store::scratch_home("cli-settings-ask");
        let mut s = store::load_settings();
        s.share_routes = store::ShareMode::Off;
        s.passkeys = false;
        s.chain = chain::names()[0].into();
        store::save_settings(&s).unwrap();
        // As `main` sets it for a shell's command, here asking in the dialog whatever keeps the key.
        store::ask_before_shell_writes_in_test(Some(|to| shell_settings_question(to).map_or(Ok(()), |q| owner_dialog::ask_present(&q))));
        owner_dialog::answer_in_test(Some(false));
        let args = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let before = serde_json::to_value(store::load_settings()).unwrap();
        let other_chain = chain::names().into_iter().find(|n| *n != chain::names()[0]).unwrap();
        let refused = [
            ("share per-day 50", share_cli(&args(&["per-day", "50"]))),
            ("share all", share_cli(&args(&["all"]))),
            ("max-fetch 1000", max_fetch_cli(&args(&["1000"]))),
            ("agent bearer on", agent_bearer_cli(&args(&["on"]))),
            ("network kept on", network_cli(&args(&["kept", "on"]))),
            ("passkey on", passkey_cli(&args(&["on"]))),
            ("update channel canary", update_cli(&args(&["channel", "canary"]))),
            ("chain <another>", chain_cli(&args(&[other_chain]))),
        ];
        for (cmd, code) in refused {
            assert_ne!(code, 0, "{cmd} went ahead on the owner's no");
        }
        assert_eq!(serde_json::to_value(store::load_settings()).unwrap(), before, "nothing was written");
        assert_eq!(owner_dialog::asked_in_test().len(), refused.len(), "each asked once");
        // Taking away asks nothing.
        assert_eq!(share_cli(&args(&["off"])), 0);
        assert_eq!(max_fetch_cli(&args(&["0"])), 0);
        assert_eq!(owner_dialog::asked_in_test().len(), refused.len());
        owner_dialog::answer_in_test(Some(true));
        assert_eq!(share_cli(&args(&["per-day", "50"])), 0);
        assert_eq!(store::load_settings().list_per_day, Some(50), "written on the owner's yes");
        store::ask_before_shell_writes_in_test(None);
        owner_dialog::answer_in_test(None);
    }

    /// A live route's record is what its entry names, so deleting it would strand the entry on the chain. It delists first.
    #[test]
    fn a_route_live_on_the_network_is_never_deleted_from_under_its_entry() {
        let _home = store::scratch_home("delete-live");
        let route = |id: &str, live: Option<bool>| -> store::Route {
            let mut r: store::Route = serde_json::from_value(serde_json::json!({
                "id": id, "site": "shop.example", "what": "list items", "method": "GET", "path": "/items", "root": "https://shop.example/", "inputs": [],
                "steps": 0, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1, "graph": { "steps": [], "provisional": false }
            }))
            .unwrap();
            r.listing = live.map(|live| store::Listing { entry_id: "0x1".into(), tx: "0x2".into(), listed_at: 1, live });
            r
        };
        store::save_route(&route("live", Some(true))).unwrap();
        store::save_route(&route("ended", Some(false))).unwrap();
        store::save_route(&route("plain", None)).unwrap();
        assert!(delete_route("live".into()).unwrap_err().contains("delist"));
        assert!(store::load_route("live").is_some());
        delete_route("ended".into()).unwrap();
        delete_route("plain".into()).unwrap();
    }

    /// Signing out of a site leaves nothing a walk could mint back: the jar and the host's browser profile go together.
    #[test]
    fn signing_out_leaves_no_session_for_the_next_walk_to_bring_back() {
        let _home = store::scratch_home("sign-out");
        let host = "shop.example";
        std::fs::create_dir_all(store::jar_path(host).parent().unwrap()).unwrap();
        store::write_json(&store::jar_path(host), &unbrowse_files::JAR, &std::collections::BTreeMap::from([("sid", "abc")])).unwrap();
        std::fs::create_dir_all(store::profile_dir(host).join("Default")).unwrap();
        std::fs::write(store::profile_dir(host).join("Default").join("Cookies"), "the session").unwrap();
        forget_session(host.into()).unwrap();
        assert!(!store::jar_path(host).exists());
        assert!(!store::profile_dir(host).exists());
    }

    /// A node on this machine's port that answers `status` with `body` once it has read the command.
    fn node_answering(status: &'static str, body: &'static str) -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/owner/restart", l.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut s, _) = l.accept().unwrap();
            // The whole command, read until the client has nothing more to send.
            s.set_read_timeout(Some(std::time::Duration::from_millis(300))).unwrap();
            let mut buf = [0u8; 4096];
            let mut got = Vec::new();
            while let Ok(n) = s.read(&mut buf) {
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
            }
            // Signed as the node signs, with the token the tests send ("t"), over the nonce the request carried.
            let head = String::from_utf8_lossy(&got).to_ascii_lowercase();
            let nonce = head.lines().find_map(|l| l.strip_prefix("x-unbrowse-nonce:")).unwrap_or_default().trim().to_string();
            let code: u16 = status.split(' ').next().unwrap().parse().unwrap();
            let mac = hex::encode(unbrowse_core::signed::reply_mac("t", code, &unbrowse_core::signed::body_hash(body.as_bytes()), &nonce));
            let _ = write!(s, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nx-unbrowse-reply: {mac}\r\nconnection: close\r\n\r\n{body}", body.len());
        });
        url
    }

    /// `update` checks for itself only when no node is running, and `restart` says the node isn't running only then. A
    /// node still on the command past the wait, or one refusing it in words that read like "start the node first", is
    /// running: the old test of the error's first words took both for no node, so `update` fetched a release beside a
    /// node fetching it, and `restart` told the owner to start a node that was up.
    #[test]
    fn only_a_refused_connection_reads_as_no_node() {
        let wait = std::time::Duration::from_millis(500);
        // Something listens and never answers: a node busy past the wait.
        let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/owner/update_now", busy.local_addr().unwrap());
        let held = std::thread::spawn(move || {
            let s = busy.accept().unwrap();
            std::thread::sleep(std::time::Duration::from_secs(2));
            drop(s);
        });
        assert!(matches!(ask_at(&url, "t", serde_json::json!({}), wait), Err(Unanswered::Node(_))), "a node busy past the wait is running");
        held.join().unwrap();

        // The node refused it, whatever its words.
        let url = node_answering("409 Conflict", r#"{"error":"the node isn't answering: start it first"}"#);
        match ask_at(&url, "t", serde_json::json!({}), std::time::Duration::from_secs(5)) {
            Err(Unanswered::Node(e)) => assert_eq!(e, "the node isn't answering: start it first", "the node's own words come back"),
            other => panic!("a refusal is the node's answer: {other:?}"),
        }
        let url = node_answering("200 OK", r#"{"into":"v1"}"#);
        assert_eq!(ask_at(&url, "t", serde_json::json!({}), std::time::Duration::from_secs(5)).unwrap()["into"], "v1");

        // Nothing on the port: no node.
        let gone = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/owner/restart", gone.local_addr().unwrap());
        drop(gone);
        assert!(matches!(ask_at(&url, "t", serde_json::json!({}), wait), Err(Unanswered::NoNode(_))), "nothing listening is no node");
    }

    /// The command and the node's window on the site are one span, whatever is asked: the command never says nothing was
    /// kept with a passkey still to come, or waits on past a window that closed.
    #[test]
    fn enrolling_waits_exactly_as_long_as_the_site_is_armed() {
        assert_eq!(enrol_span(30), (1, 60));
        assert_eq!(enrol_span(61), (2, 120));
        assert_eq!(enrol_span(600), (10, 600));
        assert_eq!(enrol_span(7200), (30, 1800));
        assert_eq!(enrol_span(0), (1, 60));
    }

    fn opened() -> IdentityView {
        IdentityView { address: "0xabc".into(), created: false }
    }

    /// A key store that fails at boot is tried again, further and further apart, until it opens: nothing else ever asks
    /// again, and lines would pass their claim window with the node up and saying nothing.
    #[test]
    fn a_key_store_that_failed_at_boot_is_tried_again_until_it_opens() {
        let (mut tries, mut said, mut waits) = (0, Vec::new(), Vec::new());
        keep_opening(
            || {
                tries += 1;
                if tries < 4 { Err("the keyring isn't up".to_string()) } else { Ok(opened()) }
            },
            |read| said.push(read.is_ok()),
            |gap| waits.push(gap.as_secs()),
        );
        assert_eq!(said, [false, false, false, true], "each try is said, so the window hears the moment it opens");
        assert_eq!(waits, [60, 120, 240]);
    }

    /// Only a read still under way waits on a dialog. One that failed has no dialog to allow, and agents told to allow one
    /// wait for good.
    #[test]
    fn a_key_that_failed_to_open_never_says_to_allow_a_dialog() {
        assert_eq!(why_locked(&None), WAITING_FOR_KEY);
        let failed = why_locked(&Some(Err("the keyring isn't up".into())));
        assert!(failed.contains("the keyring isn't up") && !failed.contains("dialog"), "{failed}");
    }

    /// What the running node took at its start, changed since: the key under it, or the owner's word on the network. Each
    /// reaches the swarm, the claims and the agents' keys only through a restart.
    #[test]
    fn a_change_to_what_the_node_took_at_its_start_restarts_it() {
        let took = |joined| Took { address: "0xABC".into(), joined };
        assert_eq!(restart_for(&took(Some(false)), "0xabc", false, false), None, "the same key, however it is written");
        assert!(restart_for(&took(Some(false)), "0xdef", false, false).unwrap().contains("key changed"));
        assert!(restart_for(&took(None), "0xdef", false, false).is_some(), "on the network or not: the agents' keys were made from it");
        assert!(restart_for(&took(Some(false)), "0xabc", true, false).unwrap().contains("off the peer network"));
        assert_eq!(restart_for(&took(None), "0xabc", true, false), None, "kept off, and not on it");
        assert!(restart_for(&took(Some(false)), "0xabc", false, true).is_some(), "light from now on");
        assert_eq!(restart_for(&took(None), "0xabc", false, true), None, "it joins light by itself");
    }

    #[test]
    fn a_settings_save_from_a_window_never_changes_the_acknowledgement() {
        store::scratch_home("terms-kept");
        accept_terms(false).unwrap();
        let kept = store::load_settings().terms_accepted;
        assert_eq!(kept.as_deref(), Some(terms::TERMS_VERSION));
        // A window's last read, from before the owner acknowledged in a shell.
        save_settings(store::Settings { terms_accepted: None, paused: true, ..store::load_settings() }).unwrap();
        assert_eq!(store::load_settings().terms_accepted, kept, "the save can't take it back");
        assert!(store::load_settings().paused, "and the rest of it is kept");
        // Nor can it make one: only the owner's answer does.
        store::scratch_home("terms-not-made");
        let saved = save_settings(store::Settings { terms_accepted: Some(terms::TERMS_VERSION.into()), ..store::Settings::default() }).unwrap();
        assert_eq!(saved.terms_accepted, None);
        assert!(!network_on());
    }

    /// A different key never goes in over what the old one made: nothing changes, and the owner is told what is at stake.
    #[test]
    fn a_different_key_is_refused_while_the_home_holds_what_the_old_one_made() {
        store::scratch_home("restore-keeps-the-data");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let before = chain::owner_address(&keys).unwrap();
        let other = [7u8; 32];
        assert!(no_data_left_behind(&keys, &other).is_ok(), "a home with nothing in it goes on");
        agents::ensure_first(&keys, 7788).unwrap();
        agents::create(&keys, "mine", 1.0, 30, 7788).unwrap();
        assert!(no_data_left_behind(&keys, &other).is_ok(), "nor does an agent key hold it back: it follows the root key");
        let keep = vault_keep(Ok(&keys as &dyn KeyStore)).unwrap();
        vault::add(&keep, "shop.example", "me", "derived", None, "You").unwrap();
        let why = no_data_left_behind(&keys, &other).unwrap_err();
        assert!(why.contains("nothing was changed") && why.contains("1 login"), "{why}");
        let words = "legal winner thank year wave sausage worth useful legal winner thank yellow";
        assert!(restore_root(&keys, words).err().is_some_and(|e| e.contains("nothing was changed")), "the restore itself refuses");
        let same: [u8; 32] = keys.get().unwrap().unwrap().as_slice().try_into().unwrap();
        assert!(no_data_left_behind(&keys, &same).is_ok(), "the same key loses nothing");
        assert_eq!(chain::owner_address(&keys).unwrap(), before);
    }

    #[test]
    fn what_a_key_holds_is_said_by_what_it_is() {
        assert!(made_under_this_key(0, 0, 0, 0).is_empty());
        let said = made_under_this_key(2, 1, 3, 4).join(", ");
        for part in ["2 logins", "1 secret", "3 passkeys", "4 routes"] {
            assert!(said.contains(part), "{said}");
        }
    }

    #[test]
    fn a_route_listed_live_is_delisted_before_it_is_deleted() {
        store::scratch_home("delete-listed");
        let mut r: store::Route = serde_json::from_value(serde_json::json!({
            "id": "listed-1", "site": "shop.example", "what": "list items", "method": "GET", "path": "/api/items",
            "root": "https://shop.example/", "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false,
            "provisional": false, "learned_at": 1, "graph": { "steps": [], "provisional": false }
        }))
        .unwrap();
        r.listing = Some(store::Listing { entry_id: "0x1".into(), tx: "0x2".into(), listed_at: 1, live: true });
        store::save_route(&r).unwrap();
        assert!(delete_route("listed-1".into()).unwrap_err().contains("delist it first"));
        assert!(store::load_route("listed-1").is_some(), "the record its entry needs is kept");
        store::update_route("listed-1", |r| r.listing.as_mut().unwrap().live = false).unwrap();
        delete_route("listed-1".into()).unwrap();
        assert!(store::load_route("listed-1").is_none());
    }

    /// The owner's rule (TRUST-03.6): the switch that keeps a node off the network keeps its chain work running, so
    /// claims, staking and top-ups go on; only a locked identity holds the pass back.
    #[test]
    fn the_chain_pass_runs_while_the_node_is_off_the_network() {
        store::scratch_home("chain-pass-off");
        accept_terms(true).unwrap();
        assert!(!network_on(), "kept off the network");
        assert!(chain_pass_runs(true, terms::standing(&store::load_settings())), "the pass runs off the network");
        for standing in [terms::Standing::Joins, terms::Standing::KeptOff, terms::Standing::TermsDue] {
            assert!(chain_pass_runs(true, standing), "{standing:?}: runs once unlocked");
            assert!(!chain_pass_runs(false, standing), "{standing:?}: waits while locked");
        }
    }

    #[test]
    fn a_node_is_on_the_network_only_once_its_owner_answers_and_doesnt_keep_it_off() {
        store::scratch_home("terms-answer");
        assert!(!network_on(), "a new node holds off");
        accept_terms(true).unwrap();
        assert!(!network_on(), "kept off");
        accept_terms(false).unwrap();
        assert!(network_on());
    }

    /// The owner's folder takes over the Keychain's root key, so a dev build keeps the owner's identity; a scratch
    /// folder makes its own, so it never runs as the owner's node.
    /// A scratch node that sets `$HOME` to its own folder isn't the owner's node, so it doesn't take the owner's key.
    #[cfg(unix)]
    #[test]
    fn the_owners_home_is_the_systems_word_not_homes() {
        let real = account_home();
        assert!(real.is_absolute() && real.as_os_str().len() > 1, "{real:?}");
        let scratch = std::path::Path::new("/tmp/not-the-owner");
        assert!(!takes_keychain_key(&scratch.join(".unbrowse"), &account_home()), "a home under a scratch $HOME");
        assert!(takes_keychain_key(&real.join(".unbrowse"), &account_home()));
    }

    /// A release node keeps its root key in the system's keystore wherever its folder is. A plain file is for a dev
    /// build, for a machine with no keystore to keep it, and for a folder of the node's own whose owner asked for one
    /// (`UNBROWSE_ROOT_KEY_FILE=1`); asking never moves the owner's own folder's key out of the keystore.
    #[test]
    fn a_release_node_keeps_its_root_key_in_the_keystore_unless_asked() {
        let kept = || false;
        assert!(!root_goes_in_a_file(false, false, false, false, false, kept), "a folder of its own, not asked");
        assert!(root_goes_in_a_file(false, false, true, false, false, kept), "a folder of its own, asked");
        assert!(!root_goes_in_a_file(false, true, false, false, false, kept), "the owner's folder");
        assert!(!root_goes_in_a_file(false, true, true, false, false, kept), "the owner's folder, asked");
        assert!(root_goes_in_a_file(false, true, false, false, true, || true), "no keystore to keep it");
        // A dev build is as it was: a file, wherever it runs and whatever was asked.
        for (the_owners, asked) in [(false, false), (false, true), (true, false), (true, true)] {
            assert!(root_goes_in_a_file(true, the_owners, asked, false, false, kept));
        }
    }

    /// In the owner's own folder the keystore keeps the key, and a `root.key` lying there does not take its place: any
    /// program of this user can write that file, with no prompt, and a node that read it would run as whoever wrote
    /// it. The file is passed over out loud, by its path, so a key an earlier build left there is not lost quietly.
    /// On Linux the file is the key there too, as it always was: that is where a machine with no keystore keeps it.
    #[test]
    fn in_the_owners_folder_the_keystore_wins_over_a_key_file_and_says_so() {
        let kept = || false;
        let file = std::path::Path::new("/Users/someone/.unbrowse/root.key");
        let in_file = root_goes_in_a_file(false, true, false, true, false, kept);
        assert!(!in_file, "a file in the owner's folder took the keystore's place");
        let said = ignored_key_file(false, true, true, in_file, file).expect("the file is passed over out loud");
        assert!(said.contains("/Users/someone/.unbrowse/root.key"), "{said}");
        // Nothing to say where no file is passed over: none there, or the file is the key.
        assert_eq!(ignored_key_file(false, true, false, false, file), None);
        assert!(root_goes_in_a_file(false, true, false, true, true, kept), "the owner's folder on Linux");
        assert_eq!(ignored_key_file(false, true, true, true, file), None);
        assert_eq!(ignored_key_file(true, true, true, true, file), None, "a dev build's key is another file");
    }

    /// In a folder of the node's own a root key's file already there is the key, asked for or not, on every system: a
    /// node that turned from it to the keystore would come up as someone else with its key still on disk.
    #[test]
    fn in_a_folder_of_its_own_a_key_file_already_there_is_the_key() {
        let kept = || false;
        for linux in [false, true] {
            let in_file = root_goes_in_a_file(false, false, false, true, linux, kept);
            assert!(in_file, "a folder of its own with its key's file (linux: {linux})");
            assert_eq!(ignored_key_file(false, false, true, in_file, std::path::Path::new("/tmp/scratch-a/root.key")), None);
        }
    }

    /// The system's keystore holds one item per account, not per folder. The owner's own folder keeps the account it
    /// always had; a node in any other folder gets an account of that folder's, so it is never the owner's node under
    /// a second name, and two scratch folders are never each other's.
    #[test]
    fn a_folder_of_its_own_has_a_keystore_account_of_its_own() {
        let user = std::path::Path::new("/Users/someone");
        assert_eq!(keychain_account(&user.join(".unbrowse"), user), KEYCHAIN_ACCOUNT, "the owner's folder is as it was");
        let (a, b) = (keychain_account(std::path::Path::new("/tmp/scratch-a"), user), keychain_account(std::path::Path::new("/tmp/scratch-b"), user));
        assert_ne!(a, KEYCHAIN_ACCOUNT);
        assert_ne!(a, b);
        assert_eq!(a, keychain_account(std::path::Path::new("/tmp/scratch-a"), user), "the same folder, the same account, every run");
    }

    /// A restore in a folder of its own writes three keystore items: the key, its seed words (`<account>.seed`) and
    /// the key it replaced. None is one the owner's node reads or writes, so nothing done there touches the owner's.
    #[test]
    fn a_restore_in_a_folder_of_its_own_never_names_the_owners_items() {
        let user = std::path::Path::new("/Users/someone");
        let previous = "0x00000000000000000000000000000000000000aa";
        let items = |home: &std::path::Path| {
            let account = keychain_account(home, user);
            vec![account.clone(), format!("{account}.seed"), replaced_account(&account, previous)]
        };
        let owners = items(&user.join(".unbrowse"));
        assert_eq!(owners, vec!["root-key".to_string(), "root-key.seed".to_string(), format!("root-key.replaced.{previous}")], "the owner's items are named as they were");
        for item in items(std::path::Path::new("/tmp/scratch-a")) {
            assert!(!owners.contains(&item), "{item}");
            // Nor any other the owner's node could make: its seed words, or a key some other restore of its replaced.
            assert!(!item.starts_with("root-key."), "{item}");
        }
    }

    #[test]
    fn only_the_owners_folder_takes_the_keychains_key() {
        let user = std::path::Path::new("/Users/someone");
        assert!(takes_keychain_key(&user.join(".unbrowse"), user));
        assert!(!takes_keychain_key(std::path::Path::new("/tmp/scratch-node"), user));
        assert!(!takes_keychain_key(&user.join(".unbrowse-b"), user));
    }

    #[test]
    fn hosts_only() {
        assert!(is_host("www.carousell.sg"));
        assert!(is_host("queue.sistic.com.sg"));
        assert!(!is_host("hook-door"));
        assert!(!is_host("../jars"));
        assert!(!is_host("a/b.com"));
        assert!(forget_session("../../etc/passwd".into()).is_err());
        assert!(store::load_route("../x").is_none());
    }

    /// External security review round 2, 2026-11-04, item 4. `unbrowse-node wallet export` reads the key from its
    /// store with no node and no token, so another program running as the owner's user could run it: a key the OS
    /// keystore keeps goes out of the shell only on the owner's yes in the node's own dialog.
    #[test]
    fn the_shell_writes_a_backup_of_a_keystore_key_only_on_the_owners_yes() {
        let _home = store::scratch_home("shell-export");
        let keys = unbrowse_core::MemoryStore::default();
        load_or_create(&keys).unwrap();
        owner_dialog::answer_in_test(None);
        assert!(shell_export_allowed(&keys, false).unwrap_err().contains("dialog"), "no screen: no backup");
        owner_dialog::answer_in_test(Some(false));
        assert!(shell_export_allowed(&keys, false).is_err(), "the owner said no");
        owner_dialog::answer_in_test(Some(true));
        assert!(shell_export_allowed(&keys, false).is_ok());
        assert_eq!(owner_dialog::asked_in_test().len(), 3);
        owner_dialog::answer_in_test(None);
        assert!(shell_export_allowed(&keys, true).is_ok(), "a key in a file is this user's to read already");
        assert_eq!(owner_dialog::asked_in_test().len(), 3, "and nothing is asked");
    }

    /// External security review round 3, 2026-11-04. A program running as the owner could set the owner passphrase
    /// itself while none was set (the default), then answer every question the node asks on a terminal. Setting the
    /// first one takes the owner's yes too: the dialog, or with no screen a code shown on the terminal and typed back.
    /// A no, a wrong code, or nothing typed, and no passphrase is set.
    #[test]
    fn setting_the_first_owner_passphrase_takes_the_owners_yes() {
        let home = store::scratch_home("passphrase-first");
        let keys = unbrowse_core::MemoryStore::default();
        load_or_create(&keys).unwrap();
        let words = "an agent's own words";
        owner_dialog::answer_in_test(Some(false));
        tty::test::type_in(&[words, words]);
        assert!(set_passphrase(&keys).is_err(), "the owner said no in the dialog");
        assert!(owner_dialog::passphrase(&keys).unwrap().is_none(), "and none is set");
        owner_dialog::answer_in_test(None);
        tty::test::type_in(&["a guess", words, words]);
        assert!(set_passphrase(&keys).is_err(), "no screen, and not the code the terminal showed");
        tty::test::type_in(&[]);
        assert!(set_passphrase(&keys).is_err(), "no screen and no terminal");
        assert!(owner_dialog::passphrase(&keys).unwrap().is_none(), "still none set");
        assert!(owner_dialog::asked_in_test().iter().all(|q| q.contains("set the owner passphrase")), "{:?}", owner_dialog::asked_in_test());
        owner_dialog::answer_in_test(Some(true));
        tty::test::type_in(&["the owner's own words", "the owner's own words"]);
        assert!(set_passphrase(&keys).unwrap().starts_with("set"), "the owner's yes in the dialog");
        let _ = std::fs::remove_dir_all(home);
    }

    /// External security review round 3, 2026-11-04. `wallet restore`, `wallet import` and `agent new` change what the
    /// node's key does with no node and no token; with the key in a keystore that keeps it from other programs, each
    /// waits on the owner's yes, as the same commands sent with the owner's token do. No dialog, or a no, and the key is
    /// the one it was and no agent key is made.
    #[test]
    fn the_shell_replaces_the_key_or_makes_an_agent_key_only_on_the_owners_yes() {
        let _home = store::scratch_home("shell-replace");
        let keys = unbrowse_core::MemoryStore::default();
        load_or_create(&keys).unwrap();
        let before = root_address(&keys).unwrap();
        let words = "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";
        let other = unbrowse_core::MemoryStore::default();
        load_or_create(&other).unwrap();
        let pass = "a long passphrase here";
        let backup = export_root(&unbrowse_core::RootKey::load(&other).unwrap(), pass).unwrap().backup;
        for answer in [None, Some(false)] {
            owner_dialog::answer_in_test(answer);
            assert!(restore_from_shell(&keys, false, words).is_err(), "restore with {answer:?}");
            assert!(import_from_shell(&keys, false, &backup, pass).is_err(), "import with {answer:?}");
            assert!(new_agent_key_in(&keys, false, "sly", 900.0, 30).is_err(), "agent new with {answer:?}");
        }
        assert_eq!(root_address(&keys).unwrap(), before, "the key is the one it was");
        assert!(agents::list().is_empty(), "no agent key was made");
        let asked = owner_dialog::asked_in_test();
        assert_eq!(asked.len(), 6, "{asked:?}");
        assert!(asked.iter().any(|q| q.contains("\"sly\"") && q.contains("900")), "the question names the key and its cap: {asked:?}");
        owner_dialog::answer_in_test(Some(true));
        assert!(import_from_shell(&keys, false, &backup, pass).is_ok(), "the owner's yes");
        assert_ne!(root_address(&keys).unwrap(), before);
    }

    /// External security review round 2, 2026-11-04, item 4 (Lewis: no screen must not simply mean refused). A shell
    /// with no screen takes the owner passphrase, typed on its own terminal, as the owner's yes for a backup of a
    /// keystore key; a wrong one or none writes nothing, and with no terminal it is refused.
    #[test]
    fn a_shell_with_no_screen_takes_the_owner_passphrase_on_its_terminal() {
        let home = store::scratch_home("shell-no-screen");
        let keys = unbrowse_core::MemoryStore::default();
        load_or_create(&keys).unwrap();
        owner_dialog::answer_in_test(None);
        let owners = "the owner's own words";
        owner_dialog::keep_passphrase(&unbrowse_core::owner_pass::Record::new_with(&unbrowse_core::RootKey::load(&keys).unwrap(), owners, 10).unwrap()).unwrap();
        tty::test::type_in(&[owners]);
        assert!(shell_export_allowed(&keys, false).is_ok(), "the owner's passphrase on the terminal");
        assert!(tty::test::said().iter().any(|t| t.contains("write a backup of this node's key")), "the terminal showed the question");
        tty::test::type_in(&["not them", "nor these", "nor those"]);
        assert!(shell_export_allowed(&keys, false).is_err(), "three wrong ones");
        tty::test::type_in(&[""]);
        assert!(shell_export_allowed(&keys, false).is_err(), "Enter alone refuses");
        tty::test::type_in(&[]);
        assert!(shell_export_allowed(&keys, false).unwrap_err().contains("terminal"), "no terminal: refused");
        let _ = std::fs::remove_dir_all(home);
    }

    /// `unbrowse-node passphrase` sets the passphrase typed twice on the terminal, sealed with the node's key; changing
    /// it takes the one set now. `unbrowse-node confirm` shows each waiting question there and sends what the owner
    /// types to the node, and Enter alone refuses.
    #[test]
    fn the_owner_sets_the_passphrase_and_answers_on_a_terminal() {
        let home = store::scratch_home("shell-passphrase");
        let keys = unbrowse_core::MemoryStore::default();
        load_or_create(&keys).unwrap();
        // Setting the first one takes the owner's yes: with no screen, the code the terminal shows, typed back.
        tty::test::type_in(&["TESTCODE", "the owner's own words", "the owner's own wordz"]);
        assert!(set_passphrase(&keys).unwrap_err().contains("didn't match"));
        tty::test::type_in(&["TESTCODE", "short", "short"]);
        assert!(set_passphrase(&keys).is_err(), "too short");
        tty::test::type_in(&["TESTCODE", "the owner's own words", "the owner's own words"]);
        assert!(set_passphrase(&keys).unwrap().starts_with("set"));
        let record = owner_dialog::passphrase(&keys).unwrap().expect("kept");
        assert_eq!(record.log_n, unbrowse_core::owner_pass::LOG_N, "at the real cost");
        tty::test::type_in(&["a guess at them"]);
        assert!(set_passphrase(&keys).unwrap_err().contains("isn't the owner passphrase"), "changing it takes the one set now");
        // confirm: what the node lists, answered with what is typed.
        let sent = std::cell::RefCell::new(Vec::new());
        let node = |cmd: &str, body: serde_json::Value| -> Result<serde_json::Value, String> {
            sent.borrow_mut().push((cmd.to_string(), body.clone()));
            match cmd {
                "confirmations" => Ok(serde_json::json!([{ "id": "q1", "question": "Show the phrase?", "seconds_left": 99 }, { "id": "q2", "question": "Export the key?", "seconds_left": 98 }])),
                _ if body["passphrase"] == "typo" => Err("that isn't the owner passphrase: 2 more tries for this question".into()),
                _ if body["passphrase"].is_null() => Ok(serde_json::json!("refused")),
                _ => Ok(serde_json::json!("allowed")),
            }
        };
        tty::test::type_in(&["typo", "the owner's own words", ""]);
        assert_eq!(confirm_on_terminal(0, &node).unwrap(), "allowed\nrefused");
        let sent = sent.into_inner();
        assert_eq!(sent.iter().filter(|(c, _)| c == "confirm").map(|(_, b)| b["id"].as_str().unwrap().to_string()).collect::<Vec<_>>(), ["q1", "q1", "q2"]);
        assert!(tty::test::said().iter().any(|t| t.contains("Export the key?")));
        let _ = std::fs::remove_dir_all(home);
    }

    /// A backup exported on one machine restores on another (a second data dir): the same address, agent keys and
    /// derived passwords. Into a node that already has a key, the key it replaces is kept beside the root key, never
    /// dropped; a wrong passphrase changes nothing; an export never writes over a file.
    #[test]
    fn a_key_backup_restores_the_same_node_on_a_new_machine() {
        let pass = ["backup ", "pass", "phrase"].concat();
        let old_home = store::scratch_home("backup-from");
        let from = unbrowse_core::MemoryStore::default();
        load_or_create(&from).unwrap();
        let root = unbrowse_core::RootKey::load(&from).unwrap();
        let v = export_root(&root, &pass).unwrap();
        assert_eq!(v.address, root.address().to_checksum());
        let file = old_home.join("node.backup.json");
        unbrowse_files::private::create_new(&file, v.backup.as_bytes()).unwrap();
        assert!(unbrowse_files::private::create_new(&file, b"{}").is_err(), "an export never writes over a file");
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&file).unwrap().permissions()) & 0o777, 0o600);

        // A new machine: a fresh data dir and a key store with nothing in it.
        let _new_home = store::scratch_home("backup-to");
        let to = unbrowse_core::MemoryStore::default();
        let backup = std::fs::read_to_string(&file).unwrap();
        assert!(import_root(&to, &backup, "not the passphrase").is_err());
        assert!(to.get().unwrap().is_none(), "a wrong passphrase changes nothing");
        let done = import_root(&to, &backup, &pass).unwrap();
        assert_eq!((done.address.as_str(), done.previous.as_deref()), (v.address.as_str(), None));
        let back = unbrowse_core::RootKey::load(&to).unwrap();
        assert_eq!(back.agent(0).api_token(), root.agent(0).api_token());
        assert_eq!(*back.password("example.com", 0, 20), *root.password("example.com", 0, 20));

        // Into a node that has a key of its own: that key is kept beside the root key first.
        let other = unbrowse_core::MemoryStore::default();
        let theirs = load_or_create(&other).unwrap().address.to_checksum();
        let done = import_root(&other, &backup, &pass).unwrap();
        assert_eq!(done.previous.as_deref(), Some(theirs.as_str()));
        let kept = FileStore::new(store::home().join("devnet").join(format!("root.key.replaced.{theirs}")), None);
        assert_eq!(kept.get().unwrap().map(|k| unbrowse_core::backup::address_of(&k[..].try_into().unwrap()).unwrap().to_checksum()), Some(theirs));
        assert!(kept.seed().unwrap().is_some(), "the replaced key's seed words are kept beside it");
        assert!(other.seed().unwrap().is_none(), "a backup's key comes with no seed words");
    }

    /// 12 seed words restore the address any wallet app opens with them, over an older node's key, which is kept
    /// beside the root key; the node then shows those 12 words. An older node's 24 words still bring it back.
    #[test]
    fn twelve_seed_words_restore_the_wallet_any_wallet_app_opens() {
        let _home = store::scratch_home("seed-words");
        let keys = unbrowse_core::MemoryStore::default();
        keys.set(&[0x11; 32]).unwrap();
        let older = load_or_create(&keys).unwrap().address.to_checksum();
        let older_words = zeroize::Zeroizing::new(unbrowse_core::recovery::phrase(&keys).unwrap().words().to_string());
        assert_eq!(older_words.split(' ').count(), 24, "an older node shows its 24 words");

        let test_words = "test test test test test test test test test test test junk";
        let done = restore_root(&keys, test_words).unwrap();
        assert_eq!((done.address.as_str(), done.previous.as_deref()), ("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", Some(older.as_str())));
        assert_eq!(unbrowse_core::recovery::phrase(&keys).unwrap().words(), test_words);

        let done = restore_root(&keys, &older_words).unwrap();
        assert_eq!(done.address, older);
        assert_eq!(unbrowse_core::recovery::phrase(&keys).unwrap().words(), older_words.as_str());
        let e = restore_root(&keys, "test test test test test test test test test test junk").err().unwrap();
        assert!(e.contains("12 words") && e.contains("24 words") && e.contains("this is 11"), "{e}");
    }

    /// The listing's first buy is on by default, at 1% of the wallet's UNB (`decide.dev-buy-default-on`), and is a share
    /// in basis points from 0 (none) to all of it.
    #[test]
    fn the_listings_first_buy_is_on_at_one_percent_and_a_share_or_none() {
        let _home = store::scratch_home("coin-dev-buy");
        assert_eq!(store::load_settings().coin_dev_buy_bps, 100, "on by default, at 1%");
        assert!(set_coin_dev_buy(10_001).is_err(), "past all of it");
        assert_eq!(store::load_settings().coin_dev_buy_bps, 100, "a refused value changes nothing");
        assert_eq!(set_coin_dev_buy(250).unwrap().bps, 250);
        assert_eq!(store::load_settings().coin_dev_buy_bps, 250);
        let mut bad = store::load_settings();
        bad.coin_dev_buy_bps = 20_000;
        assert!(save_settings(bad).is_err(), "a whole-settings save is held to the same");
        assert_eq!(set_coin_dev_buy(0).unwrap().bps, 0, "off");
        assert_eq!(store::load_settings().coin_dev_buy_bps, 0);
    }

    /// Reads this machine's real profiles and jars; prints what the window would get.
    #[test]
    fn reads_the_node_state() {
        let sites = sites();
        let sessions = sessions();
        println!("{} sites walked: {:?}", sites.len(), sites.iter().map(|s| &s.host).collect::<Vec<_>>());
        println!("{} live sessions: {:?}", sessions.len(), sessions.iter().map(|s| (&s.host, s.cookies)).collect::<Vec<_>>());
        assert!(sites.iter().all(|s| is_host(&s.host)));
    }

    /// End to end on a real site: walk HN search in the node's browser, keep its API call, call it browserless
    /// with a new query. Needs network and Chrome: `cargo test -p unbrowse-node-app -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn learns_and_calls_a_real_route() {
        let walks = learn::Walks::default();
        let view = learn::walk(&walks, "https://hn.algolia.com/?q=rust").expect("walk");
        println!("walked: {} exchanges, {} candidates", view.exchanges, view.candidates.len());
        for c in &view.candidates {
            println!("  #{} {} {}{} {} {}b {:?}", c.index, c.method, c.host, c.path, c.status, c.bytes, c.keys);
        }
        let pick = view.candidates.iter().find(|c| c.keys.iter().any(|k| k == "hits" || k == "results")).expect("the search call");
        let route = learn::keep(&walks, &view.walk, pick.index, "Search stories", &[]).expect("keep");
        println!("route {} {} {} inputs {:?}", route.id, route.method, route.path, route.inputs.iter().map(|i| (&i.name, &i.default)).collect::<Vec<_>>());
        let mut inputs = HashMap::new();
        if let Some(q) = route.inputs.iter().find(|i| i.default.as_deref() == Some("rust")) {
            inputs.insert(q.name.clone(), "tauri".to_string());
        }
        let r = run::call(&route.id, &inputs, "test").expect("call");
        println!("call ok={} {}ms error={:?}", r.ok, r.ms, r.error);
        assert!(r.ok);
        assert_eq!(route.inputs.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["q"], "the page's query is the input");
        let hits = r.data.as_ref().and_then(|d| d.get("hits")).and_then(|h| h.as_array()).expect("hits");
        let first = hits.first().and_then(|h| h.get("title")).and_then(|t| t.as_str()).unwrap_or_default().to_string();
        println!("first hit for \"tauri\": {first}");
        assert!(hits.iter().any(|h| h.to_string().to_lowercase().contains("tauri")), "the new query was used");
        store::delete_route(&route.id).unwrap();
    }

    /// The agent's path, no human choosing: walk a page with a goal, the node picks the call, keeps it, calls it.
    #[test]
    #[ignore]
    fn learns_the_goal_without_a_human() {
        let walks = learn::Walks::default();
        let (route, by) = learn::learn_goal(&walks, "https://hn.algolia.com/?q=rust", "search Hacker News stories").expect("learn");
        println!("hn: picked {} {} {} by {by}", route.method, route.site, route.path);
        assert!(route.site.contains("algolia.net") && route.inputs.iter().any(|i| i.name == "q"));
        let r = run::call(&route.id, &HashMap::from([("q".to_string(), "tauri".to_string())]), "test").unwrap();
        assert!(r.ok);
        store::delete_route(&route.id).unwrap();

        let (route, by) = learn::learn_goal(&walks, "https://unbrowse.ai", "list the sites unbrowse supports").expect("learn");
        println!("unbrowse.ai: picked {} {} {} by {by}", route.method, route.site, route.path);
        assert!(route.path.starts_with("/api/v1/sites"), "picked {}", route.path);
        store::delete_route(&route.id).unwrap();
    }
}
