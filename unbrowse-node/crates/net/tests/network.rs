//! Several nodes on one machine, over real TCP: registered nodes find a site's listings through the table; a node
//! the registry doesn't list can talk but never enters a routing table, and the listings it offers never arrive.
//! Nodes that listen on every interface, as nodes on different machines do, publish and dial only the addresses
//! another machine could.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use unbrowse_net::{dialable, grind, listen_all, Claim, Config, Identity, Listing, Listings, Multiaddr, Net, PeerId, Protocol, Registry, Rules};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };
const SITE: &str = "example.com";
/// Entry ids as the chain names them: 32 bytes, in hex.
const ENTRY_A: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ENTRY_D: &str = "0x0000000000000000000000000000000000000000000000000000000000000002";
const ENTRY_M: &str = "0x0000000000000000000000000000000000000000000000000000000000000066";

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

struct Own(Vec<Listing>);

impl Listings for Own {
    async fn site(&self, site: &str) -> Vec<Listing> {
        self.0.iter().filter(|l| l.site == site).cloned().collect()
    }
}

fn anchor(id: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..id.len().min(32)].copy_from_slice(&id.as_bytes()[..id.len().min(32)]);
    a
}

fn listing(entry: &str, by: &str) -> Listing {
    Listing { entry_id: entry.into(), site: SITE.into(), description: format!("search flights ({by})"), contributor: by.into(), fee: 0.01, signed: None }
}

/// Starts a node for `id`'s `index`th slot; `register` puts it in the registry the way an identity's metadata would.
async fn node(reg: &Arc<Reg>, id: &str, index: u32, register: bool, own: Vec<Listing>) -> Net {
    let key = grind(id, &anchor(id), index, RULES.position_bits);
    let mut cfg = Config::new(Claim { identity: id.into(), index });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    let net = Net::start(key, cfg, reg.clone(), Arc::new(Own(own))).await.unwrap();
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

async fn in_table(net: &Net) -> Vec<PeerId> {
    net.table().await.into_iter().map(|(p, _)| p).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registered_nodes_find_a_site_and_an_unlisted_node_never_counts() {
    let reg = Arc::new(Reg::default());
    let seed = node(&reg, "0xb", 0, true, vec![]).await;
    let a = node(&reg, "0xa", 0, true, vec![listing(ENTRY_A, "0xa")]).await;
    // A second node of the same identity: it may serve the identity's listings, but it is not a second opinion.
    let a2 = node(&reg, "0xa", 1, true, vec![listing(ENTRY_A, "0xa")]).await;
    let seeker = node(&reg, "0xc", 0, true, vec![]).await;
    // Not in the registry: it runs the same code and offers a listing of its own for the site.
    let mallory = node(&reg, "0xm", 0, false, vec![listing(ENTRY_M, "0xm")]).await;

    for n in [&seed, &a, &a2, &seeker, &mallory] {
        until(|| async { if in_table(n).await.is_empty() { None } else { Some(()) } }).await;
    }
    for n in [&a, &a2, &mallory] {
        n.provide(SITE).await.unwrap();
    }

    let found = until(|| async {
        let f = seeker.find(SITE).await.ok()?;
        Some(f).filter(|f| !f.listings.is_empty())
    })
    .await;
    assert_eq!(found.listings.iter().map(|l| l.entry_id.as_str()).collect::<Vec<_>>(), [ENTRY_A], "only the registered identity's listing arrives");
    assert_eq!(found.sources, ["0xa"], "two nodes of one identity are one source");
    assert!(!found.checked, "one identity can't check itself");

    for n in [&seed, &a, &a2, &seeker] {
        assert!(!in_table(n).await.contains(&mallory.peer_id()), "an unlisted node never enters a routing table");
    }

    // A second identity offering the site makes the lookup checked, and both listings arrive.
    let d = node(&reg, "0xd", 0, true, vec![listing(ENTRY_D, "0xd")]).await;
    until(|| async { if in_table(&d).await.is_empty() { None } else { Some(()) } }).await;
    d.provide(SITE).await.unwrap();
    let found = until(|| async {
        let f = seeker.find(SITE).await.ok()?;
        Some(f).filter(|f| f.checked)
    })
    .await;
    let mut entries: Vec<_> = found.listings.iter().map(|l| l.entry_id.clone()).collect();
    entries.sort();
    assert_eq!(entries, [ENTRY_A, ENTRY_D]);
    let mut sources = found.sources.clone();
    sources.sort();
    assert_eq!(sources, ["0xa", "0xd"]);
}

/// Starts a node the way one on its own machine runs: on every interface, nothing taken as reachable until a peer has
/// dialled it back. It registers what it publishes. None when this machine has no address but loopback.
async fn reachable_node(reg: &Arc<Reg>, id: &str, own: Vec<Listing>) -> Option<(Net, Vec<Multiaddr>)> {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    let mut cfg = Config::new(Claim { identity: id.into(), index: 0 });
    cfg.listen = listen_all(0);
    cfg.rules = RULES;
    cfg.probe = Duration::from_secs(1);
    let net = Net::start(key, cfg, reg.clone(), Arc::new(Own(own))).await.unwrap();
    until(|| async { Some(net.listening().await).filter(|a| !a.is_empty()) }).await;
    // Interfaces are reported one by one: what the node publishes is read once they stop coming.
    let mut published = net.published().await;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let now = net.published().await;
        if now == published {
            break;
        }
        published = now;
    }
    if published.is_empty() {
        return None;
    }
    let mut ids = reg.0.lock().unwrap();
    ids.insert(id.into(), Identity { id: id.into(), anchor: anchor(id), nodes: vec![(net.peer_id(), published.clone())] });
    Some((net, published))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nodes_reach_each_other_at_the_addresses_they_publish() {
    let reg = Arc::new(Reg::default());
    let Some((a, a_addrs)) = reachable_node(&reg, "0xa", vec![listing(ENTRY_A, "0xa")]).await else {
        // A machine whose only interface is loopback has nothing another machine could dial; the loopback test above
        // covers the table there.
        eprintln!("skipped: this machine has no interface address but loopback");
        return;
    };
    let (b, b_addrs) = reachable_node(&reg, "0xb", vec![]).await.expect("a second node finds the same interfaces");
    for addrs in [&a_addrs, &b_addrs] {
        assert!(addrs.iter().all(dialable), "only addresses another machine could dial are published: {addrs:?}");
    }

    // Each reaches the other through the registry, gets dialled back, serves the table, and keeps the other there
    // at addresses it published.
    for (n, other, published) in [(&a, &b, &b_addrs), (&b, &a, &a_addrs)] {
        let addrs = until(|| async { n.table().await.into_iter().find(|(p, _)| *p == other.peer_id()).map(|(_, a)| a) }).await;
        let bare = |a: &Multiaddr| a.iter().filter(|p| !matches!(p, Protocol::P2p(_))).collect::<Multiaddr>();
        assert!(!addrs.is_empty() && addrs.iter().all(|x| published.contains(&bare(x))), "{addrs:?} were published as {published:?}");
    }
    a.provide(SITE).await.unwrap();
    let found = until(|| async { Some(b.find(SITE).await.ok()?).filter(|f| !f.listings.is_empty()) }).await;
    assert_eq!(found.sources, ["0xa"]);
}
