//! MCP over the peer network, with no gateway between (graph `gateway.direct`): a client that signs its requests (`unb
//! mcp --peer`) asks this node over `/unbrowse/mcp/1` (`unbrowse_net::mcp`), and each ask is run through the node's own
//! door: `signed_door` checks the signature, takes the nonce once and signs the answer, as at 127.0.0.1.
//!
//! - Shut until the owner opens it: only a key made for the peer network (`unbrowse-node remote peer key`, its
//!   `gateway` `remote::PEER_NETWORK`) opens the node this way, and a node has none until its owner makes one. An agent's
//!   key for this machine (`unb connect`, the window's Agent access) opens nothing here: the ask runs as one that came
//!   over the peer network (`remote::over_peer_network`), which the door (`signed::token_for`) and each tool
//!   (`api::agent`) hold to.
//! - Only `POST /mcp`, and only signed: never a bearer token, and never the owner's token (the door here knows none), so
//!   what the peer network reaches is what an agent's MCP reaches, no more.
//! - Each tool call through it is in the owner's activity as one over the peer network, with the key's name and the
//!   peer that asked, never as a call on this machine.
//! - The authority signed for is this node's own, `<peer id>.p2p` (`unbrowse_net::mcp_authority`), put on every ask
//!   whatever it says, so a request signed for another node, or for a door on a machine, doesn't verify here.
//! - A remote key (one made for a gateway, `gateway.remote-key`) opens nothing here, as at the door (`token_for`).
//! - One answer goes back for one ask: the node answers in JSON, never as an event stream, so a tool call's progress
//!   isn't heard over the peer network, only its answer.

use axum::body::Body;
use axum::routing::post;
use tower::ServiceExt;
use unbrowse_core::signed as sig;
use unbrowse_net::{McpAnswer, McpAsk, PeerId};

use super::*;

/// This node's answer to asks over the peer network: its MCP route behind its own door.
#[derive(Clone)]
pub(crate) struct Direct {
    node: Arc<Node>,
    router: Router,
    host: String,
}

/// Headers an ask may not set: the node sets the host and what it answers in, and a body's length is its own.
const SET_HERE: [&str; 5] = ["host", "accept", "content-length", "transfer-encoding", "connection"];

impl Direct {
    pub(crate) fn new(node: Arc<Node>, me: &PeerId) -> Direct {
        // No owner's token opens this door: the owner's commands are never asked over the peer network.
        let door = window::Door { node: node.clone(), owner: Arc::new(String::new()) };
        let router = Router::new()
            .route("/mcp", post(mcp))
            .layer(axum::middleware::from_fn(counted))
            .with_state(node.clone())
            .layer(axum::middleware::from_fn_with_state(door, signed::signed_door));
        Direct { node, router, host: unbrowse_net::mcp_authority(me) }
    }

    /// The live key made for the peer network whose signing key is `key` (hex), if any.
    fn peer_key(&self, key: &str) -> Option<agents::Agent> {
        let root = unbrowse_core::RootKey::load(self.node.keys.as_ref()).ok()?;
        let key = key.trim().trim_start_matches("0x").to_ascii_lowercase();
        crate::remote::peer_keys().into_iter().find(|a| agents::constant_time_eq(&hex::encode(unbrowse_core::token_key(&agents::token_of(&root, a))), &key))
    }

    pub(crate) async fn answer(&self, from: PeerId, ask: McpAsk) -> McpAnswer {
        if ask.method != "POST" || ask.target != "/mcp" {
            return McpAnswer::refused(404, "over the peer network a node takes POST /mcp only");
        }
        let has = |name: &str| ask.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(name));
        if has("authorization") {
            return McpAnswer::refused(401, "over the peer network a node takes signed requests only, never a bearer token: sign it with your agent key (unb, the SDKs)");
        }
        if !has(sig::KEY) {
            return McpAnswer::refused(401, "over the peer network a node takes signed requests only: sign it with your agent key (unb, the SDKs)");
        }
        // Shut unless the owner made a key for the peer network; open, only to such a key.
        if crate::remote::peer_keys().is_empty() {
            return McpAnswer::refused(403, crate::remote::PEER_MCP_OFF);
        }
        if !self.node.unlocked() {
            return McpAnswer::refused(503, &self.node.locked_because());
        }
        let key = ask.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(sig::KEY)).map(|(_, v)| v.clone()).unwrap_or_default();
        let Some(agent) = self.peer_key(&key) else {
            return McpAnswer::refused(401, crate::remote::NOT_A_PEER_KEY);
        };
        let called = serde_json::from_slice::<Value>(&ask.body)
            .ok()
            .filter(|m| m.get("method").and_then(Value::as_str) == Some("tools/call"))
            .map(|m| m.pointer("/params/name").and_then(Value::as_str).unwrap_or("a tool").chars().take(80).collect::<String>());
        let mut req = axum::http::Request::builder().method("POST").uri("/mcp");
        for (k, v) in &ask.headers {
            if !SET_HERE.iter().any(|s| k.eq_ignore_ascii_case(s)) {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        let req = req.header("host", &self.host).header("accept", "application/json").body(Body::from(ask.body));
        let Ok(req) = req else { return McpAnswer::refused(400, "headers that aren't headers") };
        let Ok(res) = crate::remote::over_peer_network(self.router.clone().oneshot(req)).await;
        let status = res.status().as_u16();
        if let (Some(tool), true) = (called, res.status().is_success()) {
            store::log_activity(&store::Activity {
                at: store::now(),
                who: agent.name.clone(),
                site: "Remote, over the peer network".into(),
                what: format!("Called {tool} over the peer network"),
                kind: "call".into(),
                result: "done".into(),
                ms: None,
                unb: None,
                tx: None,
                note: Some(format!("From peer {from}")),
            });
        }
        let headers = res.headers().iter().filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string()))).take(unbrowse_net::mcp::MAX_MCP_HEADERS).collect();
        match axum::body::to_bytes(res.into_body(), unbrowse_net::MAX_MCP_ANSWER_BYTES).await {
            Ok(body) => McpAnswer { status, headers, body: body.to_vec() },
            Err(_) => McpAnswer::refused(502, "the node's answer was larger than the peer network carries"),
        }
    }
}

impl unbrowse_net::Mcp for Direct {
    fn answer(&self, from: PeerId, ask: McpAsk) -> futures_util::future::BoxFuture<'static, McpAnswer> {
        let me = self.clone();
        Box::pin(async move { me.answer(from, ask).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use unbrowse_net::{grind, Claim, Config, Identity, Listing, Listings, Multiaddr, Net, Registry, Rules};

    #[derive(Default)]
    struct Reg(Mutex<HashMap<String, Identity>>);

    impl Registry for Reg {
        async fn identity(&self, id: &str) -> Result<Option<Identity>, String> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        async fn seeds(&self) -> Vec<(PeerId, Multiaddr)> {
            vec![]
        }
    }

    struct NoListings;

    impl Listings for NoListings {
        async fn site(&self, _: &str) -> Vec<Listing> {
            vec![]
        }
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
            events: Events::default(),
            net: std::sync::OnceLock::new(),
            share: crate::share::Share::default(),
        })
    }

    /// `node` on the peer network on loopback, taking MCP: its network, its peer ID and where it listens.
    async fn serving(node: &Arc<Node>) -> (Net, PeerId, Vec<Multiaddr>) {
        let rules = Rules { position_bits: 8, nodes_per_identity: 4 };
        let key = grind("direct", &[7u8; 32], 0, rules.position_bits);
        let me = key.public().to_peer_id();
        let mut cfg = Config::new(Claim { identity: "direct".into(), index: 0 });
        cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
        cfg.announce_listen = true;
        cfg.rules = rules;
        cfg.mcp = unbrowse_net::McpDoor(Some(Arc::new(Direct::new(node.clone(), &me))));
        let net = Net::start(key, cfg, Arc::new(Reg::default()), Arc::new(NoListings)).await.unwrap();
        let mut addrs = vec![];
        for _ in 0..100 {
            addrs = net.listening().await;
            if !addrs.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        (net, me, addrs)
    }

    /// `unb mcp --peer`, the real program, as an agent host starts it: `initialize` then `tools/list` on its stdin, and
    /// the node's own answers on its stdout, over the peer network with no gateway.
    #[test]
    #[ignore = "runs the unb program beside this test's: cargo build --bin unb first"]
    fn unb_mcp_over_the_peer_network_lists_the_nodes_tools() {
        let unb = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("unb");
        assert!(unb.exists(), "{} isn't built: cargo build --bin unb", unb.display());
        let home = store::scratch_home("direct-unb");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let node = node();
        let (_, token) = agents::create_for_gateway(node.keys.as_ref(), "direct", 1.0, 30, crate::remote::PEER_NETWORK).unwrap();
        rt.block_on(async move {
            let (net, me, addrs) = serving(&node).await;
            let said = tokio::task::spawn_blocking(move || {
                use std::io::Write;
                let mut child = std::process::Command::new(&unb)
                    .args(["mcp", "--peer", &me.to_string(), "--addr", &addrs[0].to_string()])
                    .env("UNBROWSE_AGENT_TOKEN", &token)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .spawn()
                    .unwrap();
                let mut stdin = child.stdin.take().unwrap();
                writeln!(stdin, "{}", json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })).unwrap();
                writeln!(stdin, "{}", json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
                drop(stdin);
                let out = child.wait_with_output().unwrap();
                String::from_utf8(out.stdout).unwrap()
            })
            .await
            .unwrap();
            let lines: Vec<Value> = said.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
            let by_id = |i: u64| lines.iter().find(|l| l["id"] == i).cloned().unwrap_or(Value::Null);
            assert_eq!(by_id(1)["result"]["serverInfo"]["name"], "unbrowse-node", "{said}");
            assert!(by_id(2)["result"]["tools"].as_array().is_some_and(|t| t.iter().any(|t| t["name"] == "unbrowse_do")), "{said}");
            net.stop().await;
        });
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A signed `tools/list` for `node`, as `unb mcp --peer` sends it: signed for `authority` with `token`.
    fn signed_ask(token: &str, authority: &str) -> (McpAsk, String) {
        let body = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).unwrap();
        let s = crate::signed_client::sign(token, "POST", authority, "/mcp", &body);
        let mut headers: Vec<(String, String)> = s.headers.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        headers.push(("content-type".into(), "application/json".into()));
        (McpAsk { method: "POST".into(), target: "/mcp".into(), headers, body }, s.nonce)
    }

    /// Two swarms on loopback: a client that only asks, and a node that takes MCP over the peer network. Until the
    /// owner makes a key for the peer network the door is shut, even to the node's own agent key. Then that key,
    /// signing for this node, gets the node's own tools in an answer the node signed; a request signed for another
    /// node, a bad signature, a bearer token, an agent key for this machine and a remote key made for a gateway are each
    /// refused, and a tool call through it is in the owner's activity as one over the peer network.
    #[test]
    fn a_signed_mcp_request_over_the_peer_network_is_answered_by_the_nodes_own_door() {
        let home = store::scratch_home("direct-mcp");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let node = node();
        let (agent, _) = agents::create(node.keys.as_ref(), "local", 1.0, 30, 7788).unwrap();
        let local = agents::token_of(&unbrowse_core::RootKey::load(node.keys.as_ref()).unwrap(), &agent);
        let (_, remote) = agents::create_for_gateway(node.keys.as_ref(), "remote", 1.0, 30, "unbrowse.ai").unwrap();
        let keys = node.clone();
        rt.block_on(async move {
            let (net, me, addrs) = serving(&node).await;
            let client = unbrowse_net::McpClient::start().unwrap();
            let authority = unbrowse_net::mcp_authority(&me);

            // No key made for the peer network yet: the door is shut, to the node's own agent key too.
            let (ask, _) = signed_ask(&local, &authority);
            let a = client.ask(me, addrs.clone(), ask).await.unwrap();
            assert_eq!(a.status, 403, "{}", String::from_utf8_lossy(&a.body));
            assert!(String::from_utf8_lossy(&a.body).contains("making a peer key"), "says how the owner opens it");

            let (_, token) = agents::create_for_gateway(keys.keys.as_ref(), "peer", 1.0, 30, crate::remote::PEER_NETWORK).unwrap();
            let (ask, nonce) = signed_ask(&token, &authority);
            let a = client.ask(me, addrs.clone(), ask).await.unwrap();
            assert_eq!(a.status, 200, "{}", String::from_utf8_lossy(&a.body));
            assert!(crate::signed_client::the_nodes(&token, a.status, a.header(sig::REPLY).unwrap_or_default(), &a.body, &nonce), "the node signed its answer");
            let listed: Value = serde_json::from_slice(&a.body).unwrap();
            assert!(listed["result"]["tools"].as_array().is_some_and(|t| t.iter().any(|t| t["name"] == "unbrowse_do")), "{listed}");

            // Signed for another node: it doesn't verify here.
            let other = unbrowse_net::mcp_authority(&PeerId::random());
            let (ask, _) = signed_ask(&token, &other);
            assert_eq!(client.ask(me, vec![], ask).await.unwrap().status, 401);
            // Signed for a door on a machine: the same.
            let (ask, _) = signed_ask(&token, "127.0.0.1:7788");
            assert_eq!(client.ask(me, vec![], ask).await.unwrap().status, 401);
            // A signature that isn't the request's.
            let (mut ask, _) = signed_ask(&token, &authority);
            ask.body = br#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.to_vec();
            assert_eq!(client.ask(me, vec![], ask).await.unwrap().status, 401);
            // The same request sent again: its nonce was taken.
            let (ask, _) = signed_ask(&token, &authority);
            assert_eq!(client.ask(me, vec![], ask.clone()).await.unwrap().status, 200);
            assert_eq!(client.ask(me, vec![], ask).await.unwrap().status, 401, "a request is taken once");
            // A bearer token, even a live agent's.
            let bearer = McpAsk { method: "POST".into(), target: "/mcp".into(), headers: vec![("authorization".into(), format!("Bearer {token}")), ("content-type".into(), "application/json".into())], body: b"{}".to_vec() };
            assert_eq!(client.ask(me, vec![], bearer).await.unwrap().status, 401);
            // A remote key, signed properly: it opens the node only through its gateway.
            let (ask, _) = signed_ask(&remote, &authority);
            assert_eq!(client.ask(me, vec![], ask).await.unwrap().status, 401);
            // The node's agent key for this machine, signed properly: it opens the node only at its own door.
            let (ask, _) = signed_ask(&local, &authority);
            assert_eq!(client.ask(me, vec![], ask).await.unwrap().status, 401);
            // A tool call is the owner's to see, as one over the peer network from the peer that asked.
            let body = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "no_such_tool", "arguments": {} } })).unwrap();
            let s = crate::signed_client::sign(&token, "POST", &authority, "/mcp", &body);
            let mut headers: Vec<(String, String)> = s.headers.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
            headers.push(("content-type".into(), "application/json".into()));
            let a = client.ask(me, vec![], McpAsk { method: "POST".into(), target: "/mcp".into(), headers, body }).await.unwrap();
            assert_eq!(a.status, 200, "{}", String::from_utf8_lossy(&a.body));
            let logged = store::read_activity(20).into_iter().find(|e| e.what.contains("no_such_tool")).expect("the call is in the activity");
            assert_eq!(logged.who, "peer");
            assert_eq!(logged.site, "Remote, over the peer network");
            assert!(logged.note.as_deref().is_some_and(|n| n.starts_with("From peer ")), "{:?}", logged.note);
            // Anything but POST /mcp.
            let (mut ask, _) = signed_ask(&token, &authority);
            ask.target = "/owner/settings".into();
            assert_eq!(client.ask(me, vec![], ask).await.unwrap().status, 404);
            net.stop().await;
        });
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
#[path = "direct_cov_tests.rs"]
mod direct_cov_tests;
