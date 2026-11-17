//! The node's ERC-8004 identity (R1.14–R1.16): one identity per wallet, registered once in Arc's IdentityRegistry.
//! Its metadata says where the owner's nodes are, which is how other nodes find them and decide they count (R1.15,
//! spec §53).
//!
//! R1.15 names the metadata keys; how their values are written is set here. `unbrowse.peerId` is a JSON array of
//! peer IDs, one per node, at the node's index; `unbrowse.addrs` is the matching array of address lists;
//! `unbrowse.version` is the client's version; `unbrowse.registeredAt` is the block the identity was registered in.
//! The last is a pointer, never trusted: a reader finds the identity's `Registered` event in that very block, and that
//! block's hash is the anchor that fixes where the identity's nodes sit (`unbrowse_net::position`). Nobody could know
//! it while choosing keys, and the identity can't move it.

use alloy::primitives::{keccak256, Address, B256, U256};
use alloy::providers::Provider;
use alloy::rpc::types::Filter;
use alloy::sol;
use alloy::sol_types::SolEvent;
use serde::{Deserialize, Serialize};
use unbrowse_core::KeyStore;
use unbrowse_net::{Identity, Multiaddr, PeerId, Registry};

use crate::inflight::{self, Settled};
use crate::rpc::{once, ProviderBuilder};
use crate::{arc, chain, store};

sol! {
    #[sol(rpc)]
    interface IdentityRegistry {
        function register(string agentURI) external returns (uint256 agentId);
        function setAgentURI(uint256 agentId, string newURI) external;
        function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external;
        function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes);
        function tokenURI(uint256 tokenId) external view returns (string);
        function ownerOf(uint256 tokenId) external view returns (address);
        function balanceOf(address owner) external view returns (uint256);
        event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
        event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    }
}

pub const PEER_ID: &str = "unbrowse.peerId";
pub const ADDRS: &str = "unbrowse.addrs";
pub const VERSION: &str = "unbrowse.version";
pub const REGISTERED_AT: &str = "unbrowse.registeredAt";

/// The owner's identity on one chain.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Registration {
    pub chain_id: u64,
    pub registry: String,
    pub owner: String,
    /// The identity, as the decimal `agentId`.
    pub agent_id: String,
    pub block: u64,
    /// The hash of the block the identity was registered in.
    pub anchor: B256,
}

/// Where the owner's identity on this chain is kept. A devnet that forks Arc testnet has its chain ID and registry
/// address, so an identity on a live network is kept apart from the devnet's: the fork's is unknown to the network.
fn saved_path(chain: &chain::Chain, owner: Address) -> std::path::PathBuf {
    let name = format!("erc8004-{owner:#x}.json");
    match chain.network() {
        Some(net) => store::home().join(net.name).join(name),
        None => store::home().join(name),
    }
}

/// The ERC-8004 registry of the chain the node is on, if it has one: an Arc network, or a devnet that forks one.
pub fn registry_of(chain: &chain::Chain) -> Option<&'static arc::Network> {
    chain.chain_id().ok().and_then(arc::by_chain_id)
}

/// Held while the owner's identity is found or registered: two callers at once (the node joining the network, the
/// owner listing a route) would each find none and each register one.
static ENSURING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The owner's identity on this chain, registering it the first time: one identity per owner, ever. The registration
/// file is a copy of what the chain says; when it is missing (a crash after registering, a write that failed, a disk
/// that filled), the chain is asked whether the owner already holds an identity before another is registered. The
/// registration is one write, paid by the node's own key; its metadata, the registering block's
/// pointer with it, is the second (`publish`), once the node knows its peer ID.
pub async fn ensure(chain: &chain::Chain, keys: &(dyn KeyStore + Sync), name: &str) -> Result<Registration, String> {
    let _one = ENSURING.lock().await;
    let chain_id = chain.chain_id()?;
    let net = arc::by_chain_id(chain_id).ok_or("this chain has no ERC-8004 registry")?;
    let signer = chain::owner_signer(keys)?;
    let owner = signer.address();
    let saved: Registration = store::read_json(&saved_path(chain, owner), &unbrowse_files::ERC8004);
    if saved.chain_id == chain_id && saved.registry == format!("{:#x}", net.identity) && !saved.agent_id.is_empty() {
        // The file is a copy, and an identity is an ERC-721 that can move. A chain that doesn't answer leaves it standing:
        // the node starts offline on what it knows.
        return match holder(net.identity, &saved.agent_id).await {
            Some(now) if now != owner => Err(moved_away(&saved.agent_id, now)),
            _ => Ok(saved),
        };
    }
    // A chain that only says it is an Arc network (an RPC that isn't one) has no registry to register in.
    if provider().get_code_at(net.identity).await.map_err(|e| e.to_string())?.is_empty() {
        return Err(format!("there's no ERC-8004 registry at {:#x} on this chain", net.identity));
    }
    let p = chain::as_signer(signer).await?;
    let reg = IdentityRegistry::new(net.identity, &p);
    // A registration that is out shows in no balance yet, so the registry alone would say to register again: an owner
    // has one identity, ever.
    let found = match inflight::settle(&p, REGISTERING).await? {
        Settled::Waiting(s) => return Err(format!("registering the identity ({:#x}) isn't mined yet, so nothing more was sent: the node looks at it again each pass", s.tx)),
        Settled::Landed(_, receipt) => Some(registered(&receipt)?),
        Settled::Clear => match held_by(net.identity, owner, chain.registry_from()?).await? {
            Some(found) => Some(found),
            None => {
                no_second(net.identity, owner, chain.registry_from()?).await?;
                None
            }
        },
    };
    let (agent_id, block, anchor) = match found {
        Some(found) => found,
        None => {
            let uri = registration_file(name, None);
            // What a registration changes: how many identities the registry holds for the owner.
            let watch = (net.identity, reg.balanceOf(owner).calldata().clone());
            let receipt = once!(reg.register(uri), REGISTERING, 0.0, None, watch, "registering the identity");
            if !receipt.status() {
                return Err("registering the identity was reverted".into());
            }
            registered(&receipt)?
        }
    };
    let r = Registration {
        chain_id,
        registry: format!("{:#x}", net.identity),
        owner: format!("{owner:#x}"),
        agent_id: agent_id.to_string(),
        block,
        anchor,
    };
    store::write_json(&saved_path(chain, owner), &unbrowse_files::ERC8004, &r)?;
    inflight::done(REGISTERING)?;
    Ok(r)
}

/// Who holds identity `agent_id` now, if the chain answers.
async fn holder(registry: Address, agent_id: &str) -> Option<Address> {
    let p = provider();
    IdentityRegistry::new(registry, &p).ownerOf(agent_id.parse().ok()?).call().await.ok()
}

fn moved_away(agent_id: &str, now: Address) -> String {
    format!("identity {agent_id} is held by {now:#x} now, and an owner has one identity, ever, so no second one was registered: transfer it back to go on")
}

/// Refuses a registration that would give `owner` a second identity, for an owner with no identity `held_by` can find.
/// That leaves two ways it may still have had one: it registered one and moved it away, or it holds one someone else
/// registered, which `held_by`'s read of `Registered` can't see. Either way the registry would take a second, and an
/// owner has one identity, ever (`ensure`). Asked only before a registration, so its read of the logs is rare.
async fn no_second(registry: Address, owner: Address, from: u64) -> Result<(), String> {
    let p = provider();
    let reg = IdentityRegistry::new(registry, &p);
    if !reg.balanceOf(owner).call().await.map_err(|e| e.to_string())?.is_zero() {
        return Err(format!("{owner:#x} holds an identity it didn't register, so no second one was registered: this node can't take on one that was transferred to it"));
    }
    let filter = Filter::new().address(registry).event_signature(IdentityRegistry::Registered::SIGNATURE_HASH).topic2(owner.into_word());
    for log in chain::logs(&p, filter, from, None).await? {
        let Ok(event) = IdentityRegistry::Registered::decode_log(&log.inner) else { continue };
        let now = reg.ownerOf(event.agentId).call().await.map_err(|e| e.to_string())?;
        return Err(moved_away(&event.agentId.to_string(), now));
    }
    Ok(())
}

/// What a registration is kept under while it is out (`inflight`).
const REGISTERING: &str = "identity";

/// The identity a mined registration made, with its block and that block's hash.
fn registered(receipt: &alloy::rpc::types::TransactionReceipt) -> Result<(U256, u64, B256), String> {
    let event = receipt.inner.logs().iter().find_map(|l| IdentityRegistry::Registered::decode_log(&l.inner).ok()).ok_or("the registry didn't say which identity it made")?;
    let block = receipt.block_number.ok_or("no block for the registration")?;
    let anchor = receipt.block_hash.ok_or("no block hash for the registration")?;
    Ok((event.agentId, block, anchor))
}

/// The identity `owner` registered and still holds, with the block it was registered in and that block's hash, if
/// there is one: the first such, from its `Registered` event. The registry is an ERC-721, so an owner holding none is
/// told by its balance without reading any events.
/// The identity `owner` holds on this chain's registry, if any, as its decimal `agentId`.
pub async fn identity_of(chain: &chain::Chain, owner: Address) -> Result<Option<String>, String> {
    let Some(net) = registry_of(chain) else { return Ok(None) };
    Ok(held_by(net.identity, owner, chain.registry_from()?).await?.map(|(id, _, _)| id.to_string()))
}

async fn held_by(registry: Address, owner: Address, from: u64) -> Result<Option<(U256, u64, B256)>, String> {
    let p = provider();
    let reg = IdentityRegistry::new(registry, &p);
    if reg.balanceOf(owner).call().await.is_ok_and(|n| n.is_zero()) {
        return Ok(None);
    }
    let filter = Filter::new().address(registry).event_signature(IdentityRegistry::Registered::SIGNATURE_HASH).topic2(owner.into_word());
    for log in chain::logs(&p, filter, from, None).await? {
        let Ok(event) = IdentityRegistry::Registered::decode_log(&log.inner) else { continue };
        let (Some(block), Some(hash)) = (log.block_number, log.block_hash) else { continue };
        if reg.ownerOf(event.agentId).call().await.map_err(|e| e.to_string())? == owner {
            return Ok(Some((event.agentId, block, hash)));
        }
    }
    Ok(None)
}

/// The ERC-8004 registration file, as a data URI: the identity's name, its node's libp2p endpoint once it has one,
/// and the trust models it supports (R1.15).
fn registration_file(name: &str, libp2p: Option<&str>) -> String {
    let services: Vec<serde_json::Value> =
        libp2p.map(|e| serde_json::json!({ "name": "libp2p", "endpoint": e })).into_iter().collect();
    let file = serde_json::json!({
        "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        "name": name,
        "services": services,
        "supportedTrust": ["reputation", "crypto-economic"],
    });
    format!("data:application/json,{}", percent_encoding::utf8_percent_encode(&file.to_string(), percent_encoding::NON_ALPHANUMERIC))
}

/// Says where the owner's node is: the block its identity was registered in, its peer ID and addresses at index 0, its
/// client's version, and its libp2p endpoint in the registration file. A value already on chain is not written again.
/// What changed goes as one write (`rpc::batch`, through Multicall3From where the chain runs it).
pub async fn publish(keys: &(dyn KeyStore + Sync), r: &Registration, name: &str, peer: &PeerId, addrs: &[String]) -> Result<(), String> {
    use alloy::sol_types::SolCall;
    let p = chain::as_signer(chain::owner_signer(keys)?).await?;
    let registry: Address = r.registry.parse().map_err(|e| format!("{e}"))?;
    let reg = IdentityRegistry::new(registry, &p);
    let id: U256 = r.agent_id.parse().map_err(|e| format!("{e}"))?;
    // The pointer to the registering block is written with the rest; an identity found on the chain may have been left
    // without it by a write that failed.
    let want = [
        (REGISTERED_AT, r.block.to_string().into_bytes()),
        (PEER_ID, serde_json::to_vec(&[peer.to_string()]).map_err(|e| e.to_string())?),
        (ADDRS, serde_json::to_vec(&[addrs]).map_err(|e| e.to_string())?),
        (VERSION, env!("CARGO_PKG_VERSION").as_bytes().to_vec()),
    ];
    let mut calls = Vec::new();
    for (key, value) in want {
        let now = reg.getMetadata(id, key.into()).call().await.map_err(|e| e.to_string())?;
        if now.as_ref() != value.as_slice() {
            calls.push((registry, IdentityRegistry::setMetadataCall { agentId: id, metadataKey: key.into(), metadataValue: value.into() }.abi_encode().into()));
        }
    }
    let endpoint = addrs.first().map(|a| format!("{a}/p2p/{peer}"));
    let uri = registration_file(name, endpoint.as_deref());
    if reg.tokenURI(id).call().await.ok().as_deref() != Some(uri.as_str()) {
        calls.push((registry, IdentityRegistry::setAgentURICall { agentId: id, newURI: uri }.abi_encode().into()));
    }
    for receipt in crate::rpc::batch(&p, calls, "saying where the identity's node is").await? {
        if !receipt.status() {
            return Err("saying where the identity's node is was reverted".into());
        }
    }
    Ok(())
}

/// The wallet that holds an identity now: the registry is an ERC-721, so an identity's owner is its token's. A listing
/// is signed by this wallet's key (R2.15).
pub async fn owner_of(registry: Address, agent_id: &str) -> Result<Address, String> {
    let id: U256 = agent_id.parse().map_err(|_| format!("{agent_id} isn't an agentId"))?;
    let p = provider();
    IdentityRegistry::new(registry, &p).ownerOf(id).call().await.map_err(|e| format!("reading who holds identity {agent_id}: {e}"))
}

/// The registry as the peer network reads it: an identity is its ERC-8004 metadata, and its anchor the hash of the
/// block its `Registered` event is in.
pub struct Erc8004Registry {
    pub registry: Address,
    /// Where to start reading registrations for first contact: the devnet's first block, or the protocol's on Arc.
    pub from_block: u64,
    /// The identities that have said where a node of theirs is, as far as the registry's logs have been read.
    scanned: tokio::sync::Mutex<Scanned>,
}

/// How far the seeds read has got: the next block to read from, and every identity found before it.
#[derive(Default)]
struct Scanned {
    next: u64,
    ids: std::collections::BTreeSet<U256>,
}

/// How many blocks the seeds read takes at a time before it marks how far it got (a few of `chain::logs`' windows).
const SEED_STEP: u64 = 100_000;

impl Erc8004Registry {
    pub fn new(registry: Address, from_block: u64) -> Self {
        Self { registry, from_block, scanned: Default::default() }
    }

    /// Every identity whose nodes the registry has named, reading on from where the last read stopped. The first read on
    /// Arc covers hundreds of thousands of blocks, about a hundred requests; a node that meets no one reads the seeds
    /// again every round, and reading them all again each time ran into the RPC's rate limit and came back with
    /// nothing, so the node never met anyone. Each step it completes is kept, and a step that fails is read again next
    /// round, from where it stopped.
    async fn seed_ids(&self, p: &impl Provider) -> Vec<U256> {
        let mut s = self.scanned.lock().await;
        let filter = Filter::new()
            .address(self.registry)
            .event_signature(IdentityRegistry::MetadataSet::SIGNATURE_HASH)
            .topic2(keccak256(PEER_ID));
        match p.get_block_number().await {
            Err(e) => eprintln!("peers: couldn't read the chain's head for the registry's nodes, read again next round: {e}"),
            Ok(head) => {
                let mut from = s.next.max(self.from_block);
                while from <= head {
                    let to = from.saturating_add(SEED_STEP - 1).min(head);
                    match chain::logs(p, filter.clone(), from, Some(to)).await {
                        Ok(logs) => {
                            s.ids.extend(logs.iter().filter_map(|l| l.topics().get(1).map(|t| U256::from_be_bytes(t.0))));
                            from = to + 1;
                            s.next = from;
                        }
                        Err(e) => {
                            eprintln!("peers: read the registry's nodes up to block {from}, read on from there next round: {e}");
                            break;
                        }
                    }
                }
            }
        }
        s.ids.iter().copied().collect()
    }
}

fn provider() -> impl alloy::providers::Provider + Clone {
    ProviderBuilder::new().connect_http(chain::url())
}

/// Whether a call failed because the chain couldn't be reached, rather than because it answered: an RPC that answers
/// with an error (a revert, an id that isn't one) has said something about the identity; one that never answers has
/// said nothing.
fn unreachable(e: &alloy::contract::Error) -> bool {
    matches!(e, alloy::contract::Error::TransportError(t) if !t.is_error_resp())
}

impl Erc8004Registry {
    /// The identity `id`, `None` when the registry holds no node of it there, an error when the chain couldn't be read.
    async fn read(&self, id: U256) -> Result<Option<Identity>, String> {
        let p = provider();
        let reg = IdentityRegistry::new(self.registry, &p);
        let text = |b: alloy::primitives::Bytes| String::from_utf8(b.to_vec()).ok();
        let meta = |key: &'static str| {
            let reg = &reg;
            async move {
                match reg.getMetadata(id, key.into()).call().await {
                    Ok(b) => Ok(text(b)),
                    Err(e) if unreachable(&e) => Err(e.to_string()),
                    Err(_) => Ok(None),
                }
            }
        };
        let Some(at) = meta(REGISTERED_AT).await?.and_then(|t| t.parse::<u64>().ok()) else { return Ok(None) };
        let Some(peers) = meta(PEER_ID).await?.and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok()) else { return Ok(None) };
        let addrs: Vec<Vec<String>> = meta(ADDRS).await?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        // The pointer is checked, never trusted: the identity's own registration must be in that block.
        let filter = Filter::new()
            .address(self.registry)
            .event_signature(IdentityRegistry::Registered::SIGNATURE_HASH)
            .topic1(B256::from(id));
        let found = chain::logs(&p, filter, at, Some(at)).await?;
        let Some(anchor) = found.first().and_then(|l| l.block_hash) else { return Ok(None) };
        // A node's place in the list is its index (`admission::admit`), so a peer id that doesn't read ends the list
        // there rather than moving the nodes after it into its place.
        let nodes = peers
            .iter()
            .enumerate()
            .map_while(|(i, peer)| {
                let addrs: Vec<Multiaddr> = addrs.get(i).into_iter().flatten().filter_map(|a| a.parse().ok()).collect();
                Some((peer.parse().ok()?, addrs))
            })
            .collect();
        Ok(Some(Identity { id: id.to_string(), anchor: anchor.0, nodes }))
    }
}

impl Registry for Erc8004Registry {
    async fn identity(&self, id: &str) -> Result<Option<Identity>, String> {
        let Ok(id) = id.parse() else { return Ok(None) };
        self.read(id).await
    }

    /// Every identity that said where a node of its is, since `from_block` (`seed_ids`). One that can't be read now is
    /// left out: a node that finds nobody reads the seeds again.
    async fn seeds(&self) -> Vec<(PeerId, Multiaddr)> {
        let ids = self.seed_ids(&provider()).await;
        let mut out = Vec::new();
        for id in ids {
            if let Ok(Some(identity)) = self.read(id).await {
                for (peer, addrs) in identity.nodes {
                    out.extend(addrs.into_iter().map(|a| (peer, a)));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testchain;

    /// The seeds read goes on from where it stopped: a step the RPC refused is read again next round from its first
    /// block, and what was found before it is kept, so a node never starts its read of the whole registry over.
    #[tokio::test]
    async fn the_seeds_read_goes_on_from_where_it_stopped() {
        let sig = IdentityRegistry::MetadataSet::SIGNATURE_HASH;
        let key = keccak256(PEER_ID);
        let head = |n: u64| (200, format!(r#"{{"jsonrpc":"2.0","id":0,"result":"{n:#x}"}}"#));
        let found = |id: u64| {
            let log = format!(
                r#"{{"address":"0x8004a818bfb912233c491871b3d84c89a494bd9e","topics":["{sig}","{:#066x}","{key}"],"data":"0x","blockNumber":"0x60","blockHash":"{:#066x}","transactionHash":"{:#066x}","transactionIndex":"0x0","logIndex":"0x0","removed":false}}"#,
                id, 1, 2
            );
            (200, format!(r#"{{"jsonrpc":"2.0","id":0,"result":[{log}]}}"#))
        };
        let refused = (200, r#"{"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"query failed"}}"#.to_string());
        let _one = testchain::one_at_a_time().await;
        let (url, taken) = crate::rpc::tests::scripted_rpc(vec![head(100), found(7), head(102), refused, head(102), found(9), head(102)]).await;
        // Logs are read from the node's own RPC, each answer bounded (`chain::logs`): the scripted one, here.
        let _env = testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", url.port().unwrap().to_string())]);
        let p = crate::rpc::ProviderBuilder::new().connect_http(url);
        let reg = Erc8004Registry::new(Address::repeat_byte(0x80), 95);

        assert_eq!(reg.seed_ids(&p).await, vec![U256::from(7)], "blocks 95 to 100");
        assert_eq!(reg.scanned.lock().await.next, 101);
        assert_eq!(reg.seed_ids(&p).await, vec![U256::from(7)], "the step that failed keeps what was found before it");
        assert_eq!(reg.scanned.lock().await.next, 101, "and is read again from its first block");
        assert_eq!(reg.seed_ids(&p).await, vec![U256::from(7), U256::from(9)]);
        assert_eq!(reg.scanned.lock().await.next, 103);
        assert_eq!(reg.seed_ids(&p).await, vec![U256::from(7), U256::from(9)], "nothing new: only the head is read");
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 7);
    }

    /// The `Registered` events the registry holds for `owner`.
    async fn registrations(registry: Address, owner: Address) -> usize {
        let f = Filter::new().address(registry).event_signature(IdentityRegistry::Registered::SIGNATURE_HASH).topic2(owner.into_word()).from_block(0);
        provider().get_logs(&f).await.unwrap().len()
    }

    /// The owner's identity is registered once, whoever asks for it at once (the node joining the network, the owner
    /// listing a route), and however its registration file is lost (a crash after registering, a write that failed):
    /// the chain is asked before another is registered. An identity left without its registering block's pointer gets
    /// it. `cargo test -p unbrowse-node-app erc8004 -- --ignored`
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn one_erc8004_identity_per_owner() {
        let _one = testchain::one_at_a_time().await;
        let home = testchain::home("erc8004-once");
        let anvil = testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
        anvil.with_registry().await;
        let n = testchain::node("a");
        testchain::on_arc_devnet(&n, anvil.port);
        let keys = n.keys.as_ref();
        let owner = chain::owner_address(keys).unwrap();
        let registry = arc::ARC_TESTNET.identity;

        let (a, b) = futures_util::future::join(ensure(&n.chain, keys, "a"), ensure(&n.chain, keys, "a")).await;
        let (a, b) = (a.expect("the first caller"), b.expect("the second caller"));
        assert_eq!(a.agent_id, b.agent_id);
        assert_eq!(registrations(registry, owner).await, 1);

        std::fs::remove_file(saved_path(&n.chain, owner)).unwrap();
        let again = ensure(&n.chain, keys, "a").await.unwrap();
        assert_eq!((again.agent_id.as_str(), again.block, again.anchor), (a.agent_id.as_str(), a.block, a.anchor), "the same identity, read from the chain");
        assert_eq!(registrations(registry, owner).await, 1);

        // Registered, and stopped before saying where: the identity is found, and the pointer is written with the rest
        // of where the node is.
        let other = testchain::node("b");
        let them = chain::owner_address(other.keys.as_ref()).unwrap();
        let p = chain::as_signer(chain::owner_signer(other.keys.as_ref()).unwrap()).await.unwrap();
        let receipt = IdentityRegistry::new(registry, &p).register("data:,".into()).send().await.unwrap().get_receipt().await.unwrap();
        let found = ensure(&n.chain, other.keys.as_ref(), "b").await.unwrap();
        assert_eq!(found.block, receipt.block_number.unwrap());
        assert_eq!(registrations(registry, them).await, 1);
        let peer = PeerId::random();
        publish(other.keys.as_ref(), &found, "b", &peer, &["/ip4/127.0.0.1/tcp/4001".into()]).await.unwrap();
        let at = IdentityRegistry::new(registry, &provider()).getMetadata(found.agent_id.parse().unwrap(), REGISTERED_AT.into()).call().await.unwrap();
        assert_eq!(at.as_ref(), found.block.to_string().as_bytes());
        drop(anvil);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The stand-in registry's `ownerOf` and `balanceOf` moved as an ERC-721 transfer moves them: it has no transfer of
    /// its own, and the node reads only these.
    async fn transfer(rpc: &str, id: u64, from: Address, to: Address) {
        use alloy::sol_types::SolValue;
        let p = ProviderBuilder::new().connect_http(rpc.parse().unwrap());
        let slot = |key: Vec<u8>| alloy::primitives::keccak256(key);
        let word = |x: U256| B256::from(x);
        let set = |at: B256, value: B256| {
            let p = p.clone();
            async move {
                let _: serde_json::Value = p.raw_request("anvil_setStorageAt".into(), (arc::ARC_TESTNET.identity, at, value)).await.unwrap();
            }
        };
        set(slot((U256::from(id), U256::from(1)).abi_encode()), to.into_word()).await;
        set(slot((from, U256::from(2)).abi_encode()), word(U256::ZERO)).await;
        set(slot((to, U256::from(2)).abi_encode()), word(U256::from(1))).await;
    }

    /// An identity moved away isn't this owner's any more, whatever the file says, and the registry would gladly take a
    /// second: the node says so instead, with the file or without it, and so does the wallet it moved to.
    /// `cargo test -p unbrowse-node-app an_identity_moved_away -- --ignored`
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn an_identity_moved_away_is_said_and_never_registered_over() {
        let _one = testchain::one_at_a_time().await;
        let home = testchain::home("erc8004-moved");
        let anvil = testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
        anvil.with_registry().await;
        let n = testchain::node("a");
        testchain::on_arc_devnet(&n, anvil.port);
        let keys = n.keys.as_ref();
        let owner = chain::owner_address(keys).unwrap();
        let other = testchain::node("b");
        let them = chain::owner_address(other.keys.as_ref()).unwrap();
        let registry = arc::ARC_TESTNET.identity;
        let first = ensure(&n.chain, keys, "a").await.unwrap();
        transfer(&anvil.url(), first.agent_id.parse().unwrap(), owner, them).await;

        let said = ensure(&n.chain, keys, "a").await.unwrap_err();
        assert!(said.contains("held by"), "the file isn't taken over the chain: {said}");
        std::fs::remove_file(saved_path(&n.chain, owner)).unwrap();
        let said = ensure(&n.chain, keys, "a").await.unwrap_err();
        assert!(said.contains("held by"), "and with the file gone: {said}");
        assert_eq!(registrations(registry, owner).await, 1, "no second identity");

        let said = ensure(&n.chain, other.keys.as_ref(), "b").await.unwrap_err();
        assert!(said.contains("didn't register"), "the wallet it moved to registers none either: {said}");
        assert_eq!(registrations(registry, them).await, 0);
        drop(anvil);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_registration_file_names_the_libp2p_endpoint_once_there_is_one() {
        let decode = |uri: String| -> serde_json::Value {
            let body = uri.strip_prefix("data:application/json,").unwrap();
            serde_json::from_str(&percent_encoding::percent_decode_str(body).decode_utf8().unwrap()).unwrap()
        };
        let before = decode(registration_file("a node", None));
        assert_eq!(before["services"], serde_json::json!([]));
        assert_eq!(before["supportedTrust"], serde_json::json!(["reputation", "crypto-economic"]));
        let after = decode(registration_file("a node", Some("/ip4/127.0.0.1/tcp/4001/p2p/12D3Koo")));
        assert_eq!(after["services"][0]["endpoint"], "/ip4/127.0.0.1/tcp/4001/p2p/12D3Koo");
    }
}
