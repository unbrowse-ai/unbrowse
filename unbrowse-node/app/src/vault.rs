//! The vault (PRD US-011, US-012, FR-14, FR-18c): logins kept on this machine. A stored password is sealed under the
//! vault key (below); a derived one is computed from the vault key, the site, the account and a counter and never stored. `vault.json`
//! is the index (site, account, kind, counter) and holds no secret. Agents only ever get a reference.
//!
//! A reference is `vault:<site>:<account>`. An agent fills one into a page through the node's browser
//! (`fill @e3 vault:github.com:me`), and the node types the password itself, only into a page of the login's own
//! site; the walk record says the reference, never the password. A route learned from that typing keeps the
//! reference as its secret input, so every later call signs in again from the vault. `vault:new:<site>:<account>`
//! makes a login on the spot with a derived password, for signing up.
//!
//! A login can keep the key for its site's one-time codes too (two-step sign-in). `vault:code:<site>:<account>` names
//! the code: the node makes it from the key when it types it, so an agent gets past both steps holding neither the
//! key nor a code. A code an agent could read is one it could be talked into handing over.
//!
//! Secrets are sealed under the vault key the root key derives ([`Keep`], `vault.unlock-once`): the system's keystore
//! holds the root key alone, read once a run, so the vault opens with it and never asks the owner again for a secret.
//! A node whose root key is in a file (a dev build, or a Linux machine with no desktop session) seals them in
//! `vault.sealed.json`; one whose root key is in the system's keystore, in `vault.sealed.keychain.json`, since a dev
//! build and a release build share this folder but not a root key. The vault never reads a keystore item: a secret an
//! older build kept as a keystore item of its own isn't read, and its login is imported again to be used.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use unbrowse_core::{KeyStore, RootKey, Sealer};

use crate::sync::Locked;
use crate::store::{self, Activity};
use zeroize::Zeroizing;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Login {
    pub site: String,
    pub account: String,
    /// "derived" or "stored" (website passkeys arrive with the browser's WebAuthn hook).
    pub kind: String,
    #[serde(default)]
    pub counter: u32,
    pub created: u64,
    /// Whether the Keychain holds a one-time code key for this login.
    #[serde(default)]
    pub code: bool,
    /// How a derived password is made: 0 from the site and counter (logins made before 1), 1 from the site, the
    /// account and the counter (`RootKey::account_password`). A login keeps the one it was made with, so its password
    /// never changes under it.
    #[serde(default)]
    pub derivation: u8,
}

/// How every derived login made from now on is derived: with its account (`Login::derivation`).
const DERIVATION: u8 = 1;

/// The derived password for `account` on `site` at `counter`, made as `derivation` says.
fn derived(root: &RootKey, site: &str, account: &str, counter: u32, derivation: u8) -> zeroize::Zeroizing<String> {
    match derivation {
        0 => root.password(site, counter, 20),
        _ => root.account_password(site, account, counter, 20),
    }
}

fn path() -> std::path::PathBuf {
    store::home().join("vault.json")
}

pub fn list() -> Vec<Login> {
    store::read_json(&path(), &unbrowse_files::VAULT)
}

/// Which secret: a login's password, the key its one-time codes are made from, or a payment card.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Slot {
    Password,
    Code,
    Card,
}

impl Slot {
    fn label(self) -> &'static str {
        match self {
            Slot::Password => "password",
            Slot::Code => "code",
            Slot::Card => "card",
        }
    }
}

/// Where the vault keeps a login's secrets: sealed under the vault key the root key derives, each bound to its login,
/// so the file holds no secret in the clear and a record moved onto another login doesn't open (`vault.unlock-once`).
/// Nothing here reads or writes the system's keystore: the root key, read once a run, is all the vault needs.
pub struct Keep {
    sealer: Sealer,
    file: PathBuf,
}

impl Keep {
    /// Secrets sealed under the root key in `dir`, for a node that keeps its root key in a file.
    pub fn sealed(keys: &dyn KeyStore, dir: &Path) -> Result<Keep, String> {
        Self::sealed_in(keys, sealed_file(dir, false))
    }

    /// Secrets sealed under the root key in `dir`, for a node that keeps its root key in the system's keystore.
    pub fn sealed_beside_keystore(keys: &dyn KeyStore, dir: &Path) -> Result<Keep, String> {
        Self::sealed_in(keys, sealed_file(dir, true))
    }

    fn sealed_in(keys: &dyn KeyStore, file: PathBuf) -> Result<Keep, String> {
        let root = RootKey::load(keys).map_err(|e| format!("the vault seals its secrets under this node's key, and it doesn't read ({e}): start the node once first"))?;
        Ok(Keep { sealer: Sealer::from_root(&root, "vault"), file })
    }

    /// Whether secrets are sealed in a file: always, since `vault.unlock-once`; what the shell says of where a secret
    /// went.
    pub fn is_sealed(&self) -> bool {
        true
    }

    fn put(&self, slot: Slot, site: &str, account: &str, secret: &str) -> Result<(), String> {
        let name = sealed_name(slot, site, account);
        let sealed = self.sealer.seal(sealed_about(&name).as_bytes(), secret.as_bytes()).map_err(|e| e.to_string())?;
        let _held = store::hold_file(&self.file)?;
        let mut all: BTreeMap<String, String> = store::read_json(&self.file, &unbrowse_files::VAULT_SEALED);
        all.insert(name, base64::engine::general_purpose::STANDARD.encode(sealed));
        store::write_json(&self.file, &unbrowse_files::VAULT_SEALED, &all)
    }

    /// The secret as the vault holds it: wiped from memory when dropped (as every secret `get`, `secret_for` and
    /// `reveal` hand out is), so a copy is plain only where it is about to leave the node.
    fn get(&self, slot: Slot, site: &str, account: &str) -> Result<Zeroizing<String>, String> {
        self.find(slot, site, account)?
            .ok_or_else(|| format!("the vault holds no {} for {account} on {site}: one an older build kept in the system's keystore isn't read, so import the login again", slot.label()))
    }

    /// The secret, `None` when there is none: what `get` can't say, which is the difference between nothing kept and
    /// something kept that didn't read.
    fn find(&self, slot: Slot, site: &str, account: &str) -> Result<Option<Zeroizing<String>>, String> {
        let name = sealed_name(slot, site, account);
        let Some(b64) = store::read_json::<BTreeMap<String, String>>(&self.file, &unbrowse_files::VAULT_SEALED).get(&name).cloned() else {
            return Ok(None);
        };
        let damaged = || format!("the vault's {} for {account} on {site} is damaged", slot.label());
        let sealed = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| damaged())?;
        let plain = self.sealer.open(sealed_about(&name).as_bytes(), &sealed).map_err(|_| damaged())?;
        String::from_utf8(plain.to_vec()).map(|p| Some(Zeroizing::new(p))).map_err(|_| damaged())
    }

    fn delete(&self, slot: Slot, site: &str, account: &str) {
        // Rewritten only under its lock: the file holds every login's secret, and a rewrite without it could drop one
        // another process sealed meanwhile. Without the lock the secret is left: the index no longer names the login,
        // so it opens nothing, and it is written over if the login comes back.
        if let Ok(_held) = store::hold_file(&self.file) {
            let mut all: BTreeMap<String, String> = store::read_json(&self.file, &unbrowse_files::VAULT_SEALED);
            if all.remove(&sealed_name(slot, site, account)).is_some() {
                let _ = store::write_json(&self.file, &unbrowse_files::VAULT_SEALED, &all);
            }
        }
    }
}

/// The file a node seals its secrets into: one per place its root key is kept, since a dev build (its root key in a
/// file) and a release build (in the system's keystore) share this folder but not a root key.
fn sealed_file(dir: &Path, root_in_keystore: bool) -> PathBuf {
    dir.join(if root_in_keystore { "vault.sealed.keychain.json" } else { "vault.sealed.json" })
}

/// How many secrets are sealed under this node's root key in this home.
pub fn sealed_count(root_in_keystore: bool) -> usize {
    store::read_json::<BTreeMap<String, String>>(&sealed_file(&store::home(), root_in_keystore), &unbrowse_files::VAULT_SEALED).len()
}


/// A sealed secret's name in `vault.sealed.json`: which secret, of which login.
fn sealed_name(slot: Slot, site: &str, account: &str) -> String {
    format!("{}|{site}|{account}", slot.label())
}

/// What a sealed secret is bound to, so it opens only as the secret of the login it was sealed for.
fn sealed_about(name: &str) -> String {
    format!("unbrowse/vault/v1|{name}")
}

fn clean_site(site: &str) -> Result<String, String> {
    let s = site.trim().trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or_default().to_ascii_lowercase();
    if s.is_empty() || !s.contains('.') {
        return Err("enter the site's address, like github.com".into());
    }
    Ok(s)
}

/// The counter `site`'s next derived password takes: one past any its derived logins have reached. A login made since
/// the account went into the derivation (`DERIVATION`) is its account's own whatever its counter; one made before is
/// derived from the site and counter alone, so it is told apart from the site's other logins here, by never sharing a
/// counter with them.
fn next_counter(all: &[Login], site: &str) -> u32 {
    all.iter().filter(|l| l.site == site && l.kind == "derived").map(|l| l.counter + 1).max().unwrap_or(0)
}

pub fn add(keep: &Keep, site: &str, account: &str, kind: &str, password: Option<&str>, who: &str) -> Result<Login, String> {
    let site = clean_site(site)?;
    let account = account.trim().to_string();
    if account.is_empty() {
        return Err("enter the account name".into());
    }
    let _held = store::hold_file(&path())?;
    let mut all = list();
    if all.iter().any(|l| l.site == site && l.account == account) {
        return Err(format!("{account} on {site} is already in the vault"));
    }
    match kind {
        "stored" => {
            let pw = password.filter(|p| !p.is_empty()).ok_or("enter the password to store")?;
            keep.put(Slot::Password, &site, &account, pw)?;
        }
        "derived" => {}
        _ => return Err("a login is derived or stored".into()),
    }
    let counter = if kind == "derived" { next_counter(&all, &site) } else { 0 };
    let login = Login { site: site.clone(), account, kind: kind.to_string(), counter, created: store::now(), code: false, derivation: DERIVATION };
    all.push(login.clone());
    store::write_json(&path(), &unbrowse_files::VAULT, &all)?;
    store::log_activity(&Activity {
        at: store::now(),
        who: who.into(),
        site,
        what: format!("Added a {} login", if kind == "derived" { "derived-password" } else { "stored-password" }),
        kind: "vault".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    Ok(login)
}

pub fn remove(keep: &Keep, site: &str, account: &str) -> Result<(), String> {
    let _held = store::hold_file(&path())?;
    let mut all = list();
    let before = all.len();
    all.retain(|l| !(l.site == site && l.account == account));
    if all.len() == before {
        return Err("no such login".into());
    }
    // The index first: a write that fails leaves the login listed and whole, and a secret left over opens nothing.
    store::write_json(&path(), &unbrowse_files::VAULT, &all)?;
    keep.delete(Slot::Password, site, account);
    keep.delete(Slot::Code, site, account);
    Ok(())
}

/// Keeps the one-time code key for a login: the `otpauth://` address or the secret the site showed when two-step
/// sign-in was turned on. Read before it is kept, so a key that makes no codes is refused here, not at sign-in.
pub fn set_code(keep: &Keep, site: &str, account: &str, key: &str, who: &str) -> Result<Login, String> {
    unbrowse_core::CodeKey::parse(key).ok_or("that isn't a one-time code key: paste the otpauth:// address or the secret the site showed")?;
    let _held = store::hold_file(&path())?;
    let mut all = list();
    let l = all.iter_mut().find(|l| l.site == site && l.account == account).ok_or("no such login")?;
    keep.put(Slot::Code, site, account, key.trim())?;
    l.code = true;
    let out = l.clone();
    store::write_json(&path(), &unbrowse_files::VAULT, &all)?;
    store::log_activity(&Activity {
        at: store::now(),
        who: who.into(),
        site: site.to_string(),
        what: "Kept a one-time code key".into(),
        kind: "vault".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    Ok(out)
}

/// The password, for the owner who asked to see it. Never sent to an agent.
pub fn reveal(keep: &Keep, keys: &dyn KeyStore, site: &str, account: &str) -> Result<Zeroizing<String>, String> {
    let l = list().into_iter().find(|l| l.site == site && l.account == account).ok_or("no such login")?;
    if l.kind == "derived" {
        let root = RootKey::load(keys).map_err(|e| e.to_string())?;
        return Ok(derived(&root, &l.site, &l.account, l.counter, l.derivation));
    }
    keep.get(Slot::Password, site, account)
}

/// Rotates a derived password: the counter goes up, so the next one is new and the old one is gone.
pub fn rotate(site: &str, account: &str) -> Result<Login, String> {
    let _held = store::hold_file(&path())?;
    let mut all = list();
    let next = next_counter(&all, site);
    let l = all.iter_mut().find(|l| l.site == site && l.account == account).ok_or("no such login")?;
    if l.kind != "derived" {
        return Err("only derived passwords rotate here".into());
    }
    l.counter = next;
    let out = l.clone();
    store::write_json(&path(), &unbrowse_files::VAULT, &all)?;
    Ok(out)
}

// ---- limits on card payments ----

/// A limit the owner saved for a card on one site (spec §103). It authorises nothing: the node can't bind an amount and a
/// currency to what a page or a route charges, so every card fill and every card route call asks the owner whatever the
/// limit says (`api/browse.rs` `approve_checkout`, `api/call.rs` `approve_route_payment`). The amounts are in whatever
/// currency the site charges.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CardLimit {
    pub card: String,
    pub site: String,
    pub per_payment: f64,
    pub per_day: f64,
    /// The day (`store::now()` over a day) `spent` is for.
    #[serde(default)]
    pub day: u64,
    #[serde(default)]
    pub spent: f64,
}

/// The account limits are kept under, beside the cards: no card's label reads this way (`clean_label`). They are kept as
/// a card is, so a program that can write this user's files can't raise one.
const LIMITS: &str = "~limits";

/// Held while limits are read and written back, so two payments at once can't both take the day's last room.
static LIMITS_HELD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The limits as kept, none when none are, or why they didn't read.
fn kept_limits(keep: &Keep) -> Result<Vec<CardLimit>, String> {
    match keep.find(Slot::Card, CARDS, LIMITS)? {
        Some(s) => serde_json::from_str(&s).map_err(|_| "the card limits kept don't read".into()),
        None => Ok(Vec::new()),
    }
}

/// The limits as kept. One that can't be read counts as none, so the owner is asked: this fails closed. Only for asking:
/// anything that writes them back reads `kept_limits`, or it would write away every other limit.
fn read_limits(keep: &Keep) -> Vec<CardLimit> {
    kept_limits(keep).unwrap_or_default()
}

fn write_limits(keep: &Keep, all: &[CardLimit]) -> Result<(), String> {
    keep.put(Slot::Card, CARDS, LIMITS, &serde_json::to_string(all).map_err(|e| e.to_string())?)
}

/// The owner's limits, with what each has spent today.
pub fn card_limits(keep: &Keep) -> Vec<CardLimit> {
    let day = store::now() / 86_400;
    read_limits(keep).into_iter().map(|l| if l.day == day { l } else { CardLimit { day, spent: 0.0, ..l } }).collect()
}

/// The site a card limit asked for `site` is kept under: its registrable domain, as the owner is shown it before it is
/// saved (`commands::asks_the_owner`), so what they approve is what is kept.
pub fn limit_site(site: &str) -> Result<String, String> {
    Ok(unbrowse_learn::identity::site_of(&clean_site(site)?))
}

/// Stores a limit for `card` on `site`; a `per_payment` of zero takes it away. Only the owner sets one. Card use still
/// requires owner approval while the node cannot bind checkout amounts and currency to outgoing charges.
pub fn set_card_limit(keep: &Keep, card: &str, site: &str, per_payment: f64, per_day: f64, who: &str) -> Result<Option<CardLimit>, String> {
    let card = clean_label(card)?;
    if !cards().iter().any(|c| c.label == card) {
        return Err(format!("no card named {card} in the vault"));
    }
    let site = limit_site(site)?;
    if !per_payment.is_finite() || !per_day.is_finite() || per_payment < 0.0 || per_day < 0.0 {
        return Err("a limit is an amount of zero or more".into());
    }
    if per_payment > 0.0 && per_day < per_payment {
        return Err("the day's limit can't be under the limit on one payment".into());
    }
    let _held = LIMITS_HELD.locked();
    let mut all = kept_limits(keep).map_err(|e| format!("nothing was changed: {e}"))?;
    let kept = all.iter().find(|l| l.card == card && l.site == site).cloned();
    all.retain(|l| !(l.card == card && l.site == site));
    let set = (per_payment > 0.0).then(|| CardLimit {
        card: card.clone(),
        site: site.clone(),
        per_payment,
        per_day,
        day: kept.as_ref().map_or(0, |k| k.day),
        spent: kept.as_ref().map_or(0.0, |k| k.spent),
    });
    all.extend(set.clone());
    write_limits(keep, &all)?;
    let what = match &set {
        Some(l) => format!("Saved per-payment {} and per-day {} limits for {card} on {site}; card use still asks while charge amounts are unbound", l.per_payment, l.per_day),
        None => format!("Removed the stored limit for {card} on {site}"),
    };
    store::log_activity(&Activity { at: store::now(), who: who.into(), site, what, kind: "vault".into(), result: "done".into(), ms: None, unb: None, tx: None, note: None });
    Ok(set)
}

/// Whether a payment of `amount` fits `limit` on `day`. `Ok` needs no asking. `Err(Some(why))` is more than expected, and
/// says why to the owner; `Err(None)` is a payment with no limit set, which simply asks.
#[cfg(test)]
fn fits(limit: Option<&CardLimit>, amount: Option<f64>, day: u64) -> Result<(), Option<String>> {
    let Some(l) = limit else { return Err(None) };
    let Some(amount) = amount.filter(|a| a.is_finite() && *a > 0.0) else {
        return Err(Some("the agent didn't say how much this costs".into()));
    };
    if amount > l.per_payment {
        return Err(Some(format!("this costs {amount}, over your limit of {} a payment", l.per_payment)));
    }
    let spent = if l.day == day { l.spent } else { 0.0 };
    if spent + amount > l.per_day {
        return Err(Some(format!("this costs {amount} and {spent} went out today, over your limit of {} a day", l.per_day)));
    }
    Ok(())
}

/// Takes a payment from `card`'s limit on `site`: `Ok` when it fits, and it is counted against the day. Otherwise the
/// owner is asked, and `Err` says why when there is a reason to give (`fits`). A limit that can't be saved asks too, so
/// nothing goes out uncounted.
#[cfg(test)]
pub fn take_from_limit(keep: &Keep, card: &str, site: &str, amount: Option<f64>, now: u64) -> Result<(), Option<String>> {
    let day = now / 86_400;
    let _held = LIMITS_HELD.locked();
    let mut all = read_limits(keep);
    let at = all.iter().position(|l| l.card == card && l.site == site);
    fits(at.map(|i| &all[i]), amount, day)?;
    let (Some(i), Some(amount)) = (at, amount) else { return Err(None) };
    let spent = if all[i].day == day { all[i].spent } else { 0.0 };
    all[i].day = day;
    all[i].spent = spent + amount;
    write_limits(keep, &all).map_err(|_| Some("the node couldn't count this against your limit".to_string()))
}

// ---- payment cards ----

/// A payment card in the vault, as the index keeps it: no number, expiry or code, only what tells the owner's cards
/// apart. The card itself is kept beside the root key, as a password is ([`Keep`]).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CardInfo {
    pub label: String,
    pub last4: String,
    pub created: u64,
    /// Whether the card is kept with its security code: only one added while the owner keeps card security codes.
    #[serde(default)]
    pub code: bool,
}

/// The `site` a card's secret is kept under in [`Keep`]: a card belongs to no site.
const CARDS: &str = "card";

fn cards_path() -> PathBuf {
    store::home().join("cards.json")
}

pub fn cards() -> Vec<CardInfo> {
    store::read_json(&cards_path(), &unbrowse_files::CARDS)
}

/// A card's label, as references name it: lowercase letters, digits and dashes, so `vault:card:<label>:<field>` reads
/// one way only.
fn clean_label(label: &str) -> Result<String, String> {
    let l = label.trim().to_ascii_lowercase();
    if l.is_empty() || l.len() > 32 || !l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err("name the card with letters, digits and dashes, like visa or work-amex".into());
    }
    Ok(l)
}

/// Keeps a card the owner entered, under `label`. Only the owner adds a card: the window, or `unbrowse-node vault
/// card add`, which reads it from stdin, never from a command line. Its security code is kept only when `codes`, the
/// owner's choice to keep card security codes (`Settings::keep_card_codes`); otherwise none is, whatever was given.
pub fn add_card(keep: &Keep, label: &str, card: &unbrowse_core::Card, codes: bool, who: &str) -> Result<CardInfo, String> {
    let label = clean_label(label)?;
    let mut all = cards();
    if all.iter().any(|c| c.label == label) {
        return Err(format!("a card named {label} is already in the vault"));
    }
    let mut card = zeroize::Zeroizing::new(card.clone());
    if !codes {
        zeroize::Zeroize::zeroize(&mut card.cvv);
    }
    let json = zeroize::Zeroizing::new(serde_json::to_string(&*card).map_err(|e| e.to_string())?);
    keep.put(Slot::Card, CARDS, &label, &json)?;
    let info = CardInfo { label: label.clone(), last4: card.last4(), created: store::now(), code: card.has_code() };
    all.push(info.clone());
    store::write_json(&cards_path(), &unbrowse_files::CARDS, &all)?;
    store::log_activity(&Activity {
        at: store::now(),
        who: who.into(),
        site: String::new(),
        what: format!("Added the card {label}, ending {}", info.last4),
        kind: "vault".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    Ok(info)
}

/// Removes the card `label`, with its limits. Only the owner removes one, and they are asked first (`commands::asks_the_owner`).
pub fn remove_card(keep: &Keep, label: &str, who: &str) -> Result<(), String> {
    // A card added later under this label is another card: it starts with no limit.
    {
        let _held = LIMITS_HELD.locked();
        let mut limits = read_limits(keep);
        if limits.iter().any(|l| l.card == label) {
            limits.retain(|l| l.card != label);
            write_limits(keep, &limits)?;
        }
    }
    let mut all = cards();
    let before = all.len();
    all.retain(|c| c.label != label);
    if all.len() == before {
        return Err("no such card".into());
    }
    // The index first, as `remove` does.
    store::write_json(&cards_path(), &unbrowse_files::CARDS, &all)?;
    keep.delete(Slot::Card, CARDS, label);
    store::log_activity(&Activity {
        at: store::now(),
        who: who.into(),
        site: String::new(),
        what: format!("Removed the card {label}"),
        kind: "vault".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    Ok(())
}

/// What a card's security code costs to keep, said wherever the owner can turn keeping them on.
pub const KEEPING_CODES_COSTS: &str = "Card rules (PCI DSS) forbid keeping a card's security code after a payment is authorised, even encrypted. On, the vault keeps it beside the card so agents can pay where a checkout asks for it without you; off, you type it at each checkout.";

/// Takes the security code out of every card kept with one, and answers the labels of the cards it took one from.
/// Run when the owner turns keeping codes off, and as the node starts while it is off, so a code kept by an older node
/// or before the owner turned it off goes too. A card that doesn't read or rewrite is left, and said in the log.
pub fn forget_security_codes(keep: &Keep) -> Vec<String> {
    let mut all = cards();
    let (mut forgot, mut changed) = (Vec::new(), false);
    for c in all.iter_mut() {
        let Ok(json) = keep.get(Slot::Card, CARDS, &c.label) else { continue };
        let Ok(mut card) = serde_json::from_str::<unbrowse_core::Card>(&json).map(zeroize::Zeroizing::new) else { continue };
        if card.has_code() {
            zeroize::Zeroize::zeroize(&mut card.cvv);
            let rewritten = serde_json::to_string(&*card).map(zeroize::Zeroizing::new).map_err(|e| e.to_string()).and_then(|plain| keep.put(Slot::Card, CARDS, &c.label, &plain));
            if let Err(e) = rewritten {
                eprintln!("vault: the card {} still holds its security code: {e}", c.label);
                continue;
            }
            forgot.push(c.label.clone());
        }
        changed |= std::mem::take(&mut c.code);
    }
    if changed || !forgot.is_empty() {
        if let Err(e) = store::write_json(&cards_path(), &unbrowse_files::CARDS, &all) {
            eprintln!("vault: the card index still says a card holds its code, though none does: {e}");
        }
    }
    forgot
}

/// What `keep_card_codes` answers: whether the vault keeps card security codes now, and the cards whose code it just
/// forgot.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CardCodes {
    pub on: bool,
    pub forgotten: Vec<String>,
}

/// Whether the vault keeps card security codes (`Settings::keep_card_codes`): `on` sets it, none only reads it. Turning
/// it off forgets every kept code at once, not at the next start. Only the owner reaches this: the `keep_card_codes`
/// owner command, which asks them first to turn it on, and `vault card codes` in a shell, which asks the same.
pub fn set_keep_codes(keep: &Keep, on: Option<bool>, who: &str) -> Result<CardCodes, String> {
    let now = {
        let _held = store::settings_held();
        let mut s = store::load_settings();
        if let Some(on) = on {
            s.keep_card_codes = on;
            store::save_settings(&s)?;
        }
        s.keep_card_codes
    };
    let forgotten = if on == Some(false) { forget_security_codes(keep) } else { Vec::new() };
    if let Some(on) = on {
        store::log_activity(&Activity {
            at: store::now(),
            who: who.into(),
            site: String::new(),
            what: if on { "Turned on keeping card security codes".into() } else { "Turned off keeping card security codes".into() },
            kind: "vault".into(),
            result: "done".into(),
            ms: None,
            unb: None,
            tx: None,
            note: Some(if on { KEEPING_CODES_COSTS.into() } else { forgot_note(&forgotten) }),
        });
    }
    Ok(CardCodes { on: now, forgotten })
}

fn forgot_note(labels: &[String]) -> String {
    if labels.is_empty() {
        "No card held a security code.".into()
    } else {
        format!("Forgot the security code of {}. You type it at each checkout.", labels.join(", "))
    }
}

/// As the node starts: a vault holding codes while the owner hasn't chosen to keep them (a node from before the choice
/// kept every card's) forgets them, and says so once, in the activity log and the node's output, with how to choose to
/// keep them. Once forgotten there is nothing left to say it of again.
pub fn forget_unchosen_codes(keep: &Keep, codes: bool) {
    if codes {
        return;
    }
    let forgotten = forget_security_codes(keep);
    if forgotten.is_empty() {
        return;
    }
    let note = format!(
        "The vault now keeps no card security codes unless you choose to, and forgot the code of {}: a checkout asks you to type it. To let agents pay with a code without you, turn on Keep card security codes (Settings, or `unbrowse-node vault card codes on`), then remove the card and add it again with its code. {KEEPING_CODES_COSTS}",
        forgotten.join(", ")
    );
    eprintln!("vault: {note}");
    store::log_activity(&Activity {
        at: store::now(),
        who: "Node".into(),
        site: String::new(),
        what: "Forgot the cards' security codes".into(),
        kind: "vault".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(note),
    });
}

/// A card field as agents name it: `vault:card:<label>:<field>`, the field one of number, expiry (MM/YY), month,
/// year (YYYY), yy, cvv or name.
#[derive(Clone, Debug, PartialEq)]
pub struct CardRef {
    pub label: String,
    pub field: unbrowse_core::CardField,
}

impl CardRef {
    pub fn parse(s: &str) -> Option<CardRef> {
        let rest = s.trim().strip_prefix("vault:card:")?;
        let (label, field) = rest.split_once(':')?;
        let label = clean_label(label).ok()?;
        Some(CardRef { label, field: unbrowse_core::CardField::parse(field.trim())? })
    }

    /// The reference as the walk record and a route keep it.
    pub fn name(&self) -> String {
        format!("vault:card:{}:{}", self.label, self.field.name())
    }

    /// The card as the owner is shown it when asked to pay: its label and last four digits.
    pub fn shown(&self) -> Result<String, String> {
        let c = cards().into_iter().find(|c| c.label == self.label).ok_or_else(|| self.missing())?;
        Ok(format!("{} (card ending {})", c.label, c.last4))
    }

    fn missing(&self) -> String {
        format!("no card named {} is in the vault: the owner adds it (unbrowse-node vault card add {})", self.label, self.label)
    }
}

/// Whether `s` names anything in the vault: a login, its one-time code or a card field.
pub fn is_ref(s: &str) -> bool {
    Ref::parse(s).is_some() || CardRef::parse(s).is_some()
}

/// What a checkout that asks for a card's security code is told when the vault has none to give: by default it keeps
/// none (#185), so the owner types it on the page.
const NO_SECURITY_CODE: &str = "the vault keeps no card security codes (card rules forbid it unless the owner chooses to keep them): fill the card's other fields, then ask_owner, and the owner types the code on the page themselves";

/// The value a card reference names, for the node to type or send itself, only once the owner has approved the payment.
/// The security code only while the owner keeps card security codes (`codes`): off, there is none to give, even from a
/// card that somehow still holds one.
pub fn card_value(keep: &Keep, r: &CardRef, codes: bool) -> Result<zeroize::Zeroizing<String>, String> {
    if !cards().iter().any(|c| c.label == r.label) {
        return Err(r.missing());
    }
    if r.field == unbrowse_core::CardField::Cvv && !codes {
        return Err(NO_SECURITY_CODE.into());
    }
    let json = keep.get(Slot::Card, CARDS, &r.label).map_err(|e| format!("the card {} didn't read from the vault: {e}", r.label))?;
    let card = zeroize::Zeroizing::new(serde_json::from_str::<unbrowse_core::Card>(&json).map_err(|_| format!("the vault's card {} is damaged", r.label))?);
    card.field(r.field).ok_or_else(|| format!("the card {} is kept without its security code: ask_owner, and the owner types it on the page themselves", r.label))
}

/// A login as agents name it: `vault:<site>:<account>`, `vault:new:<site>:<account>` for one the node makes, or
/// `vault:code:<site>:<account>` for its one-time code.
#[derive(Clone, Debug, PartialEq)]
pub struct Ref {
    pub site: String,
    pub account: String,
    pub new: bool,
    /// The login's one-time code, not its password.
    pub code: bool,
}

impl Ref {
    pub fn parse(s: &str) -> Option<Ref> {
        let rest = s.trim().strip_prefix("vault:")?;
        let (new, code, rest) = match (rest.strip_prefix("new:"), rest.strip_prefix("code:")) {
            (Some(r), _) => (true, false, r),
            (_, Some(r)) => (false, true, r),
            _ => (false, false, rest),
        };
        let (host, after) = rest.split_once(':')?;
        // A numeric segment right after the host is the site's port, not the account
        // (vault:example.org:2083:admin names the login on example.org:2083).
        let (site, account) = match after.split_once(':') {
            Some((port, acct)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => (format!("{host}:{port}"), acct),
            _ => (host.to_string(), after),
        };
        let site = clean_site(&site).ok()?;
        let account = account.trim();
        (!account.is_empty()).then(|| Ref { site, account: account.to_string(), new, code })
    }

    /// The reference as the walk record and a route keep it.
    pub fn name(&self) -> String {
        if self.code {
            return format!("vault:code:{}:{}", self.site, self.account);
        }
        format!("vault:{}:{}", self.site, self.account)
    }

    /// Whether this login may go to `host`: a page or a call on the login's own site. Port-blind; use
    /// [`fits_page`](Ref::fits_page) at fill time, where the page's full origin is known.
    pub fn fits(&self, host: &str) -> bool {
        let site = unbrowse_learn::identity::site_of(&self.site);
        !site.is_empty() && unbrowse_learn::identity::site_of(host) == site
    }

    /// The port a port-scoped reference names (`example.org:2083` -> 2083), if any.
    pub fn port(&self) -> Option<u16> {
        self.site.rsplit_once(':').and_then(|(_, p)| p.parse().ok())
    }

    /// Whether this login may be typed into the page at `page_url`: a page on the login's own site that came over
    /// https, since a cleartext page is anyone's on the way to write, its form's target included. A port-scoped login
    /// (`example.org:2083`) fills only that port as well. This is the fill-time check; the page's full address is
    /// known here, so the port and scheme are not dropped.
    pub fn fits_page(&self, page_url: &str) -> bool {
        let Ok(u) = url::Url::parse(page_url) else { return false };
        let Some(host) = u.host_str() else { return false };
        u.scheme() == "https" && self.fits(host) && self.port().is_none_or(|port| u.port() == Some(port))
    }
}

/// The secret `r` names, for the node to type or send itself: the login's password, or its one-time code as of now.
/// A `vault:new:` login that isn't in the vault yet gets its derived password here, and is kept by [`keep_new`] once
/// that password went in.
pub fn secret_for(keep: &Keep, keys: &dyn KeyStore, r: &Ref) -> Result<Zeroizing<String>, String> {
    if r.code {
        let l = list().into_iter().find(|l| l.site == r.site && l.account == r.account && l.code);
        l.ok_or(format!("{} has no one-time code key in the vault: the owner adds it in the Unbrowse app (Vault)", r.name()))?;
        let key = keep.get(Slot::Code, &r.site, &r.account)?;
        let key = unbrowse_core::CodeKey::parse(&key).ok_or("the kept one-time code key no longer reads")?;
        return Ok(Zeroizing::new(key.now().to_string()));
    }
    if list().iter().any(|l| l.site == r.site && l.account == r.account) {
        return reveal(keep, keys, &r.site, &r.account);
    }
    if !r.new {
        return Err(format!("{} isn't in the vault: the owner adds it in the Unbrowse app (Vault)", r.name()));
    }
    let root = RootKey::load(keys).map_err(|e| e.to_string())?;
    Ok(derived(&root, &r.site, &r.account, next_counter(&list(), &r.site), DERIVATION))
}

/// The secret `r` names, when the vault holds one: `None` for a stored login whose secret isn't sealed here (one an
/// older build kept in the system's keystore). What the node never has, it can't show an agent, so the mask every
/// answer crosses passes it over rather than refusing the answer (`browse::know_vault`).
pub fn held_secret(keep: &Keep, keys: &dyn KeyStore, r: &Ref) -> Result<Option<Zeroizing<String>>, String> {
    match list().into_iter().find(|l| l.site == r.site && l.account == r.account) {
        Some(l) if l.kind != "derived" && !r.code => keep.find(Slot::Password, &r.site, &r.account),
        _ => secret_for(keep, keys, r).map(Some),
    }
}

/// Keeps the login a `vault:new:` reference made, once its password was typed: a fill that failed leaves nothing.
pub fn keep_new(keep: &Keep, r: &Ref, who: &str) -> Result<(), String> {
    if r.new && !list().iter().any(|l| l.site == r.site && l.account == r.account) {
        add(keep, &r.site, &r.account, "derived", None, who)?;
    }
    Ok(())
}

/// The values a call sends, and the secrets filled into them from the vault, each beside the reference that named
/// it: whatever the call hands back says the reference where the site said the secret.
#[derive(Clone, Debug, Default)]
pub struct Filled {
    pub values: std::collections::HashMap<String, String>,
    /// (the secret, the reference that named it)
    pub secrets: Vec<(String, String)>,
    /// The inputs whose values the vault filled in: whatever graph the call ends up sending, a heal's included, sends
    /// them only to the route's own site (`RouteClient::with_held_inputs`).
    pub held: Vec<String>,
}

impl Filled {
    /// Values a caller sent with nothing filled from the vault.
    #[cfg(test)]
    pub fn plain(values: std::collections::HashMap<String, String>) -> Self {
        Filled { values, secrets: Vec::new(), held: Vec::new() }
    }
}

/// Every place a call of `route` sends input `name`, as an address: each request whose fields take it, or the socket
/// whose frame carries it.
fn destinations(route: &store::Route, name: &str) -> Vec<String> {
    if let Some(s) = &route.socket {
        let carries = s.frame.iter().any(|p| matches!(p, store::Piece::Input { name: n } if n == name));
        return if carries { vec![s.url.clone()] } else { Vec::new() };
    }
    route
        .graph
        .steps
        .iter()
        .filter(|s| s.fields.iter().any(|f| matches!(&f.class, unbrowse_learn::Class::Input { name: n, .. } if n == name)))
        .map(|s| s.url.clone())
        .collect()
}

/// Whether a login may be sent to `address`: over an encrypted connection, to a host on the login's own site.
fn may_carry(r: &Ref, address: &str) -> bool {
    let Ok(u) = url::Url::parse(&address.replace('{', "%7B").replace('}', "%7D")) else { return false };
    matches!(u.scheme(), "https" | "wss") && u.host_str().is_some_and(|h| r.fits(h))
}

/// The cards a call of `route` with `given` would pay with: each card reference among its inputs, the caller's or a
/// default the route was learned with. A call that names one waits for the owner before anything is filled.
pub fn cards_in(route: &store::Route, given: &std::collections::HashMap<String, String>) -> Vec<CardRef> {
    let mut out: Vec<CardRef> = Vec::new();
    for i in &route.inputs {
        if let Some(r) = given.get(&i.name).or(i.default.as_ref()).and_then(|v| CardRef::parse(v)) {
            if !out.iter().any(|o| o.label == r.label) {
                out.push(r);
            }
        }
    }
    out
}

/// Whether every card a call of `route` with `given` names may go where the route sends it, read before the owner is
/// asked: a call the rules would refuse never asks them to approve it. Reads no card. `codes` is whether the owner
/// keeps card security codes.
pub fn check_cards(route: &store::Route, given: &std::collections::HashMap<String, String>, codes: bool) -> Result<(), String> {
    for (name, value) in given {
        if CardRef::parse(value).is_some() && !route.inputs.iter().any(|i| &i.name == name) {
            return Err(format!("the route has no input {name} to fill a card into"));
        }
    }
    for i in &route.inputs {
        if let Some(c) = given.get(&i.name).or(i.default.as_ref()).and_then(|v| CardRef::parse(v)) {
            card_may_go(route, &i.name, i.secret, &c, codes)?;
        }
    }
    Ok(())
}

/// The rules for one card input: a secret input, a card the vault holds, and only the route's own site, encrypted. A
/// security code only from a card kept with one, while the owner keeps them: a route call has no page for the owner to
/// type one on, so it is refused before they are asked to approve a call that can't go through.
fn card_may_go(route: &store::Route, input: &str, secret: bool, c: &CardRef, codes: bool) -> Result<(), String> {
    if !secret {
        return Err(format!("{input} isn't a secret input: a card goes only where the site checks it, never where it may show it"));
    }
    let Some(card) = cards().into_iter().find(|k| k.label == c.label) else { return Err(c.missing()) };
    if c.field == unbrowse_core::CardField::Cvv && !(codes && card.code) {
        let why = if codes { format!("the card {} is kept without it", c.label) } else { "the vault keeps none unless the owner chooses to".into() };
        return Err(format!("{input} needs the card's security code, and {why}: a route call has no page to ask for it, so pay on the checkout page with unbrowse_browse and ask_owner for the code"));
    }
    if let Some(to) = destinations(route, input).into_iter().find(|to| !may_carry_card(&route.site, to)) {
        return Err(format!("this route sends {input} to {to}: a card goes only to the site the route calls, encrypted"));
    }
    Ok(())
}

/// Whether a card may be sent to `address`: over an encrypted connection, to a host on the site the route calls (the
/// merchant the owner approved), never anywhere else the route sends.
fn may_carry_card(site: &str, address: &str) -> bool {
    let Ok(u) = url::Url::parse(&address.replace('{', "%7B").replace('}', "%7D")) else { return false };
    let site = unbrowse_learn::identity::site_of(site);
    matches!(u.scheme(), "https" | "wss") && u.host_str().is_some_and(|h| !site.is_empty() && unbrowse_learn::identity::site_of(h) == site)
}

/// The values a call sends, with every vault login filled in. A secret input bound to a login when the route was
/// learned (the login was typed from the vault then, into its own site) takes it again; a caller may name one for a
/// secret input too. Either way the login goes only where every request (or socket) that carries it is on the
/// login's own site, over an encrypted connection. Only a secret input takes a login: anything else a route sends,
/// the site may show to others.
///
/// A card goes in the same way, to the route's own site only, and only when `cards_approved`: the owner approved
/// this very call ([`cards_in`] says which cards it names). A call nobody approved never reads a card. Its security
/// code goes in only while the owner keeps card security codes (`codes`).
pub fn fill_inputs(
    keep: &Keep,
    keys: &dyn KeyStore,
    route: &store::Route,
    given: &std::collections::HashMap<String, String>,
    cards_approved: bool,
    codes: bool,
) -> Result<Filled, String> {
    let mut out = given.clone();
    let mut secrets = Vec::new();
    let mut held = Vec::new();
    for (name, value) in given {
        if is_ref(value) && !route.inputs.iter().any(|i| &i.name == name) {
            return Err(format!("the route has no input {name} to fill a vault login or card into"));
        }
    }
    for i in &route.inputs {
        let Some(value) = given.get(&i.name).or(i.default.as_ref()) else { continue };
        if let Some(c) = CardRef::parse(value) {
            card_may_go(route, &i.name, i.secret, &c, codes)?;
            if !cards_approved {
                return Err(format!("{} pays with a card, and a card goes in only on a call the owner approves: make the call through the node (unbrowse_do or unbrowse_call), which asks them", c.name()));
            }
            let v = card_value(keep, &c, codes)?;
            secrets.push((v.to_string(), c.name()));
            out.insert(i.name.clone(), v.to_string());
            held.push(i.name.clone());
            continue;
        }
        let Some(r) = Ref::parse(value) else { continue };
        // Whether an input is a secret, and where it goes, is a route's own word. A route this node learned says what
        // the owner's walk saw (a password typed into the site's own password field); one another node listed says
        // what its contributor wrote, and could put a password in any field of the site, one it shows to others
        // included. So a vault login fills only a route this node learned itself, as the node's own sign-in only ever
        // runs one (`RouteClient::with_sign_in`); an agent signs in elsewhere on the page itself, where the node sees
        // the field it fills.
        if crate::share::egress(route) != unbrowse_learn::egress::Egress::Own {
            return Err(format!("{} is a login from the vault, and this route came from another node: a login goes only into a route this node learned itself, where its own walk saw the password field. Sign in on the site's page (unbrowse_browse) instead", r.name()));
        }
        if !i.secret {
            return Err(format!("{} isn't a secret input: a vault login goes only where the site checks it, never where it may show it", i.name));
        }
        if r.new {
            return Err("vault:new: makes a login while browsing a sign-up page; a call takes a login that exists".into());
        }
        if !r.fits(&route.site) {
            return Err(format!("{} is the login for {}, and this route calls {}: a login goes only to its own site", r.name(), r.site, route.site));
        }
        if let Some(to) = destinations(route, &i.name).into_iter().find(|to| !may_carry(&r, to)) {
            return Err(format!("{} is the login for {}, and this route sends {} to {to}: a login goes only to its own site, encrypted", r.name(), r.site, i.name));
        }
        // Plain from here: the call sends it.
        let secret = secret_for(keep, keys, &r)?;
        secrets.push((secret.to_string(), r.name()));
        out.insert(i.name.clone(), secret.to_string());
        held.push(i.name.clone());
    }
    Ok(Filled { values: out, secrets, held })
}

/// Why an import left a login out when the system's keystore wouldn't take its password. Over SSH a Mac's login
/// Keychain is locked until `security unlock-keychain`.
const REFUSED: &str = "the system's keystore refused it (over SSH on a Mac, run `security unlock-keychain` first)";

/// One login read from an export.
#[derive(Debug, PartialEq)]
pub struct Exported {
    pub site: String,
    pub account: String,
    pub password: String,
    /// The one-time code key the exporter kept with the login, if it kept one.
    pub code: Option<String>,
}

/// What an import did. Rows it left out are counted by why, never listed: a row is a password.
#[derive(Debug, Default, Serialize)]
pub struct Imported {
    pub added: usize,
    /// Of those, the logins that came with a one-time code key.
    pub codes: usize,
    /// Already in the vault, or in the file twice: the vault's own is kept.
    pub known: usize,
    pub skipped: Vec<Skipped>,
}

/// Rows an import left out, and why.
#[derive(Debug, Serialize)]
pub struct Skipped {
    pub why: String,
    pub count: usize,
}

/// The logins in an export: a CSV ([`read_csv`]) or a password manager's JSON ([`read_json`]). A login saved in an
/// app is left out: [`read_export_with`] can say which site an app's logins belong to.
#[cfg(test)]
pub fn read_export(text: &str) -> Result<(Vec<Exported>, Vec<(String, usize)>), String> {
    read_export_with(text, &mut |_| None)
}

/// [`read_export`], with `apps` saying which site a login saved in an app belongs to (None: no site the node can be
/// sure of, and the login is left out).
pub fn read_export_with(text: &str, apps: Apps) -> Result<(Vec<Exported>, Vec<(String, usize)>), String> {
    let text = text.trim_start_matches('\u{feff}');
    if is_json(text) {
        return read_json(text, apps);
    }
    read_csv(text, apps)
}

/// Which site an app's logins belong to, for an import (`applinks.rs` asks the web).
pub type Apps<'a> = &'a mut dyn FnMut(&App) -> Option<String>;

/// The websites an export's app logins would be filled on: each app once, with the site `apps` finds for it.
pub fn app_sites(text: &str, apps: Apps) -> Vec<(App, String)> {
    let mut found: Vec<(App, String)> = Vec::new();
    let _ = read_export_with(text, &mut |a: &App| {
        let site = apps(a);
        if let Some(s) = &site {
            if !found.iter().any(|(x, _)| x == a) {
                found.push((a.clone(), s.clone()));
            }
        }
        site
    });
    found
}

/// [`import`], keeping an app's login only under a site the owner confirmed for that app. Which site an app's logins
/// go to is what websites say of themselves (`applinks.rs`): nothing asks the app, and a site can claim an app that
/// isn't its own (an app's signing certificate is public, so any site can name it). So the owner is asked about each
/// app on its own (`ask`), shown the app, the site it would be filled on and whether the export kept the app's
/// certificate, before that app's logins are kept; a no leaves that app's logins out and keeps everything else.
pub fn import_confirming_apps(keep: &Keep, text: &str, who: &str, apps: Apps, ask: &mut dyn FnMut(String) -> Result<(), String>) -> Result<Imported, String> {
    let found = app_sites(text, apps);
    let allowed: Vec<(App, String)> = found
        .into_iter()
        .filter(|(a, s)| {
            let cert = match a.cert {
                Some(_) => "The export kept the app's signing certificate, and the website names the same one. A certificate is public, so that alone doesn't prove the website is the app's.",
                None => "The export kept no signing certificate for the app, so only its package name was matched.",
            };
            ask(format!(
                "The import holds logins saved in the Android app {}. Unbrowse would fill them on {s}, the website that says it shares that app's logins.\n\n{cert}\n\nIs {s} that app's own website? A no leaves this app's logins out and imports the rest.",
                a.package
            ))
            .is_ok()
        })
        .collect();
    import(keep, text, who, &mut |a: &App| allowed.iter().find(|(x, _)| x == a).map(|(_, s)| s.clone()))
}

/// Whether an export is JSON rather than a CSV: a CSV's first cell is never an object or a list.
pub fn is_json(text: &str) -> bool {
    matches!(text.trim_start_matches('\u{feff}').trim_start().chars().next(), Some('{' | '['))
}

/// The logins in a password manager's JSON export: Bitwarden's (`items[].login`) and the FIDO Alliance's Credential
/// Exchange Format (`accounts[].items[]`, a `basic-auth` credential scoped to the item's URLs). A file with no logins
/// in it (one passkey, say) reads as none: the caller says what else it held. An encrypted export can't be read here.
pub fn read_json(text: &str, apps: Apps) -> Result<(Vec<Exported>, Vec<(String, usize)>), String> {
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| "this JSON doesn't read: export it again, unencrypted".to_string())?;
    if v["encrypted"].as_bool() == Some(true) || v["passwordProtected"].as_bool() == Some(true) {
        return Err("this export is encrypted: export it again as plain JSON (or CSV), import it, then delete the file".into());
    }
    let (mut out, mut skipped) = (Vec::new(), Vec::<(String, usize)>::new());
    let mut skip = |why: &str| match skipped.iter_mut().find(|(w, _)| w == why) {
        Some((_, n)) => *n += 1,
        None => skipped.push((why.to_string(), 1)),
    };
    let s = |v: &serde_json::Value| v.as_str().map(str::trim).unwrap_or_default().to_string();
    let mut take = |address: Option<String>, account: String, password: String, code: Option<String>| {
        let site = match address.as_deref().map(|a| login_site(a, apps)).unwrap_or(Err(NO_ADDRESS)) {
            Ok(site) => site,
            Err(why) => return skip(why),
        };
        if account.is_empty() {
            return skip("no username");
        }
        if password.is_empty() {
            return skip("no password");
        }
        out.push(Exported { site, account, password, code: code.filter(|c| !c.is_empty()) });
    };
    // Bitwarden: one item per entry; a login item holds its addresses, username, password and code key.
    for item in v["items"].as_array().into_iter().flatten() {
        let Some(login) = item.get("login").filter(|l| l.is_object()) else { continue };
        let address = signs_in_at(login["uris"].as_array().into_iter().flatten().map(|u| s(&u["uri"])).collect());
        let password = login["password"].as_str().unwrap_or_default().to_string();
        let has_passkey = login["fido2Credentials"].as_array().is_some_and(|p| !p.is_empty());
        if password.is_empty() && has_passkey {
            continue; // a passkey alone: the passkey import takes it
        }
        take(address, s(&login["username"]), password, Some(s(&login["totp"])));
    }
    // CXF: accounts hold items; an item's credentials are typed, and its scope names the sites it is for.
    for item in v["accounts"].as_array().into_iter().flatten().flat_map(|a| a["items"].as_array().into_iter().flatten()) {
        let urls = |c: &serde_json::Value| c["urls"].as_array().into_iter().flatten().map(s).collect::<Vec<_>>();
        let scope: Vec<String> = item["scope"]["urls"].as_array().into_iter().flatten().map(s).collect();
        for c in item["credentials"].as_array().into_iter().flatten().filter(|c| c["type"] == "basic-auth") {
            let address = signs_in_at(scope.iter().chain(urls(c).iter()).cloned().collect());
            let field = |k: &str| c[k].get("value").map(|x| x.as_str().unwrap_or_default().to_string()).unwrap_or_else(|| c[k].as_str().unwrap_or_default().to_string());
            take(address, field("username").trim().to_string(), field("password"), None);
        }
    }
    Ok((out, skipped))
}

/// The logins in a CSV a browser or a password manager exported. Every exporter writes one header row and one row
/// per login, and names its columns its own way (`url`, `login_uri`, `Web Site`; `username`, `login_username`,
/// `Login Name`), so the columns are found by what their names say: the page's address, the account, the password.
/// A row without an address on the web (a note, or an app no website claims), an account or a password is left out
/// and counted.
pub fn read_csv(text: &str, apps: Apps) -> Result<(Vec<Exported>, Vec<(String, usize)>), String> {
    let rows = csv_rows(text.trim_start_matches('\u{feff}'));
    let header = rows.first().ok_or("the file is empty")?;
    let names: Vec<String> = header.iter().map(|h| h.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()).collect();
    // Names in the order they say it most plainly: a column named `account` is a title in one export and the
    // username in another, so a `username` or `login name` column wins over it.
    let column = |exact: &[&str], part: &[&str], not: &[Option<usize>]| {
        let free = |i: &usize| !not.contains(&Some(*i));
        exact
            .iter()
            .find_map(|e| (0..names.len()).filter(free).find(|&i| names[i] == *e))
            .or_else(|| part.iter().find_map(|p| (0..names.len()).filter(free).find(|&i| names[i].contains(p))))
    };
    let password = column(&["password", "loginpassword", "pass", "passwd"], &["password"], &[]);
    let url = column(&["url", "loginuri", "uri", "website", "websiteurl", "site", "origin", "address"], &["url", "uri", "website"], &[password]);
    let account = column(&["username", "loginusername", "user", "login", "loginname", "email", "emailaddress", "account"], &["username", "user", "email", "login"], &[password, url]);
    // The one-time code key, where an exporter keeps one: `totp`, `login_totp`, `OTPAuth`, `otpSecret`.
    let code = column(&["totp", "logintotp", "otpauth", "otpsecret", "otp"], &["totp", "otp"], &[password, url, account]);
    let (Some(url), Some(account), Some(password)) = (url, account, password) else {
        return Err("this isn't a password export: it needs columns for the site's address, the username and the password".into());
    };
    let (mut out, mut skipped) = (Vec::new(), Vec::<(String, usize)>::new());
    let mut skip = |why: &str| match skipped.iter_mut().find(|(w, _)| w == why) {
        Some((_, n)) => *n += 1,
        None => skipped.push((why.to_string(), 1)),
    };
    for row in rows.iter().skip(1).filter(|r| r.iter().any(|c| !c.trim().is_empty())) {
        let cell = |i: usize| row.get(i).map(|c| c.trim()).unwrap_or_default();
        let site = match login_site(cell(url), apps) {
            Ok(site) => site,
            Err(why) => {
                skip(why);
                continue;
            }
        };
        if cell(account).is_empty() {
            skip("no username");
            continue;
        }
        let pw = row.get(password).map(String::as_str).unwrap_or_default();
        if pw.is_empty() {
            skip("no password");
            continue;
        }
        let code = code.map(cell).filter(|c| !c.is_empty()).map(String::from);
        out.push(Exported { site, account: cell(account).to_string(), password: pw.to_string(), code });
    }
    Ok((out, skipped))
}

/// The site a saved login's address names: its host, without `www.`, for an http(s) page only.
fn web_site(address: &str) -> Option<String> {
    let with_scheme = if address.contains("://") { address.to_string() } else { format!("https://{address}") };
    let u = url::Url::parse(&with_scheme).ok().filter(|u| matches!(u.scheme(), "http" | "https"))?;
    let host = u.host_str()?.trim_start_matches("www.");
    clean_site(host).ok()
}

/// An Android app a login was saved in: its package, and the SHA-256 of its signing certificate where the export kept
/// it (`android://<cert hash>@<package>/`; Bitwarden's `androidapp://<package>` keeps none).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct App {
    pub package: String,
    pub cert: Option<Vec<u8>>,
}

fn app_of(address: &str) -> Option<App> {
    let (scheme, rest) = address.trim().split_once("://")?;
    if !matches!(scheme.to_ascii_lowercase().as_str(), "android" | "androidapp") {
        return None;
    }
    let rest = rest.trim_end_matches('/');
    let (cert, package) = match rest.rsplit_once('@') {
        Some((hash, package)) => (cert_of(hash), package),
        None => (None, rest),
    };
    let named = package.contains('.') && package.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    named.then(|| App { package: package.to_string(), cert })
}

/// A certificate hash as an export writes it: base64 of its 32 bytes, in either alphabet, padded or not.
fn cert_of(hash: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, URL_SAFE};
    use base64::Engine;
    let padded = format!("{}{}", hash, "=".repeat((4 - hash.len() % 4) % 4));
    STANDARD.decode(&padded).or_else(|_| URL_SAFE.decode(&padded)).ok().filter(|b| b.len() == 32)
}

/// Of a login's addresses, the one it signs in at: a page on the web, else the app it was saved in.
fn signs_in_at(addresses: Vec<String>) -> Option<String> {
    let web = addresses.iter().find(|a| web_site(a).is_some());
    web.or_else(|| addresses.iter().find(|a| app_of(a).is_some())).cloned()
}

/// The site a login signs in on: its page's, or, for a login saved in an app, the site `apps` says the app's logins
/// belong to. `Err` says why there is none, so an import can count what it left out.
fn login_site(address: &str, apps: Apps) -> Result<String, &'static str> {
    if let Some(site) = web_site(address) {
        return Ok(site);
    }
    let app = app_of(address).ok_or(NO_ADDRESS)?;
    apps(&app).and_then(|site| clean_site(&site).ok()).ok_or(UNCLAIMED_APP)
}

const NO_ADDRESS: &str = "no address on the web (an app's login or a note)";
const UNCLAIMED_APP: &str = "an app's login, and no website names that app as sharing its logins";

/// The rows of a CSV: commas between cells, a cell in double quotes may hold commas, line breaks and `""` for a quote.
fn csv_rows(text: &str) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut cell, mut quoted) = (Vec::new(), Vec::new(), String::new(), false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, quoted) {
            ('"', true) if chars.peek() == Some(&'"') => {
                cell.push('"');
                chars.next();
            }
            ('"', true) => quoted = false,
            ('"', false) if cell.is_empty() => quoted = true,
            (',', false) => row.push(std::mem::take(&mut cell)),
            ('\r', false) => {}
            ('\n', false) => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
            }
            (c, _) => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

/// Imports an export into the vault: each login's password is kept as a stored login ([`Keep`]: the system's
/// keystore, or sealed beside a root key kept in a file). A login the vault already has keeps the vault's password. A
/// login saved in an app comes in under the site `apps` says the app's logins belong to.
pub fn import(keep: &Keep, text: &str, who: &str, apps: Apps) -> Result<Imported, String> {
    let (logins, mut skipped) = read_export_with(text, apps)?;
    // From here to the write: the list is the file as it stands now, and a login added meanwhile waits rather than goes.
    let _held = store::hold_file(&path())?;
    let mut all = list();
    let mut done = Imported::default();
    for l in logins {
        if all.iter().any(|k| k.site == l.site && k.account == l.account) {
            done.known += 1;
            continue;
        }
        if keep.put(Slot::Password, &l.site, &l.account, &l.password).is_err() {
            let why = REFUSED;
            match skipped.iter_mut().find(|(w, _)| w == why) {
                Some((_, n)) => *n += 1,
                None => skipped.push((why.into(), 1)),
            }
            continue;
        }
        // A code key that makes no codes (a counter-based or vendor one) leaves the login, without it.
        let code = l.code.as_deref().filter(|c| unbrowse_core::CodeKey::parse(c).is_some());
        let code = code.is_some_and(|c| keep.put(Slot::Code, &l.site, &l.account, c).is_ok());
        done.codes += code as usize;
        all.push(Login { site: l.site, account: l.account, kind: "stored".into(), counter: 0, created: store::now(), code, derivation: DERIVATION });
        done.added += 1;
    }
    done.skipped = skipped.into_iter().map(|(why, count)| Skipped { why, count }).collect();
    store::write_json(&path(), &unbrowse_files::VAULT, &all)?;
    store::log_activity(&Activity {
        at: store::now(),
        who: who.into(),
        site: String::new(),
        what: format!("Imported {} logins", done.added),
        kind: "vault".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: (done.known > 0).then(|| format!("{} already in the vault", done.known)),
    });
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limit() -> CardLimit {
        CardLimit { card: "visa".into(), site: "shop.example".into(), per_payment: 50.0, per_day: 80.0, day: 10, spent: 0.0 }
    }

    /// With no limit nothing changes: every payment asks, and there is nothing to explain.
    #[test]
    fn a_card_with_no_limit_asks_every_time() {
        assert_eq!(fits(None, Some(1.0), 10), Err(None));
    }

    /// The owner is asked only for what is more than expected, and is told why.
    #[test]
    fn only_a_payment_past_its_limit_asks() {
        let l = limit();
        assert_eq!(fits(Some(&l), Some(50.0), 10), Ok(()), "up to the limit");
        assert!(fits(Some(&l), Some(50.01), 10).unwrap_err().unwrap().contains("a payment"));
        assert!(fits(Some(&l), None, 10).unwrap_err().unwrap().contains("didn't say"), "no amount is never within a limit");
        for bad in [0.0, -5.0, f64::NAN, f64::INFINITY] {
            assert!(fits(Some(&l), Some(bad), 10).is_err(), "{bad} is no amount");
        }
    }

    #[test]
    fn a_day_of_small_payments_stops_at_the_days_limit() {
        let l = CardLimit { spent: 70.0, ..limit() };
        assert_eq!(fits(Some(&l), Some(10.0), 10), Ok(()), "up to the day's limit");
        assert!(fits(Some(&l), Some(10.01), 10).unwrap_err().unwrap().contains("a day"));
        assert_eq!(fits(Some(&l), Some(50.0), 11), Ok(()), "a new day starts from nothing");
    }

    /// The limit is the one for this card on this site, kept sealed, and what fits is counted.
    /// Secrets kept in a folder of their own, so a test can stop the index being written and leave them writable.
    fn sealed_apart(keys: &unbrowse_core::MemoryStore) -> Keep {
        let dir = store::home().join("secrets");
        std::fs::create_dir_all(&dir).unwrap();
        Keep::sealed(keys, &dir).unwrap()
    }

    /// A removal the index couldn't take leaves the login listed, so its password must still be there: gone, the owner
    /// holds a login that opens nothing.
    #[cfg(unix)]
    #[test]
    fn a_login_that_couldnt_be_removed_keeps_its_password() {
        use std::os::unix::fs::PermissionsExt;
        let keys = with_login();
        let keep = sealed_apart(&keys);
        add(&keep, "shop.example", "me", "stored", Some("kept"), "You").unwrap();
        let home = store::home();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o555)).unwrap();
        let removed = remove(&keep, "shop.example", "me");
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(removed.is_err(), "the index refused it");
        assert!(list().iter().any(|l| l.site == "shop.example"));
        assert_eq!(keep.get(Slot::Password, "shop.example", "me").unwrap().as_str(), "kept");
    }

    /// Two accounts on one site are two logins: one found out says nothing of the other, and rotating one moves it past
    /// every password the site's logins have had, so it can't land on the other's.
    #[test]
    fn two_accounts_on_a_site_never_share_a_derived_password() {
        let keys = with_login();
        let keep = sealed_apart(&keys);
        add(&keep, "shop.example", "first", "derived", None, "You").unwrap();
        add(&keep, "shop.example", "second", "derived", None, "You").unwrap();
        let shown = |account: &str| reveal(&keep, &keys, "shop.example", account).unwrap();
        assert_ne!(shown("first"), shown("second"));
        rotate("shop.example", "first").unwrap();
        assert_ne!(shown("first"), shown("second"));
        let new = Ref { site: "shop.example".into(), account: "third".into(), new: true, code: false };
        let typed = secret_for(&keep, &keys, &new).unwrap();
        keep_new(&keep, &new, "You").unwrap();
        assert_eq!(shown("third"), typed, "a new login keeps the password that went into the site");
        assert_ne!(shown("first"), typed);
        assert_ne!(shown("second"), typed);
    }

    /// What the vault hands out of a secret is wiped from memory when dropped: the types say so, so a change that hands
    /// out a plain string doesn't build.
    #[test]
    fn the_vaults_secrets_are_wiped_when_dropped() {
        let keys = with_login();
        let keep = sealed_apart(&keys);
        add(&keep, "shop.example", "me", "stored", Some("kept"), "You").unwrap();
        let held: Zeroizing<String> = keep.get(Slot::Password, "shop.example", "me").unwrap();
        let shown: Zeroizing<String> = reveal(&keep, &keys, "shop.example", "me").unwrap();
        let sent: Zeroizing<String> = secret_for(&keep, &keys, &Ref { site: "shop.example".into(), account: "me".into(), new: false, code: false }).unwrap();
        assert!([held, shown, sent].iter().all(|s| s.as_str() == "kept"));
    }

    /// A login removed frees its counter, and the next login on the site takes it: the account is part of the
    /// derivation, so the new account's password is never the removed one's (which may still sign in to the site). A
    /// login made before the account went in keeps the password it has.
    #[test]
    fn a_removed_logins_password_never_comes_back_as_anothers() {
        let keys = with_login();
        let keep = sealed_apart(&keys);
        add(&keep, "shop.example", "first", "derived", None, "You").unwrap();
        let gone = reveal(&keep, &keys, "shop.example", "first").unwrap();
        remove(&keep, "shop.example", "first").unwrap();
        let next = add(&keep, "shop.example", "second", "derived", None, "You").unwrap();
        assert_eq!(next.counter, 0, "the counter came free");
        assert_ne!(reveal(&keep, &keys, "shop.example", "second").unwrap(), gone);
        // An index from before: no derivation said, so it is the site's and counter's, as it always was.
        let old: Vec<Login> = serde_json::from_str(r#"[{"site":"old.example","account":"me","kind":"derived","counter":3,"created":1}]"#).unwrap();
        assert_eq!(old[0].derivation, 0);
        let root = RootKey::load(&keys).unwrap();
        assert_eq!(*derived(&root, "old.example", "me", 3, old[0].derivation), *root.password("old.example", 3, 20));
    }

    /// Limits that won't read count as none for a payment, which asks. They must not count as none for a write, which
    /// would take every other limit with it, and what each has spent today.
    #[test]
    fn limits_that_wont_read_are_never_written_over() {
        let keys = with_login();
        let keep = sealed_apart(&keys);
        store::write_json(&cards_path(), &unbrowse_files::CARDS, &[CardInfo { label: "visa".into(), last4: "4242".into(), created: 1, code: false }]).unwrap();
        keep.put(Slot::Card, CARDS, LIMITS, "not limits").unwrap();
        let said = set_card_limit(&keep, "visa", "shop.example", 5.0, 5.0, "You");
        assert!(said.is_err(), "{said:?}");
        assert_eq!(keep.get(Slot::Card, CARDS, LIMITS).unwrap().as_str(), "not limits", "left for the owner to mend");
    }

    #[test]
    fn a_limit_is_kept_sealed_and_counts_what_it_lets_through() {
        let _one = crate::testchain::one_at_a_time_blocking();
        let home = store::scratch_home("card-limits");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let keep = Keep::sealed(&keys, &home).unwrap();
        store::write_json(&cards_path(), &unbrowse_files::CARDS, &[CardInfo { label: "visa".into(), last4: "4242".into(), created: 1, code: false }]).unwrap();
        assert!(set_card_limit(&keep, "amex", "shop.example", 5.0, 5.0, "You").unwrap_err().contains("no card"));
        assert!(set_card_limit(&keep, "visa", "shop.example", 50.0, 10.0, "You").unwrap_err().contains("under"));
        set_card_limit(&keep, "visa", "https://www.shop.example/checkout", 50.0, 80.0, "You").unwrap();
        let now = 86_400 * 10;
        assert_eq!(take_from_limit(&keep, "visa", "shop.example", Some(50.0), now), Ok(()));
        assert!(take_from_limit(&keep, "visa", "shop.example", Some(40.0), now).is_err(), "the day's room is counted");
        assert_eq!(take_from_limit(&keep, "visa", "other.example", Some(1.0), now), Err(None), "another site has its own");
        assert_eq!(take_from_limit(&keep, "amex", "shop.example", Some(1.0), now), Err(None), "another card has its own");
        let file = std::fs::read_to_string(sealed_file(&home, false)).unwrap();
        assert!(!file.contains("per_payment") && !file.contains("shop.example\\\"") , "the limits are sealed, not in the clear");
        set_card_limit(&keep, "visa", "shop.example", 0.0, 0.0, "You").unwrap();
        assert_eq!(take_from_limit(&keep, "visa", "shop.example", Some(1.0), now), Err(None), "a limit taken away asks again");
        set_card_limit(&keep, "visa", "shop.example", 5.0, 5.0, "You").unwrap();
        let _ = remove_card(&keep, "visa", "You");
        assert!(card_limits(&keep).is_empty(), "a card removed takes its limits with it");
    }

    /// Each exporter names its columns its own way; the columns are found by what their names say. These are the
    /// header rows real exports start with.
    #[test]
    fn an_export_is_read_whoever_wrote_it() {
        let exports = [
            "name,url,username,password,note\nGitHub,https://github.com/login,me,pw1,\n",
            "\"url\",\"username\",\"password\",\"httpRealm\",\"formActionOrigin\",\"guid\"\n\"https://github.com\",\"me\",\"pw1\",,\"https://github.com\",\"{1}\"\n",
            "Title,URL,Username,Password,Notes,OTPAuth\nGitHub,https://github.com/,me,pw1,,\n",
            "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,GitHub,,,0,https://github.com/,me,pw1,\n",
            "url,username,password,totp,extra,name,grouping,fav\nhttps://github.com,me,pw1,,,GitHub,,0\n",
            "\u{feff}\"Account\",\"Login Name\",\"Password\",\"Web Site\",\"Comments\"\n\"GitHub\",\"me\",\"pw1\",\"github.com\",\"\"\n",
            "username,username2,username3,title,password,note,url,category,otpSecret\nme,,,GitHub,pw1,,https://www.github.com,,\n",
        ];
        for text in exports {
            let (logins, skipped) = read_export(text).unwrap();
            assert_eq!(logins, [Exported { site: "github.com".into(), account: "me".into(), password: "pw1".into(), code: None }], "{text}");
            assert!(skipped.is_empty(), "{text}");
        }
    }

    /// A password keeps every character, quotes and commas included; rows that can't be logins are counted, not kept.
    #[test]
    fn an_export_keeps_passwords_whole_and_counts_what_it_leaves() {
        let text = "url,username,password\nhttps://a.example,me,\"p,w \"\"x\"\" \"\nandroid://app,me,pw\nhttps://b.example,,pw\nhttps://c.example,me,\n\n";
        let (logins, skipped) = read_export(text).unwrap();
        assert_eq!(logins, [Exported { site: "a.example".into(), account: "me".into(), password: "p,w \"x\" ".into(), code: None }]);
        assert_eq!(skipped.iter().map(|(_, n)| n).sum::<usize>(), 3);
        assert!(read_export("title,notes\nx,y\n").is_err(), "not a password export");
    }

    /// The code key comes along whichever column an exporter keeps it in, as the address or the bare secret.
    #[test]
    fn an_export_keeps_the_code_key_beside_the_login() {
        let exports = [
            ("Title,URL,Username,Password,Notes,OTPAuth\nGitHub,https://github.com/,me,pw1,,otpauth://totp/GitHub:me?secret=GEZDGNBV\n", "otpauth://totp/GitHub:me?secret=GEZDGNBV"),
            ("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,GitHub,,,0,https://github.com/,me,pw1,GEZDGNBV\n", "GEZDGNBV"),
            ("username,username2,username3,title,password,note,url,category,otpSecret\nme,,,GitHub,pw1,,https://www.github.com,,GEZDGNBV\n", "GEZDGNBV"),
        ];
        for (text, key) in exports {
            let (logins, _) = read_export(text).unwrap();
            assert_eq!(logins[0].code.as_deref(), Some(key), "{text}");
            assert_eq!(logins[0].password, "pw1", "{text}");
        }
    }

    /// A password manager's JSON export reads too: Bitwarden's items and the Credential Exchange Format's accounts.
    /// A passkey-only entry is left to the passkey import, and an encrypted export is refused rather than misread.
    #[test]
    fn a_json_export_is_read_whoever_wrote_it() {
        let bitwarden = r#"{"encrypted":false,"folders":[],"items":[
            {"type":1,"name":"GitHub","login":{"uris":[{"match":null,"uri":"androidapp://com.github"},{"uri":"https://github.com/login"}],"username":"me","password":"p,w \"1","totp":"GEZDGNBV","fido2Credentials":[]}},
            {"type":1,"name":"Passkey only","login":{"uris":[{"uri":"https://shop.example"}],"username":"me","password":null,"fido2Credentials":[{"rpId":"shop.example"}]}},
            {"type":2,"name":"A note","secureNote":{"type":0}},
            {"type":1,"name":"No address","login":{"uris":[],"username":"me","password":"x"}}]}"#;
        let (logins, skipped) = read_export(bitwarden).unwrap();
        assert_eq!(logins, [Exported { site: "github.com".into(), account: "me".into(), password: "p,w \"1".into(), code: Some("GEZDGNBV".into()) }]);
        assert_eq!(skipped, [("no address on the web (an app's login or a note)".to_string(), 1)]);

        let cxf = r#"{"version":{"major":1,"minor":0},"exporterRpId":"manager.example","accounts":[{"id":"a","username":"me","items":[
            {"id":"i1","title":"GitHub","scope":{"urls":["https://github.com/"]},"credentials":[
                {"type":"basic-auth","username":{"fieldType":"string","value":"me"},"password":{"fieldType":"concealed-string","value":"pw1"}},
                {"type":"passkey","rpId":"github.com"}]}]}]}"#;
        let (logins, skipped) = read_export(cxf).unwrap();
        assert_eq!(logins, [Exported { site: "github.com".into(), account: "me".into(), password: "pw1".into(), code: None }]);
        assert!(skipped.is_empty());

        assert!(read_export(r#"{"encrypted":true,"encKeyValidation_DO_NOT_EDIT":"x","data":"y"}"#).unwrap_err().contains("encrypted"));
        assert_eq!(read_export(r#"{"credentialId":"x","relyingParty":"a.example","privateKey":"k"}"#).unwrap().0, []);
        assert!(is_json(" {") && is_json("\u{feff}[") && !is_json("url,username,password\n"));
    }

    /// External security review round 3, 2026-11-04. Any site can claim an app on its own page, so the owner sees each
    /// app and the site it maps to before an import keeps any of their logins; a no keeps the web logins only.
    #[test]
    fn an_app_login_comes_in_only_under_a_site_the_owner_confirmed() {
        let home = crate::store::scratch_home("vault-apps-confirmed");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let keep = Keep::sealed(&keys, &home).unwrap();
        let csv = "name,url,username,password,note\nRide,androidapp://com.ride.passenger,me,pw1,\nShop,https://shop.example/login,me,pw2,\n";
        let mut shown = Vec::new();
        let done = import_confirming_apps(&keep, csv, "You", &mut |_: &App| Some("thief.example".into()), &mut |q| {
            shown.push(q);
            Err("no".into())
        })
        .unwrap();
        assert_eq!(done.added, 1, "the web login only");
        assert!(list().iter().all(|l| l.site != "thief.example"), "the app's login didn't go to the site that claimed it");
        assert!(shown.len() == 1 && shown[0].contains("com.ride.passenger") && shown[0].contains("thief.example"), "the owner saw the mapping: {shown:?}");
        let done = import_confirming_apps(&keep, csv, "You", &mut |_: &App| Some("ride.example".into()), &mut |_| Ok(())).unwrap();
        assert_eq!(done.added, 1);
        assert!(list().iter().any(|l| l.site == "ride.example"), "on the owner's yes");
        let _ = std::fs::remove_dir_all(home);
    }

    /// The owner judges each app on its own: a yes to one app's website is never a yes to another's, and each question
    /// says whether the export kept the app's certificate or matched it by package name alone.
    #[test]
    fn the_owner_can_allow_one_app_login_and_refuse_another() {
        let home = crate::store::scratch_home("vault-apps-each");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let keep = Keep::sealed(&keys, &home).unwrap();
        let csv = "name,url,username,password,note\nRide,androidapp://com.ride.passenger,me,pw1,\nBank,androidapp://com.bank.app,me,pw2,\n";
        let mut site = |a: &App| Some(if a.package == "com.ride.passenger" { "ride.example" } else { "claims-bank.example" }.to_string());
        let mut shown = Vec::new();
        let done = import_confirming_apps(&keep, csv, "You", &mut site, &mut |q| {
            let yes = q.contains("com.ride.passenger");
            shown.push(q);
            if yes { Ok(()) } else { Err("no".into()) }
        })
        .unwrap();
        assert_eq!(shown.len(), 2, "one question per app: {shown:?}");
        assert!(shown.iter().all(|q| q.contains("no signing certificate")), "the question says the match was by package alone: {shown:?}");
        assert_eq!(done.added, 1, "the app the owner allowed");
        assert!(list().iter().any(|l| l.site == "ride.example"));
        assert!(list().iter().all(|l| l.site != "claims-bank.example"), "the refused app's login stayed out");
        let _ = std::fs::remove_dir_all(home);
    }

    /// A login saved in an app comes in under the site that app's logins belong to, as each exporter writes the app
    /// (with its signing certificate's hash, or the package alone). An app no site claims is counted, not kept, and a
    /// login with a page on the web keeps that page's site whatever app it was saved in too.
    #[test]
    fn a_login_saved_in_an_app_comes_in_under_the_site_that_claims_the_app() {
        let cert = "H03VTDHFbjK-A0vxIR-qUcSfcGGo6s4EQpl1v8ClN4s=";
        let mut asked = Vec::new();
        let mut apps = |a: &App| {
            asked.push(a.clone());
            (a.package == "com.ride.passenger").then(|| "ride.example".to_string())
        };
        let csv = format!("name,url,username,password,note\nRide,android://{cert}@com.ride.passenger/,me,pw1,\nOther,android://{cert}@com.other.app/,me,pw2,\n");
        let (logins, skipped) = read_export_with(&csv, &mut apps).unwrap();
        assert_eq!(logins, [Exported { site: "ride.example".into(), account: "me".into(), password: "pw1".into(), code: None }]);
        assert_eq!(skipped, [(UNCLAIMED_APP.to_string(), 1)]);
        assert_eq!(asked[0], App { package: "com.ride.passenger".into(), cert: cert_of(cert) });
        assert_eq!(asked[0].cert.as_ref().map(Vec::len), Some(32));

        let bitwarden = r#"{"items":[
            {"login":{"uris":[{"uri":"androidapp://com.ride.passenger"}],"username":"me","password":"pw1"}},
            {"login":{"uris":[{"uri":"androidapp://com.ride.passenger"},{"uri":"https://shop.example/login"}],"username":"me","password":"pw2"}}]}"#;
        let (logins, _) = read_export_with(bitwarden, &mut |a: &App| (a.cert.is_none() && a.package == "com.ride.passenger").then(|| "ride.example".to_string())).unwrap();
        assert_eq!(logins.iter().map(|l| l.site.as_str()).collect::<Vec<_>>(), ["ride.example", "shop.example"]);

        let cxf = r#"{"accounts":[{"items":[{"scope":{"urls":["android://com.ride.passenger"]},"credentials":[
            {"type":"basic-auth","username":{"value":"me"},"password":{"value":"pw3"}}]}]}]}"#;
        let (logins, _) = read_export_with(cxf, &mut |a: &App| (a.package == "com.ride.passenger").then(|| "ride.example".to_string())).unwrap();
        assert_eq!(logins.iter().map(|l| l.site.as_str()).collect::<Vec<_>>(), ["ride.example"]);

        // A site that comes back as no address at all is not taken.
        assert_eq!(read_export_with(&csv, &mut |_| Some("nodots".into())).unwrap().1, [(UNCLAIMED_APP.to_string(), 2)]);
        // Offline, an app's login is left out rather than guessed at.
        assert_eq!(read_export(&csv).unwrap().1, [(UNCLAIMED_APP.to_string(), 2)]);
        assert!(app_of("android://not base64@com.ride.passenger").is_some_and(|a| a.cert.is_none()));
        assert!(app_of("android://@").is_none() && app_of("androidapp://nodots").is_none() && app_of("https://ride.example").is_none());
    }

    /// `vault.unlock-once`, without migrating: a stored login whose secret an older build kept in the system's keystore
    /// isn't read. The vault holds nothing for it, so the mask passes it over; using it says to import it again; and a
    /// sealed secret that doesn't open is still an error, never passed over.
    #[test]
    fn a_login_kept_only_in_the_keystore_is_never_read() {
        store::scratch_home("vault-unsealed");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let login = |account: &str| Login { site: "shop.example".into(), account: account.into(), kind: "stored".into(), counter: 0, created: 0, code: false, derivation: DERIVATION };
        store::write_json(&path(), &unbrowse_files::VAULT, &vec![login("old"), login("new")]).unwrap();
        let keep = Keep::sealed_beside_keystore(&keys, &store::home()).unwrap();
        keep.put(Slot::Password, "shop.example", "new", "battery staple").unwrap();
        let r = |account: &str| Ref { site: "shop.example".into(), account: account.into(), new: false, code: false };
        assert!(held_secret(&keep, &keys, &r("old")).unwrap().is_none(), "nothing held, nothing to hide");
        assert_eq!(held_secret(&keep, &keys, &r("new")).unwrap().unwrap().as_str(), "battery staple");
        assert!(secret_for(&keep, &keys, &r("old")).unwrap_err().contains("import the login again"));
        // A record that doesn't open is damage, and the mask refuses rather than passing it over.
        let mut all: BTreeMap<String, String> = store::read_json(&sealed_file(&store::home(), true), &unbrowse_files::VAULT_SEALED);
        let moved = all[&sealed_name(Slot::Password, "shop.example", "new")].clone();
        all.insert(sealed_name(Slot::Password, "shop.example", "old"), moved);
        store::write_json(&sealed_file(&store::home(), true), &unbrowse_files::VAULT_SEALED, &all).unwrap();
        assert!(held_secret(&keep, &keys, &r("old")).unwrap_err().contains("damaged"));
    }

    /// A dev build (its root key in a file) and a release build (in the system's keystore) share a folder but not a
    /// root key: each seals into a file of its own, so neither's secrets are written over by, or fail to open for,
    /// the other.
    #[test]
    fn a_dev_build_and_a_release_build_seal_apart() {
        let dir = std::env::temp_dir().join(format!("unbrowse-vault-apart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (dev_keys, release_keys) = (unbrowse_core::MemoryStore::default(), unbrowse_core::MemoryStore::default());
        unbrowse_core::load_or_create(&dev_keys).unwrap();
        unbrowse_core::load_or_create(&release_keys).unwrap();
        let dev = Keep::sealed(&dev_keys, &dir).unwrap();
        let release = Keep::sealed_beside_keystore(&release_keys, &dir).unwrap();
        dev.put(Slot::Password, "shop.example", "me", "dev secret").unwrap();
        release.put(Slot::Password, "shop.example", "me", "release secret").unwrap();
        assert_eq!(dev.get(Slot::Password, "shop.example", "me").unwrap().as_str(), "dev secret");
        assert_eq!(release.get(Slot::Password, "shop.example", "me").unwrap().as_str(), "release secret");
        assert!(dir.join("vault.sealed.json").exists() && dir.join("vault.sealed.keychain.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A node with its root key in a file seals each secret under that key: the file holds no secret in the clear, a
    /// record opens only as the secret it was sealed for, and removing a login removes its secrets.
    #[test]
    fn sealed_secrets_round_trip_with_nothing_in_the_clear() {
        let dir = std::env::temp_dir().join(format!("unbrowse-vault-sealed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let keep = Keep::sealed(&keys, &dir).unwrap();
        assert!(keep.is_sealed());
        keep.put(Slot::Password, "github.com", "me", "correct horse").unwrap();
        keep.put(Slot::Code, "github.com", "me", "GEZDGNBV").unwrap();
        assert_eq!(keep.get(Slot::Password, "github.com", "me").unwrap().as_str(), "correct horse");
        assert_eq!(keep.get(Slot::Code, "github.com", "me").unwrap().as_str(), "GEZDGNBV");
        let disk = std::fs::read_to_string(sealed_file(&dir, false)).unwrap();
        assert!(!disk.contains("correct horse") && !disk.contains("GEZDGNBV"), "{disk}");

        // A record moved onto another login doesn't open.
        let mut all: BTreeMap<String, String> = store::read_json(&sealed_file(&dir, false), &unbrowse_files::VAULT_SEALED);
        let moved = all[&sealed_name(Slot::Password, "github.com", "me")].clone();
        all.insert(sealed_name(Slot::Password, "github.com", "you"), moved);
        store::write_json(&sealed_file(&dir, false), &unbrowse_files::VAULT_SEALED, &all).unwrap();
        assert!(keep.get(Slot::Password, "github.com", "you").unwrap_err().contains("damaged"));

        // Another node's key opens nothing.
        let other = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&other).unwrap();
        assert!(Keep::sealed(&other, &dir).unwrap().get(Slot::Password, "github.com", "me").is_err());

        keep.delete(Slot::Password, "github.com", "me");
        keep.delete(Slot::Code, "github.com", "me");
        let left: BTreeMap<String, String> = store::read_json(&sealed_file(&dir, false), &unbrowse_files::VAULT_SEALED);
        assert!(!left.keys().any(|k| k.ends_with("|github.com|me")), "{left:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A vault index written before code keys existed still reads, each login without one.
    #[test]
    fn an_older_vault_index_reads() {
        let old = r#"[{"site":"github.com","account":"me","kind":"stored","counter":0,"created":1}]"#;
        let logins: Vec<Login> = serde_json::from_str(old).unwrap();
        assert!(!logins[0].code);
    }

    #[test]
    fn a_reference_names_a_site_and_an_account() {
        assert_eq!(Ref::parse("vault:GitHub.com:me@x.com"), Some(Ref { site: "github.com".into(), account: "me@x.com".into(), new: false, code: false }));
        let code = Ref::parse("vault:code:github.com:me").unwrap();
        assert!(code.code && !code.new);
        assert_eq!(code.name(), "vault:code:github.com:me");
        assert_eq!(Ref::parse("vault:new:shop.example:me").map(|r| (r.new, r.name())), Some((true, "vault:shop.example:me".into())));
        assert_eq!(Ref::parse("vault:github.com:team:admin").map(|r| r.account), Some("team:admin".into()));
        assert_eq!(Ref::parse("vault:example.org:2083:admin").map(|r| (r.site, r.account)), Some(("example.org:2083".into(), "admin".into())));
        assert_eq!(Ref::parse("vault:github.com:"), None);
        assert_eq!(Ref::parse("vault:localhost:me"), None, "a site has a dot");
        assert_eq!(Ref::parse("hunter22"), None);
        // A service on a non-default port: the port belongs to the site, not the account (#26).
        let p = Ref::parse("vault:example.org:2083:admin").unwrap();
        assert_eq!((p.site.as_str(), p.account.as_str(), p.port()), ("example.org:2083", "admin", Some(2083)));
        assert_eq!(p.name(), "vault:example.org:2083:admin");
        assert_eq!(Ref::parse("vault:github.com:me").unwrap().port(), None);
    }

    /// A route whose steps are at `urls`, each taking the secret input `pw` (the last is the target).
    fn route_sending_pw(urls: &[&str], default: Option<&str>) -> store::Route {
        let steps: Vec<serde_json::Value> = urls
            .iter()
            .enumerate()
            .map(|(n, u)| {
                serde_json::json!({ "exchange": n, "method": "POST", "status": 200, "url": u, "needs_browser": false, "sets_cookie": false,
                    "fields": [{ "loc": { "in": "header", "key": "x-pw" }, "class": "input", "name": "pw", "secret": true, "default": default }] })
            })
            .collect();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({ "steps": steps, "provisional": false })).unwrap();
        store::Route::from_graph("r".into(), "sign in".into(), "https://example.com/".into(), graph).unwrap()
    }

    fn with_login() -> unbrowse_core::MemoryStore {
        store::scratch_home("vault-fill");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let login = Login { site: "example.com".into(), account: "me".into(), kind: "derived".into(), counter: 0, created: 0, code: false, derivation: DERIVATION };
        store::write_json(&path(), &unbrowse_files::VAULT, &vec![login]).unwrap();
        keys
    }

    fn given(v: &str) -> std::collections::HashMap<String, String> {
        std::collections::HashMap::from([("pw".to_string(), v.to_string())])
    }

    #[test]
    fn a_vault_login_goes_only_to_requests_on_its_own_site() {
        let keys = with_login();
        let ok = route_sending_pw(&["https://auth.example.com/session", "https://example.com/api"], None);
        let filled = fill_inputs(&Keep::sealed(&keys, &store::home()).unwrap(), &keys, &ok, &given("vault:example.com:me"), false, false).unwrap();
        assert_ne!(filled.values["pw"], "vault:example.com:me");
        assert_eq!(filled.secrets, [(filled.values["pw"].clone(), "vault:example.com:me".to_string())]);
        // The input is held to the site on whatever graph the call sends, a heal's included (`with_held_inputs`).
        assert_eq!(filled.held, ["pw"]);
        // An earlier step on another site would carry it there: refused, though the target is the login's.
        let off = route_sending_pw(&["https://auth.other.example/session", "https://example.com/api"], None);
        assert!(fill_inputs(&Keep::sealed(&keys, &store::home()).unwrap(), &keys, &off, &given("vault:example.com:me"), false, false).is_err());
        // Never in the clear.
        let plain = route_sending_pw(&["http://example.com/api"], None);
        assert!(fill_inputs(&Keep::sealed(&keys, &store::home()).unwrap(), &keys, &plain, &given("vault:example.com:me"), false, false).is_err());
    }

    /// A route another node listed decides which of its inputs is a secret and where it goes: a password it marks
    /// secret could land in a field the site shows. So no vault login fills it, whatever it marks, on the login's own
    /// site included; the same route learned here takes it.
    #[test]
    fn a_strangers_route_never_decides_where_a_vault_login_goes() {
        let keys = with_login();
        let mut stranger = route_sending_pw(&["https://example.com/api"], None);
        stranger.fetched = Some(store::Fetched { entry_id: "0x1".into(), route_id: "r".into(), agent_id: "7".into(), content_id: "sha256:ab".into(), listed_as: "sign in".into(), fetched_at: 1 });
        let refused = fill_inputs(&Keep::sealed(&keys, &store::home()).unwrap(), &keys, &stranger, &given("vault:example.com:me"), false, false);
        assert!(refused.as_ref().is_err_and(|e| e.contains("came from another node")), "{:?}", refused.map(|f| f.held));
        let own = route_sending_pw(&["https://example.com/api"], None);
        assert!(fill_inputs(&Keep::sealed(&keys, &store::home()).unwrap(), &keys, &own, &given("vault:example.com:me"), false, false).is_ok(), "the node's own route");
    }

    #[test]
    fn a_bound_vault_default_is_checked_like_a_given_one() {
        let keys = with_login();
        let off = route_sending_pw(&["https://auth.other.example/session", "https://example.com/api"], Some("vault:example.com:me"));
        assert!(fill_inputs(&Keep::sealed(&keys, &store::home()).unwrap(), &keys, &off, &Default::default(), false, false).is_err());
        let on = route_sending_pw(&["https://example.com/api"], Some("vault:example.com:me"));
        assert!(fill_inputs(&Keep::sealed(&keys, &store::home()).unwrap(), &keys, &on, &Default::default(), false, false).is_ok());
    }

    #[test]
    fn a_vault_login_goes_only_to_a_socket_on_its_own_site() {
        let keys = with_login();
        let mut r = route_sending_pw(&["https://example.com/api"], None);
        r.graph.steps.clear();
        r.socket = Some(store::SocketRoute {
            url: "wss://chat.other.example/ws".into(),
            headers: vec![],
            opening: vec![],
            server_first: false,
            frame: vec![store::Piece::Input { name: "pw".into() }],
        });
        assert!(fill_inputs(&Keep::sealed(&keys, &store::home()).unwrap(), &keys, &r, &given("vault:example.com:me"), false, false).is_err());
        r.socket.as_mut().unwrap().url = "wss://chat.example.com/ws".into();
        assert!(fill_inputs(&Keep::sealed(&keys, &store::home()).unwrap(), &keys, &r, &given("vault:example.com:me"), false, false).is_ok());
    }

    /// A home with the card `visa` in a vault sealed under a fresh root key, so no test touches the Keychain.
    fn with_card() -> (unbrowse_core::MemoryStore, Keep) {
        let keys = with_login();
        let keep = Keep::sealed(&keys, &store::home()).unwrap();
        let card = unbrowse_core::Card::read("4242 4242 4242 4242", "12/28", None, "Ada Lovelace").unwrap();
        add_card(&keep, "visa", &card, false, "You").unwrap();
        (keys, keep)
    }

    /// The same, with the owner keeping card security codes and `visa` kept with its code, 123.
    fn with_card_and_code() -> (unbrowse_core::MemoryStore, Keep) {
        let keys = with_login();
        let keep = Keep::sealed(&keys, &store::home()).unwrap();
        set_keep_codes(&keep, Some(true), "You").unwrap();
        let card = unbrowse_core::Card::read("4242 4242 4242 4242", "12/28", Some("123"), "Ada Lovelace").unwrap();
        assert!(add_card(&keep, "visa", &card, true, "You").unwrap().code);
        (keys, keep)
    }

    /// Whether the card index says a card holds its code (the sealed card itself is read through the vault).
    fn code_on_disk() -> bool {
        cards().iter().any(|c| c.code)
    }

    fn kept_card(keep: &Keep) -> unbrowse_core::Card {
        serde_json::from_str(keep.get(Slot::Card, CARDS, "visa").unwrap().as_str()).unwrap()
    }

    /// With the owner's choice off, the default, a card given with its code is kept without it: nothing stores one.
    #[test]
    fn with_the_setting_off_nothing_stores_a_code() {
        let (_keys, keep) = with_card();
        assert!(!store::load_settings().keep_card_codes, "off by default");
        let card = unbrowse_core::Card::read("5555 5555 5555 4444", "01/30", Some("123"), "Ada Lovelace").unwrap();
        let info = add_card(&keep, "mc", &card, store::load_settings().keep_card_codes, "You").unwrap();
        assert!(!info.code);
        let kept: unbrowse_core::Card = serde_json::from_str(keep.get(Slot::Card, CARDS, "mc").unwrap().as_str()).unwrap();
        assert!(!kept.has_code() && kept.cvv.is_empty());
        assert!(!keep.get(Slot::Card, CARDS, "mc").unwrap().contains("cvv"));
        assert!(!code_on_disk());
    }

    /// Turning the choice off forgets every kept code at once, not at the next start, and keeps the rest of each card.
    #[test]
    fn switching_it_off_forgets_the_stored_codes() {
        let (_keys, keep) = with_card_and_code();
        assert_eq!(kept_card(&keep).cvv, "123");
        let off = set_keep_codes(&keep, Some(false), "You").unwrap();
        assert_eq!(off, CardCodes { on: false, forgotten: vec!["visa".into()] });
        assert!(!store::load_settings().keep_card_codes);
        let kept = kept_card(&keep);
        assert!(!kept.has_code() && !keep.get(Slot::Card, CARDS, "visa").unwrap().contains("123"));
        assert_eq!((kept.number.as_str(), kept.name.as_str()), ("4242424242424242", "Ada Lovelace"));
        assert!(!code_on_disk());
        assert_eq!(set_keep_codes(&keep, Some(false), "You").unwrap().forgotten, Vec::<String>::new(), "nothing left to forget");
    }

    /// A node from before the choice kept every card's code. As it starts with the choice off it forgets them and says
    /// so once, with how to choose to keep them; with the choice on it leaves them.
    #[test]
    fn a_code_kept_before_the_choice_is_forgotten_at_start_and_said_once() {
        let (_keys, keep) = with_card();
        let old = r#"{"number":"4242424242424242","expiry":"12/28","cvv":"123","name":"Ada Lovelace"}"#;
        keep.put(Slot::Card, CARDS, "visa", old).unwrap();
        forget_unchosen_codes(&keep, true);
        assert_eq!(kept_card(&keep).cvv, "123", "the owner chose to keep them");
        forget_unchosen_codes(&keep, false);
        assert!(!kept_card(&keep).has_code() && !code_on_disk());
        forget_unchosen_codes(&keep, false);
        let told: Vec<_> = store::read_activity(50).into_iter().filter(|a| a.what.contains("security codes")).collect();
        assert_eq!(told.len(), 1, "said once");
        let note = told[0].note.clone().unwrap_or_default();
        assert!(note.contains("visa") && note.contains("Keep card security codes") && note.contains("vault card codes on") && note.contains("PCI DSS"), "{note}");
    }

    /// With the choice off a checkout is told to ask the owner for the code, even from a card that somehow still holds
    /// one, and a route call naming it is refused before the owner is asked. With it on, the kept code is given.
    #[test]
    fn with_it_off_checkout_asks_for_the_code() {
        let (keys, keep) = with_card();
        let why = card_value(&keep, &card_ref("vault:card:visa:cvv"), false).unwrap_err();
        assert!(why.contains("ask_owner"), "{why}");
        let old = r#"{"number":"4242424242424242","expiry":"12/28","cvv":"123","name":"Ada Lovelace"}"#;
        keep.put(Slot::Card, CARDS, "visa", old).unwrap();
        assert!(card_value(&keep, &card_ref("vault:card:visa:cvv"), false).unwrap_err().contains("ask_owner"), "off, even one still held isn't given");
        let route = route_sending_pw(&["https://example.com/api"], None);
        let code = given("vault:card:visa:cvv");
        let why = check_cards(&route, &code, false).unwrap_err();
        assert!(why.contains("security code") && why.contains("ask_owner"), "{why}");
        assert!(fill_inputs(&keep, &keys, &route, &code, true, false).is_err(), "approved or not");
        // On, with the card kept with its code, the call pays with it.
        let (keys, keep) = with_card_and_code();
        assert_eq!(card_value(&keep, &card_ref("vault:card:visa:cvv"), true).unwrap().as_str(), "123");
        assert!(check_cards(&route, &code, true).is_ok());
        let filled = fill_inputs(&keep, &keys, &route, &code, true, true).unwrap();
        assert_eq!(filled.values["pw"], "123");
        assert_eq!(filled.held, ["pw"], "a card's input is held to the route's site too");
    }

    fn card_ref(s: &str) -> CardRef {
        CardRef::parse(s).unwrap()
    }

    #[test]
    fn a_card_reference_names_a_label_and_a_field() {
        assert_eq!(CardRef::parse("vault:card:Visa:number").map(|r| r.name()), Some("vault:card:visa:number".into()));
        assert_eq!(CardRef::parse("vault:card:work-amex:cvv").map(|r| r.field), Some(unbrowse_core::CardField::Cvv));
        assert_eq!(CardRef::parse("vault:card:visa:pin"), None);
        assert_eq!(CardRef::parse("vault:card:vi.sa:number"), None, "a label reads one way only");
        assert_eq!(CardRef::parse("vault:card:visa"), None);
        assert_eq!(Ref::parse("vault:card:visa:number"), None, "never a login");
        assert!(is_ref("vault:card:visa:number") && is_ref("vault:github.com:me") && !is_ref("4242424242424242"));
    }

    #[test]
    fn a_card_is_kept_sealed_and_the_index_holds_only_its_last_four() {
        let (_keys, keep) = with_card();
        assert_eq!(cards().iter().map(|c| (c.label.as_str(), c.last4.as_str())).collect::<Vec<_>>(), [("visa", "4242")]);
        let index = std::fs::read_to_string(cards_path()).unwrap();
        let sealed = std::fs::read_to_string(sealed_file(&store::home(), false)).unwrap();
        for disk in [&index, &sealed] {
            assert!(!disk.contains("4242424242424242") && !disk.contains("12/28") && !disk.contains("Ada"), "{disk}");
        }
        assert_eq!(card_value(&keep, &card_ref("vault:card:visa:number"), false).unwrap().as_str(), "4242424242424242");
        assert_eq!(card_value(&keep, &card_ref("vault:card:visa:year"), false).unwrap().as_str(), "2028");
        assert_eq!(card_ref("vault:card:visa:cvv").shown().unwrap(), "visa (card ending 4242)");
        let again = unbrowse_core::Card::read("5555 5555 5555 4444", "01/30", Some("999"), "").unwrap();
        assert!(add_card(&keep, "visa", &again, false, "You").is_err(), "one card per label");
        assert!(add_card(&keep, "my card", &again, false, "You").is_err(), "a label reads one way only");
        remove_card(&keep, "visa", "You").unwrap();
        assert!(cards().is_empty());
        assert!(card_value(&keep, &card_ref("vault:card:visa:number"), false).is_err());
    }

    #[test]
    fn a_card_goes_in_only_on_an_approved_call_to_the_routes_own_site() {
        let (keys, keep) = with_card();
        let on = route_sending_pw(&["https://pay.example.com/charge", "https://example.com/api"], None);
        let card = given("vault:card:visa:number");
        assert_eq!(cards_in(&on, &card), [card_ref("vault:card:visa:number")]);
        assert!(fill_inputs(&keep, &keys, &on, &card, false, false).is_err(), "nobody approved it");
        let filled = fill_inputs(&keep, &keys, &on, &card, true, false).unwrap();
        assert_eq!(filled.values["pw"], "4242424242424242");
        assert_eq!(filled.secrets, [("4242424242424242".to_string(), "vault:card:visa:number".to_string())]);
        // A step on another site would carry it there, approved or not.
        let off = route_sending_pw(&["https://collect.other.example/charge", "https://example.com/api"], None);
        assert!(fill_inputs(&keep, &keys, &off, &card, true, false).is_err());
        let plain = route_sending_pw(&["http://example.com/api"], None);
        assert!(fill_inputs(&keep, &keys, &plain, &card, true, false).is_err());
        // Read before the owner is asked: a call the rules refuse never asks them.
        assert!(check_cards(&on, &card, false).is_ok());
        assert!(check_cards(&off, &card, false).is_err() && check_cards(&plain, &card, false).is_err());
        assert!(check_cards(&on, &given("vault:card:amex:number"), false).is_err(), "a card the vault doesn't hold");
        assert!(check_cards(&on, &std::collections::HashMap::from([("qty".to_string(), "vault:card:visa:number".to_string())]), false).is_err(), "no such input");
        // A card the route was learned with is a card the call pays with, asked about like a given one.
        let bound = route_sending_pw(&["https://example.com/api"], Some("vault:card:visa:number"));
        assert_eq!(cards_in(&bound, &Default::default()).len(), 1);
        assert!(fill_inputs(&keep, &keys, &bound, &Default::default(), false, false).is_err());
    }

    /// Each process keeps the whole file, so a write that isn't held takes back what another just added: a login the
    /// owner saved is gone from the index, or its sealed password is (TRUST-12.2).
    #[test]
    fn two_writers_of_the_vault_lose_nothing() {
        let keys = with_login();
        let home = store::home();
        std::thread::scope(|t| {
            for w in 0..4 {
                let (keys, home) = (&keys, &home);
                t.spawn(move || {
                    store::use_home(home);
                    let keep = Keep::sealed(keys, home).unwrap();
                    for i in 0..10 {
                        add(&keep, "two-writers.example", &format!("user{w}-{i}"), "stored", Some("kept"), "You").unwrap();
                    }
                });
            }
        });
        let keep = Keep::sealed(&keys, &home).unwrap();
        let saved: Vec<Login> = list().into_iter().filter(|l| l.site == "two-writers.example").collect();
        assert_eq!(saved.len(), 40, "every login is in the index");
        for l in saved {
            assert_eq!(keep.get(Slot::Password, &l.site, &l.account).unwrap().as_str(), "kept", "and its password was kept");
        }
    }

    /// A login goes to its own site and its subdomains, never a lookalike.
    #[test]
    fn a_login_fits_only_its_own_site() {
        let r = Ref::parse("vault:github.com:me").unwrap();
        assert!(r.fits("github.com") && r.fits("api.github.com"));
        assert!(!r.fits("github.com.evil.example") && !r.fits("gitlab.com"));
        // A port-scoped login fills only its exact origin: that port, https, that site (#26).
        let p = Ref::parse("vault:example.org:2083:admin").unwrap();
        assert!(p.fits_page("https://example.org:2083/"), "its own origin");
        assert!(p.fits_page("https://www.example.org:2083/login"), "same site, same port");
        assert!(!p.fits_page("https://example.org/"), "default port is a different origin");
        assert!(!p.fits_page("https://example.org:2096/"), "another port");
        assert!(!p.fits_page("http://example.org:2083/"), "another scheme");
        assert!(!p.fits_page("https://evil.example:2083/"), "another site");
        // A plain login fills any page on its site, any port.
        let g = Ref::parse("vault:github.com:me").unwrap();
        assert!(g.fits_page("https://github.com/") && g.fits_page("https://api.github.com:8443/"));
    }

    #[test]
    fn a_port_scoped_login_fills_only_that_https_origin() {
        let r = Ref::parse("vault:example.org:2083:admin").unwrap();
        assert!(r.fits_page("https://example.org:2083/"));
        assert!(!r.fits_page("https://example.org/"));
        assert!(!r.fits_page("https://example.org:2082/"));
        assert!(!r.fits_page("https://example.net:2083/"));
        assert!(!r.fits_page("http://example.org:2083/"));
    }

    /// A login is typed only into a page of its site that came over https: on a cleartext page anyone on the way
    /// writes the form.
    #[test]
    fn a_vault_login_is_never_typed_into_a_cleartext_page() {
        let r = Ref::parse("vault:shop.example:me").unwrap();
        assert!(r.fits_page("https://shop.example/login") && r.fits_page("https://www.shop.example/login"));
        assert!(!r.fits_page("http://shop.example/login"));
        assert!(!r.fits_page("https://shop.example.evil.example/login") && !r.fits_page("about:blank") && !r.fits_page(""));
    }
}
