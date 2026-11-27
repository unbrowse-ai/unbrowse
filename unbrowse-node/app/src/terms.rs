//! The terms and the network: what the owner was shown, and the one rule that reads it. The node joins the peer network
//! only with the current terms acknowledged and the owner not keeping it off; anything else it does, it does without
//! that, since none of it reaches the network. The window acknowledges them on its first-run screen, a node with no
//! window with `unbrowse-node terms accept`. `Settings::terms_accepted` is written here alone: `save_settings` keeps it.

use serde::Serialize;

use crate::store::{self, Settings};

/// The latest version TERMS.md and PRIVACY.md carry. Raising it asks every owner again, and holds their node off the
/// network until they answer.
pub const TERMS_VERSION: &str = "2026-11-01";

/// What the owner acknowledges, carried in the program: the window shows the terms of the node that holds them, which
/// updates by itself and can be newer than the window.
const TERMS: &str = include_str!("../../../TERMS.md");
const PRIVACY: &str = include_str!("../../../PRIVACY.md");

/// The terms as the window shows them.
#[derive(Serialize)]
pub struct TermsText {
    version: &'static str,
    terms: &'static str,
    privacy: &'static str,
}

pub fn text() -> TermsText {
    TermsText { version: TERMS_VERSION, terms: TERMS, privacy: PRIVACY }
}

/// Where a node stands on joining the peer network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    Joins,
    /// The owner keeps it off, whatever they acknowledged.
    KeptOff,
    /// The owner hasn't answered for the current terms: an older version acknowledged is no answer to this one.
    TermsDue,
}

pub fn standing(s: &Settings) -> Standing {
    if !s.peer_network {
        Standing::KeptOff
    } else if s.terms_accepted.as_deref() == Some(TERMS_VERSION) {
        Standing::Joins
    } else {
        Standing::TermsDue
    }
}

/// `s` with the current terms acknowledged and the owner's answer on the network in it.
pub fn acknowledged(mut s: Settings, keep_off: bool) -> Settings {
    s.terms_accepted = Some(TERMS_VERSION.into());
    s.peer_network = !keep_off;
    s
}

/// A node waiting on the owner for the terms, said wherever a node that isn't joining says why: its health, which
/// agents read (`unbrowse_whoami`), so in the app's words and never as a command (`said_to_agents`).
pub fn due() -> String {
    format!("this node stays off the peer network until its owner acknowledges terms {TERMS_VERSION}, which the Unbrowse app asks for when it opens")
}

/// Said at start, before the chain or anything else that can hold the node up: on a machine with no window, the node's
/// output is the only place the owner hears it (`unbrowse start`), so it also names the commands.
pub fn announce() {
    if standing(&store::load_settings()) == Standing::TermsDue {
        eprintln!("{}", announced());
    }
}

/// What the node's output says while the terms wait: `due`, and how an owner with no window answers.
pub fn announced() -> String {
    format!("{}; with no window, read them (`unbrowse-node terms show`) and run `unbrowse-node terms accept` (`unbrowse-node network off` keeps it off)", due())
}

/// The terms and the privacy notice in full, as `unbrowse-node terms show` prints them.
pub fn full() -> String {
    format!("{TERMS}\n{PRIVACY}")
}

/// What `unbrowse-node terms` says of the network, for the node's owner.
pub fn joining(s: &Settings) -> String {
    match standing(s) {
        Standing::Joins => "the node joins the peer network (`unbrowse-node network off` keeps it off)".into(),
        Standing::KeptOff => "the node stays off the peer network (`unbrowse-node network on` joins)".into(),
        Standing::TermsDue => due(),
    }
}

/// `unbrowse-node terms [show|accept]`: where the terms are and whether they're acknowledged, the terms themselves, or
/// acknowledging them from a shell. The node needn't be running; a running one sees it within a second.
pub fn cli(args: &[String]) -> i32 {
    let s = store::load_settings();
    match args.first().map(String::as_str) {
        None => {
            println!("terms {TERMS_VERSION}: `unbrowse-node terms show` prints them");
            println!("{}", if s.terms_accepted.as_deref() == Some(TERMS_VERSION) { "acknowledged" } else { "not acknowledged yet: `unbrowse-node terms accept` records it" });
            println!("{}", joining(&s));
            0
        }
        Some("show") => {
            println!("{}", full());
            0
        }
        Some("accept") => {
            let keep_off = !s.peer_network;
            let s = acknowledged(s, keep_off);
            match store::save_settings(&s) {
                Ok(()) => {
                    println!("accepted terms {TERMS_VERSION}: {}", joining(&s));
                    0
                }
                Err(e) => {
                    eprintln!("saving the acceptance: {e}");
                    1
                }
            }
        }
        _ => {
            eprintln!("usage: unbrowse-node terms [show|accept]");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(terms_accepted: Option<&str>, peer_network: bool) -> Settings {
        Settings { terms_accepted: terms_accepted.map(Into::into), peer_network, ..Settings::default() }
    }

    #[test]
    fn a_node_holds_off_the_network_until_the_current_terms_are_acknowledged() {
        assert_eq!(standing(&Settings::default()), Standing::TermsDue, "a new node has answered nothing");
        assert_eq!(standing(&settings(Some("2020-01-01"), true)), Standing::TermsDue, "an older version answers nothing about this one");
        assert_eq!(standing(&settings(Some(TERMS_VERSION), true)), Standing::Joins);
    }

    #[test]
    fn an_owner_who_keeps_the_node_off_stays_off_whatever_they_acknowledged() {
        assert_eq!(standing(&settings(None, false)), Standing::KeptOff);
        assert_eq!(standing(&settings(Some(TERMS_VERSION), false)), Standing::KeptOff);
    }

    #[test]
    fn acknowledging_records_the_version_and_the_owners_answer_on_the_network() {
        let on = acknowledged(Settings::default(), false);
        assert_eq!((on.terms_accepted.as_deref(), on.peer_network), (Some(TERMS_VERSION), true));
        assert_eq!(standing(&acknowledged(Settings::default(), true)), Standing::KeptOff);
    }

    /// The version a document opens with ("Version 2026-11-01. Effective ...").
    fn version_of(document: &str) -> &str {
        document.lines().find_map(|l| l.strip_prefix("Version ")).and_then(|l| l.split('.').next()).expect("a document says its version")
    }

    /// The node joins only once its owner has answered (`standing`), so terms saying it joins when it runs describe a
    /// node this isn't. On a machine with no window the answer is `terms accept`, which the node's output names when it
    /// waits; what agents read of it (`due`, in the node's health) says where the app asks, and names no command.
    #[test]
    fn the_terms_say_the_node_waits_for_its_owners_answer() {
        assert!(announced().contains("`unbrowse-node terms accept`"));
        assert!(!due().contains("unbrowse-node"), "{}", due());
        assert!(TERMS.contains("`unbrowse-node terms accept`"), "TERMS.md names how an owner with no window answers");
    }

    #[test]
    fn the_version_asked_about_is_the_latest_the_documents_carry() {
        assert_eq!(TERMS_VERSION, version_of(TERMS).max(version_of(PRIVACY)));
    }
}

#[cfg(test)]
#[path = "terms_cov_tests.rs"]
mod terms_cov_tests;
