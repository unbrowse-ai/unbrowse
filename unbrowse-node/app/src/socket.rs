//! Running a route whose target is a frame sent over a page's socket: the node opens the socket itself, with the
//! headers the page chose and the owner's cookies from the jar, speaks the protocol's opening frames, sends the
//! frame with the caller's values in it, and returns the socket's answer. When the site has moved on (the socket
//! is refused, or closes), the node's browser opens the route's page again, and the socket it opens there is the
//! route's from then on.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

use crate::store::{self, Piece, Route, SocketRoute};

/// How long the socket has to answer at each step.
const WAIT: Duration = Duration::from_secs(8);

/// The frame with the caller's values in it, each as it would sit inside a JSON string.
fn frame_of(s: &SocketRoute, values: &HashMap<String, String>) -> Result<String, String> {
    let mut out = String::new();
    for p in &s.frame {
        match p {
            Piece::Text { text } => out.push_str(text),
            Piece::Input { name } => {
                let v = values.get(name).ok_or_else(|| format!("the route needs a value for {name}"))?;
                let quoted = serde_json::to_string(v).map_err(|e| e.to_string())?;
                out.push_str(&quoted[1..quoted.len() - 1]);
            }
        }
    }
    Ok(out)
}

/// The answer as data: the frame's JSON after its kind when it has one, else its JSON, else its text.
fn answer(frame: &str, word: &str) -> serde_json::Value {
    let rest = frame.strip_prefix(word).unwrap_or(frame);
    serde_json::from_str(rest.trim()).unwrap_or_else(|_| serde_json::Value::String(frame.to_string()))
}

/// How long to keep listening once some frame has come back, for one that is plainly the answer.
const LINGER: Duration = Duration::from_millis(1500);

/// Why a frame got no answer, and whether it may have reached the site. A socket that never opened (or that closed
/// before the frame was handed over) has sent nothing; once the frame is handed to the socket it may land even if
/// the answer never comes back.
struct Unspoken {
    why: String,
    sent: bool,
}

impl Unspoken {
    /// The frame was never handed to the socket.
    fn unsent(why: impl Into<String>) -> Self {
        Unspoken { why: why.into(), sent: false }
    }

    /// The frame went out; whether the site read it is the site's to say.
    fn sent(why: impl Into<String>) -> Self {
        Unspoken { why: why.into(), sent: true }
    }
}

impl From<Unspoken> for String {
    fn from(u: Unspoken) -> Self {
        u.why
    }
}

/// Opens the socket, speaks, sends the frame, and waits for its answer: a frame back of the sent frame's kind, or
/// one that names what the caller sent; else the first frame back that isn't the echo of an opening frame.
async fn speak(s: &SocketRoute, frame: &str, sent: &[String]) -> Result<serde_json::Value, Unspoken> {
    // The build carries more than one TLS crypto backend; the socket's TLS needs one chosen. Once is enough.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let word = crate::learn::frame_kind(&s.frame);
    let mut req = s.url.as_str().into_client_request().map_err(|e| Unspoken::unsent(format!("the socket's address: {e}")))?;
    let host = req.uri().host().unwrap_or_default().to_string();
    // A site where a card sits in a checkout is sent nothing, a socket's frame included (`unbrowse_learn::hold`).
    if let Some(why) = crate::browse::card_holds_host(&host) {
        return Err(Unspoken::unsent(why));
    }
    for (k, v) in &s.headers {
        if let (Ok(k), Ok(v)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            req.headers_mut().insert(k, v);
        }
    }
    let jar: std::collections::BTreeMap<String, String> = store::read_json(&store::jar_path(&host), &unbrowse_files::JAR);
    if let Some(cookie) = jar_cookie(&s.url, &jar) {
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            req.headers_mut().insert("cookie", v);
        }
    }
    // The socket is opened to an address the egress check passed, as every other call of the node's is: a public
    // name pointed inside the owner's network is refused before anything is sent.
    let port = req.uri().port_u16().unwrap_or(if req.uri().scheme_str() == Some("wss") { 443 } else { 80 });
    let addrs = unbrowse_learn::egress::lookup(&host, port).await.map_err(Unspoken::unsent)?;
    let opened = async {
        let tcp = tokio::net::TcpStream::connect(&addrs[..]).await.map_err(|e| format!("the socket refused: {e}"))?;
        tokio_tungstenite::client_async_tls(req, tcp).await.map_err(|e| format!("the socket refused: {e}"))
    };
    let (mut ws, _) = tokio::time::timeout(WAIT, opened)
        .await
        .map_err(|_| Unspoken::unsent("the socket didn't open in time"))?
        .map_err(Unspoken::unsent)?;
    let text_of = |m: Message| match m {
        Message::Text(t) => Some(t.to_string()),
        _ => None,
    };
    if s.server_first {
        match tokio::time::timeout(WAIT, ws.next()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => return Err(Unspoken::unsent("the socket closed as it opened")),
            Ok(Some(Err(e))) => return Err(Unspoken::unsent(format!("the socket failed as it opened: {e}"))),
            _ => {}
        }
    }
    for f in &s.opening {
        ws.send(Message::Text(f.clone())).await.map_err(|e| Unspoken::unsent(format!("the socket closed: {e}")))?;
    }
    // From here the frame may have reached the site, whatever happens next.
    ws.send(Message::Text(frame.to_string())).await.map_err(|e| Unspoken::sent(format!("the socket closed: {e}")))?;
    let mut deadline = tokio::time::Instant::now() + WAIT;
    let mut first: Option<String> = None;
    let names_what_was_sent = |t: &str| sent.iter().any(|v| v.trim().len() >= 2 && crate::learn::frame_carries(t, v));
    while let Ok(Some(msg)) = tokio::time::timeout_at(deadline, ws.next()).await {
        match msg {
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(m) => {
                let Some(t) = text_of(m) else { continue };
                if (!word.is_empty() && crate::learn::frame_word(&t) == word) || names_what_was_sent(&t) {
                    let _ = ws.close(None).await;
                    return Ok(answer(&t, &word));
                }
                if first.is_none() && !s.opening.contains(&t) {
                    first = Some(t);
                    deadline = deadline.min(tokio::time::Instant::now() + LINGER);
                }
            }
        }
    }
    let _ = ws.close(None).await;
    match first {
        Some(t) => Ok(answer(&t, &word)),
        None => Err(Unspoken::sent("the socket took the frame but said nothing back")),
    }
}

/// The jar's cookies as a socket's Cookie header, when the socket goes where a browser would send all of them. The jar
/// keeps names and values only, so which were Secure it no longer knows: it goes over TLS (`wss:`) or to this machine
/// itself, never in the clear, the way HTTP replay sends it (`unbrowse_learn::client::secure_context`).
fn jar_cookie(url: &str, jar: &std::collections::BTreeMap<String, String>) -> Option<String> {
    let url = url::Url::parse(url).ok()?;
    if jar.is_empty() || !unbrowse_learn::client::secure_context(&url) {
        return None;
    }
    Some(jar.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; "))
}

/// The socket the node's browser opened most recently on the route socket's own origin (scheme, host and port): its
/// address and the headers the page chose, from the browsing log's tail. A heal never moves the route to another
/// origin, nor from `wss:` to the clear.
fn freshest(site: &str, origin: &url::Origin) -> Option<(String, Vec<(String, String)>)> {
    use std::io::{Read, Seek, SeekFrom};
    let path = crate::browse::capture_dir().join(format!("{}.jsonl", crate::browse::session_of(site)));
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(16 << 20))).ok()?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<serde_json::Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).filter(|v: &serde_json::Value| v["type"] == "socket").collect();
    let open = lines.iter().rev().find(|v| v["event"] == "open" && v["url"].as_str().and_then(|u| url::Url::parse(u).ok()).is_some_and(|u| u.origin() == *origin))?;
    let id = open["id"].as_str()?;
    let headers = lines
        .iter()
        .rev()
        .find(|v| v["event"] == "handshake" && v["id"] == id)
        .and_then(|v| v["headers"].as_object().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| crate::learn::chosen_header(k))
        .map(|(k, v)| (k, v.as_str().map(String::from).unwrap_or_default()))
        .collect();
    Some((open["url"].as_str()?.to_string(), headers))
}

/// A socket call's answer, and whether the frame may have reached the site. A frame is a message the site acts on:
/// once it is handed to the socket it may have landed, however the call ends.
pub struct SocketCall {
    pub answer: Result<serde_json::Value, String>,
    pub possible_commit: bool,
}

/// What a failed frame means for the call: whether the page may be opened again and the frame sent once more, and
/// whether the site may hold it. A frame the socket never took (it refused, or closed before the frame was handed
/// over) sent nothing, so it may be sent again. A frame the socket took may have been acted on however the call
/// ends, and is never sent twice.
fn after_a_failed_frame(handed_over: bool, writes: bool) -> (bool, bool) {
    (!handed_over, handed_over && writes)
}

/// Calls a socket route. Blocking. A refused or closed socket heals once — the node's browser opens the route's
/// page, and the route takes the socket that page opens — but only for a frame the site never received: a frame
/// that went out may already have been acted on, and sending it again would say it twice.
pub fn call(route: &mut Route, values: &HashMap<String, String>, who: &str) -> SocketCall {
    let Some(s) = route.socket.clone() else {
        return SocketCall { answer: Err("not a socket route".into()), possible_commit: false };
    };
    // While a checkout waits for the owner, a socket route sends no frame anywhere, however it is judged.
    if let Some(why) = unbrowse_learn::hold::waiting() {
        return SocketCall { answer: Err(why), possible_commit: false };
    }
    let frame = match frame_of(&s, values) {
        Ok(f) => f,
        Err(e) => return SocketCall { answer: Err(e), possible_commit: false },
    };
    let sent: Vec<String> = values.values().cloned().collect();
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return SocketCall { answer: Err(e.to_string()), possible_commit: false },
    };
    match rt.block_on(speak(&s, &frame, &sent)) {
        Ok(v) => SocketCall { answer: Ok(v), possible_commit: route.write },
        Err(first) => {
            let (may_send_again, possible_commit) = after_a_failed_frame(first.sent, route.write);
            if !may_send_again {
                // The frame went out. Opening the page again would only earn a new socket for a second frame, and
                // the site may already hold the first.
                return SocketCall { answer: Err(first.why), possible_commit };
            }
            let Some(origin) = url::Url::parse(&s.url).ok().map(|u| u.origin()) else {
                return SocketCall { answer: Err(first.why), possible_commit };
            };
            let site = unbrowse_learn::identity::site_of(&route.site);
            // The node's own tab of the site's browser: never the page an agent is driving there.
            let healed = crate::browse::act(&["open".to_string(), route.root.clone()], Some(&site), who, crate::browse::HEAL)
                .and_then(|_| {
                    std::thread::sleep(Duration::from_secs(6));
                    freshest(&site, &origin).ok_or_else(|| format!("the page opened no socket to {}", origin.ascii_serialization()))
                });
            // The socket is read off the walk record; the page that opened it isn't needed any more.
            crate::browse::heal_done(&site);
            let (url, headers) = match healed {
                Ok(socket) => socket,
                Err(e) => return SocketCall { answer: Err(format!("{}; and {e}", first.why)), possible_commit },
            };
            let healed = SocketRoute { url, headers, ..s };
            match rt.block_on(speak(&healed, &frame, &sent)) {
                Ok(v) => {
                    route.socket = Some(healed);
                    SocketCall { answer: Ok(v), possible_commit: route.write }
                }
                Err(e) => SocketCall {
                    answer: Err(format!("{}; after opening the page again: {}", first.why, e.why)),
                    possible_commit: after_a_failed_frame(e.sent, route.write).1,
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The jar rides a socket's handshake only where a browser would send every cookie in it: over TLS, or to this
    /// machine. A cleartext socket to a host on the network gets none.
    #[test]
    fn a_jar_never_rides_a_cleartext_socket() {
        let jar = std::collections::BTreeMap::from([("sid".to_string(), "dummy-secure-value".to_string())]);
        assert_eq!(jar_cookie("wss://chat.example/socket", &jar).as_deref(), Some("sid=dummy-secure-value"));
        assert_eq!(jar_cookie("ws://chat.example/socket", &jar), None);
        assert_eq!(jar_cookie("ws://127.0.0.1:9000/", &jar).as_deref(), Some("sid=dummy-secure-value"));
        assert_eq!(jar_cookie("wss://chat.example/socket", &Default::default()), None);
    }

    /// A socket addressed plainly to this machine is dialled: the egress check stops only a public name pointed in.
    #[test]
    fn a_socket_addressed_plainly_is_dialled() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let route = |url: String| SocketRoute { url, headers: vec![], opening: vec![], frame: vec![], server_first: false };
        // Plainly local: dialled (and refused, nothing listens), not stopped by the check.
        let err = rt.block_on(speak(&route(format!("ws://127.0.0.1:{port}/")), "x", &[])).err().unwrap();
        assert!(!err.why.contains("inside this network"), "{}", err.why);
        assert!(!err.sent);
    }

    /// A socket route whose public name resolves inside the owner's network is refused before the handshake. Needs
    /// DNS (a public name that answers 127.0.0.1), so it runs on request.
    #[test]
    #[ignore = "needs DNS"]
    fn a_socket_never_follows_a_public_name_inside() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let route = SocketRoute { url: "ws://localtest.me:9/".into(), headers: vec![], opening: vec![], frame: vec![], server_first: false };
        let err = rt.block_on(speak(&route, "x", &[])).err().unwrap();
        assert!(err.why.contains("inside this network"), "{}", err.why);
    }

    /// A frame the socket never took may be sent again; a frame it took may have been acted on, and is not.
    #[test]
    fn a_frame_the_socket_never_took_may_be_sent_again() {
        assert_eq!(after_a_failed_frame(false, true), (true, false), "never handed over: send it again");
        assert_eq!(after_a_failed_frame(true, true), (false, true), "handed over: the site may hold it");
        // A read route's frame changes nothing the caller must answer for.
        assert_eq!(after_a_failed_frame(true, false), (false, false));
    }
}
