//! Coverage tests for `terms.rs`: what a node still owing the terms says, and the shell command's failure.

use super::*;

#[test]
fn a_node_that_still_owes_the_terms_says_so_where_it_says_its_network() {
    assert_eq!(joining(&Settings::default()), due());
    let accepted = acknowledged(Settings::default(), false);
    assert!(joining(&accepted).contains("joins the peer network"));
    assert!(joining(&acknowledged(Settings::default(), true)).contains("stays off the peer network"));
}

/// `terms accept` writes the owner's yes; a home that can't take it says so and exits 1, with nothing recorded.
#[test]
fn accepting_the_terms_from_a_shell_fails_loudly_when_it_cannot_be_kept() {
    store::scratch_home("terms-cov-accept");
    assert_eq!(cli(&["accept".to_string()]), 0);
    assert_eq!(store::load_settings().terms_accepted.as_deref(), Some(TERMS_VERSION));
    let blocked = store::scratch_home("terms-cov-accept-blocked");
    // The settings file's place held by a folder: the acceptance can't be written over it.
    std::fs::create_dir_all(blocked.join("settings.json")).unwrap();
    assert_eq!(cli(&["accept".to_string()]), 1);
    assert_eq!(store::load_settings().terms_accepted, None);
    assert_eq!(cli(&["nonsense".to_string()]), 2);
    assert_eq!(cli(&[]), 0);
    assert_eq!(cli(&["show".to_string()]), 0);
}
