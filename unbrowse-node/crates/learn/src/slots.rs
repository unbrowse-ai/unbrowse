//! Every value a request carries, and where in the request it sits.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::trace::Exchange;

/// Where a value sits in a request.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "in", content = "key", rename_all = "snake_case")]
pub enum Loc {
    /// A path segment, by position (0 is the first segment after the host).
    Path(usize),
    Query(String),
    /// A header, lower-cased.
    Header(String),
    Cookie(String),
    /// A leaf of a JSON body, as a JSON pointer such as `/items/0/id`.
    Json(String),
    Form(String),
    /// A part of a multipart form, by name; inside a part that holds JSON, the leaf's pointer (empty for the
    /// part's whole text).
    Part(String, String),
    /// The request's whole address, when an earlier response hands it over: a resumable upload's session is the
    /// address its start was answered with.
    Url,
}

impl std::fmt::Display for Loc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Loc::Path(i) => write!(f, "path[{i}]"),
            Loc::Query(k) => write!(f, "query {k}"),
            Loc::Header(k) => write!(f, "header {k}"),
            Loc::Cookie(k) => write!(f, "cookie {k}"),
            Loc::Json(p) => write!(f, "body {p}"),
            Loc::Form(k) => write!(f, "form {k}"),
            Loc::Part(k, p) => write!(f, "part {k}{p}"),
            Loc::Url => write!(f, "url"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Slot {
    pub loc: Loc,
    pub value: String,
}

/// Headers every browser sends on its own. They say nothing about the route, and replay
/// sets its own.
const BROWSER_HEADERS: &[&str] = &[
    "accept", "accept-encoding", "accept-language", "cache-control", "connection", "content-length",
    "cookie", "dnt", "host", "origin", "pragma", "priority", "referer", "upgrade-insecure-requests",
    "user-agent",
];

pub(crate) fn is_browser_header(name: &str) -> bool {
    BROWSER_HEADERS.contains(&name) || name.starts_with("sec-")
}

/// The headers the transport writes on every request it sends, whatever the walk's browser did: its own framing
/// (`host`, `content-length`, `connection`, `accept-encoding`), the identity it presents (`user-agent`, measured
/// against the minting browser), and the session's cookie from the jar. This one rule stays a rule: it says what this
/// node's transport does, which no walk can show. Everything else the browser wrote by itself rides with the call as
/// the walk sent it.
pub(crate) fn transport_writes(name: &str) -> bool {
    matches!(name, "host" | "content-length" | "connection" | "accept-encoding" | "user-agent" | "cookie")
}

/// Whether a request of this kind is one no page code puts a header on: a navigation, or what the document loads by
/// itself (a stylesheet, a script it names, a picture, a font). Every header it carries is the browser's own.
fn sent_by_the_browser_alone(e: &Exchange) -> bool {
    matches!(e.resource_type.as_deref(), Some("Document" | "Stylesheet" | "Script" | "Font" | "Image" | "Media" | "Manifest" | "Prefetch" | "TextTrack"))
}

/// The headers a walk's browser wrote by itself, read from the walk: every name it sent on a request no page code
/// could put a header on ([`sent_by_the_browser_alone`]), and a header whose value is the walked page's own origin or
/// address (where the call was asked from). Read from the walk, never a list of names: a client hint a site asked
/// for, a browser's newer fetch metadata, a header Chrome adds under a name no list knows, are the browser's because
/// the walk shows the browser sending them where no script could.
///
/// A walk that holds no such request (a trace cut to its calls, an old capture) cannot say: then the list the engine
/// had before stands ([`is_browser_header`]), and the learn says so once.
#[derive(Clone, Debug, Default)]
pub struct BrowsersOwn {
    names: Option<std::collections::HashSet<String>>,
    pages: Vec<(String, String)>,
}

thread_local! {
    /// The last walk the fallback was said for, so a learn says it once and not per header.
    static SAID_FALLBACK: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl BrowsersOwn {
    pub fn of(trace: &crate::trace::Trace) -> Self {
        let mut names = std::collections::HashSet::new();
        let mut any = false;
        let mut pages = Vec::new();
        for e in trace.exchanges.iter().filter(|e| sent_by_the_browser_alone(e) && !e.request_headers.is_empty()) {
            any = true;
            names.extend(e.request_headers.iter().map(|(k, _)| k.to_ascii_lowercase()).filter(|k| !k.starts_with(':')));
            if e.is_main_document() {
                pages.push((e.url.origin().ascii_serialization(), e.url.to_string()));
            }
        }
        if !any {
            let at = trace as *const _ as usize;
            if SAID_FALLBACK.with(|said| said.replace(at)) != at && !cfg!(test) {
                eprintln!("   [headers] the walk holds no request the browser sent by itself, so which headers are its own is read from the engine's list, not the walk");
            }
            return BrowsersOwn { names: None, pages };
        }
        BrowsersOwn { names: Some(names), pages }
    }

    /// Whether the walk read the browser's headers itself, rather than falling back to the list.
    pub fn read(&self) -> bool {
        self.names.is_some()
    }

    /// Whether the header `name`, sent as `value`, is one the browser wrote by itself.
    pub fn wrote(&self, name: &str, value: &str) -> bool {
        let name = name.to_ascii_lowercase();
        match &self.names {
            None => is_browser_header(&name),
            Some(names) => transport_writes(&name) || names.contains(&name) || self.pages.iter().any(|(origin, address)| value == origin || value == address),
        }
    }

    /// Whether the header is the browser's own shape, which rides with the call as walked: one it wrote by itself that
    /// the transport does not write of its own ([`transport_writes`]).
    pub fn carried(&self, name: &str, value: &str) -> bool {
        match &self.names {
            None => is_carried_browser_header(&name.to_ascii_lowercase()),
            Some(_) => self.wrote(name, value) && !transport_writes(&name.to_ascii_lowercase()),
        }
    }
}

/// The browser's own shape that a call is judged by, kept on the route as the walk's own word: the client hints it sent
/// (`sec-ch-ua*`, including the high-entropy ones a site asked for with `Accept-CH`), its fetch metadata, its priority,
/// and the languages it accepted. A replay presents the shape the site was shown, never a guess.
///
/// The page a call was made from rides too (`referer`, and `origin` on a call that isn't a GET): a site's edge reads
/// where its API was asked from, and a generic `https://host/` is not the page that asked. Where the page's address
/// carries the caller's own word (`…/search?queryText=antenna`), that word is a value like any other and is swapped for
/// what the caller sends now (`Step::held`).
///
/// Not carried, because they are not the client's shape: `cookie` (the session's, from the jar), the transport's own
/// framing (`host`, `content-length`, `connection`, `accept-encoding`), and `user-agent` (the identity the transport
/// presents, measured against the minting browser).
pub(crate) fn is_carried_browser_header(name: &str) -> bool {
    matches!(
        name,
        "accept" | "accept-language" | "priority" | "dnt" | "upgrade-insecure-requests" | "cache-control" | "pragma" | "referer" | "origin"
    ) || name.starts_with("sec-ch-")
        || name.starts_with("sec-fetch-")
}

/// What a request body is, decided by its content: a site may label a JSON body
/// `application/x-www-form-urlencoded` (Algolia's client does) and its server
/// still parses the JSON, so the declared type alone can't be trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyKind {
    Json,
    Form,
    /// `multipart/form-data`: what a form sends when it can carry a file.
    Multipart,
    Other,
}

/// One part of a multipart body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub name: String,
    /// Set for a file's part.
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub value: String,
}

/// The boundary a multipart body's parts are split on, from its content type.
pub fn boundary(ex: &Exchange) -> Option<String> {
    let t = ex.request_header("content-type")?;
    if !t.to_ascii_lowercase().starts_with("multipart/form-data") {
        return None;
    }
    t.split(';').find_map(|p| p.trim().strip_prefix("boundary=").map(|b| b.trim_matches('"').to_string()))
}

/// The parts of a multipart body, in order.
pub fn parts(ex: &Exchange) -> Option<Vec<Part>> {
    let boundary = boundary(ex)?;
    let body = ex.request_body.as_deref()?;
    let delimiter = format!("--{boundary}");
    let mut out = Vec::new();
    for chunk in body.split(delimiter.as_str()).skip(1) {
        if chunk.starts_with("--") {
            break;
        }
        let chunk = chunk.strip_prefix("\r\n").or_else(|| chunk.strip_prefix('\n')).unwrap_or(chunk);
        let (head, value) = chunk.split_once("\r\n\r\n").or_else(|| chunk.split_once("\n\n")).unwrap_or((chunk, ""));
        let value = value.strip_suffix("\r\n").or_else(|| value.strip_suffix('\n')).unwrap_or(value);
        let mut part = Part { name: String::new(), filename: None, content_type: None, value: value.to_string() };
        for line in head.lines() {
            let (k, v) = line.split_once(':').unwrap_or((line, ""));
            match k.trim().to_ascii_lowercase().as_str() {
                "content-disposition" => {
                    for p in v.split(';').map(str::trim) {
                        if let Some(n) = p.strip_prefix("name=") {
                            part.name = n.trim_matches('"').to_string();
                        } else if let Some(f) = p.strip_prefix("filename=") {
                            part.filename = Some(f.trim_matches('"').to_string());
                        }
                    }
                }
                "content-type" => part.content_type = Some(v.trim().to_string()),
                _ => {}
            }
        }
        out.push(part);
    }
    Some(out)
}

/// The JSON a part holds, when its text is an object or an array.
pub fn part_json(part: &Part) -> Option<Value> {
    serde_json::from_str::<Value>(&part.value).ok().filter(|v| v.is_object() || v.is_array())
}

pub fn body_kind(ex: &Exchange) -> BodyKind {
    let Some(body) = &ex.request_body else { return BodyKind::Other };
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if v.is_object() || v.is_array() {
            return BodyKind::Json;
        }
    }
    if ex.request_header("content-type").is_some_and(|t| t.starts_with("application/x-www-form-urlencoded")) {
        return BodyKind::Form;
    }
    if boundary(ex).is_some() {
        return BodyKind::Multipart;
    }
    BodyKind::Other
}

pub fn slots(ex: &Exchange) -> Vec<Slot> {
    let mut out = Vec::new();
    if let Some(segments) = ex.url.path_segments() {
        for (i, seg) in segments.enumerate().filter(|(_, s)| !s.is_empty()) {
            let value = percent_encoding::percent_decode_str(seg).decode_utf8_lossy().into_owned();
            out.push(Slot { loc: Loc::Path(i), value });
        }
    }
    for (k, v) in ex.url.query_pairs() {
        out.push(Slot { loc: Loc::Query(k.into_owned()), value: v.into_owned() });
    }
    for (k, v) in &ex.request_headers {
        let k = k.to_ascii_lowercase();
        // The request line itself (`:method`, `:path`, `:authority`, `:scheme`) is how the call is addressed and
        // signed, not a value it carries: the path and query are already here as path pieces and query pairs, and the
        // authority is the host the route asks. Read as fields they invent dependencies — a third-party script whose
        // body happens to hold the host was pulled in as the step that "makes" it, and a route that needed no such
        // step failed on a value that step never answered.
        if k.starts_with(':') {
            continue;
        }
        // The browser's own shape rides with the call (its hints, fetch metadata, priority, languages); the rest of
        // what a browser adds on its own (the session's cookie, the transport's framing) does not.
        if !is_browser_header(&k) || is_carried_browser_header(&k) {
            out.push(Slot { loc: Loc::Header(k), value: v.clone() });
        }
    }
    for (k, v) in ex.cookies() {
        out.push(Slot { loc: Loc::Cookie(k), value: v });
    }
    if let Some(body) = &ex.request_body {
        match crate::slots::body_kind(ex) {
            crate::slots::BodyKind::Form => {
                for (k, v) in url::form_urlencoded::parse(body.as_bytes()) {
                    out.push(Slot { loc: Loc::Form(k.into_owned()), value: v.into_owned() });
                }
            }
            crate::slots::BodyKind::Json => {
                if let Ok(json) = serde_json::from_str::<Value>(body) {
                    for (pointer, value) in json_leaves(&json) {
                        out.push(Slot { loc: Loc::Json(pointer), value });
                    }
                }
            }
            crate::slots::BodyKind::Multipart => {
                // A file's bytes are sent as they were; the form's text parts are values like any other.
                for part in parts(ex).unwrap_or_default().into_iter().filter(|p| p.filename.is_none()) {
                    match part_json(&part) {
                        Some(json) => {
                            for (pointer, value) in json_leaves(&json) {
                                out.push(Slot { loc: Loc::Part(part.name.clone(), pointer), value });
                            }
                        }
                        None => out.push(Slot { loc: Loc::Part(part.name, String::new()), value: part.value }),
                    }
                }
            }
            crate::slots::BodyKind::Other => {}
        }
    }
    out
}

/// Whether a value is a flag, true or false: a setting any call may send for its own reasons, so the same flag in two
/// places of a walk is no sign that one was copied from the other.
pub fn is_flag(v: &str) -> bool {
    v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("false")
}

/// A path piece read the way a form writes a value, a space for each `+` (`/maps/search/coffee+shops/` searching for
/// "coffee shops"), when it holds a plus and no space. Whether the piece means that is the walk's to say: the value
/// stands for the piece only where a call the page made carries it so.
pub fn plus_spaced(piece: &str) -> Option<String> {
    (piece.contains('+') && !piece.contains(' ')).then(|| piece.replace('+', " ").trim().to_string()).filter(|s| !s.is_empty())
}

/// Whether a path piece holds `value`: as it is, or, for a piece written the way a form writes (`plus_spaced`), as
/// that. Case aside: a site may canonicalise it on a redirect.
pub fn piece_holds(piece: &str, value: &str) -> bool {
    piece.eq_ignore_ascii_case(value) || plus_spaced(piece).is_some_and(|p| p.eq_ignore_ascii_case(value))
}

/// Whether a value says too little to tell where it sits by itself: a flag, or one character (`adults=2`, `sort=a`).
/// Any call may send the same for its own reasons (`version=2`, `limit=1`), so such a value is a caller's only under
/// the key the caller gave it.
pub fn bound_by_key(v: &str) -> bool {
    is_flag(v) || v.chars().count() < 2
}

/// Every scalar in a JSON value, with its pointer, as text.
pub fn json_leaves(value: &Value) -> Vec<(String, String)> {
    fn walk(v: &Value, path: String, out: &mut Vec<(String, String)>) {
        match v {
            Value::Object(map) => {
                for (k, v) in map {
                    walk(v, format!("{path}/{}", k.replace('~', "~0").replace('/', "~1")), out);
                }
            }
            Value::Array(items) => {
                for (i, v) in items.iter().enumerate() {
                    walk(v, format!("{path}/{i}"), out);
                }
            }
            Value::String(s) => out.push((path, s.clone())),
            Value::Number(n) => out.push((path, n.to_string())),
            Value::Bool(b) => out.push((path, b.to_string())),
            Value::Null => {}
        }
    }
    let mut out = Vec::new();
    walk(value, String::new(), &mut out);
    out
}

/// A binary body opened into fields with no schema (`route::wire`), where its content type or its own framing says
/// which codec writes it, and the reading writes back the walk's very bytes: the codec and what it read. None for a
/// body that is text of a kind the other readers know, or that no codec opens exactly. A body is carried as text, so
/// only bytes that are one reach here.
pub fn wire_body(ex: &Exchange) -> Option<(unbrowse_route::wire::Codec, Value)> {
    let body = ex.request_body.as_deref().filter(|b| !b.is_empty())?;
    if body_kind(ex) != BodyKind::Other {
        return None;
    }
    unbrowse_route::wire::opened(ex.request_header("content-type"), &unbrowse_route::wire::bytes_of(body))
}

/// The texts a binary body's fields hold ([`wire_body`]), where a codec opens it: what a reader that looks for a value
/// in a request's body reads of one that is no text. Empty for any other body.
pub fn wire_texts(ex: &Exchange) -> Vec<String> {
    wire_body(ex).map(|(_, tree)| unbrowse_route::wire::leaves(&tree).into_iter().map(|(_, v)| v).collect()).unwrap_or_default()
}

/// Every place of a request, as [`slots`] reads them, and each field of a binary body [`wire_body`] opens, as a leaf by
/// pointer into what it read (`Loc::Json`): the learner by example's reading, where each field is a place like any
/// other.
pub fn slots_with_wire(ex: &Exchange) -> Vec<Slot> {
    let mut out = slots(ex);
    if let Some((_, tree)) = wire_body(ex) {
        out.extend(unbrowse_route::wire::leaves(&tree).into_iter().map(|(pointer, value)| Slot { loc: Loc::Json(pointer), value }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(headers: &[(&str, &str)]) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: "https://www.example.com/api/search?q=lamp".parse().unwrap(),
            request_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        }
    }

    /// The request line is how a call is addressed, not a value it carries: `:path` is already here as path pieces and
    /// query pairs, `:authority` is the host the route asks. Read as fields they invented dependencies — a third-party
    /// script whose body held the host became the step that "made" `:authority`, and the route failed on a value that
    /// step never answered (Britannica's search, 2026-11-10).
    #[test]
    fn the_request_line_is_not_a_field() {
        let ex = exchange(&[(":authority", "www.example.com"), (":path", "/api/search?q=lamp"), (":method", "GET"), (":scheme", "https"), ("x-sign", "abc")]);
        let headers: Vec<String> = slots(&ex)
            .into_iter()
            .filter_map(|s| match s.loc {
                Loc::Header(h) => Some(h),
                _ => None,
            })
            .collect();
        assert_eq!(headers, vec!["x-sign".to_string()], "only the headers the call carries");
        let all = slots(&ex);
        assert!(!all.iter().any(|s| matches!(&s.loc, Loc::Header(h) if h.starts_with(':'))), "no request-line pseudo-header is a field");
    }
}

#[cfg(test)]
mod browsers_own_tests {
    use super::BrowsersOwn;
    use crate::lab::sighting::tests::{call, trace};
    use crate::trace::Exchange;

    /// A walk that loaded its page and a stylesheet, then made a call from the page's script.
    fn walked(call_headers: &[(&str, &str)]) -> crate::trace::Trace {
        let browser = [("accept-language", "en-GB"), ("sec-ch-ua-platform", "\"macOS\""), ("x-browser-validation", "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6"), ("user-agent", "Mozilla/5.0")];
        let mut page = call("GET", "https://shop.example/search?q=lamp", &browser, None, "<html></html>");
        page.resource_type = Some("Document".into());
        let mut sheet = call("GET", "https://shop.example/s/app.css", &browser, None, "body{}");
        sheet.resource_type = Some("Stylesheet".into());
        let search: Exchange = call("GET", "https://shop.example/api/search?q=lamp", call_headers, None, r#"{"items":[]}"#);
        trace(vec![page, sheet, search])
    }

    /// A header the walk's browser sent on a request no script could put a header on (its navigation, a stylesheet
    /// the document loaded) is the browser's own, under whatever name: one no list knows included. A header only the
    /// page's call sends is the page's, and a long one nothing explains is then the session's.
    #[test]
    fn a_header_the_browser_sent_where_no_script_could_is_its_own() {
        let headers = [("x-browser-validation", "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6"), ("x-api-key", "k_7d6c5b4a39281706f5e4"), ("accept-language", "en-GB")];
        let t = walked(&headers);
        let own = BrowsersOwn::of(&t);
        assert!(own.read());
        assert!(own.wrote("x-browser-validation", "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6"), "the browser sent it on the navigation");
        assert!(own.wrote("accept-language", "en-GB"));
        assert!(!own.wrote("x-api-key", "k_7d6c5b4a39281706f5e4"), "only the page's call sends it");
        assert!(!crate::graph::a_session_header(&t, 2, "x-browser-validation", "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6", Some("shop.example")), "the browser's, not the jar's");
        assert!(crate::graph::a_session_header(&t, 2, "x-api-key", "k_7d6c5b4a39281706f5e4", Some("shop.example")), "the page's call alone sends it, and nothing explains it");
    }

    /// A header whose value is the walked page's own origin or address says where the call was asked from: the
    /// browser's, whatever it is called.
    #[test]
    fn a_header_that_sends_the_walked_pages_own_address_is_the_browsers() {
        let own = BrowsersOwn::of(&walked(&[]));
        assert!(own.wrote("origin", "https://shop.example"));
        assert!(own.wrote("referer", "https://shop.example/search?q=lamp"));
        assert!(!own.wrote("x-return-to", "https://elsewhere.example/"));
    }

    /// Of the browser's own headers, those the transport writes itself (its framing, its identity, the jar's cookie)
    /// are the transport's; the rest ride with the call as the walk sent them.
    #[test]
    fn the_browsers_own_shape_rides_as_walked_and_the_transports_own_does_not() {
        let own = BrowsersOwn::of(&walked(&[]));
        assert!(own.carried("accept-language", "en-GB"));
        assert!(own.carried("x-browser-validation", "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6"));
        assert!(own.carried("referer", "https://shop.example/search?q=lamp"));
        assert!(!own.carried("user-agent", "Mozilla/5.0"), "the identity the transport presents");
        assert!(!own.carried("x-api-key", "k_7d6c5b4a39281706f5e4"), "the page's, not the browser's");
    }

    /// A walk that holds no request the browser sent by itself cannot say which headers are its own: the engine's
    /// list stands, as it did before, and nothing is guessed.
    #[test]
    fn a_walk_with_no_request_the_browser_sent_alone_reads_the_list() {
        let t = trace(vec![call("GET", "https://shop.example/api/search?q=lamp", &[("sec-ch-ua", "\"Chromium\""), ("x-browser-validation", "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6")], None, "{}")]);
        let own = BrowsersOwn::of(&t);
        assert!(!own.read());
        assert!(own.wrote("sec-ch-ua", "\"Chromium\""));
        assert!(!own.wrote("x-browser-validation", "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6"), "the list does not know it, and the walk cannot say");
        assert!(own.carried("accept-language", "en-GB") && !own.carried("user-agent", "Mozilla/5.0"));
    }
}
