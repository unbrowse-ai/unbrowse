//! The node's own wire protocols, and the versions of each it speaks.
//!
//! Each request-response protocol is named `/unbrowse/<name>/<version>`. When one changes, its new version is spoken
//! beside the old one for one release: a node of the release that made the change offers both, newest first, and
//! multistream-select settles on the newest version both ends speak, so the node talks to the release before (which
//! speaks only the old one) and to the release after (which speaks only the new one). The release after drops the old
//! version. Two releases apart don't talk on that protocol: `min_version` keeps a node that far behind off the network
//! anyway.
//!
//! - Change notices travel on gossipsub, which negotiates its own transport (`changes::CHANGES_PROTOCOL`), so their
//!   version is in the topic (`changes::topic_of`): version 1 is `/unbrowse/site/<site>/changes`, a later one
//!   `/unbrowse/site/<site>/changes/<n>`. A node that speaks two versions watches both topics and publishes on both.
//! - The table's protocol (`node::KAD_PROTOCOL`) is libp2p's own Kademlia, which takes a single name: a change to it
//!   is a new table, not a new version of one message, and isn't run side by side.
//! - Identify's protocol version (`/unbrowse/id/1.0.0`) is only said, never checked.
//!
//! A codec is handed the protocol it negotiated: one whose versions read differently asks `version_of` it.

use libp2p::request_response::ProtocolSupport;
use libp2p::StreamProtocol;

pub const HELLO: &str = "hello";
pub const LISTINGS: &str = "listings";
pub const BODY: &str = "body";
pub const TOWER: &str = "tower";
pub const LEAVING: &str = "leaving";
pub const CHANGES: &str = "changes";

/// What this release speaks of each protocol, newest first. A change puts its new version in front of the old one
/// here, and the release after takes the old one out.
pub const THIS_RELEASE: &[(&str, &[u32])] = &[(HELLO, &[1]), (LISTINGS, &[1]), (BODY, &[1]), (TOWER, &[1]), (LEAVING, &[1]), (CHANGES, &[1])];

/// The versions of each protocol a node speaks, newest first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Speaks(Vec<(&'static str, Vec<u32>)>);

impl Default for Speaks {
    /// This release's.
    fn default() -> Self {
        Speaks(THIS_RELEASE.iter().map(|(n, v)| (*n, v.to_vec())).collect())
    }
}

impl Speaks {
    /// The versions of `name` spoken, newest first.
    pub fn versions(&self, name: &str) -> &[u32] {
        self.0.iter().find(|(n, _)| *n == name).map_or(&[], |(_, v)| v.as_slice())
    }

    /// The same, speaking `versions` of `name` instead: what another release speaks, for a test of two releases.
    pub fn with(mut self, name: &'static str, versions: &[u32]) -> Self {
        match self.0.iter_mut().find(|(n, _)| *n == name) {
            Some((_, v)) => *v = versions.to_vec(),
            None => self.0.push((name, versions.to_vec())),
        }
        self
    }

    /// Every protocol at `versions`.
    pub fn every(versions: &[u32]) -> Self {
        Speaks(THIS_RELEASE.iter().map(|(n, _)| (*n, versions.to_vec())).collect())
    }

    /// The stream protocols `name` is offered and taken under, newest first.
    pub fn protocols(&self, name: &str) -> Vec<(StreamProtocol, ProtocolSupport)> {
        self.versions(name).iter().map(|v| (protocol(name, *v), ProtocolSupport::Full)).collect()
    }

    /// Whether every protocol has a version to speak: a node with none of one could never answer it.
    pub fn check(&self) -> Result<(), String> {
        match THIS_RELEASE.iter().find(|(n, _)| self.versions(n).is_empty()) {
            Some((n, _)) => Err(format!("no version of /unbrowse/{n} to speak")),
            None => Ok(()),
        }
    }
}

/// Version `v` of protocol `name`.
pub fn protocol(name: &str, v: u32) -> StreamProtocol {
    StreamProtocol::try_from_owned(format!("/unbrowse/{name}/{v}")).expect("a protocol name starts with /")
}

/// Which version of one of these protocols `p` is.
pub fn version_of(p: &StreamProtocol) -> Option<u32> {
    p.as_ref().strip_prefix("/unbrowse/")?.rsplit_once('/')?.1.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This release's names are the ones the network has always used, so a node of the release before still talks.
    #[test]
    fn this_releases_names_are_the_networks_own() {
        let s = Speaks::default();
        assert!(s.check().is_ok());
        for (name, was) in [(BODY, crate::BODY_PROTOCOL), (TOWER, crate::TOWER_PROTOCOL), (HELLO, "/unbrowse/hello/1"), (LISTINGS, "/unbrowse/listings/1"), (LEAVING, "/unbrowse/leaving/1")] {
            assert_eq!(s.protocols(name).iter().map(|(p, _)| p.to_string()).collect::<Vec<_>>(), [was]);
        }
        assert_eq!(version_of(&protocol(BODY, 7)), Some(7));
    }

    /// A release that changes a protocol offers the new version first and still the old one.
    #[test]
    fn a_changed_protocol_offers_the_new_version_first_and_the_old_beside_it() {
        let s = Speaks::default().with(BODY, &[2, 1]);
        assert_eq!(s.protocols(BODY).iter().map(|(p, _)| p.to_string()).collect::<Vec<_>>(), ["/unbrowse/body/2", "/unbrowse/body/1"]);
        assert_eq!(s.versions(TOWER), [1], "the others are as they were");
        assert!(Speaks::default().with(BODY, &[]).check().is_err());
    }
}
