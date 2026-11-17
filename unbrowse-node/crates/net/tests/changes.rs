//! Change notices over gossipsub, between nodes on one machine over real TCP: a node that watches a site meets the node
//! that lists it and hears its notice within seconds; a notice from a node the registry doesn't admit, or one forged in
//! the lister's name, never reaches the node, and the lister's next notice still does.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use libp2p::gossipsub::{self, MessageAuthenticity, ValidationMode, Version};
use libp2p::swarm::SwarmEvent;
use libp2p::{noise, tcp, yamux};
use tokio::sync::mpsc;
use unbrowse_net::changes::{topic, CHANGES_PROTOCOL};
use unbrowse_net::{grind, Change, ChangeKind, Claim, Config, Heard, Identity, Listing, Listings, Multiaddr, Net, PeerId, Registry, Rules};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };
const SITE: &str = "example.com";

fn entry(n: u8) -> String {
    format!("0x{n:064x}")
}

#[derive(Default)]
struct Reg(Mutex<HashMap<String, Identity>>);

impl Registry for Reg {
    async fn identity(&self, id: &str) -> Result<Option<Identity>, String> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    async fn seeds(&self) -> Vec<(PeerId, Multiaddr)> {
        let ids = self.0.lock().unwrap();
        ids.values().flat_map(|i| i.nodes.iter().flat_map(|(p, a)| a.iter().map(|a| (*p, a.clone())))).collect()
    }
}

struct NoListings;

impl Listings for NoListings {
    async fn site(&self, _: &str) -> Vec<Listing> {
        vec![]
    }
}

fn anchor(id: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..id.len().min(32)].copy_from_slice(&id.as_bytes()[..id.len().min(32)]);
    a
}

async fn node(reg: &Arc<Reg>, id: &str, register: bool) -> (Net, Vec<Multiaddr>) {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    let mut cfg = Config::new(Claim { identity: id.into(), index: 0 });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    let net = Net::start(key, cfg, reg.clone(), Arc::new(NoListings)).await.unwrap();
    let addrs = until(|| async { Some(net.listening().await).filter(|a| !a.is_empty()) }).await;
    if register {
        let mut ids = reg.0.lock().unwrap();
        let i = ids.entry(id.into()).or_insert_with(|| Identity { id: id.into(), anchor: anchor(id), nodes: vec![] });
        i.nodes.push((net.peer_id(), addrs.clone()));
    }
    (net, addrs)
}

/// Waits until `f` gives a value, asking every 100 ms for 45 s. A wait that runs out names the line that waited, so
/// a failure says which condition it was.
#[track_caller]
fn until<T, F: std::future::Future<Output = Option<T>>>(mut f: impl FnMut() -> F) -> impl std::future::Future<Output = T> {
    let at = std::panic::Location::caller();
    async move {
        for _ in 0..450 {
            if let Some(t) = f().await {
                return t;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("timed out after 45 s waiting at {at}");
    }
}

/// The next notice `rx` hears within `wait`, if any.
async fn next(rx: &mut mpsc::Receiver<Heard>, wait: Duration) -> Option<Heard> {
    tokio::time::timeout(wait, rx.recv()).await.ok().flatten()
}

/// A lister, a node that keeps one of its routes, and a seed they both join through. The keeper watches the site,
/// meets the lister through the table, and hears the lister's delist within seconds, from the lister's identity.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_change_notice_reaches_a_node_watching_the_site_within_seconds() {
    let reg = Arc::new(Reg::default());
    let (_seed, _) = node(&reg, "0xs", true).await;
    let (lister, _) = node(&reg, "0xa", true).await;
    let (keeper, _) = node(&reg, "0xk", true).await;
    let mut heard = keeper.changes().expect("the stream of notices");
    assert!(keeper.changes().is_none(), "taken once");
    for n in [&lister, &keeper] {
        until(|| async { (!n.table().await.is_empty()).then_some(()) }).await;
    }
    lister.provide(SITE).await.unwrap();
    lister.watch(vec![SITE.into()]).await.unwrap();
    keeper.watch(vec![SITE.into(), "https://www.example.com/flights".into()]).await.unwrap();
    until(|| async { lister.watchers(SITE).await.contains(&keeper.peer_id()).then_some(()) }).await;

    let t = Instant::now();
    lister.publish_change(Change::now(SITE, ChangeKind::Delisted, vec![entry(1)])).await.unwrap();
    let got = next(&mut heard, Duration::from_secs(10)).await.expect("the keeper hears the notice");
    assert!(t.elapsed() < Duration::from_secs(5), "within seconds: {:?}", t.elapsed());
    assert_eq!((got.change.kind, got.change.entries.clone(), got.from, got.identity.as_str()), (ChangeKind::Delisted, vec![entry(1)], lister.peer_id(), "0xa"));
    assert!(lister.publish_change(Change::now("www.example.com", ChangeKind::Repriced, vec![entry(1)])).await.is_err(), "a notice is for a registrable site");
}

/// A node the registry doesn't list watches the site and publishes a delist, and a forger publishes one in the lister's
/// name, unsigned. The keeper hears neither, and the lister's own notice still reaches it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_forged_or_unadmitted_notice_never_reaches_the_node() {
    let reg = Arc::new(Reg::default());
    let (lister, lister_addrs) = node(&reg, "0xa", true).await;
    let (keeper, keeper_addrs) = node(&reg, "0xk", true).await;
    let (mallory, _) = node(&reg, "0xm", false).await;
    let mut heard = keeper.changes().unwrap();
    keeper.dial(lister_addrs[0].clone()).await.unwrap();
    lister.watch(vec![SITE.into()]).await.unwrap();
    keeper.watch(vec![SITE.into()]).await.unwrap();
    until(|| async { lister.watchers(SITE).await.contains(&keeper.peer_id()).then_some(()) }).await;

    // The unlisted node: on the topic, connected, publishing a notice that reads.
    mallory.dial(keeper_addrs[0].clone()).await.unwrap();
    mallory.watch(vec![SITE.into()]).await.unwrap();
    until(|| async { mallory.watchers(SITE).await.contains(&keeper.peer_id()).then_some(()) }).await;
    mallory.publish_change(Change::now(SITE, ChangeKind::Delisted, vec![entry(2)])).await.unwrap();

    // The forger: gossipsub on the network's protocol, naming the lister as the source and signing nothing.
    let mut forger: libp2p::Swarm<gossipsub::Behaviour> = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
        .unwrap()
        .with_behaviour(|_| {
            let cfg = gossipsub::ConfigBuilder::default().protocol_id(CHANGES_PROTOCOL, Version::V1_1).validation_mode(ValidationMode::Permissive).build().unwrap();
            gossipsub::Behaviour::new(MessageAuthenticity::Author(lister.peer_id()), cfg).unwrap()
        })
        .unwrap()
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();
    forger.behaviour_mut().subscribe(&topic(SITE)).unwrap();
    forger.dial(keeper_addrs[0].clone()).unwrap();
    let forged = serde_json::to_vec(&Change::now(SITE, ChangeKind::Delisted, vec![entry(3)])).unwrap();
    let published = tokio::spawn(async move {
        let until = Instant::now() + Duration::from_secs(20);
        let mut sent = false;
        while Instant::now() < until {
            match tokio::time::timeout(Duration::from_millis(200), forger.select_next_some()).await {
                Ok(SwarmEvent::Behaviour(gossipsub::Event::Subscribed { .. })) if !sent => {
                    sent = forger.behaviour_mut().publish(topic(SITE), forged.clone()).is_ok();
                }
                _ => {}
            }
            if sent {
                // A moment for it to travel.
                let _ = tokio::time::timeout(Duration::from_secs(1), forger.select_next_some()).await;
                return true;
            }
        }
        false
    });
    assert!(published.await.unwrap(), "the forger published to the keeper");
    assert!(next(&mut heard, Duration::from_secs(3)).await.is_none(), "neither notice reaches the node");

    lister.publish_change(Change::now(SITE, ChangeKind::Repriced, vec![entry(4)])).await.unwrap();
    let got = next(&mut heard, Duration::from_secs(10)).await.expect("the lister's notice still does");
    assert_eq!((got.change.entries, got.from), (vec![entry(4)], lister.peer_id()));
}
