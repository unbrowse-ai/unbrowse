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
    /// A value of the query of an address a header hands over: the `key` parameter of the URL the `name` header holds
    /// (a redirect's `location`), read against the request's own address. A sign-in service hands a one-time flow id
    /// over this way, on the way to the page that asks for the login.
    HeaderQuery { name: String, key: String },
    SetCookie { name: String },
    /// Text such as HTML or JS: the value follows the `nth` occurrence of `before`
    /// (0-based) and ends at `after`. A page lists many files after the same pattern,
    /// so which occurrence matters.
    Text { before: String, after: String, #[serde(default)] nth: usize },
}

impl At {
    /// Whether the value read here is a cookie the site set: one cookie of a `Set-Cookie` line, or a `Set-Cookie`
    /// (or `Set-Cookie2`) header read whole, which [`extract`] gives as the raw line, the cookie's value in it. Both
    /// are the session, and go on only in the cookie header of a route this node didn't learn
    /// (`replay::misplaced_session`, the app's `recipe::check_foreign`).
    pub fn sets_a_cookie(&self) -> bool {
        match self {
            At::SetCookie { .. } => true,
            At::Header { name } => name.eq_ignore_ascii_case("set-cookie") || name.eq_ignore_ascii_case("set-cookie2"),
            _ => false,
        }
    }
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

/// The HTTP authentication schemes a value may be wrapped in on its own (RFC 9110 §11.4, `auth-scheme 1*SP token68`;
/// the IANA registry's and the common unregistered `Token`, `Bot`, `JWT`): a word that says how the credential reads,
/// never part of it.
const AUTH_SCHEMES: &[&str] = &["Basic", "Bearer", "Bot", "Digest", "DPoP", "JWT", "Negotiate", "OAuth", "Token"];

impl Origin {
    /// Whether the text this origin puts around the value it reads can't choose the credential the request carries:
    /// none, or an authentication scheme alone and one space before it (`Bearer {value}`) with nothing after. The wrap
    /// is the route's own text, not the site's: in a body someone else wrote, `Bearer <their token> ` before the site's
    /// value, or `; sid=<theirs>` after it, sets the credential whole and leaves the site's value a stray word
    /// (`replay::chosen_credential`, the app's `recipe::check_foreign`).
    pub fn wraps_only_a_scheme(&self) -> bool {
        self.wrap.as_ref().is_none_or(|(before, after)| only_a_scheme(before, after))
    }
}

/// Whether text `before` and `after` a value can't choose the credential it makes: none, or an authentication scheme
/// alone and one space (`Bearer {value}`) with nothing after ([`Origin::wraps_only_a_scheme`]; a template's fixed text
/// around the caller's cookie or a clock reading, in the app's `recipe::check_foreign`).
pub fn only_a_scheme(before: &str, after: &str) -> bool {
    after.is_empty() && (before.is_empty() || before.strip_suffix(' ').is_some_and(|s| AUTH_SCHEMES.iter().any(|a| a.eq_ignore_ascii_case(s))))
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
///
/// Computed once per trace: every caller after the first (the walk's note, a trial, a site graph, a link reading) is
/// answered from the same reading ([`session_reading_key`]), and within one reading each answer's values are read once
/// (a [`Memo`] held for it), not once for every value a request sent.
pub fn session_values(trace: &Trace) -> Vec<String> {
    static READ: std::sync::Mutex<Vec<([u8; 32], Vec<String>)>> = std::sync::Mutex::new(Vec::new());
    let key = session_reading_key(trace);
    if let Some((_, held)) = READ.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(k, _)| *k == key) {
        return held.clone();
    }
    let out = {
        let _memo = Memo::unless_held();
        session_values_read(trace)
    };
    let mut read = READ.lock().unwrap_or_else(|e| e.into_inner());
    if !read.iter().any(|(k, _)| *k == key) {
        if read.len() >= SESSION_READINGS_KEPT {
            read.remove(0);
        }
        read.push((key, out.clone()));
    }
    out
}

/// Whether `v` is only a site's address: a host name (`www.shop.example`) or an origin (`https://www.shop.example`, a
/// port or a closing `/` allowed), nothing after it. A value that carries more (a path, a query, a token) is not.
fn an_address(v: &str) -> bool {
    let host = v.strip_prefix("https://").or_else(|| v.strip_prefix("http://")).unwrap_or(v).trim_end_matches('/');
    let host = host.rsplit_once(':').filter(|(_, port)| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit())).map_or(host, |(h, _)| h);
    let labels: Vec<&str> = host.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| !l.is_empty() && l.len() <= 63 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !l.starts_with('-'))
        && labels.last().is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
}

/// A text as read, not as escaped: a page's address the way a beacon sends it back, read back to plain text.
fn percent_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

/// Whether `v` reads as text, not as a token: every run of letters a plain word ([`a_plain_word`]) and every number at
/// most six digits (`iphone 13`, `taxation_customs`, `price_end=400&sort_by=3`). A token mixes letters and digits in
/// one run, runs its case at random, or is a long number (an id, a time), and doesn't.
fn plain_text(v: &str) -> bool {
    let mut runs = v.split(|c: char| !c.is_alphanumeric()).filter(|r| !r.is_empty()).peekable();
    runs.peek().is_some() && runs.all(|r| a_plain_word(r) || (r.len() <= 6 && r.chars().all(|c| c.is_ascii_digit())))
}

/// What `url`, the walked page's own address, says in plain text ([`plain_text`]), read as text: its path, each part
/// of it, each value of its query, and its path with its query. The caller wrote it, or the site shows it to anyone at
/// that address; either way it is not a session. A token in the address (a redirect's `?sid=...`) doesn't read as text
/// and is left to be read as before.
fn said_by_the_address(url: &url::Url) -> Vec<String> {
    let path = percent_decode(url.path());
    let mut said: Vec<String> = url.path_segments().into_iter().flatten().map(percent_decode).collect();
    said.extend(url.query_pairs().map(|(_, v)| v.into_owned()));
    if let Some(query) = url.query() {
        said.push(format!("{path}?{}", percent_decode(query)));
    }
    said.push(path);
    said.retain(|v| !v.trim().is_empty() && v != "/" && plain_text(v));
    said
}

/// How many traces' session readings are kept: a learn reads a few walks.
const SESSION_READINGS_KEPT: usize = 16;

/// What a session reading of `trace` is a function of, as a SHA-256: every field of every exchange and every input of
/// the trace, and the decoders in force (`trace::decoders_in_force`), through which a reply no standard reader reads
/// is read. Two traces with the same key are read the same.
fn session_reading_key(trace: &Trace) -> [u8; 32] {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    let mut put = |bytes: &[u8]| {
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(bytes);
    };
    put(&(trace.exchanges.len() as u64).to_le_bytes());
    for e in &trace.exchanges {
        put(e.method.as_bytes());
        put(e.url.as_str().as_bytes());
        put(&(e.request_headers.len() as u64).to_le_bytes());
        for (k, v) in &e.request_headers {
            put(k.as_bytes());
            put(v.as_bytes());
        }
        put(&[e.request_body.is_some() as u8]);
        put(e.request_body.as_deref().unwrap_or_default().as_bytes());
        put(&e.status.to_le_bytes());
        put(&(e.response_headers.len() as u64).to_le_bytes());
        for (k, v) in &e.response_headers {
            put(k.as_bytes());
            put(v.as_bytes());
        }
        put(&[e.response_body.is_some() as u8]);
        put(e.response_body.as_deref().unwrap_or_default().as_bytes());
        put(e.response_mime.as_bytes());
        put(&[e.resource_type.is_some() as u8]);
        put(e.resource_type.as_deref().unwrap_or_default().as_bytes());
        put(&[e.main_frame.map_or(2, u8::from)]);
    }
    put(&(trace.inputs.len() as u64).to_le_bytes());
    for i in &trace.inputs {
        put(i.name.as_bytes());
        put(i.value.as_bytes());
        put(&[i.secret as u8]);
    }
    let decoders = crate::trace::decoders_in_force();
    put(&(decoders.len() as u64).to_le_bytes());
    for d in decoders.iter() {
        put(d.as_bytes());
    }
    h.finalize().into()
}

/// [`session_values`], read afresh.
fn session_values_read(trace: &Trace) -> Vec<String> {
    // Every sent value is searched for in every answer before it: the bodies are read once for all of them.
    let searched: Vec<String> = trace
        .exchanges
        .iter()
        .filter(|ex| !ex.is_asset())
        .flat_map(crate::slots::slots)
        .filter(|slot| !matches!(slot.loc, crate::slots::Loc::Cookie(_)))
        .map(|slot| slot.value)
        .collect();
    index_text(trace, &searched.iter().map(String::as_str).collect::<Vec<_>>());
    let mut out: Vec<String> = Vec::new();
    // A site's address (an origin, a bare host name) names a place and signs no one in, wherever a request sends it.
    let mut put = |v: &str| {
        let v = v.trim();
        if !v.is_empty() && !an_address(v) && !out.iter().any(|o| o == v) {
            out.push(v.to_string());
        }
    };
    // Every value a request sent (and each word of it), with the requests that sent it.
    let traceable = |v: &str| v.len() >= MIN_TRACEABLE && !a_plain_word(v);
    let mut sent: Vec<(usize, String, String)> = Vec::new();
    // A request that sends the walked page's own address is reporting the page (an analytics hit, a tag saying where it
    // fired), not using what the site handed this visitor: what it sends back is what the page says to anyone (its
    // address, its title, the search it shows), and none of it is the session. Read as the session, those values were
    // masked out of every answer an agent got, links and titles and the search word with them. Its cookies still are.
    let page = trace.exchanges.iter().find(|e| e.is_main_document()).and_then(|e| Some(format!("{}{}", e.url.host_str()?, percent_decode(e.url.path())).to_lowercase()));
    let reports_the_page = |ex: &crate::trace::Exchange| {
        page.as_deref().is_some_and(|p| !ex.is_main_document() && (crate::trace::carries_text(ex.url.query().unwrap_or_default(), p) || ex.request_body.as_deref().is_some_and(|b| crate::trace::carries_text(b, p))))
    };
    // What the walked page's own address says in plain text is the caller's and the page's, never the session's, whichever
    // request sends it back: the site's own search call sends the search typed into the address, an event its path.
    let addressed = trace.exchanges.iter().find(|e| e.is_main_document()).map(|e| said_by_the_address(&e.url)).unwrap_or_default();
    let by_the_address = |v: &str| addressed.iter().any(|a| a == v.trim() || *a == percent_decode(v.trim()));
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
        if reports_the_page(ex) {
            continue;
        }
        for slot in crate::slots::slots(ex) {
            // A header the page's code can't set (`referer`, `origin`, a `sec-` header) is the browser's own word, saying
            // where the request came from: the page's address, which the site shows anyone, never what it handed over.
            let the_browsers = matches!(&slot.loc, crate::slots::Loc::Header(h) if crate::sandbox::forbidden_header(h));
            if matches!(slot.loc, crate::slots::Loc::Cookie(_)) || the_browsers || trace.inputs.iter().any(|t| t.value == slot.value) || by_the_address(&slot.value) {
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
            if !by_the_address(word) {
                put(word);
            }
            if !by_the_address(value) {
                put(value);
            }
        }
    }
    out
}

/// The reading [`session_values`] made before it was computed once (1b13e3b1, verbatim but for its name and the check
/// that no memo is held): the reference its tests hold the fast reading to, value for value and in order.
#[cfg(test)]
pub(crate) fn session_values_before(trace: &Trace) -> Vec<String> {
    assert!(MEMO.with(|m| m.borrow().is_none()), "the reference reads with no memo held, as it always did");
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
    // While a memo lives, where the value sits in the walk is read once, whatever request asks ([`Hits`]), and each
    // search below picks from that what reading the answers one by one would have found first.
    let Some(hits) = hits(trace, value) else { return find_origin_reading_every_answer(trace, before, value, host) };
    let n = before.min(trace.exchanges.len());
    let preferred = |i: usize| host.is_none_or(|h| trace.exchanges[i].url.host_str() == Some(h));
    let reads = |i: usize| trace.exchanges.get(i).is_some_and(|e| matches!(e.method.as_str(), "GET" | "HEAD"));
    let found = |(i, at): &(usize, At)| Some(origin(trace, *i, at.clone(), None));
    if reads(before) {
        if let Some(hit) = hits.structured.iter().rev().find(|(i, _)| *i < n && preferred(*i) && reads(*i)) {
            return found(hit);
        }
        if let Some(hit) = hits.text.iter().find(|(i, _)| *i < n && preferred(*i) && reads(*i)) {
            return found(hit);
        }
    }
    if let Some(hit) = hits.structured.iter().rev().find(|(i, _)| *i < n && preferred(*i)) {
        return found(hit);
    }
    if let Some(hit) = hits.text.iter().find(|(i, _)| *i < n && preferred(*i)) {
        return found(hit);
    }
    if host.is_some() {
        return find_origin_on(trace, before, value, None);
    }
    hits.contained.iter().find(|(i, _, _)| *i < n).map(|(i, at, wrap)| origin(trace, *i, at.clone(), Some(wrap.clone())))
}

/// [`find_origin_on`] with no memo: each answer before `before` is read in turn until one holds the value.
fn find_origin_reading_every_answer(trace: &Trace, before: usize, value: &str, host: Option<&str>) -> Option<Origin> {
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
        return find_origin_reading_every_answer(trace, before, value, None);
    }
    // Not found whole: look for an earlier response value inside it, as most of it (`Bearer <token>`). A word a long
    // text happens to hold (`Video` inside a GraphQL query) is no part of where the text comes from: rebuilt around
    // that word as a later answer gives it, the text would change on every call.
    for i in (0..n).rev().filter(|&i| !trace.exchanges[i].is_asset()) {
        for (candidate, at) in response_values(trace, i).iter() {
            if candidate.len() < MIN_TRACEABLE || candidate == value || candidate.len() * 2 < value.len() {
                continue;
            }
            if let Some(pos) = value.find(candidate.as_str()).filter(|&pos| stands_apart(value, pos, candidate.len())) {
                let wrap = (value[..pos].to_string(), value[pos + candidate.len()..].to_string());
                return Some(origin(trace, i, at.clone(), Some(wrap)));
            }
        }
    }
    None
}

/// Whether the text at `pos..pos + len` of `value` stands apart from what wraps it: no letter or digit runs on across
/// either edge. A wrap is text around a value (`Bearer `), never the rest of one run of digits or letters: a clock
/// reading in milliseconds holds the same clock in seconds as its head, and that is two readings, not one wrapped.
fn stands_apart(value: &str, pos: usize, len: usize) -> bool {
    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    let inner = &value[pos..pos + len];
    !(word(value[..pos].chars().next_back()) && word(inner.chars().next())) && !(word(value[pos + len..].chars().next()) && word(inner.chars().next_back()))
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
    // Under a memo, each answer's values are indexed once by value, the first place each stands kept: the same answer
    // as the scan below, found without reading every value of the answer for every value looked for.
    if let Some(index) = response_index(trace, i) {
        return index.get(value).cloned();
    }
    response_values(trace, i).iter().find(|(v, _)| v == value).map(|(_, at)| at.clone())
}

/// Each answer's values by value, the first place each stands in [`response_values`]' order: built once per answer
/// while a [`Memo`] lives. None with no memo held.
fn response_index(trace: &Trace, i: usize) -> Option<Rc<HashMap<String, At>>> {
    let key = (trace as *const Trace as usize, i);
    if !MEMO.with(|m| m.borrow().is_some()) {
        return None;
    }
    if let Some(found) = INDEX.with(|x| x.borrow().as_ref().and_then(|c| c.get(&key).cloned())) {
        return Some(found);
    }
    let mut index: HashMap<String, At> = HashMap::new();
    for (v, at) in response_values(trace, i).iter() {
        index.entry(v.clone()).or_insert_with(|| at.clone());
    }
    let index = Rc::new(index);
    INDEX.with(|x| {
        if let Some(c) = x.borrow_mut().as_mut() {
            c.insert(key, index.clone());
        }
    });
    Some(index)
}

fn find_in_text(trace: &Trace, i: usize, value: &str) -> Option<At> {
    if echoes(trace, i) || says_back(&trace.exchanges[i], value) {
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

/// What a search reads of one response, once while a memo lives: its structured values, and whether it says its own
/// request back ([`crate::trace::Exchange::echoes_its_request`], which reads two bodies as JSON).
#[derive(Default)]
struct Read {
    values: HashMap<(usize, usize), Rc<Vec<(String, At)>>>,
    echoes: HashMap<(usize, usize), bool>,
    /// For each trace whose bodies were indexed ([`index_text`]): every indexed value, with the answers (by index,
    /// ascending) whose body holds it anywhere. A value indexed and held by no body has an empty list.
    holders: HashMap<usize, HashMap<String, Rc<Vec<usize>>>>,
    /// For each trace: every structured value of its answers, with each answer holding it and where (first place).
    structured: HashMap<usize, Rc<HashMap<String, Vec<(usize, At)>>>>,
    /// For each trace: the finder for values held inside a longer one ([`Inside`]).
    inside: HashMap<usize, Rc<Inside>>,
    /// Where each value searched for sits in its trace ([`Hits`]).
    hits: HashMap<(usize, String), Rc<Hits>>,
}

thread_local! {
    /// Each response's values by value, beside `MEMO` and for as long as it lives ([`response_index`]).
    static INDEX: RefCell<Option<HashMap<(usize, usize), Rc<HashMap<String, At>>>>> = const { RefCell::new(None) };
    /// How many times this thread read a response's values ([`answer_reads`]).
    static READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many times this thread has read a response's values (its headers, cookies and JSON, the body parsed): once per
/// response while a [`Memo`] lives, once per look without one.
pub fn answer_reads() -> usize {
    READS.with(|n| n.get())
}

/// Where a value sits in a walk's answers, whichever request asks: what [`find_origin_on`] reads, once per value.
struct Hits {
    /// Every answer holding it as a structured value, and its first place there, by answer, ascending.
    structured: Vec<(usize, At)>,
    /// Every non-asset answer holding it whole in its text, and where, by answer, ascending.
    text: Vec<(usize, At)>,
    /// Every non-asset answer holding a shorter value inside it, as most of it: the first such of its values, its
    /// place and what the value wraps it in, by answer, descending.
    contained: Vec<(usize, At, (String, String))>,
}

/// The longest structured value looked for inside a sent one by the finder; a sent value over this is read against
/// every answer's values one by one, so a longer one is never missed.
const INSIDE_MOST: usize = 4096;

/// Every structured value of a walk's non-asset answers from [`MIN_TRACEABLE`] to [`INSIDE_MOST`] long, and a finder
/// that reads a sent value once for all of them: which of them it holds, and in which answers they sit.
struct Inside {
    finder: Option<aho_corasick::AhoCorasick>,
    patterns: Vec<String>,
    /// For each pattern: each answer holding it, its first position among that answer's values, and its place.
    places: Vec<Vec<(usize, usize, At)>>,
}

thread_local! {
    /// Each response's reading, made once while a graph is built or a walk's session values are read rather than once
    /// per value searched: a long walk holds thousands of responses, and every value a request sent is searched for in
    /// each response before it.
    static MEMO: RefCell<Option<Read>> = const { RefCell::new(None) };
}

/// Remembers responses' readings for as long as it lives. The traces searched must not change meanwhile: a graph
/// build holds one for its own fixed traces. Memos nest: one started while another lives shares it, and only the
/// outermost one forgets what was read, so a search inside a graph build inside a learn keeps the learn's readings.
pub struct Memo {
    owns: bool,
}

impl Memo {
    pub fn start() -> Self {
        let owns = MEMO.with(|m| {
            let mut m = m.borrow_mut();
            let fresh = m.is_none();
            if fresh {
                *m = Some(Read::default());
            }
            fresh
        });
        if owns {
            INDEX.with(|x| *x.borrow_mut() = Some(HashMap::new()));
        }
        Memo { owns }
    }

    /// A memo for a reading that may run inside another's: started where none is held, else None and the one held
    /// serves (its traces are as fixed as this reading's).
    fn unless_held() -> Option<Self> {
        MEMO.with(|m| m.borrow().is_none()).then(Memo::start)
    }
}

impl Drop for Memo {
    fn drop(&mut self) {
        if self.owns {
            MEMO.with(|m| *m.borrow_mut() = None);
            INDEX.with(|x| *x.borrow_mut() = None);
        }
    }
}

/// Whether response `i` says its own request back, read once per memo.
fn echoes(trace: &Trace, i: usize) -> bool {
    let key = (trace as *const Trace as usize, i);
    if let Some(e) = MEMO.with(|m| m.borrow().as_ref().and_then(|r| r.echoes.get(&key).copied())) {
        return e;
    }
    let e = trace.exchanges[i].echoes_its_request();
    MEMO.with(|m| {
        if let Some(r) = m.borrow_mut().as_mut() {
            r.echoes.insert(key, e);
        }
    });
    e
}

/// Reads every non-asset answer's body of `trace` once for all of `values`, so that while the memo lives a search for
/// one of them in the page's text ([`find_origin_on`]) reads only the bodies that hold it somewhere. Searching each
/// value through every body on its own costs the values times the bytes: a walk of thousands of answers and tens of
/// megabytes, with thousands of values sent, took minutes. A body that doesn't hold a value at all can't hold it as a
/// whole word either, so the answers searched are fewer and the answer found is the same. Nothing is indexed without a
/// memo, or when the finder for these values can't be built: the search then reads every body, as before.
pub fn index_text(trace: &Trace, values: &[&str]) {
    if MEMO.with(|m| m.borrow().is_none()) {
        return;
    }
    let mut patterns: Vec<&str> = values.iter().copied().filter(|v| v.len() >= MIN_TRACEABLE && !a_plain_word(v)).collect();
    patterns.sort_unstable();
    patterns.dedup();
    if patterns.is_empty() {
        return;
    }
    let Ok(finder) = aho_corasick::AhoCorasick::new(&patterns) else { return };
    let mut held: Vec<Vec<usize>> = vec![Vec::new(); patterns.len()];
    for (i, ex) in trace.exchanges.iter().enumerate().filter(|(_, e)| !e.is_asset()) {
        let Some(body) = ex.response_body.as_deref() else { continue };
        for m in finder.find_overlapping_iter(body) {
            let list = &mut held[m.pattern().as_usize()];
            if list.last() != Some(&i) {
                list.push(i);
            }
        }
    }
    let index: HashMap<String, Rc<Vec<usize>>> = patterns.iter().zip(held).map(|(p, h)| (p.to_string(), Rc::new(h))).collect();
    let key = trace as *const Trace as usize;
    MEMO.with(|m| {
        if let Some(r) = m.borrow_mut().as_mut() {
            r.holders.entry(key).or_default().extend(index);
        }
    });
}

/// Where `value` sits in `trace`'s answers, read once while a memo lives; None with no memo.
fn hits(trace: &Trace, value: &str) -> Option<Rc<Hits>> {
    let key = (trace as *const Trace as usize, value.to_string());
    let known = MEMO.with(|m| m.borrow().as_ref().map(|r| r.hits.get(&key).cloned()))?;
    if let Some(h) = known {
        return Some(h);
    }
    let structured = structured_index(trace).get(value).cloned().unwrap_or_default();
    let held = holders(trace, value);
    let text = (0..trace.exchanges.len())
        .filter(|&i| !trace.exchanges[i].is_asset() && held.as_ref().is_none_or(|h| h.binary_search(&i).is_ok()))
        .filter_map(|i| find_in_text(trace, i, value).map(|at| (i, at)))
        .collect();
    let h = Rc::new(Hits { structured, text, contained: contained(trace, value) });
    MEMO.with(|m| {
        if let Some(r) = m.borrow_mut().as_mut() {
            r.hits.insert(key, h.clone());
        }
    });
    Some(h)
}

/// Every structured value of `trace`'s answers, with the answers holding it and its first place in each.
fn structured_index(trace: &Trace) -> Rc<HashMap<String, Vec<(usize, At)>>> {
    let key = trace as *const Trace as usize;
    if let Some(ix) = MEMO.with(|m| m.borrow().as_ref().and_then(|r| r.structured.get(&key).cloned())) {
        return ix;
    }
    let mut ix: HashMap<String, Vec<(usize, At)>> = HashMap::new();
    for i in 0..trace.exchanges.len() {
        for (v, at) in response_values(trace, i).iter() {
            let list = ix.entry(v.clone()).or_default();
            if list.last().is_none_or(|(j, _)| *j != i) {
                list.push((i, at.clone()));
            }
        }
    }
    let ix = Rc::new(ix);
    MEMO.with(|m| {
        if let Some(r) = m.borrow_mut().as_mut() {
            r.structured.insert(key, ix.clone());
        }
    });
    ix
}

/// The answers holding one of their values inside `value`, as most of it, latest first: for each, the first such value
/// it holds, its place, and the text around it in `value`.
fn contained(trace: &Trace, value: &str) -> Vec<(usize, At, (String, String))> {
    let fits = |candidate: &str| candidate.len() >= MIN_TRACEABLE && candidate != value && candidate.len() * 2 >= value.len();
    let wrap = |candidate: &str| value.find(candidate).map(|pos| (value[..pos].to_string(), value[pos + candidate.len()..].to_string()));
    let inside = inside(trace);
    let Some(finder) = inside.finder.as_ref().filter(|_| value.len() <= INSIDE_MOST) else {
        let mut out = Vec::new();
        for i in (0..trace.exchanges.len()).rev().filter(|&i| !trace.exchanges[i].is_asset()) {
            let first = response_values(trace, i).iter().find_map(|(c, at)| if fits(c) { wrap(c).map(|w| (at.clone(), w)) } else { None });
            if let Some((at, w)) = first {
                out.push((i, at, w));
            }
        }
        return out;
    };
    // For each answer, the earliest of its values the finder saw inside `value`.
    let mut first: std::collections::BTreeMap<usize, (usize, usize, &At)> = std::collections::BTreeMap::new();
    for m in finder.find_overlapping_iter(value) {
        let p = m.pattern().as_usize();
        if !fits(&inside.patterns[p]) {
            continue;
        }
        for (i, n, at) in &inside.places[p] {
            let slot = first.entry(*i).or_insert((*n, p, at));
            if *n < slot.0 {
                *slot = (*n, p, at);
            }
        }
    }
    first.into_iter().rev().filter_map(|(i, (_, p, at))| wrap(&inside.patterns[p]).map(|w| (i, at.clone(), w))).collect()
}

/// The finder for values held inside a longer one, built once per trace while a memo lives.
fn inside(trace: &Trace) -> Rc<Inside> {
    let key = trace as *const Trace as usize;
    if let Some(i) = MEMO.with(|m| m.borrow().as_ref().and_then(|r| r.inside.get(&key).cloned())) {
        return i;
    }
    let mut ids: HashMap<String, usize> = HashMap::new();
    let mut patterns: Vec<String> = Vec::new();
    let mut places: Vec<Vec<(usize, usize, At)>> = Vec::new();
    for i in (0..trace.exchanges.len()).filter(|&i| !trace.exchanges[i].is_asset()) {
        for (n, (v, at)) in response_values(trace, i).iter().enumerate() {
            if v.len() < MIN_TRACEABLE || v.len() > INSIDE_MOST {
                continue;
            }
            let p = *ids.entry(v.clone()).or_insert_with(|| {
                patterns.push(v.clone());
                places.push(Vec::new());
                patterns.len() - 1
            });
            if places[p].last().is_none_or(|(j, _, _)| *j != i) {
                places[p].push((i, n, at.clone()));
            }
        }
    }
    let finder = aho_corasick::AhoCorasick::new(&patterns).ok();
    let inside = Rc::new(Inside { finder, patterns, places });
    MEMO.with(|m| {
        if let Some(r) = m.borrow_mut().as_mut() {
            r.inside.insert(key, inside.clone());
        }
    });
    inside
}

/// The answers whose body holds `value` somewhere, when `value` was indexed for `trace` ([`index_text`]); None when it
/// wasn't, and every body is to be read.
fn holders(trace: &Trace, value: &str) -> Option<Rc<Vec<usize>>> {
    let key = trace as *const Trace as usize;
    MEMO.with(|m| m.borrow().as_ref().and_then(|r| r.holders.get(&key)).and_then(|h| h.get(value).cloned()))
}

/// Structured values in a response: `Set-Cookie` values, other headers, and JSON leaves.
fn response_values(trace: &Trace, i: usize) -> Rc<Vec<(String, At)>> {
    let key = (trace as *const Trace as usize, i);
    if let Some(v) = MEMO.with(|m| m.borrow().as_ref().and_then(|r| r.values.get(&key).cloned())) {
        return v;
    }
    let v = Rc::new(read_values(trace, i));
    MEMO.with(|m| {
        if let Some(r) = m.borrow_mut().as_mut() {
            r.values.insert(key, v.clone());
        }
    });
    v
}

/// Whether `value` is one this exchange's own request sent in its address (a query value or a path piece, as written or
/// in another case): its answer saying it back is no source of it.
fn says_back(ex: &crate::trace::Exchange, value: &str) -> bool {
    !value.is_empty()
        && (ex.url.query_pairs().any(|(_, v)| v.eq_ignore_ascii_case(value))
            || ex.url.path_segments().into_iter().flatten().any(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().eq_ignore_ascii_case(value)))
}

fn read_values(trace: &Trace, i: usize) -> Vec<(String, At)> {
    READS.with(|n| n.set(n.get() + 1));
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
            // An address the header hands over gives each value of its query too, where the request didn't send it.
            if let Some(to) = handed_address(ex, v) {
                for (key, value) in to.query_pairs() {
                    if value.len() >= MIN_TRACEABLE && !says_back(ex, &value) {
                        out.push((value.into_owned(), At::HeaderQuery { name: name_lc.clone(), key: key.into_owned() }));
                    }
                }
            }
        }
    }
    if let Some(json) = ex.json_body().filter(|_| !echoes(trace, i)) {
        // A leaf that only says back what this same request sent in its address (a gateway answering
        // `"api": "<the operation the request named>"`) is no source of it: a later call that sends it takes it from
        // wherever this request did, and an answer that is refused (or says something else) leaves it standing.
        for (pointer, v) in json_leaves(&json) {
            if says_back(ex, &v) {
                continue;
            }
            out.push((v, At::Json { pointer }));
        }
    }
    out
}

/// The address a header's value hands over, read against the request's own: only a value written as one (absolute, or
/// a path from the root).
fn handed_address(ex: &crate::trace::Exchange, v: &str) -> Option<url::Url> {
    let v = v.trim();
    (v.starts_with("http://") || v.starts_with("https://") || v.starts_with('/')).then(|| ex.url.join(v).ok()).flatten()
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
                None => volatile_key_match(m, &key)?,
            },
            Value::Array(a) => a.get(key.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(at)
}

/// A key the page names with a part that changes every fetch, matched by the parts that stay: a `name(...)` argument,
/// or a per-load identifier (a UUID) embedded in the key. The match must be unique — two keys with the same stable
/// parts say nothing about which one the value sits in. No site is named; the shape of the key is the rule.
fn volatile_key_match<'v>(m: &'v serde_json::Map<String, Value>, key: &str) -> Option<&'v Value> {
    if let Some(field) = key.split_once('(').filter(|(name, _)| !name.is_empty() && key.ends_with(')')).map(|(name, _)| format!("{name}(")) {
        let mut asked = m.iter().filter(|(k, _)| k.starts_with(&field) && k.ends_with(')'));
        if let (Some((_, next)), None) = (asked.next(), asked.next()) {
            return Some(next);
        }
    }
    if let Some((prefix, suffix)) = uuid_stable_parts(key) {
        let mut asked = m.iter().filter(|(k, _)| {
            k.starts_with(&prefix) && k.ends_with(&suffix)
                && k.len() > prefix.len() + suffix.len()
                && is_uuid(&k[prefix.len()..k.len() - suffix.len()])
        });
        if let (Some((_, next)), None) = (asked.next(), asked.next()) {
            return Some(next);
        }
    }
    None
}

/// Whether `s` is a UUID (8-4-4-4-12 hex), the per-load identifier a page generates anew each fetch.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        if matches!(i, 8 | 13 | 18 | 23) {
            if *c != b'-' {
                return false;
            }
        } else if !c.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// The stable prefix and suffix around the first UUID embedded in a key, if it carries one.
fn uuid_stable_parts(key: &str) -> Option<(String, String)> {
    if key.len() < 36 {
        return None;
    }
    for start in 0..=key.len() - 36 {
        if key.is_char_boundary(start) && key.is_char_boundary(start + 36) && is_uuid(&key[start..start + 36]) {
            return Some((key[..start].to_string(), key[start + 36..].to_string()));
        }
    }
    None
}

/// Whether any segment of a pointer is a volatile key (a per-load UUID or a `name(...)` argument): a container the
/// page may name differently, or leave out, on another fetch.
fn pointer_volatile(pointer: &str) -> bool {
    pointer.split('/').skip(1).any(|seg| {
        let key = seg.replace("~1", "/").replace("~0", "~");
        uuid_stable_parts(&key).is_some()
            || (key.split_once('(').is_some_and(|(name, _)| !name.is_empty()) && key.ends_with(')'))
    })
}

/// The one scalar leaf named `name` across the page's JSON documents, if exactly one carries it: a value whose
/// container is volatile is still named by its own field. Two leaves of the same name say nothing about which is the
/// value's, so an ambiguous name is not read.
fn unique_leaf_named<'v>(docs: &'v [Value], name: &str) -> Option<&'v Value> {
    fn walk<'v>(v: &'v Value, name: &str, found: &mut Option<&'v Value>, count: &mut usize) {
        match v {
            Value::Object(m) => {
                for (k, val) in m {
                    if k == name && !matches!(val, Value::Object(_) | Value::Array(_) | Value::Null) {
                        *count += 1;
                        if *count == 1 {
                            *found = Some(val);
                        }
                    }
                    walk(val, name, found, count);
                }
            }
            Value::Array(a) => {
                for val in a {
                    walk(val, name, found, count);
                }
            }
            _ => {}
        }
    }
    let mut found = None;
    let mut count = 0;
    for d in docs {
        walk(d, name, &mut found, &mut count);
    }
    if count == 1 {
        found
    } else {
        None
    }
}

/// Reads the value at `at` from a response: how replay takes a derived value from a fresh
/// response.
pub fn extract(ex: &crate::trace::Exchange, at: &At) -> Option<String> {
    match at {
        At::SetCookie { name } => ex.set_cookies().into_iter().find(|(k, _)| k == name).map(|(_, v)| v),
        At::Header { name } => ex.response_header(name).map(str::to_string),
        At::HeaderQuery { name, key } => handed_address(ex, ex.response_header(name)?)?.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned()),
        At::Json { pointer } => {
            // A page can carry several JSON documents (its own state, a layout's, an ad's), and which one holds the
            // value can change with what was asked: the value is the first document's that has it.
            let docs = ex.json_documents();
            let found = docs.iter().find_map(|json| at_pointer(json, pointer)).or_else(|| {
                // A volatile container (a per-load UUID, a `name(...)` argument) may be absent this fetch — a search
                // that renders no sponsored listings carries no SponsoredListingData. The leaf's own name, unique
                // across the page's documents, is the value's stable place; an ambiguous name is not read.
                let leaf = pointer.rsplit('/').next().map(|s| s.replace("~1", "/").replace("~0", "~")).unwrap_or_default();
                if leaf.is_empty() || !pointer_volatile(pointer) {
                    return None;
                }
                unique_leaf_named(&docs, &leaf)
            })?;
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

    /// A pointer whose key embeds a per-load UUID matches a fresh page's key by its stable parts: the page generates
    /// the identifier anew each fetch, so the literal key the walk recorded is never the replay's.
    #[test]
    fn a_pointer_key_embedding_a_per_load_uuid_matches_by_its_stable_parts() {
        let ptr = "/data:0fe9406b-c393-43ec-91db-d1dfc1dd86e0_4/pageViewId";
        let walked = serde_json::json!({"data:0fe9406b-c393-43ec-91db-d1dfc1dd86e0_4": {"pageViewId": "pv-walked"}});
        assert_eq!(at_pointer(&walked, ptr).and_then(|v| v.as_str()), Some("pv-walked"));
        let fresh = serde_json::json!({"data:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_4": {"pageViewId": "pv-fresh"}});
        assert_eq!(at_pointer(&fresh, ptr).and_then(|v| v.as_str()), Some("pv-fresh"), "the fresh page's UUID key matches by prefix and suffix");
        let ambiguous = serde_json::json!({
            "data:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_4": {"pageViewId": "a"},
            "data:ffffffff-1111-2222-3333-444444444444_4": {"pageViewId": "b"}
        });
        assert_eq!(at_pointer(&ambiguous, ptr), None, "two keys with the same stable parts say nothing about which holds the value");
    }

    /// A volatile container absent on this fetch (a search rendering no sponsored listings) falls back to the leaf's
    /// own name, unique across the page's documents; an ambiguous name is not read.
    #[test]
    fn a_volatile_container_absent_this_fetch_falls_back_to_the_unique_leaf_name() {
        let ptr = At::Json { pointer: "/data:0fe9406b-c393-43ec-91db-d1dfc1dd86e0_4/pageViewId".into() };
        let ex = exchange("GET", "https://www.example.com/search", &[], None, r#"{"pageViewId":"pv-fresh","other":{"x":1}}"#);
        assert_eq!(extract(&ex, &ptr).as_deref(), Some("pv-fresh"));
        let amb = exchange("GET", "https://www.example.com/search", &[], None, r#"{"a":{"pageViewId":"p1"},"b":{"pageViewId":"p2"}}"#);
        assert_eq!(extract(&amb, &ptr), None, "two leaves of the same name say nothing about which is the value's");
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
    /// Reading only the answers whose body holds a value somewhere finds the same origin as reading every body: a
    /// value held only inside a longer word, held twice, held by a page and by a later call, or held nowhere.
    #[test]
    fn a_search_that_reads_only_the_bodies_holding_a_value_finds_what_reading_every_body_finds() {
        let page = |url: &str, body: &str| {
            let mut e = exchange("GET", url, &[], None, body);
            e.response_mime = "text/html".into();
            e.resource_type = Some("Document".into());
            e
        };
        let trace = Trace {
            exchanges: vec![
                page("https://shop.example/", r#"<script>window.k="pageKey7731xq"; var lot="xxpageKey7731xqyy";</script>"#),
                page("https://shop.example/other", "nothing of note here at all"),
                exchange("GET", "https://shop.example/api/a?k=pageKey7731xq", &[], None, r#"{"next":"curs0rAb12cd","note":"inside curs0rAb12cdZ"}"#),
                page("https://shop.example/later", r#"<a data-c="curs0rAb12cd">again pageKey7731xq</a>"#),
                exchange("GET", "https://shop.example/api/b?c=curs0rAb12cd&z=nowhere99zz1", &[], None, "{}"),
            ],
            inputs: vec![],
        };
        let values = ["pageKey7731xq", "curs0rAb12cd", "nowhere99zz1", "xxpageKey7731xqyy", "Bearer curs0rAb12cd", "pre curs0rAb12cd post"];
        let all = |trace: &Trace| -> Vec<Option<Origin>> {
            let mut out = Vec::new();
            for v in values {
                for host in [None, Some("shop.example"), Some("elsewhere.example")] {
                    out.extend((0..=trace.exchanges.len()).map(|b| find_origin_on(trace, b, v, host)));
                }
            }
            out
        };
        let every_body = all(&trace);
        let _memo = Memo::start();
        index_text(&trace, &values);
        assert!(holders(&trace, "nowhere99zz1").is_some_and(|h| h.is_empty()), "an indexed value no body holds");
        assert_eq!(all(&trace), every_body);
        let n = trace.exchanges.len() + 1;
        assert!(every_body[2].is_some() && every_body[2 * 3 * n + 5].is_none(), "the cases are real: one found, one not: {every_body:?}");
        assert!(every_body[4 * 3 * n + 5].as_ref().is_some_and(|o| o.wrap.is_some()), "a value held inside a longer one: {every_body:?}");
    }

    /// A memo started while another lives shares it, and its end leaves the outer one's readings: a graph build inside
    /// a learn doesn't make the rest of the learn read every answer again.
    #[test]
    fn a_memo_inside_a_memo_leaves_the_outer_ones_readings() {
        let trace = Trace { exchanges: vec![exchange("GET", "https://shop.example/api", &[], None, r#"{"id":"idValue12345"}"#)], inputs: vec![] };
        let outer = Memo::start();
        index_text(&trace, &["idValue12345"]);
        {
            let _inner = Memo::start();
            assert!(holders(&trace, "idValue12345").is_some());
        }
        assert!(holders(&trace, "idValue12345").is_some(), "the inner memo's end kept the outer's");
        drop(outer);
        assert!(holders(&trace, "idValue12345").is_none(), "the outer memo's end forgets");
    }

    /// A request that sends the walked page's own address reports the page: what it sends back (the page's address, its
    /// title, the search it shows) is what the page says to anyone, never the session, while a token an answer handed
    /// over and an API call sent back still is.
    #[test]
    fn what_a_request_reporting_the_page_sends_back_is_not_the_session() {
        let title = "Find tickets for lamps at Shop.example";
        let mut page = exchange("GET", "https://www.shop.example/search?q=lamps", &[], None, &format!(r#"<html><head><title>{title}</title><link rel="canonical" href="https://www.shop.example/search?q=lamps"><meta property="og:site" content="https://www.shop.example"><meta name="host" content="www.shop.example"></head><body data-token="hnd0ver77Kq2">x</body></html>"#));
        page.response_mime = "text/html".into();
        page.resource_type = Some("Document".into());
        let beacon = exchange("GET", &format!("https://metrics.example/hit?dl={}&dt={}", "https%3A%2F%2Fwww.shop.example%2Fsearch%3Fq%3Dlamps", title.replace(' ', "%20")), &[], None, "{}");
        let api = exchange("GET", "https://www.shop.example/api/cart", &[("x-token", "hnd0ver77Kq2"), ("Referer", "https://www.shop.example/search?q=lamps"), ("Origin", "https://www.shop.example")], None, "{}");
        let consent = exchange("POST", "https://consent.example/check", &[], Some(r#"{"site":"https://www.shop.example","host":"www.shop.example"}"#), "{}");
        let trace = Trace { exchanges: vec![page, beacon, api, consent], inputs: vec![crate::trace::Input::new("q", "lamps")] };
        assert!(trace.exchanges[0].is_main_document(), "the walked page");
        let held = session_values(&trace);
        assert!(held.iter().any(|h| h == "hnd0ver77Kq2"), "a handed-over token an API call sent back: {held:?}");
        for said in ["https://www.shop.example/search?q=lamps", "https://www.shop.example", "www.shop.example", title] {
            assert!(!held.iter().any(|h| h == said), "{said} is the page's, not the session's: {held:?}");
        }
    }

    /// What the walked page's own address says in plain text (the search typed into it, a word of its path, its
    /// filters) is what the caller asked for and what the page shows anyone, never the session, whichever request sends
    /// it back: the site's own search call, an event's body. Read as the session, it was masked out of every answer:
    /// "Search results for {session}" on Carousell, a WordPress.com search's words, a TARIC path (UNB-208 step 8). A
    /// token the address carries (as after a redirect to `?sid=...`) is still the session's.
    #[test]
    fn what_the_pages_own_address_says_in_plain_text_is_not_the_session() {
        let address = "https://www.shop.example/search/desk%20lamp?price_end=400&sort_by=3&sid=Zq9xK2mT7pLw";
        let mut page = exchange("GET", address, &[], None, r#"<html><head><title>desk lamp - View all desk lamp ads</title></head><body data-sid="Zq9xK2mT7pLw">Search results for "desk lamp"</body></html>"#);
        page.response_mime = "text/html".into();
        page.resource_type = Some("Document".into());
        let search = exchange("GET", "https://www.shop.example/ds/query-expansion?country_id=1880251&keyword=desk%20lamp", &[], None, "{}");
        let event = exchange("POST", "https://events.shop.example/event", &[], Some(r#"{"screen":"/search/desk lamp","query":"desk lamp"}"#), "{}");
        let api = exchange("GET", "https://www.shop.example/api/cart?sid=Zq9xK2mT7pLw", &[], None, "{}");
        let trace = Trace { exchanges: vec![page, search, event, api], inputs: vec![] };
        let held = session_values(&trace);
        assert!(held.iter().any(|h| h == "Zq9xK2mT7pLw"), "a token in the address, sent back, is the session's: {held:?}");
        for said in ["desk lamp", "/search/desk lamp"] {
            assert!(!held.iter().any(|h| h == said), "{said:?} is what the page's address says, not the session: {held:?}");
        }
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

    /// The fast reading is the old one, value for value and in order, on walks that find a value each way: the reading
    /// that makes a field `Derived` (a JSON answer's token sent on as a header, a header's value, a cookie set and sent),
    /// the whole-word scan of answers' headers and the first `ANSWER_SCAN_MOST` bytes of their bodies (a script's
    /// token, and one past the bound that stays out), a value inside a longer one (`Bearer <token>` gives both), and
    /// values too short or a plain word, which stay out. Asked twice, and once inside another memo, it reads the same.
    #[test]
    fn the_session_read_once_is_the_session_read_as_before() {
        let (access, refresh, tok, word) = ("acc3ssTokenQ7w9e2r4t6y8", "r3freshTokenZ1x3c5v7b9", "scr1ptTokenK8m2n4p6q8", "Flight");
        let mut login = exchange("POST", "https://shop.example/api/login", &[], Some(r#"{"user":"ada"}"#), &format!(r#"{{"access":"{access}","refresh":"{refresh}","mode":"{word}","n":"abc"}}"#));
        login.response_headers.push(("x-session-handle".into(), "hdrHandle5521zz".into()));
        login.response_headers.push(("set-cookie".into(), "sid=c00kieVal88; Path=/".into()));
        let mut script = exchange("GET", "https://shop.example/static/user.js", &[], None, &format!("window.__u = {{ t: \"{tok}\" }};"));
        script.response_mime = "application/javascript".into();
        script.resource_type = Some("Script".into());
        let far = "farTokenBeyondTheBound99";
        let mut big = exchange("GET", "https://shop.example/static/big.js", &[], None, &format!("{}{far}", " ".repeat(ANSWER_SCAN_MOST)));
        big.response_mime = "application/javascript".into();
        big.resource_type = Some("Script".into());
        let bearer = format!("Bearer {access}");
        let walks = [
            Trace {
                exchanges: vec![
                    login,
                    script,
                    big,
                    exchange("GET", "https://shop.example/api/me?h=hdrHandle5521zz&m=Flight&n=abc", &[("Authorization", &bearer), ("Cookie", "sid=c00kieVal88")], None, "{}"),
                    exchange("POST", "https://shop.example/api/refresh", &[("Content-Type", "application/json")], Some(&format!(r#"{{"r":"{refresh}","t":"{tok}","f":"{far}","q":"typed words here"}}"#)), "{}"),
                ],
                inputs: vec![crate::trace::Input::new("q", "typed words here")],
            },
            // Nothing found: a walk whose requests send only what no answer gave.
            Trace { exchanges: vec![exchange("GET", "https://shop.example/api/a?x=nowhereAtAll123", &[], None, "{}")], inputs: Vec::new() },
        ];
        for walk in &walks {
            let before = session_values_before(walk);
            assert_eq!(session_values(walk), before);
            assert_eq!(session_values(walk), before, "asked again: the same reading");
            let _outer = Memo::start();
            assert_eq!(session_values(walk), before, "inside a memo held by another reading");
        }
        let held = session_values(&walks[0]);
        for v in [access, refresh, tok, "hdrHandle5521zz", "c00kieVal88", bearer.as_str()] {
            assert!(held.iter().any(|h| h == v), "{v} held: {held:?}");
        }
        for v in [far, word, "abc", "typed words here"] {
            assert!(!held.iter().any(|h| h == v), "{v} stays out: {held:?}");
        }
    }

    /// A walk of 300 answers whose requests send 300 values no answer gave (the case that costs most: each is looked for
    /// in every earlier answer, and found in none) reads each answer's values once, not once per value: the old reading
    /// parses tens of thousands of bodies where this one parses at most one per answer.
    #[test]
    fn the_session_of_a_long_walk_parses_each_answer_once() {
        let exchanges: Vec<Exchange> = (0..300)
            .map(|i| exchange("GET", &format!("https://shop.example/api/item?v=sent{i:04}Value"), &[], None, &format!(r#"{{"id":"answer{i:04}Value","list":[1,2,3]}}"#)))
            .collect();
        let walk = Trace { exchanges, inputs: Vec::new() };
        let at = answer_reads();
        let before = session_values_before(&walk);
        let old = answer_reads() - at;
        let at = answer_reads();
        assert_eq!(session_values(&walk), before);
        let new = answer_reads() - at;
        assert!(new <= walk.exchanges.len(), "{new} reads for {} answers", walk.exchanges.len());
        assert!(old >= 40 * new.max(1), "the old reading parsed {old} bodies, this one {new}");
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

    /// A gateway answers each operation by naming it back (`"api": "<the operation the request named>"`). The next call
    /// to the gateway sends that name in its own address, but the answer that said it back is no source of it: a later
    /// call takes it from where the request did, so an answer that is refused leaves it standing. What the answer
    /// itself gave (a token the request never sent) is still found there.
    #[test]
    fn an_answer_that_says_back_what_its_request_sent_is_no_source_of_it() {
        let mut gateway = ex(r#"{"api":"mtop.shop.Recommend.list","v":"1.0","ret":["SUCCESS"],"data":{"next":"cursor_7f3a9c21e4"}}"#, &[]);
        gateway.url = "https://api.shop.example/h5/mtop.shop.recommend.list/1.0/?api=mtop.shop.Recommend.list&v=1.0".parse().unwrap();
        let t = trace(vec![gateway, ex("{}", &[])]);
        assert_eq!(find_origin(&t, 1, "mtop.shop.recommend.list"), None, "the path's own word, said back");
        assert_eq!(find_origin(&t, 1, "mtop.shop.Recommend.list"), None, "the query's own value, said back");
        assert_eq!(find_origin(&t, 1, "cursor_7f3a9c21e4").map(|o| o.at), Some(At::Json { pointer: "/data/next".into() }), "what it gave");
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

    /// A value is never found as the head of a longer run of digits or letters: a call's clock reading in milliseconds
    /// begins with the clock in seconds that an earlier answer stamped in a header, and that is two readings taken in
    /// the same second, not the answer's value with digits stuck on. Text that stands apart still wraps.
    #[test]
    fn a_wrap_never_splits_a_run_of_digits() {
        let t = trace(vec![ex("", &[("x-saved-at", "1794995285")])]);
        assert_eq!(find_origin(&t, 1, "1794995285684"), None, "a clock in milliseconds is not one in seconds wrapped");
        assert_eq!(find_origin(&t, 1, "9991794995285"), None, "nor with digits before it");
        assert_eq!(find_origin(&t, 1, "at:1794995285").unwrap().wrap, Some(("at:".into(), String::new())), "text that stands apart wraps");
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
