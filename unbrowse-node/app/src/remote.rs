//! This node's own remote MCP URL (graph `decide.remote-mcp-gateway`, `gateway.relay-to-own`, `gateway.attach`,
//! `gateway.remote-key`). When the owner turns it on, the node links to the gateway's peer (a libp2p peer in a Cloudflare
//! Worker, `https://unbrowse.ai` by default) as it would to any peer: over libp2p, on WebSocket, with its own peer key
//! (`unbrowse_net::Link`), and answers the gateway peer's `/unbrowse/mcp/1` asks. From then on the node's MCP is at
//! `<gateway>/p/<this node's peer ID>/mcp`, from anywhere, with no port opened here and the node's door still on
//! 127.0.0.1.
//!
//! - The URL is the node's: its peer ID is the key the node holds, the same key it has on the peer network when it
//!   had joined one before this was turned on. No other machine can attach under it.
//! - Each message the gateway hands over is answered by the node's own MCP handler, browser and logins included, as an
//!   agent at the node's door is, with progress events streamed back as they come.
//! - It opens only with a remote key the owner made for that gateway (`unbrowse-node remote key`), checked on every
//!   message (`agents::by_gateway_token`). A remote key never opens the node's own door, and no other key opens the
//!   node through the gateway: how a message arrived is a task-local here (`arrived_via`) that only this module sets.
//! - The gateway can read what it carries (`assume.gateway-sees`): the key is narrowed to this one path, capped and
//!   revocable, and each call through it is in the owner's activity.
//! - A remote key never goes on a command line: the Claude Code line it comes with signs in through the node (OAuth),
//!   so the client keeps its own token, and the key itself is shown once for a client to keep in its own settings.
//! - A sign-in through the gateway asks the owner only while the owner expects one (`expect_sign_in`: for
//!   `SIGN_IN_OPEN` after the owner turns the remote on, makes a key, or runs `unbrowse-node remote sign-in`); at any
//!   other time it is refused at once, so a stranger who knows the node's URL can neither put a dialog in front of the
//!   owner nor use up the asks the owner's own sign-in needs. The dialog says the app's name and return address are
//!   what the app chose.
//!
//! A node may instead be a **public peer** (`unbrowse-node remote public`, graph `gateway.calls-only`,
//! `gateway.no-credentials`): it attaches as `public` and answers anyone who calls the gateway's `/mcp`, with calls
//! only. It offers the tools that find and call a route, never opens or fetches a browser, never reads anyone's browser
//! for a session, and runs only in a home that holds no login, card or passkey. Every message runs as the node's own
//! public key, whose daily cap is what it spends for all of its callers together (`decide.gateway-pays-capped`). A
//! gateway takes a public peer only if it names it (unbrowse-landing `PUBLIC_PEERS`).
//!
//! The gateway peer is unbrowse-landing `worker/peer.js`; it turns MCP over HTTPS into those asks (`worker/gateway.js`).

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use unbrowse_net::Keypair;

use crate::{agents, store, Node};

pub const DEFAULT_GATEWAY: &str = "https://unbrowse.ai";
/// What a message that came through a gateway hears when its key isn't a remote key made for that gateway.
pub(crate) const NOT_THIS_GATEWAY: &str = "this key doesn't open this node through this gateway: on the node's machine, run `unbrowse-node remote key` to make one that does";
/// How often the node looks at whether the owner changed the remote setting, and pings the gateway: a WebSocket ping
/// frame, which the gateway's runtime answers without waking it.
const RECHECK: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 5 });
/// The longest the node waits between tries to attach.
const MAX_WAIT: Duration = Duration::from_secs(60);
/// What a remote key may spend a day, and how long it lasts, unless the owner says otherwise.
pub const KEY_CAP_USDC: f64 = agents::AUTO_CAP_USDC;
pub const KEY_DAYS: u64 = 30;
/// The tools a public peer offers: the ones that find and call a route. Nothing that drives a page.
pub const PUBLIC_TOOLS: [&str; 5] = ["unbrowse_do", "unbrowse_search", "unbrowse_call", "unbrowse_judge", "unbrowse_report"];
/// What a public peer answers for anything it doesn't do.
pub const NEEDS_OWN_NODE: &str = "needs your own node: this is a public Unbrowse peer, which only calls routes, with no browser and no sign-in. Install Unbrowse (unbrowse.ai) and run `unbrowse-node remote on` to use your own node from anywhere, browser and logins included";
/// What a public peer's key may spend a day for all of its callers together (graph `param.gateway.spend_per_day`).
pub const PUBLIC_SPEND_PER_DAY_USDC: f64 = 5.0;
/// The request headers taken from the gateway: MCP's own, and the key.
const PASSED: [&str; 6] = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id", "authorization"];
/// The answer headers handed back.
const RETURNED: [&str; 3] = ["content-type", "mcp-session-id", "cache-control"];

/// The owner's remote setting, in `remote.json`: on or off, which gateway, and the node's key there.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Remote {
    #[serde(default)]
    pub on: bool,
    #[serde(default)]
    pub gateway: String,
    /// A public peer (`unbrowse-node remote public`): attaches as `public`, calls only, in a home with no credential.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub public: bool,
    /// The node's Ed25519 key, protobuf-encoded, in hex. Kept when the remote is turned off, so the URL stays the
    /// same when it is turned on again.
    #[serde(default)]
    key: String,
    /// The gateway's peer ID, kept the first time the node asks it who it is (`gateway_peer`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    gateway_peer: String,
    /// Until when (milliseconds since 1970) a sign-in through the gateway may ask the owner (`expect_sign_in`): 0 when
    /// none may. Each opening has its own, so the asks counted against one never count against the next. Not part of
    /// the link: changing it doesn't link again.
    #[serde(default, skip_serializing_if = "is_zero")]
    sign_in_until: u64,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

fn path() -> std::path::PathBuf {
    store::home().join("remote.json")
}

impl Remote {
    pub fn load() -> Remote {
        store::read_json(&path(), &unbrowse_files::REMOTE)
    }

    fn save(&self) -> Result<(), String> {
        store::write_json(&path(), &unbrowse_files::REMOTE, self)
    }

    pub fn keypair(&self) -> Option<Keypair> {
        hex::decode(&self.key).ok().and_then(|b| Keypair::from_protobuf_encoding(&b).ok())
    }

    pub fn peer(&self) -> Option<String> {
        self.keypair().map(|k| k.public().to_peer_id().to_string())
    }

    /// The gateway's host, as the gateway names itself in its challenge: `unbrowse.ai`, or `127.0.0.1:8787`.
    pub fn host(&self) -> Option<String> {
        host_of(&self.gateway)
    }

    /// This node's MCP address at the gateway: its own, or the gateway's public one for a public peer.
    pub fn url(&self) -> Option<String> {
        if self.public {
            self.peer()?;
            return Some(format!("{}/mcp", self.gateway.trim_end_matches('/')));
        }
        Some(format!("{}/p/{}/mcp", self.gateway.trim_end_matches('/'), self.peer()?))
    }

    /// The gateway's page that links this node to its owner's Unbrowse account, so that an app signed in to the
    /// gateway's shared `/mcp` as them reaches this node (unbrowse-landing `worker/signin.js` `linkNode`): the owner
    /// signs in there, and this node asks them in its own dialog, as any sign-in through the gateway is asked. None for
    /// a public peer, which answers everyone and is no one's.
    pub fn account_link(&self) -> Option<String> {
        if self.public {
            return None;
        }
        Some(format!("{}/link/#own={}", self.gateway.trim_end_matches('/'), self.peer()?))
    }

    /// The setting as the link reads it: everything but when a sign-in is expected, which the link doesn't hold.
    fn linked(&self) -> Remote {
        Remote { sign_in_until: 0, ..self.clone() }
    }

    /// Whether a sign-in through the gateway may ask the owner now. Read by the tests alone since #685.
    #[cfg(test)]
    pub fn expects_sign_in(&self) -> bool {
        self.sign_in_until > now_ms()
    }

    /// The name a message through this attachment arrives by (`arrived_via`), and the gateway the keys that open it
    /// are made for: the gateway's host, or `public@<host>` for a public peer's own key.
    fn arrival(&self) -> Option<String> {
        let host = self.host()?;
        Some(if self.public { format!("public@{host}") } else { host })
    }
}

/// Whether this node's home is a public peer's: it never opens a browser or reads anyone's for a session.
pub fn public_home() -> bool {
    Remote::load().public
}

/// What in this home a public peer must not hold, said plainly; empty when it holds none.
pub fn credentials_held() -> Vec<String> {
    let mut held = vec![];
    let logins = crate::vault::list().len();
    if logins > 0 {
        held.push(format!("{logins} saved login{}", if logins == 1 { "" } else { "s" }));
    }
    let cards = crate::vault::cards().len();
    if cards > 0 {
        held.push(format!("{cards} card{}", if cards == 1 { "" } else { "s" }));
    }
    let passkeys = crate::passkey::list().len();
    if passkeys > 0 {
        held.push(format!("{passkeys} passkey{}", if passkeys == 1 { "" } else { "s" }));
    }
    // A session jar is a sign-in as much as a saved login is: a call that sends it runs as whoever signed in.
    let sessions = session_jars(&store::owner_jars_dir());
    if sessions > 0 {
        held.push(format!("{sessions} signed-in session{}", if sessions == 1 { "" } else { "s" }));
    }
    // So is a browser profile the node walked a site in: it keeps that site's cookies.
    let profiles = std::fs::read_dir(store::profiles_dir()).map(|d| d.flatten().filter(|e| e.path().is_dir()).count()).unwrap_or(0);
    if profiles > 0 {
        held.push(format!("{profiles} browser profile{}", if profiles == 1 { "" } else { "s" }));
    }
    held
}

/// The session jars in `dir` that hold a cookie: `<host>.json` files with at least one value.
fn session_jars(dir: &std::path::Path) -> usize {
    let Ok(dir) = std::fs::read_dir(dir) else { return 0 };
    dir.flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".json")))
        .filter(|e| store::read_json_opt::<serde_json::Map<String, Value>>(&e.path(), &unbrowse_files::JAR).is_some_and(|j| !j.is_empty()))
        .count()
}

/// A gateway's host from its address: `https://unbrowse.ai` → `unbrowse.ai`. Only http and https.
pub fn host_of(gateway: &str) -> Option<String> {
    let u = url::Url::parse(gateway.trim()).ok()?;
    if !matches!(u.scheme(), "https" | "http") {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    Some(match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    })
}

/// Only the field of `peer-key.json` this reads: the node's key on the peer network.
#[derive(Default, Deserialize)]
struct NetKey {
    #[serde(default)]
    key: String,
}

/// Turns the remote on at `gateway`. The first time, the node takes the key it has on the peer network, when it has
/// one, so its URL names the same peer ID; otherwise a new key.
pub fn turn_on(gateway: &str) -> Result<Remote, String> {
    turn_on_as(gateway, false)
}

/// Turns the remote on as a public peer, or as the owner's own node.
pub fn turn_on_as(gateway: &str, public: bool) -> Result<Remote, String> {
    host_of(gateway).ok_or_else(|| format!("{gateway} isn't a gateway's address (https://…)"))?;
    let mut r = Remote::load();
    r.public = public;
    if r.keypair().is_none() {
        let net: NetKey = store::read_json(&store::home().join("peer-key.json"), &unbrowse_files::PEER_KEY);
        let taken = hex::decode(&net.key).ok().and_then(|b| Keypair::from_protobuf_encoding(&b).ok()).filter(|k| k.public().try_into_ed25519().is_ok());
        let k = taken.unwrap_or_else(Keypair::generate_ed25519);
        r.key = hex::encode(k.to_protobuf_encoding().map_err(|e| e.to_string())?);
    }
    r.on = true;
    let gateway = gateway.trim().trim_end_matches('/').to_string();
    // A gateway named anew is asked who it is anew.
    if r.gateway != gateway {
        r.gateway_peer.clear();
    }
    r.gateway = gateway;
    r.save()?;
    Ok(r)
}

pub fn turn_off() -> Result<Remote, String> {
    let mut r = Remote::load();
    r.on = false;
    r.save()?;
    Ok(r)
}

tokio::task_local! {
    /// The gateway (its host) the message being answered came through, set only by `answer` here.
    static ARRIVED: String;
}

/// The name a message over the peer network arrives by (`arrived_via`), and what the keys that open the node that way are
/// made for (`unbrowse-node remote peer key`, graph `gateway.direct`). A host never has a space, so no gateway's keys
/// share it.
pub const PEER_NETWORK: &str = "peer network";
/// What an ask over the peer network hears when its key wasn't made for the peer network.
pub(crate) const NOT_A_PEER_KEY: &str = "this key doesn't open this node over the peer network: on the node's machine, run `unbrowse-node remote peer key` to make one that does";
/// What an ask over the peer network hears while the owner has made no key for it: the door is shut.
pub(crate) const PEER_MCP_OFF: &str = "this node doesn't take MCP over the peer network: its owner turns it on by running `unbrowse-node remote peer key` on its machine";

/// `f`, answered as a message that came over the peer network (`api::Direct`): only a key made for the peer network
/// opens the node then, at the door (`signed::token_for`) and at each tool (`api::agent`).
pub(crate) fn over_peer_network<F: Future>(f: F) -> impl Future<Output = F::Output> {
    ARRIVED.scope(PEER_NETWORK.into(), f)
}

/// The live keys made for the peer network: none until the owner makes one, so the door is shut by default.
pub(crate) fn peer_keys() -> Vec<agents::Agent> {
    live_keys(PEER_NETWORK)
}

/// The gateway the message being answered came through, if it came through one.
pub(crate) fn arrived_via() -> Option<String> {
    ARRIVED.try_with(Clone::clone).ok()
}

/// `f`, keeping how the message it works for arrived, for a task spawned to answer it.
pub(crate) fn keep_arrival<F: Future>(f: F) -> impl Future<Output = F::Output> {
    use futures_util::future::Either;
    match arrived_via() {
        Some(g) => Either::Left(ARRIVED.scope(g, f)),
        None => Either::Right(f),
    }
}

/// What a gateway says it is, at `/.well-known/unbrowse/gateway`: its peer ID and the address nodes dial.
#[derive(Deserialize)]
struct GatewaySays {
    peer: String,
    #[serde(default)]
    addrs: Vec<String>,
}

/// The gateway's peer ID and libp2p address. The peer ID is kept the first time (`gateway_peer`), so a gateway that
/// later names another peer is refused rather than trusted: the connection is encrypted to the peer ID the node dials.
async fn gateway_peer(r: &Remote) -> Result<(unbrowse_net::PeerId, unbrowse_net::Multiaddr), String> {
    let url = format!("{}/.well-known/unbrowse/gateway", r.gateway.trim_end_matches('/'));
    let said: GatewaySays = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .and_then(|a| a.error_for_status())
        .map_err(|e| format!("couldn't ask the gateway at {} who it is: {e}", r.gateway))?
        .json()
        .await
        .map_err(|e| format!("the gateway at {} didn't say who it is: {e}", r.gateway))?;
    let peer: unbrowse_net::PeerId = said.peer.parse().map_err(|_| format!("the gateway at {} names no peer ID", r.gateway))?;
    if !r.gateway_peer.is_empty() && r.gateway_peer != said.peer {
        return Err(format!(
            "the gateway at {} now names peer {}, not {}, the one it named before: not dialling it. Run `unbrowse-node remote on {}` again to take the new one",
            r.gateway, said.peer, r.gateway_peer, r.gateway
        ));
    }
    if r.gateway_peer.is_empty() {
        let mut kept = Remote::load();
        kept.gateway_peer = said.peer.clone();
        kept.save()?;
    }
    let addr = said
        .addrs
        .iter()
        .find_map(|a| a.parse().ok())
        .or_else(|| unbrowse_net::gateway_addr(&r.gateway, "/"))
        .ok_or_else(|| format!("the gateway at {} gives no address to dial", r.gateway))?;
    Ok((peer, addr))
}

/// Keeps this node linked to the gateway peer while the owner has the remote on. The link itself dials again after
/// a drop; this starts it again when the owner changes the setting, and after a failure to start, more slowly each time.
pub async fn keep_attached(node: Arc<Node>) {
    let mut wait = Duration::from_secs(1);
    let mut said: Option<String> = None;
    loop {
        let r = Remote::load();
        if !r.on || r.keypair().is_none() || !node.unlocked() {
            tokio::time::sleep(RECHECK).await;
            continue;
        }
        match link_once(node.clone(), &r).await {
            Ok(()) => {
                said = None;
                wait = Duration::from_secs(1);
            }
            Err(e) => {
                if said.as_deref() != Some(e.as_str()) {
                    eprintln!("remote: {e}; trying again, every {}s at most", MAX_WAIT.as_secs());
                    said = Some(e);
                }
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(MAX_WAIT);
            }
        }
    }
}

/// One link to the gateway peer, for as long as the owner's setting stays as it was: `Ok` when it changed.
async fn link_once(node: Arc<Node>, r: &Remote) -> Result<(), String> {
    if r.public {
        let held = credentials_held();
        if !held.is_empty() {
            return Err(format!("not linking as a public peer: this home holds {}. A public peer runs in a home of its own with none (UNBROWSE_HOME)", held.join(", ")));
        }
    }
    let key = r.keypair().ok_or("no key")?;
    let (gateway, addr) = gateway_peer(r).await?;
    // Read again: the gateway's peer ID may have just been kept.
    let r = Remote::load();
    let arrival = r.arrival().ok_or("the gateway's address has no host")?;
    let door = Arc::new(RemoteDoor { node, arrival, public: r.public });
    let link = unbrowse_net::Link::start(key, gateway, addr, door, "unbrowse-node-link".into())?;
    let mut state = link.state.clone();
    loop {
        tokio::select! {
            changed = state.changed() => {
                if changed.is_err() {
                    return Err("the link stopped".into());
                }
                let now = state.borrow().clone();
                match now {
                    unbrowse_net::LinkState::Connected => eprintln!("remote: linked to the gateway peer {gateway}; this node's MCP is at {}", r.url().unwrap_or_default()),
                    unbrowse_net::LinkState::Down(why) => eprintln!("remote: the gateway peer {gateway} dropped ({why}); dialling it again"),
                    unbrowse_net::LinkState::Dialling => {}
                }
            }
            _ = tokio::time::sleep(RECHECK) => {
                if Remote::load().linked() != r.linked() {
                    return Ok(());
                }
            }
        }
    }
}

/// What answers the gateway peer's asks over `/unbrowse/mcp/1`: MCP messages for the node's own handler, and an OAuth
/// sign-in for its owner. The link takes asks from the gateway peer alone (`unbrowse_net::Link`).
struct RemoteDoor {
    node: Arc<Node>,
    /// How a message through this link arrives (`arrived_via`): the gateway's host, or `public@<host>`.
    arrival: String,
    public: bool,
}

impl unbrowse_net::Mcp for RemoteDoor {
    fn answer(&self, _from: unbrowse_net::PeerId, ask: unbrowse_net::McpAsk) -> futures_util::future::BoxFuture<'static, unbrowse_net::McpAnswer> {
        let (node, arrival, public) = (self.node.clone(), self.arrival.clone(), self.public);
        Box::pin(async move {
            match (ask.method.as_str(), ask.target.as_str()) {
                ("POST", "/mcp") => mcp_ask(node, arrival, public, ask.headers, ask.body).await,
                // The gateway asks what this node links as: a public peer it may hand anyone's calls, or an owner's own.
                ("POST", "/remote/role") => json_answer(200, json!({ "role": if public { "public" } else { "own" } })),
                ("POST", "/remote/authorize") if !public => {
                    let said: Value = serde_json::from_slice(&ask.body).unwrap_or(Value::Null);
                    let client = said["client"].as_str().unwrap_or("An MCP client").chars().take(80).collect::<String>();
                    let from = said["redirect_host"].as_str().unwrap_or("").chars().take(120).collect::<String>();
                    match sign_in(node, arrival, client, from).await {
                        Ok(token) => json_answer(200, json!({ "token": token })),
                        Err(why) => json_answer(403, json!({ "why": why })),
                    }
                }
                _ => unbrowse_net::McpAnswer::refused(404, "no such door through the gateway"),
            }
        })
    }
}

fn json_answer(status: u16, v: Value) -> unbrowse_net::McpAnswer {
    unbrowse_net::McpAnswer { status, headers: vec![("content-type".into(), "application/json".into())], body: v.to_string().into_bytes() }
}

/// One MCP message from the gateway peer, answered by the node's own MCP handler: as the node's public key on a public
/// peer, else only with a remote key made for this gateway.
async fn mcp_ask(node: Arc<Node>, arrival: String, public: bool, asked: Vec<(String, String)>, body: Vec<u8>) -> unbrowse_net::McpAnswer {
    let mut headers = HeaderMap::new();
    for (k, v) in &asked {
        let k = k.to_ascii_lowercase();
        if PASSED.contains(&k.as_str()) {
            if let (Ok(name), Ok(value)) = (axum::http::HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                headers.insert(name, value);
            }
        }
    }
    // An ask carries one answer: the handler answers in JSON, never as an event stream.
    headers.insert("accept", HeaderValue::from_static("application/json"));
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return json_answer(400, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "the request isn't JSON" } }));
    };
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    // A public peer answers anyone: each message runs as the node's own public key, whose cap bounds what it spends
    // for all of them. A gateway never hands a public peer a caller's key, and one that did is ignored.
    if public {
        // Checked on every message, not only when it linked: a sign-in kept here since would be every caller's.
        let held = credentials_held();
        if !held.is_empty() {
            return json_answer(503, json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32003, "message": format!("this public peer's home holds {}: it answers no one until they are gone", held.join(", ")) } }));
        }
        headers.remove("authorization");
        match public_token(&node, &arrival).and_then(|t| HeaderValue::from_str(&format!("Bearer {t}")).ok()) {
            Some(v) => {
                headers.insert("authorization", v);
            }
            None => return json_answer(503, json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32003, "message": "this public peer has no key to call with: on its machine, run `unbrowse-node remote public` again" } })),
        }
    }
    // Every message through the gateway needs a remote key made for it, not only tool calls: a caller without one
    // learns nothing of this node. The tools check it again where they're called (`api::agent`).
    let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::trim).unwrap_or_default().to_string();
    let Some(agent) = (!token.is_empty()).then(|| agents::by_gateway_token(node.keys.as_ref(), &token, &arrival)).flatten() else {
        return json_answer(401, json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32001, "message": NOT_THIS_GATEWAY } }));
    };
    if msg.get("method").and_then(Value::as_str) == Some("tools/call") {
        let tool = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("a tool");
        store::log_activity(&store::Activity {
            at: store::now(),
            who: if public { "A public caller".into() } else { agent.name.clone() },
            site: format!("Remote, through {}", arrival.trim_start_matches("public@")),
            what: format!("Called {tool} through the gateway"),
            kind: "call".into(),
            result: "done".into(),
            ms: None,
            unb: None,
            tx: None,
            note: None,
        });
    }
    let answered = ARRIVED.scope(arrival, crate::api::mcp_for_remote(node, headers, msg)).await;
    let status = answered.status().as_u16();
    let mut out = vec![];
    for k in RETURNED {
        if let Some(v) = answered.headers().get(k).and_then(|v| v.to_str().ok()) {
            out.push((k.to_string(), v.to_string()));
        }
    }
    match axum::body::to_bytes(answered.into_body(), unbrowse_net::MAX_MCP_ANSWER_BYTES).await {
        Ok(body) => unbrowse_net::McpAnswer { status, headers: out, body: body.to_vec() },
        Err(_) => unbrowse_net::McpAnswer::refused(502, "the node's answer is larger than an ask carries"),
    }
}

/// How long after the owner turns the remote on, makes a key or runs `unbrowse-node remote sign-in` a sign-in through
/// the gateway may ask them: long enough to add the URL to an app and connect it.
pub const SIGN_IN_OPEN: Duration = Duration::from_secs(600);
/// What a sign-in hears when the owner isn't expecting one.
pub(crate) const NOT_EXPECTING_SIGN_IN: &str = "this node isn't expecting a sign-in: on its machine, run `unbrowse-node remote sign-in` (or turn the remote on in its window), then connect the app again within 10 minutes";
/// The most sign-ins that ask the owner each time the owner opens sign-ins.
const SIGN_INS_PER_OPENING: usize = 5;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Lets a sign-in through the gateway ask the owner for the next `SIGN_IN_OPEN`, until one is allowed. Only the owner
/// opens it: from their shell, their window or their token.
pub fn expect_sign_in() -> Result<(), String> {
    let mut r = Remote::load();
    if r.public {
        return Err("a public peer takes no sign-ins".into());
    }
    // Never the same as the last opening's, so a new opening starts with every ask.
    r.sign_in_until = (now_ms() + SIGN_IN_OPEN.as_millis() as u64).max(r.sign_in_until + 1);
    r.save()
}

/// Stops sign-ins asking the owner: one was just allowed. The next opening starts with every ask.
fn sign_ins_done() {
    *SIGN_INS.lock().unwrap_or_else(|p| p.into_inner()) = (0, 0, false);
    let mut r = Remote::load();
    if r.sign_in_until != 0 {
        r.sign_in_until = 0;
        let _ = r.save();
    }
}

/// The sign-ins that asked the owner since they last opened sign-ins (which opening, how many), and whether one is
/// being asked now.
static SIGN_INS: std::sync::Mutex<(u64, usize, bool)> = std::sync::Mutex::new((0, 0, false));

/// Whether a sign-in may ask the owner now: only while they expect one (`expect_sign_in`), one at a time, and at most
/// `SIGN_INS_PER_OPENING` for each time they open sign-ins. A sign-in at any other time is refused before it counts, so
/// nobody but the owner spends what the owner's own sign-in needs. When it may, it is counted and holds the one place.
fn sign_in_may_ask(open_until: u64, now: u64) -> Result<(), String> {
    if open_until <= now {
        return Err(NOT_EXPECTING_SIGN_IN.into());
    }
    let mut s = SIGN_INS.lock().unwrap_or_else(|p| p.into_inner());
    if s.0 != open_until {
        *s = (open_until, 0, s.2);
    }
    if s.2 {
        return Err("the owner is being asked about another sign-in: try again in a minute".into());
    }
    if s.1 >= SIGN_INS_PER_OPENING {
        return Err("too many sign-ins asked of this node since its owner opened sign-ins: on its machine, run `unbrowse-node remote sign-in` again".into());
    }
    s.1 += 1;
    s.2 = true;
    Ok(())
}

/// What the owner is asked about a sign-in: the app's name and return address are said as what the app chose, which
/// nothing checks, so the owner decides by whether they started it.
fn sign_in_question(host: &str, client: &str, from: &str) -> String {
    let client = crate::owner_dialog::plain(client);
    let from = crate::owner_dialog::plain(from);
    let from = if from.trim().is_empty() { "an address it didn't say".to_string() } else { from };
    format!(
        "Did you just connect an app to this Unbrowse node? A sign-in through {host} is asking to use it from anywhere, browser and logins included, spending up to {KEY_CAP_USDC} USDC a day, for {KEY_DAYS} days. The app calls itself \"{client}\" and returns to {from}: it chose both itself, and Unbrowse can't check them. Allow it only if you started this sign-in yourself, just now; if you didn't, say no."
    )
}

/// An OAuth sign-in the gateway peer handed over: the owner is asked in the node's own dialog, which nothing over the
/// network answers, and only while they expect a sign-in; on a yes the node makes a remote key for this gateway, named
/// for the app: the grant. Then sign-ins stop asking until the owner opens them again.
async fn sign_in(node: Arc<Node>, host: String, client: String, from: String) -> Result<String, String> {
    sign_in_may_ask(Remote::load().sign_in_until, now_ms())?;
    let question = sign_in_question(&host, &client, &from);
    let asked = crate::owner_dialog::ask(Some(node.keys.as_ref()), question).await;
    SIGN_INS.lock().unwrap_or_else(|p| p.into_inner()).2 = false;
    asked?;
    sign_ins_done();
    let (_, token) = make_remote_key(node.keys.as_ref(), &format!("Signed in: {}", crate::owner_dialog::plain(&client)))?;
    Ok(token)
}

/// The token of this public peer's own key for `arrival` (`public@<host>`), made when it was turned on.
fn public_token(node: &Node, arrival: &str) -> Option<String> {
    let root = unbrowse_core::RootKey::load(node.keys.as_ref()).ok()?;
    live_keys(arrival).first().map(|a| agents::token_of(&root, a))
}

/// Whether the message being answered came to a public peer: only the calling tools, and no browser.
pub(crate) fn arrived_public() -> bool {
    arrived_via().is_some_and(|g| g.starts_with("public@"))
}

/// The remote as the owner's window and API read it (`Remote` in agent-api.json): on or off, the gateway, this node's
/// URL there, and the remote keys made for it, live ones only.
pub fn status() -> Value {
    let r = Remote::load();
    let keys = r.arrival().map(|a| live_keys(&a)).unwrap_or_default();
    json!({
        "on": r.on,
        "public": r.public,
        "gateway": if r.gateway.is_empty() { DEFAULT_GATEWAY.to_string() } else { r.gateway.clone() },
        "url": r.url(),
        "account_link": r.account_link(),
        "peer": r.peer(),
        "keys": keys,
    })
}

/// Turns this node's own remote on or off from the window or the API, at `gateway` (the one it had, else
/// `DEFAULT_GATEWAY`). Never makes a public peer: that is a home of its own, set up from its shell.
pub fn set(on: bool, gateway: Option<&str>) -> Result<Value, String> {
    if on {
        let had = Remote::load().gateway;
        let g = gateway.map(str::to_string).filter(|g| !g.trim().is_empty()).unwrap_or(if had.is_empty() { DEFAULT_GATEWAY.into() } else { had });
        turn_on_as(&g, false)?;
        // The owner turned it on to connect an app: its sign-in may ask them for a while.
        expect_sign_in()?;
    } else {
        turn_off()?;
    }
    Ok(status())
}

/// The Claude Code line for this node's URL: it signs in through the node (OAuth), so no key is on the command line,
/// in the shell's history or in Claude Code's config.
pub fn claude_line(url: &str) -> String {
    format!("claude mcp add --transport http unbrowse-remote {url}")
}

/// A remote key for the gateway the remote is on, with its token.
fn make_remote_key(keys: &dyn unbrowse_core::KeyStore, name: &str) -> Result<(agents::Agent, String), String> {
    let r = Remote::load();
    if r.public {
        return Err("a public peer takes no remote keys: it answers anyone, as its own key".into());
    }
    let host = r.host().ok_or("turn the remote on first")?;
    let name = if name.trim().is_empty() { "Remote agents" } else { name.trim() };
    agents::create_for_gateway(keys, name, KEY_CAP_USDC, KEY_DAYS, &host)
}

/// A new remote key for the gateway, with its token, shown once, for an MCP client to keep in its own settings, and
/// the Claude Code line, which signs in instead and carries no key (`NewRemoteKey` in agent-api.json). The owner is
/// setting a client up: a sign-in may ask them for the next `SIGN_IN_OPEN`.
pub fn new_key(keys: &dyn unbrowse_core::KeyStore, name: &str) -> Result<Value, String> {
    let url = Remote::load().url().ok_or("turn the remote on first")?;
    let (agent, token) = make_remote_key(keys, name)?;
    expect_sign_in()?;
    Ok(json!({ "agent": agent, "token": token, "url": url, "claude": claude_line(&url) }))
}

/// Revokes every remote key for the gateway; answers the remote as it stands then.
pub fn revoke_all() -> Result<Value, String> {
    let arrival = Remote::load().arrival().unwrap_or_default();
    for a in live_keys(&arrival) {
        agents::revoke(a.index)?;
    }
    Ok(status())
}

/// `unbrowse-node remote …`: this node's own remote MCP URL.
///
///   unbrowse-node remote                    on or off, and the URL
///   unbrowse-node remote on [<gateway>]     attach to the gateway (https://unbrowse.ai unless named), print the Claude
///                                           Code line, and let an app sign in for the next 10 minutes
///   unbrowse-node remote off                stop attaching; the URL stays this node's for when it is turned on again
///   unbrowse-node remote sign-in            let an app sign in through the gateway for the next 10 minutes
///   unbrowse-node remote key [<name>]       a new remote key for the gateway, shown once, for a client that can't sign in
///   unbrowse-node remote revoke             revoke every remote key for the gateway
///   unbrowse-node remote peer               whether this node takes MCP over the peer network (`unb mcp --peer`)
///   unbrowse-node remote peer key [<name>]  a key that opens it over the peer network, shown once: until there is one,
///                                           the node takes no MCP over the peer network
///   unbrowse-node remote peer off           revoke every key for the peer network: it takes none again
///   unbrowse-node remote public [<gateway>] make this node a public peer of the gateway: calls only, for anyone, in a
///                                           home with no login, card or passkey (run it under its own UNBROWSE_HOME)
pub(crate) fn cli(args: &[String]) -> i32 {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        [] => {
            let r = Remote::load();
            match (r.on, r.url()) {
                (true, Some(url)) if r.public => println!("on, public peer {}: answers anyone at {url}, calls only", r.peer().unwrap_or_default()),
                (true, Some(url)) => println!("on: this node's MCP is at {url}"),
                (false, Some(url)) => println!("off: when on, this node's MCP is at {url} (`unbrowse-node remote on`)"),
                _ => println!("off: `unbrowse-node remote on` gives this node an MCP address that works from anywhere"),
            }
            0
        }
        ["on"] | ["on", _] => {
            let r = match turn_on(words.get(1).copied().unwrap_or(DEFAULT_GATEWAY)) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("{e}");
                    return 1;
                }
            };
            let url = r.url().unwrap_or_default();
            println!("on: this node's MCP is at {url}");
            println!("The running node attaches within a few seconds; it needs to be running for the address to answer.");
            sign_in_cli(&url)
        }
        ["sign-in"] => {
            let r = Remote::load();
            match (r.on, r.url()) {
                (true, Some(url)) if !r.public => sign_in_cli(&url),
                _ => {
                    eprintln!("turn the remote on first: `unbrowse-node remote on`");
                    1
                }
            }
        }
        ["peer"] => {
            let keys = peer_keys();
            if keys.is_empty() {
                println!("off: this node takes no MCP over the peer network. `unbrowse-node remote peer key` makes a key that opens it");
            } else {
                println!("on: {} key{} open this node over the peer network (`unbrowse-node remote peer off` revokes them)", keys.len(), if keys.len() == 1 { "" } else { "s" });
                for a in &keys {
                    println!("  {} (number {})", a.name, a.index);
                }
            }
            0
        }
        ["peer", "key"] | ["peer", "key", _] => make_peer_key(words.get(2).copied().unwrap_or("Peer agents")),
        ["peer", "off"] => {
            let keys = peer_keys();
            for a in &keys {
                if let Err(e) = agents::revoke(a.index) {
                    eprintln!("couldn't revoke {}: {e}", a.name);
                    return 1;
                }
            }
            println!("off: revoked {} key{} for the peer network; the node takes no MCP over it now", keys.len(), if keys.len() == 1 { "" } else { "s" });
            0
        }
        ["public"] | ["public", _] => public_cli(words.get(1).copied().unwrap_or(DEFAULT_GATEWAY)),
        ["off"] => match turn_off() {
            Ok(r) => {
                println!("off: the node stops attaching to {} within a few seconds; its remote keys stay, and open nothing while it's off", r.gateway);
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        ["key"] | ["key", _] => {
            let r = Remote::load();
            if r.url().is_none() {
                eprintln!("turn the remote on first: `unbrowse-node remote on`");
                return 1;
            }
            make_key(&r, words.get(1).copied().unwrap_or("Remote agents"))
        }
        ["revoke"] => {
            let before = status()["keys"].as_array().map(Vec::len).unwrap_or(0);
            match revoke_all() {
                Ok(_) => {
                    println!("revoked {before} remote key{}", if before == 1 { "" } else { "s" });
                    0
                }
                Err(e) => {
                    eprintln!("couldn't revoke: {e}");
                    1
                }
            }
        }
        _ => {
            eprintln!("usage: unbrowse-node remote [on [<gateway>]|public [<gateway>]|off|sign-in|key [<name>]|revoke|peer [key [<name>]|off]]");
            2
        }
    }
}

/// `remote public`: this node becomes a public peer of the gateway. It refuses a home that holds a credential, turns
/// the browser off for good here (headless, never fetched), and makes the node's own public key, capped at what it
/// may spend a day for all of its callers.
fn public_cli(gateway: &str) -> i32 {
    let held = credentials_held();
    if !held.is_empty() {
        eprintln!("this home holds {}: a public peer holds no one's credential. Run it in a home of its own: UNBROWSE_HOME=<empty folder> unbrowse-node remote public", held.join(", "));
        return 1;
    }
    {
        let _held = store::settings_held();
        let mut s = store::load_settings();
        s.headless_only = true;
        s.fetch_browser = false;
        s.shared_mint = false;
        if let Err(e) = store::save_settings(&s) {
            eprintln!("couldn't save the settings: {e}");
            return 1;
        }
    }
    let r = match turn_on_as(gateway, true) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let arrival = r.arrival().unwrap_or_default();
    if live_keys(&arrival).is_empty() {
        let keys = match crate::root_store() {
            Ok(k) => k,
            Err(e) => {
                eprintln!("couldn't read the node's root key: {e}");
                return 1;
            }
        };
        // A home the node has never run in has no root key yet: make it as the node does at its first start.
        if let Err(e) = unbrowse_core::load_or_create(keys.as_ref()) {
            eprintln!("couldn't make the node's root key: {e}");
            return 1;
        }
        // The key stays inside the node: no token is handed out, so nothing is asked.
        if let Err(e) = agents::create_for_gateway(keys.as_ref(), "Public callers", PUBLIC_SPEND_PER_DAY_USDC, 3650, &arrival) {
            eprintln!("couldn't make the public key: {e}");
            return 1;
        }
    }
    println!("public peer {}: once the gateway names it, it answers anyone at {}, calls only", r.peer().unwrap_or_default(), r.url().unwrap_or_default());
    println!("It spends at most {PUBLIC_SPEND_PER_DAY_USDC} USDC a day for all of its callers, never opens a browser, and reads no one's browser for a session.");
    println!("The gateway takes it once its peer ID is in the gateway's PUBLIC_PEERS.");
    0
}

fn live_keys(host: &str) -> Vec<agents::Agent> {
    let now = store::now();
    agents::list().into_iter().filter(|a| !a.revoked && a.expires > now && a.gateway.as_deref() == Some(host)).collect()
}

/// Makes a remote key for the gateway, asking the owner first as any key that leaves the keystore is asked about, and
/// prints it once with how an agent uses it.
fn make_key(r: &Remote, name: &str) -> i32 {
    let (host, url) = (r.host().unwrap_or_default(), r.url().unwrap_or_default());
    let keys = match crate::root_store() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("couldn't read the node's root key: {e}");
            return 1;
        }
    };
    let question = format!(
        "Make a remote key, \"{name}\", that lets an agent use this node from anywhere through {host}, browser and logins included, spending up to {KEY_CAP_USDC} USDC a day, for {KEY_DAYS} days? Allow it only if you are setting that agent up just now."
    );
    if let Err(e) = unbrowse_core::load_or_create(keys.as_ref()) {
        eprintln!("couldn't make the node's root key: {e}");
        return 1;
    }
    if let Err(e) = crate::shell_owner_yes(keys.as_ref(), crate::root_in_file(), &question) {
        eprintln!("{e}");
        return 1;
    }
    match new_key(keys.as_ref(), name) {
        Ok(made) => {
            let token = made["token"].as_str().unwrap_or_default();
            println!();
            println!("Remote key \"{}\" (number {}), shown once:", made["agent"]["name"].as_str().unwrap_or_default(), made["agent"]["index"]);
            println!("  {token}");
            println!();
            println!("Give it to an MCP client that can't sign in: {url}, with this key as its bearer token, kept in the client's own");
            println!("settings for the server. Never put it on a command line, where the shell's history keeps it.");
            println!();
            println!("Claude Code signs in instead, with no key (for the next 10 minutes, then `unbrowse-node remote sign-in`):");
            println!("  {}", made["claude"].as_str().unwrap_or_default());
            println!();
            println!("Whoever has this key can use this node through {host}, within {KEY_CAP_USDC} USDC a day, until it expires in {KEY_DAYS} days or you run `unbrowse-node remote revoke`.");
            0
        }
        Err(e) => {
            eprintln!("couldn't make the key: {e}");
            1
        }
    }
}

/// Lets an app sign in for the next `SIGN_IN_OPEN`, and says how: the Claude Code line, which carries no key.
fn sign_in_cli(url: &str) -> i32 {
    if let Err(e) = expect_sign_in() {
        eprintln!("{e}");
        return 1;
    }
    println!();
    println!("For the next {} minutes an app may sign in: you are asked on this machine, and say yes only to an app you are", SIGN_IN_OPEN.as_secs() / 60);
    println!("connecting yourself. Claude Code:");
    println!("  {}", claude_line(url));
    println!("Another MCP client: give it {url}; if it can't sign in, `unbrowse-node remote key` makes a key for it.");
    if let Some(link) = Remote::load().account_link() {
        println!("Apps signed in to Unbrowse as you (claude.ai, ChatGPT): link this node to your account, then say yes here:");
        println!("  {link}");
    }
    0
}

/// Makes a key that opens this node over the peer network, asking the owner first as any key that leaves the keystore
/// is asked about, and prints it once with how `unb mcp --peer` on another machine uses it: never on a command line.
fn make_peer_key(name: &str) -> i32 {
    let keys = match crate::root_store() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("couldn't read the node's root key: {e}");
            return 1;
        }
    };
    let question = format!(
        "Make a peer key, \"{name}\", that lets an agent on another machine use this node over the peer network, browser and logins included, spending up to {KEY_CAP_USDC} USDC a day, for {KEY_DAYS} days? Until there is one, this node takes no MCP over the peer network. Allow it only if you are setting that agent up just now."
    );
    if let Err(e) = unbrowse_core::load_or_create(keys.as_ref()) {
        eprintln!("couldn't make the node's root key: {e}");
        return 1;
    }
    if let Err(e) = crate::shell_owner_yes(keys.as_ref(), crate::root_in_file(), &question) {
        eprintln!("{e}");
        return 1;
    }
    match agents::create_for_gateway(keys.as_ref(), name, KEY_CAP_USDC, KEY_DAYS, PEER_NETWORK) {
        Ok((agent, token)) => {
            let (peer, addrs) = crate::peers::dial_addresses();
            println!();
            println!("Peer key \"{}\" (number {}), shown once:", agent.name, agent.index);
            println!("  {token}");
            println!();
            println!("On the other machine, the agent host runs this MCP server, with UNBROWSE_AGENT_TOKEN set to the key in the");
            println!("host's own settings for the server, never on a command line, where the shell's history keeps it:");
            match peer {
                Some(peer) => println!("  unb mcp --peer {peer}{}", addrs.iter().map(|a| format!(" --addr {a}")).collect::<String>()),
                None => println!("  unb mcp --peer <peer id> --addr <address>   (`unbrowse-node network addrs` once the node has joined the network)"),
            }
            println!();
            println!("Whoever has this key can use this node over the peer network, within {KEY_CAP_USDC} USDC a day, until it expires in {KEY_DAYS} days or you run `unbrowse-node remote peer off`.");
            0
        }
        Err(e) => {
            eprintln!("couldn't make the key: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node_for_test() -> Arc<Node> {
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

    fn ask(target: &str, key: Option<&str>, msg: Value) -> unbrowse_net::McpAsk {
        let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
        if let Some(k) = key {
            headers.push(("authorization".into(), format!("Bearer {k}")));
        }
        unbrowse_net::McpAsk { method: "POST".into(), target: target.into(), headers, body: msg.to_string().into_bytes() }
    }

    fn said(a: &unbrowse_net::McpAnswer) -> Value {
        serde_json::from_slice(&a.body).unwrap_or(Value::Null)
    }

    fn tool_names(a: &unbrowse_net::McpAnswer) -> Vec<String> {
        said(a)["result"]["tools"].as_array().map(|t| t.iter().filter_map(|t| t["name"].as_str().map(String::from)).collect()).unwrap_or_default()
    }

    #[test]
    fn a_gateway_is_named_by_its_host() {
        assert_eq!(host_of("https://unbrowse.ai").as_deref(), Some("unbrowse.ai"));
        assert_eq!(host_of("https://Unbrowse.AI/").as_deref(), Some("unbrowse.ai"));
        assert_eq!(host_of("http://127.0.0.1:8787").as_deref(), Some("127.0.0.1:8787"));
        assert_eq!(host_of("ftp://unbrowse.ai"), None);
    }

    /// The URL is the node's: turned on, it takes the key the node has on the peer network, so the remote peer ID is
    /// the network's; turned off and on, the URL stays; a new gateway is asked who it is anew.
    #[test]
    fn the_url_names_the_nodes_own_peer_id_and_stays_across_off_and_on() {
        let _home = store::scratch_home("remote-url");
        let k = Keypair::generate_ed25519();
        let saved = json!({ "identity": "x", "anchor": "", "index": 0, "bits": 16, "key": hex::encode(k.to_protobuf_encoding().unwrap()) });
        std::fs::write(store::home().join("peer-key.json"), saved.to_string()).unwrap();
        let r = turn_on("https://unbrowse.ai/").unwrap();
        assert_eq!(r.peer(), Some(k.public().to_peer_id().to_string()));
        assert_eq!(r.url(), Some(format!("https://unbrowse.ai/p/{}/mcp", k.public().to_peer_id())));
        assert_eq!(r.account_link(), Some(format!("https://unbrowse.ai/link/#own={}", k.public().to_peer_id())), "the account link names the same node at the same gateway");
        assert_eq!(Remote { public: true, ..r.clone() }.account_link(), None, "a public peer is no one's to link");
        let mut pinned = Remote::load();
        pinned.gateway_peer = "12D3KooWgateway".into();
        pinned.save().unwrap();
        assert!(!turn_off().unwrap().on);
        let again = turn_on("https://unbrowse.ai").unwrap();
        assert_eq!(again.url(), r.url());
        assert_eq!(again.gateway_peer, "12D3KooWgateway", "the same gateway keeps its peer");
        assert_eq!(turn_on("https://elsewhere.example").unwrap().gateway_peer, "", "another gateway is asked anew");
        assert!(turn_on("unbrowse.ai").is_err(), "a gateway is an https address");
    }

    /// A remote key opens the node only on a message that came through its own gateway; every other key, only at the
    /// node's own door.
    #[test]
    fn a_remote_key_opens_the_node_only_through_its_gateway() {
        let _home = store::scratch_home("remote-keys");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let (local, _) = agents::create(&keys, "local", 1.0, 30, 7788).unwrap();
        let local_token = agents::token_of(&unbrowse_core::RootKey::load(&keys).unwrap(), &local);
        let (_, remote) = agents::create_for_gateway(&keys, "remote", 1.0, 30, "unbrowse.ai").unwrap();
        assert!(agents::by_token(&keys, &remote).is_none(), "a remote key never opens the door");
        assert!(agents::by_gateway_token(&keys, &remote, "unbrowse.ai").is_some());
        assert!(agents::by_gateway_token(&keys, &remote, "elsewhere.example").is_none(), "nor another gateway");
        assert!(agents::by_gateway_token(&keys, &local_token, "unbrowse.ai").is_none(), "a door key never opens the gateway path");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (inside, spawned) = rt.block_on(ARRIVED.scope("unbrowse.ai".into(), async {
            let inside = arrived_via();
            let spawned = tokio::spawn(keep_arrival(async { arrived_via() })).await.unwrap();
            (inside, spawned)
        }));
        assert_eq!(inside.as_deref(), Some("unbrowse.ai"));
        assert_eq!(spawned.as_deref(), Some("unbrowse.ai"), "a task spawned to answer the message keeps how it arrived");
    }

    /// The gateway peer's asks to an owner's node: its own MCP handler answers one with a remote key for this gateway,
    /// and refuses one with a door key or none; a sign-in asks the owner, and a yes is a key for the gateway.
    #[test]
    fn the_door_answers_the_gateway_peer_with_a_remote_key_only() {
        let home = store::scratch_home("remote-door");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let node = node_for_test();
        turn_on("https://unbrowse.ai").unwrap();
        let (_, remote) = agents::create_for_gateway(node.keys.as_ref(), "remote", 1.0, 30, "unbrowse.ai").unwrap();
        let (local, _) = agents::create(node.keys.as_ref(), "local", 1.0, 30, 7788).unwrap();
        let local_token = agents::token_of(&unbrowse_core::RootKey::load(node.keys.as_ref()).unwrap(), &local);
        let door = RemoteDoor { node: node.clone(), arrival: "unbrowse.ai".into(), public: false };
        let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
        let ok = rt.block_on(unbrowse_net::Mcp::answer(&door, unbrowse_net::PeerId::random(), ask("/mcp", Some(&remote), list.clone())));
        assert_eq!(ok.status, 200, "{}", String::from_utf8_lossy(&ok.body));
        assert!(tool_names(&ok).iter().any(|n| n == "unbrowse_browse"), "an owner's own node offers everything: {:?}", tool_names(&ok));
        let door_key = rt.block_on(unbrowse_net::Mcp::answer(&door, unbrowse_net::PeerId::random(), ask("/mcp", Some(&local_token), list.clone())));
        assert_eq!(door_key.status, 401);
        assert!(said(&door_key)["error"]["message"].as_str().unwrap().contains("doesn't open this node through this gateway"));
        let none = rt.block_on(unbrowse_net::Mcp::answer(&door, unbrowse_net::PeerId::random(), ask("/mcp", None, list.clone())));
        assert_eq!(none.status, 401);
        let elsewhere = rt.block_on(unbrowse_net::Mcp::answer(&door, unbrowse_net::PeerId::random(), ask("/owner/settings", Some(&remote), list)));
        assert_eq!(elsewhere.status, 404, "the gateway reaches /mcp and the sign-in, nothing else");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// An OAuth sign-in: refused at once, with no dialog and nothing counted, unless the owner expects one; while they
    /// do, the owner is asked in the node's own dialog, which says the app's name and return address are the app's own
    /// word; a yes is a remote key for the gateway, named for the app, that opens the node through it, and stops
    /// sign-ins asking; a no is a denial with no key; and past a few asks in one opening the node refuses without asking.
    #[test]
    fn a_sign_in_asks_the_owner_only_while_they_expect_one_and_a_yes_is_a_key_for_the_gateway() {
        let _home = store::scratch_home("remote-sign-in");
        let node = node_for_test();
        turn_on("https://unbrowse.ai").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let run = |yes: bool| {
            crate::owner_dialog::answer_in_test(Some(yes));
            rt.block_on(sign_in(node.clone(), "unbrowse.ai".into(), "Claude".into(), "claude.ai".into()))
        };
        let asks = || crate::owner_dialog::asked_in_test().len();

        // Not expected: refused without a dialog, however often a stranger tries.
        let before = asks();
        for _ in 0..10 {
            assert_eq!(run(true).unwrap_err(), NOT_EXPECTING_SIGN_IN);
        }
        assert_eq!(asks(), before, "the owner isn't asked");

        expect_sign_in().unwrap();
        assert!(Remote::load().expects_sign_in());
        let token = run(true).expect("a yes is a key");
        let made = agents::by_gateway_token(node.keys.as_ref(), &token, "unbrowse.ai").expect("a key for the gateway");
        assert_eq!(made.name, "Signed in: Claude");
        assert!(agents::by_token(node.keys.as_ref(), &token).is_none(), "never a key for the door");
        let asked = crate::owner_dialog::asked_in_test();
        let q = asked.last().unwrap();
        assert!(q.contains("calls itself \"Claude\"") && q.contains("claude.ai") && q.contains("chose both itself"), "{q}");
        assert!(q.contains("started this sign-in yourself"), "{q}");
        // A yes closes sign-ins: the next one isn't asked.
        assert!(!Remote::load().expects_sign_in());
        let before = asks();
        assert_eq!(run(true).unwrap_err(), NOT_EXPECTING_SIGN_IN);
        assert_eq!(asks(), before);

        // Opened again: a no is no key; five asks in one opening at most.
        expect_sign_in().unwrap();
        assert!(run(false).is_err(), "a no is no key");
        for _ in 0..4 {
            let _ = run(false);
        }
        let before = asks();
        assert!(run(true).unwrap_err().contains("too many"), "past five asks in one opening");
        assert_eq!(asks(), before, "and the owner isn't asked");
        // The owner opening sign-ins again starts afresh.
        expect_sign_in().unwrap();
        assert!(run(true).is_ok());
    }

    /// Turning the remote on or making a key is the owner setting a client up: a sign-in may ask them then. The key's
    /// Claude Code line carries no key: it signs in.
    #[test]
    fn a_remote_keys_claude_line_carries_no_key() {
        let _home = store::scratch_home("remote-claude-line");
        let node = node_for_test();
        set(true, None).unwrap();
        assert!(Remote::load().expects_sign_in(), "turning it on opens sign-ins");
        sign_ins_done();
        let made = new_key(node.keys.as_ref(), "laptop").unwrap();
        let token = made["token"].as_str().unwrap();
        let claude = made["claude"].as_str().unwrap();
        assert!(!token.is_empty());
        assert!(!claude.contains(token) && !claude.contains("Bearer") && !claude.contains("--header"), "{claude}");
        assert_eq!(claude, format!("claude mcp add --transport http unbrowse-remote {}", made["url"].as_str().unwrap()));
        assert!(Remote::load().expects_sign_in(), "making a key opens sign-ins");
        // Opening sign-ins doesn't link again.
        let r = Remote::load();
        assert_eq!(r.linked(), Remote { sign_in_until: 0, ..r.clone() });
    }

    /// A public peer holds no one's sign-in: a session jar or a browser profile in its home counts as one, as a saved
    /// login does, so `remote public` refuses the home and a linked public peer answers no one while it holds one.
    /// Its own calls keep their cookies apart from the owner's jars, and it has no browser.
    #[test]
    fn a_public_peer_counts_sessions_and_profiles_as_credentials() {
        let home = store::scratch_home("remote-public-jars");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let jar = store::owner_jars_dir().join("shop.example.com.json");
        std::fs::create_dir_all(store::owner_jars_dir()).unwrap();
        store::write_json(&jar, &unbrowse_files::JAR, &std::collections::BTreeMap::from([("sid", "owners-session")])).unwrap();
        assert_eq!(credentials_held(), vec!["1 signed-in session".to_string()]);
        assert_eq!(public_cli("https://unbrowse.ai"), 1, "the home holds a session");
        assert!(!public_home(), "and it isn't made a public peer");
        std::fs::remove_file(&jar).unwrap();
        std::fs::create_dir_all(store::profile_dir("shop.example.com")).unwrap();
        assert_eq!(credentials_held(), vec!["1 browser profile".to_string()]);
        std::fs::remove_dir_all(store::profiles_dir()).unwrap();
        assert!(credentials_held().is_empty());

        let node = node_for_test();
        turn_on_as("https://unbrowse.ai", true).unwrap();
        assert!(store::jars_dir().ends_with("public-jars"), "its calls' cookies are kept apart: {}", store::jars_dir().display());
        crate::browsers::for_this_test(Some("chromium".into()));
        assert_eq!(crate::browsers::current(), None, "no browser");
        crate::browsers::for_this_test(None);
        let cookies = r#"[{"name":"sid","value":"x","domain":"shop.example.com","path":"/","expirationDate":4102444800}]"#;
        assert!(crate::import::session_from("shop.example.com", cookies).unwrap_err().contains("public peer"), "it keeps no session");

        agents::create_for_gateway(node.keys.as_ref(), "Public callers", PUBLIC_SPEND_PER_DAY_USDC, 30, "public@unbrowse.ai").unwrap();
        let door = RemoteDoor { node, arrival: "public@unbrowse.ai".into(), public: true };
        let list = || rt.block_on(unbrowse_net::Mcp::answer(&door, unbrowse_net::PeerId::random(), ask("/mcp", None, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))));
        assert_eq!(list().status, 200);
        // A session lands in the owner's jars after it linked: it answers no one until it is gone.
        store::write_json(&jar, &unbrowse_files::JAR, &std::collections::BTreeMap::from([("sid", "owners-session")])).unwrap();
        let refused = list();
        assert_eq!(refused.status, 503);
        assert!(said(&refused)["error"]["message"].as_str().unwrap().contains("signed-in session"), "{}", said(&refused));
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A public peer never walks a page or tries one: either would launch a browser and leave a profile in its home,
    /// after which it answers no one (UNB-234: a page whose door wanted a browser did exactly that on staging).
    #[test]
    fn a_public_peer_never_walks_or_tries_a_page() {
        let home = store::scratch_home("remote-public-walk");
        store::use_home(&home);
        turn_on_as("https://unbrowse.ai", true).unwrap();
        assert!(public_home());
        let walked = crate::learn::walk_as(&crate::learn::Walks::default(), "https://shop.example.com/", "public-walk", "You", &crate::learn::no_eye);
        assert_eq!(walked.err().as_deref(), Some(NEEDS_OWN_NODE));
        assert!(!store::profiles_dir().exists(), "no browser profile is made");
        assert!(credentials_held().is_empty(), "so it still answers: {:?}", credentials_held());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A public peer: anyone's message runs as the node's own public key, the list holds only the calling tools, the
    /// rest is refused as needing the caller's own node, and no sign-in is taken.
    #[test]
    fn a_public_peer_answers_anyone_with_calls_only() {
        let home = store::scratch_home("remote-public");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        assert!(credentials_held().is_empty(), "a fresh home holds no credential");
        let node = node_for_test();
        let r = turn_on_as("https://unbrowse.ai", true).unwrap();
        assert!(public_home());
        assert_eq!(r.url().as_deref(), Some("https://unbrowse.ai/mcp"), "a public peer answers at the gateway's public address");
        assert!(crate::import::session("example.com").unwrap_err().contains("public peer"), "it reads no one's browser");
        agents::create_for_gateway(node.keys.as_ref(), "Public callers", PUBLIC_SPEND_PER_DAY_USDC, 30, "public@unbrowse.ai").unwrap();
        let door = RemoteDoor { node, arrival: "public@unbrowse.ai".into(), public: true };
        let listed = rt.block_on(unbrowse_net::Mcp::answer(&door, unbrowse_net::PeerId::random(), ask("/mcp", Some("someone-elses-key"), json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))));
        assert_eq!(listed.status, 200, "a caller with no key of this node's is answered: {}", String::from_utf8_lossy(&listed.body));
        let names = tool_names(&listed);
        assert!(!names.is_empty() && names.iter().all(|n| PUBLIC_TOOLS.contains(&n.as_str())), "{names:?}");
        let browse = rt.block_on(unbrowse_net::Mcp::answer(&door, unbrowse_net::PeerId::random(), ask("/mcp", None, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "unbrowse_browse", "arguments": { "do": ["open", "https://example.com"] } } }))));
        let refused: Value = serde_json::from_str(said(&browse)["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(refused["outcome"], "not_allowed", "{refused}");
        assert!(refused["why"].as_str().unwrap().contains("needs your own node"));
        let sign_in = rt.block_on(unbrowse_net::Mcp::answer(&door, unbrowse_net::PeerId::random(), ask("/remote/authorize", None, json!({ "client": "x" }))));
        assert_eq!(sign_in.status, 404, "a public peer takes no sign-ins");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The node against the real gateway peer: the Worker in `wrangler dev` (unbrowse-landing, `npx wrangler dev -c
    /// wrangler.staging.jsonc --local`), at UNBROWSE_TEST_GATEWAY. The node asks the gateway who it is, links to its
    /// peer over libp2p, and an MCP client calls this node's URL there with its remote key and gets the node's own tools;
    /// with a door key, a refusal.
    #[test]
    #[ignore = "needs the gateway Worker running: UNBROWSE_TEST_GATEWAY=http://127.0.0.1:8787"]
    fn an_mcp_client_reaches_the_node_through_the_real_gateway_peer() {
        let Ok(gateway) = std::env::var("UNBROWSE_TEST_GATEWAY") else { return };
        let home = store::scratch_home("remote-real-gateway");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let node = node_for_test();
        let (local, _) = agents::create(node.keys.as_ref(), "local", 1.0, 30, 7788).unwrap();
        let local_token = agents::token_of(&unbrowse_core::RootKey::load(node.keys.as_ref()).unwrap(), &local);
        rt.block_on(async move {
            let r = turn_on(&gateway).unwrap();
            let (_, token) = agents::create_for_gateway(node.keys.as_ref(), "remote", 1.0, 30, &r.host().unwrap()).unwrap();
            let (n, linked) = (node.clone(), r.clone());
            tokio::spawn(async move {
                let e = link_once(n, &linked).await;
                eprintln!("link ended: {e:?}");
            });
            let url = r.url().unwrap();
            let ask = |token: String, url: String| async move {
                reqwest::Client::new()
                    .post(url)
                    .header("authorization", format!("Bearer {token}"))
                    .header("accept", "application/json, text/event-stream")
                    .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
                    .send()
                    .await
                    .unwrap()
            };
            let mut listed = Value::Null;
            for _ in 0..75 {
                let r = ask(token.clone(), url.clone()).await;
                if r.status() == 200 {
                    listed = r.json().await.unwrap();
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            assert!(listed["result"]["tools"].as_array().is_some_and(|t| t.iter().any(|t| t["name"] == "unbrowse_do")), "{listed}");
            let refused = ask(local_token, url).await;
            assert_eq!(refused.status(), 401);
            eprintln!("REMOTE_REAL_GATEWAY_PEER_OK {} via peer {}", r.url().unwrap(), Remote::load().gateway_peer);
        });
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    }
}
