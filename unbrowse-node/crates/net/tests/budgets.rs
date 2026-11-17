//! What a node does for its peers is bounded per peer, over real TCP on one machine: one peer flooding listings asks
//! is refused at once and can't stop another peer's answers; with every slot taken, a peer that pays for bodies is
//! served ahead of one that doesn't, and a newcomer still gets served; a peer flooding the table with queries has the
//! streams past its budget closed at once while another node's lookups go on.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use libp2p::kad::{self, store::MemoryStore, Mode, QueryResult, RecordKey};
use libp2p::swarm::SwarmEvent;
use libp2p::{noise, tcp, yamux, StreamProtocol};
use tokio::sync::Semaphore;
use unbrowse_net::{grind, Bodies, Claim, Config, Identity, Listing, Listings, Multiaddr, Net, PeerId, Registry, Rules, KAD_PROTOCOL};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };
const SITE: &str = "example.com";
const BODY: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
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

/// A provider's listings: one for any site asked about. The sites in `held` are answered only once the test lets one
/// through (`release`), in the order they were started; `started` records the order answers began in.
struct Held {
    held: HashSet<String>,
    gate: Arc<Semaphore>,
    started: Mutex<Vec<String>>,
    slow: Option<Duration>,
}

impl Default for Held {
    fn default() -> Held {
        Held { held: HashSet::new(), gate: Arc::new(Semaphore::new(0)), started: Mutex::default(), slow: None }
    }
}

impl Held {
    fn holding(sites: &[&str]) -> Held {
        Held { held: sites.iter().map(|s| s.to_string()).collect(), gate: Arc::new(Semaphore::new(0)), ..Held::default() }
    }

    fn release(&self, n: usize) {
        self.gate.add_permits(n);
    }

    fn started(&self) -> Vec<String> {
        self.started.lock().unwrap().clone()
    }
}

impl Listings for Held {
    async fn site(&self, site: &str) -> Vec<Listing> {
        self.started.lock().unwrap().push(site.to_string());
        if self.held.contains(site) {
            self.gate.acquire().await.unwrap().forget();
        }
        if let Some(d) = self.slow.filter(|_| site != SITE) {
            tokio::time::sleep(d).await;
        }
        let entry = format!("0x{:064x}", site.len());
        vec![Listing { entry_id: entry, site: site.into(), description: "search".into(), contributor: "0xp".into(), fee: 0.01, signed: None }]
    }
}

/// A body the store panics making.
const A_BUG: &str = "0xb0b";

/// Serves the one body to a caller that pays.
struct Store;

impl Bodies for Store {
    async fn serve(&self, _: PeerId, content_id: &str, payment: &[u8]) -> Result<Vec<u8>, String> {
        assert_ne!(content_id, A_BUG, "a bug in the store, as a panic");
        if content_id == BODY && payment == PAID {
            Ok(b"{\"method\":\"GET\"}".to_vec())
        } else {
            Err("the voucher doesn't pay for this body".into())
        }
    }
}

fn anchor(id: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..id.len().min(32)].copy_from_slice(&id.as_bytes()[..id.len().min(32)]);
    a
}

fn config(id: &str) -> Config {
    let mut cfg = Config::new(Claim { identity: id.into(), index: 0 });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    cfg
}

async fn node_with<L: Listings>(reg: &Arc<Reg>, id: &str, cfg: Config, listings: Arc<L>) -> Net {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    let net = Net::start_with_bodies(key, cfg, reg.clone(), listings, Arc::new(Store)).await.unwrap();
    let addrs = until(|| async { Some(net.listening().await).filter(|a| !a.is_empty()) }).await;
    let mut ids = reg.0.lock().unwrap();
    let i = ids.entry(id.into()).or_insert_with(|| Identity { id: id.into(), anchor: anchor(id), nodes: vec![] });
    i.nodes.push((net.peer_id(), addrs));
    net
}

async fn node(reg: &Arc<Reg>, id: &str) -> Net {
    node_with(reg, id, config(id), Arc::new(Held::default())).await
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

/// Every one of `askers` knows `provider` and counts it: the provider's answers to them are what the test measures.
async fn met(provider: &Net, askers: &[&Net]) {
    for a in askers {
        until(|| async { matches!(a.admit(provider.peer_id()).await, unbrowse_net::Standing::Counts(_)).then_some(()) }).await;
        until(|| async { matches!(provider.admit(a.peer_id()).await, unbrowse_net::Standing::Counts(_)).then_some(()) }).await;
    }
}

/// `asker` asks `provider` for `site`'s listings in the background.
fn ask(asker: &Net, provider: PeerId, site: &str) -> tokio::task::JoinHandle<Result<Vec<Listing>, String>> {
    let (asker, site) = (asker.clone(), site.to_string());
    tokio::spawn(async move { asker.listings_from(provider, &site).await })
}

/// A peer floods a provider with listings asks whose answers are slow to make. Those past its budget, or past its share
/// of the slots, are refused at once, never left to time out; another peer asking all the while is answered every time.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_peer_flooding_listings_asks_cannot_stop_another_peers_answers() {
    let reg = Arc::new(Reg::default());
    let held = Arc::new(Held { slow: Some(Duration::from_millis(300)), ..Held::default() });
    let p = node_with(&reg, "0xp", config("0xp"), held.clone()).await;
    let flooder = node(&reg, "0xf").await;
    let honest = node(&reg, "0xh").await;
    met(&p, &[&flooder, &honest]).await;

    let t = Instant::now();
    // Twelve at a time: what one connection carries at once, so every ask reaches the provider.
    let (f, to) = (flooder.clone(), p.peer_id());
    let flood = tokio::spawn(async move {
        futures::stream::iter(0..200)
            .map(|_| {
                let f = f.clone();
                async move {
                    let at = Instant::now();
                    (f.listings_from(to, "slow.example").await, at.elapsed())
                }
            })
            .buffer_unordered(12)
            .collect::<Vec<_>>()
            .await
    });
    for _ in 0..10 {
        let got = honest.listings_from(p.peer_id(), SITE).await;
        assert!(got.as_ref().is_ok_and(|l| l.len() == 1), "the other peer is answered: {got:?}");
    }
    let (mut answered, mut refused) = (0, 0);
    for (got, took) in flood.await.unwrap() {
        match got {
            Ok(_) => answered += 1,
            Err(e) => {
                assert!(e.contains("refused"), "a refusal, not a silence: {e}");
                assert!(took < Duration::from_secs(5), "refused at once, not timed out: {took:?}");
                refused += 1;
            }
        }
    }
    println!("flood: {answered} answered, {refused} refused in {:?}", t.elapsed());
    assert!(answered <= 40, "no more than its burst and what refilled: {answered}");
    assert!(refused >= 150, "{refused}");
    let load = p.load().await;
    assert!(load.refused_listings >= 150, "{load:?}");
}

/// Every slot is taken: two shared ones by one peer, the newcomer's by another that hasn't paid. A peer that hasn't
/// paid asks, then one that has. When a shared slot frees, the payer is answered first.
/// A store that panics making an answer gives its slot back, as a listings answer does: the asker is told, and asks after
/// it are served, however many there were.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panic_making_a_body_never_costs_a_slot() {
    let reg = Arc::new(Reg::default());
    let mut cfg = config("0xp");
    cfg.slots = 3;
    let p = node_with(&reg, "0xp", cfg, Arc::new(Held::default())).await;
    let asker = node(&reg, "0xa").await;
    met(&p, &[&asker]).await;
    for _ in 0..4 {
        assert!(asker.fetch_body(p.peer_id(), A_BUG, PAID).await.is_err());
    }
    assert_eq!(asker.fetch_body(p.peer_id(), BODY, PAID).await.map(|b| b.len()), Ok(16), "the slots came back");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_paying_peer_is_served_ahead_of_a_non_paying_one_when_slots_are_full() {
    let reg = Arc::new(Reg::default());
    let mut cfg = config("0xp");
    cfg.slots = 3;
    cfg.slots_per_peer = 2;
    let held = Arc::new(Held::holding(&["f.example", "n1.example", "n2.example", "payer.example"]));
    let p = node_with(&reg, "0xp", cfg, held.clone()).await;
    let (f, n1, n2, payer) = (node(&reg, "0xf").await, node(&reg, "0xa").await, node(&reg, "0xb").await, node(&reg, "0xc").await);
    met(&p, &[&f, &n1, &n2, &payer]).await;
    assert_eq!(payer.fetch_body(p.peer_id(), BODY, PAID).await.map(|b| b.len()), Ok(16), "the payer pays for a body");

    let started = |n: usize| {
        let held = held.clone();
        async move { until(|| async { (held.started().len() >= n).then_some(()) }).await }
    };
    let f1 = ask(&f, p.peer_id(), "f.example");
    let f2 = ask(&f, p.peer_id(), "f.example");
    started(2).await;
    let first = ask(&n1, p.peer_id(), "n1.example");
    started(3).await;
    // Both wait: the shared slots are f's and the newcomer's is n1's.
    let waiting = ask(&n2, p.peer_id(), "n2.example");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let paying = ask(&payer, p.peer_id(), "payer.example");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(held.started().len(), 3, "every slot is taken and both wait");

    // One of f's answers is let through, freeing a shared slot: the payer's is the next begun, though it asked last.
    held.release(1);
    started(4).await;
    assert_eq!(held.started()[3], "payer.example", "{:?}", held.started());
    held.release(5);
    for h in [f1, f2, first, waiting, paying] {
        assert!(h.await.unwrap().is_ok());
    }
    assert_eq!(held.started()[4..], ["n2.example"], "the one that didn't pay is answered after");
}

/// Every shared slot is held by peers that pay, and one more payer waits. A newcomer asks: it is answered at once, in
/// the slot kept for one, while the payers still wait.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_newcomer_still_gets_served() {
    let reg = Arc::new(Reg::default());
    let mut cfg = config("0xp");
    cfg.slots = 3;
    cfg.slots_per_peer = 2;
    let held = Arc::new(Held::holding(&["p1.example", "p2.example"]));
    let p = node_with(&reg, "0xp", cfg, held.clone()).await;
    let (p1, p2, newcomer) = (node(&reg, "0xa").await, node(&reg, "0xb").await, node(&reg, "0xn").await);
    met(&p, &[&p1, &p2, &newcomer]).await;
    for payer in [&p1, &p2] {
        assert!(payer.fetch_body(p.peer_id(), BODY, PAID).await.is_ok());
    }
    let held_answers = [ask(&p1, p.peer_id(), "p1.example"), ask(&p1, p.peer_id(), "p1.example")];
    until(|| async { (held.started().len() >= 2).then_some(()) }).await;
    let waiting = ask(&p2, p.peer_id(), "p2.example");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(held.started().len(), 2, "a payer never takes the newcomer's slot");

    let t = Instant::now();
    let got = newcomer.listings_from(p.peer_id(), "new.example").await;
    assert!(got.is_ok_and(|l| l.len() == 1), "the newcomer is answered");
    assert!(t.elapsed() < Duration::from_secs(2), "at once: {:?}", t.elapsed());
    assert!(!held.started().contains(&"p2.example".to_string()), "while the payer still waits");

    held.release(3);
    for h in held_answers {
        assert!(h.await.unwrap().is_ok());
    }
    assert!(waiting.await.unwrap().is_ok(), "and the payer is answered once a shared slot frees");
}

/// A peer that isn't admitted floods a node with table queries, thousands of them. The node answers its budget's worth
/// and closes the rest of its streams unread, so its queries end at once rather than waiting out a timeout; another
/// node's lookups through it go on all the while.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_flooding_table_queries_is_refused_at_once_and_others_are_answered() {
    let reg = Arc::new(Reg::default());
    let p = node(&reg, "0xp").await;
    let provider = node(&reg, "0xq").await;
    let seeker = node(&reg, "0xs").await;
    met(&p, &[&provider, &seeker]).await;
    provider.provide(SITE).await.unwrap();
    until(|| async { Some(seeker.find(SITE).await.ok()?).filter(|f| !f.sources.is_empty()) }).await;
    let before = p.load().await;

    let mut flooder = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
        .unwrap()
        .with_behaviour(|k| {
            let id = k.public().to_peer_id();
            kad::Behaviour::with_config(id, MemoryStore::new(id), kad::Config::new(StreamProtocol::new(KAD_PROTOCOL)))
        })
        .unwrap()
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();
    flooder.behaviour_mut().set_mode(Some(Mode::Client));
    flooder.behaviour_mut().add_address(&p.peer_id(), p.listening().await[0].clone());
    const QUERIES: usize = 3000;
    let t = Instant::now();
    for i in 0..QUERIES {
        flooder.behaviour_mut().get_providers(RecordKey::new(&format!("/unbrowse/site/flood-{i}.example")));
    }
    let flood = tokio::spawn(async move {
        let mut done = 0;
        while done < QUERIES {
            if let SwarmEvent::Behaviour(kad::Event::OutboundQueryProgressed { result: QueryResult::GetProviders(_), step, .. }) = flooder.select_next_some().await {
                if step.last {
                    done += 1;
                }
            }
        }
    });
    // The seeker's lookups go through p as the flood runs.
    for _ in 0..5 {
        let found = seeker.find(SITE).await.unwrap();
        assert_eq!(found.sources, ["0xq"], "another node's lookups go on");
    }
    tokio::time::timeout(Duration::from_secs(30), flood).await.expect("every flooding query ends, none waits out a timeout").unwrap();
    let took = t.elapsed();
    let after = p.load().await;
    let answered = after.get_providers - before.get_providers;
    println!("table flood: {answered} answered, {} refused in {took:?}", after.refused_kad - before.refused_kad);
    assert!(after.refused_kad - before.refused_kad > 0, "{after:?}");
    // Its budget: a burst of 512 and 32 a second, plus the seeker's own lookups.
    assert!((answered as f64) < 512.0 + 32.0 * took.as_secs_f64() + 100.0, "{answered} answered in {took:?}");
}
