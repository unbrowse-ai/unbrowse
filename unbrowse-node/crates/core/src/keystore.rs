//! Where the root key is kept. In the app this is the OS keystore (the macOS Keychain, Windows' Credential Manager,
//! the Secret Service on Linux), or a file only its owner can read; in tests, memory. A store keeps a second secret
//! beside the key: the entropy of the seed words a new node's key is made from (`seed.rs`), so the node can show them
//! again. The words are kept as safely as the key, in the same kind of store.

use std::sync::Mutex;

use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum KeystoreError {
    #[error("keystore unavailable: {0}")]
    Unavailable(String),
}

pub trait KeyStore {
    /// The stored secret, or `None` if nothing is stored yet.
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError>;
    fn set(&self, secret: &[u8]) -> Result<(), KeystoreError>;
    /// The entropy of the seed words the key was made from, or `None` for a key not made from seed words (a node made
    /// before them, or a key brought back from a backup or from 24 words).
    fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError>;
    /// Keeps `entropy` as the key's seed words. Empty removes them.
    fn set_seed(&self, entropy: &[u8]) -> Result<(), KeystoreError>;
}

/// One item in the OS keystore, named by service and account.
pub struct KeychainStore {
    entry: keyring::Entry,
    /// The seed words' entropy: a second item, named `<account>.seed`.
    seed: keyring::Entry,
}

impl KeychainStore {
    pub fn new(service: &str, account: &str) -> Result<Self, KeystoreError> {
        let entry = keyring::Entry::new(service, account).map_err(unavailable)?;
        let seed = keyring::Entry::new(service, &format!("{account}.seed")).map_err(unavailable)?;
        Ok(Self { entry, seed })
    }

    /// Removes the item and its seed words. Used by tests; the app never deletes a root key.
    pub fn delete(&self) -> Result<(), KeystoreError> {
        remove(&self.seed)?;
        remove(&self.entry)
    }

    /// Whether this OS keystore stores a secret and hands the same bytes back. Some Linux keyrings accept a secret
    /// but return other bytes (a Secret Service that seals under a key it cannot itself read), which would leave the
    /// node holding a root key it can't use and unable to notice: a corrupt read is not an error. When the keystore
    /// fails this check the node keeps its key in a file instead. The probe writes 32 random bytes under a separate
    /// account, reads them back, and removes them; any error or mismatch means not reliable.
    pub fn reliable(service: &str) -> bool {
        let Ok(probe) = Self::new(service, "round-trip-probe") else { return false };
        let mut want = [0u8; 32];
        if getrandom::fill(&mut want).is_err() {
            return false;
        }
        let ok = probe.set(&want).is_ok() && matches!(probe.get(), Ok(Some(got)) if got.as_slice() == want);
        let _ = probe.delete();
        ok
    }
}

impl KeyStore for KeychainStore {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        read(&self.entry)
    }

    fn set(&self, secret: &[u8]) -> Result<(), KeystoreError> {
        retrying(|| self.entry.set_secret(secret)).map_err(unavailable)
    }

    fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        Ok(read(&self.seed)?.filter(|s| !s.is_empty()))
    }

    fn set_seed(&self, entropy: &[u8]) -> Result<(), KeystoreError> {
        if entropy.is_empty() {
            return remove(&self.seed);
        }
        retrying(|| self.seed.set_secret(entropy)).map_err(unavailable)
    }
}

fn read(entry: &keyring::Entry) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
    match retrying(|| entry.get_secret()) {
        Ok(secret) => Ok(Some(Zeroizing::new(secret))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(unavailable(e)),
    }
}

fn remove(entry: &keyring::Entry) -> Result<(), KeystoreError> {
    match retrying(|| entry.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(unavailable(e)),
    }
}

fn unavailable(e: keyring::Error) -> KeystoreError {
    KeystoreError::Unavailable(e.to_string())
}

/// How many times a keystore call is made before its failure is the answer. Each call opens a session of its own.
pub const KEYSTORE_TRIES: usize = 4;

/// Whether `e` is a Secret Service session whose key exchange went wrong, which another session gets past. On Linux
/// every keystore call opens a session with a fresh Diffie-Hellman key pair, and about one in a hundred of them fails
/// on the Deck's ksecretd (measured, UNB-146): a public key with a zero first byte is sent one byte short, which
/// ksecretd refuses ("Client public key size is invalid"); a shared secret with a zero first byte is hashed by
/// ksecretd without it, so the reply is sealed under another key ("Crypto error: Unpad Error"); and about one in six
/// hundred is sealed under another key for no reason seen from here. None of these says anything about the item.
pub fn is_handshake_fault(e: &keyring::Error) -> bool {
    match e {
        keyring::Error::PlatformFailure(inner) => {
            let said = inner.to_string();
            said.contains("Client public key size is invalid") || said.starts_with("Crypto error")
        }
        _ => false,
    }
}

/// `op`, made again (up to [`KEYSTORE_TRIES`] times in all) while it fails on a session's key exchange
/// ([`is_handshake_fault`]); any other answer, kept item, missing item or refusal, is returned at once. A call to the
/// keystore that fails this way one time in a hundred fails four times running about once in a hundred million.
pub fn retrying<T>(mut op: impl FnMut() -> keyring::Result<T>) -> keyring::Result<T> {
    let mut tries = 1;
    loop {
        match op() {
            Err(e) if tries < KEYSTORE_TRIES && is_handshake_fault(&e) => tries += 1,
            answer => return answer,
        }
    }
}

/// A file only its owner can read (mode 0600), for a dev build's test identity on a local devnet. A rebuilt dev
/// binary is a new program to the Keychain, which asks for the login password again on every rebuild; a file
/// doesn't. Release builds keep the Keychain. The first read moves an existing Keychain item into the file, so the
/// identity, and every agent token derived from it, stays the same. The seed words' entropy is a second file beside the
/// key, named `<key file>.seed` (`root.key.seed`), kept the same way.
pub struct FileStore {
    path: std::path::PathBuf,
    migrate_from: Option<KeychainStore>,
}

impl FileStore {
    pub fn new(path: std::path::PathBuf, migrate_from: Option<KeychainStore>) -> Self {
        Self { path, migrate_from }
    }
}

impl FileStore {
    fn seed_path(&self) -> std::path::PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(".seed");
        self.path.with_file_name(name)
    }
}

impl KeyStore for FileStore {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        if let Some(found) = read_file(&self.path)? {
            return Ok(Some(found));
        }
        let Some(old) = &self.migrate_from else { return Ok(None) };
        let found = old.get()?;
        if let Some(secret) = &found {
            self.set(secret)?;
        }
        Ok(found)
    }

    fn set(&self, secret: &[u8]) -> Result<(), KeystoreError> {
        write_file(&self.path, secret)
    }

    /// The seed file, or, for a key moved in from the Keychain, the Keychain's seed words when they are that key's.
    fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        if let Some(found) = read_file(&self.seed_path())? {
            return Ok(Some(found).filter(|s| !s.is_empty()));
        }
        let Some(old) = &self.migrate_from else { return Ok(None) };
        let Some(found) = old.seed()? else { return Ok(None) };
        if old.get()? != self.get()? {
            return Ok(None);
        }
        self.set_seed(&found)?;
        Ok(Some(found))
    }

    fn set_seed(&self, entropy: &[u8]) -> Result<(), KeystoreError> {
        let path = self.seed_path();
        if entropy.is_empty() {
            return match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(KeystoreError::Unavailable(format!("{}: {e}", path.display()))),
            };
        }
        write_file(&path, entropy)
    }
}

/// A secret kept as hex in `path`, or `None` if there is no such file.
fn read_file(path: &std::path::Path) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
    keep_private(path)?;
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let text = Zeroizing::new(text);
            hex::decode(text.trim()).map(|b| Some(Zeroizing::new(b))).map_err(|e| KeystoreError::Unavailable(format!("{}: {e}", path.display())))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(KeystoreError::Unavailable(format!("{}: {e}", path.display()))),
    }
}

/// Holds a key file, and the folder it is in, to this user before it is read: a file another user owns is never read
/// as the root key (someone else could have put it there), and a file or folder others may read is made private
/// again (0600 and 0700). A file that isn't there yet is fine. Windows keeps a file in the user's profile to that user.
pub fn keep_private(path: &std::path::Path) -> Result<(), KeystoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let err = |e: std::io::Error| KeystoreError::Unavailable(format!("{}: {e}", path.display()));
        let meta = match std::fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(err(e)),
        };
        if !meta.file_type().is_file() {
            return Err(KeystoreError::Unavailable(format!("{} isn't a plain file (a link or a folder): the node reads no key through it", path.display())));
        }
        if let Some(me) = this_user() {
            if meta.uid() != me {
                return Err(KeystoreError::Unavailable(format!("{} belongs to another user (uid {}): the node reads no key it didn't write", path.display(), meta.uid())));
            }
        }
        if meta.mode() & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(err)?;
        }
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            if let Ok(d) = std::fs::metadata(dir) {
                if d.mode() & 0o077 != 0 && this_user() == Some(d.uid()) {
                    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
                }
            }
        }
    }
    Ok(())
}

/// The user this process runs as, without a C call: `/proc/self` belongs to it on Linux; where there is no `/proc`
/// (macOS, the BSDs) a file this process has just made belongs to it.
#[cfg(unix)]
fn this_user() -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self").ok().map(|m| m.uid()).or_else(made_file_owner)
}

/// The owner of a file this process makes and removes at once, which is the user it runs as.
#[cfg(unix)]
fn made_file_owner() -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    let nonce: u64 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos() as u64;
    let path = std::env::temp_dir().join(format!(".unbrowse-whoami-{}-{nonce}", std::process::id()));
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).ok()?;
    let uid = file.metadata().ok().map(|m| m.uid());
    drop(file);
    let _ = std::fs::remove_file(&path);
    uid
}

/// Writes `secret` as hex to `path`, through a temporary file only its owner can read.
fn write_file(path: &std::path::Path, secret: &[u8]) -> Result<(), KeystoreError> {
    unbrowse_files::private::write(path, Zeroizing::new(hex::encode(secret)).as_bytes())
        .map_err(|e| KeystoreError::Unavailable(format!("{}: {e}", path.display())))
}

/// A store whose key is read once a run (`vault.unlock-once`): the first read that finds the key keeps it in memory,
/// and every later read is answered from there, so the system's keystore asks the owner at most once a run however
/// often the node signs, seals or opens. A write goes to the store first and then replaces what is held, so the node
/// never holds a key the store doesn't. A read that finds nothing or fails keeps nothing, and the next one asks the
/// store again. The seed words are read from the store each time: only the owner reads them, and rarely.
///
/// What is held is the key of this process. Another program that replaces the key in the store (a shell's `wallet
/// restore`) does so only while no node runs here, so a running node never holds a key the store has replaced.
pub struct Remembered<S> {
    store: S,
    held: Mutex<Option<Zeroizing<Vec<u8>>>>,
}

impl<S: KeyStore> Remembered<S> {
    pub fn new(store: S) -> Self {
        Self { store, held: Mutex::new(None) }
    }

    fn held(&self) -> std::sync::MutexGuard<'_, Option<Zeroizing<Vec<u8>>>> {
        self.held.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl<S: KeyStore> KeyStore for Remembered<S> {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        // Held while the store is read: two reads at once ask the store once, not twice.
        let mut held = self.held();
        if let Some(key) = held.as_ref() {
            return Ok(Some(key.clone()));
        }
        let read = self.store.get()?;
        if let Some(key) = &read {
            *held = Some(key.clone());
        }
        Ok(read)
    }

    fn set(&self, secret: &[u8]) -> Result<(), KeystoreError> {
        let mut held = self.held();
        self.store.set(secret)?;
        *held = Some(Zeroizing::new(secret.to_vec()));
        Ok(())
    }

    fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        self.store.seed()
    }

    fn set_seed(&self, entropy: &[u8]) -> Result<(), KeystoreError> {
        self.store.set_seed(entropy)
    }
}

/// One store shared by everything in a process that reads the key: what one reader's first read holds, every other
/// reader has.
impl<S: KeyStore + ?Sized> KeyStore for std::sync::Arc<S> {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        (**self).get()
    }

    fn set(&self, secret: &[u8]) -> Result<(), KeystoreError> {
        (**self).set(secret)
    }

    fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        (**self).seed()
    }

    fn set_seed(&self, entropy: &[u8]) -> Result<(), KeystoreError> {
        (**self).set_seed(entropy)
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore {
    secret: Mutex<Option<Zeroizing<Vec<u8>>>>,
    seed: Mutex<Option<Zeroizing<Vec<u8>>>>,
}

impl KeyStore for MemoryStore {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        Ok(self.secret.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone())
    }

    fn set(&self, secret: &[u8]) -> Result<(), KeystoreError> {
        *self.secret.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Zeroizing::new(secret.to_vec()));
        Ok(())
    }

    fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        Ok(self.seed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone())
    }

    fn set_seed(&self, entropy: &[u8]) -> Result<(), KeystoreError> {
        *self.seed.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Zeroizing::new(entropy.to_vec())).filter(|s| !s.is_empty());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store that counts its reads and can be made to fail: the system's keystore, as `Remembered` sees it.
    #[derive(Default)]
    struct Counting {
        inner: MemoryStore,
        reads: std::sync::atomic::AtomicUsize,
        refuse: std::sync::atomic::AtomicBool,
    }

    impl KeyStore for Counting {
        fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.refuse.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(KeystoreError::Unavailable("User canceled the operation.".into()));
            }
            self.inner.get()
        }
        fn set(&self, secret: &[u8]) -> Result<(), KeystoreError> {
            if self.refuse.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(KeystoreError::Unavailable("User canceled the operation.".into()));
            }
            self.inner.set(secret)
        }
        fn seed(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
            self.inner.seed()
        }
        fn set_seed(&self, entropy: &[u8]) -> Result<(), KeystoreError> {
            self.inner.set_seed(entropy)
        }
    }

    #[test]
    fn the_key_is_read_from_the_store_once_a_run() {
        use std::sync::atomic::Ordering::SeqCst;
        let store = Remembered::new(Counting::default());
        // Nothing there yet: each read asks, and nothing is held.
        assert!(store.get().unwrap().is_none());
        assert!(store.get().unwrap().is_none());
        assert_eq!(store.store.reads.load(SeqCst), 2);
        store.store.inner.set(&[7; 32]).unwrap();
        // The first read that finds the key keeps it; however many follow, the store is asked once.
        for _ in 0..50 {
            assert_eq!(store.get().unwrap().unwrap().as_slice(), &[7; 32]);
        }
        assert_eq!(store.store.reads.load(SeqCst), 3, "one read found the key; the rest were answered from memory");
        // Held, the key reads even while the store would refuse: the owner isn't asked again.
        store.store.refuse.store(true, SeqCst);
        assert_eq!(store.get().unwrap().unwrap().as_slice(), &[7; 32]);
        // A write the store refuses leaves the held key as it was: the node never holds a key the store doesn't.
        assert!(store.set(&[9; 32]).is_err());
        assert_eq!(store.get().unwrap().unwrap().as_slice(), &[7; 32]);
        // A write the store takes replaces the held key.
        store.store.refuse.store(false, SeqCst);
        store.set(&[9; 32]).unwrap();
        assert_eq!(store.get().unwrap().unwrap().as_slice(), &[9; 32]);
        assert_eq!(store.store.inner.get().unwrap().unwrap().as_slice(), &[9; 32]);
        assert_eq!(store.store.reads.load(SeqCst), 3);
    }

    #[test]
    fn a_refused_read_holds_nothing_and_the_next_asks_again() {
        use std::sync::atomic::Ordering::SeqCst;
        let store = Remembered::new(Counting::default());
        store.store.inner.set(&[1; 32]).unwrap();
        store.store.refuse.store(true, SeqCst);
        assert!(store.get().is_err());
        store.store.refuse.store(false, SeqCst);
        assert_eq!(store.get().unwrap().unwrap().as_slice(), &[1; 32]);
        assert_eq!(store.store.reads.load(SeqCst), 2);
    }

    #[test]
    #[cfg(unix)]
    fn a_file_store_keeps_its_secret_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("unbrowse-filestore-{}", std::process::id()));
        let store = FileStore::new(dir.join("root.key"), None);
        assert!(store.get().unwrap().is_none());
        store.set(&[1, 2, 3]).unwrap();
        assert_eq!(store.get().unwrap().unwrap().as_slice(), &[1, 2, 3]);
        assert_eq!(std::fs::metadata(dir.join("root.key")).unwrap().permissions().mode() & 0o777, 0o600);
        // The seed words go beside it, kept the same way; empty removes them.
        assert!(store.seed().unwrap().is_none());
        store.set_seed(&[4; 16]).unwrap();
        assert_eq!(store.seed().unwrap().unwrap().as_slice(), &[4; 16]);
        assert_eq!(std::fs::metadata(dir.join("root.key.seed")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(store.get().unwrap().unwrap().as_slice(), &[1, 2, 3], "the key is untouched");
        store.set_seed(&[]).unwrap();
        assert!(store.seed().unwrap().is_none() && !dir.join("root.key.seed").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Without `/proc` (macOS) the node still knows which user it runs as, so the owner check and the folder
    /// tightening still happen there.
    #[test]
    #[cfg(unix)]
    fn the_user_is_known_without_proc() {
        let made = made_file_owner().expect("a made file has an owner");
        if let Ok(m) = std::fs::metadata("/proc/self") {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(made, m.uid());
        }
        assert_eq!(this_user(), Some(made));
    }

    /// A key file others may read, and its folder, are made private before the key is read: 0600 and 0700. A link
    /// in the key's place is never followed.
    #[test]
    #[cfg(unix)]
    fn a_key_file_others_could_read_is_made_private_before_it_is_read() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("unbrowse-filestore-loose-{}", std::process::id()));
        let store = FileStore::new(dir.join("root.key"), None);
        store.set(&[9, 9]).unwrap();
        std::fs::set_permissions(dir.join("root.key"), std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(store.get().unwrap().unwrap().as_slice(), &[9, 9]);
        assert_eq!(std::fs::metadata(dir.join("root.key")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let linked = FileStore::new(dir.join("linked.key"), None);
        std::os::unix::fs::symlink(dir.join("root.key"), dir.join("linked.key")).unwrap();
        assert!(linked.get().is_err(), "a link in a key's place is refused");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn platform(said: &str) -> keyring::Error {
        keyring::Error::PlatformFailure(said.to_string().into())
    }

    /// The two faults ksecretd gives on a bad key exchange (UNB-146), word for word as keyring shows them, are made
    /// again with a new session; the answer after is the one returned.
    #[test]
    fn a_failed_key_exchange_is_made_again() {
        for said in ["DBus error: Client public key size is invalid", "Crypto error: Unpad Error"] {
            let mut calls = 0;
            let got = retrying(|| {
                calls += 1;
                if calls < 3 { Err(platform(said)) } else { Ok("secret".to_string()) }
            });
            assert_eq!(got.unwrap(), "secret", "{said}");
            assert_eq!(calls, 3, "{said}");
        }
    }

    /// A fault that keeps happening is still said, after [`KEYSTORE_TRIES`] calls, not hidden or looped on.
    #[test]
    fn a_key_exchange_that_keeps_failing_is_said_after_four_tries() {
        let mut calls = 0;
        let got: keyring::Result<()> = retrying(|| {
            calls += 1;
            Err(platform("Crypto error: Unpad Error"))
        });
        assert!(matches!(got, Err(keyring::Error::PlatformFailure(_))));
        assert_eq!(calls, KEYSTORE_TRIES);
    }

    /// Anything else is the keystore's answer and is returned at once: a missing item, a locked store, another
    /// platform failure.
    #[test]
    fn other_answers_are_not_made_again() {
        let answers: Vec<fn() -> keyring::Error> = vec![
            || keyring::Error::NoEntry,
            || keyring::Error::NoStorageAccess("Secret Service: object locked".to_string().into()),
            || keyring::Error::PlatformFailure("No DBus session or Secret Service provider found".to_string().into()),
        ];
        for make in answers {
            let mut calls = 0;
            let got: keyring::Result<()> = retrying(|| {
                calls += 1;
                Err(make())
            });
            assert!(got.is_err());
            assert_eq!(calls, 1, "{}", make());
        }
    }

    /// Reports this machine's real OS keystore round-trip. Ignored in CI (no keystore there); run by hand on a box
    /// whose keyring is suspect: `cargo test -p unbrowse-core --ignored -- --nocapture`. On a keystore that corrupts
    /// secrets (some Linux KWallet setups) it prints false, which is why the node falls back to a file there.
    #[test]
    #[ignore = "touches this machine's real OS keystore"]
    fn reports_this_machines_keystore_round_trip() {
        let service = if cfg!(debug_assertions) { "network.unbrowse.node.dev" } else { "network.unbrowse.node" };
        println!("OS keystore round-trips a secret: {}", KeychainStore::reliable(service));
    }
}
