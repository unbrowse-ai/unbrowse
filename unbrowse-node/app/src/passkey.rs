//! Website passkeys in the vault. On unless the owner turns it off (`unbrowse-node passkey off`, Settings `passkeys`,
//! or `UNBROWSE_PASSKEYS=0`, which wins either way), and never on a site the owner names (`passkey never <site>`,
//! Settings `passkeys_never`).
//!
//! A headless browser has no authenticator, so a site that asks for a passkey ("verify it's you") stops an agent
//! until a person acts. When the node signs in to a site (it fills a vault login there), it attaches a virtual
//! authenticator (Chrome's WebAuthn domain, over DevTools) to the site's pages for a while: a passkey the site offers
//! to make then, on its own or through its "add a passkey" prompt, is made on that authenticator and kept in the
//! vault. A site that never offers one gets nothing, and the node never goes looking for a site's settings page. The
//! owner can also enrol one by hand (`passkey enrol <site>`). From then on, whenever the node's browser is on that
//! site, the node attaches the authenticator with the credential loaded, so the site's passkey prompt completes with
//! no one there, and the signature counter goes back into the vault. A site the vault has a login for and no passkey
//! gets no authenticator, only a guard in its pages that refuses a passkey prompt at once, so the site offers its
//! other ways in: the headless browser has no one to answer, and a sign-in that asks for a passkey first would wait for good.
//!
//! What is kept, and where: `passkeys.json` lists each passkey by site, account and a short name. The credential
//! itself (its id, user handle, private key and counter) is sealed (`unbrowse_core::Sealer`, under a key derived from
//! the root key in the Keychain) and never written in the clear, logged, shown, or sent to a peer: nothing here is
//! announced or served, it is this node's alone, like its logins. Only the browser's pages get it, and Chrome checks
//! the passkey's site against the page before it signs. A credential a site makes when no enrolment is waiting (no
//! sign-in just now, no `passkey enrol`) is not kept. Every enrolment, automatic or by hand, and every sign-in with a
//! stored passkey is a line in the activity log (the site and when, nothing more); the list says how each passkey
//! was enrolled.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_browser_core::cdp::client::CdpClient;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use unbrowse_core::{KeyStore, RootKey, Sealer};
use unbrowse_learn::identity::site_of;
use zeroize::Zeroize;

use crate::store::{self, Activity};
use crate::sync::Locked;

/// What an owner is told when passkeys are off.
pub const OFF: &str = "passkeys are off: `unbrowse-node passkey on` turns them back on, unless UNBROWSE_PASSKEYS=0 is set, which wins";

/// What the owner is told the first time the node starts with passkeys on.
pub const NOTICE: &str = "passkeys are on: when this node signs in to a site with a vault login and the site offers to make a passkey, the \
node accepts it and keeps it sealed in the vault, so whoever controls this node can sign in as you there. \
Turn it off with `unbrowse-node passkey off` (or UNBROWSE_PASSKEYS=0), or for one site with `unbrowse-node passkey never <site>`; \
`unbrowse-node passkey list` shows what it holds";

/// How long after a sign-in a passkey the site offers is kept.
const AFTER_SIGN_IN_MINUTES: u64 = 10;

/// How a passkey came into the vault.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum How {
    /// The site offered it after the node signed in there.
    Auto,
    /// The owner asked for it (`passkey enrol`). Passkeys kept before automatic enrolment read as this.
    #[default]
    Manual,
    /// The site offered it after the owner signed in with their own phone or security key (`owner_authn`): it stands
    /// in for that device, so each sign-in with it waits on the owner's yes, as the device would.
    Phone,
}

impl How {
    pub fn name(self) -> &'static str {
        match self {
            How::Auto => "auto",
            How::Manual => "manual",
            How::Phone => "phone",
        }
    }
}

/// One passkey, as `passkeys.json` keeps it: who and where in the clear, the credential sealed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Passkey {
    /// A short name for it, from its credential id; never the id itself.
    pub id: String,
    /// The site it signs in to: the credential's relying party, as the site named it (`google.com`).
    pub site: String,
    /// The account the site made it for, as the site named it, if it did.
    #[serde(default)]
    pub account: String,
    pub created: u64,
    /// When the node last signed in with it.
    #[serde(default)]
    pub used: Option<u64>,
    /// How it was enrolled.
    #[serde(default)]
    pub how: How,
    /// Each sign-in with it waits on the owner's yes, in the window or from their phone (the owner SDK), as the device
    /// it stands in for would ask them. On for a passkey enrolled after a sign-in with the owner's own device.
    #[serde(default)]
    pub approve: bool,
    /// The credential, sealed, in base64. Never shown: [`View`] is what leaves the node's files.
    sealed: String,
}

/// A passkey as the owner sees it: no credential, no key, no counter.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct View {
    pub id: String,
    pub site: String,
    pub account: String,
    pub created: u64,
    pub used: Option<u64>,
    pub how: How,
    #[serde(default)]
    pub approve: bool,
}

impl From<&Passkey> for View {
    fn from(p: &Passkey) -> View {
        View { id: p.id.clone(), site: p.site.clone(), account: p.account.clone(), created: p.created, used: p.used, how: p.how, approve: p.approve }
    }
}

/// The credential, as the browser's virtual authenticator holds it. Lives only in memory and sealed on disk; the
/// strings are wiped when it is dropped.
#[derive(Serialize, Deserialize)]
struct Secret {
    credential_id: String,
    rp_id: String,
    #[serde(default)]
    user_handle: String,
    private_key: String,
    sign_count: u64,
    #[serde(default)]
    resident: bool,
    #[serde(default)]
    user_name: String,
    #[serde(default)]
    backup_eligibility: Option<bool>,
    #[serde(default)]
    backup_state: Option<bool>,
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.credential_id.zeroize();
        self.user_handle.zeroize();
        self.private_key.zeroize();
    }
}

impl Secret {
    /// A credential as DevTools gives it (`WebAuthn.Credential`).
    fn from_cdp(c: &Value) -> Option<Secret> {
        let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let secret = Secret {
            credential_id: s("credentialId"),
            rp_id: s("rpId"),
            user_handle: s("userHandle"),
            private_key: s("privateKey"),
            sign_count: c.get("signCount").and_then(Value::as_u64).unwrap_or(0),
            resident: c.get("isResidentCredential").and_then(Value::as_bool).unwrap_or(false),
            user_name: s("userName"),
            backup_eligibility: c.get("backupEligibility").and_then(Value::as_bool),
            backup_state: c.get("backupState").and_then(Value::as_bool),
        };
        (!secret.credential_id.is_empty() && !secret.rp_id.is_empty() && !secret.private_key.is_empty()).then_some(secret)
    }

    /// The credential as `WebAuthn.addCredential` takes it.
    fn to_cdp(&self) -> Value {
        let mut c = json!({
            "credentialId": self.credential_id,
            "isResidentCredential": self.resident,
            "rpId": self.rp_id,
            "privateKey": self.private_key,
            "signCount": self.sign_count,
        });
        if !self.user_handle.is_empty() {
            c["userHandle"] = json!(self.user_handle);
        }
        if !self.user_name.is_empty() {
            c["userName"] = json!(self.user_name);
        }
        if let Some(b) = self.backup_eligibility {
            c["backupEligibility"] = json!(b);
        }
        if let Some(b) = self.backup_state {
            c["backupState"] = json!(b);
        }
        c
    }
}

/// The short name a credential goes by: the start of its id's hash, so the list names it without holding it.
fn short_id(credential_id: &str) -> String {
    hex::encode(&Sha256::digest(credential_id.as_bytes())[..6])
}

/// Whether a passkey for relying party `rp_id` belongs on `site`: the same registrable site, never a lookalike.
fn fits(rp_id: &str, site: &str) -> bool {
    let s = site_of(rp_id);
    !s.is_empty() && s == site_of(site)
}

/// The site an owner named, as an origin (`https://accounts.google.com`) or a host: its registrable site.
pub fn site_arg(given: &str) -> Result<String, String> {
    let given = given.trim();
    let host = match url::Url::parse(given) {
        Ok(u) if u.host_str().is_some() => u.host_str().unwrap_or_default().to_string(),
        _ => given.trim_start_matches("https://").trim_start_matches("http://").split(['/', ':']).next().unwrap_or_default().to_string(),
    };
    let site = site_of(&host);
    if site.is_empty() || !(site.contains('.') || site == "localhost") {
        return Err("name the site, like google.com or https://accounts.google.com".into());
    }
    Ok(site)
}

/// Whether passkeys are on: `UNBROWSE_PASSKEYS` when it says, else the owner's setting (on unless turned off).
pub fn enabled() -> bool {
    enabled_in(&store::home())
}

/// The owner's settings kept in `dir`.
fn settings_in(dir: &Path) -> store::Settings {
    store::read_json(&dir.join("settings.json"), &unbrowse_files::SETTINGS)
}

fn enabled_in(dir: &Path) -> bool {
    flag(std::env::var("UNBROWSE_PASSKEYS").ok().as_deref(), settings_in(dir).passkeys)
}

/// Whether the node may enrol or use a passkey on `site`: passkeys on, and the site not one the owner said never to.
fn allowed_in(dir: &Path, site: &str) -> Result<(), String> {
    if !enabled_in(dir) {
        return Err(OFF.into());
    }
    if settings_in(dir).passkeys_never.iter().any(|s| fits(s, site)) {
        return Err(format!("passkeys are off for {}: the owner said never, and only they can undo it", site_of(site)));
    }
    Ok(())
}

fn flag(env: Option<&str>, setting: bool) -> bool {
    match env.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("1" | "true" | "on" | "yes") => true,
        Some("0" | "false" | "off" | "no") => false,
        _ => setting,
    }
}

/// Turns passkeys on or off in the owner's settings.
pub fn set_enabled(on: bool) -> Result<(), String> {
    let _held = store::settings_held();
    let mut s = store::load_settings();
    s.passkeys = on;
    store::save_settings(&s)
}

/// Says never (or, `never` false, no longer never) to passkeys on one site: it is never enrolled on, and its kept
/// passkeys are never used, until the owner allows it again. Says the site, as kept.
pub fn set_never(site: &str, never: bool) -> Result<String, String> {
    set_never_in(&store::home(), site, never)
}

fn set_never_in(dir: &Path, site: &str, never: bool) -> Result<String, String> {
    let site = site_arg(site)?;
    let mut s = settings_in(dir);
    s.passkeys_never.retain(|n| site_of(n) != site);
    if never {
        s.passkeys_never.push(site.clone());
        s.passkeys_never.sort();
    }
    store::write_json(&dir.join("settings.json"), &unbrowse_files::SETTINGS, &s)?;
    Ok(site)
}

/// The sites the owner said never to.
pub fn never() -> Vec<String> {
    store::load_settings().passkeys_never
}

/// Tells the owner, once, that passkeys are on and how to turn them off: the first time the node starts with them on.
pub fn announce() {
    let seen = store::home().join("passkeys.notice");
    if enabled() && !seen.exists() {
        println!("{NOTICE}");
        let _ = std::fs::create_dir_all(store::home());
        let _ = std::fs::write(seen, format!("{}\n", store::now()));
    }
}

/// The sealer for passkeys, from the root key.
pub fn sealer(keys: &dyn KeyStore) -> Result<Sealer, String> {
    Ok(Sealer::from_root(&RootKey::load(keys).map_err(|e| e.to_string())?, "passkey"))
}

// ---- the vault's list ----

fn file(dir: &Path) -> PathBuf {
    dir.join("passkeys.json")
}

/// Every passkey kept in `dir`.
pub fn list_in(dir: &Path) -> Vec<Passkey> {
    store::read_json(&file(dir), &unbrowse_files::PASSKEYS)
}

/// The passkeys this node keeps, as the owner sees them.
pub fn list() -> Vec<View> {
    list_in(&store::home()).iter().map(View::from).collect()
}

/// What a sealed credential is bound to: its entry's site and name.
fn about(p: &Passkey) -> Vec<u8> {
    format!("unbrowse/passkey/v1|{}|{}", p.site, p.id).into_bytes()
}

fn seal_into(sealer: &Sealer, p: &mut Passkey, s: &Secret) -> Result<(), String> {
    let plain = zeroize::Zeroizing::new(serde_json::to_vec(s).map_err(|e| e.to_string())?);
    let sealed = sealer.seal(&about(p), &plain).map_err(|e| e.to_string())?;
    p.sealed = base64::engine::general_purpose::STANDARD.encode(sealed);
    Ok(())
}

fn open(sealer: &Sealer, p: &Passkey) -> Result<Secret, String> {
    let sealed = base64::engine::general_purpose::STANDARD.decode(&p.sealed).map_err(|_| format!("passkey {} is damaged", p.id))?;
    let plain = sealer.open(&about(p), &sealed).map_err(|e| format!("passkey {}: {e}", p.id))?;
    serde_json::from_slice(&plain).map_err(|_| format!("passkey {} is damaged", p.id))
}

/// Keeps a credential in `dir`'s vault, sealed. The same credential again replaces its entry.
fn keep(dir: &Path, sealer: &Sealer, s: &Secret, how: How) -> Result<Passkey, String> {
    let _held = store::hold_file(&file(dir))?;
    let mut all = list_in(dir);
    let id = short_id(&s.credential_id);
    let mut p = Passkey { id: id.clone(), site: s.rp_id.clone(), account: s.user_name.clone(), created: store::now(), used: None, how, approve: how == How::Phone, sealed: String::new() };
    seal_into(sealer, &mut p, s)?;
    all.retain(|k| k.id != id);
    all.push(p.clone());
    store::write_json(&file(dir), &unbrowse_files::PASSKEYS, &all)?;
    Ok(p)
}

/// The credentials kept in `dir` for `site`, opened.
fn secrets_for(dir: &Path, sealer: &Sealer, site: &str) -> Vec<(Passkey, Secret)> {
    list_in(dir).into_iter().filter(|p| fits(&p.site, site)).filter_map(|p| open(sealer, &p).ok().map(|s| (p, s))).collect()
}

/// Writes a passkey's new signature counter back, sealed, and when it was used.
fn set_count(dir: &Path, sealer: &Sealer, id: &str, count: u64, used: Option<u64>) -> Result<(), String> {
    let _held = store::hold_file(&file(dir))?;
    let mut all = list_in(dir);
    let p = all.iter_mut().find(|p| p.id == id).ok_or("no such passkey")?;
    let mut s = open(sealer, p)?;
    if count > s.sign_count {
        s.sign_count = count;
        seal_into(sealer, p, &s)?;
    }
    if used.is_some() {
        p.used = used;
    }
    store::write_json(&file(dir), &unbrowse_files::PASSKEYS, &all)
}

/// Removes a passkey from `dir`'s vault.
pub fn remove_in(dir: &Path, id: &str) -> Result<View, String> {
    let _held = store::hold_file(&file(dir))?;
    let mut all = list_in(dir);
    let i = all.iter().position(|p| p.id == id.trim()).ok_or("no such passkey: `unbrowse-node passkey list` names them")?;
    let gone = all.remove(i);
    store::write_json(&file(dir), &unbrowse_files::PASSKEYS, &all)?;
    Ok(View::from(&gone))
}

/// Removes a passkey from the vault, and says what is left to do: the site still lists it.
pub fn remove(id: &str, who: &str) -> Result<String, String> {
    let gone = remove_in(&store::home(), id)?;
    note(&store::home(), who, &gone.site, "Removed a stored passkey", None);
    let account = if gone.account.is_empty() { String::new() } else { format!(" for {}", gone.account) };
    Ok(format!(
        "removed passkey {}{account} on {}. The site still lists it: delete it on {}'s account page (security, passkeys) too, or anyone holding a copy could still sign in with it",
        gone.id, gone.site, gone.site
    ))
}

fn note(dir: &Path, who: &str, site: &str, what: &str, note: Option<String>) {
    store::log_activity_in(dir, &Activity {
        at: store::now(),
        who: who.into(),
        site: site.into(),
        what: what.into(),
        kind: "vault".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note,
    });
}

// ---- importing ----
//
// A passkey leaves its authenticator only where the authenticator lets it. Password managers that keep passkeys as
// data can export them: Bitwarden in its unencrypted JSON export (`login.fido2Credentials`), any manager that writes
// the FIDO Alliance's Credential Exchange Format (a `passkey` credential), and KeePassXC one at a time (`.passkey`).
// The private key in each is a PKCS#8 key, which the browser's virtual authenticator takes as it is. Platform
// authenticators don't let one out to a file: iCloud Keychain and Google Password Manager hand passkeys only to another
// credential manager app on the same device (the Credential Exchange Protocol), and Windows Hello and security keys
// never release them. For those sites the owner enrols a new passkey for the node instead ([`enrol`]).

/// Where a passkey import's reader finds nothing it can use, and what the owner can do instead.
pub const NONE_IN_FILE: &str = "no passkeys in this file. A passkey comes out of a password manager that exports them: Bitwarden's unencrypted .json export, a FIDO Credential Exchange (CXF) .json, or KeePassXC's .passkey. iCloud Keychain, Google Password Manager, Windows Hello and security keys never let one out to a file: for those sites, enrol a new passkey for the node with `unbrowse-node passkey enrol <site>`";

/// What a passkey import did: the passkeys it kept (no credential, key or counter), and counts of the rest.
#[derive(Debug, Default, Serialize)]
pub struct Imported {
    pub added: Vec<View>,
    /// Already in the vault: the vault's own copy, with its counter, is kept.
    pub known: usize,
    /// Passkeys left out, counted by why.
    pub skipped: Vec<(String, usize)>,
}

/// How many passkeys an export holds, read without a key: to say what an import would take while passkeys are off.
pub fn count_in(text: &str) -> usize {
    let (found, skipped) = read_export(text);
    found.len() + skipped.iter().map(|(_, n)| n).sum::<usize>()
}

/// Imports the passkeys in an export into the vault, sealed like an enrolled one, as the owner's own (`How::Manual`).
/// Not while passkeys are off, and never for a site the owner said never to.
pub fn import(text: &str, keys: &dyn KeyStore, who: &str) -> Result<Imported, String> {
    import_in(&store::home(), &sealer(keys)?, text, who)
}

fn import_in(dir: &Path, sealer: &Sealer, text: &str, who: &str) -> Result<Imported, String> {
    if !enabled_in(dir) {
        return Err(OFF.into());
    }
    if serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}').trim()).is_ok_and(|v| encrypted(&v)) {
        return Err("this export is encrypted: export it again as plain JSON, import it, then delete the file".into());
    }
    let (found, skipped) = read_export(text);
    if found.is_empty() && skipped.is_empty() {
        return Err(NONE_IN_FILE.into());
    }
    let mut done = Imported { skipped, ..Default::default() };
    for s in found {
        if list_in(dir).iter().any(|p| p.id == short_id(&s.credential_id)) {
            done.known += 1;
            continue;
        }
        if allowed_in(dir, &s.rp_id).is_err() {
            let why = "a site you said never to passkeys on (allowing it again undoes that)";
            match done.skipped.iter_mut().find(|(w, _)| w == why) {
                Some((_, n)) => *n += 1,
                None => done.skipped.push((why.into(), 1)),
            }
            continue;
        }
        let p = keep(dir, sealer, &s, How::Manual)?;
        // The site and when, as every passkey line says: no account, no credential.
        note(dir, who, &p.site, "Imported a passkey", None);
        done.added.push(View::from(&p));
    }
    Ok(done)
}

/// The passkeys in an export, whichever manager wrote it, and counts of those left out by why. Every object in the
/// JSON is looked at, so the envelope (Bitwarden's items, CXF's accounts, a lone `.passkey`) doesn't matter: a passkey
/// is known by its fields.
fn read_export(text: &str) -> (Vec<Secret>, Vec<(String, usize)>) {
    let Ok(v) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}').trim()) else { return (Vec::new(), Vec::new()) };
    if encrypted(&v) {
        return (Vec::new(), Vec::new());
    }
    let (mut found, mut skipped) = (Vec::new(), Vec::<(String, usize)>::new());
    let mut each = |c: &Value| {
        let Some(read) = exported(c) else { return };
        match read {
            Ok(s) if !found.iter().any(|f: &Secret| f.credential_id == s.credential_id) => found.push(s),
            Ok(_) => {}
            Err(why) => match skipped.iter_mut().find(|(w, _)| *w == why) {
                Some((_, n)) => *n += 1,
                None => skipped.push((why, 1)),
            },
        }
    };
    walk(&v, &mut each);
    (found, skipped)
}

/// Whether an export is encrypted (Bitwarden's account- or password-protected export): its fields don't read here.
fn encrypted(v: &Value) -> bool {
    v["encrypted"].as_bool() == Some(true) || v["passwordProtected"].as_bool() == Some(true)
}

fn walk(v: &Value, f: &mut impl FnMut(&Value)) {
    match v {
        Value::Object(m) => {
            f(v);
            m.values().for_each(|x| walk(x, f));
        }
        Value::Array(a) => a.iter().for_each(|x| walk(x, f)),
        _ => {}
    }
}

/// One passkey read from an export, if `c` is one: `None` when it isn't a passkey at all, `Err` with why when it is
/// one the node can't use.
fn exported(c: &Value) -> Option<Result<Secret, String>> {
    let s = |k: &str| c.get(k).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    // Bitwarden: keyValue (base64url PKCS#8), credentialId ("b64.<base64url>" or a UUID), counter and discoverable as strings.
    // CXF: a "passkey" credential with key (base64url PKCS#8). KeePassXC: privateKey (PEM) and relyingParty.
    let (key, credential_id, rp_id, user_name, counter, resident) = if c.get("keyValue").is_some() && c.get("rpId").is_some() {
        if !matches!(s("keyAlgorithm").as_str(), "" | "ECDSA") || !matches!(s("keyCurve").as_str(), "" | "P-256") {
            return Some(Err(UNSUPPORTED.into()));
        }
        let counter = c.get("counter").and_then(|n| n.as_u64().or_else(|| n.as_str().and_then(|t| t.trim().parse().ok()))).unwrap_or(0);
        (b64(&s("keyValue")), bitwarden_id(&s("credentialId")), s("rpId"), s("userName"), counter, s("discoverable") != "false")
    } else if c.get("type").and_then(Value::as_str) == Some("passkey") && c.get("key").is_some() {
        (b64(&s("key")), b64(&s("credentialId")), s("rpId"), s("username"), 0, true)
    } else if c.get("privateKey").is_some() && c.get("relyingParty").is_some() {
        (pem(&s("privateKey")), b64(&s("credentialId")), s("relyingParty"), s("username"), 0, true)
    } else {
        return None;
    };
    let (Some(key), Some(credential_id)) = (key, credential_id) else { return Some(Err("its key or id doesn't read".into())) };
    let rp_id = rp_id.trim_start_matches("https://").trim_end_matches('/').to_ascii_lowercase();
    if site_of(&rp_id).is_empty() || !(rp_id.contains('.') || rp_id == "localhost") {
        return Some(Err("it names no site".into()));
    }
    if !p256(&key) {
        return Some(Err(UNSUPPORTED.into()));
    }
    let user_handle = ["userHandle"].iter().find_map(|k| c.get(*k).and_then(Value::as_str)).and_then(b64).map(|h| STD.encode(h)).unwrap_or_default();
    Some(Ok(Secret {
        credential_id: STD.encode(credential_id),
        rp_id,
        user_handle,
        private_key: STD.encode(&*key),
        sign_count: counter,
        resident,
        user_name,
        // A password manager's passkeys are synced ones: backup-eligible and backed up, as the site saw them made.
        backup_eligibility: Some(true),
        backup_state: Some(true),
    }))
}

const UNSUPPORTED: &str = "not a P-256 key (the browser's authenticator signs with ECDSA P-256 only)";

const STD: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Bytes from base64 in either alphabet, padded or not, as exporters write it.
fn b64(text: &str) -> Option<zeroize::Zeroizing<Vec<u8>>> {
    let clean: String = text.chars().filter(|c| !c.is_whitespace() && *c != '=').map(|c| match c {
        '+' => '-',
        '/' => '_',
        c => c,
    }).collect();
    if clean.is_empty() {
        return None;
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(clean).ok().map(zeroize::Zeroizing::new)
}

/// A Bitwarden credential id: `b64.` and base64url, or a UUID (its 16 bytes), as Bitwarden's clients encode it.
fn bitwarden_id(text: &str) -> Option<zeroize::Zeroizing<Vec<u8>>> {
    if let Some(rest) = text.strip_prefix("b64.") {
        return b64(rest);
    }
    let hex: String = text.chars().filter(|c| *c != '-').collect();
    if hex.len() == 32 {
        if let Ok(bytes) = hex::decode(&hex) {
            return Some(zeroize::Zeroizing::new(bytes));
        }
    }
    b64(text)
}

/// A PEM private key's DER: a PKCS#8 key as it is, a SEC1 EC key wrapped into PKCS#8 for P-256.
fn pem(text: &str) -> Option<zeroize::Zeroizing<Vec<u8>>> {
    let label = text.lines().find_map(|l| l.trim().strip_prefix("-----BEGIN ")?.strip_suffix("-----").map(String::from))?;
    let body: String = text.lines().filter(|l| !l.trim().starts_with("-----")).collect();
    let der = b64(&body)?;
    match label.as_str() {
        "PRIVATE KEY" => Some(der),
        // A SEC1 key names its curve inside; PKCS#8 wraps it with the algorithm in front.
        "EC PRIVATE KEY" if contains(&der, P256) => {
            let mut algo = vec![0x30, (EC_KEY.len() + P256.len()) as u8];
            algo.extend_from_slice(EC_KEY);
            algo.extend_from_slice(P256);
            let mut body = vec![0x02, 0x01, 0x00];
            body.extend_from_slice(&algo);
            body.extend(der_len(0x04, der.len()));
            body.extend_from_slice(&der);
            let mut out = der_len(0x30, body.len());
            out.extend_from_slice(&body);
            Some(zeroize::Zeroizing::new(out))
        }
        _ => None,
    }
}

/// A DER tag and length.
fn der_len(tag: u8, n: usize) -> Vec<u8> {
    match n {
        0..=0x7f => vec![tag, n as u8],
        0x80..=0xff => vec![tag, 0x81, n as u8],
        _ => vec![tag, 0x82, (n >> 8) as u8, n as u8],
    }
}

/// The DER of the EC public key algorithm (1.2.840.10045.2.1) and of the P-256 curve (1.2.840.10045.3.1.7).
const EC_KEY: &[u8] = &[0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const P256: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

/// Whether a PKCS#8 key is an EC key on P-256: its algorithm and curve are both named in it.
fn p256(der: &[u8]) -> bool {
    der.first() == Some(&0x30) && contains(der, EC_KEY) && contains(der, P256)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

// ---- the browser's authenticator ----

/// Where a browser's DevTools answer: the node's own browser for a site, or an address the owner gave.
#[derive(Clone, Debug)]
pub enum Browser {
    /// The node's browser for the site (`browse::cdp_of`): all its pages are the site's.
    Node,
    /// A DevTools address the owner named: `ws://…`, `http://host:port` or a port on 127.0.0.1. Only its pages on the
    /// site get the authenticator.
    At(String),
}

impl Browser {
    fn name(&self) -> String {
        match self {
            Browser::Node => "node".into(),
            Browser::At(a) => a.clone(),
        }
    }
}

/// A browser being watched for one site: its authenticator holds the site's passkeys while the browser runs.
struct Guard {
    site: String,
    at: String,
    /// Until when (ms) a new credential the site makes is kept, and why: a sign-in just now, or an enrolment the
    /// owner asked for.
    armed: Mutex<Option<(u64, How)>>,
    alive: AtomicBool,
    /// Its watcher reached the browser: what a second caller finding this guard waits for.
    up: AtomicBool,
    /// Only refuses passkey prompts, with no authenticator: a site the vault has a login for and no passkey. Nothing
    /// can be made or signed here, and a guard with the authenticator takes over when one is wanted.
    bare: bool,
}

static GUARDS: Mutex<Vec<Arc<Guard>>> = Mutex::new(Vec::new());

/// Whether a sign-in with `site`'s passkeys waits on the owner's yes: one the vault keeps for it says so.
fn needs_approval(dir: &Path, site: &str) -> bool {
    list_in(dir).iter().any(|p| p.approve && fits(&p.site, site))
}

/// The running node, for what a passkey approval needs of it: the window's events, and whether the owner answers from
/// another device. Set as the node starts; a test has none, and its approvals are answered through `hands` directly.
static NODE: std::sync::OnceLock<Arc<crate::Node>> = std::sync::OnceLock::new();

pub fn set_node(node: Arc<crate::Node>) {
    let _ = NODE.set(node);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn guard_of(site: &str, at: &str) -> Option<Arc<Guard>> {
    let mut all = GUARDS.locked();
    all.retain(|g| g.alive.load(Ordering::SeqCst));
    all.iter().find(|g| g.site == site && g.at == at).cloned()
}

/// Whether an agent's script waits on `site` in the node's browser: the vault holds a passkey for it there, or the
/// owner is enrolling one. A script runs in the page's own world, where no wrapper of `navigator.credentials` holds
/// (`CredentialsContainer.prototype.get` is always there): it could ask the authenticator, which needs no one present,
/// to sign a challenge of its own, and carry the assertion off the node for a lasting sign-in elsewhere. Passkeys are
/// used only through the node's own flow: the site's page asks, from a click. An automatic enrolment a sign-in opened
/// is closed by the script instead, so a passkey made after it is refused, never kept.
pub fn holds_scripts(site: &str) -> bool {
    holds_scripts_in(&store::home(), site)
}

fn holds_scripts_in(dir: &Path, site: &str) -> bool {
    if allowed_in(dir, site).is_ok() && list_in(dir).iter().any(|p| fits(&p.site, site)) {
        return true;
    }
    let watching: Vec<Arc<Guard>> = {
        let mut all = GUARDS.locked();
        all.retain(|g| g.alive.load(Ordering::SeqCst));
        all.iter().filter(|g| g.at == Browser::Node.name() && fits(&g.site, site)).cloned().collect()
    };
    let mut held = false;
    for g in watching {
        let mut armed = g.armed.locked();
        match *armed {
            Some((until, How::Manual)) if until > now_ms() => held = true,
            Some((_, How::Auto)) => *armed = None,
            _ => {}
        }
    }
    held
}

/// Refuses the node's authenticator to `site`'s browser while a tab an agent's script ran in is open there: what the
/// script left behind (a timer, a listener) could ask the authenticator once it holds a passkey. Asked as a guard starts
/// and again before a passkey goes onto a page: a guard already watching takes one the owner imports or enrols later.
fn no_script_left_behind(site: &str, browser: &Browser) -> Result<(), String> {
    if matches!(browser, Browser::Node) && crate::browse::script_may_have_run_on_any(|s| fits(s, site)) {
        return Err(format!(
            "an agent's script ran in a tab of {}'s browser, and what it left there could ask for a passkey: the node brings no passkey to it until those tabs are closed",
            site_of(site)
        ));
    }
    Ok(())
}

/// Has a guard hold `site`'s passkeys in `browser`, once it is up: the one already watching, or a new one on its own
/// thread for as long as the browser answers.
fn watch(site: &str, browser: &Browser, ws: Option<String>, sealer: Sealer, dir: PathBuf) -> Result<Arc<Guard>, String> {
    watch_as(site, browser, ws, sealer, dir, false)
}

/// [`watch`], or with `bare` a guard that only refuses passkey prompts. A bare guard gives way to one that holds
/// passkeys: it ends on its next tick, and it never had an authenticator to leave behind.
fn watch_as(site: &str, browser: &Browser, ws: Option<String>, sealer: Sealer, dir: PathBuf, bare: bool) -> Result<Arc<Guard>, String> {
    let found = {
        // Registered before it is up, so two browse commands at once start one guard, not two authenticators.
        let mut all = GUARDS.locked();
        all.retain(|g| g.alive.load(Ordering::SeqCst));
        match all.iter().find(|g| g.site == site && g.at == browser.name()).cloned() {
            Some(g) if bare || !g.bare => Ok(g),
            other => {
                if let Some(g) = other {
                    g.alive.store(false, Ordering::SeqCst);
                    all.retain(|g| g.alive.load(Ordering::SeqCst));
                }
                let g = Arc::new(Guard { site: site.to_string(), at: browser.name(), armed: Mutex::new(None), alive: AtomicBool::new(true), up: AtomicBool::new(false), bare });
                all.push(g.clone());
                Err(g)
            }
        }
    };
    let g = match found {
        Ok(g) => return once_up(g),
        Err(g) => g,
    };
    let (ready, up) = std::sync::mpsc::channel();
    let (g2, browser) = (g.clone(), browser.clone());
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                g2.alive.store(false, Ordering::SeqCst);
                let _ = ready.send(Err(e.to_string()));
                return;
            }
        };
        let done = rt.block_on(run(&g2, &browser, ws, &sealer, &dir, &ready));
        g2.alive.store(false, Ordering::SeqCst);
        // An enrolment the owner asked for ended with its browser: they are told, or they wait on a passkey no one keeps.
        if matches!(g2.armed.locked().take(), Some((until, How::Manual)) if until > now_ms()) {
            note(&dir, "This node", &g2.site, "Stopped waiting to enrol a passkey: its browser went away", None);
        }
        if let Err(e) = done {
            let _ = ready.send(Err(e.clone()));
            eprintln!("passkeys: {}: {e}", g2.site);
        }
    });
    let up = match up.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(())) => return Ok(g),
        Ok(Err(e)) => e,
        Err(_) => "the browser's DevTools didn't answer".into(),
    };
    g.alive.store(false, Ordering::SeqCst);
    Err(up)
}

/// `g`, once the watcher another caller started has reached the browser, as a guard this caller started itself is
/// returned: a guard that isn't up yet refuses nothing and holds nothing.
fn once_up(g: Arc<Guard>) -> Result<Arc<Guard>, String> {
    let until = Instant::now() + Duration::from_secs(20);
    while !g.up.load(Ordering::SeqCst) {
        if !g.alive.load(Ordering::SeqCst) || Instant::now() >= until {
            return Err("the browser's DevTools didn't answer".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Ok(g)
}

/// Signs in with stored passkeys in the node's browser for `site`, if the vault holds any for it: called around every
/// browse command. A site the vault holds a login for and no passkey gets a bare guard: a site can ask for a passkey
/// before any password (Google does), and the browser has no one to answer, so the sign-in would wait for good. Other
/// sites are left as they are: the guard changes what a page can read of `navigator.credentials`, and only a sign-in
/// needs it. Quiet and cheap when passkeys are off, the site has neither, or the browser is already watched.
pub fn on_browse(site: &str, keys: &dyn KeyStore) {
    let home = store::home();
    if allowed_in(&home, site).is_err() {
        return;
    }
    let holds = list_in(&home).iter().any(|p| fits(&p.site, site));
    match guard_of(site, "node") {
        Some(g) if !(g.bare && holds) => return,
        None if !holds && !has_login(site) => return,
        _ => {}
    }
    if holds {
        if let Err(e) = no_script_left_behind(site, &Browser::Node) {
            return eprintln!("passkeys: {e}");
        }
    }
    let Some(ws) = crate::browse::cdp_of(site) else { return };
    let Ok(sealer) = sealer(keys) else { return };
    if let Err(e) = watch_as(site, &Browser::Node, Some(ws), sealer, home, !holds) {
        eprintln!("passkeys: {site}: {e}");
    }
}

/// Whether the vault holds a login for `site`.
fn has_login(site: &str) -> bool {
    crate::vault::list().into_iter().any(|l| crate::vault::Ref { site: l.site, account: l.account, new: false, code: false }.fits(site))
}

/// Whose sign-in a page just saw: the owner's own act on it, or a vault login an agent filled.
///
/// A passkey signs in as the owner with no password and no second factor, so one an agent could make would be a
/// credential stronger than the agent's own key — and every key on the node as strong as the weakest of them. So only
/// the owner's own act arms an automatic enrolment; an agent's fill arms nothing, and the owner enrols one with
/// `passkey enrol <site>` or from the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignIn {
    Owner,
    Agent,
}

/// A sign-in has just happened on `site` in the node's own browser: for the next few minutes, a passkey the site
/// offers to make is made on the node's authenticator and kept — when the sign-in was the owner's own (`SignIn::Owner`).
/// Nothing happens when passkeys are off, the owner said never to the site, the site offers none, or an agent filled
/// the login (`SignIn::Agent`): returns `None` then.
pub fn signed_in(by: SignIn, site: &str, keys: &dyn KeyStore) -> Option<Armed> {
    if by != SignIn::Owner {
        return None;
    }
    let home = store::home();
    if allowed_in(&home, site).is_err() {
        return None;
    }
    match after_sign_in(site, &Browser::Node, keys, home) {
        Ok(armed) => Some(armed),
        Err(e) => {
            eprintln!("passkeys: {site}: {e}");
            None
        }
    }
}

/// Arms an automatic enrolment on `site` in `browser`, after a sign-in there.
fn after_sign_in(site: &str, browser: &Browser, keys: &dyn KeyStore, dir: PathBuf) -> Result<Armed, String> {
    let site = site_arg(site)?;
    allowed_in(&dir, &site)?;
    let g = start(&site, browser, sealer(keys)?, dir)?;
    Ok(arm(&g, &site, AFTER_SIGN_IN_MINUTES, How::Auto))
}

/// How long the owner has to approve a sign-in with a kept passkey.
const APPROVAL_WAIT: Duration = Duration::from_secs(180);
/// How long an approval lets the page's authenticator sign, for the sign-in it was given for.
const APPROVED_FOR: Duration = Duration::from_secs(30);

/// The longest a site stays armed, whatever was asked.
const MOST_ARMED_MINUTES: u64 = 30;

/// How long `passkey enrol --wait` has anything to wait for: past this, nothing is armed and nothing can be kept, and the
/// command would sit out the rest of what it was asked before saying so.
pub fn enrol_wait_secs(asked: u64) -> u64 {
    asked.min(MOST_ARMED_MINUTES * 60)
}

/// Has `g` keep the next passkey its site makes, for `minutes`. A wait already longer stays; one the owner asked for
/// stays the owner's.
fn arm(g: &Guard, site: &str, minutes: u64, how: How) -> Armed {
    let mut armed = g.armed.locked();
    let mut until = now_ms() + minutes.clamp(1, MOST_ARMED_MINUTES) * 60_000;
    let mut how = how;
    if let Some((was, was_how)) = *armed {
        if was > now_ms() {
            until = until.max(was);
            if was_how == How::Manual {
                how = How::Manual;
            }
        }
    }
    *armed = Some((until, how));
    let how = match how {
        How::Manual => format!("on {site}, open the account's security settings and add a passkey (\"Create a passkey\"); the node keeps the one it makes"),
        How::Auto => format!("a passkey {site} offers to make in the next {minutes} minutes is kept"),
        How::Phone => format!("a passkey {site} offers to make in the next {minutes} minutes is kept, standing in for your phone or key: each sign-in with it waits on your yes"),
    };
    Armed { site: site.to_string(), until, how }
}

/// What an enrolment waits for.
#[derive(Debug, Serialize)]
pub struct Armed {
    pub site: String,
    /// Until when (ms since the epoch) a passkey the site makes is kept.
    pub until: u64,
    pub how: String,
}

/// Arms an enrolment for `site` in `browser` for `minutes`: the next passkey the site makes there is kept. The
/// browser must already be open on the site, signed in; the site's own "add a passkey" flow, driven by the owner or
/// an agent, then makes the credential on the node's authenticator.
pub fn enrol(site: &str, browser: &Browser, minutes: u64, keys: &dyn KeyStore) -> Result<Armed, String> {
    enrol_in(site, browser, minutes, keys, store::home())
}

fn enrol_in(site: &str, browser: &Browser, minutes: u64, keys: &dyn KeyStore, dir: PathBuf) -> Result<Armed, String> {
    let site = site_arg(site)?;
    allowed_in(&dir, &site)?;
    let g = start(&site, browser, sealer(keys)?, dir.clone())?;
    *g.armed.locked() = None;
    let armed = arm(&g, &site, minutes, How::Manual);
    note(&dir, "You", &site, "Waiting to enrol a passkey", None);
    Ok(armed)
}

/// Starts holding `site`'s stored passkeys in `browser`, for a browser the node doesn't run (`Browser::At`); the
/// node's own browser is watched by itself as it browses. Says how many passkeys it holds.
pub fn use_in(site: &str, browser: &Browser, keys: &dyn KeyStore) -> Result<usize, String> {
    hold(site, browser, keys, store::home())
}

fn hold(site: &str, browser: &Browser, keys: &dyn KeyStore, dir: PathBuf) -> Result<usize, String> {
    let site = site_arg(site)?;
    allowed_in(&dir, &site)?;
    let held = list_in(&dir).iter().filter(|p| fits(&p.site, &site)).count();
    if held == 0 {
        return Err(format!("the vault holds no passkey for {site}: enrol one first"));
    }
    start(&site, browser, sealer(keys)?, dir)?;
    Ok(held)
}

fn start(site: &str, browser: &Browser, sealer: Sealer, dir: PathBuf) -> Result<Arc<Guard>, String> {
    no_script_left_behind(site, browser)?;
    let ws = match browser {
        Browser::Node => Some(crate::browse::cdp_of(site).ok_or(format!("open {site} in the node's browser and sign in first: its browser isn't running"))?),
        Browser::At(_) => None,
    };
    watch(site, browser, ws, sealer, dir)
}

/// The DevTools WebSocket for an address the owner gave: on this machine only, since the credential crosses it.
async fn devtools(at: &str) -> Result<String, String> {
    let at = at.trim();
    let bad = || format!("{at} isn't a DevTools address on this machine: give ws://127.0.0.1:…, http://127.0.0.1:port or a port");
    let with_scheme = if at.contains("://") { at.to_string() } else if at.bytes().all(|b| b.is_ascii_digit()) { format!("http://127.0.0.1:{at}") } else { format!("http://{at}") };
    let u = url::Url::parse(&with_scheme).map_err(|_| bad())?;
    if !local(u.host_str().unwrap_or_default()) {
        return Err(format!("{at} is another machine: a passkey goes over DevTools in the clear, so only a browser on this machine gets one"));
    }
    match u.scheme() {
        "ws" => Ok(with_scheme),
        "http" => agent_browser_core::cdp::discovery::discover_cdp_url(u.host_str().unwrap_or_default(), u.port().ok_or_else(bad)?, None).await,
        _ => Err(bad()),
    }
}

/// Whether a DevTools host is this machine.
fn local(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// One page's authenticator.
struct Page {
    session: String,
    authenticator: String,
    /// How many of the site's passkeys the page's script was last told the authenticator holds.
    held: Option<usize>,
    /// The page script's id in the browser, so a new count replaces it.
    script: Option<String>,
    /// Whether its authenticator answers with no one present, as last set: off while the site's passkeys wait on the
    /// owner's yes, except for the moment an approval lets one sign-in through.
    presence: Option<bool>,
}

/// The page function the page script reports each passkey request through.
const BINDING: &str = "__unbrowsePasskey";

/// Test only: drops the next guard sent into a page, as a navigation can.
#[cfg(test)]
static LOSE_NEXT_GUARD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Test only: drops the next binding added to a page, the same way.
#[cfg(test)]
static LOSE_NEXT_BINDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Runs in every page a guard watches, before the site's own scripts. Neither Chrome's virtual authenticator with no
/// credential nor a headless Chrome with no authenticator ever answers a passkey sign-in: with no UI there is no one
/// to pick another way, so the site's "Verifying it's you" waits for good and its "Try another way" does nothing. With none held, such a request
/// fails at once as a person's "cancel" would, and the site offers its other ways in. A passkey the site offers to
/// make, and the autofill kind of sign-in (`mediation: "conditional"`), still go to the authenticator. Each request
/// is reported (its shape, never a secret), so a site that refuses a passkey says what it asked for.
const PAGE_GUARD: &str = r#"(()=>{try{window.__unbrowseHeld=HELD;window.__unbrowseWays={get:OWNER_GET,create:OWNER_CREATE,approve:APPROVE};const c=navigator.credentials;if(!c||c.__unbrowse)return;
const say=o=>{try{window.__unbrowsePasskey&&window.__unbrowsePasskey(JSON.stringify(o))}catch(e){}};
const brief=pk=>{const s=pk.authenticatorSelection||{};return{rp:pk.rpId||(pk.rp&&pk.rp.id),uv:pk.userVerification||s.userVerification,
attachment:s.authenticatorAttachment,residentKey:s.residentKey||s.requireResidentKey,attestation:pk.attestation,hints:pk.hints,
algs:(pk.pubKeyCredParams||[]).map(p=>p.alg),allow:(pk.allowCredentials||[]).length,exclude:(pk.excludeCredentials||[]).length,
extensions:Object.keys(pk.extensions||{})}};
const g=c.get.bind(c),m=c.create.bind(c),ways=()=>window.__unbrowseWays||{},top=window===window.top,origin=location.origin;
OWNER_JS
const told=(pk,p)=>{if(pk)p.then(()=>say(Object.assign({op:'get',answer:'ok'},brief(pk))),e=>say(Object.assign({op:'get',answer:e.name+': '+e.message},brief(pk))));return p};
c.get=function(o){const pk=o&&o.publicKey,w=ways();if(pk&&o.mediation!=='conditional'){
if(!(window.__unbrowseHeld>0)){if(w.get)return ask('get',pk,o.signal);
say(Object.assign({op:'get',answer:'refused at once: the node holds no passkey here; ask_owner has the owner answer it themselves'},brief(pk)));
return Promise.reject(new DOMException('The operation either timed out or was not allowed.','NotAllowedError'))}
const kept=()=>{const p=told(pk,g(o));return w.get?p.catch(e=>e&&e.name==='NotAllowedError'&&!(o.signal&&o.signal.aborted)?ask('get',pk,o.signal):Promise.reject(e)):p};
return w.approve?approval(pk,o.signal).then(kept):kept()}
return told(pk,g(o))};
c.create=function(o){const pk=o&&o.publicKey;if(pk&&ways().create&&o.mediation!=='conditional')return ask('create',pk,o.signal);const p=m(o);
if(pk)p.then(r=>say(Object.assign({op:'create',answer:'ok'},brief(pk))),e=>say(Object.assign({op:'create',answer:e.name+': '+e.message},brief(pk))));return p};
Object.defineProperty(c,'__unbrowse',{value:true})}catch(e){}})()"#;

/// The part of the page guard that hands a passkey request to the owner's own authenticator (`owner_authn`): the
/// request goes to the node as WebAuthn JSON, the page draws the node's prompt (the phone's QR, a line of status) over
/// itself in a closed shadow root, as a browser draws its own, and the request's promise ends with the credential or
/// the refusal the node sends back through `__unbrowseOwner`. Cancel on the prompt, or the request's own signal,
/// ends it as a person's cancel would.
const OWNER_JS: &str = r#"const pend=new Map();let box=null,boxFor=null;
const u=b=>{const a=b instanceof ArrayBuffer?new Uint8Array(b):new Uint8Array(b.buffer,b.byteOffset,b.byteLength);let s='';for(let i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
const ub=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const r=atob(s),a=new Uint8Array(r.length);for(let i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a.buffer};
const enc=pk=>{const o={};for(const k in pk)o[k]=pk[k];o.challenge=u(pk.challenge);if(pk.user)o.user=Object.assign({},pk.user,{id:u(pk.user.id)});
for(const k of['allowCredentials','excludeCredentials'])if(pk[k])o[k]=pk[k].map(d=>Object.assign({},d,{id:u(d.id)}));delete o.extensions;return o};
const def=(o,p)=>{for(const k in p)Object.defineProperty(o,k,{value:p[k],enumerable:true});return o};
const cred=(op,j)=>{const r=j.response;let resp;
if(op==='get')resp=def(Object.create(AuthenticatorAssertionResponse.prototype),{clientDataJSON:ub(r.clientDataJSON),authenticatorData:ub(r.authenticatorData),signature:ub(r.signature),userHandle:r.userHandle?ub(r.userHandle):null});
else{const ad=r.authenticatorData?ub(r.authenticatorData):null,pub=r.publicKey?ub(r.publicKey):null;resp=def(Object.create(AuthenticatorAttestationResponse.prototype),{clientDataJSON:ub(r.clientDataJSON),attestationObject:ub(r.attestationObject),
getTransports:()=>(r.transports||[]).slice(),getAuthenticatorData:()=>ad,getPublicKey:()=>pub,getPublicKeyAlgorithm:()=>r.publicKeyAlgorithm})}
return def(Object.create(PublicKeyCredential.prototype),{id:j.id,rawId:ub(j.rawId),type:'public-key',response:resp,authenticatorAttachment:j.authenticatorAttachment||'cross-platform',getClientExtensionResults:()=>({}),toJSON:()=>j})};
const hide=()=>{if(box)box.remove();box=null;boxFor=null};
const show=(id,m)=>{if(!box||boxFor!==id){hide();box=document.createElement('div');boxFor=id;box.setAttribute('style','position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center');
const sh=box.attachShadow({mode:'closed'});sh.innerHTML='<div role="dialog" aria-label="Use your passkey" style="background:#fff;color:#111;font:15px system-ui,sans-serif;border-radius:12px;padding:20px 24px;max-width:340px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.3)"><h2 style="font-size:17px;margin:0 0 8px">Use your passkey for '+location.hostname+'</h2><p class="s" style="margin:0 0 12px">Scan with your phone, or touch your security key</p><div class="q"></div><p class="u" style="font:10px monospace;word-break:break-all;color:#666;margin:8px 0"></p><button type="button" style="font:inherit;padding:6px 16px">Cancel</button></div>';
box.__s=sh;sh.querySelector('button').onclick=()=>cancel(id);(document.body||document.documentElement).appendChild(box)}
const sh=box.__s;if(m.qr){sh.querySelector('.q').innerHTML=m.svg||'';sh.querySelector('.u').textContent=m.qr}if(m.status)sh.querySelector('.s').textContent=m.status};
const cancel=id=>{const p=pend.get(id);if(!p)return;pend.delete(id);if(boxFor===id)hide();say({op:'owner-cancel',id});p.rej(new DOMException('The operation either timed out or was not allowed.','NotAllowedError'))};
// A request is said again until the node answers anything about it: a guard taking another's place can miss the first.
const send=(id,o)=>{say(o);let n=0;const t=setInterval(()=>{const p=pend.get(id);if(!p||p.heard||++n>8)return clearInterval(t);say(o)},1500)};
Object.defineProperty(window,'__unbrowseOwner',{value:(id,m)=>{const p=pend.get(id);if(!p)return;p.heard=true;if(m.qr||m.status){show(id,m);return}
pend.delete(id);if(boxFor===id)hide();if(m.approved&&p.op==='approval')p.res();else if(m.credential){try{p.res(cred(p.op,m.credential))}catch(e){p.rej(e)}}else p.rej(new DOMException(m.error||'The operation either timed out or was not allowed.',m.name||'NotAllowedError'))}});
const ask=(op,pk,sig)=>new Promise((res,rej)=>{if(sig&&sig.aborted)return rej(sig.reason||new DOMException('aborted','AbortError'));
const id=Math.random().toString(36).slice(2)+Date.now().toString(36);pend.set(id,{res,rej,op});
if(sig)sig.addEventListener('abort',()=>{if(!pend.delete(id))return;if(boxFor===id)hide();say({op:'owner-cancel',id});rej(sig.reason||new DOMException('aborted','AbortError'))});
let body;try{body=enc(pk)}catch(e){pend.delete(id);return rej(new DOMException('The request could not be read.','NotSupportedError'))}
show(id,{status:'Waiting for your phone or security key'});send(id,Object.assign({op:'owner',kind:op,id,origin,top,publicKey:body},brief(pk)))});
const approval=(pk,sig)=>new Promise((res,rej)=>{if(sig&&sig.aborted)return rej(sig.reason||new DOMException('aborted','AbortError'));
const id=Math.random().toString(36).slice(2)+Date.now().toString(36);pend.set(id,{res,rej,op:'approval'});
if(sig)sig.addEventListener('abort',()=>{if(!pend.delete(id))return;if(boxFor===id)hide();say({op:'owner-cancel',id});rej(sig.reason||new DOMException('aborted','AbortError'))});
show(id,{status:'Approve this sign-in in the Unbrowse window or on your phone'});send(id,Object.assign({op:'approve',id,top},brief(pk)))});"#;

/// The guard for a page: `held` passkeys on its authenticator, and with `owner` a request it can't answer goes to the
/// owner's own authenticator instead of being refused.
fn guard_source(held: usize, ways: Ways) -> String {
    // The settings are read at each request, so a guard that takes another's place changes a page already loaded; the
    // owner's prompt is always there to be used. A page that rewrites them gets nothing from it: the node checks every
    // request it hands on, and an authenticator that waits on the owner's yes signs nothing without it.
    PAGE_GUARD
        .replace("OWNER_JS", OWNER_JS)
        .replace("HELD", &held.to_string())
        .replace("OWNER_GET", if ways.get { "true" } else { "false" })
        .replace("OWNER_CREATE", if ways.create { "true" } else { "false" })
        .replace("APPROVE", if ways.approve { "true" } else { "false" })
}

/// Where a page's passkey request goes past the authenticator's own answer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Ways {
    /// A sign-in the authenticator can't answer goes to the owner's own phone or key.
    get: bool,
    /// So does a passkey the site makes, where no authenticator would keep it.
    create: bool,
    /// A sign-in with the site's kept passkeys waits on the owner's yes first.
    approve: bool,
}

struct Watcher<'a> {
    cdp: CdpClient,
    guard: &'a Guard,
    browser: &'a Browser,
    sealer: &'a Sealer,
    dir: &'a Path,
    pages: HashMap<String, Page>,
    /// Each passkey the authenticators hold, by short name: the highest counter seen.
    known: HashMap<String, u64>,
    /// The counter each passkey's last sign-in was logged at.
    heard: HashMap<String, u64>,
    /// Credentials the site made with no enrolment asked for, already refused.
    refused: HashSet<String>,
    /// Credentials an enrolment took that the vault couldn't write, and how each was enrolled. The site holds their
    /// public key and nothing else holds their private key: a page's authenticator can go at any time (another DevTools
    /// session leaving turns it off), so they wait here, off any page's say, and each pass tries again.
    unkept: HashMap<String, (How, Secret)>,
    /// Kept passkeys are being held off the page: a script may have run on the site (`no_script_left_behind`).
    held_off: bool,
    /// What the owner's own authenticator says back to a page, while a request it forwarded waits (`owner_authn`).
    to_page: tokio::sync::mpsc::UnboundedSender<(String, String, crate::owner_authn::ToPage)>,
    /// Each request waiting on the owner's authenticator, by the page's id for it: what ends its wait.
    waiting: HashMap<String, Arc<AtomicBool>>,
    /// Pages whose authenticator may sign now, the owner having approved a sign-in there, and since when.
    presence_on: HashMap<String, Instant>,
}

const EVENTS: &[&str] =
    &["WebAuthn.credentialAdded", "WebAuthn.credentialAsserted", "Target.targetCreated", "Target.targetInfoChanged", "Runtime.bindingCalled"];

async fn run(g: &Guard, browser: &Browser, ws: Option<String>, sealer: &Sealer, dir: &Path, ready: &std::sync::mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    let ws = match (ws, browser) {
        (Some(ws), _) => ws,
        (None, Browser::At(at)) => devtools(at).await?,
        (None, Browser::Node) => return Err("the node's browser isn't running".into()),
    };
    let cdp = CdpClient::connect(&ws).await.map_err(|e| format!("couldn't reach the browser's DevTools: {e}"))?;
    let mut events = cdp.subscribe_methods(EVENTS);
    cdp.send_command("Target.setDiscoverTargets", Some(json!({ "discover": true })), None).await?;
    let (to_page, mut owner_says) = tokio::sync::mpsc::unbounded_channel();
    let mut w = Watcher {
        cdp,
        guard: g,
        browser,
        sealer,
        dir,
        pages: HashMap::new(),
        known: HashMap::new(),
        heard: HashMap::new(),
        refused: HashSet::new(),
        unkept: HashMap::new(),
        held_off: false,
        to_page,
        waiting: HashMap::new(),
        presence_on: HashMap::new(),
    };
    w.reconcile().await?;
    g.up.store(true, Ordering::SeqCst);
    let _ = ready.send(Ok(()));
    let mut tick = tokio::time::interval(Duration::from_millis(750));
    loop {
        tokio::select! {
            e = events.recv() => {
                let Some(e) = e else { break };
                // Another guard took this one's place: it answers the pages now.
                if !g.alive.load(Ordering::SeqCst) {
                    break;
                }
                match e.method.as_str() {
                    "WebAuthn.credentialAsserted" => {
                        w.asserted(&e.params);
                        w.presence_off(false).await;
                    }
                    // The event carries the credential whole: kept or refused now, before anything can turn the page's
                    // authenticator off and take the credential with it.
                    "WebAuthn.credentialAdded" => w.added(&e.params["credential"]),
                    "Target.targetCreated" | "Target.targetInfoChanged" => w.consider(&e.params["targetInfo"]).await,
                    "Runtime.bindingCalled" if e.params["name"] == BINDING => w.reported(e.params["payload"].as_str().unwrap_or_default(), e.session_id.as_deref()).await,
                    _ => {}
                }
                if e.method.starts_with("WebAuthn.") && w.reconcile().await.is_err() {
                    break;
                }
            }
            Some((session, id, say)) = owner_says.recv() => w.tell_owner_answer(&session, &id, say).await,
            _ = tick.tick() => {
                if w.reconcile().await.is_err() {
                    break;
                }
                w.reassert().await;
                w.presence_off(true).await;
            }
        }
    }
    // What the vault never took goes with this watch: the owner hears, since the site still lists it.
    if !w.unkept.is_empty() {
        note(dir, "Node", &g.site, "Lost a new passkey: the vault couldn't keep it before its browser went", Some("the site may list it: delete it on the site's account page, then enrol again".into()));
    }
    let _ = w.cdp.close().await;
    Ok(())
}

impl Watcher<'_> {
    fn site(&self) -> &str {
        &self.guard.site
    }

    /// Attaches the authenticator to a page that should have it: every page of the node's browser for the site (it
    /// is the site's own, so the authenticator is there before the page asks), or a page on the site in another.
    async fn consider(&mut self, t: &Value) {
        let (id, kind, url) = (t["targetId"].as_str().unwrap_or_default(), t["type"].as_str().unwrap_or_default(), t["url"].as_str().unwrap_or_default());
        if kind != "page" || id.is_empty() || self.pages.contains_key(id) {
            return;
        }
        let on_site = url::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| fits(h, self.site()))).unwrap_or(false);
        if matches!(self.browser, Browser::At(_)) && !on_site {
            return;
        }
        if let Ok(page) = self.attach(id).await {
            self.pages.insert(id.to_string(), page);
        }
    }

    async fn attach(&self, target: &str) -> Result<Page, String> {
        let s = self.cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": target, "flatten": true })), None).await?;
        let session = s["sessionId"].as_str().ok_or("no session")?.to_string();
        let authenticator = if self.guard.bare { String::new() } else { self.arm(&session).await? };
        // The page script reports through a binding. A binding is delivered
        // without the runtime domain being enabled — a live test in the browser
        // engine covers exactly that — and that domain is readable from the
        // page, so enabling it would cost more than the binding gains.
        #[cfg(test)]
        let lost = LOSE_NEXT_BINDING.swap(false, std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        let lost = false;
        if !lost {
            let _ = self.cdp.send_command("Runtime.addBinding", Some(json!({ "name": BINDING })), Some(&session)).await;
        }
        let mut page = Page { session, authenticator, held: None, script: None, presence: None };
        let held = list_in(self.dir).iter().filter(|p| fits(&p.site, self.site())).count();
        self.tell(&mut page, held).await;
        Ok(page)
    }

    /// Tells a page's script how many of the site's passkeys the authenticator holds: in the page now, and in every
    /// document it loads next.
    async fn tell(&self, page: &mut Page, held: usize) {
        if page.held == Some(held) {
            return;
        }
        let source = guard_source(held, self.ways());
        if let Some(old) = page.script.take() {
            let _ = self.cdp.send_command("Page.removeScriptToEvaluateOnNewDocument", Some(json!({ "identifier": old })), Some(&page.session)).await;
        }
        if let Ok(r) = self.cdp.send_command("Page.addScriptToEvaluateOnNewDocument", Some(json!({ "source": source })), Some(&page.session)).await {
            page.script = r["identifier"].as_str().map(String::from);
        }
        #[cfg(test)]
        let lost = LOSE_NEXT_GUARD.swap(false, std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        let lost = false;
        if !lost {
            let _ = self.cdp.send_command("Runtime.evaluate", Some(json!({ "expression": source })), Some(&page.session)).await;
        }
        page.held = Some(held);
    }

    /// Puts the binding and the guard in every page again. Nothing answers for the sends in `attach` and `tell`: a page in
    /// the middle of a navigation can lose them, and nothing else would send them again. With no guard a site's sign-in
    /// waits for good; with no binding the guard runs but can report nothing. Both do nothing in a page that has them, so
    /// this is safe on every tick, and it keeps the count the guard reads fresh.
    async fn reassert(&self) {
        for page in self.pages.values() {
            let _ = self.cdp.send_command("Runtime.addBinding", Some(json!({ "name": BINDING })), Some(&page.session)).await;
            if let Some(held) = page.held {
                let source = guard_source(held, self.ways());
                let _ = self.cdp.send_command("Runtime.evaluate", Some(json!({ "expression": source })), Some(&page.session)).await;
            }
        }
    }

    /// Whether this guard's pages hand a request they can't answer to the owner's own authenticator: a guard with no
    /// authenticator of its own (the vault holds no passkey for the site), on a node that can reach one.
    fn owner(&self) -> bool {
        crate::owner_authn::available()
    }

    fn ways(&self) -> Ways {
        Ways { get: self.owner(), create: self.guard.bare && self.owner(), approve: needs_approval(self.dir, self.site()) }
    }

    /// A passkey request a page reported: its shape and how it ended, for the owner to read when a site refuses one.
    /// A request the page hands to the owner's own authenticator (`owner`), or its cancel, is taken here.
    async fn reported(&mut self, payload: &str, session: Option<&str>) {
        let v: Value = serde_json::from_str(payload).unwrap_or_default();
        // A guard another has taken the place of still hears the page for a moment: the request is the new one's.
        let live = self.guard.alive.load(Ordering::SeqCst);
        match (v["op"].as_str(), session) {
            (Some("owner"), Some(session)) if live => return self.ask_owner(session, &v).await,
            // Only a guard with the authenticator signs with a kept passkey.
            (Some("approve"), Some(session)) if live && !self.guard.bare => return self.ask_approval(session, &v).await,
            (Some("owner" | "approve"), _) => return,
            (Some("owner-cancel"), _) => {
                if let Some(c) = v["id"].as_str().and_then(|id| self.waiting.remove(id)) {
                    c.store(true, Ordering::SeqCst);
                }
                return;
            }
            _ => {}
        }
        let (op, answer) = (v["op"].as_str().unwrap_or("?"), v["answer"].as_str().unwrap_or("?"));
        eprintln!("passkeys: {}: {op} -> {answer} {payload}", self.site());
        if op == "create" || answer != "ok" {
            note(self.dir, "Node", self.site(), &format!("Passkey {op} request: {answer}"), Some(payload.chars().take(600).collect()));
        }
    }

    /// Hands a page's passkey request to the owner's own authenticator: checked against the page's address as the
    /// browser reports it, refused where an agent's script ran on the site, and answered on a thread of its own, its
    /// progress and its end sent back to the page.
    async fn ask_owner(&mut self, session: &str, v: &Value) {
        use crate::owner_authn::{Ask, Refusal, ToPage, Ui};
        let Some(id) = v["id"].as_str().map(String::from) else { return };
        // The page says a request again until it hears of it: one already taken is not asked twice.
        if self.waiting.contains_key(&id) {
            return;
        }
        let refuse = |r: Refusal| ToPage::Refused(r);
        let target = self.pages.iter().find(|(_, p)| p.session == session).map(|(t, _)| t.clone());
        let url = match &target {
            Some(t) => self.cdp.send_command("Target.getTargetInfo", Some(json!({ "targetId": t })), None).await.ok().and_then(|i| i["targetInfo"]["url"].as_str().map(String::from)),
            None => None,
        };
        let ask = if !self.owner() {
            Err(Refusal { name: "NotAllowedError", message: "the node can't reach the owner's authenticator here".into() })
        } else if matches!(self.browser, Browser::Node) && crate::browse::script_may_have_run_on_any(|s| fits(s, self.site())) {
            Err(Refusal {
                name: "NotAllowedError",
                message: "an agent's script ran in a tab of this site, so the owner's passkey isn't asked for until those tabs are closed".into(),
            })
        } else {
            match url {
                Some(url) => Ask::from_page(&url, v),
                None => Err(Refusal { name: "NotAllowedError", message: "the node lost track of the page that asked".into() }),
            }
        };
        let ask = match ask {
            Ok(a) => a,
            Err(r) => {
                note(self.dir, "Node", self.site(), &format!("Refused a page's request for your own passkey: {}", r.message), None);
                return self.tell_owner_answer(session, &id, refuse(r)).await;
            }
        };
        let what = match ask.kind {
            crate::owner_authn::Kind::Get => "sign in",
            crate::owner_authn::Kind::Create => "make a passkey",
        };
        note(self.dir, "Node", &ask.site(), &format!("A page asked to {what} with your own passkey (your phone or security key)"), Some(ask.origin.to_string()));
        let cancel = Arc::new(AtomicBool::new(false));
        self.waiting.insert(id.clone(), cancel.clone());
        self.tell_owner_answer(session, &id, ToPage::Status("Waiting for your phone or security key".into())).await;
        let (tx, page, rid) = (self.to_page.clone(), session.to_string(), id.clone());
        let ui = Ui::new(move |say| {
            let _ = tx.send((page.clone(), rid.clone(), say));
        });
        let dir = self.dir.to_path_buf();
        crate::owner_authn::run(ask, ui, cancel, move |ask, result| {
            let (what, why) = match result {
                Ok(_) => (format!("Used your own passkey to {what}"), None),
                Err(r) => (format!("Your own passkey wasn't used to {what}"), Some(r.message.clone())),
            };
            note(&dir, "Node", &ask.site(), &what, why);
        });
    }

    /// A page asks to sign in with a passkey the vault keeps for a site whose passkeys wait on the owner's yes: the
    /// owner is asked, as any ask reaches them (the window, or their phone through the owner SDK when they answer from
    /// another device), and the page hears their answer. The authenticator signs only after a yes (`approved`).
    async fn ask_approval(&mut self, session: &str, v: &Value) {
        use crate::owner_authn::{Refusal, ToPage};
        let Some(id) = v["id"].as_str().map(String::from) else { return };
        if self.waiting.contains_key(&id) {
            return;
        }
        let site = self.site().to_string();
        let account = list_in(self.dir).into_iter().find(|p| p.approve && fits(&p.site, &site)).map(|p| p.account).unwrap_or_default();
        let cancel = Arc::new(AtomicBool::new(false));
        self.waiting.insert(id.clone(), cancel.clone());
        self.tell_owner_answer(session, &id, ToPage::Status("Approve this sign-in in the Unbrowse window or on your phone".into())).await;
        let (tx, page, dir) = (self.to_page.clone(), session.to_string(), self.dir.to_path_buf());
        tokio::spawn(async move {
            let refuse = |message: String| ToPage::Refused(Refusal { name: "NotAllowedError", message });
            let node = NODE.get().cloned();
            if let Some(n) = &node {
                let events = n.events.clone();
                let away = crate::hands::away_there() && crate::owner_dialog::remote_answers(n.key().ok().map(|k| k as &dyn KeyStore)).on;
                if let Err(e) = crate::hands::reach_owner(move || events.watchers() + usize::from(away), crate::hands::open_window, crate::hands::WINDOW_WAIT).await {
                    note(&dir, "Node", &site, "Couldn't ask you to approve a sign-in with a kept passkey", Some(e.clone()));
                    let _ = tx.send((page, id, refuse(e)));
                    return;
                }
            }
            let who = if account.is_empty() { String::new() } else { format!(" as {account}") };
            let why = format!("Sign in to {site}{who} with the passkey this node keeps for you? Done lets this sign-in through; Can't do it refuses it.");
            let events = node.as_ref().map(|n| n.events.clone());
            let asked = crate::hands::ask(&site, None, &why, "this node", APPROVAL_WAIT, None, |ask| {
                if let Some(e) = &events {
                    e.tell("hands", &json!({ "kind": "ask", "site": ask.site, "ask": ask }));
                    e.emit("activity", ());
                }
            });
            let cancelled = async {
                while !cancel.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            };
            let answer = tokio::select! {
                a = asked => a,
                _ = cancelled => crate::hands::Answer::Declined,
            };
            let (what, say) = match answer {
                crate::hands::Answer::Done => ("You approved a sign-in with a kept passkey", ToPage::Approved),
                crate::hands::Answer::Declined => ("You refused a sign-in with a kept passkey", refuse("the owner refused this sign-in".into())),
                crate::hands::Answer::NoAnswer => ("A sign-in with a kept passkey wasn't approved in time", refuse("the owner didn't approve this sign-in in time".into())),
            };
            note(&dir, "Node", &site, what, None);
            let _ = tx.send((page, id, say));
        });
    }

    /// Has every page's authenticator answer with no one present only where it may: never while the site's passkeys wait
    /// on the owner's yes, save a page an approval is open for. A page whose authenticator was armed before such a
    /// passkey was kept (a tab already open) is brought in line too, or its sign-in, the autofill kind included, would
    /// go through unasked.
    async fn presence_in_line(&mut self) {
        let alone = !needs_approval(self.dir, self.site());
        let mut changes = Vec::new();
        for page in self.pages.values() {
            let on = alone || self.presence_on.contains_key(&page.session);
            if page.presence != Some(on) && !page.authenticator.is_empty() {
                changes.push((page.session.clone(), page.authenticator.clone(), on));
            }
        }
        for (session, authenticator, on) in changes {
            let set = self.cdp.send_command("WebAuthn.setAutomaticPresenceSimulation", Some(json!({ "authenticatorId": authenticator, "enabled": on })), Some(&session)).await;
            if set.is_ok() {
                if let Some(p) = self.pages.values_mut().find(|p| p.session == session) {
                    p.presence = Some(on);
                }
            }
        }
    }

    /// Lets a page's authenticator sign again only by the owner's yes: after the sign-in it was for, or once `stale`
    /// a while has passed with none.
    async fn presence_off(&mut self, stale: bool) {
        let ids: Vec<String> = self.presence_on.iter().filter(|(_, at)| !stale || at.elapsed() > APPROVED_FOR).map(|(s, _)| s.clone()).collect();
        for session in ids {
            self.presence_on.remove(&session);
        }
        self.presence_in_line().await;
    }

    /// After a sign-in with the owner's own phone or key: for the next few minutes a passkey the site offers is kept,
    /// standing in for that device, and each sign-in with it waits on the owner's yes (`How::Phone`). On its own
    /// thread: it can take this guard's place.
    fn after_owner_sign_in(&self) {
        let (site, browser, sealer, dir) = (self.site().to_string(), self.browser.clone(), self.sealer.duplicate(), self.dir.to_path_buf());
        std::thread::spawn(move || {
            if allowed_in(&dir, &site).is_err() {
                return;
            }
            match start(&site, &browser, sealer, dir.clone()) {
                Ok(g) => {
                    arm(&g, &site, AFTER_SIGN_IN_MINUTES, How::Phone);
                    note(&dir, "Node", &site, "After your sign-in with your own phone or key, a passkey the site offers in the next few minutes is kept; each sign-in with it waits on your yes", None);
                }
                Err(e) => eprintln!("passkeys: {site}: {e}"),
            }
        });
    }

    /// Sends what the owner's authenticator said to the page that asked.
    async fn tell_owner_answer(&mut self, session: &str, id: &str, say: crate::owner_authn::ToPage) {
        use crate::owner_authn::ToPage;
        if matches!(say, ToPage::Done(_) | ToPage::Refused(_) | ToPage::Approved) {
            self.waiting.remove(id);
        }
        if matches!(say, ToPage::Approved) {
            // The page's authenticator holds the site's passkeys before it may sign: a tab opened a moment ago may not
            // have been given them yet.
            let _ = self.reconcile().await;
            self.presence_on.insert(session.to_string(), Instant::now());
            self.presence_in_line().await;
        }
        let signed_in = matches!(&say, ToPage::Done(c) if c["response"]["signature"].is_string());
        let expression = format!(
            "window.__unbrowseOwner&&window.__unbrowseOwner({},{})",
            serde_json::to_string(id).unwrap_or_default(),
            say.to_json()
        );
        let _ = self.cdp.send_command("Runtime.evaluate", Some(json!({ "expression": expression })), Some(session)).await;
        if signed_in {
            self.after_owner_sign_in();
        }
    }

    /// Turns on a page's virtual authenticator over `session`, and says its id. Chrome turns a page's authenticators
    /// off whenever any DevTools session on it detaches (another client's included), so this runs again then.
    async fn arm(&self, session: &str) -> Result<String, String> {
        let session = session.to_string();
        self.cdp.send_command("WebAuthn.enable", Some(json!({ "enableUI": false })), Some(&session)).await?;
        let options = json!({
            "protocol": "ctap2",
            "ctap2Version": "ctap2_1",
            "transport": "internal",
            "hasResidentKey": true,
            "hasUserVerification": true,
            "isUserVerified": true,
            // A passkey that waits on the owner's yes is only signed with once they give it (`approved`): until then a
            // request, the page's own or one a script sends past its guard, has no presence and is never answered.
            "automaticPresenceSimulation": !needs_approval(self.dir, self.site()),
            // What a platform authenticator offers today; a site asking for one of these on its new passkey
            // otherwise gets an authenticator that looks older than any it trusts.
            "hasPrf": true,
            "hasLargeBlob": true,
            "hasCredBlob": true,
            "hasHmacSecret": true,
            // Device-bound: the passkey lives on this node only, and says so (backup eligibility and state off).
            "defaultBackupEligibility": false,
            "defaultBackupState": false,
        });
        let a = self.cdp.send_command("WebAuthn.addVirtualAuthenticator", Some(json!({ "options": options })), Some(&session)).await?;
        Ok(a["authenticatorId"].as_str().ok_or("no authenticator")?.to_string())
    }

    /// A sign-in with a stored passkey, as the browser reports it: one line in the activity log.
    fn asserted(&mut self, p: &Value) {
        let c = &p["credential"];
        let id = short_id(c["credentialId"].as_str().unwrap_or_default());
        if !self.known.contains_key(&id) {
            return;
        }
        let count = c["signCount"].as_u64().unwrap_or(0);
        if count > 0 && self.heard.get(&id).is_some_and(|h| count <= *h) {
            return;
        }
        self.used(&id, count);
    }

    fn added(&mut self, c: &Value) {
        let id = short_id(c["credentialId"].as_str().unwrap_or_default());
        let kept = list_in(self.dir).iter().any(|p| p.id == id);
        if !kept && !self.known.contains_key(&id) && !self.refused.contains(&id) {
            self.new_credential(c, &id);
        }
    }

    fn used(&mut self, id: &str, count: u64) {
        self.heard.insert(id.to_string(), count);
        let now = store::now();
        let _ = set_count(self.dir, self.sealer, id, count, Some(now));
        let site = list_in(self.dir).into_iter().find(|p| p.id == id).map(|p| p.site).unwrap_or_else(|| self.site().to_string());
        note(self.dir, "Node", &site, "Signed in with a stored passkey", None);
    }

    async fn credentials(&self, page: &Page) -> Result<Vec<Value>, String> {
        let r = self.cdp.send_command("WebAuthn.getCredentials", Some(json!({ "authenticatorId": page.authenticator })), Some(&page.session)).await?;
        Ok(r["credentials"].as_array().cloned().unwrap_or_default())
    }

    async fn drop_credential(&self, page: &Page, credential_id: &str) {
        let _ = self
            .cdp
            .send_command("WebAuthn.removeCredential", Some(json!({ "authenticatorId": page.authenticator, "credentialId": credential_id })), Some(&page.session))
            .await;
    }

    /// Brings every page's authenticator in line with the vault, and the vault with what the pages did: a credential
    /// an enrolment was waiting for is kept, one nobody asked for is refused, a sign-in's counter is written back,
    /// a passkey the owner removed leaves the pages, and a kept one the pages lack (or hold at an older counter) is
    /// loaded. Fails only when the browser has gone.
    async fn reconcile(&mut self) -> Result<(), String> {
        if !self.guard.alive.load(Ordering::SeqCst) {
            return Err("a guard with the authenticator took over".into());
        }
        // Passkeys turned off, or the site said never to: the authenticators leave every page, and the watch ends.
        if let Err(e) = allowed_in(self.dir, self.site()) {
            for (_, mut page) in std::mem::take(&mut self.pages) {
                // A page left saying one holds a passkey sends the site's sign-in to nothing, which never answers.
                self.tell(&mut page, 0).await;
                let _ = self
                    .cdp
                    .send_command("WebAuthn.removeVirtualAuthenticator", Some(json!({ "authenticatorId": page.authenticator })), Some(&page.session))
                    .await;
            }
            return Err(e);
        }
        self.keep_unkept();
        let targets = self.cdp.send_command("Target.getTargets", None, None).await?;
        let infos = targets["targetInfos"].as_array().cloned().unwrap_or_default();
        let live: HashSet<String> = infos.iter().filter_map(|t| t["targetId"].as_str().map(String::from)).collect();
        self.pages.retain(|id, _| live.contains(id));
        for t in &infos {
            self.consider(t).await;
        }
        // No authenticator, so nothing to bring in line: the pages have their guard, and `reassert` keeps it there.
        if self.guard.bare {
            return Ok(());
        }
        let kept: HashSet<String> = list_in(self.dir).into_iter().filter(|p| fits(&p.site, self.site())).map(|p| p.id).collect();
        self.presence_in_line().await;

        // What each page's authenticator holds now: short name -> (credential id, counter).
        let mut fetched = Vec::new();
        for (target, page) in &self.pages {
            fetched.push((target.clone(), self.credentials(page).await));
        }
        let mut held: HashMap<String, HashMap<String, (String, u64)>> = HashMap::new();
        for (target, creds) in fetched {
            // A page whose authenticator Chrome turned off (another DevTools session left it) is armed again on the
            // same session, empty, and gets its passkeys below. Never a second session: an authenticator left on one
            // the node no longer reads could take a credential unseen. A page that can't be armed is left until its
            // target goes.
            let creds = match creds {
                Ok(c) => c,
                Err(_) => {
                    let session = self.pages[&target].session.clone();
                    let Ok(authenticator) = self.arm(&session).await else { continue };
                    if let Some(p) = self.pages.get_mut(&target) {
                        p.authenticator = authenticator;
                        p.presence = None;
                    }
                    Vec::new()
                }
            };
            let mut on = HashMap::new();
            for c in &creds {
                let cid = c["credentialId"].as_str().unwrap_or_default().to_string();
                let count = c["signCount"].as_u64().unwrap_or(0);
                let id = short_id(&cid);
                if !kept.contains(&id) && !self.known.contains_key(&id) && !self.refused.contains(&id) {
                    self.new_credential(c, &id);
                }
                on.insert(id, (cid, count));
            }
            held.insert(target, on);
        }
        let kept: HashSet<String> = list_in(self.dir).into_iter().filter(|p| fits(&p.site, self.site())).map(|p| p.id).collect();

        // Refused, or removed from the vault: off every page.
        for (target, on) in &held {
            let page = &self.pages[target];
            for (id, (cid, _)) in on {
                if !kept.contains(id) && !self.unkept.contains_key(id) {
                    self.drop_credential(page, cid).await;
                }
            }
        }
        self.known.retain(|id, _| kept.contains(id));

        // Counters: the highest any page reached is the passkey's, and the vault's.
        for on in held.values() {
            for (id, (_, count)) in on {
                if !kept.contains(id) {
                    continue;
                }
                let before = self.known.get(id).copied();
                if before.is_some_and(|b| *count > b) {
                    self.known.insert(id.clone(), *count);
                    if self.heard.get(id).is_none_or(|h| count > h) {
                        self.used(id, *count);
                    } else {
                        let _ = set_count(self.dir, self.sealer, id, *count, None);
                    }
                }
            }
        }

        // Loading: every kept passkey on every page, at its latest counter.
        let missing = held.values().any(|on| kept.iter().any(|id| on.get(id).is_none_or(|(_, c)| self.known.get(id).is_some_and(|k| c < k))));
        let left_behind = if missing { no_script_left_behind(self.site(), self.browser).err() } else { None };
        // Said once, not each tick: the passkey waits in the vault until those tabs are closed.
        match &left_behind {
            Some(why) if !self.held_off => eprintln!("passkeys: {why}"),
            _ => {}
        }
        self.held_off = left_behind.is_some();
        if missing && left_behind.is_none() {
            for (p, mut s) in secrets_for(self.dir, self.sealer, self.site()) {
                let count = s.sign_count.max(self.known.get(&p.id).copied().unwrap_or(0));
                s.sign_count = count;
                for (target, page) in &self.pages {
                    let Some(on) = held.get(target) else { continue };
                    let has = on.get(&p.id);
                    if has.is_some_and(|(_, c)| *c >= count) {
                        continue;
                    }
                    if let Some((cid, _)) = has {
                        self.drop_credential(page, cid).await;
                    }
                    let _ = self
                        .cdp
                        .send_command("WebAuthn.addCredential", Some(json!({ "authenticatorId": page.authenticator, "credential": s.to_cdp() })), Some(&page.session))
                        .await
                        .map_err(|_| "the browser refused the passkey".to_string());
                }
                self.known.insert(p.id.clone(), count);
                self.heard.entry(p.id.clone()).or_insert(count);
            }
        }

        // Every page's script learns what the authenticator now holds: the kept passkeys loaded above, so never one that
        // won't open (a page told of that one sends a sign-in to an authenticator with nothing to answer it), or none it
        // can be trusted to hold while they are kept off it.
        let n = if self.held_off { 0 } else { secrets_for(self.dir, self.sealer, self.site()).len() };
        let targets: Vec<String> = self.pages.keys().cloned().collect();
        for t in targets {
            if let Some(mut page) = self.pages.remove(&t) {
                self.tell(&mut page, n).await;
                self.pages.insert(t, page);
            }
        }
        Ok(())
    }

    /// A passkey an enrolment made is in the vault.
    fn enrolled(&mut self, p: &Passkey, count: u64, how: How) {
        self.known.insert(p.id.clone(), count);
        self.heard.insert(p.id.clone(), count);
        match how {
            // The site and when, no account: the list says whose it is.
            How::Auto => note(self.dir, "Node", &p.site, "Enrolled a passkey the site offered after signing in", None),
            How::Phone => note(self.dir, "Node", &p.site, "Enrolled a passkey the site offered after your sign-in with your own phone or key: each sign-in with it waits on your yes", None),
            How::Manual => {
                let account = if p.account.is_empty() { String::new() } else { format!(" for {}", p.account) };
                note(self.dir, "You", &p.site, &format!("Enrolled a passkey{account}"), None);
            }
        }
    }

    /// Tries the vault again with what it couldn't write. Once kept, a passkey loads onto the pages as any kept one does.
    fn keep_unkept(&mut self) {
        for (id, (how, s)) in std::mem::take(&mut self.unkept) {
            match keep(self.dir, self.sealer, &s, how) {
                Ok(p) => self.enrolled(&p, s.sign_count, how),
                Err(_) => {
                    self.unkept.insert(id, (how, s));
                }
            }
        }
    }

    /// A credential the site just made on the authenticator: kept when an enrolment for this site is waiting (a
    /// sign-in just now, or the owner's), else refused (it leaves the page on this pass, and the owner is told to
    /// delete it on the site).
    fn new_credential(&mut self, c: &Value, id: &str) {
        if self.unkept.contains_key(id) {
            return;
        }
        let armed = self.guard.armed.locked().filter(|(until, _)| now_ms() < *until).map(|(_, how)| how);
        let secret = Secret::from_cdp(c);
        match (secret, armed) {
            (Some(s), Some(how)) if fits(&s.rp_id, self.site()) && allowed_in(self.dir, self.site()).is_ok() => match keep(self.dir, self.sealer, &s, how) {
                Ok(p) => {
                    *self.guard.armed.locked() = None;
                    self.enrolled(&p, s.sign_count, how);
                }
                // The enrolment is spent on this credential: the site already holds its public key.
                Err(e) => {
                    *self.guard.armed.locked() = None;
                    eprintln!("passkeys: {}: couldn't keep the new passkey, and will try again while this browser is open: {e}", self.site());
                    note(self.dir, "Node", self.site(), "Couldn't keep a new passkey yet", Some(format!("keep this browser open: the node is trying again ({e})")));
                    self.unkept.insert(id.to_string(), (how, s));
                }
            },
            _ => {
                self.refused.insert(id.to_string());
                note(
                    self.dir,
                    "Node",
                    self.site(),
                    "Refused a passkey the site made: no enrolment was asked for",
                    Some("the site may list it: delete it on the site's account page".into()),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("unbrowse-passkey-{name}-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn root() -> unbrowse_core::MemoryStore {
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        keys
    }

    /// Every way the credential's secrets could be written out: as given, decoded, or re-encoded.
    fn spellings(b64: &str) -> Vec<Vec<u8>> {
        let raw = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        vec![
            b64.as_bytes().to_vec(),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&raw).into_bytes(),
            hex::encode(&raw).into_bytes(),
            raw,
        ]
    }

    fn credential() -> Value {
        json!({
            "credentialId": base64::engine::general_purpose::STANDARD.encode(b"credential-id-0123456789abcdef"),
            "isResidentCredential": true,
            "rpId": "example.com",
            "privateKey": base64::engine::general_purpose::STANDARD.encode(b"-----not-a-real-pkcs8-private-key-but-long-enough-----"),
            "userHandle": base64::engine::general_purpose::STANDARD.encode(b"user-handle-42"),
            "signCount": 3,
            "userName": "me@example.com"
        })
    }

    /// External security review round 2, 2026-11-04, item 5. On a site the vault holds a passkey for, an agent's eval
    /// could call `navigator.credentials.get` with a challenge of its own (through the prototype, past any wrapper) and
    /// hand the assertion out: no agent script runs there, nor while the owner enrols one. A sign-in's automatic
    /// enrolment window is closed by the script instead, so nothing the script makes is kept.
    /// Past what a site stays armed, a wait has nothing left to wait for.
    #[test]
    fn a_wait_past_what_a_site_stays_armed_is_cut_to_it() {
        assert_eq!(enrol_wait_secs(600), 600);
        assert_eq!(enrol_wait_secs(MOST_ARMED_MINUTES * 60), MOST_ARMED_MINUTES * 60);
        assert_eq!(enrol_wait_secs(7_200), MOST_ARMED_MINUTES * 60);
    }

    #[test]
    fn no_agent_script_runs_where_a_passkey_is_in_reach() {
        let (dir, keys) = (temp("scripts"), root());
        let sealer = sealer(&keys).unwrap();
        keep(&dir, &sealer, &Secret::from_cdp(&credential()).unwrap(), How::Manual).unwrap();
        assert!(holds_scripts_in(&dir, "example.com"), "the vault holds its passkey");
        assert!(holds_scripts_in(&dir, "accounts.example.com"), "the same registrable site");
        assert!(!holds_scripts_in(&dir, "example.org"));
        // What an agent's browse command meets: its eval, and every other command that runs its script, is refused;
        // a click, which the site's own sign-in answers, is not.
        let home = crate::store::scratch_home("passkey-agent-script");
        keep(&home, &sealer, &Secret::from_cdp(&credential()).unwrap(), How::Manual).unwrap();
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let challenge = "navigator.credentials.get({publicKey:{challenge:Uint8Array.from([1,2,3]),rpId:'example.com'}})";
        let refused = crate::browse::no_script_near_a_passkey("example.com", &args(&["eval", challenge])).unwrap_err();
        assert!(refused.contains("passkey"), "{refused}");
        assert!(crate::browse::no_script_near_a_passkey("example.com", &args(&["wait", "--fn", challenge])).is_err());
        assert!(crate::browse::no_script_near_a_passkey("example.com", &args(&["click", "@e3"])).is_ok());
        // The owner said never to the site: no authenticator comes there, so nothing holds its scripts.
        set_never_in(&dir, "example.com", true).unwrap();
        assert!(!holds_scripts_in(&dir, "example.com"));
        // Enrolment windows, with no passkey kept yet.
        let empty = temp("scripts-empty");
        let guard = |site: &str, how: How| {
            let g = Arc::new(Guard { site: site.into(), at: Browser::Node.name(), armed: Mutex::new(Some((now_ms() + 60_000, how))), alive: AtomicBool::new(true), up: AtomicBool::new(true), bare: false });
            GUARDS.locked().push(g.clone());
            g
        };
        let manual = guard("enrol.example", How::Manual);
        assert!(holds_scripts_in(&empty, "enrol.example"), "the owner is enrolling one");
        let auto = guard("signin.example", How::Auto);
        assert!(!holds_scripts_in(&empty, "signin.example"), "a sign-in's window is closed instead");
        assert!(auto.armed.locked().is_none(), "closed: a passkey made now is refused");
        for g in [manual, auto] {
            g.alive.store(false, Ordering::SeqCst);
        }
        assert!(!holds_scripts_in(&empty, "enrol.example"), "no guard, no passkey: scripts run");
    }

    /// The authenticator never comes to a site's browser while a tab an agent's script ran in is open there: a timer
    /// or listener the script left could ask it for a passkey once one is loaded.
    #[test]
    fn no_passkey_comes_to_a_browser_an_agent_script_ran_in() {
        let (dir, keys) = (temp("scripted"), root());
        crate::browse::mark_scripted("scripted-pk.example", "t1");
        let Err(refused) = start("scripted-pk.example", &Browser::Node, sealer(&keys).unwrap(), dir.clone()) else { panic!("an authenticator came to a scripted browser") };
        assert!(refused.contains("script ran"), "{refused}");
        assert!(no_script_left_behind("scripted-pk.example", &Browser::At("9222".into())).is_ok(), "a browser the owner named is theirs");
        assert!(no_script_left_behind("clean-pk.example", &Browser::Node).is_ok());
    }

    /// A site's credential exists only here, so a write that takes back another's loses it for good, and a removal put
    /// back by a counter brings a passkey the owner deleted back to life (TRUST-08.1).
    #[test]
    fn two_writers_of_the_passkeys_lose_nothing() {
        let (dir, keys) = (temp("two-writers"), root());
        let sealer = sealer(&keys).unwrap();
        std::thread::scope(|t| {
            for w in 0..4 {
                let (dir, sealer) = (&dir, &sealer);
                t.spawn(move || {
                    for i in 0..10 {
                        let mut c = credential();
                        c["credentialId"] = json!(format!("{}{w}{i}", c["credentialId"].as_str().unwrap()));
                        keep(dir, sealer, &Secret::from_cdp(&c).unwrap(), How::Manual).unwrap();
                    }
                });
            }
        });
        assert_eq!(list_in(&dir).len(), 40, "every passkey kept is there");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_passkey_round_trips_sealed_and_nothing_secret_is_on_disk() {
        let (dir, keys) = (temp("vault"), root());
        let sealer = sealer(&keys).unwrap();
        let c = credential();
        let s = Secret::from_cdp(&c).unwrap();
        let p = keep(&dir, &sealer, &s, How::Manual).unwrap();
        assert_eq!((p.site.as_str(), p.account.as_str()), ("example.com", "me@example.com"));

        let disk = std::fs::read(file(&dir)).unwrap();
        for field in ["credentialId", "privateKey", "userHandle"] {
            for spelled in spellings(c[field].as_str().unwrap()) {
                assert!(!disk.windows(spelled.len()).any(|w| w == spelled.as_slice()), "{field} is on disk");
            }
        }
        assert!(!String::from_utf8_lossy(&disk).contains("sign_count"), "the counter is sealed too");

        let (back, opened) = secrets_for(&dir, &sealer, "www.example.com").pop().unwrap();
        assert_eq!(back.id, p.id);
        assert_eq!(opened.to_cdp(), c, "what goes back to the browser is what it gave");
        assert!(secrets_for(&dir, &sealer, "example.org").is_empty(), "another site gets nothing");
        assert!(secrets_for(&dir, &super::sealer(&root()).unwrap(), "example.com").is_empty(), "another node's key opens nothing");

        // A sign-in's counter is written back, sealed, with when.
        set_count(&dir, &sealer, &p.id, 9, Some(1234)).unwrap();
        let (back, opened) = secrets_for(&dir, &sealer, "example.com").pop().unwrap();
        assert_eq!((opened.sign_count, back.used), (9, Some(1234)));

        // The list shows no secret.
        let shown = serde_json::to_string(&list_in(&dir).iter().map(View::from).collect::<Vec<_>>()).unwrap();
        assert!(!shown.contains(&back.sealed) && !shown.contains("sealed"));

        // A sealed credential moved onto another entry doesn't open.
        let mut all = list_in(&dir);
        all[0].id = "000000000000".into();
        store::write_json(&file(&dir), &unbrowse_files::PASSKEYS, &all).unwrap();
        assert!(secrets_for(&dir, &sealer, "example.com").is_empty());

        assert!(remove_in(&dir, "000000000000").is_ok() && list_in(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn passkeys_are_on_unless_turned_off() {
        assert!(store::Settings::default().passkeys);
        assert!(flag(None, true) && !flag(None, false));
        assert!(!flag(Some("0"), true) && !flag(Some("off"), true), "the environment turns them off");
        assert!(flag(Some("1"), false), "and on");
        assert!(flag(Some(""), true), "an empty variable leaves the setting");
        let old: store::Settings = serde_json::from_str(r#"{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":7788,"storage_gb":4.0,"excluded":[],"auto_buy":true,"auto_buy_level":1.0}"#).unwrap();
        assert!(old.passkeys && old.passkeys_never.is_empty(), "settings written before passkeys read as on, with no site left out");
        // A passkey kept before automatic enrolment reads as one the owner enrolled.
        let p: Passkey = serde_json::from_str(r#"{"id":"abc","site":"example.com","account":"","created":1,"sealed":""}"#).unwrap();
        assert_eq!(p.how, How::Manual);
    }

    /// The owner's "never" for a site holds for the site and its subdomains, and for no other site; "allow" undoes it.
    #[test]
    fn a_site_said_never_to_gets_no_passkey() {
        let dir = temp("never");
        assert!(allowed_in(&dir, "example.com").is_ok(), "on by default");
        assert_eq!(set_never_in(&dir, "https://accounts.example.com/signin", true).unwrap(), "example.com");
        assert!(allowed_in(&dir, "example.com").unwrap_err().contains("never"));
        assert!(allowed_in(&dir, "login.example.com").is_err());
        assert!(allowed_in(&dir, "example.org").is_ok(), "another site is untouched");
        set_never_in(&dir, "example.com", true).unwrap();
        assert_eq!(settings_in(&dir).passkeys_never, vec!["example.com".to_string()], "said once, kept once");
        set_never_in(&dir, "example.com", false).unwrap();
        assert!(allowed_in(&dir, "example.com").is_ok());
        store::write_json(&dir.join("settings.json"), &unbrowse_files::SETTINGS, &store::Settings { passkeys: false, ..Default::default() }).unwrap();
        assert_eq!(allowed_in(&dir, "example.org").unwrap_err(), OFF, "off is off everywhere");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A WebAuthn demo site, served on 127.0.0.1 for one test: a page that registers a passkey (sending its public key
    /// to the server) and signs in with one (checking the signature against that key, the challenge and the counter).
    const DEMO: &str = r#"<!doctype html><title>Passkey demo</title><script>
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// An ECDSA signature arrives DER-encoded; WebCrypto verifies the raw r || s.
function raw(der) {
  let i = 3;
  const part = () => { const n = der[i]; let v = der.slice(i + 1, i + 1 + n); i += n + 2; while (v.length > 32) v = v.slice(1); const out = new Uint8Array(32); out.set(v, 32 - v.length); return out; };
  const r = part(); const s = part(); const out = new Uint8Array(64); out.set(r); out.set(s, 32); return out;
}
// The node's authenticator attaches to a new tab within a moment; until then a request has nothing to answer it, so
// each try gives up after a few seconds and the next one finds it.
async function tries(n, f) {
  for (let i = 1; ; i++) {
    try { return await f(AbortSignal.timeout(3000)); } catch (e) { if (i >= n) throw e; }
    await new Promise((r) => setTimeout(r, 500));
  }
}
const register = (n = 5) => tries(n, async (signal) => {
  const cred = await navigator.credentials.create({ signal, publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { id: 'localhost', name: 'Demo' },
    user: { id: new TextEncoder().encode('user-1'), name: 'me@demo.example', displayName: 'Me' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } });
  await fetch('/register', { method: 'POST', body: JSON.stringify({ id: cred.id, key: b64(cred.response.getPublicKey()) }) });
  return cred.id;
});
// A sign-in with a password, then the offer a site makes after one ("add a passkey?"), taken.
const login = async (n = 5) => { await fetch('/login', { method: 'POST', body: 'me@demo.example' }); return register(n); };
const signin = (n = 5) => tries(n, async (signal) => {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const a = await navigator.credentials.get({ signal, publicKey: { challenge, rpId: 'localhost', userVerification: 'required' } });
  const { key } = await (await fetch('/key?id=' + a.id)).json();
  const pub = await crypto.subtle.importKey('spki', unb64(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const authData = new Uint8Array(a.response.authenticatorData);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', a.response.clientDataJSON));
  const signed = new Uint8Array(authData.length + hash.length); signed.set(authData); signed.set(hash, authData.length);
  const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, raw(new Uint8Array(a.response.signature)), signed);
  const client = JSON.parse(new TextDecoder().decode(a.response.clientDataJSON));
  const count = new DataView(a.response.authenticatorData).getUint32(33);
  return JSON.stringify({ id: a.id, ok: verified && client.type === 'webauthn.get' && client.challenge === b64url(challenge), count });
});
</script>"#;

    /// A sign-in the demo site checks (the signature against the key it registered, the challenge, the origin), with
    /// no timeout of its own: `allow` names the credential, else the authenticator picks a discoverable one.
    fn checked_signin(allow: Option<&str>) -> String {
        let allow = match allow {
            Some(id) => format!("allowCredentials: [{{ type: 'public-key', id: unb64({id:?}.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(({id:?}.length + 3) % 4)) }}],"),
            None => String::new(),
        };
        format!(
            "(async () => {{ for (let i = 0; i < 150 && !navigator.credentials.__unbrowse; i++) await new Promise(r => setTimeout(r, 100)); \
             const challenge = crypto.getRandomValues(new Uint8Array(32)); \
             const a = await navigator.credentials.get({{ publicKey: {{ challenge, rpId: 'localhost', {allow} userVerification: 'preferred' }} }}); \
             const {{ key }} = await (await fetch('/key?id=' + a.id)).json(); \
             const pub = await crypto.subtle.importKey('spki', unb64(key), {{ name: 'ECDSA', namedCurve: 'P-256' }}, false, ['verify']); \
             const authData = new Uint8Array(a.response.authenticatorData); \
             const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', a.response.clientDataJSON)); \
             const signed = new Uint8Array(authData.length + hash.length); signed.set(authData); signed.set(hash, authData.length); \
             const verified = await crypto.subtle.verify({{ name: 'ECDSA', hash: 'SHA-256' }}, pub, raw(new Uint8Array(a.response.signature)), signed); \
             const client = JSON.parse(new TextDecoder().decode(a.response.clientDataJSON)); \
             return JSON.stringify({{ id: a.id, ok: verified && a instanceof PublicKeyCredential && client.type === 'webauthn.get' && client.challenge === b64url(challenge) && client.origin === location.origin }}); }})()"
        )
    }

    fn serve_demo() -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let keys: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        std::thread::spawn(move || {
            for mut conn in listener.incoming().flatten() {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let body = loop {
                    let Ok(n) = conn.read(&mut chunk) else { break None };
                    if n == 0 {
                        break None;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let Some(end) = text.find("\r\n\r\n") else { continue };
                    let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break Some((text[..end].to_string(), String::from_utf8_lossy(&buf[end + 4..end + 4 + len]).to_string()));
                    }
                };
                let Some((head, body)) = body else { continue };
                let line = head.lines().next().unwrap_or_default().to_string();
                let (kind, answer) = if line.starts_with("POST /login") {
                    ("application/json", "{}".to_string())
                } else if line.starts_with("POST /register") {
                    let v: Value = serde_json::from_str(&body).unwrap_or_default();
                    keys.locked().insert(v["id"].as_str().unwrap_or_default().into(), v["key"].as_str().unwrap_or_default().into());
                    ("application/json", "{}".to_string())
                } else if let Some(q) = line.strip_prefix("GET /key?id=") {
                    let id = q.split(' ').next().unwrap_or_default();
                    ("application/json", json!({ "key": keys.locked().get(id) }).to_string())
                } else {
                    ("text/html", DEMO.to_string())
                };
                let _ = write!(conn, "HTTP/1.1 200 OK\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len());
            }
        });
        port
    }

    /// Headless Chrome in a profile of its own, and its DevTools address.
    struct Chrome {
        child: std::process::Child,
        profile: PathBuf,
        ws: String,
        /// One test's Chrome at a time: several at once load the machine enough to fail other tests' timing.
        _turn: std::sync::MutexGuard<'static, ()>,
    }

    static CHROME_TURN: Mutex<()> = Mutex::new(());

    impl Chrome {
        /// A test holds one at a time: drop the last before launching the next.
        fn launch(name: &str) -> Chrome {
            let turn = CHROME_TURN.locked();
            let path = agent_browser_core::cdp::chrome::find_chrome().expect("the passkey test drives Chrome: install it, or Chrome for Testing with `agent-browser install`");
            let profile = temp(name);
            // A container without user namespaces can't run Chrome's sandbox; the launcher drops it on the same variable.
            let no_sandbox: &[&str] = if std::env::var_os("AGENT_BROWSER_NO_SANDBOX").is_some() { &["--no-sandbox"] } else { &[] };
            let child = std::process::Command::new(path)
                .args(no_sandbox)
                .args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-gpu"])
                .arg(format!("--user-data-dir={}", profile.display()))
                .arg("about:blank")
                .stdout(std::process::Stdio::null())
                .stderr(std::fs::File::create(profile.with_extension("err")).map(std::process::Stdio::from).unwrap_or_else(|_| std::process::Stdio::null()))
                .spawn()
                .unwrap();
            for _ in 0..150 {
                if let Some((port, path)) = agent_browser_core::cdp::chrome::read_devtools_active_port(&profile) {
                    return Chrome { child, profile, ws: format!("ws://127.0.0.1:{port}{path}"), _turn: turn };
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            // Not left running behind the failed test.
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            let said = std::fs::read_to_string(profile.with_extension("err")).unwrap_or_default();
            panic!("Chrome didn't open its DevTools: {}", said.chars().take(1500).collect::<String>());
        }
    }

    impl Drop for Chrome {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.profile);
            let _ = std::fs::remove_file(self.profile.with_extension("err"));
        }
    }

    /// Opens `url` in a new tab of the browser at `ws` and runs `expression` there, as the page's own script.
    fn run_on_page(rt: &tokio::runtime::Runtime, ws: &str, url: &str, expression: &str) -> Result<String, String> {
        rt.block_on(async {
            let cdp = CdpClient::connect(ws).await?;
            let t = cdp.send_command("Target.createTarget", Some(json!({ "url": url })), None).await?;
            let s = cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": t["targetId"], "flatten": true })), None).await?;
            let session = s["sessionId"].as_str().unwrap_or_default().to_string();
            // WebAuthn answers only a focused page, and a headless tab opened behind another may not be.
            cdp.send_command("Page.bringToFront", None, Some(&session)).await?;
            cdp.send_command("Emulation.setFocusEmulationEnabled", Some(json!({ "enabled": true })), Some(&session)).await?;
            let ready = json!({ "expression": "document.readyState === 'complete' && typeof signin === 'function'", "returnByValue": true });
            for _ in 0..100 {
                let r = cdp.send_command("Runtime.evaluate", Some(ready.clone()), Some(&session)).await?;
                if r["result"]["value"] == json!(true) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let r = cdp
                .send_command("Runtime.evaluate", Some(json!({ "expression": expression, "awaitPromise": true, "returnByValue": true, "userGesture": true })), Some(&session))
                .await?;
            cdp.close().await;
            match r.get("exceptionDetails") {
                Some(e) => Err(e["exception"]["description"].as_str().unwrap_or("the page's script failed").to_string()),
                None => Ok(r["result"]["value"].as_str().unwrap_or_default().to_string()),
            }
        })
    }

    fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
        for _ in 0..300 {
            if ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("{what} didn't happen");
    }

    /// End to end in headless Chrome: a site's page registers a passkey on the node's authenticator while an
    /// enrolment waits, and the vault keeps it sealed. A second browser, with an empty profile, then signs in with it
    /// from the vault alone: the site checks the signature against the key it registered. The counter goes back into
    /// the vault, the sign-in is one line in the activity log, and a passkey the site makes with no enrolment asked
    /// for is refused.
    #[test]
    fn a_passkey_enrolled_once_signs_in_from_the_vault() {
        let (dir, keys) = (temp("e2e-vault"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        let first = Chrome::launch("e2e-first");
        let armed = enrol_in("localhost", &Browser::At(first.ws.clone()), 5, &keys, dir.clone()).unwrap();
        assert_eq!(armed.site, "localhost");
        let registered = run_on_page(&rt, &first.ws, &page, "register()").expect("the site registers a passkey");
        wait_for("the vault keeping the passkey", || list_in(&dir).len() == 1);
        let kept = list_in(&dir).remove(0);
        assert_eq!((kept.site.as_str(), kept.account.as_str()), ("localhost", "me@demo.example"));
        let disk = std::fs::read_to_string(file(&dir)).unwrap();
        assert!(!disk.contains(&registered), "the credential id is sealed");
        drop(first);

        // A browser that has never seen the passkey: before the node holds it, the site's sign-in fails.
        let second = Chrome::launch("e2e-second");
        assert!(run_on_page(&rt, &second.ws, &page, "signin(1)").is_err(), "no authenticator, no sign-in");
        assert_eq!(hold("localhost", &Browser::At(second.ws.clone()), &keys, dir.clone()).unwrap(), 1);
        let answer: Value = serde_json::from_str(&run_on_page(&rt, &second.ws, &page, "signin()").expect("the site signs in")).unwrap();
        assert_eq!(answer["id"], json!(registered), "the passkey enrolled in the first browser");
        assert_eq!(answer["ok"], json!(true), "the site verified the signature: {answer}");
        let count = answer["count"].as_u64().unwrap();
        assert!(count >= 1, "{answer}");
        let sealer = sealer(&keys).unwrap();
        wait_for("the counter going back into the vault", || secrets_for(&dir, &sealer, "localhost").first().is_some_and(|(p, s)| s.sign_count >= count && p.used.is_some()));
        let log = std::fs::read_to_string(dir.join("activity.jsonl")).unwrap();
        assert!(log.contains("Signed in with a stored passkey") && log.contains("\"site\":\"localhost\""), "{log}");
        assert!(!log.contains(&registered), "the log holds no credential");

        // No enrolment asked for: a passkey the site makes now is refused, and the vault keeps only the first.
        run_on_page(&rt, &second.ws, &page, "register()").expect("the site makes a passkey on the authenticator");
        wait_for("the refusal", || std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default().contains("Refused a passkey"));
        assert_eq!(list_in(&dir).len(), 1);
        drop(second);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A page left open, as the node finds it when it arrives, and a way to read its state.
    fn open_page(rt: &tokio::runtime::Runtime, ws: &str, url: &str) -> (CdpClient, String) {
        rt.block_on(async {
            let cdp = CdpClient::connect(ws).await.unwrap();
            let t = cdp.send_command("Target.createTarget", Some(json!({ "url": url })), None).await.unwrap();
            let s = cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": t["targetId"], "flatten": true })), None).await.unwrap();
            (cdp, s["sessionId"].as_str().unwrap_or_default().to_string())
        })
    }

    fn page_says(rt: &tokio::runtime::Runtime, cdp: &CdpClient, session: &str, expression: &str) -> Value {
        rt.block_on(cdp.send_command("Runtime.evaluate", Some(json!({ "expression": expression, "returnByValue": true })), Some(session))).unwrap()["result"]["value"].clone()
    }

    /// The site has the credential's public key and the authenticator holds its only private key, so a vault that can't
    /// write this moment must not cost the owner the credential: the node holds on to it and tries again. The page can't
    /// be relied on for that: here the DevTools session that ran the site's script leaves, which turns its authenticator off.
    #[test]
    fn a_passkey_the_vault_cant_keep_yet_is_kept_once_it_can() {
        let (dir, keys) = (temp("e2e-unkept"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("e2e-unkept");
        // A folder where the vault's file goes: every write of it fails.
        std::fs::create_dir(file(&dir)).unwrap();
        enrol_in("localhost", &Browser::At(chrome.ws.clone()), 1, &keys, dir.clone()).unwrap();
        run_on_page(&rt, &chrome.ws, &page, "register()").expect("the site registers a passkey");
        // Passes of the watch go by with the vault still shut.
        std::thread::sleep(Duration::from_secs(3));
        assert!(list_in(&dir).is_empty());
        std::fs::remove_dir(file(&dir)).unwrap();
        wait_for("the vault keeping the passkey once it can", || list_in(&dir).len() == 1);
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A page is told what the authenticator can really answer with. A passkey that won't open never reaches it, and a
    /// page told there is one sends the site's sign-in to an authenticator that holds nothing, which never answers.
    #[test]
    fn a_passkey_that_wont_open_isnt_counted_as_held() {
        let (dir, keys) = (temp("e2e-damaged"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("e2e-damaged");
        let mut c = credential();
        c["rpId"] = json!("localhost");
        keep(&dir, &sealer(&keys).unwrap(), &Secret::from_cdp(&c).unwrap(), How::Manual).unwrap();
        let mut all = list_in(&dir);
        all[0].sealed = "AAAA".into();
        store::write_json(&file(&dir), &unbrowse_files::PASSKEYS, &all).unwrap();
        let (cdp, session) = open_page(&rt, &chrome.ws, &page);
        enrol_in("localhost", &Browser::At(chrome.ws.clone()), 5, &keys, dir.clone()).unwrap();
        wait_for("the page's guard", || page_says(&rt, &cdp, &session, "navigator.credentials.__unbrowse === true") == json!(true));
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(page_says(&rt, &cdp, &session, "window.__unbrowseHeld"), json!(0));
        rt.block_on(cdp.close());
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The owner says never while a page is open: the authenticator leaves it, so the page must stop saying one holds a
    /// passkey, or the site's next sign-in waits on nothing for good.
    #[test]
    fn a_page_hears_it_holds_nothing_once_the_owner_says_never() {
        let (dir, keys) = (temp("e2e-never"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("e2e-never");
        let mut c = credential();
        c["rpId"] = json!("localhost");
        keep(&dir, &sealer(&keys).unwrap(), &Secret::from_cdp(&c).unwrap(), How::Manual).unwrap();
        let (cdp, session) = open_page(&rt, &chrome.ws, &page);
        hold("localhost", &Browser::At(chrome.ws.clone()), &keys, dir.clone()).unwrap();
        wait_for("the page hearing of the passkey", || page_says(&rt, &cdp, &session, "window.__unbrowseHeld") == json!(1));
        set_never_in(&dir, "localhost", true).unwrap();
        wait_for("the page hearing it holds nothing", || page_says(&rt, &cdp, &session, "window.__unbrowseHeld") == json!(0));
        rt.block_on(cdp.close());
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A passkey that reaches the vault after a guard started, with an agent's script on the site meanwhile, stays off the
    /// page: the authenticator signs with no one present, so what the script left there could use it.
    #[test]
    fn a_passkey_imported_after_a_script_ran_stays_off_the_authenticator() {
        let (dir, keys) = (temp("e2e-late-passkey"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let first = Chrome::launch("e2e-late-first");
        enrol_in("localhost", &Browser::At(first.ws.clone()), 5, &keys, dir.clone()).unwrap();
        run_on_page(&rt, &first.ws, &page, "register()").expect("the site registers a passkey");
        wait_for("the vault keeping the passkey", || list_in(&dir).len() == 1);
        drop(first);
        let vault = std::fs::read(file(&dir)).unwrap();
        std::fs::remove_file(file(&dir)).unwrap();

        // The guard starts with no script on the site and nothing to hold.
        let second = Chrome::launch("e2e-late-second");
        let g = watch("localhost", &Browser::Node, Some(second.ws.clone()), sealer(&keys).unwrap(), dir.clone()).unwrap();
        crate::browse::mark_scripted("localhost", "tab-of-a-script");
        std::fs::write(file(&dir), &vault).unwrap();
        std::thread::sleep(Duration::from_secs(2));
        assert!(run_on_page(&rt, &second.ws, &page, "signin()").is_err(), "no passkey reached the page");
        g.alive.store(false, Ordering::SeqCst);
        drop(second);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A second caller finds a guard still on its way up: it waits for it, as the caller who started it does. A guard
    /// that doesn't come up is an error, never a guard that holds nothing.
    #[test]
    fn a_guard_on_its_way_up_is_waited_for() {
        let guard = || Arc::new(Guard { site: "up.example".into(), at: "node".into(), armed: Mutex::new(None), alive: AtomicBool::new(true), up: AtomicBool::new(false), bare: false });
        let (g, started) = (guard(), Instant::now());
        let later = g.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            later.up.store(true, Ordering::SeqCst);
        });
        assert!(once_up(g).is_ok());
        assert!(started.elapsed() >= Duration::from_millis(300), "it waited");
        let gone = guard();
        gone.alive.store(false, Ordering::SeqCst);
        assert!(once_up(gone).is_err());
    }

    /// The browser going away ends an enrolment the owner asked for, and they hear it.
    #[test]
    fn an_enrolment_whose_browser_goes_away_is_said() {
        let (dir, keys) = (temp("e2e-enrol-gone"), root());
        let chrome = Chrome::launch("e2e-enrol-gone");
        enrol_in("localhost", &Browser::At(chrome.ws.clone()), 5, &keys, dir.clone()).unwrap();
        drop(chrome);
        wait_for("the owner being told", || std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default().contains("Stopped waiting to enrol"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A guard lost on its way into a page comes back, and so does the binding it reports through: nothing answers for the
    /// first sends, so a page mid-navigation could otherwise stay without either for good. The script is added for the next document, not this one, so this page has only
    /// the send that was lost.
    #[test]
    fn a_page_that_lost_its_guard_gets_it_back() {
        let (dir, keys) = (temp("e2e-lost-guard"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("e2e-lost-guard");
        // A page already open when the node arrives has no document to come, so only a send can reach it.
        let opened = rt.block_on(async {
            let cdp = CdpClient::connect(&chrome.ws).await.unwrap();
            let t = cdp.send_command("Target.createTarget", Some(json!({ "url": page.clone() })), None).await.unwrap();
            let s = cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": t["targetId"], "flatten": true })), None).await.unwrap();
            let session = s["sessionId"].as_str().unwrap_or_default().to_string();
            for _ in 0..100 {
                let r = cdp.send_command("Runtime.evaluate", Some(json!({ "expression": "document.readyState === 'complete'", "returnByValue": true })), Some(&session)).await.unwrap();
                if r["result"]["value"] == json!(true) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            (cdp, session)
        });
        LOSE_NEXT_GUARD.store(true, std::sync::atomic::Ordering::SeqCst);
        LOSE_NEXT_BINDING.store(true, std::sync::atomic::Ordering::SeqCst);
        enrol_in("localhost", &Browser::At(chrome.ws.clone()), 5, &keys, dir.clone()).unwrap();
        let (cdp, session) = opened;
        let guarded = rt.block_on(async {
            for _ in 0..80 {
                let r = cdp.send_command("Runtime.evaluate", Some(json!({ "expression": "navigator.credentials.__unbrowse === true && typeof window.__unbrowsePasskey === 'function'", "returnByValue": true })), Some(&session)).await.unwrap();
                if r["result"]["value"] == json!(true) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            false
        });
        assert!(!LOSE_NEXT_GUARD.load(std::sync::atomic::Ordering::SeqCst) && !LOSE_NEXT_BINDING.load(std::sync::atomic::Ordering::SeqCst), "the first sends were lost");
        assert!(guarded, "the node puts the guard and its way of reporting back");
        rt.block_on(cdp.close());
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A site asks for a passkey the vault doesn't hold, on a node that can reach the owner's own authenticator (a
    /// software key stands in for their security key here): the page's own request goes to it instead of being
    /// refused, the page shows the prompt, and the site gets credentials it checks as it would any browser's. The
    /// site registers a passkey on the owner's key, then signs in with it, checking the signature against the key it
    /// registered; both are lines in the activity log.
    #[test]
    fn a_page_asks_the_owners_own_authenticator_for_a_passkey_the_vault_does_not_hold() {
        let (dir, keys) = (temp("e2e-owner"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("e2e-owner");
        // Set while this test holds the one Chrome turn: no other passkey test sees the software key.
        *crate::owner_authn::TEST_DEVICE.lock().unwrap() = Some(Arc::new(crate::owner_authn::tests::SoftKey::new()));
        let browser = Browser::At(chrome.ws.clone());
        let bare = watch_as("localhost", &browser, None, sealer(&keys).unwrap(), dir.clone(), true).unwrap();
        // The software key makes non-discoverable passkeys only, so the sign-in names the one it made.
        let register = "(async () => { for (let i = 0; i < 150 && !navigator.credentials.__unbrowse; i++) await new Promise(r => setTimeout(r, 100)); \
            const cred = await navigator.credentials.create({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { id: 'localhost', name: 'Demo' }, \
              user: { id: new TextEncoder().encode('user-1'), name: 'me@demo.example', displayName: 'Me' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], \
              authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' } } }); \
            if (!(cred instanceof PublicKeyCredential) || cred.response.getPublicKeyAlgorithm() !== -7) throw new Error('not a credential the page can read'); \
            await fetch('/register', { method: 'POST', body: JSON.stringify({ id: cred.id, key: b64(cred.response.getPublicKey()) }) }); return cred.id; })()";
        let made = run_on_page(&rt, &chrome.ws, &page, register);
        let signed = made.as_ref().ok().map(|id| run_on_page(&rt, &chrome.ws, &page, &checked_signin(Some(id))));
        *crate::owner_authn::TEST_DEVICE.lock().unwrap() = None;
        let made = made.expect("the site registers a passkey on the owner's own key");
        let answer: Value = serde_json::from_str(&signed.unwrap().expect("the site signs in with it")).unwrap();
        assert_eq!(answer["ok"], json!(true), "the site checked the signature, the challenge and the client data: {answer}");
        assert_eq!(answer["id"], json!(made), "with the passkey it registered");
        assert!(list_in(&dir).is_empty(), "the vault keeps nothing: the passkey is on the owner's own key");
        let log = std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default();
        assert!(log.contains("Used your own passkey to make a passkey") && log.contains("Used your own passkey to sign in"), "{log}");
        bare.alive.store(false, Ordering::SeqCst);
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Option 2 end to end: the owner signs in once with their own key (a software key stands in), which arms an
    /// enrolment; the passkey the site then makes is kept by the node as one that stands in for that key. A sign-in with
    /// it waits on the owner's yes (an ask, as the window and the owner SDK see them): approved, the site checks the
    /// signature; refused, the page hears NotAllowedError; and a request sent past the guard gets no answer at all.
    #[test]
    fn a_passkey_kept_after_a_phone_sign_in_signs_in_only_on_the_owners_yes() {
        let (dir, keys) = (temp("e2e-approve"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("e2e-approve");
        *crate::owner_authn::TEST_DEVICE.lock().unwrap() = Some(Arc::new(crate::owner_authn::tests::SoftKey::new()));
        let browser = Browser::At(chrome.ws.clone());
        let _bare = watch_as("localhost", &browser, None, sealer(&keys).unwrap(), dir.clone(), true).unwrap();
        let guarded = "for (let i = 0; i < 150 && !navigator.credentials.__unbrowse; i++) await new Promise(r => setTimeout(r, 100));";
        // The owner's own key: a credential made on it, then a sign-in with it.
        let on_key = run_on_page(&rt, &chrome.ws, &page, &format!("(async () => {{ {guarded} \
            const c = await navigator.credentials.create({{ publicKey: {{ challenge: new Uint8Array(32), rp: {{ id: 'localhost', name: 'Demo' }}, \
              user: {{ id: new Uint8Array([9]), name: 'me@demo.example', displayName: 'Me' }}, pubKeyCredParams: [{{ type: 'public-key', alg: -7 }}] }} }}); \
            await navigator.credentials.get({{ publicKey: {{ challenge: new Uint8Array(32), rpId: 'localhost', allowCredentials: [{{ type: 'public-key', id: c.rawId }}] }} }}); return c.id; }})()"));
        *crate::owner_authn::TEST_DEVICE.lock().unwrap() = None;
        on_key.expect("the owner's key made a credential and signed in with it");
        // The sign-in armed an enrolment: the guard with the authenticator takes over, and the site's passkey is kept.
        wait_for("the enrolment armed by the owner's sign-in", || guard_of("localhost", &browser.name()).is_some_and(|g| !g.bare && g.armed.locked().is_some()));
        run_on_page(&rt, &chrome.ws, &page, "register()").expect("the site makes a passkey on the node's authenticator");
        for _ in 0..100 {
            if list_in(&dir).len() == 1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(list_in(&dir).len(), 1, "the vault keeps it: {}", std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default());
        let kept = &list_in(&dir)[0];
        assert_eq!((kept.how, kept.approve), (How::Phone, true), "kept as standing in for the owner's key");


        // Each sign-in waits on the owner: answered here as the window or the owner SDK would.
        let answer_next = |how: crate::hands::Answer| {
            std::thread::spawn(move || {
                for _ in 0..300 {
                    if crate::hands::asks().iter().any(|a| a.site == "localhost") {
                        return crate::hands::answer("localhost", how);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                0
            })
        };
        let approving = answer_next(crate::hands::Answer::Done);
        let signed = run_on_page(&rt, &chrome.ws, &page, &checked_signin(None));
        let log = || std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default();
        let signed: Value = serde_json::from_str(&signed.unwrap_or_else(|e| panic!("approved, it signs in: {e}\n{}", log()))).unwrap();
        assert_eq!(approving.join().unwrap(), 1, "the sign-in waited on one ask");
        assert_eq!(signed["ok"], json!(true), "the site checked the signature: {signed}");

        let refusing = answer_next(crate::hands::Answer::Declined);
        let refused = run_on_page(&rt, &chrome.ws, &page, &format!("(async () => {{ {guarded} try {{ await navigator.credentials.get({{ publicKey: {{ challenge: new Uint8Array(32), rpId: 'localhost' }} }}); return 'signed'; }} catch (e) {{ return e.name; }} }})()")).unwrap();
        assert_eq!(refusing.join().unwrap(), 1);
        assert_eq!(refused, "NotAllowedError", "refused by the owner");

        // Past the guard (the prototype's own get): no presence, no answer.
        let past = run_on_page(&rt, &chrome.ws, &page, &format!("(async () => {{ {guarded} return Promise.race([CredentialsContainer.prototype.get.call(navigator.credentials, {{ publicKey: {{ challenge: new Uint8Array(32), rpId: 'localhost' }} }}).then(() => 'signed', e => e.name), new Promise(r => setTimeout(() => r('waiting'), 4000))]); }})()")).unwrap();
        assert_eq!(past, "waiting", "the authenticator signs nothing without the owner's yes");
        let log = std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default();
        assert!(log.contains("You approved a sign-in") && log.contains("You refused a sign-in"), "{log}");
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A site that asks for a passkey before any password, on a page with no authenticator at all: the bare guard refuses
    /// at once, so the site can offer its other ways in, and nothing can be made. Enrolling later takes the guard over.
    #[test]
    fn a_bare_guard_refuses_a_sign_in_at_once_and_gives_way_to_an_enrolment() {
        let (dir, keys) = (temp("e2e-bare"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("e2e-bare");
        let browser = Browser::At(chrome.ws.clone());
        let bare = watch_as("localhost", &browser, None, sealer(&keys).unwrap(), dir.clone(), true).unwrap();
        let ask = "(async () => { for (let i = 0; i < 150 && !navigator.credentials.__unbrowse; i++) await new Promise(r => setTimeout(r, 100)); \
            return Promise.race([navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), userVerification: 'required' } }).then(() => 'signed', e => e.name), new Promise(r => setTimeout(() => r('waiting'), 5000))]); })()";
        assert_eq!(run_on_page(&rt, &chrome.ws, &page, ask).unwrap(), "NotAllowedError", "refused at once, not left waiting");

        enrol_in("localhost", &browser, 5, &keys, dir.clone()).unwrap();
        assert!(!bare.alive.load(Ordering::SeqCst), "the bare guard gave way");
        run_on_page(&rt, &chrome.ws, &page, "register()").expect("the site registers a passkey on the authenticator");
        wait_for("the vault keeping the passkey", || list_in(&dir).len() == 1);
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An authenticator holding none of the site's passkeys answers a passkey sign-in at once with "not allowed", as a
    /// person's cancel would, so the site moves on to its other ways in (Google's "Verifying it's you" otherwise waits
    /// for good). A passkey the site then offers to make still reaches the authenticator and is kept, and both
    /// requests are reported in the activity log by their shape, with no credential in it.
    #[test]
    fn an_empty_authenticator_refuses_a_sign_in_at_once_and_still_enrols() {
        let (dir, keys) = (temp("e2e-empty"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("e2e-empty");
        enrol_in("localhost", &Browser::At(chrome.ws.clone()), 5, &keys, dir.clone()).unwrap();

        // The node's page guard arrives over CDP after the tab opens; on a loaded runner that can take seconds, and a
        // request made before it isn't the node's to report, so each probe waits for it and says so if it never came.
        let probe = "(async () => { for (let i = 0; i < 150 && !navigator.credentials.__unbrowse; i++) await new Promise(r => setTimeout(r, 100)); \
            if (!navigator.credentials.__unbrowse) throw new Error('the node never put its passkey guard in the page'); \
            const t0 = performance.now(); try { await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: 'localhost', userVerification: 'required' } }); return 'answered'; } \
            catch (e) { return e.name + ' ' + Math.round(performance.now() - t0); } })()";
        let answer = run_on_page(&rt, &chrome.ws, &page, probe).expect("the page runs");
        let (name, ms) = answer.split_once(' ').unwrap_or((&answer, "0"));
        assert_eq!(name, "NotAllowedError", "{answer}");
        assert!(ms.parse::<u64>().unwrap_or(u64::MAX) < 2000, "refused at once, not after a wait: {answer}");

        let after_guard = "(async () => { for (let i = 0; i < 150 && !navigator.credentials.__unbrowse; i++) await new Promise(r => setTimeout(r, 100)); \
            if (!navigator.credentials.__unbrowse) throw new Error('the node never put its passkey guard in the page'); return register(); })()";
        let registered = run_on_page(&rt, &chrome.ws, &page, after_guard).expect("the site still registers a passkey");
        wait_for("the vault keeping the passkey", || list_in(&dir).len() == 1);
        wait_for("both requests reported", || {
            let log = std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default();
            log.contains("Passkey get request: refused at once") && log.contains("Passkey create request: ok")
        });
        let log = std::fs::read_to_string(dir.join("activity.jsonl")).unwrap();
        assert!(!log.contains(&registered), "the log holds no credential");
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A P-256 key made for these tests (PKCS#8 and its public key, base64url), and a P-384 one the authenticator
    /// can't sign with. Fixtures only: no site knows them.
    const P256_PKCS8: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQImqJmqdSbqyOcnAN-Ifwmczrin9qbfTxx-8Mo7AuGahRANCAAQG3gg1HpE2n-V5c6rNd6N1BgO0JVotAdG62MzBn2jNDyw5pXpVQ-_0NtIUtFS60OEkQ-LM6LNLrsk4UxnYMd3o";
    const P256_SPKI: &str = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBt4INR6RNp_leXOqzXejdQYDtCVaLQHRutjMwZ9ozQ8sOaV6VUPv9DbSFLRUutDhJEPizOizS67JOFMZ2DHd6A";
    const P384_PKCS8: &str = "MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDB4v35HV7wxW6ZEEp1ahHGe7Xtwo7UfmBP13l2WQqdSaPCBLhkZUiT7JPgP-wlQsOChZANiAASGejDzEZotO-aWDFAZSzKPhqnLhDOsOe2Se_iWOHRv1Di0ZlqxEiJRIdlPGyguLyDnbVPOFx6T91GNCFeu2t8lIKCGApAhmzRqD6rE-hUC4l-xUdUJfgnrcbRH_kJUt7E";
    const P256_SEC1_PEM: &str = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIECJqiZqnUm6sjnJwDfiH8JnM64p/am308cfvDKOwLhmoAoGCCqGSM49\nAwEHoUQDQgAEBt4INR6RNp/leXOqzXejdQYDtCVaLQHRutjMwZ9ozQ8sOaV6VUPv\n9DbSFLRUutDhJEPizOizS67JOFMZ2DHd6A==\n-----END EC PRIVATE KEY-----\n";

    /// A Bitwarden export with one passkey on `rp`, its credential id `b64.<id>`.
    fn bitwarden(rp: &str, id_b64url: &str, key: &str) -> String {
        json!({ "encrypted": false, "items": [{ "type": 1, "name": "Demo", "login": {
            "uris": [{ "uri": format!("https://{rp}/") }], "username": "me@demo.example", "password": null, "totp": null,
            "fido2Credentials": [{ "credentialId": format!("b64.{id_b64url}"), "keyType": "public-key", "keyAlgorithm": "ECDSA",
                "keyCurve": "P-256", "keyValue": key, "rpId": rp, "userHandle": "dXNlci0x", "userName": "me@demo.example",
                "counter": "7", "rpName": "Demo", "userDisplayName": "Me", "discoverable": "true", "creationDate": "2026-01-01T00:00:00Z" }] } }] })
        .to_string()
    }

    /// Each manager that exports passkeys writes them its own way; each reads into the credential the browser's
    /// authenticator takes: the id and user handle as bytes, the PKCS#8 key, the counter, the site. A key on a curve
    /// the authenticator can't sign with is counted, never kept, and a file with no passkey reads as none.
    #[test]
    fn a_passkey_export_is_read_whoever_wrote_it() {
        let std_of = |b64url: &str| STD.encode(&*b64(b64url).unwrap());
        let (found, skipped) = read_export(&bitwarden("shop.example", "AQIDBA", P256_PKCS8));
        assert!(skipped.is_empty());
        let s = &found[0];
        assert_eq!((s.credential_id.as_str(), s.rp_id.as_str(), s.user_handle.as_str(), s.user_name.as_str()), ("AQIDBA==", "shop.example", "dXNlci0x", "me@demo.example"));
        assert_eq!((s.private_key.clone(), s.sign_count, s.resident), (std_of(P256_PKCS8), 7, true));

        // Bitwarden's own passkeys have a UUID for an id: its 16 bytes.
        let uuid = bitwarden("shop.example", "x", P256_PKCS8).replace("b64.x", "0f8fad5b-d9cb-469f-a165-70867728950e");
        assert_eq!(read_export(&uuid).0[0].credential_id, STD.encode(hex::decode("0f8fad5bd9cb469fa16570867728950e").unwrap()));

        let cxf = json!({ "version": { "major": 1, "minor": 0 }, "exporterRpId": "manager.example", "accounts": [{ "id": "a", "items": [{ "id": "i", "title": "Shop",
            "credentials": [{ "type": "passkey", "credentialId": "AQIDBA", "rpId": "shop.example", "username": "me", "userDisplayName": "Me", "userHandle": "dXNlci0x", "key": P256_PKCS8 }] }] }] });
        let (found, _) = read_export(&cxf.to_string());
        assert_eq!((found[0].credential_id.as_str(), found[0].private_key.clone(), found[0].user_name.as_str()), ("AQIDBA==", std_of(P256_PKCS8), "me"));

        let pkcs8_pem = format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n", STD.encode(&*b64(P256_PKCS8).unwrap()));
        for key in [pkcs8_pem.as_str(), P256_SEC1_PEM] {
            let keepassxc = json!({ "credentialId": "AQIDBA", "privateKey": key, "relyingParty": "shop.example", "url": "https://shop.example", "userHandle": "dXNlci0x", "username": "me" });
            let (found, skipped) = read_export(&keepassxc.to_string());
            assert!(skipped.is_empty(), "{skipped:?}");
            let der = STD.decode(&found[0].private_key).unwrap();
            assert!(p256(&der), "a P-256 PKCS#8 key");
        }

        let (found, skipped) = read_export(&bitwarden("shop.example", "AQIDBA", P384_PKCS8).replace("P-256", "P-384"));
        assert!(found.is_empty());
        assert_eq!(skipped, [(UNSUPPORTED.to_string(), 1)]);
        let (found, skipped) = read_export(&bitwarden("shop.example", "AQIDBA", P384_PKCS8));
        assert!(found.is_empty() && skipped.len() == 1, "a P-384 key labelled P-256 is still refused");
        assert_eq!(read_export(r#"{"items":[{"login":{"username":"me","password":"pw"}}]}"#).0.len(), 0);
        assert_eq!(count_in("url,username,password\nhttps://a.example,me,pw\n"), 0);
    }

    /// An imported passkey is sealed like an enrolled one, with nothing secret on disk, and importing it again keeps
    /// the vault's copy (and its counter).
    #[test]
    fn an_imported_passkey_is_sealed_and_kept_once() {
        let (dir, keys) = (temp("import"), root());
        let sealer = sealer(&keys).unwrap();
        let text = bitwarden("shop.example", "AQIDBAUG", P256_PKCS8);
        let done = import_in(&dir, &sealer, &text, "You").unwrap();
        assert_eq!(done.added.len(), 1);
        assert_eq!((done.added[0].site.as_str(), done.added[0].account.as_str()), ("shop.example", "me@demo.example"));
        let disk = std::fs::read_to_string(file(&dir)).unwrap();
        let key = STD.encode(&*b64(P256_PKCS8).unwrap());
        assert!(!disk.contains(&key[..40]) && !disk.contains("AQIDBAUG") && !disk.contains(P256_PKCS8), "{disk}");
        let opened = secrets_for(&dir, &sealer, "shop.example");
        assert_eq!(opened[0].1.private_key, key);
        set_count(&dir, &sealer, &done.added[0].id, 12, None).unwrap();
        let again = import_in(&dir, &sealer, &text, "You").unwrap();
        assert_eq!((again.added.len(), again.known), (0, 1));
        assert_eq!(secrets_for(&dir, &sealer, "shop.example")[0].1.sign_count, 12, "the vault's counter is kept");
        let log = std::fs::read_to_string(dir.join("activity.jsonl")).unwrap();
        assert!(log.contains("Imported a passkey") && !log.contains("AQIDBAUG") && !log.contains("me@demo.example"), "{log}");
        assert_eq!(done.added[0].how, How::Manual, "an import is the owner's own");
        assert!(import_in(&dir, &sealer, "{\"items\":[]}", "You").unwrap_err().contains("never let one out"));
        let locked = text.replacen("\"encrypted\":false", "\"encrypted\":true", 1);
        assert!(import_in(&dir, &sealer, &locked, "You").unwrap_err().contains("encrypted"), "an encrypted export is refused, not misread");
        // A site the owner said never to takes no passkey, imported or not.
        set_never_in(&dir, "shop.example", true).unwrap();
        let other = import_in(&dir, &sealer, &bitwarden("shop.example", "CQgHBgUE", P256_PKCS8), "You").unwrap();
        assert!(other.added.is_empty() && other.skipped[0].0.contains("said never"), "{other:?}");
        assert_eq!(list_in(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End to end: a site registered a passkey somewhere else (its public key is on the site's server); the owner
    /// imports the password manager's export of it, and a browser with an empty profile signs in with it from the
    /// vault alone. The site checks the signature against the key it registered.
    #[test]
    fn an_imported_passkey_signs_in_from_the_vault() {
        let (dir, keys) = (temp("import-e2e"), root());
        let port = serve_demo();
        let page = format!("http://localhost:{port}/");
        let id = "q83vASNFZ4mrze8BI0VniQ";
        {
            use std::io::{Read, Write};
            let body = json!({ "id": id, "key": STD.encode(&*b64(P256_SPKI).unwrap()) }).to_string();
            let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(c, "POST /register HTTP/1.1\r\nhost: localhost\r\ncontent-length: {}\r\n\r\n{body}", body.len()).unwrap();
            let mut answer = String::new();
            let _ = c.read_to_string(&mut answer);
            assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        }
        let done = import_in(&dir, &sealer(&keys).unwrap(), &bitwarden("localhost", id, P256_PKCS8), "You").unwrap();
        assert_eq!(done.added.len(), 1);

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let browser = Chrome::launch("import-e2e");
        assert!(run_on_page(&rt, &browser.ws, &page, "signin(1)").is_err(), "no authenticator, no sign-in");
        assert_eq!(hold("localhost", &Browser::At(browser.ws.clone()), &keys, dir.clone()).unwrap(), 1);
        let answer: Value = serde_json::from_str(&run_on_page(&rt, &browser.ws, &page, "signin()").expect("the site signs in")).unwrap();
        assert_eq!(answer["id"], json!(id), "the imported passkey");
        assert_eq!(answer["ok"], json!(true), "the site verified the signature: {answer}");
        assert!(answer["count"].as_u64().unwrap() > 7, "the counter carries on from the export's: {answer}");
        drop(browser);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// On by default: the node signs in to a site, the site offers a passkey after the sign-in, and the vault keeps it,
    /// marked as enrolled automatically, with one audit line that holds no secret. The same passkey then signs in.
    #[test]
    fn a_sign_in_keeps_the_passkey_the_site_offers() {
        let (dir, keys) = (temp("auto-vault"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("auto");
        let browser = Browser::At(chrome.ws.clone());

        // A site the node never signed in to: what it makes is nobody's, and nothing is kept.
        assert!(run_on_page(&rt, &chrome.ws, &page, "login(1)").is_err(), "no sign-in, no authenticator");

        let armed = after_sign_in("localhost", &browser, &keys, dir.clone()).expect("on by default, no setting written");
        assert!(armed.until > now_ms());
        let registered = run_on_page(&rt, &chrome.ws, &page, "login()").expect("the site's offer is taken");
        wait_for("the vault keeping the passkey", || list_in(&dir).len() == 1);
        let kept = View::from(&list_in(&dir)[0]);
        assert_eq!((kept.site.as_str(), kept.account.as_str(), kept.how), ("localhost", "me@demo.example", How::Auto));
        let disk = std::fs::read_to_string(file(&dir)).unwrap();
        assert!(!disk.contains(&registered), "the credential id is sealed");
        // The audit line goes down after the vault holds the passkey: a loaded runner reads between the two.
        wait_for("the audit line", || std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default().contains("Enrolled a passkey the site offered after signing in"));
        let log = std::fs::read_to_string(dir.join("activity.jsonl")).unwrap();
        let line = log.lines().find(|l| l.contains("Enrolled a passkey the site offered after signing in")).expect("an audit line");
        let line: Value = serde_json::from_str(line).unwrap();
        assert_eq!(line["site"], json!("localhost"));
        assert!(line["at"].as_u64().is_some());
        assert!(!log.contains(&registered) && !log.contains("me@demo.example"), "the log holds no credential and no account: {log}");

        // And the kept passkey signs in.
        let answer: Value = serde_json::from_str(&run_on_page(&rt, &chrome.ws, &page, "signin()").expect("the site signs in")).unwrap();
        assert_eq!((answer["id"].clone(), answer["ok"].clone()), (json!(registered), json!(true)), "{answer}");

        // Enrolled once: a second offer, with no new sign-in, is refused.
        run_on_page(&rt, &chrome.ws, &page, "register()").expect("the site makes a passkey on the authenticator");
        wait_for("the refusal", || std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default().contains("Refused a passkey"));
        assert_eq!(list_in(&dir).len(), 1);
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An agent's sign-in — a vault login it filled — arms nothing: a passkey signs in as the owner with no password
    /// and no second factor, so one an agent could make would be a credential stronger than its own key, and every
    /// key on the node as strong as the weakest of them. Only the owner's own act arms an enrolment.
    #[test]
    fn an_agents_sign_in_arms_no_enrolment() {
        let keys = root();
        let dir = temp("agent-vault");
        store::write_json(&dir.join("settings.json"), &unbrowse_files::SETTINGS, &store::Settings::default()).unwrap();
        assert!(allowed_in(&dir, "localhost").is_ok(), "passkeys are on, and nothing says never to the site");
        // Nothing armed, and nothing written: an agent's fill arms no enrolment at all.
        assert!(signed_in(SignIn::Agent, "localhost", &keys).is_none(), "an agent's fill arms nothing");
        assert!(list_in(&dir).is_empty());
        // The owner's own act is what arms one (`after_sign_in`, and `passkey enrol` for a site already signed in to).
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Off, globally or for the site, a sign-in enrols nothing: no authenticator is armed, and one already armed is
    /// taken off the pages the moment the owner says off, before the site can make anything on it.
    #[test]
    fn a_sign_in_enrols_nothing_when_the_owner_said_off_or_never() {
        let keys = root();
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("opt-out");
        let browser = Browser::At(chrome.ws.clone());
        let off = || store::Settings { passkeys: false, ..Default::default() };

        // Off for every site.
        let dir = temp("off-vault");
        store::write_json(&dir.join("settings.json"), &unbrowse_files::SETTINGS, &off()).unwrap();
        assert_eq!(after_sign_in("localhost", &browser, &keys, dir.clone()).unwrap_err(), OFF);
        assert!(enrol_in("localhost", &browser, 5, &keys, dir.clone()).is_err(), "nor by hand");
        assert!(run_on_page(&rt, &chrome.ws, &page, "login(1)").is_err(), "nothing answered the site's offer");
        assert!(list_in(&dir).is_empty());

        // Never for this site.
        let dir = temp("never-vault");
        set_never_in(&dir, "localhost", true).unwrap();
        assert!(after_sign_in("localhost", &browser, &keys, dir.clone()).unwrap_err().contains("never"));
        assert!(enrol_in("localhost", &browser, 5, &keys, dir.clone()).unwrap_err().contains("never"), "nor by hand");
        assert!(run_on_page(&rt, &chrome.ws, &page, "login(1)").is_err());
        assert!(list_in(&dir).is_empty());

        // Armed by a sign-in, then the owner says never: the authenticator leaves before the site makes one.
        let dir = temp("late-vault");
        let g = {
            after_sign_in("localhost", &browser, &keys, dir.clone()).unwrap();
            guard_of("localhost", &chrome.ws).unwrap()
        };
        set_never_in(&dir, "localhost", true).unwrap();
        wait_for("the watch ending", || !g.alive.load(Ordering::SeqCst));
        assert!(run_on_page(&rt, &chrome.ws, &page, "login(1)").is_err());
        assert!(list_in(&dir).is_empty());
        drop(chrome);
    }

    /// A sign-in with a kept passkey writes the browser's new signature counter back into the vault, sealed, with when
    /// it was used; a counter that isn't higher (a replayed or stale report) leaves the saved one as it was.
    #[test]
    fn a_sign_in_saves_the_new_sign_count_and_never_lowers_it() {
        let (dir, keys) = (temp("sign-count"), root());
        let sealer = sealer(&keys).unwrap();
        let kept = keep(&dir, &sealer, &Secret::from_cdp(&credential()).unwrap(), How::Manual).unwrap();
        let held = || {
            let (p, s) = secrets_for(&dir, &sealer, "example.com").remove(0);
            (s.sign_count, p.used)
        };
        assert_eq!(held(), (3, None), "kept at the counter the site gave it, never used");
        set_count(&dir, &sealer, &kept.id, 7, Some(1_700_000_000)).unwrap();
        assert_eq!(held(), (7, Some(1_700_000_000)), "the new counter and when it was used");
        set_count(&dir, &sealer, &kept.id, 5, Some(1_700_000_500)).unwrap();
        assert_eq!(held(), (7, Some(1_700_000_500)), "a lower counter is not saved; the use still is");
        set_count(&dir, &sealer, &kept.id, 9, None).unwrap();
        assert_eq!(held(), (9, Some(1_700_000_500)), "no new time leaves the last one");
        assert_eq!(set_count(&dir, &sealer, "000000000000", 12, None).unwrap_err(), "no such passkey");
        let disk = std::fs::read_to_string(file(&dir)).unwrap();
        assert!(!disk.contains("signCount") && !disk.contains("sign_count"), "the counter is sealed with the rest");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The owner's deny list (`passkey never <site>`) and the off switch are checked before any browser is touched: no
    /// way of starting a watch, by hand or after a sign-in, gets as far as the browser, and nothing is left running.
    #[test]
    fn a_site_on_the_deny_list_is_refused_before_any_browser_is_reached() {
        let (dir, keys) = (temp("deny"), root());
        let sealer = sealer(&keys).unwrap();
        keep(&dir, &sealer, &Secret::from_cdp(&credential()).unwrap(), How::Manual).unwrap();
        // A browser nothing listens at: reaching it would say so, not that the owner said never.
        let nowhere = Browser::At("ws://127.0.0.1:9/devtools/browser/none".into());
        set_never_in(&dir, "example.com", true).unwrap();
        for site in ["example.com", "https://login.example.com/signin"] {
            assert!(hold(site, &nowhere, &keys, dir.clone()).unwrap_err().contains("the owner said never"), "{site}: use");
            assert!(enrol_in(site, &nowhere, 5, &keys, dir.clone()).unwrap_err().contains("the owner said never"), "{site}: enrol");
            assert!(after_sign_in(site, &nowhere, &keys, dir.clone()).unwrap_err().contains("the owner said never"), "{site}: after a sign-in");
        }
        assert!(guard_of("example.com", &nowhere.name()).is_none(), "no watch was started");
        let off = store::Settings { passkeys: false, ..Default::default() };
        store::write_json(&dir.join("settings.json"), &unbrowse_files::SETTINGS, &off).unwrap();
        assert_eq!(hold("example.com", &nowhere, &keys, dir.clone()).unwrap_err(), OFF);
        assert_eq!(enrol_in("other.example", &nowhere, 5, &keys, dir.clone()).unwrap_err(), OFF);
        assert!(guard_of("other.example", &nowhere.name()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A browser the owner names with `--cdp` is given a passkey only when it runs on this machine: one on another
    /// address is refused, with no watch left behind and the vault as it was.
    #[test]
    fn a_cdp_browser_on_another_machine_is_given_no_passkey() {
        let (dir, keys) = (temp("far-cdp"), root());
        let sealer = sealer(&keys).unwrap();
        keep(&dir, &sealer, &Secret::from_cdp(&credential()).unwrap(), How::Manual).unwrap();
        for far in ["ws://10.0.0.5:9222/devtools/browser/x", "http://browser.example:9222"] {
            let browser = Browser::At(far.into());
            assert!(hold("example.com", &browser, &keys, dir.clone()).unwrap_err().contains("another machine"), "{far}: use");
            assert!(enrol_in("example.com", &browser, 5, &keys, dir.clone()).unwrap_err().contains("another machine"), "{far}: enrol");
            assert!(guard_of("example.com", far).is_none(), "{far}: no watch left");
        }
        assert_eq!(list_in(&dir).len(), 1, "the vault is as it was");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A passkey sign-in on a page where the node holds no passkey is refused at once, and what is said plainly names
    /// ask_owner, the way to have the owner sign in themselves.
    #[test]
    fn a_passkey_challenge_with_no_passkey_held_says_so_and_points_to_ask_owner() {
        let (dir, keys) = (temp("no-passkey-said"), root());
        let page = format!("http://localhost:{}/", serve_demo());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chrome = Chrome::launch("no-passkey-said");
        enrol_in("localhost", &Browser::At(chrome.ws.clone()), 5, &keys, dir.clone()).unwrap();
        let probe = "(async () => { for (let i = 0; i < 150 && !navigator.credentials.__unbrowse; i++) await new Promise(r => setTimeout(r, 100)); \
            try { await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: 'localhost', userVerification: 'required' } }); return 'answered'; } \
            catch (e) { return e.name; } })()";
        assert_eq!(run_on_page(&rt, &chrome.ws, &page, probe).expect("the page runs"), "NotAllowedError");
        wait_for("the refusal said", || std::fs::read_to_string(dir.join("activity.jsonl")).unwrap_or_default().contains("Passkey get request"));
        let log = std::fs::read_to_string(dir.join("activity.jsonl")).unwrap();
        assert!(log.contains("the node holds no passkey here"), "{log}");
        assert!(log.contains("ask_owner"), "it points to ask_owner: {log}");
        drop(chrome);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Arming an enrolment says what the owner does next, for as long as the site stays armed (never past the most),
    /// and a longer wait already armed, or one the owner asked for by hand, is not cut short or taken over by a later
    /// sign-in's shorter automatic one.
    #[test]
    fn an_enrolment_armed_again_keeps_the_longer_wait_and_the_owners_own() {
        let guard = || Guard { site: "shop.example".into(), at: "node".into(), armed: Mutex::new(None), alive: AtomicBool::new(true), up: AtomicBool::new(true), bare: false };
        let g = guard();
        let manual = arm(&g, "shop.example", 20, How::Manual);
        assert!(manual.how.contains("add a passkey") && manual.site == "shop.example");
        let soon = arm(&g, "shop.example", 10, How::Auto);
        assert!(soon.until >= manual.until, "the shorter automatic wait leaves the longer one");
        assert!(soon.how.contains("add a passkey"), "and the enrolment stays the owner's own: {}", soon.how);
        assert_eq!(g.armed.locked().map(|(_, how)| how), Some(How::Manual));

        let g = guard();
        let auto = arm(&g, "shop.example", 10, How::Auto);
        assert!(auto.how.contains("in the next 10 minutes is kept") && !auto.how.contains("waits on your yes"));
        let phone = arm(&g, "shop.example", 99, How::Phone);
        assert!(phone.how.contains("waits on your yes"), "{}", phone.how);
        assert!(phone.until >= now_ms() + (MOST_ARMED_MINUTES - 1) * 60_000 && phone.until <= now_ms() + MOST_ARMED_MINUTES * 60_000, "cut to the most a site stays armed");
        assert_eq!(enrol_wait_secs(99_999), MOST_ARMED_MINUTES * 60);
        assert_eq!(enrol_wait_secs(90), 90);
    }

    /// Removing a passkey tells the owner the site still lists it, names it in the activity log without the credential,
    /// and says plainly when no passkey has that id.
    #[test]
    fn a_removed_passkey_is_said_to_still_be_listed_on_its_site() {
        let home = store::scratch_home("passkey-remove");
        let keys = root();
        let sealer = sealer(&keys).unwrap();
        let kept = keep(&home, &sealer, &Secret::from_cdp(&credential()).unwrap(), How::Manual).unwrap();
        assert!(remove(" 000000000000", "You").unwrap_err().contains("no such passkey"));
        let said = remove(&format!(" {} ", kept.id), "You").unwrap();
        assert!(said.contains("The site still lists it") && said.contains("example.com") && said.contains("me@example.com"), "{said}");
        assert!(list_in(&home).is_empty());
        let log = std::fs::read_to_string(home.join("activity.jsonl")).unwrap();
        assert!(log.contains("Removed a stored passkey") && !log.contains("credential-id"), "{log}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The first start with passkeys on leaves a mark that the owner was told, and a start after that leaves it be.
    #[test]
    fn the_notice_that_passkeys_are_on_is_marked_once() {
        let home = store::scratch_home("passkey-notice");
        let mark = home.join("passkeys.notice");
        announce();
        let first = std::fs::read_to_string(&mark).expect("the first start marks the notice");
        assert!(first.trim().parse::<u64>().is_ok(), "{first}");
        std::fs::write(&mark, "told\n").unwrap();
        announce();
        assert_eq!(std::fs::read_to_string(&mark).unwrap(), "told\n", "already told: left as it was");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The credential crosses DevTools in the clear, so only a browser on this machine is ever given one.
    #[test]
    fn a_passkey_goes_only_to_a_browser_on_this_machine() {
        assert!(local("127.0.0.1") && local("localhost") && local("[::1]") && local("127.0.0.9"));
        assert!(!local("10.0.0.5") && !local("browser.example") && !local(""));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for far in ["ws://10.0.0.5:9222/devtools/browser/x", "http://browser.example:9222", "192.168.1.2:9333"] {
            assert!(rt.block_on(devtools(far)).unwrap_err().contains("another machine"), "{far}");
        }
        assert_eq!(rt.block_on(devtools("ws://127.0.0.1:9333/devtools/browser/x")).unwrap(), "ws://127.0.0.1:9333/devtools/browser/x");
    }

    /// A passkey goes to its own site and its subdomains, never a lookalike.
    #[test]
    fn a_passkey_fits_only_its_own_site() {
        assert!(fits("google.com", "accounts.google.com") && fits("accounts.google.com", "google.com"));
        assert!(!fits("google.com", "google.com.evil.example") && !fits("example.com", "example.org"));
        assert_eq!(site_arg("https://accounts.google.com/signin").unwrap(), "google.com");
        assert_eq!(site_arg("www.github.com").unwrap(), "github.com");
        assert_eq!(site_arg("localhost:8080").unwrap(), "localhost");
        assert!(site_arg("intranet").is_err());
    }
}

#[cfg(test)]
#[path = "passkey_cov_tests.rs"]
mod passkey_cov_tests;
