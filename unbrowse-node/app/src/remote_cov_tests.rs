//! UNB-208: the remote's gateway lookup, its link loop and its shell commands, on a gateway of the test's own.

use super::*;

/// A gateway on loopback that answers every request with `status` and `body`, and counts them.
async fn gateway_saying(status: u16, body: String) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let taken = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = taken.clone();
    tokio::spawn(async move {
        while let Ok((mut conn, _)) = listener.accept().await {
            let mut buf = vec![0u8; 8192];
            let _ = conn.read(&mut buf).await;
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let reply = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = conn.write_all(reply.as_bytes()).await;
            let _ = conn.shutdown().await;
        }
    });
    (url, taken)
}

fn who(peer: &str, addrs: &[&str]) -> String {
    json!({ "peer": peer, "addrs": addrs }).to_string()
}

fn on_at(gateway: &str) -> Remote {
    turn_on(gateway).unwrap();
    Remote::load()
}

fn node() -> Arc<Node> {
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    Arc::new(Node {
        keys: Box::new(keys),
        identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: crate::chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: crate::api::Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    })
}

/// The first time a gateway says who it is, the node keeps the peer's ID and dials the address the gateway gave; a
/// later answer naming another peer is refused, never dialled, and the kept ID stays the first.
#[tokio::test]
async fn a_gateway_that_later_names_another_peer_is_not_dialled() {
    let _home = store::scratch_home("remote-gw-peer");
    let first = unbrowse_net::PeerId::random().to_string();
    let (url, _) = gateway_saying(200, who(&first, &["/ip4/127.0.0.1/tcp/4001"])).await;
    let r = on_at(&url);
    assert!(r.gateway_peer.is_empty());
    let (peer, addr) = gateway_peer(&r).await.unwrap();
    assert_eq!((peer.to_string(), addr.to_string()), (first.clone(), "/ip4/127.0.0.1/tcp/4001".to_string()));
    assert_eq!(Remote::load().gateway_peer, first, "the first peer it named is kept");
    // Asked again, the same peer is fine.
    assert!(gateway_peer(&Remote::load()).await.is_ok());
    // Another gateway answering at the same address names a different peer.
    let other = unbrowse_net::PeerId::random().to_string();
    let (url2, _) = gateway_saying(200, who(&other, &["/ip4/127.0.0.1/tcp/4001"])).await;
    let moved = Remote { gateway: url2, ..Remote::load() };
    let e = gateway_peer(&moved).await.unwrap_err();
    assert!(e.contains("not dialling it") && e.contains(&other) && e.contains(&first), "{e}");
    assert_eq!(Remote::load().gateway_peer, first, "and the kept ID didn't move");
}

/// What a gateway can say wrong is said in words that name it: a refusal, an answer that isn't who it is, a peer ID
/// that isn't one, and no address to dial (an address that isn't one, with a host that gives none).
#[tokio::test]
async fn a_gateway_that_cannot_say_who_it_is_is_named_in_the_error() {
    let _home = store::scratch_home("remote-gw-wrong");
    let ask = |status: u16, body: String| async move {
        let (url, _) = gateway_saying(status, body).await;
        let r = on_at(&url);
        gateway_peer(&r).await.unwrap_err()
    };
    let e = ask(503, "down".into()).await;
    assert!(e.contains("couldn't ask the gateway"), "{e}");
    let e = ask(200, "not json".into()).await;
    assert!(e.contains("didn't say who it is"), "{e}");
    let e = ask(200, who("not a peer", &[])).await;
    assert!(e.contains("names no peer ID"), "{e}");
}

/// A gateway that names no address of its own is dialled where its own host says (`gateway_addr`).
#[tokio::test]
async fn a_gateway_with_no_address_is_dialled_at_its_host() {
    let _home = store::scratch_home("remote-gw-host");
    let peer = unbrowse_net::PeerId::random().to_string();
    let (url, _) = gateway_saying(200, who(&peer, &[])).await;
    let r = on_at(&url);
    let (_, addr) = gateway_peer(&r).await.unwrap();
    assert_eq!(Some(addr), unbrowse_net::gateway_addr(&url, "/"));
}

/// The node attaches as a public peer only from a home that holds no one's credential, and never links without its key
/// or to a gateway that can't say who it is; a link to a gateway ends, and is dialled again, when the owner turns the
/// remote off.
#[tokio::test]
async fn a_link_ends_when_the_owner_changes_the_setting_and_is_refused_where_it_must_not_start() {
    let _home = store::scratch_home("remote-link-once");
    // A public peer in a home with a session in it.
    let jar = store::owner_jars_dir().join("shop.example.com.json");
    std::fs::create_dir_all(store::owner_jars_dir()).unwrap();
    store::write_json(&jar, &unbrowse_files::JAR, &std::collections::BTreeMap::from([("sid", "owners-session")])).unwrap();
    let public = Remote { public: true, on: true, ..Remote::load() };
    let e = link_once(node(), &public).await.unwrap_err();
    assert!(e.contains("not linking as a public peer") && e.contains("1 signed-in session"), "{e}");
    std::fs::remove_file(&jar).unwrap();
    // No key.
    let e = link_once(node(), &Remote::default()).await.unwrap_err();
    assert_eq!(e, "no key");
    // A gateway that refuses.
    let (down, _) = gateway_saying(500, "no".into()).await;
    let e = link_once(node(), &on_at(&down)).await.unwrap_err();
    assert!(e.contains("couldn't ask the gateway"), "{e}");
    // A gateway that answers: the link starts and holds until the setting changes.
    let peer = unbrowse_net::PeerId::random().to_string();
    let (up, asked) = gateway_saying(200, who(&peer, &["/ip4/127.0.0.1/tcp/1"])).await;
    let r = on_at(&up);
    let held = { let r = r.clone(); tokio::spawn(async move { link_once(node(), &r).await }) };
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!held.is_finished(), "the link holds while the setting stays as it was");
    assert!(asked.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    turn_off().unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(30), held).await.expect("the link ends once the owner turns the remote off").unwrap();
    assert_eq!(ended, Ok(()));
}

/// While the owner has the remote on, a node that can't reach its gateway tries again by itself, a little more slowly each time (third ask well before the cap); it says each failure
/// once, and attaches nothing while the remote is off.
#[tokio::test]
async fn a_node_keeps_trying_a_gateway_that_does_not_answer() {
    let _home = store::scratch_home("remote-keep-attached");
    let (down, asked) = gateway_saying(500, "no".into()).await;
    turn_off().unwrap();
    let keeping = tokio::spawn(keep_attached(node()));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0, "off: nothing is asked of the gateway");
    on_at(&down);
    let t = std::time::Instant::now();
    while asked.load(std::sync::atomic::Ordering::SeqCst) < 3 {
        assert!(t.elapsed() < Duration::from_secs(40), "the gateway was asked {} times", asked.load(std::sync::atomic::Ordering::SeqCst));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!keeping.is_finished());
    keeping.abort();
}

fn run(args: &[&str]) -> i32 {
    cli(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
}

/// `remote peer`: no key, no MCP over the peer network; `peer key` makes one, which `peer` lists; `peer off` revokes
/// every one, and the door is shut again.
#[test]
fn the_peer_network_door_opens_with_a_peer_key_and_shuts_when_they_are_revoked() {
    let _home = store::scratch_home("remote-cli-peer");
    assert_eq!(run(&["peer"]), 0);
    assert!(peer_keys().is_empty());
    assert_eq!(run(&["peer", "key", "Laptop agent"]), 0);
    assert_eq!(run(&["peer", "key"]), 0);
    let keys = peer_keys();
    assert_eq!(keys.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(), vec!["Laptop agent", "Peer agents"]);
    assert_eq!(run(&["peer"]), 0);
    assert_eq!(run(&["peer", "off"]), 0);
    assert!(peer_keys().is_empty(), "every peer key is revoked");
    assert!(agents::list().iter().all(|a| a.revoked));
}

/// `remote key` needs the remote on; with it on, it makes a key for the gateway only; `revoke` ends them all; a word
/// the command doesn't know is a usage line, and `sign-in` too waits for the remote.
#[test]
fn a_remote_key_is_made_for_the_gateway_the_remote_is_on_and_revoked_with_one_word() {
    let _home = store::scratch_home("remote-cli-key");
    assert_eq!(run(&["key"]), 1, "the remote is off");
    assert_eq!(run(&["sign-in"]), 1, "the remote is off");
    assert_eq!(run(&["nonsense"]), 2);
    assert_eq!(run(&[]), 0);
    assert_eq!(run(&["on", "not a gateway"]), 1);
    assert_eq!(run(&["on", "https://gateway.example"]), 0);
    assert!(Remote::load().on && Remote::load().expects_sign_in());
    assert_eq!(run(&[]), 0, "on: says where the node is");
    assert_eq!(run(&["sign-in"]), 0);
    assert_eq!(run(&["key", "Phone"]), 0);
    let live = live_keys("gateway.example");
    assert_eq!(live.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(), vec!["Phone"]);
    assert!(peer_keys().is_empty(), "a remote key isn't a peer key");
    assert_eq!(run(&["revoke"]), 0);
    assert!(live_keys("gateway.example").is_empty());
    assert_eq!(run(&["off"]), 0);
    assert!(!Remote::load().on);
    assert_eq!(run(&[]), 0, "off, with its address kept");
    assert_eq!(run(&["key"]), 0, "the address is the node's, on or off");
}

/// `remote public` makes this home a public peer of the gateway with a key of its own, capped, and says nothing of
/// the owner's browser; run again it makes no second key.
#[test]
fn a_clean_home_becomes_a_public_peer_with_one_key_of_its_own() {
    let _home = store::scratch_home("remote-cli-public");
    assert_eq!(run(&["public", "https://gateway.example"]), 0);
    let r = Remote::load();
    assert!(r.on && r.public);
    let s = store::load_settings();
    assert!(s.headless_only && !s.fetch_browser && !s.shared_mint, "a public peer never opens a browser");
    let own = live_keys("public@gateway.example");
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].name, "Public callers");
    assert_eq!(run(&[]), 0);
    assert_eq!(run(&["public"]), 0);
    assert_eq!(live_keys("public@gateway.example").len(), 1, "no second key");
    assert_eq!(run(&["key"]), 1, "a public peer takes no remote keys");
}

fn door_ask(target: &str, body: &str) -> unbrowse_net::McpAsk {
    unbrowse_net::McpAsk { method: "POST".into(), target: target.into(), headers: vec![("content-type".into(), "application/json".into())], body: body.as_bytes().to_vec() }
}

fn heard(door: &RemoteDoor, ask: unbrowse_net::McpAsk) -> (u16, Value) {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let a = rt.block_on(unbrowse_net::Mcp::answer(door, unbrowse_net::PeerId::random(), ask));
    (a.status, serde_json::from_slice(&a.body).unwrap_or(Value::Null))
}

/// The gateway asks an owner's node what it links as, and to sign an app in: a yes from the owner while they expect one
/// is a token for the gateway, a no is a refusal that says why, and a message that isn't JSON is a parse error, never
/// a call.
#[test]
fn the_gateway_signs_an_app_in_through_the_door_only_on_the_owners_yes() {
    let _home = store::scratch_home("remote-door-authorize");
    turn_on("https://unbrowse.ai").unwrap();
    let door = RemoteDoor { node: node(), arrival: "unbrowse.ai".into(), public: false };
    assert_eq!(heard(&door, door_ask("/remote/role", "{}")), (200, json!({ "role": "own" })));
    let ask = door_ask("/remote/authorize", r#"{"client":"Claude","redirect_host":"claude.ai"}"#);
    // Not expecting one: a refusal, whatever the owner would say.
    crate::owner_dialog::answer_in_test(Some(true));
    let (status, said) = heard(&door, ask.clone());
    assert_eq!((status, said["why"].as_str()), (403, Some(NOT_EXPECTING_SIGN_IN)));
    expect_sign_in().unwrap();
    crate::owner_dialog::answer_in_test(Some(false));
    assert_eq!(heard(&door, ask.clone()).0, 403, "a no is no key");
    crate::owner_dialog::answer_in_test(Some(true));
    let (status, said) = heard(&door, ask);
    assert_eq!(status, 200, "{said}");
    let token = said["token"].as_str().unwrap();
    assert!(agents::by_gateway_token(door.node.keys.as_ref(), token, "unbrowse.ai").is_some(), "a key for the gateway");
    assert!(crate::owner_dialog::asked_in_test().last().is_some_and(|q| q.contains("calls itself \"Claude\"") && q.contains("claude.ai")));
    let (status, said) = heard(&door, door_ask("/mcp", "this isn't json"));
    assert_eq!((status, said["error"]["code"].clone()), (400, json!(-32700)));
    // A public peer takes no sign-ins, and answers nothing before it has a key of its own.
    let public = RemoteDoor { node: node(), arrival: "public@unbrowse.ai".into(), public: true };
    assert_eq!(heard(&public, door_ask("/remote/role", "{}")), (200, json!({ "role": "public" })));
    assert_eq!(heard(&public, door_ask("/remote/authorize", "{}")).0, 404);
    let (status, said) = heard(&public, door_ask("/mcp", r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#));
    assert_eq!((status, said["id"].clone()), (503, json!(4)));
    assert!(said["error"]["message"].as_str().unwrap().contains("no key to call with"), "{said}");
}

/// A link that ends because the owner turned the remote off is not a failure: the node says nothing of it, starts the
/// wait over, and attaches again, at once, when the owner turns it on.
#[tokio::test]
async fn a_node_attaches_again_when_the_owner_turns_the_remote_off_and_on() {
    let _home = store::scratch_home("remote-reattach");
    let peer = unbrowse_net::PeerId::random().to_string();
    let (up, asked) = gateway_saying(200, who(&peer, &["/ip4/127.0.0.1/tcp/1"])).await;
    on_at(&up);
    let keeping = tokio::spawn(keep_attached(node()));
    let t = std::time::Instant::now();
    let seen = |n: usize| asked.load(std::sync::atomic::Ordering::SeqCst) >= n;
    while !seen(1) {
        assert!(t.elapsed() < Duration::from_secs(40), "it never asked the gateway who it is");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    turn_off().unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let asks = asked.load(std::sync::atomic::Ordering::SeqCst);
    on_at(&up);
    while asked.load(std::sync::atomic::Ordering::SeqCst) <= asks {
        assert!(t.elapsed() < Duration::from_secs(60), "it never attached again");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    keeping.abort();
}

/// What a message over the peer network arrives as is the peer network, not a gateway, and a task spawned for it keeps
/// that; outside any message there is no arrival. A public peer takes no sign-ins, and the owner turning the remote off
/// from the window or the API turns it off and says so.
#[tokio::test]
async fn a_message_over_the_peer_network_arrives_as_the_peer_network_and_a_public_peer_takes_no_sign_ins() {
    let _home = store::scratch_home("remote-small");
    assert_eq!(arrived_via(), None);
    assert_eq!(keep_arrival(async { arrived_via() }).await, None, "nothing to keep outside a message");
    assert_eq!(over_peer_network(async { arrived_via() }).await.as_deref(), Some(PEER_NETWORK));
    assert_eq!(over_peer_network(keep_arrival(async { tokio::spawn(keep_arrival(async { arrived_via() })).await.unwrap() })).await.as_deref(), Some(PEER_NETWORK));
    set(true, Some("https://gateway.example")).unwrap();
    assert!(expect_sign_in().is_ok());
    let said = set(false, None).unwrap();
    assert_eq!((said["on"].clone(), said["gateway"].clone()), (json!(false), json!("https://gateway.example")));
    assert!(!Remote::load().on);
    Remote { public: true, ..Remote::load() }.save().unwrap();
    assert_eq!(expect_sign_in().unwrap_err(), "a public peer takes no sign-ins");
}
