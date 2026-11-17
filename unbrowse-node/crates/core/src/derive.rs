//! Keys derived from the root key (PRD FR-2, FR-3, FR-18c). Everything here stays in the core: the window only
//! ever sees addresses and, once, an agent's setup token.
//!
//! - An agent key is the root key hashed with a fixed label and the agent's index, so every device that holds the
//!   root key re-derives the same agent keys and nothing per agent has to be stored or backed up.
//! - The vault key is the root key hashed with its own label.
//! - A derived password is the vault key, the site and a counter, shaped to the site's rules. It is never stored:
//!   rotating it bumps the counter.

use k256::SecretKey;
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::identity::{Address, IdentityError};
use crate::keystore::KeyStore;

/// The root key, loaded for the length of one operation. Dropping it wipes the bytes.
pub struct RootKey(Zeroizing<[u8; 32]>);

impl RootKey {
    pub fn load(store: &dyn KeyStore) -> Result<Self, IdentityError> {
        let bytes = store.get()?.ok_or(IdentityError::CorruptKey)?;
        SecretKey::from_slice(&bytes).map_err(|_| IdentityError::CorruptKey)?;
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&bytes);
        Ok(Self(out))
    }

    /// The owner's own signing key, for the chain writes the core makes on the owner's behalf.
    pub fn secret(&self) -> Zeroizing<[u8; 32]> {
        self.0.clone()
    }

    pub fn address(&self) -> Address {
        address_of(&self.0)
    }

    /// Agent key `index`: a secp256k1 key no other label or index can produce.
    pub fn agent(&self, index: u32) -> AgentKey {
        let mut counter = 0u32;
        loop {
            let mut h = Keccak256::new();
            h.update(*self.0);
            h.update(b"unbrowse/agent");
            h.update(index.to_be_bytes());
            h.update(counter.to_be_bytes());
            let mut bytes = Zeroizing::new([0u8; 32]);
            bytes.copy_from_slice(&h.finalize());
            // A hash outside the curve order is astronomically rare; step past it rather than fail.
            if SecretKey::from_slice(&*bytes).is_ok() {
                return AgentKey { index, address: address_of(&bytes), secret: bytes };
            }
            counter += 1;
        }
    }

    pub fn vault_key(&self) -> Zeroizing<[u8; 32]> {
        let mut h = Keccak256::new();
        h.update(*self.0);
        h.update(b"unbrowse/vault");
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&h.finalize());
        out
    }

    /// A password for `site` from the vault key and `counter`, `len` characters long, with at least one lower-case
    /// letter, one upper-case letter, one digit and one symbol so it meets the usual site rules. Logins made before the
    /// account went into the derivation keep this one (`account_password`).
    pub fn password(&self, site: &str, counter: u32, len: usize) -> Zeroizing<String> {
        self.password_from(site, None, counter, len)
    }

    /// A password for `account` on `site`, from the vault key and `counter`: the account is part of what it is derived
    /// from, so two accounts on one site never share one, whatever counters an index gives them (a counter freed by a
    /// login removed, an index edited). Under a label of its own, so it is never one `password` makes.
    pub fn account_password(&self, site: &str, account: &str, counter: u32, len: usize) -> Zeroizing<String> {
        self.password_from(site, Some(account), counter, len)
    }

    fn password_from(&self, site: &str, account: Option<&str>, counter: u32, len: usize) -> Zeroizing<String> {
        const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
        const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
        const DIGIT: &[u8] = b"23456789";
        const SYMBOL: &[u8] = b"!#%+-=?@_";
        let len = len.clamp(8, 64);
        let vault = self.vault_key();
        let mut stream = Vec::with_capacity(len * 2);
        let mut block = 0u32;
        while stream.len() < len * 2 {
            let mut h = Keccak256::new();
            h.update(*vault);
            match account {
                None => {
                    h.update(b"unbrowse/password");
                    h.update(site.to_ascii_lowercase().as_bytes());
                }
                // Each part is said with its length, so no site and account run together into another pair's.
                Some(account) => {
                    h.update(b"unbrowse/password/account");
                    for part in [site.to_ascii_lowercase(), account.to_string()] {
                        h.update((part.len() as u64).to_be_bytes());
                        h.update(part.as_bytes());
                    }
                }
            }
            h.update(counter.to_be_bytes());
            h.update(block.to_be_bytes());
            stream.extend_from_slice(&h.finalize());
            block += 1;
        }
        let sets = [LOWER, UPPER, DIGIT, SYMBOL];
        let mut chars: Vec<u8> = (0..len)
            .map(|i| {
                // The first four positions take one of each class; the rest draw from all of them.
                let set: &[u8] = if i < 4 { sets[i] } else { sets[stream[len + i] as usize % 4] };
                set[stream[i] as usize % set.len()]
            })
            .collect();
        // Move the guaranteed classes away from the front, deterministically.
        for i in (1..len).rev() {
            let j = stream[(i * 7) % stream.len()] as usize % (i + 1);
            chars.swap(i, j);
        }
        Zeroizing::new(String::from_utf8(chars).expect("ascii"))
    }
}

pub struct AgentKey {
    pub index: u32,
    pub address: Address,
    secret: Zeroizing<[u8; 32]>,
}

impl AgentKey {
    pub fn secret(&self) -> Zeroizing<[u8; 32]> {
        self.secret.clone()
    }

    /// The bearer token the agent presents to this node's local API. Derived, so nothing is stored to check it.
    pub fn api_token(&self) -> String {
        let mut h = Keccak256::new();
        h.update(*self.secret);
        h.update(b"unbrowse/api");
        format!("unb_{}", hex::encode(&h.finalize()[..24]))
    }

    /// The bearer token for one key made under this index: the derived token with the salt the node drew for that
    /// key. A key made again under an index once used (its record lost, or two made at once) draws its own salt,
    /// so an earlier key's token, revoked or not, never passes as the new one's. No salt is a key from before salts.
    pub fn api_token_with(&self, salt: Option<&str>) -> String {
        let Some(salt) = salt else { return self.api_token() };
        let mut h = Keccak256::new();
        h.update(*self.secret);
        h.update(b"unbrowse/api");
        h.update(salt.as_bytes());
        format!("unb_{}", hex::encode(&h.finalize()[..24]))
    }
}

/// What a node answers to show a client holding agent `token` that it is the node the token is for, on the `port`
/// the client dialed: a hash of the token with a fresh `challenge` the client chose. The client checks it before it
/// sends the token, so a listener that took the port while the node was away learns nothing from the client.
pub fn node_proof(token: &str, port: u16, challenge: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(b"unbrowse/node-proof\n");
    h.update(token.as_bytes());
    h.update(b"\n");
    h.update(port.to_be_bytes());
    h.update(challenge);
    h.finalize().into()
}

/// The name a client holding agent `token` gives its key when it asks the node to prove itself (`/v1/node/proof?key=`):
/// a hash of the token, which names the key to the node that made it and says nothing of the token to anyone else. The
/// node answers for that key alone, so the answer tells the asker nothing of the node's other keys.
pub fn token_key(token: &str) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(b"unbrowse/node-key\n");
    h.update(token.as_bytes());
    h.finalize().into()
}

fn address_of(bytes: &[u8; 32]) -> Address {
    let secret = SecretKey::from_slice(bytes).expect("checked on load");
    Address::from_public_key(&secret.public_key())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::load_or_create;
    use crate::keystore::MemoryStore;

    fn root() -> (MemoryStore, RootKey) {
        let store = MemoryStore::default();
        load_or_create(&store).unwrap();
        let root = RootKey::load(&store).unwrap();
        (store, root)
    }

    #[test]
    fn agent_keys_are_stable_and_distinct() {
        let (store, root) = root();
        let again = RootKey::load(&store).unwrap();
        assert_eq!(root.agent(0).address, again.agent(0).address);
        assert_ne!(root.agent(0).address, root.agent(1).address);
        assert_ne!(root.agent(0).address, root.address());
        assert_eq!(root.agent(3).api_token(), again.agent(3).api_token());
        assert_ne!(root.agent(0).api_token(), root.agent(1).api_token());
    }

    /// Two keys made under one index with their own salts never share a token; no salt is the token from before.
    #[test]
    fn a_salted_token_is_its_keys_alone() {
        let (_, root) = root();
        let k = root.agent(0);
        assert_eq!(k.api_token_with(None), k.api_token());
        assert_ne!(k.api_token_with(Some("aa")), k.api_token_with(Some("bb")));
        assert_ne!(k.api_token_with(Some("aa")), k.api_token());
        assert_eq!(k.api_token_with(Some("aa")), root.agent(0).api_token_with(Some("aa")));
    }

    #[test]
    fn a_node_proof_holds_for_one_token_port_and_challenge() {
        let (_, root) = root();
        let token = root.agent(0).api_token();
        let p = node_proof(&token, 7788, &[1; 32]);
        assert_eq!(p, node_proof(&token, 7788, &[1; 32]));
        assert_ne!(p, node_proof(&root.agent(1).api_token(), 7788, &[1; 32]), "another agent's token");
        assert_ne!(p, node_proof(&token, 7789, &[1; 32]), "another port");
        assert_ne!(p, node_proof(&token, 7788, &[2; 32]), "an old challenge");
    }

    #[test]
    fn passwords_are_derived_not_stored() {
        let (_, root) = root();
        let a = root.password("github.com", 0, 20);
        assert_eq!(*a, *root.password("GitHub.com", 0, 20));
        assert_ne!(*a, *root.password("github.com", 1, 20));
        assert_ne!(*a, *root.password("gitlab.com", 0, 20));
        assert_eq!(a.len(), 20);
        assert!(a.bytes().any(|c| c.is_ascii_lowercase()));
        assert!(a.bytes().any(|c| c.is_ascii_uppercase()));
        assert!(a.bytes().any(|c| c.is_ascii_digit()));
        assert!(a.bytes().any(|c| !c.is_ascii_alphanumeric()));
    }

    /// Two accounts on one site at the same counter get two passwords, and neither is the site's password from before
    /// the account went in; the site is read case-blind as before, the account as it is written.
    #[test]
    fn a_derived_password_is_the_accounts_own() {
        let (_, root) = root();
        let me = root.account_password("github.com", "me", 0, 20);
        assert_ne!(*me, *root.account_password("github.com", "you", 0, 20));
        assert_ne!(*me, *root.password("github.com", 0, 20));
        assert_eq!(*me, *root.account_password("GitHub.com", "me", 0, 20));
        assert_ne!(*root.account_password("ab.com", "c", 0, 20), *root.account_password("ab.co", "mc", 0, 20));
        assert_eq!(me.len(), 20);
    }
}
