//! Which dials get a port of their own: by peer, yes; by address alone, no.

use super::*;

#[test]
fn a_dial_by_address_alone_is_left_as_it_is() {
    let addr: Multiaddr = "/ip4/127.0.0.1/tcp/4001".parse().unwrap();
    let opts = own_port(DialOpts::unknown_peer_id().address(addr).build());
    assert_eq!(opts.get_peer_id(), None);
}

#[test]
fn a_dial_by_peer_stays_a_dial_to_that_peer() {
    let peer = PeerId::random();
    assert_eq!(own_port(DialOpts::peer_id(peer).build()).get_peer_id(), Some(peer));
}

#[test]
fn a_port_wrapped_behaviour_hands_back_what_it_wraps() {
    let mut own = OwnPort::new(vec![1u8]);
    own.push(2);
    assert_eq!(own.len(), 2);
    assert_eq!(own.inner, vec![1, 2]);
}
