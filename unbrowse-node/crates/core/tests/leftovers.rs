//! Public-API behaviour the crate's unit tests leave out: one-time-code parsing corners, backups that are not ours,
//! an address's text, and a restore cut off half way.

use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use unbrowse_core::backup::{export_with, key_of as backup_key_of};
use unbrowse_core::keystore::{KeyStore, KeystoreError, MemoryStore};
use unbrowse_core::recovery::{restore, restore_key, RecoveryError, Restored};
use unbrowse_core::{load_or_create, CodeKey, IdentityError, RootKey};
use zeroize::Zeroizing;

// RFC 6238 appendix B: the shared secrets are ASCII digits repeated to the hash's block width, at time 59, 8 digits.
fn rfc_uri(secret: &[u8], algorithm: &str) -> String {
    let b32 = data_encoding::BASE32_NOPAD.encode(secret);
    format!("otpauth://totp/Example:me?secret={b32}&algorithm={algorithm}&digits=8&period=30&issuer=Example")
}

#[test]
fn a_code_key_made_for_sha256_and_sha512_gives_the_rfc_codes() {
    let sha1 = CodeKey::parse(&rfc_uri(b"12345678901234567890", "SHA1")).unwrap();
    let sha256 = CodeKey::parse(&rfc_uri(b"12345678901234567890123456789012", "sha256")).unwrap();
    let sha512 = CodeKey::parse(&rfc_uri(b"1234567890123456789012345678901234567890123456789012345678901234", "SHA512")).unwrap();
    assert_eq!(sha1.at(59).as_str(), "94287082");
    assert_eq!(sha256.at(59).as_str(), "46119246");
    assert_eq!(sha512.at(59).as_str(), "90693936");
}

#[test]
fn a_code_link_with_a_setting_this_does_not_make_codes_from_is_not_a_key() {
    let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    for bad in [
        format!("otpauth://totp/x?secret={secret}&algorithm=MD5"),
        format!("otpauth://totp/x?secret={secret}&digits=9"),
        format!("otpauth://totp/x?secret={secret}&digits=five"),
        format!("otpauth://totp/x?secret={secret}&period=0"),
        "otpauth://totp/x?issuer=nobody".to_string(),
        "otpauth://totp/x".to_string(),
        format!("otpauth://hotp/x?secret={secret}&counter=1"),
        "   ".to_string(),
        "----".to_string(),
        "not base32 at all!".to_string(),
    ] {
        assert!(CodeKey::parse(&bad).is_none(), "{bad}");
    }
}

#[test]
fn a_secret_spelled_with_percent_escapes_and_a_bare_flag_is_still_read() {
    // %47 is "G"; a pair with no "=" is ignored rather than refused; "%zz" is not an escape and stays as it is.
    let key = CodeKey::parse("otpauth://TOTP/x?flag&secret=%47EZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&x=%zz").unwrap();
    let plain = CodeKey::parse("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq").unwrap();
    assert_eq!(key.at(59).as_str(), plain.at(59).as_str());
    assert_eq!(key.at(59).len(), 6);
}

#[test]
fn the_code_for_now_is_the_code_for_this_second() {
    let key = CodeKey::parse("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
    let before = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let now = key.now();
    let after = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    assert!((before..=after).any(|t| key.at(t).as_str() == now.as_str()));
    assert!(now.chars().all(|c| c.is_ascii_digit()) && now.len() == 6);
}

fn root_of(store: &MemoryStore) -> RootKey {
    load_or_create(store).unwrap();
    RootKey::load(store).unwrap()
}

#[test]
fn a_backup_with_odd_parts_is_refused_naming_the_part_not_opened() {
    let root = root_of(&MemoryStore::default());
    let good = export_with(&root, "correct horse battery", 4).unwrap();
    assert!(backup_key_of(&good, "correct horse battery").is_ok());
    let tweak = |f: &dyn Fn(&mut serde_json::Value)| {
        let mut v: serde_json::Value = serde_json::from_str(&good).unwrap();
        f(&mut v);
        backup_key_of(&v.to_string(), "correct horse battery").map(|_| ()).unwrap_err().to_string()
    };
    assert!(tweak(&|v| v["crypto"]["kdfparams"]["n"] = 3.into()).contains("scrypt parameters"), "n not a power of two");
    assert!(tweak(&|v| v["crypto"]["kdfparams"]["n"] = (1u64 << 23).into()).contains("scrypt parameters"), "n too costly");
    assert!(tweak(&|v| v["crypto"]["kdfparams"]["dklen"] = 16.into()).contains("scrypt parameters"));
    assert!(tweak(&|v| v["crypto"]["kdfparams"]["salt"] = "not hex".into()).contains("salt"));
    assert!(tweak(&|v| v["crypto"]["cipherparams"]["iv"] = "00".into()).contains("32-byte key"));
    assert!(tweak(&|v| v["crypto"]["ciphertext"] = "00".into()).contains("32-byte key"));
    assert!(tweak(&|v| v["version"] = 2.into()).contains("version 2"));
}

#[test]
fn an_address_reads_as_its_checksummed_text_in_display_and_debug() {
    let store = MemoryStore::default();
    let a = root_of(&store).address();
    assert_eq!(format!("{a}"), a.to_checksum());
    assert_eq!(format!("{a:?}"), format!("Address({})", a.to_checksum()));
}

/// A store that can be made to refuse writes of the key or of the words.
#[derive(Default)]
struct Flaky {
    inner: MemoryStore,
    no_key: AtomicBool,
    no_seed: AtomicBool,
}

fn refused() -> KeystoreError {
    KeystoreError::Unavailable("disk full".into())
}

impl KeyStore for Flaky {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        self.inner.get()
    }
    fn set(&self, secret: &[u8]) -> Result<(), KeystoreError> {
        if self.no_key.load(SeqCst) {
            return Err(refused());
        }
        self.inner.set(secret)
    }
    fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        self.inner.seed()
    }
    fn set_seed(&self, entropy: &[u8]) -> Result<(), KeystoreError> {
        if self.no_seed.load(SeqCst) {
            return Err(refused());
        }
        self.inner.set_seed(entropy)
    }
}

#[test]
fn a_new_node_that_cannot_keep_its_seed_words_makes_no_key() {
    let store = Flaky::default();
    store.no_seed.store(true, SeqCst);
    assert!(matches!(load_or_create(&store), Err(IdentityError::Keystore(_))));
    assert!(store.get().unwrap().is_none(), "no key without the words beside it");
}

const WORDS: &str = "test test test test test test test test test test test junk";
const OTHER: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";

#[test]
fn the_same_key_restored_with_its_words_keeps_the_words_it_was_missing() {
    let store = Flaky::default();
    let key = unbrowse_core::recovery::key_of(WORDS).unwrap();
    store.inner.set(&*key.key).unwrap();
    assert!(store.seed().unwrap().is_none(), "a key with no words");
    let done = restore(&store, |_| unreachable!("the same key sets nothing aside"), WORDS).unwrap();
    assert!(matches!(done, Restored::Same(_)));
    assert_eq!(store.seed().unwrap().unwrap().as_slice(), key.seed.unwrap().as_slice());
}

#[test]
fn a_restore_whose_key_write_fails_puts_the_old_words_back() {
    let store = Flaky::default();
    load_or_create(&store).unwrap();
    let old_key = store.get().unwrap().unwrap().to_vec();
    let old_seed = store.seed().unwrap().unwrap().to_vec();
    store.no_key.store(true, SeqCst);
    let aside: Box<dyn KeyStore> = Box::new(MemoryStore::default());
    let err = restore(&store, move |_| Ok(aside), OTHER).unwrap_err();
    assert!(matches!(err, RecoveryError::Keystore(_)), "{err}");
    assert_eq!(store.get().unwrap().unwrap().as_slice(), old_key.as_slice(), "the key is the old key");
    assert_eq!(store.seed().unwrap().unwrap().as_slice(), old_seed.as_slice(), "and so are its words");
}

#[test]
fn a_key_restored_from_a_backup_replaces_the_old_one_and_drops_its_words_from_the_store() {
    let store = MemoryStore::default();
    load_or_create(&store).unwrap();
    let kept = std::sync::Arc::new(MemoryStore::default());
    struct Shared(std::sync::Arc<MemoryStore>);
    impl KeyStore for Shared {
        fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> { self.0.get() }
        fn set(&self, s: &[u8]) -> Result<(), KeystoreError> { self.0.set(s) }
        fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> { self.0.seed() }
        fn set_seed(&self, e: &[u8]) -> Result<(), KeystoreError> { self.0.set_seed(e) }
    }
    let old_seed = store.seed().unwrap().unwrap().to_vec();
    let k2 = kept.clone();
    let done = restore_key(&store, move |_| Ok(Box::new(Shared(k2))), &[0x11; 32]).unwrap();
    assert!(matches!(done, Restored::Replaced { .. }));
    assert_eq!(store.get().unwrap().unwrap().as_slice(), &[0x11; 32]);
    assert!(store.seed().unwrap().is_none());
    assert_eq!(kept.seed().unwrap().unwrap().as_slice(), old_seed.as_slice(), "the old words went aside with the old key");
}
