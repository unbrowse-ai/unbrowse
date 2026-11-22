//! Running a route (PRD US-017, FR-8, FR-31): the graph replays over a Chrome-shaped transport with the node's
//! jar, the site's own page is walked again if the site has drifted, and every call is logged with its result.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use unbrowse_learn::screencast::FrameSink;

use serde::Serialize;
use unbrowse_learn::RouteClient;

use crate::learn::own_asks;
use crate::store::{self, Activity};

#[derive(Serialize)]
pub struct CallResult {
    pub ok: bool,
    pub ms: u64,
    /// The route's answer: the target's JSON, cut down if it is large.
    pub data: Option<serde_json::Value>,
    pub error: Option<String>,
    /// Whether the site may now hold something this call wrote. A failed write that reached the site is never sent
    /// again by the node, so the agent must check before it retries.
    #[serde(default)]
    pub possible_commit: bool,
    /// What the caller may do next: `as_is` (retry as it was), `check_first` (ask the site what it holds), or
    /// `never` (the write landed).
    #[serde(default)]
    pub retry: Option<unbrowse_learn::Retry>,
    /// The rule the call ran under refused one of its requests before it was sent, or the redirect a request led to,
    /// and why (R2.28): the call never got where it was going, so it makes no line. Said to the caller in `error`;
    /// this is the node's own mark of it.
    #[serde(skip)]
    pub refused: Option<String>,
    /// How a failed call failed, as a bug report may say it (`failure_variant`): its variant, step and status, and
    /// nothing the site said. None when it passed. The node's own mark, never said to the caller.
    #[serde(skip)]
    pub variant: Option<String>,
    /// When the answer was over the reply's size and was cut down: where, how much, and where the whole of it is.
    /// None when `data` is the whole answer.
    #[serde(default)]
    pub truncated: Option<Truncated>,
    /// Which of the answer's fields `data` carries, and every other one the caller can add by its path
    /// (`unbrowse_learn::fields`). None when the call failed.
    #[serde(default)]
    pub fields: Option<unbrowse_learn::fields::Shown>,
    /// The inputs that read on to the list's next page, by name: None when the route doesn't page, or the answer says
    /// the list ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub more: Option<HashMap<String, String>>,
    /// Whether the call opened the node's browser at all (a heal, a walled step or a signing page). The measure the
    /// browserless work is judged by: a warm route should answer with this false.
    #[serde(default)]
    pub browser: bool,
    /// What the call fell back on and why, in order (`RouteClient::fell_back`): said in the reply's notes, so a route
    /// that answers only through a fallback says so each time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fell_back: Vec<String>,
    /// Why the sandbox ran no page's code for this call, where that is why it was skipped (`RouteClient::unheld`):
    /// the reply names it as the sandbox's reader said it (`outcome::held_back`).
    #[serde(skip)]
    pub unheld: Option<unbrowse_learn::sandbox::Unheld>,
    /// The route the call was answered by, where the route it was made of found the site drifted and was learned
    /// again from its plan, as a new route that took its place (`learn::learned_again`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub learned_again: Option<String>,
    /// How many records the answer holds where this route's records were seen (`Heard::records_at`), read on the
    /// answer whole, as the site sent it and as a confirming browse read it, before the reply chose its fields or cut
    /// it (`records_where_seen`): `Some(Some(0))` is the site finding nothing, `Some(None)` an answer without that
    /// place, None a route with no place seen. The reply says it as `records`.
    #[serde(skip)]
    pub records: Option<Option<usize>>,
}

/// How much answer a reply carries, at most: a ceiling, not a default. It bounds what one reply costs an agent's
/// context. An answer over it is cut down, the fields the caller named kept first, never silently: the reply's
/// `truncated` says which lists and texts were cut, how many of each were kept, the field paths under them to name
/// for less, the next page's inputs, and where the whole answer was kept, and the reply answers `answered_cut`. The
/// fields a reply leaves out by default (`fields.more`, `fields.copies`) are no cut: that reply still answers. The
/// ceiling is hard and holds the whole reply as the agent is handed it: where even the fields kept don't fit beside
/// what the reply says around them, records are cut too, whole ones from the front (`held_to_ceiling`).
pub const REPLY_BUDGET: usize = 32 * 1024;

/// A list or a text the reply cut: at its JSON pointer in `data`, `kept` of its `total` items or characters.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Cut {
    pub at: String,
    pub kept: usize,
    pub total: usize,
    /// `items` for a list, `chars` for a text.
    pub unit: &'static str,
}

/// An answer the reply cut down to `REPLY_BUDGET`.
#[derive(Clone, Debug, Serialize)]
pub struct Truncated {
    /// The answer's size as the reply carries it, and whole, as JSON bytes.
    pub kept_bytes: usize,
    pub total_bytes: usize,
    /// The lists and texts cut, outermost first (the first 20).
    pub cuts: Vec<Cut>,
    /// The whole answer, as a file on the node's machine, when it could be kept.
    pub whole: Option<String>,
    /// The fields under what was cut, each by the path to name in `fields` for a call that brings it alone, so fewer
    /// fields fit (at most `fields::MORE_LISTED`).
    pub left_out: Vec<String>,
    /// The inputs that read on to the list's next page, when the route pages and the answer says there is one.
    pub next_page: Option<HashMap<String, String>>,
    pub note: String,
}

impl Truncated {
    /// What a reply cut to `REPLY_BUDGET` says of it: the cuts `fit_reply` made, the fields under them, the next page
    /// (`next_page`), and the whole answer, kept as a file for `route`.
    fn of(route: &str, (kept_bytes, total_bytes, cuts, all): (usize, usize, Vec<Cut>, serde_json::Value), next_page: Option<HashMap<String, String>>) -> Truncated {
        let whole = keep_whole(route, &all);
        let left_out = left_out(&all, &cuts);
        Truncated::said(kept_bytes, total_bytes, cuts, whole, left_out, next_page, &all)
    }

    /// The same, its note written: how big the answer is, the records the outermost cut list kept of how many, and
    /// each way to have the rest that there is: fewer fields (when more than one is under the cut), the next page,
    /// the whole answer's file, a narrower ask.
    fn said(kept_bytes: usize, total_bytes: usize, cuts: Vec<Cut>, whole: Option<String>, left_out: Vec<String>, next_page: Option<HashMap<String, String>>, all: &serde_json::Value) -> Truncated {
        let mut ask = Vec::new();
        // One field under the cut is no fewer to name: its next page, or the whole answer, has the rest.
        if left_out.len() > 1 {
            ask.push(format!("call again with fields naming only some of the paths in left_out ({})", left_out.iter().take(3).cloned().collect::<Vec<_>>().join(", ")));
        }
        if let Some(next) = next_page.as_ref() {
            let mut inputs: Vec<String> = next.iter().map(|(k, v)| format!("{k}={v}")).collect();
            inputs.sort();
            ask.push(format!("call again with next_page's inputs ({}) for the next page", inputs.join(", ")));
        }
        if let Some(p) = whole.as_ref() {
            ask.push(format!("read the whole answer in {p} on the node's machine"));
        }
        ask.push("ask the route for less: a smaller page or a narrower query".to_string());
        let ask = format!(" To have what was left out: {}.", ask.join("; or "));
        let records = cuts
            .iter()
            .find(|c| c.unit == "items")
            .map(|c| {
                let at = pointer_path(all, &c.at);
                format!(" The reply kept {} of {} records{}, each whole.", c.kept, c.total, if at.is_empty() { String::new() } else { format!(" ({at})") })
            })
            .unwrap_or_default();
        let note = format!(
            "The answer is {} KB, over the {} KB a reply carries: each list and text in cuts keeps only its first kept items or characters.{records}{ask}",
            total_bytes / 1024,
            REPLY_BUDGET / 1024,
        );
        Truncated { kept_bytes, total_bytes, cuts, whole, left_out, next_page, note }
    }
}

/// A reply as it leaves the node, held to `REPLY_BUDGET` whole: its text, as an agent is handed it (compact JSON, the
/// MCP text and the HTTP body alike), never over the ceiling. Each answer in it (an object with `ok` and `data`: a
/// call's reply, a do's `result`, each page of several) carries its data cut to the ceiling already, and the reply
/// around it (the fields it lists, the route, the notes, what was cut) is more: where that takes the reply over, the
/// answers are cut again, each by its share of what is over, whole records kept from the front (`fit`). What was cut
/// is said as any cut is (`truncated`: the records kept of how many, the field paths under them, the next page's
/// inputs, the whole answer's file), and an answer that answered says `answered_cut`.
pub(crate) fn held_to_ceiling(reply: &mut serde_json::Value) {
    // Room for what a cut adds to the reply (its `truncated`, the note) beside what is over.
    const SAYING: usize = 2048;
    let mut answers = false;
    for _ in 0..8 {
        let over = size(reply).saturating_sub(REPLY_BUDGET);
        if over == 0 {
            return;
        }
        let mut at = Vec::new();
        answers_in(reply, String::new(), &mut at);
        let sizes: Vec<usize> = at.iter().map(|p| reply.pointer(p).map(|a| size(&a["data"])).unwrap_or(0)).collect();
        let sum: usize = sizes.iter().sum();
        if sum == 0 {
            break;
        }
        answers = true;
        let mut cut = false;
        for (p, s) in at.iter().zip(&sizes) {
            let share = ((over + SAYING) as u128 * *s as u128 / sum as u128) as usize + 1;
            let from = match p.as_str() {
                "" => "call.truncated",
                "/result" => "result.truncated",
                _ => "truncated",
            };
            let this = reply.pointer_mut(p).is_some_and(|answer| cut_again(answer, s.saturating_sub(share), from));
            // The reply's own outcome is its answer's, when it has one answer (a call, a do's result).
            if this && p == "/result" {
                said_cut(reply, from);
            }
            cut |= this;
        }
        if !cut {
            break;
        }
    }
    if answers && size(reply) > REPLY_BUDGET {
        eprintln!("reply: {} bytes over the ceiling, none of them an answer's data", size(reply) - REPLY_BUDGET);
    }
}

/// The JSON pointers of the answers in `v` (objects with `ok` and `data`), outermost first; an answer's data is not
/// looked in.
fn answers_in(v: &serde_json::Value, at: String, out: &mut Vec<String>) {
    match v {
        serde_json::Value::Object(o) => {
            if o.get("ok").is_some_and(serde_json::Value::is_boolean) && o.get("data").is_some_and(|d| !d.is_null()) {
                out.push(at);
                return;
            }
            for (k, x) in o {
                answers_in(x, format!("{at}/{}", k.replace('~', "~0").replace('/', "~1")), out);
            }
        }
        serde_json::Value::Array(a) => a.iter().enumerate().for_each(|(i, x)| answers_in(x, format!("{at}/{i}"), out)),
        _ => {}
    }
}

/// An answer that answered says it was cut, as `from` read it; one that came to anything else keeps what it said.
fn said_cut(answer: &mut serde_json::Value, from: &str) {
    if matches!(answer["outcome"].as_str(), Some("answered" | "answered_empty")) {
        answer["outcome"] = serde_json::json!(crate::outcome::Outcome::AnsweredCut.word());
        answer["outcome_from"] = serde_json::json!(from);
    }
}

/// `answer`'s data cut again to `budget` (`fit`, whole records from the front), its `truncated` saying the cuts of
/// both times against the answer as it was whole: what each list held, the answer's whole size, its file; an answer
/// that answered says `answered_cut`, read by `from`. False when nothing could be cut.
fn cut_again(answer: &mut serde_json::Value, budget: usize, from: &str) -> bool {
    let data = answer["data"].take();
    let before = size(&data);
    let mut cuts = Vec::new();
    let kept = fit(data.clone(), budget, "", "", &[], &mut cuts);
    if size(&kept) >= before || cuts.is_empty() {
        answer["data"] = data;
        return false;
    }
    let old = answer.get("truncated").filter(|t| !t.is_null()).cloned();
    let old_cuts: Vec<Cut> = old
        .as_ref()
        .and_then(|t| t["cuts"].as_array())
        .map(|cs| {
            cs.iter()
                .filter_map(|c| {
                    let unit = match c["unit"].as_str()? {
                        "items" => "items",
                        "chars" => "chars",
                        _ => return None,
                    };
                    Some(Cut { at: c["at"].as_str()?.to_string(), kept: c["kept"].as_u64()? as usize, total: c["total"].as_u64()? as usize, unit })
                })
                .collect()
        })
        .unwrap_or_default();
    // A list cut before holds what it held whole; one cut first now held what the reply had of it.
    let mut merged: Vec<Cut> = cuts.iter().map(|c| Cut { total: old_cuts.iter().find(|o| o.at == c.at && o.unit == c.unit).map_or(c.total, |o| o.total), ..c.clone() }).collect();
    let earlier: Vec<Cut> = old_cuts.into_iter().filter(|o| !cuts.iter().any(|c| c.at == o.at) && kept.pointer(&o.at).is_some()).collect();
    merged.extend(earlier);
    merged.truncate(20);
    let whole = old.as_ref().and_then(|t| t["whole"].as_str().map(String::from)).or_else(|| keep_whole(answer["route_id"].as_str().unwrap_or("reply"), &data));
    let mut out = left_out(&data, &cuts);
    for p in old.as_ref().and_then(|t| t["left_out"].as_array()).into_iter().flatten().filter_map(|p| p.as_str()) {
        if !out.iter().any(|o| o == p) {
            out.push(p.to_string());
        }
    }
    out.truncate(unbrowse_learn::fields::MORE_LISTED);
    let pages = |v: &serde_json::Value| v.as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect::<HashMap<String, String>>()).filter(|m| !m.is_empty());
    let next_page = old.as_ref().and_then(|t| pages(&t["next_page"])).or_else(|| pages(&answer["more"]));
    let total_bytes = old.as_ref().and_then(|t| t["total_bytes"].as_u64()).map_or(before, |b| b as usize);
    let t = Truncated::said(size(&kept), total_bytes, merged, whole, out, next_page, &data);
    answer["data"] = kept;
    answer["truncated"] = serde_json::to_value(&t).unwrap_or_default();
    said_cut(answer, from);
    true
}

/// A JSON pointer in an answer as a field's path names it: each list's index read as `[]`, keys joined by `.`
/// (`/items/3/title` is `items[].title`).
fn pointer_path(v: &serde_json::Value, at: &str) -> String {
    let mut path = String::new();
    let mut here = Some(v);
    for part in at.split('/').skip(1) {
        let key = part.replace("~1", "/").replace("~0", "~");
        match here {
            Some(serde_json::Value::Array(a)) => {
                path.push_str("[]");
                here = key.parse::<usize>().ok().and_then(|i| a.get(i));
            }
            other => {
                if !path.is_empty() {
                    path.push('.');
                }
                path.push_str(&key);
                here = other.and_then(|o| o.get(&key));
            }
        }
    }
    path
}

/// The fields of `all` under the lists and texts cut, by their paths, the cut's own path where none sits under it.
fn left_out(all: &serde_json::Value, cuts: &[Cut]) -> Vec<String> {
    let fields = unbrowse_learn::fields::paths(all);
    let mut out: Vec<String> = Vec::new();
    for cut in cuts {
        let at = pointer_path(all, &cut.at);
        let under: Vec<String> = fields.iter().map(|f| f.path.clone()).filter(|p| at.is_empty() || p == &at || p.starts_with(&format!("{at}.")) || p.starts_with(&format!("{at}[]"))).collect();
        let found = if under.is_empty() && !at.is_empty() { vec![at] } else { under };
        for p in found {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out.truncate(unbrowse_learn::fields::MORE_LISTED);
    out
}

/// Numbers each call, so a window can pair a call's `end` with its `start` when many run at once.
static CALLS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A call as the window sees it: the light leaves the agent on `start` and the door answers on `end`.
#[derive(Clone, Serialize)]
pub struct CallEvent {
    /// The same on a call's `start` and its `end`.
    pub id: u64,
    pub phase: &'static str,
    pub route: String,
    pub site: String,
    pub what: String,
    pub agent: String,
    pub agent_index: Option<u32>,
    pub ok: Option<bool>,
    pub ms: Option<u64>,
    /// What the call paid, in USDC.
    pub paid_usdc: Option<f64>,
    /// The same as `paid_usdc`, under the name older windows and SDKs read.
    pub paid_unb: Option<f64>,
    pub at: u64,
    /// When, in milliseconds: a burst's wall time is read from these.
    pub at_ms: u64,
}

impl CallEvent {
    pub fn start(r: &store::Route, agent: &str, agent_index: Option<u32>) -> Self {
        CallEvent {
            id: CALLS.fetch_add(1, Ordering::Relaxed) + 1,
            phase: "start",
            route: r.id.clone(),
            site: r.site.clone(),
            what: r.what.clone(),
            agent: agent.to_string(),
            agent_index,
            ok: None,
            ms: None,
            paid_usdc: None,
            paid_unb: None,
            at: store::now(),
            at_ms: now_ms(),
        }
    }

    /// The same call answered.
    pub fn end(&self, res: &CallResult, paid: Option<f64>) -> Self {
        CallEvent { phase: "end", ok: Some(res.ok), ms: Some(res.ms), paid_usdc: paid, paid_unb: paid, at: store::now(), at_ms: now_ms(), ..self.clone() }
    }

    /// The same call, failed before the site answered (no such route, a missing input, the node's own error).
    pub fn failed(&self) -> Self {
        let ms = now_ms().saturating_sub(self.at_ms);
        CallEvent { phase: "end", ok: Some(false), ms: Some(ms), paid_usdc: None, paid_unb: None, at: store::now(), at_ms: now_ms(), ..self.clone() }
    }
}

/// `route` called with `inputs`, with a heal's re-walk (if the site has drifted) showing its pictures to `frames`.
/// The route runs as the caller was shown it and the vault was checked against: this record, not whatever is on
/// disk by the time it runs.
/// `fields` are the answer's fields the caller adds to the route's defaults, by path, or `*` for the whole answer.
/// `node` opens the vault, should the site need signing in again.
pub fn call_watched(route: store::Route, inputs: &crate::vault::Filled, who: &str, frames: Option<FrameSink>, fields: &[String], node: Option<std::sync::Arc<crate::Node>>) -> Result<CallResult, String> {
    call_with(route, inputs, who, frames, fields, node)
}

/// Calls route `id` with `inputs` for `who`. Blocking.
#[cfg(test)]
pub fn call(id: &str, inputs: &HashMap<String, String>, who: &str) -> Result<CallResult, String> {
    let route = store::load_route(id).ok_or_else(|| format!("no route {id}"))?;
    call_with(route, &crate::vault::Filled::plain(inputs.clone()), who, None, &[], None)
}

/// Calls the route, in the owner's own session: a node runs routes for its owner's agents only. Another contributor's
/// route runs here too, made from its body (`recipe::into_route`), under this owner's session for the site.
/// One plain ask of the site with `values`, reading only: what a learn-time probe makes (`learn::hears`).
pub(crate) fn asked_plainly(graph: &unbrowse_learn::Graph, values: &HashMap<String, String>) -> Option<serde_json::Value> {
    let mut client = RouteClient::new(graph.clone()).with_chrome_transport().with_session_store(store::jars_dir());
    client.call_with_ledger(values).0.ok()
}

/// Whether a route can be asked with nothing but plain calls and its answer taken as the site's word: it only reads,
/// no page makes its call, and the site has shown it hears its caller (two values, two answers), so it is not a
/// route that answers its walked request alone.
fn stands_by_itself(route: &store::Route) -> bool {
    // A route whose answer only the site's own code reads (a decoder on its body) cannot be asked plainly: a plain
    // client has no body, so it would read the raw ciphered reply. Such a route is run with its body.
    let decodes = route.body.as_ref().is_some_and(|b| b.answer.decode.is_some());
    !route.write && route.socket.is_none() && !route.browser_assisted && !route.graph.steps.iter().any(|s| s.is_page_signed()) && route.heard.probed && route.heard.deaf.is_empty() && !decodes
}

/// Whether a failed call is the site saying, in its plainest way, that nothing is at the address this value made: a
/// step answered "not found" or "gone". A door, a refusal, an answer in another shape or no answer at all says
/// something else, most often that the site will not answer this caller now.
fn says_nothing_is_there(e: &unbrowse_learn::ReplayError) -> bool {
    matches!(e, unbrowse_learn::ReplayError::Failed { status: 404 | 410, .. })
}

/// Whether `values` asks the route another value than the one it was learned on.
fn another_value(route: &store::Route, values: &HashMap<String, String>) -> bool {
    route.inputs.iter().any(|i| i.default.as_ref().is_some_and(|was| values.get(&i.name).is_some_and(|now| now != was)))
}

/// Whether the site still answers the route for the value it was learned on, asked once, plainly (`asks`): an answer
/// that holds something, with its list where the route's fields sit under one.
fn still_answers_its_own(route: &store::Route, asks: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> bool {
    let walked: HashMap<String, String> = route.inputs.iter().filter_map(|i| Some((i.name.clone(), i.default.clone()?))).collect();
    asks(&route.graph, &walked).is_some_and(|v| !v.is_null() && (route.fields.is_empty() || !unbrowse_learn::fields::frame_without_records(&v, &route.fields)))
}

/// Whether an answer that left its list out is the site finding nothing for the caller's value, and not the route's
/// own answer gone: the route only reads, the caller asked a value other than the one it was learned on, and asked
/// once more for the value it was learned on the site lists its records (`asks`). A route whose own page has lost its
/// list answers that ask with the frame too, and the failure stands. One plain ask, made only when a list is missing.
fn found_nothing(route: &store::Route, values: &HashMap<String, String>, asks: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> bool {
    if route.write || route.socket.is_some() {
        return false;
    }
    let walked: HashMap<String, String> = route.inputs.iter().filter_map(|i| Some((i.name.clone(), i.default.clone()?))).collect();
    let another = walked.iter().any(|(name, was)| values.get(name).is_some_and(|now| now != was));
    // Held, the node asks the site nothing of its own: the answer without its list fails as the site sent it.
    another && !own_asks::held_at(own_asks::Ask::Recheck, "run::found_nothing") && asks(&route.graph, &walked).is_some_and(|v| !unbrowse_learn::fields::frame_without_records(&v, &route.fields))
}

/// Whether a plain ask's failure (`e`) is the call's answer, with nothing asked again: the site said nothing is at the
/// address this value made (`says_nothing_is_there`), and asked once more it still answers the route's own value
/// (`still_answers_its_own`). Where that ask is held (`own_asks::Ask::Recheck`), the node asks the site nothing of its
/// own: the site's "not found" is the call's answer as it said it, and the call is not made again.
fn the_failure_stands(route: &store::Route, e: &unbrowse_learn::ReplayError, asks: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> bool {
    says_nothing_is_there(e) && (own_asks::held_at(own_asks::Ask::Recheck, "run::still_answers_its_own") || still_answers_its_own(route, asks))
}

fn call_with(mut route: store::Route, filled: &crate::vault::Filled, who: &str, frames: Option<FrameSink>, asked_for: &[String], node: Option<std::sync::Arc<crate::Node>>) -> Result<CallResult, String> {
    // Every request this call sends, a heal's and a walled step's included, crosses the card hold where it leaves
    // (`unbrowse_learn::hold`); set here too, for a call run outside the node's own start.
    crate::browse::hold_requests_where_a_card_sits();
    let socket_before = route.socket.as_ref().and_then(|s| serde_json::to_value(s).ok());
    // A host the owner excluded is one the node never learns from: no call goes there with its session, and no heal
    // walks it again, whoever calls and whenever the route was learned.
    if let Some(host) = store::excluded_host(&route, &store::load_settings().excluded) {
        return Err(format!("{host} is excluded in Settings: the node doesn't call it or walk it"));
    }
    // A site that opted out for Unbrowse in its robots rules isn't called (R4.32), whoever made the route.
    if let Some(why) = crate::optout::refuses(&route) {
        return Err(why);
    }
    // Whose rule every request of the call is held to: a route made from another contributor's body is someone else's.
    let egress = crate::share::egress(&route);
    if route.socket.is_some() && egress != unbrowse_learn::egress::Egress::Own {
        return Err("a route this node didn't learn itself never opens a socket: a body carries none".into());
    }
    // A file on this machine is the owner's: a route this node didn't learn itself never names one, so nothing in
    // the file root goes to a site on someone else's say.
    if let Some(i) = route.inputs.iter().find(|i| i.file).filter(|_| egress != unbrowse_learn::egress::Egress::Own) {
        return Err(format!("{} is a file on this node: a route that uploads one runs only if this node learned it", i.name));
    }
    // A write of someone else's route that may send what an earlier step of it read under the owner's session (their
    // account page, their address) runs that way only on the owner's yes for this call; a no sends nothing. Where no one
    // can be asked, the call runs without it and the client refuses such a write before it is sent.
    let session_reads = match session_reads_in_writes(&route).filter(|_| egress != unbrowse_learn::egress::Egress::Own) {
        Some(question) => match ask_on_this_thread(node.as_deref(), question) {
            Some(Ok(())) => true,
            Some(Err(why)) => return Err(format!("the owner didn't allow this call, so nothing reached the site: {why}")),
            None => false,
        },
        None => false,
    };
    // A route this node didn't learn acts in the owner's session on its site only once the owner allowed that route,
    // as it is now; otherwise it runs with none of their session.
    // The yes is bound to the graph the client is given (`run_graph`), and the client checks it again against the graph
    // each request is sent from.
    let owner_consent = match egress {
        unbrowse_learn::egress::Egress::Own => None,
        _ => owner_session_for(&route, &run_graph(&route), &mut |q| ask_on_this_thread(node.as_deref(), q).unwrap_or_else(|| Err("no one to ask".into()))),
    };
    let mut values: HashMap<String, String> = route.inputs.iter().filter_map(|i| Some((i.name.clone(), i.default.clone()?))).collect();
    values.extend(filled.values.iter().map(|(k, v)| (k.clone(), v.clone())));
    if let Some(missing) = route.inputs.iter().find(|i| !i.optional && !values.contains_key(&i.name)) {
        return Err(format!("the route needs a value for {}", missing.name));
    }
    // A login still named, not filled in, is a call nobody with the vault made (a remote caller): the reference
    // never goes to the site.
    if let Some(i) = route.inputs.iter().find(|i| values.get(&i.name).is_some_and(|v| crate::vault::Ref::parse(v).is_some())) {
        return Err(format!("{} is a login from this node's vault: only its owner or an agent of theirs can call with it", i.name));
    }
    let t0 = Instant::now();
    // Whether the call failed even after the node walked the route's page again and rebuilt its chain: the site
    // answered the walk, so the node, not the site, is the likelier fault, and it reports that itself.
    let mut rewalked = false;
    // Whether a route this node didn't learn opened its browser to mint its own session: the owner's setting let it,
    // and the activity log says so.
    let mut foreign_minted = false;
    // Whether the call opened a browser at all, for any route: the browserless measure.
    let mut browser_used = false;
    // What the call costs the owner's machine (`learn.rung`), and the model requests made before it began.
    let mut made = unbrowse_learn::Made::default();
    let model_before = unbrowse_learn::judge::requests_made();
    let mut fell_back: Vec<String> = Vec::new();
    let mut unheld = None;
    // A failure comes back twice: as the caller is told it, and whole, for the owner's log; and a third time as its
    // variant and status alone (`failure_variant`), the only words of it a bug report may carry.
    let mut refused = None;
    let mut variant = None;
    // What the call said of the route's steps (`health::Said`): nothing, until a replay of its chain says.
    let mut said = unbrowse_learn::health::Said::Nothing;
    // The chain a heal found and a retry proved: the route from now on.
    let mut healed = None;
    // What the site answered that says it drifted, where the call learns the route again rather than heal it.
    let mut drifted: Option<String> = None;
    let (answer, ledger): (Result<serde_json::Value, (String, String)>, unbrowse_learn::Ledger) = if route.socket.is_some() {
        let called = crate::socket::call(&mut route, &values, who);
        // A socket that had to be found again was found by the node's browser opening the route's page.
        if route.socket.as_ref().and_then(|s| serde_json::to_value(s).ok()) != socket_before {
            made.reach(unbrowse_learn::Rung::Browser);
        }
        let socket_url = route.socket.as_ref().map(|s| s.url.clone()).unwrap_or_default();
        let mut ledger = unbrowse_learn::Ledger::frame(&socket_url, route.write);
        match called.answer {
            Ok(v) => {
                ledger.confirmed(1);
                (Ok(v), ledger)
            }
            Err(e) => {
                if called.possible_commit {
                    ledger.sending(1);
                }
                variant = Some("Socket: the socket call failed".to_string());
                (Err((e.clone(), e)), ledger)
            }
        }
    } else {
        let target = route.graph.steps.last().map(|s| (s.method.clone(), fragment(&s.url))).unwrap_or_default();
        let graph = run_graph(&route);
        // Every client this call makes is the route as it is called: the body it was learned as by example runs in the
        // graph's place where the switch says so, and a route that carries the plan it was learned by is learned again
        // where the site drifted, not healed. Each carries the owner's answers for this call too: whether a write may
        // carry what a step read under their session, whether a shared route may act in their session, and the logins
        // and cards the vault filled, checked again on the graph it sends (a heal rebuilds the chain after the first
        // check), so they go only to the route's site. The first, plain ask below is made with the same.
        let as_called = |client: RouteClient| {
            let client = match route.body.clone().filter(|_| calls_the_body()) {
                Some(body) => client.with_body(body),
                None => client,
            };
            let client = if crate::learn::learns_again(&route, writes(&route)) { client.learning_again() } else { client };
            let client = client.with_session_reads_in_writes(session_reads);
            let client = match &owner_consent {
                Some((body, digest)) => client.with_owner_consent(body, digest),
                None => client,
            };
            let client = client.with_held_inputs(filled.held.clone(), &route.site);
            // Held, a failed call fails as it failed: nothing of the node's own mends it (`own_asks::Ask::Heal`).
            if own_asks::held(own_asks::Ask::Heal) { client.holding_the_heal() } else { client }
        };
        let client = as_called(RouteClient::new(graph.clone()).with_chrome_transport().with_egress(egress).with_judged_write(route.judged.writes).with_excluded(store::load_settings().excluded));
        // A heal walks the route's root, in the root's own browser.
        let root_host = url::Url::parse(&route.root).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| route.site.clone());
        let client = client.with_session_store(store::jars_dir()).with_shared_mint(store::load_settings().shared_mint);
        // A node with no Chromium calls the route as it is and answers what the site said: there is nothing to heal
        // it with, and the engine left to pick one would find a browser the owner kept the node off.
        let client = match the_calls_browser() {
            Some(program) => client.with_browser(&program),
            None => client,
        };
        let mut client = client.with_cdp(crate::browse::cdp_of(&root_host)).with_root(&route.root, &target.0, &target.1);
        if let Some(sink) = frames {
            client = client.with_frames(sink);
        }
        // What the owner's browsing did on this site, when the route is the node's own to run in the browser.
        let site = unbrowse_learn::identity::site_of(&root_host);
        let own = egress == unbrowse_learn::egress::Egress::Own;
        // Whether the call went through a sign-in or a choice: its own answer is what says that took.
        let signed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut chose = false;
        // Whether the sign-in's own request carried the login in this call and the site didn't take it: nothing types
        // it again behind that.
        let spent = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut client = client.with_sign_in(if own { crate::setups::signing_in(site.clone(), root_host.clone(), who.to_string(), node.clone(), signed.clone(), spent.clone()) } else { None });
        // The sign-in's own request, where the node holds it: the owner's sign-in made again for the agent's request,
        // kept with the choices a site asks again (`own_asks::Ask::Setups`).
        client = client.with_plain_sign_in(if own && !crate::learn::own_asks::held(crate::learn::own_asks::Ask::Setups) { crate::setups::signing_in_plainly(site.clone(), root_host.clone(), who.to_string(), node.clone(), signed.clone(), spent) } else { None });
        // What the node can do against a wall that the client can't (`clearance`): for its own routes only.
        if own {
            client = client.with_clearer(unbrowse_learn::refusal::Source::OwnerSession, crate::clearance::owners_session(root_host.clone(), who.to_string(), node.clone()));
        }
        // A choice the route's calls depend on that the jar has lost is made again first: a store picked on the page asks
        // nothing back, so nothing later would show it had gone. A write's own steps are left as they were learned.
        if own && !route.write {
            let sends: Vec<&str> = route.graph.steps.iter().flat_map(|s| &s.fields).filter_map(|f| if let unbrowse_learn::Loc::Cookie(c) = &f.loc { Some(c.as_str()) } else { None }).collect();
            let jar: HashMap<String, String> = store::read_json(&store::jar_path(&root_host), &unbrowse_files::JAR);
            if let Some(choice) = crate::setups::load(&site).into_iter().find(|s| s.lost_from(&sends, &|c| jar.contains_key(c))).filter(|_| !crate::learn::own_asks::held_at(crate::learn::own_asks::Ask::Setups, "run::setups::earn")) {
                if let Some(earned) = crate::setups::earn(&choice, &root_host, &site, who, None) {
                    client.absorb(earned);
                    chose = true;
                }
            }
        }
        // A route that hears its caller, asked another value than its own, is first asked with no browser to heal
        // it: "not found" for that value, while the site still answers the route's own, is the site's answer to it,
        // and walking the page would only find the call the route already is. Any other failure (a door, an answer in
        // another shape, a refusal) may be the site walling new asks, and where its own value fails too the route is
        // what failed: the call is made again with the browser, as before.
        // What the call cost and how it went are read from the client whose answer is the call's: the plain ask's,
        // where its answer stood.
        let mut plain_answered: Option<RouteClient> = None;
        let (mut answer, mut ledger) = if own && !chose && stands_by_itself(&route) && another_value(&route, &values) {
            let mut plain = as_called(
                RouteClient::new(graph)
                    .with_chrome_transport()
                    .with_egress(egress)
                    .with_judged_write(route.judged.writes)
                    .with_excluded(store::load_settings().excluded)
                    .with_session_store(store::jars_dir())
                    .with_shared_mint(store::load_settings().shared_mint),
            );
            match plain.call_with_ledger(&values) {
                (Ok(v), ledger) => {
                    plain_answered = Some(plain);
                    (Ok(v), ledger)
                }
                (Err(e), ledger) if the_failure_stands(&route, &e, &mut asked_plainly) => {
                    eprintln!("   [call] the site says there is nothing at this value's address, and its word stands: not healed");
                    plain_answered = Some(plain);
                    (Err(e), ledger)
                }
                _ => client.call_with_ledger(&values),
            }
        } else {
            client.call_with_ledger(&values)
        };
        // The site answered with the page that asks what the owner already chose: it is chosen again, and asked again.
        if let Some(choice) = answer.as_ref().ok().filter(|_| own && !route.write).and_then(|v| crate::setups::load(&site).into_iter().find(|s| s.asked_by(v))).filter(|_| !crate::learn::own_asks::held_at(crate::learn::own_asks::Ask::Setups, "run::setups::earn")) {
            if let Some(jar) = crate::setups::earn(&choice, &root_host, &site, who, None) {
                client.absorb(jar);
                chose = true;
                (answer, ledger) = client.call_with_ledger(&values);
            }
        }
        if chose || signed.load(std::sync::atomic::Ordering::Relaxed) {
            let asks_again = answer.as_ref().ok().is_some_and(|v| crate::setups::load(&site).iter().any(|s| s.asked_by(v)));
            crate::setups::judged_by_the_call(&site, who, answer.is_ok() && !asks_again);
        }
        let answered_by = plain_answered.as_ref().unwrap_or(&client);
        if route.body.is_some() && calls_the_body() {
            eprintln!("   [call] {}: ran {}", route.id, if answered_by.ran_body() { "the body it was learned as by example" } else { "its graph, the body beside it" });
        }
        browser_used = answered_by.used_browser();
        fell_back = answered_by.fell_back();
        unheld = answered_by.unheld();
        made = answered_by.made().clone();
        // A choice made again on the page, or a sign-in, was the browser's work for this call.
        if chose || signed.load(std::sync::atomic::Ordering::Relaxed) {
            made.reach(unbrowse_learn::Rung::Browser);
        }
        foreign_minted = !own && browser_used;
        rewalked = answer.is_err() && serde_json::to_value(client.graph()).ok() != serde_json::to_value(&route.graph).ok();
        healed = client.healed().cloned();
        drifted = client.drifted().map(String::from);
        if let Err(unbrowse_learn::ReplayError::Refused(why) | unbrowse_learn::ReplayError::RefusedHop(why)) = &answer {
            refused = Some(why.clone());
        }
        let steps = route.graph.steps.len();
        variant = answer.as_ref().err().map(|e| failure_variant(e, steps));
        said = unbrowse_learn::health::said(&answer, steps);
        (answer.map_err(|e| (told(&e, steps), e.to_string())), ledger)
    };
    let ms = t0.elapsed().as_millis() as u64;
    if foreign_minted {
        store::log_activity(&Activity {
            at: store::now(),
            who: who.to_string(),
            site: route.site.clone(),
            what: format!("Ran shared route `{}` in this node's browser to mint its own session", route.what),
            kind: "call".into(),
            result: if answer.is_ok() { "done" } else { "failed" }.into(),
            ms: Some(ms),
            unb: None,
            tx: None,
            note: Some(route.id.clone()),
        });
    }

    let writes = writes(&route);
    let possible_commit = ledger.possible_commit();
    let retry = Some(ledger.retry(writes));
    // Nothing the call hands back, or keeps, says a secret the vault filled in: it says the reference. Nor one the
    // node typed on the route's site, or the vault holds for it: a page that shows a password shows it in the answer
    // of the call that read it too.
    let mut secrets = filled.secrets.clone();
    secrets.extend(crate::browse::secrets_of(&unbrowse_learn::identity::site_of(&route.site)));
    // Nor a session the site's jar filled in at call time, which a site may say back (a debug block, a "signed in
    // as" line): the agent reads the jar entry's name in its place. A value too short to be a session is left alone.
    secrets.extend(jar_secrets(&route.graph));
    let scrub = Scrub::of(&secrets);
    let mut truncated = None;
    let mut shown = None;
    // The fields a call of this route hands back by default, chosen once, from the first answer big enough to trim.
    let mut learned_fields = None;
    let mut more = None;
    let mut records = None;
    let mut whole_answer = None;
    // The frame of an answer with none of the records this route returns is not the answer: a page served without
    // the data its script would fetch says `200` and holds the request's key. A search that found nothing still has
    // its list, empty, and passes (`fields::frame_without_records`).
    let frame_lacks = |v: &serde_json::Value| {
        let read = match url::Url::parse(&route.root) {
            Ok(base) => unbrowse_learn::fields::with_markup_read(v.clone(), &base),
            Err(_) => v.clone(),
        };
        unbrowse_learn::fields::frame_without_records(&read, &route.fields)
    };
    let answer = match answer {
        // Held against the answer as its fields were chosen from it: with the markup it carries read, since a
        // route's fields may be that markup's links. Some sites leave the list out when they find nothing: where the
        // caller asked another value than the route was learned on, and the site still lists its records for that
        // one, the frame is its answer to this value.
        Ok(v) if !route.fields.is_empty() && frame_lacks(&v) && found_nothing(&route, &values, &mut asked_plainly) => Ok(v),
        Ok(v) if !route.fields.is_empty() && frame_lacks(&v) => {
            let told = "the site answered with the frame of its answer and none of the records this route returns: its list is not there at all".to_string();
            Err((told.clone(), told))
        }
        other => other,
    };
    let (ok, data, error, whole) = match answer {
        Ok(v) => {
            let v = scrub.json(v);
            records = records_where_seen(&route, &v);
            whole_answer = Some(v.clone());
            keep_whole_here(&route.id, &filled.values, &v);
            more = next_page(&route, filled, &values, &v, &scrub);
            // Results a call hands back drawn already, markup in a field, are read as a page is before the fields a
            // reply shows are chosen: what it lists is in that markup. A caller who names fields gets them as sent.
            let (v, drawn) = match (asked_for.is_empty(), url::Url::parse(&route.root)) {
                (true, Ok(base)) => unbrowse_learn::fields::with_markup_read_at(v, &base),
                _ => (v, Vec::new()),
            };
            // Fields chosen from an answer of another shape than this one (the page's state, before the page answered
            // with what it renders) name nothing here: they are chosen again. One a value's answer happens to lack (a
            // search's category, for a word that has none) is no other shape, and what an agent is shown stays the same.
            let all = unbrowse_learn::fields::paths(&v);
            let held = route.fields.iter().filter(|p| all.iter().any(|f| &f.path == *p)).count() * 2 > route.fields.len();
            // Fields an agent said are the answer stay the defaults even on an answer that lacks them: a page that
            // came back without its records then reads as empty, for the agent to judge, never as other fields.
            // Defaults chosen before the rule could tell records from counts miss the records: they are chosen again.
            let stale = !held
                || unbrowse_learn::fields::misses_the_records(&route.fields, &all)
                || unbrowse_learn::fields::records_gone(&route.fields, &all)
                || route.stats.fields_rule < unbrowse_learn::fields::DEFAULTS_RULE;
            // What the call drew is what it answers with: the links of the markup it carried are the defaults,
            // whatever was chosen from the flags and notes around it, unless an agent said which fields are.
            let links_drawn: Vec<String> = drawn.iter().flat_map(|at| [format!("{at}.links[].text"), format!("{at}.links[].url")]).collect();
            let defaults = if !route.judged.fields && !links_drawn.is_empty() {
                if route.fields != links_drawn {
                    learned_fields = Some(links_drawn.clone());
                }
                links_drawn
            } else if !route.judged.fields && (route.fields.is_empty() || stale) {
                // What the caller asked for says which records answer it: a search's value is said back by them.
                let asked: Vec<String> = route.inputs.iter().filter(|i| !i.secret && !i.file).filter_map(|i| values.get(&i.name).cloned()).filter(|v| !unbrowse_learn::slots::bound_by_key(v)).collect();
                let d = unbrowse_learn::fields::defaults_on(&all, &route.what, &asked, &route.root);
                let d = unbrowse_learn::fields::page_defaults(&v, d, &asked);
                if !d.is_empty() && v.to_string().len() >= unbrowse_learn::fields::WHOLE_UNDER {
                    learned_fields = Some(d.clone());
                }
                d
            } else {
                route.fields.clone()
            };
            let (v, s) = shown_of_read(&route, &v, all, &defaults, asked_for);
            let v = unbrowse_learn::fields::without_addresses(v, &route.what, asked_for);
            shown = Some(s);
            let (v, cut) = fit_reply(v, REPLY_BUDGET, asked_for);
            truncated = cut.map(|cut| Truncated::of(&route.id, cut, more.clone()));
            (true, Some(v), None, None)
        }
        Err((told, whole)) => (false, None, Some(scrub.text(&told)), Some(scrub.text(&whole))),
    };
    // A call whose replay passed and whose answer was then found to hold none of the route's records was refused at
    // its target: the site answered, with no answer.
    let said = match (said, ok) {
        (unbrowse_learn::health::Said::Answered, false) => unbrowse_learn::health::Said::Refused(route.graph.steps.len(), unbrowse_learn::health::Refused::NotAnAnswer, None),
        (said, _) => said,
    };
    // The call's line in the route (its stats, the fields learned, a heal's chain, its health) is written beside the
    // reply: the route's file is megabytes for a busy page, and every route update reads and writes it under the
    // routes' lock, so a later update still starts from this one.
    {
        let (route, error) = (route.clone(), whole.clone());
        beside(move || record(&route, socket_before, ok, ms, error, learned_fields, healed, said));
    }
    log_made(&CallMade::of(&route, ok, ms, &made, unbrowse_learn::judge::requests_made() - model_before));
    // The sighting reads the answer whole, as the site sent it, as a later call for another value is read
    // (`learn::confirm::by_its_call`), never the reply's view of it.
    // The sighting reads the whole answer (its values, lines and records), bookkeeping for a later call's confirm: it
    // is kept beside the reply, not before it, so a page's state of megabytes doesn't hold the caller up.
    {
        let (route, values, answer) = (route.clone(), values.clone(), whole_answer.clone().or_else(|| data.clone()));
        let rung = made.reached as u8;
        beside(move || crate::learn::sighted::called(&route, &values, answer.as_ref(), ok, ms, rung));
    }
    if let Some(v) = variant.as_deref().filter(|_| !ok) {
        crate::report::note_failure(&route.id, v);
        if rewalked {
            crate::report::by_node("failed", "a route still failed after the node walked its page again", None, Some(&route), v);
        }
    }
    store::log_activity(&Activity {
        at: store::now(),
        who: who.to_string(),
        site: route.site.clone(),
        what: route.what.clone(),
        kind: "call".into(),
        result: if ok { "passed" } else { "failed" }.into(),
        ms: Some(ms),
        unb: None,
        tx: None,
        note: whole,
    });
    // The site drifted: the route is learned again from its plan, for this call's values, as a new route, and the
    // call is answered by it. The old route is never edited; the new one took its place (`learn::learned_again`).
    // A call that may open no browser (`browser: never`) learns nothing again: the walk is the browser's.
    if let Some(why) = drifted.filter(|_| !ok && !browser_shut()) {
        match crate::learn::learned_again(&route, &values, who, node.as_deref()) {
            Ok(again) => {
                eprintln!("   [call] {}: the site drifted, so the route was learned again from its plan, as {}", route.id, again.id);
                let mut answered = crate::learn::not_learning_again(|| call_with(again.clone(), filled, who, None, asked_for, node))?;
                answered.fell_back.insert(0, format!("the site no longer answered the route as it was learned ({why}), so the node learned it again from the page it was learned on, as route {}", again.id));
                answered.learned_again = Some(again.id);
                return Ok(answered);
            }
            Err(not) => {
                eprintln!("   [call] {}: the site drifted, and the route was not learned again: {not}", route.id);
                fell_back.push(format!("the site no longer answered the route as it was learned ({why}), and it was not learned again: {not}"));
            }
        }
    }
    let variant = variant.filter(|_| !ok);
    Ok(CallResult { ok, ms, data, error, possible_commit, retry, truncated, refused, variant, fields: shown, more, browser: browser_used, fell_back, unheld, learned_again: None, records })
}

/// What the owner is asked before a route that came from another node runs: a write of it sends a value an earlier step
/// read from the site, and the owner holds a session for the site, so that read may be their own data (their account
/// page, their address, a token of theirs) going wherever the write puts it. None when no write carries such a value,
/// or the owner holds no session to read under.
pub fn session_reads_in_writes(route: &store::Route) -> Option<String> {
    let steps = &route.graph.steps;
    let path = |url: &str| url.split_once("://").map_or(url, |(_, rest)| rest.find('/').map_or("/", |i| &rest[i..])).split('?').next().unwrap_or_default().to_string();
    let carried: Vec<String> = steps
        .iter()
        .filter(|s| unbrowse_learn::ledger::writes_as(s, true))
        .flat_map(|w| {
            w.fields.iter().filter_map(move |f| match &f.class {
                unbrowse_learn::graph::Class::Derived { origin } if steps.iter().any(|s| s.exchange == origin.exchange) => {
                    Some(format!("{} {} would send, at {}, what {} answered", w.method, path(&w.url), f.loc, path(&origin.url)))
                }
                _ => None,
            })
        })
        .collect();
    if carried.is_empty() {
        return None;
    }
    let jar: HashMap<String, String> = store::read_json(&store::jar_path(&unbrowse_learn::client::jar_name(&route.graph)?), &unbrowse_files::JAR);
    if jar.is_empty() {
        return None;
    }
    Some(format!(
        "A route another contributor listed for {} reads from the site under your session, then writes what it read:\n\n{}\n\nWhat it reads under your session may be your own account's data. Allow this one call? A no sends nothing.",
        route.site,
        carried.join("\n")
    ))
}

/// The graph a call of `route` runs: the route's, its page origin filled in for a route learned before graphs said it
/// (the page goes out from the page it was learned on all the same).
fn run_graph(route: &store::Route) -> unbrowse_learn::Graph {
    let mut graph = route.graph.clone();
    graph.page_origin = graph.page_origin.or_else(|| unbrowse_learn::graph::origin_of(&route.root));
    graph
}

fn shared_sessions_path() -> std::path::PathBuf {
    store::home().join("shared-sessions.json")
}

/// Whether a route another node listed may act in the owner's session on its site, as `graph`: the owner said yes to
/// this route, as they were shown it, in the owner dialog (`ask`), and the yes is kept under
/// [`unbrowse_learn::client::consent_digest`] of its body and `graph`. The answer is that body and digest, for the
/// client to check again against the graph each request is sent from. None runs it with none of the owner's session:
/// a no, no one to ask, a route too long to show the owner whole ([`consent_question`]), or a route that could use no
/// session (the owner holds none for the site, and none of its steps names a session value or is answered with a
/// cookie), which isn't asked about. A no is asked again next time.
pub fn owner_session_for(route: &store::Route, graph: &unbrowse_learn::Graph, ask: &mut dyn FnMut(String) -> Result<(), String>) -> Option<(String, String)> {
    let body = route.fetched.as_ref()?.content_id.clone();
    let key = unbrowse_learn::client::consent_digest(&body, graph);
    let mut allowed: std::collections::BTreeMap<String, String> = store::read_json(&shared_sessions_path(), &unbrowse_files::SHARED_SESSIONS);
    if allowed.contains_key(&key) {
        return Some((body, key));
    }
    let jar: HashMap<String, String> = unbrowse_learn::client::jar_name(graph).map(|h| store::read_json(&store::jar_path(&h), &unbrowse_files::JAR)).unwrap_or_default();
    let names_a_session = graph.steps.iter().any(|s| {
        s.sets_cookie || s.fields.iter().any(|f| matches!(f.class, unbrowse_learn::graph::Class::Minted { .. }) || matches!(f.loc, unbrowse_learn::Loc::Cookie(_)))
    });
    if jar.is_empty() && !names_a_session {
        return None;
    }
    let Some(question) = consent_question(&route.site, &route.root, graph) else {
        eprintln!("   [call] a shared route for {} can't be shown to the owner whole (too long, or it holds what the question can't describe): it runs with none of their session", route.site);
        return None;
    };
    ask(question).ok()?;
    allowed.insert(key.clone(), route.site.clone());
    let _ = store::write_json(&shared_sessions_path(), &unbrowse_files::SHARED_SESSIONS, &allowed);
    Some((body, key))
}

/// The most a consent question shows, and so the most a route may be to be allowed the owner's session at all:
/// requests, values per request, characters per value, characters of a body, and characters in all. A route past any
/// of them is not shown in part: it is refused, and runs with none of the owner's session.
const ASK_REQUESTS: usize = 12;
const ASK_VALUES: usize = 16;
const ASK_VALUE_CHARS: usize = 80;
const ASK_BODY_CHARS: usize = 400;
const ASK_CHARS: usize = 6000;

/// Text from a route, as the owner is shown it: printable ASCII as it is, everything else (controls, line breaks,
/// bidirectional and invisible marks, any letter outside ASCII a lookalike could hide in) written as its code point,
/// so what the owner reads is what the route says. Hosts are already ASCII: a name is shown as the URL parser holds
/// it, an international one in its `xn--` form.
fn shown(s: &str) -> String {
    s.chars().map(|c| if c == ' ' || c.is_ascii_graphic() { c.to_string() } else { format!("\\u{{{:x}}}", c as u32) }).collect()
}

/// Whether a graph holds only what the consent question describes. Default-deny over the graph as it is serialized,
/// which is what its digest covers: beyond the parts the question shows (each step's method, address, fields and a
/// JSON or form body; the page origin requests claim) and parts that send nothing (a step's recorded status and answer
/// shape, flags read from its answer, the door's description), every part must be empty. A page, its scripts or
/// markup, the answers the page read, a step the page's code signs or a browser runs, a producer, a value held inside
/// another, and any part added to the graph later are not described, so a route that has one is never asked about.
fn describable(graph: &unbrowse_learn::Graph) -> bool {
    use unbrowse_learn::graph::{Body, Class};
    use unbrowse_learn::Loc;
    let empty = |v: &serde_json::Value| match v {
        serde_json::Value::Null => true,
        serde_json::Value::Bool(b) => !b,
        serde_json::Value::String(s) => s.is_empty(),
        serde_json::Value::Array(a) => a.is_empty(),
        serde_json::Value::Object(o) => o.is_empty(),
        serde_json::Value::Number(_) => false,
    };
    let only = |v: &serde_json::Value, shown: &[&str]| v.as_object().is_some_and(|o| o.iter().all(|(k, v)| shown.contains(&k.as_str()) || empty(v)));
    let Ok(whole) = serde_json::to_value(graph) else { return false };
    if !only(&whole, &["steps", "provisional", "page_origin", "door"]) {
        return false;
    }
    let steps = whole.get("steps").and_then(|s| s.as_array()).cloned().unwrap_or_default();
    let step_parts = ["exchange", "method", "status", "url", "fields", "body", "response_shape", "sets_cookie", "on_load", "foreign", "reads_page"];
    if !steps.iter().all(|s| only(s, &step_parts)) {
        return false;
    }
    // A user name or password in an address is sent as the request's credentials, outside every field: never shown,
    // so never asked about (the transport refuses one for someone else's route anyway, `Egress::request`).
    let authority = |url: &str| url.split_once("://").map_or("", |(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default()).to_string();
    if graph.steps.iter().any(|s| authority(&s.url).contains('@')) {
        return false;
    }
    graph.steps.iter().all(|s| {
        let fields = s.fields.iter().all(|f| {
            matches!(f.loc, Loc::Path(_) | Loc::Query(_) | Loc::Header(_) | Loc::Cookie(_) | Loc::Json(_) | Loc::Form(_))
                && matches!(f.class, Class::Input { .. } | Class::Piece { .. } | Class::Constant { .. } | Class::Unconfirmed { .. } | Class::Minted { .. } | Class::Derived { .. })
        });
        fields && matches!(s.body, None | Some(Body::Json { .. }) | Some(Body::Form { .. }))
    })
}

/// The question a route another node listed puts to the owner before it may act in their session. It shows, in the
/// order they are sent and each one, every request: its method, its address (scheme, host, any port, path, and the
/// query the call builds, with each value or where it comes from), every header, cookie and body value and where it
/// comes from, fixed values in full, and the body as it is templated. It names the exact origins the session goes to
/// (and that no other host gets it, another host of the site included), the start page and whether it is fetched with
/// the session, the page the requests say they come from, and that a session the site sets during the call goes along
/// too. None when the route holds what the question can't describe ([`describable`]) or doesn't fit the bounds
/// (`ASK_*`) whole: it is never shown in part, and never asked about.
pub fn consent_question(site: &str, root: &str, graph: &unbrowse_learn::Graph) -> Option<String> {
    use unbrowse_learn::graph::{Body, Class};
    use unbrowse_learn::Loc;
    if !describable(graph) || graph.steps.is_empty() || graph.steps.len() > ASK_REQUESTS {
        return None;
    }
    let origins = unbrowse_learn::client::origins_of(graph)?;
    let value = |v: &str| (v.chars().count() <= ASK_VALUE_CHARS).then(|| format!("\"{}\"", shown(v)));
    let step_of = |exchange: usize| graph.steps.iter().position(|s| s.exchange == exchange).map(|i| i + 1);
    // A value read from an earlier answer, said exactly: which answer, the selector that takes it out (a JSON pointer,
    // a header, a cookie the answer sets, or the text between two marks and which occurrence), any text sent around
    // it, and that the value read is sent on. A pointer segment that is an input's walked value is the caller's value
    // at call time (`replay::rekeyed`), and is said so. A selector too long to show refuses the question.
    let defaults: Vec<(String, String)> = graph.steps.iter().flat_map(|s| &s.fields).filter_map(|f| match &f.class {
        Class::Input { name, default: Some(d), .. } => Some((name.clone(), d.clone())),
        _ => None,
    }).collect();
    let derived = |o: &unbrowse_learn::provenance::Origin| -> Option<String> {
        use unbrowse_learn::provenance::At;
        let from = step_of(o.exchange)?;
        let what = match &o.at {
            At::Json { pointer } => {
                let rekeyed: Vec<String> = defaults.iter().filter(|(_, d)| pointer.split('/').skip(1).any(|p| p == d.replace('~', "~0").replace('/', "~1"))).map(|(n, _)| shown(n)).collect();
                let note = if rekeyed.is_empty() { String::new() } else { format!(" (where it names a walked value, your agent's value for {} takes its place)", rekeyed.join(", ")) };
                format!("the value at JSON pointer {}{note}", value(pointer)?)
            }
            At::Header { name } => format!("its header {}", value(name)?),
            At::HeaderQuery { name, key } => format!("the {} of the address its header {} hands over", value(key)?, value(name)?),
            At::SetCookie { name } => format!("the cookie {} it sets", value(name)?),
            At::Text { before, after, nth } => format!("the text after occurrence {} of {} up to {}", nth + 1, value(before)?, value(after)?),
        };
        let around = match &o.wrap {
            Some((b, a)) => format!(", sent as {} + that value + {}", value(b)?, value(a)?),
            None => String::new(),
        };
        Some(format!("{what} in the answer to request {from}, sent on as read{around}"))
    };
    let mut list = String::new();
    for (n, step) in graph.steps.iter().enumerate() {
        let source = |f: &unbrowse_learn::Field| -> Option<String> {
            Some(match &f.class {
                Class::Constant { value: v, .. } | Class::Unconfirmed { value: v } => format!("{} (fixed in the route)", value(v)?),
                Class::Input { name, default: Some(d), .. } => format!("your agent's value for {}, else {} (fixed in the route)", shown(name), value(d)?),
                Class::Input { name, .. } => format!("your agent's value for {}", shown(name)),
                Class::Piece { input, from, len } => format!("characters {} to {} of your agent's value for {}", from + 1, from + len, shown(input)),
                Class::Minted { name } => format!("your session's {}", shown(name)),
                Class::Derived { origin } => derived(origin)?,
                _ => return None,
            })
        };
        // The address as the call builds it: the template's scheme, host, port and path, then the query from the
        // step's fields alone (a template's own query is never sent).
        let origin = url::Url::parse(&unbrowse_learn::client::origins_of(&unbrowse_learn::Graph { steps: vec![step.clone()], ..Default::default() })?.into_iter().next()?).ok()?;
        let path = step.url.split_once("://").map_or("", |(_, rest)| rest.find('/').map_or("/", |i| &rest[i..])).split(['?', '#']).next().unwrap_or("/");
        let query: Vec<String> = step.fields.iter().filter_map(|f| if let Loc::Query(k) = &f.loc { Some(format!("{}={{{}}}", shown(k), shown(k))) } else { None }).collect();
        let address = format!("{}{}{}", origin.origin().ascii_serialization(), shown(path), if query.is_empty() { String::new() } else { format!("?{}", query.join("&")) });
        list.push_str(&format!("{}. {} {address}\n", n + 1, shown(&step.method)));
        let mut lines = Vec::new();
        for f in &step.fields {
            lines.push(format!("{}: {}", shown(&f.loc.to_string()), source(f)?));
        }
        match &step.body {
            Some(Body::Json { template, .. }) => {
                let text = serde_json::to_string(template).ok()?;
                if text.chars().count() > ASK_BODY_CHARS {
                    return None;
                }
                lines.push(format!("JSON body, as sent with the values above in its null places: {}", shown(&text)));
            }
            Some(Body::Form { fields }) => {
                let text = fields.iter().map(|(k, v)| format!("{}={}", k, v.as_deref().unwrap_or("{value above}"))).collect::<Vec<_>>().join("&");
                if text.chars().count() > ASK_BODY_CHARS {
                    return None;
                }
                lines.push(format!("form body: {}", shown(&text)));
            }
            Some(_) => return None,
            None => {}
        }
        if lines.len() > ASK_VALUES {
            return None;
        }
        for l in lines {
            list.push_str(&format!("   {l}\n"));
        }
    }
    let named = origins.iter().cloned().collect::<Vec<_>>().join(", ");
    if url::Url::parse(root).is_ok_and(|u| !u.username().is_empty() || u.password().is_some()) {
        return None;
    }
    let start = match url::Url::parse(root) {
        Ok(u) if origins.contains(&u.origin().ascii_serialization()) => format!("Its start page, {}, is fetched with your session when the session goes stale.", shown(u.as_str())),
        Ok(u) => format!("Its start page, {}, is at another origin and is fetched without your session.", shown(u.as_str())),
        Err(_) => "It has no start page it can fetch.".to_string(),
    };
    let from = graph.page_origin.as_deref().map(|p| format!(" Its requests say they come from {}.", shown(p))).unwrap_or_default();
    let site = shown(site);
    let q = format!(
        "A route another contributor listed for {site} asks to act in your session at {named}, and nowhere else: no other host gets your session from it, another host of {site} included.\n\nWith your yes, each call of it sends your cookies and session tokens for those origins with these requests, and for the rest of that call also any cookie they set during it, which can be a sign-in of the route's own: what the call sends after that goes to that account. Any of these requests can change your account, whatever its method. Every request also carries what a browser sends on its own (its usual headers).{from} {start}\n\nIts {} request(s), in the order they are sent, all of them:\n{list}\nAllow this route, exactly as shown, to act in your session at {named}? If it changes you are asked again. A no runs it with none of your session.",
        graph.steps.len()
    );
    (q.chars().count() <= ASK_CHARS).then_some(q)
}

/// The owner's answer to `question`, asked from the blocking thread a call runs on: None when there is no one to ask
/// here (no node, or no runtime to show the dialog on).
fn ask_on_this_thread(node: Option<&crate::Node>, question: String) -> Option<Result<(), String>> {
    let node = node?;
    let handle = tokio::runtime::Handle::try_current().ok()?;
    Some(handle.block_on(crate::owner_dialog::ask(node.key().ok(), question)))
}

/// What one call cost the owner's machine (`learn.rung`), a line of `made.jsonl`: the highest rung it reached, the
/// rung of each step of the run that answered, whether a browser ran, and how many requests it sent to a model. It
/// names the route and its site and nothing the call sent or was answered with.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CallMade {
    pub at: u64,
    pub route: String,
    pub site: String,
    pub ok: bool,
    pub ms: u64,
    /// The highest rung anything done for the call reached, 0 to 5.
    pub rung: unbrowse_learn::Rung,
    /// The rung of each step of the run that answered; empty when none did.
    #[serde(default)]
    pub steps: Vec<unbrowse_learn::Rung>,
    /// Whether a browser process ran for the call.
    pub browser: bool,
    /// Requests sent to a model while the call ran (`learn.proposer`: none).
    #[serde(default)]
    pub model_requests: u64,
}

impl CallMade {
    pub fn of(route: &store::Route, ok: bool, ms: u64, made: &unbrowse_learn::Made, model_requests: u64) -> Self {
        Self { at: store::now(), route: route.id.clone(), site: route.site.clone(), ok, ms, rung: made.reached, steps: made.steps.clone(), browser: made.browser(), model_requests }
    }
}

/// Whether a route that keeps the body it was learned as is called with it (`learn::learns_by_example`). A test holds
/// it for its own thread, so both settings are called in one run.
pub(crate) fn calls_the_body() -> bool {
    #[cfg(test)]
    if let Some(on) = CALLS_THE_BODY.with(std::cell::Cell::get) {
        return on;
    }
    crate::learn::learns_by_example()
}

thread_local! {
    /// Set while this thread's calls run for an ask that said `browser: never` ([`with_the_browser_shut`]).
    static BROWSER_SHUT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// `f`, with this thread's calls opening no browser when `shut`: what a call for an ask that said `browser: never`
/// runs under. Nothing the call does then opens one: not to sign a step its page's code signs, not to heal, not to
/// learn a drifted route again. What the browser would have done is left undone, and the call answers as the site did.
pub fn with_the_browser_shut<T>(shut: bool, f: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            BROWSER_SHUT.with(|s| s.set(self.0));
        }
    }
    let _restore = Restore(BROWSER_SHUT.with(|s| s.replace(shut)));
    f()
}

fn browser_shut() -> bool {
    BROWSER_SHUT.with(|s| s.get())
}

/// The browser a route's call may open, as the program it runs: none on a node with no Chromium (the route is called as
/// it is and answers what the site said: there is nothing to heal it with, and the engine left to pick one would find
/// a browser the owner kept the node off), and none for a call that may open none ([`with_the_browser_shut`]).
fn the_calls_browser() -> Option<String> {
    crate::browsers::apply();
    if browser_shut() {
        return None;
    }
    crate::browsers::current()?;
    Some(crate::browse::step_program().unwrap_or_else(|| "in-process".to_string()))
}

#[cfg(test)]
thread_local! {
    static CALLS_THE_BODY: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// `f`, with this thread's calls of a route that keeps a body calling it or not as `on` says.
#[cfg(test)]
pub(crate) fn calling_the_body<T>(on: bool, f: impl FnOnce() -> T) -> T {
    CALLS_THE_BODY.with(|c| c.set(Some(on)));
    let out = f();
    CALLS_THE_BODY.with(|c| c.set(None));
    out
}

/// Appends a call's line to `made.jsonl` in the node's home. Like the activity log it is appended to, never written
/// over, and a line that can't be written costs the call nothing.
pub fn log_made(m: &CallMade) {
    use std::io::Write;
    let dir = store::home();
    let _ = unbrowse_files::private::dir_at(&dir);
    if let (Ok(mut f), Ok(line)) = (unbrowse_files::private::open(&dir.join("made.jsonl"), true), unbrowse_files::MADE.to_vec(m)) {
        let _ = writeln!(f, "{}", String::from_utf8_lossy(&line));
    }
}

/// Every line of `made.jsonl` in `dir` that reads, oldest first: what the census counts.
#[cfg(test)]
mod found_nothing_tests {
    use super::*;

    /// The walk that exposed it: a shop's search, shown to hear its caller, asked for a name nobody sells. The site
    /// answered 404 and the call walked the route's page to heal it, a quarter of a minute to find the call it
    /// already was. A route is asked without a browser first only where it reads, runs as plain calls, hears its
    /// caller and is asked another value than its own; and a refusal stands only while its own value is answered.
    #[test]
    fn a_route_that_hears_is_not_healed_for_a_value_the_site_refuses_while_it_answers_its_own() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({"steps": [{
            "exchange": 0, "method": "GET", "status": 200, "needs_browser": false, "url": "https://www.shop.example/find?q={q}",
            "fields": [{"loc": {"in": "query", "key": "q"}, "class": "input", "name": "q", "default": "lamps", "secret": false}]
        }], "provisional": false}))
        .unwrap();
        let mut route = store::Route::from_graph("r".into(), "search the shop".into(), "https://www.shop.example/find?q=lamps".into(), graph).unwrap();
        route.write = false;
        let said = |q: &str| HashMap::from([("q".to_string(), q.to_string())]);
        // Never shown to hear its caller: it may answer its walked request alone, and is healed as before.
        assert!(!stands_by_itself(&route));
        route.heard = store::Heard { probed: true, ..Default::default() };
        assert!(stands_by_itself(&route));
        assert!(another_value(&route, &said("zqxv")) && !another_value(&route, &said("lamps")) && !another_value(&route, &HashMap::new()));
        let mut answers = |_: &unbrowse_learn::Graph, v: &HashMap<String, String>| (v["q"] == "lamps").then(|| serde_json::json!({"items": [{"name": "Lamp"}]}));
        assert!(still_answers_its_own(&route, &mut answers));
        let mut refuses = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| None;
        assert!(!still_answers_its_own(&route, &mut refuses), "its own value is refused too: the route is what failed");
        // Only "not found" is the site saying nothing is there: an answer in another shape, or a refusal, may be a wall.
        let failed = |status: u16| unbrowse_learn::ReplayError::Failed { step: 1, url: "https://www.shop.example/find?q=zqxv".into(), status, body: String::new() };
        assert!(says_nothing_is_there(&failed(404)) && says_nothing_is_there(&failed(410)));
        assert!(!says_nothing_is_there(&failed(403)) && !says_nothing_is_there(&failed(429)) && !says_nothing_is_there(&failed(500)));
        assert!(!says_nothing_is_there(&unbrowse_learn::ReplayError::ShapeMismatch { expected: serde_json::json!({}), got: serde_json::json!({}) }));
        // Shown deaf, a write, or a route a page must make: none is asked this way.
        let mut deaf = route.clone();
        deaf.heard.deaf = vec!["q".into()];
        assert!(!stands_by_itself(&deaf));
        let mut writes = route.clone();
        writes.write = true;
        assert!(!stands_by_itself(&writes));
        let mut paged = route.clone();
        paged.browser_assisted = true;
        assert!(!stands_by_itself(&paged));
    }

    /// The walk that exposed it: a papers search whose answer leaves its list of records out when it finds none. A
    /// word nobody searches for was answered with the frame alone, the call was told it had failed, and the page was
    /// walked again to learn what it already knew. Asked for the value it was learned on, the site still lists its
    /// records: the route stands, and the frame is what the site says when it finds nothing.
    #[test]
    fn an_answer_without_its_list_for_another_value_is_a_search_that_found_nothing() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({"steps": [{
            "exchange": 0, "method": "GET", "status": 200, "needs_browser": false, "url": "https://papers.example/find?q={q}",
            "fields": [{"loc": {"in": "query", "key": "q"}, "class": "input", "name": "q", "default": "antenna", "secret": false}]
        }], "provisional": false}))
        .unwrap();
        let mut route = store::Route::from_graph("r".into(), "search papers".into(), "https://papers.example/find?q=antenna".into(), graph).unwrap();
        route.write = false;
        route.fields = vec!["records[].title".to_string()];
        let said = |q: &str| HashMap::from([("q".to_string(), q.to_string())]);
        let mut lists = |_: &unbrowse_learn::Graph, v: &HashMap<String, String>| (v["q"] == "antenna").then(|| serde_json::json!({"total": 2, "records": [{"title": "An antenna"}, {"title": "Another"}]}));
        assert!(found_nothing(&route, &said("zqxv"), &mut lists));
        // Asked for its own value and answered with the frame, the route's own answer is gone: nothing is asked again.
        let mut never = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| -> Option<serde_json::Value> { panic!("the site is not asked again for the route's own value") };
        assert!(!found_nothing(&route, &said("antenna"), &mut never));
        // The site answers the route's own value with the frame too, or not at all: the route has lost its list.
        let mut frame = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| Some(serde_json::json!({"total": 0}));
        assert!(!found_nothing(&route, &said("zqxv"), &mut frame));
        let mut silent = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| None;
        assert!(!found_nothing(&route, &said("zqxv"), &mut silent));
        // A route that writes is never asked again to find out.
        route.write = true;
        assert!(!found_nothing(&route, &said("zqxv"), &mut never));
    }

    /// Held (`own_asks::Ask::Recheck`), a call asks the site nothing of its own to tell "nothing found" from a route
    /// gone: a "not found" for the caller's value is the call's answer as the site said it, and an answer without its
    /// list fails as it came, with the route's own value never asked again. Each says so on the node's log.
    #[test]
    fn a_held_recheck_asks_the_site_nothing() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({"steps": [{
            "exchange": 0, "method": "GET", "status": 200, "needs_browser": false, "url": "https://papers.example/find?q={q}",
            "fields": [{"loc": {"in": "query", "key": "q"}, "class": "input", "name": "q", "default": "antenna", "secret": false}]
        }], "provisional": false}))
        .unwrap();
        let mut route = store::Route::from_graph("r".into(), "search papers".into(), "https://papers.example/find?q=antenna".into(), graph).unwrap();
        route.write = false;
        route.fields = vec!["records[].title".to_string()];
        let said = |q: &str| HashMap::from([("q".to_string(), q.to_string())]);
        let mut never = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| -> Option<serde_json::Value> { panic!("the site is not asked the route's own value") };
        let failed = |status: u16| unbrowse_learn::ReplayError::Failed { step: 1, url: "https://papers.example/find?q=zqxv".into(), status, body: String::new() };
        let (stands, held) = own_asks::holding(own_asks::Ask::Recheck, || the_failure_stands(&route, &failed(404), &mut never));
        assert!(stands, "the site's not found is the call's answer, and the call is not made again");
        assert_eq!(held, vec!["   [own-ask] held: recheck at run::still_answers_its_own".to_string()]);
        let (nothing, held) = own_asks::holding(own_asks::Ask::Recheck, || found_nothing(&route, &said("zqxv"), &mut never));
        assert!(!nothing, "an answer without its list fails as it came");
        assert_eq!(held, vec!["   [own-ask] held: recheck at run::found_nothing".to_string()]);
        // Only a not found is the site's word to stand on: anything else is not this family's, and nothing is said.
        let (stands, held) = own_asks::holding(own_asks::Ask::Recheck, || the_failure_stands(&route, &failed(403), &mut never));
        assert!(!stands && held.is_empty());
        // Not held, the route's own value is asked, as before.
        let mut lists = |_: &unbrowse_learn::Graph, v: &HashMap<String, String>| (v["q"] == "antenna").then(|| serde_json::json!({"records": [{"title": "An antenna"}]}));
        assert!(the_failure_stands(&route, &failed(404), &mut lists));
    }
}

#[cfg(test)]
pub fn made_log_in(dir: &std::path::Path) -> Vec<CallMade> {
    let Ok(text) = std::fs::read_to_string(dir.join("made.jsonl")) else { return Vec::new() };
    text.lines().filter_map(|l| unbrowse_files::MADE.read(l.as_bytes()).ok()).collect()
}

/// Whether a call of `route` may change the site: any step that writes makes it a write, as the client that runs it
/// counts it (`route.write` is the target's label alone). The retry advice is read from the ledger with this label,
/// so an earlier write that may have landed is never answered "run it again as it was".
fn writes(route: &store::Route) -> bool {
    route.write || unbrowse_learn::ledger::route_writes(&route.graph)
}

/// The call's mark on the route as it is on disk now, not as it was when the call began: its stats, the socket a heal
/// found unless the record's socket changed meanwhile, and the chain a heal found (`chain`) on the same terms, so the
/// next call starts from it rather than walking again. That goes through this record, not `store::keep_learned`, so
/// a listed route or the owner's own is repaired too and keeps its place: a listing names a body already published,
/// which this leaves alone. A route deleted while the call ran stays deleted, and a listing set or ended meanwhile
/// stays as it was set.
fn record(route: &store::Route, socket_before: Option<serde_json::Value>, ok: bool, ms: u64, error: Option<String>, fields: Option<Vec<String>>, chain: Option<unbrowse_learn::Graph>, said: unbrowse_learn::health::Said) {
    let healed = route.socket.clone().filter(|s| serde_json::to_value(s).ok() != socket_before);
    // The graph is read as text only where a heal brought a new one: a route's graph carries its page and scripts
    // (megabytes), and reading it twice on every call was a sixth of the call's own time.
    let graph_before = chain.as_ref().and_then(|_| serde_json::to_value(&route.graph).ok());
    let kept = store::update_route(&route.id, |now| {
        if let Some(g) = chain.filter(|_| serde_json::to_value(&now.graph).ok() == graph_before) {
            now.graph = g;
            // A heal's chain is from a walk of its own, not the walks the body was learned from.
            now.body = None;
        }
        if let Some(f) = fields.filter(|_| !now.judged.fields && (now.fields.is_empty() || now.fields == route.fields)) {
            now.fields = f;
            now.stats.fields_rule = unbrowse_learn::fields::DEFAULTS_RULE;
        }
        now.stats.calls += 1;
        if ok {
            now.stats.passed_at(store::now());
            now.provisional &= !now.stats.sighted();
        }
        now.stats.last_ms = Some(ms);
        now.stats.last_at = Some(store::now());
        now.stats.last_error = error;
        // The call's word on each step it reached, written on the chain as it now stands (a heal's, when it healed).
        now.stats.health.note(&now.graph, said, store::now());
        if let Some(h) = healed {
            if now.socket.as_ref().and_then(|s| serde_json::to_value(s).ok()) == socket_before {
                now.socket = Some(h);
            }
        }
    });
    if let (true, Ok(Some(r))) = (ok, &kept) {
        crate::learn::try_the_page_again(r);
    }
}

/// Runs a call's bookkeeping (its line in the route, its sighting) off the caller's path, one at a time and in order,
/// so they are kept as the calls were made. A test keeps them at once, as it reads them back straight after.
fn beside(keep: impl FnOnce() + Send + 'static) {
    if cfg!(test) {
        return keep();
    }
    static QUEUE: std::sync::OnceLock<std::sync::Mutex<std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>>> = std::sync::OnceLock::new();
    let queue = QUEUE.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        std::thread::Builder::new().name("sightings".into()).spawn(move || rx.into_iter().for_each(|keep| keep())).expect("the sightings thread");
        std::sync::Mutex::new(tx)
    });
    let sent = queue.lock().unwrap_or_else(|e| e.into_inner()).send(Box::new(keep));
    if let Err(std::sync::mpsc::SendError(keep)) = sent {
        keep();
    }
}

/// What a failed call tells its caller: which step failed and how, and of what the site said only the target's own
/// answer (what a call that passed would have handed back), cut short. Never a request as it was sent: its address
/// carries the values the call filled in (session values, earlier answers, the caller's own secrets), and an earlier
/// step's answer is the route's working, not its answer. The whole error stays in the owner's log and the route's
/// stats.
fn told(e: &unbrowse_learn::ReplayError, steps: usize) -> String {
    use unbrowse_learn::ReplayError as E;
    match e {
        // What the site said, read: an error page's title and text ("No results for …"), a JSON error's message, so the
        // agent can tell a search with nothing to show from a broken call.
        E::Failed { step, status, body, .. } if *step == steps => {
            let said = unbrowse_learn::answer::site_said(body);
            if said.is_empty() { format!("the site answered {status}") } else { format!("the site answered {status}: {said}") }
        }
        E::Failed { step, status, url, body } if (200..300).contains(status) && url::Url::parse(url).is_ok_and(|u| unbrowse_learn::page::a_door(*status, body, &u)) => {
            format!("step {step} of {steps} answered {status} with the site's challenge for a person, not its page")
        }
        E::Failed { step, status, .. } => format!("step {step} of {steps} answered {status}"),
        // The site's door, said as what it is and what would earn a way through: not drift, not a missing value.
        E::Door { step, status, door, .. } => format!("step {step} of {steps} answered {status}: the site's door — {}", door.said()),
        E::NeedsBrowser { step, .. } => format!("step {step} of {steps} needs a browser: the page computes a value it sends"),
        E::MissingInput(name) => format!("no value given for input `{name}`"),
        E::MissingMinted(name) => format!("the node's session holds no `{name}`; the site's page must be walked again"),
        E::SourceMissing { step, .. } => format!("step {step} of {steps} takes a value from an earlier answer, and it wasn't there"),
        E::UnsupportedBody { step, .. } => format!("step {step} of {steps} has a body that can't be replayed yet"),
        E::BreaksBody { step, part, .. } => format!("step {step} of {steps}: the value for `{part}` would break the request's body, so it wasn't sent"),
        E::ShapeMismatch { .. } => "the target answered, but not in the recorded shape".into(),
        // What the site said is the target's own answer, as a passing call's would be: said, cut short.
        E::NotAnAnswer { why, .. } => why.clone(),
        E::Http(_) | E::Transport(_) => "a request did not complete".into(),
        E::BadUrl(_) => "a request of the route couldn't be made".into(),
        // The caller named the file, so where the node looked is theirs to see: never what the file holds.
        E::File { input, reason } => format!("file input `{input}`: {reason}"),
        E::Refused(why) => format!("the call wasn't made: {why}"),
        E::RefusedHop(why) => format!("the site answered, and where it sent the call was refused: {why}"),
    }
}

/// A failed call as a bug report may say it: the error's variant, the step and the status, and nothing the site
/// said or was sent. A body, a reason in the site's words, a URL, an input's or a cookie's name: none of them.
pub fn failure_variant(e: &unbrowse_learn::ReplayError, steps: usize) -> String {
    use unbrowse_learn::ReplayError as E;
    match e {
        E::Failed { step, status, .. } => format!("Failed: step {step} of {steps} answered {status}"),
        E::Door { step, status, door, .. } => format!("Door: step {step} of {steps} answered {status} ({:?})", door.kind),
        E::NotAnAnswer { status, .. } => format!("NotAnAnswer: the target answered {status}, not with an answer"),
        E::NeedsBrowser { step, .. } => format!("NeedsBrowser: step {step} of {steps}"),
        E::SourceMissing { step, .. } => format!("SourceMissing: step {step} of {steps}"),
        E::UnsupportedBody { step, .. } => format!("UnsupportedBody: step {step} of {steps}"),
        E::BreaksBody { step, .. } => format!("BreaksBody: step {step} of {steps}"),
        E::MissingInput(_) => "MissingInput".into(),
        E::MissingMinted(_) => "MissingMinted".into(),
        E::ShapeMismatch { .. } => "ShapeMismatch".into(),
        E::Http(_) => "Http".into(),
        E::Transport(_) => "Transport".into(),
        E::BadUrl(_) => "BadUrl".into(),
        E::Refused(_) => "Refused".into(),
        E::RefusedHop(_) => "RefusedHop".into(),
        E::File { .. } => "File".into(),
    }
}

/// Puts the reference back wherever a call's answer or error says a secret the vault filled in: as it was sent, or
/// as an address, a form or a JSON string carries it.
/// The shortest jar value read as a session: shorter ones (`en`, `1`, a currency) are a site's settings, and taking them
/// out of an answer would change what it says.
const JAR_SECRET_LEN: usize = 12;

/// The values the jar of `graph`'s site holds that a call may send as a session, each with the name the reply shows
/// in its place (`jar:<name>`).
fn jar_secrets(graph: &unbrowse_learn::Graph) -> Vec<(String, String)> {
    let Some(host) = unbrowse_learn::client::jar_name(graph) else { return Vec::new() };
    let jar: HashMap<String, String> = store::read_json(&store::jar_path(&host), &unbrowse_files::JAR);
    jar.into_iter().filter(|(_, v)| v.chars().count() >= JAR_SECRET_LEN).map(|(name, v)| (v, format!("jar:{name}"))).collect()
}

/// The inputs that read on from `answer` to the list's next page, never worked out from a secret: None when the route
/// reads on over a secret input (`Paging::over_secret`), or over one the vault filled for this call (`Filled::held`,
/// or a value sent that is one of `Filled::secrets`), since the next page is the value sent plus a step and would hand
/// the secret back. What is handed back is scrubbed as the answer is: a page token that says a secret says its name.
fn next_page(route: &store::Route, filled: &crate::vault::Filled, values: &HashMap<String, String>, answer: &serde_json::Value, scrub: &Scrub) -> Option<HashMap<String, String>> {
    let p = route.paging.as_ref()?;
    let sent = values.get(p.input());
    if p.over_secret(&route.graph) || filled.held.iter().any(|h| h == p.input()) || sent.is_some_and(|v| filled.secrets.iter().any(|(s, _)| s == v)) {
        return None;
    }
    let next = p.next(sent.map(String::as_str), answer)?;
    Some(HashMap::from([(p.input().to_string(), scrub.text(&next))]))
}

/// The jar's session values a call's answer is cleared of, each in every form the one reader knows (`trace::Written`),
/// found in one pass of one finder built for all of them: an answer of a page's state is tens of thousands of strings,
/// and asking each of them every value's reader in turn was half of a call's own time.
struct Scrub {
    finder: Option<aho_corasick::AhoCorasick>,
    /// The name each of the finder's forms is said as.
    names: Vec<String>,
    /// Each value's own reader, where the finder couldn't be built (it can refuse a set past its limits).
    each: Vec<(String, String)>,
}

impl Scrub {
    fn of(secrets: &[(String, String)]) -> Scrub {
        let mut forms: Vec<String> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        for (secret, name) in secrets {
            for (form, _) in unbrowse_learn::trace::Written::of(secret).forms() {
                if !form.is_empty() && !forms.contains(form) {
                    forms.push(form.clone());
                    names.push(name.clone());
                }
            }
        }
        let finder = (!forms.is_empty()).then(|| aho_corasick::AhoCorasick::builder().match_kind(aho_corasick::MatchKind::LeftmostLongest).build(&forms).ok()).flatten();
        let each = if finder.is_none() { secrets.to_vec() } else { Vec::new() };
        Scrub { finder, names, each }
    }

    fn is_empty(&self) -> bool {
        self.finder.is_none() && self.each.is_empty()
    }

    /// `s` with every form of every value, wherever it stands, said as that value's name.
    fn text(&self, s: &str) -> String {
        match &self.finder {
            Some(f) if f.is_match(s) => f.replace_all(s, &self.names),
            Some(_) => s.to_string(),
            None => self.each.iter().fold(s.to_string(), |out, (secret, name)| unbrowse_learn::trace::Written::of(secret).replace_all(&out, name)),
        }
    }

    fn json(&self, v: serde_json::Value) -> serde_json::Value {
        use serde_json::Value;
        if self.is_empty() {
            return v;
        }
        match v {
            Value::String(s) => Value::String(self.text(&s)),
            Value::Number(n) if self.text(&n.to_string()) != n.to_string() => Value::String(self.text(&n.to_string())),
            Value::Array(a) => Value::Array(a.into_iter().map(|v| self.json(v)).collect()),
            Value::Object(m) => Value::Object(m.into_iter().map(|(k, v)| (self.text(&k), self.json(v))).collect()),
            other => other,
        }
    }
}

/// A path fragment distinctive enough to find the target again in a fresh walk: the longest constant segment of the
/// path. Never of the query: a repair looks for the fragment in a call's path, and a query longer than every segment
/// (a GraphQL call's `operationName=…&variables=…`) was a fragment no call's path could hold.
fn fragment(url: &str) -> String {
    url.splitn(4, '/')
        .nth(3)
        .unwrap_or_default()
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .split('/')
        .filter(|s| !s.contains('{') && !s.is_empty())
        .max_by_key(|s| s.len())
        .unwrap_or_default()
        .to_string()
}

/// Whether `answer`, a call of `route` answered whole, holds records where a confirming browse saw the route's
/// records (`Heard::records_at`), and how many: the one reading of it, made on the answer as the site sent it, before a
/// reply chooses its fields (a feed's text without its type, a page's state projected to its names) or cuts it to
/// `REPLY_BUDGET`. Read on the reply instead, a right answer whose view no longer holds the place reads as none, and a
/// confirmed route is browsed for every value. None where the route has no place seen; `Some(None)` where the answer
/// lacks it (`learn::confirm::lacks_its_records`).
pub(crate) fn records_where_seen(route: &store::Route, answer: &serde_json::Value) -> Option<Option<usize>> {
    let place = route.heard.records_at.as_deref()?;
    Some((!crate::learn::confirm::lacks_its_records(route, answer)).then(|| crate::learn::confirm::count_at(answer, place).unwrap_or_default()))
}

/// An answer the browser got for `route`'s ask with `values` (a confirming browse's, `learn::confirm`), as a call of
/// the route hands its answer back: the fields shown are the route's, else the ones its answer's own shape names for
/// what was asked (`fields::defaults_on`), and an answer over `REPLY_BUDGET` is cut, saying so. Nothing is asked of
/// the site; what the ask cost is written by `served_by_the_browser`. The reply is a whole `CallResult`, as
/// agent-api.json publishes it: `ms` is the ask's time to this answer, nothing was paid, and `browser` says whether
/// the browser answered (a walk or a confirming browse) or the route's own call did. It once said that in an
/// `answered_by` the schema never published, and left out `ms`, `paid_usdc`, `paid_unb`, `possible_commit` and
/// `retry`: every learned `unbrowse_do` broke its schema (QA's MCP check, UNB-235).
pub(crate) fn as_a_reply(route: &store::Route, values: &HashMap<String, String>, asked_for: &[String], v: serde_json::Value, ms: u64, browser: bool) -> serde_json::Value {
    let all = unbrowse_learn::fields::paths(&v);
    let held = !route.fields.is_empty()
        && route.fields.iter().filter(|p| all.iter().any(|f| &f.path == *p)).count() * 2 > route.fields.len()
        && !unbrowse_learn::fields::misses_the_records(&route.fields, &all)
        && !unbrowse_learn::fields::records_gone(&route.fields, &all);
    let defaults = if held {
        route.fields.clone()
    } else {
        let asked: Vec<String> = route.inputs.iter().filter(|i| !i.secret && !i.file).filter_map(|i| values.get(&i.name).cloned()).collect();
        let d = unbrowse_learn::fields::defaults_on(&all, &route.what, &asked, &route.root);
        unbrowse_learn::fields::page_defaults(&v, d, &asked)
    };
    let (v, shown) = shown_of_read(route, &v, all, &defaults, asked_for);
    let v = unbrowse_learn::fields::without_addresses(v, &route.what, asked_for);
    let (v, cut) = fit_reply(v, REPLY_BUDGET, asked_for);
    let truncated = cut.map(|cut| Truncated::of(&route.id, cut, None));
    serde_json::json!({ "ok": true, "ms": ms, "data": v, "error": null, "paid_usdc": null, "paid_unb": null, "possible_commit": false, "retry": null, "truncated": truncated, "fields": shown, "browser": browser })
}

/// `answer` as a reply of `route` shows it, its fields already read: its `defaults` and the fields the caller asked
/// for (`fields::shown_for_read`). Fields an agent said are the answer come back as it said them.
fn shown_of_read(route: &store::Route, answer: &serde_json::Value, all: Vec<unbrowse_learn::fields::Field>, defaults: &[String], asked_for: &[String]) -> (serde_json::Value, unbrowse_learn::fields::Shown) {
    let shown_as: Vec<String> = match route.judged.fields {
        true => defaults.iter().chain(asked_for).cloned().collect(),
        false => asked_for.to_vec(),
    };
    unbrowse_learn::fields::shown_for_read(answer, all, defaults, &shown_as, &route.what)
}

/// Writes what an ask of `route` the browser served (a confirming browse, `learn::confirm`) cost, as a call's cost is
/// written: a line of `made.jsonl` at the browser's rung, and the route's last call (`stats.last_at`, `last_ms`,
/// `last_error`). It counts no call and no pass of the route: the browser answered, not the route, and a pass would
/// lift a route nothing confirmed out of provisional (`RouteStats::sighted`). `ms` is the ask's time to its reply.
pub(crate) fn served_by_the_browser(route: &store::Route, ok: bool, ms: u64, error: Option<String>) {
    let mut made = unbrowse_learn::Made::default();
    made.reach(unbrowse_learn::Rung::Browser);
    if ok {
        made.answered(vec![unbrowse_learn::Rung::Browser]);
    }
    log_made(&CallMade::of(route, ok, ms, &made, 0));
    let _ = store::update_route(&route.id, |now| {
        now.stats.last_ms = Some(ms);
        now.stats.last_at = Some(store::now());
        now.stats.last_error = error;
    });
}

/// An answer as a reply carries it: whole when it fits `budget`, else cut down to about it, with what was cut, the
/// fields the caller `named` (their paths, `fields`) kept first. The cut answer, its size, the whole answer's size,
/// the cuts, and the whole answer, when it was cut.
#[allow(clippy::type_complexity)]
pub(crate) fn fit_reply(v: serde_json::Value, budget: usize, named: &[String]) -> (serde_json::Value, Option<(usize, usize, Vec<Cut>, serde_json::Value)>) {
    let total = size(&v);
    if total <= budget {
        return (v, None);
    }
    let mut cuts = Vec::new();
    let named: Vec<&str> = named.iter().map(String::as_str).filter(|n| *n != unbrowse_learn::fields::ALL).collect();
    let kept = fit(v.clone(), budget, "", "", &named, &mut cuts);
    cuts.truncate(20);
    (kept.clone(), Some((size(&kept), total, cuts, v)))
}

/// How many bytes `v` takes written as JSON, the bytes `serde_json` writes, counted as they are written and never
/// kept: a reply is cut by asking each of its parts its size, and writing each part out to measure it copied a page's
/// state again at every level.
fn size(v: &serde_json::Value) -> usize {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0 += b.len();
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, v).map(|_| count.0).unwrap_or(0)
}

/// How many bytes `c` takes in a JSON text, as `serde_json` writes it.
fn json_bytes(c: char) -> usize {
    match c {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

/// An object of more members than this, each larger than its share of a reply, is cut as a list is: by its members.
const MANY_MEMBERS: usize = 20;

/// A text shorter than this is never cut: it is a value, not a body.
const SHORT_TEXT: usize = 1000;

/// `v` cut to about `budget` bytes: a list keeps its first items that fit, an object gives each member a fair share
/// (members smaller than their share stay whole, and the rest split what is left), and a long text keeps its start.
/// Each list or text cut is noted in `cuts` at its JSON pointer. A member at or above a field the caller `named`
/// (`path`, as fields name it) is given what it needs before the rest share what is left.
fn fit(v: serde_json::Value, budget: usize, at: &str, path: &str, named: &[&str], cuts: &mut Vec<Cut>) -> serde_json::Value {
    let whole = size(&v);
    fit_sized(v, whole, budget, at, path, named, cuts)
}

/// [`fit`], with `v`'s size already measured (`whole`): a part's size is measured by its parent to share out the room,
/// and measuring it again on the way in walked every part of a big answer twice at every level.
fn fit_sized(v: serde_json::Value, whole: usize, budget: usize, at: &str, path: &str, named: &[&str], cuts: &mut Vec<Cut>) -> serde_json::Value {
    use serde_json::Value;
    if whole <= budget {
        return v;
    }
    match v {
        Value::Array(a) => {
            let total = a.len();
            let mut out = Vec::new();
            let mut used = 2;
            for (i, item) in a.into_iter().enumerate() {
                let s = size(&item) + 1;
                if used + s <= budget {
                    used += s;
                    out.push(item);
                    continue;
                }
                // The first item alone is over: it is cut down to fit, so the list still shows one. So is a later
                // one where most of the budget is still unspent: the items before it were small and it is the
                // bulk (a key, then the data filed under it), and ending the list there would hand back the key and
                // none of the answer. A list of like records has spent its share by the time one does not fit.
                if out.is_empty() || budget.saturating_sub(used) * 2 >= budget {
                    out.push(fit_sized(item, s - 1, budget.saturating_sub(used), &format!("{at}/{i}"), &format!("{path}[]"), named, cuts));
                }
                break;
            }
            cuts.insert(cuts.iter().position(|c| c.at.starts_with(&format!("{at}/"))).unwrap_or(cuts.len()), Cut { at: at.to_string(), kept: out.len(), total, unit: "items" });
            Value::Array(out)
        }
        Value::Object(m) => {
            let members: Vec<(String, Value, usize)> = m.into_iter().map(|(k, v)| { let s = size(&v); (k, v, s) }).collect();
            let overhead = whole.saturating_sub(members.iter().map(|(_, _, s)| s).sum::<usize>());
            let mut room = budget.saturating_sub(overhead);
            let paths: Vec<String> = members.iter().map(|(k, _, _)| if path.is_empty() { k.clone() } else { format!("{path}.{k}") }).collect();
            // A member the caller named, or one a named field sits in, is kept first: the rest are left what it leaves.
            let is_named = |p: &str| named.iter().any(|n| *n == p || n.starts_with(&format!("{p}.")) || n.starts_with(&format!("{p}[]")));
            let firsts: Vec<usize> = (0..members.len()).filter(|&i| is_named(&paths[i])).collect();
            // Hundreds of records filed by id (a map, not a list) can't each be cut to a share smaller than one of
            // them: each came back whole and the reply went out at three times its budget. Such a map is a list: it
            // keeps the members the caller named, then its first others whole while they fit, and says how many.
            let mut sizes: Vec<usize> = members.iter().map(|(_, _, s)| *s).collect();
            sizes.sort_unstable();
            if members.len() > MANY_MEMBERS && sizes[sizes.len() / 2] > room / members.len() {
                let total = members.len();
                let entry = |k: &str, s: usize| size(&Value::String(k.to_string())) + 1 + s + 1;
                let mut used = 2 + firsts.iter().map(|&i| entry(&members[i].0, members[i].2)).sum::<usize>();
                let mut out = serde_json::Map::new();
                let mut full = false;
                for (i, (k, v, s)) in members.into_iter().enumerate() {
                    if firsts.contains(&i) {
                        out.insert(k, v);
                    } else if !full && used + entry(&k, s) <= budget {
                        used += entry(&k, s);
                        out.insert(k, v);
                    } else {
                        full = true;
                    }
                }
                cuts.insert(cuts.iter().position(|c| c.at.starts_with(&format!("{at}/"))).unwrap_or(cuts.len()), Cut { at: at.to_string(), kept: out.len(), total, unit: "items" });
                return Value::Object(out);
            }
            let mut share = vec![0usize; members.len()];
            // Max-min fair shares: the smallest members first, each kept whole while it fits its share; the named
            // ones among themselves first, then the rest.
            for group in [firsts.clone(), (0..members.len()).filter(|i| !firsts.contains(i)).collect::<Vec<usize>>()] {
                let mut order = group;
                order.sort_by_key(|&i| members[i].2);
                let count = order.len();
                for (n, &i) in order.iter().enumerate() {
                    let fair = room / (count - n);
                    share[i] = members[i].2.min(fair);
                    room = room.saturating_sub(share[i]);
                }
            }
            let mut out = serde_json::Map::new();
            for (i, (k, v, sized)) in members.into_iter().enumerate() {
                let pointer = format!("{at}/{}", k.replace('~', "~0").replace('/', "~1"));
                out.insert(k, fit_sized(v, sized, share[i], &pointer, &paths[i], named, cuts));
            }
            Value::Object(out)
        }
        Value::String(s) if s.chars().count() > SHORT_TEXT => {
            let total = s.chars().count();
            // Its start, as many characters as fit `budget` written as JSON: a quote, a backslash or a letter outside
            // ASCII is more than a byte of the reply.
            let mut room = budget.saturating_sub(2);
            let fits = s.chars().take_while(|c| match json_bytes(*c) {
                n if n <= room => { room -= n; true }
                _ => false,
            }).count();
            let kept = fits.max(SHORT_TEXT / 5).min(total);
            cuts.push(Cut { at: at.to_string(), kept, total, unit: "chars" });
            Value::String(s.chars().take(kept).collect())
        }
        other => other,
    }
}

/// The whole answers of this node's latest calls, cleared of the session as a reply is, for a caller in the node
/// itself that reads the whole of what it asked (a route confirmed by its own call): asked for every field instead,
/// the answer was cut to a reply's size, written to a file and read back, a quarter of that call's time. Keyed by
/// the route and a hash of the values it was called with; the newest few, for a minute.
static WHOLE_HERE: std::sync::Mutex<Vec<(u64, std::time::Instant, std::sync::Arc<serde_json::Value>)>> = std::sync::Mutex::new(Vec::new());

fn whole_key(route: &str, values: &HashMap<String, String>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut pairs: Vec<(&String, &String)> = values.iter().collect();
    pairs.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (route, pairs).hash(&mut h);
    h.finish()
}

fn keep_whole_here(route: &str, values: &HashMap<String, String>, v: &serde_json::Value) {
    let mut kept = WHOLE_HERE.lock().unwrap_or_else(|e| e.into_inner());
    let key = whole_key(route, values);
    kept.retain(|(k, at, _)| *k != key && at.elapsed() < std::time::Duration::from_secs(60));
    kept.push((key, std::time::Instant::now(), std::sync::Arc::new(v.clone())));
    let over = kept.len().saturating_sub(4);
    kept.drain(..over);
}

/// The whole answer of this node's latest call of `route` with `values`, made within the last minute: taken, so it is
/// read once. None where there is none: the caller asks for the whole answer instead.
pub(crate) fn take_whole_here(route: &str, values: &HashMap<String, String>) -> Option<serde_json::Value> {
    let mut kept = WHOLE_HERE.lock().unwrap_or_else(|e| e.into_inner());
    let key = whole_key(route, values);
    let at = kept.iter().position(|(k, at, _)| *k == key && at.elapsed() < std::time::Duration::from_secs(60))?;
    let (_, _, v) = kept.remove(at);
    Some(std::sync::Arc::try_unwrap(v).unwrap_or_else(|v| (*v).clone()))
}

/// Keeps a whole answer a reply was cut from, for its caller to read on the node's machine: the newest few only.
fn keep_whole(route: &str, v: &serde_json::Value) -> Option<String> {
    const KEPT: usize = 20;
    let dir = store::home().join("answers");
    unbrowse_files::private::dir_at(&dir).ok()?;
    let name: String = route.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    let path = dir.join(format!("{}-{name}.json", now_ms()));
    unbrowse_files::private::write(&path, &serde_json::to_vec(v).ok()?).ok()?;
    let mut old: Vec<std::path::PathBuf> = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    old.sort();
    for p in old.iter().take(old.len().saturating_sub(KEPT)) {
        let _ = std::fs::remove_file(p);
    }
    Some(path.to_string_lossy().into_owned())
}

/// A site for tests: answers each path it knows with its status, type and body, on 127.0.0.1. Its port.
#[cfg(test)]
pub(crate) fn test_site(pages: Vec<(&'static str, u16, &'static str, String)>) -> u16 {
    use std::io::{BufRead, Write};
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = site.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in site.incoming().flatten() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            let _ = reader.read_line(&mut first);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let path = first.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
            let (status, kind, body) = pages.iter().find(|(p, ..)| *p == path).map(|(_, s, k, b)| (*s, *k, b.clone())).unwrap_or((404, "text/plain", "no such page".into()));
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    port
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_call_for_an_ask_that_said_browser_never_opens_no_browser() {
        crate::browsers::for_this_test(Some("/bin/true".to_string()));
        assert!(super::the_calls_browser().is_some(), "with a browser here, a call may open it");
        assert_eq!(super::with_the_browser_shut(true, super::the_calls_browser), None, "never: not to sign, heal or learn again");
        assert!(super::the_calls_browser().is_some(), "only the calls made for that ask");
        let (inner, outer_after) = super::with_the_browser_shut(true, || (super::with_the_browser_shut(false, super::browser_shut), super::browser_shut()));
        assert_eq!((inner, outer_after, super::browser_shut()), (false, true, false), "each scope restores what was");
        crate::browsers::for_this_test(None);
    }

    /// A target that answered an error status with a page says what the page says (its title and text), never its
    /// markup: a search that found nothing is told apart from a broken call by reading it.
    #[test]
    fn a_failed_call_says_what_the_sites_page_says() {
        let page = "<!DOCTYPE html>\n<html id=\"searchTemplate\"><head><title>No results for zqx | Recipes</title><script>var x=1</script></head><body><h1>Sorry, we couldn't find results for zqx</h1></body></html>";
        let e = unbrowse_learn::ReplayError::Failed { step: 1, url: "https://r.example/search?q=zqx".into(), status: 404, body: page.into() };
        let said = told(&e, 1);
        assert!(said.starts_with("the site answered 404: ") && said.contains("No results for zqx") && said.contains("couldn't find results"), "{said}");
        assert!(!said.contains("<!DOCTYPE") && !said.contains("var x"), "{said}");
    }

    use super::*;

    /// The walk that exposed it: a GraphQL search at `/graphql?operationName=…&variables=…`. Its query is longer than
    /// its one path segment, was taken as the fragment, and the repair never found the call in the page it walked.
    #[test]
    fn the_fragment_a_repair_looks_for_is_of_the_path() {
        assert_eq!(fragment("https://news.example/graphql?wp-site=aje&operationName=SearchQuery&variables=%7B%22query%22%3A%22climate%22%7D"), "graphql");
        assert_eq!(fragment("https://shop.example/api/v2/{path[2]}/search-results?q={q}"), "search-results");
    }

    fn route() -> store::Route {
        serde_json::from_value(serde_json::json!({
            "id": "r1", "site": "crates.io", "what": "search crates", "method": "GET", "path": "/api/v1/crates?q={q}",
            "root": "https://crates.io/", "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false,
            "provisional": false, "learned_at": 1, "graph": { "steps": [], "provisional": false }
        }))
        .expect("a route")
    }

    /// A route another node listed acts in the owner's session only on their yes to that route as it is: asked once and
    /// kept, asked again when the route changes (a heal, another body), not kept on a no, and not asked at all when the
    /// route could use no session. The node's own route is never asked about.
    #[test]
    fn the_owner_allows_a_shared_route_their_session_once_per_route() {
        store::scratch_home("run-shared-session");
        let step = |path: &str| serde_json::json!({ "exchange": 0, "method": "GET", "status": 200, "url": format!("https://shop.example.com{path}"), "fields": [], "needs_browser": false, "foreign": true });
        let mut r = route();
        r.site = "shop.example.com".into();
        r.graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [step("/account/sign-out")] })).unwrap();
        let fetched = |r: &mut store::Route| r.fetched = Some(store::Fetched { entry_id: "0x1".into(), route_id: "r".into(), agent_id: "7".into(), content_id: "sha256:ab".into(), listed_as: "x".into(), fetched_at: 1 });
        let asked = std::cell::Cell::new(0);
        let mut yes = |_: String| { asked.set(asked.get() + 1); Ok(()) };
        // Its own route: no key, never asked.
        assert!(!owner_session_for(&r, &run_graph(&r), &mut yes).is_some() && asked.get() == 0);
        fetched(&mut r);
        assert!(!owner_session_for(&r, &run_graph(&r), &mut yes).is_some() && asked.get() == 0, "no session of the owner's and none named: nothing to ask");
        std::fs::create_dir_all(store::jars_dir()).unwrap();
        store::write_json(&store::jar_path("shop.example.com"), &unbrowse_files::JAR, &HashMap::from([("sid", "owners")])).unwrap();
        let mut shown = String::new();
        assert!(!owner_session_for(&r, &run_graph(&r), &mut |q| { shown = q; Err("no".into()) }).is_some(), "a no runs it with none");
        assert!(shown.contains("GET https://shop.example.com/account/sign-out") && shown.contains("whatever its method"), "{shown}");
        assert!(owner_session_for(&r, &run_graph(&r), &mut yes).is_some() && asked.get() == 1, "asked again after a no, and the yes holds");
        assert!(owner_session_for(&r, &run_graph(&r), &mut yes).is_some() && asked.get() == 1, "kept: not asked twice");
        r.graph.steps[0].url = "https://shop.example.com/account/unsubscribe".into();
        assert!(owner_session_for(&r, &run_graph(&r), &mut yes).is_some() && asked.get() == 2, "a changed route is asked about again");
    }

    /// The owner is shown everything the route would send in their session, bounded and in plain ASCII, or nothing is
    /// asked: each request in order (a repeat is listed again), its full address with any port and the query the call
    /// builds, a fixed query value, every value and where it comes from, the body as templated, the exact origins the
    /// session goes to, the start page and the page the requests claim. A route holding what the question can't
    /// describe (page code, a producer, a multipart or opaque body, a value from the page's code) or past a bound is
    /// never asked about.
    #[test]
    fn the_consent_question_shows_every_sent_detail_or_refuses() {
        let graph = |steps: Vec<serde_json::Value>| -> unbrowse_learn::Graph { serde_json::from_value(serde_json::json!({ "provisional": false, "page_origin": "https://bank.example.com", "steps": steps })).unwrap() };
        let transfer = serde_json::json!({ "exchange": 0, "method": "POST", "status": 200, "url": "https://bank.example.com:8443/api/move", "needs_browser": false, "foreign": true,
            "fields": [{ "loc": { "in": "query", "key": "action" }, "class": "constant", "value": "delete" },
                       { "loc": { "in": "query", "key": "to" }, "class": "constant", "value": "acct-8812\u{202e}evil" },
                       { "loc": { "in": "query", "key": "amount" }, "class": "input", "name": "amount", "secret": false },
                       { "loc": { "in": "header", "key": "x-mode" }, "class": "constant", "value": "wire" }],
            "body": { "kind": "json", "template": { "memo": "rent", "payee": null }, "types": { "/payee": "string" } } });
        let poll = |n: usize| serde_json::json!({ "exchange": n, "method": "GET", "status": 200, "url": "https://bank.example.com/poll", "needs_browser": false, "fields": [] });
        let q = consent_question("bank.example.com", "https://bank.example.com/start", &graph(vec![poll(0), transfer.clone(), poll(2)])).expect("a describable route is shown");
        assert!(q.contains("2. POST https://bank.example.com:8443/api/move?action={action}&to={to}&amount={amount}"), "the full address, port and query: {q}");
        assert!(q.contains("query action: \"delete\" (fixed in the route)"), "{q}");
        assert!(q.contains("query to: \"acct-8812\\u{202e}evil\" (fixed in the route)"), "bidi written out: {q}");
        assert!(q.contains("header x-mode: \"wire\" (fixed in the route)"), "{q}");
        assert!(q.contains(r#"JSON body, as sent with the values above in its null places: {"memo":"rent","payee":null}"#), "{q}");
        assert!(q.contains("1. GET https://bank.example.com/poll") && q.contains("3. GET https://bank.example.com/poll"), "in order, repeats listed: {q}");
        assert!(q.contains("at https://bank.example.com, https://bank.example.com:8443, and nowhere else") && q.contains("another host of bank.example.com included"), "the exact origins: {q}");
        assert!(q.contains("Its start page, https://bank.example.com/start, is fetched with your session"), "{q}");
        assert!(q.contains("Its requests say they come from https://bank.example.com."), "{q}");
        assert!(q.contains("which can be a sign-in of the route's own"), "the in-call session: {q}");
        assert!(q.chars().all(|c| c == '\n' || c == ' ' || c.is_ascii_graphic()), "plain ASCII only");
        // An international host is shown in its xn-- form.
        let idn = serde_json::json!({ "exchange": 0, "method": "GET", "status": 200, "url": "https://bänk.example.com/a", "needs_browser": false, "fields": [] });
        assert!(consent_question("xn--bnk-qla.example.com", "", &graph(vec![idn])).unwrap().contains("GET https://xn--bnk-qla.example.com/a"));
        // What the question can't describe is never asked about.
        let with = |f: &dyn Fn(&mut serde_json::Value)| { let mut t = transfer.clone(); f(&mut t); consent_question("bank.example.com", "", &graph(vec![t])) };
        assert_eq!(with(&|t| t["body"] = serde_json::json!({ "kind": "multipart", "boundary": "b", "parts": [{ "name": "p", "json": { "a": 1 } }] })), None, "a multipart body");
        assert_eq!(with(&|t| t["body"] = serde_json::json!({ "kind": "other" })), None, "an opaque body");
        assert_eq!(with(&|t| t["fields"][0] = serde_json::json!({ "loc": { "in": "header", "key": "x-sig" }, "class": "computed" })), None, "a value the page's code makes");
        assert_eq!(with(&|t| t["page_signed"] = serde_json::Value::Bool(true)), None, "a step the page signs");
        assert_eq!(with(&|t| t["needs_browser"] = serde_json::Value::Bool(true)), None, "a step a browser runs");
        let mut scripted = graph(vec![transfer.clone()]);
        scripted.scripts.push(unbrowse_learn::signing::Script { url: "https://bank.example.com/app.js".into(), body: "x()".into() });
        assert_eq!(consent_question("bank.example.com", "", &scripted), None, "page code");
        let mut paged = graph(vec![transfer.clone()]);
        paged.page = Some("https://bank.example.com/".into());
        assert_eq!(consent_question("bank.example.com", "", &paged), None, "a page it boots");
        // Past a bound: refused, never shown in part.
        let many: Vec<serde_json::Value> = (0..=ASK_REQUESTS).map(poll).collect();
        assert_eq!(consent_question("bank.example.com", "", &graph(many)), None);
        assert_eq!(with(&|t| t["body"]["template"]["memo"] = serde_json::Value::from("x".repeat(ASK_BODY_CHARS))), None, "a body too long");
        assert_eq!(with(&|t| t["fields"][0]["value"] = serde_json::Value::from("x".repeat(ASK_VALUE_CHARS + 1))), None, "a value too long");
    }

    /// A value taken from an earlier answer is said exactly, so a changed selector is a changed question: the JSON
    /// pointer (and where the caller's value takes a segment's place), the header, the cookie the answer sets, the text
    /// marks and their occurrence, and any text sent around it. A selector too long to show refuses the question. An
    /// address with a user name or password in it (sent as credentials, outside every field) is never asked about,
    /// whether a step's or the start page's.
    #[test]
    fn the_consent_question_shows_how_a_value_is_read_and_refuses_credentials_in_an_address() {
        let graph = |at: serde_json::Value, wrap: Option<(&str, &str)>| -> unbrowse_learn::Graph {
            let mut origin = serde_json::json!({ "exchange": 0, "url": "https://bank.example.com/me", "at": at });
            if let Some((b, a)) = wrap {
                origin["wrap"] = serde_json::json!([b, a]);
            }
            serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://bank.example.com/me", "needs_browser": false,
                  "fields": [{ "loc": { "in": "query", "key": "acct" }, "class": "input", "name": "acct", "secret": false, "default": "main" }] },
                { "exchange": 1, "method": "POST", "status": 200, "url": "https://bank.example.com/send", "needs_browser": false,
                  "fields": [{ "loc": { "in": "header", "key": "x-token" }, "class": "derived", "origin": origin }] }
            ]}))
            .unwrap()
        };
        let ask = |g: &unbrowse_learn::Graph| consent_question("bank.example.com", "https://bank.example.com/", g);
        let q = ask(&graph(serde_json::json!({ "from": "json", "pointer": "/accounts/main/token" }), None)).unwrap();
        assert!(q.contains("header x-token: the value at JSON pointer \"/accounts/main/token\" (where it names a walked value, your agent's value for acct takes its place) in the answer to request 1, sent on as read"), "{q}");
        let q = ask(&graph(serde_json::json!({ "from": "header", "name": "x-csrf" }), Some(("Bearer ", "")))).unwrap();
        assert!(q.contains("its header \"x-csrf\" in the answer to request 1, sent on as read, sent as \"Bearer \" + that value + \"\""), "{q}");
        let q = ask(&graph(serde_json::json!({ "from": "set_cookie", "name": "sid" }), None)).unwrap();
        assert!(q.contains("the cookie \"sid\" it sets in the answer to request 1"), "{q}");
        let q = ask(&graph(serde_json::json!({ "from": "text", "before": "key=\"", "after": "\"", "nth": 2 }), None)).unwrap();
        assert!(q.contains("the text after occurrence 3 of \"key=\"\" up to \"\"\" in the answer to request 1"), "{q}");
        // Two routes that differ only in the selector ask different questions.
        assert_ne!(ask(&graph(serde_json::json!({ "from": "json", "pointer": "/a" }), None)), ask(&graph(serde_json::json!({ "from": "json", "pointer": "/b" }), None)));
        assert_eq!(ask(&graph(serde_json::json!({ "from": "json", "pointer": format!("/{}", "x".repeat(ASK_VALUE_CHARS)) }), None)), None, "a selector too long to show");
        // Credentials in an address.
        let mut g = graph(serde_json::json!({ "from": "json", "pointer": "/a" }), None);
        g.steps[1].url = "https://alice:s3cret@bank.example.com/send".into();
        assert_eq!(ask(&g), None, "a step's address");
        let g = graph(serde_json::json!({ "from": "json", "pointer": "/a" }), None);
        assert_eq!(consent_question("bank.example.com", "https://alice:s3cret@bank.example.com/", &g), None, "the start page's address");
    }

    /// A route that came from another node, whose write sends what an earlier step read, puts the question to the owner
    /// when they hold a session for the site (that read may be their own account's data), naming the write and where the
    /// value came from. A write that sends only the caller's values, or an owner with no session there, asks nothing.
    #[test]
    fn the_owner_is_asked_before_a_shared_write_carries_what_their_session_read() {
        store::scratch_home("run-session-reads");
        let graph = |derived: bool| -> unbrowse_learn::Graph {
            let from = if derived {
                serde_json::json!({ "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example.com/api/me", "at": { "from": "json", "pointer": "/email" } } })
            } else {
                serde_json::json!({ "class": "input", "name": "text", "secret": false })
            };
            let mut field = serde_json::json!({ "loc": { "in": "query", "key": "text" } });
            field.as_object_mut().unwrap().extend(from.as_object().unwrap().clone());
            serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example.com/api/me", "fields": [], "needs_browser": false, "foreign": true },
                { "exchange": 1, "method": "POST", "status": 200, "url": "https://shop.example.com/api/comments", "fields": [field], "needs_browser": false, "foreign": true }
            ]}))
            .unwrap()
        };
        let mut r = route();
        r.site = "shop.example.com".into();
        r.graph = graph(true);
        assert_eq!(session_reads_in_writes(&r), None, "no session of the owner's to read under");
        std::fs::create_dir_all(store::jars_dir()).unwrap();
        store::write_json(&store::jar_path("shop.example.com"), &unbrowse_files::JAR, &HashMap::from([("sid", "owners")])).unwrap();
        let q = session_reads_in_writes(&r).expect("the owner is asked");
        assert!(q.contains("POST /api/comments") && q.contains("/api/me"), "{q}");
        r.graph = graph(false);
        assert_eq!(session_reads_in_writes(&r), None, "the caller's own value");
    }

    /// Calls running at once each carry their own id, the same on `start` and `end`: a window pairs them by it.
    /// A heal is paid for once: the chain it found is the route the next call runs, listed or not, and the route's
    /// place stays. A route someone relearned while the call ran keeps what they learned.
    #[test]
    fn a_healed_chain_becomes_the_route() {
        store::scratch_home("run-healed-chain");
        let chain = |url: &str| -> unbrowse_learn::Graph {
            serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": [], "needs_browser": false }
            ]}))
            .unwrap()
        };
        let mut r = route();
        r.id = "healed".into();
        r.graph = chain("https://shop.example/old");
        r.listing = Some(store::Listing { entry_id: "0x1".into(), tx: "0x2".into(), listed_at: 1, live: true });
        store::save_route(&r).unwrap();

        record(&r, None, true, 1, None, None, Some(chain("https://shop.example/new")), unbrowse_learn::health::Said::Nothing);
        let kept = store::load_route("healed").unwrap();
        assert_eq!(kept.graph.steps[0].url, "https://shop.example/new");
        assert!(kept.listing.is_some_and(|l| l.live), "the route keeps its place");

        // The copy this call ran is older than what's on disk now.
        record(&r, None, true, 1, None, None, Some(chain("https://shop.example/late")), unbrowse_learn::health::Said::Nothing);
        assert_eq!(store::load_route("healed").unwrap().graph.steps[0].url, "https://shop.example/new", "a route changed meanwhile keeps the change");

        let now = store::load_route("healed").unwrap();
        record(&now, None, false, 1, None, None, None, unbrowse_learn::health::Said::Nothing);
        assert_eq!(store::load_route("healed").unwrap().graph.steps[0].url, "https://shop.example/new", "a call with no proved heal changes nothing");
    }

    /// A refusal is written on the step that got it, in the route's own record: which step, how, with what status and
    /// when. The step before it answered in that call; the route's last error alone no longer has to say all of that.
    /// The next call that passes clears it and keeps when it was.
    #[test]
    fn a_refusal_is_recorded_on_the_step_that_got_it() {
        use unbrowse_learn::health::{Refused, Said};
        store::scratch_home("run-step-health");
        let mut r = route();
        r.id = "stepped".into();
        r.graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/me", "fields": [], "needs_browser": false },
            { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/list?q=lamp", "fields": [], "needs_browser": false }
        ]}))
        .unwrap();
        store::save_route(&r).unwrap();

        record(&r, None, false, 1, Some("step 2 met the site's door".into()), None, None, Said::Refused(2, Refused::Door, Some(403)));
        let kept = store::load_route("stepped").unwrap();
        let (me, list) = (kept.stats.health.of(&kept.graph.steps[0]).expect("the first step"), kept.stats.health.of(&kept.graph.steps[1]).expect("the refused step"));
        assert!(me.answered_at.is_some() && !me.stale(), "the step before the refusal answered: {me:?}");
        assert_eq!((list.how, list.status, list.refusals), (Some(Refused::Door), Some(403), 1), "{list:?}");
        assert!(list.refused_at.is_some() && list.answered_at.is_none());
        assert_eq!(kept.stats.health.stale(&kept.graph), vec![1]);
        assert!(kept.stats.health.steps.keys().any(|k| k == "GET https://shop.example/api/list"), "a step is named without the values it was asked with: {:?}", kept.stats.health.steps.keys());

        record(&kept, None, true, 1, None, None, None, Said::Answered);
        let kept = store::load_route("stepped").unwrap();
        let list = kept.stats.health.of(&kept.graph.steps[1]).unwrap();
        assert!(!list.stale() && list.answered_at.is_some() && list.refused_at.is_some() && list.refusals == 0, "{list:?}");

        // A failure that says nothing of the site leaves the record as it was.
        let before = kept.stats.health.clone();
        record(&kept, None, false, 1, Some("no value given".into()), None, None, Said::Nothing);
        assert_eq!(store::load_route("stepped").unwrap().stats.health, before);
    }

    /// A route's body is learned from the walks its graph is: a heal's chain, found on a walk of its own, takes the
    /// body's place with it, and a learn of the same call again puts its own body beside its own graph, or none. A
    /// call that healed nothing keeps the body.
    #[test]
    fn a_heal_or_a_learn_again_carries_its_own_body_and_never_the_old_one() {
        store::scratch_home("run-body-goes");
        let chain = |url: &str| -> unbrowse_learn::Graph {
            serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": [], "needs_browser": false }
            ]}))
            .unwrap()
        };
        let bodied = |url: &str| {
            let mut r = route();
            r.id = "bodied".into();
            r.graph = chain(url);
            r.body = Some(unbrowse_learn::body::from_graph(&r.graph, "shop.example"));
            r
        };
        let r = bodied("https://shop.example/old");
        store::save_route(&r).unwrap();
        assert_eq!(store::load_route("bodied").unwrap().body, r.body, "a body is kept on the route's record");
        record(&r, None, true, 1, None, None, None, unbrowse_learn::health::Said::Nothing);
        assert!(store::load_route("bodied").unwrap().body.is_some(), "a call that healed nothing keeps it");
        record(&store::load_route("bodied").unwrap(), None, true, 1, None, None, Some(chain("https://shop.example/new")), unbrowse_learn::health::Said::Nothing);
        let healed = store::load_route("bodied").unwrap();
        assert_eq!(healed.graph.steps[0].url, "https://shop.example/new");
        assert!(healed.body.is_none(), "the heal's chain is from another walk, and the body goes");
        // Learned again: the new record's own body, or none, whatever the old one carried.
        store::save_route(&r).unwrap();
        let mut again = bodied("https://shop.example/again");
        again.body = None;
        let (kept, fresh) = store::keep_learned(again).unwrap();
        assert!(fresh && kept.body.is_none() && store::load_route("bodied").unwrap().body.is_none(), "learned again with no body, it keeps none");
        let with = bodied("https://shop.example/with");
        let (kept, _) = store::keep_learned(with.clone()).unwrap();
        assert_eq!((kept.body.clone(), store::load_route("bodied").unwrap().body), (with.body.clone(), with.body), "learned again with a body, it keeps that one");
    }

    #[test]
    fn a_call_ends_under_the_id_it_started_with() {
        let r = route();
        let a = CallEvent::start(&r, "Claude", Some(0));
        let b = CallEvent::start(&r, "Claude", Some(0));
        assert_ne!(a.id, b.id);
        let res = CallResult { ok: true, ms: 412, data: None, error: None, possible_commit: false, retry: Some(unbrowse_learn::Retry::AsIs), truncated: None, refused: None, variant: None, fields: None, more: None, browser: false, fell_back: Vec::new(), unheld: None, learned_again: None, records: None };
        let end = b.end(&res, None);
        assert_eq!((end.id, end.phase, end.ok, end.ms), (b.id, "end", Some(true), Some(412)));
        assert!(end.at_ms >= b.at_ms);
        let failed = a.failed();
        assert_eq!((failed.id, failed.ok), (a.id, Some(false)));
        let text = serde_json::to_string(&end).unwrap();
        assert!(text.contains(r#""id":"#) && text.contains(r#""at_ms":"#));
    }

    /// External security review round 3, 2026-11-04. A password a page shows (the vault's for the site, or one the
    /// node typed there) is said as its login's name in a route's answer, its error and the activity log too, as in a
    /// browse reply, however the page encodes it.
    #[test]
    fn a_password_a_page_shows_never_comes_back_from_a_route_or_into_the_log() {
        use base64::Engine;
        store::scratch_home("run-shown-password");
        let pw = "Sh0wn-Pass-91";
        let b64 = base64::engine::general_purpose::STANDARD.encode(pw);
        let port = test_site(vec![
            ("/rows", 200, "application/json", serde_json::json!({ "note": format!("your password is {pw}"), "b64": b64, "html": "Sh0wn&#45;Pass-91" }).to_string()),
            ("/broken", 500, "text/plain", format!("failed for password {pw}")),
        ]);
        crate::browse::know(&unbrowse_learn::identity::site_of("127.0.0.1"), pw, "vault:127.0.0.1:me");
        read_route("shown", &format!("http://127.0.0.1:{port}/rows"));
        let r = call("shown", &HashMap::new(), "You").unwrap();
        let out = serde_json::to_string(&r.data).unwrap();
        assert!(r.ok && !out.contains(pw) && !out.contains(&b64) && out.contains("vault:127.0.0.1:me"), "{out}");
        read_route("broken", &format!("http://127.0.0.1:{port}/broken"));
        let r = call("broken", &HashMap::new(), "You").unwrap();
        assert!(!r.ok);
        assert!(!r.error.as_deref().unwrap_or_default().contains(pw), "{:?}", r.error);
        let logged = serde_json::to_string(&store::read_activity(20)).unwrap();
        assert!(!logged.contains(pw), "the activity log says the name: {logged}");
    }

    #[test]
    fn a_vault_secret_is_never_returned_in_a_call_reply() {
        let secrets = [("dummy pw&123".to_string(), "vault:example.com:me".to_string()), ("482913".to_string(), "vault:code:example.com:me".to_string())];
        let scrub = Scrub::of(&secrets);
        let data = serde_json::json!({ "echo": "you sent dummy pw&123", "code": 482913, "list": [{ "dummy pw&123": "k" }] });
        let out = scrub.json(data).to_string();
        assert!(!out.contains("dummy pw&123") && !out.contains("482913"), "{out}");
        assert!(out.contains("vault:example.com:me") && out.contains("vault:code:example.com:me"));
        // As an address or a form carries it, too.
        let error = "step 2 (https://example.com/login?pw=dummy%20pw%26123) answered 400: {\"pw\":\"dummy+pw%26123\"}";
        let told = scrub.text(error);
        assert!(!told.contains("dummy") && told.matches("vault:example.com:me").count() == 2, "{told}");
    }

    /// A call's answer is cleared of the jar's session values by one finder for all of them: a big answer holding none
    /// of them comes back as it was, and one holding them, in any form, says each value's name in its place.
    #[test]
    fn an_answer_is_cleared_of_the_jars_values_in_one_pass() {
        let secrets: Vec<(String, String)> = (0..40).map(|i| (format!("cookieValue{i:03}XyZ987"), format!("jar:c{i}"))).collect();
        let scrub = Scrub::of(&secrets);
        let page = serde_json::json!({ "rows": (0..2000).map(|i| serde_json::json!({ "title": format!("Item {i}"), "url": format!("https://shop.example/p/{i}") })).collect::<Vec<_>>() });
        assert_eq!(scrub.json(page.clone()), page, "nothing of the jar's: the same answer");
        let held = serde_json::json!({ "a": "sent cookieValue007XyZ987 back", "b": "x=cookieValue039XyZ987&y=1", "cookieValue001XyZ987": 1 });
        let out = scrub.json(held).to_string();
        assert!(!out.contains("cookieValue"), "{out}");
        assert!(out.contains("jar:c7") && out.contains("jar:c39") && out.contains("jar:c1"), "{out}");
        assert!(Scrub::of(&[]).is_empty());
    }

    /// A call's whole answer is kept for a reader in the node for the values it was called with, and read once.
    #[test]
    fn a_calls_whole_answer_is_kept_for_its_values_and_read_once() {
        let id = format!("whole-{}", std::process::id());
        let asked = HashMap::from([("q".to_string(), "lamps".to_string())]);
        keep_whole_here(&id, &asked, &serde_json::json!({ "items": [1, 2, 3] }));
        assert_eq!(take_whole_here(&id, &HashMap::from([("q".to_string(), "chairs".to_string())])), None, "another value's");
        assert_eq!(take_whole_here(&id, &asked), Some(serde_json::json!({ "items": [1, 2, 3] })));
        assert_eq!(take_whole_here(&id, &asked), None, "read once");
    }

    /// A value's size is the bytes `serde_json` writes for it, counted without writing them anywhere.
    #[test]
    fn a_values_size_is_the_bytes_its_json_takes() {
        for v in [serde_json::json!(null), serde_json::json!({ "a": [1, 2.5, "x\"y\n"], "é": { "b": true } }), serde_json::json!("ünïcode \u{1}")] {
            assert_eq!(size(&v), serde_json::to_vec(&v).unwrap().len(), "{v}");
        }
    }

    /// The caller is told which step failed and how; never the request as it was sent, nor an earlier step's answer.
    #[test]
    fn a_failed_call_never_tells_its_caller_the_request_it_sent() {
        use unbrowse_learn::ReplayError;
        let failed = |step| ReplayError::Failed { step, url: "https://example.com/api?session=DUMMY-TOKEN-1".into(), status: 400, body: "DUMMY-BODY-2".into() };
        let earlier = told(&failed(1), 2);
        assert!(!earlier.contains("DUMMY-TOKEN-1") && !earlier.contains("DUMMY-BODY-2"), "{earlier}");
        assert!(earlier.contains("step 1 of 2") && earlier.contains("400"));
        // The target's own answer is what a passing call hands back: it is said, cut short, without the address.
        let target = told(&failed(2), 2);
        assert!(target.contains("DUMMY-BODY-2") && !target.contains("DUMMY-TOKEN-1"), "{target}");
        let transport = told(&ReplayError::Transport("error sending request for url (https://example.com/?session=DUMMY-TOKEN-1)".into()), 2);
        assert!(!transport.contains("DUMMY-TOKEN-1"));
    }

    /// A page the chain reads a value from that came back as the site's check for a person (served 202, as a hotel
    /// site's WAF does) is said as that, never as a value missing at the next step.
    #[test]
    fn an_earlier_step_met_by_a_challenge_says_so() {
        use unbrowse_learn::ReplayError;
        let door = r#"<html><head><title>Human Verification</title><script src="https://token.awswaf.example/challenge.js"></script></head><body><div id="captcha-container"></div></body></html>"#;
        let e = ReplayError::Failed { step: 1, url: "https://hotels.example/searchresults.html?ss=Bangkok".into(), status: 202, body: door.into() };
        let said = told(&e, 2);
        assert!(said.contains("step 1 of 2") && said.contains("challenge"), "{said}");
        let plain = ReplayError::Failed { step: 1, url: "https://hotels.example/x".into(), status: 400, body: "{}".into() };
        assert!(!told(&plain, 2).contains("challenge"));
    }

    /// What a bug report may say of a failed call is its variant, step and status: never the target's answer the
    /// caller is told, the address, a reason in the site's words, nor an input's or cookie's name.
    #[test]
    fn a_failed_call_tells_a_bug_report_only_its_variant_and_status() {
        use unbrowse_learn::ReplayError as E;
        let site = "DUMMY-SITE-WORDS Dear John Smith, account 4111";
        let errors = [
            E::Failed { step: 2, url: "https://bank.example/acct/42?session=DUMMY-TOKEN-1".into(), status: 403, body: site.into() },
            E::NotAnAnswer { status: 200, why: site.into(), challenge: false },
            E::MissingInput("john_smith_email".into()),
            E::MissingMinted("DUMMY-COOKIE".into()),
            E::Refused(format!("bank.example: {site}")),
            E::Transport(format!("https://bank.example/?session=DUMMY-TOKEN-1 {site}")),
            E::NeedsBrowser { step: 1, url: "https://bank.example/acct/42".into(), loc: unbrowse_learn::Loc::Query("DUMMY-NAME".into()) },
        ];
        for e in &errors {
            let v = failure_variant(e, 2);
            for leak in ["DUMMY", "John", "bank", "4111", "session", "john_smith"] {
                assert!(!v.contains(leak), "{leak} in {v}");
            }
        }
        assert_eq!(failure_variant(&errors[0], 2), "Failed: step 2 of 2 answered 403");
        assert_eq!(failure_variant(&errors[1], 2), "NotAnAnswer: the target answered 200, not with an answer");
        assert!(told(&errors[0], 2).contains("DUMMY-SITE-WORDS"), "the caller is still told the target's answer");
        // Each counts in telemetry under its variant's own class, from the fixed list, and never as a plain `site`.
        let classes: Vec<&str> = errors.iter().map(|e| crate::telemetry::failure_class(Some(&failure_variant(e, 2)))).collect();
        assert_eq!(classes, ["step_status", "not_an_answer", "missing_input", "missing_minted", "refused", "transport", "needs_browser"]);
        assert_eq!(crate::telemetry::failure_class(Some("Socket: the socket call failed")), "socket");
        assert!(classes.iter().all(|c| crate::telemetry::ERROR_CLASSES.contains(c)));
    }

    /// An earlier step that writes makes the call a write: the retry advice never says "as it was" once it may have
    /// landed, though the target only reads.
    #[test]
    fn a_route_whose_earlier_step_writes_is_retried_as_a_write() {
        let mut r = route();
        r.graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": "POST", "status": 201, "url": "https://example.com/api/items", "fields": [], "needs_browser": false, "sets_cookie": false },
            { "exchange": 1, "method": "GET", "status": 200, "url": "https://example.com/api/items/1", "fields": [], "needs_browser": false, "sets_cookie": false }
        ]}))
        .unwrap();
        r.write = false;
        let mut ledger = unbrowse_learn::Ledger::of(&r.graph);
        ledger.sending(1);
        assert!(ledger.possible_commit());
        assert_eq!(ledger.retry(writes(&r)), unbrowse_learn::Retry::CheckFirst);
        ledger.answered(1, 201);
        assert_eq!(ledger.retry(writes(&r)), unbrowse_learn::Retry::Never);
    }

    /// `provisional` has a way out: the site taking the route on a second day. Passes in one sitting or a failed call
    /// aren't it, and learning the call again doesn't put the mark back.
    #[test]
    fn a_route_stops_being_provisional_once_the_site_took_it_on_a_second_day() {
        let _home = store::scratch_home("provisional");
        let url = "https://example.com/rows";
        let mut r = read_route("once", url);
        r.provisional = true;
        store::save_route(&r).unwrap();
        let mark = |ok: bool| record(&r, None, ok, 1, None, None, None, unbrowse_learn::health::Said::Nothing);
        let provisional = || store::load_route("once").unwrap().provisional;
        mark(true);
        mark(true);
        assert!(provisional(), "one sitting");
        store::update_route("once", |r| r.stats.last_pass_day -= 1).unwrap();
        mark(false);
        assert!(provisional(), "a call that failed saw nothing");
        mark(true);
        assert!(!provisional(), "a second day");
        let (again, kept) = store::keep_learned(r.clone()).unwrap();
        assert!(kept && !again.provisional, "learned again, it is the same call");
    }

    /// A one-step read of `url` on the test site, saved.
    fn read_route(id: &str, url: &str) -> store::Route {
        let r: store::Route = serde_json::from_value(serde_json::json!({
            "id": id, "site": "127.0.0.1", "what": "list rows", "method": "GET", "path": "/rows",
            "root": url, "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": [], "needs_browser": false }] }
        }))
        .unwrap();
        store::save_route(&r).unwrap();
        r
    }

    /// Audit 1118 H4 (16 Nov H8), the call's half. The next page a call hands back in `more` is worked out from what
    /// the caller gave, never from what the vault filled: a route that reads on by a count over a secret input the
    /// vault filled (a card number, a code) would say the secret plus one, in clear, to the agent. It says no next page
    /// for such an input (and a plain count still reads on).
    #[test]
    fn the_next_page_never_says_a_secret_the_vault_filled() {
        store::scratch_home("run-next-page-secret");
        let port = test_site(vec![("/rows", 200, "application/json", serde_json::json!({ "items": [{ "id": 1 }, { "id": 2 }] }).to_string())]);
        let route = |id: &str, secret: bool| {
            let mut r = read_route(id, &format!("http://127.0.0.1:{port}/rows?pin=1"));
            r.graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [{
                "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/rows?pin={{pin}}"), "needs_browser": false, "sets_cookie": false,
                "fields": [{ "loc": { "in": "query", "key": "pin" }, "class": "input", "name": "pin", "secret": secret, "default": null }],
            }] }))
            .unwrap();
            r.inputs = vec![store::RouteInput { name: "pin".into(), secret, default: None, file: false, optional: false, options: Vec::new() }];
            r.paging = Some(unbrowse_learn::paging::Paging::Count { input: "pin".into(), step: 1 });
            store::save_route(&r).unwrap();
            store::load_route(id).unwrap()
        };
        let secret_value = "4821".to_string();
        // Control: a plain page number, given by the caller, reads on to the next.
        let plain = crate::vault::Filled::plain(HashMap::from([("pin".to_string(), "2".to_string())]));
        let res = call_with(route("pages-plain", false), &plain, "You", None, &[], None).unwrap();
        assert!(res.ok, "{:?}", res.error);
        assert_eq!(res.more, Some(HashMap::from([("pin".to_string(), "3".to_string())])), "control: a plain count still reads on");
        // The same count over a secret the vault filled: nothing of the secret comes back. The test site speaks plain
        // http, where a held value is never sent at all (`held_input_leaves`), so the value is a vault secret on a
        // secret input but not held: this checks what `more` says, not where the value may go.
        let filled = crate::vault::Filled {
            values: HashMap::from([("pin".to_string(), secret_value.clone())]),
            secrets: vec![(secret_value.clone(), "vault:card:shop.example:me".to_string())],
            held: Vec::new(),
        };
        let res = call_with(route("pages-secret", true), &filled, "You", None, &[], None).unwrap();
        assert!(res.ok, "{:?}", res.error);
        let said = serde_json::to_string(&res.more).unwrap();
        assert!(!said.contains("4822") && !said.contains(&secret_value), "the next page says the secret plus one: {said}");
    }

    /// While a card sits in a checkout of a site, or the owner is deciding on one, a route call to that site sends
    /// nothing: an owner-learned `POST /checkout/confirm` that would commit the order under the same session never
    /// reaches the site, whichever session calls it. Once the hold ends, the same call goes.
    #[test]
    fn a_route_call_cannot_commit_a_checkout_while_its_card_tab_is_locked() {
        use std::io::{BufRead, Write};
        store::scratch_home("run-card-hold");
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = site.local_addr().unwrap().port();
        let seen = hits.clone();
        std::thread::spawn(move || {
            for stream in site.incoming().flatten() {
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                    line.clear();
                }
                let body = r#"{"order":"placed"}"#;
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        let url = format!("http://127.0.0.1:{port}/checkout/confirm");
        let r: store::Route = serde_json::from_value(serde_json::json!({
            "id": "confirm", "site": "127.0.0.1", "what": "confirm the order", "method": "POST", "path": "/checkout/confirm",
            "root": url, "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": true, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "POST", "status": 200, "url": url, "fields": [], "needs_browser": false }] }
        }))
        .unwrap();
        store::save_route(&r).unwrap();
        // The hold is this test's alone: kept in its own scratch home, sealed.
        crate::payhold::seal_for_tests();
        crate::payhold::begin("127.0.0.1", &[]).unwrap();
        let held = call("confirm", &HashMap::new(), "an agent");
        let why = match &held { Ok(c) => c.error.clone().unwrap_or_default(), Err(e) => e.clone() };
        assert!(held.as_ref().map(|c| !c.ok).unwrap_or(true) && why.contains("card"), "{why}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "nothing reached the site");
        crate::payhold::release("127.0.0.1").unwrap();
        let after = call("confirm", &HashMap::new(), "an agent").unwrap();
        assert!(after.ok, "{:?}", after.error);
        assert!(hits.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    }

    /// While a checkout on any site waits for the owner, no route reaches any host, though its host is one the
    /// checkout never named (where an order may be committed that the node hasn't seen yet): a POST route, and a GET
    /// route too, since a GET can commit as well. The agent hears why. Released, both go.
    #[test]
    fn a_route_to_a_host_no_checkout_named_changes_nothing_while_one_waits() {
        use std::io::{BufRead, Write};
        store::scratch_home("run-any-hold");
        crate::payhold::seal_for_tests();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = site.local_addr().unwrap().port();
        let seen = hits.clone();
        std::thread::spawn(move || {
            for stream in site.incoming().flatten() {
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                    line.clear();
                }
                let body = r#"{"ok":true}"#;
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        let route = |id: &str, method: &str, write: bool| {
            let url = format!("http://127.0.0.1:{port}/{id}");
            let r: store::Route = serde_json::from_value(serde_json::json!({
                "id": id, "site": "127.0.0.1", "what": id, "method": method, "path": format!("/{id}"),
                "root": url, "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": write, "provisional": false, "learned_at": 1,
                "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": method, "status": 200, "url": url, "fields": [], "needs_browser": false }] }
            }))
            .unwrap();
            store::save_route(&r).unwrap();
        };
        route("confirm-elsewhere", "POST", true);
        route("read-elsewhere", "GET", false);
        crate::payhold::begin("a-checkout.example", &[]).unwrap();
        let refused = call("confirm-elsewhere", &HashMap::new(), "an agent");
        let why = match &refused { Ok(c) => c.error.clone().unwrap_or_default(), Err(e) => e.clone() };
        assert!(refused.as_ref().map(|c| !c.ok).unwrap_or(true) && why.contains("waiting for the owner"), "{why}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "nothing reached the other host");
        let get = call("read-elsewhere", &HashMap::new(), "an agent");
        let why = match &get { Ok(c) => c.error.clone().unwrap_or_default(), Err(e) => e.clone() };
        assert!(get.as_ref().map(|c| !c.ok).unwrap_or(true) && why.contains("waiting for the owner"), "a GET route waits too: {why}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "nothing reached the other host");
        crate::payhold::release("a-checkout.example").unwrap();
        assert!(call("confirm-elsewhere", &HashMap::new(), "an agent").unwrap().ok, "released, the write goes");
        assert!(call("read-elsewhere", &HashMap::new(), "an agent").unwrap().ok, "and the GET");
    }

    /// Every call leaves one line saying what it cost (`learn.rung`): the highest rung it reached, each answering
    /// step's rung, whether a browser ran and how many requests it sent to a model. A plain route against a site that
    /// answers is the first rung, with no browser and no model; the line names the route and site, nothing it sent.
    /// The answer that exposed it (Carousell's search page, UNB-208 step 8): the page's own state files the site's
    /// category directory as a map of 725 small members keyed by id, beside the listings. Each member got a share of the
    /// reply smaller than itself, none could be cut, and the reply went out at 111 KB, three times what a reply carries,
    /// saying it was cut with nothing cut. A map of many members keeps its first ones that fit, as a list does, and says
    /// how many of them it kept; a member the caller named is kept first.
    #[test]
    fn an_object_of_many_small_members_is_cut_to_what_a_reply_carries() {
        let directory: serde_json::Map<String, serde_json::Value> = (0..725).map(|i| (format!("{}", 1000 + i), serde_json::json!({ "deep_link": format!("https://www.shop.example/categories/category-number-{i}/"), "image_url": format!("https://media.shop.example/categories/photos/{i}_thumbnail.png") }))).collect();
        let answer = serde_json::json!({ "Collection": { "collections": directory }, "Listing": { "results": [{ "title": "Desk lamp", "price": "S$20" }] } });
        assert!(size(&answer) > REPLY_BUDGET * 3, "{}", size(&answer));
        let (kept, cut) = fit_reply(answer, REPLY_BUDGET, &["Listing.results[].title".to_string()]);
        let (kept_bytes, total, cuts, _) = cut.expect("cut");
        assert!(kept_bytes <= REPLY_BUDGET + REPLY_BUDGET / 10, "{kept_bytes} of {total}: {cuts:?}");
        let members = kept["Collection"]["collections"].as_object().unwrap().len();
        assert!(members > 0 && members < 725, "{members} members kept");
        assert!(cuts.iter().any(|c| c.at == "/Collection/collections" && c.kept == members && c.total == 725), "{cuts:?}");
        assert_eq!(kept["Listing"]["results"][0]["title"], "Desk lamp", "the named field is kept");
    }

    #[test]
    fn a_calls_log_line_says_its_highest_rung_and_whether_a_browser_ran() {
        let home = store::scratch_home("run-made");
        let port = test_site(vec![("/rows", 200, "application/json", serde_json::json!({ "count": 2, "rows": [{ "day": "2026-04-01" }, { "day": "2026-04-02" }] }).to_string())]);
        read_route("rows", &format!("http://127.0.0.1:{port}/rows"));
        assert!(made_log_in(&home).is_empty(), "nothing is logged before a call");
        let r = call("rows", &HashMap::new(), "You").unwrap();
        assert!(r.ok, "{:?}", r.error);
        let lines = made_log_in(&home);
        assert_eq!(lines.len(), 1, "one line per call");
        let line = &lines[0];
        assert_eq!((line.route.as_str(), line.ok), ("rows", true));
        assert_eq!(line.rung, unbrowse_learn::Rung::Walk);
        assert_eq!(line.steps, vec![unbrowse_learn::Rung::Walk]);
        assert!(!line.browser, "a plain call opens no browser");
        assert_eq!(line.browser, r.browser, "the line and the reply say the same of the browser");
        assert_eq!(line.model_requests, 0, "a call asks no model");
        let raw = std::fs::read_to_string(home.join("made.jsonl")).unwrap();
        assert!(!raw.contains("2026-04-01"), "nothing the site answered is in the line: {raw}");

        // A second call adds a second line, and a call a walk had to mend says the browser ran though its steps were plain.
        call("rows", &HashMap::new(), "You").unwrap();
        assert_eq!(made_log_in(&home).len(), 2);
        let mut mended = unbrowse_learn::Made::default();
        mended.reach(unbrowse_learn::Rung::Browser);
        mended.answered(vec![unbrowse_learn::Rung::Walk]);
        let line = CallMade::of(&store::load_route("rows").unwrap(), true, 9, &mended, 0);
        assert_eq!((line.rung, line.browser), (unbrowse_learn::Rung::Browser, true));
        log_made(&line);
        assert_eq!(made_log_in(&home).last(), Some(&line), "the line reads back as it was written");
    }

    /// A list longer than 25 comes back whole when the answer fits a reply (183 rows of a day's numbers); one too big
    /// for a reply is cut down, and the reply says where, how much of how much, and where the whole of it is.
    #[test]
    fn an_answer_is_whole_or_says_what_was_cut() {
        store::scratch_home("run-truncated");
        // 2000 records (3000 when the ceiling was 64 KB): their ids alone, the default fields, fit the 32 KB ceiling.
        let rows: Vec<serde_json::Value> = (0..183).map(|i| serde_json::json!({ "day": format!("2026-04-{i:03}"), "subscribers": 1000 + i })).collect();
        let items: Vec<serde_json::Value> = (0..2000).map(|i| serde_json::json!({ "id": i, "title": "x".repeat(900) })).collect();
        let port = test_site(vec![
            ("/rows", 200, "application/json", serde_json::json!({ "count": 183, "historical_daily": rows }).to_string()),
            ("/big", 200, "application/json", serde_json::json!({ "count": 2000, "items": items }).to_string()),
        ]);
        read_route("rows", &format!("http://127.0.0.1:{port}/rows"));
        let r = call("rows", &HashMap::new(), "You").unwrap();
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.data.as_ref().unwrap()["historical_daily"].as_array().unwrap().len(), 183, "no list is cut while the answer fits");
        assert!(r.truncated.is_none());

        read_route("big", &format!("http://127.0.0.1:{port}/big"));
        // By default a call hands back each record's short fields only, so the answer fits whole, and the long texts
        // left out are listed for the caller to add.
        let r = call("big", &HashMap::new(), "You").unwrap();
        assert!(r.ok && r.truncated.is_none(), "{:?}", r.truncated);
        assert_eq!(r.data.as_ref().unwrap()["items"].as_array().unwrap().len(), 2000);
        let shown = r.fields.as_ref().expect("the fields it handed back");
        assert!(shown.more.iter().any(|f| f.path == "items[].title" && f.kind == "long text"), "{shown:?}");
        // Asked for the whole of it, the answer is over a reply, and is cut.
        let route = store::load_route("big").unwrap();
        let r = call_with(route, &crate::vault::Filled::plain(HashMap::new()), "You", None, &[unbrowse_learn::fields::ALL.to_string()], None).unwrap();
        assert!(r.ok, "{:?}", r.error);
        let t = r.truncated.expect("a cut answer says so");
        let kept = r.data.as_ref().unwrap()["items"].as_array().unwrap().len();
        assert!(kept > 0 && kept < 2000);
        assert_eq!(t.cuts.first(), Some(&Cut { at: "/items".into(), kept, total: 2000, unit: "items" }), "{:?}", t.cuts);
        assert!(t.kept_bytes <= REPLY_BUDGET + REPLY_BUDGET / 10 && t.total_bytes > 1_500_000, "{} of {}", t.kept_bytes, t.total_bytes);
        let whole: serde_json::Value = serde_json::from_slice(&std::fs::read(t.whole.as_ref().expect("the whole answer is kept")).unwrap()).unwrap();
        assert_eq!(whole["items"].as_array().unwrap().len(), 2000);
        assert!(t.note.contains("3000") || t.note.contains("KB"), "{}", t.note);
        // The walk that exposed it: a stays search whose page files its data under the request's key, a pair: the
        // key, then 340 KB of results. The key fit and the data did not, so the list ended at the key and the reply
        // was 2 KB of a 64 KB budget (the ceiling then) with none of the answer in it. The bulk is cut down to what is left instead.
        let filed = serde_json::json!({ "client": [["StaysSearch:key", { "data": { "results": (0..3000).map(|i| serde_json::json!({ "title": format!("Home number {i}"), "note": "x".repeat(100) })).collect::<Vec<_>>() } }]] });
        let (kept, cut) = fit_reply(filed, REPLY_BUDGET, &[]);
        assert!(cut.is_some());
        let results = kept["client"][0][1]["data"]["results"].as_array().expect("the data is still there, cut");
        assert!(results.len() > 100 && results.len() < 3000, "{}", results.len());
        // A long text is cut to its start, and said.
        let (v, cut) = fit_reply(serde_json::json!({ "title": "post", "text": "y".repeat(300_000) }), REPLY_BUDGET, &[]);
        let (_, _, cuts, _) = cut.expect("cut");
        assert_eq!((v["title"].as_str(), cuts[0].at.as_str(), cuts[0].unit, cuts[0].total), (Some("post"), "/text", "chars", 300_000));
    }

    /// The outcome a call's reply says, read as the reply leaves the node.
    fn outcome_of_call(r: &CallResult) -> crate::outcome::Outcome {
        crate::outcome::outcome_of("unbrowse_call", &serde_json::to_value(r).unwrap()).outcome
    }

    /// An answer over the reply's ceiling is cut, the fields the caller named kept first, and the reply answers
    /// `answered_cut`: it says which fields were left out by the paths to name for less, the inputs of the next page,
    /// and the file the whole answer is kept in.
    #[test]
    fn a_cut_reply_says_what_it_left_out_and_how_to_ask_for_it() {
        store::scratch_home("run-cut-says");
        let items: Vec<serde_json::Value> = (0..400).map(|i| serde_json::json!({ "id": i, "name": format!("item {i}"), "body": "z".repeat(400) })).collect();
        let port = test_site(vec![("/rows", 200, "application/json", serde_json::json!({ "summary": "s".repeat(30_000), "items": items, "next": "page-2" }).to_string())]);
        let mut r = read_route("pages", &format!("http://127.0.0.1:{port}/rows"));
        r.paging = Some(unbrowse_learn::paging::Paging::Token { input: "cursor".into(), from: "/next".into() });
        store::save_route(&r).unwrap();
        let asked = vec![unbrowse_learn::fields::ALL.to_string(), "summary".to_string()];
        let res = call_with(store::load_route("pages").unwrap(), &crate::vault::Filled::plain(HashMap::new()), "You", None, &asked, None).unwrap();
        assert!(res.ok, "{:?}", res.error);
        assert_eq!(outcome_of_call(&res), crate::outcome::Outcome::AnsweredCut);
        let t = res.truncated.as_ref().expect("a reply over the ceiling is cut, and says so");
        assert!(t.kept_bytes <= REPLY_BUDGET + REPLY_BUDGET / 10 && t.total_bytes > REPLY_BUDGET * 4, "{} of {}", t.kept_bytes, t.total_bytes);
        let data = res.data.as_ref().unwrap();
        assert_eq!(data["summary"].as_str().map(str::len), Some(30_000), "the field the caller named is kept whole first");
        assert!(t.cuts.iter().any(|c| c.at == "/items" && c.unit == "items" && c.total == 400 && c.kept < 400), "{:?}", t.cuts);
        assert!(["items[].id", "items[].name", "items[].body"].iter().all(|p| t.left_out.contains(&p.to_string())), "{:?}", t.left_out);
        assert_eq!(t.next_page, Some(HashMap::from([("cursor".to_string(), "page-2".to_string())])));
        let whole = t.whole.as_ref().expect("the whole answer is kept");
        assert!(t.note.contains("items[].id") && t.note.contains("cursor=page-2") && t.note.contains(whole.as_str()) && t.note.contains("32 KB"), "{}", t.note);
        let kept: serde_json::Value = serde_json::from_slice(&std::fs::read(whole).unwrap()).unwrap();
        assert_eq!(kept["items"].as_array().unwrap().len(), 400);
    }

    /// A reply at or under the ceiling is never cut, however many records it carries: it answers `answered`.
    #[test]
    fn a_reply_under_the_ceiling_is_never_cut() {
        store::scratch_home("run-under-ceiling");
        let filler = |n: usize| serde_json::json!({ "rows": (0..n).map(|i| serde_json::json!({ "n": i, "text": "w".repeat(80) })).collect::<Vec<_>>() });
        // The largest answer that fits the ceiling exactly, and a byte past it.
        let mut n = 1;
        while size(&filler(n + 1)) <= REPLY_BUDGET {
            n += 1;
        }
        let fits = filler(n);
        assert!(size(&fits) <= REPLY_BUDGET && size(&fits) > REPLY_BUDGET - 200);
        let (kept, cut) = fit_reply(fits.clone(), REPLY_BUDGET, &[]);
        assert!(cut.is_none() && kept == fits);
        assert!(fit_reply(filler(n + 1), REPLY_BUDGET, &[]).1.is_some(), "past the ceiling it is cut");
        let port = test_site(vec![("/rows", 200, "application/json", fits.to_string())]);
        read_route("fits", &format!("http://127.0.0.1:{port}/rows"));
        let res = call_with(store::load_route("fits").unwrap(), &crate::vault::Filled::plain(HashMap::new()), "You", None, &[unbrowse_learn::fields::ALL.to_string()], None).unwrap();
        assert!(res.ok && res.truncated.is_none(), "{:?}", res.truncated);
        assert_eq!(res.data.as_ref().unwrap()["rows"].as_array().unwrap().len(), n);
        assert_eq!(outcome_of_call(&res), crate::outcome::Outcome::Answered);
    }

    /// Fields a reply leaves out by default (the long texts in `fields.more`, the marked copies in `fields.copies`)
    /// are no cut: the caller can name them, nothing was lost to the ceiling, and the reply answers `answered`.
    #[test]
    fn fields_left_out_by_default_are_not_a_cut() {
        store::scratch_home("run-left-out-not-cut");
        let hit = |n: u32| serde_json::json!({ "title": format!("Story number {n}"), "story_id": 1000 + n, "body": "b".repeat(1500),
            "_marked": { "title": { "value": format!("<em>Story</em> number {n}"), "level": "full", "words": ["story"] } } });
        let answer = serde_json::json!({ "hits": (0..30).map(hit).collect::<Vec<_>>(), "page": 0 });
        let port = test_site(vec![("/rows", 200, "application/json", answer.to_string())]);
        let mut r = read_route("hits", &format!("http://127.0.0.1:{port}/rows"));
        // Defaults an agent's proposer named with the copy in them: the reply keeps the field it copies and names it.
        r.fields = vec!["hits[]._marked.title.value".into(), "hits[].story_id".into()];
        r.stats.fields_rule = unbrowse_learn::fields::DEFAULTS_RULE;
        store::save_route(&r).unwrap();
        let res = call("hits", &HashMap::new(), "You").unwrap();
        assert!(res.ok, "{:?}", res.error);
        let shown = res.fields.as_ref().expect("the fields it handed back");
        assert!(!shown.whole && shown.more.iter().any(|f| f.path == "hits[].body"), "{shown:?}");
        assert_eq!(shown.copies, ["hits[]._marked.title"]);
        assert!(res.truncated.is_none(), "{:?}", res.truncated);
        assert_eq!(outcome_of_call(&res), crate::outcome::Outcome::Answered);
    }

    /// An ask the browser served for a route (a confirming browse) is a line of `made.jsonl` at the browser's rung,
    /// and the route's last call, as a call is; it counts no call or pass of the route, which stays provisional.
    #[test]
    fn an_ask_the_browser_served_is_written_as_a_call_is() {
        let home = store::scratch_home("run-browser-served");
        let mut r = route();
        r.provisional = true;
        store::save_route(&r).unwrap();
        served_by_the_browser(&r, true, 1234, None);
        let lines = made_log_in(&home);
        assert_eq!(lines.len(), 1, "one line for the ask");
        assert_eq!((lines[0].route.as_str(), lines[0].ok, lines[0].ms, lines[0].browser), ("r1", true, 1234, true));
        assert_eq!((lines[0].rung, lines[0].steps.clone()), (unbrowse_learn::Rung::Browser, vec![unbrowse_learn::Rung::Browser]));
        let now = store::load_route("r1").unwrap();
        assert_eq!((now.stats.last_ms, now.stats.calls, now.stats.passed), (Some(1234), 0, 0));
        assert!(now.stats.last_at.is_some() && now.provisional);
        served_by_the_browser(&r, false, 99, Some("the browser's walk for this value learned nothing".into()));
        assert_eq!(made_log_in(&home).len(), 2);
        assert!(made_log_in(&home)[1].steps.is_empty() && !made_log_in(&home)[1].ok);
        assert!(store::load_route("r1").unwrap().stats.last_error.is_some());
    }

    #[test]
    fn a_calls_stats_never_bring_back_a_route_deleted_or_delisted_meanwhile() {
        store::scratch_home("run-record");
        let mut r = route();
        r.listing = Some(store::Listing { entry_id: "0x1".into(), tx: "0x2".into(), listed_at: 1, live: true });
        store::save_route(&r).unwrap();
        // The call began with `r`; meanwhile the owner delisted it.
        store::update_route("r1", |now| now.listing.as_mut().unwrap().live = false).unwrap();
        record(&r, None, true, 10, None, None, None, unbrowse_learn::health::Said::Nothing);
        let now = store::load_route("r1").unwrap();
        assert!(!now.listing.unwrap().live);
        assert_eq!(now.stats.calls, 1);
        store::delete_route("r1").unwrap();
        record(&r, None, true, 10, None, None, None, unbrowse_learn::health::Said::Nothing);
        assert!(store::load_route("r1").is_none());
    }

    /// A search's answers differ a little from value to value. One that lacks a small field the route's defaults name is
    /// still the same answer, so the defaults stay. Chosen again from that answer alone, they fell on its facets and slot
    /// ids, and an agent asking for that value got no product named.
    #[test]
    fn defaults_that_still_name_most_of_an_answer_stay() {
        store::scratch_home("run-keepfields");
        let results: Vec<String> = (0..30).map(|n| format!(r#"{{"id":"p{n}","item":{{"sku":"s{n}","title":"Lamp {n}"}}}}"#)).collect();
        let facets: Vec<String> = (0..300).map(|n| format!(r#"{{"facet":"f{n}","label":"Facet number {n} of the list on the side"}}"#)).collect();
        let answer = format!(r#"{{"results":[{}],"facets":[{}]}}"#, results.join(","), facets.join(","));
        let port = test_site(vec![("/rows", 200, "application/json", answer)]);
        let mut r = read_route("search", &format!("http://127.0.0.1:{port}/rows"));
        r.what = "search lamps".into();
        r.fields = vec!["results[].item.sku".into(), "results[].item.title".into(), "category.name".into()];
        r.stats.fields_rule = unbrowse_learn::fields::DEFAULTS_RULE;
        store::save_route(&r).unwrap();
        let got = call("search", &HashMap::new(), "You").unwrap();
        assert!(got.ok, "{:?}", got.error);
        assert_eq!(got.data.as_ref().unwrap()["results"][7]["item"]["sku"], "s7", "{:?}", got.fields);
        assert!(got.data.as_ref().unwrap().get("facets").is_none(), "{:?}", got.fields);
        assert_eq!(store::load_route("search").unwrap().fields, r.fields, "the defaults are kept");
    }

    /// A route's stored fields are its own: a call never chooses them again because the rule now leaves out a copy of a
    /// record's field with markup added. The copy is left out of the reply, the field it copies comes back in its place,
    /// and the reply names the copy, while the route keeps the fields it was learned with.
    #[test]
    fn a_stored_routes_fields_are_not_rechosen() {
        store::scratch_home("run-copies");
        let hits: Vec<String> = (0..30)
            .map(|n| format!(r#"{{"title":"Rust story number {n}","url":"https://news.example/{n}-rust","story_id":{},"_marked":{{"title":{{"value":"<em>Rust</em> story number {n}","words":["rust"]}},"url":{{"value":"https://news.example/{n}-<em>rust</em>","words":["rust"]}}}}}}"#, 1000 + n))
            .collect();
        let answer = format!(r#"{{"hits":[{}],"cursor":"next-page-token"}}"#, hits.join(","));
        let port = test_site(vec![("/rows", 200, "application/json", answer)]);
        let mut r = read_route("search", &format!("http://127.0.0.1:{port}/rows"));
        r.what = "search stories".into();
        r.fields = vec!["hits[]._marked.title.value".into(), "hits[].story_id".into(), "cursor".into()];
        r.stats.fields_rule = unbrowse_learn::fields::DEFAULTS_RULE;
        store::save_route(&r).unwrap();
        let got = call("search", &HashMap::new(), "You").unwrap();
        assert!(got.ok, "{:?}", got.error);
        let data = got.data.as_ref().unwrap();
        assert_eq!(data["hits"][3], serde_json::json!({ "title": "Rust story number 3", "story_id": 1003 }), "{data}");
        assert_eq!(data["cursor"], "next-page-token");
        let shown = got.fields.as_ref().unwrap();
        assert_eq!(shown.copies, ["hits[]._marked"], "{shown:?}");
        assert_eq!(store::load_route("search").unwrap().fields, r.fields, "the stored fields are not chosen again");
        assert_eq!(store::load_route("search").unwrap().stats.fields_rule, unbrowse_learn::fields::DEFAULTS_RULE);
    }

    /// A call's defaults read the route's own page: filters that lead back to it are its menu, and the call hands back what
    /// it found, though each filter says more of itself than a found record does.
    #[test]
    fn a_routes_defaults_leave_out_what_leads_back_to_its_page() {
        store::scratch_home("run-menu");
        let filters: Vec<String> = (0..30).map(|n| format!(r#"{{"id":"f{n}","icon":{n},"color":"dark","border":"none","hover":"light","label":"Lamp filter {n}","query":"lamp {n}","link":"/search/?q=lamp%20{n}&rs=filter"}}"#)).collect();
        let found: Vec<String> = (0..30).map(|n| format!(r#"{{"id":"p{n}","image":"https://img.example/{n}.jpg"}}"#)).collect();
        let answer = format!(r#"{{"filters":[{}],"results":[{}]}}"#, filters.join(","), found.join(","));
        let port = test_site(vec![("/rows", 200, "application/json", answer)]);
        let mut r = read_route("search", &format!("http://127.0.0.1:{port}/rows"));
        r.what = "search lamps".into();
        r.root = format!("http://127.0.0.1:{port}/search/?q=lamp");
        store::save_route(&r).unwrap();
        let got = call("search", &HashMap::new(), "You").unwrap();
        assert!(got.ok, "{:?}", got.error);
        let data = got.data.as_ref().unwrap();
        assert_eq!(data["results"][7]["id"], "p7", "{data}");
        assert!(data.get("filters").is_none(), "{data}");
    }

    /// A page route learned while it answered with the page's phrasebook kept that phrasebook's fields as its defaults.
    /// Now the page answers with what it renders, those fields name nothing in it: a call chooses its fields again from
    /// the answer it got (the page's text, with the companies found), and keeps them.
    #[test]
    fn fields_chosen_from_an_answer_of_another_shape_are_chosen_again() {
        store::scratch_home("run-refields");
        let page = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/learn/tests/fixtures/pages/search-results-signed-out.html")).unwrap();
        let port = test_site(vec![("/rows", 200, "text/html", page)]);
        let mut r = read_route("page", &format!("http://127.0.0.1:{port}/rows"));
        r.what = "find a company's reviews and rating".into();
        r.fields = vec!["title".into(), "state.i18nBundle.site.header.companyReviews".into()];
        store::save_route(&r).unwrap();
        let got = call("page", &HashMap::new(), "You").unwrap();
        assert!(got.ok, "{:?}", got.error);
        let text = got.data.as_ref().unwrap()["text"].as_str().unwrap_or_default().to_string();
        assert!(text.contains("Open Government Partnership"), "{:?}", got.data);
        assert!(store::load_route("page").unwrap().fields.iter().any(|f| f == "text"), "the new fields are kept");
    }

    /// A local site that answers by what it was asked: `answer(path and query, the Cookie header)` is the status, the
    /// extra header lines and the body of its reply. The log holds each request as `path?query | cookie`. Its port.
    fn site_by(answer: fn(&str, &str) -> (u16, &'static str, String)) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead, Write};
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = site.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in site.incoming().flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                let _ = reader.read_line(&mut first);
                let mut cookie = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if line.to_ascii_lowercase().starts_with("cookie:") {
                        cookie = line[7..].trim().to_string();
                    }
                }
                let at = first.split_whitespace().nth(1).unwrap_or("/").to_string();
                log.lock().unwrap().push(format!("{at} | {cookie}"));
                let (status, header, body) = answer(&at, &cookie);
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{header}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (port, seen)
    }

    /// Every way a call can fail is said to its caller in its own words, with the step it failed at, and a bug report
    /// gets only the variant: the door says what it is and what earns a way through, a value the node's session lacks
    /// says the page must be walked again, a refusal says the call wasn't made.
    #[test]
    fn each_failure_is_told_in_its_own_words_and_counted_under_its_variant() {
        use unbrowse_learn::ReplayError as E;
        let url = || "https://shop.example/api/x".to_string();
        let door = unbrowse_learn::graph::Door { kind: unbrowse_learn::graph::DoorKind::Cloudflare, statuses: vec![403], credential: Some("cf_clearance".into()), ttl: None, earn: unbrowse_learn::graph::Earn::BrowserOrOwner, at: None };
        let loc = || unbrowse_learn::Loc::Header("x-sig".into());
        let said = |e: E| told(&e, 3);
        let door_said = said(E::Door { step: 2, url: url(), status: 403, door: door.clone(), wall: None });
        assert!(door_said.starts_with("step 2 of 3 answered 403: the site's door") && door_said.contains("cf_clearance") && door_said.contains("the owner's hand"), "{door_said}");
        assert_eq!(said(E::NeedsBrowser { step: 1, url: url(), loc: loc() }), "step 1 of 3 needs a browser: the page computes a value it sends");
        assert_eq!(said(E::MissingInput("city".into())), "no value given for input `city`");
        assert_eq!(said(E::MissingMinted("sid".into())), "the node's session holds no `sid`; the site's page must be walked again");
        assert_eq!(said(E::SourceMissing { step: 2, url: url(), loc: loc() }), "step 2 of 3 takes a value from an earlier answer, and it wasn't there");
        assert_eq!(said(E::UnsupportedBody { step: 1, url: url() }), "step 1 of 3 has a body that can't be replayed yet");
        assert_eq!(said(E::BreaksBody { step: 2, url: url(), part: "file".into() }), "step 2 of 3: the value for `file` would break the request's body, so it wasn't sent");
        assert_eq!(said(E::ShapeMismatch { expected: serde_json::json!({}), got: serde_json::json!([]) }), "the target answered, but not in the recorded shape");
        assert_eq!(said(E::NotAnAnswer { status: 200, why: "an empty page".into(), challenge: false }), "an empty page");
        assert_eq!(said(E::Transport("EOF".into())), "a request did not complete");
        assert_eq!(said(E::BadUrl("x".into())), "a request of the route couldn't be made");
        assert_eq!(said(E::File { input: "photo".into(), reason: "not in the file root".into() }), "file input `photo`: not in the file root");
        assert_eq!(said(E::Refused("excluded".into())), "the call wasn't made: excluded");
        assert_eq!(said(E::RefusedHop("a private address".into())), "the site answered, and where it sent the call was refused: a private address");
        assert_eq!(said(E::Failed { step: 2, url: url(), status: 401, body: String::new() }), "step 2 of 3 answered 401");
        assert_eq!(said(E::Failed { step: 3, url: url(), status: 503, body: String::new() }), "the site answered 503");
        let variant = |e: E| failure_variant(&e, 3);
        assert_eq!(variant(E::Door { step: 2, url: url(), status: 403, door, wall: None }), "Door: step 2 of 3 answered 403 (Cloudflare)");
        assert_eq!(variant(E::SourceMissing { step: 2, url: url(), loc: loc() }), "SourceMissing: step 2 of 3");
        assert_eq!(variant(E::UnsupportedBody { step: 1, url: url() }), "UnsupportedBody: step 1 of 3");
        assert_eq!(variant(E::BreaksBody { step: 2, url: url(), part: "file".into() }), "BreaksBody: step 2 of 3");
        assert_eq!(variant(E::ShapeMismatch { expected: serde_json::json!({}), got: serde_json::json!([]) }), "ShapeMismatch");
        assert_eq!(variant(E::BadUrl("x".into())), "BadUrl");
        assert_eq!(variant(E::RefusedHop("a private address".into())), "RefusedHop");
        assert_eq!(variant(E::File { input: "photo".into(), reason: "r".into() }), "File");
        assert_eq!(variant(E::Refused("excluded".into())), "Refused");
    }

    /// A page served without the data its script would fetch says 200 and holds the request's key: the call fails
    /// and says the list is not there, rather than handing back the frame as if it were the answer.
    #[test]
    fn an_answer_with_none_of_the_records_the_route_returns_is_a_failure_that_says_so() {
        store::scratch_home("run-frame-lacks");
        let port = test_site(vec![
            ("/frame", 200, "application/json", serde_json::json!({ "request": { "key": "abc" } }).to_string()),
            ("/full", 200, "application/json", serde_json::json!({ "request": { "key": "abc" }, "rows": [{ "name": "a" }] }).to_string()),
        ]);
        for id in ["frame", "full"] {
            let mut r = read_route(id, &format!("http://127.0.0.1:{port}/{id}"));
            r.fields = vec!["rows[].name".into()];
            store::save_route(&r).unwrap();
        }
        let lacks = call("frame", &HashMap::new(), "You").unwrap();
        assert!(!lacks.ok && lacks.data.is_none(), "{:?}", lacks.data);
        assert_eq!(lacks.error.as_deref(), Some("the site answered with the frame of its answer and none of the records this route returns: its list is not there at all"));
        let has = call("full", &HashMap::new(), "You").unwrap();
        assert!(has.ok, "{:?}", has.error);
    }

    /// A route that hears its caller, asked another value than it was learned on, is first asked plainly (no browser
    /// to heal it): a plain answer is the call's, asked once; the site's "not found" for that value, while it still
    /// answers the route's own, is its answer, after one more ask for the value it was learned on and no more.
    #[test]
    fn a_route_that_hears_its_caller_is_asked_plainly_before_a_browser_mends_it() {
        store::scratch_home("run-plain-ask");
        let (port, seen) = site_by(|at, _| match at {
            a if a.contains("q=cats") => (200, "", serde_json::json!({ "rows": [{ "name": "cat" }] }).to_string()),
            a if a.contains("q=dogs") => (200, "", serde_json::json!({ "rows": [{ "name": "dog" }] }).to_string()),
            _ => (404, "", serde_json::json!({ "error": "not found" }).to_string()),
        });
        let url = format!("http://127.0.0.1:{port}/rows?q=cats");
        let mut r: store::Route = serde_json::from_value(serde_json::json!({
            "id": "hears", "site": "127.0.0.1", "what": "list rows", "method": "GET", "path": "/rows?q={q}",
            "root": url, "inputs": [{ "name": "q", "secret": false, "default": "cats" }], "steps": 1, "browser_assisted": false, "walk_without_fragment": true,
            "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/rows?q={{q}}"), "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "cats" }] }] }
        }))
        .unwrap();
        r.heard.probed = true;
        r.fields = vec!["rows[].name".into()];
        store::save_route(&r).unwrap();
        let ask = |q: &str| call("hears", &HashMap::from([("q".to_string(), q.to_string())]), "You").unwrap();
        let dogs = ask("dogs");
        assert!(dogs.ok, "{:?}", dogs.error);
        assert_eq!(dogs.data.as_ref().unwrap()["rows"][0]["name"], "dog");
        assert_eq!(seen.lock().unwrap().len(), 1, "a plain answer is the call's answer, asked once: {:?}", seen.lock().unwrap());
        seen.lock().unwrap().clear();
        let none = crate::learn::own_asks::asking(&[crate::learn::own_asks::Ask::Recheck], || ask("zzz"));
        assert!(!none.ok && none.error.as_deref().unwrap_or_default().starts_with("the site answered 404"), "{:?}", none.error);
        let asks = seen.lock().unwrap().clone();
        assert!(asks.len() == 2 && asks[0].contains("q=zzz") && asks[1].contains("q=cats"), "asked its value, then its own once more, and no more: {asks:?}");
    }

    /// One plain ask of a route's graph, as a learn-time probe makes it: the site's answer when it answers, nothing
    /// when it refuses.
    #[test]
    fn a_plain_ask_gives_the_sites_answer_or_nothing() {
        store::scratch_home("run-asked-plainly");
        let port = test_site(vec![("/ok", 200, "application/json", serde_json::json!({ "rows": [1, 2] }).to_string()), ("/bad", 500, "application/json", "{}".to_string())]);
        let ok = read_route("ok", &format!("http://127.0.0.1:{port}/ok"));
        let bad = read_route("bad", &format!("http://127.0.0.1:{port}/bad"));
        assert_eq!(asked_plainly(&ok.graph, &HashMap::new()), Some(serde_json::json!({ "rows": [1, 2] })));
        assert_eq!(asked_plainly(&bad.graph, &HashMap::new()), None);
    }

    /// The whole answers a cut reply points to are kept for the newest few only: the oldest are removed as new ones
    /// are written, so the folder never grows without end.
    #[test]
    fn only_the_newest_whole_answers_are_kept() {
        let home = store::scratch_home("run-keep-whole");
        let mut paths = Vec::new();
        for i in 0..24 {
            paths.push(keep_whole(&format!("route-{i:02}"), &serde_json::json!({ "n": i })).expect("kept"));
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let left = std::fs::read_dir(home.join("answers")).unwrap().flatten().count();
        assert_eq!(left, 20, "the newest twenty");
        assert!(!std::path::Path::new(&paths[0]).exists() && std::path::Path::new(&paths[23]).exists(), "the oldest went, the newest stays");
    }

    /// A reply a do wraps (its `result` is a call's answer) that is over the ceiling is cut again, and its outcome
    /// says it was cut and where that was read.
    #[test]
    fn a_wrapped_answer_over_the_ceiling_is_cut_and_says_where() {
        store::scratch_home("run-wrapped-cut");
        let rows: Vec<serde_json::Value> = (0..2000).map(|i| serde_json::json!({ "id": i, "text": "w".repeat(60) })).collect();
        let mut reply = serde_json::json!({ "ok": true, "result": { "ok": true, "outcome": "answered", "data": { "rows": rows }, "route_id": "r1" } });
        held_to_ceiling(&mut reply);
        assert!(size(&reply) <= REPLY_BUDGET + REPLY_BUDGET / 10, "{}", size(&reply));
        let answer = &reply["result"];
        assert_eq!(answer["outcome"], crate::outcome::Outcome::AnsweredCut.word());
        assert_eq!(answer["outcome_from"], "result.truncated");
        assert!(answer["truncated"]["cuts"].as_array().is_some_and(|c| c.iter().any(|c| c["at"] == "/rows" && c["total"] == 2000)), "{}", answer["truncated"]);
        assert_eq!(reply["outcome"], serde_json::Value::Null, "only the answer's own outcome says it");
    }

    /// The owner is shown a route's session values, a piece of their value and a form body as they are sent; a body
    /// too long to show means the owner is not asked at all.
    #[test]
    fn the_consent_question_shows_a_session_value_a_piece_and_a_form_body() {
        let step = |fields: serde_json::Value, body: serde_json::Value| -> unbrowse_learn::Graph {
            serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [{ "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/api/order", "needs_browser": false, "foreign": true, "fields": fields, "body": body }] })).unwrap()
        };
        let fields = serde_json::json!([
            { "loc": { "in": "cookie", "key": "sid" }, "class": "minted", "name": "sid" },
            { "loc": { "in": "query", "key": "day" }, "class": "piece", "input": "when", "from": 0, "len": 10 }
        ]);
        let q = consent_question("shop.example", "https://shop.example/", &step(fields.clone(), serde_json::json!({ "kind": "form", "fields": [["item", "lamp"], ["note", null]] }))).expect("described");
        assert!(q.contains("cookie sid: your session's sid"), "{q}");
        assert!(q.contains("query day: characters 1 to 10 of your agent's value for when"), "{q}");
        assert!(q.contains("form body: item=lamp&note={value above}"), "{q}");
        let long = "x".repeat(ASK_BODY_CHARS);
        assert_eq!(consent_question("shop.example", "https://shop.example/", &step(fields, serde_json::json!({ "kind": "form", "fields": [["item", long]] }))), None, "a form body too long to show");
    }

    /// A shared route the question can't describe runs with none of the owner's session, and they are never asked.
    #[test]
    fn a_shared_route_the_owner_cannot_be_shown_whole_is_never_asked_about() {
        store::scratch_home("run-undescribable");
        let mut r = route();
        r.site = "shop.example.com".into();
        r.graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [{ "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example.com/api/x", "needs_browser": false, "foreign": true,
            "fields": [{ "loc": { "in": "header", "key": "x-sig" }, "class": "computed" }] }] })).unwrap();
        r.fetched = Some(store::Fetched { entry_id: "0x1".into(), route_id: "r".into(), agent_id: "7".into(), content_id: "sha256:ab".into(), listed_as: "x".into(), fetched_at: 1 });
        std::fs::create_dir_all(store::jars_dir()).unwrap();
        store::write_json(&store::jar_path("shop.example.com"), &unbrowse_files::JAR, &HashMap::from([("sid", "owners")])).unwrap();
        let asked = std::cell::Cell::new(false);
        assert!(owner_session_for(&r, &run_graph(&r), &mut |_| { asked.set(true); Ok(()) }).is_none());
        assert!(!asked.get(), "the owner is not asked about what can't be shown them");
    }

    /// A route of one step that sends the session cookie `sid` the jar holds, on the test site at `port`.
    fn session_route(id: &str, port: u16, path: &str) -> store::Route {
        let url = format!("http://127.0.0.1:{port}{path}");
        let r: store::Route = serde_json::from_value(serde_json::json!({
            "id": id, "site": "127.0.0.1", "what": "read my account", "method": "GET", "path": path,
            "root": url, "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": url, "needs_browser": false,
                "fields": [{ "loc": { "in": "cookie", "key": "sid" }, "class": "minted", "name": "sid" }] }] }
        }))
        .unwrap();
        store::save_route(&r).unwrap();
        std::fs::create_dir_all(store::jars_dir()).unwrap();
        store::write_json(&store::jar_path("127.0.0.1"), &unbrowse_files::JAR, &HashMap::from([("sid", "JAR-SESSION-7f3a91")])).unwrap();
        r
    }

    /// A site that turns a call away because the session is not good any more (401) is told to the caller as what it
    /// answered, in the site's words, and never with the session value the call sent.
    #[test]
    fn a_call_the_site_turns_away_says_what_the_site_answered_and_never_the_session_it_sent() {
        store::scratch_home("run-turned-away");
        let (port, seen) = site_by(|_, cookie| (401, "", serde_json::json!({ "error": "session expired", "you_sent": cookie }).to_string()));
        session_route("gone", port, "/me");
        let r = call("gone", &HashMap::new(), "You").unwrap();
        assert!(seen.lock().unwrap().iter().any(|s| s.contains("sid=JAR-SESSION-7f3a91")), "the call carried the jar's session: {:?}", seen.lock().unwrap());
        assert!(!r.ok && r.data.is_none());
        let said = r.error.unwrap_or_default();
        assert!(said.contains("401") && said.contains("session expired"), "{said}");
        assert!(!said.contains("JAR-SESSION-7f3a91"), "the error carries the session value: {said}");
    }

    /// The session the jar filled in at call time never reaches the agent, though the site's answer says it back (a
    /// debug block, a "signed in as" line): the reply names the jar's entry in its place. A value too short to be a
    /// session is the site's own word and stays.
    #[test]
    fn a_session_the_jar_filled_in_never_comes_back_in_the_reply_though_the_site_echoes_it() {
        store::scratch_home("run-jar-echo");
        let (port, seen) = site_by(|_, cookie| (200, "", serde_json::json!({ "hello": "owner", "lang": "en", "debug": { "cookie": cookie }, "rows": [{ "name": format!("seen {cookie}") }] }).to_string()));
        session_route("echo", port, "/me");
        store::write_json(&store::jar_path("127.0.0.1"), &unbrowse_files::JAR, &HashMap::from([("sid", "JAR-SESSION-7f3a91"), ("lang", "en")])).unwrap();
        let r = call("echo", &HashMap::new(), "You").unwrap();
        assert!(seen.lock().unwrap().iter().any(|s| s.contains("sid=JAR-SESSION-7f3a91")), "the call carried the jar's session: {:?}", seen.lock().unwrap());
        assert!(r.ok, "{:?}", r.error);
        let reply = serde_json::to_string(&r).unwrap();
        assert!(!reply.contains("JAR-SESSION-7f3a91"), "the jar's session came back to the agent: {reply}");
        assert_eq!(r.data.as_ref().unwrap()["lang"], "en", "a short value is the site's word, not a session: {reply}");
    }
}
