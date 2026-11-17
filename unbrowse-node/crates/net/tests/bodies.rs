//! Route bodies between nodes on one machine, over real TCP: a node that provides a body is found by its content id
//! and serves it to a caller that pays; a payment it won't take, a body it doesn't hold and a body past the bound are
//! refused; an unlisted node's provider record never counts; a provider that sends more than a body may hold is cut
//! off.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::prelude::*;
use libp2p::request_response::{self, ProtocolSupport};
use libp2p::swarm::SwarmEvent;
use libp2p::{noise, tcp, yamux, StreamProtocol};
use unbrowse_net::{grind, Bodies, Claim, Config, FetchError, Identity, Listing, Listings, Multiaddr, Net, PeerId, Registry, Rules, BODY_PROTOCOL, MAX_BODY_BYTES};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };
const BODY: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const LARGE: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const UNKNOWN: &str = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const PAID: &[u8] = b"voucher: paid";

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

/// A node's store of bodies: it serves the one asked for when the payment is the one it takes, and records who
/// asked.
#[derive(Default)]
struct Store {
    bodies: HashMap<String, Vec<u8>>,
    asked_by: Mutex<Vec<PeerId>>,
}

impl Bodies for Store {
    async fn serve(&self, from: PeerId, content_id: &str, payment: &[u8]) -> Result<Vec<u8>, String> {
        self.asked_by.lock().unwrap().push(from);
        if payment != PAID {
            return Err("the voucher doesn't pay for this body".into());
        }
        self.bodies.get(content_id).cloned().ok_or_else(|| "no such body here".into())
    }
}

fn anchor(id: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..id.len().min(32)].copy_from_slice(&id.as_bytes()[..id.len().min(32)]);
    a
}

async fn node(reg: &Arc<Reg>, id: &str, index: u32, register: bool, store: Arc<Store>) -> Net {
    let key = grind(id, &anchor(id), index, RULES.position_bits);
    let mut cfg = Config::new(Claim { identity: id.into(), index });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    let net = Net::start_with_bodies(key, cfg, reg.clone(), Arc::new(NoListings), store).await.unwrap();
    let addrs = until(|| async { Some(net.listening().await).filter(|a| !a.is_empty()) }).await;
    if register {
        let mut ids = reg.0.lock().unwrap();
        let i = ids.entry(id.into()).or_insert_with(|| Identity { id: id.into(), anchor: anchor(id), nodes: vec![] });
        i.nodes.push((net.peer_id(), addrs));
    }
    net
}

/// Waits until `f` gives a value, asking every 100 ms for 30 s. A wait that runs out names the line that waited, so
/// a failure says which condition it was.
#[track_caller]
fn until<T, F: std::future::Future<Output = Option<T>>>(mut f: impl FnMut() -> F) -> impl std::future::Future<Output = T> {
    let at = std::panic::Location::caller();
    async move {
        for _ in 0..300 {
            if let Some(t) = f().await {
                return t;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("timed out after 30 s waiting at {at}");
    }
}

async fn joined(nets: &[&Net]) {
    for n in nets {
        until(|| async { if n.table().await.is_empty() { None } else { Some(()) } }).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_body_is_found_by_its_content_id_and_served_to_a_caller_that_pays() {
    let reg = Arc::new(Reg::default());
    let recipe = br#"{"method":"GET","url":"https://example.com/api/flights?from={from}"}"#.to_vec();
    let store = Arc::new(Store {
        bodies: HashMap::from([(BODY.to_string(), recipe.clone()), (LARGE.to_string(), vec![b'x'; MAX_BODY_BYTES + 1])]),
        ..Default::default()
    });
    let provider = node(&reg, "0xa", 0, true, store.clone()).await;
    let caller = node(&reg, "0xc", 0, true, Arc::default()).await;
    joined(&[&provider, &caller]).await;
    provider.provide_body(BODY).await.unwrap();

    let found = until(|| async { Some(caller.find_body_providers(BODY).await.ok()?).filter(|f| !f.is_empty()) }).await;
    assert_eq!(found, [provider.peer_id()]);
    assert!(caller.find_body_providers(UNKNOWN).await.unwrap().is_empty(), "providers are found by content id, not by node");

    assert_eq!(caller.fetch_body(provider.peer_id(), BODY, PAID).await, Ok(recipe));
    assert_eq!(store.asked_by.lock().unwrap().last(), Some(&caller.peer_id()), "the store hears who asks");
    assert_eq!(
        caller.fetch_body(provider.peer_id(), BODY, b"voucher: short").await,
        Err(FetchError::Refused("the voucher doesn't pay for this body".into())),
        "a payment the provider won't take is refused, with its reason"
    );
    assert_eq!(caller.fetch_body(provider.peer_id(), UNKNOWN, PAID).await, Err(FetchError::Refused("no such body here".into())));
    // A body past the bound never leaves the provider's node.
    assert!(matches!(caller.fetch_body(provider.peer_id(), LARGE, PAID).await, Err(FetchError::Refused(r)) if r.contains("larger")));
    assert!(matches!(caller.fetch_body(provider.peer_id(), &"c".repeat(300), PAID).await, Err(FetchError::Invalid(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unlisted_nodes_provider_record_never_counts() {
    let reg = Arc::new(Reg::default());
    let a = node(&reg, "0xa", 0, true, Arc::default()).await;
    // A second node of the same identity: a fallback for the same copy, not a second identity.
    let a2 = node(&reg, "0xa", 1, true, Arc::default()).await;
    let d = node(&reg, "0xd", 0, true, Arc::default()).await;
    let caller = node(&reg, "0xc", 0, true, Arc::default()).await;
    // Not in the registry: it runs the same code and provides the same body, and a body nobody else provides.
    let mallory = node(&reg, "0xm", 0, false, Arc::default()).await;
    joined(&[&a, &a2, &d, &caller, &mallory]).await;
    for n in [&a, &a2, &d, &mallory] {
        n.provide_body(BODY).await.unwrap();
    }
    mallory.provide_body(UNKNOWN).await.unwrap();

    let found = until(|| async { Some(caller.find_body_providers(BODY).await.ok()?).filter(|f| f.len() >= 3) }).await;
    let mut got = found.clone();
    got.sort();
    let mut want = vec![a.peer_id(), a2.peer_id(), d.peer_id()];
    want.sort();
    assert_eq!(got, want, "the unlisted node's record is ignored");
    assert!(found[..2].contains(&d.peer_id()), "each identity's first node comes before any identity's second: {found:?}");
    assert!(caller.find_body_providers(UNKNOWN).await.unwrap().is_empty(), "a body only an unlisted node provides has no providers");
}

/// A codec that writes whatever it is given, as a provider that ignores the bound would.
#[derive(Clone, Default)]
struct Raw;

impl request_response::Codec for Raw {
    type Protocol = StreamProtocol;
    type Request = Vec<u8>;
    type Response = Vec<u8>;
    async fn read_request<T: AsyncRead + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T) -> std::io::Result<Vec<u8>> {
        let mut buf = Vec::new();
        io.take(64 * 1024).read_to_end(&mut buf).await?;
        Ok(buf)
    }
    async fn read_response<T: AsyncRead + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T) -> std::io::Result<Vec<u8>> {
        let mut buf = Vec::new();
        io.read_to_end(&mut buf).await?;
        Ok(buf)
    }
    async fn write_request<T: AsyncWrite + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T, r: Vec<u8>) -> std::io::Result<()> {
        io.write_all(&r).await?;
        io.close().await
    }
    async fn write_response<T: AsyncWrite + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T, r: Vec<u8>) -> std::io::Result<()> {
        io.write_all(&r).await?;
        io.close().await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_provider_that_sends_more_than_a_body_may_hold_is_cut_off() {
    let mut flooder = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
        .unwrap()
        .with_behaviour(|_| {
            request_response::Behaviour::with_codec(Raw, [(StreamProtocol::new(BODY_PROTOCOL), ProtocolSupport::Full)], request_response::Config::default())
        })
        .unwrap()
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();
    flooder.listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap()).unwrap();
    let addr = loop {
        if let SwarmEvent::NewListenAddr { address, .. } = flooder.select_next_some().await {
            break address;
        }
    };
    let flooder_id = *flooder.local_peer_id();
    // Every ask is answered with a body tag and ten times what a body may hold.
    tokio::spawn(async move {
        loop {
            if let SwarmEvent::Behaviour(request_response::Event::Message { message: request_response::Message::Request { channel, .. }, .. }) =
                flooder.select_next_some().await
            {
                let flood = [&[0u8][..], &vec![b'x'; 10 * MAX_BODY_BYTES]].concat();
                let _ = flooder.behaviour_mut().send_response(channel, flood);
            }
        }
    });

    let reg = Arc::new(Reg::default());
    let caller = node(&reg, "0xc", 0, true, Arc::default()).await;
    caller.dial(addr.with(libp2p::multiaddr::Protocol::P2p(flooder_id))).await.unwrap();
    let got = until(|| async {
        match caller.fetch_body(flooder_id, BODY, PAID).await {
            Err(FetchError::Unanswered(_)) => None,
            other => Some(other),
        }
    })
    .await;
    assert_eq!(got, Err(FetchError::TooLarge));
}
