//! The network recovers from what goes wrong while nodes meet: nodes that boot together find each other once they have
//! said where they are, a registry that hung or failed is read again once it answers, a peer seen too old never counts
//! until it is new enough again, and a listings answer neither waits forever nor outgrows what its asker reads.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use unbrowse_net::{grind, Claim, Config, Identity, Listing, Listings, Multiaddr, Net, PeerId, Registry, Rules, Standing};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };
const SITE: &str = "example.com";
/// A site whose listings never come: the node's answer waits on a read that never returns.
const STUCK: &str = "stuck.example";
const ENTRY_A: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";

/// A registry that can hang or fail reads for chosen identities, hand out seeds only once told to, and count reads.
#[derive(Default)]
struct Reg {
    ids: Mutex<HashMap<String, Identity>>,
    hang: Mutex<HashSet<String>>,
    fail: Mutex<HashSet<String>>,
    seeds_on: AtomicBool,
    identity_reads: AtomicUsize,
    seed_reads: AtomicUsize,
}

impl Registry for Reg {
    async fn identity(&self, id: &str) -> Result<Option<Identity>, String> {
        self.identity_reads.fetch_add(1, Ordering::SeqCst);
        if self.hang.lock().unwrap().contains(id) {
            futures::future::pending::<()>().await;
        }
        if self.fail.lock().unwrap().contains(id) {
            return Err("the chain didn't answer".into());
        }
        Ok(self.ids.lock().unwrap().get(id).cloned())
    }
    async fn seeds(&self) -> Vec<(PeerId, Multiaddr)> {
        self.seed_reads.fetch_add(1, Ordering::SeqCst);
        if !self.seeds_on.load(Ordering::SeqCst) {
            return vec![];
        }
        let ids = self.ids.lock().unwrap();
        ids.values().flat_map(|i| i.nodes.iter().flat_map(|(p, a)| a.iter().map(|a| (*p, a.clone())))).collect()
    }
}

/// Listings that answer at once, except for `STUCK`, whose answer never comes.
struct Own(Vec<Listing>);

impl Listings for Own {
    async fn site(&self, site: &str) -> Vec<Listing> {
        if site == STUCK {
            futures::future::pending::<()>().await;
        }
        self.0.iter().filter(|l| l.site == site).cloned().collect()
    }
}

fn anchor(id: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..id.len().min(32)].copy_from_slice(&id.as_bytes()[..id.len().min(32)]);
    a
}

fn listing(entry: &str, by: &str) -> Listing {
    Listing { entry_id: entry.into(), site: SITE.into(), description: "search flights".into(), contributor: by.into(), fee: 0.01, signed: None }
}

fn config(id: &str, version: &str) -> Config {
    let mut cfg = Config::new(Claim { identity: id.into(), index: 0 });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    cfg.version = version.into();
    cfg.registry_timeout = Duration::from_secs(1);
    cfg
}

async fn node(reg: &Arc<Reg>, id: &str, register: bool, own: Vec<Listing>) -> (Net, Vec<Multiaddr>) {
    node_with(reg, id, register, own, config(id, "1.0.0")).await
}

async fn node_with(reg: &Arc<Reg>, id: &str, register: bool, own: Vec<Listing>, cfg: Config) -> (Net, Vec<Multiaddr>) {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    let net = Net::start(key, cfg, reg.clone(), Arc::new(Own(own))).await.unwrap();
    let addrs = until(|| async { Some(net.listening().await).filter(|a| !a.is_empty()) }).await;
    if register {
        register_node(reg, id, &net, &addrs);
    }
    (net, addrs)
}

fn register_node(reg: &Arc<Reg>, id: &str, net: &Net, addrs: &[Multiaddr]) {
    let mut ids = reg.ids.lock().unwrap();
    let i = ids.entry(id.into()).or_insert_with(|| Identity { id: id.into(), anchor: anchor(id), nodes: vec![] });
    i.nodes.push((net.peer_id(), addrs.to_vec()));
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

async fn knows(net: &Net, peer: PeerId) -> bool {
    net.table().await.iter().any(|(p, _)| *p == peer)
}

/// Two nodes boot together and say where they are only after each has read the registry once and found nobody, as a
/// node publishes after its network starts. They find each other anyway: a node that knows nobody reads the registry
/// again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nodes_booting_together_find_each_other() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(true, Ordering::SeqCst);
    let (a, a_addrs) = node(&reg, "0xa", false, vec![]).await;
    let (b, b_addrs) = node(&reg, "0xb", false, vec![]).await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(reg.seed_reads.load(Ordering::SeqCst) >= 2, "each read the registry before either had said where it is");
    register_node(&reg, "0xa", &a, &a_addrs);
    register_node(&reg, "0xb", &b, &b_addrs);
    until(|| async { (knows(&a, b.peer_id()).await && knows(&b, a.peer_id()).await).then_some(()) }).await;
}

/// Two nodes dial each other at the same moment, as nodes that boot together do when each reads the other from the
/// registry on the same schedule. They meet at once: each dial opens a connection of its own, so the two never become
/// one connection that both sides opened and neither can secure, which on a retry schedule both share would collide
/// again on every retry. Nothing else brings them together here: the registry hands out no seeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nodes_dialling_each_other_at_once_meet() {
    for _ in 0..5 {
        let reg = Arc::new(Reg::default());
        let (a, a_addrs) = node(&reg, "0xa", true, vec![]).await;
        let (b, b_addrs) = node(&reg, "0xb", true, vec![]).await;
        let t = Instant::now();
        let (ra, rb) = tokio::join!(a.dial(b_addrs[0].clone()), b.dial(a_addrs[0].clone()));
        ra.unwrap();
        rb.unwrap();
        until(|| async { (knows(&a, b.peer_id()).await && knows(&b, a.peer_id()).await).then_some(()) }).await;
        assert!(t.elapsed() < Duration::from_secs(10), "they meet on the first dial, not a retry: {:?}", t.elapsed());
        a.vanish().await;
        b.vanish().await;
    }
}

/// Two nodes that know only a third look the same site up at the same moment, as nodes that booted together and met
/// only the node that dialled them do when they bootstrap on one schedule. Each lookup asks the third, hears of the
/// other, and dials it, so the table's own dials cross. They meet all the same: a dial the table makes opens a port of
/// its own, as the node's do.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nodes_that_meet_through_the_table_at_once_meet() {
    for _ in 0..5 {
        let reg = Arc::new(Reg::default());
        let (s, s_addrs) = node(&reg, "0xs", true, vec![]).await;
        let (a, _) = node(&reg, "0xa", true, vec![]).await;
        let (b, _) = node(&reg, "0xb", true, vec![]).await;
        let (ra, rb) = tokio::join!(a.dial(s_addrs[0].clone()), b.dial(s_addrs[0].clone()));
        ra.unwrap();
        rb.unwrap();
        until(|| async { (knows(&a, s.peer_id()).await && knows(&b, s.peer_id()).await && knows(&s, a.peer_id()).await && knows(&s, b.peer_id()).await).then_some(()) }).await;
        let t = Instant::now();
        let _ = tokio::join!(a.find(SITE), b.find(SITE));
        until(|| async { (knows(&a, b.peer_id()).await && knows(&b, a.peer_id()).await).then_some(()) }).await;
        assert!(t.elapsed() < Duration::from_secs(10), "they meet on the lookups' own dials: {:?}", t.elapsed());
        for n in [&s, &a, &b] {
            n.vanish().await;
        }
    }
}

/// The registry hangs while a peer is met, then answers again. The peer counts once it does, though the read that hung
/// never returned.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admission_recovers_after_registry_stall() {
    let reg = Arc::new(Reg::default());
    let (a, a_addrs) = node(&reg, "0xa", true, vec![]).await;
    let (b, _) = node(&reg, "0xb", true, vec![]).await;
    reg.hang.lock().unwrap().insert("0xb".into());
    b.dial(a_addrs[0].clone()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_ne!(a.admit(b.peer_id()).await, Standing::Counts("0xb".into()), "nothing is known of b while the registry hangs");
    reg.hang.lock().unwrap().clear();
    let t = Instant::now();
    until(|| async { matches!(a.admit(b.peer_id()).await, Standing::Counts(_)).then_some(()) }).await;
    assert!(t.elapsed() < Duration::from_secs(30), "b counts soon after the registry answers again: {:?}", t.elapsed());
    until(|| async { knows(&a, b.peer_id()).await.then_some(()) }).await;
}

/// The registry fails (refused, reset) while a peer is met. That is no word on the peer: it isn't refused as
/// unregistered for the refusal's lifetime, and counts as soon as the registry answers.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_registry_that_fails_never_refuses_a_registered_peer() {
    let reg = Arc::new(Reg::default());
    let (a, a_addrs) = node(&reg, "0xa", true, vec![]).await;
    let (b, _) = node(&reg, "0xb", true, vec![]).await;
    reg.fail.lock().unwrap().insert("0xb".into());
    b.dial(a_addrs[0].clone()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_ne!(a.admit(b.peer_id()).await, Standing::Refused, "a failed read refuses nobody");
    reg.fail.lock().unwrap().clear();
    let t = Instant::now();
    until(|| async { matches!(a.admit(b.peer_id()).await, Standing::Counts(_)).then_some(()) }).await;
    assert!(t.elapsed() < Duration::from_secs(30), "b counts long before a refusal would lapse: {:?}", t.elapsed());
}

/// A peer admitted at a release the network takes is seen again at an older one, under the same key: it no longer
/// counts, though its admission hadn't lapsed. Seen again new enough, it is judged again and counts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn too_old_peer_never_counts() {
    let reg = Arc::new(Reg::default());
    let mut cfg = config("0xa", "2.0.0");
    cfg.min_peer_version = Some("2.0.0".into());
    let (a, a_addrs) = node_with(&reg, "0xa", true, vec![], cfg).await;
    let key = grind("0xb", &anchor("0xb"), 0, RULES.position_bits);
    let start = |version: &str| Net::start(key.clone(), config("0xb", version), reg.clone(), Arc::new(Own(vec![listing(ENTRY_A, "0xb")])));

    let b_new = start("2.0.0").await.unwrap();
    let addrs = until(|| async { Some(b_new.listening().await).filter(|a| !a.is_empty()) }).await;
    register_node(&reg, "0xb", &b_new, &addrs);
    b_new.dial(a_addrs[0].clone()).await.unwrap();
    until(|| async { matches!(a.admit(b_new.peer_id()).await, Standing::Counts(_)).then_some(()) }).await;
    // The first lookups each node makes once it knows the other are over: from here nobody dials the release that
    // was admitted, and only the older one speaks for the key.
    tokio::time::sleep(Duration::from_secs(5)).await;

    let b_old = start("1.0.0").await.unwrap();
    b_old.dial(a_addrs[0].clone()).await.unwrap();
    until(|| async { (!matches!(a.admit(b_old.peer_id()).await, Standing::Counts(_))).then_some(()) }).await;
    for _ in 0..10 {
        assert!(!matches!(a.admit(b_old.peer_id()).await, Standing::Counts(_)), "a peer seen too old never counts");
        assert!(!knows(&a, b_old.peer_id()).await, "nor stays in the table");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    let b_back = start("2.0.0").await.unwrap();
    b_back.dial(a_addrs[0].clone()).await.unwrap();
    until(|| async { matches!(a.admit(b_back.peer_id()).await, Standing::Counts(_)).then_some(()) }).await;
}

/// A provider whose answer for one site never comes is asked for it more times than it answers at once. It still
/// answers every seeker for every other site: a stuck answer is given up, and its slot given back.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn listings_answering_survives_a_stuck_answer() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(true, Ordering::SeqCst);
    let (_seed, _) = node(&reg, "0xs", true, vec![]).await;
    let (a, _) = node(&reg, "0xa", true, vec![listing(ENTRY_A, "0xa")]).await;
    let (s1, _) = node(&reg, "0xc", true, vec![]).await;
    let (s2, _) = node(&reg, "0xd", true, vec![]).await;
    for n in [&a, &s1, &s2] {
        until(|| async { (!n.table().await.is_empty()).then_some(()) }).await;
    }
    a.provide(SITE).await.unwrap();
    a.provide(STUCK).await.unwrap();
    until(|| async { Some(s2.find(SITE).await.ok()?).filter(|f| f.sources == ["0xa"]) }).await;

    let asks: Vec<_> = (0..20)
        .map(|_| {
            let s1 = s1.clone();
            tokio::spawn(async move { s1.find(STUCK).await })
        })
        .collect();
    for h in asks {
        let found = h.await.unwrap().unwrap();
        assert!(found.sources.is_empty(), "a stuck answer is no answer, not an empty one");
    }
    let t = Instant::now();
    let found = until(|| async { Some(s2.find(SITE).await.ok()?).filter(|f| f.sources == ["0xa"]) }).await;
    assert_eq!(found.listings.len(), 1);
    assert!(t.elapsed() < Duration::from_secs(30), "the provider answers again: {:?}", t.elapsed());
}

/// A provider holds more listings for a site than one answer may carry. Its answer carries what fits, rather than
/// nothing: the seeker counts it as a source.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn listings_answer_fits_its_bound() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(true, Ordering::SeqCst);
    let (_seed, _) = node(&reg, "0xs", true, vec![]).await;
    // 48 listings of about 6 KiB: past the 256 KiB an answer may hold, and past the 32 one source may give.
    let big: Vec<Listing> =
        (0..48).map(|i| Listing { entry_id: format!("0x{i:064x}"), site: SITE.into(), description: "d".repeat(6 * 1024), contributor: "0xb".into(), fee: 0.01, signed: None }).collect();
    let (b, _) = node(&reg, "0xb", true, big).await;
    let (s, _) = node(&reg, "0xc", true, vec![]).await;
    for n in [&b, &s] {
        until(|| async { (!n.table().await.is_empty()).then_some(()) }).await;
    }
    b.provide(SITE).await.unwrap();
    let found = until(|| async { Some(s.find(SITE).await.ok()?).filter(|f| !f.sources.is_empty()) }).await;
    assert_eq!(found.sources, ["0xb"]);
    assert!(!found.listings.is_empty() && found.listings.len() <= 32, "{} listings", found.listings.len());
    // The ones kept are the provider's first, in its order.
    assert_eq!(found.listings[0].entry_id, format!("0x{:064x}", 0));
}

/// Two nodes form a network; a third meets them before it has said where it is, as a node's network starts before it
/// publishes, so each reads no node of its identity and turns it away. It then publishes and lists a site at once.
/// Both find the site within a bound: a peer the registry doesn't list yet is not one the registry refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_site_listed_by_nodes_booting_together_is_found() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(true, Ordering::SeqCst);
    let (b, _) = node(&reg, "0xb", true, vec![]).await;
    let (c, _) = node(&reg, "0xc", true, vec![]).await;
    for n in [&b, &c] {
        until(|| async { (!n.table().await.is_empty()).then_some(()) }).await;
    }
    let (a, a_addrs) = node(&reg, "0xa", false, vec![listing(ENTRY_A, "0xa")]).await;
    until(|| async { (b.admit(a.peer_id()).await == Standing::Refused && c.admit(a.peer_id()).await == Standing::Refused).then_some(()) }).await;
    register_node(&reg, "0xa", &a, &a_addrs);
    a.provide(SITE).await.unwrap();
    let t = Instant::now();
    for n in [&b, &c] {
        until(|| async { Some(n.find(SITE).await.ok()?).filter(|f| f.sources == ["0xa"]) }).await;
    }
    assert!(t.elapsed() < Duration::from_secs(40), "found long before a refusal would lapse: {:?}", t.elapsed());
}

/// A node announces a site while the others still turn it away as unlisted, then publishes and announces nothing
/// more. Nothing new connects (no peer is asked to dial back), so only the turned-away peer being asked again, while
/// it is still connected, lets the others find the site; a refusal that only lapses is never acted on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn what_a_node_announced_before_it_was_listed_is_found_once_it_is() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(true, Ordering::SeqCst);
    let short = |id: &str| {
        let mut cfg = config(id, "1.0.0");
        cfg.refusal_ttl = Duration::from_secs(5);
        cfg.probe = Duration::from_secs(3600);
        cfg
    };
    let (b, _) = node_with(&reg, "0xb", true, vec![], short("0xb")).await;
    let (c, _) = node_with(&reg, "0xc", true, vec![], short("0xc")).await;
    for n in [&b, &c] {
        until(|| async { (!n.table().await.is_empty()).then_some(()) }).await;
    }
    let (a, a_addrs) = node_with(&reg, "0xa", false, vec![listing(ENTRY_A, "0xa")], short("0xa")).await;
    until(|| async { (b.admit(a.peer_id()).await == Standing::Refused && c.admit(a.peer_id()).await == Standing::Refused).then_some(()) }).await;
    a.provide(SITE).await.unwrap();
    register_node(&reg, "0xa", &a, &a_addrs);
    let t = Instant::now();
    for n in [&b, &c] {
        until(|| async { Some(n.find(SITE).await.ok()?).filter(|f| f.sources == ["0xa"]) }).await;
    }
    assert!(t.elapsed() < Duration::from_secs(40), "{:?}", t.elapsed());
}

/// A peer refused after it counted takes its provider records with it: AGENTS.md's rule, however it came to be refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_refused_after_it_counted_leaves_no_provider_record() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(true, Ordering::SeqCst);
    let short = |id: &str| {
        let mut cfg = config(id, "1.0.0");
        cfg.admission_ttl = Duration::from_secs(4);
        cfg
    };
    let (a, _) = node_with(&reg, "0xa", true, vec![], short("0xa")).await;
    let (b, _) = node_with(&reg, "0xb", true, vec![], short("0xb")).await;
    until(|| async { (knows(&a, b.peer_id()).await && knows(&b, a.peer_id()).await).then_some(()) }).await;
    until(|| async { b.provide(SITE).await.ok()?; a.recorded_site_providers(SITE).await.contains(&b.peer_id()).then_some(()) }).await;
    // The identity no longer places the peer where it sits: the registry's word when it is next read.
    reg.ids.lock().unwrap().get_mut("0xb").unwrap().anchor = [7u8; 32];
    until(|| async { (a.admit(b.peer_id()).await == Standing::Refused).then_some(()) }).await;
    assert!(!a.recorded_site_providers(SITE).await.contains(&b.peer_id()));
}
