//! A node that goes offline stops being found. One that crashes drops out of every lookup within its records' life;
//! one that stops cleanly drops out at once, its records gone from the peers that held them; a goodbye only the
//! leaving node signed counts; a lookup never waits on a provider that has gone; the routing table pings a silent peer
//! and drops it; a node that left is taken back when it returns; and a node that restarts still skips the providers
//! it set aside.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::prelude::*;
use libp2p::request_response::{self, ProtocolSupport};
use libp2p::swarm::SwarmEvent;
use libp2p::{noise, tcp, yamux, StreamProtocol};
use serde::{Deserialize, Serialize};
use unbrowse_net::{grind, Claim, Config, Identity, Keypair, Listing, Listings, Multiaddr, Net, PeerId, Protocol, Providers, Registry, Rules, Standing};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };
const SITE: &str = "example.com";
const BODY: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

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

/// Every node lists one route for `SITE`, as its own identity.
struct Own(String);

impl Listings for Own {
    async fn site(&self, site: &str) -> Vec<Listing> {
        if site != SITE {
            return vec![];
        }
        let n = u64::from_str_radix(&self.0[2..], 16).unwrap_or(0);
        vec![Listing { entry_id: format!("0x{n:064x}"), site: SITE.into(), description: "search flights".into(), contributor: self.0.clone(), fee: 0.01, signed: None }]
    }
}

fn anchor(id: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..id.len().min(32)].copy_from_slice(&id.as_bytes()[..id.len().min(32)]);
    a
}

/// Seconds-scale settings: records last `ttl` and are announced every `ttl / 3`; a provider not connected must answer
/// within a second; the table pings a peer silent `check_after`.
fn config(id: &str, ttl: Duration, check_after: Duration) -> Config {
    let mut cfg = Config::new(Claim { identity: id.into(), index: 0 });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    cfg.provider_ttl = ttl;
    cfg.provider_refresh = ttl / 3;
    cfg.connect_timeout = Duration::from_secs(1);
    cfg.check_after = check_after;
    cfg.ping_timeout = Duration::from_secs(1);
    cfg.registry_timeout = Duration::from_secs(2);
    cfg
}

struct Node {
    net: Net,
    addrs: Vec<Multiaddr>,
    key: Keypair,
}

async fn node(reg: &Arc<Reg>, id: &str, cfg: Config) -> Node {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    start(reg, id, key, cfg).await
}

async fn start(reg: &Arc<Reg>, id: &str, key: Keypair, cfg: Config) -> Node {
    let net = Net::start(key.clone(), cfg, reg.clone(), Arc::new(Own(id.into()))).await.unwrap();
    let addrs = until(|| async { Some(net.listening().await).filter(|a| !a.is_empty()) }).await;
    let mut ids = reg.0.lock().unwrap();
    let i = ids.entry(id.into()).or_insert_with(|| Identity { id: id.into(), anchor: anchor(id), nodes: vec![] });
    i.nodes.retain(|(p, _)| *p != net.peer_id());
    i.nodes.push((net.peer_id(), addrs.clone()));
    drop(ids);
    Node { net, addrs, key }
}

/// Waits until `f` gives a value, asking every 100 ms for 45 s. A wait that runs out names the line that waited, so
/// a failure says which condition it was.
#[track_caller]
fn until<T, F: Future<Output = Option<T>>>(mut f: impl FnMut() -> F) -> impl Future<Output = T> {
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

async fn knows(net: &Net, peer: PeerId) -> bool {
    net.table().await.iter().any(|(p, _)| *p == peer)
}

/// A seed and a node for each of `ids`, each knowing all the others.
async fn network(ids: &[&str], cfg: impl Fn(&str) -> Config) -> (Arc<Reg>, Vec<Node>) {
    let reg = Arc::new(Reg::default());
    let mut nodes = vec![node(&reg, "0x5eed", cfg("0x5eed")).await];
    for id in ids {
        nodes.push(node(&reg, id, cfg(id)).await);
    }
    for n in &nodes {
        let others: Vec<PeerId> = nodes.iter().map(|o| o.net.peer_id()).filter(|p| *p != n.net.peer_id()).collect();
        until(|| async {
            for o in &others {
                if !knows(&n.net, *o).await {
                    return None;
                }
            }
            Some(())
        })
        .await;
    }
    (reg, nodes)
}

/// `provider` provides the site and the body, and `seeker` finds it for both.
async fn provides(provider: &Net, seeker: &Net, id: &str) {
    provider.provide(SITE).await.unwrap();
    provider.provide_body(BODY).await.unwrap();
    until(|| async { seeker.find(SITE).await.ok()?.sources.contains(&id.to_string()).then_some(()) }).await;
    until(|| async { seeker.find_body_providers(BODY).await.ok()?.contains(&provider.peer_id()).then_some(()) }).await;
}

/// Whether `peer` is still recorded, seen from `at`, as providing the site or the body.
async fn recorded(at: &Net, peer: PeerId) -> bool {
    at.recorded_site_providers(SITE).await.contains(&peer) || at.recorded_body_providers(BODY).await.contains(&peer)
}

/// Holds `addr`'s port open once its node has gone: a connection is taken and nothing is ever said on it, as a machine
/// that went dark behind a router answers.
fn blackhole(addr: &Multiaddr) -> std::thread::JoinHandle<()> {
    let port = addr.iter().find_map(|p| if let Protocol::Tcp(port) = p { Some(port) } else { None }).unwrap();
    let listener = (0..100)
        .find_map(|_| {
            std::net::TcpListener::bind(("127.0.0.1", port)).ok().or_else(|| {
                std::thread::sleep(Duration::from_millis(50));
                None
            })
        })
        .expect("the gone node's port");
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for s in listener.incoming().flatten() {
            held.push(s);
        }
    })
}

/// A provider killed without a word stays recorded until its records lapse, and no longer: within the record life it
/// is gone from every peer's site and body records. Lookups pass it over long before, since it can't be reached.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_that_crashes_drops_out_within_the_record_life() {
    let ttl = Duration::from_secs(6);
    let (_reg, nodes) = network(&["0xa", "0xb", "0xc"], |id| config(id, ttl, Duration::from_secs(3600))).await;
    let (a, b, c) = (&nodes[1].net, &nodes[2].net, &nodes[3].net);
    provides(b, c, "0xb").await;
    let gone = b.peer_id();
    b.vanish().await;
    let t = Instant::now();
    assert!(recorded(c, gone).await, "a crash withdraws nothing: the records stand until they lapse");
    let found = c.find(SITE).await.unwrap();
    assert!(!found.sources.contains(&"0xb".to_string()), "a lookup passes over a provider it can't reach");
    assert!(!c.find_body_providers(BODY).await.unwrap().contains(&gone));
    for n in [a, c, &nodes[0].net] {
        until(|| async { (!recorded(n, gone).await).then_some(()) }).await;
    }
    assert!(t.elapsed() <= ttl + Duration::from_secs(3), "gone within the record life: {:?}", t.elapsed());
}

/// A provider that stops cleanly is gone from every peer's records at once, long before they would lapse, and no
/// lookup counts it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_that_stops_cleanly_drops_out_at_once() {
    let ttl = Duration::from_secs(3600);
    let (_reg, nodes) = network(&["0xa", "0xb", "0xc"], |id| config(id, ttl, Duration::from_secs(3600))).await;
    let (a, b, c) = (&nodes[1].net, &nodes[2].net, &nodes[3].net);
    provides(b, c, "0xb").await;
    provides(b, a, "0xb").await;
    let gone = b.peer_id();
    let t = Instant::now();
    b.stop().await;
    assert!(t.elapsed() < Duration::from_secs(5), "a goodbye is bounded: {:?}", t.elapsed());
    assert!(b.stopped());
    for n in [a, c, &nodes[0].net] {
        assert!(!recorded(n, gone).await, "the records it left are gone");
        assert_eq!(n.admit(gone).await, Standing::Unreachable, "and it counts nowhere");
        assert!(!knows(n, gone).await);
    }
    assert!(c.find(SITE).await.unwrap().sources.is_empty());
    assert!(c.find_body_providers(BODY).await.unwrap().is_empty());
    assert!(t.elapsed() < Duration::from_secs(10), "at once: {:?}", t.elapsed());
}

/// The leaving notice as it crosses the wire.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Leaving {
    key: Vec<u8>,
    to: String,
    at: u64,
    sig: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Left {}

fn leaving_bytes(from: &PeerId, to: &PeerId, at: u64) -> Vec<u8> {
    [&b"unbrowse/leaving/1"[..], &from.to_bytes(), &to.to_bytes(), &at.to_be_bytes()].concat()
}

/// A peer says another node's goodbye: once signed by its own key in that node's name, once passing on a goodbye that
/// node really signed. Neither changes anything: the node is still recorded, counted and found.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_forged_goodbye_is_ignored() {
    let (_reg, nodes) = network(&["0xa", "0xb", "0xc"], |id| config(id, Duration::from_secs(3600), Duration::from_secs(3600))).await;
    let (b, c) = (&nodes[2], &nodes[3]);
    provides(&b.net, &c.net, "0xb").await;
    let (victim, reader) = (b.net.peer_id(), c.net.peer_id());

    let forger = Keypair::generate_ed25519();
    let mut swarm = libp2p::SwarmBuilder::with_existing_identity(forger.clone())
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
        .unwrap()
        .with_behaviour(|_| request_response::json::Behaviour::<Leaving, Left>::new([(StreamProtocol::new("/unbrowse/leaving/1"), ProtocolSupport::Full)], request_response::Config::default()))
        .unwrap()
        .build();
    swarm.dial(c.addrs[0].clone()).unwrap();
    loop {
        if let SwarmEvent::ConnectionEstablished { .. } = swarm.select_next_some().await {
            break;
        }
    }
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let msg = leaving_bytes(&victim, &reader, at);
    let notices = [
        // The victim's key, the forger's signature.
        Leaving { key: b.key.public().encode_protobuf(), to: reader.to_string(), at, sig: forger.sign(&msg).unwrap() },
        // The victim's own signature, said by the forger.
        Leaving { key: b.key.public().encode_protobuf(), to: reader.to_string(), at, sig: b.key.sign(&msg).unwrap() },
    ];
    for n in notices {
        swarm.behaviour_mut().send_request(&reader, n);
    }
    let mut answered = 0;
    while answered < 2 {
        match swarm.select_next_some().await {
            SwarmEvent::Behaviour(request_response::Event::Message { message: request_response::Message::Response { .. }, .. }) => answered += 1,
            SwarmEvent::Behaviour(request_response::Event::OutboundFailure { error, .. }) => panic!("{error}"),
            _ => {}
        }
    }
    assert!(recorded(&c.net, victim).await, "its records stand");
    assert_eq!(c.net.admit(victim).await, Standing::Counts("0xb".into()), "it still counts");
    assert!(c.net.find(SITE).await.unwrap().sources.contains(&"0xb".to_string()));
    assert!(c.net.find_body_providers(BODY).await.unwrap().contains(&victim));
}

/// Two providers, one gone dark: its address takes a connection and never answers. A lookup returns the live one's
/// listings and body record within about one connect timeout, not after the request timeout the dark one would cost
/// if it were waited on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lookup_returns_from_the_live_provider_without_waiting_on_a_dead_one() {
    let (_reg, nodes) = network(&["0xa", "0xb", "0xc"], |id| config(id, Duration::from_secs(3600), Duration::from_secs(3600))).await;
    let (a, b, c) = (&nodes[1], &nodes[2], &nodes[3]);
    provides(&a.net, &c.net, "0xa").await;
    provides(&b.net, &c.net, "0xb").await;
    b.net.vanish().await;
    let _dark = blackhole(&b.addrs[0]);
    assert!(c.net.recorded_site_providers(SITE).await.contains(&b.net.peer_id()), "the dark one is still recorded");
    let t = Instant::now();
    let found = c.net.find(SITE).await.unwrap();
    assert_eq!(found.sources, ["0xa"]);
    assert_eq!(found.listings.len(), 1);
    assert!(t.elapsed() < Duration::from_secs(4), "the dark provider cost the lookup its connect timeout at most: {:?}", t.elapsed());
    let t = Instant::now();
    assert_eq!(c.net.find_body_providers(BODY).await.unwrap(), [a.net.peer_id()]);
    assert!(t.elapsed() < Duration::from_secs(4), "{:?}", t.elapsed());
}

/// A peer in the table goes silent. The table itself keeps it; the node pings it after `check_after`, finds no
/// answer, and drops it from the table and its admission. A peer that answers stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_table_pings_a_silent_peer_and_drops_it() {
    let check_after = Duration::from_secs(1);
    let (_reg, nodes) = network(&["0xa", "0xb", "0xc"], |id| config(id, Duration::from_secs(3600), check_after)).await;
    let (a, b, c) = (&nodes[1], &nodes[2], &nodes[3]);
    b.net.vanish().await;
    let _dark = blackhole(&b.addrs[0]);
    let gone = b.net.peer_id();
    assert!(knows(&a.net, gone).await, "losing its connection doesn't take it out of the table");
    let t = Instant::now();
    until(|| async { (!knows(&a.net, gone).await).then_some(()) }).await;
    assert!(t.elapsed() < Duration::from_secs(8), "dropped once a ping went unanswered: {:?}", t.elapsed());
    assert_ne!(a.net.admit(gone).await, Standing::Counts("0xb".into()), "and no longer counted");
    // Several checks later the peer that answers is still there.
    tokio::time::sleep(4 * check_after).await;
    assert!(knows(&a.net, c.net.peer_id()).await);
    assert_eq!(a.net.admit(c.net.peer_id()).await, Standing::Counts("0xc".into()));
}

/// A node stops cleanly, then starts again under the same key at a new address. It is admitted again once it connects,
/// and what it provides is found again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_that_said_goodbye_is_taken_back_when_it_returns() {
    let cfg = |id: &str| config(id, Duration::from_secs(3600), Duration::from_secs(3600));
    let (reg, nodes) = network(&["0xa", "0xb"], cfg).await;
    let (a, b) = (&nodes[1], &nodes[2]);
    provides(&b.net, &a.net, "0xb").await;
    b.net.stop().await;
    assert_eq!(a.net.admit(b.key.public().to_peer_id()).await, Standing::Unreachable);

    let back = start(&reg, "0xb", b.key.clone(), cfg("0xb")).await;
    back.net.dial(a.addrs[0].clone()).await.unwrap();
    until(|| async { (a.net.admit(back.net.peer_id()).await == Standing::Counts("0xb".into())).then_some(()) }).await;
    until(|| async { knows(&a.net, back.net.peer_id()).await.then_some(()) }).await;
    provides(&back.net, &a.net, "0xb").await;
}

/// A node says goodbye and starts again at once, under the same key, before the peer it told has seen its old connection
/// close: here the old connection, which said the goodbye, stays open. The node is taken back all the same, as soon as
/// it connects anew, rather than being turned away while the old connection lingers.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_that_returns_before_its_old_connection_closes_is_taken_back() {
    let cfg = |id: &str| config(id, Duration::from_secs(3600), Duration::from_secs(3600));
    let (reg, nodes) = network(&["0xa", "0xb"], cfg).await;
    let (a, b) = (&nodes[1], &nodes[2]);
    let (gone, reader) = (b.net.peer_id(), a.net.peer_id());
    b.net.vanish().await;

    // The old run, under b's key: it says b's goodbye, signed, and keeps its connection open.
    let mut old = libp2p::SwarmBuilder::with_existing_identity(b.key.clone())
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
        .unwrap()
        .with_behaviour(|_| request_response::json::Behaviour::<Leaving, Left>::new([(StreamProtocol::new("/unbrowse/leaving/1"), ProtocolSupport::Full)], request_response::Config::default()))
        .unwrap()
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(120)))
        .build();
    old.dial(a.addrs[0].clone()).unwrap();
    loop {
        if let SwarmEvent::ConnectionEstablished { .. } = old.select_next_some().await {
            break;
        }
    }
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let sig = b.key.sign(&leaving_bytes(&gone, &reader, at)).unwrap();
    old.behaviour_mut().send_request(&reader, Leaving { key: b.key.public().encode_protobuf(), to: reader.to_string(), at, sig });
    loop {
        match old.select_next_some().await {
            SwarmEvent::Behaviour(request_response::Event::Message { message: request_response::Message::Response { .. }, .. }) => break,
            SwarmEvent::Behaviour(request_response::Event::OutboundFailure { error, .. }) => panic!("{error}"),
            _ => {}
        }
    }
    assert_eq!(a.net.admit(gone).await, Standing::Unreachable, "the goodbye counted");
    let lingering = tokio::spawn(async move {
        loop {
            old.select_next_some().await;
        }
    });

    let back = start(&reg, "0xb", b.key.clone(), cfg("0xb")).await;
    back.net.dial(a.addrs[0].clone()).await.unwrap();
    let t = Instant::now();
    until(|| async { (a.net.admit(gone).await == Standing::Counts("0xb".into())).then_some(()) }).await;
    assert!(t.elapsed() < Duration::from_secs(15), "taken back as it connects anew: {:?}", t.elapsed());
    until(|| async { knows(&a.net, gone).await.then_some(()) }).await;
    lingering.abort();
}

/// The providers a node set aside are kept on disk: a restart still skips them, on the same schedule, rather than
/// learning again which are gone. A file torn mid-write, too large, or written by a newer node reads as empty, the
/// newer one is never written over, and the file never outgrows its bound.
#[test]
fn a_restarted_node_still_skips_a_provider_it_set_aside() {
    let dir = std::env::temp_dir().join(format!("unbrowse-set-aside-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("set-aside.json");
    let (dead, live) = (PeerId::random(), PeerId::random());
    {
        let mut p = Providers::open(&path);
        assert_eq!(p.failed(BODY, dead, 7), 8);
    }
    let mut p = Providers::open(&path);
    assert_eq!(p.usable(BODY, [dead, live], 7), [live], "skipped after the restart");
    assert_eq!(p.usable(BODY, [dead, live], 8), [dead, live], "and tried again when its time is up");
    assert_eq!(p.failed(BODY, dead, 8), 10, "its count carried over: a second failure is two epochs");

    let whole = std::fs::read(&path).unwrap();
    std::fs::write(&path, &whole[..whole.len() / 2]).unwrap();
    assert!(Providers::open(&path).is_empty(), "a torn file reads as empty");
    std::fs::write(&path, vec![b' '; unbrowse_net::MAX_KEPT_BYTES as usize + 1]).unwrap();
    assert!(Providers::open(&path).is_empty(), "so does one past the bound");
    let newer = String::from_utf8(whole).unwrap().replacen("\"v\":1", "\"v\":2", 1);
    std::fs::write(&path, &newer).unwrap();
    let mut p = Providers::open(&path);
    assert!(p.is_empty(), "and one a newer node wrote");
    p.failed(BODY, dead, 9);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), newer, "which is never written over");
    std::fs::remove_file(&path).unwrap();

    let mut p = Providers::open(&path);
    for i in 0..(unbrowse_net::MAX_KEPT + 50) {
        p.failed(&format!("sha256:{i:064x}"), dead, i as u64);
    }
    assert!(std::fs::metadata(&path).unwrap().len() <= unbrowse_net::MAX_KEPT_BYTES);
    let p = Providers::open(&path);
    assert_eq!(p.len(), unbrowse_net::MAX_KEPT);
    let last = unbrowse_net::MAX_KEPT + 49;
    assert!(p.excluded(&format!("sha256:{last:064x}"), dead, last as u64), "the latest are kept");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Measures what re-announcing costs: a network of nodes each providing `SITES` sites and `BODIES` bodies, run for a
/// number of refreshes, with what each node announced and what its peers asked of it counted. Prints the counts per
/// node per refresh; at the protocol's 20-minute refresh an hour is three of them.
/// `cargo test -p unbrowse-net --test offline reannouncing_costs -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn reannouncing_costs() {
    const NODES: usize = 8;
    const SITES: usize = 3;
    const BODIES: usize = 2;
    let ttl = Duration::from_secs(9);
    let ids: Vec<String> = (1..NODES).map(|i| format!("0x{i:x}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let (_reg, nodes) = network(&refs, |id| config(id, ttl, Duration::from_secs(3600))).await;
    for (i, n) in nodes.iter().enumerate() {
        for s in 0..SITES {
            n.net.provide(&format!("site{i}-{s}.example")).await.unwrap();
        }
        for b in 0..BODIES {
            n.net.provide_body(&format!("sha256:{i:032x}{b:032x}")).await.unwrap();
        }
    }
    // Past the network's own first announcements, and its small-table ones, into the steady refresh.
    tokio::time::sleep(ttl).await;
    let before: Vec<_> = futures::future::join_all(nodes.iter().map(|n| n.net.load())).await;
    let refreshes = 6u32;
    tokio::time::sleep((ttl / 3) * refreshes).await;
    let after: Vec<_> = futures::future::join_all(nodes.iter().map(|n| n.net.load())).await;
    let per = |f: fn(&unbrowse_net::Load) -> u64| -> f64 {
        after.iter().zip(&before).map(|(a, b)| (f(a) - f(b)) as f64).sum::<f64>() / NODES as f64 / refreshes as f64
    };
    println!(
        "{NODES} nodes, {SITES} sites and {BODIES} bodies each; per node per refresh: announced {:.1}, asked find_node {:.1}, get_providers {:.1}, add_provider {:.1}",
        per(|l| l.announced),
        per(|l| l.find_node),
        per(|l| l.get_providers),
        per(|l| l.add_provider)
    );
}
