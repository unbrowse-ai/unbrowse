//! Where a request value came from: an earlier response's JSON, header, `Set-Cookie`, or
//! text (HTML or JS).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::slots::json_leaves;
use crate::trace::Trace;

/// Values shorter than this are too common to trace ("1", "en", "true") and are not searched.
pub const MIN_TRACEABLE: usize = 6;

/// Whether a value is one plain word (`Flight`, `homes`, `ONLINE`): letters only, written as a word is (lower case,
/// capitalised, or all capitals). Like a short value it is too common to trace: a page's code sends the words it
/// uses, and an answer that says the same word (a config's `"productLine": "Flight"`) is not where it came from. A
/// token or an id is not a word: it has digits, or its letters' case runs at random.
pub fn a_plain_word(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false };
    let rest: Vec<char> = chars.collect();
    value.chars().count() <= 24
        && value.chars().all(char::is_alphabetic)
        && (first.is_lowercase() || first.is_uppercase())
        && (rest.iter().all(|c| c.is_lowercase()) || value.chars().all(char::is_uppercase))
}

/// How many characters before a value in text are kept to find it again.
const TEXT_CONTEXT: usize = 32;

/// Response headers that describe the response itself. A request value that matches one,
/// such as `content-type: application/json`, is a coincidence, not a source.
const DESCRIPTIVE_HEADERS: &[&str] = &[
    "age", "cache-control", "connection", "content-encoding", "content-language", "content-length",
    "content-type", "date", "etag", "expires", "keep-alive", "last-modified", "server",
    "transfer-encoding", "vary",
];

/// Where in a response a value is found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "from", rename_all = "snake_case")]
pub enum At {
    Json { pointer: String },
    Header { name: String },
    SetCookie { name: String },
    /// Text such as HTML or JS: the value follows the `nth` occurrence of `before`
    /// (0-based) and ends at `after`. A page lists many files after the same pattern,
    /// so which occurrence matters.
    Text { before: String, after: String, #[serde(default)] nth: usize },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Origin {
    /// Index of the exchange whose response holds the value.
    pub exchange: usize,
    /// That exchange's URL, for people reading the graph.
    pub url: String,
    pub at: At,
    /// Text around the found value in the request, as in `Bearer {value}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap: Option<(String, String)>,
}

/// How much of one answer's body [`session_values`] reads for a value a later request sent back: the first 4 MiB. A
/// token an answer delivers further in than that (inside a larger script or page) is not found there, and is not in
/// what the node holds as the session unless a cookie, a credential field or a smaller answer carries it too
/// (SECURITY.md, "What isn't defended").
pub const ANSWER_SCAN_MOST: usize = 4 << 20;

/// What a walk held as its session, read by the learner's own rules: each cookie its browser sent or was set, and
/// each value a request of the walk sent, in any position (an address, a header, a cookie, a body), that an earlier
/// answer of the walk delivered, any answer, a script or a stylesheet as much as an API's: something the site gave the
/// session to hold and hand back, a login answer's token sent on as a bearer or in a body, a personalised script's
/// token sent on by the page. Found two ways: the reading that makes a field `Derived` ([`find_origin_on`]), and one
/// pass over every answer's headers and the first [`ANSWER_SCAN_MOST`] bytes of its body for every value a request sent
/// (whole, as a word), so an answer the learner's own reading passes over is read too. A value found inside a longer one
/// (`Bearer <token>`) gives the token as well. What the walk typed is the caller's, never the site's; a value shorter
/// than [`MIN_TRACEABLE`] or a plain word is too common to trace.
pub fn session_values(trace: &Trace) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut put = |v: &str| {
        let v = v.trim();
        if !v.is_empty() && !out.iter().any(|o| o == v) {
            out.push(v.to_string());
        }
    };
    // Every value a request sent (and each word of it), with the requests that sent it.
    let traceable = |v: &str| v.len() >= MIN_TRACEABLE && !a_plain_word(v);
    let mut sent: Vec<(usize, String, String)> = Vec::new();
    for (i, ex) in trace.exchanges.iter().enumerate() {
        for (_, v) in ex.cookies() {
            put(&v);
        }
        for (k, v) in &ex.response_headers {
            if k.eq_ignore_ascii_case("set-cookie") {
                for line in v.lines() {
                    if let Some((_, v)) = line.split(';').next().and_then(|p| p.split_once('=')) {
                        put(v);
                    }
                }
            }
        }
        for slot in crate::slots::slots(ex) {
            if matches!(slot.loc, crate::slots::Loc::Cookie(_)) || trace.inputs.iter().any(|t| t.value == slot.value) {
                continue;
            }
            if !ex.is_asset() {
                if let Some(origin) = find_origin_on(trace, i, &slot.value, None) {
                    put(&slot.value);
                    if let Some((head, tail)) = &origin.wrap {
                        if let Some(inner) = slot.value.strip_prefix(head.as_str()).and_then(|v| v.strip_suffix(tail.as_str())) {
                            put(inner);
                        }
                    }
                }
            }
            if traceable(&slot.value) {
                sent.push((i, slot.value.clone(), slot.value.clone()));
            }
            for word in slot.value.split_whitespace().filter(|w| *w != slot.value && traceable(w)) {
                sent.push((i, word.to_string(), slot.value.clone()));
            }
        }
    }
    if sent.is_empty() {
        return out;
    }
    let mut patterns: Vec<&str> = sent.iter().map(|(_, p, _)| p.as_str()).collect();
    patterns.sort_unstable();
    patterns.dedup();
    let first = sightings(trace, &patterns, aho_corasick::AhoCorasick::new(&patterns).ok());
    for (i, word, value) in &sent {
        let Ok(n) = patterns.binary_search(&word.as_str()) else { continue };
        if first[n].is_some_and(|j| j < *i) {
            put(word);
            put(value);
        }
    }
    out
}

/// The first answer of `trace` each of `patterns` stood in, whole: headers (but `Set-Cookie`, read as cookies) and the
/// first [`ANSWER_SCAN_MOST`] bytes of each body, in one pass with `finder`. Should the finder for them not have built
/// (it can refuse a set past its own limits), each pattern is looked for on its own instead: slower, never a scan that
/// found nothing because it didn't run.
fn sightings(trace: &Trace, patterns: &[&str], finder: Option<aho_corasick::AhoCorasick>) -> Vec<Option<usize>> {
    let found = |text: &str| -> Vec<(usize, usize, usize)> {
        match &finder {
            Some(f) => f.find_overlapping_iter(text).map(|m| (m.pattern().as_usize(), m.start(), m.end())).collect(),
            None => patterns.iter().enumerate().flat_map(|(n, p)| text.match_indices(p).map(move |(at, _)| (n, at, at + p.len()))).collect(),
        }
    };
    let mut first: Vec<Option<usize>> = vec![None; patterns.len()];
    let whole = |text: &str, s: usize, e: usize| {
        !text[..s].chars().next_back().is_some_and(char::is_alphanumeric) && !text[e..].chars().next().is_some_and(char::is_alphanumeric)
    };
    for (j, ex) in trace.exchanges.iter().enumerate() {
        let body = ex.response_body.as_deref().unwrap_or_default();
        let mut end = body.len().min(ANSWER_SCAN_MOST);
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        let texts = ex.response_headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("set-cookie")).map(|(_, v)| v.as_str()).chain([&body[..end]]);
        for text in texts {
            for (n, s, e) in found(text) {
                let at = &mut first[n];
                if at.is_none() && whole(text, s, e) {
                    *at = Some(j);
                }
            }
        }
    }
    first
}

/// Finds the response before exchange `before` that holds `value`, either exactly or
/// wrapped in surrounding text (`Bearer g_123` from a response holding `g_123`).
///
/// Structured values (`Set-Cookie`, headers, JSON) prefer the latest issuer, so a
/// rotating cookie re-fetches from where it was last set. Text prefers the earliest
/// response: a page's own HTML (`src="/…"`) outlives the minified assets it
/// references, whose content changes on every deploy.
pub fn find_origin(trace: &Trace, before: usize, value: &str) -> Option<Origin> {
    find_origin_on(trace, before, value, None)
}

/// As [`find_origin`], but a route's own site is preferred: a value seen on both
/// the route's host and a third party's (ad tech, metrics) takes the route's
/// host, so the dependency graph doesn't grow steps on other sites.
pub fn find_origin_on(trace: &Trace, before: usize, value: &str, host: Option<&str>) -> Option<Origin> {
    if value.len() < MIN_TRACEABLE || a_plain_word(value) {
        return None;
    }
    let n = before.min(trace.exchanges.len());
    let preferred = |i: usize| host.is_none_or(|h| trace.exchanges[i].url.host_str() == Some(h));
    // A read takes a value from a read wherever one holds it: a POST that says it back would ride along on every call,
    // sent again for a value any page gave. A step that writes keeps its order: the latest issuer is the session's.
    let reads = |i: usize| trace.exchanges.get(i).is_some_and(|e| matches!(e.method.as_str(), "GET" | "HEAD"));
    if reads(before) {
        for i in (0..n).rev().filter(|&i| preferred(i) && reads(i)) {
            if let Some(at) = find_structured(trace, i, value) {
                return Some(origin(trace, i, at, None));
            }
        }
        // That holds for what a page's own text says, too: a site that says its address back in every answer would
        // otherwise hand a read to whichever POST the page happened to send first.
        for i in (0..n).filter(|&i| preferred(i) && reads(i) && !trace.exchanges[i].is_asset()) {
            if let Some(at) = find_in_text(trace, i, value) {
                return Some(origin(trace, i, at, None));
            }
        }
    }
    for i in (0..n).rev().filter(|&i| preferred(i)) {
        if let Some(at) = find_structured(trace, i, value) {
            return Some(origin(trace, i, at, None));
        }
    }
    for i in (0..n).filter(|&i| preferred(i) && !trace.exchanges[i].is_asset()) {
        if let Some(at) = find_in_text(trace, i, value) {
            return Some(origin(trace, i, at, None));
        }
    }
    if host.is_some() {
        return find_origin_on(trace, before, value, None);
    }
    // Not found whole: look for an earlier response value inside it, as most of it (`Bearer <token>`). A word a long
    // text happens to hold (`Video` inside a GraphQL query) is no part of where the text comes from: rebuilt around
    // that word as a later answer gives it, the text would change on every call.
    for i in (0..n).rev().filter(|&i| !trace.exchanges[i].is_asset()) {
        for (candidate, at) in response_values(trace, i).iter() {
            if candidate.len() < MIN_TRACEABLE || candidate == value || candidate.len() * 2 < value.len() {
                continue;
            }
            if let Some(pos) = value.find(candidate.as_str()) {
                let wrap = (value[..pos].to_string(), value[pos + candidate.len()..].to_string());
                return Some(origin(trace, i, at.clone(), Some(wrap)));
            }
        }
    }
    None
}

/// Where a value sits in a script or stylesheet the page loaded before `before`. Never a step
/// to re-fetch (a bundle's text moves on every deploy, see [`find_origin_on`]); it says the site
/// ships the value to everyone, so it is a constant, with the place it came from kept.
pub fn find_in_static(trace: &Trace, before: usize, value: &str) -> Option<Origin> {
    if value.len() < MIN_TRACEABLE {
        return None;
    }
    let n = before.min(trace.exchanges.len());
    (0..n)
        .filter(|&i| trace.exchanges[i].is_static_code())
        .find_map(|i| find_in_text(trace, i, value).map(|at| origin(trace, i, at, None)))
}

fn origin(trace: &Trace, i: usize, at: At, wrap: Option<(String, String)>) -> Origin {
    Origin { exchange: i, url: without_query(&trace.exchanges[i].url), at, wrap }
}

fn find_structured(trace: &Trace, i: usize, value: &str) -> Option<At> {
    response_values(trace, i).iter().find(|(v, _)| v == value).map(|(_, at)| at.clone())
}

fn find_in_text(trace: &Trace, i: usize, value: &str) -> Option<At> {
    if trace.exchanges[i].echoes_its_request() {
        return None;
    }
    let body = trace.exchanges[i].response_body.as_deref()?;
    let pos = find_delimited(body, value)?;
    let start = floor_char_boundary(body, pos.saturating_sub(TEXT_CONTEXT));
    let mut before = body[start..pos].rsplit('\n').next().unwrap_or_default().to_string();
    // The value's context is the tail of `before` itself; count the occurrences of
    // the context that come strictly before the value's own, so `extract` can pick
    // the same one when the pattern repeats (a page listing many files).
    let mut nth = 0;
    if let Some(at) = pos.checked_sub(before.len()) {
        nth = body[..at].match_indices(before.as_str()).count();
    } else {
        // The context starts mid-line at the very beginning of the body.
        before = body[..pos].to_string();
    }
    let after = body[pos + value.len()..].chars().next().map(String::from).unwrap_or_default();
    Some(At::Text { before, after, nth })
}

thread_local! {
    /// Each response's structured values, read once while a graph is built rather than once per value searched: a
    /// long walk holds thousands of responses, and a big request body has hundreds of values to trace.
    static MEMO: RefCell<Option<HashMap<(usize, usize), Rc<Vec<(String, At)>>>>> = const { RefCell::new(None) };
}

/// Remembers responses' values for as long as it lives. The traces searched must not change meanwhile: a graph
/// build holds one for its own fixed traces.
pub struct Memo(());

impl Memo {
    pub fn start() -> Self {
        MEMO.with(|m| *m.borrow_mut() = Some(HashMap::new()));
        Memo(())
    }
}

impl Drop for Memo {
    fn drop(&mut self) {
        MEMO.with(|m| *m.borrow_mut() = None);
    }
}

/// Structured values in a response: `Set-Cookie` values, other headers, and JSON leaves.
fn response_values(trace: &Trace, i: usize) -> Rc<Vec<(String, At)>> {
    let key = (trace as *const Trace as usize, i);
    if let Some(v) = MEMO.with(|m| m.borrow().as_ref().and_then(|c| c.get(&key).cloned())) {
        return v;
    }
    let v = Rc::new(read_values(trace, i));
    MEMO.with(|m| {
        if let Some(c) = m.borrow_mut().as_mut() {
            c.insert(key, v.clone());
        }
    });
    v
}

fn read_values(trace: &Trace, i: usize) -> Vec<(String, At)> {
    let ex = &trace.exchanges[i];
    let mut out: Vec<(String, At)> = ex
        .set_cookies()
        .into_iter()
        .map(|(name, v)| (v, At::SetCookie { name }))
        .collect();
    for (name, v) in &ex.response_headers {
        let name_lc = name.to_ascii_lowercase();
        if name_lc != "set-cookie" && !DESCRIPTIVE_HEADERS.contains(&name_lc.as_str()) && !name_lc.starts_with("access-control-") {
            out.push((v.clone(), At::Header { name: name.to_ascii_lowercase() }));
        }
    }
    if let Some(json) = ex.json_body().filter(|_| !ex.echoes_its_request()) {
        for (pointer, v) in json_leaves(&json) {
            out.push((v, At::Json { pointer }));
        }
    }
    out
}

/// A URL without its query, which can hold what the agent typed.
fn without_query(url: &url::Url) -> String {
    let mut url = url.clone();
    url.set_query(None);
    url.to_string()
}

/// The value at `pointer` in `v`, where a key written as a field with the arguments it was asked with
/// (`search({"input":{"dest":"Bangkok","acid":"7f3a…"}})`, a GraphQL cache's key for one query) stands for that field
/// however it is asked: the arguments are the ask's own (what was searched, an id made for that ask), so the same page
/// asked again holds the field under the new ask's key. Only where the exact key is missing, and only when the object
/// holds that field under one key alone: two are two asks, and neither is taken for the other.
pub fn at_pointer<'v>(v: &'v Value, pointer: &str) -> Option<&'v Value> {
    if let Some(found) = v.pointer(pointer) {
        return Some(found);
    }
    let mut at = v;
    for part in pointer.split('/').skip(1) {
        let key = part.replace("~1", "/").replace("~0", "~");
        at = match at {
            Value::Object(m) => match m.get(&key) {
                Some(next) => next,
                None => {
                    let field = key.split_once('(').filter(|(name, _)| !name.is_empty() && key.ends_with(')')).map(|(name, _)| format!("{name}("))?;
                    let mut asked = m.iter().filter(|(k, _)| k.starts_with(&field) && k.ends_with(')'));
                    match (asked.next(), asked.next()) {
                        (Some((_, next)), None) => next,
                        _ => return None,
                    }
                }
            },
            Value::Array(a) => a.get(key.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(at)
}

/// Reads the value at `at` from a response: how replay takes a derived value from a fresh
/// response.
pub fn extract(ex: &crate::trace::Exchange, at: &At) -> Option<String> {
    match at {
        At::SetCookie { name } => ex.set_cookies().into_iter().find(|(k, _)| k == name).map(|(_, v)| v),
        At::Header { name } => ex.response_header(name).map(str::to_string),
        At::Json { pointer } => {
            // A page can carry several JSON documents (its own state, a layout's, an ad's), and which one holds the
            // value can change with what was asked: the value is the first document's that has it.
            let docs = ex.json_documents();
            let found = docs.iter().find_map(|json| at_pointer(json, pointer))?;
            match found {
                Value::String(s) => Some(s.clone()),
                Value::Null | Value::Object(_) | Value::Array(_) => None,
                other => Some(other.to_string()),
            }
        }
        At::Text { before, after, nth } => {
            let body = ex.response_body.as_deref()?;
            // The `nth` occurrence of the context (0-based) is the one the value
            // followed when the route was learned: a page lists many files after the
            // same pattern, so which occurrence matters.
            let occurrences: Vec<usize> = body.match_indices(before.as_str()).map(|(at, _)| at).collect();
            if let Some(&at) = occurrences.get(*nth) {
                let start = at + before.len();
                let rest = &body[start..];
                let end = if after.is_empty() {
                    rest.find(['\n', '\r']).unwrap_or(rest.len())
                } else {
                    rest.find(after.as_str()).unwrap_or(rest.len())
                };
                return Some(rest[..end].to_string());
            }
            // The context can rot: minified bundles change on every deploy around a
            // stable pattern such as `fetch("/g/`. Try progressively shorter
            // suffixes of it at the first occurrence.
            let mut suffix_len = before.len();
            while suffix_len >= 4 {
                let ctx = &before[before.len() - suffix_len..];
                if let Some(at) = body.find(ctx) {
                    let start = at + suffix_len;
                    let rest = &body[start..];
                    let end = if after.is_empty() {
                        rest.find(['\n', '\r']).unwrap_or(rest.len())
                    } else {
                        rest.find(after.as_str()).unwrap_or(rest.len())
                    };
                    return Some(rest[..end].to_string());
                }
                suffix_len -= 1;
                while suffix_len > 4 && !before.is_char_boundary(before.len() - suffix_len) {
                    suffix_len -= 1;
                }
            }
            None
        }
    }
}

/// The first occurrence of `needle` in `hay` that isn't part of a longer word.
fn find_delimited(hay: &str, needle: &str) -> Option<usize> {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(rel) = hay[from..].find(needle) {
        let pos = from + rel;
        let before_ok = hay[..pos].chars().next_back().is_none_or(|c| !word(c));
        let after_ok = hay[pos + needle.len()..].chars().next().is_none_or(|c| !word(c));
        if before_ok && after_ok {
            return Some(pos);
        }
        from = pos + needle.len();
    }
    None
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>, answer: &str) -> crate::trace::Exchange {
        crate::trace::Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: body.map(String::from),
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(answer.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        }
    }

    /// A value an answer of the walk delivered that a later request sent back, in any position, is the session's: a
    /// login answer's access token sent on as a bearer, its refresh token sent in a body, a cursor-like handle sent in
    /// an address. A value nobody sent back is only what the page said, and what the walk typed is the caller's.
    #[test]
    fn a_value_the_site_handed_over_and_the_walk_sent_back_is_the_sessions() {
        let (access, refresh, handle) = ("acc3ssTokenQ7w9e2r4t6y8", "r3freshTokenZ1x3c5v7b9", "h4ndle9921kq");
        let trace = Trace {
            exchanges: vec![
                exchange("POST", "https://shop.example/login", &[], Some(r#"{"user":"me@example.com"}"#), &format!(r#"{{"access_token":"{access}","refresh_token":"{refresh}","handle":"{handle}","shown":"onlyShownNeverSent42"}}"#)),
                exchange("GET", &format!("https://shop.example/api/me?h={handle}"), &[("Authorization", &format!("Bearer {access}"))], None, "{}"),
                exchange("POST", "https://shop.example/api/renew", &[("Content-Type", "application/json")], Some(&format!(r#"{{"refresh":"{refresh}"}}"#)), "{}"),
            ],
            inputs: vec![crate::trace::Input { name: "user".into(), value: "me@example.com".into(), secret: false }],
        };
        let held = session_values(&trace);
        for v in [access, refresh, handle] {
            assert!(held.iter().any(|h| h == v), "{v}: {held:?}");
        }
        assert!(!held.iter().any(|h| h.contains("onlyShownNeverSent42")), "an answer's value nothing sent back: {held:?}");
        assert!(!held.iter().any(|h| h.contains("me@example.com")), "what the walk typed: {held:?}");
    }
    use crate::trace::Exchange;

    /// The pass over every answer gives the same sightings with its finder or without one: a finder that couldn't be
    /// built is a slower scan, never one that found nothing.
    #[test]
    fn a_scan_whose_finder_did_not_build_still_reads_every_answer() {
        let token = "scr1ptTokenK8m2n4p6q8";
        let trace = Trace {
            exchanges: vec![
                exchange("GET", "https://shop.example/static/user.js", &[], None, &format!("window.__u = {{ t: \"{token}\" }};")),
                exchange("POST", "https://shop.example/api/cart", &[], Some(&format!(r#"{{"t":"{token}"}}"#)), "{}"),
            ],
            inputs: Vec::new(),
        };
        let patterns = [token, "nowhereAtAll123"];
        let with = sightings(&trace, &patterns, aho_corasick::AhoCorasick::new(patterns).ok());
        assert_eq!(with, vec![Some(0), None]);
        assert_eq!(sightings(&trace, &patterns, None), with);
    }

    /// An asset is an answer: a token a personalised script delivered that the page later sent back, in a body, is the
    /// session's, as one an API delivered is. A script read past [`ANSWER_SCAN_MOST`] isn't read for one.
    #[test]
    fn a_token_a_script_delivered_and_the_page_sent_back_is_the_sessions() {
        let token = "scr1ptTokenK8m2n4p6q8";
        let mut script = exchange("GET", "https://shop.example/static/user.js", &[], None, &format!("window.__u = {{ t: \"{token}\" }};"));
        script.response_mime = "application/javascript".into();
        script.resource_type = Some("Script".into());
        assert!(script.is_asset(), "the fixture is an asset");
        let far = "farTokenBeyondTheBound99";
        let mut big = exchange("GET", "https://shop.example/static/big.js", &[], None, &format!("{}{far}", " ".repeat(ANSWER_SCAN_MOST)));
        big.response_mime = "application/javascript".into();
        big.resource_type = Some("Script".into());
        let trace = Trace {
            exchanges: vec![
                script,
                big,
                exchange("POST", "https://shop.example/api/cart", &[("Content-Type", "application/json")], Some(&format!(r#"{{"t":"{token}","f":"{far}"}}"#)), "{}"),
            ],
            inputs: Vec::new(),
        };
        let held = session_values(&trace);
        assert!(held.iter().any(|h| h == token), "{held:?}");
        assert!(!held.iter().any(|h| h == far), "past the bound: {held:?}");
    }

    /// A page's GraphQL cache keys each query by the arguments it was asked with, an id made for the ask among them: the
    /// page asked again holds the same field under a new key, and the value is read from there. Two asks of one field
    /// are two keys, and neither is taken for the other.
    #[test]
    fn a_field_keyed_by_its_arguments_is_read_however_it_was_asked() {
        let walked = r#"/ROOT_QUERY/searchQueries/search({"input":{"acid":"a1","dest":"Bangkok"}})/flexibleDatesConfig/useCase"#;
        let now = serde_json::json!({ "ROOT_QUERY": { "searchQueries": { r#"search({"input":{"acid":"b2","dest":"Tokyo"}})"#: { "flexibleDatesConfig": { "useCase": "DATE_RANGE" } } } } });
        assert_eq!(at_pointer(&now, walked), Some(&serde_json::json!("DATE_RANGE")));
        let two = serde_json::json!({ "q": { "search({\"a\":1})": { "x": 1 }, "search({\"a\":2})": { "x": 2 } } });
        assert_eq!(at_pointer(&two, "/q/search({\"a\":3})/x"), None);
        assert_eq!(at_pointer(&two, "/q/search({\"a\":2})/x"), Some(&serde_json::json!(2)), "the exact key first");
        assert_eq!(at_pointer(&now, "/ROOT_QUERY/other/x"), None, "a plain key is the key");
    }

    fn ex(body: &str, headers: &[(&str, &str)]) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: "https://shop.example/x".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            response_body: Some(body.into()),
            response_mime: String::new(),
            resource_type: None,
            main_frame: None,
        }
    }

    fn trace(exchanges: Vec<Exchange>) -> Trace {
        Trace { exchanges, inputs: vec![] }
    }

    /// A page says a value in its text, and a POST it sent first says it back as JSON, as every answer of the site does.
    /// A read takes it from the page, so no POST rides along on every call. What only a POST gave stays the POST's, and a
    /// step that writes keeps the latest issuer.
    #[test]
    fn a_read_takes_a_value_from_a_pages_text_before_a_writes_answer() {
        let page = ex(r#"<html><head><meta content="/search/pins/?q=kitchen" property="og:url"/></head></html>"#, &[]);
        let mut write = ex(r#"{"context":{"visible_url":"/search/pins/?q=kitchen","order_id":"o_778899"}}"#, &[]);
        write.method = "POST".into();
        write.request_body = Some("experiment=one".into());
        let read = ex("{}", &[]);
        let t = trace(vec![page, write, read]);
        assert_eq!(find_origin(&t, 2, "/search/pins/?q=kitchen").unwrap().exchange, 0);
        assert_eq!(find_origin(&t, 2, "o_778899").unwrap().exchange, 1, "only the POST gave it");
        let mut t = t;
        t.exchanges[2].method = "POST".into();
        assert_eq!(find_origin(&t, 2, "/search/pins/?q=kitchen").unwrap().exchange, 1, "a write keeps the latest issuer");
    }

    #[test]
    fn a_response_that_plays_back_its_request_is_no_values_origin() {
        // A page reports a view and the server answers with the report itself: the feed id in it is the page's own.
        let sent = r#"{"info":[{"action":"view","request":{"canonical_url":"https://shop.example/c/shoes/"},"feed":{"correlation_id":"40d7a83a-01c0-4b1e"},"seen":0.97014925373134330}]}"#;
        // Played back with its number printed its own way.
        let played = sent[8..sent.len() - 1].replace("0.97014925373134330", "0.9701492537313433");
        let mut report = ex(&played, &[("Set-Cookie", "sid=s_abcdef; Path=/")]);
        report.method = "POST".into();
        report.request_body = Some(sent.into());
        assert!(report.echoes_its_request());
        let t = trace(vec![report]);
        assert!(find_origin(&t, 1, "40d7a83a-01c0-4b1e").is_none());
        // Its cookie is still the server's.
        assert_eq!(find_origin(&t, 1, "s_abcdef").unwrap().at, At::SetCookie { name: "sid".into() });
        // A response that adds anything of its own answers the request.
        let mut answer = ex(r#"{"id":"o_778899","name":"shoes"}"#, &[]);
        answer.request_body = Some(r#"{"name":"shoes"}"#.into());
        assert!(!answer.echoes_its_request());
        assert_eq!(find_origin(&trace(vec![answer]), 1, "o_778899").unwrap().at, At::Json { pointer: "/id".into() });
    }

    #[test]
    fn finds_a_json_leaf() {
        let t = trace(vec![ex(r#"{"results":[{"id":"p_123456"}]}"#, &[])]);
        let o = find_origin(&t, 1, "p_123456").unwrap();
        assert_eq!(o.at, At::Json { pointer: "/results/0/id".into() });
    }

    #[test]
    fn finds_a_set_cookie_before_a_header() {
        let t = trace(vec![ex("", &[("Set-Cookie", "sid=s_abcdef; Path=/; HttpOnly")])]);
        assert_eq!(find_origin(&t, 1, "s_abcdef").unwrap().at, At::SetCookie { name: "sid".into() });
    }

    #[test]
    fn finds_text_with_its_context() {
        let t = trace(vec![ex(r#"<meta name="csrf" content="csrf_998877">"#, &[])]);
        let o = find_origin(&t, 1, "csrf_998877").unwrap();
        assert_eq!(o.at, At::Text { before: r#"<meta name="csrf" content=""#.into(), after: "\"".into(), nth: 0 });
    }

    #[test]
    fn finds_a_wrapped_value() {
        let t = trace(vec![ex(r#"{"guestToken":"g_424242"}"#, &[])]);
        let o = find_origin(&t, 1, "Bearer g_424242").unwrap();
        assert_eq!(o.wrap, Some(("Bearer ".into(), String::new())));
    }

    /// A word an earlier answer holds, inside a long text the request sends (a GraphQL query naming the type
    /// `Video`), is not where the text comes from: the text has no origin, rather than one rebuilt around that word.
    /// The query that exposed it: a video site's search, whose replays sent a query rebuilt around another type name
    /// and answered an empty list (2026-11-06).
    #[test]
    fn a_word_inside_a_long_text_is_not_its_origin() {
        let t = trace(vec![ex(r#"{"data":{"story":{"__typename":"VideoStory"}}}"#, &[])]);
        let query = "fragment VIDEO_BASE_FRAGMENT on VideoStory { id xid title duration thumbnail channel { id xid name displayName } } query SEARCH_QUERY($query: String!) { search { videos(query: $query) { edges { node { ...VIDEO_BASE_FRAGMENT } } } } }";
        assert!(find_origin(&t, 1, query).is_none());
    }

    #[test]
    fn prefers_the_latest_response_and_ignores_later_ones() {
        let t = trace(vec![ex(r#"{"a":"tok_111111"}"#, &[]), ex(r#"{"b":"tok_111111"}"#, &[]), ex(r#"{"c":"tok_111111"}"#, &[])]);
        assert_eq!(find_origin(&t, 2, "tok_111111").unwrap().exchange, 1);
    }

    /// A page that carries more than one JSON document is searched whole: a value in the second one is read as well
    /// as one in the first, wherever the page put it when the call was made.
    #[test]
    fn a_value_in_any_of_the_pages_json_documents_is_read() {
        // The first document is the longer one: a reader that takes the page's biggest blob (or its first) finds
        // neither value, which is exactly what a page that reorders its state did in the wild.
        let big = "x".repeat(400);
        let body = format!(r#"<html><script type="application/json" id="layout">{{"theme":"dark","padding":"{big}"}}</script>
            <script type="application/json" id="state">{{"Application":{{"csrfToken":"tok_98765"}},"Location":{{"location":{{"country_id":"1880251"}}}}}}</script></html>"#);
        let page = ex(&body, &[]);
        let csrf = At::Json { pointer: "/Application/csrfToken".into() };
        assert_eq!(extract(&page, &csrf).as_deref(), Some("tok_98765"));
        let country = At::Json { pointer: "/Location/location/country_id".into() };
        assert_eq!(extract(&page, &country).as_deref(), Some("1880251"));
    }

    #[test]
    fn extract_reads_back_what_find_origin_found() {
        let t = trace(vec![
            ex(r#"<meta name="csrf" content="csrf_123456">"#, &[("Set-Cookie", "sid=s_abcdef; Path=/")]),
            ex(r#"{"results":[{"id":"p_998877"}]}"#, &[("X-Token", "rt_445566")]),
        ]);
        for (value, i) in [("csrf_123456", 0), ("s_abcdef", 0), ("p_998877", 1), ("rt_445566", 1)] {
            let o = find_origin(&t, 2, value).unwrap();
            assert_eq!(extract(&t.exchanges[i], &o.at).as_deref(), Some(value), "{value}");
        }
    }

    #[test]
    fn origin_urls_drop_the_query() {
        let mut e = ex(r#"{"id":"p_998877"}"#, &[]);
        e.url = "https://shop.example/api/search?q=secret+words".parse().unwrap();
        assert_eq!(find_origin(&trace(vec![e]), 1, "p_998877").unwrap().url, "https://shop.example/api/search");
    }

    #[test]
    fn descriptive_response_headers_are_not_sources() {
        let t = trace(vec![ex("", &[("Content-Type", "application/json"), ("X-Request-Token", "rt_778899")])]);
        assert!(find_origin(&t, 1, "application/json").is_none());
        assert_eq!(find_origin(&t, 1, "rt_778899").unwrap().at, At::Header { name: "x-request-token".into() });
    }

    #[test]
    fn short_values_and_partial_words_are_not_traced() {
        let t = trace(vec![ex(r#"{"a":"1"} abc_tok_111111x"#, &[])]);
        assert!(find_origin(&t, 1, "1").is_none());
        assert!(find_origin(&t, 1, "tok_111111").is_none());
    }

    #[test]
    fn prefers_the_pages_text_over_a_later_assets() {
        // The page references the asset; the asset's own text changes on every deploy,
        // so the page is the origin that survives.
        let page = ex(r#"<script src="/sttc/main.abc123.js"></script>"#, &[]);
        let css = ex("body{margin:0 1rem;padding-bottom:1rem}.abc123{}", &[]);
        let t = trace(vec![page, css]);
        let o = find_origin(&t, 2, "abc123").unwrap();
        assert_eq!(o.exchange, 0, "the page's reference outlives the asset's content");
        assert!(matches!(o.at, At::Text { .. }));
    }

    #[test]
    fn structured_issuers_still_prefer_the_latest() {
        let t = trace(vec![
            ex("", &[("Set-Cookie", "sid=s_abcdef; Path=/")]),
            ex("", &[("Set-Cookie", "sid=s_abcdef; Path=/")]),
        ]);
        assert_eq!(find_origin(&t, 2, "s_abcdef").unwrap().exchange, 1);
    }

    #[test]
    fn a_rotated_context_still_extracts_by_its_suffix() {
        // Learned against one bundle, re-run against a redeployed one: the code
        // around `fetch("/g/` changed, the pattern itself didn't.
        let learned = ex(r#"X};try{const e=await fetch("/g/search-intent/v1/x","#, &[]);
        let o = find_origin(&trace(vec![learned]), 1, "search-intent").unwrap();
        let fresh = ex(r#"Qy!;const k=await fetch("/g/search-intent/v1/x","#, &[]);
        assert_eq!(extract(&fresh, &o.at).as_deref(), Some("search-intent"));
    }
}
