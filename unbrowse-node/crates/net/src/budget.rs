//! What a node does for its peers, bounded per peer (R7.18, R7.26), the way token buckets bound a client and BitTorrent
//! bounds its uploads.
//!
//! - `Rate`, `PerPeer`: a token bucket for each peer, per protocol: a burst, then a steady rate. A peer past its budget
//!   is refused at once, with a reason, never left to time out.
//! - `Budget`: one protocol's buckets. A peer the registry admitted has a bucket of its own. One it hasn't (any key is
//!   free to make, so a stranger can be many) has its own bucket and shares one more with every other stranger, so
//!   strangers together can't spend what admitted peers are owed.
//! - `Slots`: the answers a node makes at once for one protocol. When they are all taken, the next free one goes to a
//!   peer that pays this node for bodies, most paid first, as BitTorrent unchokes the peers that reciprocate. One slot
//!   is kept for a newcomer, a peer that hasn't paid, and it goes round them, the one whose turn was longest ago
//!   first, as BitTorrent's optimistic unchoke gives a peer it knows nothing of a turn. An ask waits for a slot a
//!   moment at most, then is refused.
//! - `Payers`: who paid this node for a body, and how many times within the hour.
//! - `KadGate`: Kademlia answers its own queries, so its budget is held where its streams open: one a peer opens past
//!   its budget is closed unread, and the asker's query moves on to another peer at once.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use libp2p::core::transport::PortUse;
use libp2p::core::Endpoint;
use libp2p::swarm::handler::ConnectionEvent;
use libp2p::swarm::{
    ConnectionDenied, ConnectionHandler, ConnectionHandlerEvent, ConnectionId, FromSwarm, NetworkBehaviour, SubstreamProtocol, THandler, THandlerInEvent,
    THandlerOutEvent, ToSwarm,
};
use libp2p::{Multiaddr, PeerId};

/// How often one peer may ask: a burst, then a steady rate.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Rate {
    pub burst: f64,
    pub per_second: f64,
    /// Peers tracked at once. Past it, a peer not yet tracked waits until one has gone quiet.
    pub peers: usize,
}

/// Listings asks one peer makes of this node. A seeker asks a provider once a lookup, and a node holding routes for
/// others looks up each site it touches once a pass, so a burst covers a pass and a slow refill covers lookups.
pub(crate) const LISTINGS_RATE: Rate = Rate { burst: 32.0, per_second: 1.0, peers: 1024 };
/// Body asks one peer makes. Bodies are served to any peer that pays, admitted or not.
pub(crate) const BODY_RATE: Rate = Rate { burst: 20.0, per_second: 1.0, peers: 1024 };
/// Kademlia streams one peer opens to this node: lookups through it, and the records it announces here. Announcing
/// every body a node provides is two streams a body to each of the closest peers, all at once, so the burst is wide.
pub(crate) const KAD_RATE: Rate = Rate { burst: 512.0, per_second: 32.0, peers: 4096 };
/// What every peer the registry hasn't admitted shares, per protocol, on top of its own bucket.
pub(crate) const STRANGERS_LISTINGS: Rate = Rate { burst: 64.0, per_second: 4.0, peers: 1 };
pub(crate) const STRANGERS_BODIES: Rate = Rate { burst: 64.0, per_second: 4.0, peers: 1 };
pub(crate) const STRANGERS_KAD: Rate = Rate { burst: 1024.0, per_second: 64.0, peers: 1 };

/// Answers made at once, per protocol, from every peer together; one of them is the newcomer's.
pub const SLOTS: usize = 16;
/// Slots one peer holds at once, at most: a peer within its rate still can't take every slot with answers that are
/// slow to make.
pub const SLOTS_PER_PEER: usize = 4;
/// Asks waiting for a slot, at most, and how long one waits before it is refused. Short: the asker's own timeout is
/// ten seconds, and a refusal it hears in time lets it ask another provider.
pub const MAX_WAITING: usize = 32;
pub const SLOT_WAIT: Duration = Duration::from_secs(2);
/// How long a body paid for counts towards a peer being served first, and payers remembered, at most.
pub const PAID_FOR: Duration = Duration::from_secs(3600);
const MAX_PAYERS: usize = 1024;
/// Payment times kept per peer, at most: a rank past it is a tie among the peers that pay most.
const MAX_PAID_TIMES: usize = 256;

/// Each peer's allowance, as a bucket refilled at `per_second` up to `burst`.
pub(crate) struct PerPeer {
    rate: Rate,
    buckets: HashMap<PeerId, (f64, Instant)>,
}

impl PerPeer {
    pub(crate) fn new(rate: Rate) -> PerPeer {
        PerPeer { rate, buckets: HashMap::new() }
    }

    fn level(&self, b: (f64, Instant), now: Instant) -> f64 {
        (b.0 + now.saturating_duration_since(b.1).as_secs_f64() * self.rate.per_second).min(self.rate.burst)
    }

    /// Whether `peer` may ask now, without spending anything.
    fn has(&mut self, peer: PeerId, now: Instant) -> bool {
        if !self.buckets.contains_key(&peer) && self.buckets.len() >= self.rate.peers {
            // A peer whose allowance has refilled is one the bucket no longer needs to remember.
            let rate = self.rate;
            self.buckets.retain(|_, b| (b.0 + now.saturating_duration_since(b.1).as_secs_f64() * rate.per_second).min(rate.burst) < rate.burst);
            if self.buckets.len() >= self.rate.peers {
                return false;
            }
        }
        self.buckets.get(&peer).map(|b| self.level(*b, now)).unwrap_or(self.rate.burst) >= 1.0
    }

    fn spend(&mut self, peer: PeerId, now: Instant) {
        let tokens = self.buckets.get(&peer).map(|b| self.level(*b, now)).unwrap_or(self.rate.burst);
        self.buckets.insert(peer, (tokens - 1.0, now));
    }

    /// Whether `peer` may ask now; an ask taken spends one from its allowance.
    pub(crate) fn take(&mut self, peer: PeerId, now: Instant) -> bool {
        if !self.has(peer, now) {
            return false;
        }
        self.spend(peer, now);
        true
    }
}

/// One protocol's buckets: each peer's own, and the one strangers share.
pub(crate) struct Budget {
    peers: PerPeer,
    strangers: PerPeer,
    /// The one key the strangers' shared bucket is kept under.
    all: PeerId,
}

impl Budget {
    pub(crate) fn new(each: Rate, strangers: Rate) -> Budget {
        // The strangers' bucket is the one entry of a map of its own, under a key made once.
        Budget { peers: PerPeer::new(each), strangers: PerPeer::new(strangers), all: PeerId::random() }
    }

    /// Whether `peer` may ask now, spending from its allowance if so; a stranger spends from the shared one too, and is
    /// refused when either is spent.
    pub(crate) fn take(&mut self, peer: PeerId, admitted: bool, now: Instant) -> bool {
        if admitted {
            return self.peers.take(peer, now);
        }
        if !self.peers.has(peer, now) || !self.strangers.has(self.all, now) {
            return false;
        }
        self.peers.spend(peer, now);
        self.strangers.spend(self.all, now);
        true
    }
}

/// Who paid this node for a body within the hour (R7.29, `serving.slots`): each peer's payment times, the newest last.
#[derive(Default)]
pub(crate) struct Payers {
    paid: HashMap<PeerId, VecDeque<Instant>>,
}

impl Payers {
    /// `peer` paid for a body it was served.
    pub(crate) fn paid(&mut self, peer: PeerId, now: Instant) {
        if !self.paid.contains_key(&peer) && self.paid.len() >= MAX_PAYERS {
            self.paid.retain(|_, at| {
                forget_before(at, now);
                !at.is_empty()
            });
            if self.paid.len() >= MAX_PAYERS {
                // The one whose newest payment is oldest makes room.
                if let Some(oldest) = self.paid.iter().min_by_key(|(_, at)| at.back().copied()).map(|(p, _)| *p) {
                    self.paid.remove(&oldest);
                }
            }
        }
        let at = self.paid.entry(peer).or_default();
        forget_before(at, now);
        if at.len() >= MAX_PAID_TIMES {
            at.pop_front();
        }
        at.push_back(now);
    }

    /// How many bodies `peer` paid for within `PAID_FOR` of `now`, never a running count of older ones; 0 for a peer
    /// that hasn't.
    pub(crate) fn rank(&self, peer: &PeerId, now: Instant) -> u32 {
        self.paid.get(peer).map_or(0, |at| at.iter().filter(|t| now.saturating_duration_since(**t) < PAID_FOR).count() as u32)
    }
}

/// Drops the payment times `PAID_FOR` or more before `now`.
fn forget_before(at: &mut VecDeque<Instant>, now: Instant) {
    while at.front().is_some_and(|t| now.saturating_duration_since(*t) >= PAID_FOR) {
        at.pop_front();
    }
}

/// The slot an answer holds: one of the shared ones, or the newcomer's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Slot {
    pub peer: PeerId,
    pub newcomer: bool,
}

/// What became of an ask for a slot.
pub(crate) enum Asked<T> {
    /// Answer it now, in this slot.
    Now(Slot, T),
    /// It waits for a slot under this ticket, and the ask it pushed out of a full queue, if any, is refused.
    Waiting(u64, Option<T>),
    /// Refuse it, with this reason.
    Refused(T, &'static str),
}

struct Waiting<T> {
    ticket: u64,
    peer: PeerId,
    ask: T,
}

/// One protocol's serving slots, and the asks waiting for one.
pub(crate) struct Slots<T> {
    total: usize,
    per_peer: usize,
    /// Shared slots taken, and who holds the newcomer's.
    shared: usize,
    newcomer: Option<PeerId>,
    held: HashMap<PeerId, usize>,
    waiting: VecDeque<Waiting<T>>,
    /// When each peer last had the newcomer's slot.
    turns: HashMap<PeerId, Instant>,
    next: u64,
}

/// The reason a waiting ask is refused with once it has waited `SLOT_WAIT`, or was pushed out by a higher-ranked one.
pub(crate) const BUSY: &str = "too many asks at once; ask again later";

impl<T> Slots<T> {
    /// `total` slots, one of them the newcomer's, at most `per_peer` held or waited for by one peer.
    pub(crate) fn new(total: usize, per_peer: usize) -> Slots<T> {
        Slots { total: total.max(2), per_peer: per_peer.max(1), shared: 0, newcomer: None, held: HashMap::new(), waiting: VecDeque::new(), turns: HashMap::new(), next: 0 }
    }

    /// Answers being made now.
    pub(crate) fn busy(&self) -> usize {
        self.shared + usize::from(self.newcomer.is_some())
    }

    fn holds(&self, peer: &PeerId) -> usize {
        self.held.get(peer).copied().unwrap_or(0) + self.waiting.iter().filter(|w| w.peer == *peer).count()
    }

    fn start(&mut self, peer: PeerId, newcomer: bool, now: Instant) -> Slot {
        *self.held.entry(peer).or_insert(0) += 1;
        if newcomer {
            self.newcomer = Some(peer);
            self.turns.insert(peer, now);
            if self.turns.len() > MAX_PAYERS {
                // The turns longest ago are the ones forgotten: those peers go first next time, as they would anyway.
                let mut at: Vec<Instant> = self.turns.values().copied().collect();
                at.sort();
                let cut = at[at.len() / 2];
                self.turns.retain(|_, t| *t >= cut);
            }
        } else {
            self.shared += 1;
        }
        Slot { peer, newcomer }
    }

    /// `peer` asks, ranked `rank_of` by what it paid this node (0 for nothing). It is answered now if a slot it may take
    /// is free, and waits if not. It is refused past its share of slots, and when as many wait as may, none ranked
    /// below it; one ranked below it is pushed out instead.
    pub(crate) fn ask(&mut self, peer: PeerId, ask: T, now: Instant, rank_of: impl Fn(&PeerId) -> u32) -> Asked<T> {
        if self.holds(&peer) >= self.per_peer {
            return Asked::Refused(ask, "too many asks at once from this peer; ask again later");
        }
        let rank = rank_of(&peer);
        if self.shared < self.total - 1 {
            return Asked::Now(self.start(peer, false, now), ask);
        }
        if rank == 0 && self.newcomer.is_none() {
            return Asked::Now(self.start(peer, true, now), ask);
        }
        let mut out = None;
        if self.waiting.len() >= MAX_WAITING {
            // The lowest ranked, and of those the one that came last, makes room for a higher-ranked ask.
            let lowest = self.waiting.iter().enumerate().map(|(i, w)| (rank_of(&w.peer), std::cmp::Reverse(i))).min();
            match lowest {
                Some((r, std::cmp::Reverse(i))) if r < rank => out = self.waiting.remove(i).map(|w| w.ask),
                _ => return Asked::Refused(ask, BUSY),
            }
        }
        self.next += 1;
        self.waiting.push_back(Waiting { ticket: self.next, peer, ask });
        Asked::Waiting(self.next, out)
    }

    /// The answer in `slot` is done. The slot goes to a waiting ask, if one may take it: the newcomer's to the waiting
    /// peer that hasn't paid and whose turn in it was longest ago; a shared one to the waiting peer that paid most, and
    /// of those the one that asked first.
    pub(crate) fn done(&mut self, slot: Slot, now: Instant, rank_of: impl Fn(&PeerId) -> u32) -> Option<(Slot, T)> {
        if let Some(n) = self.held.get_mut(&slot.peer) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                self.held.remove(&slot.peer);
            }
        }
        let next = if slot.newcomer {
            self.newcomer = None;
            self.waiting
                .iter()
                .enumerate()
                .filter(|(_, w)| rank_of(&w.peer) == 0)
                .min_by_key(|(i, w)| (self.turns.get(&w.peer).copied(), *i))
                .map(|(i, _)| i)
        } else {
            self.shared = self.shared.saturating_sub(1);
            self.waiting.iter().enumerate().max_by_key(|(i, w)| (rank_of(&w.peer), std::cmp::Reverse(*i))).map(|(i, _)| i)
        };
        let w = self.waiting.remove(next?)?;
        Some((self.start(w.peer, slot.newcomer, now), w.ask))
    }

    /// The ask waiting under `ticket`, taken out to be refused: it has waited `SLOT_WAIT`.
    pub(crate) fn expire(&mut self, ticket: u64) -> Option<T> {
        let i = self.waiting.iter().position(|w| w.ticket == ticket)?;
        self.waiting.remove(i).map(|w| w.ask)
    }
}

/// The Kademlia budget, shared between the swarm, which says who counts, and each connection, where streams open.
#[derive(Clone)]
pub(crate) struct KadGate(Arc<Mutex<GateState>>);

struct GateState {
    budget: Budget,
    counts: HashSet<PeerId>,
    refused: u64,
}

impl KadGate {
    pub(crate) fn new() -> KadGate {
        KadGate(Arc::new(Mutex::new(GateState { budget: Budget::new(KAD_RATE, STRANGERS_KAD), counts: HashSet::new(), refused: 0 })))
    }

    fn state(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Whether `peer` counts now, which gives it a bucket of its own.
    pub(crate) fn set_counts(&self, peer: PeerId, counts: bool) {
        let mut s = self.state();
        if counts {
            s.counts.insert(peer);
        } else {
            s.counts.remove(&peer);
        }
    }

    /// Whether a stream `peer` opened may be answered; one that may not is counted.
    fn take(&self, peer: PeerId) -> bool {
        let mut s = self.state();
        let counts = s.counts.contains(&peer);
        let ok = s.budget.take(peer, counts, Instant::now());
        if !ok {
            s.refused += 1;
        }
        ok
    }

    /// Streams refused since the node started.
    pub(crate) fn refused(&self) -> u64 {
        self.state().refused
    }
}

/// A behaviour, Kademlia here, whose inbound streams are held to the gate: each connection's handler closes a stream
/// the peer opened past its budget before the behaviour reads it. Everything else passes through unchanged.
pub(crate) struct Gated<B> {
    pub inner: B,
    gate: KadGate,
}

impl<B> Gated<B> {
    pub(crate) fn new(inner: B, gate: KadGate) -> Gated<B> {
        Gated { inner, gate }
    }
}

impl<B> std::ops::Deref for Gated<B> {
    type Target = B;
    fn deref(&self) -> &B {
        &self.inner
    }
}

impl<B> std::ops::DerefMut for Gated<B> {
    fn deref_mut(&mut self) -> &mut B {
        &mut self.inner
    }
}

pub(crate) struct GatedHandler<H> {
    inner: H,
    peer: PeerId,
    gate: KadGate,
}

impl<B: NetworkBehaviour> NetworkBehaviour for Gated<B> {
    type ConnectionHandler = GatedHandler<THandler<B>>;
    type ToSwarm = B::ToSwarm;

    fn handle_pending_inbound_connection(&mut self, id: ConnectionId, local: &Multiaddr, remote: &Multiaddr) -> Result<(), ConnectionDenied> {
        self.inner.handle_pending_inbound_connection(id, local, remote)
    }

    fn handle_established_inbound_connection(&mut self, id: ConnectionId, peer: PeerId, local: &Multiaddr, remote: &Multiaddr) -> Result<THandler<Self>, ConnectionDenied> {
        let inner = self.inner.handle_established_inbound_connection(id, peer, local, remote)?;
        Ok(GatedHandler { inner, peer, gate: self.gate.clone() })
    }

    fn handle_pending_outbound_connection(&mut self, id: ConnectionId, peer: Option<PeerId>, addrs: &[Multiaddr], role: Endpoint) -> Result<Vec<Multiaddr>, ConnectionDenied> {
        self.inner.handle_pending_outbound_connection(id, peer, addrs, role)
    }

    fn handle_established_outbound_connection(&mut self, id: ConnectionId, peer: PeerId, addr: &Multiaddr, role: Endpoint, port_use: PortUse) -> Result<THandler<Self>, ConnectionDenied> {
        let inner = self.inner.handle_established_outbound_connection(id, peer, addr, role, port_use)?;
        Ok(GatedHandler { inner, peer, gate: self.gate.clone() })
    }

    fn on_swarm_event(&mut self, event: FromSwarm) {
        self.inner.on_swarm_event(event)
    }

    fn on_connection_handler_event(&mut self, peer: PeerId, id: ConnectionId, event: THandlerOutEvent<Self>) {
        self.inner.on_connection_handler_event(peer, id, event)
    }

    fn poll(&mut self, cx: &mut Context<'_>) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        self.inner.poll(cx)
    }
}

impl<H: ConnectionHandler> ConnectionHandler for GatedHandler<H> {
    type FromBehaviour = H::FromBehaviour;
    type ToBehaviour = H::ToBehaviour;
    type InboundProtocol = H::InboundProtocol;
    type OutboundProtocol = H::OutboundProtocol;
    type InboundOpenInfo = H::InboundOpenInfo;
    type OutboundOpenInfo = H::OutboundOpenInfo;

    fn listen_protocol(&self) -> SubstreamProtocol<Self::InboundProtocol, Self::InboundOpenInfo> {
        self.inner.listen_protocol()
    }

    fn connection_keep_alive(&self) -> bool {
        self.inner.connection_keep_alive()
    }

    fn poll(&mut self, cx: &mut Context<'_>) -> Poll<ConnectionHandlerEvent<Self::OutboundProtocol, Self::OutboundOpenInfo, Self::ToBehaviour>> {
        self.inner.poll(cx)
    }

    fn poll_close(&mut self, cx: &mut Context<'_>) -> Poll<Option<Self::ToBehaviour>> {
        self.inner.poll_close(cx)
    }

    fn on_behaviour_event(&mut self, event: Self::FromBehaviour) {
        self.inner.on_behaviour_event(event)
    }

    fn on_connection_event(&mut self, event: ConnectionEvent<Self::InboundProtocol, Self::OutboundProtocol, Self::InboundOpenInfo, Self::OutboundOpenInfo>) {
        // A stream past the peer's budget is dropped here, which closes it: the asker reads the end of the stream at
        // once, a refusal, and its query asks another peer.
        if matches!(event, ConnectionEvent::FullyNegotiatedInbound(_)) && !self.gate.take(self.peer) {
            return;
        }
        self.inner.on_connection_event(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_asks_at_its_rate_and_others_keep_theirs() {
        let rate = Rate { burst: 3.0, per_second: 1.0, peers: 2 };
        let mut limit = PerPeer::new(rate);
        let (a, b, c) = (PeerId::random(), PeerId::random(), PeerId::random());
        let t = Instant::now();
        assert!((0..3).all(|_| limit.take(a, t)), "a burst");
        assert!(!limit.take(a, t), "past the burst");
        assert!(limit.take(b, t), "another peer's allowance is its own");
        assert!(!limit.take(c, t), "past the peers tracked, while every tracked one is still spending");
        assert!(limit.take(a, t + Duration::from_secs(1)), "one more a second later");
        assert!(!limit.take(a, t + Duration::from_secs(1)));
        // Once the tracked peers' allowances have refilled, they are forgotten and c is tracked in their place.
        assert!(limit.take(c, t + Duration::from_secs(10)));
    }

    /// Strangers share one allowance between them, on top of their own: many keys spend no more than it, and an
    /// admitted peer's allowance is untouched by them.
    #[test]
    fn strangers_together_spend_no_more_than_their_share() {
        let mut b = Budget::new(Rate { burst: 4.0, per_second: 0.0, peers: 1000 }, Rate { burst: 10.0, per_second: 0.0, peers: 1 });
        let t = Instant::now();
        let taken = (0..100).filter(|_| b.take(PeerId::random(), false, t)).count();
        assert_eq!(taken, 10, "a hundred strangers' keys share ten");
        let admitted = PeerId::random();
        assert_eq!((0..10).filter(|_| b.take(admitted, true, t)).count(), 4, "an admitted peer has its own four");
    }

    fn rank(payers: &[PeerId]) -> impl Fn(&PeerId) -> u32 + '_ {
        move |p| u32::from(payers.contains(p))
    }

    /// With every slot taken, a peer that pays is served before one that doesn't, whoever asked first; the newcomer's
    /// slot goes to a peer that hasn't paid, and round them.
    #[test]
    fn a_free_slot_goes_to_a_payer_first_and_the_newcomers_round_those_who_havent_paid() {
        let t = Instant::now();
        let (f, n1, n2, n3, p) = (PeerId::random(), PeerId::random(), PeerId::random(), PeerId::random(), PeerId::random());
        let payers = [p];
        let mut s: Slots<&str> = Slots::new(3, 2);
        let Asked::Now(f1, _) = s.ask(f, "f1", t, rank(&payers)) else { panic!() };
        let Asked::Now(f2, _) = s.ask(f, "f2", t, rank(&payers)) else { panic!() };
        assert!(!f1.newcomer && !f2.newcomer, "the shared slots");
        assert!(matches!(s.ask(f, "f3", t, rank(&payers)), Asked::Refused(_, _)), "past one peer's share");
        let Asked::Now(nc, _) = s.ask(n1, "n1", t, rank(&payers)) else { panic!("the newcomer's slot is free") };
        assert!(nc.newcomer);
        assert!(matches!(s.ask(n2, "n2", t, rank(&payers)), Asked::Waiting(_, None)));
        assert!(matches!(s.ask(p, "p", t, rank(&payers)), Asked::Waiting(_, None)), "a payer never takes the newcomer's slot");
        assert!(matches!(s.ask(n3, "n3", t, rank(&payers)), Asked::Waiting(_, None)));
        assert_eq!(s.busy(), 3);
        // A shared slot frees: the payer, though it asked after n2.
        let (slot, ask) = s.done(f1, t, rank(&payers)).unwrap();
        assert_eq!((ask, slot.newcomer), ("p", false));
        // The newcomer's frees: n2 has never had it, so it goes before n1 would; then n3.
        let (slot, ask) = s.done(nc, t, rank(&payers)).unwrap();
        assert_eq!((ask, slot.newcomer), ("n2", true));
        assert_eq!(s.done(slot, t + Duration::from_secs(1), rank(&payers)).map(|(_, a)| a), Some("n3"));
        assert!(s.expire(99).is_none());
    }

    /// A full queue makes room for a payer by pushing out the latest of those ranked lowest; one ranked no higher is
    /// refused at once, and a waiting ask is taken out when it has waited long enough.
    #[test]
    fn a_full_queue_makes_room_for_a_payer_and_refuses_the_rest() {
        let t = Instant::now();
        let p = PeerId::random();
        let payers = [p];
        let mut s: Slots<usize> = Slots::new(2, 1);
        assert!(matches!(s.ask(PeerId::random(), 0, t, rank(&payers)), Asked::Now(..)));
        assert!(matches!(s.ask(PeerId::random(), 1, t, rank(&payers)), Asked::Now(..)));
        let mut tickets = vec![];
        for i in 0..MAX_WAITING {
            let Asked::Waiting(ticket, None) = s.ask(PeerId::random(), 2 + i, t, rank(&payers)) else { panic!() };
            tickets.push(ticket);
        }
        assert!(matches!(s.ask(PeerId::random(), 99, t, rank(&payers)), Asked::Refused(99, BUSY)), "full, and none ranked below it");
        let Asked::Waiting(_, Some(out)) = s.ask(p, 100, t, rank(&payers)) else { panic!("room is made for a payer") };
        assert_eq!(out, 1 + MAX_WAITING, "the latest of the lowest ranked");
        assert_eq!(s.expire(tickets[0]), Some(2));
        assert_eq!(s.expire(tickets[0]), None, "once");
    }

    #[test]
    fn a_payer_ranks_by_bodies_paid_for_lately() {
        let mut payers = Payers::default();
        let (a, b) = (PeerId::random(), PeerId::random());
        let t = Instant::now();
        payers.paid(a, t);
        payers.paid(a, t);
        payers.paid(b, t);
        assert_eq!((payers.rank(&a, t), payers.rank(&b, t), payers.rank(&PeerId::random(), t)), (2, 1, 0));
        assert_eq!(payers.rank(&a, t + PAID_FOR), 0, "a payment long ago no longer ranks");
    }

    /// A free slot goes to the peer that paid for the most bodies within the hour (R7.29): one paying once every 59
    /// minutes all day has paid for one or two within any hour, never a running count of the day.
    #[test]
    fn a_payer_ranks_by_bodies_paid_for_within_the_hour_only() {
        let mut payers = Payers::default();
        let a = PeerId::random();
        let t = Instant::now();
        let gap = Duration::from_secs(59 * 60);
        for k in 0..24u32 {
            payers.paid(a, t + gap * k);
        }
        let last = t + gap * 23;
        assert_eq!(payers.rank(&a, last), 2, "the payment 59 minutes ago and this one");
        assert_eq!(payers.rank(&a, last + Duration::from_secs(60)), 1, "an hour on from the one before, only the last");
        assert!(payers.paid[&a].len() <= 2, "older payments are forgotten");
    }
}

#[cfg(test)]
#[path = "budget_tests.rs"]
mod budget_tests;
