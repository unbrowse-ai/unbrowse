//! Change notices: a contributor's node says, over gossipsub, that it delisted or repriced entries, so the nodes that
//! keep a copy of a route or serve its site hear of it in seconds rather than at their next read of the chain. The
//! chain stays the truth: a notice only makes a node read the chain again for the entries it names, now, and changes
//! nothing on its own. A forged one, or one from a peer the registry doesn't admit, is dropped and never forwarded.
//!
//! - Each registrable site has a topic, `/unbrowse/site/<site>/changes`, on Unbrowse's own gossipsub protocol name,
//!   so it never mixes with another network's. That is version 1 of the notices; a later version goes on
//!   `/unbrowse/site/<site>/changes/<n>` (`topic_of`), and a node speaking two watches and publishes on both
//!   (`wire.rs`).
//! - A notice (`Change`) names the site, what changed, the entries and when. Gossipsub signs it with the publishing
//!   node's key, and only signed notices are read (`ValidationMode::Strict`); its source must count, as a provider
//!   record's must (`node.rs`).
//! - The topic scores its peers with gossipsub's own peer scoring (`score`), tuned for a topic that carries a few notices
//!   a day: see `topic_score` for each parameter and why.

use std::time::Duration;

use libp2p::gossipsub::{self, IdentTopic, PeerScoreParams, PeerScoreThresholds, TopicHash, TopicScoreParams, ValidationMode, Version};
use serde::{Deserialize, Serialize};

use crate::budget::Rate;

/// The gossipsub protocol name the network speaks.
pub const CHANGES_PROTOCOL: &str = "/unbrowse/changes/1.1.0";
/// A notice is a site, a word, a time and at most `MAX_CHANGED` entry ids: well under this.
pub const MAX_CHANGE_BYTES: usize = 4 * 1024;
/// A signed withdrawal is a signature in hex, well under this.
pub const MAX_WITHDRAWAL_CHARS: usize = 200;
/// Entries one notice names, at most. A node that changes more on one site sends more notices.
pub const MAX_CHANGED: usize = 32;
/// How far a notice's time may be from the reader's clock. One older is from another time, and is read from the chain
/// on the node's own schedule anyway.
pub const CHANGE_SKEW: u64 = 600;
/// Notices one source may publish that this node reads and forwards: a burst covers delisting a site's routes at once,
/// and a slow refill covers repricing. Past it, a notice is ignored, neither read nor forwarded.
pub(crate) const CHANGE_RATE: Rate = Rate { burst: 64.0, per_second: 1.0, peers: 1024 };
/// How long a notice from a source not yet judged waits for the verdict before it is dropped.
pub(crate) const JUDGE_WAIT: Duration = Duration::from_secs(10);
/// What the application score of a peer the registry refused is: below the graylist, so gossipsub ignores everything it
/// sends and grafts it to no mesh.
pub(crate) const REFUSED_SCORE: f64 = -1000.0;

/// What changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    /// The contributor delisted the entries: no node should run or serve them.
    Delisted,
    /// The contributor's fee changed, which every entry it lists charges.
    Repriced,
}

/// A change notice: the site whose topic carries it, what changed, the entries (`0x` and 64 hex digits each) and when,
/// in seconds since 1970.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub site: String,
    pub kind: ChangeKind,
    pub entries: Vec<String>,
    pub at: u64,
    /// For each entry, in order, its contributor's signed withdrawal of its listing, or none at all. The chain holds an
    /// entry only once a claim has credited it; until then the contributor's signature is the only word that it is
    /// withdrawn (R2.16), and the node that reads the notice checks it against the listing it keeps. Opaque here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub signed: Vec<String>,
}

/// A notice this node read: what it says, and the node that published it, with the identity it counts under.
#[derive(Clone, Debug)]
pub struct Heard {
    pub change: Change,
    pub from: libp2p::PeerId,
    pub identity: String,
}

/// The topic a site's notices go on, in version 1.
pub fn topic(site: &str) -> IdentTopic {
    topic_of(site, 1)
}

/// The topic a site's notices of version `v` go on.
pub fn topic_of(site: &str, v: u32) -> IdentTopic {
    match v {
        1 => IdentTopic::new(format!("/unbrowse/site/{site}/changes")),
        v => IdentTopic::new(format!("/unbrowse/site/{site}/changes/{v}")),
    }
}

/// The version of the notices `on` carries, when it is one of `site`'s topics.
pub fn version_on(site: &str, on: &TopicHash) -> Option<u32> {
    let rest = on.as_str().strip_prefix(&format!("/unbrowse/site/{site}/changes"))?;
    match rest.strip_prefix('/') {
        None if rest.is_empty() => Some(1),
        Some(v) => v.parse().ok().filter(|v| *v > 1),
        None => None,
    }
}

impl Change {
    /// A notice of `kind` for `entries` on `site`, now.
    pub fn now(site: &str, kind: ChangeKind, entries: Vec<String>) -> Change {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        Change { site: site.to_string(), kind, entries, at, signed: vec![] }
    }

    /// Whether the notice is one a node reads: for a registrable site, naming 1 to `MAX_CHANGED` entry ids, made within
    /// `CHANGE_SKEW` of `now`, and, when read off the wire, on its own site's topic.
    pub fn check(&self, on: Option<&TopicHash>, now: u64) -> Result<(), &'static str> {
        if crate::site::site_of(&self.site).as_deref() != Some(self.site.as_str()) {
            return Err("a notice is for a registrable site");
        }
        if on.is_some_and(|t| version_on(&self.site, t).is_none()) {
            return Err("a notice goes on its own site's topic");
        }
        let entry = |id: &str| id.strip_prefix("0x").is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()));
        if self.entries.is_empty() || self.entries.len() > MAX_CHANGED || !self.entries.iter().all(|e| entry(e)) {
            return Err("a notice names 1 to 32 entry ids");
        }
        if self.at.abs_diff(now) > CHANGE_SKEW {
            return Err("a notice from another time");
        }
        if !self.signed.is_empty() && (self.signed.len() != self.entries.len() || self.signed.iter().any(|w| w.is_empty() || w.len() > MAX_WITHDRAWAL_CHARS)) {
            return Err("a notice signs a withdrawal for each entry it names, or for none");
        }
        Ok(())
    }

    pub(crate) fn read(bytes: &[u8], on: &TopicHash, now: u64) -> Option<Change> {
        if bytes.len() > MAX_CHANGE_BYTES {
            return None;
        }
        let c: Change = serde_json::from_slice(bytes).ok()?;
        c.check(Some(on), now).ok().map(|_| c)
    }
}

/// Gossipsub as the network runs it.
pub(crate) fn config() -> Result<gossipsub::Config, String> {
    gossipsub::ConfigBuilder::default()
        .protocol_id(CHANGES_PROTOCOL, Version::V1_1)
        // Only notices signed by their source's key, with its peer ID and a sequence number, are read.
        .validation_mode(ValidationMode::Strict)
        // A notice is forwarded only once this node has judged it: its source counts, and it reads.
        .validate_messages()
        .max_transmit_size(MAX_CHANGE_BYTES)
        // A notice is rare and matters: its publisher sends it to every peer on the topic above the publish
        // threshold, not only its mesh, so the nodes that hear it first are all those connected.
        .flood_publish(true)
        // Peer exchange stays off (gossipsub's default): peers come from admission and the table, never from what
        // another peer suggests.
        .heartbeat_interval(Duration::from_secs(1))
        .build()
        .map_err(|e| e.to_string())
}

/// The peer score's parameters across topics, and its thresholds. With no per-topic parameters yet: each site's are
/// set as it is watched (`topic_score`).
pub(crate) fn score() -> (PeerScoreParams, PeerScoreThresholds) {
    let params = PeerScoreParams {
        // Positive topic score is capped well below the application score a refusal sets, so time in a mesh and
        // first deliveries never buy back a peer the registry refused.
        topic_score_cap: 50.0,
        // P5, the application score: 0 for a peer that counts or isn't judged yet, `REFUSED_SCORE` for one the
        // registry refused. Weighted 1, so a refusal puts the peer below the graylist at once.
        app_specific_weight: 1.0,
        // P6, IP colocation, is off. One identity may run up to 16 nodes, often on one machine; every devnet runs all
        // its nodes on one address; and admission already makes each node cost an identity's registration, which is
        // the Sybil bound colocation stands in for elsewhere.
        ip_colocation_factor_weight: 0.0,
        // P7, behaviour: a peer that grafts during its backoff or doesn't send what it offered. Six free a decay
        // period, then quadratic, decaying by about a half a minute.
        behaviour_penalty_weight: -10.0,
        behaviour_penalty_threshold: 6.0,
        behaviour_penalty_decay: 0.99,
        decay_interval: Duration::from_secs(1),
        decay_to_zero: 0.01,
        // A peer's score outlives its connection by an hour, so dropping and redialling doesn't shed a penalty.
        retain_score: Duration::from_secs(3600),
        topics: Default::default(),
        ..PeerScoreParams::default()
    };
    let thresholds = PeerScoreThresholds {
        // Gossip about notices is sent to and taken from peers above -10, notices published to those above -50, and
        // nothing at all is taken from those below -80: one invalid notice (P4, -100) or a refusal (P5) is below it.
        gossip_threshold: -10.0,
        publish_threshold: -50.0,
        graylist_threshold: -80.0,
        // Peer exchange is off, and no score is high enough to take one if a peer sends it.
        accept_px_threshold: 1000.0,
        opportunistic_graft_threshold: 5.0,
    };
    (params, thresholds)
}

/// One site's topic parameters. A site's topic carries a few notices a day, from one or a few contributors, so it is
/// scored for what a quiet topic can show: peers that forward invalid notices fall at once, peers that stay and deliver
/// first rise a little, and nobody is punished for the silence of a topic with nothing to say.
pub(crate) fn topic_score() -> TopicScoreParams {
    // Decays are per second (`decay_interval`): 0.5^(1/3600) halves a counter in an hour.
    let hourly = 0.5f64.powf(1.0 / 3600.0);
    TopicScoreParams {
        topic_weight: 1.0,
        // P1, time in the mesh: up to +10 after an hour, so a peer that has stayed is preferred when the mesh is
        // pruned, never enough to offset a penalty.
        time_in_mesh_weight: 10.0 / 3600.0,
        time_in_mesh_quantum: Duration::from_secs(1),
        time_in_mesh_cap: 3600.0,
        // P2, first deliveries: +1 a notice delivered first, up to +10, halving in an hour.
        first_message_deliveries_weight: 1.0,
        first_message_deliveries_decay: hourly,
        first_message_deliveries_cap: 10.0,
        // P3 and P3b, the mesh delivery rate, are off. They penalise a mesh peer that delivers fewer than a threshold
        // of messages in a window, which on a topic with no messages most hours penalises every honest peer and
        // empties the mesh. Ethereum turned them off on its quiet topics for the same reason.
        mesh_message_deliveries_weight: 0.0,
        mesh_message_deliveries_decay: 0.5,
        mesh_message_deliveries_cap: 1.0,
        mesh_message_deliveries_threshold: 0.0,
        mesh_message_deliveries_window: Duration::from_millis(10),
        mesh_message_deliveries_activation: Duration::from_secs(3600),
        mesh_failure_penalty_weight: 0.0,
        mesh_failure_penalty_decay: 0.5,
        // P4, invalid notices: -100 times the square of how many, halving in an hour. One is enough to graylist the
        // peer that forwarded it: an honest node forwards only notices it judged, so an invalid one is a forgery or a
        // node that doesn't check.
        invalid_message_deliveries_weight: -100.0,
        invalid_message_deliveries_decay: hourly,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: u8) -> String {
        format!("0x{:064x}", n)
    }

    /// A notice is read only when it is for a registrable site, on that site's topic, names well-formed entries
    /// within the bound, and is from about now.
    #[test]
    fn only_a_notice_that_reads_is_read() {
        let now = 1_000_000;
        let good = Change { site: "example.com".into(), kind: ChangeKind::Delisted, entries: vec![entry(1)], at: now, signed: vec![] };
        let on = topic("example.com").hash();
        let bytes = serde_json::to_vec(&good).unwrap();
        assert_eq!(Change::read(&bytes, &on, now), Some(good.clone()));
        let withdrawn = Change { signed: vec![format!("0x{}", "ab".repeat(65))], ..good.clone() };
        assert_eq!(Change::read(&serde_json::to_vec(&withdrawn).unwrap(), &on, now), Some(withdrawn), "with its withdrawal");
        assert!(Change::read(&bytes, &topic("other.example").hash(), now).is_none(), "on another site's topic");
        assert_eq!(Change::read(&bytes, &topic_of("example.com", 2).hash(), now), Some(good.clone()), "or another version's topic of its site");
        assert_eq!(version_on("example.com", &topic_of("example.com", 2).hash()), Some(2));
        assert_eq!(version_on("example.com", &IdentTopic::new("/unbrowse/site/example.com/changesx").hash()), None);
        assert!(Change::read(&bytes, &on, now + CHANGE_SKEW + 1).is_none(), "from another time");
        for bad in [
            Change { site: "www.example.com".into(), ..good.clone() },
            Change { entries: vec![], ..good.clone() },
            Change { entries: vec!["route-1".into()], ..good.clone() },
            Change { entries: (0..=MAX_CHANGED as u8).map(entry).collect(), ..good.clone() },
            Change { signed: vec!["0xab".into(), "0xcd".into()], ..good.clone() },
            Change { signed: vec!["0x".to_string() + &"a".repeat(MAX_WITHDRAWAL_CHARS)], ..good.clone() },
        ] {
            assert!(Change::read(&serde_json::to_vec(&bad).unwrap(), &topic(&bad.site).hash(), now).is_none(), "{bad:?}");
        }
        assert!(Change::read(b"{\"site\":1}", &on, now).is_none());
        assert!(Change::read(&vec![b' '; MAX_CHANGE_BYTES + 1], &on, now).is_none());
        assert_eq!(serde_json::to_value(ChangeKind::Repriced).unwrap(), "repriced");
    }

    /// The parameters are ones gossipsub takes, and one invalid notice, or a refusal, puts a peer below the graylist.
    #[test]
    fn one_invalid_notice_or_a_refusal_graylists_a_peer() {
        let (mut params, thresholds) = score();
        params.topics.insert(topic("example.com").hash(), topic_score());
        assert!(params.validate().is_ok() && thresholds.validate().is_ok());
        assert!(topic_score().validate().is_ok());
        let t = topic_score();
        assert!(t.invalid_message_deliveries_weight * t.topic_weight < thresholds.graylist_threshold);
        assert!(REFUSED_SCORE * params.app_specific_weight + params.topic_score_cap < thresholds.graylist_threshold);
        assert_eq!(t.mesh_message_deliveries_weight, 0.0, "a quiet topic penalises nobody for its silence");
        assert!(config().is_ok());
    }
}
