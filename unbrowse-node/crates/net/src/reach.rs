//! Where a node can be reached from another machine. A node listens on every interface, and the addresses it hears
//! back from the swarm include ones no other machine can use: loopback, the unspecified address it bound, a link-local
//! address that means something only on one link. What it publishes (R1.15), and what it takes from a peer to dial
//! it again, is what is left once those are dropped. Private addresses stay: a LAN or a private network such as a
//! tailnet is exactly where other nodes may reach it.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use libp2p::multiaddr::Protocol;
use libp2p::Multiaddr;

/// The addresses to listen on for a node others dial: every interface, IPv4 and IPv6, TCP and QUIC, on one port.
pub fn listen_all(port: u16) -> Vec<Multiaddr> {
    let on = |ip: IpAddr| -> [Multiaddr; 2] {
        let base = Multiaddr::empty().with(match ip {
            IpAddr::V4(v4) => Protocol::Ip4(v4),
            IpAddr::V6(v6) => Protocol::Ip6(v6),
        });
        [base.clone().with(Protocol::Tcp(port)), base.with(Protocol::Udp(port)).with(Protocol::QuicV1)]
    };
    [on(Ipv4Addr::UNSPECIFIED.into()), on(Ipv6Addr::UNSPECIFIED.into())].into_iter().flatten().collect()
}

/// Whether another machine could dial `addr`. Its first IP, the node's own or, for a relayed address, the relay's,
/// must be one a packet from elsewhere can reach; an address with no IP isn't one the nodes dial (they don't resolve
/// names).
pub fn dialable(addr: &Multiaddr) -> bool {
    match addr.iter().next() {
        Some(Protocol::Ip4(ip)) => reachable_v4(ip),
        Some(Protocol::Ip6(ip)) => match ip.to_ipv4_mapped() {
            Some(v4) => reachable_v4(v4),
            None => reachable_v6(ip),
        },
        _ => false,
    }
}

fn reachable_v4(ip: Ipv4Addr) -> bool {
    // Link-local (169.254/16) is self-assigned when nothing else is, and means a different host on every link.
    !(ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() || ip.is_link_local())
}

fn reachable_v6(ip: Ipv6Addr) -> bool {
    // A link-local address (fe80::/10) needs the interface it is on to be dialled, and a multiaddr can't carry that.
    !(ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_unicast_link_local())
}

/// What a node publishes: the addresses its owner names first, in the owner's order, then those other nodes have
/// confirmed (AutoNAT, a relay's reservation), then its interface addresses; each only if another machine could dial
/// it, once, without a trailing `/p2p/<peer>` (the reader adds the peer ID it already knows). The swarm hands out the
/// last two in no fixed order, so each is sorted: the same addresses publish the same bytes, and cost no write.
pub fn published(announced: &[Multiaddr], confirmed: &[Multiaddr], listening: &[Multiaddr]) -> Vec<Multiaddr> {
    let bare = |a: &Multiaddr| {
        let mut a = a.clone();
        if matches!(a.iter().last(), Some(Protocol::P2p(_))) {
            a.pop();
        }
        a
    };
    let sorted = |xs: &[Multiaddr]| {
        let mut xs: Vec<Multiaddr> = xs.iter().map(bare).collect();
        xs.sort_by_key(|a| a.to_string());
        xs
    };
    let mut out: Vec<Multiaddr> = Vec::new();
    for a in announced.iter().map(bare).chain(sorted(confirmed)).chain(sorted(listening)) {
        if dialable(&a) && !out.contains(&a) {
            out.push(a);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addrs(xs: &[&str]) -> Vec<Multiaddr> {
        xs.iter().map(|x| x.parse().unwrap()).collect()
    }

    #[test]
    fn only_addresses_another_machine_could_dial_are_published() {
        let listening = addrs(&[
            "/ip4/127.0.0.1/tcp/4001",
            "/ip4/0.0.0.0/tcp/4001",
            "/ip6/::1/udp/4001/quic-v1",
            "/ip6/::/tcp/4001",
            "/ip4/169.254.10.2/tcp/4001",
            "/ip6/fe80::1/tcp/4001",
            "/ip4/224.0.0.1/tcp/4001",
            "/ip6/::ffff:127.0.0.1/tcp/4001",
            // A LAN, a carrier-grade NAT or tailnet range, and a global IPv6 address all reach other machines.
            "/ip4/192.168.1.20/tcp/4001",
            "/ip4/100.101.102.103/udp/4001/quic-v1",
            "/ip6/2001:db8::7/tcp/4001",
        ]);
        assert_eq!(
            published(&[], &[], &listening),
            addrs(&["/ip4/100.101.102.103/udp/4001/quic-v1", "/ip4/192.168.1.20/tcp/4001", "/ip6/2001:db8::7/tcp/4001"])
        );
        let mut shuffled = listening.clone();
        shuffled.reverse();
        assert_eq!(published(&[], &[], &shuffled), published(&[], &[], &listening), "the same addresses in any order publish alike");
    }

    #[test]
    fn named_and_confirmed_addresses_come_first_once_each() {
        let (me, relay) = (libp2p::PeerId::random(), libp2p::PeerId::random());
        let announced = addrs(&["/ip4/203.0.113.9/tcp/4001", "/ip4/127.0.0.1/tcp/4001"]);
        let confirmed = addrs(&[
            "/ip4/192.168.1.20/tcp/4001",
            &format!("/ip4/198.51.100.4/tcp/4001/p2p/{relay}/p2p-circuit/p2p/{me}"),
            &format!("/ip4/127.0.0.1/tcp/4001/p2p/{relay}/p2p-circuit/p2p/{me}"),
        ]);
        let listening = addrs(&["/ip4/192.168.1.20/tcp/4001", "/ip4/127.0.0.1/tcp/4001"]);
        assert_eq!(
            published(&announced, &confirmed, &listening),
            addrs(&[
                // An owner can't make the node publish loopback either.
                "/ip4/203.0.113.9/tcp/4001",
                "/ip4/192.168.1.20/tcp/4001",
                // A relayed address counts by the relay's IP, and drops the node's own peer ID.
                &format!("/ip4/198.51.100.4/tcp/4001/p2p/{relay}/p2p-circuit"),
            ])
        );
    }

    #[test]
    fn a_name_is_not_an_address_the_nodes_dial() {
        assert!(!dialable(&"/dns4/node.example/tcp/4001".parse().unwrap()));
        assert!(!dialable(&Multiaddr::empty()));
    }

    #[test]
    fn a_node_listens_on_every_interface_on_one_port() {
        assert_eq!(
            listen_all(4001),
            addrs(&["/ip4/0.0.0.0/tcp/4001", "/ip4/0.0.0.0/udp/4001/quic-v1", "/ip6/::/tcp/4001", "/ip6/::/udp/4001/quic-v1"])
        );
    }
}
