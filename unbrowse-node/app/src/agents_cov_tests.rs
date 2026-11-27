use super::*;

fn keys() -> unbrowse_core::MemoryStore {
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    keys
}

/// Naming the wallet a key already pays from changes nothing: no payer entry is added, the file is not rewritten.
#[test]
fn naming_the_wallet_a_key_already_pays_from_writes_nothing() {
    let _home = store::scratch_home("agents-cov-payer-same");
    let keys = keys();
    let a = ensure_first(&keys, 0).unwrap().unwrap();
    set_payer(a.index, 3, None).unwrap();
    assert!(list()[0].payers.is_empty(), "the node's own wallet is already the payer");
    let w: alloy::primitives::Address = "0x00000000000000000000000000000000000000a1".parse().unwrap();
    set_payer(a.index, 3, Some(w)).unwrap();
    set_payer(a.index, 9, Some(w)).unwrap();
    assert_eq!(list()[0].payers.len(), 1, "the same wallet again adds no later epoch");
    assert_eq!(payer_at(a.index, 3), Some(w));
    assert_eq!(payer_at(a.index, 2), None, "before its epoch the key paid from the node's wallet");
}

/// A remote key is made for a gateway's host alone: a blank host or a URL is refused and no key is made.
#[test]
fn a_remote_key_needs_a_gateways_host_and_makes_no_key_without_one() {
    let _home = store::scratch_home("agents-cov-gateway");
    let keys = keys();
    for bad in ["", "   ", "https://gw.example/x"] {
        let e = create_for_gateway(&keys, "remote", 1.0, 30, bad).unwrap_err();
        assert!(e.contains("isn't a gateway's host"), "{e}");
    }
    assert!(list().is_empty(), "no key was made");
    let (a, token) = create_for_gateway(&keys, "remote", 1.0, 30, " GW.Example ").unwrap();
    assert_eq!(a.gateway.as_deref(), Some("gw.example"), "the host is trimmed and lowercased");
    assert!(by_token(&keys, &token).is_none(), "a remote key never opens the node's own door");
    assert_eq!(by_gateway_token(&keys, &token, "gw.example").map(|x| x.index), Some(a.index));
}

/// A key needs a real name: blank, or one that reads as a command-line option, is refused and nothing is saved.
#[test]
fn a_key_with_no_name_or_an_options_name_is_refused() {
    let _home = store::scratch_home("agents-cov-name");
    let keys = keys();
    assert_eq!(create(&keys, "  ", 1.0, 30, 0).unwrap_err(), "give the agent a name");
    let e = create(&keys, " --help", 1.0, 30, 0).unwrap_err();
    assert!(e.contains("--help looks like an option"), "{e}");
    assert!(list().is_empty());
}

/// A revoke the node can't write down is not lost silently: nothing half-written is left in the owed file's place.
#[test]
fn a_revoke_owed_that_cannot_be_written_leaves_no_owed_file() {
    let home = store::scratch_home("agents-cov-owed-blocked");
    std::fs::create_dir(home.join("revokes-owed.json.part")).unwrap();
    owe_revoke(4);
    assert!(!home.join("revokes-owed.json").exists());
    assert!(revokes_owed().is_empty());
}

/// A key the chain already had revoked is revoked here and says so in the log; a key that isn't here changes nothing.
#[test]
fn a_key_the_chain_revoked_is_revoked_here_and_logged() {
    let _home = store::scratch_home("agents-cov-chain-revoked");
    let keys = keys();
    let a = ensure_first(&keys, 0).unwrap().unwrap();
    let before = store::read_activity(50).len();
    revoke_as_the_chain_has(a.index + 5);
    assert!(!list()[0].revoked, "an index not here changes no key");
    assert_eq!(store::read_activity(50).len(), before, "and says nothing");
    revoke_as_the_chain_has(a.index);
    assert!(list()[0].revoked);
    let log = store::read_activity(50);
    assert_eq!(log.len(), before + 1);
    assert_eq!(log[0].what, format!("Revoked {}'s key, as the chain already had", a.name));
    assert_eq!(log[0].who, "Node");
}

/// New terms land on a live key only: a revoked key keeps the cap and expiry it had.
#[test]
fn new_terms_reach_a_live_key_and_never_a_revoked_one() {
    let _home = store::scratch_home("agents-cov-terms");
    let keys = keys();
    let a = ensure_first(&keys, 0).unwrap().unwrap();
    set_terms(a.index, 2.5, 12345);
    let k = list().remove(0);
    assert_eq!((k.cap_usdc, k.expires), (2.5, 12345));
    revoke_quietly(a.index).unwrap();
    set_terms(a.index, 9.0, 99999);
    let k = list().remove(0);
    assert_eq!((k.cap_usdc, k.expires), (2.5, 12345), "a revoked key's terms stay as they were");
    set_terms(a.index + 3, 1.0, 1);
    assert_eq!(list().len(), 1);
}

/// Revoking the node's first key also forgets which key `--agent first` meant, and only for that key.
#[test]
fn forgetting_the_first_keys_grant_forgets_which_key_is_first() {
    let _home = store::scratch_home("agents-cov-forget-first");
    write_grant(0, "tok0", true).unwrap();
    write_grant(1, "tok1", false).unwrap();
    forget_grant(1);
    assert!(first_path().exists(), "another key's grant going leaves first as it was");
    assert_eq!(read_grant(0).as_deref(), Some("tok0"));
    forget_grant(0);
    assert!(!first_path().exists());
    assert!(read_grant(0).is_none());
}
