//! Every served request of a route as a sighting, by shape: the route's evidence, kept beside it so that what a call
//! met can be read back from the files (`docs/REBUILD.md` §5, "a sighting as shapes"). A warm call, and a confirming
//! browse with the route called beside it, each add a line to `sightings/<route>.jsonl` in the node's home: what was
//! asked, what the browser's walk sent for the route's call, how each answer held its records, which of the walk's
//! calls the route was held against and why, and how long after the site's last page load the call was made, and for
//! which value. Never a value: each one is its shape (`Shape::of`) and a mark, a digest under a key only this node
//! holds, so that two sightings can be read as the same value or another without either being kept. The node's own:
//! the folder is private, and a route that is shared carries none of it. Bounded: the latest [`KEPT`] lines a route.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use unbrowse_learn::trace::{Exchange, Trace};
use unbrowse_learn::route::body::{Chars, Shape};

/// How many sightings a route keeps: the latest.
pub const KEPT: usize = 64;

/// One served request of a route.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sighting {
    pub at_ms: u64,
    pub how: How,
    /// The caller's values, by input name.
    pub asked: Vec<Seen>,
    /// The browser's walk's own request of the route's call, each part (a confirming browse only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sent: Vec<Seen>,
    /// How the route's answer held its records; None where its call failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Held>,
    /// How the browser's walk's answer to the call held its records (a confirming browse only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walked: Option<Held>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compared: Option<Compared>,
    pub ok: bool,
    pub ms: u64,
    pub rung: u8,
    /// The site's last page load in a browser of this node before the call, where there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since_load: Option<SinceLoad>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum How {
    /// The route called for the agent's ask.
    Call,
    /// The agent's ask served by the browser, the route called beside it and compared.
    Confirm,
}

/// One value, by where it was and what it looked like: never what it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    /// `query:<key>`, `header:<name>`, `cookie:<name>`, `input:<name>`.
    pub at: String,
    pub len: usize,
    pub of: Chars,
    /// The value's mark: the same value has the same mark on every sighting of this node, and no other does.
    pub mark: String,
}

/// How an answer held its records.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Held {
    pub bytes: usize,
    /// Where the route's records were seen (`Heard::records_at`), and how many this answer holds there; None where
    /// the route has no such place yet, or the answer lacks it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub records_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub records: Option<usize>,
    /// How many of its own lines the answer said, as compared (`said_lines`).
    pub lines: usize,
    /// Its lines by mark (`marks_of`), and what it says, its values by mark (`said_of`), never their text: what a later
    /// call is held against to say whether it is this answer again (`confirm::by_its_call`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub marks: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub said: Vec<String>,
    /// Whether the answer said back a value it was asked, on a line of its own (a warm call only; None elsewhere). A
    /// route whose first answer never said its value (a company's statement, figures and no name) answers about a thing
    /// without naming it, and its next answers are not held to saying theirs (`confirm::by_its_call`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub named: Option<bool>,
    /// Its records, each by one mark (`rows_of`): the records at its own records place, what a frame's per-load noise
    /// (a token, a time, a rotating strip beside them) never reaches. Empty for an answer that holds no list of records.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<String>,
}

/// What a confirming browse held the route's answer against.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Compared {
    /// The walk's request it was held against, and how many of the walk's requests were the route's call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<usize>,
    pub calls: usize,
    /// How many query keys that request sent which the route leaves empty: why it was chosen over the others.
    pub left_out: usize,
    /// Lines each answer said, and how many both said.
    pub ours: usize,
    pub theirs: usize,
    pub shared: usize,
    /// The verdict, as the log says it.
    pub verdict: String,
}

/// The site's last page load before the call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SinceLoad {
    pub ago_ms: u64,
    /// Whether that page was loaded for the value this call asks: each value asked was one the page's address held.
    pub same_value: bool,
}

/// The node's key for marks, made once and kept private in the sightings folder.
fn key() -> Vec<u8> {
    static KEY: Mutex<Option<Vec<u8>>> = Mutex::new(None);
    let mut held = KEY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(k) = held.as_ref() {
        return k.clone();
    }
    let path = folder().join("key");
    let k = std::fs::read(&path).ok().filter(|k| k.len() == 32).unwrap_or_else(|| {
        let mut k = vec![0u8; 32];
        let _ = getrandom::fill(&mut k);
        let _ = unbrowse_files::private::dir_at(&folder());
        let _ = unbrowse_files::private::write(&path, &k);
        k
    });
    *held = Some(k.clone());
    k
}

/// A value's mark: the first 12 hex of SHA-256 over the node's key and the value.
pub fn mark(value: &str) -> String {
    mark_with(&key(), value)
}

fn mark_with(key: &[u8], value: &str) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(key);
    h.update([0u8]);
    h.update(value.as_bytes());
    hex::encode(&h.finalize()[..6])
}

pub fn seen(at: String, value: &str) -> Seen {
    let Shape { len, of } = Shape::of(value);
    Seen { at, len, of, mark: mark(value) }
}

/// Each part of a request: its query values, its headers but the cookie header, and its cookies by name.
pub fn parts(e: &Exchange) -> Vec<Seen> {
    let mut out: Vec<Seen> = e.url.query_pairs().map(|(k, v)| seen(format!("query:{k}"), &v)).collect();
    for (name, value) in &e.request_headers {
        let name = name.to_ascii_lowercase();
        if name != "cookie" && !name.starts_with(':') {
            out.push(seen(format!("header:{name}"), value));
        }
    }
    out.extend(e.cookies().into_iter().map(|(k, v)| seen(format!("cookie:{k}"), &v)));
    out
}

/// The caller's values, by input name, secrets left out.
pub fn asked(route: &crate::store::Route, given: &HashMap<String, String>) -> Vec<Seen> {
    let mut out: Vec<Seen> = route.inputs.iter().filter(|i| !i.secret).filter_map(|i| given.get(&i.name).or(i.default.as_ref()).map(|v| seen(format!("input:{}", i.name), v))).collect();
    out.sort_by(|a, b| a.at.cmp(&b.at));
    out
}

/// How `data`, an answer of `route`, held its records.
pub fn held(route: &crate::store::Route, data: &serde_json::Value) -> Held {
    let place = route.heard.records_at.clone();
    let records = place.as_deref().and_then(|p| super::confirm::count_at(data, p));
    Held { bytes: data.to_string().len(), records_at: place, records, lines: super::confirm::lines_of(data), marks: marks_of(data), said: said_of(data), named: None, rows: rows_of(data).unwrap_or_default() }
}

/// An answer's own lines (`confirm::lines_said`) by mark, sorted, the lowest [`SAID`].
pub fn marks_of(data: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = super::confirm::lines_said(data).iter().map(|l| mark(l)).collect();
    out.sort();
    out.dedup();
    out.truncate(SAID);
    out
}

/// How many of an answer's values a sighting keeps by mark: the lowest marks, so two answers' kept marks are drawn from
/// the same part of the marks' range and compare as their wholes do.
pub const SAID: usize = 512;

/// What an answer says, by mark: every text and number it holds (read as its records, `confirm::as_records`), a reading
/// of the clock aside (a time it was made, which moves whatever was asked), sorted, the lowest [`SAID`]. Its values,
/// not only its lines: a statement of figures says one line of words and hundreds of numbers, a package's downloads
/// by day one name and a count a day, and two such answers for two values differ in their numbers.
pub fn said_of(data: &serde_json::Value) -> Vec<String> {
    fn walk(v: &serde_json::Value, depth: usize, out: &mut Vec<String>) {
        match v {
            _ if depth > 32 => {}
            serde_json::Value::String(s) if !s.trim().is_empty() && !a_clock_reading(s) => out.push(mark(s.trim())),
            serde_json::Value::Number(n) if !n.as_f64().is_some_and(clock_number) => out.push(mark(&n.to_string())),
            serde_json::Value::Array(items) => items.iter().for_each(|x| walk(x, depth + 1, out)),
            serde_json::Value::Object(o) => o.values().for_each(|x| walk(x, depth + 1, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(&super::confirm::as_records(data), 0, &mut out);
    out.sort();
    out.dedup();
    out.truncate(SAID);
    out
}

/// An answer's records, each by one mark: the records at its own records place, the list of objects holding the most of
/// them (two or more), read as its records (`confirm::as_records`). A record's mark is over its values, a field every
/// record repeats left out (a list's own stamp, the same on each) and a reading of the clock left out (an id made of
/// the time, a fetch's moment): what one record says that another does not. None where the answer holds no such list.
pub fn rows_of(data: &serde_json::Value) -> Option<Vec<String>> {
    fn lists<'a>(v: &'a serde_json::Value, depth: usize, best: &mut Option<&'a Vec<serde_json::Value>>) {
        match v {
            _ if depth > 32 => {}
            serde_json::Value::Array(items) => {
                let n = items.iter().filter(|x| x.is_object()).count();
                if n >= 2 && best.is_none_or(|b| n > b.iter().filter(|x| x.is_object()).count()) {
                    *best = Some(items);
                }
                items.iter().for_each(|x| lists(x, depth + 1, best));
            }
            serde_json::Value::Object(o) => o.values().for_each(|x| lists(x, depth + 1, best)),
            _ => {}
        }
    }
    let read = super::confirm::as_records(data);
    let mut best = None;
    lists(&read, 0, &mut best);
    let records: Vec<&serde_json::Map<String, serde_json::Value>> = best?.iter().filter_map(serde_json::Value::as_object).collect();
    let mut out = row_marks(&records);
    out.sort();
    Some(out)
}

/// Each of `records`' marks, in their order, as [`rows_of`] marks them: over its values, a field every record repeats
/// and a reading of the clock left out.
pub fn row_marks(records: &[&serde_json::Map<String, serde_json::Value>]) -> Vec<String> {
    let repeated = |k: &str, v: &serde_json::Value| records.iter().all(|r| r.get(k) == Some(v));
    records
        .iter()
        .map(|r| {
            let mut values: Vec<String> = Vec::new();
            for (k, v) in r.iter().filter(|(k, v)| !repeated(k, v)) {
                let mut leaves = Vec::new();
                said_into(v, 0, &mut leaves);
                values.extend(leaves.into_iter().map(|l| format!("{k}={l}")));
            }
            values.sort();
            mark(&values.join("\u{1f}"))
        })
        .collect()
}

/// The texts and numbers `v` holds, trimmed, a reading of the clock aside.
fn said_into(v: &serde_json::Value, depth: usize, out: &mut Vec<String>) {
    match v {
        _ if depth > 32 => {}
        serde_json::Value::String(s) if !s.trim().is_empty() && !a_clock_reading(s) => out.push(s.trim().to_string()),
        serde_json::Value::Number(n) if !n.as_f64().is_some_and(clock_number) => out.push(n.to_string()),
        serde_json::Value::Array(items) => items.iter().for_each(|x| said_into(x, depth + 1, out)),
        serde_json::Value::Object(o) => o.values().for_each(|x| said_into(x, depth + 1, out)),
        _ => {}
    }
}

/// A number that reads as the clock now, in seconds or milliseconds since 1970, within two years of it.
fn clock_number(f: f64) -> bool {
    let now = now_ms() as f64;
    let year = 365.0 * 24.0 * 3600.0 * 1000.0;
    (f - now).abs() < 2.0 * year || (f * 1000.0 - now).abs() < 2.0 * year
}

/// A text that reads as a moment, a date with a time of day (`2026-11-16T09:28:41Z`), or as the clock's number.
fn a_clock_reading(s: &str) -> bool {
    let t = s.trim();
    let b = t.as_bytes();
    let dated = b.len() >= 16 && b[4] == b'-' && b[7] == b'-' && (b[10] == b'T' || b[10] == b' ') && b[13] == b':' && b[..4].iter().all(u8::is_ascii_digit);
    dated || t.parse::<f64>().is_ok_and(clock_number)
}

/// What the answer the route's first sighting held says (`said_of`): its latest call that answered for the values it was
/// learned on. None where no such call was kept.
pub fn first_answer(route: &crate::store::Route) -> Option<Held> {
    first_answer_in(&folder(), route)
}

fn first_answer_in(dir: &std::path::Path, route: &crate::store::Route) -> Option<Held> {
    let own = asked(route, &HashMap::new());
    let path = dir.join(format!("{}.jsonl", route.id.replace(['/', '\\', '.'], "_")));
    let text = std::fs::read_to_string(path).ok()?;
    text.lines().rev().filter_map(|l| serde_json::from_str::<Sighting>(l).ok()).find(|s| s.ok && s.asked == own && s.answer.as_ref().is_some_and(|a| !a.said.is_empty())).and_then(|s| s.answer)
}

/// Each site's last page load in a browser of this node: when, and the marks of the values its address held.
static LOADS: Mutex<Vec<(String, u64, Vec<String>)>> = Mutex::new(Vec::new());

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn site_of(u: &url::Url) -> String {
    u.host_str().unwrap_or_default().trim_start_matches("www.").to_string()
}

/// A page of `url` was loaded in the browser now: the values its address held are its path's pieces and its query's
/// values, by mark.
pub fn page_loaded(url: &str) {
    let Ok(u) = url::Url::parse(url) else { return };
    let mut values: Vec<String> = u.query_pairs().map(|(_, v)| mark(&v)).collect();
    values.extend(u.path_segments().into_iter().flatten().filter(|p| !p.is_empty()).map(|p| mark(&percent_encoding::percent_decode_str(p).decode_utf8_lossy())));
    let mut loads = LOADS.lock().unwrap_or_else(|e| e.into_inner());
    let site = site_of(&u);
    loads.retain(|(s, _, _)| *s != site);
    loads.push((site, now_ms(), values));
}

/// How long before now the site of `root` was last loaded, and whether for the values `asked` marks.
pub fn since_load(root: &str, asked: &[Seen]) -> Option<SinceLoad> {
    let site = url::Url::parse(root).ok().map(|u| site_of(&u))?;
    let loads = LOADS.lock().unwrap_or_else(|e| e.into_inner());
    let (_, at, values) = loads.iter().find(|(s, _, _)| *s == site)?;
    let same_value = !asked.is_empty() && asked.iter().all(|a| values.contains(&a.mark));
    Some(SinceLoad { ago_ms: now_ms().saturating_sub(*at), same_value })
}

fn folder() -> std::path::PathBuf {
    crate::store::home().join("sightings")
}

/// Adds `s` to the route's sightings, keeping the latest [`KEPT`]. A line that can't be written costs the call nothing.
pub fn keep(route: &str, s: &Sighting) {
    keep_in(&folder(), route, s);
}

fn keep_in(dir: &std::path::Path, route: &str, s: &Sighting) {
    let _ = unbrowse_files::private::dir_at(dir);
    let path = dir.join(format!("{}.jsonl", route.replace(['/', '\\', '.'], "_")));
    let Ok(line) = serde_json::to_string(s) else { return };
    let mut lines: Vec<String> = std::fs::read_to_string(&path).map(|t| t.lines().map(str::to_string).collect()).unwrap_or_default();
    lines.push(line);
    let from = lines.len().saturating_sub(KEPT);
    let _ = unbrowse_files::private::write(&path, format!("{}\n", lines[from..].join("\n")).as_bytes());
}

/// The route's sightings in `dir`, oldest first.
#[cfg(test)]
fn of_route_in(dir: &std::path::Path, route: &str) -> Vec<Sighting> {
    let path = dir.join(format!("{}.jsonl", route.replace(['/', '\\', '.'], "_")));
    std::fs::read_to_string(path).map(|t| t.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()).unwrap_or_default()
}

/// A warm call of `route` for `given`, answered `data` (None: it failed).
pub fn called(route: &crate::store::Route, given: &HashMap<String, String>, data: Option<&serde_json::Value>, ok: bool, ms: u64, rung: u8) {
    let asked = asked(route, given);
    let since_load = since_load(&route.root, &asked);
    let values: Vec<String> = route.inputs.iter().filter(|i| !i.secret).filter_map(|i| given.get(&i.name).or(i.default.as_ref())).map(|v| v.trim().to_lowercase()).filter(|v| v.chars().count() >= 2).collect();
    let answer = data.map(|d| Held { named: Some(names_its_value(d, &values)), ..held(route, d) });
    let s = Sighting { at_ms: now_ms(), how: How::Call, asked, sent: Vec::new(), answer, walked: None, compared: None, ok, ms, rung, since_load };
    keep(&route.id, &s);
}

/// Whether an answer names one of the values it was asked (`values`, lowercased): a line of its text holds one, or one of
/// its own values is one, whole, in any case: a thing named by a short id or a number (`"sku": "7731"`) is named, though
/// no line of text holds it.
fn names_its_value(data: &serde_json::Value, values: &[String]) -> bool {
    if super::confirm::lines_said(data).iter().any(|l| values.iter().any(|v| l.contains(v.as_str()))) {
        return true;
    }
    fn holds(v: &serde_json::Value, values: &[String], depth: usize) -> bool {
        match v {
            _ if depth > 32 => false,
            serde_json::Value::String(s) => values.iter().any(|x| s.trim().to_lowercase() == *x),
            serde_json::Value::Number(n) => values.iter().any(|x| n.to_string() == *x),
            serde_json::Value::Array(items) => items.iter().any(|i| holds(i, values, depth + 1)),
            serde_json::Value::Object(o) => o.values().any(|i| holds(i, values, depth + 1)),
            _ => false,
        }
    }
    holds(&super::confirm::as_records(data), values, 0)
}

/// The browser's walk `second` served the ask; `route` was called beside it and answered `answer`.
pub fn confirmed(route: &crate::store::Route, given: &HashMap<String, String>, second: &Trace, call: Option<usize>, walked: Option<&serde_json::Value>, answer: Option<&serde_json::Value>, compared: Compared) {
    let asked = asked(route, given);
    let sent = call.and_then(|j| second.exchanges.get(j)).map(parts).unwrap_or_default();
    let s = Sighting { at_ms: now_ms(), how: How::Confirm, asked, sent, answer: answer.map(|d| held(route, d)), walked: walked.map(|d| held(route, d)), ok: answer.is_some(), ms: 0, rung: 5, since_load: Some(SinceLoad { ago_ms: 0, same_value: true }), compared: Some(compared) };
    keep(&route.id, &s);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mark says whether two sightings sent one value, and never what it was: the same value marks alike, another
    /// value otherwise, and a mark holds no piece of the value.
    #[test]
    fn a_mark_tells_the_same_value_without_keeping_it() {
        let key = [7u8; 32];
        let (a, b) = (mark_with(&key, "4f9c2b7d0e1a83f6c5d2"), mark_with(&key, "4f9c2b7d0e1a83f6c5d3"));
        assert_eq!(a, mark_with(&key, "4f9c2b7d0e1a83f6c5d2"));
        assert_ne!(a, b);
        assert_eq!(a.len(), 12);
        assert!(!a.contains("4f9c2b"));
        assert_ne!(a, mark_with(&[8u8; 32], "4f9c2b7d0e1a83f6c5d2"), "another node's key marks otherwise");
    }

    /// An answer that names its thing only by a short id or a number (no line of text holds it) still names it: a lookup
    /// of item 7731 answered `{"item": {"sku": "7731", ...}}` said its value, and was read as saying none, so the next
    /// item's own call could never stand.
    #[test]
    fn an_answer_that_names_its_thing_by_a_short_id_names_it() {
        let item = serde_json::json!({ "item": { "sku": "7731", "name": "brass desk lamp", "price": 40 } });
        assert!(names_its_value(&item, &["7731".to_string()]));
        assert!(names_its_value(&serde_json::json!({ "count": 7731 }), &["7731".to_string()]), "a number");
        assert!(!names_its_value(&item, &["8842".to_string()]));
        assert!(names_its_value(&serde_json::json!({ "code": "Rt5Wn8Kd" }), &["rt5wn8kd".to_string()]), "in any case");
        assert!(names_its_value(&serde_json::json!({ "title": "The brass desk lamp guide" }), &["brass desk lamp".to_string()]), "a line holding it, as before");
    }

    /// A request's parts are read as places, with the cookie header read as its cookies, by name.
    #[test]
    fn a_requests_parts_are_its_query_its_headers_and_its_cookies() {
        let e = Exchange {
            method: "GET".into(),
            url: url::Url::parse("https://shop.example/find?q=lamps&page=2").unwrap(),
            request_headers: vec![("Cookie".into(), "sid=abc123; theme=dark".into()), ("x-trace".into(), "0a1b2c3d".into())],
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: None,
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let at: Vec<String> = parts(&e).into_iter().map(|s| s.at).collect();
        assert_eq!(at, ["query:q", "query:page", "header:x-trace", "cookie:sid", "cookie:theme"]);
        let x = parts(&e).into_iter().find(|s| s.at == "header:x-trace").unwrap();
        assert_eq!((x.len, x.of), (8, Chars::Hex));
    }

    /// The site's last page load is read for the value asked: a page loaded for that value is the same value, a page
    /// for another is not.
    #[test]
    fn a_call_says_how_long_after_a_page_load_and_for_which_value() {
        page_loaded("https://www.inn.example/results?ss=Lisbon");
        let lisbon = vec![seen("input:ss".into(), "Lisbon")];
        let tokyo = vec![seen("input:ss".into(), "Tokyo")];
        assert!(since_load("https://www.inn.example/results?ss={ss}", &lisbon).is_some_and(|l| l.same_value));
        assert!(since_load("https://inn.example/results", &tokyo).is_some_and(|l| !l.same_value));
        assert!(since_load("https://other.example/", &tokyo).is_none());
    }
    /// A route keeps its latest sightings and no more, oldest first.
    #[test]
    fn a_route_keeps_its_latest_sightings() {
        let dir = std::env::temp_dir().join(format!("sighted-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for n in 0..(KEPT as u64 + 5) {
            let s = Sighting { at_ms: n, how: How::Call, asked: Vec::new(), sent: Vec::new(), answer: None, walked: None, compared: None, ok: true, ms: n, rung: 0, since_load: None };
            keep_in(&dir, "r1", &s);
        }
        let kept = of_route_in(&dir, "r1");
        assert_eq!(kept.len(), KEPT);
        assert_eq!((kept[0].at_ms, kept[KEPT - 1].at_ms), (5, KEPT as u64 + 4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A confirming browse keeps what it saw: the browser's walk's request by its parts (never their values), whether
    /// the route's call answered, and how each answer held its records; a call that failed is kept as failed.
    #[test]
    fn a_confirming_browse_is_kept_with_the_walks_request_and_the_verdict() {
        crate::store::scratch_home("sighted-confirmed");
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp", "optional": false }] }]
        }))
        .unwrap();
        let route = crate::store::Route::from_graph("sighted-confirmed-route".into(), "search".into(), "https://shop.example/".into(), graph).unwrap();
        let walk = Trace {
            exchanges: vec![Exchange {
                method: "GET".into(),
                url: url::Url::parse("https://shop.example/api/search?q=kettle").unwrap(),
                request_headers: vec![("x-app".into(), "web".into())],
                request_body: None,
                status: 200,
                response_headers: Vec::new(),
                response_body: Some("{}".into()),
                response_mime: "application/json".into(),
                resource_type: Some("XHR".into()),
                main_frame: Some(true),
            }],
            inputs: Vec::new(),
        };
        let given = HashMap::from([("q".to_string(), "kettle".to_string())]);
        let compared = Compared { call: Some(0), calls: 1, left_out: 0, ours: 3, theirs: 3, shared: 3, verdict: "agreed".into() };
        let answer = serde_json::json!({ "results": [{ "title": "Brass kettle one" }, { "title": "Glass kettle two" }] });
        confirmed(&route, &given, &walk, Some(0), Some(&answer), Some(&answer), compared.clone());
        confirmed(&route, &given, &walk, None, None, None, Compared { call: None, verdict: "failed: 403".into(), ..compared.clone() });
        let kept = of_route_in(&folder(), &route.id);
        assert_eq!(kept.len(), 2);
        let (agreed, failed) = (&kept[0], &kept[1]);
        assert_eq!(agreed.how, How::Confirm);
        assert!(agreed.ok && agreed.answer.is_some() && agreed.walked.is_some());
        assert_eq!(agreed.sent.iter().map(|s| s.at.as_str()).collect::<Vec<_>>(), ["query:q", "header:x-app"], "the walk's request, by its parts");
        assert_eq!(agreed.asked.iter().map(|s| s.at.as_str()).collect::<Vec<_>>(), ["input:q"]);
        assert_eq!(agreed.compared.as_ref().map(|c| c.verdict.as_str()), Some("agreed"));
        assert!(!serde_json::to_string(agreed).unwrap().contains("kettle"), "no value is kept");
        assert!(!failed.ok && failed.answer.is_none() && failed.walked.is_none() && failed.sent.is_empty());
    }
}
