//! `/unbrowse/mcp/1`: an MCP request to one node over the peer network, with no gateway between (graph `gateway.direct`).
//! A client that signs its requests (`unb mcp --peer`, the SDKs) dials its owner's node by peer ID, directly or through
//! any relay that carries it, and hands it the HTTP request it would have sent to the node's door: the method, the
//! target, the headers (the signature's among them) and the body. The node answers it with its own door, so the request
//! is checked, its nonce taken and its answer signed exactly as at 127.0.0.1; the token never leaves the client. The
//! connection is encrypted to the node's peer key, which the client named, so nothing in between reads it.
//!
//! - `McpAsk`, `McpAnswer`: one request and its answer. On the wire, a 4-byte big-endian length, that many bytes of JSON
//!   (method, target, headers; status and headers for an answer), then the body to the end, as its bytes.
//! - `Mcp`: what answers the asks a node takes (`Config::mcp`). The node implements it with its door; a node that
//!   doesn't refuses every ask.
//! - The bounds both sides hold to, and the per-peer rate a node takes asks at (R7.29): one past it is refused at once.
//! - `authority`: the authority a request to a node over the peer network is signed for, `<peer id>.p2p`, so a request
//!   signed for one node verifies at no other node and at no door on a machine.
//! - `McpClient`: a swarm of its own for a client that only asks: no table, no listings, no identity on the network.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::prelude::*;
use libp2p::request_response::{self, OutboundRequestId, ResponseChannel};
use libp2p::{PeerId, StreamProtocol};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::body::read_bounded;
use crate::budget::{PerPeer, Rate};

pub const MCP_PROTOCOL: &str = "/unbrowse/mcp/1";
/// One ask: an MCP message's JSON-RPC is a few kilobytes, a tool call's arguments rarely more.
pub const MAX_MCP_ASK_BYTES: usize = 1024 * 1024;
/// One answer: a tool's reply, a page's picture included.
pub const MAX_MCP_ANSWER_BYTES: usize = 16 * 1024 * 1024;
/// The headers one ask or answer carries, and the bytes of any one of them.
pub const MAX_MCP_HEADERS: usize = 32;
pub const MAX_MCP_HEADER_BYTES: usize = 8 * 1024;
/// How long a client waits for an answer: a tool call may walk a page for minutes (the node's `CALL_WAIT_SECS`, 330 s),
/// with a margin. The node gives its door a little less, so a slow door is an answer, not a silence.
pub const MCP_TIMEOUT: Duration = Duration::from_secs(360);
pub(crate) const ANSWER_TIMEOUT: Duration = Duration::from_secs(345);
/// Asks a node answers at once, from every peer together; one past this is refused at once.
pub(crate) const MAX_ANSWERING: usize = 16;
/// How often one peer may ask: an agent's burst of a few dozen calls passes, and a loop is slowed (the gateway's
/// `gateway.caller_rate`).
pub(crate) const MCP_RATE: Rate = Rate { burst: 30.0, per_second: 0.5, peers: 1024 };

/// The authority a request to node `peer` over the peer network is signed for: `<peer id>.p2p`, lower case as the door
/// reads a host. The node puts it on every ask it takes, whatever the asker sent, so a request signed for another node,
/// or for a door on a machine, doesn't verify.
pub fn authority(peer: &PeerId) -> String {
    format!("{peer}.p2p").to_ascii_lowercase()
}

/// One MCP request to a node: what its door takes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpAsk {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The node's answer, as its door gave it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpAnswer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl McpAnswer {
    /// A refusal the network makes, before any door: the status and why, as JSON. Unsigned, so a client reads only its
    /// status.
    pub fn refused(status: u16, why: &str) -> McpAnswer {
        let body = serde_json::to_vec(&serde_json::json!({ "error": why })).unwrap_or_default();
        McpAnswer { status, headers: vec![("content-type".into(), "application/json".into())], body }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// What answers the asks a node takes. The node implements it with its own door; `from` is the peer that asked.
pub trait Mcp: Send + Sync + 'static {
    fn answer(&self, from: PeerId, ask: McpAsk) -> BoxFuture<'static, McpAnswer>;
}

/// The node's `Mcp`, if it takes asks at all (`Config::mcp`).
#[derive(Clone, Default)]
pub struct McpDoor(pub Option<Arc<dyn Mcp>>);

impl std::fmt::Debug for McpDoor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() { "McpDoor(open)" } else { "McpDoor(none)" })
    }
}

#[derive(Serialize, Deserialize)]
struct AskHead {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

#[derive(Serialize, Deserialize)]
struct AnswerHead {
    status: u16,
    headers: Vec<(String, String)>,
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

fn headers_ok(headers: &[(String, String)]) -> bool {
    headers.len() <= MAX_MCP_HEADERS && headers.iter().all(|(k, v)| k.len() + v.len() <= MAX_MCP_HEADER_BYTES)
}

/// A head as JSON with its length in front, then the body.
fn frame<H: Serialize>(head: &H, body: &[u8], max: usize) -> io::Result<Vec<u8>> {
    let head = serde_json::to_vec(head).map_err(|e| bad(&e.to_string()))?;
    let len = u32::try_from(head.len()).map_err(|_| bad("a head too long"))?;
    let out = [&len.to_be_bytes()[..], &head, body].concat();
    if out.len() > max {
        return Err(bad("past the bound"));
    }
    Ok(out)
}

fn unframe<H: for<'de> Deserialize<'de>>(bytes: &[u8]) -> io::Result<(H, Vec<u8>)> {
    let (len, rest) = bytes.split_first_chunk::<4>().ok_or_else(|| bad("no head"))?;
    let len = u32::from_be_bytes(*len) as usize;
    if len > rest.len() {
        return Err(bad("a head longer than what came"));
    }
    let head = serde_json::from_slice(&rest[..len]).map_err(|_| bad("a head that isn't one"))?;
    Ok((head, rest[len..].to_vec()))
}

pub(crate) fn encode_ask(ask: &McpAsk) -> io::Result<Vec<u8>> {
    if !headers_ok(&ask.headers) {
        return Err(bad("too many headers, or one too long"));
    }
    frame(&AskHead { method: ask.method.clone(), target: ask.target.clone(), headers: ask.headers.clone() }, &ask.body, MAX_MCP_ASK_BYTES)
}

pub(crate) fn decode_ask(bytes: &[u8]) -> io::Result<McpAsk> {
    let (h, body): (AskHead, _) = unframe(bytes)?;
    if !headers_ok(&h.headers) {
        return Err(bad("too many headers, or one too long"));
    }
    Ok(McpAsk { method: h.method, target: h.target, headers: h.headers, body })
}

pub(crate) fn encode_answer(a: &McpAnswer) -> io::Result<Vec<u8>> {
    if !headers_ok(&a.headers) {
        return Err(bad("too many headers, or one too long"));
    }
    frame(&AnswerHead { status: a.status, headers: a.headers.clone() }, &a.body, MAX_MCP_ANSWER_BYTES)
}

pub(crate) fn decode_answer(bytes: &[u8]) -> io::Result<McpAnswer> {
    let (h, body): (AnswerHead, _) = unframe(bytes)?;
    if !headers_ok(&h.headers) {
        return Err(bad("too many headers, or one too long"));
    }
    Ok(McpAnswer { status: h.status, headers: h.headers, body })
}

/// Each side reads at most one byte past its bound, and never writes past it.
#[derive(Clone, Default)]
pub struct McpCodec;

impl request_response::Codec for McpCodec {
    type Protocol = StreamProtocol;
    type Request = McpAsk;
    type Response = McpAnswer;

    async fn read_request<T: AsyncRead + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<McpAsk> {
        decode_ask(&read_bounded(io, MAX_MCP_ASK_BYTES).await?)
    }

    async fn read_response<T: AsyncRead + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<McpAnswer> {
        decode_answer(&read_bounded(io, MAX_MCP_ANSWER_BYTES).await?)
    }

    async fn write_request<T: AsyncWrite + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T, ask: McpAsk) -> io::Result<()> {
        io.write_all(&encode_ask(&ask)?).await?;
        io.close().await
    }

    async fn write_response<T: AsyncWrite + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T, answer: McpAnswer) -> io::Result<()> {
        let bytes = encode_answer(&answer).or_else(|_| encode_answer(&McpAnswer::refused(502, "the node's answer was larger than the peer network carries")))?;
        io.write_all(&bytes).await?;
        io.close().await
    }
}

pub(crate) type Asking = oneshot::Sender<Result<McpAnswer, request_response::OutboundFailure>>;

/// The swarm's side of the protocol: asks this node sent and waits on, those it is answering, and how often each peer
/// may ask.
pub(crate) struct Desk {
    pub(crate) asking: std::collections::HashMap<OutboundRequestId, Asking>,
    answering: usize,
    rate: PerPeer,
}

impl Desk {
    pub(crate) fn new() -> Desk {
        Desk { asking: Default::default(), answering: 0, rate: PerPeer::new(MCP_RATE) }
    }

    /// An answer is going out: its place among those being made is given back.
    pub(crate) fn answered(&mut self) {
        self.answering = self.answering.saturating_sub(1);
    }
}

/// An ask being answered: however the door ends, an answer goes out and its place is given back.
struct Answering<F: FnOnce(ResponseChannel<McpAnswer>, McpAnswer)>(Option<(F, ResponseChannel<McpAnswer>)>);

impl<F: FnOnce(ResponseChannel<McpAnswer>, McpAnswer)> Answering<F> {
    fn answer(mut self, answer: McpAnswer) {
        if let Some((tell, channel)) = self.0.take() {
            tell(channel, answer);
        }
    }
}

impl<F: FnOnce(ResponseChannel<McpAnswer>, McpAnswer)> Drop for Answering<F> {
    fn drop(&mut self) {
        if let Some((tell, channel)) = self.0.take() {
            tell(channel, McpAnswer::refused(500, "the node failed answering"));
        }
    }
}

/// Why an ask would be refused before its door, if it would: a peer past its rate, too many being answered, or a node
/// that takes no asks.
pub(crate) fn turned_away(desk: &mut Desk, door: &McpDoor, peer: PeerId, now: std::time::Instant) -> Option<McpAnswer> {
    if door.0.is_none() {
        return Some(McpAnswer::refused(404, "this node takes no MCP over the peer network"));
    }
    if !desk.rate.take(peer, now) {
        return Some(McpAnswer::refused(429, "too many asks from this peer; ask again shortly"));
    }
    if desk.answering >= MAX_ANSWERING {
        return Some(McpAnswer::refused(503, "too many asks at once; ask again shortly"));
    }
    None
}

/// One event of the protocol. An ask past the bounds is refused at once; any other is answered by `door` off the
/// swarm's loop, and its answer goes back through `answer`.
pub(crate) fn event(
    behaviour: &mut request_response::Behaviour<McpCodec>,
    desk: &mut Desk,
    door: &McpDoor,
    answer: impl FnOnce(ResponseChannel<McpAnswer>, McpAnswer) + Send + 'static,
    e: request_response::Event<McpAsk, McpAnswer>,
) {
    match e {
        request_response::Event::Message { peer, message: request_response::Message::Request { request, channel, .. }, .. } => {
            if let Some(refusal) = turned_away(desk, door, peer, std::time::Instant::now()) {
                let _ = behaviour.send_response(channel, refusal);
                return;
            }
            let Some(mcp) = door.0.clone() else { return };
            desk.answering += 1;
            let answering = Answering(Some((answer, channel)));
            tokio::spawn(async move {
                let a = tokio::time::timeout(ANSWER_TIMEOUT, mcp.answer(peer, request)).await.unwrap_or_else(|_| McpAnswer::refused(504, "the node didn't answer in time"));
                answering.answer(a);
            });
        }
        request_response::Event::Message { message: request_response::Message::Response { request_id, response }, .. } => {
            if let Some(reply) = desk.asking.remove(&request_id) {
                let _ = reply.send(Ok(response));
            }
        }
        request_response::Event::OutboundFailure { request_id, error, .. } => {
            if let Some(reply) = desk.asking.remove(&request_id) {
                let _ = reply.send(Err(error));
            }
        }
        _ => {}
    }
}

pub(crate) fn behaviour(protocols: Vec<(StreamProtocol, request_response::ProtocolSupport)>) -> request_response::Behaviour<McpCodec> {
    request_response::Behaviour::with_codec(McpCodec, protocols, request_response::Config::default().with_request_timeout(MCP_TIMEOUT).with_max_concurrent_streams(MAX_ANSWERING))
}

/// A client that only asks nodes: a swarm of its own, with no table, no listings and no identity on the network. It
/// dials the addresses it is given (a relay's circuit address included) and upgrades a relayed connection to a direct
/// one when both ends can (DCUtR).
#[derive(Clone)]
pub struct McpClient {
    tx: tokio::sync::mpsc::Sender<(PeerId, Vec<libp2p::Multiaddr>, McpAsk, Asking)>,
    peer_id: PeerId,
}

mod client {
    #![allow(unreachable_code)]
    use libp2p::swarm::NetworkBehaviour;
    use libp2p::{dcutr, identify, ping, relay, request_response};

    #[derive(NetworkBehaviour)]
    pub(super) struct Behaviour {
        pub(super) mcp: request_response::Behaviour<super::McpCodec>,
        pub(super) identify: identify::Behaviour,
        pub(super) ping: ping::Behaviour,
        pub(super) relay_client: relay::client::Behaviour,
        pub(super) dcutr: dcutr::Behaviour,
    }
}

impl McpClient {
    /// Starts the client's swarm with a key of its own.
    pub fn start() -> Result<McpClient, String> {
        use libp2p::{dcutr, identify, noise, ping, tcp, yamux};
        let key = libp2p::identity::Keypair::generate_ed25519();
        let peer_id = key.public().to_peer_id();
        let builder = libp2p::SwarmBuilder::with_existing_identity(key)
            .with_tokio()
            .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
            .map_err(|e| e.to_string())?
            .with_quic()
            .with_relay_client(noise::Config::new, yamux::Config::default)
            .map_err(|e| e.to_string())?;
        let Ok(builder) = builder.with_behaviour(|k, relay_client| client::Behaviour {
            mcp: request_response::Behaviour::with_codec(
                McpCodec,
                crate::wire::Speaks::default().protocols(crate::wire::MCP),
                request_response::Config::default().with_request_timeout(MCP_TIMEOUT),
            ),
            identify: identify::Behaviour::new(identify::Config::new("/unbrowse/id/1.0.0".into(), k.public()).with_agent_version("unbrowse-mcp-client".into())),
            ping: ping::Behaviour::new(ping::Config::new()),
            relay_client,
            dcutr: dcutr::Behaviour::new(peer_id),
        });
        let mut swarm = builder.with_swarm_config(|c| c.with_idle_connection_timeout(MCP_TIMEOUT)).build();
        // A listener of its own lets a hole punch through a relay land; a client with none still asks directly.
        let _ = swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse().expect("static"));
        let _ = swarm.listen_on("/ip4/0.0.0.0/udp/0/quic-v1".parse().expect("static"));
        let (tx, mut rx) = tokio::sync::mpsc::channel::<(PeerId, Vec<libp2p::Multiaddr>, McpAsk, Asking)>(64);
        tokio::spawn(async move {
            use libp2p::swarm::SwarmEvent;
            let mut asking: std::collections::HashMap<OutboundRequestId, Asking> = Default::default();
            loop {
                tokio::select! {
                    cmd = rx.recv() => {
                        let Some((peer, addrs, ask, reply)) = cmd else { return };
                        for a in addrs {
                            swarm.add_peer_address(peer, a);
                        }
                        let id = swarm.behaviour_mut().mcp.send_request(&peer, ask);
                        asking.insert(id, reply);
                    }
                    e = swarm.select_next_some() => match e {
                        SwarmEvent::Behaviour(client::BehaviourEvent::Mcp(request_response::Event::Message { message: request_response::Message::Response { request_id, response }, .. })) => {
                            if let Some(reply) = asking.remove(&request_id) {
                                let _ = reply.send(Ok(response));
                            }
                        }
                        SwarmEvent::Behaviour(client::BehaviourEvent::Mcp(request_response::Event::OutboundFailure { request_id, error, .. })) => {
                            if let Some(reply) = asking.remove(&request_id) {
                                let _ = reply.send(Err(error));
                            }
                        }
                        _ => {}
                    }
                }
            }
        });
        Ok(McpClient { tx, peer_id })
    }

    /// The client's own peer ID: a new one each run, standing for no one.
    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    /// Asks node `peer`, dialling `addrs` (and any address the client already knows for it), and waits for its answer.
    pub async fn ask(&self, peer: PeerId, addrs: Vec<libp2p::Multiaddr>, ask: McpAsk) -> Result<McpAnswer, String> {
        let (reply, answer) = oneshot::channel();
        self.tx.send((peer, addrs, ask, reply)).await.map_err(|_| "the client stopped".to_string())?;
        match tokio::time::timeout(MCP_TIMEOUT + Duration::from_secs(5), answer).await {
            Ok(Ok(Ok(a))) => Ok(a),
            Ok(Ok(Err(e))) => Err(format!("the node didn't answer: {e}")),
            Ok(Err(_)) => Err("the client stopped".into()),
            Err(_) => Err("the node didn't answer in time".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::request_response::Codec as _;

    fn proto() -> StreamProtocol {
        StreamProtocol::new(MCP_PROTOCOL)
    }

    fn ask() -> McpAsk {
        McpAsk { method: "POST".into(), target: "/mcp".into(), headers: vec![("x-unbrowse-key".into(), "ab".into())], body: br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_vec() }
    }

    #[tokio::test]
    async fn an_ask_and_its_answer_cross_the_wire_unchanged() {
        let mut wire = Vec::new();
        McpCodec.write_request(&proto(), &mut futures::io::Cursor::new(&mut wire), ask()).await.unwrap();
        assert_eq!(McpCodec.read_request(&proto(), &mut &wire[..]).await.unwrap(), ask());
        let answer = McpAnswer { status: 200, headers: vec![("x-unbrowse-reply".into(), "cd".into())], body: vec![0, 159, 255, b'{'] };
        let mut wire = Vec::new();
        McpCodec.write_response(&proto(), &mut futures::io::Cursor::new(&mut wire), answer.clone()).await.unwrap();
        assert_eq!(McpCodec.read_response(&proto(), &mut &wire[..]).await.unwrap(), answer, "a body's bytes, any bytes, come through as they were");
    }

    /// An ask past the bound is never sent, and one a peer sends anyway is cut off one byte past it, unread; an answer
    /// past its bound goes out as a refusal instead.
    #[tokio::test]
    async fn an_ask_past_the_bound_is_never_sent_or_read_and_an_answer_past_it_is_a_refusal() {
        let flood = McpAsk { body: vec![b'x'; MAX_MCP_ASK_BYTES], ..ask() };
        let mut wire = Vec::new();
        assert!(McpCodec.write_request(&proto(), &mut futures::io::Cursor::new(&mut wire), flood).await.is_err());
        assert!(wire.is_empty(), "nothing was written");
        let more = vec![b'x'; 4 * MAX_MCP_ASK_BYTES];
        let mut reader = &more[..];
        assert!(McpCodec.read_request(&proto(), &mut reader).await.is_err());
        assert_eq!(more.len() - reader.len(), MAX_MCP_ASK_BYTES + 1, "read stops one byte past the bound");
        let many = McpAsk { headers: (0..=MAX_MCP_HEADERS).map(|i| (format!("h{i}"), "v".into())).collect(), ..ask() };
        assert!(encode_ask(&many).is_err(), "too many headers");
        let huge = McpAnswer { status: 200, headers: vec![], body: vec![b'x'; MAX_MCP_ANSWER_BYTES] };
        let mut wire = Vec::new();
        McpCodec.write_response(&proto(), &mut futures::io::Cursor::new(&mut wire), huge).await.unwrap();
        assert_eq!(McpCodec.read_response(&proto(), &mut &wire[..]).await.unwrap().status, 502);
        assert!(decode_ask(&[0, 0, 0, 9, b'{']).is_err() && decode_ask(&[]).is_err() && decode_answer(&[0, 0, 0, 2, b'[', b']']).is_err());
    }

    /// A node that takes no asks refuses each; a peer past its rate is refused at once, others aren't; past the asks
    /// answered at once, every peer is refused.
    #[test]
    fn asks_past_a_peers_rate_or_the_nodes_answers_at_once_are_refused_at_once() {
        struct Echo;
        impl Mcp for Echo {
            fn answer(&self, _: PeerId, _: McpAsk) -> BoxFuture<'static, McpAnswer> {
                Box::pin(async { McpAnswer::refused(200, "") })
            }
        }
        let now = std::time::Instant::now();
        let (a, b) = (PeerId::random(), PeerId::random());
        let mut desk = Desk::new();
        assert_eq!(turned_away(&mut desk, &McpDoor(None), a, now).map(|r| r.status), Some(404));
        let door = McpDoor(Some(Arc::new(Echo)));
        let mut desk = Desk::new();
        for _ in 0..MCP_RATE.burst as usize {
            assert!(turned_away(&mut desk, &door, a, now).is_none());
        }
        assert_eq!(turned_away(&mut desk, &door, a, now).map(|r| r.status), Some(429));
        assert!(turned_away(&mut desk, &door, b, now).is_none(), "one peer's rate is its own");
        desk.answering = MAX_ANSWERING;
        assert_eq!(turned_away(&mut desk, &door, PeerId::random(), now).map(|r| r.status), Some(503));
        desk.answered();
        assert!(turned_away(&mut desk, &door, PeerId::random(), now).is_none());
    }

    #[test]
    fn a_request_is_signed_for_the_node_it_goes_to() {
        let (a, b) = (PeerId::random(), PeerId::random());
        assert_ne!(authority(&a), authority(&b));
        assert!(authority(&a).ends_with(".p2p") && authority(&a) == authority(&a).to_ascii_lowercase());
    }
}
