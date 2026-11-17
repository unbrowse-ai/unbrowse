//! Two releases a protocol version apart, on one machine over real TCP. The release that changes a protocol speaks the
//! new version beside the old one (`wire.rs`), so it talks to the release before, which speaks only the old one, and
//! to the release after, which speaks only the new one: admission, the table, listings, bodies, hand-overs to a
//! tower, change notices and goodbyes all cross. The release before and the release after, two versions apart, don't.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use unbrowse_net::{grind, Bodies, Change, ChangeKind, Claim, Config, Identity, Listing, Listings, Multiaddr, Net, PeerId, Registry, Rules, Speaks, Standing, Towers};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };
const SITE: &str = "example.com";
const BODY: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const RECIPE: &[u8] = br#"{"method":"GET","url":"https://example.com/api/items"}"#;
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

/// Every node lists one route on the site, serves its body to a caller that pays, and holds what it is handed.
#[derive(Default)]
struct Shop {
    held: Mutex<Vec<Vec<u8>>>,
}

impl Listings for Shop {
    async fn site(&self, site: &str) -> Vec<Listing> {
        vec![Listing { entry_id: "0x01".into(), site: site.into(), description: "Search items".into(), contributor: "0xc".into(), fee: 0.01, signed: None }]
    }
}

impl Bodies for Shop {
    async fn serve(&self, _: PeerId, content_id: &str, payment: &[u8]) -> Result<Vec<u8>, String> {
        (content_id == BODY && payment == PAID).then(|| RECIPE.to_vec()).ok_or_else(|| "not served".into())
    }
}

impl Towers for Shop {
    async fn hold(&self, _: PeerId, handed: &[u8]) -> Result<(), String> {
        self.held.lock().unwrap().push(handed.to_vec());
        Ok(())
    }
}

fn anchor(id: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..id.len().min(32)].copy_from_slice(&id.as_bytes()[..id.len().min(32)]);
    a
}

/// What the release before speaks: version 1 of everything, as this release does.
fn before() -> Speaks {
    Speaks::default()
}

/// The release that changes every protocol: version 2 first, version 1 beside it.
fn changing() -> Speaks {
    Speaks::every(&[2, 1])
}

/// The release after it, which dropped version 1.
fn after() -> Speaks {
    Speaks::every(&[2])
}

struct Node {
    net: Net,
    shop: Arc<Shop>,
    addrs: Vec<Multiaddr>,
}

async fn node(reg: &Arc<Reg>, id: &str, speaks: Speaks) -> Node {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    let mut cfg = Config::new(Claim { identity: id.into(), index: 0 });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    cfg.speaks = speaks;
    let shop = Arc::new(Shop::default());
    let net = Net::start_with(key, cfg, reg.clone(), shop.clone(), shop.clone(), shop.clone()).await.unwrap();
    let addrs = until(|| async { Some(net.listening().await).filter(|a| !a.is_empty()) }).await;
    let mut ids = reg.0.lock().unwrap();
    ids.entry(id.into()).or_insert_with(|| Identity { id: id.into(), anchor: anchor(id), nodes: vec![] }).nodes.push((net.peer_id(), addrs.clone()));
    drop(ids);
    Node { net, shop, addrs }
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

/// Two nodes of the given releases meet; then each protocol is used both ways, and the first says goodbye.
async fn they_talk(one: Speaks, other: Speaks) {
    let reg = Arc::new(Reg::default());
    let a = node(&reg, "0xa", one).await;
    let b = node(&reg, "0xb", other).await;
    for (x, y) in [(&a, &b), (&b, &a)] {
        // Each finds the other through the registry's seeds and admits it (hello) into its table.
        until(|| async { x.net.table().await.iter().any(|(p, _)| *p == y.net.peer_id()).then_some(()) }).await;
        assert!(matches!(x.net.admit(y.net.peer_id()).await, Standing::Counts(_)), "admitted");
        // Listings, bodies and hand-overs.
        let got = x.net.listings_from(y.net.peer_id(), SITE).await.expect("listings cross");
        assert_eq!(got.len(), 1);
        assert_eq!(x.net.fetch_body(y.net.peer_id(), BODY, PAID).await.expect("a body crosses"), RECIPE);
        x.net.hand_over(y.net.peer_id(), b"lines".to_vec()).await.expect("a hand-over crosses");
        assert_eq!(y.shop.held.lock().unwrap().last().map(Vec::as_slice), Some(&b"lines"[..]));
    }
    // Change notices, on the topic of a version both speak.
    let mut heard = b.net.changes().unwrap();
    a.net.watch(vec![SITE.into()]).await.unwrap();
    b.net.watch(vec![SITE.into()]).await.unwrap();
    until(|| async { a.net.watchers(SITE).await.contains(&b.net.peer_id()).then_some(()) }).await;
    let entry = format!("0x{:064x}", 1);
    until(|| async { a.net.publish_change(Change::now(SITE, ChangeKind::Delisted, vec![entry.clone()])).await.ok() }).await;
    let got = tokio::time::timeout(Duration::from_secs(10), heard.recv()).await.expect("a notice crosses").unwrap();
    assert_eq!((got.change.entries, got.from), (vec![entry], a.net.peer_id()));
    // A goodbye.
    a.net.stop().await;
    until(|| async { (!b.net.table().await.iter().any(|(p, _)| *p == a.net.peer_id())).then_some(()) }).await;
    assert_eq!(b.net.admit(a.net.peer_id()).await, Standing::Unreachable, "the goodbye was heard");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_release_that_changes_a_protocol_talks_to_the_release_before() {
    they_talk(before(), changing()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_release_after_a_change_talks_to_the_release_that_made_it() {
    they_talk(changing(), after()).await;
}

/// The old version is dropped the release after: a node two versions behind isn't spoken to.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_releases_apart_do_not_talk() {
    let reg = Arc::new(Reg::default());
    let a = node(&reg, "0xa", before()).await;
    let b = node(&reg, "0xb", after()).await;
    let _ = b.net.dial(a.addrs[0].clone()).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(b.net.table().await.is_empty() && a.net.table().await.is_empty(), "neither admits the other");
    assert!(!matches!(b.net.admit(a.net.peer_id()).await, Standing::Counts(_)));
    assert!(b.net.listings_from(a.net.peer_id(), SITE).await.is_err());
    assert!(b.net.fetch_body(a.net.peer_id(), BODY, PAID).await.is_err());
}

/// A node with no version of a protocol to speak doesn't start.
#[tokio::test]
async fn a_node_that_speaks_no_version_of_a_protocol_does_not_start() {
    let mut cfg = Config::new(Claim { identity: "0xa".into(), index: 0 });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.speaks = Speaks::default().with(unbrowse_net::wire::BODY, &[]);
    let key = grind("0xa", &anchor("0xa"), 0, RULES.position_bits);
    let shop = Arc::new(Shop::default());
    assert!(Net::start_with(key, cfg, Arc::new(Reg::default()), shop.clone(), shop.clone(), shop).await.is_err());
}
