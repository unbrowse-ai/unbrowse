//! Seed words: a new node's root key is made the way any EVM wallet makes its first account, so the same 12 words open
//! the same address in MetaMask, Rabby or any other wallet app. The words are a BIP-39 phrase (128 bits of entropy,
//! English, no passphrase); the key is the BIP-32 child at `m/44'/60'/0'/0/0`, Ethereum's first account.
//!
//! The derived key can't give the words back, so the node keeps the words' entropy beside the root key
//! (`KeyStore::seed`). A key made before seed words has none, and keeps working as it is.

use hmac::{Hmac, Mac};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{FieldBytes, Scalar, SecretKey};
use sha2::Sha512;
use zeroize::Zeroizing;

/// Bytes of entropy in a new phrase: 16 bytes is 12 words.
pub const ENTROPY_LEN: usize = 16;

/// Ethereum's first account, `m/44'/60'/0'/0/0`. A set top bit marks a hardened step.
const PATH: [u32; 5] = [44 | HARDENED, 60 | HARDENED, HARDENED, 0, 0];
const HARDENED: u32 = 0x8000_0000;

/// The words could not make a key: a step of the path landed outside the curve's order. The odds are about one in
/// 2^127 per step; BIP-32 says to skip such a step, and a wallet app would then show another address, so the node
/// refuses the words instead.
#[derive(Debug, thiserror::Error)]
#[error("these words don't make a key at m/44'/60'/0'/0/0")]
pub struct NoKey;

/// Fresh entropy for a new node's phrase.
pub fn fresh() -> Zeroizing<[u8; ENTROPY_LEN]> {
    let mut e = Zeroizing::new([0u8; ENTROPY_LEN]);
    getrandom::fill(&mut *e).expect("the OS has no randomness to give");
    e
}

/// The phrase the entropy writes out.
pub fn words(entropy: &[u8]) -> Zeroizing<String> {
    let m = bip39::Mnemonic::from_entropy(entropy).expect("16 bytes is a 12-word phrase");
    Zeroizing::new(m.to_string())
}

/// The root key the phrase with this entropy opens in any wallet app: its first Ethereum account.
pub fn key_of(entropy: &[u8]) -> Result<Zeroizing<[u8; 32]>, NoKey> {
    let m = bip39::Mnemonic::from_entropy(entropy).map_err(|_| NoKey)?;
    let seed = Zeroizing::new(m.to_seed_normalized(""));
    derive(&seed)
}

/// BIP-32 from a 64-byte seed down `PATH`.
fn derive(seed: &[u8; 64]) -> Result<Zeroizing<[u8; 32]>, NoKey> {
    let (mut key, mut chain) = split(hmac(b"Bitcoin seed", &[seed]));
    for index in PATH {
        let i = index.to_be_bytes();
        let out = if index & HARDENED != 0 {
            hmac(&*chain, &[&[0u8], &*key, &i])
        } else {
            let public = SecretKey::from_bytes(&FieldBytes::from(*key)).map_err(|_| NoKey)?.public_key().to_encoded_point(true);
            hmac(&*chain, &[public.as_bytes(), &i])
        };
        let (tweak, next_chain) = split(out);
        let tweak: Option<Scalar> = Scalar::from_repr(FieldBytes::from(*tweak)).into();
        let parent: Option<Scalar> = Scalar::from_repr(FieldBytes::from(*key)).into();
        let child = tweak.ok_or(NoKey)? + parent.ok_or(NoKey)?;
        if bool::from(child.is_zero()) {
            return Err(NoKey);
        }
        key = Zeroizing::new(child.to_bytes().into());
        chain = next_chain;
    }
    Ok(key)
}

fn hmac(key: &[u8], parts: &[&[u8]]) -> Zeroizing<[u8; 64]> {
    let mut mac = Hmac::<Sha512>::new_from_slice(key).expect("HMAC takes a key of any length");
    for p in parts {
        mac.update(p);
    }
    Zeroizing::new(mac.finalize().into_bytes().into())
}

/// A BIP-32 step's output: the key half and the chain-code half.
fn split(i: Zeroizing<[u8; 64]>) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
    let (mut l, mut r) = (Zeroizing::new([0u8; 32]), Zeroizing::new([0u8; 32]));
    l.copy_from_slice(&i[..32]);
    r.copy_from_slice(&i[32..]);
    (l, r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::Address;

    /// The public vector every Ethereum dev tool ships: Anvil's and Hardhat's account 0.
    #[test]
    fn the_test_phrase_opens_anvils_first_account() {
        let m = bip39::Mnemonic::parse("test test test test test test test test test test test junk").unwrap();
        let key = key_of(&m.to_entropy()).unwrap();
        let address = Address::from_public_key(&SecretKey::from_slice(&*key).unwrap().public_key());
        assert_eq!(address.to_checksum(), "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    }

    /// A new phrase is 12 words, and two are never the same.
    #[test]
    fn fresh_entropy_is_twelve_words() {
        let e = fresh();
        assert_eq!(words(&*e).split(' ').count(), 12);
        assert_ne!(*fresh(), *e);
    }
}
