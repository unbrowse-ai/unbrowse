//! Sealing for vault records that must sit on disk: a website passkey's private key and its counter. The key is the
//! vault key (the root key hashed with its own label, `RootKey::vault_key`) hashed with the record kind's label, so it
//! is re-derived from the root key in the Keychain and never stored. Each record is XChaCha20-Poly1305 under a fresh
//! random nonce, bound to what the record is about (its site and name), so a sealed record moved onto another entry, or
//! changed by one bit, does not open.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::derive::RootKey;

const NONCE: usize = 24;

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("the system's random source failed: {0}")]
    Random(String),
    #[error("the sealed record doesn't open with this node's key, or it was changed")]
    Open,
}

/// The key one kind of record is sealed under. Dropping it wipes the bytes.
pub struct Sealer(Zeroizing<[u8; 32]>);

impl Sealer {
    /// The sealer for records of `kind` (`"passkey"`), derived from the root key.
    pub fn from_root(root: &RootKey, kind: &str) -> Self {
        let mut h = Keccak256::new();
        h.update(*root.vault_key());
        h.update(b"unbrowse/sealed/");
        h.update(kind.as_bytes());
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&h.finalize());
        Sealer(key)
    }

    /// Another sealer for the same kind, for a thread of its own: the key is copied, never shown, and each copy wipes
    /// its bytes when dropped.
    pub fn duplicate(&self) -> Self {
        Sealer(Zeroizing::new(*self.0))
    }

    /// `plain` sealed: the nonce, then the ciphertext and its tag. `about` is bound in and must match to open it.
    pub fn seal(&self, about: &[u8], plain: &[u8]) -> Result<Vec<u8>, SealError> {
        let mut nonce = [0u8; NONCE];
        getrandom::fill(&mut nonce).map_err(|e| SealError::Random(e.to_string()))?;
        let cipher = XChaCha20Poly1305::new((&*self.0).into());
        let body = cipher.encrypt(&XNonce::from(nonce), Payload { msg: plain, aad: about }).map_err(|_| SealError::Open)?;
        let mut out = Vec::with_capacity(NONCE + body.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&body);
        Ok(out)
    }

    /// What [`seal`](Self::seal) sealed, if `about` is what it was sealed about and nothing was changed.
    pub fn open(&self, about: &[u8], sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        let (nonce, body) = sealed.split_first_chunk::<NONCE>().ok_or(SealError::Open)?;
        let cipher = XChaCha20Poly1305::new((&*self.0).into());
        cipher.decrypt(&XNonce::from(*nonce), Payload { msg: body, aad: about }).map(Zeroizing::new).map_err(|_| SealError::Open)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::load_or_create;
    use crate::keystore::MemoryStore;

    fn root() -> RootKey {
        let store = MemoryStore::default();
        load_or_create(&store).unwrap();
        RootKey::load(&store).unwrap()
    }

    #[test]
    fn a_record_opens_only_with_its_key_and_its_name() {
        let root = root();
        let s = Sealer::from_root(&root, "passkey");
        let sealed = s.seal(b"example.com|a1", b"the private key").unwrap();
        assert!(!sealed.windows(15).any(|w| w == b"the private key"), "no plaintext in the sealed bytes");
        assert_eq!(&**s.open(b"example.com|a1", &sealed).unwrap(), b"the private key");
        assert!(s.open(b"example.com|b2", &sealed).is_err(), "moved onto another entry");
        let mut changed = sealed.clone();
        *changed.last_mut().unwrap() ^= 1;
        assert!(s.open(b"example.com|a1", &changed).is_err(), "one bit changed");
        assert!(Sealer::from_root(&root, "card").open(b"example.com|a1", &sealed).is_err(), "another kind's key");
        assert!(Sealer::from_root(&self::root(), "passkey").open(b"example.com|a1", &sealed).is_err(), "another node's key");
        assert_ne!(s.seal(b"x", b"same").unwrap(), s.seal(b"x", b"same").unwrap(), "a fresh nonce each time");
    }
}
