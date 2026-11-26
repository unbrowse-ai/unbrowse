//! The keystores that stand over the OS keychain, run against keyring's in-memory mock credential store so no real
//! Keychain, Credential Manager or Secret Service is touched. A separate test binary: the default credential builder
//! is process-global, so it is set here and nowhere else.

use std::sync::Once;
use unbrowse_core::{FileStore, KeyStore, KeychainStore, Remembered};

fn mock_keychain() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| keyring::set_default_credential_builder(keyring::mock::default_credential_builder()));
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("unbrowse-keystore-mock-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_keychain_item_hands_back_the_key_and_the_seed_words_it_was_given() {
    mock_keychain();
    let store = KeychainStore::new("network.unbrowse.node.test", "mock-key").unwrap();
    assert!(store.get().unwrap().is_none(), "nothing stored yet");
    assert!(store.seed().unwrap().is_none());
    store.set(&[7; 32]).unwrap();
    store.set_seed(&[5; 16]).unwrap();
    assert_eq!(store.get().unwrap().unwrap().as_slice(), &[7; 32]);
    assert_eq!(store.seed().unwrap().unwrap().as_slice(), &[5; 16]);
}

#[test]
fn empty_seed_words_remove_them_and_a_missing_item_is_not_an_error() {
    mock_keychain();
    let store = KeychainStore::new("network.unbrowse.node.test", "mock-seed").unwrap();
    store.set_seed(&[5; 16]).unwrap();
    store.set_seed(&[]).unwrap();
    assert!(store.seed().unwrap().is_none(), "words removed");
    store.set_seed(&[]).unwrap();
    store.delete().unwrap();
}

#[test]
fn a_keychain_that_hands_back_what_it_was_given_is_reliable() {
    mock_keychain();
    assert!(KeychainStore::reliable("network.unbrowse.node.test"));
}

#[test]
fn a_key_moves_from_the_keychain_to_the_file_and_stays_there() {
    mock_keychain();
    let dir = scratch("migrate");
    let old = KeychainStore::new("network.unbrowse.node.test", "mock-migrate").unwrap();
    old.set(&[3; 32]).unwrap();
    let store = FileStore::new(dir.join("root.key"), Some(old));
    assert!(!dir.join("root.key").exists());
    assert_eq!(store.get().unwrap().unwrap().as_slice(), &[3; 32]);
    assert!(dir.join("root.key").exists(), "the first read wrote the file");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_file_store_with_no_key_and_nothing_to_move_in_has_none() {
    mock_keychain();
    let dir = scratch("empty-migrate");
    let old = KeychainStore::new("network.unbrowse.node.test", "mock-empty").unwrap();
    let store = FileStore::new(dir.join("root.key"), Some(old));
    assert!(store.get().unwrap().is_none());
    assert!(!dir.join("root.key").exists(), "nothing is written for a key that isn't there");
    assert!(store.seed().unwrap().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn seed_words_move_in_from_the_keychain_only_when_they_are_the_moved_keys() {
    mock_keychain();
    let dir = scratch("migrate-seed");
    let old = KeychainStore::new("network.unbrowse.node.test", "mock-migrate-seed").unwrap();
    old.set(&[3; 32]).unwrap();
    old.set_seed(&[4; 16]).unwrap();
    let store = FileStore::new(dir.join("root.key"), Some(old));
    assert_eq!(store.get().unwrap().unwrap().as_slice(), &[3; 32]);
    assert_eq!(store.seed().unwrap().unwrap().as_slice(), &[4; 16]);
    assert!(dir.join("root.key.seed").exists(), "the words were moved into their own file");

    // A key that is not the keychain's: its words are not this key's.
    let other = scratch("migrate-seed-other");
    let old = KeychainStore::new("network.unbrowse.node.test", "mock-migrate-other").unwrap();
    old.set(&[3; 32]).unwrap();
    old.set_seed(&[4; 16]).unwrap();
    let store = FileStore::new(other.join("root.key"), Some(old));
    std::fs::create_dir_all(&other).unwrap();
    store.set(&[8; 32]).unwrap();
    assert!(store.seed().unwrap().is_none(), "the keychain's words belong to another key");
    assert!(!other.join("root.key.seed").exists());
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&other);
}

#[test]
fn a_file_store_without_a_keychain_has_no_words_until_it_is_given_some() {
    let dir = scratch("seed-roundtrip");
    let store = FileStore::new(dir.join("root.key"), None);
    assert!(store.seed().unwrap().is_none());
    store.set_seed(&[1, 2, 3]).unwrap();
    assert_eq!(store.seed().unwrap().unwrap().as_slice(), &[1, 2, 3]);
    store.set_seed(&[]).unwrap();
    store.set_seed(&[]).unwrap();
    assert!(store.seed().unwrap().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_key_file_that_is_not_hex_is_said_so_not_read_as_a_key() {
    let dir = scratch("nothex");
    std::fs::write(dir.join("root.key"), "this is not hex").unwrap();
    let said = FileStore::new(dir.join("root.key"), None).get().unwrap_err().to_string();
    assert!(said.contains("root.key"), "{said}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[cfg(unix)]
fn a_folder_in_the_place_of_the_seed_file_is_an_error_to_read_and_to_clear() {
    let dir = scratch("seed-dir");
    std::fs::create_dir_all(dir.join("root.key.seed")).unwrap();
    let store = FileStore::new(dir.join("root.key"), None);
    let read = store.seed().unwrap_err().to_string();
    assert!(read.contains("root.key.seed") && read.contains("isn't a plain file"), "{read}");
    assert!(store.set_seed(&[]).unwrap_err().to_string().contains("root.key.seed"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[cfg(unix)]
fn a_path_the_system_cannot_look_up_is_an_error_not_a_missing_key() {
    let said = unbrowse_core::keystore::keep_private(std::path::Path::new("bad\0name")).unwrap_err().to_string();
    assert!(said.contains("bad"), "{said}");
}

#[test]
fn a_remembered_store_passes_the_seed_words_through_to_its_store() {
    let dir = scratch("remembered-seed");
    let store = Remembered::new(FileStore::new(dir.join("root.key"), None));
    assert!(store.seed().unwrap().is_none());
    store.set_seed(&[6; 16]).unwrap();
    assert_eq!(store.seed().unwrap().unwrap().as_slice(), &[6; 16]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_store_shared_by_arc_is_one_store() {
    let dir = scratch("arc");
    let a = std::sync::Arc::new(Remembered::new(FileStore::new(dir.join("root.key"), None)));
    let b = a.clone();
    a.set(&[2; 32]).unwrap();
    a.set_seed(&[9; 16]).unwrap();
    assert_eq!(b.get().unwrap().unwrap().as_slice(), &[2; 32]);
    assert_eq!(b.seed().unwrap().unwrap().as_slice(), &[9; 16]);
    b.set_seed(&[]).unwrap();
    assert!(a.seed().unwrap().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}
