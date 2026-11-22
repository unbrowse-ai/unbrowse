//! The browser's debugger on a pipe, and the one door to it.
//!
//! A debugger on a TCP port answers any local process of any OS user: Chrome has no authentication of its own, and it
//! checks a WebSocket's Origin only when one is sent. So a launched Chrome gets `--remote-debugging-pipe` and opens no
//! port at all: it reads commands on fd 3 and answers on fd 4, which only the process that launched it holds.
//!
//! The launcher is rarely the only client (the daemon, the node's walk and the window's picture each connect), so the
//! pipe is served through a relay in the launching process. The relay listens on loopback, but it answers a WebSocket
//! only at a path carrying a secret drawn at launch (256 bits, compared in constant time), refuses any request that
//! names an Origin (a web page), and serves nothing else: no `/json`, no frontend. The secret goes only to the
//! launcher's own callers and into owner-only files. Each client gets its own browser session on the pipe
//! (`Target.attachToBrowserTarget`), so its ids, its events and the sessions it attaches are its own, as on a
//! connection of its own, and a client can't reach another's sessions.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

/// Where a relay's WebSocket path starts; the secret follows. Chrome's own shape, so tools that read a browser
/// endpoint's path as `/devtools/browser/<id>` still do.
const PATH: &str = "/devtools/browser/";

/// The id of the relay's first command, which says the browser is up: the first thing written to a new pipe.
const READY_ID: u64 = 1;

/// A fresh secret: 256 bits from the system's generator (two v4 UUIDs carry 244 random bits; a third tops them up).
fn secret() -> String {
    format!(
        "{}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    )
}

/// Byte-for-byte equality that takes as long whatever the bytes are.
pub(crate) fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether a WebSocket request may reach the browser: the exact secret path, no Origin (a web page always sends one; a
/// process driving the browser has no reason to), and the relay's own loopback address as its Host, `127.0.0.1:<port>`
/// exactly, as the address the relay hands out names it (a name made to resolve here, DNS rebinding, names another).
fn admits(path: &str, origin: Option<&str>, host: Option<&str>, secret: &str, port: u16) -> bool {
    origin.is_none()
        && host.is_some_and(|h| h.trim().eq_ignore_ascii_case(&format!("127.0.0.1:{port}")))
        && path.strip_prefix(PATH).is_some_and(|given| constant_time_eq(given, secret))
}

/// The two pipes a Chrome launched with `--remote-debugging-pipe` talks on: the ends the child gets (it reads fd 3,
/// writes fd 4) and the ends this process keeps.
pub(crate) struct Pipes {
    pub child_reads: std::io::PipeReader,
    pub child_writes: std::io::PipeWriter,
    pub to_browser: std::io::PipeWriter,
    pub from_browser: std::io::PipeReader,
}

pub(crate) fn pipes() -> std::io::Result<Pipes> {
    let (child_reads, to_browser) = std::io::pipe()?;
    let (from_browser, child_writes) = std::io::pipe()?;
    Ok(Pipes { child_reads, child_writes, to_browser, from_browser })
}

enum Pending {
    /// The relay's own first command: its answer says the browser is up.
    Ready,
    /// A client's browser session being opened.
    Attach(u64),
    /// A command whose answer nobody waits for.
    Ignore,
    /// A client's command: its own id, and whether the relay put it in the client's browser session.
    Call { client: u64, id: Value, placed: bool },
}

struct Client {
    tx: UnboundedSender<String>,
    /// The client's browser session, once the browser has opened it.
    browser: Option<String>,
    /// What the client sent before its session was open.
    queued: Vec<Value>,
}

struct Router {
    to_browser: mpsc::Sender<Vec<u8>>,
    next_id: u64,
    next_client: u64,
    clients: HashMap<u64, Client>,
    /// Every session a client holds (its browser session too), and whose it is.
    sessions: HashMap<String, u64>,
    pending: HashMap<u64, Pending>,
    ready: bool,
    closed: bool,
}

impl Router {
    fn send(&mut self, mut message: Value, pending: Pending) {
        self.next_id += 1;
        let id = self.next_id;
        message["id"] = json!(id);
        self.pending.insert(id, pending);
        let mut bytes = message.to_string().into_bytes();
        bytes.push(0);
        let _ = self.to_browser.send(bytes);
    }

    fn connect(&mut self, tx: UnboundedSender<String>) -> Option<u64> {
        if self.closed {
            return None;
        }
        self.next_client += 1;
        let client = self.next_client;
        self.clients.insert(client, Client { tx, browser: None, queued: Vec::new() });
        self.send(json!({ "method": "Target.attachToBrowserTarget" }), Pending::Attach(client));
        Some(client)
    }

    fn disconnect(&mut self, client: u64) {
        let Some(gone) = self.clients.remove(&client) else { return };
        self.sessions.retain(|_, owner| *owner != client);
        if let Some(session) = gone.browser {
            // Detaching the browser session detaches every session the client attached under it.
            self.send(
                json!({ "method": "Target.detachFromTarget", "params": { "sessionId": session } }),
                Pending::Ignore,
            );
        }
    }

    /// Whether `session` may be named by `client`: its own, or one nobody holds (the browser answers that).
    fn may_name(&self, client: u64, session: &str) -> bool {
        self.sessions.get(session).is_none_or(|owner| *owner == client)
    }

    fn outbound(&mut self, client: u64, text: &str) {
        let Ok(message) = serde_json::from_str::<Value>(text) else { return };
        if !message.is_object() || message.get("id").is_none() {
            return;
        }
        let Some(entry) = self.clients.get_mut(&client) else { return };
        if entry.browser.is_none() {
            entry.queued.push(message);
            return;
        }
        self.forward(client, message);
    }

    fn forward(&mut self, client: u64, mut message: Value) {
        let Some(browser) = self.clients.get(&client).and_then(|c| c.browser.clone()) else { return };
        let id = message["id"].clone();
        let named = message.get("sessionId").and_then(Value::as_str).map(str::to_string);
        let in_params = message.pointer("/params/sessionId").and_then(Value::as_str).map(str::to_string);
        // Another client's session is not this one's to drive or detach.
        if [&named, &in_params].into_iter().flatten().any(|s| !self.may_name(client, s)) {
            let mut refusal = json!({ "id": id, "error": { "code": -32001, "message": "Session with given id not found." } });
            if let Some(named) = named {
                refusal["sessionId"] = json!(named);
            }
            self.deliver(client, refusal);
            return;
        }
        let placed = named.is_none();
        if placed {
            message["sessionId"] = json!(browser);
        }
        self.send(message, Pending::Call { client, id, placed });
    }

    fn deliver(&mut self, client: u64, message: Value) {
        // Sessions the browser opens for a client are that client's.
        if let Some(session) = message.pointer("/result/sessionId").and_then(Value::as_str) {
            self.sessions.insert(session.to_string(), client);
        }
        match message.get("method").and_then(Value::as_str) {
            Some("Target.attachedToTarget") => {
                if let Some(session) = message.pointer("/params/sessionId").and_then(Value::as_str) {
                    self.sessions.insert(session.to_string(), client);
                }
            }
            Some("Target.detachedFromTarget") => {
                if let Some(session) = message.pointer("/params/sessionId").and_then(Value::as_str) {
                    if self.clients.get(&client).and_then(|c| c.browser.as_deref()) != Some(session) {
                        self.sessions.remove(session);
                    }
                }
            }
            _ => {}
        }
        if let Some(entry) = self.clients.get(&client) {
            let _ = entry.tx.send(message.to_string());
        }
    }

    fn inbound(&mut self, mut message: Value) {
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            match self.pending.remove(&id) {
                Some(Pending::Ready) => self.ready = true,
                Some(Pending::Attach(client)) => {
                    let session = message.pointer("/result/sessionId").and_then(Value::as_str).map(str::to_string);
                    match (session, self.clients.get_mut(&client)) {
                        (Some(session), Some(entry)) => {
                            entry.browser = Some(session.clone());
                            let queued = std::mem::take(&mut entry.queued);
                            self.sessions.insert(session, client);
                            for message in queued {
                                self.forward(client, message);
                            }
                        }
                        // The browser wouldn't open a session: the client is let go, and its socket closes.
                        _ => {
                            self.clients.remove(&client);
                        }
                    }
                }
                Some(Pending::Call { client, id, placed }) => {
                    message["id"] = id;
                    let browser = self.clients.get(&client).and_then(|c| c.browser.clone());
                    if placed && message.get("sessionId").and_then(Value::as_str) == browser.as_deref() {
                        message.as_object_mut().map(|m| m.remove("sessionId"));
                    }
                    self.deliver(client, message);
                }
                Some(Pending::Ignore) | None => {}
            }
            return;
        }
        // An event: it belongs to whoever holds its session. Events outside any session are the relay's own.
        let Some(session) = message.get("sessionId").and_then(Value::as_str).map(str::to_string) else { return };
        let Some(&client) = self.sessions.get(&session) else { return };
        if self.clients.get(&client).and_then(|c| c.browser.as_deref()) == Some(session.as_str()) {
            message.as_object_mut().map(|m| m.remove("sessionId"));
        }
        self.deliver(client, message);
    }

    /// The browser has gone: every client's socket closes.
    fn close(&mut self) {
        self.closed = true;
        self.clients.clear();
        self.sessions.clear();
    }
}

struct Shared {
    router: Mutex<Router>,
    changed: Condvar,
}

/// A launched browser's debugger, served over its pipe at a secret address. Dropping it closes the door; the pipe
/// closes when the browser goes.
pub struct Relay {
    shared: Arc<Shared>,
    port: u16,
    secret: String,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Relay {
    /// Serves the browser on the far end of these pipes. Its first command asks the browser's version, so
    /// [`Relay::wait_ready`] can tell when it is up.
    pub(crate) fn start(to_browser: impl Write + Send + 'static, from_browser: impl Read + Send + 'static) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let secret = secret();

        let (to_browser_tx, to_browser_rx) = mpsc::channel::<Vec<u8>>();
        let shared = Arc::new(Shared {
            router: Mutex::new(Router {
                to_browser: to_browser_tx,
                next_id: READY_ID - 1,
                next_client: 0,
                clients: HashMap::new(),
                sessions: HashMap::new(),
                pending: HashMap::new(),
                ready: false,
                closed: false,
            }),
            changed: Condvar::new(),
        });
        shared.router.lock().unwrap().send(json!({ "method": "Browser.getVersion" }), Pending::Ready);

        std::thread::Builder::new().name("cdp-pipe-write".into()).spawn(move || {
            let mut to_browser = to_browser;
            while let Ok(bytes) = to_browser_rx.recv() {
                if to_browser.write_all(&bytes).and_then(|_| to_browser.flush()).is_err() {
                    break;
                }
            }
        })?;

        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let (gone_tx, gone_rx) = tokio::sync::oneshot::channel::<()>();
        let reading = shared.clone();
        std::thread::Builder::new().name("cdp-pipe-read".into()).spawn(move || {
            read_pipe(from_browser, &reading);
            let _ = gone_tx.send(());
        })?;

        let serving = shared.clone();
        let serving_secret: Arc<str> = Arc::from(secret.as_str());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        std::thread::Builder::new().name("cdp-pipe-door".into()).spawn(move || {
            runtime.block_on(async move {
                let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
                let accepting = async {
                    loop {
                        let Ok((stream, _)) = listener.accept().await else { continue };
                        tokio::spawn(serve_client(stream, serving.clone(), serving_secret.clone(), port));
                    }
                };
                tokio::select! {
                    _ = accepting => {}
                    _ = stop_rx => {}
                    _ = gone_rx => {}
                }
            });
        })?;

        Ok(Self { shared, port, secret, stop: Some(stop_tx) })
    }

    pub fn ws_url(&self) -> String {
        format!("ws://127.0.0.1:{}{}{}", self.port, PATH, self.secret)
    }

    /// Whether the browser has answered on the pipe yet.
    pub fn is_ready(&self) -> bool {
        self.shared.router.lock().unwrap().ready
    }

    /// Waits up to `timeout` for the browser's first answer.
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut router = self.shared.router.lock().unwrap();
        while !router.ready && !router.closed {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            router = self.shared.changed.wait_timeout(router, left).unwrap().0;
        }
        router.ready
    }

    /// Asks the browser to close, as `Browser.close` from a client would, so it flushes its profile first.
    pub fn close_browser(&self) {
        self.shared.router.lock().unwrap().send(json!({ "method": "Browser.close" }), Pending::Ignore);
    }

    /// Whether the browser's end of the pipe has closed.
    pub fn is_closed(&self) -> bool {
        self.shared.router.lock().unwrap().closed
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

/// Reads NUL-separated messages from the browser until its end closes.
fn read_pipe(mut from_browser: impl Read, shared: &Shared) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = match from_browser.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let start = buffer.len();
        buffer.extend_from_slice(&chunk[..n]);
        let mut from = 0;
        let mut search = start;
        while let Some(at) = buffer[search..].iter().position(|b| *b == 0) {
            let end = search + at;
            if let Ok(message) = serde_json::from_slice::<Value>(&buffer[from..end]) {
                let mut router = shared.router.lock().unwrap();
                let was_ready = router.ready;
                router.inbound(message);
                if router.ready != was_ready {
                    shared.changed.notify_all();
                }
            }
            from = end + 1;
            search = from;
        }
        buffer.drain(..from);
    }
    shared.router.lock().unwrap().close();
    shared.changed.notify_all();
}

fn refuse(status: StatusCode) -> ErrorResponse {
    let mut response = ErrorResponse::new(None);
    *response.status_mut() = status;
    response
}

// The handshake callback's error is tungstenite's `ErrorResponse`, returned by value as its signature asks.
#[allow(clippy::result_large_err)]
async fn serve_client(stream: tokio::net::TcpStream, shared: Arc<Shared>, secret: Arc<str>, port: u16) {
    let check = |request: &Request, response: Response| {
        let origin = request.headers().get("origin").map(|o| o.to_str().unwrap_or("?"));
        let host = request.headers().get("host").map(|h| h.to_str().unwrap_or("?"));
        if admits(request.uri().path(), origin, host, &secret, port) {
            Ok(response)
        } else {
            Err(refuse(StatusCode::NOT_FOUND))
        }
    };
    let config = WebSocketConfig { max_message_size: None, max_frame_size: None, ..Default::default() };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async_with_config(stream, check, Some(config)).await else { return };
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = unbounded_channel::<String>();
    let Some(client) = shared.router.lock().unwrap().connect(tx) else { return };
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    while let Some(Ok(message)) = source.next().await {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Message::Close(_) => break,
            _ => continue,
        };
        shared.router.lock().unwrap().outbound(client, &text);
    }
    shared.router.lock().unwrap().disconnect(client);
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A browser on the far end of a pipe, answering as Chrome does over `--remote-debugging-pipe`: each browser
    /// session is its own, and its events stay in it.
    struct FakeBrowser {
        relay: Relay,
    }

    fn fake_browser() -> FakeBrowser {
        let p = pipes().unwrap();
        let (mut reads, mut writes) = (p.child_reads, p.child_writes);
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut sessions = 0;
            while let Ok(n) = reads.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..n]);
                while let Some(end) = buffer.iter().position(|b| *b == 0) {
                    let message: Value = serde_json::from_slice(&buffer[..end]).unwrap();
                    buffer.drain(..=end);
                    let id = message["id"].clone();
                    let session = message.get("sessionId").cloned();
                    let mut answers = Vec::new();
                    match message["method"].as_str().unwrap_or("") {
                        "Target.attachToBrowserTarget" => {
                            sessions += 1;
                            answers.push(json!({ "id": id, "result": { "sessionId": format!("B{sessions}") } }));
                        }
                        "Target.attachToTarget" => {
                            sessions += 1;
                            let child = format!("P{sessions}");
                            answers.push(json!({ "method": "Target.attachedToTarget", "sessionId": session, "params": { "sessionId": child } }));
                            answers.push(json!({ "id": id, "sessionId": session, "result": { "sessionId": child } }));
                        }
                        "Echo" => {
                            answers.push(json!({ "method": "Echoed", "sessionId": session, "params": {} }));
                            answers.push(json!({ "id": id, "sessionId": session, "result": { "in": session } }));
                        }
                        _ => answers.push(json!({ "id": id, "sessionId": session, "result": {} })),
                    }
                    for answer in answers {
                        let mut answer = answer;
                        if answer.get("sessionId") == Some(&Value::Null) {
                            answer.as_object_mut().unwrap().remove("sessionId");
                        }
                        let mut bytes = answer.to_string().into_bytes();
                        bytes.push(0);
                        if writes.write_all(&bytes).is_err() {
                            return;
                        }
                    }
                }
            }
        });
        let relay = Relay::start(p.to_browser, p.from_browser).unwrap();
        assert!(relay.wait_ready(Duration::from_secs(5)));
        FakeBrowser { relay }
    }

    async fn ws(url: &str) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String> {
        tokio_tungstenite::connect_async(url).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
    }

    async fn ask(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        message: Value,
    ) -> Vec<Value> {
        ws.send(Message::Text(message.to_string())).await.unwrap();
        let mut heard = Vec::new();
        loop {
            let Some(Ok(Message::Text(text))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap() else {
                panic!("the relay closed")
            };
            let v: Value = serde_json::from_str(&text).unwrap();
            let done = v.get("id") == message.get("id");
            heard.push(v);
            if done {
                return heard;
            }
        }
    }

    #[test]
    fn only_the_exact_secret_path_without_an_origin_is_let_in() {
        let s = "a".repeat(64);
        let h = Some("127.0.0.1:4100");
        assert!(admits(&format!("{PATH}{s}"), None, h, &s, 4100));
        assert!(!admits(&format!("{PATH}{s}"), Some("https://page.example"), h, &s, 4100), "a web page is never let in");
        assert!(!admits(&format!("{PATH}{}", "b".repeat(64)), None, h, &s, 4100));
        assert!(!admits(PATH, None, h, &s, 4100));
        assert!(!admits(&format!("{PATH}{s}x"), None, h, &s, 4100));
        assert!(!admits("/json/version", None, h, &s, 4100));
        // The relay's own address as Host, exactly: a rebound name, another port, or none is refused.
        for host in [Some("rebound.example:4100"), Some("localhost:4100"), Some("127.0.0.1:4101"), Some("127.0.0.1"), None] {
            assert!(!admits(&format!("{PATH}{s}"), None, host, &s, 4100), "{host:?}");
        }
        assert_ne!(secret(), secret());
        assert_eq!(secret().len(), 72);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_browsers_debugger_answers_no_one_without_its_secret() {
        let browser = fake_browser();
        let url = browser.relay.ws_url();
        let port = url.split(':').nth(2).unwrap().split('/').next().unwrap().to_string();
        // No secret, a wrong one, and the HTTP listing Chrome serves on a port: all refused.
        assert!(ws(&format!("ws://127.0.0.1:{port}/devtools/browser/")).await.is_err());
        assert!(ws(&format!("ws://127.0.0.1:{port}/devtools/browser/{}", "0".repeat(72))).await.is_err());
        let listing = reqwest::get(format!("http://127.0.0.1:{port}/json/version")).await;
        assert!(listing.map(|r| !r.status().is_success()).unwrap_or(true), "the relay lists nothing");
        // A web page names its origin: refused even with the secret.
        let mut request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url.as_str()).unwrap();
        request.headers_mut().insert("origin", "https://page.example".parse().unwrap());
        assert!(tokio_tungstenite::connect_async(request).await.is_err());
        // A Host other than the relay's own address (a name rebound to it) is refused, even with the secret.
        let mut rebound = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url.as_str()).unwrap();
        rebound.headers_mut().insert("host", format!("rebound.example:{port}").parse().unwrap());
        assert!(tokio_tungstenite::connect_async(rebound).await.is_err());
        // The secret opens it.
        let mut client = ws(&url).await.unwrap();
        let heard = ask(&mut client, json!({ "id": 7, "method": "Browser.getVersion" })).await;
        assert_eq!(heard.last().unwrap(), &json!({ "id": 7, "result": {} }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn each_client_has_its_own_browser_session_and_cannot_reach_anothers() {
        let browser = fake_browser();
        let mut a = ws(&browser.relay.ws_url()).await.unwrap();
        let mut b = ws(&browser.relay.ws_url()).await.unwrap();
        // The same ids from two clients each come back to their sender, in the client's own browser session, which
        // the client never sees named.
        let heard_a = ask(&mut a, json!({ "id": 1, "method": "Echo" })).await;
        let heard_b = ask(&mut b, json!({ "id": 1, "method": "Echo" })).await;
        let (in_a, in_b) = (heard_a.last().unwrap()["result"]["in"].clone(), heard_b.last().unwrap()["result"]["in"].clone());
        assert_ne!(in_a, in_b);
        assert!(heard_a.iter().all(|m| m.get("sessionId").is_none()), "{heard_a:?}");
        assert_eq!(heard_a.first().unwrap()["method"], "Echoed", "a client's events reach it");
        // A page session a client attaches is that client's: its own commands there are answered...
        let attached = ask(&mut a, json!({ "id": 2, "method": "Target.attachToTarget", "params": { "targetId": "t" } })).await;
        let page = attached.last().unwrap()["result"]["sessionId"].as_str().unwrap().to_string();
        let heard = ask(&mut a, json!({ "id": 3, "sessionId": page, "method": "Echo" })).await;
        assert_eq!(heard.last().unwrap()["result"]["in"], json!(page));
        // ...and another client naming it is refused, as is detaching it.
        let refused = ask(&mut b, json!({ "id": 4, "sessionId": page, "method": "Echo" })).await;
        assert_eq!(refused.len(), 1, "no event of a's reaches b: {refused:?}");
        assert!(refused[0].get("error").is_some(), "{refused:?}");
        let refused = ask(&mut b, json!({ "id": 5, "method": "Target.detachFromTarget", "params": { "sessionId": page } })).await;
        assert!(refused.last().unwrap().get("error").is_some(), "{refused:?}");
    }
}
