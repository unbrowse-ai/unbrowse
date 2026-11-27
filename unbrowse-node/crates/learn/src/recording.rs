//! A walk as the learner holds it (`learn.record`): the trace, the scripts by hash, the storage and the sockets.
//!
//! The engine's capture says which code sent each request (its initiator), lists every script the page parsed with
//! the sha256 of its body (kept once per hash), and holds each origin's storage when the page settled and when the
//! walk ended. What sent a request is kept here, beside the trace, not on its exchanges: the trace is what the
//! learner has always read, and a recording adds to it without changing it. A recording reads all of it from either log the browser writes: the walk's own
//! (`request`/`response` lines, paired by the engine) or the sidecar's (`exchange` lines). A log written before any of
//! this reads as it did, with no scripts, no storage and no initiators.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::blobs::{sha256_hex, BlobError, Blobs};
use crate::session::{Session, SocketEvent};
use crate::trace::{Exchange, Trace, TraceError};

/// What sent a request, as the walk recorded it (`learn.record`): what kind of thing (`parser`, `script`,
/// `preflight`, `other`), where a parser met it, and for a script the stack it was sent from and each async hop that
/// stack was scheduled from.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, Deserialize)]
pub struct Initiator {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub line: Option<u64>,
    #[serde(default)]
    pub column: Option<u64>,
    /// The stack the request was sent from, innermost first.
    #[serde(default)]
    pub frames: Vec<StackFrame>,
    /// The stacks it was scheduled from (an `await`, a timer, a promise), nearest first.
    #[serde(default)]
    pub parents: Vec<AsyncHop>,
}

/// One frame of a stack: the script (by the id the walk listed it under), its url, the function, and the place in it
/// (zero-based line and column).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, Deserialize)]
pub struct StackFrame {
    #[serde(rename = "scriptId", default)]
    pub script_id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub function: String,
    #[serde(default)]
    pub line: u64,
    #[serde(default)]
    pub column: u64,
}

/// An async hop of a stack: what scheduled it (`await`, `setTimeout`, `Promise.then`) and its frames.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, Deserialize)]
pub struct AsyncHop {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub frames: Vec<StackFrame>,
}

impl Initiator {
    /// Every frame of the stack, the request's own first, then each hop's in order.
    pub fn all_frames(&self) -> impl Iterator<Item = &StackFrame> {
        self.frames.iter().chain(self.parents.iter().flat_map(|h| h.frames.iter()))
    }

    /// The frame that sent the request: the innermost one that is in a script (a frame of the browser's own has no
    /// script id).
    pub fn sender(&self) -> Option<&StackFrame> {
        self.all_frames().find(|f| !f.script_id.is_empty())
    }
}

/// A request the log holds, in the order it was sent, with what sent it.
#[derive(Clone, Debug)]
struct Sent {
    method: String,
    url: String,
    initiator: Option<Initiator>,
}

/// What a script is written in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Js,
    Wasm,
}

/// A script the page parsed: its id in the session that parsed it (what a stack frame names), its url (the page's
/// own for an inline script, empty for an evaluated one), its language, and the hash and length of its body. A script
/// whose body Chrome didn't give has no hash.
#[derive(Clone, Debug, PartialEq)]
pub struct Script {
    pub id: String,
    pub url: String,
    pub language: Language,
    pub sha256: Option<String>,
    pub length: Option<u64>,
    pub module: bool,
    /// What parsed it when it wasn't the page itself: a worker, a frame Chrome runs apart from the page.
    pub context: Option<String>,
}

/// The page's storage for one origin at one moment of the walk (`settle` or `end`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StorageSnapshot {
    pub at: String,
    pub origin: String,
    pub local: BTreeMap<String, String>,
    pub session: BTreeMap<String, String>,
}

/// One walk: what it asked and was answered, the code that ran, what the page stored, and what its sockets said.
#[derive(Clone, Debug)]
pub struct Recording {
    pub trace: Arc<Trace>,
    pub scripts: Vec<Script>,
    pub storage: Vec<StorageSnapshot>,
    pub sockets: Vec<SocketEvent>,
    /// Each script's body, by hash, kept only when its bytes have the hash they were listed under.
    bodies: Arc<BTreeMap<String, Vec<u8>>>,
    /// Every request the log holds, in the order sent, with what sent it.
    sent: Vec<Sent>,
}

#[derive(Deserialize)]
struct ScriptLine {
    #[serde(rename = "scriptId", default)]
    script_id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    length: Option<u64>,
    #[serde(default)]
    module: bool,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    bytes: Option<String>,
}

#[derive(Deserialize)]
struct StorageLine {
    #[serde(default)]
    at: String,
    #[serde(default)]
    origin: String,
    #[serde(default)]
    local: BTreeMap<String, String>,
    #[serde(default)]
    session: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct SocketLine {
    t: f64,
    id: String,
    event: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    opcode: Option<u64>,
    #[serde(default)]
    data: Option<String>,
}

impl Recording {
    /// The recording of a walk's capture in `capture_dir`, whichever log wrote it: the sidecar's (`exchange` lines) or
    /// the walk's own (`request`/`response` lines, paired by the engine). `None` when the log can't be read as a trace.
    pub fn read(capture_dir: &Path, session: &str) -> Option<Self> {
        let path = agent_browser_core::session::capture_path(capture_dir, session);
        let lines = agent_browser_core::session::read_capture(&path);
        if lines.iter().any(|l| l["type"] == "exchange") {
            let text = std::fs::read_to_string(&path).ok()?;
            return Self::from_log(&text).ok();
        }
        let har = agent_browser_core::session::walk_har_from_lines(&lines);
        let trace = Trace::from_har_value(har).ok()?;
        let sockets = lines.iter().filter(|l| l["type"] == "socket").filter_map(socket_event).collect();
        Some(Self::with(trace, sockets, &lines))
    }

    /// The recording of a sidecar log: its session's trace and sockets, with the scripts and storage beside them.
    pub fn from_log(log: &str) -> Result<Self, TraceError> {
        let session = Session::from_log(log)?;
        let lines: Vec<Value> = log.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        Ok(Self::with(session.trace, session.sockets, &lines))
    }

    fn with(mut trace: Trace, mut sockets: Vec<SocketEvent>, lines: &[Value]) -> Self {
        let mut scripts = Vec::new();
        let mut storage = Vec::new();
        let mut bodies = BTreeMap::new();
        let mut sent = Vec::new();
        // A request's address as the trace writes it, so the two are told to be the same request.
        let address = |raw: &str| url::Url::parse(raw).map(|u| u.to_string()).unwrap_or_else(|_| raw.to_string());
        let what_sent = |v: &Value| Initiator::deserialize(v).ok();
        for line in lines {
            match line["type"].as_str() {
                // The walk's own log: one line per request.
                Some("request") => sent.push(Sent {
                    method: line["method"].as_str().unwrap_or("GET").to_uppercase(),
                    url: address(line["url"].as_str().unwrap_or_default()),
                    initiator: line.get("initiator").and_then(what_sent),
                }),
                // The sidecar's: one line per exchange.
                Some("exchange") => sent.push(Sent {
                    method: line["entry"]["request"]["method"].as_str().unwrap_or("GET").to_uppercase(),
                    url: address(line["entry"]["request"]["url"].as_str().unwrap_or_default()),
                    initiator: line["entry"].get("_initiator").and_then(what_sent),
                }),
                Some("script") => {
                    let Ok(s) = ScriptLine::deserialize(line) else { continue };
                    if s.script_id.is_empty() {
                        continue;
                    }
                    let body = match (&s.source, &s.bytes) {
                        (Some(text), _) => Some(text.as_bytes().to_vec()),
                        (None, Some(encoded)) => {
                            use base64::Engine;
                            base64::engine::general_purpose::STANDARD.decode(encoded).ok()
                        }
                        _ => None,
                    };
                    // A body is the code only when its bytes have the hash the walk listed (the log is scrubbed of
                    // secrets after it is hashed, and a scrubbed body is not the code that ran).
                    if let (Some(body), Some(sha)) = (body, &s.sha256) {
                        if sha256_hex(&body) == *sha {
                            bodies.entry(sha.clone()).or_insert(body);
                        }
                    }
                    scripts.push(Script {
                        id: s.script_id,
                        url: s.url,
                        language: if s.language == "wasm" { Language::Wasm } else { Language::Js },
                        sha256: s.sha256,
                        length: s.length,
                        module: s.module,
                        context: s.context,
                    });
                }
                Some("origin_storage") => {
                    if let Ok(s) = StorageLine::deserialize(line) {
                        storage.push(StorageSnapshot { at: s.at, origin: s.origin, local: s.local, session: s.session });
                    }
                }
                _ => {}
            }
        }
        for exchange in &mut trace.exchanges {
            if exchange.resource_type.as_deref() != Some("Script") {
                continue;
            }
            let Some(prefix) = exchange.response_body.as_deref().filter(|s| !s.is_empty()) else { continue };
            let mut sources = scripts.iter()
                .filter(|s| s.language == Language::Js && s.url == exchange.url.as_str())
                .filter_map(|s| std::str::from_utf8(bodies.get(s.sha256.as_ref()?)?).ok())
                .filter(|s| s.starts_with(prefix));
            if let Some(full) = sources.next() {
                if full.len() > prefix.len() && sources.all(|other| other == full) {
                    exchange.response_body = Some(full.to_owned());
                }
            }
        }
        sockets.sort_by(|a, b| a.t.total_cmp(&b.t));
        Self { trace: Arc::new(trace), scripts, storage, sockets, bodies: Arc::new(bodies), sent }
    }

    /// The body of the script listed under `sha`, when the walk kept it.
    pub fn body(&self, sha: &str) -> Option<&[u8]> {
        self.bodies.get(sha).map(Vec::as_slice)
    }

    /// The script a stack frame is in. A script id is unique within the session that parsed it, and a worker's ids
    /// can repeat the page's, so the frame's url decides between scripts that share an id.
    pub fn script(&self, frame: &StackFrame) -> Option<&Script> {
        let same_id = || self.scripts.iter().filter(|s| s.id == frame.script_id);
        same_id().find(|s| s.url == frame.url).or_else(|| same_id().next())
    }

    /// What sent `exchange`, one of this recording's trace: the log's request to the same address by the same method,
    /// and where the page asked that more than once, the one in the same place among them. `None` when the log
    /// predates initiators.
    pub fn initiator_of(&self, exchange: &Exchange) -> Option<&Initiator> {
        let same = |method: &str, url: &str| method.eq_ignore_ascii_case(&exchange.method) && url == exchange.url.as_str();
        let nth = self.trace.exchanges.iter().take_while(|e| !std::ptr::eq(*e, exchange)).filter(|e| same(&e.method, e.url.as_str())).count();
        self.sent.iter().filter(|s| same(&s.method, &s.url)).nth(nth)?.initiator.as_ref()
    }

    /// The script and the place in it that sent `exchange`: its initiator's innermost frame in a listed script.
    pub fn sent_by(&self, exchange: &Exchange) -> Option<(&Script, &StackFrame)> {
        self.initiator_of(exchange)?.all_frames().find_map(|f| self.script(f).map(|s| (s, f)))
    }

    /// The script and place that sent the first request this recording holds of `method` to `url`: the same as
    /// [`sent_by`], found by what was sent rather than by an exchange of this recording's own trace, so a caller
    /// holding a call read from a trace whose doors were struck out (the lab's) can still name its sender.
    pub fn sent_by_value(&self, method: &str, url: &str) -> Option<(&Script, &StackFrame)> {
        let hit = self.sent.iter().find(|s| s.method.eq_ignore_ascii_case(method) && s.url == url)?;
        hit.initiator.as_ref()?.all_frames().find_map(|f| self.script(f).map(|s| (s, f)))
    }

    /// The storage of `origin` at `at` (`settle` or `end`).
    pub fn storage_at(&self, at: &str, origin: &str) -> Option<&StorageSnapshot> {
        self.storage.iter().find(|s| s.at == at && s.origin == origin)
    }

    /// Keeps every script body the walk held in `blobs`, once each. Returns how many bodies were put.
    pub fn keep_scripts(&self, blobs: &Blobs) -> Result<usize, BlobError> {
        for (sha, body) in self.bodies.iter() {
            blobs.put_as(sha, body)?;
        }
        Ok(self.bodies.len())
    }
}

fn socket_event(line: &Value) -> Option<SocketEvent> {
    let s = SocketLine::deserialize(line).ok()?;
    let headers = s
        .headers
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, v.as_str().map(String::from).unwrap_or_else(|| v.to_string())))
        .collect();
    Some(SocketEvent { t: s.t, id: s.id, kind: s.event, url: s.url, headers, opcode: s.opcode.unwrap_or(1), data: s.data })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SIGNER: &str = "function sign(t) { let h = 7; for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }\nfunction askForData() { return fetch('/api/data?sig=' + sign('q')); }\n";
    const MODULE: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    /// A directory of its own for one test, gone when it drops.
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("recording-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn initiator() -> Value {
        json!({"type": "script",
            "frames": [{"scriptId": "7", "url": "https://shop.example/app.js", "function": "askForData", "line": 1, "column": 31}],
            "parents": [{"description": "setTimeout", "frames": [{"scriptId": "5", "url": "https://shop.example/", "function": "", "line": 9, "column": 2}]}]})
    }

    fn script_lines() -> Vec<Value> {
        use base64::Engine;
        vec![
            json!({"type": "script", "t": 1.0, "scriptId": "5", "url": "https://shop.example/", "language": "js", "sha256": sha256_hex(b"setTimeout(askForData, 9)"), "length": 25, "source": "setTimeout(askForData, 9)"}),
            json!({"type": "script", "t": 1.1, "scriptId": "7", "url": "https://shop.example/app.js", "language": "js", "sha256": sha256_hex(SIGNER.as_bytes()), "length": SIGNER.len(), "source": SIGNER}),
            // The same body parsed again (a second frame): listed, its body not written twice.
            json!({"type": "script", "t": 1.2, "scriptId": "9", "url": "https://shop.example/app.js", "language": "js", "sha256": sha256_hex(SIGNER.as_bytes()), "length": SIGNER.len()}),
            json!({"type": "script", "t": 1.3, "scriptId": "11", "url": "wasm://wasm/abc", "language": "wasm", "sha256": sha256_hex(MODULE), "length": 8,
                "bytes": base64::engine::general_purpose::STANDARD.encode(MODULE)}),
            // A body scrubbed after it was hashed is no longer the code that ran.
            json!({"type": "script", "t": 1.4, "scriptId": "12", "url": "https://shop.example/login.js", "language": "js", "sha256": sha256_hex(b"const pw = 'hunter22';"), "length": 22, "source": "const pw = 'secret:1';"}),
            json!({"type": "origin_storage", "t": 2.0, "at": "settle", "origin": "https://shop.example", "local": {"early": "at-load"}, "session": {"tab": "one"}}),
            json!({"type": "origin_storage", "t": 5.0, "at": "end", "origin": "https://shop.example", "local": {"early": "at-load", "late": "after-settle"}, "session": {"tab": "one"}}),
        ]
    }

    #[test]
    fn a_fetched_script_prefix_is_completed_by_what_the_browser_parsed() {
        let dir = Scratch::new("script-prefix");
        let url = "https://shop.example/app.js";
        let prefix = "function sign(t) {";
        let mut lines = walk_lines(true);
        lines.extend(script_lines());
        lines.extend([
            json!({"type": "request", "t": 1.0, "requestId": "app", "method": "GET", "url": url, "headers": {}, "resourceType": "Script", "frameId": "MAIN"}),
            json!({"type": "response", "t": 1.1, "requestId": "app", "url": url, "status": 200, "mimeType": "application/javascript", "headers": {}, "body": prefix}),
        ]);
        write(&dir.0, "w", &lines);
        let body = |name| Recording::read(&dir.0, name).unwrap().trace.exchanges.iter().find(|e| e.url.as_str() == url).unwrap().response_body.clone().unwrap();
        assert_eq!(body("w"), SIGNER);

        let other = "function sign(t) { return t; }";
        lines.push(json!({"type": "script", "scriptId": "13", "url": url, "language": "js", "sha256": sha256_hex(other.as_bytes()), "source": other}));
        write(&dir.0, "other", &lines);
        assert_eq!(body("other"), prefix);
    }

    fn write(dir: &Path, session: &str, lines: &[Value]) {
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(agent_browser_core::session::capture_path(dir, session), text).unwrap();
    }

    fn walk_lines(with_initiator: bool) -> Vec<Value> {
        let mut call = json!({"type": "request", "t": 3.0, "requestId": "2", "method": "GET", "url": "https://shop.example/api/data?sig=abc", "headers": {}, "resourceType": "Fetch", "frameId": "MAIN"});
        if with_initiator {
            call["initiator"] = initiator();
        }
        vec![
            json!({"type": "mint", "url": "https://shop.example/", "t": 0.5}),
            json!({"type": "request", "t": 1.0, "requestId": "1", "method": "GET", "url": "https://shop.example/", "headers": {}, "resourceType": "Document", "frameId": "MAIN", "initiator": {"type": "other"}}),
            json!({"type": "response", "t": 1.5, "requestId": "1", "url": "https://shop.example/", "status": 200, "mimeType": "text/html", "headers": {}, "body": "<html></html>"}),
            call,
            json!({"type": "response", "t": 3.5, "requestId": "2", "url": "https://shop.example/api/data?sig=abc", "status": 200, "mimeType": "application/json", "headers": {}, "body": "{\"items\":[]}"}),
        ]
    }

    #[test]
    fn an_exchange_knows_the_script_and_place_that_sent_it() {
        let dir = Scratch::new("sent");
        let mut lines = walk_lines(true);
        lines.extend(script_lines());
        write(&dir.0, "w", &lines);
        let recording = Recording::read(&dir.0, "w").expect("the walk reads");
        let call = recording.trace.exchanges.iter().find(|e| e.url.path() == "/api/data").unwrap();
        let initiator = recording.initiator_of(call).expect("what sent the call is kept beside it");
        assert_eq!(initiator.kind, "script");
        let sender = initiator.sender().unwrap();
        assert_eq!((sender.function.as_str(), sender.line, sender.column), ("askForData", 1, 31));
        assert_eq!(initiator.parents[0].description, "setTimeout");
        let (script, frame) = recording.sent_by(call).expect("the script that sent it is listed");
        assert_eq!((script.id.as_str(), script.url.as_str()), ("7", "https://shop.example/app.js"));
        assert_eq!(frame.function, "askForData");
        let body = recording.body(script.sha256.as_deref().unwrap()).unwrap();
        assert!(std::str::from_utf8(body).unwrap().contains("function sign("), "the sender's code is in hand");
        // The page itself was sent by nothing of the page's: no script.
        let page = &recording.trace.exchanges[0];
        assert_eq!(recording.initiator_of(page).map(|i| i.kind.as_str()), Some("other"));
        assert!(recording.sent_by(page).is_none());
    }

    #[test]
    fn a_recording_holds_the_trace_scripts_storage_and_sockets() {
        // The walk's own log.
        let dir = Scratch::new("holds");
        let mut lines = walk_lines(true);
        lines.extend(script_lines());
        lines.push(json!({"type": "socket", "t": 4.0, "id": "s1", "event": "open", "url": "wss://shop.example/live"}));
        lines.push(json!({"type": "socket", "t": 4.2, "id": "s1", "event": "received", "opcode": 1, "data": "{\"price\":3}"}));
        write(&dir.0, "w", &lines);
        let walk = Recording::read(&dir.0, "w").unwrap();

        // The sidecar's log, with the same scripts and storage.
        let mut sidecar = vec![
            json!({"type": "action", "t": 0.5, "action": "navigate", "value": "https://shop.example/"}),
            json!({"type": "exchange", "t": 3.0, "resourceType": "Fetch", "entry": {
                "_initiator": initiator(),
                "request": {"method": "GET", "url": "https://shop.example/api/data?sig=abc", "headers": []},
                "response": {"status": 200, "headers": [], "content": {"mimeType": "application/json", "text": "{\"items\":[]}"}}}}),
            json!({"type": "socket", "t": 4.0, "id": "s1", "event": "open", "url": "wss://shop.example/live"}),
            json!({"type": "socket", "t": 4.2, "id": "s1", "event": "received", "opcode": 1, "data": "{\"price\":3}"}),
        ];
        sidecar.extend(script_lines());
        write(&dir.0, "s", &sidecar);
        let side = Recording::read(&dir.0, "s").unwrap();

        for (name, r, calls) in [("walk", &walk, 2), ("sidecar", &side, 1)] {
            assert_eq!(r.trace.exchanges.len(), calls, "{name}: the trace");
            assert_eq!(r.scripts.len(), 5, "{name}: every parsed script is listed");
            assert_eq!(r.scripts.iter().filter(|s| s.language == Language::Wasm).count(), 1, "{name}");
            let wasm = r.scripts.iter().find(|s| s.language == Language::Wasm).unwrap();
            assert_eq!(r.body(wasm.sha256.as_deref().unwrap()), Some(MODULE), "{name}: a module is its bytes");
            let signer = sha256_hex(SIGNER.as_bytes());
            assert_eq!(r.scripts.iter().filter(|s| s.sha256.as_deref() == Some(signer.as_str())).count(), 2, "{name}");
            assert!(r.body(&signer).is_some(), "{name}");
            let scrubbed = r.scripts.iter().find(|s| s.id == "12").unwrap();
            assert!(r.body(scrubbed.sha256.as_deref().unwrap()).is_none(), "{name}: a body that isn't its hash's is not kept");
            assert_eq!(r.storage_at("settle", "https://shop.example").unwrap().local.get("late"), None, "{name}");
            assert_eq!(r.storage_at("end", "https://shop.example").unwrap().local["late"], "after-settle", "{name}");
            assert_eq!(r.storage_at("end", "https://shop.example").unwrap().session["tab"], "one", "{name}");
            assert_eq!(r.sockets.len(), 2, "{name}: the sockets");
            assert_eq!(r.sockets[1].data.as_deref(), Some("{\"price\":3}"), "{name}");
            let call = r.trace.exchanges.iter().find(|e| e.url.path() == "/api/data").unwrap();
            assert_eq!(r.sent_by(call).map(|(s, _)| s.id.as_str()), Some("7"), "{name}");
        }

        // The bodies go to the blob store once each.
        let store = Scratch::new("holds-blobs");
        let blobs = Blobs::at(&store.0);
        assert_eq!(walk.keep_scripts(&blobs).unwrap(), 3, "three bodies have the hash they were listed under");
        assert_eq!(side.keep_scripts(&blobs).unwrap(), 3, "the same bodies again, already kept");
        assert_eq!(blobs.get(&sha256_hex(SIGNER.as_bytes())).unwrap().as_deref(), Some(SIGNER.as_bytes()));
    }

    #[test]
    fn a_capture_with_no_script_lines_still_reads() {
        let dir = Scratch::new("old");
        // A walk's log from before the recording: no scripts, no storage, no initiators.
        write(&dir.0, "w", &walk_lines(false).into_iter().map(|mut l| {
            if let Some(o) = l.as_object_mut() {
                o.remove("initiator");
            }
            l
        }).collect::<Vec<_>>());
        let walk = Recording::read(&dir.0, "w").expect("an old walk reads");
        assert_eq!(walk.trace.exchanges.len(), 2);
        assert!(walk.scripts.is_empty() && walk.storage.is_empty() && walk.sockets.is_empty());
        assert!(walk.trace.exchanges.iter().all(|e| walk.initiator_of(e).is_none()));
        assert_eq!(walk.trace.exchanges[1].json_body().unwrap()["items"], json!([]));
        // The same trace the learner read before: what `walk::trace_from_walk` gives.
        let before = crate::walk::trace_from_walk(&dir.0, "w").unwrap();
        assert_eq!(before.exchanges.len(), walk.trace.exchanges.len());
        assert!(before.exchanges.iter().zip(&walk.trace.exchanges).all(|(a, b)| a.url == b.url && a.status == b.status));

        // A sidecar log from before: actions and exchanges only.
        let old = [
            json!({"type": "action", "t": 0.5, "action": "fill", "selector": "#q", "field": "Search", "value": "shoes"}),
            json!({"type": "exchange", "t": 1.0, "resourceType": "XHR", "entry": {
                "request": {"method": "GET", "url": "https://shop.example/api?q=shoes", "headers": []},
                "response": {"status": 200, "headers": [], "content": {"mimeType": "application/json", "text": "{}"}}}}),
        ];
        let text: String = old.iter().map(|l| format!("{l}\n")).collect();
        let side = Recording::from_log(&text).expect("an old sidecar log reads");
        assert_eq!(side.trace.exchanges.len(), 1);
        assert_eq!(side.trace.inputs.len(), 1, "what was typed is still an input");
        assert!(side.scripts.is_empty() && side.initiator_of(&side.trace.exchanges[0]).is_none());
        // And the session reads a new log, script lines and all, as it read the old.
        let mut new = old.to_vec();
        new.extend(script_lines());
        let text: String = new.iter().map(|l| format!("{l}\n")).collect();
        assert_eq!(Session::from_log(&text).unwrap().trace.exchanges.len(), 1);
    }
}
