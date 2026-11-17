//! Whether the node is alive, and whether it is ready, said apart as a probe would read them (`GET /v1/health`). A
//! node that answers is alive. A local node (the owner keeps it off the network) is ready once its root key and
//! identity are: it needs no chain (R1.35). A node on the network is ready once each part it needs to take part is up:
//! its chain, the Settlement contract on it, its root key, the wallet that key is, and the peer network.
//!
//! The node joins the peer network on its own wallet, with no sign-in (spec §86), once its chain, Settlement and key
//! are ready (`to_join`): a node that couldn't be paid, or couldn't sign what it serves, never offers to serve. Its
//! first write, the identity registration, is paid from that wallet, so a node whose wallet holds no USDC yet says so
//! here and joins once it does.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::{chain, update, Node};
use crate::sync::Locked;

/// One part of readiness: whether it is up, and what it is or why not, in a line.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Check {
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Health {
    /// Always true in an answer: a node that isn't alive doesn't answer.
    pub alive: bool,
    /// Every check is ok.
    pub ready: bool,
    pub checks: BTreeMap<&'static str, Check>,
}

fn check(r: Result<String, String>) -> Check {
    match r {
        Ok(detail) => Check { ok: true, detail },
        Err(detail) => Check { ok: false, detail },
    }
}

/// The chain answers: the live network's RPC as the chain it is named for, or the devnet started. Its name only: the
/// owner's RPC address can carry their provider's key, and this answer goes to anyone on this machine.
fn chain_up(n: &Node) -> Result<String, String> {
    if let Some(e) = n.chain_error.locked().clone() {
        return Err(e);
    }
    match (n.chain.network(), n.chain.deployed()) {
        // The second RPC's state too, loudly when one is missing: never its address, which can carry a provider's key.
        (Some(net), _) => {
            let line = match crate::rpc::second_rpc_state() {
                (state, Some(held)) => format!("{} (second RPC {state}: {held})", net.name),
                (state, None) => format!("{} (second RPC {state})", net.name),
            };
            // While the two RPCs' logs disagree, the owner sees it here for as long as it lasts (R11-CHAIN-3).
            Ok(match crate::chain::ranking_disagrees() {
                Some(why) => format!("{line}; route reputation isn't read on while the RPCs disagree: {why}"),
                None => line,
            })
        }
        (None, Ok(_)) => Ok("the devnet".to_string()),
        (None, Err(_)) => Err("the chain is still starting".into()),
    }
}

fn settlement(n: &Node) -> Result<String, String> {
    n.chain.deployed().map(|d| format!("Settlement {:#x}", d.settlement))
}

fn keys(n: &Node) -> Result<String, String> {
    n.key().map(|_| "the root key is readable".to_string())
}

/// The wallet the root key is, on Arc: the node's own, which it joins, pays and earns with. Said ready, never named:
/// this answer needs no token, and an address would tie this machine's account to the owner's wallet and its history
/// for anyone on it. The owner reads it with their token (`identity`).
fn identity(n: &Node) -> Result<String, String> {
    chain::owner_address(n.key()?).map(|_| "ready: this node's own wallet on Arc".to_string())
}

fn network(n: &Node) -> Result<String, String> {
    match crate::terms::standing(&crate::store::load_settings()) {
        // Turned off with the node running: it is still there until the restart that takes it off goes through.
        crate::terms::Standing::KeptOff if n.peers().is_some() => return Ok("leaving: the owner took this node off the peer network, and it leaves once no call is under way".into()),
        crate::terms::Standing::KeptOff => return Ok("off: the owner keeps this node off the peer network".into()),
        // As local as a node kept off, and as ready: it waits on its owner, and nothing here is broken.
        crate::terms::Standing::TermsDue => return Ok(format!("waiting: {}", crate::terms::due())),
        crate::terms::Standing::Joins => {}
    }
    if !on_network(n) {
        return Ok(LOCAL.into());
    }
    if update::below_minimum() {
        return Err(format!("this node is older than the network takes ({}): it joins once it has updated", update::min_version().unwrap_or_default()));
    }
    if n.peers().is_some() {
        return Ok("joined".into());
    }
    if n.net.get().is_some() {
        return Err("left the peer network to restart, and didn't start again: restart the node to rejoin".into());
    }
    to_join(n)?;
    Err(match JOIN_ERROR.locked().clone() {
        Some(e) => format!("joining: {e}"),
        None => "joining".into(),
    })
}

#[cfg(test)]
pub(crate) fn network_said(n: &Node) -> Result<String, String> {
    network(n)
}

/// What a node the owner keeps off the network is: local, and ready as that (R1.35).
pub const LOCAL: &str = "local: the owner keeps this node off the network, so routes stay on this node (`unbrowse-node network on` joins on its own wallet; no sign-in needed)";

/// Why the node's last try to join the peer network failed, said by `network` while it tries again: most often that its
/// wallet holds no USDC yet for its identity's registration.
pub static JOIN_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Whether the node is on the network now (`link::on_network`): it has joined, on its own wallet or by a linked one,
/// and its owner keeps it on. A local node joins nothing.
fn on_network(n: &Node) -> bool {
    let Some(me) = n.key().ok().and_then(|k| chain::owner_address(k).ok()) else { return false };
    crate::link::on_network_since(&format!("{me:#x}")).is_some() && crate::network_on()
}

/// What must be ready before the node joins the peer network: that it is on the network, its chain, Settlement, and its
/// root key. Else the first that isn't, and why.
pub fn to_join(n: &Node) -> Result<(), String> {
    if !on_network(n) {
        return Err(LOCAL.into());
    }
    chain_up(n).map_err(|e| format!("waiting for the chain: {e}"))?;
    settlement(n).map_err(|e| format!("waiting for Settlement: {e}"))?;
    keys(n).map_err(|e| format!("waiting for the root key: {e}"))?;
    Ok(())
}

/// `detail` with every address taken out: a wallet or contract address (`0x` and 40 or more hex digits) and a web
/// address (which can carry a provider's key). What answers without a token names no identity, whatever a check's
/// error happened to say.
fn unnamed(detail: &str) -> String {
    detail
        .split(' ')
        .map(|w| {
            let bare = w.trim_matches(|c: char| !c.is_ascii_alphanumeric());
            let hex = bare.strip_prefix("0x").or_else(|| bare.strip_prefix("0X")).is_some_and(|h| h.len() >= 40 && h.chars().all(|c| c.is_ascii_hexdigit()));
            if hex || w.contains("://") {
                "[an address]"
            } else {
                w
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Where the node stands now.
pub fn of(n: &Node) -> Health {
    // A local node needs no chain (R1.35): while it is off the network, the chain and Settlement are said, never awaited.
    let local = !on_network(n);
    let needed = |r: Result<String, String>| match r {
        Err(e) if local => Ok(format!("not needed while the node is off the network ({e})")),
        r => r,
    };
    let checks: BTreeMap<&'static str, Check> = [
        ("chain", check(needed(chain_up(n)))),
        ("settlement", check(needed(settlement(n)))),
        ("keys", check(keys(n))),
        ("identity", check(identity(n))),
        ("network", check(network(n))),
    ]
    .into_iter()
    .map(|(k, c)| (k, Check { detail: unnamed(&c.detail), ..c }))
    .collect();
    Health { alive: true, ready: checks.values().all(|c| c.ok), checks }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::Shared;
    use crate::{arc, store, testchain};
    use std::sync::Arc;

    /// A node whose chain hasn't started is alive and not ready, and says what it waits for; the key and the identity
    /// it holds are ready already.
    #[test]
    fn a_node_whose_chain_has_not_started_is_alive_but_not_ready() {
        let _home = store::scratch_home("health-start");
        testchain::keep_local();
        let n = testchain::node("health");
        let h = of(&n);
        assert!(h.alive && h.ready, "a local node needs no chain to be ready: {h:?}");
        assert!(h.checks["chain"].detail.starts_with("not needed while the node is off the network"), "{h:?}");
        assert!(h.checks["keys"].ok && h.checks["identity"].ok, "{h:?}");
        assert!(h.checks["identity"].detail.ends_with("this node's own wallet on Arc"), "{h:?}");
        assert_eq!(to_join(&n).unwrap_err(), LOCAL, "kept off the network: the node is local");
        assert!(h.checks["network"].ok, "local is a node's ready state off the network");
        // The peer network on, with no sign-in: the node is on the network with its own wallet (spec §86).
        store::save_settings(&crate::terms::acknowledged(store::load_settings(), false)).unwrap();
        assert!(crate::link::load(&crate::identity(&n).unwrap().address).is_none(), "no wallet linked");
        let h = of(&n);
        assert!(h.alive && !h.ready, "on the network, it waits for its chain");
        assert!(!h.checks["chain"].ok && !h.checks["settlement"].ok);
        assert!(to_join(&n).unwrap_err().contains("waiting for the chain"));
        // Waiting on the Keychain: not ready on the key either.
        *n.identity.writing() = None;
        assert!(!of(&n).checks["keys"].ok && !of(&n).checks["identity"].ok);
    }

    /// A node on a live network with no Settlement on it: its chain answers, and it is alive but not ready. Its health
    /// says so over its port, and it never joins the peer network, so it announces and serves nothing, until
    /// Settlement is there. `cargo test -p unbrowse-node-app no_settlement -- --ignored` (needs Anvil).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_node_with_no_settlement_is_alive_but_not_ready_and_does_not_serve() {
        let _one = testchain::one_at_a_time().await;
        let home = testchain::home("health-no-settlement");
        let anvil = testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
        let _env = testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
        let n = testchain::node("no-settlement");
        let started = n.clone();
        tokio::time::timeout(std::time::Duration::from_secs(30), crate::start_chain(&started)).await.expect("the chain answers");
        // Signed in: the chain and Settlement are what it needs now.
        testchain::sign_in(&n);

        let h = of(&n);
        assert!(h.alive && !h.ready, "{h:?}");
        assert!(h.checks["chain"].ok, "{h:?}");
        assert!(!h.checks["settlement"].ok, "{h:?}");
        assert!(to_join(&n).unwrap_err().contains("waiting for Settlement"));

        // Over the node's own port, as a probe reads it.
        let port = testchain::free_port();
        let served = n.clone();
        let h2 = home.clone();
        tokio::spawn(async move {
            store::use_home(&h2);
            let _ = crate::api::serve(served, port, "owner".into()).await;
        });
        let url = format!("http://127.0.0.1:{port}/v1/health");
        let mut answer = None;
        for _ in 0..50 {
            if let Ok(r) = reqwest::get(&url).await {
                answer = Some((r.status(), r.json::<serde_json::Value>().await.unwrap()));
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let (status, body) = answer.expect("the node answers its health");
        assert!(status.is_success());
        assert_eq!((body["alive"].clone(), body["ready"].clone()), (serde_json::json!(true), serde_json::json!(false)), "{body}");
        assert_eq!(body["checks"]["settlement"]["ok"], serde_json::json!(false), "{body}");

        // It doesn't join, so nothing is announced or served, however long it waits.
        let joining = Arc::clone(&n);
        assert!(tokio::time::timeout(std::time::Duration::from_secs(5), crate::join_peers(joining, port)).await.is_err(), "join_peers returned");
        assert!(n.net.get().is_none(), "joined the peer network with no Settlement");
        crate::chain::forget_live();
    }

    /// What answers without a token names no identity: not the node's wallet, nor an address a check's error carries,
    /// nor the RPC the chain is read through.
    #[test]
    fn health_names_no_address() {
        let _home = store::scratch_home("health-names");
        testchain::keep_local();
        let n = testchain::node("health-names");
        let me = format!("{:#x}", chain::owner_address(n.key().unwrap()).unwrap());
        let said = serde_json::to_string(&of(&n)).unwrap().to_ascii_lowercase();
        assert!(!said.contains(&me[2..].to_ascii_lowercase()), "{said}");
        *JOIN_ERROR.locked() = Some(format!("fund {me} with USDC at https://rpc.example/v2/secret-key first"));
        let unnamed = unnamed(JOIN_ERROR.locked().as_deref().unwrap());
        *JOIN_ERROR.locked() = None;
        assert!(!unnamed.contains(&me) && !unnamed.contains("secret-key"), "{unnamed}");
        assert!(unnamed.starts_with("fund [an address] with USDC"), "{unnamed}");
    }
}
