//! A node's link to its gateway over WebSocket, and MCP asks over the peer network (`/unbrowse/mcp/1`): the link dials
//! the gateway peer, answers what the gateway asks with its door, says how it stands, and dials again after a drop;
//! a node answers an ask a client sends it, and a client that can't reach a node is told so. All on 127.0.0.1.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use futures::StreamExt;
use libp2p::request_response::{self, OutboundRequestId};
use libp2p::swarm::SwarmEvent;
use libp2p::{noise, tcp, yamux, StreamProtocol};
use tokio::sync::{mpsc, oneshot, watch};
use unbrowse_net::mcp::McpCodec;
use unbrowse_net::{gateway_addr, grind, Claim, Config, Identity, Keypair, Link, LinkState, Listing, Listings, Mcp, McpAnswer, McpAsk, McpClient, McpDoor, Multiaddr, Net, PeerId, Registry, Rules, MCP_PROTOCOL};

const RULES: Rules = Rules { position_bits: 8, nodes_per_identity: 4 };

type Reply = oneshot::Sender<Result<McpAnswer, String>>;

/// A gateway peer as a test stands it up: a libp2p node that listens over WebSocket on 127.0.0.1 and sends asks to the
/// peers connected to it. Dropped, it closes its connections.
struct Gateway {
    peer: PeerId,
    port: u16,
    asks: mpsc::Sender<(PeerId, McpAsk, Reply)>,
    connected: watch::Receiver<Vec<PeerId>>,
}

impl Gateway {
    async fn start(key: Keypair, port: u16) -> Gateway {
        let peer = key.public().to_peer_id();
        let mut swarm = libp2p::SwarmBuilder::with_existing_identity(key)
            .with_tokio()
            .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
            .unwrap()
            .with_websocket(noise::Config::new, yamux::Config::default)
            .await
            .unwrap()
            .with_behaviour(|_| request_response::Behaviour::with_codec(McpCodec, [(StreamProtocol::new(MCP_PROTOCOL), request_response::ProtocolSupport::Outbound)], request_response::Config::default().with_request_timeout(Duration::from_secs(20))))
            .unwrap()
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
            .build();
        swarm.listen_on(format!("/ip4/127.0.0.1/tcp/{port}/ws").parse().unwrap()).unwrap();
        let (asks, mut commands) = mpsc::channel::<(PeerId, McpAsk, Reply)>(8);
        let (connected_tx, connected) = watch::channel(Vec::new());
        let (listening_tx, listening) = oneshot::channel::<u16>();
        tokio::spawn(async move {
            let mut listening_tx = Some(listening_tx);
            let mut waiting: HashMap<OutboundRequestId, Reply> = HashMap::new();
            loop {
                tokio::select! {
                    cmd = commands.recv() => {
                        let Some((to, ask, reply)) = cmd else { return };
                        let id = swarm.behaviour_mut().send_request(&to, ask);
                        waiting.insert(id, reply);
                    }
                    ev = swarm.select_next_some() => match ev {
                        SwarmEvent::NewListenAddr { address, .. } => {
                            let port = address.iter().find_map(|p| if let libp2p::multiaddr::Protocol::Tcp(p) = p { Some(p) } else { None });
                            if let (Some(tx), Some(port)) = (listening_tx.take(), port) {
                                let _ = tx.send(port);
                            }
                        }
                        SwarmEvent::ConnectionEstablished { peer_id, .. } => connected_tx.send_modify(|v| v.push(peer_id)),
                        SwarmEvent::ConnectionClosed { peer_id, .. } => connected_tx.send_modify(|v| v.retain(|p| *p != peer_id)),
                        SwarmEvent::Behaviour(request_response::Event::Message { message: request_response::Message::Response { request_id, response }, .. }) => {
                            if let Some(r) = waiting.remove(&request_id) {
                                let _ = r.send(Ok(response));
                            }
                        }
                        SwarmEvent::Behaviour(request_response::Event::OutboundFailure { request_id, error, .. }) => {
                            if let Some(r) = waiting.remove(&request_id) {
                                let _ = r.send(Err(error.to_string()));
                            }
                        }
                        _ => {}
                    }
                }
            }
        });
        let port = tokio::time::timeout(Duration::from_secs(10), listening).await.expect("the gateway listens").unwrap();
        Gateway { peer, port, asks, connected }
    }

    fn address(&self) -> Multiaddr {
        gateway_addr(&format!("http://127.0.0.1:{}", self.port), "/").unwrap()
    }

    async fn ask(&self, to: PeerId, ask: McpAsk) -> Result<McpAnswer, String> {
        let (reply, answer) = oneshot::channel();
        self.asks.send((to, ask, reply)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(20), answer).await.expect("the ask was answered").unwrap()
    }

    async fn holds(&self, peer: PeerId) {
        let mut connected = self.connected.clone();
        tokio::time::timeout(Duration::from_secs(20), connected.wait_for(|v| v.contains(&peer))).await.expect("the link reached the gateway").unwrap();
    }
}

/// The door of a node under test: it answers with who asked and what, and counts the asks it took.
#[derive(Default)]
struct Door {
    heard: Mutex<Vec<(PeerId, McpAsk)>>,
}

impl Mcp for Door {
    fn answer(&self, from: PeerId, ask: McpAsk) -> BoxFuture<'static, McpAnswer> {
        self.heard.lock().unwrap().push((from, ask.clone()));
        Box::pin(async move { McpAnswer { status: 200, headers: vec![("x-unbrowse-reply".into(), "signed".into())], body: format!("{} {}: {}", ask.method, ask.target, String::from_utf8_lossy(&ask.body)).into_bytes() } })
    }
}

fn get(target: &str, body: &str) -> McpAsk {
    McpAsk { method: "POST".into(), target: target.into(), headers: vec![("x-unbrowse-key".into(), "ab".into())], body: body.as_bytes().to_vec() }
}

async fn state_is(link: &Link, want: impl Fn(&LinkState) -> bool, what: &str) -> LinkState {
    let mut state = link.state.clone();
    let seen = tokio::time::timeout(Duration::from_secs(30), state.wait_for(|s| want(s))).await.unwrap_or_else(|_| panic!("the link never reached: {what}; it was {:?}", *link.state.borrow()));
    #[allow(clippy::let_and_return)]
    let out = seen.unwrap().clone();
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_link_dials_its_gateway_over_websocket_and_answers_the_gateways_asks_with_its_door() {
    let gateway = Gateway::start(Keypair::generate_ed25519(), 0).await;
    let key = Keypair::generate_ed25519();
    let me = key.public().to_peer_id();
    let door = Arc::new(Door::default());
    let link = Link::start(key, gateway.peer, gateway.address(), door.clone(), "unbrowse-node-link; role=own".into()).unwrap();
    assert_eq!(*link.state.borrow(), LinkState::Dialling, "a link that has not yet reached its gateway says it is dialling");
    state_is(&link, |s| *s == LinkState::Connected, "Connected").await;
    gateway.holds(me).await;

    let answer = gateway.ask(me, get("/mcp", r#"{"method":"tools/list"}"#)).await.unwrap();
    assert_eq!(answer.status, 200);
    assert_eq!(answer.header("X-Unbrowse-Reply"), Some("signed"));
    assert_eq!(String::from_utf8_lossy(&answer.body), r#"POST /mcp: {"method":"tools/list"}"#);
    let heard = door.heard.lock().unwrap().clone();
    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0].0, gateway.peer, "the door is told who asked: the gateway");
    assert_eq!(heard[0].1.headers, vec![("x-unbrowse-key".to_string(), "ab".to_string())]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dropped_link_closes_its_connection() {
    let gateway = Gateway::start(Keypair::generate_ed25519(), 0).await;
    let key = Keypair::generate_ed25519();
    let me = key.public().to_peer_id();
    let link = Link::start(key, gateway.peer, gateway.address(), Arc::new(Door::default()), "unbrowse-node-link".into()).unwrap();
    gateway.holds(me).await;
    drop(link);
    let mut connected = gateway.connected.clone();
    tokio::time::timeout(Duration::from_secs(20), connected.wait_for(|v| !v.contains(&me))).await.expect("the gateway saw the connection close").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_link_whose_gateway_goes_says_so_and_dials_again_when_it_is_back() {
    let key = Keypair::generate_ed25519();
    let gateway_key = Keypair::generate_ed25519();
    let gateway = Gateway::start(gateway_key.clone(), 0).await;
    let (port, peer, addr) = (gateway.port, gateway.peer, gateway.address());
    let me = key.public().to_peer_id();
    let door = Arc::new(Door::default());
    let link = Link::start(key, peer, addr, door, "unbrowse-node-link".into()).unwrap();
    state_is(&link, |s| *s == LinkState::Connected, "Connected").await;

    drop(gateway);
    let down = state_is(&link, |s| matches!(s, LinkState::Down(_)), "Down after the gateway left").await;
    let LinkState::Down(why) = down else { unreachable!() };
    assert!(!why.is_empty(), "a link that is down says why");

    // The gateway comes back at the same address with the same key: the link dials it again, unasked.
    let again = Gateway::start(gateway_key, port).await;
    state_is(&link, |s| *s == LinkState::Connected, "Connected again").await;
    again.holds(me).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_link_to_an_address_where_no_gateway_listens_is_down_not_dialling_for_ever() {
    // A port nothing listens on: ask the system for one and let it go.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let addr = gateway_addr(&format!("http://127.0.0.1:{port}"), "/").unwrap();
    let link = Link::start(Keypair::generate_ed25519(), PeerId::random(), addr, Arc::new(Door::default()), "unbrowse-node-link".into()).unwrap();
    let LinkState::Down(why) = state_is(&link, |s| matches!(s, LinkState::Down(_)), "Down").await else { unreachable!() };
    assert!(!why.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_link_never_trusts_a_peer_that_is_not_the_gateway_it_was_given() {
    let gateway = Gateway::start(Keypair::generate_ed25519(), 0).await;
    // The dialler rejects the unexpected peer ID. The listening peer may briefly see an inbound connection
    // while the dialler is closing it, so the rejection must be checked on the link itself.
    let someone_else = PeerId::random();
    let link = Link::start(Keypair::generate_ed25519(), someone_else, gateway.address(), Arc::new(Door::default()), "unbrowse-node-link".into()).unwrap();
    let LinkState::Down(why) = state_is(&link, |s| matches!(s, LinkState::Down(_)), "Down").await else { unreachable!() };
    assert!(why.starts_with(&format!("Dial error: Unexpected peer ID {} ", gateway.peer)), "the dialler should reject the gateway's actual peer ID: {why}");
}

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

fn anchor(id: &str) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[..id.len().min(32)].copy_from_slice(&id.as_bytes()[..id.len().min(32)]);
    a
}

async fn node(id: &str, door: Option<Arc<Door>>) -> (Net, Vec<Multiaddr>) {
    let key = grind(id, &anchor(id), 0, RULES.position_bits);
    let mut cfg = Config::new(Claim { identity: id.into(), index: 0 });
    cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
    cfg.announce_listen = true;
    cfg.rules = RULES;
    if let Some(door) = door {
        cfg.mcp = McpDoor(Some(door));
    }
    let net = Net::start(key, cfg, Arc::new(Reg::default()), Arc::new(NoListings)).await.unwrap();
    for _ in 0..100 {
        let addrs = net.listening().await;
        if !addrs.is_empty() {
            return (net, addrs);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the node never listened");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_answers_the_mcp_ask_another_node_sends_it_with_its_door() {
    let door = Arc::new(Door::default());
    let (server, addrs) = node("0xa", Some(door.clone())).await;
    let (asker, _) = node("0xb", None).await;
    let answer = asker.ask_mcp(server.peer_id(), addrs, get("/mcp", "hello")).await.unwrap();
    assert_eq!((answer.status, String::from_utf8_lossy(&answer.body).into_owned()), (200, "POST /mcp: hello".to_string()));
    assert_eq!(door.heard.lock().unwrap()[0].0, asker.peer_id(), "the door is told which peer asked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_without_a_door_refuses_every_mcp_ask_and_says_why() {
    let (server, addrs) = node("0xa", None).await;
    let (asker, _) = node("0xb", None).await;
    let answer = asker.ask_mcp(server.peer_id(), addrs, get("/mcp", "hello")).await.unwrap();
    assert_eq!(answer.status, 404);
    assert!(String::from_utf8_lossy(&answer.body).contains("takes no MCP"), "{}", String::from_utf8_lossy(&answer.body));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_mcp_ask_to_a_peer_that_cannot_be_reached_is_an_error_not_an_answer() {
    let (asker, _) = node("0xb", None).await;
    let gone = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let err = asker.ask_mcp(PeerId::random(), vec![format!("/ip4/127.0.0.1/tcp/{gone}").parse().unwrap()], get("/mcp", "x")).await.unwrap_err();
    assert!(err.starts_with("the node didn't answer"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_that_only_asks_gets_the_answer_of_the_node_it_asked_and_its_own_peer_id() {
    let door = Arc::new(Door::default());
    let (server, addrs) = node("0xa", Some(door.clone())).await;
    let client = McpClient::start().unwrap();
    assert_ne!(client.peer_id(), server.peer_id());
    let answer = client.ask(server.peer_id(), addrs, get("/mcp", "from a client")).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&answer.body), "POST /mcp: from a client");
    assert_eq!(door.heard.lock().unwrap()[0].0, client.peer_id());
    // Asked again with nothing but the peer ID, the client still knows the address it was given.
    let again = client.ask(server.peer_id(), vec![], get("/mcp", "again")).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&again.body), "POST /mcp: again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_that_cannot_reach_the_node_says_it_did_not_answer() {
    let client = McpClient::start().unwrap();
    let gone = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let err = client.ask(PeerId::random(), vec![format!("/ip4/127.0.0.1/tcp/{gone}").parse().unwrap()], get("/mcp", "x")).await.unwrap_err();
    assert!(err.starts_with("the node didn't answer"), "{err}");
}

#[test]
fn a_door_says_whether_it_is_open() {
    assert_eq!(format!("{:?}", McpDoor(None)), "McpDoor(none)");
    assert_eq!(format!("{:?}", McpDoor(Some(Arc::new(Door::default())))), "McpDoor(open)");
}
