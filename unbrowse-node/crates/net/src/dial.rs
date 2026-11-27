//! Every dial a behaviour asks for by peer opens a port of its own (`OwnPort`), as every dial the node makes itself
//! does (`node.rs`).
//!
//! libp2p dials over TCP from the port the node listens on unless told otherwise. Two dials between the same pair of
//! listening ports are then the same connection: two nodes that dial each other at the same moment open one TCP
//! connection from both ends, which neither can secure, and once that has happened every later dial between them
//! finds the pair of ports still taken (`AddrInUse`) until the operating system lets the dead connection go, minutes
//! later. Nodes that boot together meet each other through the table on one schedule, so the table's own dials cross,
//! and from then on the two can't reach each other at all. With a port of its own, each dial is a connection of its
//! own, and dials that cross are two connections that both succeed.
//!
//! The behaviours that set up reachability keep dialling from the listening port: hole punching (DCUtR) needs both
//! ends to dial from the ports others see them at, and AutoNAT and the relay client dial on its behalf.

use std::task::{Context, Poll};

use libp2p::core::transport::PortUse;
use libp2p::core::Endpoint;
use libp2p::swarm::dial_opts::{DialOpts, PeerCondition};
use libp2p::swarm::{ConnectionDenied, ConnectionId, FromSwarm, NetworkBehaviour, THandler, THandlerInEvent, THandlerOutEvent, ToSwarm};
use libp2p::{Multiaddr, PeerId};

/// A behaviour whose dials by peer each open a port of their own. Everything else passes through unchanged.
pub(crate) struct OwnPort<B> {
    pub inner: B,
}

impl<B> OwnPort<B> {
    pub(crate) fn new(inner: B) -> OwnPort<B> {
        OwnPort { inner }
    }
}

impl<B> std::ops::Deref for OwnPort<B> {
    type Target = B;
    fn deref(&self) -> &B {
        &self.inner
    }
}

impl<B> std::ops::DerefMut for OwnPort<B> {
    fn deref_mut(&mut self) -> &mut B {
        &mut self.inner
    }
}

/// The dial a behaviour asked for, as one from a port of its own. A dial by peer (all Kademlia and request-response
/// make) is made again with the same condition the behaviours give, the addresses coming, as before, from asking every
/// behaviour, the one that dials among them; one by address alone is left as it is.
fn own_port(opts: DialOpts) -> DialOpts {
    match opts.get_peer_id() {
        Some(peer) => DialOpts::peer_id(peer).condition(PeerCondition::Disconnected).allocate_new_port().build(),
        None => opts,
    }
}

impl<B: NetworkBehaviour> NetworkBehaviour for OwnPort<B> {
    type ConnectionHandler = THandler<B>;
    type ToSwarm = B::ToSwarm;

    fn handle_pending_inbound_connection(&mut self, id: ConnectionId, local: &Multiaddr, remote: &Multiaddr) -> Result<(), ConnectionDenied> {
        self.inner.handle_pending_inbound_connection(id, local, remote)
    }

    fn handle_established_inbound_connection(&mut self, id: ConnectionId, peer: PeerId, local: &Multiaddr, remote: &Multiaddr) -> Result<THandler<Self>, ConnectionDenied> {
        self.inner.handle_established_inbound_connection(id, peer, local, remote)
    }

    fn handle_pending_outbound_connection(&mut self, id: ConnectionId, peer: Option<PeerId>, addrs: &[Multiaddr], role: Endpoint) -> Result<Vec<Multiaddr>, ConnectionDenied> {
        self.inner.handle_pending_outbound_connection(id, peer, addrs, role)
    }

    fn handle_established_outbound_connection(&mut self, id: ConnectionId, peer: PeerId, addr: &Multiaddr, role: Endpoint, port_use: PortUse) -> Result<THandler<Self>, ConnectionDenied> {
        self.inner.handle_established_outbound_connection(id, peer, addr, role, port_use)
    }

    fn on_swarm_event(&mut self, event: FromSwarm) {
        self.inner.on_swarm_event(event)
    }

    fn on_connection_handler_event(&mut self, peer: PeerId, id: ConnectionId, event: THandlerOutEvent<Self>) {
        self.inner.on_connection_handler_event(peer, id, event)
    }

    fn poll(&mut self, cx: &mut Context<'_>) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        match self.inner.poll(cx) {
            Poll::Ready(ToSwarm::Dial { opts }) => Poll::Ready(ToSwarm::Dial { opts: own_port(opts) }),
            other => other,
        }
    }
}

#[cfg(test)]
#[path = "dial_tests.rs"]
mod dial_tests;
