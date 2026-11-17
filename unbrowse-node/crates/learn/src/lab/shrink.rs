//! The smallest request a site accepts (`docs/REBUILD.md`, phase 4): what a body sends that the site does not need,
//! found by leaving it out one part at a time and letting the site say.
//!
//! A part stays out only if, with it out, the site still answers the walk's own value as the walk did and a second
//! value as itself — the same two of the site's tests ([`crate::lab::verify`]), read by the same readers. Candidates
//! are tried in a fixed order: a step whose reply no later step reads, then an open hole (a value nothing explains,
//! which the body sends as walked), then a header the page wrote that the body sends as fixed text.
//!
//! What a site's door reads is never a candidate, whatever one ask of it says (`AGENTS.md`: a request presents what
//! the browser presented, and the mint's jar is the session): a header the browser writes by itself or carries as its
//! shape ([`crate::slots::is_browser_header`], [`crate::slots::is_carried_browser_header`]), a header that says what
//! the request's own body is (the `content-` family, the body's framing as `content-length` is the transport's), and a
//! cookie (a browser sends every cookie it holds for the site, so a route that names fewer saves nothing and looks
//! like no browser). Nor a hole that carries the caller's value, the answer step, or a step that writes. A part left
//! out passes on the minute it is asked; one a door reads draws the wall at the hundredth call.
//!
//! Each leave-out costs asks of the site. A budget bounds them: the parts are tried in order until it is spent, and
//! what was left untried is said. A body the site will not answer even whole (the walk's own request is refused) is
//! returned unchanged: there is nothing to shrink against.

use std::collections::HashMap;

use crate::lab::answer::{nothing_of_its_own, said_lines, TOO_LITTLE_TO_TELL};
use crate::lab::call::call;
use crate::lab::site::{Said, Site};
use crate::trace::Exchange;
use unbrowse_route as route;

/// A part of a body that may not be needed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Part {
    /// A whole step whose reply no later step reads, by id.
    Step(String),
    /// A value nothing explains, sent as walked: by step id and place.
    Open(String, route::Place),
    /// A header the page wrote that a step sends as fixed text, by step id and name.
    Header(String, String),
}

impl Part {
    pub fn say(&self) -> String {
        match self {
            Part::Step(step) => format!("step {step}, whose reply nothing reads"),
            Part::Open(step, at) => format!("the {at} of step {step}, a value nothing explains"),
            Part::Header(step, name) => format!("the header {name} of step {step}"),
        }
    }

    /// The part in a word or two, as a line that lists several says it: `a step nothing reads (x0)`, `traceparent`,
    /// `the query uid`.
    pub fn short(&self) -> String {
        match self {
            Part::Step(step) => format!("a step nothing reads ({step})"),
            Part::Open(_, route::Place::Header(name)) | Part::Header(_, name) => name.clone(),
            Part::Open(_, at) => format!("the {at}"),
        }
    }

    /// What kind of part it is, as the candidates are counted.
    pub fn kind(&self) -> &'static str {
        match self {
            Part::Step(_) => "a step nothing reads",
            Part::Open(..) => "an open value",
            Part::Header(..) => "a fixed header the page wrote",
        }
    }

    fn step(&self) -> &str {
        match self {
            Part::Step(step) | Part::Open(step, _) | Part::Header(step, _) => step,
        }
    }
}

/// What became of a part tried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fate {
    /// With it out, the site still answered: it is not in the shrunk body.
    LeftOut,
    /// With it out, the site answered otherwise: it is kept.
    Kept,
    /// The budget was spent before it was tried.
    NotTried,
}

/// The smallest request a site accepted, and the record of what was tried.
#[derive(Clone, Debug)]
pub struct Shrunk {
    /// The body less the parts left out: the same body when none was.
    pub body: route::Route,
    /// Each part, in the order tried, and its fate.
    pub tried: Vec<(Part, Fate)>,
    /// Asks of the site spent.
    pub asks: usize,
    /// Why nothing was tried, where the body could not be checked at all.
    pub unchecked: Option<String>,
}

/// A site that counts what it is asked, so a budget is held to the ask.
struct Counting<'a> {
    site: &'a mut dyn Site,
    asks: usize,
}
impl Site for Counting<'_> {
    fn ask(&mut self, step: &route::Step, built: &route::Built) -> Said {
        self.asks += 1;
        self.site.ask(step, built)
    }
}

/// Whether a hole sends a value of the caller's: a slot, or anything made over one. Such a hole is never a candidate.
fn carries_the_caller(hole: &route::Hole) -> bool {
    hole.ways.iter().flat_map(|w| w.expr.all()).any(|e| matches!(e, route::Expr::Slot { .. } | route::Expr::Given { .. } | route::Expr::File { .. }))
}

/// Whether a hole sends a fixed text and nothing else: no caller value, no read, no cookie, no reading of the clock.
fn is_fixed_text(hole: &route::Hole) -> bool {
    !hole.open && hole.ways.iter().all(|w| matches!(w.expr, route::Expr::Text { .. }))
}

/// Whether a header is one a site's door reads as the browser's own: one the browser writes by itself or carries as
/// its shape (the engine's readers of those), or one that says what the request's own body is (the `content-` family).
fn the_browsers(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    crate::slots::is_browser_header(&name) || crate::slots::is_carried_browser_header(&name) || name.starts_with("content-")
}

/// The lines an answer says of its own, the asked words struck out.
fn lines(answer: &Exchange, struck: &[&str]) -> std::collections::BTreeSet<String> {
    said_lines(&crate::lab::answer::answer_of(answer).unwrap_or(serde_json::Value::Null), struck)
}

/// Whether `site` answers `body` for the walk's own value as the walk did and for the `second` value as itself: a
/// call for each, the second's answer with something of its own beside the first's. Where there is no second value,
/// the walk's own answering is all that is asked.
fn answers_both(body: &route::Route, walked: &HashMap<String, String>, second: Option<&HashMap<String, String>>, jar: &HashMap<String, String>, now: u64, site: &mut dyn Site) -> bool {
    let Ok(w) = call(body, walked, jar, now, site) else { return false };
    let Some(second) = second else { return true };
    let walked_words: Vec<&str> = walked.values().map(String::as_str).collect();
    let walked_lines = lines(&w.answer, &walked_words);
    if walked_lines.len() < TOO_LITTLE_TO_TELL {
        return false;
    }
    let Ok(s) = call(body, second, jar, now, site) else { return false };
    let second_words: Vec<&str> = second.values().map(String::as_str).collect();
    let second_lines = lines(&s.answer, &second_words);
    second_lines.len() >= TOO_LITTLE_TO_TELL && !nothing_of_its_own(&second_lines, &walked_lines)
}

/// The candidates of `body`, in the fixed order: the steps whose reply no later step reads, then the open values (in
/// a header or the address's query, where leaving one out sends nothing in its place), then the fixed headers the page
/// wrote. Never what a door reads as the browser's ([`the_browsers`]), never a cookie, never a hole that carries the
/// caller, never the answer step, never a step that writes.
pub fn candidates(body: &route::Route) -> Vec<Part> {
    let reads = |id: &str| body.steps.iter().flat_map(|s| &s.holes).flat_map(|h| &h.ways).any(|w| w.expr.reads().contains(&id));
    let steps = body.steps.iter().filter(|s| s.id != body.answer.step && !s.writes && !reads(&s.id)).map(|s| Part::Step(s.id.clone()));
    let mut open = Vec::new();
    let mut headers = Vec::new();
    for step in body.steps.iter().filter(|s| !s.writes) {
        for hole in step.holes.iter().filter(|h| !carries_the_caller(h)) {
            match &hole.at {
                route::Place::Header(name) if the_browsers(name) => {}
                route::Place::Header(_) | route::Place::Query(_) if hole.open => open.push(Part::Open(step.id.clone(), hole.at.clone())),
                route::Place::Header(name) if is_fixed_text(hole) => headers.push(Part::Header(step.id.clone(), name.clone())),
                _ => {}
            }
        }
    }
    steps.chain(open).chain(headers).collect()
}

/// `body` with `part` left out: the hole gone from its step, or the whole step gone.
fn without(body: &route::Route, part: &Part) -> route::Route {
    let mut body = body.clone();
    match part {
        Part::Step(step) => body.steps.retain(|s| &s.id != step),
        Part::Open(step, at) => drop_hole(&mut body, step, at),
        Part::Header(step, name) => drop_hole(&mut body, step, &route::Place::Header(name.clone())),
    }
    body
}

fn drop_hole(body: &mut route::Route, step: &str, at: &route::Place) {
    if let Some(s) = body.steps.iter_mut().find(|s| s.id == step) {
        s.holes.retain(|h| &h.at != at);
    }
}

/// The smallest request `site` accepts, from `body`: each candidate left out if the site still answers the walk's own
/// value and the `second` value with it gone, spending no more than `budget` asks.
pub fn shrink(body: &route::Route, walked: &HashMap<String, String>, second: Option<&HashMap<String, String>>, jar: &HashMap<String, String>, now: u64, budget: usize, site: &mut dyn Site) -> Shrunk {
    let mut counting = Counting { site, asks: 0 };
    // Nothing to shrink against: the site does not answer the body's own walk.
    if !answers_both(body, walked, second, jar, now, &mut counting) {
        return Shrunk { body: body.clone(), tried: Vec::new(), asks: counting.asks, unchecked: Some("the site did not answer the body's own walk; nothing to shrink against".into()) };
    }
    let spent = counting.asks;
    let mut shrunk = shrink_from(body, walked, second, jar, now, budget.saturating_sub(spent), counting.site);
    shrunk.asks += spent;
    shrunk
}

/// [`shrink`], for a body the site is already known to answer for the walk's own value and the second value as itself
/// (the site's tests just said so, `lab::verify`): the whole body is not asked again, and the budget goes to the parts.
pub fn shrink_from(body: &route::Route, walked: &HashMap<String, String>, second: Option<&HashMap<String, String>>, jar: &HashMap<String, String>, now: u64, budget: usize, site: &mut dyn Site) -> Shrunk {
    let mut counting = Counting { site, asks: 0 };
    let mut shrunk = body.clone();
    let mut tried = Vec::new();
    let mut stopped = false;
    // The candidates are read from the body once: leaving a step out never adds a candidate, so the order is fixed.
    for part in candidates(body) {
        // A step left out takes its holes with it: a candidate on a step already gone is not tried.
        if !shrunk.steps.iter().any(|s| s.id == part.step()) {
            continue;
        }
        // A trial costs a call for the walk's value and one for the second, each of the body's steps: refuse to start
        // one the budget cannot cover, and leave it and the rest untried.
        let cost = shrunk.steps.len() * if second.is_some() { 2 } else { 1 };
        if stopped || counting.asks + cost > budget {
            stopped = true;
            tried.push((part, Fate::NotTried));
            continue;
        }
        let candidate = without(&shrunk, &part);
        if answers_both(&candidate, walked, second, jar, now, &mut counting) {
            shrunk = candidate;
            tried.push((part, Fate::LeftOut));
        } else {
            tried.push((part, Fate::Kept));
        }
    }
    Shrunk { body: shrunk, tried, asks: counting.asks, unchecked: None }
}

/// `graph` with what shrinking left out of a body said from it taken out of it too: each step left out, and each
/// field at a place left out, matched by the step's exchange (`body::step_id`, the names `from_graph` gives). The
/// graph carries every pass the node makes, shrinking among them, so a part the site did not need is gone from what
/// every later call runs, and a body kept beside the graph (what a graph cannot say, which shrinking never tries) is
/// laid over the shrunk graph as over any other.
pub fn left_out_of(graph: &crate::graph::Graph, tried: &[(Part, Fate)]) -> crate::graph::Graph {
    let mut graph = graph.clone();
    for (part, _) in tried.iter().filter(|(_, fate)| *fate == Fate::LeftOut) {
        match part {
            Part::Step(id) => graph.steps.retain(|s| crate::body::step_id(s.exchange) != *id),
            Part::Open(id, at) => drop_field(&mut graph, id, at),
            Part::Header(id, name) => drop_field(&mut graph, id, &route::Place::Header(name.clone())),
        }
    }
    graph
}

fn drop_field(graph: &mut crate::graph::Graph, id: &str, at: &route::Place) {
    let loc = crate::body::loc_of(at);
    let Some(step) = graph.steps.iter_mut().find(|s| crate::body::step_id(s.exchange) == id) else { return };
    step.fields.retain(|f| f.loc != loc);
    step.held.retain(|h| h.loc != loc);
    // The address names a query value it sends: one left out goes from the address too.
    if let route::Place::Query(key) = at {
        if let Some((path, query)) = step.url.split_once('?') {
            let kept: Vec<&str> = query.split('&').filter(|pair| pair.split('=').next() != Some(key.as_str())).collect();
            step.url = if kept.is_empty() { path.to_string() } else { format!("{path}?{}", kept.join("&")) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lab::site::Said;
    use crate::trace::Exchange;

    fn reply(body: &str) -> Exchange {
        Exchange { method: "GET".into(), url: "https://shop.example/api/search".parse().unwrap(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![], response_body: Some(body.into()), response_mime: "application/json".into(), resource_type: Some("XHR".into()), main_frame: None }
    }

    fn records(word: &str) -> Exchange {
        let name = match word {
            "lamp" => ["desk reading light 60w", "brass bedside glow", "floor standing arc", "clip on task bright", "vintage edison bulb", "dimmable ring halo"],
            _ => ["three seat couch grey", "foldaway bed settee", "chesterfield leather tan", "corner lounge modular", "two seat loveseat navy", "recliner powered cream"],
        };
        reply(&format!(r#"{{"items":[{}]}}"#, name.iter().map(|n| format!(r#"{{"name":"{n}"}}"#)).collect::<Vec<_>>().join(",")))
    }

    fn hole(at: route::Place, expr: route::Expr) -> route::Hole {
        route::Hole { at, ways: vec![route::Way { rung: 0, expr }], over: false, open: false }
    }

    fn open(at: route::Place, walked: &str) -> route::Hole {
        route::Hole { open: true, ..hole(at, route::Expr::text(walked)) }
    }

    fn step(id: &str, path: &str, holes: Vec<route::Hole>) -> route::Step {
        route::Step { id: id.into(), method: "GET".into(), url: format!("https://shop.example{path}"), holes, body: None, expect: 200, script: None, page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: None }
    }

    /// A token step whose reply the search reads, a menu step nothing reads, then the search. The search sends `q`; a
    /// fixed `x-api` header it needs and a fixed `x-client` it does not; an open `traceparent` (a value nothing
    /// explains, sent as walked) it does not need; the browser's own `accept-language` and `sec-fetch-mode`, and a
    /// `content-type`; the token as `x-token`; and two cookies, `sid` it needs and `ad` it does not.
    fn chained_body() -> route::Route {
        use route::{At, Expr, Place};
        let search = step(
            "x2",
            "/api/search",
            vec![
                hole(Place::Query("q".into()), Expr::Slot { name: "q".into(), or: Some("lamp".into()), optional: false }),
                hole(Place::Header("x-api".into()), Expr::text("web-1")),
                hole(Place::Header("x-client".into()), Expr::text("shop-web")),
                open(Place::Header("traceparent".into()), "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
                hole(Place::Header("accept-language".into()), Expr::text("en-GB,en;q=0.9")),
                hole(Place::Header("sec-fetch-mode".into()), Expr::text("cors")),
                hole(Place::Header("content-type".into()), Expr::text("application/json")),
                hole(Place::Header("x-token".into()), Expr::Read { step: "x0".into(), at: At::Json { pointer: "/token".into() } }),
                hole(Place::Cookie("sid".into()), Expr::Cookie { name: "sid".into(), here: false }),
                hole(Place::Cookie("ad".into()), Expr::Cookie { name: "ad".into(), here: false }),
            ],
        );
        let slot = route::Slot { name: "q".into(), secret: false, example: Some("lamp".into()), choices: Vec::new() };
        route::Route { v: route::VERSION, tests: Vec::new(), plan: None, meaning: Default::default(), site: "shop.example".into(), slots: vec![slot], answer: route::Answer { step: "x2".into(), page: false, decode: None }, steps: vec![step("x0", "/api/token", vec![]), step("x1", "/api/menu", vec![]), search] }
    }

    fn asked(word: &str) -> HashMap<String, String> {
        HashMap::from([("q".to_string(), word.to_string())])
    }

    /// A site whose search needs exactly the `x-api` header, the `sid` cookie and the token the token step gave:
    /// without any of them it answers 403. With them, each word its own records, and a nonsense word an empty list.
    struct Needs {
        token: String,
    }
    impl Site for Needs {
        fn ask(&mut self, step: &route::Step, built: &route::Built) -> Said {
            let header = |name: &str| built.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
            let cookie = |name: &str| header("cookie").unwrap_or_default().split(';').any(|c| c.trim().starts_with(&format!("{name}=")));
            match step.id.as_str() {
                "x0" => return Said::Reply { at: None, reply: reply(&format!(r#"{{"token":"{}"}}"#, self.token)) },
                "x1" => return Said::Reply { at: None, reply: reply(r#"{"items":["home","deals"]}"#) },
                _ => {}
            }
            if header("x-api").as_deref() != Some("web-1") || !cookie("sid") || header("x-token").as_deref() != Some(self.token.as_str()) {
                return Said::Reply { at: None, reply: Exchange { status: 403, ..reply(r#"{"error":"forbidden"}"#) } };
            }
            let word = built.url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
            Said::Reply { at: None, reply: if word.chars().any(|c| "aeiou".contains(c)) { records(&word) } else { reply(r#"{"items":[]}"#) } }
        }
    }

    fn jar() -> HashMap<String, String> {
        HashMap::from([("sid".to_string(), "s-abc".to_string()), ("ad".to_string(), "a-xyz".to_string())])
    }

    fn fate<'a>(s: &'a Shrunk, part: &Part) -> &'a Fate {
        &s.tried.iter().find(|(p, _)| p == part).unwrap_or_else(|| panic!("{} was tried", part.say())).1
    }

    fn header_of(body: &route::Route, step: &str, name: &str) -> bool {
        body.steps.iter().find(|s| s.id == step).is_some_and(|s| s.holes.iter().any(|h| h.at == route::Place::Header(name.into())))
    }

    /// The site keeps what it needs and the rest goes: the menu step nothing reads, the open `traceparent`, and the
    /// fixed `x-client` header are left out; the `x-api` header is kept. What a door reads is not tried at all and stays.
    #[test]
    fn the_smallest_request_the_site_accepts_is_found() {
        let shrunk = shrink(&chained_body(), &asked("lamp"), Some(&asked("sofa")), &jar(), 1, 1000, &mut Needs { token: "tok-9f8e".into() });
        assert_eq!(shrunk.unchecked, None);
        assert_eq!(*fate(&shrunk, &Part::Step("x1".into())), Fate::LeftOut, "the menu's reply nothing reads");
        assert_eq!(*fate(&shrunk, &Part::Open("x2".into(), route::Place::Header("traceparent".into()))), Fate::LeftOut);
        assert_eq!(*fate(&shrunk, &Part::Header("x2".into(), "x-client".into())), Fate::LeftOut);
        assert_eq!(*fate(&shrunk, &Part::Header("x2".into(), "x-api".into())), Fate::Kept, "without it the site refuses");
        assert!(!header_of(&shrunk.body, "x2", "traceparent") && !header_of(&shrunk.body, "x2", "x-client") && header_of(&shrunk.body, "x2", "x-api"));
        assert!(!shrunk.body.steps.iter().any(|s| s.id == "x1") && shrunk.body.steps.iter().any(|s| s.id == "x0"), "the menu goes; the token step, which the search reads, stays");
        for kept in ["accept-language", "sec-fetch-mode", "content-type"] {
            assert!(header_of(&shrunk.body, "x2", kept), "{kept} is the browser's or the body's own, never tried, and stays");
        }
        let search = shrunk.body.steps.iter().find(|s| s.id == "x2").unwrap();
        assert!(search.holes.iter().any(|h| h.at == route::Place::Cookie("ad".into())), "a cookie is never left out, though this site does not read it");
    }

    /// A header the browser writes by itself or carries as its shape, one that says what the body is, and a cookie are
    /// never candidates, whatever the site would say: they are what a door reads, asked of the engine's own readers.
    #[test]
    fn a_browser_shape_header_and_a_cookie_are_never_candidates() {
        let parts = candidates(&chained_body());
        for header in ["accept-language", "sec-fetch-mode", "content-type"] {
            assert!(!parts.iter().any(|p| p.say().contains(header)), "{header} is a candidate: {parts:?}");
        }
        assert!(!parts.iter().any(|p| p.say().contains("cookie")), "a cookie is a candidate: {parts:?}");
        assert!(!parts.iter().any(|p| matches!(p, Part::Open(_, route::Place::Query(k)) if k == "q")), "the caller's value is never a candidate");
        assert!(!parts.contains(&Part::Step("x2".into())), "the answer step is never a candidate");
        assert!(!parts.contains(&Part::Step("x0".into())), "a step a later step reads is never a candidate");
    }

    /// The order is fixed: a step nothing reads, then an open value, then a fixed header the page wrote.
    #[test]
    fn an_open_hole_is_tried_before_a_fixed_header() {
        let parts = candidates(&chained_body());
        let at = |part: &Part| parts.iter().position(|p| p == part).unwrap_or_else(|| panic!("{} is a candidate: {parts:?}", part.say()));
        let menu = at(&Part::Step("x1".into()));
        let trace = at(&Part::Open("x2".into(), route::Place::Header("traceparent".into())));
        let client = at(&Part::Header("x2".into(), "x-client".into()));
        assert!(menu < trace && trace < client, "{parts:?}");
        assert_eq!(parts.iter().map(Part::kind).collect::<Vec<_>>(), ["a step nothing reads", "an open value", "a fixed header the page wrote", "a fixed header the page wrote"]);
    }

    /// The budget is held to the ask: with room for only the first trial, the rest are left untried, and the asks
    /// spent do not pass the budget.
    #[test]
    fn the_budget_is_respected_to_the_ask() {
        // The whole body answers in one check of 6 asks (3 steps, two values). A budget of 15 covers it and one trial
        // (another 6, 12 in all), not a second (18 is more than 15).
        let shrunk = shrink(&chained_body(), &asked("lamp"), Some(&asked("sofa")), &jar(), 1, 15, &mut Needs { token: "tok-9f8e".into() });
        assert!(shrunk.asks <= 15, "spent {} of 15", shrunk.asks);
        assert!(shrunk.tried.iter().any(|(_, f)| *f == Fate::NotTried), "some parts were left untried");
        let tried = shrunk.tried.iter().filter(|(_, f)| *f != Fate::NotTried).count();
        assert!(tried >= 1 && tried < candidates(&chained_body()).len(), "some tried, not all: {tried}");
    }

    /// What shrinking left out of a body said from a graph is taken out of the graph: the step and the fields at the
    /// places left out, the address's query too; what was kept stays.
    #[test]
    fn what_shrinking_left_out_is_taken_out_of_the_graph() {
        let graph: crate::graph::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/menu", "fields": [], "needs_browser": false },
            { "exchange": 2, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}&uid={uid}", "needs_browser": false, "fields": [
                { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp" },
                { "loc": { "in": "query", "key": "uid" }, "class": "unconfirmed", "value": "u-7f3a" },
                { "loc": { "in": "header", "key": "traceparent" }, "class": "unconfirmed", "value": "00-4bf9-01" },
                { "loc": { "in": "header", "key": "x-api" }, "class": "constant", "value": "web-1", "origin": null }
            ] }
        ] })).unwrap();
        let tried = vec![
            (Part::Step("x1".into()), Fate::LeftOut),
            (Part::Open("x2".into(), route::Place::Query("uid".into())), Fate::LeftOut),
            (Part::Open("x2".into(), route::Place::Header("traceparent".into())), Fate::LeftOut),
            (Part::Header("x2".into(), "x-api".into()), Fate::Kept),
        ];
        let shrunk = left_out_of(&graph, &tried);
        assert_eq!(shrunk.steps.iter().map(|s| s.exchange).collect::<Vec<_>>(), [2]);
        let search = &shrunk.steps[0];
        assert_eq!(search.url, "https://shop.example/api/search?q={q}");
        let locs: Vec<String> = search.fields.iter().map(|f| f.loc.to_string()).collect();
        assert_eq!(locs, ["query q", "header x-api"], "{locs:?}");
    }

    /// A body the site will not answer even whole is returned unchanged, with why.
    #[test]
    fn a_body_the_site_refuses_whole_is_returned_unchanged() {
        struct Down;
        impl Site for Down {
            fn ask(&mut self, _step: &route::Step, _built: &route::Built) -> Said {
                Said::Reply { at: None, reply: Exchange { status: 500, ..reply(r#"{"error":"down"}"#) } }
            }
        }
        let shrunk = shrink(&chained_body(), &asked("lamp"), Some(&asked("sofa")), &jar(), 1, 1000, &mut Down);
        assert!(shrunk.unchecked.is_some());
        assert!(shrunk.tried.is_empty());
        assert_eq!(serde_json::to_string(&shrunk.body).unwrap(), serde_json::to_string(&chained_body()).unwrap(), "the body is unchanged");
    }
}
