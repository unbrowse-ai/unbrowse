//! A node's link to a gateway peer (graph `gateway.peer`, `gateway.relay-to-own`): the gateway is a peer like any
//! other, with a peer ID of its own, reached over libp2p. A node behind a router dials it, over WebSocket so a gateway
//! that takes only HTTPS (a Cloudflare Worker) is reachable, keeps the connection, and answers the `/unbrowse/mcp/1`
//! asks the gateway peer sends on it with its own door ([`Mcp`]). Noise encrypts the connection to the peer ID each
//! side expects, as on every libp2p connection: the node dials the gateway's peer ID and no other, and the gateway
//! knows the node by the key it proved.
//!
//! The swarm is the node's own key and nothing else of the network's: no table, no listings, no relay. It runs whether
//! or not the node is on the peer network, since an owner's own node is reached through it either way.

use std::sync::Arc;
use std::time::Duration;

use futures::prelude::*;
use libp2p::request_response;
use libp2p::swarm::SwarmEvent;
use libp2p::{Multiaddr, PeerId};

use crate::mcp::{self, Mcp, McpAnswer, McpCodec, McpDoor};

mod behaviour {
    #![allow(unreachable_code)]
    use libp2p::swarm::NetworkBehaviour;
    use libp2p::{identify, ping, request_response};

    #[derive(NetworkBehaviour)]
    pub(super) struct Behaviour {
        pub(super) mcp: request_response::Behaviour<super::McpCodec>,
        pub(super) identify: identify::Behaviour,
        pub(super) ping: ping::Behaviour,
    }
}

/// How the link stands, for the node's log and the owner's window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkState {
    Dialling,
    Connected,
    Down(String),
}

/// A running link: dropped, it stops and the connection closes.
pub struct Link {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    pub state: tokio::sync::watch::Receiver<LinkState>,
}

impl Drop for Link {
    fn drop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
    }
}

/// How often the link pings the gateway, so a connection a proxy would close for idleness stays up.
const PING_EVERY: Duration = Duration::from_secs(25);
/// The longest it waits before dialling again after a drop.
const MAX_WAIT: Duration = Duration::from_secs(60);

impl Link {
    /// Dials `gateway` at `addr` with this node's `key`, again after every drop, and answers the gateway peer's asks
    /// with `door`. Asks from any other peer are refused: the link is to the gateway alone.
    pub fn start(key: libp2p::identity::Keypair, gateway: PeerId, addr: Multiaddr, door: Arc<dyn Mcp>, agent: String) -> Result<Link, String> {
        use libp2p::{identify, noise, ping, tcp, yamux};
        let me = key.public().to_peer_id();
        let builder = libp2p::SwarmBuilder::with_existing_identity(key)
            .with_tokio()
            .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
            .map_err(|e| e.to_string())?
            .with_dns()
            .map_err(|e| e.to_string())?;
        let builder = futures::executor::block_on(builder.with_websocket(noise::Config::new, yamux::Config::default)).map_err(|e| e.to_string())?;
        let Ok(builder) = builder.with_behaviour(|k| behaviour::Behaviour {
            mcp: mcp::behaviour(crate::wire::Speaks::default().protocols(crate::wire::MCP).into_iter().map(|(p, _)| (p, request_response::ProtocolSupport::Inbound)).collect()),
            identify: identify::Behaviour::new(identify::Config::new("/unbrowse/id/1.0.0".into(), k.public()).with_agent_version(agent)),
            ping: ping::Behaviour::new(ping::Config::new().with_interval(PING_EVERY)),
        });
        let mut swarm = builder.with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(u64::MAX / 4))).build();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let (tell, state) = tokio::sync::watch::channel(LinkState::Dialling);
        let door = McpDoor(Some(door));
        tokio::spawn(async move {
            let mut desk = mcp::Desk::new();
            let (answers_tx, mut answers) = tokio::sync::mpsc::channel::<(request_response::ResponseChannel<McpAnswer>, McpAnswer)>(64);
            let mut wait = Duration::from_secs(1);
            let target = addr.clone().with_p2p(gateway).unwrap_or(addr);
            let _ = swarm.dial(target.clone());
            let redial = tokio::time::sleep(Duration::from_secs(3600 * 24 * 365));
            tokio::pin!(redial);
            loop {
                tokio::select! {
                    _ = &mut stopped => return,
                    Some((channel, answer)) = answers.recv() => {
                        desk.answered();
                        let _ = swarm.behaviour_mut().mcp.send_response(channel, answer);
                    }
                    _ = &mut redial => {
                        let _ = tell.send(LinkState::Dialling);
                        let _ = swarm.dial(target.clone());
                        redial.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(3600 * 24 * 365));
                    }
                    e = swarm.select_next_some() => match e {
                        SwarmEvent::ConnectionEstablished { peer_id, .. } if peer_id == gateway => {
                            wait = Duration::from_secs(1);
                            let _ = tell.send(LinkState::Connected);
                        }
                        SwarmEvent::ConnectionClosed { peer_id, num_established: 0, cause, .. } if peer_id == gateway => {
                            let _ = tell.send(LinkState::Down(cause.map(|c| c.to_string()).unwrap_or_else(|| "closed".into())));
                            redial.as_mut().reset(tokio::time::Instant::now() + wait);
                            wait = (wait * 2).min(MAX_WAIT);
                        }
                        SwarmEvent::OutgoingConnectionError { peer_id: Some(p), error, .. } if p == gateway => {
                            let _ = tell.send(LinkState::Down(error.to_string()));
                            redial.as_mut().reset(tokio::time::Instant::now() + wait);
                            wait = (wait * 2).min(MAX_WAIT);
                        }
                        SwarmEvent::Behaviour(behaviour::BehaviourEvent::Mcp(request_response::Event::Message { peer, message: request_response::Message::Request { channel, .. }, .. })) if peer != gateway => {
                            let _ = swarm.behaviour_mut().mcp.send_response(channel, McpAnswer::refused(403, "this link takes asks from its gateway alone"));
                        }
                        SwarmEvent::Behaviour(behaviour::BehaviourEvent::Mcp(ev)) => {
                            let tx = answers_tx.clone();
                            mcp::event(&mut swarm.behaviour_mut().mcp, &mut desk, &door, move |channel, answer| {
                                let _ = tx.try_send((channel, answer));
                            }, ev);
                        }
                        _ => {}
                    }
                }
            }
        });
        let _ = me;
        Ok(Link { stop: Some(stop), state })
    }
}

/// A gateway's libp2p address from its HTTPS address: `https://unbrowse.ai` is `/dns4/unbrowse.ai/tcp/443/wss`, and
/// `http://127.0.0.1:8787` is `/ip4/127.0.0.1/tcp/8787/ws`, each with the path the gateway takes peers at.
pub fn gateway_addr(gateway: &str, path: &str) -> Option<Multiaddr> {
    use libp2p::multiaddr::Protocol;
    let (secure, rest) = if let Some(r) = gateway.trim().strip_prefix("https://") { (true, r) } else { (false, gateway.trim().strip_prefix("http://")?) };
    let authority = rest.split('/').next()?;
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => (h.trim_matches(['[', ']']), p.parse::<u16>().ok()?),
        _ => (authority, if secure { 443 } else { 80 }),
    };
    let mut a = Multiaddr::empty();
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => a.push(Protocol::Ip4(ip)),
        Ok(std::net::IpAddr::V6(ip)) => a.push(Protocol::Ip6(ip)),
        Err(_) => a.push(Protocol::Dns4(host.to_string().into())),
    }
    a.push(Protocol::Tcp(port));
    let path = if path.is_empty() { "/".to_string() } else { path.to_string() };
    if secure {
        a.push(Protocol::Tls);
    }
    // The site's root is plain `/ws`, the address every libp2p speaks; another path is `x-parity-ws`.
    a.push(Protocol::Ws(path.into()));
    Some(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gateway_address_becomes_its_websocket_multiaddr() {
        assert_eq!(gateway_addr("https://unbrowse.ai", "/").unwrap().to_string(), "/dns4/unbrowse.ai/tcp/443/tls/ws");
        assert_eq!(gateway_addr("https://unbrowse.ai", "/p2p").unwrap().to_string(), "/dns4/unbrowse.ai/tcp/443/tls/x-parity-ws/%2Fp2p");
        assert_eq!(gateway_addr("http://127.0.0.1:8787/", "/p2p").unwrap().to_string(), "/ip4/127.0.0.1/tcp/8787/x-parity-ws/%2Fp2p");
        assert!(gateway_addr("ftp://x", "/").is_none());
    }
}

#[cfg(test)]
mod spike {
    use super::*;

    struct Echo;
    impl Mcp for Echo {
        fn answer(&self, from: PeerId, ask: crate::McpAsk) -> futures::future::BoxFuture<'static, McpAnswer> {
            Box::pin(async move { McpAnswer { status: 200, headers: vec![("content-type".into(), "application/json".into())], body: format!("{{\"from\":\"{from}\",\"target\":\"{}\",\"body\":{}}}", ask.target, String::from_utf8_lossy(&ask.body)).into_bytes() } })
        }
    }

    /// The link against a js-libp2p peer (UNBROWSE_TEST_JS_PEER at UNBROWSE_TEST_JS_ADDR): it dials over WebSocket, and
    /// answers the asks the JavaScript peer sends with its door.
    #[test]
    #[ignore = "needs a js-libp2p peer listening: UNBROWSE_TEST_JS_PEER, UNBROWSE_TEST_JS_ADDR"]
    fn the_link_answers_a_javascript_peer() {
        let (Ok(peer), Ok(addr)) = (std::env::var("UNBROWSE_TEST_JS_PEER"), std::env::var("UNBROWSE_TEST_JS_ADDR")) else { return };
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let link = Link::start(libp2p::identity::Keypair::generate_ed25519(), peer.parse().unwrap(), addr.parse().unwrap(), Arc::new(Echo), "unbrowse-node-link; role=own".into()).unwrap();
            let mut state = link.state.clone();
            let _ = tokio::time::timeout(Duration::from_secs(20), state.wait_for(|s| *s == LinkState::Connected)).await.expect("connected");
            tokio::time::sleep(Duration::from_secs(5)).await;
            eprintln!("LINK_STATE {:?}", *link.state.borrow());
        });
    }
}
