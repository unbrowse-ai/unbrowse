//! Coverage tests for `onboard.rs`: the steps that need no node, no terminal and no screen.

use super::*;

#[test]
fn a_word_onboard_does_not_know_is_said_with_its_usage_and_exits_2() {
    assert_eq!(cli(&["--no-such-thing".to_string()]), 2);
    assert_eq!(cli(&["--website".to_string(), "--key-file".to_string(), "k".to_string()]), 2, "two ways to sign in");
}

/// The terms are acknowledged on the command line's own yes, and the owner's earlier answer on the network stands.
#[test]
fn the_terms_a_command_line_accepts_are_acknowledged_with_the_network_as_chosen() {
    store::scratch_home("onboard-cov-terms-on");
    assert_eq!(store::load_settings().terms_accepted, None);
    terms_step(false, true).unwrap();
    let s = store::load_settings();
    assert_eq!((s.terms_accepted.as_deref(), s.peer_network), (Some(terms::TERMS_VERSION), true));

    store::scratch_home("onboard-cov-terms-off");
    terms_step(true, true).unwrap();
    let s = store::load_settings();
    assert_eq!((s.terms_accepted.as_deref(), s.peer_network), (Some(terms::TERMS_VERSION), false), "--keep-off keeps it off");
}

/// Terms already acknowledged are not asked again, but `--keep-off` still takes the node off the network.
#[test]
fn terms_already_acknowledged_are_not_asked_again_but_keep_off_is_still_kept() {
    store::scratch_home("onboard-cov-terms-again");
    terms_step(false, true).unwrap();
    assert!(store::load_settings().peer_network);
    terms_step(false, false).unwrap();
    assert!(store::load_settings().peer_network, "acknowledged and joined: left as it is");
    terms_step(true, false).unwrap();
    let s = store::load_settings();
    assert_eq!((s.terms_accepted.as_deref(), s.peer_network), (Some(terms::TERMS_VERSION), false));
    // Once kept off, a later run with no flag keeps it off.
    terms_step(false, false).unwrap();
    assert!(!store::load_settings().peer_network);
}

#[test]
fn a_path_under_the_users_home_is_read_from_it() {
    assert_eq!(expand(Path::new("/etc/key")), PathBuf::from("/etc/key"));
    assert_eq!(expand(Path::new("relative/key")), PathBuf::from("relative/key"));
    if let Some(home) = std::env::var_os("HOME") {
        assert_eq!(expand(Path::new("~/keys/me")), PathBuf::from(home).join("keys/me"));
        assert_eq!(expand(Path::new("~")), PathBuf::from(std::env::var_os("HOME").unwrap()).join(""));
    }
    assert_eq!(expand(Path::new("~other/key")), PathBuf::from("~other/key"), "another user's home is not this one's");
}
