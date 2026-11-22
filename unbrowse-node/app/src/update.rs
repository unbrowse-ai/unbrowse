//! The node keeps itself current, from metadata shaped after TUF (The Update Framework): three roles, each its own
//! keys and its own file, so no one key, mirror or stale copy decides what a node runs.
//!
//! - **root** names the keys of every role and how many of each must sign (`root/<N>.root.json`). A new root is
//!   signed by enough keys of the one before it and of its own, so a node follows a rotation one version at a time
//!   from the root it trusts. The first root is built in (`builtin_root`): Unbrowse's release key for every role,
//!   until the owner's offline root keys replace it with root 2.
//! - **targets** says what the releases are: each version's package for each machine with the sha512 npm keeps for
//!   it, the oldest version the network takes (`min_version`), the version each channel runs (`stable`, `canary`),
//!   the share of nodes on canary, and a halt that stops every rollout.
//! - **timestamp** is short-lived (a week) and names the one targets file current now, by version and sha256. It is
//!   signed again every day, so a mirror that keeps serving old metadata is caught once its timestamp expires.
//!
//! The three come in the `@unbrowse/updates` package on npm, published again at every release, promotion, halt and
//! daily refresh (`.github/scripts/updates.mjs`). A node keeps the newest of each it checked
//! (`versions/trust.json`) and never takes an older one, so neither the metadata nor the release can be rolled back.
//!
//! Each release goes to canary first, then to stable once promoted. A node is on the channel its owner picks
//! (`update_channel`), else on canary when a stable hash of its identity and the release falls within the canary
//! share: a percentage rollout with no server deciding.
//!
//! A released node checks when it starts and every six hours, and when its owner says so (`unbrowse update`). A newer
//! release is fetched from npm, checked against the metadata, unpacked into `~/.unbrowse/versions/<version>` and
//! named in `versions/current`, and the node restarts into it once no call is in flight. A node started from an older
//! install runs the newest version there instead. A node older than the network's `min_version` stays off the peer
//! network, and its peers refuse it, until it runs a release that is new enough.
//!
//! The owner can turn updates off (`auto_update`). Only a build the release made updates itself (`UNBROWSE_RELEASE`
//! at build time): a dev build, or one built from source, never does.
//!
//! Nodes from before this metadata read a single manifest in the `unbrowse` package, signed by the release key
//! (`Manifest`, `verify`); the release still writes it, so they can update into a node that reads the metadata.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};

use crate::store;
use crate::sync::Locked;

/// The public half of Unbrowse's online release key (Ed25519): targets and timestamp, and root 1 until offline keys
/// exist. Never use it as a successor root key.
const RELEASE_KEY: &str = "45e1a25e4ea96bb07b65176cb2d4a2eb754ce8b8eeb4b1b2164ceaf5fce4b0c6";

/// Offline root public keys. Replace this empty placeholder with the owner's generated public keys before producing
/// a release; private keys are never stored in the repository. See docs/OPERATIONS.md §2 for the ceremony.
const OFFLINE_ROOT_KEYS: &[&str] = &[];
/// Generate distinct offline target and timestamp role keys in the same owner ceremony before the transition.
const OFFLINE_TARGETS_KEYS: &[&str] = &[];
const OFFLINE_TIMESTAMP_KEYS: &[&str] = &[];
#[cfg(test)]
const POST_TRANSITION_TEST_KEY_SEEDS: [u8; 6] = [41, 42, 48, 49, 50, 43];
/// Until the owner completes the offline ceremony, release builds accept the online root only through this UTC date.
const ONLINE_ROOT_ACCEPTED_UNTIL: Option<&str> = Some("2026-12-15");

/// The package on npm the metadata comes in.
pub const METADATA_PACKAGE: &str = "@unbrowse/updates";

/// The version this program is.
pub const RUNNING: &str = env!("CARGO_PKG_VERSION");

/// Set on a node this updater started, so it never hands over again at once.
const HANDED_OVER: &str = "UNBROWSE_UPDATED";

/// The most read from the registry at once: its answers about a version, and a whole package. Nothing the registry
/// sends is trusted before the metadata is checked, so nothing it sends may be unbounded either.
const MAX_ANSWER: u64 = 1 << 20;
const MAX_PACKAGE: u64 = 512 << 20;
/// The most a package may hold unpacked, and any one metadata file.
const MAX_UNPACKED: u64 = 2 << 30;
const MAX_MANIFEST: u64 = 64 << 10;
/// The most roots a node follows in one check: a chain longer than any rotation schedule makes is someone's padding.
const MAX_ROOTS: u64 = 256;

/// A release, as the single signed manifest of nodes before the metadata says.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub version: String,
    pub min_version: String,
    /// By machine (`darwin-arm64`, `linux-x64`, `win32-x64`, …).
    pub platforms: BTreeMap<String, Package>,
    /// The browser add-on's package for each machine (`@unbrowse/browser-<machine>`), apart from the node's since the
    /// browser became optional (`browsers.rs`). A release from before has none; a node from before reads past it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub browsers: BTreeMap<String, Package>,
}

/// A machine's package on npm and the sha512 of its tarball, as npm writes it (`sha512-<base64>`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Package {
    pub name: String,
    pub integrity: String,
}

/// A role's keys (Ed25519 public keys in hex, which are also their ids) and how many of them must sign.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Role {
    pub keys: Vec<String>,
    pub threshold: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Roles {
    pub root: Role,
    pub targets: Role,
    pub timestamp: Role,
}

/// Who signs what, from this version on. `expires` is in seconds since 1970, as every file's is.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Root {
    #[serde(rename = "_type")]
    pub kind: String,
    pub version: u64,
    pub expires: u64,
    pub roles: Roles,
}

/// What the releases are and which one each channel runs.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Targets {
    #[serde(rename = "_type")]
    pub kind: String,
    pub version: u64,
    pub expires: u64,
    pub min_version: String,
    /// Each release a channel names, by version.
    pub releases: BTreeMap<String, Release>,
    pub channels: Channels,
    /// The share of nodes that pick no channel which run canary, in percent.
    #[serde(default)]
    pub canary_share: u8,
    /// Why every rollout is stopped, while it is.
    #[serde(default)]
    pub halt: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Release {
    pub platforms: BTreeMap<String, Package>,
    /// The browser add-on's package for each machine, as in the release's manifest ([`Manifest::browsers`]).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub browsers: BTreeMap<String, Package>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Channels {
    pub stable: String,
    #[serde(default)]
    pub canary: Option<String>,
}

/// The targets file current now, until `expires`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Timestamp {
    #[serde(rename = "_type")]
    pub kind: String,
    pub version: u64,
    pub expires: u64,
    pub targets: Pinned,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Pinned {
    pub version: u64,
    /// The sha256 of the targets file's bytes, in hex.
    pub sha256: String,
}

/// A metadata file: what is signed, and the signatures over its canonical bytes (`canonical`).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Signed {
    signed: Value,
    signatures: Vec<Signature>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Signature {
    keyid: String,
    sig: String,
}

/// The release channel a node runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Canary,
}

impl Channel {
    pub fn parse(s: &str) -> Option<Channel> {
        match s {
            "stable" => Some(Channel::Stable),
            "canary" => Some(Channel::Canary),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Canary => "canary",
        }
    }
}

/// What the window shows of updates.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub running: String,
    /// Updates run in this build, and the owner hasn't turned them off.
    pub enabled: bool,
    /// The newest release this node's channel runs.
    pub latest: Option<String>,
    pub min_version: Option<String>,
    /// This node is older than the network takes.
    pub outdated: bool,
    pub checking: bool,
    /// A newer version unpacked, which the node restarts into once nothing is in flight.
    pub ready: Option<String>,
    pub error: Option<String>,
    /// The channel this node runs, once it has checked.
    pub channel: Option<String>,
    /// Why the rollout is stopped, while the metadata says it is.
    pub halted: Option<String>,
    pub update_root_warning: Option<String>,
}

static STATUS: Mutex<Option<Status>> = Mutex::new(None);

pub fn status() -> Status {
    let mut s = STATUS.locked().clone().unwrap_or_default();
    s.running = RUNNING.into();
    s.enabled = enabled();
    s.update_root_warning = OFFLINE_ROOT_KEYS
        .is_empty()
        .then(|| "update root is a single online key".into());
    s.min_version = s.min_version.or_else(min_version);
    s.outdated = below_minimum();
    s
}

fn set(f: impl FnOnce(&mut Status)) {
    let mut s = STATUS.locked();
    f(s.get_or_insert_with(Status::default));
}

/// Whether this build is one the release made, which alone updates itself.
pub fn released() -> bool {
    release_build_enabled(option_env!("UNBROWSE_RELEASE"))
}

const fn release_build_enabled(value: Option<&str>) -> bool {
    match value {
        Some(value) => str_eq(value, "1"),
        None => false,
    }
}

/// Whether this node updates itself: a released build whose owner hasn't turned updates off.
pub fn enabled() -> bool {
    released() && store::load_settings().auto_update
}

/// This machine, as the packages name it.
pub fn platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

fn version(v: &str) -> Option<semver::Version> {
    semver::Version::parse(v.trim()).ok()
}

/// `a` is a later release than `b`.
pub fn newer(a: &str, b: &str) -> bool {
    matches!((version(a), version(b)), (Some(a), Some(b)) if a > b)
}

fn verify_key(bytes: &[u8], sig: &str, key: &str) -> Result<(), String> {
    let key: [u8; 32] = hex::decode(key)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or("the key isn't a key")?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key).map_err(|e| e.to_string())?;
    let sig = hex::decode(sig.trim()).map_err(|_| "the signature isn't hex")?;
    let sig = ed25519_dalek::Signature::from_slice(&sig).map_err(|_| "the signature isn't one")?;
    key.verify_strict(bytes, &sig)
        .map_err(|_| "the signature isn't the key's".to_string())
}

/// Reads a manifest of the format before the metadata, if `key` signed exactly these bytes (`sig` in hex).
pub fn verify(manifest: &[u8], sig: &str, key: &str) -> Result<Manifest, String> {
    verify_key(manifest, sig, key).map_err(|e| {
        if e.contains("key's") {
            "the manifest isn't signed by Unbrowse's release key".into()
        } else {
            e
        }
    })?;
    serde_json::from_slice(manifest).map_err(|e| format!("the manifest can't be read: {e}"))
}

/// The bytes a metadata file's signatures are over: its `signed` part as JSON with every object's keys in order and
/// no space, so any program that writes JSON this way signs what the node checks (`.github/scripts/updates.mjs`).
pub fn canonical(v: &Value) -> Vec<u8> {
    fn write(v: &Value, out: &mut Vec<u8>) {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                out.push(b'{');
                for (i, k) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    out.extend(serde_json::to_vec(k).expect("a string"));
                    out.push(b':');
                    write(&m[k], out);
                }
                out.push(b'}');
            }
            Value::Array(a) => {
                out.push(b'[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    write(x, out);
                }
                out.push(b']');
            }
            other => out.extend(serde_json::to_vec(other).expect("a value")),
        }
    }
    let mut out = Vec::new();
    write(v, &mut out);
    out
}

/// A metadata file of `kind`, read but not yet checked.
fn read_signed<T: DeserializeOwned>(file: &[u8], kind: &str) -> Result<(Signed, T), String> {
    let s: Signed = serde_json::from_slice(file)
        .map_err(|e| format!("the {kind} metadata can't be read: {e}"))?;
    if s.signed.get("_type").and_then(Value::as_str) != Some(kind) {
        return Err(format!("the {kind} metadata is another role's"));
    }
    let t = serde_json::from_value(s.signed.clone())
        .map_err(|e| format!("the {kind} metadata can't be read: {e}"))?;
    Ok((s, t))
}

/// Whether at least `role.threshold` of `role`'s keys signed `file`, each counted once.
fn signed_by(file: &Signed, role: &Role, what: &str) -> Result<(), String> {
    let bytes = canonical(&file.signed);
    let mut good = BTreeSet::new();
    for s in &file.signatures {
        let id = s.keyid.to_ascii_lowercase();
        if role.keys.iter().any(|k| k.eq_ignore_ascii_case(&id))
            && !good.contains(&id)
            && verify_key(&bytes, &s.sig, &id).is_ok()
        {
            good.insert(id);
        }
    }
    if role.threshold == 0 || good.len() < role.threshold {
        return Err(format!(
            "the {what} isn't signed by {} of the {} keys that sign it",
            role.threshold.max(1),
            role.keys.len()
        ));
    }
    Ok(())
}

/// The root a node trusts before it has checked any. Targets and timestamp are signed online; once configured, root
/// signatures are held by the offline keys instead.
pub fn builtin_root() -> Root {
    builtin_root_with_roles(RELEASE_KEY, OFFLINE_ROOT_KEYS)
}

const fn date_before(left: &str, right: &str) -> bool {
    let a = left.as_bytes();
    let b = right.as_bytes();
    if a.len() != 10 || b.len() != 10 {
        return false;
    }
    let mut i = 0;
    while i < 10 {
        if a[i] < b[i] {
            return true;
        }
        if a[i] > b[i] {
            return false;
        }
        i += 1;
    }
    false
}
const fn str_eq(left: &str, right: &str) -> bool {
    let a = left.as_bytes();
    let b = right.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}
const fn release_offline_keys_valid() -> bool {
    if OFFLINE_ROOT_KEYS.len() < 2
        || OFFLINE_TARGETS_KEYS.len() < 2
        || OFFLINE_TIMESTAMP_KEYS.is_empty()
    {
        return false;
    }
    role_keys_valid(OFFLINE_ROOT_KEYS, 2)
        && role_keys_valid(OFFLINE_TARGETS_KEYS, 2)
        && role_keys_valid(OFFLINE_TIMESTAMP_KEYS, 1)
        && roles_disjoint(OFFLINE_ROOT_KEYS, OFFLINE_TARGETS_KEYS)
        && roles_disjoint(OFFLINE_ROOT_KEYS, OFFLINE_TIMESTAMP_KEYS)
        && roles_disjoint(OFFLINE_TARGETS_KEYS, OFFLINE_TIMESTAMP_KEYS)
}
const fn role_keys_valid(keys: &[&str], minimum: usize) -> bool {
    if keys.len() < minimum {
        return false;
    }
    let mut i = 0;
    while i < keys.len() {
        let key = keys[i].as_bytes();
        if key.len() != 64 || str_eq(keys[i], RELEASE_KEY) {
            return false;
        }
        let mut j = 0;
        while j < 64 {
            let c = key[j];
            if !((c >= b'0' && c <= b'9') || (c >= b'a' && c <= b'f')) {
                return false;
            }
            j += 1;
        }
        let mut k = 0;
        while k < i {
            if str_eq(keys[k], keys[i]) {
                return false;
            }
            k += 1;
        }
        i += 1;
    }
    true
}
const fn roles_disjoint(left: &[&str], right: &[&str]) -> bool {
    let mut i = 0;
    while i < left.len() {
        let mut j = 0;
        while j < right.len() {
            if str_eq(left[i], right[j]) {
                return false;
            }
            j += 1;
        }
        i += 1;
    }
    true
}
const fn offline_roles_empty() -> bool {
    OFFLINE_ROOT_KEYS.is_empty()
        && OFFLINE_TARGETS_KEYS.is_empty()
        && OFFLINE_TIMESTAMP_KEYS.is_empty()
}
const _: () = {
    let is_release = release_build_enabled(option_env!("UNBROWSE_RELEASE"));
    if is_release && !release_offline_keys_valid() {
        if !offline_roles_empty() {
            panic!("release blocked: offline update role keys are partial, malformed, duplicated, or overlapping");
        }
        match ONLINE_ROOT_ACCEPTED_UNTIL {
            Some(deadline) => match option_env!("UNBROWSE_BUILD_DATE_UTC") {
                Some(today) if date_before(today, deadline) => (),
                _ => panic!("release blocked: configure offline root public keys or remove the expired online-root exception"),
            },
            None => panic!("release blocked: configure offline root public keys"),
        }
    }
};

fn builtin_root_of(key: &str) -> Root {
    let one = Role {
        keys: vec![key.to_string()],
        threshold: 1,
    };
    Root {
        kind: "root".into(),
        version: 1,
        expires: u64::MAX,
        roles: Roles {
            root: one.clone(),
            targets: one.clone(),
            timestamp: one,
        },
    }
}

fn builtin_root_with_roles(online_key: &str, offline_keys: &[&str]) -> Root {
    if offline_keys.is_empty() {
        return builtin_root_of(online_key);
    }
    builtin_root_with_roles_and_roles(offline_keys, OFFLINE_TARGETS_KEYS, OFFLINE_TIMESTAMP_KEYS)
}

fn builtin_root_with_roles_and_roles(
    root_keys: &[&str],
    target_keys: &[&str],
    timestamp_keys: &[&str],
) -> Root {
    let root = Role {
        keys: root_keys.iter().map(|key| (*key).to_string()).collect(),
        threshold: 2,
    };
    let targets = Role {
        keys: target_keys.iter().map(|key| (*key).to_string()).collect(),
        threshold: 2,
    };
    let timestamp = Role {
        keys: timestamp_keys
            .iter()
            .map(|key| (*key).to_string())
            .collect(),
        threshold: 1,
    };
    Root {
        kind: "root".into(),
        version: 2,
        expires: 4_102_444_800,
        roles: Roles {
            root,
            targets,
            timestamp,
        },
    }
}

/// The root after `trusted`, if `file` is it: the very next version, signed by enough of `trusted`'s root keys and of
/// its own.
pub fn next_root(trusted: &Root, file: &[u8]) -> Result<Root, String> {
    let (s, new): (Signed, Root) = read_signed(file, "root")?;
    if new.version != trusted.version + 1 {
        return Err(format!(
            "root {} comes where root {} should",
            new.version,
            trusted.version + 1
        ));
    }
    signed_by(
        &s,
        &trusted.roles.root,
        &format!("root {} (by root {}'s keys)", new.version, trusted.version),
    )?;
    signed_by(
        &s,
        &new.roles.root,
        &format!("root {} (by its own keys)", new.version),
    )?;
    if new.roles.root.threshold < 2 {
        return Err("a successor root needs at least two root keys".into());
    }
    if new.expires == u64::MAX {
        return Err("a successor root must expire".into());
    }
    let forbidden: BTreeSet<_> = new
        .roles
        .targets
        .keys
        .iter()
        .chain(new.roles.timestamp.keys.iter())
        .chain(trusted.roles.targets.keys.iter())
        .chain(trusted.roles.timestamp.keys.iter())
        .map(|key| key.to_ascii_lowercase())
        .chain(std::iter::once(RELEASE_KEY.to_string()))
        .collect();
    if new
        .roles
        .root
        .keys
        .iter()
        .any(|key| forbidden.contains(&key.to_ascii_lowercase()))
    {
        return Err(
            "successor root keys must be separate from online roles and the release key".into(),
        );
    }
    if new.roles.targets.keys.iter().any(|key| {
        new.roles
            .timestamp
            .keys
            .iter()
            .any(|other| key.eq_ignore_ascii_case(other))
    }) {
        return Err("successor targets and timestamp roles must use separate keys".into());
    }
    Ok(new)
}

/// npm's integrity string for these bytes.
pub fn integrity(bytes: &[u8]) -> String {
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
    )
}

fn versions() -> PathBuf {
    store::home().join("versions")
}

/// The newest metadata this node checked: each file whole, as signed, in hex. Written whole or not at all, so a node
/// stopped mid-write still holds the newest it kept.
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Kept {
    #[serde(default)]
    roots: Vec<String>,
    // Legacy single-root field is deliberately ignored: it has no authenticated chain.
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    targets: Option<String>,
}

const TRUST: &str = "trust.json";

/// What a node holds as trusted: its newest root, and the newest timestamp and targets that root's keys signed.
#[derive(Clone, Debug)]
pub struct Trusted {
    pub root: Root,
    pub timestamp: Option<Timestamp>,
    pub targets: Option<Targets>,
}

fn unhex(h: &Option<String>) -> Option<Vec<u8>> {
    h.as_deref().and_then(|h| hex::decode(h).ok())
}

/// What this node trusts, from `dir`: the root it kept, if that root is signed by its own keys and newer than the one
/// built in (else the built-in one), and the timestamp and targets it kept, while that root's keys signed them. A file
/// the keys no longer sign (the role's keys rotated) no longer counts, so a rotation away from a stolen key also
/// forgets what that key signed.
fn trusted_in(builtin: &Root, dir: &Path) -> Trusted {
    let k: Kept = store::read_json(&dir.join(TRUST), &unbrowse_files::TRUST);
    let (root, _) = verified_kept_roots(builtin, &k.roots);
    let timestamp = unhex(&k.timestamp).and_then(|f| {
        let (s, t): (Signed, Timestamp) = read_signed(&f, "timestamp").ok()?;
        signed_by(&s, &root.roles.timestamp, "kept timestamp")
            .ok()
            .map(|_| t)
    });
    let targets = unhex(&k.targets).and_then(|f| {
        let (s, t): (Signed, Targets) = read_signed(&f, "targets").ok()?;
        signed_by(&s, &root.roles.targets, "kept targets")
            .ok()
            .map(|_| t)
    });
    Trusted {
        root,
        timestamp,
        targets,
    }
}

/// Return the longest verifiable chain in the persisted root list, trying candidates in version order and dropping
/// stale, malformed, duplicate and non-chaining entries so an old root cannot hide a later valid root.
fn verified_kept_roots(builtin: &Root, encoded_roots: &[String]) -> (Root, Vec<String>) {
    let mut root = builtin.clone();
    let mut verified = Vec::new();
    let mut candidates: Vec<(u64, Vec<u8>)> = encoded_roots
        .iter()
        .filter_map(|encoded| {
            let bytes = hex::decode(encoded).ok()?;
            let (_, candidate): (Signed, Root) = read_signed(&bytes, "root").ok()?;
            Some((candidate.version, bytes))
        })
        .collect();
    candidates.sort_by_key(|(version, _)| *version);
    for (_, bytes) in candidates {
        if let Ok(next) = next_root(&root, &bytes) {
            root = next;
            verified.push(hex::encode(bytes));
        }
    }
    (root, verified)
}

fn keep_files(
    builtin: &Root,
    dir: &Path,
    root: Option<&[u8]>,
    timestamp: Option<&[u8]>,
    targets: Option<&[u8]>,
) -> Result<(), String> {
    let mut k: Kept = store::read_json(&dir.join(TRUST), &unbrowse_files::TRUST);
    if let Some(f) = root {
        k.roots.push(hex::encode(f));
        k.root = Some(hex::encode(f));
    }
    let (_, verified) = verified_kept_roots(builtin, &k.roots);
    k.roots = verified;
    if let Some(f) = timestamp {
        k.timestamp = Some(hex::encode(f));
    }
    if let Some(f) = targets {
        k.targets = Some(hex::encode(f));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    store::write_json(&dir.join(TRUST), &unbrowse_files::TRUST, &k)
}

/// The manifest a node from before the metadata kept, and its signature, in one file.
#[derive(Serialize, Deserialize)]
pub(crate) struct KeptManifest {
    /// The manifest's bytes as signed, in hex.
    manifest: String,
    sig: String,
}

const KEPT: &str = "kept-manifest.json";

/// The manifest an older release of this node kept, so the network's `min_version` it knew holds until the metadata
/// says more.
fn kept_manifest(key: &str, dir: &Path) -> Option<Manifest> {
    let (m, sig) = match std::fs::read(dir.join(KEPT)) {
        Ok(text) => {
            let k: KeptManifest = unbrowse_files::KEPT_MANIFEST
                .read_from(&dir.join(KEPT), &text)
                .ok()?;
            (hex::decode(k.manifest).ok()?, k.sig)
        }
        Err(_) => (
            std::fs::read(dir.join("manifest.json")).ok()?,
            std::fs::read_to_string(dir.join("manifest.sig")).ok()?,
        ),
    };
    verify(&m, &sig, key).ok()
}

/// The oldest version the network takes, as `dir`'s newest checked metadata says: the kept targets', else the higher
/// of that and the manifest an older release kept, so moving to the metadata never lowers it.
fn min_version_in(builtin: &Root, key: &str, dir: &Path) -> Option<String> {
    let trusted = trusted_in(builtin, dir);
    let from_targets = trusted.targets.map(|t| t.min_version);
    // The online-key manifest remains only for nodes that have not reached an offline root; after transition it
    // cannot impose a minimum that bypasses targets signatures.
    let from_manifest = (trusted.root.version == 1)
        .then(|| kept_manifest(key, dir).map(|m| m.min_version))
        .flatten();
    match (from_targets, from_manifest) {
        (Some(a), Some(b)) => Some(if newer(&b, &a) { b } else { a }),
        (a, b) => a.or(b),
    }
}

/// The oldest version the network takes, as the newest metadata this node has checked says.
pub fn min_version() -> Option<String> {
    min_version_in(&builtin_root(), RELEASE_KEY, &versions())
}

/// The oldest release a released node takes from its peers. A build the release didn't make (a devnet's) takes any.
pub fn network_minimum() -> Option<String> {
    released().then(min_version).flatten()
}

/// This node is older than the network takes. A build the release didn't make is never held back.
pub fn below_minimum() -> bool {
    network_minimum().is_some_and(|min| newer(&min, RUNNING))
}

/// The node program in an unpacked version, if it is there.
pub fn program(dir: &Path) -> Option<PathBuf> {
    let exe = format!("unbrowse-node{}", std::env::consts::EXE_SUFFIX);
    [
        dir.join("Unbrowse.app/Contents/MacOS").join(&exe),
        dir.join("bin").join(&exe),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

/// The file saying which version a start runs, what a release on trial is called, the release that stayed up, and the
/// release that didn't, all in `versions`.
const CURRENT: &str = "current";
const TRIAL: &str = "trial.json";
const PROVED: &str = "proved";
const GAVE_UP: &str = "gave-up";

/// How many times a release that hasn't stayed up is started before the node stays on the one it has: a start can be
/// cut short by something else (a power cut, a restart of the machine), so one isn't enough to give up on it.
const STARTS_ALLOWED: u32 = 2;

/// How long a release has to stay up to have proved itself.
const PROVEN_AFTER: Duration = Duration::from_secs(120);

/// How long a release gets to answer `--help` before the node goes through with leaving the network for it.
const ANSWERS_WITHIN: Duration = Duration::from_secs(30);

/// A release being tried, how many times it was started without yet staying up, and what its latest start noted of
/// how far it got (`reached`), so a release given up on can be said to have stopped there.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Trial {
    version: String,
    starts: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    reached: Vec<String>,
}

/// What a start does with release `v`, given what stayed up here and what is on trial.
#[derive(Debug, PartialEq)]
enum Turn {
    /// It has stayed up here: it runs, and nothing is counted.
    Proved,
    /// It runs, as this many starts of it.
    Try(u32),
    /// It was started as often as a release is: this node stays on what it has.
    GiveUp,
}

fn turn_of(v: &str, proved: Option<&str>, trial: &Trial) -> Turn {
    if proved == Some(v) {
        return Turn::Proved;
    }
    let starts = if trial.version == v { trial.starts } else { 0 };
    if starts >= STARTS_ALLOWED {
        Turn::GiveUp
    } else {
        Turn::Try(starts + 1)
    }
}

/// A one-line file in `versions`, or `None`.
fn word_in(dir: &Path, file: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(file))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Puts `text` at `path` whole: a start that reads it never finds half of it (a crash during a plain write would leave
/// `current` empty or cut short).
fn put_whole(path: &Path, text: &str) -> Result<(), String> {
    let part = path.with_extension("part");
    std::fs::write(&part, text).map_err(|e| e.to_string())?;
    std::fs::rename(&part, path).map_err(|e| e.to_string())
}

/// Notes that release `v` is being started, in `dir`. False when it has had its starts: `give_up` has run, and it isn't
/// to be started.
fn about_to_start(dir: &Path, v: &str) -> bool {
    let trial: Trial = word_in(dir, TRIAL)
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    match turn_of(v, word_in(dir, PROVED).as_deref(), &trial) {
        Turn::Proved => true,
        Turn::Try(starts) => {
            let trial = serde_json::to_string(&Trial {
                version: v.to_string(),
                starts,
                reached: Vec::new(),
            })
            .unwrap_or_default();
            if let Err(e) = put_whole(&dir.join(TRIAL), &trial) {
                eprintln!("update: couldn't note the start of {v}: {e}");
            }
            true
        }
        Turn::GiveUp => {
            give_up(dir, v);
            false
        }
    }
}

/// Notes how far this start got, when this program is the release on trial: the start that gives up on it says so, since
/// a release that stops (or is stopped) before it has proved itself can't say why itself.
pub fn reached(step: &str) {
    note_reached(&versions(), RUNNING, step);
}

fn note_reached(dir: &Path, running: &str, step: &str) {
    let Some(mut trial) = word_in(dir, TRIAL).and_then(|t| serde_json::from_str::<Trial>(&t).ok()) else { return };
    if trial.version != running {
        return;
    }
    trial.reached.push(step.to_string());
    if let Err(e) = put_whole(&dir.join(TRIAL), &serde_json::to_string(&trial).unwrap_or_default()) {
        eprintln!("update: couldn't note how far {running} got: {e}");
    }
}

/// What release `v`'s latest start noted of how far it got, to say beside giving up on it. Read before `about_to_start`,
/// which clears the trial when it gives up.
fn how_far(dir: &Path, v: &str) -> String {
    match word_in(dir, TRIAL).and_then(|t| serde_json::from_str::<Trial>(&t).ok()) {
        Some(t) if t.version == v && !t.reached.is_empty() => format!("its latest start noted: {}", t.reached.join("; ")),
        _ => "its latest start noted nothing: it stopped before it began, or was stopped from outside (the system \
              refusing its signature, a kill)"
            .into(),
    }
}

/// This node stays off release `v`: no start runs it and no check fetches it again, until a newer one comes.
fn give_up(dir: &Path, v: &str) {
    if let Err(e) = put_whole(&dir.join(GAVE_UP), v) {
        eprintln!("update: couldn't note that {v} is given up on: {e}");
    }
    let _ = std::fs::remove_file(dir.join(TRIAL));
    if word_in(dir, CURRENT).as_deref() == Some(v) {
        let _ = std::fs::remove_file(dir.join(CURRENT));
    }
}

/// Forgets the release this node gave up on once it holds nothing back: the node runs that release or a newer one (a
/// newer install landed, or the owner put it in by hand). Core #630: it used to be kept for good.
fn forget_gave_up_behind(dir: &Path, running: &str) {
    if word_in(dir, GAVE_UP).is_some_and(|v| !newer(&v, running)) {
        let _ = std::fs::remove_file(dir.join(GAVE_UP));
    }
}

/// The owner asking for an update (`unbrowse update`) tries a release given up on once more, on a count of starts of
/// its own: they may have fixed what stopped it (core #630).
fn try_gave_up_again(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(GAVE_UP));
}

/// What the owner is told of release `w`, given up on here, while the node stays on `running`.
fn stays_on(w: &str, running: &str) -> String {
    format!("{w} didn't start here, so this node stays on {running} until a newer release; `unbrowse update` tries {w} again")
}

/// The node has stayed up as `running`: a release on trial has proved itself.
fn prove(dir: &Path, running: &str) {
    let trial: Option<Trial> = word_in(dir, TRIAL).and_then(|t| serde_json::from_str(&t).ok());
    if trial.is_some_and(|t| t.version == running) {
        if let Err(e) = put_whole(&dir.join(PROVED), running) {
            eprintln!("update: couldn't note that {running} stayed up: {e}");
        }
        let _ = std::fs::remove_file(dir.join(TRIAL));
    }
}

/// Whether the metadata still takes this node to `v`, unpacked and not yet run: not while the rollout is halted, and not
/// past what its channel runs now (a channel moved back, or the owner picked another). Before the key is open a node's
/// place in the rollout isn't known, so the canary may be its release.
fn still_wanted(v: &str, t: &Targets, place: &Place) -> bool {
    let (_, want) = choose(t, place);
    let Some(want) = want else { return false };
    let most = match (place.chosen, &place.seed, &t.channels.canary) {
        (None, None, Some(canary)) if newer(canary, &want) => canary.clone(),
        _ => want,
    };
    !newer(v, &most)
}

/// The newest version unpacked here, if it is newer than this program.
fn waiting() -> Option<(String, PathBuf)> {
    let v = word_in(&versions(), CURRENT)?;
    if !newer(&v, RUNNING) {
        return None;
    }
    Some((v.clone(), program(&versions().join(&v))?))
}

/// At start: a newer version unpacked here runs instead of this one, if what this node last read of the metadata still
/// takes it there and the release has starts left. One that dies as it starts ends here, not in a loop: nothing it
/// runs can stop it, so this program, the one that starts it, keeps the count.
pub fn run_newest() {
    if !enabled() || std::env::var_os(HANDED_OVER).is_some() {
        return;
    }
    let Some((v, exe)) = waiting() else { return };
    let dir = versions();
    if let Some(t) = trusted_in(&builtin_root(), &dir).targets {
        if !still_wanted(&v, &t, &place(None)) {
            eprintln!("update: {v} is unpacked here, and the update metadata no longer takes this node to it");
            let _ = std::fs::remove_file(dir.join(CURRENT));
            return;
        }
    }
    let why = how_far(&dir, &v);
    if !about_to_start(&dir, &v) {
        eprintln!("update: {v} didn't stay up in {STARTS_ALLOWED} starts, so this node stays on {RUNNING} ({why})");
        return;
    }
    eprintln!("update: running {v}, the newest here");
    if let Err(e) = hand_over(&exe) {
        eprintln!("{e}");
        give_up(&dir, &v);
    }
}

/// Becomes the node at `exe`, with this one's arguments. On Unix it takes this process's place; on Windows it starts
/// on its own and this one ends, and it waits for the port this one leaves. Comes back only when it couldn't.
fn hand_over(exe: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(std::env::args_os().skip(1)).env(HANDED_OVER, "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = cmd.exec();
        Err(format!("update: couldn't start {}: {e}", exe.display()))
    }
    #[cfg(windows)]
    {
        match cmd.spawn() {
            Ok(_) => std::process::exit(0),
            Err(e) => Err(format!("update: couldn't start {}: {e}", exe.display())),
        }
    }
}

/// Whether the program at `exe` starts here at all: a release built for another system, one the system won't run or one
/// that can't find its libraries fails this, while the node is still on the network to stay on.
fn answers(exe: &Path) -> Result<(), String> {
    let mut child = std::process::Command::new(exe)
        .arg("--help")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("{} doesn't start: {e}", exe.display()))?;
    let until = std::time::Instant::now() + ANSWERS_WITHIN;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) if s.success() => return Ok(()),
            Some(s) => return Err(format!("{} ended with {s}", exe.display())),
            None if std::time::Instant::now() > until => {
                let _ = child.kill();
                return Err(format!("{} didn't answer", exe.display()));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Whether this node was started by an update or a restart, and may find its port not yet free.
pub fn handed_over() -> bool {
    std::env::var_os(HANDED_OVER).is_some()
}

/// Agents' calls and the owner's commands under way; a restart waits for none.
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Counts a request while it runs.
pub struct Busy;

impl Busy {
    pub fn enter() -> Busy {
        IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Busy
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// How long a restart waits for calls in flight, and for the owner: an ask or a page in their hands is cut by a restart
/// as a call is, and takes as long as they take.
const CALLS_WAIT: Duration = Duration::from_secs(3600);
const OWNER_WAIT: Duration = Duration::from_secs(4 * 3600);

/// Whether a restart goes on waiting, after `waited`, with `in_flight` calls under way and with the owner asked or
/// holding a page or not.
fn waits_on(in_flight: usize, owner_busy: bool, waited: Duration) -> bool {
    (in_flight > 0 && waited < CALLS_WAIT) || (owner_busy && waited < OWNER_WAIT)
}

/// Says what a restart that didn't happen left the node as: `ready` no longer promises it.
fn say_stayed(why: String) {
    eprintln!("update: {why}");
    set(|s| {
        s.ready = None;
        s.error = Some(why);
    });
}

/// Waits for what's in flight, then becomes the node at `exe`.
/// A restart is a clean stop: the node leaves the peer network first (`peers::leave`, on `rt`, the runtime that runs
/// it), so its peers hear it is going and the program it becomes is admitted afresh when it connects. Leaving can't be
/// undone in a running process, so a release is checked before the node leaves; if starting it still fails, the node
/// starts this same program over, which joins again. Only when that fails too does it stay up off the network, saying so.
fn restart_when_idle(node: &crate::Node, rt: &tokio::runtime::Handle, exe: PathBuf, into: String) {
    let started = std::time::Instant::now();
    while waits_on(
        IN_FLIGHT.load(Ordering::SeqCst),
        crate::hands::owner_busy(),
        started.elapsed(),
    ) {
        std::thread::sleep(Duration::from_secs(5));
    }
    let (dir, updating) = (versions(), into != RUNNING);
    if updating {
        if let Err(e) = answers(&exe) {
            give_up(&dir, &into);
            say_stayed(format!(
                "{into} wasn't started, so this node stays on {RUNNING}: {e}"
            ));
            return;
        }
        let why = how_far(&dir, &into);
        if !about_to_start(&dir, &into) {
            say_stayed(format!(
                "{into} didn't stay up in {STARTS_ALLOWED} starts, so this node stays on {RUNNING} ({why})"
            ));
            return;
        }
    }
    eprintln!("update: restarting into {into}");
    rt.block_on(crate::peers::leave(node));
    let Err(failed) = hand_over(&exe) else { return };
    eprintln!("{failed}");
    if updating {
        give_up(&dir, &into);
    }
    let stayed = std::env::current_exe()
        .map_err(|e| e.to_string())
        .and_then(|me| hand_over(&at_its_path(me)))
        .err()
        .unwrap_or_default();
    say_stayed(format!("the node left the network to restart and couldn't start again ({failed}; {stayed}): restart it to rejoin"));
}

/// This program as it is named on disk now. A program replaced while it runs (a new build copied over it) is named
/// `<path> (deleted)` by Linux: the restart starts what is at `<path>`, the program that replaced it.
fn at_its_path(exe: PathBuf) -> PathBuf {
    match exe.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
        Some(path) if !exe.exists() => PathBuf::from(path),
        _ => exe,
    }
}

/// The owner's restart: into the newest version unpacked here, else this same program, once no call is in flight.
/// The version it restarts into.
pub fn restart(node: &Arc<crate::Node>) -> Result<String, String> {
    let (into, exe) = match waiting().filter(|_| released()) {
        Some(w) => w,
        None => (
            RUNNING.to_string(),
            at_its_path(std::env::current_exe().map_err(|e| format!("this node's program: {e}"))?),
        ),
    };
    let (v, node, rt) = (
        into.clone(),
        node.clone(),
        tokio::runtime::Handle::current(),
    );
    std::thread::spawn(move || {
        // The reply to the command that asked goes out first.
        std::thread::sleep(Duration::from_millis(300));
        restart_when_idle(&node, &rt, exe, v);
    });
    Ok(into)
}

/// Where the packages are read from: npm, or `UNBROWSE_REGISTRY` (a mirror, or a test's).
fn registry() -> String {
    std::env::var("UNBROWSE_REGISTRY")
        .unwrap_or_else(|_| "https://registry.npmjs.org".into())
        .trim_end_matches('/')
        .to_string()
}

/// A registry answer of at most `max` bytes.
fn get(client: &reqwest::blocking::Client, url: &str, max: u64) -> Result<Vec<u8>, String> {
    let r = client.get(url).send().map_err(|e| format!("{url}: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("{url}: {}", r.status()));
    }
    let mut out = Vec::new();
    r.take(max + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("{url}: {e}"))?;
    if out.len() as u64 > max {
        return Err(format!("{url}: larger than any release"));
    }
    Ok(out)
}

fn escaped(name: &str) -> String {
    name.replace('/', "%2f")
}

/// A package version's tarball from the registry, checked against the integrity `want` (or npm's own when `None`).
fn tarball(
    client: &reqwest::blocking::Client,
    reg: &str,
    name: &str,
    version: &str,
    want: Option<&str>,
) -> Result<Vec<u8>, String> {
    let meta: Value = serde_json::from_slice(&get(
        client,
        &format!("{reg}/{}/{version}", escaped(name)),
        MAX_ANSWER,
    )?)
    .map_err(|e| format!("{name}@{version}: {e}"))?;
    let url = meta["dist"]["tarball"]
        .as_str()
        .ok_or_else(|| format!("{name}@{version} has no tarball"))?;
    let bytes = get(client, url, MAX_PACKAGE)?;
    let want = want
        .or(meta["dist"]["integrity"].as_str())
        .ok_or_else(|| format!("{name}@{version} has no integrity"))?;
    if integrity(&bytes) != want {
        return Err(format!(
            "{name}@{version} isn't the package the release made"
        ));
    }
    Ok(bytes)
}

/// The files of an npm tarball under `package/`, by their path inside it.
fn files(tgz: &[u8]) -> Result<tar::Archive<flate2::read::GzDecoder<&[u8]>>, String> {
    Ok(tar::Archive::new(flate2::read::GzDecoder::new(tgz)))
}

/// One small file from an npm tarball, if it holds it. The metadata package is read before anything in it is
/// checked, so the read stops at a metadata file's size limit, whatever the archive says it holds.
fn find_file(tgz: &[u8], path: &str) -> Result<Option<Vec<u8>>, String> {
    let mut a = files(tgz)?;
    let mut seen = 0u64;
    for e in a.entries().map_err(|e| e.to_string())? {
        let mut e = e.map_err(|e| e.to_string())?;
        seen += e.size();
        if seen > MAX_UNPACKED {
            return Err("the package is larger than any release".into());
        }
        if e.path().map_err(|e| e.to_string())?.to_string_lossy() == format!("package/{path}") {
            let mut out = Vec::new();
            (&mut e)
                .take(MAX_MANIFEST + 1)
                .read_to_end(&mut out)
                .map_err(|e| e.to_string())?;
            if out.len() as u64 > MAX_MANIFEST {
                return Err(format!("the package's {path} is larger than any metadata"));
            }
            return Ok(Some(out));
        }
    }
    Ok(None)
}

/// Unpacks an npm tarball's `package/` into `into`: files and folders only. A path that would land outside it, a link,
/// or more than a release ever holds is refused.
pub fn unpack(tgz: &[u8], into: &Path) -> Result<(), String> {
    let mut a = files(tgz)?;
    let mut total = 0u64;
    for e in a.entries().map_err(|e| e.to_string())? {
        let mut e = e.map_err(|e| e.to_string())?;
        let kind = e.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            return Err("the package holds something other than files and folders".into());
        }
        total += e.size();
        if total > MAX_UNPACKED {
            return Err("the package is larger than any release".into());
        }
        let path = e.path().map_err(|e| e.to_string())?.into_owned();
        let Ok(rel) = path.strip_prefix("package") else {
            continue;
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        if !rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return Err(format!(
                "the package names {} outside itself",
                path.display()
            ));
        }
        let to = into.join(rel);
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        e.unpack(&to)
            .map_err(|err| format!("{}: {err}", to.display()))?;
    }
    Ok(())
}

/// Where a node stands for a rollout: the channel its owner picked, if one, and what its place is drawn from (its
/// identity), and the time it checks at.
#[derive(Clone, Debug)]
pub struct Place {
    pub chosen: Option<Channel>,
    pub seed: Option<String>,
    pub now: u64,
}

/// Where, out of 100, a node falls for a release's canary: a hash of its identity and the release, so it is the same
/// at every check of one release, a raised share only adds nodes, and the same nodes aren't every release's canary.
pub fn bucket(seed: &str, release: &str) -> u8 {
    let h = Sha256::digest(format!("unbrowse rollout\0{seed}\0{release}").as_bytes());
    (u64::from_be_bytes(h[..8].try_into().expect("8 bytes")) % 100) as u8
}

/// The channel a node runs under `t`, and the release it should run: canary's for a canary node when it is newer than
/// stable's, else stable's. None while the rollout is halted. A node with no identity yet, and no channel picked, is on
/// stable.
pub fn choose(t: &Targets, place: &Place) -> (Channel, Option<String>) {
    let canary = t
        .channels
        .canary
        .clone()
        .filter(|c| newer(c, &t.channels.stable));
    let channel = match (place.chosen, &canary, &place.seed) {
        (Some(c), _, _) => c,
        (None, Some(c), Some(seed)) if bucket(seed, c) < t.canary_share.min(100) => Channel::Canary,
        _ => Channel::Stable,
    };
    if t.halt.is_some() {
        return (channel, None);
    }
    let want = match channel {
        Channel::Canary => canary.unwrap_or_else(|| t.channels.stable.clone()),
        Channel::Stable => t.channels.stable.clone(),
    };
    (channel, Some(want))
}

/// What a check found: the metadata checked, the channel the node runs and the release it runs there (none while
/// halted), and the version it unpacked, if any.
#[derive(Debug)]
pub struct Checked {
    pub targets: Targets,
    pub channel: Channel,
    pub want: Option<String>,
    pub unpacked: Option<(String, PathBuf)>,
}

/// Checks the metadata from `files` (a file's bytes by its path in the metadata package, `None` when it isn't there)
/// against what `dir` trusts, starting from `builtin`, and keeps what it checked. The newest timestamp and targets it
/// returns are current, signed by the keys the newest root names, and no older than any this node checked before.
pub fn check_metadata(
    builtin: &Root,
    files: &dyn Fn(&str) -> Result<Option<Vec<u8>>, String>,
    dir: &Path,
    now: u64,
) -> Result<Targets, String> {
    let held = trusted_in(builtin, dir);
    // Root: one version at a time, each signed by the one before and by itself.
    let mut root = held.root.clone();
    for _ in 0..MAX_ROOTS {
        let Some(f) = files(&format!("root/{}.root.json", root.version + 1))? else {
            break;
        };
        root = next_root(&root, &f)?;
        keep_files(builtin, dir, Some(&f), None, None)?;
    }
    if root.expires <= now {
        return Err(format!(
            "the update metadata's root {} has expired: the owner must sign a new one",
            root.version
        ));
    }
    // What a role's earlier keys signed no longer counts once they are rotated out.
    let held = trusted_in(builtin, dir);

    let ts_file = files("timestamp.json")?.ok_or("the update metadata has no timestamp")?;
    let (s, ts): (Signed, Timestamp) = read_signed(&ts_file, "timestamp")?;
    signed_by(&s, &root.roles.timestamp, "timestamp")?;
    if let Some(had) = &held.timestamp {
        if ts.version < had.version {
            return Err(format!("the update metadata's timestamp {} is older than {}, which this node already checked", ts.version, had.version));
        }
    }
    if ts.expires <= now {
        return Err(format!("the update metadata's timestamp expired {}s ago: a mirror may be holding back newer releases", now - ts.expires));
    }

    let tg_file = files("targets.json")?.ok_or("the update metadata has no targets")?;
    if hex::encode(Sha256::digest(&tg_file)) != ts.targets.sha256.to_ascii_lowercase() {
        return Err("the update metadata's targets aren't the ones its timestamp names".into());
    }
    let (s, tg): (Signed, Targets) = read_signed(&tg_file, "targets")?;
    if tg.version != ts.targets.version {
        return Err(format!(
            "the timestamp names targets {}, but these are {}",
            ts.targets.version, tg.version
        ));
    }
    signed_by(&s, &root.roles.targets, "targets")?;
    if let Some(had) = &held.targets {
        if tg.version < had.version {
            return Err(format!("the update metadata's targets {} are older than {}, which this node already checked", tg.version, had.version));
        }
    }
    if tg.expires <= now {
        return Err(format!(
            "the update metadata's targets {} have expired",
            tg.version
        ));
    }
    keep_files(builtin, dir, None, Some(&ts_file), Some(&tg_file))?;
    Ok(tg)
}

/// Checks npm's metadata and, when this node's channel runs a newer release, fetches it, checks it against the
/// metadata and unpacks it into `versions`.
pub fn check(
    reg: &str,
    builtin: &Root,
    running: &str,
    machine: &str,
    versions: &Path,
    place: &Place,
) -> Result<Checked, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let latest: Value = serde_json::from_slice(&get(
        &client,
        &format!("{reg}/{}/latest", escaped(METADATA_PACKAGE)),
        MAX_ANSWER,
    )?)
    .map_err(|e| format!("{METADATA_PACKAGE}: {e}"))?;
    let v = latest["version"]
        .as_str()
        .ok_or_else(|| format!("npm's {METADATA_PACKAGE} has no version"))?
        .to_string();
    let pkg = tarball(&client, reg, METADATA_PACKAGE, &v, None)?;
    let targets = check_metadata(builtin, &|p| find_file(&pkg, p), versions, place.now)?;
    let (channel, want) = choose(&targets, place);
    forget_unwanted(versions, &targets, place, running);
    // Never an older release than this one: a channel moved back is a rollback, and isn't followed. Nor one that didn't
    // stay up here: it is fetched again only when a newer one comes, or the owner asks for it (`try_gave_up_again`).
    forget_gave_up_behind(versions, running);
    let gave_up = word_in(versions, GAVE_UP);
    let Some(next) = want
        .clone()
        .filter(|w| newer(w, running) && gave_up.as_deref() != Some(w.as_str()))
    else {
        return Ok(Checked {
            targets,
            channel,
            want,
            unpacked: None,
        });
    };
    let want_now = want;
    let want = next;
    let release = targets.releases.get(&want).ok_or_else(|| {
        format!(
            "the update metadata names {want} for {} but has no release of it",
            channel.name()
        )
    })?;
    let p = release
        .platforms
        .get(machine)
        .ok_or_else(|| format!("{want} has nothing for {machine}"))?;
    let bytes = tarball(&client, reg, &p.name, &want, Some(&p.integrity))?;
    let dir = versions.join(&want);
    // Fetched and checked already, waiting on a restart that didn't come: it isn't fetched again.
    if word_in(versions, CURRENT).as_deref() == Some(want.as_str()) && program(&dir).is_some() {
        return Ok(Checked {
            targets,
            channel,
            want: want_now,
            unpacked: Some((want, dir)),
        });
    }
    let part = versions.join(format!("{want}.partial"));
    let _ = std::fs::remove_dir_all(&part);
    unpack(&bytes, &part)?;
    if program(&part).is_none() {
        return Err(format!("{} {want} has no node in it", p.name));
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&part, &dir).map_err(|e| e.to_string())?;
    put_whole(&versions.join(CURRENT), &want)?;
    Ok(Checked {
        targets,
        channel,
        want: want_now,
        unpacked: Some((want, dir)),
    })
}

/// A version unpacked and not yet run that the metadata no longer takes this node to isn't what the next start runs.
fn forget_unwanted(versions: &Path, targets: &Targets, place: &Place, running: &str) {
    if word_in(versions, CURRENT)
        .is_some_and(|v| newer(&v, running) && !still_wanted(&v, targets, place))
    {
        let _ = std::fs::remove_file(versions.join(CURRENT));
    }
}

/// The browser add-on's package for `machine` in release `version`, fetched and checked: the package the update metadata
/// names for that release (checked as an update is), else, for a release the metadata no longer names, the one its own
/// manifest names (in `unbrowse` of that version, signed by the release key `key`). Either way the tarball's bytes are
/// the ones the release signed for; anything else is refused.
pub fn browser_tarball(
    reg: &str,
    builtin: &Root,
    key: &str,
    version: &str,
    machine: &str,
    versions: &Path,
    now: u64,
) -> Result<Vec<u8>, String> {
    // Legacy manifests are signed by the online release key. Permit that path only before the built-in or held root
    // has transitioned away from online root 1; a metadata outage must never restore that key's browser authority.
    let allow_legacy_manifest =
        builtin.version == 1 && trusted_in(builtin, versions).root.version == 1;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let from_metadata = || -> Result<Option<Package>, String> {
        let latest: Value = serde_json::from_slice(&get(
            &client,
            &format!("{reg}/{}/latest", escaped(METADATA_PACKAGE)),
            MAX_ANSWER,
        )?)
        .map_err(|e| format!("{METADATA_PACKAGE}: {e}"))?;
        let v = latest["version"]
            .as_str()
            .ok_or_else(|| format!("npm's {METADATA_PACKAGE} has no version"))?
            .to_string();
        let pkg = tarball(&client, reg, METADATA_PACKAGE, &v, None)?;
        let targets = check_metadata(builtin, &|p| find_file(&pkg, p), versions, now)?;
        Ok(targets
            .releases
            .get(version)
            .and_then(|r| r.browsers.get(machine))
            .cloned())
    };
    let from_manifest = || -> Result<Package, String> {
        let pkg = tarball(&client, reg, "unbrowse", version, None)?;
        let m = find_file(&pkg, "manifest.json")?
            .ok_or_else(|| format!("unbrowse {version} carries no manifest"))?;
        let sig = find_file(&pkg, "manifest.sig")?
            .ok_or_else(|| format!("unbrowse {version}'s manifest isn't signed"))?;
        let m = verify(&m, String::from_utf8_lossy(&sig).trim(), key)?;
        if m.version != version {
            return Err(format!(
                "unbrowse {version} carries the manifest of {}",
                m.version
            ));
        }
        m.browsers
            .get(machine)
            .cloned()
            .ok_or_else(|| format!("release {version} has no browser for {machine}"))
    };
    let p = match from_metadata() {
        Ok(Some(p)) => p,
        Ok(None) | Err(_) if allow_legacy_manifest => from_manifest()?,
        Ok(None) => {
            return Err(
                "offline update root requires browser metadata signed by its targets role".into(),
            )
        }
        Err(error) => {
            return Err(format!(
                "offline update root requires valid browser metadata signed by its targets role: {error}"
            ));
        }
    };
    tarball(&client, reg, &p.name, version, Some(&p.integrity))
}

/// An install that has the browser keeps it across an update into a release that carries none beside its node (the
/// browser became an add-on, `browsers.rs`): the new release's browser package, fetched and checked against the
/// targets, goes where the node keeps its add-on; if that fails, the program this node drives is copied there, so
/// browsing works after the restart either way. An install with no browser gets none.
fn carry_browser(reg: &str, targets: &Targets, version: &str, machine: &str, dir: &Path) {
    let Some(node) = program(dir) else { return };
    if node
        .with_file_name(crate::browsers::program_file())
        .is_file()
    {
        return;
    }
    let Ok(have) = crate::browse::binary() else {
        return;
    };
    if crate::browsers::addon_version().as_deref() == Some(version) {
        return;
    }
    let fetched = targets
        .releases
        .get(version)
        .and_then(|r| r.browsers.get(machine))
        .ok_or_else(|| format!("{version} names no browser for {machine}"))
        .and_then(|p| {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(300))
                .build()
                .map_err(|e| e.to_string())?;
            tarball(&client, reg, &p.name, version, Some(&p.integrity))
        })
        .and_then(|tgz| crate::browsers::put_package(&tgz, version));
    if let Err(e) = fetched {
        eprintln!("update: {version}'s browser wasn't fetched ({e}); keeping this one's");
        if let Err(e) = crate::browsers::put_program(&have, RUNNING) {
            eprintln!("update: keeping the browser: {e}");
        }
    }
}

/// The browser add-on's package for this machine, of the release this node is.
pub fn browser_package() -> Result<Vec<u8>, String> {
    if !released() {
        return Err("this node was built from source, so no release holds its browser: build it (cargo build --release in unbrowse-browser/cli) and run `unbrowse browser install --from <the program it built>`".into());
    }
    let machine = platform().ok_or("there is no released browser for this machine")?;
    browser_tarball(
        &registry(),
        &builtin_root(),
        RELEASE_KEY,
        RUNNING,
        machine,
        &versions(),
        now(),
    )
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The node's place for a rollout: its owner's channel, and its identity once the key is open.
fn place(node: Option<&crate::Node>) -> Place {
    let chosen = store::load_settings()
        .update_channel
        .as_deref()
        .and_then(Channel::parse);
    let seed = node.and_then(|n| {
        n.identity
            .read()
            .ok()?
            .as_ref()?
            .as_ref()
            .ok()
            .map(|v| v.address.clone())
    });
    Place {
        chosen,
        seed,
        now: now(),
    }
}

/// A check under way, said in the status for as long as it lasts, a panic in it included.
struct Checking;

impl Checking {
    fn started() -> Checking {
        set(|s| s.checking = true);
        Checking
    }
}

impl Drop for Checking {
    fn drop(&mut self) {
        set(|s| s.checking = false);
    }
}

/// One check, its result said in the status: the version unpacked, if there was a newer one for this node.
pub fn check_now(node: Option<&crate::Node>) -> Result<Option<(String, PathBuf)>, String> {
    let machine = platform().ok_or("this machine has no released package")?;
    let checking = Checking::started();
    let r = check(
        &registry(),
        &builtin_root(),
        RUNNING,
        machine,
        &versions(),
        &place(node),
    );
    if let Ok(Checked {
        unpacked: Some((v, dir)),
        targets,
        ..
    }) = &r
    {
        carry_browser(&registry(), targets, v, machine, dir);
    }
    drop(checking);
    let gave_up = word_in(&versions(), GAVE_UP);
    set(|s| match &r {
        Ok(c) => {
            s.error = c.want.as_ref().filter(|w| gave_up.as_ref() == Some(*w) && newer(w, RUNNING)).map(|w| stays_on(w, RUNNING));
            s.ready = c
                .unpacked
                .as_ref()
                .map(|(v, _)| v.clone())
                .or(s.ready.take());
            s.latest = c.want.clone().or(s.latest.take());
            s.min_version = Some(c.targets.min_version.clone());
            s.channel = Some(c.channel.name().into());
            s.halted = c.targets.halt.clone();
        }
        Err(e) => s.error = Some(e.clone()),
    });
    r.map(|c| c.unpacked)
}

/// The owner's `unbrowse update`: checks now, whether or not updates are on, and restarts into a newer release once no
/// call is in flight. A build the release didn't make never updates itself.
pub fn update_now(node: &Arc<crate::Node>) -> Result<Status, String> {
    if !released() {
        return Err("this node was built from source, so it doesn't update itself".into());
    }
    try_gave_up_again(&versions());
    let found = check_now(Some(node));
    node.events.emit("update", ());
    if let Some((v, dir)) = found? {
        if let Some(exe) = program(&dir) {
            let (node, rt) = (node.clone(), tokio::runtime::Handle::current());
            std::thread::spawn(move || restart_when_idle(&node, &rt, exe, v));
        }
    }
    Ok(status())
}

/// Checks now and every six hours; restarts into a newer version once no call is in flight.
pub fn run(node: Arc<crate::Node>) {
    if platform().is_none() {
        return;
    }
    let rt = tokio::runtime::Handle::current();
    // A release this node was started into proves itself by staying up.
    std::thread::spawn(|| {
        std::thread::sleep(PROVEN_AFTER);
        prove(&versions(), RUNNING);
    });
    std::thread::spawn(move || loop {
        if enabled() {
            // A panic in one pass ends that pass, not the node's updates for as long as it runs.
            let pass = std::panic::AssertUnwindSafe(|| {
                node.events.emit("update", ());
                match check_now(Some(&node)) {
                    Ok(Some((v, dir))) => {
                        node.events.emit("update", ());
                        if let Some(exe) = program(&dir) {
                            restart_when_idle(&node, &rt, exe, v);
                        }
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("update: {e}"),
                }
                node.events.emit("update", ());
            });
            if std::panic::catch_unwind(pass).is_err() {
                eprintln!("update: a check panicked; the next one runs as usual");
            }
        }
        std::thread::sleep(Duration::from_secs(6 * 3600));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    fn tried(name: &str, current: &str) -> PathBuf {
        let dir = scratch(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CURRENT), current).unwrap();
        dir
    }

    /// A release that dies as it starts gets its starts and no more: then nothing runs it, `current` no longer names it,
    /// and the node stays on what it has. Nothing the bad release could do would have ended the loop.
    #[test]
    fn a_release_that_never_stays_up_is_given_up_on() {
        let dir = tried("gives-up", "2.0.0");
        assert!(about_to_start(&dir, "2.0.0") && about_to_start(&dir, "2.0.0"));
        assert!(
            !about_to_start(&dir, "2.0.0"),
            "the third start is the one that doesn't happen"
        );
        assert_eq!(word_in(&dir, CURRENT), None);
        assert_eq!(word_in(&dir, GAVE_UP).as_deref(), Some("2.0.0"));
        assert!(
            about_to_start(&dir, "2.0.1"),
            "a newer release starts on a count of its own"
        );
    }

    /// Core #630: a release given up on is forgotten once the node runs it or a newer one, kept while it is still ahead,
    /// and the owner is told how to try it again, which `unbrowse update` does.
    #[test]
    fn a_release_given_up_on_is_forgotten_once_passed_and_the_owner_can_try_it_again() {
        let dir = tried("gave-up-again", "2.0.0");
        give_up(&dir, "2.0.0");
        forget_gave_up_behind(&dir, "1.9.0");
        assert_eq!(word_in(&dir, GAVE_UP).as_deref(), Some("2.0.0"), "still ahead of the node: kept");
        forget_gave_up_behind(&dir, "2.0.1");
        assert_eq!(word_in(&dir, GAVE_UP), None, "a newer install landed: nothing to hold back");
        give_up(&dir, "2.0.0");
        forget_gave_up_behind(&dir, "2.0.0");
        assert_eq!(word_in(&dir, GAVE_UP), None, "the owner put it in by hand");
        give_up(&dir, "2.0.0");
        assert!(stays_on("2.0.0", "1.9.0").contains("`unbrowse update` tries 2.0.0 again"));
        try_gave_up_again(&dir);
        assert_eq!(word_in(&dir, GAVE_UP), None);
        assert!(about_to_start(&dir, "2.0.0"), "and it starts on a count of its own");
    }

    /// A release that stops before it proves itself can't say why, so each start notes how far it got, and the start that
    /// gives up on it says so. Its count starts afresh each start; what any other program notes is no part of it.
    #[test]
    fn giving_up_says_how_far_the_latest_start_got() {
        let dir = tried("how-far", "2.0.0");
        assert!(how_far(&dir, "2.0.0").contains("noted nothing"));
        assert!(about_to_start(&dir, "2.0.0"));
        note_reached(&dir, "2.0.0", "it started");
        note_reached(&dir, "1.9.0", "not the release on trial");
        note_reached(&dir, "2.0.0", "it stopped: a node was already running here (pid 7)");
        assert!(about_to_start(&dir, "2.0.0"));
        assert!(how_far(&dir, "2.0.0").contains("noted nothing"), "a new start's notes start empty");
        note_reached(&dir, "2.0.0", "it started");
        note_reached(&dir, "2.0.0", "it stopped: port 7788: address in use");
        let why = how_far(&dir, "2.0.0");
        assert_eq!(why, "its latest start noted: it started; it stopped: port 7788: address in use");
        assert!(how_far(&dir, "2.0.1").contains("noted nothing"), "another release's notes aren't this one's");
        assert!(!about_to_start(&dir, "2.0.0"));
    }

    /// Staying up ends the trial: a proved release is started as often as a machine restarts, and counts nothing.
    #[test]
    fn a_release_that_stayed_up_is_never_counted_again() {
        let dir = tried("proved", "2.0.0");
        assert!(about_to_start(&dir, "2.0.0"));
        prove(&dir, "1.9.0");
        assert_eq!(
            word_in(&dir, PROVED),
            None,
            "what runs now isn't the release on trial"
        );
        prove(&dir, "2.0.0");
        assert_eq!(word_in(&dir, PROVED).as_deref(), Some("2.0.0"));
        for _ in 0..5 {
            assert!(about_to_start(&dir, "2.0.0"));
        }
        assert_eq!(
            turn_of("2.0.0", Some("2.0.0"), &Trial::default()),
            Turn::Proved
        );
        assert_eq!(
            turn_of(
                "2.0.1",
                Some("2.0.0"),
                &Trial {
                    version: "2.0.0".into(),
                    starts: 9,
                    reached: Vec::new(),
                }
            ),
            Turn::Try(1)
        );
    }

    /// `current` is what every start reads: halted, or with the channel moved back past it or the owner on another,
    /// it stops naming a release this node hasn't run, whichever comes first, a check or a start.
    #[test]
    fn a_release_the_metadata_took_back_is_no_longer_started() {
        let targets = |stable: &str, canary: Option<&str>, halt: Option<&str>| -> Targets {
            serde_json::from_value(json!({ "_type": "targets", "version": 1, "expires": 9, "min_version": "1.0.0", "channels": { "stable": stable, "canary": canary }, "canary_share": 10, "halt": halt, "releases": {} })).unwrap()
        };
        let knows = |chosen| Place {
            chosen,
            seed: Some("0xabc".into()),
            now: 1,
        };
        let at_start = Place {
            chosen: None,
            seed: None,
            now: 1,
        };
        assert!(still_wanted(
            "2.0.0",
            &targets("2.0.0", None, None),
            &knows(None)
        ));
        assert!(
            still_wanted("2.0.0", &targets("2.1.0", None, None), &knows(None)),
            "the channel went past it: still on the way there"
        );
        assert!(
            !still_wanted("2.0.0", &targets("1.9.0", None, None), &knows(None)),
            "moved back"
        );
        assert!(
            !still_wanted(
                "2.0.0",
                &targets("2.0.0", None, Some("a bad release")),
                &knows(None)
            ),
            "halted"
        );
        assert!(
            !still_wanted(
                "2.1.0",
                &targets("2.0.0", Some("2.1.0"), None),
                &knows(Some(Channel::Stable))
            ),
            "the owner picked stable"
        );
        assert!(
            still_wanted("2.1.0", &targets("2.0.0", Some("2.1.0"), None), &at_start),
            "its place in the rollout isn't known yet"
        );
        assert!(!still_wanted(
            "2.2.0",
            &targets("2.0.0", Some("2.1.0"), None),
            &at_start
        ));
        let dir = tried("took-back", "2.0.0");
        forget_unwanted(&dir, &targets("2.0.0", None, None), &knows(None), "1.0.0");
        assert_eq!(word_in(&dir, CURRENT).as_deref(), Some("2.0.0"));
        forget_unwanted(&dir, &targets("1.9.0", None, None), &knows(None), "1.0.0");
        assert_eq!(word_in(&dir, CURRENT), None);
    }

    /// The node doesn't leave the network for a program that can't start: this is the check it makes while it still can
    /// stay. A program it can't start is said, and so is one that starts and fails.
    #[cfg(unix)]
    #[test]
    fn a_release_that_cant_start_is_found_before_the_node_leaves() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("answers");
        std::fs::create_dir_all(&dir).unwrap();
        let program = |name: &str, body: &str, mode: u32| {
            let p = dir.join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            p
        };
        assert!(answers(&program("fine", "#!/bin/sh\nexit 0\n", 0o755)).is_ok());
        assert!(answers(&program("dies", "#!/bin/sh\nexit 3\n", 0o755)).is_err());
        assert!(answers(&program("not-runnable", "#!/bin/sh\nexit 0\n", 0o644)).is_err());
        assert!(answers(&dir.join("not-there")).is_err());
        assert!(
            hand_over(&dir.join("not-there"))
                .unwrap_err()
                .contains("couldn't start"),
            "and a hand-over that fails says so to its caller"
        );
    }

    /// A restart waits on the owner past where it stops waiting on a call: a call stuck for an hour doesn't hold updates
    /// back for good, while a page in the owner's hands is theirs to finish.
    #[test]
    fn a_restart_waits_for_the_owner_longer_than_for_a_call() {
        let min = |m: u64| Duration::from_secs(m * 60);
        assert!(!waits_on(0, false, min(0)));
        assert!(waits_on(1, false, min(59)));
        assert!(
            !waits_on(1, false, min(60)),
            "a stuck call doesn't stop updates"
        );
        assert!(
            waits_on(0, true, min(61)) && waits_on(1, true, min(61)),
            "an ask or a held page goes on being waited for"
        );
        assert!(!waits_on(0, true, min(240)));
    }

    /// A panic in a check used to leave `checking` said for as long as the node ran, with no check ever coming.
    #[test]
    fn a_check_that_panics_doesnt_stay_checking() {
        let _ = std::panic::catch_unwind(|| {
            let _checking = Checking::started();
            panic!("a pass panics");
        });
        assert!(!status().checking);
    }

    /// A restart after a new build was copied over the running program starts the new build at the program's path:
    /// Linux names the replaced program `<path> (deleted)`, a file that isn't there.
    #[test]
    fn a_restart_starts_the_program_that_replaced_this_one() {
        let dir = scratch("replaced");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("unbrowse-node");
        std::fs::write(&exe, b"new build").unwrap();
        assert_eq!(at_its_path(dir.join("unbrowse-node (deleted)")), exe);
        assert_eq!(at_its_path(exe.clone()), exe);
        // A program truly named so is left as it is.
        let odd = dir.join("odd (deleted)");
        std::fs::write(&odd, b"x").unwrap();
        assert_eq!(at_its_path(odd.clone()), odd);
    }
    use std::io::Write;

    /// A test key from a fixed seed. Never a release key: these exist only here and in the script's tests.
    fn test_key(seed: u8) -> (SigningKey, String) {
        let k = SigningKey::from_bytes(&[seed; 32]);
        let public = hex::encode(k.verifying_key().to_bytes());
        (k, public)
    }

    fn key() -> (SigningKey, String) {
        test_key(7)
    }

    fn tgz(files: &[(&str, &[u8], u32)]) -> Vec<u8> {
        tgz_of(files, tar::EntryType::Regular)
    }

    fn tgz_of(files: &[(&str, &[u8], u32)], kind: tar::EntryType) -> Vec<u8> {
        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for (path, data, mode) in files {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(kind);
            h.set_size(data.len() as u64);
            h.set_mode(*mode);
            // Written raw so a test can name a path outside the package, as a hostile tarball would.
            h.as_gnu_mut().unwrap().name[..path.len()].copy_from_slice(path.as_bytes());
            h.set_cksum();
            b.append(&h, *data).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap()
    }

    /// A metadata file: `signed`, signed by each of `keys`.
    fn sign(signed: &Value, keys: &[&SigningKey]) -> Vec<u8> {
        let bytes = canonical(signed);
        let sigs: Vec<Value> =
            keys.iter().map(|k| json!({ "keyid": hex::encode(k.verifying_key().to_bytes()), "sig": hex::encode(k.sign(&bytes).to_bytes()) })).collect();
        serde_json::to_vec_pretty(&json!({ "signed": signed, "signatures": sigs })).unwrap()
    }

    const NOW: u64 = 1_800_000_000;
    const DAY: u64 = 86_400;

    fn role(keys: &[&str], threshold: usize) -> Value {
        json!({ "keys": keys, "threshold": threshold })
    }

    fn root_json(version: u64, root: Value, targets: Value, timestamp: Value) -> Value {
        json!({ "_type": "root", "version": version, "expires": NOW + 365 * DAY, "roles": { "root": root, "targets": targets, "timestamp": timestamp } })
    }

    fn targets_json(
        version: u64,
        stable: &str,
        canary: Option<&str>,
        share: u8,
        halt: Option<&str>,
        releases: Value,
    ) -> Value {
        json!({ "_type": "targets", "version": version, "expires": NOW + 365 * DAY, "min_version": "13.0.0", "releases": releases,
            "channels": { "stable": stable, "canary": canary }, "canary_share": share, "halt": halt })
    }

    fn timestamp_json(version: u64, expires: u64, targets: &[u8]) -> Value {
        let t: Value = serde_json::from_slice(targets).unwrap();
        json!({ "_type": "timestamp", "version": version, "expires": expires,
            "targets": { "version": t["signed"]["version"], "sha256": hex::encode(Sha256::digest(targets)) } })
    }

    /// The metadata package's files, by their path in it.
    type Files = BTreeMap<String, Vec<u8>>;

    fn reader(files: &Files) -> impl Fn(&str) -> Result<Option<Vec<u8>>, String> + '_ {
        move |p| Ok(files.get(p).cloned())
    }

    /// Targets and a timestamp for them, signed by `tk` and `sk`.
    fn metadata(
        targets: &Value,
        tk: &SigningKey,
        ts_version: u64,
        expires: u64,
        sk: &SigningKey,
    ) -> Files {
        let t = sign(targets, &[tk]);
        let ts = sign(&timestamp_json(ts_version, expires, &t), &[sk]);
        [
            ("targets.json".to_string(), t),
            ("timestamp.json".to_string(), ts),
        ]
        .into()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("unbrowse-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// Only the release key's signature over the exact bytes counts: a changed byte or another key is refused.
    #[test]
    fn only_a_manifest_the_release_key_signed_is_read() {
        let (k, public) = key();
        let m = br#"{"version":"13.2.0","min_version":"13.0.0","platforms":{}}"#;
        let sig = hex::encode(k.sign(m).to_bytes());
        assert_eq!(verify(m, &sig, &public).unwrap().version, "13.2.0");
        let mut changed = m.to_vec();
        changed[13] = b'9';
        assert!(verify(&changed, &sig, &public).is_err());
        let (_, other) = test_key(8);
        assert!(verify(m, &sig, &other).is_err());
        assert!(verify(m, "not hex", &public).is_err());
    }

    /// What the release writes for nodes from before the metadata (`.github/scripts/sign-manifest.mjs`, signed with the
    /// real release key in a dry run of the release on stand-in programs) is what such a node reads with the key it
    /// trusts.
    #[test]
    fn the_node_reads_the_manifest_the_release_signs() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/release");
        let m = std::fs::read(dir.join("manifest.json")).unwrap();
        let sig = std::fs::read_to_string(dir.join("manifest.sig")).unwrap();
        let read = verify(&m, &sig, RELEASE_KEY).expect("the release key's signature");
        assert_eq!(read.min_version, "13.0.0");
        assert_eq!(read.platforms.len(), 5);
        assert!(read
            .platforms
            .values()
            .all(|p| p.name.starts_with("@unbrowse/") && p.integrity.starts_with("sha512-")));
    }

    /// What `.github/scripts/updates.mjs` writes, with test keys, is what the node checks: the same canonical bytes,
    /// the same roles. The script's own test (`.github/scripts/test/updates.test.mjs`) writes these files again and
    /// fails if they differ.
    #[test]
    fn the_node_reads_the_metadata_the_release_script_signs() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/updates");
        let files: Files = ["root/2.root.json", "targets.json", "timestamp.json"]
            .iter()
            .map(|p| {
                (
                    p.to_string(),
                    std::fs::read(dir.join(p)).unwrap_or_else(|e| panic!("{p}: {e}")),
                )
            })
            .collect();
        // The script's test keys: seed 1 the release key the built-in root names, 2 and 3 the new root's root keys,
        // 4 its targets key, 5 its timestamp key.
        let builtin = builtin_root_of(&test_key(1).1);
        let home = scratch("fixture");
        let t = check_metadata(&builtin, &reader(&files), &home, 1_790_000_000)
            .expect("the script's metadata checks");
        assert_eq!(t.channels.canary.as_deref(), Some("13.6.0"));
        assert_eq!(t.channels.stable, "13.5.0");
        assert_eq!(t.canary_share, 10);
        assert!(t.releases["13.6.0"].platforms["linux-x64"]
            .integrity
            .starts_with("sha512-"));
        assert_eq!(trusted_in(&builtin, &home).root.roles.root.threshold, 2);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn canonical_bytes_sort_every_key_and_drop_space() {
        let v: Value =
            serde_json::from_str(r#"{ "b": [1, {"z": "é\n", "a": null}], "a": true }"#).unwrap();
        assert_eq!(
            String::from_utf8(canonical(&v)).unwrap(),
            r#"{"a":true,"b":[1,{"a":null,"z":"é\n"}]}"#
        );
    }

    #[test]
    fn versions_compare_as_releases() {
        assert!(newer("13.10.0", "13.9.1"));
        assert!(!newer("13.1.0", "13.1.0"));
        assert!(!newer("0.1.0", "13.0.0"));
        assert!(!newer("garbage", "13.0.0"));
    }

    /// A timestamp past its expiry is refused, however well signed: a mirror that keeps serving the metadata it had
    /// can hold a node back a week at most, and the node says so. A fresh one is taken.
    #[test]
    fn expired_timestamp_metadata_is_refused() {
        let (k, public) = key();
        let builtin = builtin_root_of(&public);
        let home = scratch("expired");
        let t = targets_json(1, "13.2.0", None, 0, None, json!({}));
        let stale = metadata(&t, &k, 1, NOW - 1, &k);
        let e = check_metadata(&builtin, &reader(&stale), &home, NOW).unwrap_err();
        assert!(e.contains("timestamp expired"), "{e}");
        assert!(
            trusted_in(&builtin, &home).timestamp.is_none(),
            "nothing expired is kept"
        );
        let fresh = metadata(&t, &k, 2, NOW + 7 * DAY, &k);
        assert_eq!(
            check_metadata(&builtin, &reader(&fresh), &home, NOW)
                .unwrap()
                .channels
                .stable,
            "13.2.0"
        );
        // The same metadata a week later is stale.
        assert!(
            check_metadata(&builtin, &reader(&fresh), &home, NOW + 8 * DAY)
                .unwrap_err()
                .contains("timestamp expired")
        );
        // Targets past their own expiry are refused too, under a fresh timestamp.
        let mut old = t.clone();
        old["version"] = json!(2);
        old["expires"] = json!(NOW - 1);
        assert!(check_metadata(
            &builtin,
            &reader(&metadata(&old, &k, 3, NOW + DAY, &k)),
            &home,
            NOW
        )
        .unwrap_err()
        .contains("expired"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A node follows the owner's rotation from the root it trusts: root 2 signed by root 1's key and by its own two of
    /// three, naming new targets and timestamp keys. From then on only the new keys sign; what the old key signs is
    /// refused, and a root signed by the new keys alone, or out of order, is never taken.
    #[test]
    fn a_rotated_root_is_followed() {
        let (release, release_pub) = test_key(1);
        let (r1, r1p) = test_key(2);
        let (r2, r2p) = test_key(3);
        let (_, r3p) = test_key(9);
        let (tk, tkp) = test_key(4);
        let (sk, skp) = test_key(5);
        let builtin = builtin_root_of(&release_pub);
        let home = scratch("rotate");
        let t = targets_json(1, "13.2.0", None, 0, None, json!({}));

        let root2 = root_json(
            2,
            role(&[&r1p, &r2p, &r3p], 2),
            role(&[&tkp], 1),
            role(&[&skp], 1),
        );
        // One of the new root keys isn't enough of them.
        let mut files = metadata(&t, &tk, 1, NOW + DAY, &sk);
        files.insert("root/2.root.json".into(), sign(&root2, &[&release, &r1]));
        assert!(check_metadata(&builtin, &reader(&files), &home, NOW)
            .unwrap_err()
            .contains("by its own keys"));
        // The new keys alone, without root 1's say, aren't either.
        files.insert("root/2.root.json".into(), sign(&root2, &[&r1, &r2]));
        assert!(check_metadata(&builtin, &reader(&files), &home, NOW)
            .unwrap_err()
            .contains("by root 1's keys"));
        // Both: followed, and the new targets and timestamp keys sign from now on.
        files.insert(
            "root/2.root.json".into(),
            sign(&root2, &[&release, &r1, &r2]),
        );
        check_metadata(&builtin, &reader(&files), &home, NOW).expect("root 2 is followed");
        assert_eq!(trusted_in(&builtin, &home).root.version, 2);

        // The release key signs no more targets: root 2 doesn't name it.
        let mut by_old = metadata(
            &targets_json(2, "13.3.0", None, 0, None, json!({})),
            &release,
            2,
            NOW + DAY,
            &sk,
        );
        by_old.insert("root/2.root.json".into(), files["root/2.root.json"].clone());
        assert!(check_metadata(&builtin, &reader(&by_old), &home, NOW)
            .unwrap_err()
            .contains("targets isn't signed"));

        // Root 3, signed by root 2's keys and its own, follows; one skipping a version doesn't.
        let root3 = root_json(
            3,
            role(&[&r1p, &r2p], 2),
            role(&[&tkp], 1),
            role(&[&skp], 1),
        );
        let mut later = metadata(
            &targets_json(3, "13.3.0", None, 0, None, json!({})),
            &tk,
            3,
            NOW + DAY,
            &sk,
        );
        later.insert("root/3.root.json".into(), sign(&root3, &[&r1, &r2]));
        check_metadata(&builtin, &reader(&later), &home, NOW).expect("root 3 is followed");
        assert_eq!(trusted_in(&builtin, &home).root.version, 3);
        let skipped = root_json(
            5,
            role(&[&r1p, &r2p], 2),
            role(&[&tkp], 1),
            role(&[&skp], 1),
        );
        assert!(next_root(
            &trusted_in(&builtin, &home).root,
            &sign(&skipped, &[&r1, &r2])
        )
        .unwrap_err()
        .contains("comes where root 4"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The online release key is only a one-time root-rotation cosigner: it cannot satisfy the new offline root
    /// threshold alone or sign targets after the root moves it out of that role.
    #[test]
    fn online_signer_cannot_authorize_new_root_or_binary() {
        let (release, release_pub) = test_key(1);
        let (root_a, root_a_pub) = test_key(2);
        let (root_b, root_b_pub) = test_key(3);
        let (targets_key, targets_pub) = test_key(4);
        let (timestamp_key, timestamp_pub) = test_key(5);
        let builtin = builtin_root_of(&release_pub);
        let home = scratch("online-signer-boundary");
        let root2 = root_json(
            2,
            role(&[&root_a_pub, &root_b_pub], 2),
            role(&[&targets_pub], 1),
            role(&[&timestamp_pub], 1),
        );

        let release_only_root = sign(&root2, &[&release]);
        assert!(next_root(&builtin, &release_only_root)
            .unwrap_err()
            .contains("by its own keys"));

        let mut files = metadata(
            &targets_json(1, "13.2.0", None, 0, None, json!({})),
            &release,
            1,
            NOW + DAY,
            &timestamp_key,
        );
        files.insert(
            "root/2.root.json".into(),
            sign(&root2, &[&release, &root_a, &root_b]),
        );
        // Even a valid root rotation cannot make the old online signer a targets signer or authorize a binary.
        let error = check_metadata(&builtin, &reader(&files), &home, NOW).unwrap_err();
        assert!(error.contains("targets isn't signed"), "{error}");

        // The distinct online targets and timestamp roles can authorize metadata after the rotation.
        let mut authorized = metadata(
            &targets_json(2, "13.2.0", None, 0, None, json!({})),
            &targets_key,
            2,
            NOW + DAY,
            &timestamp_key,
        );
        authorized.insert("root/2.root.json".into(), files["root/2.root.json"].clone());
        check_metadata(&builtin, &reader(&authorized), &home, NOW)
            .expect("the new online roles remain usable");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Only the offline root threshold, not the online release signer alone or with one cosigner, can authorize a new root.
    #[test]
    fn offline_root_is_required_to_rotate_online_keys() {
        let (release, release_pub) = test_key(1);
        let (root_a, root_a_pub) = test_key(2);
        let (root_b, root_b_pub) = test_key(3);
        let (_targets, targets_pub) = test_key(4);
        let (_, timestamp_pub) = test_key(5);
        let builtin = builtin_root_of(&release_pub);
        let root2 = root_json(
            2,
            role(&[&root_a_pub, &root_b_pub], 2),
            role(&[&targets_pub], 1),
            role(&[&timestamp_pub], 1),
        );
        assert!(next_root(&builtin, &sign(&root2, &[&release])).is_err());
        assert!(next_root(&builtin, &sign(&root2, &[&release, &root_a])).is_err());
        assert!(next_root(&builtin, &sign(&root2, &[&release, &root_a, &root_b])).is_ok());
    }

    #[test]
    fn status_names_the_temporary_single_online_update_root() {
        assert_eq!(
            status().update_root_warning.as_deref(),
            Some("update root is a single online key")
        );
    }

    #[test]
    fn successor_shape_rules_do_not_prove_the_online_root_is_offline() {
        let (release, release_pub) = test_key(1);
        let (root_a, root_a_pub) = test_key(2);
        let (root_b, root_b_pub) = test_key(3);
        let (_, targets_pub) = test_key(4);
        let (_, timestamp_pub) = test_key(5);
        let builtin = builtin_root_of(&release_pub);

        let attacker_threshold_one = root_json(
            2,
            role(&[&root_a_pub, &root_b_pub], 1),
            role(&[&targets_pub], 1),
            role(&[&timestamp_pub], 1),
        );
        assert!(next_root(
            &builtin,
            &sign(&attacker_threshold_one, &[&release, &root_a])
        )
        .is_err());

        let attacker_reuses_online_key = root_json(
            2,
            role(&[&root_a_pub, &release_pub], 2),
            role(&[&targets_pub], 1),
            role(&[&timestamp_pub], 1),
        );
        assert!(next_root(
            &builtin,
            &sign(&attacker_reuses_online_key, &[&release, &root_a])
        )
        .is_err());

        // This only demonstrates accepted root shape when the old online trust root and new keys cooperate.
        let shape_example = root_json(
            2,
            role(&[&root_a_pub, &root_b_pub], 2),
            role(&[&targets_pub], 1),
            role(&[&timestamp_pub], 1),
        );
        assert!(next_root(
            &builtin,
            &sign(&shape_example, &[&release, &root_a, &root_b])
        )
        .is_ok());
    }

    #[test]
    fn a_kept_root_that_does_not_chain_from_the_builtin_root_is_ignored() {
        let (online, _online_pub) = test_key(1);
        let (_, offline_a) = test_key(31);
        let (_, offline_b) = test_key(32);
        let (_, target_a) = test_key(37);
        let (_, target_b) = test_key(38);
        let (_, timestamp) = test_key(39);
        let builtin = builtin_root_with_roles_and_roles(
            &[&offline_a, &offline_b],
            &[&target_a, &target_b],
            &[&timestamp],
        );
        let (attacker_a, attacker_a_pub) = test_key(33);
        let (attacker_b, attacker_b_pub) = test_key(34);
        let (_, target_pub) = test_key(35);
        let (_, timestamp_pub) = test_key(36);
        let planted = root_json(
            2,
            role(&[&attacker_a_pub, &attacker_b_pub], 2),
            role(&[&target_pub], 1),
            role(&[&timestamp_pub], 1),
        );
        let bytes = sign(&planted, &[&online, &attacker_a, &attacker_b]);
        let home = scratch("planted-root");
        std::fs::create_dir_all(&home).unwrap();
        let kept = Kept {
            roots: vec![hex::encode(bytes)],
            root: None,
            timestamp: None,
            targets: None,
        };
        std::fs::write(home.join(TRUST), serde_json::to_vec(&kept).unwrap()).unwrap();
        assert_eq!(trusted_in(&builtin, &home).root.version, 2);
        assert_eq!(
            trusted_in(&builtin, &home).root.roles.root.keys,
            builtin.roles.root.keys
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_kept_online_era_root_does_not_hide_a_later_offline_rotation() {
        let (online, _online_pub) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[5]);
        let (offline_a, offline_a_pub) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[0]);
        let (offline_b, offline_b_pub) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[1]);
        let (_, targets_a) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[2]);
        let (_, targets_b) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[3]);
        let (_, timestamp) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[4]);
        let builtin = builtin_root_with_roles_and_roles(
            &[&offline_a_pub, &offline_b_pub],
            &[&targets_a, &targets_b],
            &[&timestamp],
        );

        let (old_a, old_a_pub) = test_key(51);
        let (old_b, old_b_pub) = test_key(52);
        let (_, old_targets) = test_key(53);
        let (_, old_timestamp) = test_key(54);
        let online_era_root2 = root_json(
            2,
            role(&[&old_a_pub, &old_b_pub], 2),
            role(&[&old_targets], 1),
            role(&[&old_timestamp], 1),
        );
        let online_era_root2 = sign(&online_era_root2, &[&online, &old_a, &old_b]);

        let (next_a, next_a_pub) = test_key(55);
        let (next_b, next_b_pub) = test_key(56);
        let (_, next_targets) = test_key(57);
        let (_, next_timestamp) = test_key(58);
        let offline_root3 = root_json(
            3,
            role(&[&next_a_pub, &next_b_pub], 2),
            role(&[&next_targets], 1),
            role(&[&next_timestamp], 1),
        );
        let offline_root3 = sign(&offline_root3, &[&offline_a, &offline_b, &next_a, &next_b]);

        let home = scratch("transition-root-chain");
        std::fs::create_dir_all(&home).unwrap();
        let kept = Kept {
            roots: vec![hex::encode(&offline_root3), hex::encode(&online_era_root2)],
            root: None,
            timestamp: None,
            targets: None,
        };
        std::fs::write(home.join(TRUST), serde_json::to_vec(&kept).unwrap()).unwrap();

        assert_eq!(trusted_in(&builtin, &home).root.version, 3);
        for _ in 0..3 {
            keep_files(&builtin, &home, None, None, None).unwrap();
        }
        let normalized: Kept = store::read_json(&home.join(TRUST), &unbrowse_files::TRUST);
        assert_eq!(normalized.roots, vec![hex::encode(&offline_root3)]);
        assert_eq!(trusted_in(&builtin, &home).root.version, 3);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_root_without_the_offline_threshold_is_refused_after_transition() {
        let (offline_a, pub_a) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[0]);
        let (offline_b, pub_b) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[1]);
        let (release, _release_pub) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[5]);
        let (_, target_a) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[2]);
        let (_, target_b) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[3]);
        let (_, timestamp) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[4]);
        let builtin = builtin_root_with_roles_and_roles(
            &[&pub_a, &pub_b],
            &[&target_a, &target_b],
            &[&timestamp],
        );
        let (next_a, next_a_pub) = test_key(44);
        let (next_b, next_b_pub) = test_key(45);
        let (_, target_pub) = test_key(46);
        let (_, timestamp_pub) = test_key(47);
        let successor = root_json(
            3,
            role(&[&next_a_pub, &next_b_pub], 2),
            role(&[&target_pub], 1),
            role(&[&timestamp_pub], 1),
        );
        assert!(next_root(&builtin, &sign(&successor, &[&release, &offline_a])).is_err());
        assert!(next_root(
            &builtin,
            &sign(&successor, &[&offline_a, &offline_b, &next_a, &next_b])
        )
        .is_ok());
    }

    /// Once a node has checked a timestamp and targets, older ones are refused even when every signature is good: a
    /// registry, or someone answering for it, can't roll the metadata back.
    #[test]
    fn rolled_back_metadata_is_refused() {
        let (k, public) = key();
        let builtin = builtin_root_of(&public);
        let home = scratch("rollback");
        let new = metadata(
            &targets_json(5, "13.3.0", None, 0, None, json!({})),
            &k,
            5,
            NOW + DAY,
            &k,
        );
        check_metadata(&builtin, &reader(&new), &home, NOW).unwrap();
        let old_ts = metadata(
            &targets_json(5, "13.3.0", None, 0, None, json!({})),
            &k,
            4,
            NOW + DAY,
            &k,
        );
        assert!(check_metadata(&builtin, &reader(&old_ts), &home, NOW)
            .unwrap_err()
            .contains("timestamp 4 is older than 5"));
        let old_targets = metadata(
            &targets_json(4, "13.2.0", None, 0, None, json!({})),
            &k,
            6,
            NOW + DAY,
            &k,
        );
        assert!(check_metadata(&builtin, &reader(&old_targets), &home, NOW)
            .unwrap_err()
            .contains("targets 4 are older than 5"));
        // A timestamp whose targets aren't the file served beside it.
        let mut mixed = new.clone();
        mixed.insert(
            "targets.json".into(),
            sign(&targets_json(5, "13.9.0", None, 0, None, json!({})), &[&k]),
        );
        assert!(check_metadata(&builtin, &reader(&mixed), &home, NOW)
            .unwrap_err()
            .contains("aren't the ones its timestamp names"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A node's place for a release's canary is the same at every check, about the share the targets say, and only
    /// grows as the share does.
    #[test]
    fn a_canary_share_picks_the_same_nodes_and_about_that_many() {
        let t = |share| targets_json(1, "13.2.0", Some("13.3.0"), share, None, json!({}));
        let t10: Targets = serde_json::from_value(t(10)).unwrap();
        let t50: Targets = serde_json::from_value(t(50)).unwrap();
        let at = |seed: String, chosen| Place {
            chosen,
            seed: Some(seed),
            now: NOW,
        };
        let canary_at = |t: &Targets| {
            (0..2000)
                .filter(|i| choose(t, &at(format!("0x{i:040x}"), None)).0 == Channel::Canary)
                .collect::<BTreeSet<_>>()
        };
        let (ten, fifty) = (canary_at(&t10), canary_at(&t50));
        assert!(
            (150..250).contains(&ten.len()),
            "{} of 2000 at 10%",
            ten.len()
        );
        assert!(
            ten.is_subset(&fifty),
            "raising the share keeps the nodes already on canary"
        );
        assert_eq!(canary_at(&t10), ten, "the same nodes at every check");
        // A node that picked its channel runs it, whatever its hash.
        let some = ten.iter().next().copied().unwrap();
        assert_eq!(
            choose(&t10, &at(format!("0x{some:040x}"), Some(Channel::Stable))),
            (Channel::Stable, Some("13.2.0".into()))
        );
        assert_eq!(
            choose(
                &t10,
                &Place {
                    chosen: Some(Channel::Canary),
                    seed: None,
                    now: NOW
                }
            ),
            (Channel::Canary, Some("13.3.0".into()))
        );
        // No identity yet and no channel picked: stable.
        assert_eq!(
            choose(
                &t10,
                &Place {
                    chosen: None,
                    seed: None,
                    now: NOW
                }
            )
            .0,
            Channel::Stable
        );
    }

    /// A package's files land under the folder, programs runnable; a path that climbs out is refused.
    #[test]
    fn a_package_unpacks_inside_its_folder_only() {
        let dir = scratch("unpack");
        unpack(
            &tgz(&[
                ("package/bin/unbrowse-node", b"node", 0o755),
                ("package/LICENSE", b"l", 0o644),
            ]),
            &dir,
        )
        .unwrap();
        assert!(program(&dir).is_some() || cfg!(windows));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.join("bin/unbrowse-node"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0o111
            );
        }
        let out = dir.join("escape");
        assert!(unpack(
            &tgz(&[("package/../escape", b"x", 0o644)]),
            &dir.join("inner")
        )
        .is_err());
        assert!(!out.exists());
        // A link could carry a later file anywhere: none is unpacked.
        assert!(unpack(
            &tgz_of(&[("package/bin/away", b"", 0o777)], tar::EntryType::Symlink),
            &dir.join("links")
        )
        .is_err());
        assert!(!dir.join("links/bin/away").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A release for linux-x64 whose node program holds `node`, and its entry in the targets.
    fn release(node: &[u8]) -> (Vec<u8>, Value) {
        let pkg = tgz(&[("package/bin/unbrowse-node", node, 0o755)]);
        let entry = json!({ "platforms": { "linux-x64": { "name": "@unbrowse/linux-x64", "integrity": integrity(&pkg) } } });
        (pkg, entry)
    }

    /// The metadata package of `files`, as npm serves it.
    fn metadata_package(files: &Files) -> Vec<u8> {
        let paths: Vec<(String, Vec<u8>)> = files
            .iter()
            .map(|(p, b)| (format!("package/{p}"), b.clone()))
            .collect();
        tgz(&paths
            .iter()
            .map(|(p, b)| (p.as_str(), b.as_slice(), 0o644))
            .collect::<Vec<_>>())
    }

    /// The whole check against a registry of its own: the metadata package npm calls latest, checked, then the
    /// machine's package for the version this node's channel runs, checked against the targets' integrity, unpacked
    /// and named current. A package whose bytes aren't the targets' is refused.
    #[test]
    fn a_newer_release_is_fetched_checked_and_unpacked() {
        let home = scratch("fetch");
        let versions = home.join("versions");
        let (k, public) = key();
        let builtin = builtin_root_of(&public);
        let (machine, entry) = release(b"the new node");
        let tampered = tgz(&[("package/bin/unbrowse-node", b"someone else's node", 0o755)]);
        let files = metadata(
            &targets_json(1, "13.2.0", None, 0, None, json!({ "13.2.0": entry })),
            &k,
            1,
            NOW + DAY,
            &k,
        );
        let stable = Place {
            chosen: None,
            seed: Some("0xabc".into()),
            now: NOW,
        };

        for (served, ok) in [(tampered, false), (machine.clone(), true)] {
            let reg = serve(vec![
                (METADATA_PACKAGE, "1.0.1", metadata_package(&files)),
                ("@unbrowse/linux-x64", "13.2.0", served),
            ]);
            let r = check(&reg, &builtin, "13.1.0", "linux-x64", &versions, &stable);
            if !ok {
                assert!(r
                    .unwrap_err()
                    .contains("isn't the package the release made"));
                assert!(!versions.join("13.2.0").exists());
                continue;
            }
            let (v, dir) = r.unwrap().unpacked.expect("an update");
            assert_eq!(v, "13.2.0");
            assert_eq!(
                std::fs::read(dir.join("bin/unbrowse-node")).unwrap(),
                b"the new node"
            );
            assert_eq!(
                std::fs::read_to_string(versions.join("current")).unwrap(),
                "13.2.0"
            );
        }
        // Already current: nothing to do.
        let reg = serve(vec![(METADATA_PACKAGE, "1.0.1", metadata_package(&files))]);
        assert!(
            check(&reg, &builtin, "13.2.0", "linux-x64", &versions, &stable)
                .unwrap()
                .unpacked
                .is_none()
        );
        // Stable moved back to an older release, signed and current: the node doesn't follow it down.
        let back = metadata(
            &targets_json(
                2,
                "13.1.5",
                None,
                0,
                None,
                json!({ "13.1.5": release(b"old").1 }),
            ),
            &k,
            2,
            NOW + DAY,
            &k,
        );
        let reg = serve(vec![(METADATA_PACKAGE, "1.0.2", metadata_package(&back))]);
        assert!(
            check(&reg, &builtin, "13.2.0", "linux-x64", &versions, &stable)
                .unwrap()
                .unpacked
                .is_none()
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A release on canary reaches the nodes on canary and no other: one that picked canary, and those the share
    /// draws, unpack it; one on stable keeps to stable's release.
    #[test]
    fn a_canary_release_reaches_only_canary_nodes() {
        let home = scratch("canary");
        let (k, public) = key();
        let builtin = builtin_root_of(&public);
        let (stable_pkg, stable_entry) = release(b"stable node");
        let (canary_pkg, canary_entry) = release(b"canary node");
        let t = targets_json(
            1,
            "13.2.0",
            Some("13.3.0"),
            10,
            None,
            json!({ "13.2.0": stable_entry, "13.3.0": canary_entry }),
        );
        let files = metadata(&t, &k, 1, NOW + DAY, &k);
        let reg = serve(vec![
            (METADATA_PACKAGE, "1.0.1", metadata_package(&files)),
            ("@unbrowse/linux-x64", "13.2.0", stable_pkg),
            ("@unbrowse/linux-x64", "13.3.0", canary_pkg),
        ]);
        let targets: Targets = serde_json::from_value(t).unwrap();
        let drawn = (0..1000)
            .map(|i| format!("0x{i:040x}"))
            .find(|s| {
                choose(
                    &targets,
                    &Place {
                        chosen: None,
                        seed: Some(s.clone()),
                        now: NOW,
                    },
                )
                .0 == Channel::Canary
            })
            .unwrap();
        let left = (0..1000)
            .map(|i| format!("0x{i:040x}"))
            .find(|s| {
                choose(
                    &targets,
                    &Place {
                        chosen: None,
                        seed: Some(s.clone()),
                        now: NOW,
                    },
                )
                .0 == Channel::Stable
            })
            .unwrap();
        for (name, place, runs) in [
            (
                "picked-canary",
                Place {
                    chosen: Some(Channel::Canary),
                    seed: None,
                    now: NOW,
                },
                "canary node",
            ),
            (
                "drawn",
                Place {
                    chosen: None,
                    seed: Some(drawn),
                    now: NOW,
                },
                "canary node",
            ),
            (
                "picked-stable",
                Place {
                    chosen: Some(Channel::Stable),
                    seed: None,
                    now: NOW,
                },
                "stable node",
            ),
            (
                "left",
                Place {
                    chosen: None,
                    seed: Some(left),
                    now: NOW,
                },
                "stable node",
            ),
        ] {
            let versions = home.join(name);
            let c = check(&reg, &builtin, "13.1.0", "linux-x64", &versions, &place).unwrap();
            let (_, dir) = c.unpacked.expect("an update");
            assert_eq!(
                std::fs::read(dir.join("bin/unbrowse-node")).unwrap(),
                runs.as_bytes(),
                "{name}"
            );
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A halt in the targets stops every rollout: no node, on canary or stable, fetches a release while it stands, and
    /// lifting it lets them go on.
    #[test]
    fn a_halt_stops_the_rollout() {
        let home = scratch("halt");
        let versions = home.join("versions");
        let (k, public) = key();
        let builtin = builtin_root_of(&public);
        let (pkg, entry) = release(b"canary node");
        let releases = json!({ "13.2.0": release(b"stable").1, "13.3.0": entry });
        let halted = metadata(
            &targets_json(
                2,
                "13.2.0",
                Some("13.3.0"),
                100,
                Some("13.3.0 loses calls"),
                releases.clone(),
            ),
            &k,
            2,
            NOW + DAY,
            &k,
        );
        let reg = serve(vec![
            (METADATA_PACKAGE, "1.0.2", metadata_package(&halted)),
            ("@unbrowse/linux-x64", "13.3.0", pkg.clone()),
        ]);
        for chosen in [Some(Channel::Canary), Some(Channel::Stable), None] {
            let c = check(
                &reg,
                &builtin,
                "13.1.0",
                "linux-x64",
                &versions,
                &Place {
                    chosen,
                    seed: Some("0x1".into()),
                    now: NOW,
                },
            )
            .unwrap();
            assert!(
                c.unpacked.is_none(),
                "{chosen:?} fetched a release during a halt"
            );
            assert_eq!(c.targets.halt.as_deref(), Some("13.3.0 loses calls"));
        }
        assert!(!versions.join("current").exists());
        let resumed = metadata(
            &targets_json(3, "13.2.0", Some("13.3.0"), 100, None, releases),
            &k,
            3,
            NOW + DAY,
            &k,
        );
        let reg = serve(vec![
            (METADATA_PACKAGE, "1.0.3", metadata_package(&resumed)),
            ("@unbrowse/linux-x64", "13.3.0", pkg),
        ]);
        let c = check(
            &reg,
            &builtin,
            "13.1.0",
            "linux-x64",
            &versions,
            &Place {
                chosen: Some(Channel::Canary),
                seed: None,
                now: NOW,
            },
        )
        .unwrap();
        assert_eq!(c.unpacked.map(|(v, _)| v).as_deref(), Some("13.3.0"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The network's minimum from the newest metadata checked holds from the start, and moving from the manifest an
    /// older release kept never lowers it.
    #[test]
    fn the_kept_minimum_never_drops() {
        let home = scratch("minimum");
        let (k, public) = key();
        let builtin = builtin_root_of(&public);
        std::fs::create_dir_all(&home).unwrap();
        let m = serde_json::to_vec(&Manifest {
            version: "13.4.0".into(),
            min_version: "13.1.0".into(),
            platforms: BTreeMap::new(),
            browsers: BTreeMap::new(),
        })
        .unwrap();
        store::write_json(
            &home.join(KEPT),
            &unbrowse_files::KEPT_MANIFEST,
            &KeptManifest {
                manifest: hex::encode(&m),
                sig: hex::encode(k.sign(&m).to_bytes()),
            },
        )
        .unwrap();
        assert_eq!(
            min_version_in(&builtin, &public, &home).as_deref(),
            Some("13.1.0")
        );
        // Targets saying 13.0.0 don't lower what the older release knew.
        check_metadata(
            &builtin,
            &reader(&metadata(
                &targets_json(1, "13.4.0", None, 0, None, json!({})),
                &k,
                1,
                NOW + DAY,
                &k,
            )),
            &home,
            NOW,
        )
        .unwrap();
        assert_eq!(
            min_version_in(&builtin, &public, &home).as_deref(),
            Some("13.1.0")
        );
        // Targets raising it do.
        let mut up = targets_json(2, "13.5.0", None, 0, None, json!({}));
        up["min_version"] = json!("13.4.0");
        check_metadata(
            &builtin,
            &reader(&metadata(&up, &k, 2, NOW + DAY, &k)),
            &home,
            NOW,
        )
        .unwrap();
        assert_eq!(
            min_version_in(&builtin, &public, &home).as_deref(),
            Some("13.4.0")
        );
        // A half-written file beside the kept one changes nothing.
        std::fs::write(home.join(format!("{TRUST}.1.0.tmp")), b"{\"root\":\"7b").unwrap();
        assert_eq!(
            min_version_in(&builtin, &public, &home).as_deref(),
            Some("13.4.0")
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The browser add-on of the release a node is comes checked: the package the update metadata names for that
    /// release, else (a release the metadata no longer names) the one the release's own signed manifest names. Bytes
    /// the release didn't sign, a manifest signed by another key, or a release with no browser are refused.
    #[test]
    fn the_browser_is_the_one_the_release_signed() {
        let home = scratch("browser-pkg");
        let versions = home.join("versions");
        let (k, public) = key();
        let builtin = builtin_root_of(&public);
        let browser = tgz(&[("package/bin/agent-browser", b"the release's browser", 0o755)]);
        let tampered = tgz(&[(
            "package/bin/agent-browser",
            b"someone else's browser",
            0o755,
        )]);
        let entry = json!({ "platforms": {}, "browsers": { "linux-x64": { "name": "@unbrowse/browser-linux-x64", "integrity": integrity(&browser) } } });
        let files = metadata(
            &targets_json(1, "13.2.0", None, 0, None, json!({ "13.2.0": entry })),
            &k,
            1,
            NOW + DAY,
            &k,
        );

        // Named by the metadata.
        let reg = serve(vec![
            (METADATA_PACKAGE, "1.0.1", metadata_package(&files)),
            ("@unbrowse/browser-linux-x64", "13.2.0", browser.clone()),
        ]);
        assert_eq!(
            browser_tarball(
                &reg,
                &builtin,
                &public,
                "13.2.0",
                "linux-x64",
                &versions,
                NOW
            )
            .unwrap(),
            browser
        );
        let reg = serve(vec![
            (METADATA_PACKAGE, "1.0.1", metadata_package(&files)),
            ("@unbrowse/browser-linux-x64", "13.2.0", tampered.clone()),
        ]);
        assert!(browser_tarball(
            &reg,
            &builtin,
            &public,
            "13.2.0",
            "linux-x64",
            &versions,
            NOW
        )
        .unwrap_err()
        .contains("isn't the package the release made"));

        // A release the metadata doesn't name: its own manifest, signed by the release key.
        let manifest = |key: &SigningKey, browsers: Value| {
            let m = serde_json::to_vec(&json!({ "version": "13.1.0", "min_version": "13.0.0", "platforms": {}, "browsers": browsers })).unwrap();
            let sig = hex::encode(key.sign(&m).to_bytes());
            tgz(&[
                ("package/manifest.json", m.as_slice(), 0o644),
                ("package/manifest.sig", sig.as_bytes(), 0o644),
            ])
        };
        let named = json!({ "linux-x64": { "name": "@unbrowse/browser-linux-x64", "integrity": integrity(&browser) } });
        let reg = serve(vec![
            (METADATA_PACKAGE, "1.0.1", metadata_package(&files)),
            ("unbrowse", "13.1.0", manifest(&k, named.clone())),
            ("@unbrowse/browser-linux-x64", "13.1.0", browser.clone()),
        ]);
        assert_eq!(
            browser_tarball(
                &reg,
                &builtin,
                &public,
                "13.1.0",
                "linux-x64",
                &versions,
                NOW
            )
            .unwrap(),
            browser
        );
        let (other, _) = test_key(9);
        let reg = serve(vec![
            (METADATA_PACKAGE, "1.0.1", metadata_package(&files)),
            ("unbrowse", "13.1.0", manifest(&other, named)),
            ("@unbrowse/browser-linux-x64", "13.1.0", browser.clone()),
        ]);
        assert!(
            browser_tarball(
                &reg,
                &builtin,
                &public,
                "13.1.0",
                "linux-x64",
                &versions,
                NOW
            )
            .is_err(),
            "a manifest another key signed"
        );
        let reg = serve(vec![
            (METADATA_PACKAGE, "1.0.1", metadata_package(&files)),
            ("unbrowse", "13.1.0", manifest(&k, json!({}))),
        ]);
        assert!(browser_tarball(
            &reg,
            &builtin,
            &public,
            "13.1.0",
            "linux-x64",
            &versions,
            NOW
        )
        .unwrap_err()
        .contains("no browser for linux-x64"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn after_the_transition_a_browser_is_installed_only_from_signed_targets() {
        let (release, release_pub) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[5]);
        let (_root_a, root_a_pub) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[0]);
        let (_, root_b_pub) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[1]);
        let (_, targets_a) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[2]);
        let (_, targets_b) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[3]);
        let (_, timestamp) = test_key(POST_TRANSITION_TEST_KEY_SEEDS[4]);
        let offline_builtin = builtin_root_with_roles_and_roles(
            &[&root_a_pub, &root_b_pub],
            &[&targets_a, &targets_b],
            &[&timestamp],
        );
        assert_ne!(offline_builtin.version, 1);

        let browser = tgz(&[("package/bin/agent-browser", b"browser", 0o755)]);
        let manifest = serde_json::to_vec(&json!({
            "version": "13.1.0", "min_version": "13.0.0", "platforms": {},
            "browsers": { "linux-x64": { "name": "@unbrowse/browser-linux-x64", "integrity": integrity(&browser) } }
        })).unwrap();
        let signature = hex::encode(release.sign(&manifest).to_bytes());
        let package = tgz(&[
            ("package/manifest.json", manifest.as_slice(), 0o644),
            ("package/manifest.sig", signature.as_bytes(), 0o644),
        ]);
        let reg = serve(vec![
            ("unbrowse", "13.1.0", package),
            ("@unbrowse/browser-linux-x64", "13.1.0", browser),
        ]);
        let home = scratch("offline-browser-no-manifest-fallback");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("manifest.json"), &manifest).unwrap();
        std::fs::write(home.join("manifest.sig"), &signature).unwrap();
        assert_eq!(min_version_in(&offline_builtin, &release_pub, &home), None);
        assert_eq!(
            min_version_in(&builtin_root_of(&release_pub), &release_pub, &home).as_deref(),
            Some("13.0.0"),
            "legacy minimum metadata remains available only before root transition"
        );
        let result = browser_tarball(
            &reg,
            &offline_builtin,
            &release_pub,
            "13.1.0",
            "linux-x64",
            &home,
            NOW,
        );
        assert!(
            result.unwrap_err().contains("offline update root requires"),
            "an online-key manifest must not supply a browser after the offline root transition"
        );
        let _ = std::fs::remove_dir_all(home);
    }

    /// An install with the browser keeps it across an update into a release that carries none beside its node: the
    /// new release's browser package when the targets name one, else a copy of the program it had. One without the
    /// browser gets none.
    #[test]
    fn an_install_with_the_browser_keeps_it_across_an_update() {
        let home = store::scratch_home("carry-browser");
        let dir = home.join("versions/13.2.0");
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(dir.join("bin/unbrowse-node"), b"the new node").unwrap();
        let browser = tgz(&[(
            format!("package/bin/{}", crate::browsers::program_file()).as_str(),
            b"13.2.0's browser",
            0o755,
        )]);
        let entry = json!({ "platforms": {}, "browsers": { "linux-x64": { "name": "@unbrowse/browser-linux-x64", "integrity": integrity(&browser) } } });
        let targets: Targets = serde_json::from_value(targets_json(
            1,
            "13.2.0",
            None,
            0,
            None,
            json!({ "13.2.0": entry }),
        ))
        .unwrap();
        let alone: Targets = serde_json::from_value(targets_json(
            1,
            "13.2.0",
            None,
            0,
            None,
            json!({ "13.2.0": { "platforms": {} } }),
        ))
        .unwrap();
        let reg = serve(vec![("@unbrowse/browser-linux-x64", "13.2.0", browser)]);
        let beside = std::env::current_exe()
            .unwrap()
            .with_file_name(crate::browsers::program_file());
        if std::env::var_os("UNBROWSE_BROWSER").is_some() || beside.exists() {
            return;
        }

        // No browser here (none installed, and the engine's own build counts only when it's there): none is fetched.
        if crate::browse::binary().is_err() {
            carry_browser(&reg, &targets, "13.2.0", "linux-x64", &dir);
            assert!(
                !crate::browsers::addon_program().exists(),
                "an install without the browser gets none"
            );
        }
        let src = home.join(crate::browsers::program_file());
        std::fs::write(&src, b"13.1.0's browser").unwrap();
        crate::browsers::put_program(&src, "13.1.0").unwrap();
        // The targets name none for the new release: the program it had is kept.
        carry_browser(&reg, &alone, "13.2.0", "linux-x64", &dir);
        assert_eq!(
            std::fs::read(crate::browsers::addon_program()).unwrap(),
            b"13.1.0's browser"
        );
        // They name one: it comes checked.
        crate::browsers::put_program(&src, "13.1.0").unwrap();
        carry_browser(&reg, &targets, "13.2.0", "linux-x64", &dir);
        assert_eq!(
            std::fs::read(crate::browsers::addon_program()).unwrap(),
            b"13.2.0's browser"
        );
        assert_eq!(crate::browsers::addon_version().as_deref(), Some("13.2.0"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A registry on 127.0.0.1 serving `packages` (name, version, tarball): each version's metadata names its tarball
    /// as npm does, and `latest` is the last version listed for a name.
    fn serve(packages: Vec<(&'static str, &'static str, Vec<u8>)>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let b = base.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let line = String::from_utf8_lossy(&buf[..n])
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_string();
                let path = line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                let mut body = Vec::new();
                if let Some(i) = path.strip_prefix("/t/") {
                    body = packages[i.parse::<usize>().unwrap()].2.clone();
                } else {
                    for (i, (name, version, tgz)) in packages.iter().enumerate() {
                        if path == format!("/{}/latest", escaped(name)) {
                            body = format!(r#"{{"version":"{version}"}}"#).into_bytes();
                        } else if path == format!("/{}/{version}", escaped(name)) {
                            body = format!(
                                r#"{{"dist":{{"tarball":"{b}/t/{i}","integrity":"{}"}}}}"#,
                                integrity(tgz)
                            )
                            .into_bytes();
                        }
                    }
                }
                let status = if body.is_empty() {
                    "404 Not Found"
                } else {
                    "200 OK"
                };
                let _ = write!(
                    s,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(&body);
            }
        });
        base
    }

    #[test]
    fn a_self_updating_build_is_exactly_the_guarded_build() {
        assert!(release_build_enabled(Some("1")));
        assert!(!release_build_enabled(Some("0")));
        assert!(!release_build_enabled(Some("true")));
        assert!(!release_build_enabled(None));
    }

    /// Dates compare as the text of a day (`YYYY-MM-DD`): earlier is before, equal and later are not, and anything not ten
    /// bytes long is before nothing.
    #[test]
    fn a_date_is_before_another_only_when_both_are_days_and_it_is_earlier() {
        assert!(date_before("2026-11-01", "2026-11-02"));
        assert!(date_before("2025-12-31", "2026-01-01"));
        assert!(!date_before("2026-11-02", "2026-11-01"));
        assert!(!date_before("2026-11-01", "2026-11-01"));
        assert!(!date_before("2026-11-1", "2026-11-02"));
        assert!(!date_before("2026-11-01", ""));
    }

    /// Two keys are the same only when every byte is, and keys of another length are never the same.
    #[test]
    fn two_strings_are_equal_only_when_every_byte_is() {
        assert!(str_eq("abc", "abc") && str_eq("", ""));
        assert!(!str_eq("abc", "abd") && !str_eq("abc", "ab") && !str_eq("ab", "abc"));
    }

    /// A role's keys must be 64 lowercase hex digits each, at least `minimum` of them, none repeated, none the release key.
    #[test]
    fn a_roles_keys_are_valid_only_as_64_distinct_hex_digits_and_not_the_release_key() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        assert!(role_keys_valid(&[a.as_str(), b.as_str()], 2));
        assert!(role_keys_valid(&[a.as_str()], 1));
        assert!(!role_keys_valid(&[a.as_str()], 2), "too few");
        assert!(!role_keys_valid(&[a.as_str(), a.as_str()], 2), "a key twice");
        assert!(!role_keys_valid(&["abc"], 1), "too short");
        assert!(!role_keys_valid(&["A".repeat(64).as_str()], 1), "capitals");
        assert!(!role_keys_valid(&["g".repeat(64).as_str()], 1), "not hex");
        assert!(!role_keys_valid(&[RELEASE_KEY], 1), "the online release key is not an offline key");
        assert!(role_keys_valid(&[], 0));
    }

    /// Two roles may not share a key.
    #[test]
    fn two_roles_are_disjoint_only_when_they_share_no_key() {
        assert!(roles_disjoint(&["a", "b"], &["c"]));
        assert!(roles_disjoint(&[], &["c"]));
        assert!(!roles_disjoint(&["a", "b"], &["c", "b"]));
    }

    /// This build holds no offline keys yet, so a release build of it is allowed only by the dated online-root exception:
    /// the keys are empty, not partial, and not valid.
    #[test]
    fn the_build_holds_no_offline_keys_and_says_so() {
        assert!(offline_roles_empty());
        assert!(!release_offline_keys_valid());
    }

    /// A build that isn't a release has no package to fetch for the browser or for itself, and says why; it never asks a
    /// registry.
    #[test]
    fn a_build_from_source_fetches_no_browser_and_does_not_update_itself() {
        if released() {
            return;
        }
        let e = browser_package().unwrap_err();
        assert!(e.starts_with("this node was built from source, so no release holds its browser"), "{e}");
        assert!(e.contains("unbrowse browser install --from"), "{e}");
    }

    /// The machine this runs on has a released package named for it.
    #[test]
    fn this_machine_has_a_named_package() {
        let name = platform().expect("a tested machine");
        assert!(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"].contains(&name), "{name}");
        assert!(name.starts_with(match std::env::consts::OS { "macos" => "darwin", "windows" => "win32", o => o }));
    }

    /// A node's place for a rollout carries the channel its owner chose (and none when the owner chose nothing), and a
    /// word that is no channel is none.
    #[test]
    fn the_place_holds_the_channel_the_owner_chose() {
        let _home = store::scratch_home("update-place");
        assert_eq!(place(None).chosen, None);
        let mut s = store::load_settings();
        s.update_channel = Some("canary".into());
        store::save_settings(&s).unwrap();
        assert_eq!(place(None).chosen, Some(Channel::Canary));
        s.update_channel = Some("beta".into());
        store::save_settings(&s).unwrap();
        assert_eq!(place(None).chosen, None);
        assert!(place(None).seed.is_none(), "no node, no identity to place by");
        assert!(place(None).now > 1_700_000_000);
    }

    /// A restart that didn't happen leaves the status with the reason and no promise of a release ready.
    #[test]
    fn a_restart_that_did_not_happen_leaves_the_reason_and_no_release_ready() {
        set(|s| s.ready = Some("9.9.9".into()));
        say_stayed("9.9.9 wasn't started".into());
        let s = status();
        assert_eq!(s.ready, None);
        assert_eq!(s.error.as_deref(), Some("9.9.9 wasn't started"));
    }

    /// A release waits to be run only when it is unpacked here with its program and is newer than this one: none unpacked,
    /// an older one, or a newer one with no program, wait for nothing.
    #[test]
    fn a_release_waits_only_when_it_is_newer_and_has_its_program() {
        let home = store::scratch_home("update-waiting");
        let versions = home.join("versions");
        assert!(waiting().is_none(), "nothing unpacked");
        for v in ["0.0.1", "9999.0.0"] {
            std::fs::create_dir_all(versions.join(v).join("bin")).unwrap();
        }
        std::fs::write(versions.join(CURRENT), "9999.0.0\n").unwrap();
        assert!(waiting().is_none(), "newer, but its program isn't there");
        let exe = versions.join("9999.0.0/bin").join(format!("unbrowse-node{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&exe, "").unwrap();
        std::fs::write(versions.join("0.0.1/bin").join(exe.file_name().unwrap()), "").unwrap();
        assert_eq!(waiting(), Some(("9999.0.0".to_string(), exe)));
        std::fs::write(versions.join(CURRENT), "0.0.1").unwrap();
        assert!(waiting().is_none(), "older than this program");
    }
}
