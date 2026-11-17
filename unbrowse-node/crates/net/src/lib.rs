//! The node's peer network. Nodes find each other and each site's listings through a Kademlia table keyed by site,
//! so no node holds the whole map: a node stores what it holds and what it uses, and asks the table for the rest.
//!
//! - `site`: the key a site is found under, its registrable domain.
//! - `position`: where a node sits in the table, fixed by its identity so it can't aim at a site's key.
//! - `admission`: which peers enter the routing table and whose provider records are kept.
//! - `reach`: which of a node's addresses another machine could dial, and so are published.
//! - `body`: route bodies by content id: the key their providers are recorded under, and `/unbrowse/body/1`, where a
//!   caller asks a provider for one, paying for it. Bodies are opaque bytes here.
//! - `budget`: what the node does for each peer, bounded: a token bucket per peer and protocol, and serving slots
//!   that go to the peers that pay for bodies first, with one kept for a newcomer.
//! - `changes`: change notices over gossipsub, one topic a site: a contributor's node says it delisted or repriced
//!   entries, and the nodes that keep or serve them read the chain again at once. Advisory: the chain stays the truth.
//! - `dial`: every dial a behaviour asks for by peer opens a port of its own, so dials that cross are two connections.
//! - `providers`: which of a body's providers a caller still tries, on R7.20's doubling schedule, kept across restarts.
//! - `tower`: `/unbrowse/tower/1`, where a node hands a peer the signed vouchers and lines it would have claimed, so
//!   the peer can claim what is still unclaimed as the window closes. The lines are opaque bytes here.
//! - `node`: the running swarm and the handle the node uses: provide a site, find a site's listings; provide, find
//!   and fetch a body; leave the network cleanly (`Net::stop`).

#[macro_use]
mod antithesis;
pub mod admission;
pub mod body;
mod budget;
mod dial;
pub mod changes;
pub mod node;
pub mod position;
pub mod providers;
pub mod reach;
pub mod site;
pub mod tower;
pub mod wire;

pub use admission::{admit, Claim, Identity, Refusal, Registry, Rules};
pub use changes::{Change, ChangeKind, Heard};
pub use body::{body_key, Bodies, FetchError, NoBodies, BODY_PROTOCOL, MAX_BODY_BYTES, MAX_BODY_PROVIDERS, MAX_CONTENT_ID_BYTES, MAX_PAYMENT_BYTES};
pub use libp2p::identity::Keypair;
pub use libp2p::multiaddr::Protocol;
pub use libp2p::{Multiaddr, PeerId};
pub use node::{Config, Found, Listing, Listings, Load, Net, Serve, Standing, KAD_PROTOCOL};
pub use position::{grind, placed, position, target};
pub use providers::{exclusion, load_kept, save_kept, Providers, MAX_EXCLUSION, MAX_KEPT, MAX_KEPT_BYTES};
pub use reach::{dialable, listen_all, published};
pub use site::{site_key, site_of};
pub use tower::{HandError, NoTowers, Towers, MAX_HANDED_BYTES, TOWER_PROTOCOL};
pub use wire::Speaks;
