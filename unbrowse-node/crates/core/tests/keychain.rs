//! Round trip through the real OS keystore, under a throwaway item that is deleted afterwards.
//! Ignored by default because it writes to the user's Keychain:
//!   cargo test -p unbrowse-core -- --ignored

use unbrowse_core::{load_or_create, KeyStore, KeychainStore};

#[test]
#[ignore]
fn root_key_survives_a_restart_in_the_keychain() {
    let store = KeychainStore::new("network.unbrowse.node.test", "root-key").unwrap();
    store.delete().unwrap();

    let first = load_or_create(&store).unwrap();
    assert!(first.created);

    // A fresh handle, as after an app restart.
    let reopened = KeychainStore::new("network.unbrowse.node.test", "root-key").unwrap();
    let second = load_or_create(&reopened).unwrap();
    assert!(!second.created);
    assert_eq!(first.address, second.address);
    assert!(reopened.seed().unwrap().is_some(), "the seed words are a second item beside the key");

    reopened.delete().unwrap();
    assert!(reopened.seed().unwrap().is_none());
}
