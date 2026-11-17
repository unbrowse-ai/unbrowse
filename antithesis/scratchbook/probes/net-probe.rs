//! Scratch probes for the Antithesis research pass. Not part of the repo.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use unbrowse_net::{grind, Claim, Config, Identity, Listing, Listings, Multiaddr, Net, PeerId, Registry, Rules, Standing};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };
const SITE: &str = "example.com";
const SLOW: &str = "slow.example";
const ENTRY_A: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";

/// A registry that can hang reads for chosen identities (a blackholed RPC), hand out no seeds until told to, and
/// count reads.
#[derive(Default)]
struct Reg {
    ids: Mutex<HashMap<String, Identity>>,
    hang: Mutex<HashSet<String>>,
    seeds_on: AtomicBool,
    identity_reads: AtomicUsize,
    seed_reads: AtomicUsize,
}

impl Registry for Reg {
    async fn identity(&self, id: &str) -> Option<Identity> {
        self.identity_reads.fetch_add(1, Ordering::SeqCst);
        if self.hang.lock().unwrap().contains(id) {
            futures::future::pending::<()>().await;
        }
        self.ids.lock().unwrap().get(id).cloned()
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

/// Listings that answer `SITE` at once and hang forever on `SLOW` (an answer waiting on a chain read that never returns).
struct Own(Vec<Listing>);
impl Listings for Own {
    async fn site(&self, site: &str) -> Vec<Listing> {
        if site == SLOW {
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
    Listing { entry_id: entry.into(), site: SITE.into(), description: "x".into(), contributor: by.into(), fee: 0.01, signed: None }
}

async fn node_with(reg: &Arc<Reg>, id: &str, register: bool, own: Vec<Listing>, tweak: impl FnOnce(&mut Config)) -> (Net, Vec<Multiaddr>) {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    let mut cfg = Config::new(Claim { identity: id.into(), index: 0 });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    tweak(&mut cfg);
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

async fn until<T, F: std::future::Future<Output = Option<T>>>(mut f: impl FnMut() -> F) -> T {
    for _ in 0..300 {
        if let Some(t) = f().await {
            return t;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out");
}

/// D2: a node with a minimum version meets a registered peer older than it. The spec (update.rs:9-10) says the peer is
/// refused. Counts how often it ends up counting instead, over fresh pairs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn probe_version_gate() {
    let mut outcomes: HashMap<String, usize> = HashMap::new();
    let mut listings_used = 0;
    for trial in 0..20 {
        let reg = Arc::new(Reg::default());
        let a_id = format!("0xa{trial}");
        let b_id = format!("0xb{trial}");
        let (a, _a_addrs) = node_with(&reg, &a_id, true, vec![], |c| {
            c.version = "2.0.0".into();
            c.min_peer_version = Some("2.0.0".into());
        })
        .await;
        let (b, _b_addrs) = node_with(&reg, &b_id, true, vec![listing(ENTRY_A, &b_id)], |c| c.version = "1.0.0".into()).await;
        // The old node dials the new one, as joining from the registry would.
        b.dial(_a_addrs[0].clone()).await.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
        let s = a.admit(b.peer_id()).await;
        let key = match &s {
            Standing::Counts(_) => "Counts",
            Standing::Refused => "Refused",
            Standing::Unreachable => "Unreachable",
        };
        *outcomes.entry(key.into()).or_default() += 1;
        if matches!(s, Standing::Counts(_)) {
            // Does the new node then use the old node's listings?
            let _ = b.provide(SITE).await;
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Ok(f) = a.find(SITE).await {
                if !f.listings.is_empty() {
                    listings_used += 1;
                }
            }
            // And does it still count after the old node has reconnected (Identify seen again)?
            tokio::time::sleep(Duration::from_secs(1)).await;
            eprintln!("trial {trial}: after reconnect standing = {:?}", a.admit(b.peer_id()).await);
        }
        drop((a, b));
    }
    eprintln!("VERSION GATE outcomes for a too-old registered peer: {outcomes:?}; trials where the new node used the old node's listings: {listings_used}");
}

/// Registry read hangs: the node can never re-ask that peer, even after the registry answers again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn probe_registry_hang_wedges_admission() {
    let reg = Arc::new(Reg::default());
    let (a, a_addrs) = node_with(&reg, "0xa", true, vec![], |_| {}).await;
    let (b, _) = node_with(&reg, "0xb", true, vec![], |_| {}).await;
    reg.hang.lock().unwrap().insert("0xb".into());
    b.dial(a_addrs[0].clone()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    // The registry recovers: every read from now on answers at once.
    reg.hang.lock().unwrap().clear();
    let reads_before = reg.identity_reads.load(Ordering::SeqCst);
    let t = std::time::Instant::now();
    let s1 = a.admit(b.peer_id()).await;
    eprintln!("REGISTRY HANG: after recovery, admit took {:?} -> {s1:?}", t.elapsed());
    // Drop and remake the connection: a fresh connection doesn't ask either.
    let s2 = a.admit(b.peer_id()).await;
    let reads_after = reg.identity_reads.load(Ordering::SeqCst);
    eprintln!("REGISTRY HANG: second admit -> {s2:?}; identity reads for the pair after recovery: {}", reads_after - reads_before);
    let in_table = a.table().await.iter().any(|(p, _)| *p == b.peer_id());
    eprintln!("REGISTRY HANG: b in a's table: {in_table}; b's view of a: {:?}", b.admit(a.peer_id()).await);
}

/// D3: two nodes boot together and publish where they are only after their first seed read (as peers.rs publishes
/// after Net::start). Nobody dials anybody else: do they ever meet?
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn probe_join_reads_seeds_once() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(true, Ordering::SeqCst);
    let (a, a_addrs) = node_with(&reg, "0xa", false, vec![], |_| {}).await;
    let (b, b_addrs) = node_with(&reg, "0xb", false, vec![], |_| {}).await;
    // Both publish after their first seed read (3 s after start).
    tokio::time::sleep(Duration::from_secs(4)).await;
    register_node(&reg, "0xa", &a, &a_addrs);
    register_node(&reg, "0xb", &b, &b_addrs);
    let seeds_at_publish = reg.seed_reads.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(30)).await;
    eprintln!(
        "JOIN: 30 s after both published: a's table {} peers, b's table {} peers; seed reads at publish {seeds_at_publish}, now {}",
        a.table().await.len(),
        b.table().await.len(),
        reg.seed_reads.load(Ordering::SeqCst)
    );
    // A third node that boots now joins both and the network forms through it.
    let (c, _) = node_with(&reg, "0xc", true, vec![], |_| {}).await;
    tokio::time::sleep(Duration::from_secs(8)).await;
    eprintln!("JOIN: after a third node boots: a {} b {} c {}", a.table().await.len(), b.table().await.len(), c.table().await.len());
}

/// Listings answers stall node-wide: 16 asks whose answer never comes (a chain read that hangs) leave no room for any
/// other seeker's ask, for any site, even after the cause is gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn probe_listings_slots_exhausted() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(true, Ordering::SeqCst);
    let (_seed, _) = node_with(&reg, "0xs", true, vec![], |_| {}).await;
    let (a, _) = node_with(&reg, "0xa", true, vec![listing(ENTRY_A, "0xa")], |_| {}).await;
    let (s1, _) = node_with(&reg, "0xc", true, vec![], |_| {}).await;
    let (s2, _) = node_with(&reg, "0xd", true, vec![], |_| {}).await;
    for n in [&a, &s1, &s2] {
        until(|| async { if n.table().await.is_empty() { None } else { Some(()) } }).await;
    }
    a.provide(SITE).await.unwrap();
    a.provide(SLOW).await.unwrap();
    // Control: s2 finds the site's listing before anything stalls.
    let before = until(|| async { Some(s2.find(SITE).await.ok()?).filter(|f| !f.listings.is_empty()) }).await;
    eprintln!("LISTINGS: before, s2 found {} listing(s) from {:?}", before.listings.len(), before.sources);
    // s1 asks 20 times at once for the slow site; each answer waits forever.
    let asks: Vec<_> = (0..20).map(|_| { let s1 = s1.clone(); tokio::spawn(async move { s1.find(SLOW).await }) }).collect();
    for h in asks {
        let _ = h.await;
    }
    // Control: a second provider of the same site, which never stalled.
    let (e, _) = node_with(&reg, "0xe", true, vec![listing("0x00000000000000000000000000000000000000000000000000000000000000ee", "0xe")], |_| {}).await;
    until(|| async { if e.table().await.is_empty() { None } else { Some(()) } }).await;
    e.provide(SITE).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    // s2 asks for the site that answers at once, three times.
    for i in 0..3 {
        let t = std::time::Instant::now();
        let f = s2.find(SITE).await.unwrap();
        eprintln!("LISTINGS: after the stall, try {i}: s2 found {} listing(s) from {:?} in {:?}", f.listings.len(), f.sources, t.elapsed());
    }
}

/// D2, the path with no race: a peer admitted at one release is later seen (by Identify) at a release older than the
/// node takes. The too-old branch inserts a refusal but leaves the admission: does the peer still count?
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn probe_admitted_peer_seen_too_old_still_counts() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(false, Ordering::SeqCst);
    let (a, a_addrs) = node_with(&reg, "0xa", true, vec![], |c| {
        c.version = "2.0.0".into();
        c.min_peer_version = Some("2.0.0".into());
    })
    .await;
    // b at a release a takes, then the same key at an older one (a rollback, or two installs of one identity's slot).
    let key = grind("0xb", &anchor("0xb"), 0, RULES.position_bits);
    let start = |version: &str| {
        let mut cfg = Config::new(Claim { identity: "0xb".into(), index: 0 });
        cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
        cfg.announce_listen = true;
        cfg.rules = RULES;
        cfg.version = version.into();
        Net::start(key.clone(), cfg, reg.clone(), Arc::new(Own(vec![listing(ENTRY_A, "0xb")])))
    };
    let b_new = start("2.0.0").await.unwrap();
    let addrs = until(|| async { Some(b_new.listening().await).filter(|a| !a.is_empty()) }).await;
    register_node(&reg, "0xb", &b_new, &addrs);
    b_new.dial(a_addrs[0].clone()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    eprintln!("ROLLBACK: a's view of b at 2.0.0: {:?}", a.admit(b_new.peer_id()).await);
    let b_old = start("1.0.0").await.unwrap();
    b_old.dial(a_addrs[0].clone()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    eprintln!("ROLLBACK: a's view of the same peer after Identify said 1.0.0: {:?}", a.admit(b_old.peer_id()).await);
    let _ = b_old.provide(SITE).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let f = a.find(SITE).await.unwrap();
    eprintln!("ROLLBACK: a's lookup of the site: {} listing(s) from {:?}", f.listings.len(), f.sources);
}

/// A provider with more listings for a site than one answer may carry: does the seeker get the first 32 (as `kept`
/// suggests), or nothing from that source?
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn probe_oversized_listings_answer() {
    let reg = Arc::new(Reg::default());
    reg.seeds_on.store(true, Ordering::SeqCst);
    let (_seed, _) = node_with(&reg, "0xs", true, vec![], |_| {}).await;
    let big = |n: usize| -> Vec<Listing> {
        (0..n)
            .map(|i| Listing { entry_id: format!("0x{i:064x}"), site: SITE.into(), description: "d".repeat(6 * 1024), contributor: "0xa".into(), fee: 0.01, signed: None })
            .collect()
    };
    // 36 listings of about 6 KiB: under the 7 KiB a signed listing may take, about 220 KiB together.
    let (a, _) = node_with(&reg, "0xa", true, big(36), |_| {}).await;
    // 48 of them: about 295 KiB, past the 256 KiB an answer may hold.
    let (b, _) = node_with(&reg, "0xb", true, big(48).into_iter().map(|mut l| { l.contributor = "0xb".into(); l }).collect(), |_| {}).await;
    let (s, _) = node_with(&reg, "0xc", true, vec![], |_| {}).await;
    for n in [&a, &b, &s] {
        until(|| async { if n.table().await.is_empty() { None } else { Some(()) } }).await;
    }
    a.provide(SITE).await.unwrap();
    b.provide(SITE).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    for _ in 0..3 {
        let f = s.find(SITE).await.unwrap();
        eprintln!("OVERSIZE: seeker got {} listing(s) from sources {:?} (a answers 36 small-enough, b answers 48)", f.listings.len(), f.sources);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
