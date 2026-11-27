//! A recorded flow: the HTTP exchanges from a HAR file, plus what the agent typed.

use serde::Deserialize;
use url::Url;

#[derive(Debug, thiserror::Error)]
pub enum TraceError {
    #[error("not a HAR file: {0}")]
    Har(#[from] serde_json::Error),
}

#[derive(Clone, Debug)]
pub struct CookieChange {    pub name: String,
    /// Its new value, or None for a cookie taken out (set empty, or set to expire).
    pub value: Option<String>,
    /// The `Domain` the site set it for, when it said one (`None`: this host alone).
    pub domain: Option<String>,
    /// The path it goes to: the line's own, or the folder of the address that set it when the line said none.
    pub path: String,
    /// When it runs out, from `Max-Age`, in Unix seconds.
    pub expires: Option<f64>,
    /// The line said `HttpOnly`: the cookie goes with requests and is never shown to a page's script.
    pub http_only: bool,
}

/// The page a route was learned on, as the walk saw it: the last main document on `host`'s site, its head kept whole
/// (a signing bundle reads a `<meta>` or a `<script>` from it). Capped: a route travels to other nodes, and a page's
/// state blob can be megabytes. None when the walk saw no such document.
pub fn page_html_of(trace: &Trace, host: &str) -> Option<String> {
    // A page's own setup is not all in its head: the state a bundle boots from (`__APP_INITIAL_STATE__`, an inline
    // `<script>` writing a global) often sits in the body, just past a smaller cut. Measured on Trip.com's results
    // page: 271 KB, with that state at 129 KB — a 128 KB cap carried the page without the state, and the app stopped
    // on it. A page that fits is kept whole.
    const CAP: usize = 512 * 1024;
    let doc = trace.exchanges.iter().rev().find(|e| {
        e.is_main_document() && e.url.host_str().is_some_and(|h| crate::identity::same_site(h, host))
    })?;
    let body = doc.response_body.as_deref()?.trim_start();
    if !body.starts_with('<') {
        return None;
    }
    if body.len() <= CAP {
        return Some(body.to_string());
    }
    // A cut at a character boundary: the page's head (where its meta and config tags are) comes first.
    let mut end = CAP;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    // A cut inside a `<script>` would hand the sandbox half a program, and the half that runs is a syntax error: the
    // head ends at the last complete element.
    let head = body[..end].to_lowercase();
    if let Some(open) = head.rfind("<script") {
        if head.rfind("</script").is_none_or(|close| close < open) {
            end = open;
        }
    }
    let mut page = body[..end].to_string();
    // The page's state travels with its head even when it sits past the cut: a `<script type="application/json">`
    // block (`__NEXT_DATA__`, `__NFES_DATA__`) is what the page's own code reads as data, and a bundle booted without
    // it reads nothing. Bounded, and only blocks that are not already in the head.
    const STATE_CAP: usize = 192 * 1024;
    let lower = body.to_lowercase();
    let mut at = 0;
    let mut kept = 0;
    while let Some(open) = lower[at..].find("<script") {
        let open = at + open;
        let Some(tag_end) = lower[open..].find('>').map(|i| open + i + 1) else { break };
        let close = lower[tag_end..].find("</script>").map(|i| tag_end + i);
        let Some(close) = close else { break };
        let tag = &lower[open..tag_end];
        let is_state = tag.contains("application/json") || tag.contains("application/ld+json");
        at = close + 9;
        if !is_state || open < end {
            continue;
        }
        let block = &body[open..close + 9];
        if kept + block.len() > STATE_CAP {
            break;
        }
        kept += block.len();
        page.push_str(block);
    }
    Some(page)
}

#[derive(Clone, Debug)]
pub struct Exchange {
    pub method: String,
    pub url: Url,
    pub request_headers: Vec<(String, String)>,
    pub request_body: Option<String>,
    pub status: u16,
    pub response_headers: Vec<(String, String)>,
    pub response_body: Option<String>,
    pub response_mime: String,
    /// The HAR `_resourceType` (e.g. `Document`, `XHR`, `Stylesheet`), when recorded.
    pub resource_type: Option<String>,
    /// Whether the walk's main frame made the request, rather than a frame inside it (a challenge widget, an ad,
    /// a consent banner). `None` when the log predates frames.
    pub main_frame: Option<bool>,
}

thread_local! {
    /// A learn's decoders for replies no standard reader reads: the programs cut from the scripts that read them
    /// (`app::learn` fills them from the walk's recording). The last resort of [`Exchange::own_json`] runs them over a
    /// reply nothing else reads that could be an answer the page's code unpacked
    /// ([`Exchange::could_be_unpacked_by_the_page`]), so a ciphered or obfuscated answer reads as what the page showed —
    /// one reading, asked by every place that judges a reply. Empty by default: a reply a standard reader reads, and
    /// every reply at call time, never runs a decoder, so it changes nothing there.
    static DECODERS: std::cell::RefCell<std::rc::Rc<Vec<String>>> = std::cell::RefCell::new(std::rc::Rc::new(Vec::new()));
    /// What each decoder made of each reply body it was run over, by the decoder and the body: a decoder that failed on
    /// a body is never run on it again in the learn, and a reply read many times is decoded once. Kept across nested
    /// scopes (a decoder's reading of a body is a pure function of the two) and emptied when the outermost scope ends.
    static DECODED_CACHE: std::cell::RefCell<std::collections::HashMap<(u64, u64, usize), Option<serde_json::Value>>> = std::cell::RefCell::new(std::collections::HashMap::new());
    /// How deep the nested `DecodedGuard` scopes are on this thread.
    static DECODED_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// How many times a decoder was run on this thread (each run is one sandbox child): what a learn's log reports, and
    /// what a test counts.
    static DECODER_RUNS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// `DECODER_RUNS` when the outermost scope began, so its end can say how many runs the learn made.
    static DECODER_RUNS_AT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The decoders this thread's learn has set (`DecodedGuard`): what `own_json` reads a reply no standard reader reads
/// through, so part of what any reading built on it depends on.
pub fn decoders_in_force() -> std::rc::Rc<Vec<String>> {
    DECODERS.with(|d| d.borrow().clone())
}

/// How many times a decoder has been run over a reply on this thread ([`decoded_overlay`]): each is one child process
/// started in the sandbox (`generated::decode`).
pub fn decoder_runs() -> usize {
    DECODER_RUNS.with(|n| n.get())
}

fn hash_of(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// What the page's own code turns `body` into, when a learn set its decoders (`DecodedGuard`): the first decoder whose
/// output is JSON, cached by decoder and body. None when no decoder is set (call time, and every learn with no such
/// reply) or none reads it. Only reached when every standard reader of `own_json` returned nothing, and only for a reply
/// that could be an answer the page's code unpacked, so a normal reply or a resource never runs one.
fn decoded_overlay(body: &str) -> Option<serde_json::Value> {
    let decoders = DECODERS.with(|d| d.borrow().clone());
    if decoders.is_empty() {
        return None;
    }
    let (of_body, len) = (hash_of(body), body.len());
    let env = crate::generated::Environment::default();
    decoders.iter().find_map(|prog| {
        let key = (hash_of(prog), of_body, len);
        if let Some(hit) = DECODED_CACHE.with(|c| c.borrow().get(&key).cloned()) {
            return hit;
        }
        DECODER_RUNS.with(|n| n.set(n.get() + 1));
        let out = crate::generated::decode(prog, body, &env).and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        DECODED_CACHE.with(|c| c.borrow_mut().insert(key, out.clone()));
        out
    })
}

/// Sets `decoders` as the reading of replies no standard reader reads for its lifetime, restoring the previous reading
/// on drop. A learn holds it over recognising and building a route, so every place that asks `own_json` reads a
/// ciphered reply as what the page showed. Nested scopes restore the decoders and share what each decoder already made
/// of a body; the outermost scope empties that on drop. Empty at call time and for every normal reply, so it changes
/// nothing there.
#[must_use]
pub struct DecodedGuard {
    decoders: std::rc::Rc<Vec<String>>,
}

impl DecodedGuard {
    pub fn set(decoders: Vec<String>) -> Self {
        if DECODED_DEPTH.with(|d| d.replace(d.get() + 1)) == 0 {
            DECODER_RUNS_AT.with(|at| at.set(decoder_runs()));
        }
        DecodedGuard { decoders: DECODERS.with(|d| d.replace(std::rc::Rc::new(decoders))) }
    }

    /// Whether no decoder was set: no reply of the walk needed the page's own code to read it.
    pub fn is_empty(&self) -> bool {
        DECODERS.with(|d| d.borrow().is_empty())
    }
}

impl Drop for DecodedGuard {
    fn drop(&mut self) {
        DECODERS.with(|d| *d.borrow_mut() = std::mem::take(&mut self.decoders));
        let outermost = DECODED_DEPTH.with(|d| {
            d.set(d.get().saturating_sub(1));
            d.get() == 0
        });
        if outermost {
            let replies = DECODED_CACHE.with(|c| {
                let mut c = c.borrow_mut();
                let replies = c.keys().map(|k| (k.1, k.2)).collect::<std::collections::HashSet<_>>().len();
                c.clear();
                replies
            });
            let runs = decoder_runs() - DECODER_RUNS_AT.with(|at| at.get());
            if runs > 0 {
                eprintln!("   [decode] the page's decoders ran {runs} times over {replies} replies a script was handed (one sandbox run each)");
            }
        }
    }
}

impl Exchange {
    /// The response as JSON: the body itself when it is JSON, else the page's
    /// embedded state blob (`<script type="application/json">`). One stored
    /// body serves both text-marker extraction and structured reads.
    pub fn json_body(&self) -> Option<serde_json::Value> {
        self.json_body_like(None)
    }

    /// The same, for a page that embeds several JSON blobs: the one shaped `like` (a route's recorded answer), read as
    /// the route was learned (`embedded_json_like`).
    pub fn json_body_like(&self, like: Option<&serde_json::Value>) -> Option<serde_json::Value> {
        self.json_body_with_source(like).map(|(value, _)| value)
    }

    /// The parsed value and whether it came from the body's own JSON.
    pub(crate) fn json_body_with_source(&self, like: Option<&serde_json::Value>) -> Option<(serde_json::Value, bool)> {
        if let Some(v) = self.own_json() {
            return Some((v, true));
        }
        embedded_json_value_like(self.response_body.as_deref()?, like).map(|value| (value, false))
    }

    /// The answer's own JSON, however the site wrapped it: the body itself, the body inside the name its address
    /// asked for (`cb({...})`), behind a guard (`)]}'`), as the events of a stream, or encoded again as text
    /// (`encoded_json`). Never a page's embedded state:
    /// that is the page's, read by `json_body_like`. This is the one reading of "what JSON did this call answer
    /// with": learning a call, replaying it, judging whether it failed and paging through it all ask it here, so a
    /// wrapping one of them can read is one all of them can.
    pub fn own_json(&self) -> Option<serde_json::Value> {
        let body = self.response_body.as_deref()?;
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
            return Some(v);
        }
        if let Some(padded) = self.padded_json() {
            return serde_json::from_str(padded).ok();
        }
        guarded_json(body)
            .or_else(|| event_stream_json(body))
            .or_else(|| encoded_json(body))
            .or_else(|| self.could_be_unpacked_by_the_page().then(|| decoded_overlay(body)).flatten())
    }

    /// Whether this reply could be an answer the page's own code unpacked, and so one a learn's decoder may be run over
    /// (`DecodedGuard`). Read from the walk: a decoder is the code of a script that fetched a reply and read its body,
    /// so the only reply it can stand for is one handed to a script as data. Not a resource the browser loaded and
    /// consumed itself: a document or frame it rendered, a script it ran, a stylesheet it applied, an image, a font or
    /// media it drew, by the recorded resource type ([`Exchange::is_asset`]). Not a reply that declares itself one of
    /// those kinds whatever loaded it ([`Exchange::declares_an_asset`]: a script a worker imported is recorded as
    /// `Other`, and is still a script): it is read as the text of the kind it declares, not undecodable. Nor a reply
    /// that reads as markup (`page::is_markup`), read as the page it is.
    ///
    /// Why this hides no ciphered answer: a page's code can only unpack a reply its script was handed as data, and the
    /// browser hands a script the body of what it fetched (`fetch`, `XMLHttpRequest`, an event stream), never the body
    /// of a document, script, stylesheet, image or font it loaded as a resource. A ciphered answer declared as a script
    /// or a stylesheet would say it is code to run rather than data to read. The ciphered answers the engine knows are
    /// fetched and read as text or bytes, and declare a data type (`text/plain`, `application/x-msgpack`, the matrix's
    /// `cipher-answer`, `msgpack-answer` and `protobuf-*` rows).
    pub fn could_be_unpacked_by_the_page(&self) -> bool {
        if self.is_asset() || self.declares_an_asset() || self.resource_type.as_deref() == Some("Document") {
            return false;
        }
        let body = self.response_body.as_deref().unwrap_or_default();
        !crate::page::is_markup(self.response_header("content-type").unwrap_or(&self.response_mime), body)
    }

    /// Every JSON document the body holds: the body itself when it is JSON, a padded or event-stream answer, or each
    /// script on a page that says it holds JSON, in the page's order. A page may carry several, and which one holds a
    /// value can change with what was asked: extraction searches them all rather than the first.
    pub fn json_documents(&self) -> Vec<serde_json::Value> {
        let Some(body) = self.response_body.as_deref() else { return Vec::new() };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
            return vec![v];
        }
        if let Some(padded) = self.padded_json() {
            if let Ok(v) = serde_json::from_str(padded) {
                return vec![v];
            }
        }
        if let Some(v) = event_stream_json(body) {
            return vec![v];
        }
        json_blobs(body).map(|(_, value)| value).collect()
    }

    pub fn request_header(&self, name: &str) -> Option<&str> {
        header(&self.request_headers, name)
    }

    pub fn response_header(&self, name: &str) -> Option<&str> {
        header(&self.response_headers, name)
    }

    /// Cookies the request sent, in order.
    pub fn cookies(&self) -> Vec<(String, String)> {
        self.request_headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("cookie"))
            .flat_map(|(_, v)| v.split(';'))
            .filter_map(|kv| {
                let (k, v) = kv.trim().split_once('=')?;
                Some((k.to_string(), v.to_string()))
            })
            .collect()
    }

    /// The JSON an answer carries inside a call of the name its own address gave it (`?cb=draw`, answered `draw({…});`).
    /// That is how a page reads another host's API through a script tag: the browser logs a script, and what came back
    /// is data the page asked for. The name is the whole test, so a page's own code is never read as one.
    pub fn padded_json(&self) -> Option<&str> {
        self.url.query()?;
        let body = self.response_body.as_deref()?.trim();
        // A server may open with a comment, so the body can't be read as anything but a script.
        let body = match body.strip_prefix("/*") {
            Some(rest) => rest.split_once("*/")?.1.trim_start(),
            None => body,
        };
        let (name, rest) = body.split_once('(')?;
        let name = name.trim();
        if name.is_empty() || !self.url.query_pairs().any(|(_, v)| v == name) {
            return None;
        }
        let rest = rest.trim_end();
        let inner = rest.strip_suffix(';').unwrap_or(rest).trim_end().strip_suffix(')')?;
        // What's inside must be JSON whole: a script that calls the same name and goes on is code.
        (inner.trim_start().starts_with(['{', '[']) && serde_json::from_str::<serde::de::IgnoredAny>(inner).is_ok()).then_some(inner)
    }

    /// Whether the body answers with nothing but what the request sent: every value in it was in the request's own
    /// body (an event the page reports, played back to it). The server made none of them, so none of them is a
    /// value's origin; the response's headers and cookies are still the server's.
    pub fn echoes_its_request(&self) -> bool {
        use serde_json::Value;
        fn leaves<'a>(v: &'a Value, out: &mut Vec<&'a Value>) {
            match v {
                Value::Array(a) => a.iter().for_each(|v| leaves(v, out)),
                Value::Object(o) => o.values().for_each(|v| leaves(v, out)),
                Value::Bool(_) | Value::Null => {}
                leaf => out.push(leaf),
            }
        }
        let Some(sent) = self.request_body.as_deref() else {
            return false;
        };
        let Some(answer) = self.own_json() else {
            return false;
        };
        let mut said = Vec::new();
        leaves(&answer, &mut said);
        if !said.iter().any(|v| v.as_str().is_none_or(|s| !s.is_empty())) {
            return false;
        }
        // A JSON request is compared value for value: a number prints its digits its own way on each side.
        if let Ok(asked) = serde_json::from_str::<Value>(sent) {
            let mut sent_values = Vec::new();
            leaves(&asked, &mut sent_values);
            // Read back, the same number may land an ulp apart.
            let same = |a: &Value, b: &Value| match (a.as_f64(), b.as_f64()) {
                (Some(x), Some(y)) => x == y || (x - y).abs() <= f64::EPSILON * 4.0 * x.abs().max(y.abs()),
                _ => a == b,
            };
            return said.iter().all(|v| sent_values.iter().any(|s| same(v, s)));
        }
        // Otherwise a value the request sent shows in it as itself or JSON-escaped.
        said.iter().all(|v| {
            let text = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
            sent.contains(text.as_str()) || serde_json::to_string(&text).is_ok_and(|q| sent.contains(&q[1..q.len() - 1]))
        })
    }

    /// Whether the answer's records are ones the request sent: its longest list of records holds no text the request
    /// didn't carry. A page's events reported to a logger come back that way, inside an answer of its own making, and
    /// they say what the page was asked as well as any result does. The server found none of them.
    pub fn records_are_what_it_sent(&self) -> bool {
        use serde_json::Value;
        fn texts<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
            match v {
                Value::Array(a) => a.iter().for_each(|v| texts(v, out)),
                Value::Object(o) => o.values().for_each(|v| texts(v, out)),
                Value::String(s) if !s.is_empty() => out.push(s),
                _ => {}
            }
        }
        fn longest<'a>(v: &'a Value, best: &mut Option<&'a Vec<Value>>) {
            match v {
                Value::Array(a) => {
                    if a.iter().filter(|x| x.is_object()).count() >= 2 && best.is_none_or(|b| a.len() > b.len()) {
                        *best = Some(a);
                    }
                    a.iter().for_each(|x| longest(x, best));
                }
                Value::Object(o) => o.values().for_each(|x| longest(x, best)),
                _ => {}
            }
        }
        let Some(request) = self.request_body.as_deref() else { return false };
        // A JSON body, or the JSON a form's values hold.
        let sent: Vec<Value> = match serde_json::from_str::<Value>(request) {
            Ok(v) => vec![v],
            Err(_) => url::form_urlencoded::parse(request.as_bytes()).filter_map(|(_, v)| serde_json::from_str::<Value>(&v).ok()).collect(),
        };
        let Some(answer) = self.json_body() else { return false };
        let mut records = None;
        longest(&answer, &mut records);
        let Some(records) = records else { return false };
        let (mut said, mut carried) = (Vec::new(), Vec::new());
        records.iter().for_each(|r| texts(r, &mut said));
        sent.iter().for_each(|v| texts(v, &mut carried));
        let carried: std::collections::HashSet<&str> = carried.into_iter().collect();
        !said.is_empty() && said.iter().all(|t| carried.contains(t))
    }

    /// Whether this exchange is a static asset (stylesheet, script, font, image, media).
    /// Asset bodies carry incidental text, so they are not value origins; a `Document`
    /// (the page itself) and API responses (`XHR`/`Fetch`) are not assets.
    pub fn is_asset(&self) -> bool {
        if self.padded_json().is_some() {
            return false;
        }
        if let Some(rt) = &self.resource_type {
            return matches!(
                rt.as_str(),
                "Stylesheet" | "Script" | "Font" | "Image" | "Media" | "Manifest" | "Prefetch" | "Ping"
            );
        }
        self.declares_an_asset()
    }

    /// Whether the reply declares itself a resource's kind: a stylesheet, a script, an image, a font or media, by the
    /// type it was served as. What [`Exchange::is_asset`] reads where the walk recorded no resource type.
    pub fn declares_an_asset(&self) -> bool {
        matches!(
            self.response_mime.split(';').next().unwrap_or_default().trim(),
            "text/css" | "application/javascript" | "text/javascript" | "image/svg+xml"
        ) || self.response_mime.starts_with("image/")
            || self.response_mime.starts_with("font/")
            || self.response_mime.starts_with("audio/")
            || self.response_mime.starts_with("video/")
    }

    /// Whether this exchange is code or style the page loaded: a script or a stylesheet.
    pub fn is_static_code(&self) -> bool {
        if self.padded_json().is_some() {
            return false;
        }
        if let Some(rt) = &self.resource_type {
            return matches!(rt.as_str(), "Script" | "Stylesheet");
        }
        let mime = self.response_mime.to_ascii_lowercase();
        mime.contains("javascript") || mime.contains("ecmascript") || mime.starts_with("text/css")
    }

    /// What the response did to each cookie it named, in order: its new value, or None for one taken out (set empty,
    /// or set to expire, whatever value the line leaves).
    pub fn cookie_changes(&self) -> Vec<(String, Option<String>)> {
        self.cookie_changes_scoped().into_iter().map(|(name, value, _)| (name, value)).collect()
    }

    /// The same, with the `Domain` the site set each cookie for when it said one (`None`: for this host alone): the
    /// jar keeps the reach beside the value, so a later call sends the cookie where a browser would — a cookie set
    /// for the site's whole domain rides every host of the site under it, and a host-only one stays on its host.
    pub fn cookie_changes_scoped(&self) -> Vec<(String, Option<String>, Option<String>)> {
        self.cookie_changes_whole().into_iter().map(|c| (c.name, c.value, c.domain)).collect()
    }

    /// Every cookie a response set or took out, with what its line said about it: the path it goes to, and when it
    /// runs out (`Max-Age`, counted from now). A browser sends a request's cookies longest-path first, then oldest
    /// first, and a site that binds a token to a request reads that order; the jar keeps enough to send them so.
    pub fn cookie_changes_whole(&self) -> Vec<CookieChange> {
        self.response_headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, line)| {
                let (k, v) = line.split(';').next()?.trim().split_once('=')?;
                let value = (!v.is_empty() && !crate::http::ends_the_cookie(line)).then(|| v.to_string());
                let path = crate::http::cookie_path(line, &self.url);
                let expires = crate::http::cookie_expiry(line);
                let http_only = crate::http::cookie_http_only(line);
                Some(CookieChange { name: k.to_string(), value, domain: agent_browser_core::session::set_cookie_domain(line), path, expires, http_only })
            })
            .collect()
    }

    /// Cookies the response set: the name and value of each `Set-Cookie`.
    pub fn set_cookies(&self) -> Vec<(String, String)> {
        self.response_headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, v)| {
                let first = v.split(';').next()?;
                let (k, v) = first.trim().split_once('=')?;
                Some((k.to_string(), v.to_string()))
            })
            .collect()
    }
}

/// Pulls the data out of a server-side-rendered page: many sites embed the
/// page's state as JSON inside `<script type="application/json">` tags (with
/// `/` escaped as `\u002F` so the blob stays script-safe). The largest such
/// blob is the page's data; a learned route's response is that JSON, not the
/// surrounding HTML.
pub fn embedded_json(body: &str) -> Option<String> {
    embedded_json_like(body, None)
}

/// The page's JSON state blob shaped `like` (the answer a route recorded from this page): the blob that shares the
/// most top-level keys with it, else the largest. The largest isn't always the state: a search with no results
/// shrinks its state below a settings blob the page also carries, and that page is the route's answer all the same.
/// An event stream's answer as JSON (`text/event-stream`, a search that sends its results as they come): the `data` of
/// each of its events that is JSON, in order, as one list. Read from the body's own shape, whatever its type says:
/// every line is a field of an event (`data:`, `event:`, `id:`, `retry:`) or a comment (`:`), and a blank line ends one.
/// None for any other body, and for a stream none of whose events holds JSON.
/// The data a body holds when the whole of it is that data encoded again as text: base64, in either alphabet, of a
/// JSON object or list. A site sends an answer this way to keep it out of plain sight, and the page decodes it before
/// it shows anything. Read from the body alone: it is one run of the encoding's own characters, long enough to hold
/// something, and what it decodes to is JSON whole. A word, an id or a token decodes to no JSON and is left as it is.
/// Whether a reply body reads as data by a standard reader as it stands — plain JSON, a guarded or padded answer, an
/// event stream, or base64 of JSON — ignoring the learn-time decoded overlay. A reply that reads false here is the
/// site's own to decode (`app::learn::attach_a_decoder`): the overlay must not mask it, so this never calls `own_json`.
pub fn reads_by_a_standard_reader(body: &str) -> bool {
    !body.trim().is_empty()
        && (serde_json::from_str::<serde_json::Value>(body).is_ok()
            || guarded_json(body).is_some()
            || event_stream_json(body).is_some()
            || encoded_json(body).is_some())
}

/// What the site's own decoder (`Answer::decode`) makes of the reply `raw` at call time: the JSON text it unpacks,
/// None where a standard reader reads the reply as it stands (it never reaches a decoder) or the decoder makes no JSON.
/// The one place a call's answer is decoded, for the node's caller (`replay::run`) and the learner's own (`lab::call`).
pub fn decoded_answer(source: &str, raw: &str, env: &crate::generated::Environment) -> Option<String> {
    if reads_by_a_standard_reader(raw) {
        return None;
    }
    crate::generated::decode(source, raw, env).filter(|t| serde_json::from_str::<serde_json::Value>(t).is_ok())
}

pub fn encoded_json(body: &str) -> Option<serde_json::Value> {
    use base64::Engine;
    let text = body.trim();
    let in_alphabet = |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_' | '=');
    if text.len() < 24 || !text.chars().all(in_alphabet) {
        return None;
    }
    let bare = text.trim_end_matches('=');
    let engines = [base64::engine::general_purpose::STANDARD_NO_PAD, base64::engine::general_purpose::URL_SAFE_NO_PAD];
    let decoded = engines.iter().find_map(|e| e.decode(bare).ok())?;
    let inner = std::str::from_utf8(&decoded).ok()?.trim();
    if !inner.starts_with(['{', '[']) {
        return None;
    }
    serde_json::from_str(inner).ok()
}

pub fn event_stream_json(body: &str) -> Option<serde_json::Value> {
    let lines: Vec<&str> = body.lines().map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let field = |l: &str| ["data:", "event:", "id:", "retry:", ":"].iter().any(|f| l.starts_with(f)) || ["data", "event", "id", "retry"].contains(&l);
    if !lines.iter().any(|l| l.starts_with("data")) || !lines.iter().all(|l| l.is_empty() || field(l)) {
        return None;
    }
    let mut events = Vec::new();
    let mut data: Vec<&str> = Vec::new();
    for l in lines.iter().chain(std::iter::once(&"")) {
        if l.is_empty() {
            if !data.is_empty() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data.join("\n")) {
                    events.push(v);
                }
                data.clear();
            }
        } else if let Some(d) = l.strip_prefix("data") {
            let d = d.strip_prefix(':').unwrap_or(d);
            data.push(d.strip_prefix(' ').unwrap_or(d));
        }
    }
    (!events.is_empty()).then_some(serde_json::Value::Array(events))
}

/// A body's JSON read from the text alone, for a reader that holds no exchange (what a site said in an error): the
/// body itself, behind a guard, or a stream's events. A callback's wrapping needs the address that named it, so that
/// one is `Exchange::own_json`'s to read.
pub fn body_json(body: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(body).ok().or_else(|| guarded_json(body)).or_else(|| event_stream_json(body))
}

/// The JSON behind a guard: a site may open a JSON answer with characters that stop it running as a script on another
/// site's page (`)]}'` and a line break, `for(;;);`, `while(1);`, a script-closing `</x>//`), and its own code reads
/// past them. What makes a guard a guard, read from the text alone: it ends where a statement, a line or a comment
/// ends, it carries no line of its own, and everything after it is one JSON document. Text that merely holds a bracket
/// further in is not that.
pub fn guarded_json(body: &str) -> Option<serde_json::Value> {
    let body = body.trim_start();
    let at = body.find(['{', '['])?;
    let (guard, rest) = body.split_at(at);
    // Where the site's own code stops reading the guard: the end of a line (a break, or the quote `)]}'` puts there),
    // the end of a statement (`;`), or the end of a comment (`//` to the line's end, `*/`). The answer begins on the
    // line the guard ends on, so a guard never spans a line and then carries on.
    let bare = guard.trim_end();
    let a_line_end = guard.ends_with('\n') && guard.matches('\n').count() == 1;
    let an_ending = !guard.contains('\n') && (bare.ends_with([';', '\'']) || bare.ends_with("//") || bare.ends_with("*/"));
    if guard.is_empty() || !(a_line_end || an_ending) {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(rest.trim()).ok().filter(|v| v.is_object() || v.is_array())
}

pub fn embedded_json_like(body: &str, like: Option<&serde_json::Value>) -> Option<String> {
    pick_json_blob(body, like).map(|(text, _)| text.to_string())
}

pub(crate) fn embedded_json_value_like(body: &str, like: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    pick_json_blob(body, like).map(|(_, value)| value)
}

fn pick_json_blob<'a>(body: &'a str, like: Option<&serde_json::Value>) -> Option<(&'a str, serde_json::Value)> {
    let like = like.and_then(serde_json::Value::as_object);
    json_blobs(body).max_by_key(|(text, value)| {
        let shared = like.zip(value.as_object()).map_or(0, |(wanted, held)| wanted.keys().filter(|key| held.contains_key(*key)).count());
        (shared, text.len())
    })
}

/// Each script on the page whose tag says it holds JSON, and that parses, in the page's order.
fn json_blobs(body: &str) -> impl Iterator<Item = (&str, serde_json::Value)> {
    let mut from = 0;
    std::iter::from_fn(move || loop {
        let start = body[from..].find("<script")?;
        let tag_start = from + start;
        let tag_len = body[tag_start..].find('>')?;
        let attrs = body[tag_start..tag_start + tag_len].to_ascii_lowercase();
        let content_start = tag_start + tag_len + 1;
        let rel_end = body[content_start..].find("</script>")?;
        // A state blob's tag says it holds JSON, whatever else it carries (`id="__NEXT_DATA__"` before or after).
        let json = attrs.contains(r#"type="application/json""#) || attrs.contains("type='application/json'");
        let candidate = &body[content_start..content_start + rel_end];
        from = content_start + rel_end;
        if let Some(value) = json.then(|| serde_json::from_str(candidate).ok()).flatten() {
            return Some((candidate, value));
        }
    })
}

/// Whether `v` has at least half the top-level keys of `like`: the same kind of answer, as a replay weighs it.
pub fn shares_top_keys(v: &serde_json::Value, like: &serde_json::Value) -> bool {
    match (v.as_object(), like.as_object()) {
        (Some(o), Some(l)) if !l.is_empty() => l.keys().filter(|k| o.contains_key(k.as_str())).count() * 2 >= l.len(),
        _ => false,
    }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/// What a page's address asks it for, as names and values: its query, and its fragment where that is written as a
/// query too (`#q=dividend`, `#/search?q=dividend`). A page that reads its search from the fragment is asked there as
/// much as one that reads its query; a fragment that names a place on the page (`#reviews`) asks for nothing.
pub fn asked_pairs(url: &url::Url) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    for (k, v) in fragment_pairs(url) {
        if !out.iter().any(|(have, _)| *have == k) {
            out.push((k, v));
        }
    }
    out
}

/// The pairs the address's fragment asks for, where it is written as a query ([`asked_pairs`]): what the page was
/// asked that never reached a server in the address.
pub fn fragment_pairs(url: &url::Url) -> Vec<(String, String)> {
    let fragment = url.fragment().unwrap_or_default();
    let pairs = fragment.split_once('?').map(|(_, q)| q).unwrap_or_else(|| fragment.trim_start_matches(['!', '/']));
    if !pairs.contains('=') {
        return Vec::new();
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in url::form_urlencoded::parse(pairs.as_bytes()) {
        let named = !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '[' | ']'));
        if named && !out.iter().any(|(have, _)| *have == k) {
            out.push((k.into_owned(), v.into_owned()));
        }
    }
    out
}

/// Whether a value the walked address carried in its fragment acted as a credential in the walk. A fragment never
/// reaches a server in the address: the page's own code read it and carried it on, and where it carried it says what it
/// is. It is a credential when the walk sends it where a credential goes (a cookie, or a header that isn't the browser's
/// own: an `Authorization`, an API key's), or when the walk sends it to a site and no answer to a request that carried
/// it says it back whole: a value the site was given only to check, as a typed password is read. A value the site says
/// back (the search it ran) is what the page was asked. A flag or a single character (`slots::bound_by_key`) is never
/// one.
///
/// This marks a value secret on the node's own copy of a route; it never clears one. What leaves the node with a shared
/// route is decided at the sharing boundary from the owner's own address, whatever this says: a value the fragment
/// carried is withheld there however the site answered (`recipe::compile_with`).
pub fn fragment_credential(value: &str, exchanges: &[Exchange]) -> bool {
    if crate::slots::bound_by_key(value) {
        return false;
    }
    let in_a_credentials_place = exchanges.iter().any(|e| {
        e.request_headers.iter().any(|(k, v)| {
            let k = k.to_ascii_lowercase();
            (k == "cookie" || !crate::slots::is_browser_header(&k)) && carries_whole(v, value)
        })
    });
    let carried: Vec<&Exchange> = exchanges
        .iter()
        .filter(|e| carries_whole(e.url.as_str(), value) || e.request_body.as_deref().is_some_and(|b| carries_whole(b, value)))
        .collect();
    let only_checked = !carried.is_empty() && !carried.iter().any(|e| e.response_body.as_deref().is_some_and(|b| carries_whole(b, value)));
    in_a_credentials_place || only_checked
}

/// Whether `text` (an address, a body, a frame) sends `value`, read the way a server reads it: each layer of
/// escaping undone in turn (`%20` or `+` for a space, `\"` or `é` inside a JSON string) until nothing changes,
/// so a value nested at any depth (a form string inside JSON inside a query) is still seen. Case is ignored.
pub fn carries_text(text: &str, value: &str) -> bool {
    let value = value.to_lowercase();
    !value.trim().is_empty() && readings(text).iter().any(|r| r.contains(&value))
}

/// Whether `text` holds `value` whole, read the same way as [`carries_text`]: not as part of a longer word or number
/// (`1234` isn't said back by `12345`), so a short value doesn't turn up in a big answer by chance.
pub fn carries_whole(text: &str, value: &str) -> bool {
    Readings::of(text).carries_whole(value)
}

/// A text's layers ([`readings`]), read once to be searched many times: a learn asks whether one page's text holds
/// each of hundreds of words, and reading a megabyte's layers afresh for every word took minutes.
pub struct Readings(Vec<String>);

impl Readings {
    pub fn of(text: &str) -> Self {
        Readings(readings(text))
    }

    /// [`carries_whole`] of the text these are the readings of.
    pub fn carries_whole(&self, value: &str) -> bool {
        let value = value.to_lowercase();
        if value.trim().is_empty() {
            return false;
        }
        self.0.iter().any(|r| r.match_indices(value.as_str()).any(|(at, _)| whole_at(r, at, at + value.len())))
    }
}

fn whole_at(text: &str, start: usize, end: usize) -> bool {
    !text[..start].chars().next_back().is_some_and(char::is_alphanumeric) && !text[end..].chars().next().is_some_and(char::is_alphanumeric)
}

/// The lowercased values carried whole by any source, with each source scanned once per layer of escaping.
pub fn whole_values<'a>(texts: impl IntoIterator<Item = &'a str>, values: impl IntoIterator<Item = &'a str>) -> std::collections::HashSet<String> {
    use std::collections::HashSet;

    let distinct: HashSet<_> = values.into_iter().filter(|v| !v.trim().is_empty()).map(str::to_lowercase).collect();
    let values: Vec<_> = distinct.into_iter().collect();
    if values.is_empty() {
        return HashSet::new();
    }
    let finder = (values.len() > 1).then(|| aho_corasick::AhoCorasick::new(&values).ok()).flatten();
    let Some(finder) = finder else {
        let mut found = HashSet::new();
        for text in texts {
            let readings = Readings::of(text);
            for value in &values {
                if !found.contains(value) && readings.carries_whole(value) {
                    found.insert(value.clone());
                }
            }
        }
        return found;
    };
    let mut found = vec![false; values.len()];
    let mut remaining = values.len();
    let mut next = vec![0; values.len()];
    'sources: for text in texts {
        for layer in readings(text) {
            next.fill(0);
            for hit in finder.find_overlapping_iter(layer.as_str()) {
                let i = hit.pattern().as_usize();
                if found[i] || hit.start() < next[i] {
                    continue;
                }
                // Match the non-overlapping order of `str::match_indices` for each individual value.
                next[i] = hit.end();
                if whole_at(&layer, hit.start(), hit.end()) {
                    found[i] = true;
                    remaining -= 1;
                    if remaining == 0 {
                        break 'sources;
                    }
                }
            }
        }
    }
    values.into_iter().zip(found).filter_map(|(value, found)| found.then_some(value)).collect()
}

/// One layer of the ways a value may be written as text (each with whether it sits inside longer text by nature): as
/// itself; as an address carries it (percent-encoded, or form-encoded with `+` for a space); as a JSON string or
/// markup escapes it (a text node, an attribute, every quote by name or number); and as base64, standard or for
/// addresses, with or without padding, whole or as the part of a longer encoding that always holds it, at any of the
/// three places the value can start (these sit inside longer text by nature).
fn written_once(value: &str) -> Vec<(String, bool)> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    use base64::Engine;
    let mut forms: Vec<(String, bool)> = vec![(value.to_string(), false)];
    let mut put = |f: String, within: bool| {
        if !f.is_empty() && !forms.iter().any(|(g, _)| *g == f) {
            forms.push((f, within));
        }
    };
    put(percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string(), false);
    put(url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>(), false);
    if let Ok(json) = serde_json::to_string(value) {
        put(json[1..json.len() - 1].to_string(), false);
    }
    // Markup: what a text node's serialisation escapes, what an attribute's does, and every quote said by name or
    // number, as servers and libraries write them.
    let escaped = |quote: &str, apos: &str, all: bool| {
        value.chars().fold(String::new(), |mut out, c| {
            match c {
                '&' => out.push_str("&amp;"),
                '<' if all => out.push_str("&lt;"),
                '>' if all => out.push_str("&gt;"),
                '"' if !quote.is_empty() => out.push_str(quote),
                '\'' if !apos.is_empty() => out.push_str(apos),
                '\u{a0}' => out.push_str("&nbsp;"),
                c => out.push(c),
            }
            out
        })
    };
    put(escaped("", "", true), false);
    put(escaped("&quot;", "", false), false);
    for (quote, apos) in [("&quot;", "&#39;"), ("&quot;", "&#x27;"), ("&#34;", "&#39;"), ("&quot;", "&apos;"), ("&#x22;", "&#x27;")] {
        put(escaped(quote, apos, true), false);
    }
    // Base64, standard and for addresses, whole (with its padding or without) ...
    let bytes = value.as_bytes();
    for engine in [&STANDARD, &URL_SAFE, &STANDARD_NO_PAD, &URL_SAFE_NO_PAD] {
        put(engine.encode(bytes), true);
    }
    // ... and the part of it a longer encoding always holds, wherever the value starts in it: at an offset of k bytes
    // into a group of three, the first characters mix in what came before and the last what comes after.
    for k in 0..3usize {
        let mut shifted = vec![0u8; k];
        shifted.extend_from_slice(bytes);
        let head = (k * 8).div_ceil(6);
        let tail = usize::from(shifted.len() % 3 != 0);
        for engine in [&STANDARD_NO_PAD, &URL_SAFE_NO_PAD] {
            let all = engine.encode(&shifted);
            if let Some(core) = all.get(head..all.len().saturating_sub(tail)).filter(|c| c.len() >= 4) {
                put(core.to_string(), true);
            }
        }
    }
    forms
}

/// How many layers of its own forms the reader applies to a value: base64 of a value already base64, an address's
/// escape of base64, base64 of a JSON string, and so on, three deep. One layer is how a page or a client usually
/// writes a value; two is a token wrapped once more on its way (a cookie that holds a base64 blob, sent in a base64
/// header); three covers one more wrapping than anything seen in a walk, and the count of forms stays bounded
/// ([`WRITTEN_FORMS_MOST`]). A transform the reader doesn't know (a reversal, a cipher, a split) or nesting deeper than
/// this isn't seen (SECURITY.md, "What isn't defended").
pub const WRITTEN_DEPTH: usize = 3;
/// The most forms one value is read in, its own first, then each layer's in turn.
pub const WRITTEN_FORMS_MOST: usize = 2048;
/// A form longer than this (in bytes) isn't written again in a further layer: a value that long is read as it is and in
/// one layer of its forms, which bounds the work on a long value.
pub const WRITTEN_FORM_LONGEST: usize = 2048;

/// Every way a value may be written as text, the one list of it: [`written_once`] applied to the value, then to each
/// form it gave, [`WRITTEN_DEPTH`] layers deep, at most [`WRITTEN_FORMS_MOST`] forms. Each says whether it sits inside
/// longer text by nature (any layer of base64 does). [`carries_written`] reads text by it, and every mask of a value the
/// node holds replaces these ([`Written`]).
pub fn written_forms(value: &str) -> Vec<(String, bool)> {
    let mut all: Vec<(String, bool)> = written_once(value);
    let mut seen: std::collections::HashSet<String> = all.iter().map(|(f, _)| f.clone()).collect();
    let mut layer: Vec<(String, bool)> = all.iter().skip(1).cloned().collect();
    for _ in 1..WRITTEN_DEPTH {
        let mut next = Vec::new();
        for (form, within) in &layer {
            if form.len() > WRITTEN_FORM_LONGEST {
                continue;
            }
            for (again, inside) in written_once(form).into_iter().skip(1) {
                if all.len() >= WRITTEN_FORMS_MOST {
                    return all;
                }
                if seen.insert(again.clone()) {
                    all.push((again.clone(), *within || inside));
                    next.push((again, *within || inside));
                }
            }
        }
        layer = next;
    }
    all
}

/// A value's [`written_forms`], ready to find in text and to replace: built once per value and kept a while.
pub struct Written {
    forms: Vec<(String, bool)>,
    /// The search forms, found overlapping, each with whether it may stand inside longer text.
    detect: Option<(aho_corasick::AhoCorasick, Vec<bool>)>,
    /// The forms as written, longest first where they overlap, for a mask.
    replace: Option<aho_corasick::AhoCorasick>,
    long: bool,
    exact: bool,
}

/// The values a [`Written`] was built for lately; dropped whole when it grows past this.
const WRITTEN_KEPT: usize = 1024;
static WRITTEN: std::sync::Mutex<Option<std::collections::HashMap<String, std::sync::Arc<Written>>>> = std::sync::Mutex::new(None);

impl Written {
    /// The reader for `value`.
    pub fn of(value: &str) -> std::sync::Arc<Written> {
        let mut kept = WRITTEN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let map = kept.get_or_insert_with(Default::default);
        if let Some(w) = map.get(value) {
            return w.clone();
        }
        if map.len() >= WRITTEN_KEPT {
            map.clear();
        }
        let w = std::sync::Arc::new(Written::build(value, false));
        map.insert(value.to_string(), w.clone());
        w
    }

    /// Checks a secret even inside longer strings, without putting it in the shared cache.
    pub fn secret(value: &str) -> Written {
        Written::build(value, true)
    }

    fn build(value: &str, secret: bool) -> Written {
        let forms: Vec<(String, bool)> = if value.is_empty() || (!secret && value.trim().is_empty()) {
            Vec::new()
        } else {
            written_forms(value).into_iter().filter(|(f, _)| !f.is_empty()).collect()
        };
        let mut patterns: Vec<(String, bool)> = Vec::new();
        for (form, within) in &forms {
            let form = if secret { form.clone() } else { form.to_lowercase() };
            match patterns.iter_mut().find(|(pattern, _)| *pattern == form) {
                Some((_, w)) => *w |= *within,
                None => patterns.push((form, *within)),
            }
        }
        let detect = (!patterns.is_empty())
            .then(|| aho_corasick::AhoCorasick::new(patterns.iter().map(|(f, _)| f.as_str())).ok().map(|ac| (ac, patterns.iter().map(|(_, w)| *w).collect())))
            .flatten();
        let replace = (!forms.is_empty())
            .then(|| aho_corasick::AhoCorasick::builder().match_kind(aho_corasick::MatchKind::LeftmostLongest).build(forms.iter().map(|(f, _)| f.as_str())).ok())
            .flatten();
        Written { forms, detect, replace, long: secret || value.chars().count() >= WRITTEN_ANYWHERE, exact: secret }
    }

    /// The reader for `value` with no finder, as one that couldn't build reads: for tests of that path.
    #[cfg(test)]
    pub(crate) fn without_finder(value: &str) -> Written {
        Written { detect: None, replace: None, ..Written::build(value, false) }
    }

    /// The forms, the value's own first.
    pub fn forms(&self) -> &[(String, bool)] {
        &self.forms
    }

    /// Whether `text` carries the value ([`carries_written`]). Should the finder not have built (it can refuse a set
    /// past its own limits), each form is looked for on its own: slower, never a reading that found nothing because it
    /// didn't run.
    pub fn carries(&self, text: &str) -> bool {
        if self.long && self.forms.first().is_some_and(|(literal, _)| text.contains(literal)) {
            return true;
        }
        let counts = |r: &str, at: usize, end: usize, within: bool| {
            let before = r[..at].chars().next_back();
            let after = r[end..].chars().next();
            self.long || within || (!before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric))
        };
        let text_forms = if self.exact { readings_as(text, str::to_owned) } else { readings(text) };
        text_forms.iter().any(|r| match &self.detect {
            Some((ac, within)) => ac.find_overlapping_iter(r.as_str()).any(|m| counts(r, m.start(), m.end(), within[m.pattern().as_usize()])),
            None => self.forms.iter().any(|(f, within)| {
                let f = if self.exact { f.clone() } else { f.to_lowercase() };
                r.match_indices(f.as_str()).any(|(at, _)| counts(r, at, at + f.len(), *within))
            }),
        })
    }

    /// `text` with every form of the value, wherever it stands, said as `with`. Without a finder, each form is replaced
    /// on its own, longest first.
    pub fn replace_all(&self, text: &str, with: &str) -> String {
        match &self.replace {
            Some(ac) => ac.replace_all(text, &vec![with; ac.patterns_len()]),
            None => {
                let mut forms: Vec<&str> = self.forms.iter().map(|(f, _)| f.as_str()).collect();
                forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
                forms.into_iter().fold(text.to_string(), |t, f| t.replace(f, with))
            }
        }
    }
}

/// Whether `text` carries `value`, however it is written: any of its [`written_forms`] (to [`WRITTEN_DEPTH`] layers),
/// found in any layer of the text's escaping ([`readings`]), whole (not inside a longer word or number), or anywhere for
/// a form that sits inside longer text by nature or a value of [`WRITTEN_ANYWHERE`] characters or more. Case is
/// ignored. Read in one pass over each layer of the text, however many forms there are, so a large text costs its
/// length times its layers. The one reading of "this text still carries that value": the sharing boundary's leftover
/// check, an agent's call guard, the route view an agent is shown and the masks of what is said to an agent all use it
/// or its forms. A transform it doesn't know, or nesting deeper than [`WRITTEN_DEPTH`], isn't seen.
pub fn carries_written(text: &str, value: &str) -> bool {
    !value.trim().is_empty() && Written::of(value).carries(text)
}

/// A value at least this long is carried wherever it stands, inside a longer word too: too long to turn up by chance.
pub const WRITTEN_ANYWHERE: usize = 12;

/// Every layer of a text, from as sent to fully unescaped, in lower case.
fn readings(text: &str) -> Vec<String> {
    readings_as(text, str::to_lowercase)
}

fn readings_as(text: &str, normalize: impl Fn(&str) -> String) -> Vec<String> {
    let mut out = vec![normalize(text)];
    let mut cur = text.to_string();
    // Each pass undoes one layer; the depth is bounded so a text that keeps changing can't loop.
    for _ in 0..8 {
        let unquoted = percent_encoding::percent_decode_str(&cur.replace('+', " ")).decode_utf8_lossy().into_owned();
        let next = unescape_json(&unquoted);
        if next == cur {
            break;
        }
        out.push(normalize(&unquoted));
        out.push(normalize(&next));
        cur = next;
    }
    out
}

/// A text with JSON's string escapes undone wherever they sit; anything that isn't one is left as it was.
fn unescape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    let hex4 = |chars: &mut std::iter::Peekable<std::str::Chars>| -> Option<u32> {
        let code: String = (0..4).filter_map(|_| chars.next_if(|c| c.is_ascii_hexdigit())).collect();
        (code.len() == 4).then(|| u32::from_str_radix(&code, 16).ok()).flatten()
    };
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('u') => match hex4(&mut chars) {
                Some(hi @ 0xD800..=0xDBFF) => {
                    let lo = (chars.next_if_eq(&'\\').is_some() && chars.next_if_eq(&'u').is_some()).then(|| hex4(&mut chars)).flatten();
                    match lo {
                        Some(lo @ 0xDC00..=0xDFFF) => out.extend(char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))),
                        _ => out.push('\u{FFFD}'),
                    }
                }
                Some(code) => out.push(char::from_u32(code).unwrap_or('\u{FFFD}')),
                None => out.push_str("\\u"),
            },
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Something the agent typed during the flow. Secrets, such as passwords, are never published;
/// they become parameters filled from the user's vault.
#[derive(Clone, Debug)]
pub struct Input {
    pub name: String,
    pub value: String,
    pub secret: bool,
}

impl Input {
    pub fn new(name: &str, value: &str) -> Self {
        Self { name: name.into(), value: value.into(), secret: false }
    }

    pub fn secret(name: &str, value: &str) -> Self {
        Self { name: name.into(), value: value.into(), secret: true }
    }
}

#[derive(Clone, Debug)]
pub struct Trace {
    pub exchanges: Vec<Exchange>,
    pub inputs: Vec<Input>,
}

/// One frame of the stack that sent a request, as the browser reports it: the script, and a zero-based line and
/// column in it (the column in UTF-16 units, as the browser counts).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frame {
    pub script: String,
    pub line: u32,
    pub column: u32,
    pub function: String,
}

/// What the browser saw the page's own code do for one call (`url`). Either a header it set, with the string it built
/// just before: what a recipe is fitted from. Or, with no header named, the stack that sent the call (`stack`): where
/// in the page's code the request was made, which is where a search for what wrote its values starts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Probe {
    pub header: String,
    pub value: String,
    pub url: String,
    pub input: String,
    /// What the header's payload was before the page encoded it, when the probe could see it (a `btoa` call). Empty
    /// otherwise: a custom encoder is not a library call, and its input is not observable without hooking it.
    pub pre: String,
    /// The frames that sent the call, innermost first, then those that scheduled it where the browser kept them.
    /// Empty on a probe of a header.
    pub stack: Vec<Frame>,
}

impl Exchange {
    /// Whether this may be a page the main frame was served, rather than a call or a frame's own document.
    /// Without frames recorded, every document may be.
    pub fn is_main_document(&self) -> bool {
        self.main_frame != Some(false) && self.resource_type.as_deref() == Some("Document")
    }

    /// The request received a final HTTP response. A capture uses zero when no response was recorded.
    pub fn has_final_http_response(&self) -> bool {
        self.status >= 200
    }

    /// Whether the site answered with a refusal a door gives while it decides.
    pub fn is_refused(&self) -> bool {
        REFUSED.contains(&self.status)
    }
}

/// The statuses a door answers a page with while it decides: forbidden, too many requests, unavailable.
pub const REFUSED: [u16; 3] = [403, 429, 503];

/// Why a main document opened the walk's door ([`Trace::door_why`]): each is something the walk shows, never a page's
/// looks alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DoorWhy {
    /// The site refused the page ([`REFUSED`]).
    Refused,
    /// The main frame was served another site's page: a waiting room.
    AnotherSite,
    /// A page that only runs its own code, which the walk went on past to the site's page.
    WentPast,
}

impl DoorWhy {
    /// The name a log line and the x-ray carry.
    pub fn name(self) -> &'static str {
        match self {
            DoorWhy::Refused => "refused",
            DoorWhy::AnotherSite => "another_site",
            DoorWhy::WentPast => "went_past",
        }
    }
}

/// One exchange inside the walk's door: its index, the main document that holds it there, and why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InDoor {
    pub index: usize,
    pub by: usize,
    pub why: DoorWhy,
}

impl Trace {
    /// The site's front door, read from the walk itself: from the first page the main frame was refused (or
    /// served by another site, as a waiting room is) to the page of the site's own that it was finally let
    /// through to. Everything in between is the door: the challenge, its scripts and probes, the vendor's
    /// frames. The browser passed it at mint time; a route never replays it, and its cookies come from the jar.
    pub fn door(&self, site: &str) -> Vec<usize> {
        self.door_why(site).into_iter().map(|d| d.index).collect()
    }

    /// The door's stretch as [`Trace::door`] reads it, each exchange with the main document that holds it there and
    /// why that document is the door's: what a reader of a learn (the node's log, the x-ray) is shown for every call
    /// the door took away. One pass, so the door and its reasons never disagree.
    pub fn door_why(&self, site: &str) -> Vec<InDoor> {
        // The page the walk was finally let through to: the last on-site main document that is a page rather than a
        // gate — one that says something, or is more than a script-only stub. A gate-like document before it is part of
        // the door even when its status is not a refusal and no vendor's name is on it: a site may answer a navigation
        // `202` with a page that runs code and says nothing, the way Booking.com does, and the browser passes it.
        // A walk that ended on such a page was not shown to be stopped: an app's shell looks the same as a check that
        // serves itself (a script, no words, no link), and its calls may be answered from any host. Its calls stay
        // candidates, and replay judges them; a check is told by `graph::Door::met` and by what the site answers.
        let gate = |e: &Exchange| crate::page::a_door(e.status, e.response_body.as_deref().unwrap_or_default(), &e.url);
        let real = self
            .exchanges
            .iter()
            .enumerate()
            .rev()
            .find(|(_, e)| {
                e.is_main_document()
                    && e.url.host_str().is_some_and(|h| crate::identity::on_site(h, site))
                    && (200..300).contains(&e.status)
                    && !gate(e)
            })
            .map(|(i, _)| i);
        let mut out = Vec::new();
        let mut held: Option<(usize, DoorWhy)> = None;
        for (i, e) in self.exchanges.iter().enumerate() {
            if e.is_main_document() && e.has_final_http_response() {
                let own = e.url.host_str().is_some_and(|h| crate::identity::on_site(h, site));
                // Another site's document is a waiting room only when it is known to be the main frame's: in a log
                // without frames it may be an ad's or a widget's frame.
                if own || e.main_frame == Some(true) {
                    held = if !own {
                        Some((i, DoorWhy::AnotherSite))
                    } else if e.is_refused() {
                        Some((i, DoorWhy::Refused))
                    } else if gate(e) && real.is_some_and(|r| i < r) {
                        Some((i, DoorWhy::WentPast))
                    } else {
                        None
                    };
                }
            }
            if let Some((by, why)) = held {
                out.push(InDoor { index: i, by, why });
            }
        }
        out
    }

    /// The hosts the walk's door was made of: the gates it passed on the way to the site.
    pub fn gates(&self, site: &str) -> Vec<String> {
        let mut hosts: Vec<String> = self
            .door(site)
            .into_iter()
            .map(|i| &self.exchanges[i].url)
            .filter(|u| matches!(u.scheme(), "http" | "https"))
            .filter_map(|u| u.host_str().map(String::from))
            .collect();
        hosts.sort();
        hosts.dedup();
        hosts
    }

    /// The trace without its front door: what a route may contain.
    /// Indices shift, so this runs before anything else looks at exchanges.
    pub fn without_door(&self, site: &str) -> Trace {
        let door = self.door(site);
        Trace {
            exchanges: self.exchanges.iter().enumerate().filter(|(i, _)| !door.contains(i)).map(|(_, e)| e.clone()).collect(),
            inputs: self.inputs.clone(),
        }
    }

    pub fn from_har(har: &str, inputs: Vec<Input>) -> Result<Self, TraceError> {
        Ok(Self::with_har(serde_json::from_str(har)?, inputs))
    }

    pub(crate) fn from_har_value(har: serde_json::Value) -> Result<Self, TraceError> {
        Ok(Self::with_har(serde_json::from_value(har)?, Vec::new()))
    }

    fn with_har(har: Har, inputs: Vec<Input>) -> Self {
        let exchanges = har.log.entries.into_iter().filter_map(HarEntry::into_exchange).collect();
        Self { exchanges, inputs }
    }
}

impl HarEntry {
    pub(crate) fn into_exchange(self) -> Option<Exchange> {
        let url = Url::parse(&self.request.url).ok()?;
        let request_headers: Vec<(String, String)> = self.request.headers.into_iter().map(|h| (h.name, h.value)).collect();
        // A body the page compressed, as its `content-encoding` says, is read as what it compresses: what the page's code
        // wrote, typed values and all. The transport compresses it again on the way out (`wire::as_sent`).
        let encoding = request_headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-encoding")).map(|(_, v)| v.clone());
        let request_body = self.request.post_data.and_then(HarPostData::body).map(|body| match &encoding {
            Some(enc) => unbrowse_route::wire::uncompressed(enc, &unbrowse_route::wire::bytes_of(&body)).map(|b| unbrowse_route::wire::carried(&b)).unwrap_or(body),
            None => body,
        });
        Some(Exchange {
            method: self.request.method,
            url,
            request_headers,
            request_body,
            status: self.response.status,
            response_headers: self.response.headers.into_iter().map(|h| (h.name, h.value)).collect(),
            // The body stays exactly as recorded: text markers in a page need
            // the raw HTML (their escaped quotes only exist there), while JSON
            // readers fall back to the page's embedded state blob through
            // `json_body`.
            //
            // A body recorded in base64 is bytes, read as every reply's bytes are (`route::wire::reply_text`): the
            // JSON a codec the engine reads holds, else its text where it is text (a reply the page's own code
            // unpacks, recorded as bytes, is still the text that code reads); bytes that are neither are no body. A
            // call of the route reads the live answer the same way (`http`, `replay`).
            response_body: match self.response.content.encoding.as_deref() {
                None => self.response.content.text,
                Some(enc) if enc.eq_ignore_ascii_case("base64") => self.response.content.text.as_deref().and_then(|t| {
                    use base64::Engine;
                    let bytes = base64::engine::general_purpose::STANDARD.decode(t.trim()).ok()?;
                    unbrowse_route::wire::reply_text(self.response.content.mime_type.as_deref().unwrap_or_default(), &bytes)
                }),
                Some(_) => None,
            },
            response_mime: self.response.content.mime_type.unwrap_or_default(),
            resource_type: self.resource_type,
            main_frame: self.main_frame,
        })
    }
}

// HAR 1.2, only the fields route learning reads.

#[derive(Deserialize)]
struct Har {
    log: HarLog,
}

#[derive(Deserialize)]
struct HarLog {
    entries: Vec<HarEntry>,
}

#[derive(Deserialize)]
pub(crate) struct HarEntry {
    request: HarRequest,
    response: HarResponse,
    /// Chrome's `_resourceType`; `None` when the HAR omits it.
    #[serde(rename = "_resourceType", default)]
    resource_type: Option<String>,
    /// Whether the main frame made it; logs without frames say nothing.
    #[serde(rename = "_mainFrame", default)]
    main_frame: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarRequest {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<HarHeader>,
    post_data: Option<HarPostData>,
}

#[derive(Deserialize)]
struct HarPostData {
    text: Option<String>,
    /// `base64`: `text` is the request's bytes, which are no text (`agent-browser-core`'s `post_data`).
    #[serde(default, rename = "_encoding")]
    encoding: Option<String>,
}

impl HarPostData {
    /// The body as the engine carries one: its text, or bytes that are no text marked (`route::wire::carried`).
    fn body(self) -> Option<String> {
        match self.encoding.as_deref() {
            Some(enc) if enc.eq_ignore_ascii_case("base64") => {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD.decode(self.text?.trim()).ok()?;
                Some(unbrowse_route::wire::carried(&bytes))
            }
            _ => self.text,
        }
    }
}

#[derive(Deserialize)]
struct HarResponse {
    status: u16,
    #[serde(default)]
    headers: Vec<HarHeader>,
    #[serde(default)]
    content: HarContent,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HarContent {
    mime_type: Option<String>,
    text: Option<String>,
    encoding: Option<String>,
}

#[derive(Deserialize)]
struct HarHeader {
    name: String,
    value: String,
}

#[cfg(test)]
mod tests {
    use super::{asked_pairs, fragment_credential, guarded_json, carries_text, carries_whole, embedded_json, embedded_json_like, event_stream_json, page_html_of, Exchange, Trace};
    use super::{carries_written, written_forms, WRITTEN_FORMS_MOST, WRITTEN_FORM_LONGEST};

    /// The reader applies its own forms to its own output, three layers deep: a value base64'd twice, base64 of its
    /// address escape, the escape of its base64, three wrappings; a fourth isn't read, and the forms stay bounded.
    /// A reader whose finder couldn't be built reads and masks the same, slower: never one that finds nothing.
    #[test]
    fn a_reader_without_its_finder_still_reads_and_masks() {
        use base64::Engine;
        let v = "case-4471-private";
        let twice = base64::engine::general_purpose::STANDARD.encode(base64::engine::general_purpose::STANDARD.encode(v));
        let plain = super::Written::without_finder(v);
        let text = format!("a {v} b {twice} c");
        assert!(plain.carries(&text) && plain.carries(&twice));
        assert!(!plain.carries("nothing here"));
        assert_eq!(plain.replace_all(&text, "{q}"), super::Written::of(v).replace_all(&text, "{q}"));
        assert!(!plain.replace_all(&text, "{q}").contains(v));
    }

    #[test]
    fn a_value_written_inside_its_own_forms_is_read_three_deep() {
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        use base64::Engine;
        let v = "case-4471-private";
        let b = |s: &str| STANDARD.encode(s);
        let pct = |s: &str| percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string();
        for (how, text) in [
            ("twice base64", format!("{{\"t\":\"{}\"}}", b(&b(v)))),
            ("base64 of its escape", format!("x={}", b(&pct(&format!("q={v}&n=1"))))),
            ("the escape of its base64", format!("{{\"t\":\"{}\"}}", pct(&b(v)))),
            ("base64 of a JSON string holding it", b(&format!("{{\"q\":\"{v}\"}}"))),
            ("three wrappings", URL_SAFE_NO_PAD.encode(b(&b(v)))),
        ] {
            assert!(carries_written(&text, v), "{how}: {text}");
        }
        assert!(!carries_written(&b(&b(&b(&b(v)))), v), "a fourth layer isn't read");
        assert!(!carries_written("nothing of it here", v));
        assert!(written_forms(v).len() <= WRITTEN_FORMS_MOST);
        let long = "x".repeat(WRITTEN_FORM_LONGEST * 2);
        assert!(written_forms(&long).len() <= WRITTEN_FORMS_MOST, "a long value is bounded too");
    }

    /// A request body recorded as bytes in base64 is carried as those bytes; one recorded as text is its text.
    #[test]
    fn a_request_body_recorded_as_bytes_is_those_bytes() {
        use base64::Engine;
        let bytes = [0x0a, 0x80, 0x01, 0x10, 0xac, 0x02];
        let har = |post: &str| format!(r#"{{"log":{{"entries":[{{"request":{{"method":"POST","url":"https://shop.example/api/search","headers":[],"postData":{post}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"application/json","text":"{{}}"}}}}}}]}}}}"#);
        let as_bytes = har(&format!(r#"{{"mimeType":"application/x-protobuf","text":"{}","_encoding":"base64"}}"#, base64::engine::general_purpose::STANDARD.encode(bytes)));
        let body = Trace::from_har(&as_bytes, Vec::new()).unwrap().exchanges[0].request_body.clone().unwrap();
        assert_eq!(unbrowse_route::wire::bytes_of(&body), bytes);
        let as_text = har(r#"{"mimeType":"application/json","text":"{\"q\":1}"}"#);
        assert_eq!(Trace::from_har(&as_text, Vec::new()).unwrap().exchanges[0].request_body.as_deref(), Some(r#"{"q":1}"#));
    }

    /// A page that compresses its call's body says so in the request's `content-encoding`, and the walk keeps the bytes
    /// it sent. The body reads as what it compresses, so the value typed into the page is found where the page put it;
    /// bytes that say an encoding and aren't in it stay the bytes they are.
    #[test]
    fn a_compressed_request_body_reads_as_what_it_compresses() {
        use base64::Engine;
        let json = r#"{"context":{"client":{"hl":"en","clientName":"WEB"}},"query":"desk lamp"}"#;
        let gzipped = unbrowse_route::wire::as_sent(Some("gzip"), json.as_bytes());
        let har = |headers: &str, bytes: &[u8]| {
            format!(
                r#"{{"log":{{"entries":[{{"request":{{"method":"POST","url":"https://video.example/api/v1/search","headers":{headers},"postData":{{"mimeType":"application/json","text":"{}","_encoding":"base64"}}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"application/json","text":"{{}}"}}}}}}]}}}}"#,
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        };
        let said = r#"[{"name":"Content-Type","value":"application/json"},{"name":"Content-Encoding","value":"gzip"}]"#;
        let e = Trace::from_har(&har(said, &gzipped), Vec::new()).unwrap().exchanges[0].clone();
        assert_eq!(e.request_body.as_deref(), Some(json));
        assert!(crate::slots::slots(&e).iter().any(|s| s.value == "desk lamp"), "the typed value is a place of the call: {:?}", crate::slots::slots(&e));
        let unsaid = Trace::from_har(&har("[]", &gzipped), Vec::new()).unwrap().exchanges[0].clone();
        assert_eq!(unbrowse_route::wire::bytes_of(unsaid.request_body.as_deref().unwrap()), gzipped, "with no encoding said, the bytes are the bytes");
        let not_in_it = [0x0a, 0x80, 0x01];
        let wrong = Trace::from_har(&har(said, &not_in_it), Vec::new()).unwrap().exchanges[0].clone();
        assert_eq!(unbrowse_route::wire::bytes_of(wrong.request_body.as_deref().unwrap()), not_in_it);
    }

    /// A reply recorded in base64 whose type names a codec the engine reads is the JSON it holds; one of any other
    /// type, or that does not open exactly, is no body at all, as before.
    #[test]
    fn a_binary_answer_recorded_in_base64_is_the_json_it_holds() {
        use base64::Engine;
        // {"query": "kettle", "n": 2}
        let mut packed = vec![0x82, 0xa5];
        packed.extend(b"query");
        packed.push(0xa6);
        packed.extend(b"kettle");
        packed.extend([0xa1, b'n', 0x02]);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&packed);
        let har = |mime: &str, text: &str| format!(r#"{{"log":{{"entries":[{{"request":{{"method":"GET","url":"https://shop.example/api/search?q=kettle","headers":[]}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"{mime}","text":"{text}","encoding":"base64"}}}}}}]}}}}"#);
        let read = |mime: &str, text: &str| Trace::from_har(&har(mime, text), Vec::new()).unwrap().exchanges[0].clone();
        let e = read("application/x-msgpack", &encoded);
        assert_eq!(e.own_json(), Some(serde_json::json!({ "query": "kettle", "n": 2 })));
        assert_eq!(read("image/png", &encoded).response_body, None);
        assert_eq!(read("application/x-msgpack", "AAAA").response_body, None, "bytes that do not open are no body");
    }

    /// A reply is read in one place, whether the walk recorded it as text or as bytes: a binary answer of a codec the
    /// engine reads is the JSON it holds, a reply the page's own code unpacks (recorded as bytes, as the capture keeps
    /// every reply the page's script read) is its text and reaches the decoder, and a plain reply is itself. Only the
    /// one no standard reader reads reaches the decoder: the binary answer, read by its codec, never does.
    #[test]
    fn a_ciphered_a_binary_and_a_plain_reply_are_each_read_once_in_one_place() {
        use base64::Engine;
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        // {"query": "kettle", "n": 2}, as MessagePack.
        let mut packed = vec![0x82, 0xa5];
        packed.extend(b"query");
        packed.push(0xa6);
        packed.extend(b"kettle");
        packed.extend([0xa1, b'n', 0x02]);
        let har = |mime: &str, text: &str, encoding: &str| format!(r#"{{"log":{{"entries":[{{"request":{{"method":"GET","url":"https://shop.example/api/search?q=kettle","headers":[]}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"{mime}","text":"{text}"{encoding}}}}}}}]}}}}"#);
        let read = |mime: &str, text: &str, encoding: &str| Trace::from_har(&har(mime, text, encoding), Vec::new()).unwrap().exchanges[0].clone();
        let as_bytes = r#","encoding":"base64""#;
        let binary = read("application/x-msgpack", &b64(&packed), as_bytes);
        let ciphered = read("text/plain", &b64(b"@@not-json-not-base64-%%"), as_bytes);
        let plain = read("application/json", r#"{\"real\":1}"#, "");
        assert_eq!(ciphered.response_body.as_deref(), Some("@@not-json-not-base64-%%"), "a reply recorded as bytes that is text is its text");
        let _guard = super::DecodedGuard::set(vec!["function sign(ctx){ return JSON.stringify({ decoded: true }); }".to_string()]);
        assert_eq!(binary.own_json(), Some(serde_json::json!({ "query": "kettle", "n": 2 })), "a binary answer is the JSON its codec opens, not the decoder's");
        assert_eq!(plain.own_json(), Some(serde_json::json!({ "real": 1 })), "a plain reply reads as itself");
        if crate::sandbox::available() {
            assert_eq!(ciphered.own_json(), Some(serde_json::json!({ "decoded": true })), "only the reply no standard reader reads reaches the decoder");
        }
        // A live answer is read by the same rule: the codec's JSON, else the text.
        assert_eq!(unbrowse_route::wire::reply_read("application/x-msgpack", &packed), binary.response_body.clone().unwrap());
        assert_eq!(unbrowse_route::wire::reply_read("text/plain", b"@@not-json-not-base64-%%"), "@@not-json-not-base64-%%");
    }

    /// A reply a standard reader reads never reaches a decoder: with a learn's decoder set (one that would turn any
    /// text into a fixed object), a plain JSON reply still reads as itself, and base64-of-JSON still reads as its
    /// JSON — the decoded overlay is the last resort of `own_json`, reached only where every standard reader returned
    /// nothing. A reply none of them read is the only one the decoder reads.
    #[test]
    fn a_reply_a_standard_reader_reads_never_reaches_a_decoder() {
        use base64::Engine;
        let ex = |body: &str| Exchange {
            method: "GET".into(), url: "https://shop.example/x".parse().unwrap(), request_headers: vec![], request_body: None,
            status: 200, response_headers: vec![], response_body: Some(body.into()), response_mime: "text/plain".into(), resource_type: Some("XHR".into()), main_frame: None,
        };
        let decoder = "function sign(ctx){ return JSON.stringify({ decoded: true }); }".to_string();
        let plain = ex("{\"real\":1}");
        let encoded = ex(&base64::engine::general_purpose::STANDARD.encode("{\"real\":2,\"and\":\"a longer body so it reads as encoded JSON\"}"));
        let ciphered = ex("@@not-json-not-base64-%%");
        let _guard = super::DecodedGuard::set(vec![decoder]);
        let out = (plain.own_json(), encoded.own_json(), ciphered.own_json());
        assert_eq!(out.0, Some(serde_json::json!({"real": 1})), "a plain JSON reply reads as itself, not the decoder's");
        assert_eq!(out.1.as_ref().and_then(|v| v.get("real")), Some(&serde_json::json!(2)), "base64 of JSON reads as its JSON, not the decoder's");
        assert_eq!(out.2, Some(serde_json::json!({"decoded": true})), "only a reply no standard reader reads reaches the decoder");
    }

    /// An ordinary page walked with a learn's decoder set (one that would turn any text into a fixed object): its
    /// document, its three scripts and its two stylesheets are resources the browser loaded and consumed, never a reply
    /// a script was handed, so no decoder is run over any of them, however often recognition asks; its one data call
    /// answers JSON and reads as itself. No decoder run is no sandbox child: the walk starts none.
    #[test]
    fn a_resource_the_browser_loaded_is_never_run_through_a_decoder() {
        let ex = |url: &str, kind: &str, mime: &str, body: &str| Exchange {
            method: "GET".into(), url: url.parse().unwrap(), request_headers: vec![], request_body: None, status: 200,
            response_headers: vec![("content-type".into(), mime.into())], response_body: Some(body.into()), response_mime: mime.into(),
            resource_type: Some(kind.into()), main_frame: Some(true),
        };
        let walk = [
            ex("https://store.example/blogs/read/a-day-out", "Document", "text/html", "<!doctype html><html><head><title>A day out</title></head><body><article>A day out</article></body></html>"),
            ex("https://store.example/s/theme.js", "Script", "application/javascript", "(function(){ window.theme = { cart: function () { return fetch('/cart.js'); } }; })();"),
            ex("https://store.example/s/vendor.js", "Script", "text/javascript", "var a=1;function b(c){return c*2}window.vendor={b:b};"),
            // A script a worker imported: recorded as `Other`, declared a script.
            ex("https://store.example/s/pixel.js", "Other", "text/javascript", "!function(){var q=[];self.track=function(e){q.push(e)}}();"),
            ex("https://store.example/s/theme.css", "Stylesheet", "text/css", "body{margin:0}article{font:16px/1.5 serif}"),
            ex("https://store.example/s/fonts.css", "Stylesheet", "text/css", "@font-face{font-family:Body;src:url(/f/body.woff2)}"),
            ex("https://store.example/api/articles/a-day-out", "Fetch", "application/json", r#"{"title":"A day out","body":"..."}"#),
        ];
        let _guard = super::DecodedGuard::set(vec!["function sign(ctx){ return JSON.stringify({ decoded: true }); }".to_string()]);
        let before = super::decoder_runs();
        for _ in 0..3 {
            for e in &walk[..6] {
                assert_eq!(e.own_json(), None, "{} is a resource, not an answer the page unpacked", e.url);
                assert!(!e.could_be_unpacked_by_the_page(), "{}", e.url);
            }
            assert_eq!(walk[6].own_json(), Some(serde_json::json!({"title": "A day out", "body": "..."})));
        }
        assert_eq!(super::decoder_runs() - before, 0, "no decoder was run, so no sandbox child was started");
    }

    /// The data call whose answer only the page's own function unpacks is the one reply a decoder is run over: once,
    /// however often it is read, and a decoder that made nothing of a body is not run on it again in the learn, nested
    /// scopes included.
    #[test]
    fn a_decoder_runs_once_on_the_one_reply_a_script_was_handed() {
        let ex = |kind: &str, body: &str| Exchange {
            method: "GET".into(), url: "https://shop.example/api/search?q=lamp".parse().unwrap(), request_headers: vec![], request_body: None,
            status: 200, response_headers: vec![], response_body: Some(body.into()), response_mime: "text/plain".into(), resource_type: Some(kind.into()), main_frame: None,
        };
        let ciphered = ex("Fetch", "@@not-json-not-base64-%%");
        let unread = ex("XHR", "##another-reply-nothing-reads##");
        assert!(ciphered.could_be_unpacked_by_the_page() && unread.could_be_unpacked_by_the_page());
        let decoder = "function sign(ctx){ return ctx.body.indexOf('@@') === 0 ? JSON.stringify({ decoded: true }) : ''; }".to_string();
        let _guard = super::DecodedGuard::set(vec![decoder.clone()]);
        let before = super::decoder_runs();
        let first = ciphered.own_json();
        let _ = unread.own_json();
        assert_eq!(super::decoder_runs() - before, 2, "one run for each reply a script was handed");
        {
            let _inner = super::DecodedGuard::set(vec![decoder]);
            assert_eq!(ciphered.own_json(), first);
            assert_eq!(unread.own_json(), None);
        }
        assert_eq!(ciphered.own_json(), first);
        assert_eq!(super::decoder_runs() - before, 2, "a body a decoder was run on is not run again, in a nested scope or after it");
        if crate::sandbox::available() {
            assert_eq!(first, Some(serde_json::json!({"decoded": true})), "the ciphered reply reads as what the page's code unpacks");
        }
    }

    /// An answer behind a guard is its JSON: the guard is read past as the site's own code reads past it. Text that
    /// holds a bracket is still text.
    #[test]
    fn a_guard_before_the_json_is_read_past() {
        let guarded = guarded_json(")]}'\n[[\"ramen tokyo\",[[null,\"Ichiran\"]]]]").expect("the JSON behind the guard");
        assert_eq!(guarded[0][0], "ramen tokyo");
        assert!(guarded_json("for (;;);{\"ok\":true}").is_some());
        assert!(guarded_json("while(1);[1,2]").is_some());
        assert!(guarded_json("Hello [1,2]").is_none(), "a word before a bracket is no guard");
        assert!(guarded_json("{\"ok\":true}").is_none(), "nothing to read past");
        assert!(guarded_json(")]}'\n[1,2] and more").is_none(), "what follows is one document");
    }

    /// A guard is read past by where it ends, not by how short it is: a site's guard may close the script it would
    /// have run in and comment the rest of the line out (`'")}while(1);</x>//`), or close a block comment. Both stop
    /// the answer running as a script, which is what a guard is for; neither is data, and the JSON behind it is the
    /// answer. What a guard still cannot be is text that carries on onto another line.
    #[test]
    fn a_guard_is_read_past_by_where_it_ends_not_by_how_long_it_is() {
        assert!(guarded_json("'\" )}while(1);</x>//{\"ok\":true}").is_some(), "a guard that closes a script and comments the line out");
        assert!(guarded_json("/* an anti-hijacking guard */{\"ok\":true}").is_some(), "a guard that ends a comment");
        assert!(guarded_json("for(;;);\n[1,2]").is_some(), "a guard that ends a line");
        assert!(guarded_json("first line\nsecond line [1,2]").is_none(), "a guard carries no line of its own");
        assert!(guarded_json("see the note above\nand the table;{\"ok\":true}").is_none(), "text that spans lines is text");
    }

    /// A page asked through its fragment is asked as much as one asked through its query; a fragment that names a
    /// place on the page asks for nothing.
    #[test]
    fn a_fragment_written_as_a_query_asks_the_page() {
        let asked = |u: &str| asked_pairs(&u.parse().unwrap());
        let pair = |k: &str, v: &str| (k.to_string(), v.to_string());
        assert_eq!(asked("https://fund.example/search#q=dividend%20growth&sort=date"), vec![pair("q", "dividend growth"), pair("sort", "date")]);
        assert_eq!(asked("https://fund.example/app?lang=en#/search?q=dividend"), vec![pair("lang", "en"), pair("q", "dividend")]);
        assert_eq!(asked("https://fund.example/search?q=bonds#q=dividend"), vec![pair("q", "bonds")], "the query's own value stands");
        assert!(asked("https://fund.example/fund/1#reviews").is_empty());
        assert!(asked("https://fund.example/fund/1#a sentence = another").is_empty(), "a name is a word");
    }

    /// A value the page read from its address's fragment is a credential when the walk carries it where one goes, or
    /// sends it to the site and is never told it back; a search term the site runs and says back is what the page was
    /// asked. A value too short to tell apart is never one.
    #[test]
    fn a_fragment_value_the_walk_uses_as_a_credential_is_one() {
        let ex = |url: &str, headers: &[(&str, &str)], body: Option<&str>, answer: &str| Exchange {
            method: if body.is_some() { "POST" } else { "GET" }.into(),
            url: url.parse().unwrap(),
            request_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: body.map(String::from),
            status: 200,
            response_headers: vec![],
            response_body: Some(answer.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        let token = "tok_9f8e7d6c5b4a";
        let bearer = [ex("https://api.app.example/me", &[("authorization", &format!("Bearer {token}"))], None, r#"{"name":"owner"}"#)];
        assert!(fragment_credential(token, &bearer), "sent where a credential goes");
        let checked = [ex("https://api.app.example/session", &[], Some(&format!(r#"{{"access_token":"{token}"}}"#)), r#"{"ok":true}"#)];
        assert!(fragment_credential(token, &checked), "sent, and never said back");
        let search = [ex("https://api.app.example/search?q=dividend", &[("accept-language", "en")], None, r#"{"results":[{"title":"Dividend growth fund"}]}"#)];
        assert!(!fragment_credential("dividend", &search), "a search the site runs and says back");
        assert!(!fragment_credential("en", &search), "a short word the walk never sends whole");
        let code = [ex("https://api.app.example/verify", &[("x-otp", "a1b2c")], None, r#"{"ok":true}"#)];
        assert!(fragment_credential("a1b2c", &code), "a short code sent where a credential goes is one, however short");
        assert!(!fragment_credential("unsent", &search), "a value the walk never sends acted as nothing");
    }

    /// A site that answers a navigation `202` with a script-only stub and serves the page once the code has run: the
    /// stub is part of the door (the browser passed it), so a route never replays it. Measured on Booking.com, whose
    /// stub is 8.9 KB with no words and no on-site link.
    #[test]
    fn a_script_only_stub_before_the_real_page_is_the_door() {
        let stub = Exchange {
            method: "GET".into(),
            url: "https://www.hotels.example/searchresults.html?ss=paris".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 202,
            response_headers: vec![],
            response_body: Some(format!("<html><head><title></title><script>{}</script></head><body><div id='app'></div></body></html>", "var a=1;".repeat(500))),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let real = Exchange {
            method: "GET".into(),
            url: "https://www.hotels.example/searchresults.html?ss=paris".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(format!("<html><head><title>Paris</title></head><body><h1>Paris</h1>{}</body></html>", "<a href='/h/1'>Hotel Paris</a>".repeat(40))),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let trace = Trace { exchanges: vec![stub, real], inputs: vec![] };
        assert_eq!(trace.door("hotels.example"), vec![0], "the stub is the door, the real page is not");
    }

    /// A walk that ended on a page that only runs its code was not shown to be stopped there: an app's shell and a check
    /// that serves itself look the same, and the shell's answer may come from another host. hn.algolia.com's shell draws
    /// its stories from `POST …-dsn.algolia.net/1/indexes/…/query`, a domain of its own, and the only on-site JSON is a
    /// settings call (QA 45316072080, checks 14–16: the whole walk was the door, no candidate was left, and the agent was
    /// told a check asks a person). Its calls stay: whether one answers is replay's to judge, and a check is told by
    /// `graph::Door::met`. A page that only runs its code is the door only when the walk went on past it to a page.
    #[test]
    fn a_walk_that_ended_on_a_shell_keeps_its_calls_wherever_they_were_answered() {
        let page = |url: &str, body: &str| Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(body.into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let call = |url: &str, body: Option<&str>, answer: &str| Exchange {
            method: if body.is_some() { "POST" } else { "GET" }.into(),
            url: url.parse().unwrap(),
            request_headers: vec![("content-type".into(), "application/json".into())],
            request_body: body.map(String::from),
            status: 200,
            response_headers: vec![],
            response_body: Some(answer.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        let shell = r#"<html><head><title>HN Search</title><script src="/public/main.js"></script></head><body><main id="root"></main></body></html>"#;
        assert!(crate::page::a_door(200, shell, &"https://hn.search.example/?q=rust".parse().unwrap()), "the fixture has the shape this test is about");
        let settings = call("https://telemetry.search.example/1/settings", None, r#"{"enabled":false,"sampleRate":0.1}"#);
        let search = call(
            "https://abc123-dsn.search-api.example/1/indexes/Item/query",
            Some(r#"{"query":"rust","page":0,"hitsPerPage":20}"#),
            r#"{"hits":[{"title":"Rust 2.0"},{"title":"Why Rust"}],"nbHits":36249}"#,
        );
        for asked in ["https://hn.search.example/?q=rust", "https://hn.search.example/"] {
            let walk = Trace { exchanges: vec![page(asked, shell), settings.clone(), search.clone()], inputs: vec![] };
            assert!(walk.door("search.example").is_empty(), "{asked}: the walk ended on the shell, and showed no door");
            assert_eq!(walk.without_door("search.example").exchanges.len(), 3, "{asked}: the search is still a candidate");
        }
        // The same looks with a check's bookkeeping: still no door read from looks. Nothing it answers is the ask, which
        // the learner and replay say; the door itself is `Door::met`'s.
        let bookkeeping = call("https://www.lib.example/.within/api/make-challenge", None, r#"{"challenge":"9f8e7d","rules":{"algorithm":"fast"}}"#);
        let check = page("https://www.lib.example/search?query=lamps", r#"<html><head><title>One moment</title><script src="/hold.js"></script></head><body><p>Please wait.</p></body></html>"#);
        let held = Trace { exchanges: vec![check.clone(), bookkeeping], inputs: vec![] };
        assert!(held.door("lib.example").is_empty());
        assert!(crate::graph::Door::met(&held, "lib.example").is_some(), "the check is still a door the route can pass");
        // A page that only runs its code, which the walk went on past to the site's page, is the door it passed.
        let through = page("https://www.lib.example/search?query=lamps", r#"<html><body><h1>Lamps</h1><a href="/lamps/1">Brass lamp</a></body></html>"#);
        assert_eq!(Trace { exchanges: vec![check, through], inputs: vec![] }.door("lib.example"), vec![0]);
    }

    /// Every call the door takes away carries the page that holds it there and why, so a reader of the learn (the
    /// node's log, the x-ray) can tell what the walk showed: a refusal, another site's waiting room, or a page of script
    /// the walk went past. The reasons are the door's own reading, so the two never disagree.
    #[test]
    fn each_call_the_door_takes_says_why() {
        let doc = |url: &str, status: u16, body: &str| Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status,
            response_headers: vec![],
            response_body: Some(body.into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let call = |url: &str| Exchange { resource_type: Some("XHR".into()), response_mime: "application/json".into(), response_body: Some("{}".into()), ..doc(url, 200, "") };
        let stub = r#"<html><head><script src="/hold.js"></script></head><body><div id="app"></div></body></html>"#;
        let page = r#"<html><body><h1>Lamps</h1><a href="/lamps/1">Brass lamp</a></body></html>"#;
        let walk = Trace {
            exchanges: vec![
                doc("https://www.shop.example/lamps", 403, "<html><body>Forbidden</body></html>"),
                Exchange { response_body: None, ..doc("https://www.shop.example/lamps", 0, "") },
                call("https://www.shop.example/.check/ping"),
                doc("https://wait.vendor.example/queue", 200, "<html><body>You are in line</body></html>"),
                doc("https://www.shop.example/lamps", 202, stub),
                call("https://www.shop.example/.check/solve"),
                doc("https://www.shop.example/lamps", 200, page),
                Exchange { response_body: None, ..doc("https://wait.vendor.example/queue", 0, "") },
                call("https://www.shop.example/api/lamps"),
            ],
            inputs: vec![],
        };
        let why = walk.door_why("shop.example");
        let named: Vec<(usize, usize, &str)> = why.iter().map(|d| (d.index, d.by, d.why.name())).collect();
        assert_eq!(named, vec![(0, 0, "refused"), (1, 0, "refused"), (2, 0, "refused"), (3, 3, "another_site"), (4, 4, "went_past"), (5, 4, "went_past")]);
        assert_eq!(walk.door("shop.example"), vec![0, 1, 2, 3, 4, 5], "the door is the same stretch its reasons name");
    }

    fn script(url: &str, body: &str) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: "application/javascript".into(),
            resource_type: Some("Script".into()),
            main_frame: Some(true),
        }
    }

    /// A logger's answer plays the events it was sent back among its own values. They are the longest list in it, and
    /// they say what the page was asked, but the server found none of them. A search that says its filters back beside
    /// the results it found holds records of its own, and so does one sent no records.
    #[test]
    fn records_a_call_sent_are_not_records_it_found() {
        let call = |request: &str, answer: &str| Exchange { request_body: Some(request.into()), method: "POST".into(), resource_type: Some("XHR".into()), ..script("https://shop.example/resource/log/create/", answer) };
        let events = r#"[{"label":"Cabinets","query":"kitchen"},{"label":"Tiles","query":"kitchen"},{"label":"Taps","query":"kitchen"}]"#;
        let form = format!("source=%2Fsearch&data={}", url::form_urlencoded::byte_serialize(format!(r#"{{"options":{{"events":{events}}}}}"#).as_bytes()).collect::<String>());
        let played = format!(r#"{{"response":{{"status":"ok","data":null}},"context":{{"country":"SG","url":"/search?q=kitchen"}},"resource":{{"options":{{"events":{events}}}}}}}"#);
        assert!(call(&form, &played).records_are_what_it_sent(), "from a form");
        assert!(call(&format!(r#"{{"events":{events}}}"#), &played).records_are_what_it_sent(), "from a JSON body");
        let results = r#"{"filters":[{"id":"a"},{"id":"b"}],"results":[{"title":"Oak cabinet"},{"title":"Pine cabinet"},{"title":"Ash cabinet"}]}"#;
        assert!(!call(r#"{"q":"kitchen","filters":[{"id":"a"},{"id":"b"}]}"#, results).records_are_what_it_sent());
        assert!(!call(r#"{"q":"kitchen"}"#, r#"{"results":[{"title":"Oak"},{"title":"Pine"}]}"#).records_are_what_it_sent());
        assert!(!call(r#"{"q":"kitchen"}"#, r#"{"count":0}"#).records_are_what_it_sent(), "no records at all");
    }

    /// An answer inside the call its own address named is data, however the browser logged it, and read as the JSON it
    /// holds. The name is what says so: a script that merely calls something, or names no one the address gave, is code.
    #[test]
    fn an_answer_inside_the_name_its_address_gave_is_data() {
        for body in ["draw.api1({\"results\":[{\"title\":\"Pods\"}]});", "/*O_o*/\ndraw.api1({\"results\":[{\"title\":\"Pods\"}]})\n", "draw.api1( {\"results\":[{\"title\":\"Pods\"}]} ) ;"] {
            let e = script("https://find.example/v1?q=pod&cb=draw.api1", body);
            assert!(!e.is_asset() && !e.is_static_code(), "{body}");
            assert_eq!(e.json_body().unwrap()["results"][0]["title"], "Pods", "{body}");
        }
        for (url, body) in [
            ("https://find.example/v1?q=pod&cb=draw.api1", "other({\"results\":[]});"),
            ("https://find.example/v1?q=pod&cb=draw.api1", "draw.api1(1, 2);"),
            ("https://find.example/app.js", "draw({\"results\":[]});"),
            ("https://find.example/app.js?v=draw", "draw({\"results\":[]}); more();"),
        ] {
            let e = script(url, body);
            assert!(e.is_asset() && e.is_static_code(), "{url} {body}");
            assert!(e.json_body().is_none(), "{url} {body}");
        }
    }

    /// An answer that is its data encoded again as text is read as the data: the whole body is one run of the
    /// encoding's characters and decodes to JSON whole. A token, an id or a word decodes to no JSON, and stays text.
    #[test]
    fn an_answer_encoded_as_text_is_read_as_the_data_it_holds() {
        use base64::Engine;
        let data = r#"{"query":"kettle","results":[{"title":"kettle one","price":12}]}"#;
        for engine in [base64::engine::general_purpose::STANDARD, base64::engine::general_purpose::URL_SAFE_NO_PAD] {
            let read = super::encoded_json(&format!("  {}\n", engine.encode(data))).expect("the data it holds");
            assert_eq!(read["results"][0]["title"], "kettle one");
        }
        let list = base64::engine::general_purpose::STANDARD.encode(r#"[{"title":"kettle one"},{"title":"kettle two"}]"#);
        assert!(super::encoded_json(&list).is_some_and(|v| v.as_array().is_some_and(|a| a.len() == 2)));
        // What isn't data encoded: a token, an id, words, a number encoded, and data cut short.
        let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        for not_data in ["eyJhbGciOiJIUzI1NiJ9", "0123456789abcdef0123456789abcdef", &b64("just some words, encoded for no reason"), &b64("12345678901234567890"), &b64(&data[..data.len() - 3]), "{\"already\":\"json\", \"not\":\"encoded\"}", ""] {
            assert_eq!(super::encoded_json(not_data), None, "{not_data}");
        }
    }

    /// A search that streams its results as events of JSON (`text/event-stream`) answers with them as one list, in order;
    /// a field split over lines is one event's data. Text that only looks like it (a sentence starting "data:") is not
    /// a stream, and a stream with no JSON in it holds no data.
    #[test]
    fn an_event_stream_of_json_is_read_as_its_events() {
        let stream = "event: first\r\ndata:{\"flights\":[{\"no\":\"SQ1\"}]}\r\n\r\n: keep-alive\n\nid: 2\ndata: {\"flights\":\ndata: [{\"no\":\"SQ2\"}]}\n\n";
        let v = event_stream_json(stream).unwrap();
        assert_eq!(v, serde_json::json!([{"flights":[{"no":"SQ1"}]}, {"flights":[{"no":"SQ2"}]}]));
        let ex = super::Exchange { response_body: Some(stream.into()), response_mime: "text/event-stream".into(), ..exchange_stub() };
        assert_eq!(ex.json_body(), Some(v));
        assert!(event_stream_json("data: these are the prices\nand more text").is_none());
        assert!(event_stream_json("event: ping\ndata: hello\n\n").is_none());
        assert!(event_stream_json("{\"a\":1}").is_none());
    }

    fn exchange_stub() -> super::Exchange {
        super::Exchange {
            method: "POST".into(),
            url: "https://air.example/api/search".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: None,
            response_mime: String::new(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        }
    }

    /// A search with no results shrinks its page's state below another JSON blob the page carries (its settings): the
    /// page is still read as its state, the blob shaped like the route's recorded answer, never the settings because
    /// they are bigger. With nothing recorded, the largest blob stands as before.
    #[test]
    fn a_page_is_read_as_the_state_its_route_recorded_not_its_biggest_blob() {
        let blob = |attrs: &str, v: serde_json::Value| format!("<script type=\"application/json\" {attrs}>{v}</script>");
        let settings = serde_json::json!({ "locale": "en", "featureFlags": (0..200).map(|i| format!("flag_{i}")).collect::<Vec<_>>() });
        let state = |results: Vec<serde_json::Value>| serde_json::json!({ "payload": { "results": results, "query": "x" }, "title": "Search", "meta": {} });
        let invalid = format!("<script type=\"application/json\">{}</script>", "broken".repeat(400));
        let empty = format!("<html><body>{}{}{invalid}</body></html>", blob("id=\"env\"", settings.clone()), blob("data-target=\"app\"", state(vec![])));
        let recorded = serde_json::json!({ "payload": { "results": [{ "name": "string" }], "query": "string" }, "title": "string", "meta": {} });
        let read: serde_json::Value = serde_json::from_str(&embedded_json_like(&empty, Some(&recorded)).unwrap()).unwrap();
        assert_eq!(read["payload"]["results"], serde_json::json!([]), "the empty search's state, not the settings: {read}");
        assert_eq!(super::embedded_json_value_like(&empty, Some(&recorded)), Some(read));
        let largest: serde_json::Value = serde_json::from_str(&embedded_json(&empty).unwrap()).unwrap();
        assert!(largest.get("featureFlags").is_some(), "with nothing recorded, the largest blob stands");
        // A recording no blob resembles reads the largest, as before.
        let other = serde_json::json!({ "unrelated": "string" });
        assert!(serde_json::from_str::<serde_json::Value>(&embedded_json_like(&empty, Some(&other)).unwrap()).unwrap().get("featureFlags").is_some());
    }

    #[test]
    fn a_value_is_seen_through_every_layer_it_was_escaped_in() {
        // A search API's body: the query, form-encoded, inside a JSON string (the walk of hn.algolia.com).
        let body = r#"{"requests":[{"indexName":"Item","params":"query=sqlite%20vector%20search&hitsPerPage=20"}]}"#;
        assert!(carries_text(body, "sqlite vector search"));
        // The same JSON again, percent-encoded into an address (a GraphQL GET).
        let url = "https://api.example/graphql?variables=%7B%22q%22%3A%22caf%5Cu00e9%20%5C%22latte%5C%22%22%7D";
        assert!(carries_text(url, "café \"latte\""));
        // A chat frame with the message JSON-escaped, and a form post with `+` for a space.
        assert!(carries_text(r#"MESG{"message":"line one\nline \"two\""}"#, "line one\nline \"two\""));
        assert!(carries_text("q=blue+chair&page=1", "Blue Chair"));
        // A literal plus survives: it was sent as `%2B`.
        assert!(carries_text("q=c%2B%2B+jobs", "c++ jobs"));
        assert!(!carries_text(body, "postgres"));
        assert!(!carries_text(body, "  "));
    }

    #[test]
    fn a_value_said_back_whole_is_not_part_of_a_longer_one() {
        assert!(carries_whole(r#"{"ok":true,"code":"1234"}"#, "1234"));
        assert!(!carries_whole(r#"{"ok":true,"expires":12345}"#, "1234"));
        assert!(carries_whole("q=blue+chair&page=1", "blue chair"));
        assert!(!carries_whole("q=blue+chairs", "blue chair"));
    }

    #[test]
    fn scanning_many_values_agrees_with_reading_each_one() {
        let sources = [
            r#"q=blue%2520chair&page=1; aux=warm+weather"#,
            r#"{"county":"Z\u00fcrich","note":"x---","age":345}"#,
            "red chair; solaris; Café; {c++ jobs}; 12345",
            "warm; door-test; élan and elan",
        ];
        let values = ["123", "12345", "BLUE CHAIR", "red chair", "blue", "warm weather", "warm", "Zürich", "Café", "--", "c++ jobs", "door", "test", "elan", "élan", "lan", "solar", "  ", "blue chair"];
        let expected = values.iter().filter(|v| sources.iter().any(|s| carries_whole(s, v))).map(|v| v.to_lowercase()).collect();
        assert_eq!(super::whole_values(sources, values), expected);
        assert_eq!(super::whole_values(sources, ["ZÜRICH"]), ["zürich".to_string()].into_iter().collect());
        assert!(super::whole_values(sources, ["  "]).is_empty());
    }

    /// The page a route was learned on is the walk's last main document on its own site: another site's page is not
    /// it, and a page longer than a route carries keeps its head (where the meta and config tags are).
    #[test]
    fn a_routes_page_is_the_walks_own_document() {
        let doc = |url: &str, body: String| Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(body),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let trace = Trace {
            exchanges: vec![
                doc("https://ads.other.example/frame", "<html>ad</html>".into()),
                doc("https://www.shop.example/search?q=lamp", r#"<html><head><meta name="csrf" content="x"></head></html>"#.into()),
            ],
            inputs: vec![],
        };
        let html = page_html_of(&trace, "shop.example").expect("the walk's own page");
        assert!(html.contains("csrf"), "{html}");
        assert!(page_html_of(&trace, "elsewhere.example").is_none(), "another site's document is not the route's page");
        // A page over the cap keeps its start, where the tags a bundle reads are.
        let big = format!("<html><head><meta name=\"csrf\" content=\"x\"></head><body>{}</body></html>", "a".repeat(600 * 1024));
        let long = Trace { exchanges: vec![doc("https://www.shop.example/", big)], inputs: vec![] };
        let kept = page_html_of(&long, "www.shop.example").expect("a page");
        assert!(kept.len() <= 512 * 1024 && kept.contains("csrf"), "{}", kept.len());
        // A page that fits is kept whole: the state a bundle boots from often sits past a smaller cut.
        let fits = format!("<html><head></head><body>{}</body><script>window.__STATE__=1</script></html>", "a".repeat(200 * 1024));
        let whole = page_html_of(&Trace { exchanges: vec![doc("https://www.shop.example/", fits)], inputs: vec![] }, "www.shop.example").expect("a page");
        assert!(whole.contains("window.__STATE__=1"), "a page under the cap is whole");
    }

    /// A page's state travels with its head even past the cut: the page's own code reads a JSON block as data, and a
    /// bundle booted without it reads nothing. Markup past the cut stays out.
    #[test]
    fn a_pages_state_block_past_the_cut_rides_with_its_head() {
        let doc = |body: String| Exchange {
            method: "GET".into(),
            url: "https://www.shop.example/search".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(body),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let state = r#"{"page":"search","sig":"s-1"}"#;
        let body = format!(
            r#"<html><head><meta name="csrf" content="x"></head><body>{}</body><script type="application/json" id="__DATA__">{state}</script><div id="painted">later</div></html>"#,
            "a".repeat(600 * 1024)
        );
        let trace = Trace { exchanges: vec![doc(body)], inputs: vec![] };
        let kept = page_html_of(&trace, "shop.example").expect("a page");
        assert!(kept.contains("csrf"), "the head");
        assert!(kept.contains(state), "the page's state, past the cut");
        assert!(!kept.contains("painted"), "markup past the cut stays in the walk");
        assert!(kept.len() < 512 * 1024 + 192 * 1024, "{}", kept.len());
    }
}
