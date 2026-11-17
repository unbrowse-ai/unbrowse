//! Where a node sits in the table, and why it can't choose. A node's position is the hash of its peer ID, as stock
//! Kademlia has it. Peer IDs cost nothing to make, so left alone a node could grind keys until it sat among the few
//! peers closest to one site's key and hid that site's providers. Here a position must start with bits drawn from
//! the node's identity and a hash that only existed once the identity was registered, so aiming at a key means
//! registering identities until one lands near it.

use libp2p::identity::Keypair;
use libp2p::kad::KBucketKey;
use libp2p::PeerId;
use sha2::{Digest, Sha256};

/// A node's position in the table: the same 256 bits the routing table measures distance with.
pub fn position(peer: &PeerId) -> [u8; 32] {
    let key = KBucketKey::from(*peer);
    let mut out = [0u8; 32];
    out.copy_from_slice(key.hashed_bytes());
    out
}

/// The bits the `index`th node of an identity must start with: drawn from the identity and its anchor (the hash of
/// the block that registered it), which the identity's owner could not know when it chose its keys.
pub fn target(identity: &str, anchor: &[u8; 32], index: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"unbrowse/position/v1");
    h.update(identity.to_ascii_lowercase().as_bytes());
    h.update(anchor);
    h.update(index.to_be_bytes());
    h.finalize().into()
}

/// Whether the first `bits` bits of `a` and `b` agree.
pub fn shares_prefix(a: &[u8; 32], b: &[u8; 32], bits: u32) -> bool {
    let bits = bits.min(256) as usize;
    let (whole, rest) = (bits / 8, bits % 8);
    if a[..whole] != b[..whole] {
        return false;
    }
    rest == 0 || (a[whole] ^ b[whole]) >> (8 - rest) == 0
}

/// Whether a peer sits where its identity's `index`th node must.
pub fn placed(peer: &PeerId, identity: &str, anchor: &[u8; 32], index: u32, bits: u32) -> bool {
    shares_prefix(&position(peer), &target(identity, anchor, index), bits)
}

/// Makes keys until one sits where the identity's `index`th node must: about 2^bits tries, once per node.
pub fn grind(identity: &str, anchor: &[u8; 32], index: u32, bits: u32) -> Keypair {
    let want = target(identity, anchor, index);
    loop {
        let key = Keypair::generate_ed25519();
        if shares_prefix(&position(&key.public().to_peer_id()), &want, bits) {
            return key;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ground_key_sits_at_its_target_and_nowhere_else() {
        let anchor = [7u8; 32];
        let key = grind("0xabc", &anchor, 0, 10);
        let peer = key.public().to_peer_id();
        assert!(placed(&peer, "0xabc", &anchor, 0, 10));
        // Another identity, anchor or index draws other bits; a 10-bit match by chance is 1 in 1024 for each.
        let elsewhere = [placed(&peer, "0xabd", &anchor, 0, 10), placed(&peer, "0xabc", &[8u8; 32], 0, 10), placed(&peer, "0xabc", &anchor, 1, 10)];
        assert!(elsewhere.iter().filter(|x| **x).count() <= 1, "{elsewhere:?}");
    }

    #[test]
    fn the_position_is_the_one_the_routing_table_measures() {
        let peer = Keypair::generate_ed25519().public().to_peer_id();
        let expect: [u8; 32] = Sha256::digest(peer.to_bytes()).into();
        assert_eq!(position(&peer), expect);
    }

    #[test]
    fn prefixes_compare_bit_by_bit() {
        let a = [0b1010_0000u8; 32];
        let mut b = a;
        b[0] = 0b1011_0000;
        assert!(shares_prefix(&a, &b, 3));
        assert!(!shares_prefix(&a, &b, 4));
        assert!(shares_prefix(&a, &a, 256));
    }
}
