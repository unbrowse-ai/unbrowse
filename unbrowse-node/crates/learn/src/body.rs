//! A route's graph as a body of holes and ways (`unbrowse_route`), and the world a call fills that body in.
//!
//! The rebuild (`docs/REBUILD.md`) learns to one body and calls from it. Until the learner writes that body itself,
//! every route the node holds is a [`Graph`], and [`from_graph`] says the same thing in the body's words: each way a
//! value is made today (`graph::Class`, a caller's value held in a longer one, a signature's recipe) is an
//! expression, and each place replay quietly sent nothing or fell back to the jar is a second way of the same hole.
//!
//! [`shadow`] holds the two to each other. While a replay runs, the body made from its graph is filled for the same
//! call, and the request it builds must be the request replay built, byte for byte. Nothing is sent twice: the body
//! is filled from the replies replay already has. In this crate's own tests a difference fails the test, so every
//! test of replay is a test of the filler; in a running node it is a line in the log, and only when
//! `UNBROWSE_FILL_SHADOW` is set.

use std::collections::HashMap;

use unbrowse_route as route;
use unbrowse_route::{Expr, Place, Way};

use crate::graph::{Body, Class, Field, Graph, Held, Step, Wrap, Written};
use crate::provenance::At;
use crate::replay::{Fetch, ReplayError, Request};
use crate::signing::{Algo, Part, Recipe};
use crate::slots::Loc;
use crate::trace::Exchange;

/// A step's name in the body made from a graph: the exchange its replies are kept under.
pub fn step_id(exchange: usize) -> String {
    format!("x{exchange}")
}

pub(crate) fn exchange_of(step: &str) -> Option<usize> {
    step.strip_prefix('x')?.parse().ok()
}

pub fn place_of(loc: &Loc) -> Place {
    match loc {
        Loc::Path(i) => Place::Path(*i),
        Loc::Query(k) => Place::Query(k.clone()),
        Loc::Header(k) => Place::Header(k.clone()),
        Loc::Cookie(k) => Place::Cookie(k.clone()),
        Loc::Json(p) => Place::Json(p.clone()),
        Loc::Form(k) => Place::Form(k.clone()),
        Loc::Part(n, p) => Place::Part(n.clone(), p.clone()),
        Loc::Url => Place::Url,
    }
}

pub(crate) fn at_of(at: &At) -> route::At {
    match at {
        At::Json { pointer } => route::At::Json { pointer: pointer.clone() },
        At::Header { name } => route::At::Header { name: name.clone() },
        At::SetCookie { name } => route::At::SetCookie { name: name.clone() },
        At::Text { before, after, nth } => route::At::Text { before: before.clone(), after: after.clone(), nth: *nth },
    }
}

pub(crate) fn at_back(at: &route::At) -> At {
    match at {
        route::At::Json { pointer } => At::Json { pointer: pointer.clone() },
        route::At::Header { name } => At::Header { name: name.clone() },
        route::At::SetCookie { name } => At::SetCookie { name: name.clone() },
        route::At::Text { before, after, nth } => At::Text { before: before.clone(), after: after.clone(), nth: *nth },
    }
}

fn how_of(written: Written) -> route::How {
    match written {
        Written::Plain => route::How::Plain,
        Written::Json => route::How::Json,
        Written::Percent => route::How::Percent,
        Written::Plus => route::How::Plus,
        Written::Upper => route::How::Upper,
        Written::Lower => route::How::Lower,
        Written::Dashed => route::How::Dashed,
    }
}

fn wrap_of(wrap: Wrap) -> route::Wrap {
    match wrap {
        Wrap::Base64 => route::Wrap::Base64,
        Wrap::Base64NoPad => route::Wrap::Base64NoPad,
        Wrap::Base64Url => route::Wrap::Base64Url,
        Wrap::Base64UrlNoPad => route::Wrap::Base64UrlNoPad,
    }
}

fn algo_of(algo: Algo) -> route::Algo {
    match algo {
        Algo::Md5 => route::Algo::Md5,
        Algo::Sha1 => route::Algo::Sha1,
        Algo::Sha256 => route::Algo::Sha256,
    }
}

/// A recipe as what it is: a digest over parts of the request and the session, joined.
pub fn recipe_expr(recipe: &Recipe) -> Expr {
    let sent = |part: route::Sent| Expr::Sent { part };
    let parts = recipe
        .parts
        .iter()
        .map(|part| match part {
            Part::Path => sent(route::Sent::Path),
            Part::Method => sent(route::Sent::Method),
            Part::Body => sent(route::Sent::Body),
            Part::Cookie { name } => sent(route::Sent::Cookie(name.clone())),
            Part::Constant { value } => Expr::text(value.as_str()),
            Part::Fresh { template } => Expr::Stamp { form: template.clone() },
            Part::Query { key } => sent(route::Sent::Query(key.clone())),
            Part::Header { name } => sent(route::Sent::Header(name.clone())),
            Part::CookiePiece { name, separator, index } => Expr::Piece { of: Box::new(sent(route::Sent::Cookie(name.clone()))), split: separator.clone(), index: *index },
        })
        .collect();
    Expr::Hash { algo: algo_of(recipe.algo), of: Box::new(Expr::Join { parts, with: recipe.separator.clone() }) }
}

/// The ways one field of a step is made, cheapest first.
fn ways_of(graph: &Graph, step: &Step, loc: &Loc, class: &Class, open: &mut bool) -> Vec<Way> {
    let way = |rung: u8, expr: Expr| Way { rung, expr };
    let nothing = |after: Option<usize>| Way { rung: 0, expr: Expr::Nothing { after: after.map(step_id) } };
    match class {
        Class::Input { name, default, optional, .. } => vec![way(0, Expr::Slot { name: name.clone(), or: default.clone(), optional: *optional })],
        // A cookie another node's body names is the owner's only where the jar's cookies go.
        Class::Minted { name } => vec![way(0, Expr::Cookie { name: name.clone(), here: step.foreign && matches!(loc, Loc::Cookie(_)) })],
        Class::Constant { value, .. } => vec![way(0, Expr::text(value.as_str()))],
        Class::Unconfirmed { value } => {
            *open = true;
            vec![way(0, Expr::text(value.as_str()))]
        }
        Class::Derived { origin } => {
            let read = Expr::Read { step: step_id(origin.exchange), at: at_of(&origin.at) };
            let read = match &origin.wrap {
                Some((before, after)) => Expr::Join { parts: vec![Expr::text(before.as_str()), read, Expr::text(after.as_str())], with: String::new() },
                None => read,
            };
            let mut ways = vec![way(0, read)];
            // What a call does when the reply does not hold the value, each a way of its own. A cookie is the
            // session's, and the jar's copy stands in. A step the page makes takes the page's request whole. A leaf
            // the request's own template leaves empty is sent empty. A list read off a shorter list is shorter. A
            // header a reply's header filled is left out when that step was answered another way.
            match loc {
                Loc::Cookie(name) => ways.push(way(0, Expr::Cookie { name: name.clone(), here: true })),
                _ if graph.page.is_some() && step.is_page_signed() => ways.push(nothing(None)),
                _ if crate::replay::template_is_null(step, loc) => ways.push(nothing(None)),
                _ if crate::replay::follows_a_list(step, loc, origin.exchange) => ways.push(nothing(Some(origin.exchange))),
                Loc::Header(_) if matches!(origin.at, At::Header { .. }) => ways.push(nothing(Some(origin.exchange))),
                _ => {}
            }
            ways
        }
        // The page's own code makes it, and the step's request is the page's (rung 3 and below): nothing of this
        // body's is sent in its place.
        Class::Computed | Class::Script { .. } => vec![Way { rung: 3, expr: Expr::Nothing { after: None } }],
        Class::Piece { input, from, len } => vec![way(0, Expr::Slice { of: Box::new(Expr::Given { name: input.clone() }), from: *from, len: *len })],
        Class::Recipe { recipe } => vec![way(1, recipe_expr(recipe))],
        Class::Generated { program, evidence } => vec![way(2, Expr::Program { source: program.clone(), evidence: serde_json::to_value(evidence).ok() })],
        Class::Fresh { value, id, clock } => {
            let clock = match clock {
                crate::fresh::Clock::Millis => route::Clock::Millis,
                crate::fresh::Clock::Seconds => route::Clock::Seconds,
                crate::fresh::Clock::Random => route::Clock::Random,
            };
            if id.is_empty() {
                return vec![way(0, Expr::text(value.as_str()))];
            }
            // The walked value with a new reading wherever the walk's id stood.
            let mut parts = Vec::new();
            for (n, piece) in value.split(id.as_str()).enumerate() {
                if n > 0 {
                    parts.push(Expr::Fresh { id: id.clone(), clock });
                }
                if !piece.is_empty() {
                    parts.push(Expr::text(piece));
                }
            }
            vec![way(0, Expr::Join { parts, with: String::new() })]
        }
        Class::File { name, of } => {
            let fact = match of {
                crate::upload::FileFact::Size => route::FileFact::Size,
                crate::upload::FileFact::Name => route::FileFact::Name,
            };
            vec![way(0, Expr::File { slot: name.clone(), fact })]
        }
    }
}

/// `expr` with what the caller gives now written where the walk's own value stood inside it.
fn held_in(expr: Expr, held: &Held) -> Expr {
    Expr::Swap {
        within: Box::new(expr),
        was: held.sits.clone(),
        now: Box::new(Expr::Written { of: Box::new(Expr::Given { name: held.input.clone() }), how: how_of(held.written) }),
        inside: held.inside.map(wrap_of),
    }
}

fn form_of(step: &Step, body: &Body) -> route::Form {
    match body {
        Body::Json { template, types } => route::Form::Json { template: template.clone(), types: types.clone(), follows: crate::replay::followed_lists(step) },
        Body::Form { fields } => route::Form::Fields { fields: fields.clone() },
        Body::Multipart { boundary, parts } => route::Form::Multipart {
            boundary: boundary.clone(),
            parts: parts
                .iter()
                .map(|p| route::Part { name: p.name.clone(), filename: p.filename.clone(), content_type: p.content_type.clone(), text: p.text.clone(), json: p.json.clone(), types: p.types.clone() })
                .collect(),
        },
        Body::Other => route::Form::Other,
        Body::Upload { input, protocol, content_type } => route::Form::Upload { slot: input.clone(), protocol: serde_json::to_value(protocol).unwrap_or_default(), content_type: content_type.clone() },
    }
}

/// One step of a graph as a step of a body.
pub fn step_of(graph: &Graph, step: &Step) -> route::Step {
    let holes = step
        .fields
        .iter()
        .map(|f| {
            let mut open = false;
            let mut ways = ways_of(graph, step, &f.loc, &f.class, &mut open);
            let held: Vec<&Held> = step.held.iter().filter(|h| h.loc == f.loc).collect();
            for way in ways.iter_mut().filter(|w| !w.expr.reads_the_request()) {
                for h in &held {
                    way.expr = held_in(std::mem::replace(&mut way.expr, Expr::Nothing { after: None }), h);
                }
            }
            route::Hole { at: place_of(&f.loc), ways, over: !held.is_empty(), open }
        })
        .collect();
    route::Step {
        id: step_id(step.exchange),
        method: step.method.clone(),
        url: step.url.clone(),
        holes,
        body: step.body.as_ref().map(|b| form_of(step, b)),
        expect: step.status,
        // A page is asked for as a page; a call a page's script made goes out from that page.
        script: (!graph.asks_as_a_page(step)).then(|| route::Caller { origin: graph.page_origin.clone() }),
        page: step.is_page_signed(),
        writes: crate::ledger::writes(step),
        on_load: step.on_load,
        sets_cookie: step.sets_cookie,
        lifetime: None,
        shape: step.response_shape.clone(),
    }
}

/// A graph as a body: the same route, in holes and ways.
pub fn from_graph(graph: &Graph, site: &str) -> route::Route {
    let mut slots: Vec<route::Slot> = Vec::new();
    for field in graph.steps.iter().flat_map(|s| &s.fields) {
        if let Class::Input { name, secret, default, .. } = &field.class {
            match slots.iter_mut().find(|s| s.name == *name) {
                Some(slot) => {
                    slot.secret |= *secret;
                    if slot.example.is_none() {
                        slot.example = default.clone();
                    }
                }
                None => slots.push(route::Slot { name: name.clone(), secret: *secret, example: default.clone(), choices: Vec::new() }),
            }
        }
    }
    // A secret's value is the caller's vault's, and is in no body.
    for slot in slots.iter_mut().filter(|s| s.secret) {
        slot.example = None;
    }
    let last = graph.steps.last();
    route::Route {
        v: route::VERSION, tests: Vec::new(), plan: None, meaning: Default::default(),
        site: site.to_string(),
        slots,
        steps: graph.steps.iter().map(|s| step_of(graph, s)).collect(),
        answer: route::Answer { step: last.map(|s| step_id(s.exchange)).unwrap_or_default(), page: last.is_some_and(|s| s.reads_page), decode: None },
    }
}

/// Why a body cannot be said as a graph: where it says what a graph cannot, and what.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unsaid {
    /// The step, where it is one step's.
    pub step: Option<String>,
    /// The place in that step, where it is one place's.
    pub at: Option<Place>,
    /// What a graph cannot say: the same words for the same kind of thing, so refusals can be counted by it.
    pub why: &'static str,
    /// What this body says there.
    pub detail: String,
}

impl std::fmt::Display for Unsaid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(step) = &self.step {
            write!(f, "step {step}")?;
            if let Some(at) = &self.at {
                write!(f, ", {at}")?;
            }
            write!(f, ": ")?;
        }
        write!(f, "{}", self.why)?;
        if !self.detail.is_empty() {
            write!(f, " ({})", self.detail)?;
        }
        Ok(())
    }
}

impl std::error::Error for Unsaid {}

pub(crate) fn loc_of(place: &Place) -> Loc {
    match place {
        Place::Path(i) => Loc::Path(*i),
        Place::Query(k) => Loc::Query(k.clone()),
        Place::Header(k) => Loc::Header(k.clone()),
        Place::Cookie(k) => Loc::Cookie(k.clone()),
        Place::Json(p) => Loc::Json(p.clone()),
        Place::Form(k) => Loc::Form(k.clone()),
        Place::Part(n, p) => Loc::Part(n.clone(), p.clone()),
        Place::Url => Loc::Url,
    }
}

fn how_back(how: route::How) -> Written {
    match how {
        route::How::Plain => Written::Plain,
        route::How::Json => Written::Json,
        route::How::Percent => Written::Percent,
        route::How::Plus => Written::Plus,
        route::How::Upper => Written::Upper,
        route::How::Lower => Written::Lower,
        route::How::Dashed => Written::Dashed,
    }
}

fn wrap_back(wrap: route::Wrap) -> Wrap {
    match wrap {
        route::Wrap::Base64 => Wrap::Base64,
        route::Wrap::Base64NoPad => Wrap::Base64NoPad,
        route::Wrap::Base64Url => Wrap::Base64Url,
        route::Wrap::Base64UrlNoPad => Wrap::Base64UrlNoPad,
    }
}

/// A digest over parts of the request and the session as the recipe it is ([`recipe_expr`] the other way). None
/// for an expression no recipe's part means.
fn recipe_of(algo: route::Algo, of: &Expr) -> Option<Recipe> {
    let Expr::Join { parts, with } = of else { return None };
    let part = |e: &Expr| -> Option<Part> {
        Some(match e {
            Expr::Sent { part: route::Sent::Path } => Part::Path,
            Expr::Sent { part: route::Sent::Method } => Part::Method,
            Expr::Sent { part: route::Sent::Body } => Part::Body,
            Expr::Sent { part: route::Sent::Cookie(name) } => Part::Cookie { name: name.clone() },
            Expr::Sent { part: route::Sent::Query(key) } => Part::Query { key: key.clone() },
            Expr::Sent { part: route::Sent::Header(name) } => Part::Header { name: name.clone() },
            Expr::Text { is } => Part::Constant { value: is.clone() },
            Expr::Stamp { form } => Part::Fresh { template: form.clone() },
            Expr::Piece { of, split, index } => match of.as_ref() {
                Expr::Sent { part: route::Sent::Cookie(name) } => Part::CookiePiece { name: name.clone(), separator: split.clone(), index: *index },
                _ => return None,
            },
            _ => return None,
        })
    };
    let algo = match algo {
        route::Algo::Md5 => Algo::Md5,
        route::Algo::Sha1 => Algo::Sha1,
        route::Algo::Sha256 => Algo::Sha256,
    };
    Some(Recipe { algo, separator: with.clone(), parts: parts.iter().map(part).collect::<Option<_>>()? })
}

/// A world that knows only what a body says by itself: what the walk sent for each slot (`or`), or a mark in its
/// place when `marked`. It is how a value the walk sent is read back out of a way, and where the caller's word sits
/// in it.
struct Walked {
    marked: bool,
}

/// The mark that stands for slot `name`'s value: no text a walk sends holds it.
fn mark(name: &str) -> String {
    format!("\u{e000}{name}\u{e001}")
}

impl route::World for Walked {
    fn slot(&self, name: &str) -> Option<String> {
        self.marked.then(|| mark(name))
    }
    fn cookie(&self, _: &str) -> Option<String> {
        None
    }
    fn read(&self, _: &str, _: &route::At) -> Option<String> {
        None
    }
    fn answered(&self, _: &str) -> bool {
        false
    }
    fn fresh(&mut self, id: &str, _: route::Clock) -> String {
        id.to_string()
    }
    fn now_ms(&self) -> u64 {
        0
    }
    fn digits(&mut self, n: usize) -> String {
        "0".repeat(n)
    }
    fn file(&self, _: &str, _: route::FileFact) -> Result<String, String> {
        Err("no file".into())
    }
    fn same_site(&self, a: &str, b: &str) -> bool {
        a == b
    }
}

fn walked_value(expr: &Expr, marked: bool) -> Option<String> {
    match expr.eval(&mut route::expr::Cx { world: &mut Walked { marked }, host: None, sent: None }) {
        Ok(route::Outcome::Is(v)) => Some(v),
        _ => None,
    }
}

/// The caller's words a way holds inside a longer value of the walk's, as a graph holds them ([`Held`]): a value
/// the caller's word is written into a certain way, a join of fixed text around one or more of their words, either
/// encoded again. None for a way of any other shape. The walk's whole value comes back beside them: a graph sends it,
/// with each word swapped for what the caller gives now.
fn held_way(loc: &Loc, expr: &Expr) -> Option<Result<(String, Vec<Held>), &'static str>> {
    // The caller's words, each with how it is written and what the walk sent.
    fn leaves(e: &Expr, out: &mut Vec<(String, route::How, Option<String>, bool)>) -> bool {
        match e {
            Expr::Slot { name, or, optional } => {
                out.push((name.clone(), route::How::Plain, or.clone(), *optional));
                true
            }
            Expr::Written { of, how } => match of.as_ref() {
                Expr::Slot { name, or, optional } => {
                    out.push((name.clone(), *how, or.clone(), *optional));
                    true
                }
                _ => false,
            },
            _ => false,
        }
    }
    let (inner, inside) = match expr {
        Expr::Wrapped { of, how } => (of.as_ref(), Some(*how)),
        e => (e, None),
    };
    let mut words = Vec::new();
    match inner {
        Expr::Join { parts, .. } => {
            for p in parts {
                if !matches!(p, Expr::Text { .. }) && !leaves(p, &mut words) {
                    return None;
                }
            }
        }
        // A word written another way is the walk's value with the word swapped: plain, it is a slot (an input).
        Expr::Written { how, .. } if *how != route::How::Plain || inside.is_some() => {
            leaves(inner, &mut words);
        }
        Expr::Slot { .. } if inside.is_some() => {
            leaves(inner, &mut words);
        }
        _ => return None,
    }
    if words.is_empty() {
        return None;
    }
    if words.iter().any(|(_, _, _, optional)| *optional) {
        return Some(Err("a word the caller may leave out of a longer value is sent with the walk's word by a graph"));
    }
    if words.iter().any(|(_, _, or, _)| or.is_none()) {
        return Some(Err("a longer value with no word of the walk's in it cannot be held by a graph"));
    }
    let Some(walked) = walked_value(expr, false) else { return Some(Err("the walk's value cannot be read back out of the way")) };
    let mut held: Vec<Held> = Vec::new();
    for (name, how, or, _) in &words {
        let h = Held { loc: loc.clone(), input: name.clone(), sits: how.write(or.as_deref().unwrap_or_default()), written: how_back(*how), inside: inside.map(wrap_back) };
        if !held.contains(&h) {
            held.push(h);
        }
    }
    // Where a graph puts each word is where the word as the walk wrote it stands in the walk's value. Each word is
    // put in as a mark, in the graph's order, and the value that comes out must be the one the way makes with the
    // marks: else the walk's word stands somewhere else too, and the caller's would go there as well.
    let text = match inside {
        Some(wrap) => match wrap.open(&walked) {
            Some(text) => text,
            None => return Some(Err("the walk's value is not the text the way encodes")),
        },
        None => walked.clone(),
    };
    let swapped = held.iter().fold(text, |v, h| crate::graph::swapped(&v, &h.sits, &h.written.write(&mark(&h.input))));
    if walked_value(inner, true).as_deref() != Some(swapped.as_str()) {
        return Some(Err("the caller's word, as the walk wrote it, stands elsewhere in the value too, and a graph would put the new word there as well"));
    }
    Some(Ok((walked, held)))
}

/// The walk's value, the id and its clock, where `parts` are fixed texts and one made-up id, which may stand in them
/// more than once. None for anything else: two ids, or a part that is neither.
fn fresh_in_text(parts: &[Expr]) -> Option<(String, String, crate::fresh::Clock)> {
    let mut found: Option<(&str, route::Clock)> = None;
    let mut value = String::new();
    for part in parts {
        match part {
            Expr::Text { is } => value.push_str(is),
            Expr::Fresh { id, clock } => {
                match found {
                    Some((had, _)) if had != id => return None,
                    _ => found = Some((id.as_str(), *clock)),
                }
                value.push_str(id);
            }
            _ => return None,
        }
    }
    let (id, clock) = found?;
    let clock = match clock {
        route::Clock::Millis => crate::fresh::Clock::Millis,
        route::Clock::Seconds => crate::fresh::Clock::Seconds,
        route::Clock::Random => crate::fresh::Clock::Random,
    };
    Some((value, id.to_string(), clock))
}

/// The class of a graph's field that fills a hole as `expr` does, and the caller's words it holds. Err: what a graph
/// cannot say.
fn class_of(body: &route::Route, hole: &route::Hole, expr: &Expr) -> Result<(Class, Vec<Held>), (&'static str, String)> {
    let loc = loc_of(&hole.at);
    let secret = |name: &str| body.slots.iter().any(|s| s.name == name && s.secret);
    let origin = |step: &str, at: &route::At, wrap: Option<(String, String)>| -> Result<Class, (&'static str, String)> {
        let exchange = exchange_of(step).ok_or(("a read of a step that is no call of the walk", step.to_string()))?;
        let url = body.step(step).map(|s| s.url.clone()).unwrap_or_default();
        Ok(Class::Derived { origin: crate::provenance::Origin { exchange, url, at: at_back(at), wrap } })
    };
    if let Some(held) = held_way(&loc, expr) {
        let (walked, held) = held.map_err(|why| (why, String::new()))?;
        return Ok((Class::Constant { value: walked, origin: None }, held));
    }
    let class = match expr {
        Expr::Text { is } if hole.open => Class::Unconfirmed { value: is.clone() },
        Expr::Text { is } => Class::Constant { value: is.clone(), origin: None },
        Expr::Slot { name, or, optional } => Class::Input { name: name.clone(), secret: secret(name), default: or.clone(), optional: *optional },
        Expr::Written { of, how: route::How::Plain } if matches!(of.as_ref(), Expr::Slot { .. }) => return class_of(body, hole, of),
        Expr::Given { name } => Class::Input { name: name.clone(), secret: secret(name), default: None, optional: false },
        Expr::Cookie { name, .. } => Class::Minted { name: name.clone() },
        Expr::Read { step, at } => origin(step, at, None)?,
        // A made-up id inside a longer value, as `from_graph` says a graph's fresh id: fixed text around one id, read
        // anew for each call wherever it stood. Said back as that fresh id, the walk's value with the id in place.
        Expr::Join { parts, with } if with.is_empty() && fresh_in_text(parts).is_some() => {
            let (value, id, clock) = fresh_in_text(parts).expect("matched just above");
            Class::Fresh { value, id, clock }
        }
        Expr::Join { parts, with } if with.is_empty() && matches!(parts.as_slice(), [Expr::Text { .. }, Expr::Read { .. }, Expr::Text { .. }]) => {
            let [Expr::Text { is: before }, Expr::Read { step, at }, Expr::Text { is: after }] = parts.as_slice() else { unreachable!() };
            origin(step, at, Some((before.clone(), after.clone())))?
        }
        Expr::Slice { of, from, len } => match of.as_ref() {
            Expr::Given { name } => Class::Piece { input: name.clone(), from: *from, len: *len },
            _ => return Err(("a piece of anything but the caller's value is no class of a graph's", String::new())),
        },
        Expr::Stamp { form } => {
            // A reading of the clock is a graph's fresh id: the walk's value with the id where the reading stood,
            // read anew on every call. One clock to a value, and no chance in it.
            let clocks: Vec<(&str, crate::fresh::Clock)> = [("{ms}", crate::fresh::Clock::Millis), ("{s}", crate::fresh::Clock::Seconds)].into_iter().filter(|(token, _)| form.contains(token)).collect();
            let rest = clocks.iter().fold(form.clone(), |f, (token, _)| f.replace(token, ""));
            match clocks.as_slice() {
                [(token, clock)] if !rest.contains(['{', '}']) => Class::Fresh { value: form.clone(), id: token.to_string(), clock: *clock },
                _ => return Err(("a graph's fresh id is one reading of one clock", form.clone())),
            }
        }
        Expr::Fresh { id, clock } => Class::Fresh {
            value: id.clone(),
            id: id.clone(),
            clock: match clock {
                route::Clock::Millis => crate::fresh::Clock::Millis,
                route::Clock::Seconds => crate::fresh::Clock::Seconds,
                route::Clock::Random => crate::fresh::Clock::Random,
            },
        },
        Expr::Pick { .. } => return Err(("a graph has no class for a value picked from a list in an earlier reply", String::new())),
        Expr::Hash { algo, of } => Class::Recipe { recipe: recipe_of(*algo, of).ok_or(("a digest over what no recipe's part means", format!("{of:?}")))? },
        Expr::Program { source, evidence } => match evidence.clone().and_then(|e| serde_json::from_value(e).ok()) {
            Some(evidence) => Class::Generated { program: source.clone(), evidence },
            None => return Err(("a program with no evidence of how it was made", String::new())),
        },
        Expr::File { slot, fact } => Class::File {
            name: slot.clone(),
            of: match fact {
                route::FileFact::Size => crate::upload::FileFact::Size,
                route::FileFact::Name => crate::upload::FileFact::Name,
            },
        },
        Expr::Swap { .. } => {
            // A graph's own held word, said as a body (`held_in`), said back.
            let mut held = Vec::new();
            let mut at = expr;
            while let Expr::Swap { within, was, now, inside } = at {
                let Expr::Written { of, how } = now.as_ref() else { return Err(("a swap of anything but the caller's value written some way", String::new())) };
                let Expr::Given { name } = of.as_ref() else { return Err(("a swap of anything but the caller's value written some way", String::new())) };
                held.insert(0, Held { loc: loc.clone(), input: name.clone(), sits: was.clone(), written: how_back(*how), inside: inside.map(wrap_back) });
                at = within;
            }
            let (class, inner) = class_of(body, hole, at)?;
            if !inner.is_empty() || !matches!(class, Class::Constant { .. } | Class::Unconfirmed { .. } | Class::Derived { .. } | Class::Input { .. }) {
                return Err(("a swap into a value no graph holds a word in", String::new()));
            }
            return Ok((class, held));
        }
        other => return Err(("no class of a graph's field fills a place this way", format!("{other:?}").split([' ', '{']).next().unwrap_or_default().to_string())),
    };
    Ok((class, Vec::new()))
}

/// A body's step as a graph's step, and whether each of its holes fills as the graph's own field does by its very
/// ways (`step_of`), or only by what they come to (a word held in a longer value; a reading of the clock).
fn graph_step(body: &route::Route, step: &route::Step) -> Result<(Step, Vec<bool>), Unsaid> {
    let here = |at: Option<&Place>, why: &'static str, detail: String| Unsaid { step: Some(step.id.clone()), at: at.cloned(), why, detail };
    let exchange = exchange_of(&step.id).ok_or_else(|| here(None, "a graph's step is a call of the walk, named by its place there", step.id.clone()))?;
    if step.page {
        return Err(here(None, "the page's own code makes this step, and a graph made from a body carries no page", String::new()));
    }
    if step.lifetime.is_some() {
        return Err(here(None, "a graph keeps no reply for a time", String::new()));
    }
    let mut fields: Vec<Field> = Vec::new();
    let mut held: Vec<Held> = Vec::new();
    let mut by_its_ways: Vec<bool> = Vec::new();
    for hole in &step.holes {
        let (class, h) = match hole.ways.as_slice() {
            [] => return Err(here(Some(&hole.at), "a hole with no way to fill it", String::new())),
            // A read with the fallback a graph applies by itself is that read: the fallback is checked against the
            // graph's own below.
            [first, ..] => class_of(body, hole, &first.expr).map_err(|(why, detail)| here(Some(&hole.at), why, detail))?,
        };
        by_its_ways.push(h.is_empty() && !matches!(class, Class::Fresh { .. }));
        fields.push(Field { loc: loc_of(&hole.at), class });
        held.extend(h);
    }
    let constant = |loc: &Loc| fields.iter().find_map(|f| match &f.class {
        Class::Constant { value, .. } if f.loc == *loc && held.iter().any(|h| h.loc == *loc) => Some(value.clone()),
        _ => None,
    });
    let form = match &step.body {
        None => None,
        Some(route::Form::Json { template, types, .. }) => {
            // A word held in a longer value is the walk's own text in a graph's template, as `graph::build` writes it.
            let (mut template, mut types) = (template.clone(), types.clone());
            for h in &held {
                if let (Loc::Json(pointer), Some(value)) = (&h.loc, constant(&h.loc)) {
                    if let Some(leaf) = template.pointer_mut(pointer) {
                        *leaf = serde_json::Value::String(value);
                    }
                    types.remove(pointer);
                }
            }
            Some(Body::Json { template, types })
        }
        Some(route::Form::Fields { fields: named }) => Some(Body::Form { fields: named.iter().map(|(name, fixed)| (name.clone(), fixed.clone().or_else(|| constant(&Loc::Form(name.clone()))))).collect() }),
        Some(route::Form::Multipart { boundary, parts }) => {
            if held.iter().any(|h| matches!(h.loc, Loc::Part(..))) {
                return Err(here(None, "a graph holds no caller's word in a part of a multipart body", String::new()));
            }
            Some(Body::Multipart {
                boundary: boundary.clone(),
                parts: parts.iter().map(|p| crate::graph::PartTemplate { name: p.name.clone(), filename: p.filename.clone(), content_type: p.content_type.clone(), text: p.text.clone(), json: p.json.clone(), types: p.types.clone() }).collect(),
            })
        }
        Some(route::Form::Upload { slot, protocol, content_type }) => Some(Body::Upload {
            input: slot.clone(),
            protocol: serde_json::from_value(protocol.clone()).map_err(|e| here(None, "an upload whose way of sending a graph does not read", e.to_string()))?,
            content_type: content_type.clone(),
        }),
        Some(route::Form::Other) => Some(Body::Other),
        Some(route::Form::Wire { .. }) => return Err(here(None, "a graph holds no binary body's fields", String::new())),
    };
    // The address as `graph::build` writes it: the path's made pieces as holes, and the query's values in their order,
    // each one made for the call as a hole of its key.
    fn enc(s: &str) -> String {
        url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
    }
    let query: Vec<String> = fields
        .iter()
        .filter_map(|f| match (&f.loc, &f.class) {
            (Loc::Query(k), Class::Constant { value, .. } | Class::Unconfirmed { value }) => Some(format!("{}={}", enc(k), enc(value))),
            (Loc::Query(k), _) => Some(format!("{}={{{k}}}", enc(k))),
            _ => None,
        })
        .collect();
    let url = address_of(step, &query);
    let is_answer = step.id == body.answer.step;
    let graph_step = Step {
        exchange,
        method: step.method.clone(),
        status: step.expect,
        url,
        fields,
        body: form,
        response_shape: step.shape.clone(),
        needs_browser: false,
        page_signed: false,
        page_producers: Vec::new(),
        sets_cookie: step.sets_cookie,
        on_load: step.on_load,
        foreign: false,
        held,
        reads_page: is_answer && body.answer.page,
    };
    Ok((graph_step, by_its_ways))
}

/// A body's step's address as a graph holds it: the address the body holds, with the query a graph writes from the
/// step's holes (`query`, each `key=value` or `key={key}`). A body said from a graph keeps the graph's address, its
/// query in it (the filler reads only the path of it), and that is the address as a graph holds it already.
fn address_of(step: &route::Step, query: &[String]) -> String {
    if query.is_empty() || step.url.contains('?') {
        step.url.clone()
    } else {
        format!("{}?{}", step.url, query.join("&"))
    }
}

/// The page a script's call goes out from: the one it names, or its own origin.
fn goes_out_from(caller: &route::Caller, step: &route::Step) -> String {
    caller.origin.clone().unwrap_or_else(|| url::Url::parse(&step.url.replace('{', "%7B").replace('}', "%7D")).map(|u| u.origin().ascii_serialization()).unwrap_or_default())
}

/// A body as a graph the node's caller runs (`replay`), saying each hole's way as the class of field that means the
/// same: a fixed text, a slot, a cookie, a read, a piece of the caller's value, a word held in a longer value, a
/// reading of the clock, a recipe, a program, a fact about a file. Where the body says something a graph cannot (a
/// way no class means, a word a graph would put in more places than the body, a read a graph would fall back from
/// where the body stops, a page asked for as a script's call or the other way, a step one says writes and the
/// other does not), nothing is written and the place and the reason are said. Nothing is made close.
///
/// What a graph keeps and a body does not (the scripts of a page, what the walk's answers set) is left out: no step
/// of a body learned by example needs the page or was sent by itself as it loaded.
pub fn to_graph(body: &route::Route) -> Result<Graph, Unsaid> {
    let whole = |why: &'static str, detail: String| Unsaid { step: None, at: None, why, detail };
    if let Some(why) = body.refused() {
        return Err(whole("the body is refused", why));
    }
    if body.answer.decode.is_some() {
        return Err(whole("the site's own code unpacks the reply, and a graph has no decoder for an answer", String::new()));
    }
    let Some(last) = body.steps.last() else { return Err(whole("a body with no step", String::new())) };
    if last.id != body.answer.step {
        return Err(whole("a graph's answer is its last step", format!("the answer is {}, the last step {}", body.answer.step, last.id)));
    }
    // A graph's scripts' calls all go out from one page. A call that names none goes out from its own origin.
    let page_origin = if body.steps.iter().filter_map(|s| s.script.as_ref()).all(|c| c.origin.is_none()) {
        None
    } else {
        let mut pages: Vec<String> = body.steps.iter().filter_map(|s| s.script.as_ref().map(|c| goes_out_from(c, s))).collect();
        pages.dedup();
        match pages.as_slice() {
            [one] => Some(one.clone()),
            more => return Err(whole("a graph's scripts' calls go out from one page, and this body's from more", format!("{more:?}"))),
        }
    };
    let mut graph = Graph { page_origin, ..Graph::default() };
    let mut ways: Vec<Vec<bool>> = Vec::new();
    for step in &body.steps {
        let (s, w) = graph_step(body, step)?;
        graph.steps.push(s);
        ways.push(w);
    }
    graph.provisional = graph.steps.iter().flat_map(|s| &s.fields).any(|f| matches!(f.class, Class::Unconfirmed { .. }));
    // A step the body asks for as a page, whose reply holds JSON and is not the answer read as a page, is a page the
    // browser went to, answered by the state it embeds: the graph says so, and asks it as a page.
    graph.visited = body.steps.iter().filter(|s| s.script.is_none() && s.shape.is_some() && !(s.id == body.answer.step && body.answer.page)).filter_map(|s| exchange_of(&s.id)).collect();
    // Held to the graph's own reading of itself: the body its steps say (`step_of`) is this body, step for step, but
    // where a hole fills by what its way comes to and not by the way itself.
    for ((step, theirs), by_its_ways) in body.steps.iter().zip(&graph.steps).zip(&ways) {
        let said = step_of(&graph, theirs);
        let here = |at: Option<&Place>, why: &'static str, detail: String| Unsaid { step: Some(step.id.clone()), at: at.cloned(), why, detail };
        if said.script.is_some() != step.script.is_some() {
            return Err(match step.script {
                Some(_) => here(None, "a graph asks a step whose reply holds no JSON for as a page, and this body asks it as a script's call", String::new()),
                None => here(None, "a graph asks a step whose reply holds JSON for as a script's call unless that page is the answer read as a page, and this body asks it as a page", String::new()),
            });
        }
        if let (Some(theirs), Some(ours)) = (&said.script, &step.script) {
            if goes_out_from(theirs, &said) != goes_out_from(ours, step) {
                return Err(here(None, "a graph's step goes out from another page than the body's", format!("{:?} against {:?}", theirs.origin, ours.origin)));
            }
        }
        if said.writes != step.writes {
            return Err(here(None, "the ledger's rule says of the graph's step another thing than the body says of its own", format!("the body says {} it writes, the graph {}", step.writes, said.writes)));
        }
        for ((hole, theirs), by_its_ways) in step.holes.iter().zip(&said.holes).zip(by_its_ways) {
            if *by_its_ways && (hole.ways != theirs.ways || hole.open != theirs.open || hole.over != theirs.over) {
                return Err(here(Some(&hole.at), "a graph's field fills this place another way than the body does", format!("{:?}", theirs.ways.iter().map(|w| &w.expr).collect::<Vec<_>>())));
            }
            if !*by_its_ways && hole.ways.len() != 1 {
                return Err(here(Some(&hole.at), "a graph holds a word in a longer value, or reads the clock, in one way only", String::new()));
            }
        }
        if let (Some(route::Form::Json { follows: ours, .. }), Some(route::Form::Json { follows: theirs, .. })) = (&step.body, &said.body) {
            if ours != theirs {
                return Err(here(None, "the lists a graph cuts short where a reply's list is shorter are not the body's", format!("{theirs:?} against {ours:?}")));
            }
        }
    }
    Ok(graph)
}

/// Whether a graph says `hole` of `step` as the body does, read as [`to_graph`] reads a hole: a class of a graph's
/// field means its first way, and the graph's own reading of that field (`step_of`) gives the hole's ways back, or,
/// for a word held in a longer value or a reading of the clock, fills it in one way by what that way comes to. Only
/// the hole is asked: whether its step is a page's, or keeps its reply a while, is the step's.
pub fn a_graph_says(body: &route::Route, step: &route::Step, hole: &route::Hole) -> bool {
    let mut alone = step.clone();
    alone.holes = vec![hole.clone()];
    alone.page = false;
    alone.lifetime = None;
    let Ok((said, by_its_ways)) = graph_step(body, &alone) else { return false };
    let graph = Graph { steps: vec![said], ..Graph::default() };
    let back = step_of(&graph, &graph.steps[0]);
    let Some(theirs) = back.holes.iter().find(|h| h.at == hole.at) else { return false };
    match by_its_ways.first() {
        Some(true) => hole.ways == theirs.ways && hole.open == theirs.open && hole.over == theirs.over,
        Some(false) => hole.ways.len() == 1,
        None => false,
    }
}

/// Each slot `body` asks, whether it is secret, and the value the walk gave it where a way says it (a slot's
/// fallback): what a route that keeps the body offers its callers.
pub fn asked_as_walked(body: &route::Route) -> Vec<(String, bool, Option<String>)> {
    let ways: Vec<&Expr> = body.steps.iter().flat_map(|s| &s.holes).flat_map(|h| &h.ways).flat_map(|w| w.expr.all()).collect();
    body.asked()
        .into_iter()
        .map(|name| {
            let secret = body.slots.iter().any(|s| s.name == name && s.secret);
            let walked = ways.iter().find_map(|e| match e {
                Expr::Slot { name: n, or: Some(was), .. } if n == name => Some(was.clone()),
                _ => None,
            });
            (name.to_string(), secret, walked)
        })
        .collect()
}

/// What runs where a route keeps the body it was learned as beside its graph: the graph, said as a body, with the
/// stored body's holes a graph cannot say laid over it ([`overlay`]).
#[derive(Clone, Debug)]
pub struct Overlaid {
    pub body: route::Route,
    /// The holes laid over the graph's, by step and place.
    pub laid: Vec<(String, Place)>,
    /// The stored body's holes a graph cannot say that had nowhere to go, and why.
    pub dropped: Vec<String>,
}

/// Whether two steps are the same call: the same method, and the same address, piece for piece, but where either makes
/// a piece for each call.
fn the_same_call(a: &route::Step, b: &route::Step) -> bool {
    let pieces = |url: &str| url.split('?').next().unwrap_or_default().split('/').map(String::from).collect::<Vec<_>>();
    let made = |piece: &str| piece.starts_with("{path[");
    let (ours, theirs) = (pieces(&a.url), pieces(&b.url));
    a.method.eq_ignore_ascii_case(&b.method) && ours.len() == theirs.len() && ours.iter().zip(&theirs).all(|(p, q)| p == q || made(p) || made(q))
}

/// The body a call runs, from the route's graph as it stands and the body it was learned as (`stored`).
///
/// The graph carries every pass the node makes after a learn (a page input for reading on, a shorter chain, a header
/// moved to the jar, a word the site hears inside a longer value), and other passes are added all the time; a body
/// written before them knows none of them. So the graph is what runs, said as a body ([`from_graph`]), and the stored
/// body says only what a graph cannot: each of its holes that a graph does not say ([`a_graph_says`]) takes the place
/// of the graph's hole at the same place of the same step, the step that is the same call (the learners number a
/// walk's calls each its own way), reading what it reads from the graph's steps. Every other hole, every step, the slots and the answer are
/// the graph's. A hole whose step the graph no longer has, whose place the graph's step no longer sends, or that reads
/// a step the graph no longer has, is dropped and said. A step the graph reads as the page's to make only for values
/// it could not say, all of which the body says, is the body's to make. With no stored body, or none of its holes
/// laid, the body is the graph's own, which runs as the graph does.
pub fn overlay(graph: &Graph, stored: Option<&route::Route>) -> Overlaid {
    let mut body = from_graph(graph, stored.map_or("", |b| b.site.as_str()));
    let (mut laid, mut dropped) = (Vec::new(), Vec::new());
    let Some(stored) = stored else { return Overlaid { body, laid, dropped } };
    // What the stored body found its values to mean is the body's to keep: its slots' kinds and its answer's records.
    body.meaning = stored.meaning.clone();
    // The site's own code unpacks the reply: the decoder is the body's, not the graph's (a graph has no decoder), so
    // it is carried onto the rebuilt body and is a reason the body runs (`with_body`), whatever its request holes are.
    body.answer.decode = stored.answer.decode.clone();
    // Each stored step is the graph's step that is the same call: the two learners number one walk's calls otherwise
    // (the classifier counts only the calls it keeps), so a step is known by what it asks, in the walk's order.
    let mut taken: Vec<usize> = Vec::new();
    let mut names: HashMap<String, String> = HashMap::new();
    for step in &stored.steps {
        if let Some(n) = (0..body.steps.len()).find(|n| !taken.contains(n) && the_same_call(step, &body.steps[*n])) {
            taken.push(n);
            names.insert(step.id.clone(), body.steps[n].id.clone());
        }
    }
    // A binary body the graph's step cannot open (its body is opaque to a graph) is the stored step's own: its form,
    // and each hole in its fields, which the graph's step has no place for, are taken whole.
    for step in &stored.steps {
        let (Some(route::Form::Wire { .. }), Some(id)) = (&step.body, names.get(&step.id)) else { continue };
        let Some(theirs) = body.steps.iter_mut().find(|s| s.id == *id).filter(|s| matches!(s.body, Some(route::Form::Other))) else { continue };
        theirs.body = step.body.clone();
        for hole in step.holes.iter().filter(|h| matches!(h.at, Place::Json(_)) && h.ways.iter().all(|w| w.expr.reads().is_empty())) {
            if !theirs.holes.iter().any(|h| h.at == hole.at) {
                theirs.holes.push(hole.clone());
                laid.push((id.clone(), hole.at.clone()));
            }
        }
    }
    for step in &stored.steps {
        for hole in step.holes.iter().filter(|h| !a_graph_says(stored, step, h)) {
            let Some(id) = names.get(&step.id) else {
                dropped.push(format!("step {}, {}: the graph has no such call", step.id, hole.at));
                continue;
            };
            if let Some(gone) = hole.ways.iter().flat_map(|w| w.expr.reads()).find(|read| !names.contains_key(*read)) {
                dropped.push(format!("step {}, {}: it reads step {gone}, which the graph has no longer", step.id, hole.at));
                continue;
            }
            let renamed = route::Hole { ways: hole.ways.iter().map(|w| Way { rung: w.rung, expr: w.expr.with_steps_renamed(&|read| names[read].clone()) }).collect(), ..hole.clone() };
            let theirs = body.steps.iter_mut().find(|s| s.id == *id).expect("a named step is the graph's");
            match theirs.holes.iter_mut().find(|h| h.at == hole.at) {
                Some(at) => {
                    *at = renamed;
                    laid.push((id.clone(), hole.at.clone()));
                }
                None => dropped.push(format!("step {}, {}: the graph's step sends nothing there", step.id, hole.at)),
            }
        }
    }
    // A step the graph says the page makes only for values the body now says is not the page's to make: the graph read
    // those values as made by the page's code because it could not say them, and the body does. One the walk saw the
    // page make whole, or that needs the browser for anything else, still is.
    for step in &graph.steps {
        let id = step_id(step.exchange);
        let laid_here = |loc: &Loc| laid.iter().any(|(at, place)| *at == id && *place == place_of(loc));
        if !laid.iter().any(|(at, _)| *at == id) {
            continue;
        }
        let made: Vec<&Loc> = step.fields.iter().filter(|f| matches!(f.class, Class::Script { .. } | Class::Computed)).map(|f| &f.loc).chain(step.page_producers.iter().map(|p| &p.loc)).collect();
        let still = step.page_signed || (made.is_empty() && step.needs_browser) || made.iter().any(|loc| !laid_here(loc));
        if let Some(ours) = body.steps.iter_mut().find(|s| s.id == id) {
            ours.page = still;
        }
    }
    // A slot a laid hole asks that the graph does not, as the stored body has it.
    let asked: Vec<String> = laid.iter().filter_map(|(id, at)| body.step(id).and_then(|s| s.holes.iter().find(|h| h.at == *at))).flat_map(|h| h.ways.iter().flat_map(|w| w.expr.slots())).map(String::from).collect();
    for name in asked {
        if !body.slots.iter().any(|s| s.name == name) {
            body.slots.push(stored.slots.iter().find(|s| s.name == name).cloned().unwrap_or(route::Slot { name, secret: false, example: None, choices: Vec::new() }));
        }
    }
    Overlaid { body, laid, dropped }
}

/// The graph the node's caller runs a body by, where the body builds every request itself (`replay::replay_body`):
/// what the caller's loop reads of a step besides its request, and nothing more. It never refuses: a body a graph
/// cannot say (a value written one way after another, a value picked from a list) has a skeleton all the same.
///
/// Per step: the exchange its id names (a step named otherwise takes the next free one), its method, its address with
/// the query's fixed values written in as `graph::build` writes them (each other value a hole of its key), the status
/// it was learned with, the shape of its reply, whether the page sent it as it loaded and whether its answer set a
/// cookie, whether the page's own code makes it, whether it is a page the browser went to or the answer read as a
/// page, its body's template, and whether it writes, as the body says. Per hole, fields at its place saying what the
/// loop reads off a field: each earlier step a way reads, and where; each caller's value it takes, by name, whether
/// secret, and what the walk sent; a file's fact; a fresh id; a value the jar holds, by name (the client's runner
/// tells the jar's tokens from its cookies by it); the text the step sends as its own, which the ledger's rule reads.
/// Anything else is a constant with no value in it. What the node keeps beside a body is set on it by
/// [`skeleton_beside`].
pub fn skeleton(body: &route::Route) -> Graph {
    // Each step's exchange: the one its id names, or the next free one.
    let mut next = body.steps.iter().filter_map(|s| exchange_of(&s.id)).max().map_or(0, |m| m + 1);
    let mut number: HashMap<&str, usize> = HashMap::new();
    for s in &body.steps {
        let n = exchange_of(&s.id).unwrap_or_else(|| {
            next += 1;
            next - 1
        });
        number.insert(s.id.as_str(), n);
    }
    let secret = |name: &str| body.slots.iter().any(|s| s.name == name && s.secret);
    let mut graph = Graph::default();
    for step in &body.steps {
        let mut fields: Vec<Field> = Vec::new();
        for hole in &step.holes {
            let loc = loc_of(&hole.at);
            let mut field = |class: Class| {
                let f = Field { loc: loc.clone(), class };
                if !fields.iter().any(|g| g.loc == f.loc && serde_json::to_value(&g.class).ok() == serde_json::to_value(&f.class).ok()) {
                    fields.push(f);
                }
            };
            let mut said = false;
            for expr in hole.ways.iter().flat_map(|w| w.expr.all()) {
                let origin = |read: &str, at: crate::provenance::At| number.get(read).map(|&exchange| crate::provenance::Origin { exchange, url: body.step(read).map(|s| s.url.clone()).unwrap_or_default(), at, wrap: None });
                let class = match expr {
                    Expr::Read { step: read, at } => origin(read, at_back(at)).map(|origin| Class::Derived { origin }),
                    Expr::Pick { step: read, list, .. } => origin(read, crate::provenance::At::Json { pointer: list.clone() }).map(|origin| Class::Derived { origin }),
                    Expr::Slot { name, or, optional } => Some(Class::Input { name: name.clone(), secret: secret(name), default: or.clone(), optional: *optional }),
                    Expr::Given { name } => Some(Class::Input { name: name.clone(), secret: secret(name), default: None, optional: false }),
                    Expr::File { slot, fact } => Some(Class::File {
                        name: slot.clone(),
                        of: match fact {
                            route::FileFact::Size => crate::upload::FileFact::Size,
                            route::FileFact::Name => crate::upload::FileFact::Name,
                        },
                    }),
                    // A value the jar holds: the runner tells the jar's tokens from its cookies by these.
                    Expr::Cookie { name, .. } => Some(Class::Minted { name: name.clone() }),
                    Expr::Fresh { id, clock } => Some(Class::Fresh {
                        value: id.clone(),
                        id: id.clone(),
                        clock: match clock {
                            route::Clock::Millis => crate::fresh::Clock::Millis,
                            route::Clock::Seconds => crate::fresh::Clock::Seconds,
                            route::Clock::Random => crate::fresh::Clock::Random,
                        },
                    }),
                    _ => None,
                };
                if let Some(class) = class {
                    said = true;
                    field(class);
                }
            }
            // The text the step sends as its own: a fixed text, or the walk's value around the caller's words. The
            // caller's value itself, however written or cut, is the caller's, not the step's.
            fn the_callers(e: &Expr) -> bool {
                match e {
                    Expr::Slot { .. } | Expr::Given { .. } => true,
                    Expr::Written { of, .. } | Expr::Slice { of, .. } | Expr::Piece { of, .. } => the_callers(of),
                    _ => false,
                }
            }
            let first = hole.ways.first().map(|w| &w.expr);
            let own = first
                .filter(|e| !the_callers(e) && !e.reads_the_request() && e.reads().is_empty() && !e.all().iter().any(|x| matches!(x, Expr::Stamp { .. } | Expr::Fresh { .. } | Expr::Cookie { .. } | Expr::Stored { .. } | Expr::File { .. })))
                .and_then(|e| walked_value(e, false));
            match own {
                Some(value) if hole.open && matches!(first, Some(Expr::Text { .. })) => field(Class::Unconfirmed { value }),
                Some(value) => field(Class::Constant { value, origin: None }),
                None if !said => field(Class::Constant { value: String::new(), origin: None }),
                None => {}
            }
        }
        let held_text = |loc: &Loc| fields.iter().find_map(|f| match &f.class {
            Class::Constant { value, .. } | Class::Unconfirmed { value } if f.loc == *loc && !value.is_empty() => Some(value.clone()),
            _ => None,
        });
        fn enc(s: &str) -> String {
            url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
        }
        let query: Vec<String> = step
            .holes
            .iter()
            .filter_map(|h| match &h.at {
                Place::Query(k) => Some(match held_text(&Loc::Query(k.clone())) {
                    Some(v) if !fields.iter().any(|f| f.loc == Loc::Query(k.clone()) && !matches!(f.class, Class::Constant { .. } | Class::Unconfirmed { .. })) => format!("{}={}", enc(k), enc(&v)),
                    _ => format!("{}={{{k}}}", enc(k)),
                }),
                _ => None,
            })
            .collect();
        let url = address_of(step, &query);
        let form = step.body.as_ref().map(|form| match form {
            route::Form::Json { template, types, .. } => Body::Json { template: template.clone(), types: types.clone() },
            route::Form::Fields { fields } => Body::Form { fields: fields.clone() },
            route::Form::Multipart { boundary, parts } => Body::Multipart {
                boundary: boundary.clone(),
                parts: parts.iter().map(|p| crate::graph::PartTemplate { name: p.name.clone(), filename: p.filename.clone(), content_type: p.content_type.clone(), text: p.text.clone(), json: p.json.clone(), types: p.types.clone() }).collect(),
            },
            route::Form::Upload { slot, protocol, content_type } => match serde_json::from_value(protocol.clone()) {
                Ok(protocol) => Body::Upload { input: slot.clone(), protocol, content_type: content_type.clone() },
                Err(_) => Body::Other,
            },
            route::Form::Other | route::Form::Wire { .. } => Body::Other,
        });
        let mut skeleton = Step {
            exchange: number[step.id.as_str()],
            method: step.method.clone(),
            status: step.expect,
            url,
            fields,
            body: form,
            response_shape: step.shape.clone(),
            needs_browser: false,
            page_signed: step.page,
            page_producers: Vec::new(),
            sets_cookie: step.sets_cookie,
            on_load: step.on_load,
            foreign: false,
            held: Vec::new(),
            reads_page: step.id == body.answer.step && body.answer.page,
        };
        // Whether it writes, as the body says. A step the body says writes, which the ledger's rule would read as one
        // that only asks, is held to its method, as the rule holds a step that is someone else's.
        if step.writes && !crate::ledger::writes(&skeleton) {
            skeleton.foreign = true;
        }
        graph.steps.push(skeleton);
    }
    graph.provisional = body.steps.iter().flat_map(|s| &s.holes).any(|h| h.open);
    graph.page_origin = body.steps.iter().find_map(|s| s.script.as_ref().and_then(|c| c.origin.clone()));
    graph.visited = body.steps.iter().filter(|s| s.script.is_none() && s.shape.is_some() && !(s.id == body.answer.step && body.answer.page)).map(|s| number[s.id.as_str()]).collect();
    graph
}

/// A body's [`skeleton`], with what the node keeps beside a body set on it from the route's stored `graph`: the page
/// the route carries (`page_html`), the door it met, the page a signing bridge boots, the scripts it runs and the
/// answers that page read, and the page its calls go out from. A body never carries any of these (markup can hold a
/// session, and a body may be shared): the node's route record keeps them, as it keeps them on a graph.
pub fn skeleton_beside(body: &route::Route, graph: &Graph) -> Graph {
    let mut skeleton = skeleton(body);
    skeleton.page_html = graph.page_html.clone();
    skeleton.door = graph.door.clone();
    skeleton.page = graph.page.clone();
    skeleton.scripts = graph.scripts.clone();
    skeleton.api = graph.api.clone();
    skeleton.page_origin = graph.page_origin.clone().or(skeleton.page_origin);
    skeleton
}

/// The clock and the chance one step of a call is made with: read once, and handed to every maker of that step's
/// values, the body's filler and the graph's own loops alike, so a digest over a reading of the clock or a run of
/// random digits is the same digest whichever made it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reading {
    /// Milliseconds since 1970.
    pub now: u64,
    /// Where the step's random digits start.
    pub seed: u64,
}

static DRAWS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Reading {
    /// A reading of the clock now, and a seed of chance no other reading shares.
    pub fn take() -> Reading {
        // A clock a test holds gives the same reading and the same chance each time, so two calls it holds to each
        // other draw alike.
        #[cfg(test)]
        if let Some(now) = crate::fresh::HELD.with(|held| held.get()) {
            return Reading { now: now as u64, seed: now as u64 };
        }
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
        Reading { now: crate::fresh::now_millis() as u64, seed: nanos ^ (std::process::id() as u64) << 32 ^ DRAWS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) }
    }

    /// The step's random digits, drawn in turn: every maker that draws the same counts in the same order gets the same
    /// digits.
    pub fn chance(&self) -> impl FnMut(usize) -> String {
        let mut state = self.seed | 1;
        move |n| {
            (0..n)
                .map(|_| {
                    state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
                    char::from(b'0' + ((state >> 33) % 10) as u8)
                })
                .collect()
        }
    }
}

/// The world of one replay: the caller's values, the transport's session, the replies the call has had so far, and
/// the step's reading of the clock and of chance.
pub struct Replaying<'a, F: Fetch + ?Sized> {
    pub graph: &'a Graph,
    pub inputs: &'a HashMap<String, String>,
    pub fetch: &'a F,
    pub responses: &'a HashMap<usize, Exchange>,
    /// A new reading for each id the walk's page made up, the same in every step of the call.
    pub fresh: &'a HashMap<String, String>,
    pub reading: Reading,
    /// The step's random digits, as `reading` draws them.
    pub chance: Box<dyn FnMut(usize) -> String + 'a>,
}

impl<F: Fetch + ?Sized> route::World for Replaying<'_, F> {
    fn slot(&self, name: &str) -> Option<String> {
        self.inputs.get(name).cloned()
    }

    fn cookie(&self, name: &str) -> Option<String> {
        self.fetch.minted(name)
    }

    fn cookie_for(&self, name: &str, host: Option<&str>) -> Option<String> {
        self.fetch.minted_cookie(name, host)
    }

    fn read(&self, step: &str, at: &route::At) -> Option<String> {
        let source = self.responses.get(&exchange_of(step)?)?;
        crate::provenance::extract(source, &crate::replay::rekeyed(&at_back(at), self.graph, self.inputs, source.response_body.as_deref()))
    }

    fn list(&self, step: &str, pointer: &str) -> Option<Vec<serde_json::Value>> {
        self.responses.get(&exchange_of(step)?)?.own_json()?.pointer(pointer)?.as_array().cloned()
    }

    fn answered(&self, step: &str) -> bool {
        exchange_of(step).is_some_and(|e| self.responses.contains_key(&e))
    }

    fn fresh(&mut self, id: &str, _clock: route::Clock) -> String {
        self.fresh.get(id).cloned().unwrap_or_else(|| id.to_string())
    }

    fn now_ms(&self) -> u64 {
        self.reading.now
    }

    fn digits(&mut self, n: usize) -> String {
        (self.chance)(n)
    }

    fn file(&self, named: &str, fact: route::FileFact) -> Result<String, String> {
        let opened = crate::files::open_in(named, &self.fetch.file_root())?;
        Ok(match fact {
            route::FileFact::Size => opened.size.to_string(),
            route::FileFact::Name => opened.name,
        })
    }

    fn same_site(&self, a: &str, b: &str) -> bool {
        let site = |origin: &str| url::Url::parse(origin).ok().and_then(|u| u.host_str().map(crate::identity::site_of));
        site(a).is_some() && site(a) == site(b)
    }

    fn program(&mut self, source: &str, sent: &route::Built) -> Option<String> {
        let request = Request { method: sent.method.clone(), url: sent.url.clone(), exchange: 0, headers: sent.headers.clone(), body: sent.body.as_deref().map(unbrowse_route::wire::bytes_of) };
        crate::generated::compute(source, &request, &sent.cookies(), &self.fetch.environment())
    }

    fn program_reading(&mut self, source: &str, sent: &route::Built, fed: &[(route::Reach, Option<String>)]) -> Option<String> {
        let request = Request { method: sent.method.clone(), url: sent.url.clone(), exchange: 0, headers: sent.headers.clone(), body: sent.body.as_deref().map(unbrowse_route::wire::bytes_of) };
        // The program sees what its reads were fed and nothing else of the session, as it was held to the walks: the
        // cookies its feeds hand it, the stored keys, the browser's name; the rest of the sandbox's world is the bare one.
        crate::generated::compute_reading(source, &request, &[], &crate::generated::Environment::default(), fed)
    }

    /// A value the page keeps in its storage, as the node holds it at call time: the storage the walk's page left,
    /// kept beside the jar (`Fetch::stored`). The one path for a stored value at call time, whether a place sends it
    /// whole (`Expr::Stored`) or a program of the site's own reads it (a feed of `Expr::ProgramReading`).
    fn stored(&self, area: route::expr::Area, key: &str) -> Option<String> {
        self.fetch.stored(area, key)
    }
}

/// Whether a replay also builds each step's request the other way, and holds the two to each other: in this crate's
/// tests, and wherever `UNBROWSE_FILL_SHADOW` is set.
pub(crate) fn shadowing() -> bool {
    cfg!(test) || std::env::var_os("UNBROWSE_FILL_SHADOW").is_some()
}

/// The request the body made from `graph` builds for `step` on this call, the values made over the request written
/// into it (`route::start`, then `finish`). Where it stops, the request as far as it was built when it stopped, where
/// it got that far.
pub(crate) fn filled<F: Fetch + ?Sized>(
    graph: &Graph,
    step: &Step,
    inputs: &HashMap<String, String>,
    fetch: &F,
    responses: &HashMap<usize, Exchange>,
    fresh: &HashMap<String, String>,
    reading: Reading,
) -> Result<route::Built, (route::Stuck, Option<route::Built>)> {
    filled_from(&step_of(graph, step), graph, inputs, fetch, responses, fresh, reading)
}

/// [`filled`], for a body's own step: the request that step builds on this call, with `graph` the one the call
/// is run by (a body's [`skeleton`], or the graph the step was said from).
pub(crate) fn filled_from<F: Fetch + ?Sized>(
    body: &route::Step,
    graph: &Graph,
    inputs: &HashMap<String, String>,
    fetch: &F,
    responses: &HashMap<usize, Exchange>,
    fresh: &HashMap<String, String>,
    reading: Reading,
) -> Result<route::Built, (route::Stuck, Option<route::Built>)> {
    let mut world = Replaying { graph, inputs, fetch, responses, fresh, reading, chance: Box::new(reading.chance()) };
    let draft = route::start(body, &mut world).map_err(|stuck| (stuck, None))?;
    draft.finish_keeping(&mut world).map_err(|(stuck, built)| (stuck, Some(built)))
}

/// The rung a request the filler built was made at (`Built::rung`), as replay counts rungs.
pub(crate) fn rung_of(built: &route::Built) -> crate::rung::Rung {
    use crate::rung::Rung;
    match built.rung() {
        0 => Rung::Walk,
        1 => Rung::Expression,
        2 => Rung::Function,
        3 => Rung::Bundle,
        4 => Rung::Page,
        _ => Rung::Browser,
    }
}

/// What replay says when the body's filler stops at a step (`n`, 1-based): the error replay gives for that case, and
/// whether it is a value the page did not hand over, which replay steps past where nothing after reads it. `url` is
/// the request as far as it was built, where a value made over it was what failed.
pub(crate) fn refusal_of(stuck: &route::Stuck, n: usize, step: &Step, built: Option<&route::Built>) -> (ReplayError, bool) {
    use route::Why;
    let loc = || stuck.at.as_ref().map(loc_of).unwrap_or(Loc::Url);
    let url = || step.url.clone();
    match &stuck.why {
        Why::Slot(name) => (ReplayError::MissingInput(name.clone()), false),
        // A value of a field: what replay's fields would not have found either, and may step past.
        Why::Source { .. } | Why::Short => (ReplayError::SourceMissing { step: n, url: url(), loc: loc() }, true),
        // A list with a hole in it, as the body is written: replay says it the same way, and does not step past it.
        Why::Gap | Why::NotWrapped => (ReplayError::SourceMissing { step: n, url: url(), loc: loc() }, false),
        Why::File { slot, reason } => (ReplayError::File { input: slot.clone(), reason: reason.clone() }, false),
        Why::Needs(_) | Why::NotSent(_) | Why::Unbuilt => (ReplayError::NeedsBrowser { step: n, url: built.map(|b| b.url.to_string()).unwrap_or_else(url), loc: loc() }, false),
        Why::Body => (ReplayError::UnsupportedBody { step: n, url: url() }, false),
        Why::Breaks { part } => (ReplayError::BreaksBody { step: n, url: url(), part: part.clone() }, false),
        Why::BadUrl(why) => (ReplayError::BadUrl(why.clone()), false),
        Why::OtherOrigin { own, to } => (ReplayError::Transport(format!("an earlier answer handed {own} over to {to}, another origin: the node doesn't send it there")), false),
        // The caller's value is not a date, a time or a number in the form the route reads: nothing is sent, as the
        // site would be asked for another value than the caller's.
        Why::Unread(_) => (ReplayError::Refused(stuck.to_string()), false),
        // The caller's word is none the site's own table lists: no code to send, so nothing is sent.
        Why::NotListed(_) => (ReplayError::Refused(stuck.to_string()), false),
    }
}

#[cfg(test)]
thread_local! {
    /// How many requests, and how many refusals, this thread's replays were held to the filler on: a test reads it
    /// to say the comparison ran.
    pub(crate) static HELD: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}

/// Says a difference between replay and the filler: a failed test in this crate, a line in the log elsewhere.
fn differs(step: &Step, what: String) {
    let said = format!("the body's filler and replay differ at {} {}: {what}", step.method, step.url);
    if cfg!(test) {
        panic!("{said}");
    }
    eprintln!("   [fill] {said}");
}

/// Holds the body's filler and the graph's own builders to each other on one step, whichever of them sent: the same
/// finished request (its method, address, headers and body, the values made over it written in) at the same rung, or
/// the same refusal at the same place. `fields` is what the graph's builders made: the request and its rung, or the
/// error replay gives.
pub(crate) fn held_alike(step: &Step, filled: &Result<route::Built, (route::Stuck, Option<route::Built>)>, fields: Result<(&Request, crate::rung::Rung), &ReplayError>) {
    match (filled, fields) {
        (Ok(built), Ok((req, rung))) => {
            #[cfg(test)]
            HELD.with(|held| held.set((held.get().0 + 1, held.get().1)));
            if built.method != req.method {
                differs(step, format!("the method: {} against {}", built.method, req.method));
            }
            if built.url != req.url {
                differs(step, format!("the address: {} against {}", built.url, req.url));
            }
            if built.headers != req.headers {
                differs(step, format!("the headers: {:?} against {:?}", built.headers, req.headers));
            }
            if built.body.as_deref().map(str::as_bytes) != req.body.as_deref() {
                differs(step, format!("the body: {:?} against {:?}", built.body, req.text()));
            }
            if rung_of(built) != rung {
                differs(step, format!("the rung: {:?} against {rung:?}", rung_of(built)));
            }
        }
        (Err((stuck, _)), Ok(_)) => differs(step, format!("replay built a request, and the filler stopped ({stuck})")),
        (Ok(_), Err(refusal)) => differs(step, format!("replay stopped ({refusal}), and the filler built a request")),
        (Err((stuck, built)), Err(refusal)) => {
            #[cfg(test)]
            HELD.with(|held| held.set((held.get().0, held.get().1 + 1)));
            // The same kind of refusal, at the same place: replay's error for the filler's stop, read the same way.
            let (theirs, _) = refusal_of(stuck, 0, step, built.as_ref());
            // Where it stopped: the place, the caller's value, or the part of the body.
            let place = |e: &ReplayError| match e {
                ReplayError::SourceMissing { loc, .. } | ReplayError::NeedsBrowser { loc, .. } => Some(loc.to_string()),
                ReplayError::MissingInput(name) | ReplayError::File { input: name, .. } => Some(name.clone()),
                ReplayError::BreaksBody { part, .. } => Some(part.clone()),
                _ => None,
            };
            let same = std::mem::discriminant(&theirs) == std::mem::discriminant(refusal) && place(&theirs) == place(refusal);
            if !same {
                differs(step, format!("replay stopped ({refusal}), and the filler stopped for another reason ({stuck})"));
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::signing::compute_with;

    /// A world with a fixed clock and fixed chance, so a signature made twice is the same signature.
    struct Still;
    impl route::World for Still {
        fn slot(&self, _: &str) -> Option<String> {
            None
        }
        fn cookie(&self, _: &str) -> Option<String> {
            None
        }
        fn read(&self, _: &str, _: &route::At) -> Option<String> {
            None
        }
        fn answered(&self, _: &str) -> bool {
            false
        }
        fn fresh(&mut self, id: &str, _: route::Clock) -> String {
            id.to_string()
        }
        fn now_ms(&self) -> u64 {
            1_794_198_118_858
        }
        fn digits(&mut self, n: usize) -> String {
            "4".repeat(n)
        }
        fn file(&self, _: &str, _: route::FileFact) -> Result<String, String> {
            Err("no files".into())
        }
        fn same_site(&self, a: &str, b: &str) -> bool {
            a == b
        }
    }

    /// Every part a recipe may hold, as an expression: the digest the body makes over a request is the digest the
    /// recipe makes over it.
    #[test]
    fn a_recipe_as_an_expression_makes_the_recipes_own_value() {
        let request = Request {
            method: "post".into(),
            url: "https://air.example/api/search?from=sin&t=1794198116912".parse().unwrap(),
            exchange: 0,
            headers: vec![("cookie".into(), "GUID=0903410231; token=abc_1800; other=x".into())],
            body: Some(br#"{"to":"tyo"}"#.to_vec()),
        };
        let cookies = vec![("GUID".to_string(), "0903410231".to_string()), ("token".to_string(), "abc_1800".to_string()), ("other".to_string(), "x".to_string())];
        let built = route::Built { method: request.method.clone(), url: request.url.clone(), headers: request.headers.clone(), body: request.text().map(String::from), made: vec![] };
        for algo in [Algo::Md5, Algo::Sha1, Algo::Sha256] {
            for separator in [";", "&", ""] {
                let recipe = Recipe {
                    algo,
                    separator: separator.into(),
                    parts: vec![
                        Part::Path,
                        Part::Method,
                        Part::Body,
                        Part::Cookie { name: "GUID".into() },
                        Part::Constant { value: String::new() },
                        Part::Fresh { template: "-{ms}-{d7}-{s}".into() },
                        Part::Query { key: "t".into() },
                        Part::CookiePiece { name: "token".into(), separator: "_".into(), index: 0 },
                    ],
                };
                let theirs = compute_with(&recipe, &request, request.text(), &cookies, 1_794_198_118_858, |n| "4".repeat(n));
                let ours = recipe_expr(&recipe).eval(&mut route::expr::Cx { world: &mut Still, host: None, sent: Some(&built) });
                assert_eq!(ours.ok(), theirs.map(route::Outcome::Is), "{algo:?} joined by {separator:?}");
            }
        }
        // A part the request does not carry makes no value, for the recipe and for the expression alike.
        let recipe = Recipe { algo: Algo::Md5, separator: ";".into(), parts: vec![Part::Path, Part::Cookie { name: "absent".into() }] };
        assert_eq!(compute_with(&recipe, &request, None, &cookies, 0, |n| "4".repeat(n)), None);
        assert!(recipe_expr(&recipe).eval(&mut route::expr::Cx { world: &mut Still, host: None, sent: Some(&built) }).is_err());
    }

    /// What a value is written as is the same text from either side: the body's own writers are not a second
    /// reading of how a place writes a value.
    #[test]
    fn a_value_is_written_the_same_by_the_graph_and_by_the_body() {
        let values = ["desk lamp", "a\"b\\c", "été & co/über", "Tokyo", "", "x+y=z", "ｆｕｌｌ width"];
        for written in [Written::Plain, Written::Json, Written::Percent, Written::Plus, Written::Upper, Written::Lower, Written::Dashed] {
            for value in values {
                assert_eq!(how_of(written).write(value), written.write(value), "{written:?} of {value:?}");
            }
        }
        for wrap in [Wrap::Base64, Wrap::Base64NoPad, Wrap::Base64Url, Wrap::Base64UrlNoPad] {
            for value in values {
                let closed = wrap.close(value);
                assert_eq!(wrap_of(wrap).close(value), closed);
                assert_eq!(wrap_of(wrap).open(&closed), wrap.open(&closed));
            }
        }
        for (value, part, now) in [("the lamp and lamps", "lamp", "desk"), ("address dress", "dress", "coat"), ("t:lamp", "lamp", "x"), ("nothing here", "lamp", "x"), ("a.lamp.lamp", "lamp", "y")] {
            assert_eq!(route::expr::swapped(value, part, now), crate::graph::swapped(value, part, now), "{part} in {value}");
        }
    }

    /// A transport that answers every request with an empty reply, and holds a cookie for every name when `jar`.
    struct Empty {
        jar: bool,
    }
    impl Fetch for Empty {
        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status: 200,
                response_headers: vec![],
                response_body: Some("{}".into()),
                response_mime: "application/json".into(),
                resource_type: Some("XHR".into()),
                main_frame: None,
            })
        }
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }
        fn minted(&self, name: &str) -> Option<String> {
            self.jar.then(|| format!("held-{name}"))
        }
    }

    /// A search call a page's script made at `url`, as a walk holds it.
    fn searched(url: &str) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![("x-client".into(), "web".into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[{"name":"lamp"}]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        }
    }

    fn one_call() -> Graph {
        let search = searched("https://shop.example/api/search?q=lamp&n=10");
        crate::graph::build(&[crate::trace::Trace { exchanges: vec![search], inputs: vec![crate::trace::Input::new("q", "lamp")] }], |_| true).unwrap()
    }

    /// A transport that answers a request at a path it holds a reply for with that reply, and any other as [`Empty`]
    /// does, and keeps every request it is asked for, whole.
    #[derive(Default)]
    pub(crate) struct Kept {
        pub replies: HashMap<String, String>,
        pub jar: bool,
        pub sent: Vec<String>,
    }
    impl Fetch for Kept {
        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.sent.push(format!("{} {} {:?} {:?}", req.method, req.url, req.headers, req.text()));
            let mut reply = Empty { jar: self.jar }.fetch(req)?;
            if let Some(body) = self.replies.get(req.url.path()) {
                reply.response_body = Some(body.clone());
            }
            Ok(reply)
        }
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }
        fn minted(&self, name: &str) -> Option<String> {
            self.jar.then(|| format!("held-{name}"))
        }
    }

    /// A stored value at call time has one source, the node's storage beside the jar (`Fetch::stored`): a program of
    /// the site's own that reads the page's storage (`signed-reads`' seed) is fed from it, as a place that sends the
    /// stored value whole is, and never from the bare sandbox's environment.
    #[test]
    fn a_stored_value_at_call_time_is_read_from_the_nodes_storage_alone() {
        struct Stores;
        impl Fetch for Stores {
            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                Empty { jar: false }.fetch(req)
            }
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }
            fn stored(&self, area: route::expr::Area, key: &str) -> Option<String> {
                (area == route::expr::Area::Local && key == "seed").then(|| "sd-kept".to_string())
            }
            fn environment(&self) -> crate::generated::Environment {
                let mut env = crate::generated::Environment::default();
                env.storage.local.insert("seed".into(), "sd-environment".into());
                env
            }
        }
        let stored = || Expr::Stored { area: route::expr::Area::Local, key: "seed".into() };
        let mut holes = vec![a_hole(Place::Header("x-seed".into()), stored())];
        if crate::sandbox::runtime().is_some() {
            let source = "function sign(ctx) { return 'sig:' + (localStorage.getItem('seed') || ''); }".to_string();
            holes.push(a_hole(Place::Header("x-sig".into()), Expr::ProgramReading { source, reads: vec![route::Feed { read: route::Reach::Local("seed".into()), from: stored() }], evidence: None }));
        }
        let body = body_of(vec![script_step("x0", "/api/search", holes, &serde_json::json!({}))]);
        let graph = skeleton(&body);
        let built = filled_from(&body.steps[0], &graph, &asked("lamp"), &Stores, &HashMap::new(), &HashMap::new(), Reading::take()).expect("the step builds");
        let header = |name: &str| built.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        assert_eq!(header("x-seed").as_deref(), Some("sd-kept"), "a place that sends the stored value whole");
        if crate::sandbox::runtime().is_some() {
            assert_eq!(header("x-sig").as_deref(), Some("sig:sd-kept"), "a program that reads the storage is fed the node's storage");
        }
    }

    /// A script's GET at `path` of shop.example, answering as `answer` is shaped, with these holes.
    fn script_step(id: &str, path: &str, holes: Vec<route::Hole>, answer: &serde_json::Value) -> route::Step {
        route::Step { id: id.into(), method: "GET".into(), url: format!("https://shop.example{path}"), holes, body: None, expect: 200, script: Some(route::Caller { origin: None }), page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: Some(crate::graph::shape(answer)) }
    }

    fn a_hole(at: Place, expr: Expr) -> route::Hole {
        route::Hole { at, ways: vec![Way { rung: 0, expr }], over: false, open: false }
    }

    /// A body of these steps whose answer is the last, with the slot `q`.
    fn body_of(steps: Vec<route::Step>) -> route::Route {
        let slot = route::Slot { name: "q".into(), secret: false, example: None, choices: Vec::new() };
        route::Route { v: route::VERSION, tests: Vec::new(), plan: None, meaning: Default::default(), site: "shop.example".into(), slots: vec![slot], answer: route::Answer { step: steps.last().map(|s| s.id.clone()).unwrap_or_default(), page: false, decode: None }, steps }
    }

    fn asked(q: &str) -> HashMap<String, String> {
        HashMap::from([("q".to_string(), q.to_string())])
    }

    /// The word written with a plus for each space, then percent-encoded: a way no graph says.
    fn written_twice() -> Expr {
        Expr::Written { of: Box::new(Expr::Written { of: Box::new(Expr::Slot { name: "q".into(), or: Some("red lamp".into()), optional: false }), how: route::How::Plus }), how: route::How::Percent }
    }

    /// A graph's script step at `path` of shop.example, as exchange `n`, with these fields (JSON as a route file holds
    /// them).
    fn graph_step_at(n: usize, path: &str, fields: serde_json::Value, answer: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "exchange": n, "method": "GET", "status": 200, "url": format!("https://shop.example{path}"), "fields": fields, "needs_browser": false, "response_shape": crate::graph::shape(answer) })
    }

    fn the_graph(steps: Vec<serde_json::Value>) -> Graph {
        serde_json::from_value(serde_json::json!({ "provisional": false, "steps": steps })).unwrap()
    }

    fn query_input(key: &str, name: &str, default: &str) -> serde_json::Value {
        serde_json::json!({ "loc": { "in": "query", "key": key }, "class": "input", "name": name, "secret": false, "default": default })
    }

    fn sent_query(sent: &str, key: &str) -> Option<String> {
        let url: url::Url = sent.split(' ').nth(1)?.parse().ok()?;
        url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
    }

    /// A pass that opened an optional input on the graph after the body was written (the next page's handle) is in
    /// what runs: the overlay is the graph with the body's own hole laid over it, so a call for the next page sends the
    /// handle, and the word as the body writes it.
    #[test]
    fn a_slot_a_later_pass_opened_on_the_graph_is_sent_through_the_body() {
        let items = serde_json::json!({ "items": [{ "name": "red lamp" }] });
        let stored = body_of(vec![script_step("x0", "/api/search", vec![a_hole(Place::Query("q".into()), written_twice())], &items)]);
        let mut graph = the_graph(vec![graph_step_at(0, "/api/search?q={q}", serde_json::json!([query_input("q", "q", "red lamp")]), &items)]);
        crate::paging::place_optional(&mut graph.steps[0], &Loc::Query("page_handle".into()), "page_handle", None);
        let laid = overlay(&graph, Some(&stored));
        assert_eq!(laid.laid, vec![("x0".to_string(), Place::Query("q".into()))]);
        let mut site = Kept { replies: HashMap::from([("/api/search".to_string(), items.to_string())]), ..Kept::default() };
        let next = HashMap::from([("q".to_string(), "red lamp".to_string()), ("page_handle".to_string(), "after-6".to_string())]);
        crate::replay::replay_body(&laid.body, &next, &mut site).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(sent_query(&site.sent[0], "page_handle").as_deref(), Some("after-6"), "{}", site.sent[0]);
        assert_eq!(sent_query(&site.sent[0], "q").as_deref(), Some("red%2Blamp"));
        // The first page, asked without the handle, sends none.
        crate::replay::replay_body(&laid.body, &asked("red lamp"), &mut site).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(sent_query(&site.sent[1], "page_handle"), None, "{}", site.sent[1]);
    }

    /// A hole a graph cannot say is the stored body's in what runs; one a graph says is the graph's, whatever the
    /// body wrote there.
    #[test]
    fn a_hole_a_graph_cannot_say_survives_the_overlay() {
        let items = serde_json::json!({ "items": [{ "name": "red lamp" }] });
        let own = a_hole(Place::Query("lang".into()), Expr::text("de"));
        let stored = body_of(vec![script_step("x0", "/api/search", vec![a_hole(Place::Query("q".into()), written_twice()), own.clone()], &items)]);
        assert!(!a_graph_says(&stored, &stored.steps[0], &stored.steps[0].holes[0]) && a_graph_says(&stored, &stored.steps[0], &own));
        let graph = the_graph(vec![graph_step_at(0, "/api/search?q={q}&lang=en", serde_json::json!([query_input("q", "q", "red lamp"), { "loc": { "in": "query", "key": "lang" }, "class": "constant", "value": "en", "origin": null }]), &items)]);
        let laid = overlay(&graph, Some(&stored));
        let hole = |at: &str| laid.body.steps[0].holes.iter().find(|h| h.at == Place::Query(at.into())).cloned().unwrap();
        assert_eq!(hole("q"), stored.steps[0].holes[0], "the body's own way");
        assert_eq!(hole("lang").ways[0].expr, Expr::text("en"), "the graph's, as it stands");
        // A body whose every hole a graph says lays nothing: what runs is the graph's own.
        assert!(overlay(&graph, Some(&body_of(vec![script_step("x0", "/api/search", vec![own], &items)]))).laid.is_empty());
    }

    /// A step the graph reads as the page's to make only because it could not say one value (it reads that value as
    /// computed by the page's code) is the body's to make once the body says the value: plain, no browser. One the walk
    /// saw the page make whole is still the page's.
    #[test]
    fn a_step_the_page_made_only_for_a_value_the_body_says_is_the_bodys() {
        let items = serde_json::json!({ "items": [{ "name": "red lamp" }] });
        let stored = body_of(vec![script_step("x0", "/api/search", vec![a_hole(Place::Query("q".into()), written_twice())], &items)]);
        let computed = serde_json::json!([{ "loc": { "in": "query", "key": "q" }, "class": "computed" }]);
        let graph = the_graph(vec![graph_step_at(0, "/api/search?q={q}", computed.clone(), &items)]);
        assert!(graph.steps[0].is_page_signed() && from_graph(&graph, "shop.example").steps[0].page);
        let laid = overlay(&graph, Some(&stored));
        assert!(!laid.body.steps[0].page, "the body says the value the page was to make");
        let mut site = Kept { replies: HashMap::from([("/api/search".to_string(), items.to_string())]), ..Kept::default() };
        crate::replay::replay_body(&laid.body, &asked("red lamp"), &mut site).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(sent_query(&site.sent[0], "q").as_deref(), Some("red%2Blamp"));
        let mut whole = graph.clone();
        whole.steps[0].page_signed = true;
        assert!(overlay(&whole, Some(&stored)).body.steps[0].page, "a step the page makes whole stays the page's");
    }

    /// The two learners number a walk's calls each its own way (the classifier counts only the calls it keeps; the
    /// lab, every call of the walk): a stored step is the graph's step that makes the same call, whatever either names
    /// it, and what a laid hole reads is read from the graph's step that is the same call.
    #[test]
    fn a_step_is_known_by_the_call_it_makes_not_by_its_number() {
        let items = serde_json::json!({ "items": [{ "name": "red lamp" }] });
        let reads = Expr::Written { of: Box::new(Expr::Written { of: Box::new(Expr::Read { step: "x14".into(), at: route::At::Json { pointer: "/token".into() } }), how: route::How::Plus }), how: route::How::Percent };
        let token = script_step("x14", "/api/token", vec![], &serde_json::json!({ "token": "a b" }));
        let search = script_step("x15", "/api/search", vec![a_hole(Place::Query("q".into()), written_twice()), a_hole(Place::Header("x-token".into()), reads)], &items);
        let stored = body_of(vec![token, search]);
        let header = serde_json::json!({ "loc": { "in": "header", "key": "x-token" }, "class": "constant", "value": "a b", "origin": null });
        let graph = the_graph(vec![graph_step_at(0, "/api/token", serde_json::json!([]), &serde_json::json!({ "token": "a b" })), graph_step_at(1, "/api/search?q={q}", serde_json::json!([query_input("q", "q", "red lamp"), header]), &items)]);
        let laid = overlay(&graph, Some(&stored));
        assert_eq!(laid.laid, vec![("x1".to_string(), Place::Query("q".into())), ("x1".to_string(), Place::Header("x-token".into()))], "{:?}", laid.dropped);
        let mut site = Kept { replies: HashMap::from([("/api/token".to_string(), r#"{"token":"a b"}"#.to_string()), ("/api/search".to_string(), items.to_string())]), ..Kept::default() };
        crate::replay::replay_body(&laid.body, &asked("red lamp"), &mut site).unwrap_or_else(|e| panic!("{e}"));
        assert!(site.sent[1].contains(r#""x-token", "a%2Bb""#), "read from the graph's step that is the same call: {}", site.sent[1]);
    }

    /// A step a shorter chain cut from the graph is not run, whatever the body said of it, and a hole of the body
    /// that read it has nothing to read and is dropped, said; the call's own hole a graph cannot say still runs.
    #[test]
    fn a_step_a_shorter_chain_cut_is_not_run() {
        let items = serde_json::json!({ "items": [{ "name": "red lamp" }] });
        let token = script_step("x0", "/api/token", vec![a_hole(Place::Query("q".into()), written_twice())], &serde_json::json!({ "token": "t" }));
        let reads = Expr::Written { of: Box::new(Expr::Written { of: Box::new(Expr::Read { step: "x0".into(), at: route::At::Json { pointer: "/token".into() } }), how: route::How::Plus }), how: route::How::Percent };
        let search = script_step("x1", "/api/search", vec![a_hole(Place::Query("q".into()), written_twice()), a_hole(Place::Header("x-token".into()), reads)], &items);
        let stored = body_of(vec![token, search]);
        let graph = the_graph(vec![graph_step_at(1, "/api/search?q={q}", serde_json::json!([query_input("q", "q", "red lamp"), { "loc": { "in": "header", "key": "x-token" }, "class": "constant", "value": "t", "origin": null }]), &items)]);
        let laid = overlay(&graph, Some(&stored));
        assert_eq!(laid.body.steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["x1"]);
        assert_eq!(laid.laid, vec![("x1".to_string(), Place::Query("q".into()))]);
        assert_eq!(laid.dropped.len(), 2, "{:?}", laid.dropped);
        assert!(laid.dropped.iter().any(|d| d.contains("no such call")) && laid.dropped.iter().any(|d| d.contains("reads step x0")), "{:?}", laid.dropped);
        let mut site = Kept { replies: HashMap::from([("/api/search".to_string(), items.to_string())]), ..Kept::default() };
        crate::replay::replay_body(&laid.body, &asked("red lamp"), &mut site).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(site.sent.len(), 1);
        assert!(site.sent[0].contains("/api/search") && site.sent[0].contains(r#""x-token", "t""#), "{}", site.sent[0]);
    }

    /// A header a pass moved to the jar after the body was written (the page's token, which the graph names and the
    /// jar keeps) is read from the jar in what runs, where the body had kept the walk's value as its own text.
    #[test]
    fn a_header_moved_to_the_jar_is_read_from_the_jar() {
        let items = serde_json::json!({ "items": [{ "name": "red lamp" }] });
        let walked = a_hole(Place::Header("authorization".into()), Expr::text("Bearer tok_5f4e3d2c1b0a"));
        let stored = body_of(vec![script_step("x0", "/api/search", vec![a_hole(Place::Query("q".into()), written_twice()), walked], &items)]);
        let graph = the_graph(vec![graph_step_at(0, "/api/search?q={q}", serde_json::json!([query_input("q", "q", "red lamp"), { "loc": { "in": "header", "key": "authorization" }, "class": "minted", "name": "authorization" }]), &items)]);
        let laid = overlay(&graph, Some(&stored));
        let mut site = Kept { replies: HashMap::from([("/api/search".to_string(), items.to_string())]), jar: true, ..Kept::default() };
        crate::replay::replay_body(&laid.body, &asked("red lamp"), &mut site).unwrap_or_else(|e| panic!("{e}"));
        assert!(site.sent[0].contains(r#""authorization", "held-authorization""#) && !site.sent[0].contains("tok_5f4e3d2c1b0a"), "{}", site.sent[0]);
        assert_eq!(sent_query(&site.sent[0], "q").as_deref(), Some("red%2Blamp"));
    }

    /// A word the page writes one way and then another (a plus for each space, then the whole percent-encoded, as a
    /// search box hands its word to an address that encodes it again) is sent written so. No graph says such a
    /// value, and the body runs all the same.
    #[test]
    fn a_body_sends_a_value_written_one_way_after_another_as_written() {
        let items = serde_json::json!({"items": [{"name": "red lamp"}]});
        let twice = Expr::Written { of: Box::new(Expr::Written { of: Box::new(Expr::Slot { name: "q".into(), or: None, optional: false }), how: route::How::Plus }), how: route::How::Percent };
        let body = body_of(vec![script_step("x0", "/api/search", vec![a_hole(Place::Query("q".into()), twice)], &items)]);
        assert!(to_graph(&body).is_err(), "a graph says no value written twice over");
        let mut site = Kept { replies: HashMap::from([("/api/search".to_string(), items.to_string())]), ..Kept::default() };
        let called = crate::replay::replay_body(&body, &asked("red lamp"), &mut site).unwrap_or_else(|e| panic!("{e}"));
        let sent: url::Url = called.steps[0].0.parse().unwrap();
        assert_eq!(sent.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).as_deref(), Some("red%2Blamp"));
        assert_eq!(called.rungs, vec![crate::rung::Rung::Walk]);
    }

    /// A value picked from an earlier answer's list is the value of the item that fits the caller's word: asked for
    /// another word, another item's.
    #[test]
    fn a_body_sends_the_value_of_the_item_its_pick_finds() {
        let list = serde_json::json!({"items": [{"name": "desk", "id": "d1"}, {"name": "lamp", "id": "l2"}]});
        let item = serde_json::json!({"item": {"id": "l2"}});
        let pick = Expr::Pick { step: "x0".into(), list: "/items".into(), fits: route::Fits::Equals { at: "/name".into(), is: Box::new(Expr::Slot { name: "q".into(), or: None, optional: false }) }, take: "/id".into() };
        let body = body_of(vec![script_step("x0", "/api/list", vec![], &list), script_step("x1", "/api/item", vec![a_hole(Place::Query("id".into()), pick)], &item)]);
        assert!(to_graph(&body).is_err(), "a graph says no pick");
        for (word, id) in [("lamp", "l2"), ("desk", "d1")] {
            let mut site = Kept { replies: HashMap::from([("/api/list".to_string(), list.to_string()), ("/api/item".to_string(), item.to_string())]), ..Kept::default() };
            let called = crate::replay::replay_body(&body, &asked(word), &mut site).unwrap_or_else(|e| panic!("{e}"));
            assert_eq!(called.steps.len(), 2);
            assert!(called.steps[1].0.ends_with(&format!("/api/item?id={id}")), "{word}: {}", called.steps[1].0);
        }
        // A word no item fits finds nothing to send, and says so as replay says a value an answer did not hold.
        let mut site = Kept { replies: HashMap::from([("/api/list".to_string(), list.to_string())]), ..Kept::default() };
        assert!(matches!(crate::replay::replay_body(&body, &asked("chair"), &mut site), Err(ReplayError::SourceMissing { step: 2, .. })));
    }

    /// A step nothing after it reads is stepped past by a body as by the graph it says: one the page sent by itself as
    /// it loaded, and one whose value an earlier answer did not hand over. The same requests go out either way.
    #[test]
    fn a_step_nothing_reads_is_stepped_past_by_a_body_as_by_its_graph() {
        let items = serde_json::json!({"items": [{"name": "lamp"}]});
        let mut banner = script_step("x0", "/api/banner", vec![], &serde_json::json!({"text": "sale"}));
        banner.on_load = true;
        let token = script_step("x1", "/api/session", vec![], &serde_json::json!({"token": "t"}));
        let reads = a_hole(Place::Header("x-token".into()), Expr::Read { step: "x1".into(), at: route::At::Json { pointer: "/token".into() } });
        let unread = script_step("x2", "/api/track", vec![reads], &serde_json::json!({"ok": true}));
        let search = script_step("x3", "/api/search", vec![a_hole(Place::Query("q".into()), Expr::Slot { name: "q".into(), or: Some("lamp".into()), optional: false })], &items);
        let body = body_of(vec![banner, token, unread, search]);
        let graph = to_graph(&body).unwrap_or_else(|unsaid| panic!("{unsaid}"));
        // The session's answer holds no token: the track step has nothing to send, and nothing after reads it.
        let replies = HashMap::from([("/api/session".to_string(), "{}".to_string()), ("/api/search".to_string(), items.to_string())]);
        let mut by_body = Kept { replies: replies.clone(), ..Kept::default() };
        let mut by_graph = Kept { replies, ..Kept::default() };
        let called = crate::replay::replay_body(&body, &asked("desk"), &mut by_body).unwrap_or_else(|e| panic!("{e}"));
        crate::replay::replay(&graph, &asked("desk"), &mut by_graph).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(by_body.sent, by_graph.sent);
        let paths: Vec<String> = called.steps.iter().map(|(u, _)| url::Url::parse(u).unwrap().path().to_string()).collect();
        assert_eq!(paths, ["/api/session", "/api/search"]);
    }

    /// A value an earlier answer was to hand over and did not stops the call where replay stops it, with replay's
    /// own error: the step, its address, the place.
    #[test]
    fn a_reply_value_a_body_does_not_find_fails_as_replay_fails() {
        let token = script_step("x0", "/api/session", vec![], &serde_json::json!({"token": "t"}));
        let reads = a_hole(Place::Header("x-token".into()), Expr::Read { step: "x0".into(), at: route::At::Json { pointer: "/token".into() } });
        let search = script_step("x1", "/api/search", vec![reads, a_hole(Place::Query("q".into()), Expr::Slot { name: "q".into(), or: Some("lamp".into()), optional: false })], &serde_json::json!({"items": []}));
        let body = body_of(vec![token, search]);
        let graph = to_graph(&body).unwrap_or_else(|unsaid| panic!("{unsaid}"));
        let ours = crate::replay::replay_body(&body, &asked("desk"), &mut Kept::default()).map(|_| ()).unwrap_err();
        let theirs = crate::replay::replay(&graph, &asked("desk"), &mut Kept::default()).map(|_| ()).unwrap_err();
        assert!(matches!(&ours, ReplayError::SourceMissing { step: 2, loc: Loc::Header(name), .. } if name == "x-token"), "{ours}");
        assert_eq!(ours.to_string(), theirs.to_string());
    }

    /// A transport that keeps the address of every request it is asked for.
    #[derive(Default)]
    struct Asked(Vec<url::Url>);
    impl Fetch for Asked {
        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.0.push(req.url.clone());
            Empty { jar: false }.fetch(req)
        }
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }
    }

    /// A caller's word that the walked value already says somewhere else (a key of the JSON it rides in) is still
    /// written where the walk's word stood: asked for `query`, the call searches for `query`, and not for the
    /// walk's word again. The replay and the body's filler agree on it, as on every request.
    #[test]
    fn a_callers_word_the_walked_value_says_elsewhere_is_still_written_where_the_walks_stood() {
        let variables = r#"{"query":"gaza","start":1}"#;
        let page = Exchange { url: "https://www.news.example/search/gaza".parse().unwrap(), response_body: Some("<html></html>".into()), response_mime: "text/html".into(), resource_type: Some("Document".into()), ..searched("https://www.news.example/") };
        let call = searched(&format!("https://www.news.example/graphql?operationName=SearchQuery&variables={}", url::form_urlencoded::byte_serialize(variables.as_bytes()).collect::<String>()));
        let graph = crate::graph::build(&[crate::trace::Trace { exchanges: vec![page, call], inputs: vec![crate::trace::Input::new("q", "gaza")] }], |e| e.url.path() == "/graphql").unwrap();
        assert!(graph.steps.last().unwrap().held.iter().any(|h| h.input == "q" && h.sits == "gaza"), "the word rides inside the JSON: {:?}", graph.steps.last().unwrap().held);
        let sent = |word: &str| {
            let mut asked = Asked::default();
            let _ = crate::replay::replay(&graph, &HashMap::from([("q".to_string(), word.to_string())]), &mut asked);
            let call = asked.0.iter().find(|u| u.path() == "/graphql").expect("the call was made").clone();
            call.query_pairs().find(|(k, _)| k == "variables").map(|(_, v)| v.into_owned()).unwrap_or_default()
        };
        assert_eq!(sent("syria"), r#"{"query":"syria","start":1}"#);
        assert_eq!(sent("query"), r#"{"query":"query","start":1}"#, "a word the walked value says as its own key");
        assert_eq!(sent("start"), r#"{"query":"start","start":1}"#);
    }

    /// An id the page draws at random on each visit (written as a UUID is) is made up afresh for every call, and the
    /// same in every step of one call, whichever builder sends: a graph says it as a fresh id of no clock, and the
    /// body as the same.
    #[test]
    fn an_id_drawn_at_random_is_made_up_afresh_by_the_body_as_by_the_graph() {
        let mut graph = one_call();
        let step = graph.steps.last_mut().unwrap();
        let walked = "080dbce1-3f6b-4a45-b181-2c6c26f285ca";
        step.url = format!("{}&sessionId={{query[sessionId]}}", step.url);
        step.fields.push(crate::graph::Field { loc: Loc::Query("sessionId".into()), class: Class::Fresh { value: walked.into(), id: walked.into(), clock: crate::fresh::Clock::Random } });
        let body = from_graph(&graph, "shop.example");
        let way = &body.steps[0].holes.iter().find(|h| h.at == route::Place::Query("sessionId".into())).unwrap().ways[0].expr;
        assert_eq!(way, &Expr::Join { parts: vec![Expr::Fresh { id: walked.into(), clock: route::Clock::Random }], with: String::new() });
        let sent = |fill_body: bool| {
            let mut asked = Asked::default();
            let _ = crate::replay::replay_by(&graph, &HashMap::from([("q".to_string(), "desk".to_string())]), &mut asked, fill_body);
            asked.0.iter().find(|u| u.path() == "/api/search").and_then(|u| u.query_pairs().find(|(k, _)| k == "sessionId").map(|(_, v)| v.into_owned())).expect("the call sends an id")
        };
        for fill_body in [false, true] {
            let id = sent(fill_body);
            assert!(crate::fresh::a_random_id(&id) && id != walked, "a new id drawn for the call, not the walk's: {id}");
        }
        assert_eq!(to_graph(&body).map(|g| g.steps[0].fields.iter().any(|f| matches!(f.class, Class::Fresh { clock: crate::fresh::Clock::Random, .. }))).ok(), Some(true), "said back as the graph's own");
        // Inside a longer value, as a graph's fresh id is when the page wraps it: said as a join, said back the same.
        let step = graph.steps.last_mut().unwrap();
        step.fields.retain(|f| f.loc != Loc::Query("sessionId".into()));
        step.fields.push(crate::graph::Field { loc: Loc::Query("sessionId".into()), class: Class::Fresh { value: format!("s:{walked}:web"), id: walked.into(), clock: crate::fresh::Clock::Random } });
        let back = to_graph(&from_graph(&graph, "shop.example")).expect("a fresh id in a longer value is said back");
        let field = back.steps[0].fields.iter().find(|f| f.loc == Loc::Query("sessionId".into())).unwrap();
        assert_eq!(field.class, Class::Fresh { value: format!("s:{walked}:web"), id: walked.into(), clock: crate::fresh::Clock::Random });
    }

    /// The comparison is live in this crate's tests: a replay here is a request the filler was held to.
    #[test]
    fn a_replay_in_this_crates_tests_is_held_to_the_filler() {
        let graph = one_call();
        let before = HELD.with(|held| held.get());
        let inputs = HashMap::from([("q".to_string(), "desk".to_string())]);
        let _ = crate::replay::replay(&graph, &inputs, &mut Empty { jar: false });
        assert_eq!(HELD.with(|held| held.get()).0, before.0 + 1);
    }

    /// And a difference fails the test it shows in.
    #[test]
    #[should_panic(expected = "differ at GET")]
    fn a_request_the_filler_builds_otherwise_fails_the_test() {
        let graph = one_call();
        let step = &graph.steps[0];
        let theirs = Request { method: "GET".into(), url: "https://shop.example/api/search?q=desk&n=10".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let ours = route::Built { method: "GET".into(), url: "https://shop.example/api/search?q=lamp&n=10".parse().unwrap(), headers: vec![], body: None, made: vec![] };
        held_alike(step, &Ok(ours), Ok((&theirs, crate::rung::Rung::Walk)));
    }

    /// A graph said as a body and read back is the same body, and names what the graph names.
    #[test]
    fn a_graph_as_a_body_asks_for_what_the_graph_asks_for() {
        let body = from_graph(&one_call(), "shop.example");
        assert_eq!(body.refused(), None);
        assert_eq!(body.asked(), ["q"]);
        assert_eq!(body.slots[0].example.as_deref(), Some("lamp"));
        assert_eq!(body.answer.step, body.steps[0].id);
        let written = serde_json::to_string(&body).unwrap();
        assert_eq!(serde_json::from_str::<route::Route>(&written).unwrap(), body);
    }

    /// A world a test fills a body in: the caller's values, the jar, the replies so far by step, and a clock that
    /// reads the same for a stamp and for a fresh id, so the two can be held to each other.
    pub(crate) struct Hand<'a> {
        pub slots: HashMap<String, String>,
        pub jar: HashMap<String, String>,
        pub replies: HashMap<String, &'a Exchange>,
        pub now: u64,
    }
    impl route::World for Hand<'_> {
        fn slot(&self, name: &str) -> Option<String> {
            self.slots.get(name).cloned()
        }
        fn cookie(&self, name: &str) -> Option<String> {
            self.jar.get(name).cloned()
        }
        fn read(&self, step: &str, at: &route::At) -> Option<String> {
            crate::provenance::extract(self.replies.get(step)?, &at_back(at))
        }
        fn list(&self, step: &str, pointer: &str) -> Option<Vec<serde_json::Value>> {
            self.replies.get(step)?.own_json()?.pointer(pointer)?.as_array().cloned()
        }
        fn answered(&self, step: &str) -> bool {
            self.replies.contains_key(step)
        }
        fn fresh(&mut self, _: &str, clock: route::Clock) -> String {
            match clock {
                route::Clock::Millis => self.now.to_string(),
                route::Clock::Seconds => (self.now / 1000).to_string(),
                route::Clock::Random => "080dbce1-3f6b-4a45-b181-2c6c26f285ca".to_string(),
            }
        }
        fn now_ms(&self) -> u64 {
            self.now
        }
        fn digits(&mut self, n: usize) -> String {
            "0".repeat(n)
        }
        fn file(&self, _: &str, _: route::FileFact) -> Result<String, String> {
            Err("no files".into())
        }
        fn same_site(&self, a: &str, b: &str) -> bool {
            let site = |origin: &str| url::Url::parse(origin).ok().and_then(|u| u.host_str().map(crate::identity::site_of));
            site(a).is_some() && site(a) == site(b)
        }
    }

    /// The steps of `body` (up to `upto` of them) that fill otherwise than the same step of the body `graph` says
    /// (`from_graph`), in `world`: each with both requests, or the reasons they could not be built.
    pub(crate) fn differs(body: &route::Route, graph: &Graph, world: &mut Hand, upto: usize) -> Vec<String> {
        let back = from_graph(graph, &body.site);
        if back.steps.len() != body.steps.len() {
            return vec![format!("{} steps against {}", back.steps.len(), body.steps.len())];
        }
        let mut out = Vec::new();
        for (ours, theirs) in body.steps.iter().zip(&back.steps).take(upto) {
            let (a, b) = (route::request(ours, world), route::request(theirs, world));
            if a != b {
                out.push(format!("step {}: {a:?} against {b:?}", ours.id));
            }
        }
        out
    }

    /// Each step of `body` and of the body its graph says (`from_graph(to_graph(body))`), filled in each world: the
    /// same request, or the same reason it cannot be built.
    pub(crate) fn fills_alike(body: &route::Route, worlds: &mut [Hand]) {
        let graph = to_graph(body).unwrap_or_else(|unsaid| panic!("{unsaid}"));
        for world in worlds.iter_mut() {
            let differ = differs(body, &graph, world, usize::MAX);
            assert!(differ.is_empty(), "for {:?}: {differ:?}", world.slots);
        }
    }

    /// Two walks of a page whose search the lab learns with every kind of way it writes: a read of an earlier reply,
    /// the word in the path, the query, the body and a referer, written in capitals, packed and encoded, a piece of
    /// another value, a cookie and a value that is one, a reading of the clock, a fixed text and an open one.
    fn every_way(word: &str, token: &str, ms: &str, trace_id: &str, date: &str) -> crate::trace::Trace {
        use crate::lab::sighting::tests::{call, trace};
        let packed = Wrap::Base64.close(&format!(r#"{{"query":"{word}","rows":24}}"#));
        let address = url::Url::parse_with_params(&format!("https://shop.example/api/find/{word}/all"), &[("q", word), ("code", &word.to_uppercase()), ("date", date), ("size", "20"), ("_", ms), ("s", &packed)]).unwrap();
        let referer = format!("https://shop.example/search?q={word}&from=home");
        trace(vec![
            call("GET", "https://shop.example/api/session", &[], None, &format!(r#"{{"token":"{token}"}}"#)),
            call(
                "POST",
                address.as_str(),
                &[("x-token", token), ("x-trace-id", trace_id), ("referer", &referer), ("content-type", "application/json"), ("cookie", "csrf=9d8c7b6a5f4e; sid=s%3Aabc"), ("x-csrf-token", "9d8c7b6a5f4e")],
                Some(&format!(r#"{{"term":"{word}","page":1,"exact":false}}"#)),
                r#"{"items":[{"name":"one"}]}"#,
            ),
        ])
    }

    fn hand<'a>(word: &str, when: &str, replies: &[(&str, &'a Exchange)]) -> Hand<'a> {
        Hand {
            slots: HashMap::from([("q".to_string(), word.to_string()), ("when".to_string(), when.to_string())]),
            jar: HashMap::from([("csrf".to_string(), "9d8c7b6a5f4e".to_string()), ("sid".to_string(), "s%3Aabc".to_string())]),
            replies: replies.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            now: 1_794_398_400_000,
        }
    }

    /// A body the lab learns, said as a graph and back, fills as the body does, for each walk's values and for a word
    /// neither walk asked: every kind of way the lab writes has a class of a graph's field that means the same.
    #[test]
    fn a_learned_body_said_as_a_graph_fills_as_the_body_does() {
        use crate::lab::sighting::tests::walk;
        use crate::lab::{compile, synth::Lab};
        let (first, second) = (every_way("lamp", "tok_9f8e7d6c5b", "1794398399120", "7f3a9c21e5b84d06", "2027-03-09"), every_way("sofa", "tok_1a2b3c4d5e", "1794398401877", "c40e18b72a9d5f63", "2027-04-17"));
        let walks = [walk(&first, &[("q", "lamp"), ("when", "2027-03-09T20:30:00")]), walk(&second, &[("q", "sofa"), ("when", "2027-04-17T18:00:00")])];
        let body = compile::route(&Lab::new(&walks), 1, "shop.example").unwrap();
        let graph = to_graph(&body).unwrap_or_else(|unsaid| panic!("{unsaid}"));
        // Each kind of way, as the class of field that means the same.
        let class = |loc: Loc| graph.steps[1].fields.iter().find(|f| f.loc == loc).map(|f| f.class.clone()).unwrap_or_else(|| panic!("no field at {loc:?}"));
        assert!(matches!(class(Loc::Path(2)), Class::Input { name, .. } if name == "q"));
        assert!(matches!(class(Loc::Json("/term".into())), Class::Input { .. }));
        assert!(matches!(class(Loc::Query("date".into())), Class::Piece { from: 0, len: 10, .. }));
        assert!(matches!(class(Loc::Query("_".into())), Class::Fresh { clock: crate::fresh::Clock::Millis, .. }));
        assert!(matches!(class(Loc::Query("size".into())), Class::Constant { value, .. } if value == "20"));
        assert!(matches!(class(Loc::Header("x-token".into())), Class::Derived { origin } if origin.exchange == 0));
        assert!(matches!(class(Loc::Header("x-trace-id".into())), Class::Unconfirmed { .. }));
        assert!(matches!(class(Loc::Header("x-csrf-token".into())), Class::Minted { name } if name == "csrf"));
        assert!(matches!(class(Loc::Cookie("sid".into())), Class::Minted { .. }));
        let held: Vec<(Loc, Written, Option<Wrap>)> = graph.steps[1].held.iter().map(|h| (h.loc.clone(), h.written, h.inside)).collect();
        assert!(held.contains(&(Loc::Query("code".into()), Written::Upper, None)), "{held:?}");
        assert!(held.contains(&(Loc::Query("s".into()), Written::Plain, Some(Wrap::Base64))), "{held:?}");
        assert!(held.contains(&(Loc::Header("referer".into()), Written::Plain, None)), "{held:?}");
        assert!(graph.provisional, "an open place is an unconfirmed field");
        assert_eq!(graph.page_origin.as_deref(), Some("https://shop.example"));
        let (one, two) = (&first.exchanges[0], &second.exchanges[0]);
        fills_alike(&body, &mut [hand("lamp", "2027-03-09T20:30:00", &[("x0", one)]), hand("sofa", "2027-04-17T18:00:00", &[("x0", two)]), hand("chair", "2027-05-01T12:00:00", &[("x0", two)])]);
        // A step that cannot be built cannot be built either way, for the same reason.
        fills_alike(&body, &mut [hand("lamp", "2027", &[("x0", one)]), hand("lamp", "2027-03-09T20:30:00", &[])]);
    }

    /// A digest over parts of the request is a graph's recipe, and fills as the body's expression does.
    #[test]
    fn a_digest_said_as_a_recipe_fills_as_the_body_does() {
        use crate::lab::sighting::tests::{trace, walk};
        use crate::lab::synth::tests::signed;
        use crate::lab::{compile, synth::Lab};
        let (first, second) = (trace(vec![signed("lamps", "1794398399120", "Desk lamp")]), trace(vec![signed("kettles", "1794398401877", "Steel kettle")]));
        let walks = [walk(&first, &[("q", "lamps")]), walk(&second, &[("q", "kettles")])];
        let body = compile::route(&Lab::new(&walks), 0, "shop.example").unwrap();
        let graph = to_graph(&body).unwrap_or_else(|unsaid| panic!("{unsaid}"));
        assert!(graph.steps[0].fields.iter().any(|f| f.loc == Loc::Query("sign".into()) && matches!(&f.class, Class::Recipe { recipe } if recipe.parts.len() == 4)));
        let jar = HashMap::from([("_tk".to_string(), "5f3a9c21e4d7b8a6_1794402700000".to_string())]);
        let world = |word: &str| Hand { slots: HashMap::from([("q".to_string(), word.to_string())]), jar: jar.clone(), replies: HashMap::new(), now: 1_794_402_699_999 };
        fills_alike(&body, &mut [world("lamps"), world("kettles"), world("sofas")]);
    }

    /// A page the browser went to, answered by the state it embeds, is said as a graph that asks it for as a page:
    /// marked `visited`, though its reply holds JSON. Said back as a body it is still asked for as a page, and it
    /// fills as the body does; with the mark gone, the same graph would ask it as a script's call.
    #[test]
    fn a_page_the_browser_went_to_is_said_as_a_graph_that_asks_it_for_as_a_page() {
        let page = route::Step {
            id: "x0".into(),
            method: "GET".into(),
            url: "https://www.stays.example/searchresults.html".into(),
            holes: vec![route::Hole { at: Place::Query("ss".into()), ways: vec![Way { rung: 0, expr: Expr::Slot { name: "ss".into(), or: Some("Lisbon".into()), optional: false } }], over: false, open: false }],
            body: None,
            expect: 200,
            script: None,
            page: false,
            writes: false,
            on_load: false,
            sets_cookie: false,
            lifetime: None,
            shape: Some(serde_json::json!({ "results": [{ "name": "string" }] })),
        };
        let body = route::Route { v: route::VERSION, tests: Vec::new(), plan: None, meaning: Default::default(), site: "stays.example".into(), slots: vec![], steps: vec![page], answer: route::Answer { step: "x0".into(), page: false, decode: None } };
        let graph = to_graph(&body).unwrap_or_else(|unsaid| panic!("{unsaid}"));
        assert_eq!(graph.visited, [0]);
        assert!(graph.asks_as_a_page(&graph.steps[0]));
        assert_eq!(from_graph(&graph, "stays.example").steps[0].script, None);
        let world = |city: &str| Hand { slots: HashMap::from([("ss".to_string(), city.to_string())]), jar: HashMap::new(), replies: HashMap::new(), now: 0 };
        fills_alike(&body, &mut [world("Lisbon"), world("Porto")]);
        let unmarked = Graph { visited: Vec::new(), ..graph };
        assert!(!unmarked.asks_as_a_page(&unmarked.steps[0]), "unmarked, a step whose reply holds JSON is a script's call");
    }

    /// A step the page sent by itself as it loaded only asks, though its address says nothing of asking: the body
    /// keeps that it was, and whether its answer set a cookie, and the graph said back from the body is read by the
    /// ledger's rule as the first was.
    #[test]
    fn a_step_the_page_sent_as_it_loaded_reads_the_same_to_the_ledger_both_ways() {
        let graph = |sets_cookie: bool| -> Graph {
            serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [{ "exchange": 13, "method": "POST", "status": 200, "url": "https://shop.example/sch/ajax/images", "needs_browser": false, "response_shape": { "items": "array" }, "on_load": true, "sets_cookie": sets_cookie, "body": { "kind": "json", "template": { "size": 20 }, "types": {} }, "fields": [] }] })).unwrap()
        };
        let first = graph(false);
        assert!(!crate::ledger::writes(&first.steps[0]), "sent as the page loaded, it only asks");
        let body = from_graph(&first, "shop.example");
        assert_eq!((body.steps[0].on_load, body.steps[0].writes), (true, false));
        let back = to_graph(&body).unwrap_or_else(|unsaid| panic!("{unsaid}"));
        assert!(back.steps[0].on_load && !crate::ledger::writes(&back.steps[0]), "read by the ledger as the first graph was");
        // One whose answer set a cookie may write, and its body keeps that it did: said back, it is still one.
        let cookie = graph(true);
        assert!(crate::ledger::writes(&cookie.steps[0]));
        let back = to_graph(&from_graph(&cookie, "shop.example")).unwrap_or_else(|unsaid| panic!("{unsaid}"));
        assert!(back.steps[0].sets_cookie && crate::ledger::writes(&back.steps[0]));
    }

    /// A classifier's graph marks no page as gone to: its steps are asked as they always were, and the graph it
    /// writes is the same bytes, with no mark in them.
    #[test]
    fn a_classifiers_step_is_asked_as_it_was() {
        let graph = one_call();
        assert!(graph.visited.is_empty());
        assert!(!serde_json::to_string(&graph).unwrap().contains("visited"));
        assert_eq!(graph.asks_as_a_page(&graph.steps[0]), graph.steps[0].reads_page || graph.steps[0].response_shape.is_none());
    }

    /// Where a body says something a graph cannot, the graph is not written and the place and the reason are said:
    /// two ways that are not a fallback a graph applies, a word a graph would also put where the body keeps the
    /// walk's text, a way no class means, a word the caller may leave out of a longer value, a read a graph falls
    /// back from where the body stops, a page answered by the state it embeds, and an answer that is not the last step.
    #[test]
    fn a_body_a_graph_cannot_say_is_refused_with_the_place_and_why() {
        let slot = |or: &str| Expr::Slot { name: "q".into(), or: Some(or.into()), optional: false };
        let hole = |at: Place, ways: Vec<Expr>| route::Hole { at, ways: ways.into_iter().map(|expr| Way { rung: 0, expr }).collect(), over: false, open: false };
        let step = |id: &str, holes: Vec<route::Hole>| route::Step { id: id.into(), method: "GET".into(), url: "https://shop.example/api/search".into(), holes, body: None, expect: 200, script: Some(route::Caller { origin: None }), page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: Some(serde_json::json!({"items": "array"})) };
        let body = |steps: Vec<route::Step>| route::Route { v: route::VERSION, tests: Vec::new(), plan: None, meaning: Default::default(), site: "shop.example".into(), slots: vec![], answer: route::Answer { step: steps.last().map(|s| s.id.clone()).unwrap_or_default(), page: false, decode: None }, steps };
        let why = |b: route::Route| to_graph(&b).map(|_| ()).unwrap_err();
        let at = |e: Unsaid| (e.at, e.why);
        let q = || Place::Query("q".into());
        assert_eq!(at(why(body(vec![step("x1", vec![hole(q(), vec![slot("lamp"), Expr::text("lamp")])])]))), (Some(q()), "a graph's field fills this place another way than the body does"));
        let twice = Expr::Join { parts: vec![Expr::text("lamp: "), slot("lamp")], with: String::new() };
        assert_eq!(at(why(body(vec![step("x1", vec![hole(q(), vec![twice])])]))).1, "the caller's word, as the walk wrote it, stands elsewhere in the value too, and a graph would put the new word there as well");
        assert_eq!(at(why(body(vec![step("x1", vec![hole(q(), vec![Expr::Stored { area: route::expr::Area::Local, key: "k".into() }])])]))).1, "no class of a graph's field fills a place this way");
        let optional = Expr::Join { parts: vec![Expr::text("in:"), Expr::Slot { name: "q".into(), or: Some("lamp".into()), optional: true }], with: String::new() };
        assert_eq!(at(why(body(vec![step("x1", vec![hole(q(), vec![optional])])]))).1, "a word the caller may leave out of a longer value is sent with the walk's word by a graph");
        // A leaf of a JSON body read from a reply: a graph sends its template's null when the reply lacks it, and the
        // body stops.
        let read = Expr::Read { step: "x0".into(), at: route::At::Json { pointer: "/token".into() } };
        let mut with_body = step("x1", vec![hole(Place::Json("/token".into()), vec![read])]);
        with_body.body = Some(route::Form::Json { template: serde_json::json!({"token": null}), types: [("/token".to_string(), "string".to_string())].into(), follows: vec![] });
        let refused = why(body(vec![step("x0", vec![]), with_body]));
        assert_eq!((refused.step.as_deref(), refused.why), (Some("x1"), "a graph's field fills this place another way than the body does"), "{refused}");
        // A script's call whose reply holds no JSON: a graph asks such a step for as a page.
        let mut bare = step("x1", vec![]);
        bare.shape = None;
        assert_eq!(why(body(vec![bare])).why, "a graph asks a step whose reply holds no JSON for as a page, and this body asks it as a script's call");
        let mut last_is_not = body(vec![step("x1", vec![]), step("x2", vec![])]);
        last_is_not.answer.step = "x1".into();
        assert_eq!(why(last_is_not).why, "a graph's answer is its last step");
        // A POST to a cart may change what the site holds, by the ledger's rule, and this body says it does not.
        let mut writes = step("x1", vec![]);
        writes.method = "POST".into();
        writes.url = "https://shop.example/api/cart/items".into();
        assert_eq!(why(body(vec![writes])).why, "the ledger's rule says of the graph's step another thing than the body says of its own");
        let mut elsewhere = step("x2", vec![]);
        elsewhere.script = Some(route::Caller { origin: Some("https://other.example".into()) });
        assert_eq!(why(body(vec![step("x1", vec![]), elsewhere])).why, "a graph's scripts' calls go out from one page, and this body's from more");
    }

    /// Every route a node holds, read from its own folder: each is said as a body, and replayed against a transport
    /// that answers everything with an empty reply, with nothing given and with every slot written anew, with a jar
    /// and without. Each request replay builds, and each step it cannot build, is one the filler is held to.
    ///
    /// `UNBROWSE_ROUTES=<a node's routes folder> cargo test -p unbrowse-learn the_routes_a_node_holds -- --nocapture`.
    /// The routes are the owner's and live outside the repository; with no folder named there is nothing to read.
    #[test]
    fn the_routes_a_node_holds_fill_as_replay_builds_them() {
        let _offline = crate::http::offline();
        let Some(dir) = std::env::var_os("UNBROWSE_ROUTES") else { return };
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir).expect("the routes folder").filter_map(|e| Some(e.ok()?.path())).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        files.sort();
        let (mut read, mut unread, mut refused) = (0usize, 0usize, 0usize);
        let mut differing: Vec<String> = Vec::new();
        let before = HELD.with(|held| held.get());
        for file in &files {
            let graph = std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok()).and_then(|v| serde_json::from_value::<Graph>(v.get("graph")?.clone()).ok());
            let Some(graph) = graph.filter(|g| !g.steps.is_empty()) else {
                unread += 1;
                continue;
            };
            read += 1;
            let body = from_graph(&graph, "site.example");
            let written = serde_json::to_string(&body).expect("a body is written");
            assert_eq!(serde_json::from_str::<route::Route>(&written).expect("a body written is read"), body, "{}", file.display());
            refused += usize::from(body.refused().is_some());
            let anew: HashMap<String, String> = body.asked().into_iter().map(|name| (name.to_string(), format!("another {name}"))).collect();
            for inputs in [HashMap::new(), anew] {
                for jar in [false, true] {
                    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let _ = crate::replay::replay(&graph, &inputs, &mut Empty { jar });
                    }));
                    if run.is_err() {
                        differing.push(file.file_name().unwrap_or_default().to_string_lossy().into_owned());
                    }
                }
            }
        }
        differing.sort();
        differing.dedup();
        let held = HELD.with(|held| held.get());
        eprintln!(
            "{read} routes read ({unread} files hold no graph this build reads); {} requests and {} refusals held to replay; {refused} bodies read a step that is not before them; {} routes differ",
            held.0 - before.0,
            held.1 - before.1,
            differing.len()
        );
        assert!(differing.is_empty(), "the filler differs from replay on {} of {read} routes: {differing:?}", differing.len());
    }

    /// Every route a node holds, said as a body and run as one (`replay_body`) beside its graph run by replay, against
    /// a transport that answers everything with an empty reply, with nothing given and with every slot written anew,
    /// with a jar and without, the clock held: the same requests go out, and the call comes to the same end.
    ///
    /// `UNBROWSE_ROUTES=<a node's routes folder> cargo test -p unbrowse-learn the_routes_a_node_holds -- --nocapture`.
    #[test]
    fn the_routes_a_node_holds_run_as_bodies_as_their_graphs_run() {
        let _offline = crate::http::offline();
        let Some(dir) = std::env::var_os("UNBROWSE_ROUTES") else { return };
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir).expect("the routes folder").filter_map(|e| Some(e.ok()?.path())).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        files.sort();
        let (mut read, mut runs, mut requests, mut refusals, mut answered, mut readings) = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
        let mut differing: Vec<String> = Vec::new();
        // Where a graph's address leaves out a key its own fields send: the skeleton's names it, in an error's text.
        let mut addressed: Vec<String> = Vec::new();
        crate::fresh::HELD.with(|held| held.set(Some(1_794_398_400_000)));
        for file in &files {
            let graph = std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok()).and_then(|v| serde_json::from_value::<Graph>(v.get("graph")?.clone()).ok());
            let Some(graph) = graph.filter(|g| !g.steps.is_empty()) else { continue };
            read += 1;
            let body = from_graph(&graph, "site.example");
            let name = file.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let anew: HashMap<String, String> = body.asked().into_iter().map(|name| (name.to_string(), format!("another {name}"))).collect();
            let mut said: Option<String> = None;
            // What the loop reads off each step besides its request, read off the skeleton as off the graph.
            let skeleton = skeleton(&body);
            let reading = |g: &Graph, n: usize| {
                let s = &g.steps[n];
                let judged = crate::answer::Judged::of(s);
                let fresh: Vec<String> = s.fields.iter().filter_map(|f| if let Class::Fresh { id, .. } = &f.class { Some(id.clone()) } else { None }).collect();
                let reads: Vec<(String, usize)> = s.fields.iter().filter_map(|f| if let Class::Derived { origin } = &f.class { Some((f.loc.to_string(), origin.exchange)) } else { None }).collect();
                // A caller's value the walk sent, which a read keyed by it follows (`rekeyed`).
                let defaults: Vec<(String, String)> = s.fields.iter().filter_map(|f| if let Class::Input { name, default: Some(was), .. } = &f.class { Some((name.clone(), was.clone())) } else { None }).collect();
                // The address as the loop reads it: its path (where the request goes, and the ledger's rule). Its
                // query is read into nothing but the text of an error, and is compared on its own below.
                let path = s.url.split('?').next().unwrap_or_default();
                format!(
                    "{} {} {} {path} {:?} on_load {} sets_cookie {} reads_page {} signed {} writes {} judged {:?} feeds_later {} fresh {fresh:?} reads {reads:?} defaults {defaults:?}",
                    s.exchange, s.method, s.status, s.response_shape, s.on_load, s.sets_cookie, s.reads_page, s.is_page_signed(), crate::ledger::writes(s), (judged.status, judged.writes, judged.sends_a_secret), g.feeds_later(n)
                )
            };
            readings += graph.steps.len();
            if let Some(n) = (0..graph.steps.len().min(skeleton.steps.len())).find(|&n| graph.steps[n].url != skeleton.steps[n].url) {
                addressed.push(format!("{name}: step {} {} written {}", n + 1, graph.steps[n].url.split('?').next().unwrap_or_default(), skeleton.steps[n].url.split_once('?').map_or("", |(_, q)| q)));
            }
            if skeleton.steps.len() != graph.steps.len() {
                said = Some(format!("the skeleton has {} steps, the graph {}", skeleton.steps.len(), graph.steps.len()));
            } else if let Some(n) = (0..graph.steps.len()).find(|&n| reading(&graph, n) != reading(&skeleton, n)) {
                let (a, b) = (reading(&graph, n), reading(&skeleton, n));
                let from = a.char_indices().zip(b.chars()).find(|((_, x), y)| x != y).map_or(a.len().min(b.len()), |((i, _), _)| i);
                let from = a[..from].rfind(' ').map_or(0, |i| i + 1);
                said = Some(format!("step {} reads otherwise, from: the graph {:?}, the skeleton {:?}", n + 1, a[from..].chars().take(300).collect::<String>(), b[from..].chars().take(300).collect::<String>()));
            }
            for (given, inputs) in [("nothing given", HashMap::new()), ("every slot anew", anew)] {
                for jar in [false, true] {
                    let end = |r: Result<crate::replay::HttpReplay, ReplayError>| match r {
                        Ok(called) => Ok(format!("{:?} {:?} {}", called.steps, called.rungs, called.target.status)),
                        Err(e) => Err(e.to_string()),
                    };
                    let (mut theirs, mut ours) = (Kept { jar, ..Kept::default() }, Kept { jar, ..Kept::default() });
                    let by_graph = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| end(crate::replay::replay(&graph, &inputs, &mut theirs))));
                    let by_body = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| end(crate::replay::replay_body(&body, &inputs, &mut ours))));
                    runs += 1;
                    let how = format!("{given}, {}", if jar { "a jar" } else { "no jar" });
                    let (Ok(by_graph), Ok(by_body)) = (by_graph, by_body) else {
                        said.get_or_insert(format!("{how}: a run panicked"));
                        continue;
                    };
                    if theirs.sent != ours.sent {
                        let at = theirs.sent.iter().zip(&ours.sent).position(|(a, b)| a != b).unwrap_or(theirs.sent.len().min(ours.sent.len()));
                        said.get_or_insert(format!("{how}: request {} differs: replay {:?}, the body {:?}", at + 1, theirs.sent.get(at), ours.sent.get(at)));
                    } else if by_graph != by_body {
                        said.get_or_insert(format!("{how}: the same {} requests, and replay ends {by_graph:?}, the body {by_body:?}", ours.sent.len()));
                    } else {
                        requests += ours.sent.len();
                        refusals += usize::from(by_body.is_err());
                        answered += usize::from(by_body.is_ok());
                    }
                }
            }
            if let Some(said) = said {
                differing.push(format!("{name}: {said}"));
            }
        }
        crate::fresh::HELD.with(|held| held.set(None));
        eprintln!("{read} routes read, {readings} steps' readings compared, {runs} runs; where the two agree, {requests} requests compared, {refusals} runs refused alike and {answered} answered alike; {} routes differ", differing.len());
        for d in &differing {
            eprintln!("  {}", d.chars().take(700).collect::<String>());
        }
        eprintln!("{} routes' graphs write an address with fewer keys than their fields send, which the skeleton writes in:", addressed.len());
        for a in &addressed {
            let keys: Vec<&str> = a.rsplit_once(" written ").map_or("", |(_, q)| q).split('&').filter_map(|kv| kv.split('=').next()).collect();
            eprintln!("  {} keys {keys:?}", a.split(" written ").next().unwrap_or_default());
        }
        assert!(differing.is_empty(), "a body runs otherwise than its graph on {} of {read} routes", differing.len());
    }
}

