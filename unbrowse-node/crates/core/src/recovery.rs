//! The root key written as words (BIP-39), so the owner can keep it off the machine and bring it back. Everything
//! the node has is made from the root key: the owner's address, every agent key, every derived password. The
//! Keychain holds the only copy, so a lost Mac or a wiped Keychain would take all of it.
//!
//! There are two kinds of phrase, told apart by their length.
//!
//! - **12 words: seed words.** A node made since 3 November 2026 has them. The root key is made from them the way any
//!   EVM wallet makes its first account (`m/44'/60'/0'/0/0`, `seed.rs`), so the same 12 words open this node's
//!   wallet, the same address, in MetaMask, Rabby or any other wallet app. They also bring the node back.
//! - **24 words: an older node's key.** A node made before seed words has a key of 32 random bytes. Its words are those
//!   bytes read straight as BIP-39 entropy. They bring back this node and nothing else: a wallet app reads any phrase
//!   as seed words, so it would show a different address. To open an older node's wallet in a wallet app, export its
//!   key (`backup.rs`, `wallet export`) and import that. An older key is never moved to seed words: its address is
//!   its identity on chain.

use zeroize::Zeroizing;

use crate::derive::RootKey;
use crate::identity::{Address, IdentityError};
use crate::keystore::KeyStore;
use crate::seed;

#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    #[error("{0}")]
    Phrase(String),
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error(transparent)]
    Keystore(#[from] crate::keystore::KeystoreError),
}

/// A node's phrase, of either kind.
pub enum Phrase {
    /// 12 seed words: they open this node's wallet in any wallet app, and bring the node back.
    Seed(Zeroizing<String>),
    /// 24 words of an older node's key: they bring back this node only.
    Key(Zeroizing<String>),
}

impl Phrase {
    pub fn words(&self) -> &str {
        match self {
            Phrase::Seed(w) | Phrase::Key(w) => w,
        }
    }
}

/// The node's phrase: its seed words when its key was made from them, else the key's 24 words. Seed words are shown
/// only when they still make the key in the store, so a phrase shown is always this node's.
pub fn phrase(store: &dyn KeyStore) -> Result<Phrase, RecoveryError> {
    let root = RootKey::load(store)?;
    if let Some(entropy) = store.seed()? {
        if seed::key_of(&entropy).is_ok_and(|k| *k == *root.secret()) {
            return Ok(Phrase::Seed(seed::words(&entropy)));
        }
    }
    Ok(Phrase::Key(key_words(&root)))
}

/// The root key's 32 bytes as 24 words.
fn key_words(root: &RootKey) -> Zeroizing<String> {
    let words = bip39::Mnemonic::from_entropy(&*root.secret()).expect("32 bytes is a 24-word phrase");
    Zeroizing::new(words.to_string())
}

/// What a phrase brings back: the root key, and the seed words' entropy when the phrase is seed words.
pub struct Read {
    pub key: Zeroizing<[u8; 32]>,
    pub seed: Option<Zeroizing<Vec<u8>>>,
}

/// The root key the words make. 12 words are seed words, taken down the standard path; 24 words are an older key's
/// bytes, read straight. Case, extra spaces and line breaks are forgiven; a word off the list, any other word count, or
/// a checksum that doesn't hold is refused, so a mistyped phrase never becomes a new key.
pub fn key_of(words: &str) -> Result<Read, RecoveryError> {
    let clean = Zeroizing::new(words.split_whitespace().map(str::to_lowercase).collect::<Vec<_>>().join(" "));
    let n = clean.split(' ').filter(|w| !w.is_empty()).count();
    if n != 12 && n != 24 {
        return Err(RecoveryError::Phrase(format!(
            "a recovery phrase is 12 words (a node's seed words) or 24 words (an older node's key); this is {n}"
        )));
    }
    let m = bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &clean).map_err(|e| RecoveryError::Phrase(match e {
        bip39::Error::UnknownWord(i) => format!("word {} isn't on the recovery word list", i + 1),
        bip39::Error::InvalidChecksum => "the words don't check out: one of them is wrong or out of place".into(),
        other => other.to_string(),
    }))?;
    let entropy = Zeroizing::new(m.to_entropy());
    if n == 12 {
        let key = seed::key_of(&entropy).map_err(|e| RecoveryError::Phrase(e.to_string()))?;
        return Ok(Read { key, seed: Some(entropy) });
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&entropy);
    k256::SecretKey::from_slice(&*key).map_err(|_| RecoveryError::Phrase("those words aren't a key this node can use".into()))?;
    Ok(Read { key, seed: None })
}

/// What a restore did.
#[derive(Debug, Clone, PartialEq)]
pub enum Restored {
    /// The words are the key already in the store.
    Same(Address),
    /// The store now holds the words' key. The key it held before went to `aside` first, under `previous`.
    Replaced { address: Address, previous: Address },
}

/// Puts the key the words make into `store`, with the seed words when the phrase is seed words. The key already there
/// is never dropped: it may be the only copy of someone's key, so it goes into `aside` first, with its seed words if
/// it has them, and if that fails nothing changes.
pub fn restore(store: &dyn KeyStore, aside: impl FnOnce(&Address) -> Result<Box<dyn KeyStore>, RecoveryError>, words: &str) -> Result<Restored, RecoveryError> {
    let read = key_of(words)?;
    put(store, aside, &read.key, read.seed.as_deref().map(Vec::as_slice))
}

/// Puts `key` into `store`, as `restore` does with the words' key: the key already there goes into `aside` first. Used
/// by a restore from the encrypted backup too (`backup::key_of`). The key comes with no seed words, so a replaced
/// key's words are set aside with it and the store keeps none.
pub fn restore_key(store: &dyn KeyStore, aside: impl FnOnce(&Address) -> Result<Box<dyn KeyStore>, RecoveryError>, key: &[u8; 32]) -> Result<Restored, RecoveryError> {
    put(store, aside, key, None)
}

fn put(store: &dyn KeyStore, aside: impl FnOnce(&Address) -> Result<Box<dyn KeyStore>, RecoveryError>, key: &[u8; 32], seed: Option<&[u8]>) -> Result<Restored, RecoveryError> {
    k256::SecretKey::from_slice(key).map_err(|_| RecoveryError::Phrase("that isn't a key this node can use".into()))?;
    let address = address_of(key);
    let Some(current) = store.get()? else {
        store.set_seed(seed.unwrap_or_default())?;
        store.set(key)?;
        return Ok(Restored::Same(address));
    };
    if current.as_slice() == key.as_slice() {
        // The same key: keep the seed words if these are they, and leave the store's alone otherwise.
        if let Some(s) = seed {
            if store.seed()?.as_deref().map(Vec::as_slice) != Some(s) {
                store.set_seed(s)?;
            }
        }
        return Ok(Restored::Same(address));
    }
    let previous = RootKey::load(store)?.address();
    let old_seed = store.seed()?;
    let kept = aside(&previous)?;
    if let Some(s) = &old_seed {
        kept.set_seed(s)?;
    }
    kept.set(&current)?;
    // The words, then the key. A shown phrase is checked against the key (`phrase`), so a write cut off between the
    // two never shows another key's words.
    store.set_seed(seed.unwrap_or_default())?;
    if let Err(e) = store.set(key) {
        let _ = store.set_seed(old_seed.as_deref().map(Vec::as_slice).unwrap_or_default());
        return Err(e.into());
    }
    Ok(Restored::Replaced { address, previous })
}

fn address_of(key: &[u8; 32]) -> Address {
    Address::from_public_key(&k256::SecretKey::from_slice(key).expect("checked").public_key())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::load_or_create;
    use crate::keystore::MemoryStore;

    /// The public test phrase every Ethereum dev tool ships, and the address it opens (Anvil's and Hardhat's account 0).
    const TEST_WORDS: &str = "test test test test test test test test test test test junk";
    const TEST_ADDRESS: &str = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

    /// A node made now: its key comes from seed words.
    fn node() -> (MemoryStore, RootKey) {
        let store = MemoryStore::default();
        load_or_create(&store).unwrap();
        let root = RootKey::load(&store).unwrap();
        (store, root)
    }

    /// A node made before seed words: 32 random bytes and nothing beside them.
    fn older_node() -> (MemoryStore, RootKey) {
        let store = MemoryStore::default();
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).unwrap();
        store.set(&key).unwrap();
        let root = RootKey::load(&store).unwrap();
        (store, root)
    }

    /// The BIP-39 reference vector for 32 bytes of 0x7f: an older key's words are its bytes, read straight.
    #[test]
    fn an_older_keys_words_are_the_bip39_words_of_the_key() {
        let store = MemoryStore::default();
        store.set(&[0x7f; 32]).unwrap();
        let Phrase::Key(words) = phrase(&store).unwrap() else { panic!("an older key has no seed words") };
        assert_eq!(
            *words,
            "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"
        );
    }

    /// A new node shows its 12 seed words, and they make its key.
    #[test]
    fn a_new_node_shows_its_twelve_seed_words() {
        let (store, root) = node();
        let Phrase::Seed(words) = phrase(&store).unwrap() else { panic!("a new node has seed words") };
        assert_eq!(words.split(' ').count(), 12);
        assert_eq!(*key_of(&words).unwrap().key, *root.secret());
    }

    /// 12 words restore the address any wallet app opens with them, and the node keeps the words to show again.
    #[test]
    fn twelve_words_restore_the_standard_wallet() {
        let fresh = MemoryStore::default();
        let done = restore(&fresh, |_| unreachable!("nothing to set aside"), TEST_WORDS).unwrap();
        assert!(matches!(&done, Restored::Same(a) if a.to_checksum() == TEST_ADDRESS), "{done:?}");
        let Phrase::Seed(words) = phrase(&fresh).unwrap() else { panic!("the words are kept") };
        assert_eq!(*words, TEST_WORDS);
        // Again: the same key, nothing set aside.
        assert!(matches!(restore(&fresh, |_| unreachable!(), TEST_WORDS).unwrap(), Restored::Same(_)));
    }

    /// Writing the key out and reading it back is the same key: the same address, agents and passwords. Both kinds.
    #[test]
    fn a_phrase_brings_back_everything_the_key_made() {
        for (_, root) in [node(), older_node()] {
            let store = MemoryStore::default();
            store.set(&*root.secret()).unwrap();
            let words = Zeroizing::new(phrase(&store).unwrap().words().to_string());
            let fresh = MemoryStore::default();
            assert_eq!(restore(&fresh, |_| unreachable!("nothing to set aside"), &words).unwrap(), Restored::Same(root.address()));
            let back = RootKey::load(&fresh).unwrap();
            assert_eq!(back.agent(2).api_token(), root.agent(2).api_token());
            assert_eq!(*back.password("github.com", 0, 20), *root.password("github.com", 0, 20));
            // As people write them down: capitals, extra spaces, a line break.
            let messy = words.to_uppercase().replacen(' ', "  \n", 3);
            assert_eq!(*key_of(&messy).unwrap().key, *root.secret());
        }
        // A seeded node's words come back as its seed words.
        let (store, root) = node();
        let words = Zeroizing::new(phrase(&store).unwrap().words().to_string());
        let fresh = MemoryStore::default();
        restore(&fresh, |_| unreachable!(), &words).unwrap();
        assert!(matches!(phrase(&fresh).unwrap(), Phrase::Seed(w) if *w == *words));
        assert_eq!(RootKey::load(&fresh).unwrap().address(), root.address());
    }

    /// A restore over another key keeps that key, and its seed words, first; a wrong phrase changes nothing.
    #[test]
    fn a_restore_never_drops_the_key_it_replaces() {
        let (store, old) = node();
        let old_words = Zeroizing::new(phrase(&store).unwrap().words().to_string());
        let kept = std::sync::Arc::new(MemoryStore::default());
        let k = kept.clone();
        let done = restore(&store, move |_| Ok(Box::new(SharedStore(k))), TEST_WORDS).unwrap();
        assert_eq!(done, Restored::Replaced { address: key_address(TEST_WORDS), previous: old.address() });
        assert_eq!(kept.get().unwrap().unwrap().as_slice(), &*old.secret());
        assert!(matches!(phrase(&*kept).unwrap(), Phrase::Seed(w) if *w == *old_words), "the old words go aside too");
        assert_eq!(RootKey::load(&store).unwrap().address().to_checksum(), TEST_ADDRESS);

        // Swap two words the checksum catches, and the store keeps its key. Some swaps still check out, so take the
        // first that doesn't.
        for words in [old_words.to_string(), key_words(&old).to_string()] {
            let words: Vec<String> = words.split(' ').map(String::from).collect();
            let swapped = (1..words.len())
                .map(|j| {
                    let mut s = words.clone();
                    s.swap(0, j);
                    s.join(" ")
                })
                .find(|s| key_of(s).is_err())
                .expect("some swap breaks the checksum");
            assert!(restore(&store, |_| unreachable!(), &swapped).is_err());
            let n = words.len();
            assert!(restore(&store, |_| unreachable!(), &format!("{} notaword", words[..n - 1].join(" "))).is_err());
        }
        assert!(restore(&store, |_| unreachable!(), "legal winner thank year").is_err(), "too few words");
        assert_eq!(RootKey::load(&store).unwrap().address().to_checksum(), TEST_ADDRESS);

        // Setting the old key aside fails: nothing changes.
        let failed = restore(&store, |_| Err(RecoveryError::Phrase("no room".into())), &old_words);
        assert!(failed.is_err());
        assert_eq!(RootKey::load(&store).unwrap().address().to_checksum(), TEST_ADDRESS);
        assert!(matches!(phrase(&store).unwrap(), Phrase::Seed(w) if *w == TEST_WORDS));
    }

    /// Only 12 or 24 words are a phrase. A valid BIP-39 phrase of another length is refused, saying what is wanted.
    #[test]
    fn other_word_counts_are_refused_plainly() {
        let eighteen = bip39::Mnemonic::from_entropy(&[0x7f; 24]).unwrap().to_string();
        for words in [eighteen.as_str(), "test test test test test test test test test test test test junk"] {
            let Err(e) = key_of(words) else { panic!("{} words are not a phrase", words.split(' ').count()) };
            assert!(e.to_string().starts_with("a recovery phrase is 12 words (a node's seed words) or 24 words"), "{e}");
        }
    }

    /// 24 words, or a backup, over a seeded node: the old seed words go aside with its key, and the store keeps no
    /// words that aren't its key's. Words that don't make the stored key are never shown.
    #[test]
    fn a_key_with_no_seed_words_never_shows_another_keys_words() {
        let (store, old) = node();
        let (_, older) = older_node();
        let kept = std::sync::Arc::new(MemoryStore::default());
        let k = kept.clone();
        restore(&store, move |_| Ok(Box::new(SharedStore(k))), &key_words(&older)).unwrap();
        assert!(store.seed().unwrap().is_none());
        assert!(matches!(phrase(&*kept).unwrap(), Phrase::Seed(_)));
        assert!(matches!(phrase(&store).unwrap(), Phrase::Key(w) if *w == *key_words(&older)));

        let (store, _) = node();
        restore_key(&store, |_| Ok(Box::new(MemoryStore::default())), &old.secret()).unwrap();
        assert!(matches!(phrase(&store).unwrap(), Phrase::Key(_)), "a backup's key comes with no words");

        // Words beside a key they don't make, as a write cut off between the two would leave.
        let (store, root) = older_node();
        store.set_seed(&[9; 16]).unwrap();
        assert!(matches!(phrase(&store).unwrap(), Phrase::Key(w) if *w == *key_words(&root)));
    }

    fn key_address(words: &str) -> Address {
        address_of(&key_of(words).unwrap().key)
    }

    struct SharedStore(std::sync::Arc<MemoryStore>);
    impl KeyStore for SharedStore {
        fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, crate::keystore::KeystoreError> {
            self.0.get()
        }
        fn set(&self, secret: &[u8]) -> Result<(), crate::keystore::KeystoreError> {
            self.0.set(secret)
        }
        fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, crate::keystore::KeystoreError> {
            self.0.seed()
        }
        fn set_seed(&self, entropy: &[u8]) -> Result<(), crate::keystore::KeystoreError> {
            self.0.set_seed(entropy)
        }
    }
}
