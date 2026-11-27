//! Whether what a site sent back is an answer. A refusal, an error the site said in its own words, a challenge, a
//! detour to a sign-in, or nothing at all is never a route's answer: a route is never learned from one, and a call
//! that gets one back is a failed call, said as the site said it. Each rule is a property of the response and the
//! walk that recorded it; none names a site.

use serde_json::Value;

use crate::graph::Step;
use crate::trace::Exchange;

/// What the site said, in its own words, cut short: the message of an error it answered with, a page's title, or the
/// start of its body.
pub fn site_said(body: &str) -> String {
    let body = body.trim();
    if let Some(v) = crate::trace::body_json(body) {
        if let Some(m) = message_in(&v) {
            return cut(&m, 300);
        }
        return cut(&v.to_string(), 300);
    }
    if crate::page::is_html(body) {
        let page = crate::page::read(body, &url::Url::parse("https://page.invalid/").expect("a static address"));
        let title = page["title"].as_str().unwrap_or_default();
        // A page starts with its menus: its headings say what it is, and they go first, so what it said survives the cut.
        let headings = crate::page::headings(body).join(" ");
        let text = page["text"].as_str().unwrap_or_default();
        let text = if headings.is_empty() { text.to_string() } else { format!("{headings} {text}") };
        let said = match (title.is_empty(), text.is_empty()) {
            (false, false) if !text.starts_with(title) => format!("{title}: {text}"),
            (false, _) if text.is_empty() => title.to_string(),
            _ => text.to_string(),
        };
        return cut(&said, 300);
    }
    cut(body, 300)
}

fn cut(s: &str, n: usize) -> String {
    let s: String = s.chars().filter(|c| !c.is_control() || *c == '\n').collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        return s;
    }
    format!("{}…", s.chars().take(n).collect::<String>())
}

/// The first message an error answer carries: a string under a key that names one (`message`, `error_message`,
/// `detail`, `reason`), else the error member itself when it is a string.
fn message_in(v: &Value) -> Option<String> {
    fn says(k: &str) -> bool {
        let k = k.to_ascii_lowercase();
        ["message", "msg", "detail", "description", "reason"].iter().any(|w| k.contains(w))
    }
    match v {
        Value::Object(o) => {
            if let Some(m) = o.iter().find(|(k, v)| says(k) && v.as_str().is_some_and(|s| !s.trim().is_empty())).and_then(|(_, v)| v.as_str()) {
                return Some(m.to_string());
            }
            if let Some(m) = o.iter().find(|(k, v)| error_key(k) && v.as_str().is_some_and(|s| !s.trim().is_empty())).and_then(|(_, v)| v.as_str()) {
                return Some(m.to_string());
            }
            o.values().filter(|v| v.is_object() || v.is_array()).find_map(message_in)
        }
        Value::Array(a) => a.iter().find_map(message_in),
        _ => None,
    }
}

/// A member whose name says it holds the request's error: `error`, `errors`, `error_code`, `errorMessage`.
fn error_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    k == "err" || k.starts_with("error")
}

/// Whether a member holds something: not null, false, zero, or empty.
fn holds(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        Value::Bool(true) => true,
    }
}

/// Whether a value is a failure code: a constant in capitals that opens with the word (`FAIL_SYS_TOKEN_EMPTY`,
/// `ERROR_RATE_LIMITED`, `ERR_BAD_REQUEST`), alone or before what it means (`FAIL_SYS_TOKEN_EMPTY::the token is empty`).
/// A sentence that mentions failing, or a record's `failed`, is not a code.
fn failure_code(s: &str) -> bool {
    let code = s.split(|c: char| c == ':' || c.is_whitespace()).next().unwrap_or_default();
    code.len() >= 6
        && code.contains('_')
        && code.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && ["FAIL", "ERR"].iter().any(|w| code.starts_with(w))
}

/// Whether a list is nothing but failure codes: every entry a constant in capitals that opens with the word or closes
/// with it (`GATE7_ERROR::busy` beside `FAIL_SYS_USER_VALIDATE`), and at least one that opens with it. A code that
/// only closes with the word is read as one in such company alone: by itself `NO_ERROR` says the opposite.
fn failure_codes(list: &[Value]) -> bool {
    let code = |s: &str| s.split(|c: char| c == ':' || c.is_whitespace()).next().unwrap_or_default().to_string();
    let constant = |c: &str| c.len() >= 6 && c.contains('_') && c.chars().all(|x| x.is_ascii_uppercase() || x.is_ascii_digit() || x == '_');
    let closes = |c: &str| ["_ERROR", "_ERR", "_FAIL", "_FAILED", "_FAILURE"].iter().any(|w| c.ends_with(w));
    !list.is_empty()
        && list.iter().all(|x| x.as_str().is_some_and(|s| failure_code(s) || (constant(&code(s)) && closes(&code(s)))))
        && list.iter().any(|x| x.as_str().is_some_and(failure_code))
}

/// The failure code an answer says at its top, where it holds no record: a member that is a failure code, or a list of
/// nothing but them (`failure_code`), and no list of things anywhere in it. Small objects beside the code (how big a
/// dialog to show, where to go instead) are not what was asked for. None for an answer with no code, or with records.
pub fn failed_by_code(body: &Value) -> Option<String> {
    fn lists_things(v: &Value, depth: usize) -> bool {
        match v {
            Value::Array(a) => a.iter().any(|x| x.is_object()) || (depth < 4 && a.iter().any(|x| lists_things(x, depth + 1))),
            Value::Object(o) => depth < 4 && o.values().any(|x| lists_things(x, depth + 1)),
            _ => false,
        }
    }
    let code = body.as_object()?.values().find_map(|v| match v {
        Value::String(s) if failure_code(s) => Some(s.clone()),
        Value::Array(a) if failure_codes(a) => a.iter().filter_map(Value::as_str).find(|s| failure_code(s)).map(String::from),
        _ => None,
    })?;
    (!lists_things(body, 0)).then(|| cut(&code, 80))
}

/// The page an answer points to in place of data: an object of a few members, every one a short word or number but
/// one, which is a web address. A call that asked for the site's data and got only this was sent to a page instead
/// (a check to pass, or the site's word that it won't answer); what that page is, is read from the page. None for an
/// answer that carries anything more. Read only against a route's recorded shape (`replay`): a route whose own answer
/// is a link keeps its link.
pub fn pointer_url(body: &Value) -> Option<String> {
    let o = body.as_object()?;
    if o.is_empty() || o.len() > 4 {
        return None;
    }
    let mut url = None;
    for v in o.values() {
        match v {
            Value::String(s) if s.starts_with("http://") || s.starts_with("https://") => {
                if url.replace(s.clone()).is_some() {
                    return None;
                }
            }
            Value::String(s) if s.len() <= 32 => {}
            Value::Number(_) | Value::Bool(_) | Value::Null => {}
            _ => return None,
        }
    }
    url
}

/// The address of the site's check that a failed answer points to: the page the site hands back beside a failure
/// code ([`failed_by_code`]) instead of records — its validate/punish page (Alibaba baxia puts it under `data.url`;
/// others name a top-level `url`/`redirect`). The clearance flow opens this page; once it is passed (by a person, or
/// by the node) the site sets its clearance cookie and the route's own call answers. None when the answer did not
/// fail by a code, or named no address to go to.
pub fn check_url(body: &Value) -> Option<String> {
    failed_by_code(body)?;
    let o = body.as_object()?;
    let in_data = |k: &str| o.get("data").and_then(|d| d.get(k)).and_then(Value::as_str);
    in_data("url")
        .or_else(|| o.get("url").and_then(Value::as_str))
        .or_else(|| in_data("redirect"))
        .map(String::from)
}

/// Whether a member says the request failed: an error member that holds something, an outcome member of the
/// request (`response`, `result`, `outcome`) whose word is a failure, a `status` of `error`, `success`/`ok` set
/// false, or, under any name, a failure code or a list of nothing but them (`failure_code`). A record's own
/// `status: failed` (a job that failed) is the record, not the request failing.
fn says_failed(k: &str, v: &Value) -> bool {
    if error_key(k) {
        return holds(v);
    }
    if v.as_str().is_some_and(failure_code) || v.as_array().is_some_and(|a| failure_codes(a)) {
        return true;
    }
    let k = k.to_ascii_lowercase();
    match v {
        Value::String(s) => {
            let s = s.to_ascii_lowercase();
            (matches!(k.as_str(), "response" | "result" | "outcome") && matches!(s.as_str(), "error" | "fail" | "failed" | "failure"))
                || (k == "status" && s == "error")
        }
        Value::Bool(false) => matches!(k.as_str(), "success" | "ok" | "succeeded"),
        _ => false,
    }
}

/// Whether a member only says how the request went: its message, a code, a type, a flag.
fn about_the_request(k: &str, v: &Value) -> bool {
    let k = k.to_ascii_lowercase();
    !holds(v) || ["message", "msg", "detail", "description", "reason", "code", "status", "type", "warning", "documentation", "doc_url", "url"].iter().any(|w| k.contains(w))
}

/// The answer, when it is the site saying the request failed rather than answering it: at its top, a member says it
/// failed, nothing else in it holds data (no other member is a list or an object with anything in it), and little else
/// is said beside how the request went. An answer with data beside an error (a partial result), or a record that
/// happens to have an error field among its own, is still an answer. Returns what the site said.
pub fn said_failure(body: &Value) -> Option<String> {
    let o = body.as_object()?;
    // A GraphQL answer says how it went in its own shape: errors and no data is a request that failed, whatever its
    // extensions say about how long it took.
    let graphql = o.keys().all(|k| matches!(k.as_str(), "errors" | "data" | "extensions"));
    // Data whose every field came back null is no data either: each field the request asked for failed, and the
    // answer names them only to say so (`{"searchPosts": null}` beside "Access denied").
    // Nor is data that holds only the objects the failed fields hang from: each named by its id and its type, the
    // field asked for null beneath it (`{"search": {"id": "…", "videos": null, "__typename": "Search"}}` beside
    // "Maximum attempts reached"). A list with anything in it, or any other value, is something answered.
    fn bare(d: &Value) -> bool {
        match d {
            Value::Null => true,
            Value::Object(m) => m.iter().all(|(k, v)| bare(v) || (matches!(k.as_str(), "id" | "__typename") && !v.is_object() && !v.is_array())),
            Value::Array(a) => a.is_empty(),
            _ => false,
        }
    }
    let no_data = |d: &Value| d.is_null() || d.as_object().is_some_and(|m| m.values().all(bare));
    if graphql && o.get("errors").is_some_and(holds) && o.get("data").is_none_or(no_data) {
        return Some(message_in(body).map(|m| cut(&m, 300)).unwrap_or_else(|| cut(&body.to_string(), 300)));
    }
    // A failure code at the top and no list of things anywhere: the request failed, whatever small objects ride along
    // (how big a dialog to show, where to go instead). The code is the site's own explicit word.
    if let Some(code) = failed_by_code(body) {
        return Some(message_in(body).map(|m| cut(&m, 300)).unwrap_or(code));
    }
    let failed: Vec<(&String, &Value)> = o.iter().filter(|(k, v)| says_failed(k, v)).collect();
    if failed.is_empty() {
        return None;
    }
    let others = || o.iter().filter(|(k, _)| !failed.iter().any(|(f, _)| f == k));
    // An object that holds nothing but how the request went (a message, a code, the address the site sends the caller
    // to instead) is no data: `{"url": "…/hold"}` beside a failure code is where the site sent the call, not an answer.
    let only_about_the_request = |m: &serde_json::Map<String, Value>| m.iter().all(|(k, v)| !v.is_object() && !v.is_array() && about_the_request(k, v));
    let data = others().any(|(_, v)| v.as_array().is_some_and(|a| !a.is_empty()) || v.as_object().is_some_and(|m| !m.is_empty() && !only_about_the_request(m)));
    let said_besides = others().filter(|(k, v)| !about_the_request(k, v)).count();
    // A failure code is the site's own explicit word: beside it, with no data, the plain values that ride along (the
    // API's name, its version, a trace id) are the envelope every answer of that gateway wears, however many there are.
    let coded = failed.iter().any(|(_, v)| v.as_str().is_some_and(failure_code) || v.as_array().is_some_and(|a| !a.is_empty() && a.iter().all(|x| x.as_str().is_some_and(failure_code))));
    if data || (said_besides > 2 && !coded) {
        return None;
    }
    Some(message_in(body).map(|m| cut(&m, 300)).unwrap_or_else(|| cut(&body.to_string(), 300)))
}

/// Why a recorded exchange can't be a route's answer, read from the exchange alone: the site refused it (4xx, 5xx),
/// its answer says it failed, it is the site's challenge, or a read got no answer back (a `HEAD`, a redirect, an
/// empty body, or `202 Accepted`: the request taken, its answer not given). `write` is whether the call changes
/// state: a write may answer with nothing, with a redirect, or with 202.
pub fn not_an_answer(e: &Exchange, write: bool) -> Option<String> {
    let body = e.response_body.as_deref().unwrap_or_default();
    if e.status >= 400 {
        let said = site_said(body);
        return Some(if said.is_empty() { format!("the site answered {}", e.status) } else { format!("the site answered {}: {said}", e.status) });
    }
    if !write {
        if e.method.eq_ignore_ascii_case("HEAD") {
            return Some("it is a HEAD request, which carries no answer".into());
        }
        if (300..400).contains(&e.status) {
            return Some(format!("the site answered {}, a redirect, not the data", e.status));
        }
        if e.status == 202 {
            return Some("the site answered 202: it took the request but held the answer back".into());
        }
        if body.trim().is_empty() {
            return Some(format!("the site answered {} with nothing", e.status));
        }
    }
    // The answer's JSON in whatever the site wrapped it in (`Exchange::own_json`): a failure says so in the same words
    // inside a callback, behind a guard or as a stream's event.
    if let Some(v) = e.own_json() {
        if crate::verify::challenge_response(&e.url, &v) {
            return Some("it is the site's challenge, not its data".into());
        }
        if let Some(said) = said_failure(&v) {
            return Some(format!("the site's answer says it failed: {said}"));
        }
    }
    None
}

/// Whether the answer is the site's challenge, read from its own JSON.
pub fn a_challenge(e: &Exchange) -> bool {
    e.own_json().is_some_and(|v| crate::verify::challenge_response(&e.url, &v))
}

/// The page's own address as a page that sends the reader back to it would carry it: host and path, as read.
fn address(u: &url::Url) -> String {
    let path = percent_encoding::percent_decode_str(u.path()).decode_utf8_lossy().into_owned();
    format!("{}{}", u.host_str().unwrap_or_default(), path.trim_end_matches('/')).to_lowercase()
}

/// Whether `landed` is a page the site sent the reader to instead of `asked`: another page, whose address carries the
/// asked page's own address to come back to (a sign-in, a consent wall, a check), the way `?dest=` or `?next=` does.
/// A page of the same site may name it by its path alone (`?ReturnUrl=/domains/panel`); the site's front page (`/`) is
/// in every address, so only a path below it counts.
pub fn detour(asked: &url::Url, landed: &url::Url) -> bool {
    let (a, l) = (address(asked), address(landed));
    let Some(q) = landed.query().filter(|_| a != l) else { return false };
    if crate::trace::carries_text(q, &a) {
        return true;
    }
    let path = percent_encoding::percent_decode_str(asked.path()).decode_utf8_lossy().trim_end_matches('/').to_lowercase();
    let same_site = asked.host_str().zip(landed.host_str()).is_some_and(|(x, y)| crate::identity::same_site(x, y));
    same_site && path.len() > 1 && crate::trace::carries_text(q, &path)
}

/// A body that isn't JSON or a page, as an answer: text the site serves as data (a feed, XML, plain text, Markdown, a
/// script-safe JSON with a prefix), with its type. None for a body that isn't text.
pub fn text_answer(content_type: &str, body: &str) -> Option<Value> {
    if body.trim().is_empty() {
        return None;
    }
    let ct = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    let (kind, sub) = ct.split_once('/').unwrap_or((ct.as_str(), ""));
    let text = match kind {
        "text" => sub != "html",
        "application" => sub.ends_with("xml") || sub.ends_with("json") || matches!(sub, "javascript" | "x-ndjson" | "csv" | "yaml" | "x-yaml" | "toml"),
        "" => !body.chars().any(|c| c.is_control() && !c.is_whitespace()),
        _ => false,
    };
    text.then(|| serde_json::json!({ "content_type": if ct.is_empty() { "text/plain".to_string() } else { ct.clone() }, "text": body }))
}

/// The records of a markup text a site serves as data (a feed, an XML list): its repeated element, the one that
/// holds elements of its own and occurs most (the outermost of equals), each occurrence read as its child elements'
/// texts by name (an empty child's `href`, as a link written as an attribute). A text of one line reads as one of many
/// lines. `{"records": [...]}`; None where no element with children repeats.
pub fn markup_records(text: &str) -> Option<Value> {
    let tags = markup_tags(text);
    // (name, start of each occurrence's content, end), for elements that open and close.
    let mut spans: std::collections::BTreeMap<String, Vec<(usize, usize, usize)>> = Default::default();
    let mut open: Vec<(String, usize, usize)> = Vec::new();
    for t in &tags {
        match t.kind {
            Tag::Open => open.push((t.name.clone(), t.end, t.start)),
            Tag::Close => {
                if let Some(at) = open.iter().rposition(|(n, _, _)| *n == t.name) {
                    let (name, from, first) = open.remove(at);
                    open.truncate(at);
                    spans.entry(name).or_default().push((from, t.start, first));
                }
            }
            Tag::Empty => {}
        }
    }
    let holds = |&(from, to, _): &(usize, usize, usize)| tags.iter().any(|t| t.start >= from && t.end <= to && t.kind != Tag::Close);
    let (_, list) = spans.iter().filter(|(_, v)| v.len() >= 2 && v.iter().all(holds)).max_by_key(|(_, v)| (v.len(), std::cmp::Reverse(v.iter().map(|s| s.2).min().unwrap_or(0))))?;
    let records: Vec<Value> = list
        .iter()
        .map(|&(from, to, _)| {
            let inner = &text[from..to];
            let mut o = serde_json::Map::new();
            for t in markup_tags(inner) {
                let value = match t.kind {
                    Tag::Open => inner[t.end..].find(&format!("</{}", t.name)).map(|e| markup_text(&inner[t.end..t.end + e])),
                    Tag::Empty => t.href.clone(),
                    Tag::Close => None,
                };
                if let Some(v) = value.filter(|v| !v.is_empty() && !v.contains('<')) {
                    o.entry(t.name.clone()).or_insert(Value::String(v));
                }
            }
            Value::Object(o)
        })
        .collect();
    Some(serde_json::json!({ "records": records }))
}

#[derive(PartialEq)]
enum Tag {
    Open,
    Close,
    Empty,
}

struct MarkupTag {
    name: String,
    kind: Tag,
    start: usize,
    end: usize,
    href: Option<String>,
}

/// The element tags of a markup text, in order: declarations, comments and character data are no tags.
fn markup_tags(text: &str) -> Vec<MarkupTag> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = text[at..].find('<').map(|i| at + i) {
        if text[i..].starts_with("<![CDATA[") {
            at = text[i..].find("]]>").map_or(text.len(), |e| i + e + 3);
            continue;
        }
        let Some(e) = text[i..].find('>').map(|e| i + e) else { break };
        let inside = &text[i + 1..e];
        at = e + 1;
        if inside.starts_with('?') || inside.starts_with('!') {
            continue;
        }
        let (kind, body) = if let Some(b) = inside.strip_prefix('/') { (Tag::Close, b) } else if let Some(b) = inside.strip_suffix('/') { (Tag::Empty, b) } else { (Tag::Open, inside) };
        let name = body.split(|c: char| c.is_whitespace()).next().unwrap_or_default().to_string();
        if name.is_empty() {
            continue;
        }
        let href = body.split("href=").nth(1).and_then(|h| h.trim_start_matches(['"', '\'']).split(['"', '\'']).next()).map(String::from);
        out.push(MarkupTag { name, kind, start: i, end: e + 1, href });
    }
    out
}

/// An element's text: character data unwrapped, the five standard entities read.
fn markup_text(inner: &str) -> String {
    let t = inner.trim();
    let t = t.strip_prefix("<![CDATA[").and_then(|x| x.strip_suffix("]]>")).unwrap_or(t);
    t.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&amp;", "&").trim().to_string()
}

/// A reply that is no page, as a route's call hands it back: its own JSON however the site wrapped it, read in the
/// shape the route recorded (`like`, [`Exchange::json_body_like`]), else the text a site serves as data
/// ([`text_answer`]). The call reads its live target here, and a reader that holds a walk's record of the same call
/// reads the record here too, so the two are compared by what each said, never by two readings of it. None for a
/// reply that reads as neither.
pub fn data_of(e: &Exchange, like: Option<&Value>) -> Option<Value> {
    data_with_source(e, like).map(|(value, _)| value)
}

pub(crate) fn data_with_source(e: &Exchange, like: Option<&Value>) -> Option<(Value, bool)> {
    e.json_body_with_source(like).or_else(|| {
        text_answer(e.response_header("content-type").unwrap_or(&e.response_mime), e.response_body.as_deref().unwrap_or_default())
            .map(|value| (value, false))
    })
}

/// Whether an answer lists nothing: the site answered and has nothing for the value. A page read as the answer
/// (`page::read`: its title, state, text and links) that links nowhere and whose state holds no records; or JSON
/// (`own_json`'s) with a list and every list in it empty, that says nothing else but the values asked (`asked`, the
/// request echoed back), counts and flags. An answer with no list says nothing of having one to fill. The one reader
/// of an empty answer: the agent's outcome (`answered_empty`) and a confirming browse (`learn::confirm`) both ask it.
pub fn lists_nothing(data: &Value, asked: &[&str]) -> bool {
    lists_nothing_beside(data, asked, None)
}

/// Whether a results object declares that it is still loading or failed.
pub fn search_unready(object: &serde_json::Map<String, Value>) -> bool {
    ["pending", "loading"].iter().any(|k| object.get(*k) == Some(&Value::Bool(true)))
        || object.get("error").is_some_and(|e| !e.is_null() && e.as_bool() != Some(false))
}

/// The fields that show a page's search settled with zero results for this query. A page can carry menus, filters
/// and other state beside its search. Require a matching query, a completed search, a zero count and an empty
/// result list in the same state object. When the cold page identified a list, its state must supply the evidence.
/// Another populated result list anywhere on the page vetoes the evidence.
pub fn empty_search_fields(data: &Value, asked: &str, witness: Option<&Value>) -> Option<Vec<String>> {
    fn result_list(name: &str) -> bool {
        let words = crate::goal::key_words(name);
        matches!(words.last().map(String::as_str), Some("results" | "listings" | "hits")) || words == ["listing", "cards"]
    }

    fn result_count(name: &str) -> bool {
        let words = crate::goal::key_words(name);
        words == ["number", "of", "results"] || words == ["result", "count"] || words == ["total", "results"]
    }

    fn field_name(name: &str) -> bool {
        !name.is_empty() && !name.contains(['.', '[', ']', '{', '}'])
    }

    fn read(data: &Value, asked: &str, witness: Option<&Value>, path: &mut Vec<String>, eligible: bool, evidence: &mut Option<Vec<String>>) -> Option<()> {
        let object = match data {
            Value::Object(object) => object,
            Value::Array(items) if path.len() < 16 => {
                // Lists inside an array can veto the empty result. They cannot provide projected field paths.
                path.push(String::new());
                let clear = items.iter().try_for_each(|item| read(item, asked, witness, path, false, evidence));
                path.pop();
                return clear;
            }
            _ => return Some(()),
        };
        let mut results = Vec::new();
        for (name, value) in object {
            if let Some(items) = value.as_array().filter(|_| result_list(name)) {
                if !items.is_empty() {
                    return None;
                }
                if field_name(name) && witness.is_none_or(|list| std::ptr::eq(list, value)) {
                    results.push(name);
                }
            }
        }
        let error = object.get("error");
        let eligible = eligible && !search_unready(object);
        if evidence.is_none() && eligible && !results.is_empty() {
            let complete = ["pending", "loading"].into_iter().find(|k| object.get(*k) == Some(&Value::Bool(false)));
            if let Some(complete) = complete {
                let own_query = object.get("query").and_then(Value::as_str).map(|q| ("query".to_string(), q));
                let context_queries = object.iter().filter(|(name, _)| field_name(name)).filter_map(|(name, v)| {
                    Some((format!("{name}.query"), v.get("query")?.as_str()?))
                });
                let mut queries = own_query.into_iter().chain(context_queries);
                let asked_here = |q: &str| q.trim().eq_ignore_ascii_case(asked);
                let query = queries.next().filter(|(_, q)| asked_here(q) && queries.all(|(_, q)| asked_here(q)));
                let counts: Vec<_> = object.iter().filter(|(name, _)| result_count(name)).collect();
                let zero = !counts.is_empty() && counts.iter().all(|(k, v)| field_name(k) && (v.as_u64() == Some(0) || v.as_str() == Some("0")));
                if let Some((query, _)) = query.filter(|_| zero) {
                    let at = |key: &str| path.iter().map(String::as_str).chain(std::iter::once(key)).collect::<Vec<_>>().join(".");
                    let mut fields = vec![at(&query), at(complete)];
                    fields.extend(counts.into_iter().map(|(k, _)| at(k)));
                    fields.extend(results.into_iter().map(|k| at(k)));
                    if error.is_some() {
                        fields.push(at("error"));
                    }
                    *evidence = Some(fields);
                }
            }
        }
        if path.len() < 16 {
            for (name, value) in object.iter().filter(|(_, v)| v.is_object() || v.is_array()) {
                path.push(name.clone());
                read(value, asked, witness, path, eligible && field_name(name), evidence)?;
                path.pop();
            }
        }
        Some(())
    }

    let asked = asked.trim();
    if asked.chars().count() < 3 {
        return None;
    }
    let mut evidence = None;
    read(data, asked, witness, &mut Vec::new(), true, &mut evidence)?;
    evidence
}

/// [`lists_nothing`], held beside another answer of the same page (`beside`: the same call for another value). A page's
/// links that the other answer carries too are the page's frame (its menus, the same whatever was asked), not results:
/// a page whose every link is frame links nowhere, where the other answer links somewhere of its own (two links or
/// more). Two answers alike link alike, and say nothing of being empty: that is a call deaf to its caller.
pub fn lists_nothing_beside(data: &Value, asked: &[&str], beside: Option<&Value>) -> bool {
    lists_nothing_walked(data, asked, beside, None)
}

/// What a walk holds to judge one of its answers by alone, where no other answer stands beside it (a first learn):
/// the values the answered request sent (`slots::slots`, its address, body and headers), what the walked page showed
/// (`shown`), and the page's own document where the answer is the page read.
#[derive(Clone, Debug, Default)]
pub struct Walked<'a> {
    pub sent: Vec<String>,
    pub shown: Option<&'a crate::shown::Shown>,
    pub document: Option<&'a str>,
}

impl<'a> Walked<'a> {
    /// The walk's record `e` of the answered request, and what the walked page showed.
    pub fn of(e: &'a Exchange, shown: Option<&'a crate::shown::Shown>) -> Walked<'a> {
        let body = e.response_body.as_deref().unwrap_or_default();
        let markup = crate::page::is_markup(e.response_header("content-type").unwrap_or(&e.response_mime), body) && serde_json::from_str::<Value>(body).is_err();
        let mut sent: Vec<String> = crate::slots::slots(e).into_iter().map(|s| s.value).collect();
        sent.push(e.url.as_str().to_string());
        // The request's headers as the browser sent them (its user agent among them): a site's account of the request
        // says them back too.
        sent.extend(e.request_headers.iter().map(|(_, v)| v.clone()));
        Walked { sent, shown, document: markup.then_some(body) }
    }
}

/// [`lists_nothing_beside`], with what the walk holds (`walked`) to judge the answer by on its own, the site's page the
/// judge. A page read lists nothing, too, when its document says nothing but the ask back (`page::says_only_the_ask`:
/// headings and the value named, no link of a record's) and its state lists nothing. JSON lists nothing, too, when it
/// holds a list and no list of records (none holds an object or a list), says back what the request sent, and holds
/// nothing of its own besides: no phrase, no text naming a value asked beside more, and nothing the page showed
/// (`Shown::says_of`, where the page shows enough to judge by). What is left is the request said back and the site's
/// bookkeeping (cache names, buckets, flags, placeholders in brackets), which an empty answer carries as readily as a
/// full one.
pub fn lists_nothing_walked(data: &Value, asked: &[&str], beside: Option<&Value>, walked: Option<&Walked>) -> bool {
    let read_page = |d: &Value| d.as_object().is_some_and(|o| o.contains_key("links") && o.contains_key("text") && o.keys().all(|k| matches!(k.as_str(), "title" | "state" | "text" | "links")));
    if read_page(data) {
        let urls = |d: &Value| d["links"].as_array().map(|l| l.iter().filter_map(|x| x["url"].as_str().map(str::to_string)).collect::<std::collections::BTreeSet<_>>()).unwrap_or_default();
        let own = urls(data);
        let frame = beside.filter(|b| read_page(b)).map(urls).filter(|theirs| theirs.difference(&own).count() >= 2).unwrap_or_default();
        let links_nowhere = data["links"].as_array().is_some_and(|l| l.iter().all(|x| x["url"].as_str().is_some_and(|u| frame.contains(u))));
        let says_only_the_ask = || walked.and_then(|w| w.document).is_some_and(|d| crate::page::says_only_the_ask(d, asked));
        return (links_nowhere || says_only_the_ask()) && (data["state"].is_null() || lists_nothing_walked(&data["state"], asked, None, walked.map(|w| Walked { document: None, ..w.clone() }).as_ref()));
    }
    lists_nothing_json(data, asked) || walked.is_some_and(|w| holds_nothing_of_its_own(data, asked, w))
}

/// How many values of its own an object outside the request's account holds to be one record
/// ([`holds_nothing_of_its_own`]): more than the one or two notes a server leaves beside its account of a request.
const RECORD_FIELDS: usize = 3;

/// Whether JSON holds a list and no list of records, says back what its request sent (`walked.sent`, or a value
/// asked), and holds nothing of its own besides ([`lists_nothing_walked`]).
fn holds_nothing_of_its_own(data: &Value, asked: &[&str], walked: &Walked) -> bool {
    let same = |a: &str, b: &str| a.trim().eq_ignore_ascii_case(b.trim());
    // Said back whole, or with a mark of the site's beside it (`<user agent>:ua`): a value it was sent, of a length
    // no chance makes, inside a longer text.
    let within = |v: &str, s: &str| v.trim().chars().count() >= 12 && s.to_lowercase().contains(&v.trim().to_lowercase());
    let sent = |s: &str| walked.sent.iter().any(|v| same(v, s) || within(v, s)) || asked.iter().any(|v| same(v, s));
    // A text wholly in brackets stands where a value would: `(redacted)`, `(none)`, a note in place of one.
    let placeholder = |s: &str| {
        let t = s.trim();
        [('(', ')'), ('[', ']'), ('<', '>'), ('{', '}')].iter().any(|(o, c)| t.starts_with(*o) && t.ends_with(*c) && t[1..t.len() - 1].chars().all(|x| x != *o && x != *c))
    };
    let asked: Vec<String> = asked.iter().map(|a| a.trim().to_lowercase()).filter(|a| a.chars().count() >= 3).collect();
    let (mut lists, mut records, mut echoed) = (0usize, false, false);
    let mut own: Vec<Value> = Vec::new();
    fn walk(v: &Value, depth: usize, f: &mut dyn FnMut(&Value)) {
        if depth > 32 {
            return;
        }
        f(v);
        match v {
            Value::Array(items) => items.iter().for_each(|x| walk(x, depth + 1, f)),
            Value::Object(o) => o.values().for_each(|x| walk(x, depth + 1, f)),
            _ => {}
        }
    }
    walk(data, 0, &mut |v| match v {
        Value::Array(items) => {
            lists += 1;
            records |= items.iter().any(|x| x.is_object() || x.is_array());
        }
        Value::String(s) if sent(s) => echoed = true,
        Value::String(s) if !crate::goal::link(s.trim()) && !placeholder(s) => own.push(v.clone()),
        Value::Number(_) => own.push(v.clone()),
        _ => {}
    });
    if lists == 0 || records || !echoed {
        return false;
    }
    // One record is an answer, list or none. An empty answer's bookkeeping, as its walk shows it, is the site's account
    // of the request: each object of it says back something the request sent (the query, the page's address, the
    // browser's own user agent), in it or below it, or holds a placeholder where a value would be (a parameter as
    // received and as finalized, the client as characterized, the routing that found no index), and the server's notes
    // beside it come one or two to an object (a cache's name and bucket, a query's time). A record says back nothing of
    // the request: an object, no part of it the request's account, holding RECORD_FIELDS values of its own or more
    // (texts and counts the request did not send, no link), as an item's own details are (an invite's inviter, its
    // server, its channel, each with an id, a name, counts).
    fn of_the_request(v: &Value, depth: usize, marks: &dyn Fn(&str) -> bool) -> bool {
        match v {
            _ if depth > 32 => false,
            Value::String(s) => marks(s),
            Value::Object(o) => o.values().any(|x| of_the_request(x, depth + 1, marks)),
            Value::Array(items) => items.iter().any(|x| of_the_request(x, depth + 1, marks)),
            _ => false,
        }
    }
    fn a_record(v: &Value, depth: usize, own: &dyn Fn(&Value) -> bool, marks: &dyn Fn(&str) -> bool) -> bool {
        match v {
            _ if depth > 32 => false,
            Value::Object(o) => (o.values().filter(|x| own(x)).count() >= RECORD_FIELDS && !of_the_request(v, depth, marks)) || o.values().any(|x| a_record(x, depth + 1, own, marks)),
            Value::Array(items) => items.iter().any(|x| a_record(x, depth + 1, own, marks)),
            _ => false,
        }
    }
    let own_value = |x: &Value| match x {
        Value::String(s) => !s.trim().is_empty() && !sent(s) && !crate::goal::link(s.trim()) && !placeholder(s),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        _ => false,
    };
    let marks = |s: &str| sent(s) || placeholder(s);
    if a_record(data, 0, &own_value, &marks) {
        return false;
    }
    let a_phrase = |t: &str| t.contains(' ') && t.chars().count() >= 4;
    let names_the_ask = |t: &str| asked.iter().any(|a| t.contains(a.as_str()) && t.len() > a.len());
    let telling = own.iter().filter_map(Value::as_str).map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()).any(|t| a_phrase(&t) || names_the_ask(&t));
    let shown = walked.shown.filter(|s| s.judges()).is_some_and(|s| s.says_of(&Value::Array(own.clone())));
    !telling && !shown
}

/// [`lists_nothing`]'s JSON reading: a list, every list empty, nothing said besides the ask.
fn lists_nothing_json(data: &Value, asked: &[&str]) -> bool {
    // (lists seen, something said besides the ask)
    fn walk(v: &Value, asked: &[&str], depth: usize, seen: &mut (usize, bool)) {
        if depth > 32 || seen.1 {
            return;
        }
        match v {
            Value::Array(items) => {
                seen.0 += 1;
                seen.1 |= !items.is_empty();
            }
            Value::Object(o) => o.values().for_each(|x| walk(x, asked, depth + 1, seen)),
            Value::String(s) => seen.1 |= !s.trim().is_empty() && !asked.iter().any(|a| a.trim().eq_ignore_ascii_case(s.trim())),
            _ => {}
        }
    }
    let mut seen = (0, false);
    walk(data, asked, 0, &mut seen);
    seen.0 > 0 && !seen.1
}

/// Why the target's answer to a replayed read isn't the answer, read against what the walk recorded for it: a
/// refusal or an error the site said in its own words, a challenge, a 2xx of another kind than the walk saw (the
/// site took the request and held the answer back), nothing where the walk saw an answer, or a detour to another
/// page that names the asked one. A write is judged by its ledger, not here.
/// Whether a read's replay found nothing, said by the site as a page: it answered 404 where the walk saw an answer,
/// with a page of markup that says back a value the caller asked for (three characters or more), as a search page
/// says "No results for …" or "… - nothing found". That is the answer to the search, not a broken route; a 404 that
/// says none of what was asked (a page that moved, an id that's gone) still fails.
pub fn found_nothing(step: &Step, inputs: &std::collections::HashMap<String, String>, got: &Exchange) -> bool {
    found_nothing_for(Judged::of(step), inputs, got)
}

/// A step as the judges of an answer read it: the status the walk saw, whether it may change what the site holds
/// (`ledger::writes`), and whether it sends a secret. A graph's step gives one ([`Judged::of`]), and so does a step
/// learned by example, so the learner's caller and the node's ask the same judges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Judged {
    pub status: u16,
    pub writes: bool,
    pub sends_a_secret: bool,
}

impl Judged {
    pub fn of(step: &Step) -> Judged {
        Judged { status: step.status, writes: crate::ledger::writes(step), sends_a_secret: step.fields.iter().any(|f| matches!(f.class, crate::graph::Class::Input { secret: true, .. })) }
    }
}

/// [`found_nothing`], for a step as the judges read it.
pub fn found_nothing_for(step: Judged, inputs: &std::collections::HashMap<String, String>, got: &Exchange) -> bool {
    if got.status != 404 || step.status == 404 || step.writes {
        return false;
    }
    let body = got.response_body.as_deref().unwrap_or_default();
    let content_type = got.response_header("content-type").unwrap_or(&got.response_mime);
    if !crate::page::is_markup(content_type, body) {
        return false;
    }
    let page = crate::page::read(body, &got.url);
    let said = format!("{}\n{}", page["title"].as_str().unwrap_or_default(), page["text"].as_str().unwrap_or_default()).to_lowercase();
    inputs.values().map(|v| v.trim().to_lowercase()).any(|v| v.chars().count() >= 3 && said.contains(&v))
}

pub fn replayed_not_an_answer(step: &Step, asked: &url::Url, got: &Exchange) -> Option<String> {
    not_an_answer_for(Judged::of(step), asked, got)
}

/// [`replayed_not_an_answer`], for a step as the judges read it.
pub fn not_an_answer_for(step: Judged, asked: &url::Url, got: &Exchange) -> Option<String> {
    if step.writes {
        // A step that sends a secret and is answered with a page that asks for one again was refused: a site that
        // turns a wrong password away serves its sign-in form once more, and says 200 doing it.
        if step.sends_a_secret && password_input_matches(got, |_| true) {
            return Some("the site answered with a page that asks for the password again: it did not sign in".into());
        }
        return None;
    }
    if (200..300).contains(&step.status) && (200..300).contains(&got.status) && got.status != step.status {
        return Some(format!("the site answered {} where the walk saw {}: it took the request but held the answer back", got.status, step.status));
    }
    if let Some(why) = not_an_answer(got, false) {
        // A read whose recorded answer was empty (204) answers empty again.
        let empty_as_recorded = got.status == step.status && got.response_body.as_deref().is_none_or(|b| b.trim().is_empty()) && step.status == 204;
        if !empty_as_recorded {
            return Some(why);
        }
    }
    // A page that runs code and says nothing is a gate, whatever its status: a site may answer a navigation `202`
    // with a script-only stub and serve the page once the code has run (Booking.com does). Answering that stub is
    // answering nothing; the page needs its own browser.
    if got.is_main_document() && crate::page::a_door(got.status, got.response_body.as_deref().unwrap_or_default(), &got.url) {
        return Some(format!("the site answered {} with a page that runs code and says nothing: the page needs its own browser", got.status));
    }
    if detour(asked, &got.url) {
        return Some(format!("the site sent it to another page ({}) that names this one to come back to: a sign-in or a wall", got.url.path()));
    }
    if sent_to_sign_in(asked, got) {
        return Some(format!("the site sent it to another page ({}), which asks for a password: the session is gone", got.url.path()));
    }
    None
}

/// Whether a read landed on another page than the one asked, and that page asks for an existing password.
pub fn sent_to_sign_in(asked: &url::Url, got: &Exchange) -> bool {
    let moved = asked.host_str() != got.url.host_str() || asked.path().trim_end_matches('/') != got.url.path().trim_end_matches('/');
    moved && password_input_matches(got, |input| !creates_a_password(input))
}

fn password_input_matches(got: &Exchange, check: impl FnMut(scraper::ElementRef<'_>) -> bool) -> bool {
    got.response_body.as_deref().is_some_and(|b| {
        let password = scraper::Selector::parse("input[type=password i]").expect("static selector");
        crate::page::is_html(b) && scraper::Html::parse_document(b).select(&password).any(check)
    })
}

/// A new password field belongs to the agent filling the form. Its autocomplete purpose takes precedence over
/// the form's submit label, and a separate sign-in form on the same page still asks for an existing password.
fn creates_a_password(input: scraper::ElementRef<'_>) -> bool {
    let purpose = input.value().attr("autocomplete").and_then(|value| value.split_whitespace().last()).unwrap_or_default();
    if purpose.eq_ignore_ascii_case("new-password") {
        return true;
    }
    if purpose.eq_ignore_ascii_case("current-password") {
        return false;
    }
    let Some(form) = input.ancestors().filter_map(scraper::ElementRef::wrap).find(|e| e.value().name() == "form") else { return false };
    let submit = scraper::Selector::parse("button:not([type]), button[type=submit i], input[type=submit i]").expect("static selector");
    form.select(&submit).any(|button| {
        let tag = button.value();
        let label = tag.attr("aria-label").or_else(|| tag.attr("value").filter(|_| tag.name() == "input"));
        let label = label.map(str::to_owned).unwrap_or_else(|| button.text().collect::<Vec<_>>().join(" "));
        let label = label.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
        matches!(label.as_str(), "create account" | "create an account" | "register" | "sign up" | "signup")
    })
}

#[cfg(test)]
mod tests {
    /// A page read as the answer that links nowhere and holds no records lists nothing; one that links to a result,
    /// or whose state holds one, lists something. (The agent's outcome's own cases, 2346b1b2.)
    #[test]
    fn a_page_read_as_the_answer_says_when_it_lists_nothing() {
        let page = |links: Value, state: Value| json!({ "title": "Search · shop.example", "state": state, "text": "Search\nNo results for \"zqxv\". Try another word.", "links": links });
        assert!(lists_nothing(&page(json!([]), Value::Null), &[]));
        assert!(lists_nothing(&page(json!([]), json!({ "search": { "q": "zqxv", "hits": [] } })), &["zqxv"]));
        assert!(!lists_nothing(&page(json!([{ "text": "Brass desk lamp", "url": "https://shop.example/p/1" }]), Value::Null), &[]));
        assert!(!lists_nothing(&page(json!([]), json!({ "hits": [{ "name": "Brass desk lamp" }] })), &[]));
    }

    #[test]
    fn empty_search_evidence_needs_a_completed_query_and_no_other_results() {
        let search = json!({"context":{"query":"zqxv"},"listingCards":[],"numberOfResults":0,"pending":false,"error":null});
        let complete = json!({"search":search, "navigation":{"items":[{"label":"Home"}]}});
        let fields = empty_search_fields(&complete, "zqxv", Some(&complete["search"]["listingCards"])).expect("the settled search has no listings");
        assert_eq!(crate::fields::project(&complete, &fields), json!({"search":search}));
        assert!(empty_search_fields(&complete, "lamps", None).is_none(), "the result belongs to another query");
        let mut partial = complete.clone();
        partial["search"].as_object_mut().unwrap().remove("listingCards");
        assert!(empty_search_fields(&partial, "zqxv", None).is_none(), "a shell may have nothing to show yet");
        let mut pending = complete.clone();
        pending["loading"] = json!(true);
        assert!(empty_search_fields(&pending, "zqxv", None).is_none(), "the parent search is still loading");
        let mut failed = complete.clone();
        failed["search"]["error"] = json!("Unavailable");
        assert!(empty_search_fields(&failed, "zqxv", None).is_none(), "the search failed");
        let mut other = complete.clone();
        other["page"]["searchProductResults"] = json!([{"title":"A result"}]);
        assert!(empty_search_fields(&other, "zqxv", None).is_none(), "the page still lists matching products");
        let mut section = complete.clone();
        section["page"]["sections"] = json!([{"results":[{"title":"A result"}]}]);
        assert!(empty_search_fields(&section, "zqxv", None).is_none(), "results inside an array also veto an empty search");
        let mut hits = complete.clone();
        hits["page"]["hits"] = json!([{"title":"A result"}]);
        assert!(empty_search_fields(&hits, "zqxv", None).is_none(), "a nonempty hits list also vetoes an empty search");
        let mut inconsistent = complete.clone();
        inconsistent["search"]["resultCount"] = json!(5);
        assert!(empty_search_fields(&inconsistent, "zqxv", None).is_none(), "the counts disagree");
        let mut stale = complete.clone();
        stale["search"]["query"] = json!("lamps");
        assert!(empty_search_fields(&stale, "zqxv", None).is_none(), "some state belongs to another query");
        let mixed = json!({"search":{"query":"zqxv","pending":true,"listingCards":[]}, "catalog":search});
        assert!(empty_search_fields(&mixed, "zqxv", None).is_some());
        assert!(empty_search_fields(&mixed, "zqxv", Some(&mixed["search"]["listingCards"])).is_none());
    }

    /// JSON that only says back what was asked, beside a list with nothing in it, is the site's empty answer for the
    /// value; a list with a record, or words of the site's own beside it, is not. (2346b1b2's cases.)
    #[test]
    fn an_answer_echoing_the_query_beside_an_empty_list_is_empty() {
        let asked = ["zqxv"];
        assert!(lists_nothing(&json!({ "query": "zqxv", "results": [], "total": 0, "page": 1, "exact": true }), &asked));
        assert!(lists_nothing(&json!({ "data": { "search": { "term": "ZQXV", "items": [] } } }), &asked));
        assert!(lists_nothing(&json!([]), &[]));
        assert!(!lists_nothing(&json!({ "query": "zqxv", "results": [{ "name": "Brass desk lamp" }] }), &asked));
        assert!(!lists_nothing(&json!({ "query": "zqxv", "results": [], "message": "the search is down for a moment" }), &asked));
        assert!(!lists_nothing(&json!({ "query": "zqxv", "total": 0 }), &asked), "no list, nothing said of one");
        assert!(!lists_nothing(&json!({ "query": "zqxv", "results": [] }), &[]), "an echo is only one of what was asked");
    }

    /// Beside the same page for a value with results, a page whose only links are the ones both carry (the site's
    /// menus) lists nothing; one with a link of its own lists something; and two pages alike are not called empty.
    #[test]
    fn a_page_whose_every_link_is_the_frame_beside_one_with_results_lists_nothing() {
        let link = |u: &str| json!({ "text": u, "url": format!("https://books.example{u}") });
        let page = |links: Vec<Value>| json!({ "title": "Book search", "state": Value::Null, "text": "Search\nBooks\nGroups", "links": links });
        let found = page(vec![link("/import"), link("/groups"), link("/book/1"), link("/book/2"), link("/book/3")]);
        let none = page(vec![link("/import")]);
        assert!(!lists_nothing(&none, &[]), "alone, a link is a link");
        assert!(lists_nothing_beside(&none, &[], Some(&found)), "beside results, the menus alone link nowhere");
        assert!(!lists_nothing_beside(&page(vec![link("/import"), link("/book/9")]), &[], Some(&found)), "a result of its own");
        assert!(!lists_nothing_beside(&found, &[], Some(&found)), "two answers alike are deaf, not empty");
        assert!(!lists_nothing_beside(&none, &[], Some(&page(vec![link("/import"), link("/book/1")]))), "beside one link of its own, too little to call a frame");
    }


    /// The walk that exposed it: a shop's page asks its own address for the results, and on a walled run the site
    /// answered that call with two codes and the address of its check. One code closes with the word where the
    /// reader wanted it to open with it, and the address sat in an object the reader took for data, so the answer
    /// was not read as a failure, the page's shell was kept as the search, and words were answered `ok` with a
    /// title, a header and a footer. Codes that say it failed, and nothing beside them but where to go, is a failure.
    #[test]
    fn codes_that_say_it_failed_beside_only_an_address_are_a_failure_not_an_answer() {
        let walled: Value = serde_json::from_str(r#"{"ret":["FAIL_SYS_USER_VALIDATE","GATE7_ERROR::SM::busy, try later"],"data":{"url":"https://www.shop.example/find/lamps/hold?t=abc"}}"#).unwrap();
        assert!(said_failure(&walled).is_some());
        assert!(failure_code("FAIL_SYS_USER_VALIDATE") && !failure_code("GATE7_ERROR::SM::busy"), "a code that only closes with the word is one in a list beside one that opens with it");
        assert!(failure_codes(&[Value::from("FAIL_SYS_USER_VALIDATE"), Value::from("GATE7_ERROR::SM::busy")]));
        assert!(!failure_codes(&[Value::from("NO_ERROR")]) && !failure_codes(&[Value::from("GATE7_ERROR")]) && !failure_codes(&[]));
        assert!(said_failure(&serde_json::json!({"status": "NO_ERROR", "name": "Lamp", "price": "12.00"})).is_none(), "a healthy answer that names no error is an answer");
        assert!(!failure_code("ERROR") && !failure_code("Terror_Error") && !failure_code("the request failed"));
        // Data beside the codes is still an answer: a partial result, or a record that carries a code of its own.
        let partial: Value = serde_json::from_str(r#"{"ret":["GATE7_ERROR::slow"],"data":{"items":[{"name":"Lamp"}]}}"#).unwrap();
        assert!(said_failure(&partial).is_none());
        let named: Value = serde_json::from_str(r#"{"ret":["GATE7_ERROR::slow"],"data":{"name":"Lamp","price":"12.00"}}"#).unwrap();
        assert!(said_failure(&named).is_none(), "an object that holds more than how the request went is data");
        // The site's own shape carried more beside the address (how big a dialog to show), which is still no record.
        let dialog: Value = serde_json::from_str(r#"{"ret":["FAIL_SYS_USER_VALIDATE","GATE7_ERROR::SM::busy"],"data":{"url":"https://www.shop.example/hold","size":{"w":"420","h":"320"}},"size":{"w":"420","h":"320"}}"#).unwrap();
        assert_eq!(failed_by_code(&dialog).as_deref(), Some("FAIL_SYS_USER_VALIDATE"));
        assert!(said_failure(&dialog).is_some(), "the one reader of an answer that failed says so for it everywhere");
        assert!(failed_by_code(&partial).is_none(), "a list of things is an answer, whatever code rides with it");
        assert!(failed_by_code(&serde_json::json!({"data": {"url": "https://www.shop.example/x"}})).is_none());
        // An answer with no code at all and only an address is not read as a failure here.
        let moved: Value = serde_json::from_str(r#"{"data":{"url":"https://www.shop.example/find/lamps"}}"#).unwrap();
        assert!(said_failure(&moved).is_none());
    }

    /// A failed answer that hands back its validate/check page points the clearance flow at that page; a healthy
    /// answer, or a plain move with no failure code, points nowhere. General: the address is read from the answer's
    /// shape (`data.url`, a top-level `url`/`redirect`), never from any site's name — the site below is a fixture.
    #[test]
    fn a_failed_answer_points_at_the_sites_check_page() {
        let walled: Value = serde_json::from_str(r#"{"ret":["FAIL_SYS_USER_VALIDATE","GATE7_ERROR::SM::busy"],"data":{"url":"https://www.shop.example/_____tmd_____/punish?x5secdata=abc"}}"#).unwrap();
        assert_eq!(check_url(&walled).as_deref(), Some("https://www.shop.example/_____tmd_____/punish?x5secdata=abc"));
        let top: Value = serde_json::from_str(r#"{"ret":["FAIL_SYS_USER_VALIDATE"],"url":"https://www.shop.example/validate"}"#).unwrap();
        assert_eq!(check_url(&top).as_deref(), Some("https://www.shop.example/validate"));
        let healthy: Value = serde_json::from_str(r#"{"ret":["GATE7_ERROR::slow"],"data":{"items":[{"name":"Lamp"}]}}"#).unwrap();
        assert!(check_url(&healthy).is_none(), "a healthy answer with records points nowhere");
        let moved: Value = serde_json::from_str(r#"{"data":{"url":"https://www.shop.example/find/lamps"}}"#).unwrap();
        assert!(check_url(&moved).is_none(), "a move with no failure code is not a check");
        let codeless: Value = serde_json::from_str(r#"{"ret":["FAIL_SYS_USER_VALIDATE"]}"#).unwrap();
        assert!(check_url(&codeless).is_none(), "a failure that names no address points nowhere");
    }
    use super::*;
    use serde_json::json;

    /// The walk that exposed it: a sign-in called with a wrong password. The site served its sign-in form again, 200,
    /// and the call was reported as done. A step that sends a secret and gets a page asking for one was refused; the
    /// same step answered with the page behind the sign-in was not.
    #[test]
    fn a_sign_in_answered_with_the_sign_in_form_again_did_not_sign_in() {
        let step: Step = serde_json::from_value(json!({
            "exchange": 0, "method": "POST", "status": 303, "url": "https://club.example/authenticate", "needs_browser": false,
            "fields": [{ "loc": { "in": "form", "key": "password" }, "class": "input", "name": "password", "secret": true, "default": null }]
        }))
        .unwrap();
        let asked: url::Url = "https://club.example/authenticate".parse().unwrap();
        let mut form = ex("POST", "https://club.example/login", 200, "<html><body><form><input name=\"username\"><input type=\"password\" name=\"password\"></form></body></html>");
        form.response_mime = "text/html".into();
        assert!(replayed_not_an_answer(&step, &asked, &form).is_some_and(|w| w.contains("did not sign in")));
        let mut inside = ex("POST", "https://club.example/secure", 200, "<html><body><h2>Secure Area</h2><a href=\"/logout\">Logout</a></body></html>");
        inside.response_mime = "text/html".into();
        assert_eq!(replayed_not_an_answer(&step, &asked, &inside), None);
    }

    #[test]
    fn a_signup_form_does_not_mean_the_site_asked_for_an_existing_login() {
        let asked = "https://shop.example/login".parse().unwrap();
        let signup = "https://shop.example/signup";
        let form = r#"<html><body><form method="post"><input type="hidden" name="email"><label>Password<input type="password" name="password" required></label><input name="address" required><button type="submit">Create Account</button></form></body></html>"#;
        assert!(!sent_to_sign_in(&asked, &ex("POST", signup, 200, form)));
        let with_login = form.replace("</body>", r#"<form><input name="email"><input type="password"><button>Sign in</button></form></body>"#);
        assert!(sent_to_sign_in(&asked, &ex("POST", signup, 200, &with_login)));
        let new_password = form.replace("type=\"password\"", "type=\"password\" autocomplete=\"section-signup new-password\"").replace("Create Account", "Continue");
        assert!(!sent_to_sign_in(&asked, &ex("POST", signup, 200, &new_password)));
        let current_password = form.replace("type=\"password\"", "type=\"password\" autocomplete=\"current-password\"");
        assert!(sent_to_sign_in(&asked, &ex("POST", signup, 200, &current_password)));
    }

    /// A GraphQL answer with errors and no data failed, however much its extensions say; one with data answered, errors
    /// beside it or not.
    #[test]
    fn a_graphql_answer_with_errors_and_no_data_failed() {
        let failed = json!({ "errors": [{ "message": "Internal Server Error", "extensions": { "code": "VALIDATION_INVALID_TYPE_VARIABLE" } }], "extensions": { "latency": { "ms": 5 } } });
        assert!(said_failure(&failed).is_some_and(|m| m.contains("Internal Server Error")));
        let partly = json!({ "errors": [{ "message": "one field failed" }], "data": { "search": { "results": [{ "name": "Riverside" }] } } });
        assert!(said_failure(&partly).is_none());
    }

    /// The walk that exposed it, as a first learn: a library's search answered a value it has nothing for with its
    /// envelope alone, the request said back (the value, the page's address) beside its cache's bookkeeping and a list
    /// of the cache's names, and no records place at all. Alone, that read as something said; held to what its
    /// request sent and what the page showed, it lists nothing. The same call with its records, a list of names that
    /// name the value, a notice in words, or a record that holds no list, each says something.
    #[test]
    fn an_answer_holding_only_the_ask_said_back_and_its_bookkeeping_lists_nothing() {
        let call = "https://lib.example/services/search/page?user_query=qzxv&hits_per_page=50&client_url=https%3A%2F%2Flib.example%2Fsearch%3Fquery%3Dqzxv";
        let envelope = json!({ "request": { "client_request_parameters": { "client_url": "https://lib.example/search?query=qzxv", "user_query": "qzxv" } },
            "caching": { "search": { "name": "PX-1x7o:XX-T:sr-Q:9ad9ba12+CS:some", "acceptable_names": ["PX-1x7o:XX-T:std-Q:9ad9ba12+CS:some"], "statsd_bucket": "search.cache.metadata.search_results", "utilization": { "hit": true, "miss": false } } } });
        let e = ex("GET", call, 200, &envelope.to_string());
        let walked = Walked::of(&e, None);
        let asked = ["qzxv"];
        assert!(!lists_nothing(&envelope, &asked), "alone, the cache's names are something said");
        assert!(lists_nothing_walked(&envelope, &asked, None, Some(&walked)), "the ask said back and the site's bookkeeping list nothing");
        let mut found = envelope.clone();
        found["response"] = json!({ "hits": { "hits": [{ "title": "Qzxv and the sea", "identifier": "qzxv-1" }] } });
        assert!(!lists_nothing_walked(&found, &asked, None, Some(&walked)), "a list of records");
        let named = json!({ "query": "lamp", "suggestions": ["lamp-shade", "lamp-oil"] });
        assert!(!lists_nothing_walked(&named, &["lamp"], None, Some(&Walked::of(&ex("GET", "https://shop.example/suggest?query=lamp", 200, &named.to_string()), None))), "names that name the value");
        let notice = json!({ "user_query": "qzxv", "notices": ["the search is down for a moment"] });
        assert!(!lists_nothing_walked(&notice, &asked, None, Some(&walked)), "words of the site's own");
        let record = json!({ "user_query": "qzxv", "status": "SHIPPED" });
        assert!(!lists_nothing_walked(&record, &asked, None, Some(&walked)), "no list: nothing said of one to fill");
        // As the site sends it: its account of the request beside the empty records place, with the request's own
        // user agent said back with a mark, and notes in brackets where values would be.
        let agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
        let mut sent = ex("GET", call, 200, "");
        sent.request_headers = vec![("User-Agent".into(), agent.into())];
        let mut whole = envelope.clone();
        whole["session_context"] = json!({ "username": "(guest user)", "client_characterization": { "client_useragent": format!("{agent}:sua"), "client_ip": "203.0.113.7:sra" } });
        whole["response"] = json!({ "header": { "succeeded": true, "query_time": 328, "forensics": { "routing": { "index_addressed": "(cannot determine without hits)" } } }, "body": { "hits": { "total": 0, "returned": 0, "hits": [] } }, "hit_schema": [] });
        sent.response_body = Some(whole.to_string());
        assert!(lists_nothing_walked(&whole, &asked, None, Some(&Walked::of(&sent, None))), "the request said back with a mark, and notes in brackets, are no answer");
        let mut titled = whole.clone();
        titled["response"]["body"]["note"] = json!("Try a shorter word, or browse our collections");
        assert!(!lists_nothing_walked(&titled, &asked, None, Some(&Walked::of(&sent, None))), "words of the site's own beside the empty place");
        let unasked = json!({ "names": ["PX-1x7o"], "bucket": "search.cache" });
        assert!(!lists_nothing_walked(&unasked, &asked, None, Some(&walked)), "a call that says nothing of the ask answers something else");
    }

    /// An answer that is one record, an object and no list of records, is an answer: an invite asked by its code says
    /// the code back and holds its inviter, its server, its channel, each with an id, a name and counts of its own,
    /// beside empty lists of the server's traits. Read as an empty answer's bookkeeping it was said `answered_empty`
    /// (a live invite, read as nothing). The empty answer's bookkeeping stays nothing: a cache's name beside its bucket,
    /// a query's time beside its flags, one or two values of their own to an object.
    #[test]
    fn an_answer_that_is_one_record_is_an_answer() {
        let url = "https://chat.example/api/invites/Qx7Lm2Pa?with_counts=true";
        let invite = json!({ "type": 0, "code": "Qx7Lm2Pa", "expires_at": null,
            "inviter": { "id": "281937465019283746", "username": "harbour", "avatar": "9f8e7d6c5b4a39281706f5e4d3c2b1a0", "public_flags": 0 },
            "guild": { "id": "1029384756102938475", "name": "Kilns", "icon": "0a1b2c3d4e5f60718293a4b5c6d7e8f9", "features": ["GUILD_ONBOARDING_EVER_ENABLED"], "verification_level": 1, "nsfw": false },
            "channel": { "id": "1029384756102938476", "type": 0, "name": "welcome" },
            "profile": { "id": "1029384756102938475", "name": "Kilns", "member_count": 4211, "online_count": 389, "traits": [], "features": [] },
            "approximate_member_count": 4211, "approximate_presence_count": 389 });
        let e = ex("GET", url, 200, &invite.to_string());
        assert!(!lists_nothing_walked(&invite, &["Qx7Lm2Pa"], None, Some(&Walked::of(&e, None))), "one record, with values of its own");
        // Its fields all sent back, or placeholders, or zero: no record of its own.
        let bare = json!({ "code": "Qx7Lm2Pa", "guild": { "id": "Qx7Lm2Pa", "name": "(unknown)", "count": 0 }, "traits": [] });
        assert!(lists_nothing_walked(&bare, &["Qx7Lm2Pa"], None, Some(&Walked::of(&ex("GET", url, 200, &bare.to_string()), None))), "nothing of its own");
        // A search's empty envelope, as the live one is built: its account of the request holds many values of its own
        // to an object (a session, the client characterized, the parameters as finalized), each object saying back
        // what the request sent, in it or below it, or a placeholder. That is the request's account, never a record.
        let call = "https://lib.example/services/search/page?user_query=qzxv&hits_per_page=100&page=1&uid=R:8f2a01c4be93d77e0a51-S:1c9e44b0a7d2f3e58b16-P:1-K:h-T:1794700000000";
        let agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
        let uid = "R:8f2a01c4be93d77e0a51-S:1c9e44b0a7d2f3e58b16-P:1-K:h-T:1794700000000";
        let envelope = json!({ "uid": uid, "version": "beta", "elapsed_secs": 0.48,
            "session_context": { "session_key": "anon1", "created": "2026-11-16T00:00:00Z", "username": "(guest user)", "authentication_method": "cookie",
                "client_characterization": { "characterized_by": "via_forwarded_for_header_chain", "client_ip": "203.0.113.7:sra", "client_useragent": format!("{agent}:sua"), "client_id": "203.0.113.7:sra:cid" } },
            "request": { "client_request_parameters": { "client": "lib_search_client_pilot_web", "user_query": "qzxv", "hits_per_page": 100, "page": 1, "uid": uid },
                "backend_requests": { "search": { "finalized_parameters": { "client": "lib_search_client_pilot_web", "user_query": "(redacted)", "hits_per_page": 100, "page": 1, "uid": uid, "page_type": "search_results", "aggregations_size": 10, "service_backend": "fts_main", "scope": "metadata", "service": "search__fulltext__main_backend" } } } },
            "response": { "header": { "succeeded": true, "query_time": 328, "forensics": { "routing": { "backend": "fts-main-clusterserving-metadata", "backend_server": "fts-main-node-7-14", "index_addressed": "(cannot determine without hits)" } } },
                "body": { "hits": { "total": 0, "returned": 0, "hits": [] } }, "hit_schema": [] } });
        let mut sent = ex("GET", call, 200, &envelope.to_string());
        sent.request_headers = vec![("User-Agent".into(), agent.into())];
        assert!(lists_nothing_walked(&envelope, &["qzxv"], None, Some(&Walked::of(&sent, None))), "the request's account lists nothing");
    }

    /// The walk that exposed it, as a first learn: a search page rendered on the server for a value it has nothing for
    /// says so under its headings, and links only from its frame: a heading's word (`Filter by category`), its
    /// sponsors after the main part, its footer. Read alone, those links were the answer's records. Judged by how the
    /// page is built, it lists nothing; the same page with results, even one, or with lines naming the value, or with
    /// picks of its own, lists something.
    #[test]
    fn a_page_that_says_only_the_ask_back_under_its_headings_lists_nothing() {
        let page = |q: &str, found: &str| {
            format!(
                "<!doctype html><html><head><title>Search</title></head><body><a href=\"#content\">Skip to main content</a><header><nav><a href=\"/\">Home</a></nav></header>\
                 <main id=\"content\"><div class=\"panel\"><h2>Filter by <a href=\"/categories/\">category</a></h2><form><ul><li><input type=\"checkbox\" id=\"c1\"><label for=\"c1\">Lamps</label></li><li><input type=\"checkbox\" id=\"c2\"><label for=\"c2\">Rugs</label></li></ul><button>Apply</button></form></div>\
                 <div><h2>Search results</h2><form action=\"/search/\"><p><strong>{n}</strong> items for \"{q}\"</p><label for=\"o\">Order by</label><select id=\"o\"><option>Relevance</option></select></form>{found}</div></main>\
                 <footer><a href=\"/help/\">Help</a></footer><div class=\"sponsors\"><a href=\"https://sponsor-one.example/\"><span>Sponsor One</span><span>Gold sponsor</span></a><a href=\"https://sponsor-two.example/\"><span>Sponsor Two</span></a></div><a href=\"/sitemap/\">Site map</a></body></html>",
                n = if found.is_empty() { 0 } else { 4 }
            )
        };
        let read = |body: &str, q: &str| {
            let url = format!("https://shop.example/search/?q={q}");
            let e = Exchange { response_mime: "text/html".into(), ..ex("GET", &url, 200, body) };
            let data = crate::page::read(body, &e.url);
            let nothing = lists_nothing_walked(&data, &[q], None, Some(&Walked::of(&e, None)));
            (lists_nothing(&data, &[q]), nothing)
        };
        let none = page("qzxv", "<div class=\"callout\"><p>We found nothing for 'qzxv'</p></div>");
        assert_eq!(read(&none, "qzxv"), (false, true), "alone its frame's links were records; built as it is, it lists nothing");
        let card = |name: &str| format!("<a class=\"card\" href=\"/item/{name}/\"><h3><span>{name}</span><span>Nov 2026</span></h3><p>A {name} for the reading corner.</p></a>");
        let four: String = ["brass-lamp", "desk-lamp", "floor-lamp", "lamp-shade"].iter().map(|n| card(n)).collect();
        assert!(!read(&page("lamp", &four), "lamp").1, "results");
        assert!(!read(&page("lamp", &card("brass-lamp")), "lamp").1, "one result is a result");
        let lines = "<ul><li>lamp oil, 1 l</li><li>lamp wick, cotton</li><li>lamp glass, clear</li></ul>";
        assert!(!read(&page("lamp", lines), "lamp").1, "lines that name the value, at three places");
        let picks = "<div class=\"callout\"><p>We found nothing for 'qzxv'</p></div><ul><li><a href=\"/item/rug/\">A wool rug</a></li></ul>";
        assert!(!read(&page("qzxv", picks), "qzxv").1, "picks of its own are things it lists");
        assert!(!read(&none, "").1, "a page asked no value says nothing back");
    }

    fn ex(method: &str, url: &str, status: u16, body: &str) -> Exchange {
        Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status,
            response_headers: vec![],
            response_body: (!body.is_empty()).then(|| body.to_string()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        }
    }

    /// The error answers of two APIs, each served with 200: the site said it failed, and said why.
    #[test]
    fn an_answer_that_says_it_failed_is_no_answer() {
        let limited = json!({ "error": { "status": { "error_code": 10012, "error_message": "Public API users are limited to querying historical data within the past 365 days" } } });
        assert!(said_failure(&limited).is_some_and(|m| m.contains("365 days")), "{:?}", said_failure(&limited));
        let keyless = json!({ "Response": "Error", "Message": "You need a valid auth key or api key to access this endpoint", "HasWarning": false, "Type": 1, "RateLimit": {}, "Data": {} });
        assert!(said_failure(&keyless).is_some_and(|m| m.contains("valid auth key")));
        let graphql = json!({ "data": null, "errors": [{ "message": "Cannot query field" }] });
        assert_eq!(said_failure(&graphql).as_deref(), Some("Cannot query field"));
        // Every field asked for came back null: refused, however the answer names them.
        let refused = json!({ "errors": [{ "message": "Access denied", "extensions": {} }], "data": { "searchPosts": null } });
        assert_eq!(said_failure(&refused).as_deref(), Some("Access denied"));
        // The field asked for is null under the object it hangs from, which names only itself: nothing was answered.
        let limited = json!({ "data": { "search": { "id": "U2VhcmNo", "videos": null, "__typename": "Search" } }, "errors": [{ "message": "Maximum attempts reached. Please try again later.", "path": ["search", "videos"], "type": "too_many_requests" }] });
        assert!(said_failure(&limited).is_some_and(|m| m.contains("Maximum attempts")));
        let named = json!({ "data": { "search": { "id": "U2VhcmNo", "total": 3, "videos": null } }, "errors": [{ "message": "videos timed out" }] });
        assert!(said_failure(&named).is_none(), "a count beside the failed field is an answer");
        // One field failed beside one that answered: a partial result is still an answer.
        let partial = json!({ "errors": [{ "message": "Timeout" }], "data": { "ads": null, "posts": [{ "title": "a" }] } });
        assert_eq!(said_failure(&partial), None);
        // A gateway that answers 200 with its outcome as a list of codes, under a name of its own, and an empty data
        // member: the code says it failed (a search kept as a route answered "the token is empty" to every call).
        let coded = json!({ "api": "shop.search.recommend", "data": {}, "ret": ["FAIL_SYS_TOKEN_EMPTY::the token is empty"], "traceId": "d74c5c5217943804162331588e6264", "v": "1.0" });
        assert!(said_failure(&coded).is_some(), "{:?}", said_failure(&coded));
        assert!(said_failure(&json!({ "api": "shop.search.recommend", "data": { "items": [1] }, "ret": ["SUCCESS::ok"], "v": "1.0" })).is_none());
        assert!(said_failure(&json!({ "note": "the build failed to start", "name": "nightly" })).is_none(), "a sentence is not a code");
        // Data beside an error is a partial answer, and an error member that holds nothing is no error.
        assert!(said_failure(&json!({ "data": { "items": [1] }, "errors": [{ "message": "one field failed" }] })).is_none());
        assert!(said_failure(&json!({ "error": null, "results": [] })).is_none());
        assert!(said_failure(&json!({ "status": "ok", "count": 0 })).is_none());
        assert!(said_failure(&json!([{ "error": "a row about errors" }])).is_none());
        // A record whose own status is a failure, or that keeps an error field among its own, is the record.
        assert!(said_failure(&json!({ "id": 7, "status": "failed", "name": "nightly build" })).is_none());
        assert!(said_failure(&json!({ "id": 7, "error": "compile failed", "name": "nightly", "started": "2026-10-01", "ended": "2026-10-01" })).is_none());
    }

    /// An answer wrapped in the name its address asked for is read like any other: a failure inside it is no answer.
    #[test]
    fn a_failure_wrapped_in_its_callback_is_no_answer() {
        let body = r#"cb7({"api":"shop.search.recommend","data":{},"ret":["FAIL_SYS_TOKEN_EMPTY::the token is empty"],"v":"1.0"})"#;
        let failed = ex("GET", "https://api.shop.example/h5/search/1.0/?callback=cb7&q=flask", 200, body);
        assert!(not_an_answer(&failed, false).is_some_and(|w| w.contains("says it failed")), "{:?}", not_an_answer(&failed, false));
        let fine = ex("GET", "https://api.shop.example/h5/search/1.0/?callback=cb7&q=flask", 200, r#"cb7({"data":{"items":[{"name":"flask"}]},"ret":["SUCCESS::ok"]})"#);
        assert!(not_an_answer(&fine, false).is_none());
    }

    /// A site's error page opens with its menus, far past where a message is cut. Its headings say what it is, so they
    /// go first: an agent can tell a search with nothing to show from a broken call.
    #[test]
    fn a_page_says_its_headings_before_its_menus() {
        let menu = "<a href=/a>Skip to content</a> ".to_string() + &"<a href=/b>Recipes</a> ".repeat(100);
        let page = format!("<html><head><title>[zqx] Results</title></head><body><nav>{menu}</nav><main><h1>Search Results For</h1><h2>0 results found for your search.</h2></main></body></html>");
        let said = site_said(&page);
        assert!(said.contains("0 results found for your search."), "{said}");
        assert!(said.chars().count() <= 301);
    }

    /// A refusal, a HEAD, a redirect, an empty body, a challenge and an error said in the site's words are never an
    /// answer a read is learned from; a write may answer with nothing.
    #[test]
    fn a_route_is_never_learned_from_a_response_that_is_no_answer() {
        let refused = not_an_answer(&ex("GET", "https://api.example.com/repos/a/b", 403, r#"{"message":"API rate limit exceeded for 10.0.0.1."}"#), false);
        assert!(refused.as_deref().is_some_and(|m| m.contains("403") && m.contains("API rate limit exceeded")), "{refused:?}");
        let missing = not_an_answer(&ex("GET", "https://www.example.com/address/f0123", 404, "<html><head><title>Page not found</title></head><body>Not here</body></html>"), false);
        assert!(missing.as_deref().is_some_and(|m| m.contains("404") && m.contains("Page not found")), "{missing:?}");
        assert!(not_an_answer(&ex("HEAD", "https://www.example.com/pricing", 200, ""), false).is_some());
        assert!(not_an_answer(&ex("GET", "https://www.example.com/pricing", 200, ""), false).is_some());
        assert!(not_an_answer(&ex("GET", "https://www.example.com/old", 301, ""), false).is_some());
        // A bot check served with 202, and an answer still being computed: the request taken, the answer held back.
        assert!(not_an_answer(&ex("GET", "https://html.duckduckgo.com/html/?q=rust", 202, "<html><body>Unfortunately, bots use DuckDuckGo too.</body></html>"), false).is_some());
        assert!(not_an_answer(&ex("GET", "https://api.github.com/repos/a/b/stats/contributors", 202, "{}"), false).is_some());
        assert!(not_an_answer(&ex("GET", "https://api.example.com/v3/coins/x/history", 200, r#"{"error":{"status":{"error_code":10012,"error_message":"limited to the past 365 days"}}}"#), false).is_some());
        assert!(not_an_answer(&ex("POST", "https://www.example.com/__challenge/verify", 200, r#"{"token":"abc"}"#), false).is_some());
        // An answer, and a write that answers with nothing.
        assert!(not_an_answer(&ex("GET", "https://api.example.com/items?q=a", 200, r#"{"items":[{"id":1}]}"#), false).is_none());
        assert!(not_an_answer(&ex("POST", "https://www.example.com/api/messages", 204, ""), true).is_none());
    }

    /// A page the site sent the reader to that names the asked page to come back to is a detour, whatever it is
    /// called; the same page reached by a canonical redirect is not.
    #[test]
    fn a_page_that_names_the_asked_one_to_come_back_to_is_a_detour() {
        let asked = url::Url::parse("https://old.reddit.com/search?q=browserbase&sort=top").unwrap();
        let login = url::Url::parse("https://old.reddit.com/login/?reason=lor2&dest=https%3A%2F%2Fold.reddit.com%2Fsearch%3Fq%3Dbrowserbase").unwrap();
        assert!(detour(&asked, &login));
        let canonical = url::Url::parse("https://old.reddit.com/search/?q=browserbase&sort=top").unwrap();
        assert!(!detour(&asked, &canonical));
        let elsewhere = url::Url::parse("https://www.example.com/items?page=2").unwrap();
        assert!(!detour(&url::Url::parse("https://www.example.com/items").unwrap(), &elsewhere));
        // A review site's next page of reviews, opened signed out, sent to the sign-in on its sister domain.
        let page = url::Url::parse("https://www.glassdoor.sg/Reviews/Open-Government-Products-Reviews-E2503777_P2.htm?sort.sortType=RD&sort.ascending=false").unwrap();
        let login = url::Url::parse("https://www.glassdoor.com/member/profile/login?reason=bot-detection&postLoginUrl=https%3A%2F%2Fwww.glassdoor.sg%2FReviews%2FOpen-Government-Products-Reviews-E2503777_P2.htm%3Fsort.sortType%3DRD").unwrap();
        assert!(detour(&page, &login));
        // A registrar's control panel sends to its sign-in on another host of the site, naming the panel by its path.
        let panel = url::Url::parse("https://ap.www.namecheap.com/domains/domaincontrolpanel/example.si/domain").unwrap();
        let signin = url::Url::parse("https://www.namecheap.com/myaccount/login/?ReturnUrl=%2fdomains%2fdomaincontrolpanel%2fexample.si%2fdomain").unwrap();
        assert!(detour(&panel, &signin));
        // The front page's path is in every address: only another site's whole address, or a path below the front, names it.
        let home = url::Url::parse("https://www.example.com/").unwrap();
        assert!(!detour(&home, &url::Url::parse("https://www.example.com/search?from=/").unwrap()));
        assert!(!detour(&panel, &url::Url::parse("https://other.example/login?next=/domains/domaincontrolpanel/example.si/domain").unwrap()), "another site's path is its own");
    }

    /// A feed, a sitemap, Markdown and plain text are answers as text; a picture is not.
    #[test]
    fn a_plain_data_body_is_an_answer_as_text() {
        let rss = text_answer("application/rss+xml; charset=utf-8", "<?xml version=\"1.0\"?><rss><channel><item><title>A</title></item></channel></rss>").unwrap();
        assert_eq!(rss["content_type"], "application/rss+xml");
        assert!(rss["text"].as_str().unwrap().contains("<item>"));
        assert!(text_answer("text/markdown", "# Docs\n\n- [Intro](/intro)").is_some());
        assert!(text_answer("text/plain", "# llms.txt\n> what the site is").is_some());
        assert!(text_answer("application/xml", "<urlset><url><loc>https://example.com/</loc></url></urlset>").is_some());
        assert!(text_answer("image/png", "\u{89}PNG").is_none());
        assert!(text_answer("text/plain", "  ").is_none());
    }

    fn step(method: &str, status: u16) -> Step {
        serde_json::from_value(json!({ "exchange": 0, "method": method, "status": status, "url": "https://html.example.com/html/?q={q}", "fields": [], "needs_browser": false })).unwrap()
    }

    /// A read whose replay comes back as a challenge served with another 2xx than the walk saw, as an error said in
    /// the site's words with 200, or as nothing, is a failed call; the same answer the walk saw is not.
    #[test]
    fn a_replayed_read_that_gets_no_answer_back_fails() {
        let asked = url::Url::parse("https://html.example.com/html/?q=rust").unwrap();
        let challenge = ex("GET", asked.as_str(), 202, "<html><body>Unfortunately, bots use this site too. Select all squares containing a duck</body></html>");
        let why = replayed_not_an_answer(&step("GET", 200), &asked, &challenge);
        assert!(why.as_deref().is_some_and(|w| w.contains("202") && w.contains("200")), "{why:?}");
        let error = ex("GET", asked.as_str(), 200, r#"{"Response":"Error","Message":"API key required","Data":{}}"#);
        assert!(replayed_not_an_answer(&step("GET", 200), &asked, &error).is_some_and(|w| w.contains("API key required")));
        assert!(replayed_not_an_answer(&step("GET", 200), &asked, &ex("GET", asked.as_str(), 200, "")).is_some());
        let mut detoured = ex("GET", asked.as_str(), 200, "<html><body>Sign in</body></html>");
        detoured.url = url::Url::parse("https://html.example.com/login?next=%2F%2Fhtml.example.com%2Fhtml%2F").unwrap();
        assert!(replayed_not_an_answer(&step("GET", 200), &asked, &detoured).is_some());
        // The answer the walk saw, and a write, which its ledger judges.
        assert!(replayed_not_an_answer(&step("GET", 200), &asked, &ex("GET", asked.as_str(), 200, r#"{"results":[1]}"#)).is_none());
        assert!(replayed_not_an_answer(&step("DELETE", 200), &asked, &ex("DELETE", asked.as_str(), 202, "")).is_none());
    }
    /// A search that finds nothing answered with a 404 page saying so ("zqxjvbnmqw free download - … no results") found
    /// nothing; a 404 that names nothing asked, or a write's 404, did not. The page that exposed it: a software
    /// directory's search, whose no-results page is served as 404 (2026-11-06; a recipe site did the same on 11-02).
    #[test]
    fn a_search_that_finds_nothing_answered_404_found_nothing() {
        let step: Step = serde_json::from_value(json!({ "exchange": 0, "method": "GET", "status": 200, "url": "https://soft.example/directory/?q={q}", "needs_browser": false, "response_shape": null, "fields": [] })).unwrap();
        let page = |body: &str| { let mut e = ex("GET", "https://soft.example/directory/?q=zqxjvbnmqw", 404, body); e.response_mime = "text/html".into(); e };
        let asked: std::collections::HashMap<String, String> = [("q".to_string(), "zqxjvbnmqw".to_string())].into();
        assert!(found_nothing(&step, &asked, &page("<html><head><title>zqxjvbnmqw free download</title></head><body><p>No results for zqxjvbnmqw</p></body></html>")));
        assert!(!found_nothing(&step, &asked, &page("<html><head><title>Not Found</title></head><body><p>This page moved.</p></body></html>")));
        let mut write = step.clone();
        write.method = "POST".into();
        assert!(!found_nothing(&write, &asked, &page("<html><body>No results for zqxjvbnmqw</body></html>")));
    }


    /// The walk that exposed it: a lost session's `/secure` redirects to `/login`, which answers 200 with a form. Nothing
    /// names the page asked for, so only where it landed says so. A page that moved elsewhere, or a sign-in page asked for
    /// by name, is a page like any other.
    #[test]
    fn a_read_sent_to_a_password_form_has_lost_its_session() {
        let asked = url::Url::parse("https://shop.example/secure").unwrap();
        let form = "<html><body><form><input name=u><input type=password name=p></form></body></html>";
        let mut got = ex("GET", "https://shop.example/login", 200, form);
        got.response_mime = "text/html".into();
        assert!(replayed_not_an_answer(&step("GET", 200), &asked, &got).is_some_and(|w| w.contains("password")));
        let at_login = url::Url::parse("https://shop.example/login").unwrap();
        assert_eq!(replayed_not_an_answer(&step("GET", 200), &at_login, &got), None, "the sign-in page itself, asked for");
        let mut moved = ex("GET", "https://shop.example/new-home", 200, "<html><body><h1>Lamps</h1></body></html>");
        moved.response_mime = "text/html".into();
        assert_eq!(replayed_not_an_answer(&step("GET", 200), &asked, &moved), None, "a page that moved is still the page");
    }

    /// A feed served as one line of XML reads as its items, each by its children's texts: RSS's items, Atom's entries
    /// (a link written as an attribute read by its href), and any list of repeated elements with children. A text
    /// with no repeated element of its own reads as no records.
    #[test]
    fn a_feed_is_read_by_its_items() {
        let rss = r#"<?xml version="1.0"?><rss><channel><title>zig - News</title><item><title>Zig 0.14 released</title><link>https://a.example/1</link><pubDate>Mon</pubDate></item><item><title>Why we chose Zig</title><link>https://b.example/2</link></item><item><title><![CDATA[Zig &amp; C]]></title></item></channel></rss>"#;
        let r = markup_records(rss).expect("records");
        let titles: Vec<&str> = r["records"].as_array().unwrap().iter().filter_map(|x| x["title"].as_str()).collect();
        assert_eq!(titles, ["Zig 0.14 released", "Why we chose Zig", "Zig & C"]);
        assert_eq!(r["records"][0]["link"], "https://a.example/1");
        let atom = "<feed xmlns=\"http://www.w3.org/2005/Atom\"><title>t</title>\n<entry><title>One rust post</title><link href=\"https://c.example/1\"/><author><name>A</name></author></entry>\n<entry><title>Two rust posts</title><link href=\"https://c.example/2\"/><author><name>B</name></author></entry></feed>";
        let a = markup_records(atom).expect("records");
        assert_eq!(a["records"].as_array().unwrap().len(), 2);
        assert_eq!((a["records"][1]["title"].as_str(), a["records"][1]["link"].as_str()), (Some("Two rust posts"), Some("https://c.example/2")));
        let list = "<results><row><name>lamp</name></row><row><name>jar</name></row></results>";
        assert_eq!(markup_records(list).unwrap()["records"][1]["name"], "jar");
        assert!(markup_records(r#"<?xml version="1.0"?><rss><channel><title>nothing - News</title></channel></rss>"#).is_none());
    }

    /// An answer that is only a pointer to a page names that page; one with a second address, a long value or anything
    /// structured carries more than a pointer, and names none.
    #[test]
    fn an_answer_that_only_points_to_a_page_names_it() {
        let p = |v: Value| pointer_url(&v);
        assert_eq!(p(serde_json::json!({ "rgv587_flag": "sm", "url": "https://deny.example/t.html?action=deny" })).as_deref(), Some("https://deny.example/t.html?action=deny"));
        assert_eq!(p(serde_json::json!({ "go": "http://a.example/", "n": 3, "ok": true, "x": null })).as_deref(), Some("http://a.example/"));
        assert!(p(serde_json::json!({ "a": "https://a.example/", "b": "https://b.example/" })).is_none(), "two addresses");
        assert!(p(serde_json::json!({ "url": "https://a.example/", "why": "a sentence longer than any short word or flag would be" })).is_none(), "a long value");
        assert!(p(serde_json::json!({ "url": "https://a.example/", "items": [] })).is_none(), "something structured");
        assert!(p(serde_json::json!({ "flag": "sm" })).is_none() && p(serde_json::json!({})).is_none() && p(serde_json::json!([1])).is_none(), "no address");
        assert!(p(serde_json::json!({ "a": 1, "b": 2, "c": 3, "d": 4, "url": "https://a.example/" })).is_none(), "too many members");
    }
}
