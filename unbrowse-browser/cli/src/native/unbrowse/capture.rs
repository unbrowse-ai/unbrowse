//! Unbrowse fork: passive capture for route learning.
//!
//! When `UNBROWSE_CAPTURE_DIR` is set, each session appends a JSON-lines log to `<dir>/<session>.jsonl`
//! while the agent browses: one line per finished request (a HAR 1.2 entry with the headers really sent
//! and received, cookies included, and text bodies), one per page-driving action with what was typed,
//! one per socket event and one per download. Nothing has to be started or stopped; the node reads it.
//!
//! The log keeps its own table of requests, fed from every DevTools event the daemon drains
//! ([`Capture::on_event`]). It shares nothing with upstream's HAR recorder, so either can change alone.

use std::collections::{HashMap, VecDeque};
use std::io::Write;

use serde_json::{json, Value};

use super::super::actions::DaemonState;
use super::super::browser::PageInfo;

pub use agent_browser_core::capture::{now_secs, CaptureLog, LOGGED_ACTIONS};

/// How long a request that has its answer waits to be called finished before it is written anyway. Chrome
/// calls a request finished once the page has read its body, so a call the page sent and ignored the answer
/// of (saving a preference, a choice) would never be written: yet it is the call that changed something.
const UNREAD_WAIT_SECS: f64 = 8.0;

/// The most requests kept waiting for an answer. A page that opens requests and never ends them (a stream,
/// a long poll) must not grow the daemon without bound: the oldest go first.
const OPEN_LIMIT: usize = 4096;

/// The largest body kept in a line. A page's data calls are far smaller; a video segment is not a route.
const BODY_LIMIT: usize = 8 * 1024 * 1024;

/// The most of a socket frame's payload kept: a socket can stream large updates, and what an agent sends is small.
const FRAME_LIMIT: usize = 64 * 1024;

type Headers = Vec<(String, String)>;

/// One request of a chain of redirects, from sent to answered.
#[derive(Default)]
struct Hop {
    /// This hop's own key in the log's settle queue: the chain's id and its place in it.
    key: String,
    /// Chrome's id for the whole chain of redirects.
    chain: String,
    /// The DevTools session that saw it: a tab's page, a frame's or a worker's.
    session: Option<String>,
    seen_at: f64,
    wall_time: f64,
    method: String,
    url: String,
    resource_type: String,
    request_headers: Headers,
    /// What the request sent (`agent_browser_core::capture::request_body`): its text, or its bytes in base64 (`true`).
    post_data: Option<(String, bool)>,
    needs_post_data: bool,
    status: Option<i64>,
    status_text: String,
    http_version: String,
    mime_type: String,
    response_headers: Headers,
    redirect_url: String,
    body: Option<(String, bool)>,
    body_size: i64,
    /// Whether the headers really sent, and really received, have been matched to this hop.
    sent_known: bool,
    answer_known: bool,
    answered_at: Option<f64>,
    /// The page read the answer (or the request failed, or redirected): nothing more is coming.
    finished: bool,
    queued: bool,
}

/// The capture log and the requests it has yet to write.
#[derive(Default)]
pub struct Capture {
    pub log: Option<CaptureLog>,
    open: Vec<Hop>,
    hops_seen: HashMap<String, usize>,
    /// `Network.*ExtraInfo` reports waiting for the hop they belong to. They name only the chain and come as
    /// a stream of their own beside the main events, in hop order: the first report without a hop belongs to
    /// the first hop without a report.
    sent: HashMap<String, VecDeque<Headers>>,
    answered: HashMap<String, VecDeque<Headers>>,
    /// Socket and download lines made while draining, written at the next flush.
    lines: Vec<Value>,
    /// When the latest step the log records began: what has gone out since is what the step set off.
    step_at: f64,
}

impl Capture {
    /// Reads one DevTools event. Called for every event the daemon drains, whatever else handles it.
    pub fn on_event(&mut self, method: &str, params: &Value, session: Option<&str>) {
        if self.log.is_none() {
            return;
        }
        let id = params.get("requestId").and_then(Value::as_str).unwrap_or_default();
        match method {
            "Network.requestWillBeSent" => self.sent_event(id, params, session),
            "Network.requestWillBeSentExtraInfo" => {
                let headers = extra_info_headers(params.get("headers"));
                match self.open.iter_mut().find(|h| h.chain == id && !h.sent_known) {
                    Some(hop) => {
                        hop.request_headers = headers;
                        hop.sent_known = true;
                    }
                    None => self.sent.entry(id.to_string()).or_default().push_back(headers),
                }
            }
            "Network.responseReceivedExtraInfo" => {
                let headers = extra_info_headers(params.get("headers"));
                match self.open.iter_mut().find(|h| h.chain == id && h.status.is_some() && !h.answer_known) {
                    Some(hop) => {
                        hop.response_headers = headers;
                        hop.answer_known = true;
                    }
                    None => self.answered.entry(id.to_string()).or_default().push_back(headers),
                }
            }
            "Network.responseReceived" => {
                if let Some(response) = params.get("response") {
                    if let Some(kind) = params.get("type").and_then(Value::as_str) {
                        if let Some(hop) = self.last_hop(id) {
                            hop.resource_type = kind.to_string();
                        }
                    }
                    self.answer(id, response);
                }
            }
            "Network.loadingFinished" => {
                if let Some(hop) = self.last_hop(id) {
                    hop.finished = true;
                    if let Some(len) = params.get("encodedDataLength").and_then(Value::as_i64) {
                        hop.body_size = len;
                    }
                }
            }
            "Network.loadingFailed" => {
                if let Some(hop) = self.last_hop(id) {
                    hop.finished = true;
                    if hop.status.is_none() {
                        hop.status = Some(0);
                        hop.status_text = params.get("errorText").and_then(Value::as_str).unwrap_or("Failed").to_string();
                        hop.answer_known = true;
                    }
                }
            }
            "Browser.downloadWillBegin" | "Page.downloadWillBegin" => self.lines.extend(download_line(params)),
            _ => self.lines.extend(socket_line(method, params)),
        }
    }

    fn last_hop(&mut self, chain: &str) -> Option<&mut Hop> {
        self.open.iter_mut().rev().find(|h| h.chain == chain)
    }

    fn sent_event(&mut self, id: &str, params: &Value, session: Option<&str>) {
        let Some(request) = params.get("request") else { return };
        // A redirect is reported on the request that follows it: the hop before this one is answered by it.
        if let Some(redirect) = params.get("redirectResponse") {
            self.answer(id, redirect);
            if let Some(hop) = self.last_hop(id) {
                hop.finished = true;
                hop.redirect_url = request.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
            }
        }
        let n = self.hops_seen.entry(id.to_string()).or_default();
        *n += 1;
        let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let post_data = agent_browser_core::capture::request_body(request);
        let mut hop = Hop {
            key: format!("{id}#{n}"),
            chain: id.to_string(),
            session: session.map(String::from),
            seen_at: now_secs(),
            wall_time: params.get("wallTime").and_then(Value::as_f64).unwrap_or_default(),
            method: text(request, "method"),
            url: text(request, "url"),
            resource_type: text(params, "type"),
            request_headers: headers_of(request.get("headers")),
            needs_post_data: post_data.is_none() && request.get("hasPostData").and_then(Value::as_bool) == Some(true),
            post_data,
            ..Hop::default()
        };
        if let Some(headers) = self.sent.get_mut(id).and_then(VecDeque::pop_front) {
            hop.request_headers = headers;
            hop.sent_known = true;
        }
        if self.open.len() >= OPEN_LIMIT {
            let gone = self.open.remove(0);
            self.forget_chain_if_done(&gone.chain);
        }
        self.open.push(hop);
    }

    /// The last hop of `chain` has its answer: from the cache it has no reports coming, otherwise it takes
    /// what arrived ahead of its event.
    fn answer(&mut self, chain: &str, response: &Value) {
        let parked = self.answered.get_mut(chain).and_then(VecDeque::pop_front);
        let Some(hop) = self.open.iter_mut().rev().find(|h| h.chain == chain) else { return };
        hop.status = response.get("status").and_then(Value::as_i64);
        hop.status_text = response.get("statusText").and_then(Value::as_str).unwrap_or_default().to_string();
        hop.mime_type = response.get("mimeType").and_then(Value::as_str).unwrap_or_default().to_string();
        hop.http_version = response.get("protocol").and_then(Value::as_str).unwrap_or_default().to_string();
        hop.answered_at = Some(now_secs());
        if !hop.answer_known {
            hop.response_headers = headers_of(response.get("headers"));
        }
        let flag = |name: &str| response.get(name).and_then(Value::as_bool).unwrap_or(false);
        if flag("fromDiskCache") || flag("fromPrefetchCache") || flag("fromServiceWorker") {
            hop.sent_known = true;
            hop.answer_known = true;
            // Nothing was reported for it, so what was parked is the next hop's.
            if let Some(headers) = parked {
                self.answered.entry(chain.to_string()).or_default().push_front(headers);
            }
        } else if let (false, Some(headers)) = (hop.answer_known, parked) {
            hop.response_headers = headers;
            hop.answer_known = true;
        }
    }

    fn forget_chain_if_done(&mut self, chain: &str) {
        if !self.open.iter().any(|h| h.chain == chain) {
            self.hops_seen.remove(chain);
            self.sent.remove(chain);
            self.answered.remove(chain);
        }
    }
}

/// Opens the session's log on the first command when capture is configured. The secrets the log names are sealed
/// beside it with the browser's at-rest key, so a browser started again for the same session goes on naming them: a
/// log that names a secret is never reopened without its list, which would write that secret as it is.
pub fn ensure(state: &mut DaemonState) {
    if state.unbrowse.capture.log.is_none() && CaptureLog::configured_dir().is_some() {
        state.unbrowse.capture.log = CaptureLog::open_sealed(&state.session_id, sealer());
        if state.unbrowse.capture.log.is_none() {
            let _ = writeln!(std::io::stderr(), "[capture] the log of session {} names secrets this browser can't read back, so nothing is recorded", state.session_id);
        }
    }
}

/// Seals the log's list of secrets as AES-256-GCM under the key the browser keeps its saved logins with: a fresh
/// 12-byte nonce, then the ciphertext and its tag.
struct KeySealer(aes_gcm::Aes256Gcm);

impl agent_browser_core::capture::Sealer for KeySealer {
    fn seal(&self, plain: &[u8]) -> Option<Vec<u8>> {
        use aes_gcm::aead::Aead;
        let mut nonce = [0u8; 12];
        getrandom::getrandom(&mut nonce).ok()?;
        let mut out = nonce.to_vec();
        out.extend(self.0.encrypt(aes_gcm::Nonce::from_slice(&nonce), plain).ok()?);
        Some(out)
    }

    fn open(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        use aes_gcm::aead::Aead;
        let (nonce, body) = (sealed.get(..12)?, sealed.get(12..)?);
        self.0.decrypt(aes_gcm::Nonce::from_slice(nonce), body).ok()
    }
}

/// The sealer, from the browser's key (made, as a saved login makes it, when there is none yet).
fn sealer() -> Option<Box<dyn agent_browser_core::capture::Sealer>> {
    use aes_gcm::KeyInit;
    let key = super::super::auth::ensure_encryption_key().map_err(|e| eprintln!("[capture] the secrets this log names are kept in memory only: {e}")).ok()?;
    aes_gcm::Aes256Gcm::new_from_slice(&key).ok().map(|c| Box::new(KeySealer(c)) as Box<dyn agent_browser_core::capture::Sealer>)
}

/// Names in the log every value the node asked it to forget while another command held the daemon's state,
/// in what it already holds and from now on. Runs before anything else is written.
pub fn apply_queued(state: &mut DaemonState) {
    let values = state.unbrowse.busy.take_forgets();
    if values.is_empty() {
        return;
    }
    ensure(state);
    if let Some(log) = state.unbrowse.capture.log.as_mut() {
        for value in values {
            log.forget(&value);
        }
    }
}

/// The node names a value its learner found the site only checks (a code typed into a plain field), so the
/// log says the name, in what it already holds and from now on. `None` when `cmd` is another command.
pub fn forget(state: &mut DaemonState, cmd: &Value) -> Option<Result<Value, String>> {
    if cmd.get("action").and_then(Value::as_str) != Some("capture_forget") {
        return None;
    }
    ensure(state);
    Some(match (cmd.get("value").and_then(Value::as_str), state.unbrowse.capture.log.as_mut()) {
        (Some(value), Some(log)) => Ok(json!({ "named": log.forget(value) })),
        (None, _) => Err("capture_forget needs a value".to_string()),
        (_, None) => Ok(json!({ "named": null })),
    })
}

/// Fetches what Chrome holds back while it still has it (a body is dropped when the page navigates): the
/// body of each request that just finished, and the POST data Chrome left out of the event. Runs after
/// every drain, then writes what has settled.
pub async fn after_drain(state: &mut DaemonState) {
    if state.unbrowse.capture.log.is_none() {
        return;
    }
    if let Some(mgr) = state.browser.as_ref() {
        let client = mgr.client.clone();
        let active = mgr.active_session_id().ok().map(String::from);
        for hop in state.unbrowse.capture.open.iter_mut() {
            let Some(session) = hop.session.clone().or_else(|| active.clone()) else { continue };
            if hop.needs_post_data {
                // Asked once: an answer that says no won't change.
                hop.needs_post_data = false;
                let asked = client.send_command("Network.getRequestPostData", Some(json!({ "requestId": hop.chain })), Some(&session)).await;
                hop.post_data = asked.ok().and_then(|r| agent_browser_core::capture::held_back_body(&r));
            }
            if hop.finished && !hop.queued && hop.body.is_none() && hop.status.is_some_and(|s| s != 0) && hop.redirect_url.is_empty() && mime_is_text(&hop.mime_type) {
                let asked = client.send_command("Network.getResponseBody", Some(json!({ "requestId": hop.chain })), Some(&session)).await;
                if let Ok(said) = asked {
                    let body = said.get("body").and_then(Value::as_str).unwrap_or_default();
                    if body.len() <= BODY_LIMIT {
                        hop.body = Some((body.to_string(), said.get("base64Encoded").and_then(Value::as_bool).unwrap_or(false)));
                    }
                }
            }
        }
    }
    flush(state, false);
}

/// Writes the requests that have settled, or every answered one when `all` (the session is closing).
pub fn flush(state: &mut DaemonState, all: bool) {
    apply_queued(state);
    let pages = state.browser.as_ref().map(|b| b.pages_list()).unwrap_or_default();
    let capture = &mut state.unbrowse.capture;
    let Some(log) = capture.log.as_mut() else { return };
    for line in capture.lines.drain(..) {
        log.write(line);
    }
    let now = now_secs();
    for hop in capture.open.iter_mut().filter(|h| !h.queued) {
        let unread = hop.status.is_some() && hop.answered_at.is_some_and(|at| all || now - at >= UNREAD_WAIT_SECS);
        if hop.finished || unread {
            hop.queued = true;
            log.queue(&hop.key);
        }
    }
    let due = if all { log.drain_pending() } else { log.settled() };
    for key in due {
        let Some(at) = capture.open.iter().position(|h| h.key == key) else { continue };
        let hop = capture.open.remove(at);
        let mut line = json!({ "type": "exchange", "t": hop.seen_at, "resourceType": hop.resource_type });
        if let Some(tab) = tab_of_session(&pages, hop.session.as_deref()) {
            line["tab"] = json!(tab);
        }
        let chain = hop.chain.clone();
        line["entry"] = entry_json(hop);
        log.write(line);
        if !capture.open.iter().any(|h| h.chain == chain) {
            capture.hops_seen.remove(&chain);
            capture.sent.remove(&chain);
            capture.answered.remove(&chain);
        }
    }
    // What the latest step set off and isn't in the log yet: the page's own calls and pages sent since it, by when each
    // was sent and where to. A large answer is still coming long after a small one sent later is logged; a reader
    // waiting on the step reads it here. A call the page keeps open from before the step (a long poll) is not the step's.
    let step_at = capture.step_at;
    let open: Vec<(f64, String)> = capture
        .open
        .iter()
        .filter(|h| h.seen_at >= step_at && matches!(h.resource_type.as_str(), "Fetch" | "XHR" | "Document"))
        .filter_map(|h| Some((h.seen_at, url::Url::parse(&h.url).ok()?.host_str()?.to_string())))
        .collect();
    log.say_open(&open.iter().map(|(t, host)| (*t, host.as_str())).collect::<Vec<_>>());
}

/// The session is closing: everything answered is written, and the log is ended.
pub fn close(state: &mut DaemonState) {
    flush(state, true);
    if let Some(log) = state.unbrowse.capture.log.as_mut() {
        log.end();
    }
}

/// The label of the tab whose page a request was seen on, so a reader can tell one tab's requests from
/// another's in a log the site's tabs share. None for a frame's or a worker's session, or a tab with no label.
fn tab_of_session(pages: &[PageInfo], session: Option<&str>) -> Option<String> {
    let session = session?;
    pages.iter().find(|p| p.session_id == session).and_then(|p| p.label.clone())
}

/// A request as a HAR 1.2 entry.
fn entry_json(h: Hop) -> Value {
    let pairs = |headers: &Headers| headers.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect::<Vec<_>>();
    let header = |headers: &Headers, name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    let cookie = |pair: &str| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        json!({ "name": name.trim(), "value": value.trim() })
    };
    let request_cookies: Vec<Value> = header(&h.request_headers, "cookie").map(|c| c.split(';').map(cookie).collect()).unwrap_or_default();
    let response_cookies: Vec<Value> = h
        .response_headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
        .map(|(_, v)| cookie(v.split(';').next().unwrap_or_default()))
        .collect();
    let query: Vec<Value> = url::Url::parse(&h.url)
        .map(|u| u.query_pairs().map(|(k, v)| json!({ "name": k, "value": v })).collect())
        .unwrap_or_default();
    let mut request = json!({
        "method": h.method,
        "url": h.url,
        "httpVersion": h.http_version,
        "cookies": request_cookies,
        "headers": pairs(&h.request_headers),
        "queryString": query,
        "headersSize": -1,
        "bodySize": h.post_data.as_ref().map_or(0, |(body, base64)| if *base64 { body.len() / 4 * 3 - body.bytes().rev().take_while(|b| *b == b'=').count() } else { body.len() }),
    });
    if let Some((body, base64)) = &h.post_data {
        let kind = header(&h.request_headers, "content-type").unwrap_or_else(|| "text/plain".to_string());
        request["postData"] = json!({ "mimeType": kind, "text": body });
        // Bytes that are no text, in base64, said as the engine's own walk says it (`HarPostData`'s `_encoding`).
        if *base64 {
            request["postData"]["_encoding"] = json!("base64");
        }
    }
    let mime = if h.mime_type.is_empty() { "application/octet-stream" } else { h.mime_type.as_str() };
    let mut content = json!({ "size": h.body_size, "mimeType": mime });
    if let Some((body, base64)) = &h.body {
        content["text"] = json!(body);
        if *base64 {
            content["encoding"] = json!("base64");
        }
    }
    json!({
        "startedDateTime": started(h.wall_time),
        "time": h.answered_at.map_or(0.0, |at| ((at - h.seen_at) * 1000.0).max(0.0)),
        "request": request,
        "response": {
            "status": h.status.unwrap_or(0),
            "statusText": h.status_text,
            "httpVersion": h.http_version,
            "cookies": response_cookies,
            "headers": pairs(&h.response_headers),
            "content": content,
            "redirectURL": h.redirect_url,
            "headersSize": -1,
            "bodySize": h.body_size,
        },
        "cache": {},
        "timings": { "send": 0, "wait": 0, "receive": 0 },
        "_resourceType": h.resource_type,
    })
}

/// Seconds since the Unix epoch as an RFC 3339 time, to the millisecond, in UTC.
fn started(wall_time: f64) -> String {
    let millis = (wall_time * 1000.0).max(0.0) as u64;
    let (days, rest) = (millis / 86_400_000, millis % 86_400_000);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (day, month) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s, ms) = (rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{ms:03}Z")
}

/// A DevTools headers object as pairs, in the order given.
fn headers_of(headers: Option<&Value>) -> Headers {
    let Some(map) = headers.and_then(Value::as_object) else { return Vec::new() };
    map.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect()
}

/// Headers from a `Network.*ExtraInfo` event: repeated headers such as `Set-Cookie` arrive joined by
/// newlines and are split back into one pair each; HTTP/2 pseudo-headers are dropped.
fn extra_info_headers(headers: Option<&Value>) -> Headers {
    headers_of(headers)
        .into_iter()
        .filter(|(k, _)| !k.starts_with(':'))
        .flat_map(|(k, v)| v.split('\n').map(|line| (k.clone(), line.to_string())).collect::<Vec<_>>())
        .collect()
}

/// Whether a body of this type is text a route could read: data and documents, not pictures or media.
fn mime_is_text(mime: &str) -> bool {
    let mime = mime.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    mime.starts_with("text/")
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
        || matches!(
            mime.as_str(),
            "application/json" | "application/xml" | "application/javascript" | "application/x-javascript" | "application/x-www-form-urlencoded" | "application/graphql" | "application/x-ndjson" | "image/svg+xml"
        )
}

/// Logs a page-driving action, stamped with the moment before it runs. For typed text, also whether the
/// field is a password, one-time code or card field; such a value is written as its name (`secret:<n>`, or
/// the vault reference the node filled it from), never as typed. For `fill`, `type` and `select` the line is
/// handed back to be written when the command succeeds ([`log_done`]), so a fill aimed at a field that
/// wasn't there never reads as typed. Every other action is written at once.
pub async fn log_action(state: &mut DaemonState, action: &str, cmd: &Value) -> Option<Value> {
    ensure(state);
    flush(state, false);
    state.unbrowse.capture.log.as_ref()?;
    // Before a line is held back or skipped: a command the log doesn't record still sends what it carries.
    for (value, name) in credentials_carried(action, cmd) {
        name_secret(state, &value, &name);
    }
    // A one-time code the node fills beside a login is named as the login's code.
    if let (Some(code), Some(log)) = (cmd.get("code").and_then(Value::as_str).filter(|_| action == "fill"), state.unbrowse.capture.log.as_mut()) {
        log.keep_secret(code, cmd.get("codeAs").and_then(Value::as_str));
    }
    // A login the node fills from its vault comes with its reference (`as`), which the log says instead of
    // the password. Agents can't send one: it isn't a flag the CLI parses, only a field the node puts on the request.
    let named = cmd.get("as").and_then(Value::as_str).filter(|_| matches!(action, "fill" | "type"));
    let typing = typed_text(action, cmd);
    let secret = match typing {
        _ if named.is_some() => true,
        Some((_, field)) => field_is_secret(state, field).await,
        None => false,
    };
    if let (true, Some((text, _)), Some(log)) = (secret, typing, state.unbrowse.capture.log.as_mut()) {
        log.keep_secret(text, named);
    }
    if !LOGGED_ACTIONS.contains(&action) {
        return None;
    }
    let selector = cmd.get("selector").and_then(Value::as_str);
    let value = match action {
        "fill" => cmd.get("value").cloned(),
        "type" | "keyboard" => cmd.get("text").cloned(),
        // A select is logged by what it sends: the chosen options' values, which a page's label need not say.
        "select" => match selector {
            Some(sel) => Some(option_values(state, sel, cmd.get("values").cloned().unwrap_or(Value::Null)).await),
            None => cmd.get("values").cloned(),
        },
        "press" => cmd.get("key").cloned(),
        "navigate" => cmd.get("url").cloned(),
        _ => None,
    };
    let t = now_secs();
    state.unbrowse.capture.step_at = t;
    // The field's own name, so routes name inputs the way a person would, not by CSS selector.
    let field = match (action, selector) {
        ("fill" | "type" | "select", Some(sel)) => on_element(state, sel, FIELD_NAME, None).await.and_then(|v| v.as_str().map(String::from)).filter(|s| !s.is_empty()),
        _ => None,
    };
    // A choice made by a click is the caller's value as much as text they typed: a radio or a box that a
    // form sends by its name and its value. The step is logged with both, as a fill is.
    let chosen = match (action, selector) {
        ("click" | "check", Some(sel)) => on_element(state, sel, CHOSEN_CONTROL, None).await.and_then(|v| {
            let pair = v.as_array()?;
            Some((pair.first()?.as_str()?.to_string(), pair.get(1)?.as_str()?.to_string())).filter(|(name, _)| !name.is_empty())
        }),
        _ => None,
    };
    let (field, value) = match chosen {
        Some((name, sent)) => (Some(name), Some(Value::String(sent))),
        None => (field, value),
    };
    // What finds the element again on a later visit: a snapshot's ref names it for that snapshot alone.
    let locator = match selector {
        Some(sel) if STEPS_ON_AN_ELEMENT.contains(&action) => on_element(state, sel, UNIQUE_SELECTOR, None).await.and_then(|v| v.as_str().map(String::from)),
        _ => None,
    };
    let line = submitted(json!({ "type": "action", "t": t, "action": action, "selector": selector, "field": field, "locator": locator, "value": value, "secret": secret }), cmd);
    if matches!(action, "fill" | "type" | "select") {
        return Some(line);
    }
    if let Some(log) = state.unbrowse.capture.log.as_mut() {
        log.write(line);
    }
    None
}

/// An action's log `line`, marked `submit` when its command submits its field's form itself (a vault login's one step,
/// `fill` with `submit`): no click or key after it sends the form, so the learner takes the fill as the step that did.
fn submitted(mut line: Value, cmd: &Value) -> Value {
    if cmd.get("submit").and_then(Value::as_bool) == Some(true) {
        line["submit"] = json!(true);
    }
    line
}

/// Writes a typed action [`log_action`] held back, once its command succeeded.
pub fn log_done(state: &mut DaemonState, line: Option<Value>) {
    if let (Some(line), Some(log)) = (line, state.unbrowse.capture.log.as_mut()) {
        log.write(line);
    }
}

/// Says `name` instead of `value` from now on, in every line the log writes.
pub fn name_secret(state: &mut DaemonState, value: &str, name: &str) {
    if let Some(log) = state.unbrowse.capture.log.as_mut() {
        log.keep_secret(value, Some(name));
    }
}

/// The text a command types on the page, and the field it names: none means whatever has the focus.
fn typed_text<'a>(action: &str, cmd: &'a Value) -> Option<(&'a str, Option<&'a str>)> {
    let text = match action {
        "fill" | "setvalue" => cmd.get("value"),
        "type" | "keyboard" | "inserttext" => cmd.get("text"),
        _ => None,
    };
    Some((text?.as_str()?, cmd.get("selector").and_then(Value::as_str)))
}

/// The credentials a command carries, each with the name the log says instead: a `password` on any command,
/// and the form HTTP Basic sends it in, which is what a request's headers then carry.
fn credentials_carried(action: &str, cmd: &Value) -> Vec<(String, String)> {
    let Some(password) = cmd.get("password").and_then(Value::as_str) else { return Vec::new() };
    let username = cmd.get("username").and_then(Value::as_str).unwrap_or_default();
    let who = cmd.get("name").and_then(Value::as_str).unwrap_or(username);
    let mut carried = vec![(password.to_string(), format!("secret:{action}:{who}"))];
    if action == "credentials" {
        let basic = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, format!("{username}:{password}"));
        carried.push((basic, format!("secret:basic:{who}")));
    }
    carried
}

/// The steps the node can take again by themselves.
const STEPS_ON_AN_ELEMENT: &[&str] = &["click", "fill", "type", "select", "check", "uncheck"];

/// Finds the first selector that names only this element, from what lasts about it: an id a person wrote,
/// its name, a test id or label, where a link goes, what a button does. An id a page's code made up changes
/// between loads, so one holding a number or a colon is passed over. With nothing else, its place on the
/// page stands.
const UNIQUE_SELECTOR: &str = r#"function() {
  const doc = this.ownerDocument, tag = this.tagName.toLowerCase();
  const one = (s) => { try { const f = doc.querySelectorAll(s); return f.length === 1 && f[0] === this; } catch (e) { return false; } };
  const quoted = (v) => '"' + String(v).replace(/["\\]/g, '\\$&') + '"';
  const made = (v) => /[\d:]/.test(v);
  const tries = [];
  if (this.id && !made(this.id)) tries.push('#' + CSS.escape(this.id));
  for (const a of ['name', 'data-testid', 'data-test', 'aria-label', 'autocomplete']) {
    const v = this.getAttribute(a);
    if (v) tries.push(tag + '[' + a + '=' + quoted(v) + ']');
  }
  const href = this.getAttribute('href');
  if (href) tries.push(tag + '[href=' + quoted(href) + ']');
  const type = this.getAttribute('type');
  if (type) tries.push(tag + '[type=' + quoted(type) + ']');
  const value = this.getAttribute('value');
  if (value && tag === 'input') tries.push(tag + '[value=' + quoted(value) + ']');
  const classes = [...this.classList].filter((c) => !made(c)).map((c) => CSS.escape(c));
  if (classes.length) tries.push(tag + '.' + classes.join('.'));
  tries.push('form ' + tag, tag);
  const path = [];
  for (let e = this; e && e !== doc.body && e.parentElement; e = e.parentElement) {
    if (e !== this && e.id && !made(e.id)) { path.unshift('#' + CSS.escape(e.id)); break; }
    const same = [...e.parentElement.children].filter((c) => c.tagName === e.tagName);
    path.unshift(e.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(e) + 1) + ')' : ''));
  }
  tries.push((path[0] && path[0][0] === '#' ? '' : 'body > ') + path.join(' > '));
  return tries.find(one) || null;
}"#;

/// The name and the value a form sends for a control a click chooses: a radio or a checkbox with a name, or
/// the label that stands for one.
const CHOSEN_CONTROL: &str = "function() { \
    const of = (e) => e && e.tagName === 'INPUT' && (e.type === 'radio' || e.type === 'checkbox') && e.name ? e : null; \
    const e = of(this) || of(this.control) || (this.querySelector ? of(this.querySelector('input[type=radio], input[type=checkbox]')) : null); \
    return e ? [String(e.name).slice(0, 80), String(e.value).slice(0, 200)] : null; }";

/// The field's identity, in the order a person would read it: `name`, `id`, `aria-label`, its label's text,
/// its placeholder.
const FIELD_NAME: &str = "function() { const read = (s) => (s || '').trim().slice(0, 80); \
    const label = (this.labels && this.labels[0]) ? this.labels[0].innerText : ''; \
    return read(this.name) || read(this.id) || read(this.getAttribute('aria-label')) || read(label) || read(this.placeholder); }";

/// The values a select sends for the options chosen, each by its value or its text.
const OPTION_VALUES: &str = "function(chosen) { const all = Array.isArray(chosen) ? chosen : [chosen]; \
    const opts = this.options ? Array.from(this.options) : []; \
    return all.map((c) => { const s = String(c); const o = opts.find((o) => o.value === s) || opts.find((o) => (o.text || '').trim() === s.trim() || o.label === s); return o ? o.value : s; }); }";

/// What makes a field's value a secret, read from the field.
const SECRET_FIELD: &str = "(e) => { const a = (e.autocomplete || '').toLowerCase(); \
    return e.type === 'password' || a.includes('password') || a === 'one-time-code' || a.startsWith('cc-'); }";

/// Calls `function` on the element at `selector` and gives back what it returned. None when the element
/// can't be found: in a frame or a shadow root the document can't reach, or gone.
async fn on_element(state: &DaemonState, selector: &str, function: &str, argument: Option<Value>) -> Option<Value> {
    let mgr = state.browser.as_ref()?;
    let session_id = mgr.active_session_id().ok()?;
    let (object_id, sid) = super::super::element::resolve_element_object_id(&mgr.client, session_id, &state.ref_map, selector, &state.iframe_sessions).await.ok()?;
    let mut params = json!({ "objectId": object_id, "functionDeclaration": function, "returnByValue": true });
    if let Some(argument) = argument {
        params["arguments"] = json!([{ "value": argument }]);
    }
    let said = mgr.client.send_command("Runtime.callFunctionOn", Some(params), Some(&sid)).await.ok()?;
    said.get("result")?.get("value").cloned()
}

async fn option_values(state: &DaemonState, selector: &str, chosen: Value) -> Value {
    on_element(state, selector, OPTION_VALUES, Some(chosen.clone())).await.filter(Value::is_array).unwrap_or(chosen)
}

/// Whether a field is the kind whose value is secret. Reads the field named, or with none the one with the
/// focus: typing with no selector goes wherever the focus is, in the page or in a frame of it.
async fn field_is_secret(state: &DaemonState, selector: Option<&str>) -> bool {
    if let Some(selector) = selector {
        let check = format!("function() {{ return ({SECRET_FIELD})(this); }}");
        return on_element(state, selector, &check, None).await.and_then(|v| v.as_bool()).unwrap_or(false);
    }
    let Some(mgr) = state.browser.as_ref() else { return false };
    let Ok(session_id) = mgr.active_session_id() else { return false };
    let focused = format!(
        "(() => {{ let e = document.activeElement; for (;;) {{ \
         const inner = e && (e.shadowRoot ? e.shadowRoot.activeElement : e.contentDocument ? e.contentDocument.activeElement : null); \
         if (!inner) break; e = inner; }} return !!e && ({SECRET_FIELD})(e); }})()"
    );
    for sid in std::iter::once(session_id).chain(state.active_iframe_sessions.iter().map(String::as_str)) {
        let read = mgr.client.send_command("Runtime.evaluate", Some(json!({ "expression": focused, "returnByValue": true })), Some(sid));
        if read.await.ok().and_then(|r| r.get("result")?.get("value")?.as_bool()).unwrap_or(false) {
            return true;
        }
    }
    false
}

/// One of a page's socket events as a capture line: the socket's address when it opens, the headers it
/// opened with and was answered with, and each frame sent or received with its text.
fn socket_line(method: &str, params: &Value) -> Option<Value> {
    let id = params.get("requestId").and_then(Value::as_str)?;
    let t = now_secs();
    let headers = |v: Option<&Value>| v.cloned().unwrap_or(Value::Null);
    let frame = |dir: &str| {
        let r = params.get("response")?;
        let opcode = r.get("opcode").and_then(Value::as_u64).unwrap_or(1);
        let data: String = r.get("payloadData").and_then(Value::as_str).unwrap_or_default().chars().take(FRAME_LIMIT).collect();
        Some(json!({ "type": "socket", "t": t, "id": id, "event": dir, "opcode": opcode, "data": data }))
    };
    match method {
        "Network.webSocketCreated" => Some(json!({ "type": "socket", "t": t, "id": id, "event": "open", "url": params.get("url").cloned().unwrap_or(Value::Null) })),
        "Network.webSocketWillSendHandshakeRequest" => {
            Some(json!({ "type": "socket", "t": t, "id": id, "event": "handshake", "headers": headers(params.pointer("/request/headers")) }))
        }
        "Network.webSocketHandshakeResponseReceived" => Some(json!({
            "type": "socket", "t": t, "id": id, "event": "accepted",
            "status": params.pointer("/response/status").cloned().unwrap_or(Value::Null),
            "headers": headers(params.pointer("/response/headers")),
        })),
        "Network.webSocketFrameSent" => frame("sent"),
        "Network.webSocketFrameReceived" => frame("received"),
        "Network.webSocketClosed" => Some(json!({ "type": "socket", "t": t, "id": id, "event": "closed" })),
        _ => None,
    }
}

/// A download the page started: the file's address and the name the browser will save it under. The
/// browser never finishes loading a download as an answer, so no exchange is written for one.
fn download_line(params: &Value) -> Option<Value> {
    let url = params.get("url").and_then(Value::as_str)?;
    let name = params.get("suggestedFilename").and_then(Value::as_str).unwrap_or_default();
    Some(json!({ "type": "download", "t": now_secs(), "url": url, "name": name }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture_in(dir: &std::path::Path) -> Capture {
        Capture { log: CaptureLog::open_in(dir, "walk"), ..Capture::default() }
    }

    fn written(state: &mut DaemonState, dir: &std::path::Path) -> Vec<Value> {
        flush(state, true);
        std::fs::read_to_string(dir.join("walk.jsonl")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn header<'a>(entry: &'a Value, side: &str, name: &str) -> Vec<&'a str> {
        let all = entry[side]["headers"].as_array().unwrap();
        all.iter().filter(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))).filter_map(|h| h["value"].as_str()).collect()
    }

    /// The cookies a request really sent and was really given come from the extra reports, whichever side of
    /// the main events they arrive on.
    #[test]
    fn a_request_is_written_with_the_cookies_really_sent_and_set() {
        for extras_first in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let mut state = DaemonState::new();
            state.unbrowse.capture = capture_in(dir.path());
            let c = &mut state.unbrowse.capture;
            let extras = |c: &mut Capture| {
                c.on_event("Network.requestWillBeSentExtraInfo", &json!({ "requestId": "r", "headers": { "Cookie": "sid=1", ":path": "/cart" } }), None);
                c.on_event("Network.responseReceivedExtraInfo", &json!({ "requestId": "r", "headers": { "Set-Cookie": "a=1; Path=/\nb=2" } }), None);
            };
            if extras_first {
                extras(c);
            }
            c.on_event("Network.requestWillBeSent", &json!({ "requestId": "r", "type": "XHR", "request": { "method": "POST", "url": "https://shop.example/cart?x=1", "headers": { "Accept": "*/*" }, "postData": "qty=2" } }), Some("s"));
            c.on_event("Network.responseReceived", &json!({ "requestId": "r", "type": "XHR", "response": { "status": 200, "mimeType": "application/json", "headers": { "Content-Type": "application/json" } } }), Some("s"));
            if !extras_first {
                extras(c);
            }
            c.on_event("Network.loadingFinished", &json!({ "requestId": "r", "encodedDataLength": 12 }), Some("s"));
            let lines = written(&mut state, dir.path());
            assert_eq!(lines.len(), 1, "{lines:?}");
            let (line, entry) = (&lines[0], &lines[0]["entry"]);
            assert_eq!((line["type"].as_str(), line["resourceType"].as_str()), (Some("exchange"), Some("XHR")));
            assert_eq!(header(entry, "request", "cookie"), ["sid=1"], "extras first: {extras_first}");
            assert!(header(entry, "request", ":path").is_empty());
            assert_eq!(header(entry, "response", "set-cookie"), ["a=1; Path=/", "b=2"]);
            assert_eq!(entry["request"]["postData"]["text"], "qty=2");
            assert_eq!(entry["response"]["status"], 200);
        }
    }

    /// A page that compresses what it sends (its `content-encoding` says so) sends bytes that are no text. Chrome's
    /// `postData` reads those as one character a byte, which is not what was sent; the parts Chrome gives are, and the
    /// walk keeps them, in base64, said so.
    #[test]
    fn a_body_of_bytes_is_written_as_the_bytes_the_page_sent() {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let sent: Vec<u8> = vec![0x1f, 0x8b, 0x08, 0x00, 0x98, 0xcc, 0x00, 0xed, 0xe1];
        let as_one_char_a_byte: String = sent.iter().map(|b| *b as char).collect();
        let dir = tempfile::tempdir().unwrap();
        let mut state = DaemonState::new();
        state.unbrowse.capture = capture_in(dir.path());
        let c = &mut state.unbrowse.capture;
        c.on_event("Network.requestWillBeSent", &json!({ "requestId": "z", "type": "Fetch", "request": { "method": "POST", "url": "https://shop.example/api/search", "headers": { "Content-Type": "application/json", "Content-Encoding": "gzip" }, "postData": as_one_char_a_byte, "postDataEntries": [{ "bytes": b64.encode(&sent) }], "hasPostData": true } }), Some("s"));
        c.on_event("Network.responseReceived", &json!({ "requestId": "z", "type": "Fetch", "response": { "status": 200, "mimeType": "application/json", "headers": {} } }), Some("s"));
        c.on_event("Network.loadingFinished", &json!({ "requestId": "z", "encodedDataLength": 2 }), Some("s"));
        let lines = written(&mut state, dir.path());
        let post = &lines[0]["entry"]["request"]["postData"];
        assert_eq!(post["_encoding"], "base64", "{post}");
        assert_eq!(b64.decode(post["text"].as_str().unwrap()).unwrap(), sent);
        assert_eq!(lines[0]["entry"]["request"]["bodySize"], sent.len());
    }

    /// What the latest step set off and isn't in the log yet is said beside it (`walk.open`): a call the page sent
    /// after the step, by when and where to, until its answer is written. A call open from before the step (a long
    /// poll) and a picture are not the step's to wait for.
    #[test]
    fn a_call_the_step_set_off_is_said_until_it_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = DaemonState::new();
        state.unbrowse.capture = capture_in(dir.path());
        let sent = |c: &mut Capture, id: &str, kind: &str, url: &str| {
            c.on_event("Network.requestWillBeSent", &json!({ "requestId": id, "type": kind, "request": { "method": "GET", "url": url, "headers": {} } }), Some("s"));
        };
        sent(&mut state.unbrowse.capture, "poll", "XHR", "https://www.shop.example/live/poll");
        state.unbrowse.capture.step_at = now_secs();
        sent(&mut state.unbrowse.capture, "search", "Fetch", "https://www.shop.example/api/search?q=lamp");
        sent(&mut state.unbrowse.capture, "pic", "Image", "https://img.shop.example/lamp.jpg");
        flush(&mut state, false);
        let said = std::fs::read_to_string(dir.path().join("walk.open")).unwrap();
        let hosts: Vec<&str> = said.lines().filter_map(|l| l.split_once(' ').map(|(_, h)| h)).collect();
        assert_eq!(hosts, ["www.shop.example"], "only the step's own call: {said}");
        let c = &mut state.unbrowse.capture;
        c.on_event("Network.responseReceived", &json!({ "requestId": "search", "type": "Fetch", "response": { "status": 200, "mimeType": "application/json", "headers": {} } }), Some("s"));
        c.on_event("Network.loadingFinished", &json!({ "requestId": "search", "encodedDataLength": 2 }), Some("s"));
        let lines = written(&mut state, dir.path());
        assert!(lines.iter().any(|l| l["entry"]["request"]["url"].as_str().is_some_and(|u| u.contains("/api/search"))));
        assert_eq!(std::fs::read_to_string(dir.path().join("walk.open")).unwrap(), "", "written, it is no longer coming");
    }

    /// A body Chrome held back from the event comes from `Network.getRequestPostData`, in base64 when it says so, and
    /// is kept as the engine keeps one: as bytes where it is no text, as text where it is.
    #[test]
    fn a_held_back_body_is_kept_as_its_bytes() {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let bytes = [0x1f, 0x8b, 0x08, 0x00, 0x98];
        assert_eq!(agent_browser_core::capture::held_back_body(&json!({ "postData": b64.encode(bytes), "base64Encoded": true })), Some((b64.encode(bytes), true)));
        assert_eq!(agent_browser_core::capture::held_back_body(&json!({ "postData": b64.encode("q=lamp"), "base64Encoded": true })), Some(("q=lamp".to_string(), false)));
        assert_eq!(agent_browser_core::capture::held_back_body(&json!({ "postData": "q=lamp" })), Some(("q=lamp".to_string(), false)), "an answer from an older Chrome reads as it did");
    }

    /// Each hop of a redirect is its own line, with its own cookies, in the order the hops were made.
    #[test]
    fn each_hop_of_a_redirect_is_written_with_its_own_headers() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = DaemonState::new();
        state.unbrowse.capture = capture_in(dir.path());
        let c = &mut state.unbrowse.capture;
        let sent = |url: &str, redirect: Option<i64>| {
            let mut p = json!({ "requestId": "r", "type": "Document", "request": { "method": "GET", "url": url, "headers": {} } });
            if let Some(status) = redirect {
                p["redirectResponse"] = json!({ "status": status, "headers": {} });
            }
            p
        };
        c.on_event("Network.requestWillBeSent", &sent("https://a.example/in", None), None);
        c.on_event("Network.requestWillBeSent", &sent("https://a.example/home", Some(302)), None);
        for hop in ["one", "two"] {
            c.on_event("Network.requestWillBeSentExtraInfo", &json!({ "requestId": "r", "headers": { "Cookie": format!("hop={hop}") } }), None);
            c.on_event("Network.responseReceivedExtraInfo", &json!({ "requestId": "r", "headers": { "Set-Cookie": format!("from={hop}") } }), None);
        }
        c.on_event("Network.responseReceived", &json!({ "requestId": "r", "response": { "status": 200, "mimeType": "text/html", "headers": {} } }), None);
        c.on_event("Network.loadingFinished", &json!({ "requestId": "r" }), None);
        let lines = written(&mut state, dir.path());
        let got: Vec<_> = lines.iter().map(|l| (l["entry"]["response"]["status"].as_i64().unwrap(), header(&l["entry"], "request", "cookie")[0].to_string(), header(&l["entry"], "response", "set-cookie")[0].to_string())).collect();
        assert_eq!(got, [(302, "hop=one".to_string(), "from=one".to_string()), (200, "hop=two".to_string(), "from=two".to_string())]);
        assert_eq!(lines[0]["entry"]["response"]["redirectURL"], "https://a.example/home");
    }

    /// A call whose answer nobody read is written as the session closes; one with no answer is not a call that happened.
    #[test]
    fn an_answer_nobody_read_is_still_written_and_an_unanswered_call_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = DaemonState::new();
        state.unbrowse.capture = capture_in(dir.path());
        let c = &mut state.unbrowse.capture;
        for id in ["answered", "in-flight"] {
            c.on_event("Network.requestWillBeSent", &json!({ "requestId": id, "request": { "method": "POST", "url": format!("https://a.example/{id}"), "headers": {} } }), None);
        }
        c.on_event("Network.responseReceived", &json!({ "requestId": "answered", "response": { "status": 204, "headers": {} } }), None);
        let lines = written(&mut state, dir.path());
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0]["entry"]["request"]["url"], "https://a.example/answered");
        assert!(written(&mut state, dir.path()).len() == 1, "written once");
    }

    /// A socket's frames and a download are lines of their own; an event naming neither writes nothing.
    #[test]
    fn socket_frames_and_downloads_are_capture_lines() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = DaemonState::new();
        state.unbrowse.capture = capture_in(dir.path());
        let c = &mut state.unbrowse.capture;
        c.on_event("Network.webSocketCreated", &json!({ "requestId": "w", "url": "wss://chat.example/s" }), None);
        c.on_event("Network.webSocketFrameSent", &json!({ "requestId": "w", "response": { "opcode": 1, "payloadData": "hi" } }), None);
        c.on_event("Page.downloadWillBegin", &json!({ "guid": "g", "url": "https://files.example/q3", "suggestedFilename": "q3.pdf" }), None);
        c.on_event("Page.frameNavigated", &json!({ "requestId": "w" }), None);
        let lines = written(&mut state, dir.path());
        let kinds: Vec<_> = lines.iter().map(|l| (l["type"].as_str().unwrap(), l["event"].as_str().or(l["name"].as_str()).unwrap())).collect();
        assert_eq!(kinds, [("socket", "open"), ("socket", "sent"), ("download", "q3.pdf")]);
        assert_eq!(lines[1]["data"], "hi");
    }

    /// A password is a credential on whichever command brings it, and HTTP Basic's is carried in the form its header sends.
    #[test]
    fn a_password_is_named_on_any_command_that_carries_it() {
        let saved = credentials_carried("auth_save", &json!({ "name": "shop", "username": "me", "password": "pw" }));
        assert_eq!(saved, [("pw".to_string(), "secret:auth_save:shop".to_string())]);
        let basic = credentials_carried("credentials", &json!({ "username": "me", "password": "pw" }));
        assert_eq!(basic[1], ("bWU6cHc=".to_string(), "secret:basic:me".to_string()));
        assert!(credentials_carried("fill", &json!({ "value": "pw" })).is_empty(), "a typed value is judged by its field");
    }

    /// Every command that types text is read for where it goes: with no selector, that is the focused field.
    #[test]
    fn text_is_read_from_every_command_that_types() {
        assert_eq!(typed_text("setvalue", &json!({ "selector": "#a", "value": "v" })), Some(("v", Some("#a"))));
        assert_eq!(typed_text("keyboard", &json!({ "subaction": "type", "text": "v" })), Some(("v", None)));
        assert_eq!(typed_text("click", &json!({ "selector": "#a" })), None);
    }

    /// A browser started again for a session whose log already names a secret goes on writing it, naming the secret,
    /// because the list of what it names is sealed beside the log: never unsealed in the file, never a log gone quiet.
    #[test]
    fn a_fill_that_submits_its_form_says_so_in_its_line() {
        let line = || json!({ "type": "action", "action": "fill", "secret": true });
        assert_eq!(submitted(line(), &json!({ "action": "fill", "submit": true }))["submit"], json!(true));
        for cmd in [json!({ "action": "fill" }), json!({ "action": "fill", "submit": false }), json!({ "action": "fill", "submit": "yes" })] {
            assert!(submitted(line(), &cmd).get("submit").is_none(), "{cmd}");
        }
    }

    #[test]
    fn a_restarted_browser_goes_on_naming_what_the_log_named() {
        use aes_gcm::KeyInit;
        let dir = tempfile::tempdir().unwrap();
        let seal = || Some(Box::new(KeySealer(aes_gcm::Aes256Gcm::new_from_slice(&[7u8; 32]).unwrap())) as Box<dyn agent_browser_core::capture::Sealer>);
        let mut first = CaptureLog::open_in_sealed(dir.path(), "s", seal()).unwrap();
        first.keep_secret("correct-horse-battery", Some("vault:a.example:me"));
        first.write(json!({ "type": "action", "action": "fill", "value": "correct-horse-battery" }));
        drop(first);
        assert!(CaptureLog::open_in(dir.path(), "s").is_none(), "without the list, nothing is written");
        let mut again = CaptureLog::open_in_sealed(dir.path(), "s", seal()).expect("the list is read back");
        again.write(json!({ "type": "exchange", "entry": { "request": { "postData": { "text": "pw=correct-horse-battery" } } } }));
        let text = std::fs::read_to_string(dir.path().join("s.jsonl")).unwrap();
        assert_eq!(text.lines().count(), 2, "{text}");
        assert!(!text.contains("correct-horse") && text.contains("pw=vault:a.example:me"), "{text}");
    }

    #[test]
    fn a_request_starts_at_the_time_chrome_gave_it() {
        assert_eq!(started(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(started(1_795_219_200.25), "2026-11-21T00:00:00.250Z");
    }
}
