//! The running network: one libp2p swarm per node, and a handle the node talks to it through.
//!
//! The swarm speaks eight protocols on every connection: Kademlia under Unbrowse's own name, so it never joins the
//! public IPFS table; Identify, which swaps listen addresses and says whether a peer serves the table; `hello`, where
//! each side names the identity it runs under; `listings`, where a seeker asks a provider for a site's listings;
//! `body`, where a caller asks a provider for a route's body by content id, paying for it (see `body`); `tower`,
//! where a node hands a peer the lines it would have claimed, for the peer to claim if it doesn't (see `tower`);
//! `leaving`, where a node that stops says so, signed, to the peers that may hold its records; and ping, which tells a
//! peer that answers from one that has gone.
//! The routing table takes peers only by hand (`BucketInserts::Manual`) and provider records only through the node
//! (`StoreInserts::FilterBoth`), so both pass the admission check first.
//!
//! Every dial the node makes to meet a peer opens a port of its own (`allocate_new_port`), and so does every dial the
//! table and the request protocols make on their own (`dial::OwnPort`). libp2p otherwise dials from
//! the port the node listens on, and two nodes that dial each other at the same moment then open one TCP connection
//! from both ends at once, which both sides take as theirs to secure and neither can: the dials fail on both sides.
//! Nodes that boot together read the registry on the same schedule and dial each other at the same moment on every
//! retry, so they would never meet. With ports of their own, the two dials are two connections, and both succeed.
//! Identify still learns the address a peer sees the node at: it puts the listening port in place of the new one.
//!
//! A node that goes offline stops being found, the way BitTorrent's peers do (BEP 5): its provider records live an
//! hour and it announces them again every 20 minutes, so a node that crashed drops out within the hour; one that stops
//! cleanly withdraws at once (`Net::stop`); lookups try the providers connected now first and dial the rest together
//! with a short timeout (`counted`), so one that has gone costs a lookup that timeout, not a queue of them; and the
//! routing table pings a peer silent past `check_after` and drops it if it doesn't answer (`check_table`).
//!
//! What the node does for its peers is bounded per peer (`budget`, R7.18, R7.26): each peer has a token bucket per
//! protocol, for the listings and bodies it asks for and the Kademlia streams it opens, and a peer past it is refused at
//! once, never left to time out. Listings and bodies are answered in a few slots at a time; when they are all taken,
//! the next free one goes to the peers that pay this node for bodies, and one is kept for a newcomer, as BitTorrent
//! unchokes the peers that reciprocate and gives a stranger a turn.
//!
//! Change notices travel by gossipsub (`changes`): a node watches the sites whose routes it keeps or serves, meets the
//! nodes that provide each one so it is on the site's topic with them, and reads a notice only once its source counts.
//! A notice makes the node read the chain again; it changes nothing by itself.
//!
//! Three more find out whether others can reach the node and get it reached when they can't (R7.23): AutoNAT asks
//! connected peers to dial it back, circuit relay v2 lets a node behind a router be reached through a reachable peer,
//! and DCUtR turns a relayed connection into a direct one by punching through both routers at once. A node others
//! reach serves the table and relays for others; one they can't only asks, and holds a reservation on a relay.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use libp2p::identity::Keypair;
use libp2p::kad::store::RecordStore as _;
use libp2p::core::transport::ListenerId;
use libp2p::kad::{self, store::MemoryStore, BucketInserts, GetProvidersOk, Mode, ProviderRecord, QueryId, QueryResult, RecordKey, StoreInserts};
use libp2p::multiaddr::Protocol;
use libp2p::request_response::{self, OutboundRequestId, ResponseChannel};
use libp2p::swarm::dial_opts::{DialOpts, PeerCondition};
use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
use libp2p::identity::PublicKey;
use libp2p::gossipsub::{self, MessageAcceptance, MessageAuthenticity, MessageId};
use libp2p::{autonat, dcutr, identify, noise, ping, relay, tcp, yamux, Multiaddr, PeerId, StreamProtocol, Swarm};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::admission::{self, Claim, Identity, Refusal, Registry, Rules};
use crate::body::{self, BodyAnswer, BodyAsk, BodyCodec, Bodies, FetchError, NoBodies, BODY_TIMEOUT, MAX_BODY_PROVIDERS, SERVE_TIMEOUT};
use crate::dial::OwnPort;
use crate::budget::{self, Asked, Budget, Gated, KadGate, Payers, PerPeer, Slot, Slots, BODY_RATE, LISTINGS_RATE, SLOT_WAIT, STRANGERS_BODIES, STRANGERS_LISTINGS};
use crate::changes::{self, Change, Heard};
use crate::tower::{self, Desk, HandError, NoTowers, TowerAnswer, TowerCodec, Towers, TOWER_TIMEOUT};
use crate::wire::{self, Speaks};
use crate::{reach, site};

/// The table's protocol name. A private name keeps Unbrowse peers in their own table.
pub const KAD_PROTOCOL: &str = "/unbrowse/kad/1.0.0";
const IDENTIFY_PROTOCOL: &str = "/unbrowse/id/1.0.0";
/// What a leaving notice's signature covers starts with this, so no signature made for anything else reads as one.
const LEAVING_DOMAIN: &[u8] = b"unbrowse/leaving/1";
/// How far a leaving notice's time may be from the reader's clock. One older is a goodbye from another time.
const LEAVING_SKEW: u64 = 300;
/// Peers a stopping node tells it is leaving, at most.
const MAX_GOODBYES: usize = 64;
/// How long a lookup asks the table where a provider it has no address for is.
const LOCATE_WAIT: Duration = Duration::from_secs(5);
/// Providers whose listings one lookup fetches, at most.
const MAX_SOURCES: usize = 8;
/// Providers one lookup takes from the table and may try to meet, at most: the peers answering a lookup choose who
/// they name, so how much meeting a lookup does is set here, not by them.
const MAX_PROVIDERS: usize = 4 * MAX_SOURCES;
/// Providers met at once: enough that those not connected now are dialled together, so a provider that has gone costs
/// a lookup one connect timeout, not one each.
const ADMITTING: usize = 16;
/// Listings taken from one provider's answer, at most. Nothing here can check a listing's signature, so nothing here
/// bounds what one lookup takes across providers: the reader does that over the listings that check, so one provider's
/// junk never takes another's place (`interleaved`).
const MAX_LISTINGS_PER_SOURCE: usize = 32;
/// The most bytes a listings answer, and a listings or hello request, may hold.
const MAX_ANSWER_BYTES: u64 = 256 * 1024;
const MAX_ASK_BYTES: u64 = 4 * 1024;
/// Streams of one protocol one connection carries at once. Listings and bodies are answered in `Config::slots`, which
/// bound them across connections; this bounds the rest.
const MAX_ANSWERING: usize = 16;
/// Provider records held for a peer not yet judged, and peers held for, at most. Past either, a record is dropped:
/// the peer announces again once it counts.
const MAX_HELD_PER_PEER: usize = 64;
const MAX_HELD_PEERS: usize = 256;
/// Relays a node others can't reach holds reservations on at once.
const MAX_RELAYS: usize = 2;
/// How soon a node that knows nobody tries its saved peers and the registry's seeds again, at first and at most: a
/// node that booted with others, before any of them had said where it is, finds them once they have.
const JOIN_RETRY: Duration = Duration::from_secs(3);
const JOIN_RETRY_MAX: Duration = Duration::from_secs(120);
/// How often a node that has joined looks itself up again, once its early repeats are done (`join`).
const BOOTSTRAP_EVERY: Duration = Duration::from_secs(600);
/// How soon a peer whose identity couldn't be read is asked again, at first and at most.
const UNREAD_RETRY: Duration = Duration::from_secs(5);
const UNREAD_RETRY_MAX: Duration = Duration::from_secs(300);
/// How long a peer the registry doesn't list yet stays turned away, at first and at most, before it is asked again
/// while still connected. A node meets others before its metadata lands (its network starts first), so "not listed"
/// is often "not listed yet": it stands seconds, rising to minutes, never as long as a refusal the registry made.
const UNLISTED_RETRY: Duration = Duration::from_secs(3);
const UNLISTED_RETRY_MAX: Duration = Duration::from_secs(300);
/// How soon after a peer is first admitted the node announces again what it provides, so admissions that come
/// together are one announcement.
const REANNOUNCE_AFTER: Duration = Duration::from_secs(2);
/// How often a node whose table is small announces again what it provides. A young network's peers turn each other
/// away and drop each other's records while they join; the table's own refresh is a day away.
const REANNOUNCE_EVERY: Duration = Duration::from_secs(300);
/// How often a node looks again for the nodes on a watched site's topic, for each site it has none connected on, and
/// how many sites a look covers at most. A site's providers are found through the table and met; once connected,
/// gossipsub swaps what each watches.
const WATCH_EVERY: Duration = Duration::from_secs(15);
const MEET_SITES: usize = 8;
/// Providers of a watched site met, at most, to be on its topic with them.
const MEET_WATCHERS: usize = 4;
/// Sites watched at once, at most: each is a subscription every connected peer hears of.
const MAX_WATCHED: usize = 512;
/// Notices heard and not yet taken by the node, at most; past it one is dropped, and the node reads the chain on its
/// own schedule anyway.
const MAX_HEARD: usize = 256;

/// One route as the network carries it between nodes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Listing {
    pub entry_id: String,
    pub site: String,
    pub description: String,
    pub contributor: String,
    pub fee: f64,
    /// The contributor's signed listing with its proof of inclusion in a posted root, which the network carries as it
    /// is: the node that reads it checks it. Absent from a node that predates signed listings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed: Option<serde_json::Value>,
}

/// Where a node's own listings for a site come from when a seeker asks it, in the order the node would have a seeker
/// see them: an answer carries as many as fit its bounds, first first (`fit`).
pub trait Listings: Send + Sync + 'static {
    fn site(&self, site: &str) -> impl Future<Output = Vec<Listing>> + Send;
}

/// Whether the node serves the table for others or only asks it. A node in light mode, or one others can't dial,
/// asks only: it stores no records and answers no lookups.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Serve {
    Server,
    Client,
    /// Serves while others can reach it, asks only while they can't: reachable once AutoNAT has a peer dial it back,
    /// or when its addresses are taken as reachable (`announce_listen`, `announce`).
    Auto,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: Vec<Multiaddr>,
    /// Treat every address the node listens on as reachable (a devnet or a test on one machine). Such a node also
    /// takes a peer's loopback addresses, since its peers share its machine.
    pub announce_listen: bool,
    /// Addresses the owner says the node is reached at (a forwarded port, a public address the node can't see from
    /// inside). They are taken as reachable and published first.
    pub announce: Vec<Multiaddr>,
    /// How soon after starting, and how often until a peer has answered, the node asks a peer to dial it back.
    pub probe: Duration,
    pub claim: Claim,
    pub serve: Serve,
    pub rules: Rules,
    /// Peers per bucket and copies of each record.
    pub k: usize,
    /// Lookups in flight at once.
    pub alpha: usize,
    /// Distinct identities a site's listings must come from before a lookup counts as checked.
    pub listing_sources: usize,
    /// How long a provider record lasts, on the peers that hold it, from when it was announced last (R7.18): a node
    /// that went offline without a word drops out of every lookup within this long.
    pub provider_ttl: Duration,
    /// How often the node announces again every record it provides. Well inside `provider_ttl`, so a record lapses
    /// only when its provider has stopped announcing it.
    pub provider_refresh: Duration,
    /// How long a lookup waits to reach a provider it isn't connected to before it counts it gone.
    pub connect_timeout: Duration,
    /// How long a peer in the routing table may be silent before it is pinged; one that doesn't answer within
    /// `ping_timeout` is dropped from the table and its admission.
    pub check_after: Duration,
    pub ping_timeout: Duration,
    /// How long a stopping node spends telling its peers it is leaving (`Net::stop`), at most.
    pub goodbye_within: Duration,
    /// How long an admission stands before the registry is read again.
    pub admission_ttl: Duration,
    /// How long a refusal the registry made stands (a peer placed where its identity's node can't sit, an index past
    /// the identity's nodes, a release too old). A peer the registry doesn't list under its identity is refused only
    /// seconds to minutes (`UNLISTED_RETRY`): its metadata may not have landed yet.
    pub refusal_ttl: Duration,
    /// How long reading a peer's identity from the registry may take. Past it the peer isn't judged, and is asked
    /// again soon: a read that hangs never keeps a peer out for good.
    pub registry_timeout: Duration,
    /// Where the routing table is saved, so a restart starts from it.
    pub saved: Option<PathBuf>,
    /// This node's release, which Identify tells peers (`unbrowse/<version>`).
    pub version: String,
    /// The oldest release the network takes: an older peer, or one that doesn't say, is refused.
    pub min_peer_version: Option<String>,
    /// Listings answers, and body answers, made at once, one of each kept for a newcomer; and how many of those one
    /// peer may hold or wait for (`budget::Slots`).
    pub slots: usize,
    pub slots_per_peer: usize,
    /// The versions of each wire protocol the node speaks, newest first (`wire.rs`): this release's, unless a test
    /// stands up a node of another.
    pub speaks: Speaks,
}

impl Config {
    /// The protocol's values (spec §53, R7.18): k = 20, α = 3, two sources, records valid an hour and refreshed every
    /// 20 minutes.
    pub fn new(claim: Claim) -> Config {
        let day = Duration::from_secs(24 * 3600);
        let minute = Duration::from_secs(60);
        Config {
            listen: vec!["/ip4/0.0.0.0/udp/0/quic-v1".parse().expect("static"), "/ip4/0.0.0.0/tcp/0".parse().expect("static")],
            announce_listen: false,
            announce: vec![],
            probe: Duration::from_secs(15),
            claim,
            serve: Serve::Auto,
            rules: Rules { position_bits: 16, nodes_per_identity: 16 },
            k: 20,
            alpha: 3,
            listing_sources: 2,
            provider_ttl: 60 * minute,
            provider_refresh: 20 * minute,
            connect_timeout: Duration::from_secs(3),
            check_after: 5 * minute,
            ping_timeout: Duration::from_secs(10),
            goodbye_within: Duration::from_secs(2),
            admission_ttl: day,
            refusal_ttl: Duration::from_secs(600),
            registry_timeout: Duration::from_secs(30),
            saved: None,
            version: env!("CARGO_PKG_VERSION").into(),
            min_peer_version: None,
            slots: budget::SLOTS,
            slots_per_peer: budget::SLOTS_PER_PEER,
            speaks: Speaks::default(),
        }
    }
}

/// What a site lookup found.
#[derive(Clone, Debug, Default)]
pub struct Found {
    /// The site's listings, only for the site asked about, unchecked: each provider's answer at most
    /// `MAX_LISTINGS_PER_SOURCE`, each listing once within it, the providers' answers taken in turn (first of each,
    /// then second of each, ...). Two providers may carry the same listing, and either copy may be forged: only the
    /// reader, checking signatures, can say which to keep, and bounds what it keeps by what checks.
    pub listings: Vec<Listing>,
    /// The identities that answered. Several nodes of one identity are one source.
    pub sources: Vec<String>,
    /// Whether enough distinct identities answered to catch one of them leaving listings out.
    pub checked: bool,
}

/// Where a peer stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Standing {
    Counts(String),
    Refused,
    Unreachable,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Hello {}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ListingsAsk {
    site: String,
}

/// A provider's answer: its listings, or why it won't answer now. A refusal carries no `listings`, so a release that
/// predates refusals reads it as no answer at all, never as a source with nothing.
#[derive(Clone, Debug, Default, Deserialize)]
struct ListingsAnswer {
    #[serde(default)]
    listings: Vec<Listing>,
    #[serde(default)]
    refused: Option<String>,
}

/// An answer on the wire is one or the other: `{"listings": [...]}`, or `{"refused": "..."}`.
impl Serialize for ListingsAnswer {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(untagged)]
        enum Wire<'a> {
            Listings { listings: &'a [Listing] },
            Refused { refused: &'a str },
        }
        match &self.refused {
            Some(refused) => Wire::Refused { refused }.serialize(s),
            None => Wire::Listings { listings: &self.listings }.serialize(s),
        }
    }
}

/// A node saying it is leaving the network, to one peer: its public key, the peer it tells, when, and its signature
/// over the three (`leaving_bytes`). A peer takes it only from the node it names, addressed to itself, and lately, so
/// nobody can say another node's goodbye, nor pass on one a node said to someone else.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Leaving {
    key: Vec<u8>,
    to: String,
    at: u64,
    sig: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Left {}

/// How much of the table's work a node has done since it started: what it announced, and what peers asked of it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Load {
    /// Announcements of a record it provides that went out, its own and the table's periodic ones.
    pub announced: u64,
    /// Requests peers made of it: where the closest peers to a key are, who provides a key, and records to hold.
    pub find_node: u64,
    pub get_providers: u64,
    pub add_provider: u64,
    /// Asks refused for a peer's budget or the slots being full: listings, bodies, and Kademlia streams closed unread.
    pub refused_listings: u64,
    pub refused_bodies: u64,
    pub refused_kad: u64,
}

// `NetworkBehaviour` generates the code that Rust 1.100 reports as an `unreachable call` (rust-lang/rust, lint
// `unreachable_code`): a sub-behaviour whose handler event is uninhabited (`Infallible`) is handed that event, and the
// call can never run. The code is the macro's, not ours, so the allow covers this module and the struct alone.
mod derived {
    #![allow(unreachable_code)]
    use super::*;

    #[derive(NetworkBehaviour)]
    pub(super) struct Behaviour {
        pub(super) kad: Gated<OwnPort<kad::Behaviour<MemoryStore>>>,
        pub(super) identify: identify::Behaviour,
        pub(super) hello: OwnPort<request_response::json::Behaviour<Hello, Claim>>,
        pub(super) listings: OwnPort<request_response::json::Behaviour<ListingsAsk, ListingsAnswer>>,
        pub(super) body: OwnPort<request_response::Behaviour<BodyCodec>>,
        pub(super) tower: OwnPort<request_response::Behaviour<TowerCodec>>,
        pub(super) leaving: OwnPort<request_response::json::Behaviour<Leaving, Left>>,
        pub(super) gossip: gossipsub::Behaviour,
        pub(super) ping: ping::Behaviour,
        pub(super) autonat: autonat::Behaviour,
        pub(super) relay: relay::Behaviour,
        pub(super) relay_client: relay::client::Behaviour,
        pub(super) dcutr: dcutr::Behaviour,
    }
}
use derived::{Behaviour, BehaviourEvent};

/// AutoNAT as the network runs it. A peer may confirm a private address: on a LAN or a tailnet the nodes that dial
/// this one are on that network too. Dial-backs it does for others are few, each to the address the asker is seen at.
fn autonat_config(probe: Duration) -> autonat::Config {
    autonat::Config {
        boot_delay: probe,
        retry_interval: probe,
        // A peer asked once isn't asked again for six probes' time, so a node with few peers waits that long after a
        // dial-back that failed by chance.
        throttle_server_period: 6 * probe,
        only_global_ips: false,
        throttle_clients_global_max: 30,
        throttle_clients_peer_max: 3,
        throttle_clients_period: Duration::from_secs(60),
        ..Default::default()
    }
}

/// The relay a reachable node runs for others: a few reservations and short, small circuits, enough to set up a hole
/// punch or carry one listings answer, not to carry traffic.
fn relay_config() -> relay::Config {
    relay::Config {
        max_reservations: 32,
        max_reservations_per_peer: 2,
        max_circuits: 16,
        max_circuits_per_peer: 2,
        max_circuit_duration: Duration::from_secs(120),
        max_circuit_bytes: 2 * MAX_ANSWER_BYTES,
        ..Default::default()
    }
}

/// What AutoNAT last said about whether others reach the node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Nat {
    Unknown,
    Public,
    Private,
}

enum Cmd {
    Provide(RecordKey, oneshot::Sender<Result<(), String>>),
    StopProviding(RecordKey),
    Providers(RecordKey, oneshot::Sender<HashSet<PeerId>>),
    Locate(PeerId, oneshot::Sender<Vec<Multiaddr>>),
    Admit(PeerId, Vec<Multiaddr>, oneshot::Sender<Standing>),
    Fetch(PeerId, String, oneshot::Sender<Result<Vec<Listing>, String>>),
    FetchBody(PeerId, Vec<Multiaddr>, BodyAsk, oneshot::Sender<Result<BodyAnswer, request_response::OutboundFailure>>),
    HandOver(PeerId, Vec<Multiaddr>, Vec<u8>, tower::Handing),
    Dial(Option<PeerId>, Vec<Multiaddr>),
    Table(oneshot::Sender<Vec<(PeerId, Vec<Multiaddr>)>>),
    Listening(oneshot::Sender<Vec<Multiaddr>>),
    Published(oneshot::Sender<Vec<Multiaddr>>),
    Bootstrap,
    Save,
    /// How live each peer is: connected now, seen within a record's life, or neither.
    Live(Vec<PeerId>, oneshot::Sender<Vec<(PeerId, Live)>>),
    /// Reach a peer, at the addresses given and any the table knows.
    Connect(PeerId, Vec<Multiaddr>, oneshot::Sender<Reached>),
    /// The providers the table records for a key, as it answers, none met or judged.
    Recorded(RecordKey, oneshot::Sender<HashSet<PeerId>>),
    /// Stop providing everything and tell the peers that may hold the records; answered with how many heard.
    Leave(oneshot::Sender<usize>),
    /// End the swarm, saving the routing table first or not.
    Halt(bool, oneshot::Sender<()>),
    Load(oneshot::Sender<Load>),
    /// Watch exactly these sites' topics; answered with the sites newly watched.
    Watch(Vec<String>, oneshot::Sender<Vec<String>>),
    Publish(Change, oneshot::Sender<Result<(), String>>),
    /// The watched sites with no peer on their topic connected.
    Lonely(oneshot::Sender<Vec<String>>),
    /// The connected peers on a site's topic.
    Watchers(String, oneshot::Sender<Vec<PeerId>>),
}

/// How live a peer is, best first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Live {
    Now,
    Lately,
    Unknown,
}

/// What came of reaching a peer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reached {
    Yes,
    /// Nothing is known of where it is.
    NoAddress,
    No,
}

enum Inner {
    Judged(PeerId, Claim, Result<(), Refusal>),
    /// Time to announce again everything the node provides.
    Reannounce,
    /// A providers lookup that has found some has waited long enough for the rest.
    Enough(QueryId),
    /// The registry couldn't be read for this peer's identity, in time or at all.
    Unread(PeerId),
    /// The registry read for this peer's hello has ended, however it ended: its place goes to the next peer waiting.
    LookupDone(PeerId),
    /// Time to ask a peer whose identity couldn't be read again.
    AskAgain(PeerId),
    /// Time to look at the hellos waiting for a registry read again.
    ReadsFree,
    /// A listings answer, or none when it couldn't be made in time: the asker then hears nothing.
    Answer(ResponseChannel<ListingsAnswer>, Slot, Option<Vec<Listing>>),
    Body(ResponseChannel<BodyAnswer>, Slot, BodyAnswer),
    /// An ask that waited for a slot under this ticket has waited `SLOT_WAIT`: listings (true) or bodies.
    Waited(bool, u64),
    Tower(ResponseChannel<TowerAnswer>, TowerAnswer),
    /// A notice whose source wasn't judged when it came, and the verdict since: its id, who forwarded it, its source.
    Vouched(MessageId, PeerId, PeerId, Change, Standing),
}

/// A listings answer being made. However making it ends (an answer, the timeout, a panic), the slot it holds is given
/// back.
struct Answering {
    itx: mpsc::UnboundedSender<Inner>,
    channel: Option<ResponseChannel<ListingsAnswer>>,
    slot: Slot,
}

impl Answering {
    fn answer(mut self, listings: Option<Vec<Listing>>) {
        if let Some(c) = self.channel.take() {
            let _ = self.itx.send(Inner::Answer(c, self.slot, listings));
        }
    }
}

impl Drop for Answering {
    fn drop(&mut self) {
        if let Some(c) = self.channel.take() {
            let _ = self.itx.send(Inner::Answer(c, self.slot, None));
        }
    }
}

/// A body answer being made, on the same terms as [`Answering`]: however it ends, the slot is given back and the asker
/// is told. A `Bodies` that panics would otherwise take a slot with it, and a few of them leave none.
struct ServingBody {
    itx: mpsc::UnboundedSender<Inner>,
    channel: Option<ResponseChannel<BodyAnswer>>,
    slot: Slot,
}

impl ServingBody {
    fn answer(mut self, answer: BodyAnswer) {
        if let Some(c) = self.channel.take() {
            let _ = self.itx.send(Inner::Body(c, self.slot, answer));
        }
    }
}

impl Drop for ServingBody {
    fn drop(&mut self) {
        if let Some(c) = self.channel.take() {
            let _ = self.itx.send(Inner::Body(c, self.slot, BodyAnswer::of(Err("the node failed making this answer".into()))));
        }
    }
}

/// The node's handle on its network.
#[derive(Clone)]
pub struct Net {
    tx: mpsc::Sender<Cmd>,
    heard: Arc<std::sync::Mutex<Option<mpsc::Receiver<Heard>>>>,
    peer_id: PeerId,
    sources: usize,
    connect_timeout: Duration,
    goodbye_within: Duration,
}

impl Net {
    /// Starts the network under `key`, which must sit where `cfg.claim` says (see `position::grind`). It serves no
    /// bodies: every ask for one is refused.
    pub async fn start<R: Registry, L: Listings>(key: Keypair, cfg: Config, registry: Arc<R>, listings: Arc<L>) -> Result<Net, String> {
        Net::start_with_bodies(key, cfg, registry, listings, Arc::new(NoBodies)).await
    }

    /// Starts the network as `start` does, answering asks for bodies from `bodies`. It watches for no one: every
    /// hand-over of lines is refused.
    pub async fn start_with_bodies<R: Registry, L: Listings, B: Bodies>(
        key: Keypair,
        cfg: Config,
        registry: Arc<R>,
        listings: Arc<L>,
        bodies: Arc<B>,
    ) -> Result<Net, String> {
        Net::start_with(key, cfg, registry, listings, bodies, Arc::new(NoTowers)).await
    }

    /// Starts the network as `start_with_bodies` does, keeping the lines peers hand it in `towers`.
    pub async fn start_with<R: Registry, L: Listings, B: Bodies, T: Towers>(
        key: Keypair,
        cfg: Config,
        registry: Arc<R>,
        listings: Arc<L>,
        bodies: Arc<B>,
        towers: Arc<T>,
    ) -> Result<Net, String> {
        let peer_id = key.public().to_peer_id();
        cfg.speaks.check()?;
        let speaks = cfg.speaks.clone();
        let kad_proto = StreamProtocol::new(KAD_PROTOCOL);
        let mut kcfg = kad::Config::new(kad_proto.clone());
        kcfg.set_replication_factor(NonZeroUsize::new(cfg.k).ok_or("k must be positive")?)
            .set_parallelism(NonZeroUsize::new(cfg.alpha).ok_or("alpha must be positive")?)
            .disjoint_query_paths(true)
            .set_kbucket_inserts(BucketInserts::Manual)
            .set_record_filtering(StoreInserts::FilterBoth)
            .set_provider_record_ttl(Some(cfg.provider_ttl))
            .set_provider_publication_interval(Some(cfg.provider_refresh));
        // The node's own records never lapse on it: the table announces them again every `provider_refresh`, and each
        // peer that takes one holds it `provider_ttl` from then (`kad::Behaviour::provider_received`).
        let signer = key.clone();
        let agent = format!("unbrowse/{}", cfg.version);
        let mut gossip = gossipsub::Behaviour::new(MessageAuthenticity::Signed(key.clone()), changes::config()?)?;
        let (params, thresholds) = changes::score();
        gossip.with_peer_score(params, thresholds)?;
        let gate = KadGate::new();
        let kad_gate = gate.clone();
        let builder = libp2p::SwarmBuilder::with_existing_identity(key)
            .with_tokio()
            .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
            .map_err(|e| e.to_string())?
            .with_quic()
            .with_relay_client(noise::Config::new, yamux::Config::default)
            .map_err(|e| e.to_string())?;
        // The closure returns a `Behaviour`, not a `Result`, so `with_behaviour` cannot fail (its error type is
        // `Infallible`): Rust 1.100 reports a `map_err` on it as an unreachable call, so the pattern takes the `Ok` alone.
        let Ok(builder) = builder.with_behaviour(|k, relay_client| Behaviour {
                kad: Gated::new(OwnPort::new(kad::Behaviour::with_config(peer_id, MemoryStore::new(peer_id), kcfg)), kad_gate),
                identify: identify::Behaviour::new(identify::Config::new(IDENTIFY_PROTOCOL.into(), k.public()).with_agent_version(agent.clone())),
                hello: OwnPort::new(request_response::json::Behaviour::with_codec(
                    request_response::json::codec::Codec::default().set_request_size_maximum(MAX_ASK_BYTES).set_response_size_maximum(MAX_ASK_BYTES),
                    speaks.protocols(wire::HELLO),
                    request_response::Config::default(),
                )),
                listings: OwnPort::new(request_response::json::Behaviour::with_codec(
                    request_response::json::codec::Codec::default().set_request_size_maximum(MAX_ASK_BYTES).set_response_size_maximum(MAX_ANSWER_BYTES),
                    speaks.protocols(wire::LISTINGS),
                    request_response::Config::default().with_max_concurrent_streams(MAX_ANSWERING),
                )),
                body: OwnPort::new(request_response::Behaviour::with_codec(
                    BodyCodec,
                    speaks.protocols(wire::BODY),
                    request_response::Config::default().with_request_timeout(BODY_TIMEOUT).with_max_concurrent_streams(MAX_ANSWERING),
                )),
                tower: OwnPort::new(request_response::Behaviour::with_codec(
                    TowerCodec,
                    speaks.protocols(wire::TOWER),
                    request_response::Config::default().with_request_timeout(TOWER_TIMEOUT).with_max_concurrent_streams(MAX_ANSWERING),
                )),
                leaving: OwnPort::new(request_response::json::Behaviour::with_codec(
                    request_response::json::codec::Codec::default().set_request_size_maximum(MAX_ASK_BYTES).set_response_size_maximum(MAX_ASK_BYTES),
                    speaks.protocols(wire::LEAVING),
                    request_response::Config::default().with_request_timeout(cfg.goodbye_within).with_max_concurrent_streams(MAX_ANSWERING),
                )),
                gossip,
                // Every connection is pinged as it opens and every `check_after` while it stays open: an answer is
                // the peer seen, and none is the peer gone. Ping holds no connection open on its own.
                ping: ping::Behaviour::new(ping::Config::new().with_interval(cfg.check_after).with_timeout(cfg.ping_timeout)),
                autonat: autonat::Behaviour::new(peer_id, autonat_config(cfg.probe)),
                relay: relay::Behaviour::new(peer_id, relay_config()),
                relay_client,
                dcutr: dcutr::Behaviour::new(peer_id),
        });
        let mut swarm = builder.with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(120))).build();
        // A machine without IPv6, say, can't listen on every address asked for; the node needs one.
        let mut failed = Vec::new();
        for a in &cfg.listen {
            if let Err(e) = swarm.listen_on(a.clone()) {
                failed.push(format!("{a}: {e}"));
            }
        }
        if !cfg.listen.is_empty() && failed.len() == cfg.listen.len() {
            return Err(format!("the node can't listen on any address: {}", failed.join("; ")));
        }
        for a in &cfg.announce {
            swarm.add_external_address(a.clone());
        }

        let (tx, rx) = mpsc::channel(256);
        let (itx, irx) = mpsc::unbounded_channel();
        let (heard_tx, heard_rx) = mpsc::channel(MAX_HEARD);
        let state = State::new(&cfg, kad_proto, signer, gate, heard_tx);
        serve_as(&mut swarm, &state);
        tokio::spawn(run(swarm, state, registry.clone(), listings, bodies, towers, rx, itx, irx));
        let net = Net { tx, heard: Arc::new(std::sync::Mutex::new(Some(heard_rx))), peer_id, sources: cfg.listing_sources, connect_timeout: cfg.connect_timeout, goodbye_within: cfg.goodbye_within };
        tokio::spawn(join(net.clone(), registry, cfg.saved.clone()));
        tokio::spawn(watching(net.clone()));
        Ok(net)
    }

    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    async fn ask<T>(&self, cmd: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T, String> {
        let (reply, answer) = oneshot::channel();
        self.tx.send(cmd(reply)).await.map_err(|_| "the network has stopped".to_string())?;
        answer.await.map_err(|_| "the network has stopped".to_string())
    }

    /// Announces this node as a provider of a site's listings. Refreshed by the table until the node stops.
    pub async fn provide(&self, site: &str) -> Result<(), String> {
        self.ask(|r| Cmd::Provide(site::site_key(site), r)).await?
    }

    /// Finds a site's listings: its providers from the table, kept only if they count, at most one per identity,
    /// each asked for the site's listings.
    pub async fn find(&self, site: &str) -> Result<Found, String> {
        let providers = self.ask(|r| Cmd::Providers(site::site_key(site), r)).await?;
        let mut by_identity: Vec<(String, PeerId)> = Vec::new();
        for (id, p) in self.counted(providers, MAX_SOURCES).await {
            if !by_identity.iter().any(|(i, _)| *i == id) {
                by_identity.push((id, p));
            }
        }
        let fetched = futures::future::join_all(by_identity.into_iter().take(MAX_SOURCES).map(|(id, p)| async move { (id, self.fetch(p, site).await) })).await;
        let mut found = Found::default();
        let mut answers = Vec::new();
        for (id, answer) in fetched {
            let Ok(listings) = answer else { continue };
            found.sources.push(id);
            answers.push(kept(listings, site));
        }
        found.listings = interleaved(answers);
        found.checked = found.sources.len() >= self.sources;
        Ok(found)
    }

    /// The providers from a lookup that count, with the identity each runs under, live first: those connected now,
    /// then those seen within a record's life, then the rest (`Live`). Those not connected must be reached within
    /// `connect_timeout` to count, and are dialled together, so a provider that has gone costs the lookup that long
    /// once, however many have gone; an admission made while it was up never stands in for reaching it now. No more
    /// are met once `identities` distinct identities count. This node is never one of them.
    async fn counted(&self, providers: HashSet<PeerId>, identities: usize) -> Vec<(String, PeerId)> {
        let providers: Vec<PeerId> = providers.into_iter().filter(|p| *p != self.peer_id).take(MAX_PROVIDERS).collect();
        let mut by_life = self.ask(|r| Cmd::Live(providers, r)).await.unwrap_or_default();
        by_life.sort_by_key(|(_, live)| *live);
        let mut standings = futures::stream::iter(by_life).map(|(p, live)| async move { (p, live, self.meet(p, live).await) }).buffer_unordered(ADMITTING);
        let mut counted = Vec::new();
        let mut distinct = HashSet::new();
        while let Some((p, live, s)) = standings.next().await {
            if let Standing::Counts(id) = s {
                distinct.insert(id.clone());
                counted.push((live, id, p));
            }
            if distinct.len() >= identities {
                break;
            }
        }
        counted.sort_by_key(|(live, _, _)| *live);
        counted.into_iter().map(|(_, id, p)| (id, p)).collect()
    }

    /// Where a provider stands, reaching it first unless it is connected now.
    async fn meet(&self, peer: PeerId, live: Live) -> Standing {
        if live != Live::Now && !self.reach(peer).await {
            return Standing::Unreachable;
        }
        self.admit(peer).await
    }

    /// Whether `peer` can be reached now: dialled at the addresses known for it within `connect_timeout`, or, with
    /// none known, at those the table finds for it.
    async fn reach(&self, peer: PeerId) -> bool {
        let connect = |addrs: Vec<Multiaddr>| tokio::time::timeout(self.connect_timeout, self.ask(move |r| Cmd::Connect(peer, addrs, r)));
        match connect(vec![]).await {
            Ok(Ok(Reached::Yes)) => return true,
            Ok(Ok(Reached::NoAddress)) => {}
            _ => return false,
        }
        let addrs = tokio::time::timeout(LOCATE_WAIT, self.ask(|r| Cmd::Locate(peer, r))).await.ok().and_then(Result::ok).unwrap_or_default();
        !addrs.is_empty() && matches!(connect(addrs).await, Ok(Ok(Reached::Yes)))
    }

    /// The providers the table records for a site, as its peers answer, none met or judged: what a lookup starts from.
    /// A provider that went offline without a word stays here until its records lapse.
    pub async fn recorded_site_providers(&self, site: &str) -> HashSet<PeerId> {
        self.ask(|r| Cmd::Recorded(site::site_key(site), r)).await.unwrap_or_default()
    }

    /// The same, for a body's providers.
    pub async fn recorded_body_providers(&self, content_id: &str) -> HashSet<PeerId> {
        self.ask(|r| Cmd::Recorded(body::body_key(content_id), r)).await.unwrap_or_default()
    }

    /// Leaves the network cleanly, within `goodbye_within` and a moment: stops providing every record, tells every
    /// admitted peer it was connected to within a record's life that it is leaving (signed, so the peer drops its
    /// records and stops counting it at once), saves the routing table and ends the swarm. Every handle on it then
    /// hears the network has stopped. A node that crashes says nothing; its records lapse within `provider_ttl`.
    pub async fn stop(&self) {
        let _ = tokio::time::timeout(self.goodbye_within, self.ask(Cmd::Leave)).await;
        self.halt(true).await;
    }

    /// Ends the swarm at once, telling nobody and saving nothing, as a crash or a pulled cable does: what the others
    /// then see is what they see of a node that went offline without a word.
    pub async fn vanish(&self) {
        self.halt(false).await;
    }

    /// Asks the swarm to end and returns once it has: the loop answers the ask before it lets go of its end of the
    /// channel, so the answer alone doesn't mean `stopped` is true yet.
    async fn halt(&self, save: bool) {
        let ended = async {
            let _ = self.ask(|r| Cmd::Halt(save, r)).await;
            self.tx.closed().await;
        };
        let _ = tokio::time::timeout(Duration::from_secs(2), ended).await;
    }

    /// The table's work this node has done since it started.
    pub async fn load(&self) -> Load {
        self.ask(Cmd::Load).await.unwrap_or_default()
    }

    /// Whether the swarm has ended.
    pub fn stopped(&self) -> bool {
        self.tx.is_closed()
    }

    /// Announces this node as a provider of the body named `content_id` (R7.18). The record is refreshed every
    /// `provider_refresh` and lasts `provider_ttl` (20 minutes and an hour, by default) until `stop_providing_body`. Whether
    /// the node may seed at all (it paid for the body, it isn't in light mode) is the node's to decide, not the table's.
    pub async fn provide_body(&self, content_id: &str) -> Result<(), String> {
        self.ask(|r| Cmd::Provide(body::body_key(content_id), r)).await?
    }

    /// Stops announcing this node as a provider of a body. Records already on other peers lapse within `provider_ttl`.
    pub async fn stop_providing_body(&self, content_id: &str) -> Result<(), String> {
        self.tx.send(Cmd::StopProviding(body::body_key(content_id))).await.map_err(|_| "the network has stopped".to_string())
    }

    /// Finds the providers of the body named `content_id`: those that count, at most `MAX_BODY_PROVIDERS`. Each
    /// identity's first node comes before any identity's second, so one identity running many nodes can't fill the
    /// list; its other nodes follow, as fallbacks for the same copy. This node is never in it.
    pub async fn find_body_providers(&self, content_id: &str) -> Result<Vec<PeerId>, String> {
        let providers = self.ask(|r| Cmd::Providers(body::body_key(content_id), r)).await?;
        let mut seen = HashSet::new();
        let (mut first, mut more) = (Vec::new(), Vec::new());
        for (id, p) in self.counted(providers, MAX_BODY_PROVIDERS).await {
            if seen.insert(id) {
                first.push(p);
            } else {
                more.push(p);
            }
        }
        first.extend(more);
        first.truncate(MAX_BODY_PROVIDERS);
        Ok(first)
    }

    /// Asks `peer` for the body named `content_id`, paying with `payment`, which the provider's node judges. The body
    /// comes back unchecked: the caller checks it against the content id in the signed listing before using or paying
    /// for it (R7.19).
    pub async fn fetch_body(&self, peer: PeerId, content_id: &str, payment: &[u8]) -> Result<Vec<u8>, FetchError> {
        let ask = BodyAsk { content_id: content_id.to_string(), payment: payment.to_vec() };
        ask.check().map_err(FetchError::Invalid)?;
        if peer == self.peer_id {
            return Err(FetchError::Invalid("a node doesn't fetch from itself".into()));
        }
        let mut answer = self.ask_body(peer, vec![], ask.clone()).await;
        // Not connected and no address for it: ask the table where it is, then try once more.
        if matches!(answer, Err(request_response::OutboundFailure::DialFailure)) {
            let addrs = self.ask(|r| Cmd::Locate(peer, r)).await.unwrap_or_default();
            if !addrs.is_empty() {
                answer = self.ask_body(peer, addrs, ask).await;
            }
        }
        match answer {
            Ok(BodyAnswer::Ok { body }) => Ok(body),
            Ok(BodyAnswer::Refused { reason }) => Err(FetchError::Refused(reason)),
            Err(request_response::OutboundFailure::Io(e)) if body::is_oversized(&e) => Err(FetchError::TooLarge),
            Err(e) => Err(FetchError::Unanswered(e.to_string())),
        }
    }

    async fn ask_body(&self, peer: PeerId, addrs: Vec<Multiaddr>, ask: BodyAsk) -> Result<BodyAnswer, request_response::OutboundFailure> {
        // The protocol times the ask out itself; this only covers a network that has stopped answering its handle.
        match tokio::time::timeout(BODY_TIMEOUT + Duration::from_secs(5), self.ask(|r| Cmd::FetchBody(peer, addrs, ask, r))).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(request_response::OutboundFailure::ConnectionClosed),
            Err(_) => Err(request_response::OutboundFailure::Timeout),
        }
    }

    /// Hands `peer` the bytes of the lines this node would have claimed, for it to claim them if this node doesn't
    /// (see `tower`). The peer's node checks and keeps them; what it says back is its answer.
    pub async fn hand_over(&self, peer: PeerId, handed: Vec<u8>) -> Result<(), HandError> {
        if handed.len() > tower::MAX_HANDED_BYTES {
            return Err(HandError::TooLarge);
        }
        if peer == self.peer_id {
            return Err(HandError::Refused("a node doesn't hand lines to itself".into()));
        }
        let ask = |addrs: Vec<Multiaddr>, handed: Vec<u8>| async move {
            match tokio::time::timeout(TOWER_TIMEOUT + Duration::from_secs(5), self.ask(|r| Cmd::HandOver(peer, addrs, handed, r))).await {
                Ok(Ok(answer)) => answer,
                Ok(Err(_)) => Err(request_response::OutboundFailure::ConnectionClosed),
                Err(_) => Err(request_response::OutboundFailure::Timeout),
            }
        };
        let mut answer = ask(vec![], handed.clone()).await;
        // Not connected and no address for it: ask the table where it is, then try once more.
        if matches!(answer, Err(request_response::OutboundFailure::DialFailure)) {
            let addrs = self.ask(|r| Cmd::Locate(peer, r)).await.unwrap_or_default();
            if !addrs.is_empty() {
                answer = ask(addrs, handed).await;
            }
        }
        tower::heard(answer)
    }

    /// Where a peer stands, meeting it first if need be.
    pub async fn admit(&self, peer: PeerId) -> Standing {
        let wait = Duration::from_secs(10);
        let first = tokio::time::timeout(wait, self.ask(|r| Cmd::Admit(peer, vec![], r))).await;
        match first {
            Ok(Ok(Standing::Unreachable)) | Err(_) => {}
            Ok(Ok(s)) => return s,
            Ok(Err(_)) => return Standing::Unreachable,
        }
        // No address for it yet: ask the table where it is, then try once more.
        let addrs = self.ask(|r| Cmd::Locate(peer, r)).await.unwrap_or_default();
        if addrs.is_empty() {
            return Standing::Unreachable;
        }
        match tokio::time::timeout(wait, self.ask(|r| Cmd::Admit(peer, addrs, r))).await {
            Ok(Ok(s)) => s,
            _ => Standing::Unreachable,
        }
    }

    /// Asks one provider for a site's listings, as a lookup does each provider it found. They come back unchecked.
    pub async fn listings_from(&self, peer: PeerId, site: &str) -> Result<Vec<Listing>, String> {
        self.fetch(peer, site).await
    }

    async fn fetch(&self, peer: PeerId, site: &str) -> Result<Vec<Listing>, String> {
        let site = site.to_string();
        tokio::time::timeout(Duration::from_secs(15), self.ask(|r| Cmd::Fetch(peer, site, r)))
            .await
            .map_err(|_| "the provider didn't answer".to_string())??
    }

    pub async fn dial(&self, addr: Multiaddr) -> Result<(), String> {
        self.tx.send(Cmd::Dial(None, vec![addr])).await.map_err(|_| "the network has stopped".to_string())
    }

    /// Dials a known peer at any of its addresses, one attempt for all of them.
    async fn dial_peer(&self, peer: PeerId, addrs: Vec<Multiaddr>) {
        let _ = self.tx.send(Cmd::Dial(Some(peer), addrs)).await;
    }

    /// The peers in the routing table, with their addresses.
    pub async fn table(&self) -> Vec<(PeerId, Vec<Multiaddr>)> {
        self.ask(Cmd::Table).await.unwrap_or_default()
    }

    pub async fn listening(&self) -> Vec<Multiaddr> {
        self.ask(Cmd::Listening).await.unwrap_or_default()
    }

    /// The addresses the node should publish for others to dial: with `announce_listen`, every address it listens on;
    /// otherwise those `reach::published` keeps from what the owner named, what peers confirmed and its interfaces.
    pub async fn published(&self) -> Vec<Multiaddr> {
        self.ask(Cmd::Published).await.unwrap_or_default()
    }

    pub async fn save(&self) {
        let _ = self.tx.send(Cmd::Save).await;
    }

    /// Watches exactly these sites' change notices (`changes`), at most `MAX_WATCHED`: the sites whose routes the node
    /// keeps a copy of or serves. Each site newly watched has its providers met at once, so the node is on the site's
    /// topic with the nodes that list it; one with none connected is looked at again every `WATCH_EVERY`.
    pub async fn watch(&self, sites: Vec<String>) -> Result<(), String> {
        let sites: Vec<String> = sites.into_iter().filter_map(|s| site::site_of(&s)).collect::<std::collections::BTreeSet<_>>().into_iter().take(MAX_WATCHED).collect();
        let new = self.ask(|r| Cmd::Watch(sites, r)).await?;
        let net = self.clone();
        tokio::spawn(async move {
            for site in new {
                net.meet_watchers(&site).await;
            }
        });
        Ok(())
    }

    /// Publishes a change notice on its site's topic, signed by this node's key. The nodes that watch the site read the
    /// chain again for the entries it names. With none connected, the site's providers are met first.
    pub async fn publish_change(&self, change: Change) -> Result<(), String> {
        change.check(None, unix_now()).map_err(String::from)?;
        if self.watchers(&change.site).await.is_empty() {
            self.meet_watchers(&change.site).await;
        }
        self.ask(|r| Cmd::Publish(change, r)).await?
    }

    /// The notices this node reads, from sources that count, as they come. There is one such stream: the first call
    /// takes it, and later calls get none.
    pub fn changes(&self) -> Option<mpsc::Receiver<Heard>> {
        self.heard.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take()
    }

    /// The connected peers that watch `site`'s notices.
    pub async fn watchers(&self, site: &str) -> Vec<PeerId> {
        let site = site.to_string();
        self.ask(|r| Cmd::Watchers(site, r)).await.unwrap_or_default()
    }

    /// Meets the providers of `site` that count, at most `MEET_WATCHERS`: the nodes that list routes for it, which
    /// watch it, so this node is on the site's topic with them.
    async fn meet_watchers(&self, site: &str) {
        let Ok(providers) = self.ask(|r| Cmd::Providers(site::site_key(site), r)).await else { return };
        let _ = self.counted(providers, MEET_WATCHERS).await;
    }
}

/// Looks again, every `WATCH_EVERY`, for the nodes on each watched site's topic that has none connected: a node that
/// lists the site may have restarted, or the first meeting found none yet. It ends with the swarm.
async fn watching(net: Net) {
    while !net.stopped() {
        tokio::time::sleep(WATCH_EVERY).await;
        let Ok(lonely) = net.ask(Cmd::Lonely).await else { return };
        for site in lonely.into_iter().take(MEET_SITES) {
            net.meet_watchers(&site).await;
        }
    }
}

/// The listings one provider's answer adds to a lookup: only for the site asked about (anything else it sends is
/// dropped), each naming an entry id the chain could hold, each once, at most `MAX_LISTINGS_PER_SOURCE`. Nothing is
/// dropped for what another provider sent: that one's copy may be the forged one.
fn kept(listings: Vec<Listing>, site: &str) -> Vec<Listing> {
    let entry_id = |id: &str| id.strip_prefix("0x").is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()));
    let mut seen = HashSet::new();
    listings
        .into_iter()
        .filter(|l| l.site == site && entry_id(&l.entry_id))
        // Once per listing, not per entry: listings of one body are one entry (R2.4) and only accumulate (R2.16), and
        // each contributor's words are what a goal finds its listing by (R2.22).
        .filter(|l| seen.insert(format!("{}|{}|{}", l.entry_id.to_ascii_lowercase(), l.contributor.to_ascii_lowercase(), l.description)))
        .take(MAX_LISTINGS_PER_SOURCE)
        .collect()
}

/// The providers' answers taken in turn: the first listing of each, then the second of each, and so on. A reader that
/// stops after some number of listings has then given every provider the same share, so one that sends a full answer
/// of junk spends its own share and never another's.
fn interleaved(answers: Vec<Vec<Listing>>) -> Vec<Listing> {
    let mut answers: Vec<std::vec::IntoIter<Listing>> = answers.into_iter().map(Vec::into_iter).collect();
    let mut out = Vec::new();
    loop {
        let before = out.len();
        out.extend(answers.iter_mut().filter_map(Iterator::next));
        if out.len() == before {
            return out;
        }
    }
}

/// What of a node's listings one answer carries: in the order given, as many as fit the bounds the asker reads an answer
/// within, `MAX_LISTINGS_PER_SOURCE` listings and `MAX_ANSWER_BYTES` bytes. One that doesn't fit is left out and the
/// next is tried, so an answer past the bound is never sent whole, to be refused whole by the asker.
fn fit(listings: Vec<Listing>) -> Vec<Listing> {
    // `{"listings":[` and `]}`, and a comma between listings.
    let mut bytes = r#"{"listings":[]}"#.len();
    let mut out = Vec::new();
    for l in listings {
        if out.len() >= MAX_LISTINGS_PER_SOURCE {
            break;
        }
        let Ok(size) = serde_json::to_vec(&l).map(|v| v.len()) else { continue };
        let more = size + usize::from(!out.is_empty());
        if bytes + more <= MAX_ANSWER_BYTES as usize {
            bytes += more;
            out.push(l);
        }
    }
    out
}

/// Holds a provider record from a peer not yet judged, within the bounds; a record past them is dropped.
fn hold(held: &mut HashMap<PeerId, Vec<ProviderRecord>>, peer: PeerId, rec: ProviderRecord) {
    if !held.contains_key(&peer) && held.len() >= MAX_HELD_PEERS {
        return;
    }
    let recs = held.entry(peer).or_default();
    if recs.len() < MAX_HELD_PER_PEER {
        recs.push(rec);
    }
}

/// First contact (`first_contact`), then a lookup of the node's own ID, which fills its buckets. Repeated soon after
/// and then on a doubling wait up to every ten minutes, with a save each time; a node whose table has emptied makes
/// first contact again. The early repeats are what bound how long nodes that boot together take to meet: first
/// contact ends at the first peer that counts, and that peer may not have met the rest yet when it is first asked.
async fn join<R: Registry>(net: Net, registry: Arc<R>, saved: Option<PathBuf>) {
    // It ends with the swarm: a node that has stopped joins nothing.
    while !net.stopped() {
        first_contact(&net, registry.as_ref(), saved.as_deref()).await;
        let _ = net.tx.send(Cmd::Bootstrap).await;
        let mut wait = JOIN_RETRY;
        loop {
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(BOOTSTRAP_EVERY);
            if net.stopped() {
                return;
            }
            if net.table().await.is_empty() {
                break;
            }
            let _ = net.tx.send(Cmd::Bootstrap).await;
            net.save().await;
        }
    }
}

/// Dials the saved routing table first, and the registry's seeds only if none of those peers counts (R7.24), until
/// the table holds a peer. Both are tried again on a doubling wait for as long as it holds none: nodes that boot
/// together each read the registry before the others have said where they are, and a dial or a read that failed
/// once may not fail again.
async fn first_contact<R: Registry>(net: &Net, registry: &R, saved: Option<&std::path::Path>) {
    let mut wait = JOIN_RETRY;
    while !net.stopped() {
        for (peer, addrs) in saved.map(load_table).unwrap_or_default() {
            net.dial_peer(peer, addrs).await;
        }
        if table_within(net, JOIN_RETRY).await {
            return;
        }
        let mut seeds: HashMap<PeerId, Vec<Multiaddr>> = HashMap::new();
        for (peer, addr) in registry.seeds().await {
            if peer != net.peer_id {
                seeds.entry(peer).or_default().push(addr);
            }
        }
        for (peer, addrs) in seeds {
            net.dial_peer(peer, addrs).await;
        }
        if table_within(net, wait).await {
            return;
        }
        wait = (wait * 2).min(JOIN_RETRY_MAX);
    }
}

/// Whether the routing table holds a peer within `wait`.
async fn table_within(net: &Net, wait: Duration) -> bool {
    let until = Instant::now() + wait;
    loop {
        tokio::time::sleep(Duration::from_secs(1).min(wait)).await;
        if !net.table().await.is_empty() {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
    }
}

#[derive(Serialize, Deserialize)]
struct SavedPeer {
    peer: String,
    addrs: Vec<String>,
}

/// The table saved at `path` (`unbrowse_files::PEER_TABLE`): none when it is missing, doesn't read or a newer node
/// wrote it.
fn load_table(path: &std::path::Path) -> Vec<(PeerId, Vec<Multiaddr>)> {
    let saved: Vec<SavedPeer> = unbrowse_files::PEER_TABLE.read_at(path).ok().flatten().unwrap_or_default();
    saved
        .into_iter()
        .filter_map(|s| Some((s.peer.parse().ok()?, s.addrs.iter().filter_map(|a| a.parse().ok()).collect())))
        .collect()
}

/// Saves the routing table whole or not at all: written beside it and renamed over it, so a node stopped mid-write
/// starts from the last table it saved. An empty table isn't saved: the peers known last time are a better start. A
/// table a newer node saved is never written over.
fn save_table(path: &std::path::Path, table: &[(PeerId, Vec<Multiaddr>)]) {
    if table.is_empty() {
        return;
    }
    let saved: Vec<SavedPeer> = table.iter().map(|(p, a)| SavedPeer { peer: p.to_string(), addrs: a.iter().map(|a| a.to_string()).collect() }).collect();
    let _ = unbrowse_files::PEER_TABLE.write_at(path, &saved);
}

/// How many registry reads, each judging one peer's hello, the node runs at once. Every peer with a key of its own can
/// say hello, and keys cost nothing: without a bound, as many reads as peers could connect at once would run against the
/// registry.
const REGISTRY_LOOKUPS: usize = 8;

/// How many hellos may wait for a registry read. Past it a hello is left unjudged and asked again later (`unread`).
const LOOKUPS_WAITING: usize = 256;

/// How many peers refused a place because the queue is full (`Source::places`) are remembered as next in line: when one
/// says hello again it waits ahead of every hello that came since, past `LOOKUPS_WAITING` if need be.
const NEXT_IN_LINE: usize = 64;

/// How many hellos from one source (`Source`) may wait at once. Keys cost nothing, so one machine could otherwise fill
/// every place with peers of its own and leave the rest refused.
const SOURCE_WAITING: usize = 16;

/// Of the `LOOKUPS_WAITING` places, how many hellos over relayed connections may hold at once; the rest are kept for
/// direct ones. Of the `NEXT_IN_LINE` remembered, how many may be relayed. Each kind has places the other can't take:
/// relays carry whoever reaches them, so the peers behind every relay together can't crowd out a peer that connected
/// directly, and a busy direct crowd can't leave relayed peers, whose only way in is a relay, without a place.
const RELAYED_WAITING: usize = LOOKUPS_WAITING / 4;
const RELAYED_NEXT_IN_LINE: usize = NEXT_IN_LINE / 4;

/// Where a hello comes from, for sharing the registry reads and the waiting places fairly. A source is something a
/// peer can't mint for free: keys cost nothing, so a peer is never a source of its own.
///
/// - A direct connection's source is the address it came from (an IPv6 one by its /64, which one machine is commonly
///   given whole), so a machine minting peers counts once.
/// - A relayed connection's source is the relay it came through, one source for every peer behind it. A relay client
///   can be anyone and can name as many peers as it likes; the relay is one the node itself dialed or reserved on.
/// - A connection whose address names neither shares one source with every other such connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Source {
    Ip(std::net::IpAddr),
    /// The relay's peer, or `None` for every relay whose address doesn't name it.
    Relayed(Option<PeerId>),
    Unplaced,
}

impl Source {
    fn of(endpoint: &libp2p::core::ConnectedPoint) -> Source {
        use libp2p::core::ConnectedPoint;
        // A circuit is named in the address dialed, or in the relayed address the node listens on (the peer's own
        // address then names only the peer).
        let (remote, ours) = match endpoint {
            ConnectedPoint::Dialer { address, .. } => (address, None),
            ConnectedPoint::Listener { local_addr, send_back_addr } => (send_back_addr, Some(local_addr)),
        };
        if let Some(relay) = Source::relay_in(remote).or_else(|| ours.and_then(Source::relay_in)) {
            return Source::Relayed(relay);
        }
        for p in remote.iter() {
            match p {
                Protocol::Ip4(v4) => return Source::Ip(v4.into()),
                Protocol::Ip6(v6) => {
                    let s = v6.segments();
                    return Source::Ip(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0).into());
                }
                _ => {}
            }
        }
        Source::Unplaced
    }

    /// If `addr` goes through a relay, the relay: the peer named just before the circuit, if any.
    fn relay_in(addr: &Multiaddr) -> Option<Option<PeerId>> {
        let mut last = None;
        for p in addr.iter() {
            match p {
                Protocol::P2p(peer) => last = Some(peer),
                Protocol::P2pCircuit => return Some(last),
                _ => {}
            }
        }
        None
    }

    fn relayed(&self) -> bool {
        matches!(self, Source::Relayed(_))
    }

    /// The places hellos of this kind may hold waiting, and how many of this kind are remembered as next in line.
    fn places(&self) -> (usize, usize) {
        if self.relayed() {
            (RELAYED_WAITING, RELAYED_NEXT_IN_LINE)
        } else {
            (LOOKUPS_WAITING - RELAYED_WAITING, NEXT_IN_LINE - RELAYED_NEXT_IN_LINE)
        }
    }
}

/// The registry reads for hellos: those running and those waiting, in the order they came. A peer has at most one read
/// running or waiting, each read ends by `registry_timeout`, and a freed place goes to the peer that has waited longest,
/// never to whoever says hello again first. So peers that hold their reads as long as they can (a registry slow for
/// their identity) take their turn and give it up, and a peer that came while they held every place is next, not
/// refused for as long as they keep coming back.
///
/// A peer refused because every place its kind may hold is taken (`Source::places`: direct and relayed hellos each
/// have their own, `LOOKUPS_WAITING` in all) is remembered, the first of them in the order they were refused, up to
/// its kind's share of `NEXT_IN_LINE`, while it stays connected. Its hello asked again then waits at the front, behind
/// only remembered peers that came back before it, so peers that keep arriving can't refuse it again on every retry.
///
/// The places, and the registry reads they spend (`Reads`), go round the sources with a hello waiting: the next is
/// the waiting hello whose source was served longest ago, oldest first among equals. One source holds at most
/// `SOURCE_WAITING` places in the queue. So a machine naming a fresh identity on every hello, from one peer or a
/// thousand, takes its turn with every other source, and a hello from anywhere else is next once a read is free.
#[derive(Default)]
struct Lookups {
    running: HashSet<PeerId>,
    waiting: VecDeque<(PeerId, Source, Claim)>,
    /// How many hellos at the front of `waiting` are from peers that were next in line.
    ahead: usize,
    /// Each with whether it came relayed, so each kind keeps to its share.
    next_in_line: VecDeque<(PeerId, bool)>,
    /// When each source was last served, by a count of hellos served; a source not here has never been, or not lately.
    served: HashMap<Source, u64>,
    turn: u64,
}

#[derive(Debug, PartialEq)]
enum Offer {
    Waiting,
    /// The peer has a read running or waiting already: this hello is that one's, and starts nothing.
    AlreadyAsked,
    /// `LOOKUPS_WAITING` hellos are waiting.
    Full,
}

impl Lookups {
    fn offer(&mut self, peer: PeerId, source: Source, claim: Claim) -> Offer {
        if self.running.contains(&peer) || self.waiting.iter().any(|(p, _, _)| *p == peer) {
            return Offer::AlreadyAsked;
        }
        if self.waiting.iter().filter(|(_, s, _)| *s == source).count() >= SOURCE_WAITING {
            return Offer::Full;
        }
        let (places, remembered) = source.places();
        let relayed = source.relayed();
        if let Some(i) = self.next_in_line.iter().position(|(p, _)| *p == peer) {
            if self.next_in_line[i].1 == relayed && self.waiting.iter().take(self.ahead).filter(|(_, s, _)| s.relayed() == relayed).count() >= remembered {
                // As many of its kind as are ever remembered wait at the front already: it stays remembered, and
                // comes in when one of them is served. The front is the kind's share of `NEXT_IN_LINE` and no more,
                // so refusing, remembering and coming back never grows the queue past its ceiling.
                return Offer::Full;
            }
            let (_, was_relayed) = self.next_in_line.remove(i).expect("just found");
            if was_relayed == relayed {
                // Remembered when it was refused: it waits ahead of every hello not remembered.
                self.waiting.insert(self.ahead, (peer, source, claim));
                self.ahead += 1;
                return Offer::Waiting;
            }
            // It was remembered as the other kind: that turn was in the other kind's share, and coming back another
            // way doesn't carry it into this one's. It is a newcomer here.
        }
        if self.waiting.iter().filter(|(_, s, _)| s.relayed() == relayed).count() >= places {
            if self.next_in_line.iter().filter(|(_, r)| *r == relayed).count() < remembered {
                self.next_in_line.push_back((peer, relayed));
            }
            return Offer::Full;
        }
        self.waiting.push_back((peer, source, claim));
        Offer::Waiting
    }

    /// If a place is free, the waiting hello whose source was served longest ago (the oldest of those) of the ones
    /// `ready` takes, now counted as running.
    fn next(&mut self, mut ready: impl FnMut(&Claim, Source) -> bool) -> Option<(PeerId, Source, Claim)> {
        if self.running.len() >= REGISTRY_LOOKUPS {
            return None;
        }
        let i = (0..self.waiting.len())
            .filter(|&i| ready(&self.waiting[i].2, self.waiting[i].1))
            .min_by_key(|&i| (self.served.get(&self.waiting[i].1).copied().unwrap_or(0), i))?;
        let (peer, source, claim) = self.waiting.remove(i)?;
        if i < self.ahead {
            self.ahead -= 1;
        }
        self.turn += 1;
        self.served.insert(source, self.turn);
        // What is remembered is bounded: a source served long ago and with nothing waiting is as one never served.
        if self.served.len() > 2 * LOOKUPS_WAITING {
            let (turn, waiting) = (self.turn, &self.waiting);
            self.served.retain(|s, at| turn - *at < LOOKUPS_WAITING as u64 || waiting.iter().any(|(_, w, _)| w == s));
        }
        self.running.insert(peer);
        Some((peer, source, claim))
    }

    fn done(&mut self, peer: PeerId) {
        self.running.remove(&peer);
    }

    /// The peer has gone: it is no longer next in line.
    fn gone(&mut self, peer: &PeerId) {
        self.next_in_line.retain(|(p, _)| p != peer);
    }
}

/// How long the registry's answer about one identity stands before it is read again: short, so a node its identity
/// has just added is admitted soon after, and long enough that peers naming one identity again and again (retries,
/// several nodes, fresh keys) cost one read.
const REGISTRY_FRESH: Duration = Duration::from_secs(10);
/// Identities whose answers are remembered, at most.
const REGISTRY_REMEMBERED: usize = 4096;
/// Registry reads for identities with no fresh answer: a burst, then one a second, however many peers say hello. Keys
/// and identity numbers cost a peer nothing, so without it peers naming a new one each time would have the node read
/// the chain as fast as they connect, and the RPC the node pays and claims through would turn it away. Past it a hello
/// is left unjudged and asked again later, as one whose read failed is.
const REGISTRY_READ_BURST: f64 = 32.0;
const REGISTRY_READS_PER_SECOND: f64 = 1.0;
/// Each source's own share of those reads (`Source`): a few at once, then one every four seconds. One machine naming
/// fresh identities, however many keys it mints, spends at most a quarter of the steady rate, and the rest stays for
/// everyone else.
const SOURCE_READ_BURST: f64 = 4.0;
const SOURCE_READS_PER_SECOND: f64 = 0.25;

/// The registry's recent answers, by the identity as a peer named it, and the allowance for reads past them: the
/// node's, and each source's within it.
struct Reads {
    answers: HashMap<String, (Instant, Option<Identity>)>,
    tokens: f64,
    at: Instant,
    sources: HashMap<Source, (f64, Instant)>,
}

#[derive(Debug)]
enum Answer {
    /// A fresh answer: no read.
    Known(Option<Identity>),
    /// Read the registry; the allowance is spent.
    Read,
    /// The allowance is spent: ask again later.
    Later,
}

impl Reads {
    fn new(now: Instant) -> Reads {
        Reads { answers: HashMap::new(), tokens: REGISTRY_READ_BURST, at: now, sources: HashMap::new() }
    }

    fn known(&self, id: &str, now: Instant) -> Option<Option<Identity>> {
        let (at, answer) = self.answers.get(id)?;
        (now.saturating_duration_since(*at) < REGISTRY_FRESH).then(|| answer.clone())
    }

    /// The node's allowance and `source`'s at `now`.
    fn allowance(&self, source: Source, now: Instant) -> (f64, f64) {
        let node = (self.tokens + now.saturating_duration_since(self.at).as_secs_f64() * REGISTRY_READS_PER_SECOND).min(REGISTRY_READ_BURST);
        let own = self.sources.get(&source).map_or(SOURCE_READ_BURST, |(t, at)| {
            (t + now.saturating_duration_since(*at).as_secs_f64() * SOURCE_READS_PER_SECOND).min(SOURCE_READ_BURST)
        });
        (node, own)
    }

    /// Whether a hello naming `id` from `source` can be judged now: its answer is fresh, or both allowances have a read.
    fn ready(&self, id: &str, source: Source, now: Instant) -> bool {
        let (node, own) = self.allowance(source, now);
        self.known(id, now).is_some() || (node >= 1.0 && own >= 1.0)
    }

    fn ask(&mut self, id: &str, source: Source, now: Instant) -> Answer {
        if let Some(answer) = self.known(id, now) {
            return Answer::Known(answer);
        }
        let (node, own) = self.allowance(source, now);
        self.tokens = node;
        self.at = now;
        if node < 1.0 || own < 1.0 {
            return Answer::Later;
        }
        self.tokens -= 1.0;
        // A source with a full allowance is as one never seen, so only those that spent lately are kept.
        if self.sources.len() >= REGISTRY_REMEMBERED {
            self.sources.retain(|_, (t, at)| *t + now.saturating_duration_since(*at).as_secs_f64() * SOURCE_READS_PER_SECOND < SOURCE_READ_BURST);
        }
        self.sources.insert(source, (own - 1.0, now));
        Answer::Read
    }

    /// Keeps what the registry answered for `id`. A failed read is never kept: it said nothing.
    fn answered(&mut self, id: String, answer: Option<Identity>, now: Instant) {
        if !self.answers.contains_key(&id) && self.answers.len() >= REGISTRY_REMEMBERED {
            self.answers.retain(|_, (at, _)| now.saturating_duration_since(*at) < REGISTRY_FRESH);
            if self.answers.len() >= REGISTRY_REMEMBERED {
                return;
            }
        }
        self.answers.insert(id, (now, answer));
    }
}

/// Says the read for `peer` has ended when dropped, so a read that panics gives its place back too.
struct LookupEnds(mpsc::UnboundedSender<Inner>, PeerId);

impl Drop for LookupEnds {
    fn drop(&mut self) {
        let _ = self.0.send(Inner::LookupDone(self.1));
    }
}

/// How often waiting hellos are looked at again while none can be judged yet, for want of a registry read.
const READS_WAKE: Duration = Duration::from_millis(500);

/// The hellos to judge now, in turn by source (`Lookups::next`), while places are free and each has a fresh answer or
/// a read both its source's allowance and the node's can spend; each with the read spent on it. A hello that can't be
/// judged yet stays waiting, never refused, and its turn keeps its place. A peer gone while its hello waited is passed
/// over.
fn next_lookups(lookups: &mut Lookups, reads: &mut Reads, now: Instant, mut connected: impl FnMut(&PeerId) -> bool) -> Vec<(PeerId, Claim, Answer)> {
    let mut started = Vec::new();
    while let Some((peer, source, claim)) = lookups.next(|c, s| reads.ready(&c.identity, s, now)) {
        if !connected(&peer) {
            lookups.done(peer);
            continue;
        }
        let asked = reads.ask(&claim.identity, source, now);
        started.push((peer, claim, asked));
    }
    started
}

/// Starts the registry reads for the hellos that can be judged now (`next_lookups`), and looks again shortly while
/// some wait for a read.
fn start_lookups<R: Registry>(swarm: &Swarm<Behaviour>, st: &mut State, registry: &Arc<R>, itx: &mpsc::UnboundedSender<Inner>) {
    let reads = st.reads.clone();
    let started = {
        let mut reads = reads.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        next_lookups(&mut st.lookups, &mut reads, Instant::now(), |p| swarm.is_connected(p))
    };
    if !st.lookups.waiting.is_empty() && st.lookups.running.len() < REGISTRY_LOOKUPS && !st.reads_wake {
        st.reads_wake = true;
        later(itx, READS_WAKE, Inner::ReadsFree);
    }
    for (peer, claim, asked) in started {
        let (registry, itx, rules, wait, reads) = (registry.clone(), itx.clone(), st.rules, st.registry_timeout, st.reads.clone());
        tokio::spawn(async move {
            let _ends = LookupEnds(itx.clone(), peer);
            let reads_now = || reads.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let answer = match asked {
                Answer::Known(identity) => Ok(Ok(identity)),
                Answer::Later => {
                    sut_reachable!("a peer was left unjudged because the node had read the registry as often as it may", &serde_json::json!({ "peer": peer.to_string() }));
                    let _ = itx.send(Inner::Unread(peer));
                    return;
                }
                Answer::Read => {
                    let answer = tokio::time::timeout(wait, registry.identity(&claim.identity)).await;
                    if let Ok(Ok(identity)) = &answer {
                        reads_now().answered(claim.identity.clone(), identity.clone(), Instant::now());
                    }
                    answer
                }
            };
            match answer {
                Ok(Ok(identity)) => {
                    let verdict = admission::admit(&peer, &claim, identity.as_ref(), rules);
                    // A peer counts under the identity as the registry names it, never as the peer spelled it:
                    // "5" and "0x5" are one identity, and count once.
                    let claim = match (&verdict, &identity) {
                        (Ok(()), Some(i)) => Claim { identity: i.id.clone(), ..claim },
                        _ => claim,
                    };
                    let _ = itx.send(Inner::Judged(peer, claim, verdict));
                }
                Ok(Err(_)) | Err(_) => {
                    sut_reachable!("a peer was left unjudged because its registry read failed or timed out", &serde_json::json!({ "peer": peer.to_string() }));
                    let _ = itx.send(Inner::Unread(peer));
                }
            }
        });
    }
}

struct State {
    /// The node's own key, which signs its leaving notices.
    key: Keypair,
    claim: Claim,
    rules: Rules,
    admission_ttl: Duration,
    refusal_ttl: Duration,
    registry_timeout: Duration,
    /// The registry reads for hellos, running and waiting (`Lookups`).
    lookups: Lookups,
    /// The registry's recent answers and the allowance for reads past them (`Reads`).
    reads: Arc<std::sync::Mutex<Reads>>,
    /// A look at the waiting hellos is due (`READS_WAKE`).
    reads_wake: bool,
    /// Where each connected peer's first connection came from (`Source`).
    sources: HashMap<PeerId, Source>,
    announce_listen: bool,
    announce: Vec<Multiaddr>,
    serve: Serve,
    nat: Nat,
    /// Peers that offer to relay for others, from Identify.
    hop: HashSet<PeerId>,
    /// Relays this node holds a reservation on, by the listener that holds it.
    relays: HashMap<PeerId, ListenerId>,
    kad_proto: StreamProtocol,
    saved: Option<PathBuf>,
    min_peer: Option<semver::Version>,
    admitted: HashMap<PeerId, (String, Instant)>,
    /// Peers turned away, when, and for how long.
    refused: HashMap<PeerId, (Instant, Duration)>,
    /// Peers the registry didn't list under the identity they named, and how many times in a row: each is asked again
    /// while connected, later each time (`UNLISTED_RETRY`).
    unlisted: HashMap<PeerId, u32>,
    /// Peers per bucket: a table holding fewer is small, and re-announces on admissions and on `REANNOUNCE_EVERY`.
    k: usize,
    /// An announcement of everything the node provides is due shortly.
    reannouncing: bool,
    /// Peers asked who they are and not yet judged.
    asking: HashSet<PeerId>,
    /// Peers whose identity couldn't be read, and how many times in a row: each is asked again, later each time.
    unread: HashMap<PeerId, u32>,
    /// Peers Identify last said are older than the network takes. Such a peer never counts, whatever its admission
    /// said, until Identify says it is new enough.
    too_old: HashSet<PeerId>,
    /// Addresses of peers that serve the table, from Identify.
    routable: HashMap<PeerId, Vec<Multiaddr>>,
    /// Provider records from peers not yet judged.
    held: HashMap<PeerId, Vec<ProviderRecord>>,
    waiting: HashMap<PeerId, Vec<oneshot::Sender<Standing>>>,
    providing: HashMap<QueryId, oneshot::Sender<Result<(), String>>>,
    finding: HashMap<QueryId, (HashSet<PeerId>, oneshot::Sender<HashSet<PeerId>>)>,
    locating: HashMap<QueryId, (PeerId, oneshot::Sender<Vec<Multiaddr>>)>,
    fetching: HashMap<OutboundRequestId, oneshot::Sender<Result<Vec<Listing>, String>>>,
    fetching_bodies: HashMap<OutboundRequestId, oneshot::Sender<Result<BodyAnswer, request_response::OutboundFailure>>>,
    /// How often each peer may ask for listings and for bodies, and the slots answers are made in.
    listings_budget: Budget,
    bodies_budget: Budget,
    listings_slots: Slots<(ResponseChannel<ListingsAnswer>, ListingsAsk)>,
    body_slots: Slots<(ResponseChannel<BodyAnswer>, BodyAsk)>,
    /// Who paid this node for bodies lately: they are served first when the slots are full.
    payers: Payers,
    /// Slots of each kind there are.
    slot_count: usize,
    /// How many Kademlia streams each peer may open, shared with every connection's handler.
    kad_gate: KadGate,
    /// The sites whose change notices the node watches, how many notices each source may have read, and where those
    /// read go.
    watched: HashSet<String>,
    /// The versions of change notices spoken, newest first: each has its own topic (`changes::topic_of`).
    notices: Vec<u32>,
    change_rate: PerPeer,
    heard: mpsc::Sender<Heard>,
    tower: Desk,
    provider_ttl: Duration,
    connect_timeout: Duration,
    check_after: Duration,
    /// How long a peer pinged for being silent has to answer: a dial and a ping.
    check_wait: Duration,
    /// When each peer was last seen: a connection opened or closed, or a ping answered.
    last_seen: HashMap<PeerId, Instant>,
    /// Peers in the routing table pinged for being silent, and since when.
    probing: HashMap<PeerId, Instant>,
    /// Lookups waiting to reach a peer.
    connecting: HashMap<PeerId, Vec<oneshot::Sender<Reached>>>,
    /// The keys this node holds a provider record of each peer's under, so a peer that leaves takes every one.
    recorded: HashMap<PeerId, HashSet<RecordKey>>,
    /// Peers that said they were leaving, and when. One counts again only once it opens a connection after saying so and
    /// is admitted again.
    left: HashMap<PeerId, Instant>,
    /// The node is leaving: it announces nothing more.
    stopping: bool,
    /// Goodbyes sent and not yet answered, how many were answered, and who waits on them all.
    goodbyes: HashSet<OutboundRequestId>,
    heard_goodbye: usize,
    leave: Option<oneshot::Sender<usize>>,
    load: Load,
}

impl State {
    fn new(cfg: &Config, kad_proto: StreamProtocol, key: Keypair, kad_gate: KadGate, heard: mpsc::Sender<Heard>) -> State {
        State {
            key,
            claim: cfg.claim.clone(),
            rules: cfg.rules,
            admission_ttl: cfg.admission_ttl,
            refusal_ttl: cfg.refusal_ttl,
            registry_timeout: cfg.registry_timeout,
            lookups: Lookups::default(),
            reads: Arc::new(std::sync::Mutex::new(Reads::new(Instant::now()))),
            reads_wake: false,
            sources: HashMap::new(),
            announce_listen: cfg.announce_listen,
            announce: cfg.announce.clone(),
            serve: cfg.serve,
            nat: Nat::Unknown,
            hop: HashSet::new(),
            relays: HashMap::new(),
            kad_proto,
            saved: cfg.saved.clone(),
            min_peer: cfg.min_peer_version.as_deref().and_then(|v| semver::Version::parse(v).ok()),
            admitted: HashMap::new(),
            refused: HashMap::new(),
            unlisted: HashMap::new(),
            k: cfg.k,
            reannouncing: false,
            asking: HashSet::new(),
            unread: HashMap::new(),
            too_old: HashSet::new(),
            routable: HashMap::new(),
            held: HashMap::new(),
            waiting: HashMap::new(),
            providing: HashMap::new(),
            finding: HashMap::new(),
            locating: HashMap::new(),
            fetching: HashMap::new(),
            fetching_bodies: HashMap::new(),
            listings_budget: Budget::new(LISTINGS_RATE, STRANGERS_LISTINGS),
            bodies_budget: Budget::new(BODY_RATE, STRANGERS_BODIES),
            listings_slots: Slots::new(cfg.slots, cfg.slots_per_peer),
            body_slots: Slots::new(cfg.slots, cfg.slots_per_peer),
            payers: Payers::default(),
            slot_count: cfg.slots,
            kad_gate,
            watched: HashSet::new(),
            notices: cfg.speaks.versions(wire::CHANGES).to_vec(),
            change_rate: PerPeer::new(changes::CHANGE_RATE),
            heard,
            tower: Desk::new(),
            provider_ttl: cfg.provider_ttl,
            connect_timeout: cfg.connect_timeout,
            check_after: cfg.check_after,
            check_wait: cfg.connect_timeout + cfg.ping_timeout,
            last_seen: HashMap::new(),
            probing: HashMap::new(),
            connecting: HashMap::new(),
            recorded: HashMap::new(),
            left: HashMap::new(),
            stopping: false,
            goodbyes: HashSet::new(),
            heard_goodbye: 0,
            leave: None,
            load: Load::default(),
        }
    }

    /// How live `peer` is, from the swarm's connections and when it was last seen.
    fn live(&self, swarm: &Swarm<Behaviour>, peer: &PeerId) -> Live {
        if swarm.is_connected(peer) {
            Live::Now
        } else if self.last_seen.get(peer).is_some_and(|t| t.elapsed() < self.provider_ttl) {
            Live::Lately
        } else {
            Live::Unknown
        }
    }

    /// Tells those waiting to reach `peer` how it went.
    fn reached(&mut self, peer: &PeerId, r: Reached) {
        for w in self.connecting.remove(peer).unwrap_or_default() {
            let _ = w.send(r);
        }
    }

    fn standing(&self, peer: &PeerId) -> Option<Standing> {
        // A peer that said it was leaving is gone until it comes back: nothing it was admitted under stands.
        if self.left.contains_key(peer) {
            return Some(Standing::Unreachable);
        }
        if let Some((id, at)) = self.admitted.get(peer) {
            if at.elapsed() < self.admission_ttl {
                // The version gate: a peer Identify reported older than the network takes is never a source.
                sut_always_or_unreachable!(!self.too_old.contains(peer), "a peer Identify found too old never counts", &serde_json::json!({ "peer": peer.to_string() }));
                return Some(Standing::Counts(id.clone()));
            }
        }
        match self.refused.get(peer) {
            Some((at, ttl)) if at.elapsed() < *ttl => Some(Standing::Refused),
            _ => None,
        }
    }

    fn counts(&self, peer: &PeerId) -> bool {
        matches!(self.standing(peer), Some(Standing::Counts(_)))
    }

    fn tell(&mut self, peer: &PeerId, s: Standing) {
        for w in self.waiting.remove(peer).unwrap_or_default() {
            let _ = w.send(s.clone());
        }
    }

    /// Whether others can reach the node directly: AutoNAT found so, or its addresses are taken as reachable.
    fn reachable(&self) -> bool {
        self.announce_listen || !self.announce.is_empty() || self.nat == Nat::Public
    }
}

/// Sets what the node does for others from whether they reach it: it serves the table (unless told which to do) and
/// relays only while reachable, and holds relay reservations only while AutoNAT finds it can't be reached.
fn serve_as(swarm: &mut Swarm<Behaviour>, st: &State) {
    let serves = match st.serve {
        Serve::Server => true,
        Serve::Client => false,
        Serve::Auto => st.reachable(),
    };
    let b = swarm.behaviour_mut();
    b.kad.set_mode(Some(if serves { Mode::Server } else { Mode::Client }));
    // A node in light mode relays for nobody, and one found unreachable from outside can't.
    let relays = st.nat == Nat::Public && st.serve != Serve::Client;
    b.relay.set_status(Some(if relays { relay::Status::Enable } else { relay::Status::Disable }));
}

/// Whether the node should hold relay reservations: AutoNAT tried and nobody could dial it, and no address it has is
/// otherwise taken as reachable. AutoNAT goes back to not knowing when its probes find nobody to ask, which says
/// nothing new about the node, so reservations already held are kept through that: dropping them would leave a node
/// nobody can dial with no address at all until the next verdict.
fn needs_relay(nat: Nat, reachable: bool, holding: bool) -> bool {
    !reachable && (nat == Nat::Private || (nat == Nat::Unknown && holding))
}

/// Takes reservations on admitted peers that relay, up to `MAX_RELAYS`, while the node needs them; drops them once it
/// doesn't. A relay is reached at an address another machine could dial, so the relayed address it gives is too.
fn relay_through(swarm: &mut Swarm<Behaviour>, st: &mut State) {
    if !needs_relay(st.nat, st.reachable(), !st.relays.is_empty()) {
        for (_, l) in st.relays.drain() {
            swarm.remove_listener(l);
        }
        return;
    }
    let candidates: Vec<PeerId> = st
        .hop
        .iter()
        .filter(|p| !st.relays.contains_key(p) && swarm.is_connected(p) && matches!(st.standing(p), Some(Standing::Counts(_))))
        .copied()
        .collect();
    for peer in candidates {
        if st.relays.len() >= MAX_RELAYS {
            break;
        }
        let direct = |a: &&Multiaddr| reach::dialable(a) && !a.iter().any(|p| p == Protocol::P2pCircuit);
        let Some(addr) = st.routable.get(&peer).and_then(|addrs| addrs.iter().find(direct)).cloned() else { continue };
        if let Ok(l) = swarm.listen_on(addr.with(Protocol::P2p(peer)).with(Protocol::P2pCircuit)) {
            st.relays.insert(peer, l);
        }
    }
}

/// Whether `peer` counts now, told to the Kademlia gate, which gives a peer that counts a bucket of its own, and to
/// gossipsub, where a peer the registry refused scores below the graylist. Called wherever a peer's admission changes,
/// and as it connects.
fn recount(swarm: &mut Swarm<Behaviour>, st: &State, peer: &PeerId) {
    let standing = st.standing(peer);
    st.kad_gate.set_counts(*peer, matches!(standing, Some(Standing::Counts(_))));
    let score = if standing == Some(Standing::Refused) { changes::REFUSED_SCORE } else { 0.0 };
    swarm.behaviour_mut().gossip.set_application_score(peer, score);
}

/// Where `peer` stands, told to `reply`: at once if it is known, or once it is judged, meeting it first if need be.
fn admit_now(swarm: &mut Swarm<Behaviour>, st: &mut State, peer: PeerId, addrs: Vec<Multiaddr>, reply: oneshot::Sender<Standing>) {
    if let Some(s) = st.standing(&peer) {
        let _ = reply.send(s);
        return;
    }
    st.waiting.entry(peer).or_default().push(reply);
    if swarm.is_connected(&peer) {
        ask_who(swarm, st, peer);
    } else if swarm.dial(DialOpts::peer_id(peer).addresses(addrs).extend_addresses_through_behaviour().allocate_new_port().build()).is_err() {
        st.tell(&peer, Standing::Unreachable);
    }
}

fn ask_who(swarm: &mut Swarm<Behaviour>, st: &mut State, peer: PeerId) {
    if st.asking.insert(peer) {
        swarm.behaviour_mut().hello.send_request(&peer, Hello {});
    }
}

/// A peer's release, as Identify told it (`unbrowse/<version>`), is older than `min`, or it didn't say.
fn too_old(agent: &str, min: Option<&semver::Version>) -> bool {
    let Some(min) = min else { return false };
    agent.strip_prefix("unbrowse/").and_then(|v| semver::Version::parse(v).ok()).is_none_or(|v| &v < min)
}

fn into_table(swarm: &mut Swarm<Behaviour>, st: &State, peer: &PeerId) {
    for a in st.routable.get(peer).cloned().unwrap_or_default() {
        swarm.behaviour_mut().kad.add_address(peer, a);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run<R: Registry, L: Listings, B: Bodies, T: Towers>(
    mut swarm: Swarm<Behaviour>,
    mut st: State,
    registry: Arc<R>,
    listings: Arc<L>,
    bodies: Arc<B>,
    towers: Arc<T>,
    mut rx: mpsc::Receiver<Cmd>,
    itx: mpsc::UnboundedSender<Inner>,
    mut irx: mpsc::UnboundedReceiver<Inner>,
) {
    let mut every = tokio::time::interval_at(tokio::time::Instant::now() + REANNOUNCE_EVERY, REANNOUNCE_EVERY);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The table is checked a few times in each `check_after`, so a peer is pinged soon after it falls silent.
    let check_every = (st.check_after / 4).max(Duration::from_millis(250));
    let mut check = tokio::time::interval_at(tokio::time::Instant::now() + check_every, check_every);
    check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = every.tick() => {
                let size = table_of(&mut swarm).len();
                if size > 0 && size < st.k && !st.stopping {
                    reannounce(&mut swarm, &mut st);
                }
            }
            _ = check.tick() => check_table(&mut swarm, &mut st),
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                if !command(&mut swarm, &mut st, cmd) {
                    break;
                }
            }
            Some(inner) = irx.recv() => match inner {
                Inner::Judged(peer, claim, verdict) => judged(&mut swarm, &mut st, &itx, peer, claim, verdict),
                Inner::Reannounce => {
                    st.reannouncing = false;
                    if !st.stopping {
                        reannounce(&mut swarm, &mut st);
                    }
                }
                Inner::Unread(peer) => unread(&mut st, &itx, peer),
                Inner::LookupDone(peer) => {
                    st.lookups.done(peer);
                    start_lookups(&swarm, &mut st, &registry, &itx);
                }
                Inner::ReadsFree => {
                    st.reads_wake = false;
                    start_lookups(&swarm, &mut st, &registry, &itx);
                }
                Inner::Enough(id) => {
                    if let Some((found, reply)) = st.finding.remove(&id) {
                        let _ = reply.send(found);
                        if let Some(mut q) = swarm.behaviour_mut().kad.query_mut(&id) {
                            q.finish();
                        }
                    }
                }
                Inner::AskAgain(peer) => {
                    if swarm.is_connected(&peer) && st.standing(&peer).is_none() {
                        if st.unread.contains_key(&peer) {
                            sut_reachable!("a peer the registry couldn't be read for was asked again", &serde_json::json!({ "peer": peer.to_string() }));
                        }
                        ask_who(&mut swarm, &mut st, peer);
                    }
                }
                Inner::Answer(channel, slot, ls) => {
                    // None: the answer couldn't be made in time. The channel goes unanswered, so the asker hears no
                    // answer at all rather than an empty one, which would count this node as a source with nothing.
                    if let Some(ls) = ls {
                        let answer = ListingsAnswer { listings: fit(ls), refused: None };
                        sut_always!(
                            answer.listings.len() <= MAX_LISTINGS_PER_SOURCE && serde_json::to_vec(&answer).map_or(0, |v| v.len() as u64) <= MAX_ANSWER_BYTES,
                            "a listings answer a node sends fits the bound its asker reads",
                            &serde_json::json!({ "listings": answer.listings.len() })
                        );
                        let _ = swarm.behaviour_mut().listings.send_response(channel, answer);
                    }
                    let now = Instant::now();
                    let payers = &st.payers;
                    if let Some((slot, (channel, ask))) = st.listings_slots.done(slot, now, |p| payers.rank(p, now)) {
                        answer_listings(&itx, &listings, slot, channel, ask);
                    }
                }
                Inner::Body(channel, slot, answer) => {
                    let now = Instant::now();
                    // A body served is one paid for: the node serves none unless the payment checks.
                    if matches!(answer, BodyAnswer::Ok { .. }) {
                        st.payers.paid(slot.peer, now);
                    }
                    let _ = swarm.behaviour_mut().body.send_response(channel, answer);
                    let payers = &st.payers;
                    if let Some((slot, (channel, ask))) = st.body_slots.done(slot, now, |p| payers.rank(p, now)) {
                        answer_body(&itx, &bodies, slot, channel, ask);
                    }
                }
                Inner::Waited(true, ticket) => {
                    if let Some((channel, _)) = st.listings_slots.expire(ticket) {
                        refuse_listings(&mut swarm, &mut st, channel, budget::BUSY);
                    }
                }
                Inner::Waited(false, ticket) => {
                    if let Some((channel, _)) = st.body_slots.expire(ticket) {
                        refuse_body(&mut swarm, &mut st, channel, budget::BUSY);
                    }
                }
                Inner::Tower(channel, answer) => {
                    st.tower.answered();
                    let _ = swarm.behaviour_mut().tower.send_response(channel, answer);
                }
                Inner::Vouched(id, from, source, change, s) => vouched(&mut swarm, &mut st, id, from, source, change, s),
            },
            event = swarm.select_next_some() => match event {
                SwarmEvent::Behaviour(BehaviourEvent::Tower(e)) => {
                    let itx = itx.clone();
                    tower::event(&mut swarm.behaviour_mut().tower, &mut st.tower, &towers, move |c, a| { let _ = itx.send(Inner::Tower(c, a)); }, e);
                }
                event => event_of(&mut swarm, &mut st, &registry, &listings, &bodies, &itx, event),
            },
        }
    }
}

/// Carries out a command; false once the swarm is to end.
fn command(swarm: &mut Swarm<Behaviour>, st: &mut State, cmd: Cmd) -> bool {
    let kad = &mut swarm.behaviour_mut().kad;
    match cmd {
        Cmd::Provide(_, reply) if st.stopping => {
            let _ = reply.send(Err("the node is leaving the network".into()));
        }
        Cmd::Provide(key, reply) => match kad.start_providing(key) {
            Ok(q) => {
                st.load.announced += 1;
                st.providing.insert(q, reply);
            }
            Err(e) => {
                let _ = reply.send(Err(e.to_string()));
            }
        },
        Cmd::StopProviding(key) => kad.stop_providing(&key),
        Cmd::Providers(key, reply) => {
            let q = kad.get_providers(key);
            st.finding.insert(q, (HashSet::new(), reply));
        }
        Cmd::Locate(peer, reply) => {
            let q = kad.get_closest_peers(peer);
            st.locating.insert(q, (peer, reply));
        }
        Cmd::Admit(peer, addrs, reply) => admit_now(swarm, st, peer, addrs, reply),
        Cmd::Fetch(peer, site, reply) => {
            let id = swarm.behaviour_mut().listings.send_request(&peer, ListingsAsk { site });
            st.fetching.insert(id, reply);
        }
        Cmd::FetchBody(peer, addrs, ask, reply) => {
            for a in addrs {
                swarm.add_peer_address(peer, a);
            }
            let id = swarm.behaviour_mut().body.send_request(&peer, ask);
            st.fetching_bodies.insert(id, reply);
        }
        Cmd::HandOver(peer, addrs, handed, reply) => {
            for a in addrs {
                swarm.add_peer_address(peer, a);
            }
            let id = swarm.behaviour_mut().tower.send_request(&peer, handed);
            st.tower.handing.insert(id, reply);
        }
        Cmd::Dial(peer, addrs) => {
            let _ = match peer {
                // A connected peer isn't dialled again: AutoNAT takes any failed dial to a peer it is dialling back,
                // a refused one included, as the dial-back failing.
                Some(p) if swarm.is_connected(&p) => Ok(()),
                Some(p) => swarm.dial(DialOpts::peer_id(p).condition(PeerCondition::Disconnected).addresses(addrs).allocate_new_port().build()),
                None => addrs.into_iter().try_for_each(|a| swarm.dial(DialOpts::unknown_peer_id().address(a).allocate_new_port().build())),
            };
        }
        Cmd::Table(reply) => {
            let _ = reply.send(table_of(swarm));
        }
        Cmd::Listening(reply) => {
            let _ = reply.send(swarm.listeners().cloned().collect());
        }
        Cmd::Published(reply) => {
            let listening: Vec<Multiaddr> = swarm.listeners().cloned().collect();
            let addrs = if st.announce_listen {
                st.announce.iter().chain(&listening).cloned().fold(Vec::new(), |mut out, a| {
                    if !out.contains(&a) {
                        out.push(a);
                    }
                    out
                })
            } else {
                let confirmed: Vec<Multiaddr> = swarm.external_addresses().cloned().collect();
                reach::published(&st.announce, &confirmed, &listening)
            };
            let _ = reply.send(addrs);
        }
        Cmd::Bootstrap => {
            let _ = swarm.behaviour_mut().kad.bootstrap();
        }
        Cmd::Save => {
            if let Some(path) = st.saved.clone() {
                save_table(&path, &table_of(swarm));
            }
        }
        Cmd::Live(peers, reply) => {
            let _ = reply.send(peers.into_iter().map(|p| (p, st.live(swarm, &p))).collect());
        }
        Cmd::Connect(peer, addrs, reply) => {
            if swarm.is_connected(&peer) {
                let _ = reply.send(Reached::Yes);
                return true;
            }
            let waiting = st.connecting.entry(peer).or_default();
            waiting.retain(|w| !w.is_closed());
            waiting.push(reply);
            let dial = DialOpts::peer_id(peer).condition(PeerCondition::DisconnectedAndNotDialing).addresses(addrs).extend_addresses_through_behaviour().allocate_new_port().build();
            match swarm.dial(dial) {
                // Already being dialled: the dial under way answers.
                Ok(()) | Err(libp2p::swarm::DialError::DialPeerConditionFalse(_)) => {}
                Err(libp2p::swarm::DialError::NoAddresses) => st.reached(&peer, Reached::NoAddress),
                Err(_) => st.reached(&peer, Reached::No),
            }
        }
        Cmd::Recorded(key, reply) => {
            let q = swarm.behaviour_mut().kad.get_providers(key);
            st.finding.insert(q, (HashSet::new(), reply));
        }
        Cmd::Leave(reply) => leave(swarm, st, reply),
        Cmd::Halt(save, reply) => {
            if save {
                if let Some(path) = st.saved.clone() {
                    save_table(&path, &table_of(swarm));
                }
            }
            let _ = reply.send(());
            return false;
        }
        Cmd::Load(reply) => {
            let _ = reply.send(Load { refused_kad: st.kad_gate.refused(), ..st.load });
        }
        Cmd::Watch(sites, reply) => {
            let want: HashSet<String> = sites.into_iter().collect();
            let gossip = &mut swarm.behaviour_mut().gossip;
            for gone in st.watched.difference(&want) {
                for v in &st.notices {
                    gossip.unsubscribe(&changes::topic_of(gone, *v));
                }
            }
            let mut new = Vec::new();
            for site in want.difference(&st.watched) {
                let mut on = false;
                for v in &st.notices {
                    let topic = changes::topic_of(site, *v);
                    if gossip.subscribe(&topic).is_ok() {
                        let _ = gossip.set_topic_params(topic, changes::topic_score());
                        on = true;
                    }
                }
                if on {
                    new.push(site.clone());
                }
            }
            st.watched = want;
            let _ = reply.send(new);
        }
        Cmd::Publish(change, reply) => {
            // On every version's topic the node speaks: a watcher of the release before hears it on the old one, and
            // one of the release after on the new. It is sent once it reaches a watcher on either.
            let sent = serde_json::to_vec(&change).map_err(|e| e.to_string()).and_then(|bytes| {
                let tried: Vec<Result<(), String>> = st
                    .notices
                    .iter()
                    .map(|v| {
                        swarm.behaviour_mut().gossip.publish(changes::topic_of(&change.site, *v), bytes.clone()).map(|_| ()).map_err(|e| match e {
                            gossipsub::PublishError::NoPeersSubscribedToTopic => "no node that watches the site is connected".to_string(),
                            e => e.to_string(),
                        })
                    })
                    .collect();
                match tried.iter().find_map(|t| t.as_ref().err()) {
                    Some(e) if !tried.iter().any(Result::is_ok) => Err(e.clone()),
                    _ => Ok(()),
                }
            });
            let _ = reply.send(sent);
        }
        Cmd::Lonely(reply) => {
            let gossip = &swarm.behaviour_mut().gossip;
            let lonely = st.watched.iter().filter(|site| watchers_of(gossip, site, &st.notices).is_empty()).cloned().collect();
            let _ = reply.send(lonely);
        }
        Cmd::Watchers(site, reply) => {
            let _ = reply.send(watchers_of(&swarm.behaviour_mut().gossip, &site, &st.notices));
        }
    }
    true
}

/// The bytes a leaving notice signs: who leaves, whom it tells, and when, after `LEAVING_DOMAIN`.
fn leaving_bytes(from: &PeerId, to: &PeerId, at: u64) -> Vec<u8> {
    [LEAVING_DOMAIN, &from.to_bytes(), &to.to_bytes(), &at.to_be_bytes()].concat()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The notice `key`'s node sends `to` when it leaves, at `at`.
fn leaving_notice(key: &Keypair, to: &PeerId, at: u64) -> Option<Leaving> {
    let me = key.public().to_peer_id();
    let sig = key.sign(&leaving_bytes(&me, to, at)).ok()?;
    Some(Leaving { key: key.public().encode_protobuf(), to: to.to_string(), at, sig })
}

/// Whether `notice`, which `from` sent this node `me` at `now`, is `from` saying it is leaving: its key is `from`'s,
/// it is addressed to `me`, its time is within `LEAVING_SKEW` of `now`, and `from`'s key signed it. Anything else is
/// a goodbye nobody can vouch for, and changes nothing.
fn goodbye_from(notice: &Leaving, from: &PeerId, me: &PeerId, now: u64) -> bool {
    let Ok(key) = PublicKey::try_decode_protobuf(&notice.key) else { return false };
    key.to_peer_id() == *from
        && notice.to.parse::<PeerId>().is_ok_and(|to| to == *me)
        && notice.at.abs_diff(now) <= LEAVING_SKEW
        && key.verify(&leaving_bytes(from, me, notice.at), &notice.sig)
}

/// Leaves: withdraws every record this node provides, so the table announces none again, and tells every peer that
/// counts and was connected within a record's life, connected ones first, that it is leaving. Those are the peers that
/// may hold its records: a record is announced to peers met then, and lasts `provider_ttl`. `reply` hears how many
/// answered, once all have or failed; `Net::stop` waits for it no longer than `goodbye_within`.
fn leave(swarm: &mut Swarm<Behaviour>, st: &mut State, reply: oneshot::Sender<usize>) {
    st.stopping = true;
    let kad = &mut swarm.behaviour_mut().kad;
    let provided: Vec<RecordKey> = kad.store_mut().provided().map(|r| r.key.clone()).collect();
    for key in provided {
        kad.stop_providing(&key);
    }
    let mut told: Vec<(Live, PeerId)> = st
        .admitted
        .keys()
        .filter(|p| matches!(st.standing(p), Some(Standing::Counts(_))))
        .map(|p| (st.live(swarm, p), *p))
        .filter(|(live, _)| *live != Live::Unknown)
        .collect();
    told.sort();
    told.truncate(MAX_GOODBYES);
    let at = unix_now();
    for (_, peer) in told {
        let Some(notice) = leaving_notice(&st.key, &peer, at) else { continue };
        st.goodbyes.insert(swarm.behaviour_mut().leaving.send_request(&peer, notice));
    }
    st.heard_goodbye = 0;
    if st.goodbyes.is_empty() {
        let _ = reply.send(0);
    } else {
        st.leave = Some(reply);
    }
}

/// A goodbye this node sent was answered, or failed.
fn goodbye_answered(st: &mut State, id: OutboundRequestId, heard: bool) {
    if st.goodbyes.remove(&id) {
        st.heard_goodbye += usize::from(heard);
        if st.goodbyes.is_empty() {
            if let Some(reply) = st.leave.take() {
                let _ = reply.send(st.heard_goodbye);
            }
        }
    }
}

/// `peer` said, and signed, that it is leaving. Every provider record this node holds for it goes, for every key, and
/// it leaves the routing table and its admission: no lookup finds it here, and none counts it, until it connects anew
/// and is admitted again.
fn said_goodbye(swarm: &mut Swarm<Behaviour>, st: &mut State, peer: PeerId) {
    st.left.insert(peer, Instant::now());
    st.admitted.remove(&peer);
    recount(swarm, st, &peer);
    st.asking.remove(&peer);
    st.held.remove(&peer);
    st.probing.remove(&peer);
    st.last_seen.remove(&peer);
    st.routable.remove(&peer);
    swarm.behaviour_mut().kad.remove_peer(&peer);
    drop_records(swarm, st, &peer);
    st.tell(&peer, Standing::Unreachable);
    st.reached(&peer, Reached::No);
    relay_through(swarm, st);
}

/// Keeps a provider record of a peer that counts, noting its key under the peer.
fn keep_record(swarm: &mut Swarm<Behaviour>, st: &mut State, rec: ProviderRecord) {
    let (peer, key) = (rec.provider, rec.key.clone());
    if swarm.behaviour_mut().kad.store_mut().add_provider(rec).is_ok() {
        st.recorded.entry(peer).or_default().insert(key);
    }
}

/// Pings every peer in the routing table that has been silent `check_after`, dialling it if it isn't connected, and
/// drops one that hasn't answered within `check_wait` (`evict`). The table itself never drops a peer that stopped
/// answering: kad keeps a peer's last address and drops a peer only for one waiting to enter a full bucket, which
/// with peers added by hand never happens. Also forgets, past a record's life, what no record can still need.
fn check_table(swarm: &mut Swarm<Behaviour>, st: &mut State) {
    let now = Instant::now();
    for (peer, _) in table_of(swarm) {
        if let Some(since) = st.probing.get(&peer) {
            if now.saturating_duration_since(*since) >= st.check_wait {
                evict(swarm, st, peer);
            }
            continue;
        }
        if st.last_seen.get(&peer).is_some_and(|t| now.saturating_duration_since(*t) < st.check_after) {
            continue;
        }
        st.probing.insert(peer, now);
        // A connected peer's ping comes round on its connection; one not connected is pinged as the dial opens.
        if !swarm.is_connected(&peer) {
            let _ = swarm.dial(DialOpts::peer_id(peer).condition(PeerCondition::DisconnectedAndNotDialing).allocate_new_port().build());
        }
    }
    let connected: HashSet<PeerId> = swarm.connected_peers().copied().collect();
    forget_standing(&mut st.refused, &mut st.unlisted, &mut st.unread, &connected, now);
    let ttl = st.provider_ttl;
    st.left.retain(|_, at| now.saturating_duration_since(*at) < ttl);
    st.last_seen.retain(|p, at| connected.contains(p) || now.saturating_duration_since(*at) < ttl);
    let kad = &mut swarm.behaviour_mut().kad;
    st.recorded.retain(|peer, keys| {
        keys.retain(|k| kad.store_mut().providers(k).iter().any(|r| r.provider == *peer && !r.is_expired(now)));
        !keys.is_empty()
    });
}

/// Forgets what no longer says anything of a peer: a refusal past its own wait reads as no refusal already, and what is
/// counted while a peer is connected (`unlisted`, `unread`) is counted afresh when it comes back. A node meets peers for
/// as long as it runs, so kept for good these only grow.
fn forget_standing(refused: &mut HashMap<PeerId, (Instant, Duration)>, unlisted: &mut HashMap<PeerId, u32>, unread: &mut HashMap<PeerId, u32>, connected: &HashSet<PeerId>, now: Instant) {
    refused.retain(|_, (at, wait)| now.saturating_duration_since(*at) < *wait);
    unlisted.retain(|p, _| connected.contains(p));
    unread.retain(|p, _| connected.contains(p));
}

/// Takes every provider record this node holds for `peer` out of its store.
fn drop_records(swarm: &mut Swarm<Behaviour>, st: &mut State, peer: &PeerId) {
    let kad = &mut swarm.behaviour_mut().kad;
    for key in st.recorded.remove(peer).unwrap_or_default() {
        kad.store_mut().remove_provider(&key, peer);
    }
}

/// A peer in the table that didn't answer a ping: out of the table and its admission, its connection, if any, closed.
/// It is judged again when it is next met.
fn evict(swarm: &mut Swarm<Behaviour>, st: &mut State, peer: PeerId) {
    st.probing.remove(&peer);
    st.admitted.remove(&peer);
    recount(swarm, st, &peer);
    swarm.behaviour_mut().kad.remove_peer(&peer);
    if swarm.is_connected(&peer) {
        let _ = swarm.disconnect_peer_id(peer);
    }
}

fn table_of(swarm: &mut Swarm<Behaviour>) -> Vec<(PeerId, Vec<Multiaddr>)> {
    let mut out = Vec::new();
    for bucket in swarm.behaviour_mut().kad.kbuckets() {
        for e in bucket.iter() {
            out.push((*e.node.key.preimage(), e.node.value.iter().cloned().collect()));
        }
    }
    out
}

fn judged(swarm: &mut Swarm<Behaviour>, st: &mut State, itx: &mpsc::UnboundedSender<Inner>, peer: PeerId, claim: Claim, verdict: Result<(), Refusal>) {
    st.asking.remove(&peer);
    #[allow(unused_variables)]
    let retried = st.unread.remove(&peer).is_some();
    // A verdict read before Identify said the peer is too old lands after it: the version wins.
    let verdict = if st.too_old.contains(&peer) { verdict.and(Err(Refusal::TooOld)) } else { verdict };
    match verdict {
        Ok(()) => {
            sut_always!(!st.too_old.contains(&peer), "an admission never lands for a peer already seen too old", &serde_json::json!({ "peer": peer.to_string() }));
            // Admission recovers after a registry stall: a peer whose read failed is judged once the registry answers.
            sut_sometimes!(retried, "a peer was admitted after a registry read for it had failed", &serde_json::json!({ "peer": peer.to_string() }));
            let new = st.admitted.insert(peer, (claim.identity.clone(), Instant::now())).is_none();
            #[allow(unused_variables)]
            let was_unlisted = st.unlisted.remove(&peer).is_some();
            sut_sometimes!(was_unlisted, "a peer turned away as not listed was admitted once the registry listed it", &serde_json::json!({ "peer": peer.to_string() }));
            st.refused.remove(&peer);
            into_table(swarm, st, &peer);
            // What it announced while unjudged, or while not listed yet, is kept now that it counts.
            for rec in st.held.remove(&peer).unwrap_or_default() {
                keep_record(swarm, st, rec);
            }
            st.tell(&peer, Standing::Counts(claim.identity));
            recount(swarm, st, &peer);
            relay_through(swarm, st);
            // A peer this node hadn't counted may have dropped what it announced before: in a small table it may
            // be one of the few the records belong on, so they go out again.
            if new && !st.reannouncing && table_of(swarm).len() < st.k {
                st.reannouncing = true;
                later(itx, REANNOUNCE_AFTER, Inner::Reannounce);
            }
        }
        // The registry doesn't list it under that identity: maybe not yet. It is turned away for a short while and
        // asked again while connected; what it announces meanwhile is held, within the bounds, not dropped.
        Err(Refusal::Unregistered | Refusal::NotItsNode) => {
            let tries = st.unlisted.entry(peer).or_insert(0);
            *tries += 1;
            let wait = UNLISTED_RETRY.saturating_mul(1 << (*tries - 1).min(16)).min(UNLISTED_RETRY_MAX);
            st.refused.insert(peer, (Instant::now(), wait));
            st.admitted.remove(&peer);
            recount(swarm, st, &peer);
            swarm.behaviour_mut().kad.remove_peer(&peer);
            st.tell(&peer, Standing::Refused);
            later(itx, wait, Inner::AskAgain(peer));
        }
        Err(_) => {
            st.refused.insert(peer, (Instant::now(), st.refusal_ttl));
            st.unlisted.remove(&peer);
            st.admitted.remove(&peer);
            st.held.remove(&peer);
            recount(swarm, st, &peer);
            swarm.behaviour_mut().kad.remove_peer(&peer);
            // A refused peer's provider records are dropped: it may have counted when it announced them.
            drop_records(swarm, st, &peer);
            st.tell(&peer, Standing::Refused);
        }
    }
}

/// Sends `what` to the swarm's loop after `wait`.
fn later(itx: &mpsc::UnboundedSender<Inner>, wait: Duration, what: Inner) {
    let itx = itx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(wait).await;
        let _ = itx.send(what);
    });
}

/// The connected peers gossipsub knows watch `site`, on any version's topic the node speaks.
fn watchers_of(gossip: &gossipsub::Behaviour, site: &str, versions: &[u32]) -> Vec<PeerId> {
    let hashes: Vec<_> = versions.iter().map(|v| changes::topic_of(site, *v).hash()).collect();
    gossip.all_peers().filter(|(_, topics)| hashes.iter().any(|h| topics.contains(&h))).map(|(p, _)| *p).collect()
}

/// A notice came, from `source` by way of `from`. It is read only if it reads (`Change::read`) and its source is within
/// its rate and counts; then it is forwarded and handed to the node. One that doesn't read, or whose source the
/// registry refused, is rejected, which lowers the forwarder's score; one past its source's rate is ignored. A source
/// not yet judged is judged first, and the notice waits for the verdict, at most `JUDGE_WAIT`.
fn heard_change(swarm: &mut Swarm<Behaviour>, st: &mut State, itx: &mpsc::UnboundedSender<Inner>, from: PeerId, id: MessageId, message: gossipsub::Message) {
    let Some((change, source)) = Change::read(&message.data, &message.topic, unix_now()).zip(message.source) else {
        swarm.behaviour_mut().gossip.report_message_validation_result(&id, &from, MessageAcceptance::Reject);
        return;
    };
    if !st.change_rate.take(source, Instant::now()) {
        swarm.behaviour_mut().gossip.report_message_validation_result(&id, &from, MessageAcceptance::Ignore);
        return;
    }
    match st.standing(&source) {
        Some(s @ (Standing::Counts(_) | Standing::Refused | Standing::Unreachable)) => vouched(swarm, st, id, from, source, change, s),
        None => {
            let (reply, verdict) = oneshot::channel();
            admit_now(swarm, st, source, vec![], reply);
            let itx = itx.clone();
            tokio::spawn(async move {
                let s = tokio::time::timeout(changes::JUDGE_WAIT, verdict).await.ok().and_then(Result::ok).unwrap_or(Standing::Unreachable);
                let _ = itx.send(Inner::Vouched(id, from, source, change, s));
            });
        }
    }
}

/// What a notice's source stands as decides it: read, forwarded and handed to the node when the source counts; rejected
/// when the registry refused it; ignored when it couldn't be judged or said it is leaving.
fn vouched(swarm: &mut Swarm<Behaviour>, st: &mut State, id: MessageId, from: PeerId, source: PeerId, change: Change, s: Standing) {
    let acceptance = match s {
        Standing::Counts(identity) => {
            // Full: the notice is dropped, and the node reads the chain on its own schedule anyway.
            let _ = st.heard.try_send(Heard { change, from: source, identity });
            MessageAcceptance::Accept
        }
        Standing::Refused => MessageAcceptance::Reject,
        Standing::Unreachable => MessageAcceptance::Ignore,
    };
    swarm.behaviour_mut().gossip.report_message_validation_result(&id, &from, acceptance);
}

/// Makes a listings answer in `slot`. One that takes longer than a body's is given up, as the body's is: the slot goes
/// back either way (`Answering`).
fn answer_listings<L: Listings>(itx: &mpsc::UnboundedSender<Inner>, listings: &Arc<L>, slot: Slot, channel: ResponseChannel<ListingsAnswer>, ask: ListingsAsk) {
    let (listings, answering) = (listings.clone(), Answering { itx: itx.clone(), channel: Some(channel), slot });
    tokio::spawn(async move {
        let ls = tokio::time::timeout(SERVE_TIMEOUT, listings.site(&ask.site)).await.ok();
        answering.answer(ls);
    });
}

/// Makes a body answer in `slot`, from what the node's store says of the ask.
fn answer_body<B: Bodies>(itx: &mpsc::UnboundedSender<Inner>, bodies: &Arc<B>, slot: Slot, channel: ResponseChannel<BodyAnswer>, ask: BodyAsk) {
    let (bodies, serving) = (bodies.clone(), ServingBody { itx: itx.clone(), channel: Some(channel), slot });
    tokio::spawn(async move {
        let served = tokio::time::timeout(SERVE_TIMEOUT, bodies.serve(slot.peer, &ask.content_id, &ask.payment))
            .await
            .unwrap_or_else(|_| Err("the node didn't find the body in time".into()));
        serving.answer(BodyAnswer::of(served));
    });
}

/// Refuses a listings ask at once, saying why.
fn refuse_listings(swarm: &mut Swarm<Behaviour>, st: &mut State, channel: ResponseChannel<ListingsAnswer>, why: &str) {
    st.load.refused_listings += 1;
    let answer = ListingsAnswer { listings: vec![], refused: Some(why.to_string()) };
    let _ = swarm.behaviour_mut().listings.send_response(channel, answer);
}

/// Refuses a body ask at once, saying why.
fn refuse_body(swarm: &mut Swarm<Behaviour>, st: &mut State, channel: ResponseChannel<BodyAnswer>, why: &str) {
    st.load.refused_bodies += 1;
    let _ = swarm.behaviour_mut().body.send_response(channel, BodyAnswer::refused(why));
}

/// Announces again every record this node provides, a site's or a body's, to the peers closest to its key now.
fn reannounce(swarm: &mut Swarm<Behaviour>, st: &mut State) {
    let kad = &mut swarm.behaviour_mut().kad;
    let keys: Vec<RecordKey> = kad.store_mut().provided().map(|r| r.key.clone()).collect();
    for key in keys {
        if kad.start_providing(key).is_ok() {
            st.load.announced += 1;
        }
    }
}

/// The registry couldn't say who a peer is. The peer isn't judged on that: anyone waiting hears it can't be reached now,
/// and it is asked again after a wait that doubles each time in a row, so a registry that is back takes it at once.
fn unread(st: &mut State, itx: &mpsc::UnboundedSender<Inner>, peer: PeerId) {
    st.asking.remove(&peer);
    st.tell(&peer, Standing::Unreachable);
    let tries = st.unread.entry(peer).or_insert(0);
    *tries += 1;
    let wait = UNREAD_RETRY.saturating_mul(1 << (*tries - 1).min(16)).min(UNREAD_RETRY_MAX);
    later(itx, wait, Inner::AskAgain(peer));
}

fn event_of<R: Registry, L: Listings, B: Bodies>(
    swarm: &mut Swarm<Behaviour>,
    st: &mut State,
    registry: &Arc<R>,
    listings: &Arc<L>,
    bodies: &Arc<B>,
    itx: &mpsc::UnboundedSender<Inner>,
    event: SwarmEvent<BehaviourEvent>,
) {
    match event {
        SwarmEvent::NewListenAddr { address, .. } => {
            if st.announce_listen {
                swarm.add_external_address(address);
            }
        }
        SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
            st.last_seen.insert(peer_id, Instant::now());
            st.sources.entry(peer_id).or_insert_with(|| Source::of(&endpoint));
            // A peer that said it was leaving and opens a connection after it said so is back, and is judged afresh
            // like any peer met. Its old connections may not have closed yet: a node that stops and starts again at
            // once can connect before this node has noticed the old connections end, and waiting for them to go
            // would leave it turned away for a record's life.
            st.left.remove(&peer_id);
            st.reached(&peer_id, Reached::Yes);
            recount(swarm, st, &peer_id);
            if st.standing(&peer_id).is_none() {
                ask_who(swarm, st, peer_id);
            }
        }
        // A peer gone before it was judged takes the records held for it. A relay is one only while connected.
        // Nor is it being asked any more: it is asked again when it is next met.
        SwarmEvent::ConnectionClosed { peer_id, num_established: 0, .. } => {
            if !st.left.contains_key(&peer_id) {
                st.last_seen.insert(peer_id, Instant::now());
            }
            st.hop.remove(&peer_id);
            st.asking.remove(&peer_id);
            st.lookups.gone(&peer_id);
            st.sources.remove(&peer_id);
            if st.standing(&peer_id).is_none() || st.unlisted.contains_key(&peer_id) {
                st.held.remove(&peer_id);
            }
            if st.standing(&peer_id).is_none() {
                st.tell(&peer_id, Standing::Unreachable);
            }
        }
        SwarmEvent::OutgoingConnectionError { peer_id: Some(peer), error, .. } => {
            if !swarm.is_connected(&peer) {
                if !st.asking.contains(&peer) {
                    st.tell(&peer, Standing::Unreachable);
                }
                st.reached(&peer, if matches!(error, libp2p::swarm::DialError::NoAddresses) { Reached::NoAddress } else { Reached::No });
                // A silent peer pinged for it that can't be dialled hasn't answered.
                if st.probing.contains_key(&peer) {
                    evict(swarm, st, peer);
                }
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Ping(ping::Event { peer, result, .. })) => match result {
            Ok(_) => {
                st.last_seen.insert(peer, Instant::now());
                st.probing.remove(&peer);
            }
            // A release without ping: its connection opening is the only word on it.
            Err(ping::Failure::Unsupported) => {
                st.probing.remove(&peer);
            }
            // No answer on a connection that is open: a peer the table holds, or one admitted, has gone.
            Err(_) => {
                if st.admitted.contains_key(&peer) || st.probing.contains_key(&peer) {
                    evict(swarm, st, peer);
                }
            }
        },
        SwarmEvent::Behaviour(BehaviourEvent::Leaving(request_response::Event::Message { peer, message, .. })) => match message {
            request_response::Message::Request { request, channel, .. } => {
                let me = *swarm.local_peer_id();
                if goodbye_from(&request, &peer, &me, unix_now()) {
                    said_goodbye(swarm, st, peer);
                }
                let _ = swarm.behaviour_mut().leaving.send_response(channel, Left {});
            }
            request_response::Message::Response { request_id, .. } => goodbye_answered(st, request_id, true),
        },
        SwarmEvent::Behaviour(BehaviourEvent::Leaving(request_response::Event::OutboundFailure { request_id, .. })) => {
            goodbye_answered(st, request_id, false);
        }
        SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. })) => {
            // A peer older than the network takes is refused: a change older nodes can't mix with reaches the
            // network as they update, and none stays behind on it.
            // It wins over an admission it had, and over one still being read for it.
            if too_old(&info.agent_version, st.min_peer.as_ref()) {
                st.too_old.insert(peer_id);
                st.admitted.remove(&peer_id);
                recount(swarm, st, &peer_id);
                st.asking.remove(&peer_id);
                st.held.remove(&peer_id);
                st.unlisted.remove(&peer_id);
                st.refused.insert(peer_id, (Instant::now(), st.refusal_ttl));
                st.routable.remove(&peer_id);
                swarm.behaviour_mut().kad.remove_peer(&peer_id);
                drop_records(swarm, st, &peer_id);
                st.tell(&peer_id, Standing::Refused);
                let _ = swarm.disconnect_peer_id(peer_id);
            } else {
                // A peer refused for its version that comes back new enough is judged again.
                if st.too_old.remove(&peer_id) {
                    st.refused.remove(&peer_id);
                    ask_who(swarm, st, peer_id);
                }
                // A peer's loopback address is this machine, not the peer, unless the network shares one machine.
                let addrs: Vec<Multiaddr> =
                    info.listen_addrs.into_iter().filter(|a| st.announce_listen || reach::dialable(a)).collect();
                if info.protocols.contains(&relay::HOP_PROTOCOL_NAME) {
                    st.hop.insert(peer_id);
                } else {
                    st.hop.remove(&peer_id);
                }
                // Only a peer that serves the table belongs in a routing table; Identify says whether it does. It
                // says again when the peer starts or stops serving.
                if info.protocols.contains(&st.kad_proto) && !addrs.is_empty() {
                    st.routable.insert(peer_id, addrs);
                    if matches!(st.standing(&peer_id), Some(Standing::Counts(_))) {
                        into_table(swarm, st, &peer_id);
                    }
                } else if st.routable.remove(&peer_id).is_some() {
                    swarm.behaviour_mut().kad.remove_peer(&peer_id);
                }
                relay_through(swarm, st);
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Autonat(autonat::Event::StatusChanged { new, .. })) => {
            st.nat = match new {
                autonat::NatStatus::Public(_) => Nat::Public,
                autonat::NatStatus::Private => Nat::Private,
                autonat::NatStatus::Unknown => Nat::Unknown,
            };
            // An address a peer once dialed back that nobody reaches now is no longer published. A relayed address
            // goes with its reservation, and one the owner named stays.
            if st.nat != Nat::Public && !st.announce_listen {
                let stale: Vec<Multiaddr> = swarm
                    .external_addresses()
                    .filter(|a| !st.announce.contains(a) && !a.iter().any(|p| p == Protocol::P2pCircuit))
                    .cloned()
                    .collect();
                for a in stale {
                    swarm.remove_external_address(&a);
                }
            }
            serve_as(swarm, st);
            relay_through(swarm, st);
        }
        SwarmEvent::ListenerClosed { listener_id, .. } => {
            st.relays.retain(|_, l| *l != listener_id);
            // A reservation that ended (its relay went, or stopped holding it) is replaced now: nothing else may happen
            // to ask for a while, and the relayed address went with it.
            if !st.stopping {
                relay_through(swarm, st);
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Hello(request_response::Event::Message { peer, message, .. })) => match message {
            request_response::Message::Request { channel, .. } => {
                let _ = swarm.behaviour_mut().hello.send_response(channel, st.claim.clone());
            }
            // The registry read is bounded: one that hangs, or fails, leaves the peer unjudged (`unread`), never stuck
            // as being asked nor refused as unregistered.
            request_response::Message::Response { response: claim, .. } => {
                // At most REGISTRY_LOOKUPS reads at once, however many peers say hello, and one per peer: a hello waits
                // its turn, by where it came from and then in the order it came (`Lookups`). Past LOOKUPS_WAITING
                // waiting, or SOURCE_WAITING from its source, it is left unjudged, never admitted, and asked again
                // later, as one whose read failed is.
                let source = st.sources.get(&peer).copied().unwrap_or(Source::Unplaced);
                if st.lookups.offer(peer, source, claim) == Offer::Full {
                    let _ = itx.send(Inner::Unread(peer));
                    return;
                }
                start_lookups(swarm, st, registry, itx);
            }
        },
        SwarmEvent::Behaviour(BehaviourEvent::Hello(request_response::Event::OutboundFailure { peer, .. })) => {
            // Still connected (the ask went out on a connection that closed, or timed out): no word on the peer, so
            // it is asked again later, as one whose identity couldn't be read is. Nothing else would ask it while
            // the connection stands. A peer next in line that doesn't answer when asked again gives its place up: a
            // place is held by coming back, never by staying connected and silent.
            st.asking.remove(&peer);
            st.lookups.gone(&peer);
            st.tell(&peer, Standing::Unreachable);
            if swarm.is_connected(&peer) {
                later(itx, UNREAD_RETRY, Inner::AskAgain(peer));
            } else {
                // Never judged, so nothing it sent is kept.
                st.held.remove(&peer);
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Listings(request_response::Event::Message { peer, message, .. })) => match message {
            request_response::Message::Request { request, channel, .. } => {
                // A peer past its budget, or one asking while every slot it may take is busy and as many wait as may,
                // hears so at once, and may ask another provider.
                let now = Instant::now();
                if !st.listings_budget.take(peer, st.counts(&peer), now) {
                    refuse_listings(swarm, st, channel, "too many asks from this peer; ask again later");
                    return;
                }
                let payers = &st.payers;
                match st.listings_slots.ask(peer, (channel, request), now, |p| payers.rank(p, now)) {
                    Asked::Now(slot, (channel, ask)) => answer_listings(itx, listings, slot, channel, ask),
                    Asked::Waiting(ticket, out) => {
                        later(itx, SLOT_WAIT, Inner::Waited(true, ticket));
                        if let Some((channel, _)) = out {
                            refuse_listings(swarm, st, channel, budget::BUSY);
                        }
                    }
                    Asked::Refused((channel, _), why) => refuse_listings(swarm, st, channel, why),
                }
                debug_assert!(st.listings_slots.busy() <= st.slot_count, "listings answers in flight never exceed their slots");
                sut_always_less_than_or_equal_to!(st.listings_slots.busy(), st.slot_count, "listings answers in flight never exceed their slots");
            }
            request_response::Message::Response { request_id, response } => {
                if let Some(reply) = st.fetching.remove(&request_id) {
                    let _ = reply.send(match response.refused {
                        Some(why) => Err(format!("the provider refused: {why}")),
                        None => Ok(response.listings),
                    });
                }
            }
        },
        SwarmEvent::Behaviour(BehaviourEvent::Listings(request_response::Event::OutboundFailure { request_id, error, .. })) => {
            if let Some(reply) = st.fetching.remove(&request_id) {
                let _ = reply.send(Err(error.to_string()));
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Body(request_response::Event::Message { peer, message, .. })) => match message {
            request_response::Message::Request { request, channel, .. } => {
                // A peer past its rate, or one asking while every slot it may take is busy and as many wait as may,
                // hears so at once: a refusal costs a byte and tells the caller to try another provider.
                let now = Instant::now();
                if !st.bodies_budget.take(peer, st.counts(&peer), now) {
                    refuse_body(swarm, st, channel, "too many asks from this peer; ask again later");
                    return;
                }
                let payers = &st.payers;
                match st.body_slots.ask(peer, (channel, request), now, |p| payers.rank(p, now)) {
                    Asked::Now(slot, (channel, ask)) => answer_body(itx, bodies, slot, channel, ask),
                    Asked::Waiting(ticket, out) => {
                        later(itx, SLOT_WAIT, Inner::Waited(false, ticket));
                        if let Some((channel, _)) = out {
                            refuse_body(swarm, st, channel, budget::BUSY);
                        }
                    }
                    Asked::Refused((channel, _), why) => refuse_body(swarm, st, channel, why),
                }
            }
            request_response::Message::Response { request_id, response } => {
                if let Some(reply) = st.fetching_bodies.remove(&request_id) {
                    let _ = reply.send(Ok(response));
                }
            }
        },
        SwarmEvent::Behaviour(BehaviourEvent::Body(request_response::Event::OutboundFailure { request_id, error, .. })) => {
            if let Some(reply) = st.fetching_bodies.remove(&request_id) {
                let _ = reply.send(Err(error));
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Kad(e)) => kad_event(swarm, st, itx, e),
        SwarmEvent::Behaviour(BehaviourEvent::Gossip(gossipsub::Event::Message { propagation_source, message_id, message })) => {
            heard_change(swarm, st, itx, propagation_source, message_id, message)
        }
        _ => {}
    }
}

fn kad_event(swarm: &mut Swarm<Behaviour>, st: &mut State, itx: &mpsc::UnboundedSender<Inner>, e: kad::Event) {
    match e {
        kad::Event::InboundRequest { request: kad::InboundRequest::AddProvider { record: Some(rec) } } => {
            st.load.add_provider += 1;
            let peer = rec.provider;
            match st.standing(&peer) {
                Some(Standing::Counts(_)) => keep_record(swarm, st, rec),
                // Not listed yet: held, kept if the registry lists it when it is asked again.
                Some(Standing::Refused) if st.unlisted.contains_key(&peer) => hold(&mut st.held, peer, rec),
                Some(_) => {}
                None => {
                    hold(&mut st.held, peer, rec);
                    if swarm.is_connected(&peer) {
                        ask_who(swarm, st, peer);
                    }
                }
            }
        }
        // The table met a peer it doesn't hold (a lookup's answer, a request over a connection). Inserts are by hand,
        // so it holds only peers that count; one that already counts belongs in it, wherever it was left out.
        kad::Event::RoutablePeer { peer, .. } | kad::Event::PendingRoutablePeer { peer, .. } | kad::Event::UnroutablePeer { peer } => {
            if matches!(st.standing(&peer), Some(Standing::Counts(_))) {
                sut_reachable!("a peer that counts and was missing from the table was put back", &serde_json::json!({ "peer": peer.to_string() }));
                into_table(swarm, st, &peer);
            }
        }
        kad::Event::InboundRequest { request: kad::InboundRequest::FindNode { .. } } => st.load.find_node += 1,
        kad::Event::InboundRequest { request: kad::InboundRequest::GetProvider { .. } } => st.load.get_providers += 1,
        kad::Event::OutboundQueryProgressed { result: QueryResult::RepublishProvider(_), .. } => st.load.announced += 1,
        kad::Event::OutboundQueryProgressed { id, result, step, .. } => match result {
            QueryResult::StartProviding(r) => {
                if let Some(reply) = st.providing.remove(&id) {
                    let _ = reply.send(r.map(|_| ()).map_err(|e| e.to_string()));
                }
            }
            QueryResult::GetProviders(r) => {
                let done = match r {
                    Ok(GetProvidersOk::FoundProviders { providers, .. }) => match st.finding.get_mut(&id) {
                        // Enough providers ends the lookup: the answering peers can name more, never make it take them.
                        Some((found, _)) => {
                            // The table's answer waits on each peer it asks for up to kad's own peer timeout, ten
                            // seconds, and a peer that has gone never answers. Once some providers are known the rest
                            // are waited for a connect timeout, no longer: a live peer answers in far less.
                            if found.is_empty() && !providers.is_empty() {
                                later(itx, st.connect_timeout, Inner::Enough(id));
                            }
                            found.extend(providers.into_iter().take(MAX_PROVIDERS.saturating_sub(found.len())));
                            step.last || found.len() >= MAX_PROVIDERS
                        }
                        None => step.last,
                    },
                    _ => true,
                };
                if done {
                    if let Some((found, reply)) = st.finding.remove(&id) {
                        let _ = reply.send(found);
                    }
                    if let Some(mut q) = swarm.behaviour_mut().kad.query_mut(&id) {
                        q.finish();
                    }
                }
            }
            QueryResult::GetClosestPeers(r) => {
                if let Some((target, reply)) = st.locating.remove(&id) {
                    let addrs = r.ok().and_then(|ok| ok.peers.into_iter().find(|p| p.peer_id == target)).map(|p| p.addrs).unwrap_or_default();
                    let _ = reply.send(addrs);
                }
            }
            _ => {}
        },
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A peer that is a source of its own: one connected directly from an address nobody else has used.
    fn alone(_peer: PeerId) -> Source {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0x0a00_0000);
        Source::Ip(std::net::Ipv4Addr::from(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)).into())
    }

    /// The places, and the remembered, a direct connection's hellos have.
    fn direct() -> (usize, usize) {
        alone(PeerId::random()).places()
    }

    /// A hello from a new peer of its own.
    fn fresh(lookups: &mut Lookups) -> Offer {
        let peer = PeerId::random();
        lookups.offer(peer, alone(peer), Claim { identity: "7".into(), index: 0 })
    }

    /// A peer refused because the hello queue was full is next in line: when it says hello again it is served before
    /// every peer that arrived after it was refused, however many keep arriving and however full the queue is. Those
    /// remembered are served in the order they come back, at most their kind's share of NEXT_IN_LINE are remembered, and
    /// one that leaves
    /// gives its place up.
    #[test]
    fn a_peer_refused_at_capacity_is_served_before_newer_arrivals() {
        let claim = || Claim { identity: "7".into(), index: 0 };
        let mut lookups = Lookups::default();
        let (places, remembered) = direct();
        for _ in 0..REGISTRY_LOOKUPS {
            assert_eq!(fresh(&mut lookups), Offer::Waiting);
            assert!(lookups.next(|_, _| true).is_some());
        }
        while lookups.waiting.len() < places {
            assert_eq!(fresh(&mut lookups), Offer::Waiting);
        }
        let (first, honest) = (PeerId::random(), PeerId::random());
        assert_eq!(lookups.offer(first, alone(first), claim()), Offer::Full);
        assert_eq!(lookups.offer(honest, alone(honest), claim()), Offer::Full);
        // Fresh keys keep arriving while the queue is full: each is refused, and none goes ahead of those refused before.
        let churn: Vec<PeerId> = (0..remembered * 2).map(|_| PeerId::random()).collect();
        for p in &churn {
            assert_eq!(lookups.offer(*p, alone(*p), claim()), Offer::Full);
        }
        assert_eq!(lookups.next_in_line.len(), remembered, "the remembered are bounded");
        // The honest peer is asked again before the one refused ahead of it; the newcomers retry too. It still gets a
        // place, past the full queue, ahead of every newcomer.
        assert_eq!(lookups.offer(honest, alone(honest), claim()), Offer::Waiting);
        assert_eq!(fresh(&mut lookups), Offer::Full, "a newcomer is still refused");
        assert_eq!(lookups.offer(churn[remembered - 3], alone(churn[remembered - 3]), claim()), Offer::Waiting, "one remembered after it, waiting behind it");
        assert_eq!(lookups.offer(first, alone(first), claim()), Offer::Waiting);
        assert_eq!(lookups.offer(churn[remembered], alone(churn[remembered]), claim()), Offer::Full, "one refused past the bound wasn't remembered");
        let order: Vec<PeerId> = lookups.waiting.iter().take(3).map(|(p, _, _)| *p).collect();
        assert_eq!(order, vec![honest, churn[remembered - 3], first], "the remembered wait at the front, in the order they came back");
        let ended = *lookups.running.iter().next().unwrap();
        lookups.done(ended);
        assert_eq!(lookups.next(|_, _| true).map(|(p, _, _)| p), Some(honest), "served before every newer arrival");
        assert!(lookups.waiting.len() <= LOOKUPS_WAITING + NEXT_IN_LINE);
        // One that leaves gives its place up, and a peer refused now is remembered in its stead.
        lookups.gone(&churn[0]);
        let late = PeerId::random();
        assert_eq!(lookups.offer(late, alone(late), claim()), Offer::Full);
        assert!(lookups.next_in_line.contains(&(late, false)));
    }

    /// Peers can't have the node read the registry faster than its allowance, however many fresh keys or identity
    /// numbers they name: an identity read lately is answered from that read, and past the burst a read waits its
    /// turn at the steady rate. A failed read is never kept as an answer, and an answer is read afresh once it is old.
    #[test]
    fn peers_cannot_make_the_node_read_the_registry_past_its_rate() {
        let t = Instant::now();
        let mut reads = Reads::new(t);
        let fresh_ids: Vec<Answer> = (0..1000).map(|n| reads.ask(&n.to_string(), alone(PeerId::random()), t)).collect();
        assert_eq!(fresh_ids.iter().filter(|r| matches!(r, Answer::Read)).count(), REGISTRY_READ_BURST as usize, "a burst, then nothing");
        assert!(matches!(reads.ask("7", alone(PeerId::random()), t + Duration::from_millis(500)), Answer::Later));
        assert!(matches!(reads.ask("7", alone(PeerId::random()), t + Duration::from_secs(1)), Answer::Read), "one a second");
        let known = Identity { id: "7".into(), anchor: [1; 32], nodes: vec![] };
        reads.answered("7".into(), Some(known), t + Duration::from_secs(1));
        reads.answered("8".into(), None, t + Duration::from_secs(1));
        // Asked again and again, by any number of peers, an identity read lately costs nothing.
        for _ in 0..100 {
            assert!(matches!(reads.ask("7", alone(PeerId::random()), t + Duration::from_secs(2)), Answer::Known(Some(ref i)) if i.id == "7"));
            assert!(matches!(reads.ask("8", alone(PeerId::random()), t + Duration::from_secs(2)), Answer::Known(None)), "nobody there, lately");
        }
        assert!(matches!(reads.ask("9", alone(PeerId::random()), t + Duration::from_secs(2)), Answer::Read), "the allowance wasn't spent on them");
        // Once old it is read again, so a node an identity just added counts.
        assert!(matches!(reads.ask("7", alone(PeerId::random()), t + Duration::from_secs(1) + REGISTRY_FRESH + Duration::from_secs(5)), Answer::Read));
        // What is remembered is bounded.
        for n in 0..(2 * REGISTRY_REMEMBERED) {
            reads.answered(format!("x{n}"), None, t + Duration::from_secs(30));
        }
        assert!(reads.answers.len() <= REGISTRY_REMEMBERED);
    }

    /// Runs the hello queue against the registry allowance in steps of 100ms for `secs`: each step every attacking
    /// machine (`machines` addresses) offers the hello of one peer that names a fresh identity on every hello and of
    /// as many freshly minted peers as it likes, each naming a fresh identity too; a peer from elsewhere says hello
    /// once at `arrives`. Every read ends at once with nobody there. Returns how long that peer waited to be judged,
    /// the reads the attackers had made, and the identities they named.
    fn churn(machines: u8, arrives: Duration, secs: u64) -> (Option<Duration>, usize, usize) {
        let t0 = Instant::now();
        let mut lookups = Lookups::default();
        let mut reads = Reads::new(t0);
        let attackers: Vec<(PeerId, Source)> = (0..machines).map(|m| (PeerId::random(), Source::Ip(std::net::Ipv4Addr::new(203, 0, 113, m).into()))).collect();
        let honest = PeerId::random();
        let honest_from = Source::Ip(std::net::Ipv4Addr::new(198, 51, 100, 1).into());
        let (mut named, mut attacker_reads, mut waited) = (0usize, 0usize, None);
        let mut now = t0;
        while now < t0 + Duration::from_secs(secs) {
            for (churner, machine) in &attackers {
                for peer in std::iter::once(*churner).chain((0..32).map(|_| PeerId::random())) {
                    named += 1;
                    let _ = lookups.offer(peer, *machine, Claim { identity: format!("{}", 1_000_000 + named), index: 0 });
                }
            }
            if now.duration_since(t0) == arrives {
                assert_eq!(lookups.offer(honest, honest_from, Claim { identity: "42".into(), index: 0 }), Offer::Waiting);
            }
            for (peer, claim, asked) in next_lookups(&mut lookups, &mut reads, now, |_| true) {
                if peer == honest {
                    waited = Some(now.duration_since(t0) - arrives);
                } else if matches!(asked, Answer::Read) {
                    attacker_reads += 1;
                }
                if matches!(asked, Answer::Read) {
                    reads.answered(claim.identity, None, now);
                }
                lookups.done(peer);
            }
            now += Duration::from_millis(100);
        }
        (waited, attacker_reads, named)
    }

    /// One peer naming a thousand fresh identities, alone or with as many keys as it can mint on one machine, takes
    /// its turn and its own share of the registry reads: another peer's single hello is judged within about a second
    /// of saying it, however long the churn has gone on, and the node never reads past its own ceiling.
    #[test]
    fn identity_churn_from_one_peer_does_not_delay_another_peers_admission() {
        let secs = 120;
        let (waited, reads, named) = churn(1, Duration::from_secs(60), secs);
        assert!(named >= 1000, "the churn named {named} identities");
        let waited = waited.expect("the other peer was judged");
        assert!(waited <= Duration::from_millis(1500), "it waited {waited:?}");
        // One machine has its own share, a quarter of the node's steady rate, and the node's ceiling holds.
        assert!(reads as f64 <= SOURCE_READ_BURST + secs as f64 * SOURCE_READS_PER_SECOND + 1.0, "{reads} reads from one machine");
        assert!(reads as f64 <= REGISTRY_READ_BURST + secs as f64 * REGISTRY_READS_PER_SECOND);
        // Several machines churning at once: they and the newcomer take turns, so it waits about one turn each.
        let (waited, reads, _) = churn(8, Duration::from_secs(60), secs);
        let waited = waited.expect("the other peer was judged");
        assert!(waited <= Duration::from_secs(9), "it waited {waited:?}");
        assert!(reads as f64 <= REGISTRY_READ_BURST + secs as f64 * REGISTRY_READS_PER_SECOND, "the node's ceiling holds: {reads}");
    }

    /// One machine holds at most SOURCE_WAITING places in the hello queue, however many keys it mints, so it can't
    /// fill the queue and leave others refused; and the address a peer came from is its source, by the /64 on IPv6.
    #[test]
    fn one_machine_cannot_fill_the_hello_queue() {
        let mut lookups = Lookups::default();
        let machine = Source::Ip(std::net::Ipv4Addr::new(203, 0, 113, 9).into());
        let claim = || Claim { identity: "7".into(), index: 0 };
        let taken = (0..1000).filter(|_| lookups.offer(PeerId::random(), machine, claim()) == Offer::Waiting).count();
        assert_eq!(taken, SOURCE_WAITING);
        assert_eq!(fresh(&mut lookups), Offer::Waiting, "another source still has a place");
        let a: Multiaddr = "/ip6/2001:db8:1:2:aaaa::1/tcp/4001".parse().unwrap();
        let b: Multiaddr = "/ip6/2001:db8:1:2:bbbb::9/udp/4001/quic-v1".parse().unwrap();
        assert_eq!(Source::of(&inbound(&a)), Source::of(&inbound(&b)));
        assert_ne!(Source::of(&inbound(&a)), Source::of(&inbound(&"/ip6/2001:db8:1:3::1/tcp/4001".parse().unwrap())));
    }

    /// A connection that came in from `addr`, on the node's own listening address.
    fn inbound(addr: &Multiaddr) -> libp2p::core::ConnectedPoint {
        libp2p::core::ConnectedPoint::Listener { local_addr: "/ip4/0.0.0.0/tcp/4001".parse().unwrap(), send_back_addr: addr.clone() }
    }

    /// A connection relayed to the node through `relay`, from `peer`: the node listens on the relay's circuit and
    /// knows the peer only by its key, which costs nothing.
    fn through(relay: PeerId, peer: PeerId) -> libp2p::core::ConnectedPoint {
        libp2p::core::ConnectedPoint::Listener {
            local_addr: format!("/ip4/192.0.2.1/tcp/4001/p2p/{relay}/p2p-circuit").parse().unwrap(),
            send_back_addr: Multiaddr::empty().with(Protocol::P2p(peer)),
        }
    }

    /// A source is something a peer can't mint: every peer behind one relay is one source, the relay's, however many
    /// keys its client names, whether the node listens on the relay's circuit or dialed through it. Over a thousand
    /// churned identities that relay's client holds at most its source's places and can't fill the relayed share, let
    /// alone the queue; a peer connected directly finds a place and is judged at the next free read; a peer behind
    /// another relay still finds one; and the queue never holds more than its ceiling.
    #[test]
    fn peers_behind_one_relay_are_one_source_and_cannot_starve_direct_newcomers() {
        let relay = PeerId::random();
        let churned: Vec<Source> = (0..1000).map(|_| Source::of(&through(relay, PeerId::random()))).collect();
        assert!(churned.iter().all(|s| *s == Source::Relayed(Some(relay))), "one source for every peer behind the relay");
        let dialed: Multiaddr = format!("/ip4/192.0.2.1/tcp/4001/p2p/{relay}/p2p-circuit/p2p/{}", PeerId::random()).parse().unwrap();
        let dialed = libp2p::core::ConnectedPoint::Dialer { address: dialed, role_override: libp2p::core::Endpoint::Dialer, port_use: libp2p::core::transport::PortUse::New };
        assert_eq!(Source::of(&dialed), Source::Relayed(Some(relay)), "dialed through it, the same relay");
        assert_ne!(Source::of(&through(PeerId::random(), PeerId::random())), Source::Relayed(Some(relay)), "another relay is another source");

        let claim = |n: usize| Claim { identity: format!("{}", 1_000_000 + n), index: 0 };
        let mut lookups = Lookups::default();
        // Every read is held, so nothing leaves the queue while the client churns.
        for n in 0..REGISTRY_LOOKUPS {
            let p = PeerId::random();
            assert_eq!(lookups.offer(p, alone(p), claim(n)), Offer::Waiting);
            assert!(lookups.next(|_, _| true).is_some());
        }
        let mut taken = 0;
        for (n, source) in churned.iter().enumerate() {
            if lookups.offer(PeerId::random(), *source, claim(n)) == Offer::Waiting {
                taken += 1;
            }
        }
        assert_eq!(taken, SOURCE_WAITING, "the relay's client holds its source's places, no more");
        assert!(lookups.next_in_line.is_empty(), "refused for its source's share, none of its peers is next in line");
        // Behind another relay, a peer still finds a place.
        let elsewhere = PeerId::random();
        assert_eq!(lookups.offer(elsewhere, Source::of(&through(PeerId::random(), elsewhere)), claim(0)), Offer::Waiting);

        // Relays enough to fill the relayed share, each churning: they take that share and no place of a direct peer.
        let relays: Vec<Source> = (0..2 * RELAYED_WAITING / SOURCE_WAITING).map(|_| Source::Relayed(Some(PeerId::random()))).collect();
        for (n, source) in relays.iter().cycle().take(1000).enumerate() {
            let _ = lookups.offer(PeerId::random(), *source, claim(n));
        }
        assert_eq!(lookups.waiting.iter().filter(|(_, s, _)| s.relayed()).count(), RELAYED_WAITING, "relayed hellos fill their own share");
        assert_eq!(lookups.next_in_line.len(), RELAYED_NEXT_IN_LINE, "and their own share of the remembered");
        let newcomer = PeerId::random();
        let from = Source::of(&inbound(&"/ip4/198.51.100.7/tcp/4001".parse().unwrap()));
        assert_eq!(lookups.offer(newcomer, from, claim(42)), Offer::Waiting, "a direct newcomer finds a place");
        // The next read freed goes to it: its source has never been served, every relay's has.
        let ended = *lookups.running.iter().next().unwrap();
        lookups.done(ended);
        let mut served = Vec::new();
        while served.len() < SOURCE_WAITING {
            let (peer, _, _) = lookups.next(|_, _| true).expect("a read is free");
            served.push(peer);
            lookups.done(peer);
        }
        assert!(served.contains(&newcomer), "judged within one turn of each source waiting");
        // Direct peers fill their share too and can't take the relayed one: relayed places freed by those reads stay
        // for relayed peers.
        while lookups.offer(PeerId::random(), alone(PeerId::random()), claim(7)) == Offer::Waiting {}
        assert_eq!(lookups.waiting.iter().filter(|(_, s, _)| !s.relayed()).count(), direct().0);
        let behind = PeerId::random();
        assert_eq!(lookups.offer(behind, Source::of(&through(PeerId::random(), behind)), claim(8)), Offer::Waiting);
        assert!(lookups.waiting.len() <= LOOKUPS_WAITING + NEXT_IN_LINE, "the node's ceiling holds");
    }

    /// A turn remembered for one kind of connection is a turn in that kind's share. A peer refused directly that comes
    /// back through a relay (or the reverse) is a newcomer among the relayed: it can't enter their full share ahead of
    /// them, and the memory of its refusal is spent.
    #[test]
    fn a_remembered_turn_never_crosses_into_the_other_kinds_places() {
        let claim = |n: usize| Claim { identity: format!("{n}"), index: 0 };
        let mut lookups = Lookups::default();
        while lookups.offer(PeerId::random(), alone(PeerId::random()), claim(1)) == Offer::Waiting {}
        let relays: Vec<Source> = (0..RELAYED_WAITING / SOURCE_WAITING).map(|_| Source::Relayed(Some(PeerId::random()))).collect();
        for source in relays.iter().cycle().take(RELAYED_WAITING) {
            assert_eq!(lookups.offer(PeerId::random(), *source, claim(2)), Offer::Waiting);
        }
        let waiting = lookups.waiting.len();
        // Refused directly and remembered, with the direct share full.
        let switcher = PeerId::random();
        assert_eq!(lookups.offer(switcher, alone(switcher), claim(3)), Offer::Full);
        assert!(lookups.next_in_line.contains(&(switcher, false)));
        // Back through a relay nobody has used, while the relayed share is full: no place, and no turn ahead.
        assert_eq!(lookups.offer(switcher, Source::Relayed(Some(PeerId::random())), claim(3)), Offer::Full);
        assert_eq!(lookups.waiting.len(), waiting, "the relayed share holds what it held");
        assert_eq!(lookups.ahead, 0);
        assert!(!lookups.next_in_line.contains(&(switcher, false)), "the direct turn is spent");
        // The same way it was refused, a remembered peer still waits at the front.
        let patient = PeerId::random();
        assert_eq!(lookups.offer(patient, alone(patient), claim(4)), Offer::Full);
        assert_eq!(lookups.offer(patient, alone(patient), claim(4)), Offer::Waiting);
        assert_eq!(lookups.waiting[0].0, patient);
    }

    /// Being refused, remembered and coming back is a turn at the front, not more places: however long fresh peers
    /// from fresh sources keep being refused and keep coming back, each kind holds at most its places and its share
    /// of the remembered, and the queue its ceiling.
    #[test]
    fn remembered_peers_coming_back_never_grow_the_queue_past_its_ceiling() {
        let claim = || Claim { identity: "7".into(), index: 0 };
        for relayed in [false, true] {
            let from = |_: PeerId| if relayed { Source::Relayed(Some(PeerId::random())) } else { alone(PeerId::random()) };
            let (places, remembered) = from(PeerId::random()).places();
            let mut lookups = Lookups::default();
            for _ in 0..50 {
                let refused: Vec<(PeerId, Source)> = (0..2 * NEXT_IN_LINE).map(|_| PeerId::random()).map(|p| (p, from(p))).collect();
                for _ in 0..2 {
                    for (peer, source) in &refused {
                        let _ = lookups.offer(*peer, *source, claim());
                    }
                }
                assert!(lookups.waiting.len() <= places + remembered, "{} waiting", lookups.waiting.len());
                assert!(lookups.next_in_line.len() <= remembered);
            }
            assert_eq!(lookups.waiting.len(), places + remembered, "the kind's places and its remembered, all taken");
            assert!(lookups.waiting.len() <= LOOKUPS_WAITING + NEXT_IN_LINE);
            // One held back stays remembered and comes in at the front once a remembered one before it is served.
            let held = lookups.next_in_line[0].0;
            assert_eq!(lookups.offer(held, from(held), claim()), Offer::Full);
            assert_eq!(lookups.next_in_line[0].0, held, "still next in line");
            let front = lookups.waiting[0].1;
            let (served, _, _) = lookups.next(|_, s| s == front).unwrap();
            lookups.done(served);
            assert_eq!(lookups.offer(held, from(held), claim()), Offer::Waiting);
            assert!(lookups.waiting.iter().take(lookups.ahead).any(|(p, _, _)| *p == held));
        }
    }

    /// Peers holding every registry read can't keep a peer that came meanwhile out: at most REGISTRY_LOOKUPS run, one
    /// per peer, and a freed place goes to the peer that has waited longest, ahead of the holders saying hello again.
    #[test]
    fn hello_registry_slots_cannot_starve_waiting_peer() {
        let claim = || Claim { identity: "7".into(), index: 0 };
        let mut lookups = Lookups::default();
        let holders: Vec<PeerId> = (0..REGISTRY_LOOKUPS).map(|_| PeerId::random()).collect();
        for p in &holders {
            assert_eq!(lookups.offer(*p, alone(*p), claim()), Offer::Waiting);
            assert_eq!(lookups.next(|_, _| true).map(|(q, _, _)| q), Some(*p));
        }
        assert_eq!(lookups.offer(holders[0], alone(holders[0]), claim()), Offer::AlreadyAsked, "one read per peer");
        let honest = PeerId::random();
        assert_eq!(lookups.offer(honest, alone(honest), claim()), Offer::Waiting);
        assert!(lookups.next(|_, _| true).is_none(), "every place is held");
        // A holder's read ends, and it says hello again at once, with a fresh key too: the honest peer goes first.
        lookups.done(holders[0]);
        assert_eq!(lookups.offer(holders[0], alone(holders[0]), claim()), Offer::Waiting);
        assert_eq!(fresh(&mut lookups), Offer::Waiting);
        assert_eq!(lookups.next(|_, _| true).map(|(q, _, _)| q), Some(honest), "the longest waiting goes first");
        assert!(lookups.next(|_, _| true).is_none(), "never past the cap");
        // The queue has a bound: past it a hello is refused a place, not kept.
        while lookups.waiting.len() < direct().0 {
            assert_eq!(fresh(&mut lookups), Offer::Waiting);
        }
        assert_eq!(fresh(&mut lookups), Offer::Full);
    }

    /// A node nobody can dial holds reservations, and AutoNAT losing its answer doesn't end them. Only a node reachable
    /// without them, or one that never needed any, goes without.
    #[test]
    fn a_reservation_outlasts_autonat_not_knowing() {
        assert!(needs_relay(Nat::Private, false, false), "found unreachable");
        assert!(needs_relay(Nat::Unknown, false, true), "no new answer: what it holds stays");
        assert!(!needs_relay(Nat::Unknown, false, false), "no answer yet and nothing held: none is taken");
        assert!(!needs_relay(Nat::Public, true, true), "reachable by itself");
        assert!(!needs_relay(Nat::Private, true, true), "an address the owner named");
    }

    /// A node meets peers for as long as it runs: what it counts of each ends with the refusal or the connection.
    #[test]
    fn standing_that_ran_out_is_forgotten() {
        let (here, gone) = (PeerId::random(), PeerId::random());
        let at = Instant::now();
        let now = at + Duration::from_secs(100);
        let mut refused = HashMap::from([(gone, (at, Duration::from_secs(10))), (here, (at, Duration::from_secs(1000)))]);
        let mut unlisted = HashMap::from([(gone, 3), (here, 1)]);
        let mut unread = unlisted.clone();
        forget_standing(&mut refused, &mut unlisted, &mut unread, &HashSet::from([here]), now);
        assert!(refused.contains_key(&here) && !refused.contains_key(&gone), "a refusal lasts its wait");
        assert_eq!((unlisted.len(), unread.len()), (1, 1), "tries end with the connection");
    }

    fn listing(id: &str, site: &str) -> Listing {
        Listing { entry_id: id.into(), site: site.into(), description: String::new(), contributor: "0xc".into(), fee: 1.0, signed: None }
    }

    #[test]
    fn a_providers_answer_adds_bounded_listings_once_each() {
        let id = |n: usize| format!("0x{n:064x}");
        let answer: Vec<_> = (0..1000).map(|n| listing(&id(n % 40), "example.com")).collect();
        let got = kept(answer, "example.com");
        assert_eq!(got.len(), MAX_LISTINGS_PER_SOURCE, "one provider's share");
        let ids: HashSet<_> = got.iter().map(|l| l.entry_id.clone()).collect();
        assert_eq!(ids.len(), got.len(), "each entry once");
        // Another site's, or an id the chain can't hold, is dropped.
        let more = vec![listing(&id(1), "example.com"), listing(&id(99), "other.example"), listing("route-1", "example.com"), listing(&id(500), "example.com")];
        assert_eq!(kept(more, "example.com").iter().map(|l| l.entry_id.clone()).collect::<Vec<_>>(), [id(1), id(500)]);
    }

    /// Limits on what a lookup takes can't be spent by a provider on another's behalf: nothing is checked here, so
    /// providers that each send a full answer of junk, or a copy of an honest provider's listing, still leave the
    /// honest provider's listings in the lookup, at the front, among the first of every provider's.
    #[test]
    fn one_providers_unchecked_listings_never_crowd_out_anothers() {
        let id = |n: usize| format!("0x{n:064x}");
        let by = |who: &str, n: usize| Listing { contributor: who.into(), ..listing(&id(n), "example.com") };
        let junk = |who: &str| (0..MAX_LISTINGS_PER_SOURCE).map(|n| by(who, n)).collect::<Vec<_>>();
        let honest = vec![by("0xh", 0), by("0xh", 1)];
        let answers = vec![kept(junk("0xh"), "example.com"), kept(junk("0xm"), "example.com"), kept(honest.clone(), "example.com"), kept(junk("0xn"), "example.com")];
        let got = interleaved(answers);
        assert_eq!(got.len(), 3 * MAX_LISTINGS_PER_SOURCE + 2, "nothing is capped across providers before it is checked");
        // A forged copy of the honest listing, with the honest contributor's name, from the first provider doesn't
        // stand in for the honest provider's own: both are there, for the reader to check.
        assert_eq!(got.iter().filter(|l| **l == honest[0]).count(), 2);
        // Each provider's first listing comes before any provider's second: a reader that stops early stops fairly.
        assert_eq!(&got[2], &honest[0]);
        assert_eq!(&got[6], &honest[1]);
        assert!(interleaved(vec![vec![], vec![]]).is_empty());
    }

    /// Two listings of one body are one entry (R2.4) and both stand (R2.16): an answer keeps each, by its own words
    /// or its own contributor, and takes one listing the answer repeats once.
    #[test]
    fn listings_that_share_a_body_are_each_kept() {
        let e = format!("0x{:064x}", 7);
        let said = |d: &str, by: &str| Listing { description: d.into(), contributor: by.into(), ..listing(&e, "example.com") };
        let got = kept(vec![said("Look up items", "0xa"), said("Add to cart", "0xa"), said("Look up items", "0xb"), said("Add to cart", "0xA")], "example.com");
        let words: Vec<_> = got.iter().map(|l| (l.description.as_str(), l.contributor.as_str())).collect();
        assert_eq!(words, [("Look up items", "0xa"), ("Add to cart", "0xa"), ("Look up items", "0xb")]);
    }

    /// What a node answers always reads within the asker's bounds, keeping the listings it put first.
    #[test]
    fn a_listings_answer_fits_the_bound_its_asker_reads() {
        let id = |n: usize| format!("0x{n:064x}");
        let sized = |n: usize, bytes: usize| Listing { description: "d".repeat(bytes), ..listing(&id(n), "example.com") };
        let size = |ls: &[Listing]| serde_json::to_vec(&ListingsAnswer { listings: ls.to_vec(), refused: None }).unwrap().len() as u64;
        // Many small ones: the count bounds it.
        let got = fit((0..100).map(|n| sized(n, 10)).collect());
        assert_eq!(got.len(), MAX_LISTINGS_PER_SOURCE);
        assert_eq!(got[0].entry_id, id(0));
        // Large ones: the bytes bound it, and the answer is never past them.
        let got = fit((0..48).map(|n| sized(n, 7 * 1024)).collect());
        assert!(size(&got) <= MAX_ANSWER_BYTES && !got.is_empty() && got.len() < 48);
        assert_eq!(got.iter().map(|l| l.entry_id.clone()).collect::<Vec<_>>(), (0..got.len()).map(id).collect::<Vec<_>>(), "the first ones");
        // One that alone is past the bound is left out, and those after it still go.
        let got = fit(vec![sized(0, MAX_ANSWER_BYTES as usize), sized(1, 10)]);
        assert_eq!(got.iter().map(|l| l.entry_id.clone()).collect::<Vec<_>>(), [id(1)]);
        assert!(size(&fit((0..32).map(|n| sized(n, 8 * 1024)).collect())) <= MAX_ANSWER_BYTES);
    }

    /// A refusal carries no listings: a release that predates refusals fails to read it, as no answer, rather than
    /// reading a source with nothing. A refusal and an answer both read back as they were sent.
    #[test]
    fn a_refused_listings_answer_is_never_read_as_an_empty_one() {
        #[derive(Deserialize)]
        struct Before {
            #[allow(dead_code)]
            listings: Vec<Listing>,
        }
        let refused = serde_json::to_vec(&ListingsAnswer { listings: vec![], refused: Some("busy".into()) }).unwrap();
        assert_eq!(refused, br#"{"refused":"busy"}"#);
        assert!(serde_json::from_slice::<Before>(&refused).is_err(), "an older release hears no answer");
        assert_eq!(serde_json::from_slice::<ListingsAnswer>(&refused).unwrap().refused.as_deref(), Some("busy"));
        let empty = serde_json::to_vec(&ListingsAnswer::default()).unwrap();
        assert!(serde_json::from_slice::<Before>(&empty).is_ok(), "an empty answer is still one");
        let back: ListingsAnswer = serde_json::from_slice(&empty).unwrap();
        assert!(back.listings.is_empty() && back.refused.is_none());
    }

    #[test]
    fn records_held_for_unjudged_peers_are_bounded() {
        let mut held = HashMap::new();
        let rec = |peer: PeerId| ProviderRecord::new(RecordKey::new(&b"site"), peer, vec![]);
        let one = PeerId::random();
        for _ in 0..(MAX_HELD_PER_PEER * 3) {
            hold(&mut held, one, rec(one));
        }
        assert_eq!(held[&one].len(), MAX_HELD_PER_PEER);
        for _ in 0..(MAX_HELD_PEERS * 2) {
            let p = PeerId::random();
            hold(&mut held, p, rec(p));
        }
        assert_eq!(held.len(), MAX_HELD_PEERS);
    }

    /// The saved table is replaced whole: what loads is the last table saved, never a part of one, and an empty table
    /// leaves the last one standing.
    #[test]
    fn the_saved_table_is_replaced_whole() {
        let path = std::env::temp_dir().join(format!("unbrowse-peer-table-{}.json", std::process::id()));
        let table: Vec<(PeerId, Vec<Multiaddr>)> = (0..3).map(|i| (PeerId::random(), vec![format!("/ip4/127.0.0.1/tcp/{}", 4000 + i).parse().unwrap()])).collect();
        save_table(&path, &table);
        assert_eq!(load_table(&path), table);
        save_table(&path, &[]);
        assert_eq!(load_table(&path), table, "an empty table doesn't replace the peers known last");
        save_table(&path, &table[..1]);
        assert_eq!(load_table(&path), table[..1]);
        let left: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with(&format!("unbrowse-peer-table-{}.", std::process::id()))).collect();
        assert!(left.iter().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")), "nothing half-written is left beside it");
        let _ = std::fs::remove_file(&path);
    }

    /// A goodbye counts only from the node it names, signed by that node's key, addressed to the reader, and lately:
    /// one signed by another key, passed on by another peer, addressed elsewhere or from another time changes nothing.
    #[test]
    fn only_a_node_can_say_its_own_goodbye() {
        let (leaver, other) = (Keypair::generate_ed25519(), Keypair::generate_ed25519());
        let (from, by, me, elsewhere) = (leaver.public().to_peer_id(), other.public().to_peer_id(), PeerId::random(), PeerId::random());
        let now = 1_000_000;
        let good = leaving_notice(&leaver, &me, now).unwrap();
        assert!(goodbye_from(&good, &from, &me, now));
        assert!(goodbye_from(&good, &from, &me, now + LEAVING_SKEW), "a clock a little off still reads it");
        assert!(!goodbye_from(&good, &by, &me, now), "passed on by another peer");
        assert!(!goodbye_from(&good, &from, &elsewhere, now), "read by a peer it wasn't addressed to");
        assert!(!goodbye_from(&good, &from, &me, now + LEAVING_SKEW + 1), "from another time");
        // The leaver's key, signed by another: what a peer forging another's goodbye can make.
        let forged = Leaving { sig: other.sign(&leaving_bytes(&from, &me, now)).unwrap(), ..good.clone() };
        assert!(!goodbye_from(&forged, &from, &me, now));
        // A notice altered after signing: its time moved, or its addressee.
        assert!(!goodbye_from(&Leaving { at: now + 1, ..good.clone() }, &from, &me, now));
        assert!(!goodbye_from(&Leaving { to: elsewhere.to_string(), ..good.clone() }, &from, &elsewhere, now));
        assert!(!goodbye_from(&Leaving { key: vec![1, 2, 3], ..good }, &from, &me, now), "a key that isn't one");
    }

    /// A peer is refused when it is older than the network takes, or doesn't say which release it is; with no
    /// minimum, every release is taken.
    #[test]
    fn a_peer_older_than_the_network_takes_is_refused() {
        let min = semver::Version::parse("13.2.0").unwrap();
        assert!(!too_old("unbrowse/13.2.0", Some(&min)));
        assert!(!too_old("unbrowse/14.0.0", Some(&min)));
        assert!(too_old("unbrowse/13.1.9", Some(&min)));
        assert!(too_old("rust-libp2p/0.47.0", Some(&min)));
        assert!(!too_old("rust-libp2p/0.47.0", None));
    }

    /// A peer table saved before files carried versions still seeds a restart; one saved again carries its version,
    /// and one a newer node saved is read as no table and never written over.
    #[test]
    fn a_peer_table_from_before_reads_and_a_newer_one_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("unbrowse-peer-table-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("peer-table.json");
        std::fs::copy(unbrowse_files::fixture(&unbrowse_files::PEER_TABLE), &path).unwrap();
        let table = load_table(&path);
        assert_eq!(table.len(), 1);
        assert_eq!(table[0].1, ["/ip4/127.0.0.1/tcp/47123".parse::<Multiaddr>().unwrap()]);
        save_table(&path, &table);
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["v"], unbrowse_files::PEER_TABLE.version());
        assert_eq!(load_table(&path), table);

        let newer = format!(r#"{{"v":{},"items":[]}}"#, unbrowse_files::PEER_TABLE.version() + 1);
        std::fs::write(&path, &newer).unwrap();
        assert!(load_table(&path).is_empty());
        save_table(&path, &table);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer, "never written over");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
