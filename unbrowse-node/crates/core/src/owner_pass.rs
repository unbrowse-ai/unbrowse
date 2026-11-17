//! The owner's passphrase: the owner's yes on a node with no screen to show a dialog on.
//!
//! The owner sets it once, on a terminal (`unbrowse-node passphrase`), and types it on a terminal again
//! (`unbrowse-node confirm`) whenever the node waits on the owner's yes for a command that hands out a secret. The node
//! keeps only a slow hash of it (scrypt), so the file gives nobody the passphrase back, and every guess costs a fraction
//! of a second.
//!
//! The file is sealed with a key derived from the node's root key (HMAC-SHA256), and the node trusts no record its key
//! didn't seal. A program that can write the owner's files but can't read the root key (the macOS Keychain keeps it
//! from other programs; on Linux and Windows an agent run as another OS user can't read it) can't put a passphrase of
//! its own in place to answer for the owner. A program that can read the root key has the node's wallet already, which
//! is what the passphrase guards.

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::derive::RootKey;

/// The shortest passphrase the node takes, in characters: a short one falls to guessing against the hash.
pub const MIN_CHARS: usize = 10;

/// scrypt's cost: 2^17 with `r` = 8, 128 MiB and about half a second a guess on a laptop.
pub const LOG_N: u8 = 17;

/// The costs a record may name: below, a guess is too cheap; above, checking one takes too long or too much memory.
const LOG_N_RANGE: std::ops::RangeInclusive<u8> = 10..=20;

#[derive(Debug, thiserror::Error)]
pub enum PassError {
    #[error("the owner passphrase needs at least {MIN_CHARS} characters")]
    TooShort,
    #[error("the owner passphrase file isn't one this node wrote: {0}")]
    NotOurs(String),
    #[error("{0}")]
    Failed(String),
}

/// The passphrase as the node keeps it: its scrypt hash and salt, sealed with the root key.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Record {
    pub v: u8,
    pub log_n: u8,
    pub salt: String,
    pub hash: String,
    pub mac: String,
}

impl Record {
    /// A record of `passphrase` sealed with `root`, at the real cost.
    pub fn new(root: &RootKey, passphrase: &str) -> Result<Self, PassError> {
        Self::new_with(root, passphrase, LOG_N)
    }

    /// `new` at scrypt cost 2^`log_n`: tests use a cheap one.
    pub fn new_with(root: &RootKey, passphrase: &str, log_n: u8) -> Result<Self, PassError> {
        if passphrase.chars().count() < MIN_CHARS {
            return Err(PassError::TooShort);
        }
        let mut salt = [0u8; 16];
        getrandom::fill(&mut salt).map_err(|e| PassError::Failed(e.to_string()))?;
        let hash = stretch(passphrase, &salt, log_n)?;
        let mut r = Record { v: 1, log_n, salt: hex::encode(salt), hash: hex::encode(*hash), mac: String::new() };
        r.mac = hex::encode(r.seal(root)?.finalize().into_bytes());
        Ok(r)
    }

    /// Whether `root` sealed this record: one its key didn't is never trusted, whatever passphrase it names.
    pub fn sealed_by(&self, root: &RootKey) -> Result<(), PassError> {
        let mac = hex::decode(&self.mac).map_err(|_| PassError::NotOurs("its seal isn't hex".into()))?;
        self.seal(root)?.verify_slice(&mac).map_err(|_| PassError::NotOurs("this node's key didn't seal it".into()))
    }

    /// Whether `passphrase` is the one this record keeps. Slow on purpose: run it off an async runtime's threads.
    pub fn opens(&self, passphrase: &str) -> Result<bool, PassError> {
        let salt = hex::decode(&self.salt).map_err(|_| PassError::NotOurs("its salt isn't hex".into()))?;
        let want = hex::decode(&self.hash).map_err(|_| PassError::NotOurs("its hash isn't hex".into()))?;
        let got = stretch(passphrase, &salt, self.log_n)?;
        // Every byte is compared, whatever the first one that differs.
        Ok(want.len() == got.len() && want.iter().zip(got.iter()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0)
    }

    fn seal(&self, root: &RootKey) -> Result<Hmac<Sha256>, PassError> {
        if self.v != 1 || !LOG_N_RANGE.contains(&self.log_n) {
            return Err(PassError::NotOurs(format!("version {} at cost 2^{}", self.v, self.log_n)));
        }
        let key = seal_key(root);
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&*key).map_err(|e| PassError::Failed(e.to_string()))?;
        mac.update(format!("unbrowse owner passphrase v{} {} {} {}", self.v, self.log_n, self.salt, self.hash).as_bytes());
        Ok(mac)
    }
}

/// The key that seals the record: the root key hashed with its own label, so it opens nothing else.
fn seal_key(root: &RootKey) -> Zeroizing<[u8; 32]> {
    let mut h = Keccak256::new();
    h.update(*root.secret());
    h.update(b"unbrowse/owner-passphrase");
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&h.finalize());
    out
}

/// A seal over `text` under `label`, with a key derived from the root key: what the node writes beside a record the
/// owner confirmed (the wallet withdrawals go to), so a copy another program wrote in its place, without the root key,
/// is told apart from it. The label keeps a seal for one kind of record from passing for another's.
pub fn seal_text(root: &RootKey, label: &str, text: &str) -> String {
    hex::encode(text_mac(root, label, text).finalize().into_bytes())
}

/// Whether `mac` is the seal `seal_text` makes for `text` under `label` with `root`.
pub fn sealed_text(root: &RootKey, label: &str, text: &str, mac: &str) -> bool {
    hex::decode(mac).is_ok_and(|m| text_mac(root, label, text).verify_slice(&m).is_ok())
}

fn text_mac(root: &RootKey, label: &str, text: &str) -> Hmac<Sha256> {
    key_mac(&text_seal_key(root, label), text)
}

/// The key `seal_text` uses for `label`: derived from the root key and the label, so it opens nothing else and seals
/// nothing under another label. For a record sealed often (on every change), held by the caller in place of the root
/// key, which is loaded only for one operation.
pub fn text_seal_key(root: &RootKey, label: &str) -> Zeroizing<[u8; 32]> {
    let mut h = Keccak256::new();
    h.update(*root.secret());
    h.update(b"unbrowse/sealed/");
    h.update(label.as_bytes());
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&h.finalize());
    key
}

/// `seal_text`, with the label's key from [`text_seal_key`].
pub fn seal_text_with(key: &[u8; 32], text: &str) -> String {
    hex::encode(key_mac(key, text).finalize().into_bytes())
}

/// `sealed_text`, with the label's key from [`text_seal_key`].
pub fn sealed_text_with(key: &[u8; 32], text: &str, mac: &str) -> bool {
    hex::decode(mac).is_ok_and(|m| key_mac(key, text).verify_slice(&m).is_ok())
}

fn key_mac(key: &[u8; 32], text: &str) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(text.as_bytes());
    mac
}

fn stretch(passphrase: &str, salt: &[u8], log_n: u8) -> Result<Zeroizing<[u8; 32]>, PassError> {
    if !LOG_N_RANGE.contains(&log_n) {
        return Err(PassError::NotOurs(format!("cost 2^{log_n}")));
    }
    let params = scrypt::Params::new(log_n, 8, 1, 32).map_err(|e| PassError::Failed(e.to_string()))?;
    let mut out = Zeroizing::new([0u8; 32]);
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut *out).map_err(|e| PassError::Failed(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::MemoryStore;

    fn root() -> RootKey {
        let store = MemoryStore::default();
        crate::identity::load_or_create(&store).unwrap();
        RootKey::load(&store).unwrap()
    }

    /// The record opens with its own passphrase only, keeps no copy of it, and names a cost in range.
    #[test]
    fn a_record_opens_with_its_passphrase_and_no_other() {
        let root = root();
        let r = Record::new_with(&root, "correct horse battery", 10).unwrap();
        assert!(r.opens("correct horse battery").unwrap());
        assert!(!r.opens("correct horse batterz").unwrap());
        assert!(!serde_json::to_string(&r).unwrap().contains("horse"));
        assert!(matches!(Record::new_with(&root, "short", 10), Err(PassError::TooShort)));
        r.sealed_by(&root).unwrap();
    }

    /// A program that can write the owner's files but not read the node's key can't put a passphrase of its own in
    /// place: a record another key sealed, or one edited after sealing, is refused.
    #[test]
    fn a_record_another_key_sealed_is_never_trusted() {
        let (ours, theirs) = (root(), root());
        let forged = Record::new_with(&theirs, "the agent's own words", 10).unwrap();
        assert!(matches!(forged.sealed_by(&ours), Err(PassError::NotOurs(_))));
        let mut edited = Record::new_with(&ours, "the owner's own words", 10).unwrap();
        edited.hash = forged.hash.clone();
        edited.salt = forged.salt.clone();
        assert!(matches!(edited.sealed_by(&ours), Err(PassError::NotOurs(_))));
        let mut cheap = Record::new_with(&ours, "the owner's own words", 10).unwrap();
        cheap.log_n = 1;
        assert!(cheap.sealed_by(&ours).is_err());
    }

    /// A text sealed under one label opens under that label and that root key only, and only unchanged.
    #[test]
    fn a_sealed_text_opens_with_its_own_key_label_and_words_only() {
        let (ours, theirs) = (root(), root());
        let mac = seal_text(&ours, "owner-link", "node owner nonce signature");
        assert!(sealed_text(&ours, "owner-link", "node owner nonce signature", &mac));
        assert!(!sealed_text(&ours, "owner-link", "node thief nonce signature", &mac));
        assert!(!sealed_text(&ours, "something-else", "node owner nonce signature", &mac));
        assert!(!sealed_text(&theirs, "owner-link", "node owner nonce signature", &mac));
        assert!(!sealed_text(&ours, "owner-link", "node owner nonce signature", "not hex"));
    }
}
