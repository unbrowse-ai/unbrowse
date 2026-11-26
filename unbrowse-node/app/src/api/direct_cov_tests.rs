//! The peer door's refusals, asked of it directly (no swarm): what each says and in what order it says it.

use super::*;
use unbrowse_net::McpAsk;

fn a_node(unlocked: bool) -> Arc<Node> {
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let identity = if unlocked { Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true })) } else { None };
    Arc::new(Node {
        keys: Box::new(keys),
        identity: std::sync::RwLock::new(identity),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: crate::chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    })
}

fn ask(headers: &[(&str, &str)]) -> McpAsk {
    McpAsk { method: "POST".into(), target: "/mcp".into(), headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body: b"{}".to_vec() }
}

fn said(a: &McpAnswer) -> String {
    String::from_utf8_lossy(&a.body).into_owned()
}

/// A request with no signature is refused as unsigned before anything else is looked at, and one that is signed is
/// refused by whatever the node lacks: no key made for the peer network (403, said how to open it), a node still
/// locked (503, said why), a signature key that is none of the node's peer keys (401).
#[test]
fn the_peer_door_refuses_what_is_unsigned_then_what_the_node_cannot_yet_serve_then_a_stranger_key() {
    let home = store::scratch_home("direct-cov-refusals");
    store::use_home(&home);
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let from = PeerId::random();
    let node = a_node(true);
    let door = Direct::new(node.clone(), &from);
    let run = |door: &Direct, ask: McpAsk| rt.block_on(door.answer(from, ask));

    let unsigned = run(&door, ask(&[("content-type", "application/json")]));
    assert_eq!(unsigned.status, 401, "{}", said(&unsigned));
    assert!(said(&unsigned).contains("signed requests only") && !said(&unsigned).contains("bearer"), "{}", said(&unsigned));

    let signed = [(sig::KEY, "deadbeef")];
    let shut = run(&door, ask(&signed));
    assert_eq!(shut.status, 403, "no key made for the peer network: {}", said(&shut));
    assert!(said(&shut).contains("making a peer key"), "{}", said(&shut));

    agents::create_for_gateway(node.keys.as_ref(), "peer", 1.0, 30, crate::remote::PEER_NETWORK).unwrap();
    let stranger = run(&door, ask(&signed));
    assert_eq!(stranger.status, 401, "{}", said(&stranger));
    assert_eq!(said(&stranger), serde_json::to_string(&json!({ "error": crate::remote::NOT_A_PEER_KEY })).unwrap());

    // The same ask at a node whose key store has not opened: it says why, as the door of any locked node does.
    let locked = a_node(false);
    let locked_door = Direct::new(locked.clone(), &from);
    let waiting = run(&locked_door, ask(&signed));
    assert_eq!(waiting.status, 503, "{}", said(&waiting));
    assert!(said(&waiting).contains(&locked.locked_because()), "{}", said(&waiting));
    let _ = std::fs::remove_dir_all(&home);
}
