use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use super::cdp::client::InspectProxyHandle;

/// Counter for unique attach IDs so concurrent connections don't collide.
///
/// The daemon numbers its own commands upward from 1, so every id the proxy
/// puts on the shared connection (attach, detach, and each DevTools command)
/// comes from this negative range and can never answer a daemon command.
static ATTACH_ID: AtomicI64 = AtomicI64::new(-1000);

/// Lightweight HTTP + WebSocket server for `agent-browser inspect`.
///
/// Serves two purposes:
/// - `GET /<token>` redirects to Chrome's built-in DevTools frontend with `ws=` pointing to this server
/// - WebSocket connections create a dedicated CDP session via `Target.attachToTarget` and proxy
///   CDP messages through the daemon's existing browser-level connection, injecting/stripping
///   `sessionId` so the DevTools frontend sees a page-level view
///
/// Both routes need the per-launch token, which only the `inspect` reply
/// carries: a loopback port has no permissions of its own, so any local client
/// or any page that found the port could otherwise drive the inspected page.
pub struct InspectServer {
    port: u16,
    token: String,
    _handle: tokio::task::JoinHandle<()>,
}

impl InspectServer {
    /// Start the inspect proxy server.
    ///
    /// - `proxy_handle`: lightweight handle for sending/receiving raw CDP messages
    /// - `target_id`: the CDP target ID of the page to inspect
    /// - `chrome_host_port`: the Chrome debug server address (e.g. "127.0.0.1:9222")
    pub async fn start(
        proxy_handle: InspectProxyHandle,
        target_id: String,
        chrome_host_port: String,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind inspect server: {}", e))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local addr: {}", e))?
            .port();

        let proxy = Arc::new(proxy_handle);
        let token = super::stream::new_secret();

        let handle = tokio::spawn(accept_loop(
            listener,
            proxy,
            target_id,
            chrome_host_port,
            port,
            Arc::from(token.as_str()),
        ));

        Ok(Self {
            port,
            token,
            _handle: handle,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The URL that opens DevTools on the inspected page. It carries the
    /// per-launch token, so it is handed only to whoever ran `inspect`.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.token)
    }

    /// The DevTools frontend a browser carries, pointed at this proxy: for a browser whose debugger is on a pipe, which
    /// serves no frontend over HTTP. Only that browser opens it.
    pub fn frontend_in_browser(&self) -> String {
        format!(
            "devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:{}/ws/{}",
            self.port, self.token
        )
    }

    pub fn shutdown(self) {
        self._handle.abort();
    }
}

async fn accept_loop(
    listener: TcpListener,
    proxy: Arc<InspectProxyHandle>,
    target_id: String,
    chrome_host_port: String,
    proxy_port: u16,
    token: Arc<str>,
) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => continue,
        };

        let proxy = proxy.clone();
        let tid = target_id.clone();
        let chp = chrome_host_port.clone();
        let token = token.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, proxy, tid, chp, proxy_port, token).await {
                let _ = writeln!(std::io::stderr(), "[inspect] connection error: {}", e);
            }
        });
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    proxy: Arc<InspectProxyHandle>,
    target_id: String,
    chrome_host_port: String,
    proxy_port: u16,
    token: Arc<str>,
) -> Result<(), String> {
    // Peek at the request line to determine routing WITHOUT consuming bytes.
    // This is critical: tokio_tungstenite::accept_async needs to read the full
    // HTTP upgrade request itself, so we must not consume anything for WS paths.
    let mut peek_buf = [0u8; 32];
    let n = stream
        .peek(&mut peek_buf)
        .await
        .map_err(|e| e.to_string())?;
    let peek = String::from_utf8_lossy(&peek_buf[..n]);

    if peek.starts_with("GET /ws") {
        return handle_ws_proxy(stream, proxy, target_id, chrome_host_port, token).await;
    }

    if peek.starts_with("GET /") {
        let buf_reader = BufReader::new(stream);
        return handle_http_redirect(buf_reader, chrome_host_port, proxy_port, token).await;
    }

    // Unknown request -- consume and respond 404
    let mut stream = stream;
    let mut discard = [0u8; 4096];
    let _ = stream.read(&mut discard).await;
    stream
        .write_all(NOT_FOUND.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

const MAX_HEADER_BYTES: usize = 8192;
const NOT_FOUND: &str = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

async fn handle_http_redirect(
    buf_reader: BufReader<tokio::net::TcpStream>,
    chrome_host_port: String,
    proxy_port: u16,
    token: Arc<str>,
) -> Result<(), String> {
    let mut br = buf_reader;
    let mut request_line = String::new();
    let mut total_bytes = br
        .read_line(&mut request_line)
        .await
        .map_err(|e| e.to_string())?;
    loop {
        let mut line = String::new();
        let n = br.read_line(&mut line).await.map_err(|e| e.to_string())?;
        total_bytes += n;
        if line == "\r\n" || line == "\n" || line.is_empty() || total_bytes > MAX_HEADER_BYTES {
            break;
        }
    }

    let mut stream = br.into_inner();
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    if !path_carries_token(path, "/", &token) {
        stream
            .write_all(NOT_FOUND.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let location = format!(
        "http://{}/devtools/devtools_app.html?ws=127.0.0.1:{}/ws/{}",
        chrome_host_port, proxy_port, token
    );
    let body = format!(
        "<html><body>Redirecting to <a href=\"{url}\">{url}</a></body></html>",
        url = location
    );
    let resp = format!(
        "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Type: text/html\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        location,
        body.len(),
        body
    );
    stream
        .write_all(resp.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Whether `path` is exactly `<prefix><token>`, compared in constant time.
fn path_carries_token(path: &str, prefix: &str, token: &str) -> bool {
    path.strip_prefix(prefix)
        .is_some_and(|provided| super::stream::constant_time_eq(token, provided))
}

/// The DevTools frontend the redirect opens is served by Chrome's own debug
/// server, so a browser client of the proxy names that origin. A client with
/// no Origin is not a web page; it still needs the token.
fn is_devtools_origin(origin: Option<&str>, chrome_host_port: &str) -> bool {
    match origin {
        None => true,
        Some(origin) => {
            origin.eq_ignore_ascii_case(&format!("http://{chrome_host_port}"))
                || origin.starts_with("devtools://")
        }
    }
}

fn reject(status: StatusCode, reason: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(reason.to_string()));
    *response.status_mut() = status;
    response
}

async fn handle_ws_proxy(
    stream: tokio::net::TcpStream,
    proxy: Arc<InspectProxyHandle>,
    target_id: String,
    chrome_host_port: String,
    token: Arc<str>,
) -> Result<(), String> {
    // Refused at the handshake, before any CDP session is attached.
    let callback = |req: &Request, resp: Response| {
        if !path_carries_token(req.uri().path(), "/ws/", &token) {
            return Err(reject(StatusCode::FORBIDDEN, "Inspect token missing"));
        }
        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
        if !is_devtools_origin(origin, &chrome_host_port) {
            return Err(reject(StatusCode::FORBIDDEN, "Origin not allowed"));
        }
        Ok(resp)
    };
    let ws_stream = tokio_tungstenite::accept_hdr_async(stream, callback)
        .await
        .map_err(|e| format!("WebSocket handshake failed: {}", e))?;

    // Create a dedicated CDP session for this DevTools connection.
    // Each connection gets its own session so domain enablements (DOM.enable, etc.)
    // always trigger fresh initial state dumps from Chrome.
    let attach_id = ATTACH_ID.fetch_sub(1, Ordering::SeqCst);
    let attach_cmd = format!(
        r#"{{"id":{},"method":"Target.attachToTarget","params":{{"targetId":"{}","flatten":true}}}}"#,
        attach_id, target_id
    );

    // Subscribe BEFORE sending so we don't miss the response (tokio broadcast
    // receivers only deliver messages to receivers that already exist).
    let mut raw_rx = proxy.subscribe_raw();

    proxy
        .send_raw(attach_cmd)
        .await
        .map_err(|e| format!("Failed to send attachToTarget: {}", e))?;

    // Wait for the attachToTarget response to extract the session ID
    let session_id = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Ok(raw_msg) = raw_rx.recv().await {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw_msg.text) {
                if val.get("id").and_then(|v| v.as_i64()) == Some(attach_id) {
                    if let Some(sid) = val
                        .get("result")
                        .and_then(|r| r.get("sessionId"))
                        .and_then(|s| s.as_str())
                    {
                        return Ok(sid.to_string());
                    }
                    return Err("attachToTarget failed".to_string());
                }
            }
        }
        Err("raw message channel closed".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for attachToTarget response".to_string())?
    .map_err(|e| format!("Failed to create DevTools session: {}", e))?;

    let (ws_tx, mut ws_rx) = ws_stream.split();
    let ws_tx = Arc::new(Mutex::new(ws_tx));

    // Proxy id -> the id DevTools chose, so each reply goes back under the
    // id its command was sent with.
    let ids: Arc<Mutex<HashMap<i64, Value>>> = Arc::new(Mutex::new(HashMap::new()));

    let mut raw_rx = proxy.subscribe_raw();
    let ws_tx_clone = ws_tx.clone();
    let session_id_clone = session_id.clone();
    let ids_for_replies = ids.clone();

    // Chrome -> DevTools: forward messages matching our session, strip sessionId
    let mut chrome_to_devtools = tokio::spawn(async move {
        loop {
            let raw_msg = match raw_rx.recv().await {
                Ok(msg) => msg,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    let _ = writeln!(
                        std::io::stderr(),
                        "[inspect] warning: dropped {} CDP messages (channel lag)",
                        n
                    );
                    continue;
                }
                Err(_) => break,
            };

            if raw_msg.session_id.as_deref() != Some(&session_id_clone) {
                continue;
            }

            let Some(stripped) = restore_reply(&raw_msg.text, &ids_for_replies).await else {
                continue;
            };

            let mut tx = ws_tx_clone.lock().await;
            if tx.send(Message::Text(stripped)).await.is_err() {
                break;
            }
        }
    });

    // DevTools -> Chrome: inject sessionId and forward
    let proxy_for_send = proxy.clone();
    let session_id_for_send = session_id.clone();
    let mut devtools_to_chrome = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };

            // A frame that cannot be re-addressed to the page session is never
            // forwarded: on the browser-level connection it would reach the
            // browser target itself.
            let proxy_id = ATTACH_ID.fetch_sub(1, Ordering::SeqCst);
            let Some((readdressed, original_id)) =
                readdress_frame(&text, &session_id_for_send, proxy_id)
            else {
                let _ = writeln!(
                    std::io::stderr(),
                    "[inspect] closing: DevTools sent a frame that is not a CDP command"
                );
                break;
            };
            ids.lock().await.insert(proxy_id, original_id);
            if proxy_for_send.send_raw(readdressed).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = &mut chrome_to_devtools => {
            devtools_to_chrome.abort();
        },
        _ = &mut devtools_to_chrome => {
            chrome_to_devtools.abort();
        },
    }

    // Clean up the CDP session so Chrome doesn't leak attached targets
    let detach_cmd = format!(
        r#"{{"id":{},"method":"Target.detachFromTarget","params":{{"sessionId":"{}"}}}}"#,
        ATTACH_ID.fetch_sub(1, Ordering::SeqCst),
        session_id
    );
    let _ = proxy.send_raw(detach_cmd).await;

    Ok(())
}

/// Re-address one DevTools frame to the proxy's page session: the frame must
/// be a JSON object with an integer `id`; its `sessionId` becomes ours and its
/// `id` becomes `proxy_id`. Returns the frame to send and the client's own id,
/// or `None` when the frame is anything else, so it is never sent as is.
fn readdress_frame(json: &str, session_id: &str, proxy_id: i64) -> Option<(String, Value)> {
    let mut val = serde_json::from_str::<Value>(json).ok()?;
    let obj = val.as_object_mut()?;
    let original_id = obj.get("id").filter(|id| id.is_i64() || id.is_u64())?.clone();
    obj.insert("id".to_string(), Value::from(proxy_id));
    obj.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    let text = serde_json::to_string(&val).ok()?;
    Some((text, original_id))
}

/// Turn a message from the proxy's page session back into what DevTools
/// expects: no `sessionId`, and a reply under the id DevTools sent. A reply
/// whose id the proxy did not issue is not DevTools' and is dropped.
async fn restore_reply(json: &str, ids: &Mutex<HashMap<i64, Value>>) -> Option<String> {
    let mut val = serde_json::from_str::<Value>(json).ok()?;
    let obj = val.as_object_mut()?;
    obj.remove("sessionId");
    if let Some(id) = obj.get("id") {
        let proxy_id = id.as_i64()?;
        let original = ids.lock().await.remove(&proxy_id)?;
        obj.insert("id".to_string(), original);
    }
    serde_json::to_string(&val).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_readdress_frame() {
        let input = r#"{"id":1,"method":"DOM.getDocument"}"#;
        let (result, original) = readdress_frame(input, "abc123", -5).expect("a CDP command");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("valid JSON");
        assert_eq!(parsed["sessionId"], "abc123");
        assert_eq!(parsed["method"], "DOM.getDocument");
        assert_eq!(parsed["id"], -5);
        assert_eq!(original, 1);
    }

    #[test]
    fn a_client_sessionid_is_replaced_by_the_proxys() {
        let input = r#"{"id":1,"method":"Target.createTarget","sessionId":"other"}"#;
        let (result, _) = readdress_frame(input, "mine", -5).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["sessionId"], "mine");
    }

    #[test]
    fn a_frame_the_proxy_cannot_readdress_is_never_forwarded() {
        let deep = format!(
            r#"{{"id":9001,"method":"Target.createTarget","params":{{"x":{}0{}}}}}"#,
            "[".repeat(200),
            "]".repeat(200)
        );
        assert!(serde_json::from_str::<Value>(&deep).is_err());
        let lone_surrogate =
            r#"{"id":9002,"method":"Target.createTarget","params":{"x":"\ud800"}}"#;
        assert!(serde_json::from_str::<Value>(lone_surrogate).is_err());

        for frame in [
            deep.as_str(),
            lone_surrogate,
            "not json",
            "[1,2]",
            "42",
            "{}",
            r#"{"method":"Target.createTarget"}"#,
            r#"{"id":"x","method":"Target.createTarget"}"#,
        ] {
            assert!(
                readdress_frame(frame, "abc", -5).is_none(),
                "forwarded a frame it could not re-address: {frame}"
            );
        }
    }

    #[tokio::test]
    async fn a_reply_returns_under_the_clients_id_and_only_once() {
        let ids = Mutex::new(HashMap::from([(-7i64, Value::from(42))]));
        let reply = r#"{"id":-7,"result":{},"sessionId":"abc123"}"#;
        let restored = restore_reply(reply, &ids).await.expect("our reply");
        let parsed: serde_json::Value = serde_json::from_str(&restored).unwrap();
        assert!(parsed.get("sessionId").is_none());
        assert_eq!(parsed["id"], 42);
        assert!(restore_reply(reply, &ids).await.is_none(), "replayed a reply");
    }

    #[test]
    fn proxy_ids_never_collide_with_daemon_command_ids() {
        // The daemon numbers commands upward from 1; a DevTools client that
        // reuses one of those ids still goes out under a negative proxy id.
        let proxy_id = ATTACH_ID.fetch_sub(1, Ordering::SeqCst);
        let (sent, original) =
            readdress_frame(r#"{"id":1,"method":"Runtime.evaluate"}"#, "s", proxy_id).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&sent).unwrap();
        assert!(parsed["id"].as_i64().unwrap() < 0);
        assert_eq!(original, 1);
    }

    #[tokio::test]
    async fn events_pass_through_without_their_session() {
        let ids = Mutex::new(HashMap::new());
        let event = r#"{"method":"DOM.documentUpdated","params":{},"sessionId":"abc123"}"#;
        let restored = restore_reply(event, &ids).await.expect("an event");
        let parsed: serde_json::Value = serde_json::from_str(&restored).unwrap();
        assert!(parsed.get("sessionId").is_none());
        assert_eq!(parsed["method"], "DOM.documentUpdated");
    }

    #[test]
    fn the_inspect_routes_need_the_launch_token() {
        let token = "a".repeat(64);
        assert!(path_carries_token(&format!("/ws/{token}"), "/ws/", &token));
        assert!(path_carries_token(&format!("/{token}"), "/", &token));
        assert!(!path_carries_token("/ws", "/ws/", &token));
        assert!(!path_carries_token("/ws/", "/ws/", &token));
        assert!(!path_carries_token(&format!("/ws/{}", "b".repeat(64)), "/ws/", &token));
        assert!(!path_carries_token("/", "/", &token));
    }

    #[test]
    fn only_the_devtools_frontend_origin_may_connect() {
        assert!(is_devtools_origin(Some("http://127.0.0.1:9222"), "127.0.0.1:9222"));
        assert!(is_devtools_origin(None, "127.0.0.1:9222"));
        assert!(!is_devtools_origin(Some("http://evil.example"), "127.0.0.1:9222"));
        assert!(!is_devtools_origin(Some("http://127.0.0.1:8000"), "127.0.0.1:9222"));
    }
}
