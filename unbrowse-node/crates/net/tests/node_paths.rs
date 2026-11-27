//! Paths of the running node the other tests leave out, each on loopback with nodes started here: a node that can't
//! listen anywhere says so, a node asks nothing of itself, a peer nobody knows is unreachable, a saved routing table
//! brings a restarted node back without the registry's seeds, a node stops watching a site it no longer needs, and a
//! notice with no watcher connected is not published.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use unbrowse_net::{grind, Bodies, Change, ChangeKind, Claim, Config, FetchError, HandError, Identity, Listing, Listings, Multiaddr, Net, PeerId, Registry, Rules, Serve, Standing, Towers};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };
const SITE: &str = "example.com";
const BODY: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

/// A registry that lists every node started, and offers as seeds only the identities in `seeds`.
#[derive(Default)]
struct Reg {
    ids: Mutex<HashMap<String, Identity>>,
    seeds: Mutex<Vec<String>>,
}

impl Registry for Reg {
    async fn identity(&self, id: &str) -> Result<Option<Identity>, String> {
        Ok(self.ids.lock().unwrap().get(id).cloned())
    }
    async fn seeds(&self) -> Vec<(PeerId, Multiaddr)> {
        let (ids, seeds) = (self.ids.lock().unwrap(), self.seeds.lock().unwrap());
        ids.values().filter(|i| seeds.contains(&i.id)).flat_map(|i| i.nodes.iter().flat_map(|(p, a)| a.iter().map(|a| (*p, a.clone())))).collect()
    }
}

struct NoListings;

impl Listings for NoListings {
    async fn site(&self, _: &str) -> Vec<Listing> {
        vec![]
    }
}

struct Body;

impl Bodies for Body {
    async fn serve(&self, _: PeerId, content_id: &str, _: &[u8]) -> Result<Vec<u8>, String> {
        if content_id == BODY {
            Ok(b"the body".to_vec())
        } else {
            Err("no such body here".into())
        }
    }
}

#[derive(Default)]
struct Held(Mutex<Vec<Vec<u8>>>);

impl Towers for Held {
    async fn hold(&self, _: PeerId, handed: &[u8]) -> Result<(), String> {
        self.0.lock().unwrap().push(handed.to_vec());
        Ok(())
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

/// A node for `id` with `cfg`, registered once it listens; `seed` makes it one the registry offers to joiners.
async fn start(reg: &Arc<Reg>, id: &str, cfg: Config, seed: bool) -> Net {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    let net = Net::start_with(key, cfg, reg.clone(), Arc::new(NoListings), Arc::new(Body), Arc::new(Held::default())).await.unwrap();
    let addrs = until(|| async { Some(net.listening().await).filter(|a| !a.is_empty()) }).await;
    reg.ids.lock().unwrap().entry(id.into()).or_insert_with(|| Identity { id: id.into(), anchor: anchor(id), nodes: vec![] }).nodes.push((net.peer_id(), addrs));
    if seed {
        reg.seeds.lock().unwrap().push(id.into());
    }
    net
}

async fn node(reg: &Arc<Reg>, id: &str, seed: bool) -> Net {
    start(reg, id, config(id), seed).await
}

/// Waits until `f` gives a value, asking every 100 ms for 30 s; a wait that runs out names the line that waited.
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

async fn joined(net: &Net) {
    until(|| async { (!net.table().await.is_empty()).then_some(()) }).await;
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("unbrowse-net-node-paths-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_that_can_listen_on_no_address_says_so_instead_of_starting() {
    let reg = Arc::new(Reg::default());
    let mut cfg = config("0xa");
    // No websocket transport here: the address can't be listened on.
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0/ws".parse().unwrap()];
    let key = grind("0xa", &anchor("0xa"), 0, RULES.position_bits);
    let said = match Net::start(key, cfg, reg, Arc::new(NoListings)).await {
        Ok(_) => panic!("a node that listens nowhere started"),
        Err(e) => e,
    };
    assert!(said.contains("can't listen on any address") && said.contains("/ws"), "{said}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_asks_for_nothing_from_itself() {
    let reg = Arc::new(Reg::default());
    let a = node(&reg, "0xa", true).await;
    assert!(matches!(a.fetch_body(a.peer_id(), BODY, b"paid").await, Err(FetchError::Invalid(r)) if r.contains("itself")));
    assert!(matches!(a.hand_over(a.peer_id(), b"[]".to_vec()).await, Err(HandError::Refused(r)) if r.contains("itself")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_nobody_knows_is_unreachable_not_counted() {
    let reg = Arc::new(Reg::default());
    let a = node(&reg, "0xa", true).await;
    let stranger = PeerId::random();
    assert_eq!(a.admit(stranger).await, Standing::Unreachable);
    assert!(matches!(a.fetch_body(stranger, BODY, b"paid").await, Err(FetchError::Unanswered(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_node_joins_again_from_its_saved_table_without_the_registrys_seeds() {
    let reg = Arc::new(Reg::default());
    let seed = node(&reg, "0xs", true).await;
    let dir = scratch("saved");
    let table = dir.join("table.json");
    let mut cfg = config("0xa");
    cfg.saved = Some(table.clone());
    let first = start(&reg, "0xa", cfg.clone(), false).await;
    joined(&first).await;
    first.save().await;
    until(|| async { table.exists().then_some(()) }).await;
    let saved = std::fs::read_to_string(&table).unwrap();
    assert!(saved.contains(&seed.peer_id().to_string()), "the file names the peer it joined: {saved}");
    first.stop().await;

    // The registry no longer offers any seed: only the file can bring the node back.
    reg.seeds.lock().unwrap().clear();
    reg.ids.lock().unwrap().remove("0xa");
    let again = start(&reg, "0xa", cfg, false).await;
    until(|| async { again.table().await.iter().any(|(p, _)| *p == seed.peer_id()).then_some(()) }).await;
    again.stop().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_that_stops_watching_a_site_is_no_longer_among_its_watchers() {
    let reg = Arc::new(Reg::default());
    let lister = node(&reg, "0xa", true).await;
    let keeper = node(&reg, "0xk", false).await;
    joined(&keeper).await;
    lister.watch(vec![SITE.into()]).await.unwrap();
    keeper.watch(vec![SITE.into()]).await.unwrap();
    until(|| async { lister.watchers(SITE).await.contains(&keeper.peer_id()).then_some(()) }).await;
    keeper.watch(vec![]).await.unwrap();
    until(|| async { (!lister.watchers(SITE).await.contains(&keeper.peer_id())).then_some(()) }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_notice_with_no_node_watching_is_not_published_and_says_so() {
    let reg = Arc::new(Reg::default());
    let lone = node(&reg, "0xa", true).await;
    let said = lone.publish_change(Change::now(SITE, ChangeKind::Delisted, vec![format!("0x{:064x}", 1)])).await.unwrap_err();
    assert!(said.contains("no node that watches the site is connected"), "{said}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_node_joins_and_asks_but_is_not_asked_to_serve() {
    let reg = Arc::new(Reg::default());
    let seed = node(&reg, "0xs", true).await;
    let mut cfg = config("0xc");
    cfg.serve = Serve::Client;
    let client = start(&reg, "0xc", cfg, false).await;
    joined(&client).await;
    assert!(client.table().await.iter().any(|(p, _)| *p == seed.peer_id()));
}
