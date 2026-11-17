//! Watchtower hand-overs between nodes on one machine, over real TCP: a node hands a peer the bytes of its lines and
//! hears that the peer holds them; a peer that won't hold them says why; a node that watches for no one refuses; a
//! peer past its rate is refused at once; a hand-over past the bound is never sent.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use unbrowse_net::{grind, Claim, Config, HandError, Identity, Listing, Listings, Multiaddr, Net, NoBodies, PeerId, Registry, Rules, Towers, MAX_HANDED_BYTES};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };

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

/// A tower's store: it keeps what it is handed, by who handed it, unless it starts with `refuse`.
#[derive(Default)]
struct Held(Mutex<Vec<(PeerId, Vec<u8>)>>);

impl Towers for Held {
    async fn hold(&self, from: PeerId, handed: &[u8]) -> Result<(), String> {
        assert_ne!(handed, A_BUG, "a bug in the store, as a panic");
        if handed.starts_with(b"refuse") {
            return Err("the lines don't check".into());
        }
        self.0.lock().unwrap().push((from, handed.to_vec()));
        Ok(())
    }
}

fn anchor(id: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..id.len().min(32)].copy_from_slice(&id.as_bytes()[..id.len().min(32)]);
    a
}

async fn node<T: Towers>(reg: &Arc<Reg>, id: &str, towers: Option<Arc<T>>) -> Net {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    let mut cfg = Config::new(Claim { identity: id.into(), index: 0 });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    let net = match towers {
        Some(t) => Net::start_with(key, cfg, reg.clone(), Arc::new(NoListings), Arc::new(NoBodies), t).await.unwrap(),
        None => Net::start(key, cfg, reg.clone(), Arc::new(NoListings)).await.unwrap(),
    };
    let addrs = until(|| async { Some(net.listening().await).filter(|a| !a.is_empty()) }).await;
    let mut ids = reg.0.lock().unwrap();
    ids.entry(id.into()).or_insert_with(|| Identity { id: id.into(), anchor: anchor(id), nodes: vec![] }).nodes.push((net.peer_id(), addrs));
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

/// A hand-over the tower panics checking.
const A_BUG: &[u8] = b"a bug";

/// A tower that panics checking a hand-over gives back its place among the checks running: the hand-over is refused, and
/// the next is checked, however many there were.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panic_checking_a_hand_over_never_costs_a_place() {
    let reg = Arc::new(Reg(Mutex::default()));
    let held = Arc::new(Held::default());
    let tower = node(&reg, "0xtower", Some(held.clone())).await;
    let client = node::<Held>(&reg, "0xclient", None).await;
    until(|| async { matches!(client.admit(tower.peer_id()).await, unbrowse_net::Standing::Counts(_)).then_some(()) }).await;
    until(|| async { matches!(tower.admit(client.peer_id()).await, unbrowse_net::Standing::Counts(_)).then_some(()) }).await;
    for _ in 0..10 {
        assert!(client.hand_over(tower.peer_id(), A_BUG.to_vec()).await.is_err());
    }
    assert_eq!(client.hand_over(tower.peer_id(), b"lines".to_vec()).await, Ok(()), "the checks came back");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_hands_its_lines_to_a_tower_which_holds_them_or_says_why_not() {
    let reg = Arc::new(Reg::default());
    let held = Arc::new(Held::default());
    let tower = node(&reg, "0xt", Some(held.clone())).await;
    let payer = node::<Held>(&reg, "0xp", None).await;
    let none = node::<Held>(&reg, "0xn", None).await;
    for n in [&tower, &payer, &none] {
        until(|| async { if n.table().await.is_empty() { None } else { Some(()) } }).await;
    }

    payer.hand_over(tower.peer_id(), b"[{\"line\":0}]".to_vec()).await.unwrap();
    assert_eq!(held.0.lock().unwrap().clone(), [(payer.peer_id(), b"[{\"line\":0}]".to_vec())], "the tower holds the bytes, as sent, by who sent them");

    let refused = payer.hand_over(tower.peer_id(), b"refuse these".to_vec()).await.unwrap_err();
    assert_eq!(refused, HandError::Refused("the lines don't check".into()), "the tower's own reason comes back");
    let no_one = payer.hand_over(none.peer_id(), b"[]".to_vec()).await.unwrap_err();
    assert!(matches!(no_one, HandError::Refused(r) if r.contains("watches for no one")), "a node started without towers refuses");
    assert_eq!(payer.hand_over(payer.peer_id(), b"[]".to_vec()).await.unwrap_err(), HandError::Refused("a node doesn't hand lines to itself".into()));

    assert_eq!(payer.hand_over(tower.peer_id(), vec![b'x'; MAX_HANDED_BYTES + 1]).await.unwrap_err(), HandError::TooLarge);
    assert_eq!(held.0.lock().unwrap().len(), 1, "nothing past the bound reached the tower");

    // A burst, then one at a time: a peer past its rate is refused before its lines are read.
    let mut rated = None;
    for i in 0..40 {
        if let Err(e) = payer.hand_over(tower.peer_id(), format!("[{i}]").into_bytes()).await {
            rated = Some(e);
            break;
        }
    }
    assert!(matches!(rated, Some(HandError::Refused(r)) if r.contains("too many hand-overs from this peer")), "a peer handing over without pause is slowed");
}
