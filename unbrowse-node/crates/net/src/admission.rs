//! Which peers count. Meeting a peer is not trusting it: a peer enters the routing table, and its provider records
//! are kept, only once the registry shows its identity lists this peer ID and the peer sits where that identity's node
//! must. The handshake has already proved the peer holds its peer ID's key, so nobody can pose as a listed peer.

use std::future::Future;

use libp2p::{Multiaddr, PeerId};
use serde::{Deserialize, Serialize};

use crate::position;

/// What a peer says it is, asked for on every new connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    /// The identity that runs the node.
    pub identity: String,
    /// Which of the identity's nodes this is; it fixes the node's position.
    pub index: u32,
}

/// An identity as the registry holds it.
#[derive(Clone, Debug)]
pub struct Identity {
    pub id: String,
    /// The hash of the block that registered the identity.
    pub anchor: [u8; 32],
    /// Its nodes: peer ID and the addresses each listens on.
    pub nodes: Vec<(PeerId, Vec<Multiaddr>)>,
}

/// Where identities are read from: on Arc, ERC-8004 identities and their metadata; on a devnet, a stand-in.
pub trait Registry: Send + Sync + 'static {
    /// The identity with this id, if it is registered; an error when the registry couldn't be read. A peer whose
    /// identity couldn't be read is not judged on it: it is asked again soon, never refused as unregistered.
    fn identity(&self, id: &str) -> impl Future<Output = Result<Option<Identity>, String>> + Send;
    /// Registered nodes to make first contact with, when a node knows nobody.
    fn seeds(&self) -> impl Future<Output = Vec<(PeerId, Multiaddr)>> + Send;
}

/// The limits on where a node may sit.
#[derive(Clone, Copy, Debug)]
pub struct Rules {
    /// Bits of a node's position fixed by its identity.
    pub position_bits: u32,
    /// Nodes one identity may run.
    pub nodes_per_identity: u32,
}

/// Why a peer was turned away.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// No identity is registered under the id it gave.
    Unregistered,
    /// The identity is registered, but doesn't list this peer ID.
    NotItsNode,
    /// The identity may not run that many nodes.
    IndexTooHigh,
    /// The peer doesn't sit where the identity's node must.
    Misplaced,
    /// The peer runs a release older than the network takes, whatever the registry says of it.
    TooOld,
}

/// Whether `peer`, claiming `claim`, counts, given what the registry holds for the identity it named.
pub fn admit(peer: &PeerId, claim: &Claim, identity: Option<&Identity>, rules: Rules) -> Result<(), Refusal> {
    let identity = identity.ok_or(Refusal::Unregistered)?;
    if !identity.nodes.iter().any(|(p, _)| p == peer) {
        return Err(Refusal::NotItsNode);
    }
    if claim.index >= rules.nodes_per_identity {
        return Err(Refusal::IndexTooHigh);
    }
    // The peer is the identity's node at the index it claims, so one listed peer can't take every index in turn, and
    // only the first `nodes_per_identity` nodes the identity lists ever count, however long its list is.
    if identity.nodes.get(claim.index as usize).is_none_or(|(p, _)| p != peer) {
        return Err(Refusal::NotItsNode);
    }
    if !position::placed(peer, &identity.id, &identity.anchor, claim.index, rules.position_bits) {
        return Err(Refusal::Misplaced);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };

    fn registered(id: &str, peers: &[PeerId]) -> Identity {
        Identity { id: id.into(), anchor: [3u8; 32], nodes: peers.iter().map(|p| (*p, vec![])).collect() }
    }

    #[test]
    fn a_listed_and_placed_node_counts() {
        let peer = position::grind("0xa", &[3u8; 32], 2, 8).public().to_peer_id();
        let claim = Claim { identity: "0xa".into(), index: 2 };
        let others = [Keypair::generate_ed25519().public().to_peer_id(), Keypair::generate_ed25519().public().to_peer_id()];
        assert_eq!(admit(&peer, &claim, Some(&registered("0xa", &[others[0], others[1], peer])), RULES), Ok(()));
    }

    #[test]
    fn a_peer_its_identity_does_not_list_never_counts() {
        let peer = position::grind("0xa", &[3u8; 32], 0, 8).public().to_peer_id();
        let other = Keypair::generate_ed25519().public().to_peer_id();
        let claim = Claim { identity: "0xa".into(), index: 0 };
        assert_eq!(admit(&peer, &claim, None, RULES), Err(Refusal::Unregistered));
        assert_eq!(admit(&peer, &claim, Some(&registered("0xa", &[other])), RULES), Err(Refusal::NotItsNode));
    }

    /// A listed peer counts only at its own place in the identity's list: claiming another index is refused, and a
    /// node past the first `nodes_per_identity` of a long list never counts.
    #[test]
    fn a_peer_counts_only_at_its_own_index_in_a_capped_list() {
        let anchor = [3u8; 32];
        let at = |i: u32| position::grind("0xa", &anchor, i, 8).public().to_peer_id();
        let (p0, p1) = (at(0), at(1));
        let id = registered("0xa", &[p0, p1]);
        assert_eq!(admit(&p1, &Claim { identity: "0xa".into(), index: 1 }, Some(&id), RULES), Ok(()));
        assert_eq!(admit(&p1, &Claim { identity: "0xa".into(), index: 0 }, Some(&id), RULES), Err(Refusal::NotItsNode), "p1 is not the identity's node 0");
        // A key placed for index 2, listed fifth: past the cap of four only its own index could admit it, and it isn't there.
        let p2 = at(2);
        let long = registered("0xa", &[p0, p1, at(3), at(3), p2]);
        assert_eq!(admit(&p2, &Claim { identity: "0xa".into(), index: 2 }, Some(&long), RULES), Err(Refusal::NotItsNode));
    }

    #[test]
    fn a_node_can_neither_choose_its_position_nor_add_indexes_to_find_one() {
        let anchor = [3u8; 32];
        let free = loop {
            // A key that sits where index 0 must not: the kind a node grinding toward a site's key would hold.
            let k = Keypair::generate_ed25519().public().to_peer_id();
            if !position::placed(&k, "0xa", &anchor, 0, 8) {
                break k;
            }
        };
        let id = registered("0xa", &[free]);
        assert_eq!(admit(&free, &Claim { identity: "0xa".into(), index: 0 }, Some(&id), RULES), Err(Refusal::Misplaced));
        assert_eq!(admit(&free, &Claim { identity: "0xa".into(), index: 4 }, Some(&id), RULES), Err(Refusal::IndexTooHigh));
    }
}
