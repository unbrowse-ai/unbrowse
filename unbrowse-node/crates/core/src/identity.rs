//! The root key (PRD US-001, FR-1): a secp256k1 key generated on the device and kept in the
//! keystore. Only its address leaves this module.
//!
//! A new node's key is a standard wallet's first account: made from 12 fresh seed words at `m/44'/60'/0'/0/0`
//! (`seed.rs`), so the words open the same address in any wallet app. The words are kept beside the key. A key made
//! before that, from 32 random bytes, stays exactly as it is: its address is its identity on chain.

use std::fmt;

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{PublicKey, SecretKey};
use sha3::{Digest, Keccak256};

use crate::keystore::{KeyStore, KeystoreError};
use crate::seed;

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error(transparent)]
    Keystore(#[from] KeystoreError),
    /// Something is stored but it is not a valid key. Never overwritten automatically:
    /// it may be the only copy of someone's key.
    #[error("the stored root key is unreadable; it has been left untouched")]
    CorruptKey,
}

/// A 20-byte wallet address on Arc (an EVM chain).
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Address([u8; 20]);

impl Address {
    pub fn from_public_key(key: &PublicKey) -> Self {
        let point = key.to_encoded_point(false);
        let hash = Keccak256::digest(&point.as_bytes()[1..]);
        let mut out = [0u8; 20];
        out.copy_from_slice(&hash[12..]);
        Self(out)
    }

    /// EIP-55 mixed-case checksum form, e.g. `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`.
    pub fn to_checksum(&self) -> String {
        let lower = hex::encode(self.0);
        let hash = Keccak256::digest(lower.as_bytes());
        let mut out = String::with_capacity(42);
        out.push_str("0x");
        for (i, c) in lower.chars().enumerate() {
            let nibble = (hash[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0x0f;
            out.push(if nibble >= 8 { c.to_ascii_uppercase() } else { c });
        }
        out
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_checksum())
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Address({self})")
    }
}

/// The public face of the root key. Holds no secret.
#[derive(Debug, Clone)]
pub struct Identity {
    pub address: Address,
    /// True when this run generated the key; false when it was loaded.
    pub created: bool,
}

/// Loads the root key from the store, or makes one from fresh seed words on first run. A key already there is never
/// changed, whether or not it came from seed words.
pub fn load_or_create(store: &dyn KeyStore) -> Result<Identity, IdentityError> {
    if let Some(bytes) = store.get()? {
        let secret = SecretKey::from_slice(&bytes).map_err(|_| IdentityError::CorruptKey)?;
        return Ok(Identity { address: Address::from_public_key(&secret.public_key()), created: false });
    }
    // Words that make no key at the path are about one draw in 2^125; draw again.
    let (entropy, key) = loop {
        let entropy = seed::fresh();
        if let Ok(key) = seed::key_of(&*entropy) {
            break (entropy, key);
        }
    };
    // The words first: a key in the store with no words beside it would read as a node made before seed words.
    store.set_seed(&*entropy)?;
    store.set(&*key)?;
    let secret = SecretKey::from_slice(&*key).map_err(|_| IdentityError::CorruptKey)?;
    Ok(Identity { address: Address::from_public_key(&secret.public_key()), created: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::MemoryStore;

    #[test]
    fn address_of_private_key_one() {
        // Well-known vector: private key 0x…01.
        let mut bytes = [0u8; 32];
        bytes[31] = 1;
        let secret = SecretKey::from_slice(&bytes).unwrap();
        let addr = Address::from_public_key(&secret.public_key());
        assert_eq!(addr.to_checksum(), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    }

    #[test]
    fn first_run_creates_then_loads_the_same_key() {
        let store = MemoryStore::default();
        let first = load_or_create(&store).unwrap();
        assert!(first.created);
        let second = load_or_create(&store).unwrap();
        assert!(!second.created);
        assert_eq!(first.address, second.address);
    }

    /// A new node's key is its seed words' first Ethereum account, and the words are kept beside it.
    #[test]
    fn a_new_key_is_made_from_seed_words_it_keeps() {
        let store = MemoryStore::default();
        load_or_create(&store).unwrap();
        let entropy = store.seed().unwrap().expect("the words are kept");
        assert_eq!(entropy.len(), seed::ENTROPY_LEN);
        assert_eq!(*seed::key_of(&entropy).unwrap(), store.get().unwrap().unwrap().as_slice());
    }

    /// A key made before seed words loads as it is: no words are made for it, and its address doesn't move.
    #[test]
    fn an_older_key_is_kept_as_it_is() {
        let store = MemoryStore::default();
        let mut bytes = [0u8; 32];
        bytes[31] = 1;
        store.set(&bytes).unwrap();
        let id = load_or_create(&store).unwrap();
        assert!(!id.created);
        assert_eq!(id.address.to_checksum(), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
        assert_eq!(store.get().unwrap().unwrap().as_slice(), &bytes);
        assert!(store.seed().unwrap().is_none());
    }

    #[test]
    fn two_devices_get_different_keys() {
        let a = load_or_create(&MemoryStore::default()).unwrap();
        let b = load_or_create(&MemoryStore::default()).unwrap();
        assert_ne!(a.address, b.address);
    }

    #[test]
    fn a_corrupt_key_is_reported_not_replaced() {
        let store = MemoryStore::default();
        store.set(&[0u8; 32]).unwrap(); // zero is not a valid secp256k1 key
        assert!(matches!(load_or_create(&store), Err(IdentityError::CorruptKey)));
        assert_eq!(store.get().unwrap().unwrap().as_slice(), &[0u8; 32]);
    }
}
