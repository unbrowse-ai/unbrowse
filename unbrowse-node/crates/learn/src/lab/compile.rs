//! A call, as the walks bear it out, written as a step of a body; and the steps its reads need before it.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use unbrowse_route as route;
use unbrowse_route::{Expr, Way};

use crate::body::{exchange_of, place_of, step_id};
use crate::lab::answer::{settle, Unsettled};
use crate::graph::Graph;
use crate::lab::sighting::Walk;
use crate::ledger;
use crate::trace::Trace;
use crate::lab::synth::{Hole, Kind, Lab};
use crate::slots::{body_kind, BodyKind, Loc};
use crate::trace::Exchange;

/// What a hole sends when the walks found no way to make it: what the first walk sent, marked open. An open hole
/// that kept the first walk's own reading sends that, and is open still.
fn ways_of(hole: &Hole) -> (Vec<Way>, bool) {
    let open = hole.kind == Kind::Open;
    match (&hole.ways[..], hole.sent.first().and_then(|v| v.as_deref())) {
        ([], Some(walked)) => (vec![Way { rung: 0, expr: Expr::text(walked) }], true),
        (ways, _) => (ways.to_vec(), open),
    }
}

/// The call's address as a template: its origin and its path, with `{path[i]}` where piece `i` is made for each
/// call. The query is written from the holes that sit in it.
fn address(e: &Exchange, made: &BTreeSet<usize>) -> String {
    let origin = &e.url[..url::Position::BeforePath];
    let pieces: Vec<String> = e.url.path().split('/').skip(1).enumerate().map(|(i, piece)| if made.contains(&i) { format!("{{path[{i}]}}") } else { piece.to_string() }).collect();
    format!("{origin}/{}", pieces.join("/"))
}

/// The kind of leaf the walk sent at `pointer`, as a body's template records it.
fn leaf_kind(body: &Value, pointer: &str) -> &'static str {
    match body.pointer(pointer) {
        Some(Value::Number(_)) => "number",
        Some(Value::Bool(_)) => "bool",
        _ => "string",
    }
}

/// The texts a hole sends as its walk sent them and the route holds as its own: a fixed text, or the fixed pieces of
/// a join around the caller's word. A value the caller, the session or an earlier reply makes is none of the route's.
fn own_texts(hole: &route::Hole) -> Vec<&str> {
    match hole.ways.first().map(|w| &w.expr) {
        Some(Expr::Text { is }) => vec![is.as_str()],
        Some(Expr::Join { parts, .. }) => parts.iter().filter_map(|p| if let Expr::Text { is } = p { Some(is.as_str()) } else { None }).collect(),
        _ => Vec::new(),
    }
}

/// Whether the step may change what the site holds, asked of the one rule the ledger has ([`ledger::Call::writes`]):
/// the step as written (with what its walk's call answered: whether it set a cookie), and the route's own text in its
/// body and address. Whether the page sent the call by itself as it loaded is not read from a walk here, so the rule's
/// exception for such a call is never taken: a POST is a read only where its address or its own text says it asks.
pub fn writes(step: &route::Step) -> bool {
    use std::borrow::Cow;
    let mut body: Vec<(Loc, Cow<'_, str>)> = Vec::new();
    match &step.body {
        Some(route::Form::Json { template, .. }) => body.extend(crate::slots::json_leaves(template).into_iter().map(|(pointer, leaf)| (Loc::Json(pointer), Cow::Owned(leaf)))),
        Some(route::Form::Fields { fields }) => body.extend(fields.iter().filter_map(|(name, fixed)| Some((Loc::Form(name.clone()), Cow::Borrowed(fixed.as_deref()?))))),
        Some(route::Form::Multipart { parts, .. }) => {
            for p in parts {
                if let Some(json) = &p.json {
                    body.extend(crate::slots::json_leaves(json).into_iter().map(|(pointer, leaf)| (Loc::Part(p.name.clone(), pointer), Cow::Owned(leaf))));
                }
                if let Some(text) = &p.text {
                    body.push((Loc::Part(p.name.clone(), String::new()), Cow::Borrowed(text.as_str())));
                }
            }
        }
        // A binary body's fields, read as a JSON body's leaves are: the rule reads what the request says it asks.
        Some(route::Form::Wire { template, .. }) => body.extend(unbrowse_route::wire::leaves(template).into_iter().map(|(pointer, leaf)| (Loc::Json(pointer), Cow::Owned(leaf)))),
        Some(route::Form::Upload { .. } | route::Form::Other) | None => {}
    }
    let mut query: Vec<Cow<'_, str>> = Vec::new();
    for hole in &step.holes {
        let texts = own_texts(hole).into_iter().map(Cow::Borrowed);
        match &hole.at {
            route::Place::Json(pointer) => body.extend(texts.map(|t| (Loc::Json(pointer.clone()), t))),
            route::Place::Form(name) => body.extend(texts.map(|t| (Loc::Form(name.clone()), t))),
            route::Place::Part(name, pointer) => body.extend(texts.map(|t| (Loc::Part(name.clone(), pointer.clone()), t))),
            route::Place::Query(_) => query.extend(texts),
            _ => {}
        }
    }
    ledger::Call { method: &step.method, address: &step.url, status: step.expect, foreign: false, on_load: step.on_load, sets_cookie: step.sets_cookie, body, query }.writes()
}

/// The call the first walk made at `at`, as a step: each place the walks say is made for the call is a hole with
/// the ways they bear out, and the rest is the step's own text. None when the first walk made no such call.
pub fn step(lab: &Lab, at: usize) -> Option<route::Step> {
    step_of_holes(lab, at, &lab.holes(at))
}

/// The test a step was learned against (`route::Test`): for each walk that made the call, each place it sent, where
/// the value came from and what it looked like. Read from the same places `step` is written from; a value made for the
/// call is kept where the step has a hole for it, as the body sends it. Never a value.
fn test_of(at: usize, holes: &[Hole], step: &route::Step) -> route::Test {
    let from = |kind: Kind| match kind {
        Kind::Fixed => route::Source::Fixed,
        Kind::Callers => route::Source::Caller,
        Kind::Session => route::Source::Session,
        Kind::Read => route::Source::Read,
        Kind::Clock => route::Source::Clock,
        Kind::Digest => route::Source::Digest,
        Kind::Function => route::Source::Function,
        Kind::Pick => route::Source::Pick,
        Kind::Browsers => route::Source::Browser,
        Kind::Open => route::Source::Open,
    };
    let walks = holes.iter().map(|h| h.sent.len()).max().unwrap_or(0);
    let sightings = (0..walks)
        .map(|walk| route::Sighting {
            seen: holes
                .iter()
                .filter(|h| matches!(h.kind, Kind::Fixed | Kind::Browsers) || step.holes.iter().any(|b| b.at == place_of(&h.at)))
                .filter_map(|h| h.sent.get(walk)?.as_deref().map(|value| route::Seen { at: place_of(&h.at), from: from(h.kind), shape: route::Shape::of(value) }))
                .collect(),
        })
        .filter(|s| !s.seen.is_empty())
        .collect();
    route::Test { step: step_id(at), sightings, over_scripts: Vec::new() }
}

fn step_of_holes(lab: &Lab, at: usize, holes: &[Hole]) -> Option<route::Step> {
    let e = lab.walks.first()?.trace.exchanges.get(at)?;
    let fixed = |hole: &Hole| hole.kind == Kind::Fixed && matches!(hole.ways.as_slice(), [Way { expr: Expr::Text { .. }, .. }]);
    let made_pieces: BTreeSet<usize> = holes.iter().filter(|h| !fixed(h)).filter_map(|h| if let Loc::Path(i) = h.at { Some(i) } else { None }).collect();
    // A binary body opened into fields (`slots::wire_body`) is written as JSON's is: its tree the template, each made
    // leaf emptied there.
    let wire = crate::slots::wire_body(e);
    let json: Option<Value> = match &wire {
        Some((_, tree)) => Some(tree.clone()),
        None => (body_kind(e) == BodyKind::Json).then(|| e.request_body.as_deref().and_then(|b| serde_json::from_str(b).ok())).flatten(),
    };
    let mut template = json.clone();
    let mut types: BTreeMap<String, String> = BTreeMap::new();
    let mut fields: Vec<(String, Option<String>)> = Vec::new();
    let mut out: Vec<route::Hole> = Vec::new();
    for hole in holes {
        let (ways, open) = ways_of(hole);
        if ways.is_empty() {
            continue;
        }
        let body_hole = |ways: Vec<Way>| route::Hole { at: place_of(&hole.at), ways, over: false, open };
        match &hole.at {
            // A piece of the path that is fixed is the address's own text.
            Loc::Path(i) if !made_pieces.contains(i) => {}
            Loc::Json(pointer) => {
                // A fixed leaf stays in the template as the kind of leaf it is. A made one is emptied there, and the
                // hole writes it back as the kind the walk sent.
                if fixed(hole) && !open {
                    continue;
                }
                if let (Some(body), Some(walked)) = (template.as_mut(), json.as_ref()) {
                    types.insert(pointer.clone(), leaf_kind(walked, pointer).to_string());
                    if let Some(leaf) = body.pointer_mut(pointer) {
                        *leaf = Value::Null;
                    }
                }
                out.push(body_hole(ways));
            }
            Loc::Form(name) => {
                if fixed(hole) && !open {
                    fields.push((name.clone(), hole.sent.first().cloned().flatten()));
                } else {
                    fields.push((name.clone(), None));
                    out.push(body_hole(ways));
                }
            }
            _ => out.push(body_hole(ways)),
        }
    }
    let body = match body_kind(e) {
        _ if e.request_body.as_deref().is_none_or(str::is_empty) => None,
        BodyKind::Json => template.map(|template| route::Form::Json { template, types, follows: Vec::new() }),
        BodyKind::Form => Some(route::Form::Fields { fields }),
        // A multipart body, and one that is neither JSON nor a form, are not written by this learner yet.
        BodyKind::Other => match (wire, template) {
            (Some((codec, _)), Some(template)) => Some(route::Form::Wire { codec, template }),
            _ => Some(route::Form::Other),
        },
        BodyKind::Multipart => Some(route::Form::Other),
    };
    // A call a page's script made goes out from that page; a page is asked for as a page.
    let page = e.resource_type.as_deref() == Some("Document");
    let from = e.request_header("origin").map(String::from).or_else(|| e.request_header("referer").and_then(crate::graph::origin_of));
    let mut step = route::Step {
        id: step_id(at),
        method: e.method.clone(),
        url: address(e, &made_pieces),
        holes: out,
        body,
        expect: e.status,
        script: (!page).then_some(route::Caller { origin: from }),
        page: false,
        writes: true,
        // Whether the page sent it by itself as it loaded is not read from a walk here yet.
        on_load: false,
        sets_cookie: !e.set_cookies().is_empty(),
        lifetime: None,
        // The shape of its reply, as a graph's step keeps it (`graph::build`): one reader for both.
        shape: crate::graph::answer_shape(e, &inputs_of(&lab.walks[0])),
    };
    step.writes = writes(&step);
    Some(step)
}

/// A route for the call the first walk made at `at`: its step, and before it every step one of its reads needs,
/// and theirs, in the order the walk made them.
pub fn route(lab: &Lab, at: usize, site: &str) -> Option<route::Route> {
    let mut steps: BTreeMap<usize, route::Step> = BTreeMap::new();
    let mut tests: BTreeMap<usize, route::Test> = BTreeMap::new();
    let mut wanted = vec![at];
    while let Some(next) = wanted.pop() {
        if steps.contains_key(&next) {
            continue;
        }
        let holes = lab.holes(next);
        let step = step_of_holes(lab, next, &holes)?;
        // A reply is read only from a call made before the one that reads it: anything else is no source.
        wanted.extend(step.holes.iter().flat_map(|h| &h.ways).flat_map(|w| w.expr.reads()).filter_map(exchange_of).filter(|&source| source < next));
        let mut test = test_of(next, &holes, &step);
        // Where this step hashed a constant of the script that sent it, or ran that script's own function as a
        // program, the script's hash is kept on its test, so a deploy that changes the script (and may change the
        // constant or the function) is seen when the body is checked again.
        // A table the script ships, kept on the route, is the script's data as a constant is.
        let looks_up = step.holes.iter().flat_map(|h| &h.ways).any(|w| w.expr.all().iter().any(|e| matches!(e, Expr::Lookup { .. })));
        let runs_its_script = hashes_a_constant(&step) || looks_up || step.holes.iter().flat_map(|h| &h.ways).any(|w| w.expr.holds_code());
        if runs_its_script {
            test.over_scripts = lab.sender_sha_for(next).map(|sha| vec![sha.to_string()]).unwrap_or_default();
        }
        tests.insert(next, test);
        steps.insert(next, step);
    }
    let steps: Vec<route::Step> = steps.into_values().collect();
    let mut tests: Vec<route::Test> = tests.into_values().collect();
    let mut slots: Vec<route::Slot> = Vec::new();
    for expr in steps.iter().flat_map(|s| &s.holes).flat_map(|h| &h.ways).flat_map(|w| w.expr.all()) {
        if let Expr::Slot { name, or, .. } = expr {
            if !slots.iter().any(|s| s.name == *name) {
                let secret = lab.is_secret(name);
                slots.push(route::Slot { name: name.clone(), secret, example: or.clone().filter(|_| !secret), choices: Vec::new() });
            }
        }
    }
    // Whether the answer is the page read rather than a state it embeds, as a graph's step says it.
    let page = crate::graph::reads_page(lab.walks.first()?.trace.exchanges.get(at)?, &inputs_of(&lab.walks[0]));
    // A reply the standard readers cannot read, that the site's own code unpacks: the decoder cut from the script
    // that read it, run over the reply at call time. The sending script's hash is noted on the answer step's test.
    let decode = (!page).then(|| lab.decoder(at)).flatten();
    if let Some((_, Some(sha))) = &decode {
        if let Some(test) = tests.iter_mut().find(|t| t.step == step_id(at)) {
            if !test.over_scripts.contains(sha) {
                test.over_scripts.push(sha.clone());
            }
        }
    }
    let mut body = route::Route { v: route::VERSION, tests, plan: None, meaning: Default::default(), site: site.to_string(), slots, steps, answer: route::Answer { step: step_id(at), page, decode: decode.map(|(d, _)| d) } };
    // What its values mean, read from what the search found before any proposer is asked: each slot's kind by what
    // its ways do with it (a slot a way reads as a date is a date; one looked up in the site's table takes the
    // table's words, its choices), and the answer's records, read from its reply on every walk that made it.
    let (mut kinds, choices) = crate::lab::meaning::kinds(&body);
    // A slot the ways say only is free text is shown to the proposer, where there is one, with every walk's value of
    // it; a place it names is kept only where every one of those values is a place's name (`propose::kind_of`).
    if let Some(proposer) = lab.proposer() {
        for (name, kind) in kinds.iter_mut().filter(|(_, k)| **k == route::meaning::Kind::Text).filter(|(name, _)| !lab.is_secret(name)) {
            let values: Vec<String> = lab.walks.iter().filter_map(|w| w.asked.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone())).collect();
            if let Some(proposed) = crate::lab::propose::kind_of(proposer, name, &values) {
                *kind = proposed;
            }
        }
    }
    for slot in body.slots.iter_mut() {
        if let Some(listed) = choices.get(&slot.name).filter(|_| slot.choices.is_empty()) {
            slot.choices = listed.clone();
        }
    }
    let replies: Vec<(Value, Vec<(String, String)>)> = lab
        .sightings(at)
        .iter()
        .enumerate()
        .filter_map(|(walk, i)| Some((lab.walks[walk].trace.exchanges.get((*i)?)?.own_json()?, lab.walks[walk].asked.clone())))
        .collect();
    body.meaning = route::meaning::Meaning { kinds, records: crate::lab::meaning::records(&replies) };
    for way in body.steps.iter_mut().flat_map(|s| s.holes.iter_mut()).flat_map(|h| h.ways.iter_mut()) {
        way.expr = way.expr.with_no_walked_value_for(&|n| lab.is_secret(n));
    }
    named_by_their_fields(&mut body);
    Some(body)
}

/// Each slot named as the classifier names an input (`graph::input_name`): the name the walk asked it by, unless that
/// name says nothing of the field (a snapshot's ref, `@e7`, renumbered by every snapshot, or the control's kind), when
/// it is the key the call sends it under. Done once the body is built, since the lab looks each value up by the name
/// it was asked by. A slot two places would name apart, or whose new name another slot holds, keeps its name.
fn named_by_their_fields(body: &mut route::Route) {
    let mut named: BTreeMap<String, Option<String>> = BTreeMap::new();
    for hole in body.steps.iter().flat_map(|s| &s.holes) {
        let loc = crate::body::loc_of(&hole.at);
        for name in hole.ways.iter().flat_map(|w| w.expr.slots()) {
            let new = crate::graph::input_name(name, &loc);
            if new == name {
                continue;
            }
            match named.get(name) {
                Some(Some(was)) if *was != new => {
                    named.insert(name.to_string(), None);
                }
                Some(_) => {}
                None => {
                    named.insert(name.to_string(), Some(new));
                }
            }
        }
    }
    let held: BTreeSet<String> = body.slots.iter().map(|s| s.name.clone()).collect();
    let rename: BTreeMap<String, String> = named.into_iter().filter_map(|(old, new)| new.filter(|n| !held.contains(n)).map(|n| (old, n))).collect();
    if rename.is_empty() {
        return;
    }
    let to = |n: &str| rename.get(n).cloned();
    for way in body.steps.iter_mut().flat_map(|s| s.holes.iter_mut()).flat_map(|h| h.ways.iter_mut()) {
        way.expr = way.expr.with_slots_renamed(&to);
    }
    for slot in body.slots.iter_mut() {
        if let Some(new) = to(&slot.name) {
            slot.name = new;
        }
    }
    for (old, new) in &rename {
        if let Some(kind) = body.meaning.kinds.remove(old) {
            body.meaning.kinds.insert(new.clone(), kind);
        }
    }
    for says in body.meaning.records.iter_mut().flat_map(|r| r.fields.iter_mut()).filter_map(|f| f.says.as_mut()) {
        if let Some(new) = to(says) {
            *says = new;
        }
    }
}

/// The plan to learn a route again (`route::Plan`): the page it was learned on (`page`, the first walk's own address),
/// with each place a value was asked written `{name}`, the goal, which name each came under, and how each was found.
///
/// Where other walks of the page are in hand (`again`, their addresses), the places are what the addresses differ by
/// (`sighting::apart`): a piece or a value that differs from another walk's is asked, inside the page's own marks
/// where it wraps the value in some (`{word}-`), and one the same on every walk is the page's own, whatever one walk
/// reads it as. Each is named as the walk named the value there (`asked`), else by its key, else by the path's word
/// before it, else by its place. Where no other walk differs, one walk's reading stands, and each place says so: a
/// place holds a value of `asked` where it is that value whole and a word (a letter in it, not a flag, two characters
/// or more), the places a second walk of the page for another word puts the word in (`experiment::for_another_word`).
/// A browser never sends an address's fragment, so where `page` asks in its fragment and no other address carries one
/// (another walk's address read from its document), the fragment's places are one walk's reading too.
///
/// A secret's value (`secret`, by name) is never written into the page, whatever it is made of: its place stands as
/// `{name}` too, and nothing else of it is kept.
pub fn plan_of(page: &str, again: &[&str], goal: &str, asked: &[(String, String)], secret: &[(String, String)], done: Vec<route::Done>) -> Option<route::Plan> {
    use crate::lab::sighting::{apart, Apart};
    use route::AskedAt;
    let mut u = url::Url::parse(page).ok()?;
    let mut differ: Vec<Apart> = Vec::new();
    for other in again.iter().filter_map(|a| url::Url::parse(a).ok()) {
        for d in apart(&u, &other) {
            if !differ.iter().any(|have| have.at == d.at) {
                differ.push(d);
            }
        }
    }
    // The fragment, where no other address can say what it asked.
    let fragment_unsaid = again.iter().filter_map(|a| url::Url::parse(a).ok()).all(|o| o.fragment().is_none_or(str::is_empty));
    let segments: Vec<String> = u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default();
    // The name of each place found apart: the walk's own name for the value there, else the place's key, else the
    // path's word before it (one the walks share), else its place. Two places holding one value share its name.
    let mut named: Vec<(&Apart, String)> = Vec::new();
    for d in &differ {
        let walks = asked.iter().find(|(_, v)| v.eq_ignore_ascii_case(&d.first) || (matches!(d.at, AskedAt::Path(_)) && crate::slots::piece_holds(&d.first, v))).map(|(n, _)| n.clone());
        let word_before = |i: usize| -> Option<String> {
            let j = i.checked_sub(1)?;
            let w = segments.get(j)?;
            let shared = !differ.iter().any(|o| o.at == AskedAt::Path(j));
            (shared && w.chars().any(char::is_alphabetic) && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then(|| w.to_lowercase().replace('-', "_"))
        };
        let base = walks.unwrap_or_else(|| match &d.at {
            AskedAt::Query(k) | AskedAt::Fragment(k) => k.clone(),
            AskedAt::Path(i) => word_before(*i).unwrap_or_else(|| format!("part{i}")),
        });
        let name = match named.iter().find(|(o, n)| *n == base && o.first != d.first) {
            None => base,
            Some(_) => (2..).map(|k| format!("{base}_{k}")).find(|n| !named.iter().any(|(_, have)| have == n)).unwrap_or(base),
        };
        named.push((d, name));
    }
    let a_word = |v: &str| v.chars().any(char::is_alphabetic) && !crate::slots::is_flag(v) && v.chars().count() >= 2;
    // What stands at a place in the plan's page, and the name it was asked under and how that was found (none for a
    // secret's place, named in the page and nowhere else). None where the page's own value stands.
    let write = |at: &AskedAt, v: &str| -> Option<(Option<(String, route::AskedBy)>, String)> {
        if let Some((d, name)) = named.iter().find(|(d, _)| d.at == *at) {
            return Some((Some((name.clone(), route::AskedBy::TwoWalks)), format!("{}{{{name}}}{}", d.before, d.after)));
        }
        let one_walk = differ.is_empty() || (matches!(at, AskedAt::Fragment(_)) && fragment_unsaid);
        if let Some((name, _)) = asked.iter().find(|(_, value)| one_walk && value == v && a_word(v)) {
            return Some((Some((name.clone(), route::AskedBy::OneWalk)), format!("{{{name}}}")));
        }
        secret.iter().find(|(_, value)| !value.is_empty() && value == v).map(|(name, _)| (None, format!("{{{name}}}")))
    };
    let mut places: Vec<route::Asked> = Vec::new();
    let mut keep = |name: Option<(String, route::AskedBy)>, at: AskedAt| {
        if let Some((slot, by)) = name {
            places.push(route::Asked { slot, at, by });
        }
    };
    let pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    if pairs.iter().any(|(k, v)| write(&AskedAt::Query(k.clone()), v).is_some()) {
        let moved: Vec<(String, String)> = pairs
            .into_iter()
            .map(|(k, v)| match write(&AskedAt::Query(k.clone()), &v) {
                Some((name, written)) => {
                    keep(name, AskedAt::Query(k.clone()));
                    (k, written)
                }
                None => (k, v),
            })
            .collect();
        u.query_pairs_mut().clear().extend_pairs(moved);
    }
    if segments.iter().enumerate().any(|(i, p)| write(&AskedAt::Path(i), p).is_some()) {
        let moved: Vec<String> = segments
            .iter()
            .enumerate()
            .map(|(i, p)| match write(&AskedAt::Path(i), p) {
                Some((name, written)) => {
                    keep(name, AskedAt::Path(i));
                    written
                }
                None => p.clone(),
            })
            .collect();
        u.path_segments_mut().ok()?.clear().extend(moved.iter().map(String::as_str));
    }
    if let Some((lead, held)) = u.fragment().and_then(route::fragment_pairs).map(|(l, p)| (l.to_string(), p.to_string())) {
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(held.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        if pairs.iter().any(|(k, v)| write(&AskedAt::Fragment(k.clone()), v).is_some()) {
            let moved: String = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(pairs.into_iter().map(|(k, v)| match write(&AskedAt::Fragment(k.clone()), &v) {
                    Some((name, written)) => {
                        keep(name, AskedAt::Fragment(k.clone()));
                        (k, written)
                    }
                    None => (k, v),
                }))
                .finish();
            u.set_fragment(Some(&format!("{lead}{moved}")));
        }
    }
    // Written as a person reads it: a place as `{name}`, not its encoding.
    let page = u.to_string().replace("%7B", "{").replace("%7D", "}");
    Some(route::Plan { page, goal: goal.to_string(), asked: places, done })
}

/// The page a second walk for `word` goes to, from the plan alone: `word` written at every place the plan says a
/// slot was asked, as the trial writes another word wherever the first walk was asked one. None when the plan was
/// asked nothing: then there is no other page to walk.
pub fn page_for_another_word(plan: &route::Plan, word: &str) -> Option<String> {
    if plan.asked.is_empty() {
        return None;
    }
    plan.address(&plan.asked.iter().map(|a| (a.slot.clone(), word.to_string())).collect())
}

/// What was done on the page, as a plan keeps it (`route::Done`): each step that acted on the page (not a navigation,
/// which is the plan's page, nor the engine's own reading of it), by kind and the field it was done to, and the slot
/// a value typed or chosen there fills, where it is the value of one in `asked`. What was typed is never kept, and a
/// step typed as a secret keeps no slot. A target that spells a value given (a selector naming the typed text) has
/// the value written as its slot's `{name}`; one that spells a secret's value is not kept at all.
pub fn done_of(actions: &[crate::session::Action], asked: &[(String, String)], secret: &[(String, String)]) -> Vec<route::Done> {
    let spelled = |text: &str, value: &str| value.chars().count() >= 2 && text.contains(value);
    actions
        .iter()
        .filter(|a| !matches!(a.kind.as_str(), "navigate" | "read"))
        .filter_map(|a| {
            let target = a.field.clone().or_else(|| a.locator.clone()).or_else(|| a.selector.clone())?;
            let typed = a.value.as_deref().unwrap_or_default();
            if secret.iter().any(|(_, v)| spelled(&target, v)) || (a.secret && spelled(&target, typed)) {
                return None;
            }
            let target = asked.iter().fold(target, |t, (name, v)| if spelled(&t, v) { t.replace(v.as_str(), &format!("{{{name}}}")) } else { t });
            let slot = (!a.secret).then(|| asked.iter().find(|(_, v)| !typed.is_empty() && v == typed).map(|(name, _)| name.clone())).flatten();
            Some(route::Done { kind: a.kind.clone(), target, slot })
        })
        .collect()
}

/// Why a learn wrote no route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unlearned {
    /// The walks settle no answer, and none is guessed.
    Unsettled(Unsettled),
    /// The answer's call is not one the first walk made: its place there.
    Unwritten(usize),
}

impl std::fmt::Display for Unlearned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unlearned::Unsettled(why) => write!(f, "the walks settle no answer: {why}"),
            Unlearned::Unwritten(at) => write!(f, "call {at} of the first walk could not be written as a step"),
        }
    }
}

/// The route a learn's walks bear out, with nothing kept from another learn: which call is the answer, as the two
/// walks say it ([`crate::lab::answer`]), and that call with the steps its reads need, as [`route`] writes it. A
/// route whose answer is the page read, not a state it embeds, says so. Where the walks settle nothing, nothing is written and the
/// reason is said: what one walk would guess is no answer here.
///
/// Two walks of one page are one experiment, and neither is the earlier: a door that stopped the walk a corpus sorts
/// first is no sighting of the page it stopped, and says nothing against what the site served the other walk. So the
/// same two walks are asked the other way round before the experiment is called void, and the route is written from
/// whichever walk it settles on; where neither order settles, the reason is the one the first reading gave.
pub fn learn(walks: &[Walk], site: &str) -> Result<route::Route, Unlearned> {
    match settled(walks, site) {
        Ok(body) => Ok(body),
        Err(why) if walks.len() > 1 => {
            let other_way: Vec<Walk> = walks.iter().rev().map(|w| Walk { trace: w.trace, asked: w.asked.clone(), session: w.session }).collect();
            settled(&other_way, site).map_err(|_| why)
        }
        Err(why) => Err(why),
    }
}

/// [`learn`] in one order: the answer the walks settle on, written from the first of them.
fn settled(walks: &[Walk], site: &str) -> Result<route::Route, Unlearned> {
    let at = settle(walks).map_err(Unlearned::Unsettled)?;
    route(&Lab::new(walks), at, site).ok_or(Unlearned::Unwritten(at))
}

/// The graph the node's caller runs for the call a learn has chosen (the last call of `first` that `is_target`
/// says is it), learned by example from every walk of its page the node has in hand: `first`, asked what its inputs
/// say (never a secret), and each of `others`, another walk of the page, asked what its own address asks under those
/// names (`sighting::asked_again`, against `page`, the address `first` walked). Each walk's door is set aside as
/// `build` sets it aside, so no step is a door's. The call is the node's choice, not the lab's pick; the route is
/// that call and the steps its reads need (`route`), said as a graph (`body::to_graph`).
///
/// Every walk in hand is a sighting, and not only the newest: a walk for the same word says what does not move
/// with the time, and one for another word says what moves with the word, and a learn that has both should not
/// read as if it had one.
///
/// Err: why no graph was written, for the node to say beside the classifier's graph it keeps.
pub fn graph_by_example(first: &Trace, page: &str, others: &[&Trace], is_target: impl Fn(&Exchange) -> bool) -> Result<Graph, String> {
    let learned = body_by_example(first, page, others, is_target, None)?;
    learned.graph.map_err(|unsaid| format!("the body cannot be said as a graph: {unsaid}"))
}

/// What the learner by example writes for a call: the body, and the graph that says it where a graph can.
#[derive(Clone, Debug)]
pub struct ByExample {
    pub body: route::Route,
    /// The graph `body::to_graph` says the body as, or where and why it cannot.
    pub graph: Result<Graph, crate::body::Unsaid>,
}

/// [`graph_by_example`], handing back the body as well as what a graph makes of it, so the node keeps the body beside
/// whichever graph stands. `recording`, when the walk kept one, names the script that sent the call and holds its
/// body, whose string literals the digest search may hash a signature over (`slice::literals`). Err: why no body was
/// written.
pub fn body_by_example(first: &Trace, page: &str, others: &[&Trace], is_target: impl Fn(&Exchange) -> bool, recording: Option<&crate::recording::Recording>) -> Result<ByExample, String> {
    body_by_example_stored(first, page, others, is_target, recording, &[])
}

/// What a walk's page kept in its storage for the page's own origin, as its recording holds it: what the page had
/// when it settled, with what it stored by the end beside it (a key written after the page settled is still one its
/// later call could read). None when the recording holds neither.
pub fn storage_when_called(recording: &crate::recording::Recording, page: &str) -> Option<crate::sandbox::Storage> {
    let origin = url::Url::parse(page).ok()?.origin().ascii_serialization();
    let (settle, end) = (recording.storage_at("settle", &origin), recording.storage_at("end", &origin));
    if settle.is_none() && end.is_none() {
        return None;
    }
    let mut out = crate::sandbox::Storage::default();
    for snap in [end, settle].into_iter().flatten() {
        out.local.extend(snap.local.iter().map(|(k, v)| (k.clone(), v.clone())));
        out.session.extend(snap.session.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    Some(out)
}

/// [`body_by_example`], with what each other walk's page kept in its storage (`others_stored`, in the order of
/// `others`; a missing entry is a walk whose recording held none): a function of the sending script that reads the
/// page's storage is held to each walk with its own.
pub fn body_by_example_stored(first: &Trace, page: &str, others: &[&Trace], is_target: impl Fn(&Exchange) -> bool, recording: Option<&crate::recording::Recording>, others_stored: &[Option<crate::sandbox::Storage>]) -> Result<ByExample, String> {
    let first = crate::graph::without_its_door(first, &is_target);
    let at = first.exchanges.iter().rposition(&is_target).ok_or("the walk does not hold the call")?;
    let walked = url::Url::parse(page).map_err(|e| format!("the page's address does not read: {e}"))?;
    // A value the walk kept as a secret is asked as any other is: the caller's to give. Only its walked value is never
    // kept (`Lab::with_secrets`).
    let asked: Vec<(String, String)> = first.inputs.iter().map(|i| (i.name.clone(), i.value.clone())).collect();
    let secrets: Vec<String> = first.inputs.iter().filter(|i| i.secret).map(|i| i.name.clone()).collect();
    // A walk with no page of its own was asked nothing that can be read, and is no sighting.
    let again: Vec<(Trace, Vec<(String, String)>, Option<crate::sandbox::Storage>)> = others
        .iter()
        .enumerate()
        .map(|(n, other)| (crate::graph::without_its_door(other, &is_target), others_stored.get(n).cloned().flatten()))
        .filter_map(|(other, stored)| {
            let page = other.exchanges.iter().find(|e| e.is_main_document())?.url.clone();
            let asked = crate::lab::sighting::asked_again(&walked, &asked, &page);
            Some((other, asked, stored))
        })
        .collect();
    // With no other walk, one sighting says what one walk can: the asked value's places are the caller's, a value an
    // earlier reply, the jar, the page's storage or the clock makes is that, and the rest is sent as walked and marked
    // open (`synth::Lab::holes`), for a second sighting to settle. The first ask is answered from this body, and a door
    // that refuses the second walk leaves it standing.
    let mut walks = vec![Walk { trace: &first, asked, session: 1 }];
    walks.extend(again.iter().map(|(trace, asked, _)| Walk { trace, asked: asked.clone(), session: 1 }));
    let stores: Vec<Option<crate::sandbox::Storage>> = std::iter::once(recording.and_then(|r| storage_when_called(r, page))).chain(again.iter().map(|(_, _, stored)| stored.clone())).collect();
    let site = walked.host_str().map(crate::identity::site_of).unwrap_or_default();
    // What the recording says of the target call, matched by what it sent (the lab's trace has its doors struck out,
    // so its indices are not the recording's): the script that sent it and its string literals (constants a digest
    // of the call may be hashed over), the frame that sent it (`sender`, whose function a program may be cut from),
    // and the scripts the walk fetched (what that function calls).
    let target = first.exchanges.get(at);
    let (literals, sha) = recording
        .zip(target)
        .and_then(|(rec, target)| {
            let (script, _) = rec.sent_by_value(&target.method, target.url.as_str())?;
            let sha = script.sha256.clone()?;
            let body = rec.body(&sha)?;
            Some((crate::slice::literals(&String::from_utf8_lossy(body)), sha))
        })
        .map_or((Vec::new(), None), |(lits, sha)| (lits, Some(sha)));
    let sender = recording.zip(target).and_then(|(rec, target)| {
        let (script, frame) = rec.sent_by_value(&target.method, target.url.as_str())?;
        let body = rec.body(script.sha256.as_deref()?)?;
        Some(crate::signing::Producer { script: frame.url.clone(), at: crate::slice::offset_at(&String::from_utf8_lossy(body), frame.line as u32, frame.column as u32)?, frame: true })
    });
    let mut scripts: Vec<(String, String)> = Vec::new();
    if let Some(rec) = recording {
        for s in &rec.scripts {
            let Some(body) = s.sha256.as_deref().and_then(|sha| rec.body(sha)) else { continue };
            if !s.url.is_empty() && !scripts.iter().any(|(u, _)| *u == s.url) {
                scripts.push((s.url.clone(), String::from_utf8_lossy(body).into_owned()));
            }
        }
    }
    let saw_sender = sender.is_some();
    // The tables the sending script ships, read by the same parser: the site's data a caller's word may be turned into
    // its code by (`Lab::listed`).
    let tables = recording
        .zip(target)
        .and_then(|(rec, target)| {
            let (script, _) = rec.sent_by_value(&target.method, target.url.as_str())?;
            Some(crate::slice::tables(&String::from_utf8_lossy(rec.body(script.sha256.as_deref()?)?)))
        })
        .unwrap_or_default();
    // What each walk's page kept in its storage when it made the call (`storage_when_called`): a value the call
    // sends that the page held there is the storage's, and a cut function that reads the storage is held to it.
    let lab = Lab::new(&walks).reading(at, literals, sha, sender, scripts).with_tables(tables).with_proposer(crate::lab::propose::configured()).stored(stores).with_secrets(secrets);
    let body = route(&lab, at, &site).ok_or("the lab wrote no step for the call")?;
    // A function cut from the sending script and refused says why, naming the read the node has no source for.
    for (loc, why) in lab.refusals() {
        eprintln!("   [route] {} left open: {why}", place_of(&loc));
    }
    // A fallback says so (`AGENTS.md`): without a JavaScript runtime, the sending script's constants (the digest
    // search's parts) and its functions (a cut program) cannot be searched, so a header the script makes stays open.
    // Say it once, naming the places, when a sender was in hand and a runtime would have been the only thing to try.
    if let Some(why) = crate::sandbox::unheld().filter(|_| saw_sender) {
        let open: Vec<route::Place> = lab.holes(at).into_iter().filter(|h| h.kind == Kind::Open && matches!(h.at, Loc::Header(_))).map(|h| place_of(&h.at)).collect();
        if let Some(line) = no_runtime_note(&open, why) {
            eprintln!("   [route] {line}");
        }
    }
    let graph = crate::body::to_graph(&body);
    Ok(ByExample { body, graph })
}

/// The line a learn says when it runs no page's code (no runtime, or one that can't be held: `sandbox::Unheld`) and so searched the sending script neither for the
/// constants a digest is made over ([`crate::slice::literals`]) nor for a function to cut and run
/// ([`crate::lab::synth::Lab::program`]): a header the script makes stays open, and the line names which. None when
/// nothing was left open, so a machine with a runtime, or one with no such header, says nothing.
pub fn no_runtime_note(open: &[route::Place], why: crate::sandbox::Unheld) -> Option<String> {
    (!open.is_empty()).then(|| {
        let places = open.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ");
        format!("the search ran without the sending script's constants or functions: {}; left open: {places}", why.said())
    })
}

/// A body's size, as [`counted`] says a graph's: its steps, and the slots it asks a caller for.
pub fn counted_body(body: &route::Route) -> String {
    let plural = |n: usize, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    format!("{}, {}", plural(body.steps.len(), "step"), plural(body.asked().len(), "input"))
}

/// A graph's size, as a person reads it beside another's: its steps, and the inputs it asks a caller for.
pub fn counted(graph: &Graph) -> String {
    let mut inputs: Vec<&str> = graph.steps.iter().flat_map(|s| &s.fields).filter_map(|f| if let crate::graph::Class::Input { name, .. } = &f.class { Some(name.as_str()) } else { None }).collect();
    inputs.sort_unstable();
    inputs.dedup();
    let plural = |n: usize, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    format!("{}, {}", plural(graph.steps.len(), "step"), plural(inputs.len(), "input"))
}

/// Whether a step hashes a constant of its sending script: a way of its is a hash over a join that holds a fixed
/// text. The text is the script's constant (`fit_by_search_with` keeps a page constant as `Expr::Text`), so the
/// script's hash is worth noting on the step's test.
fn hashes_a_constant(step: &route::Step) -> bool {
    step.holes.iter().flat_map(|h| &h.ways).any(|w| {
        matches!(&w.expr, Expr::Hash { of, .. } if matches!(of.as_ref(), Expr::Join { parts, .. } if parts.iter().any(|p| matches!(p, Expr::Text { .. }))))
    })
}

/// What a walk was asked, as the engine's readers of a reply take it.
fn inputs_of(walk: &Walk) -> Vec<crate::trace::Input> {
    walk.asked.iter().map(|(name, value)| crate::trace::Input::new(name, value)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(of: &[(&str, &str)]) -> Vec<(String, String)> {
        of.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// One walk writes a body, saying what one sighting can: the asked value's place is the caller's, a value an
    /// earlier reply of the walk holds is read from that reply, a cookie is the jar's, and a value nothing the walk
    /// shows makes is sent as walked and marked open, for a second sighting to settle. So the first ask, and a page
    /// whose door refused the second walk, are answered from a body.
    #[test]
    fn one_walk_writes_a_body_whose_asked_place_is_the_callers_and_whose_unexplained_places_are_open() {
        use crate::lab::sighting::tests::call;
        let mut first = crate::trace::Trace {
            exchanges: vec![
                call("GET", "https://shop.example/p/search?q=lamp", &[], None, "<html></html>"),
                call("GET", "https://shop.example/api/config", &[], None, r#"{"build":"b_7c6b5a4f3e2d1c0b9a"}"#),
                call("GET", "https://shop.example/api/search?q=lamp&build=b_7c6b5a4f3e2d1c0b9a", &[("x-app-hash", "9a8b7c6d5e4f3a2b"), ("x-client-build", "2611"), ("cookie", "sid=s_0f1e2d3c4b5a69788")], None, r#"{"items":[{"name":"Desk lamp"}]}"#),
            ],
            inputs: vec![crate::trace::Input::new("q", "lamp")],
        };
        first.exchanges[0].resource_type = Some("Document".into());
        let is_target = |e: &Exchange| e.url.path() == "/api/search";
        let learned = body_by_example(&first, "https://shop.example/p/search?q=lamp", &[], is_target, None).expect("one walk writes a body");
        let step = learned.body.steps.iter().find(|s| s.url.contains("/api/search")).unwrap_or_else(|| panic!("the search is a step: {}", serde_json::to_string(&learned.body).unwrap()));
        let hole = |at: route::Place| step.holes.iter().find(|h| h.at == at).unwrap_or_else(|| panic!("no hole at {at}"));
        assert_eq!(hole(route::Place::Query("q".into())).ways[0].expr, Expr::Slot { name: "q".into(), or: Some("lamp".into()), optional: false });
        assert!(!hole(route::Place::Query("q".into())).open);
        assert!(matches!(hole(route::Place::Query("build".into())).ways[0].expr, Expr::Read { .. }), "read from the config's reply");
        assert_eq!(hole(route::Place::Cookie("sid".into())).ways[0].expr, Expr::Cookie { name: "sid".into(), here: false });
        // A long header nothing explains is the session's, as the classifier reads one from one walk: one reader.
        assert_eq!(hole(route::Place::Header("x-app-hash".into())).ways[0].expr, Expr::Cookie { name: "x-app-hash".into(), here: false });
        let unexplained = hole(route::Place::Header("x-client-build".into()));
        assert_eq!((unexplained.open, &unexplained.ways[0].expr), (true, &Expr::text("2611")));
        assert_eq!(step.url, "https://shop.example/api/search", "the path is the address's own");
        assert_eq!(learned.body.asked(), ["q"]);
    }

    /// A value the walk asked by the ref its snapshot numbered the control by (`@e7`), or by the control's kind, is
    /// offered under the key the call sends it as, as the classifier names an input (`graph::input_name`): a ref is
    /// renumbered by every snapshot, and a caller passes the field by its name. A name that says what it fills stays.
    #[test]
    fn a_value_asked_by_a_snapshots_ref_is_offered_by_the_key_the_call_sends_it_as() {
        use crate::lab::sighting::tests::call;
        let mut first = crate::trace::Trace {
            exchanges: vec![
                call("GET", "https://bank.example/transfer", &[], None, "<html></html>"),
                call("POST", "https://bank.example/api/transfer?toAccount=28440&amount=15&note=rent", &[], None, r#"{"ok":true,"id":991}"#),
            ],
            inputs: vec![crate::trace::Input::new("@e7", "28440"), crate::trace::Input::new("textbox", "15"), crate::trace::Input::new("note", "rent")],
        };
        first.exchanges[0].resource_type = Some("Document".into());
        let is_target = |e: &Exchange| e.url.path() == "/api/transfer";
        let learned = body_by_example(&first, "https://bank.example/transfer", &[], is_target, None).expect("one walk writes a body");
        let mut asked = learned.body.asked();
        asked.sort();
        assert_eq!(asked, ["amount", "note", "toAccount"], "{}", serde_json::to_string(&learned.body).unwrap());
        let step = learned.body.steps.iter().find(|s| s.url.contains("/api/transfer")).unwrap();
        let to = step.holes.iter().find(|h| h.at == route::Place::Query("toAccount".into())).expect("a hole at toAccount");
        assert_eq!(to.ways[0].expr.slots(), ["toAccount"]);
    }

    /// A value the walk kept as a secret (a message the site never said back, a password) is the caller's to give, as
    /// the classifier keeps it: a secret slot under the name the page gave its field. Its walked value is kept
    /// nowhere on the body, neither as the slot's example nor as text sent as walked.
    #[test]
    fn a_typed_secret_is_the_callers_slot_and_its_value_is_kept_nowhere() {
        use crate::lab::sighting::tests::call;
        let typed = "meet at noon by the gate";
        let mut first = crate::trace::Trace {
            exchanges: vec![
                call("GET", "https://shop.example/p/77001", &[], None, "<html></html>"),
                call("POST", "https://shop.example/api/item/77001/offer", &[], Some(&format!(r#"{{"message":"{typed}"}}"#)), r#"{"ok":true}"#),
            ],
            inputs: vec![crate::trace::Input { name: "Type here...".into(), value: typed.into(), secret: true }],
        };
        first.exchanges[0].resource_type = Some("Document".into());
        let is_target = |e: &Exchange| e.url.path().ends_with("/offer");
        let learned = body_by_example(&first, "https://shop.example/p/77001", &[], is_target, None).expect("one walk writes a body");
        let said = serde_json::to_string(&learned.body).unwrap();
        assert_eq!(learned.body.asked(), ["Type here..."], "{said}");
        let slot = &learned.body.slots[0];
        assert!(slot.secret && slot.example.is_none(), "{said}");
        assert!(!said.contains(typed), "the typed value is kept nowhere: {said}");
        let graph = learned.graph.expect("a graph says the body");
        let input = graph.steps.iter().flat_map(|s| &s.fields).find_map(|f| match &f.class {
            crate::graph::Class::Input { name, secret, default, .. } => Some((name.clone(), *secret, default.clone())),
            _ => None,
        });
        assert_eq!(input, Some(("Type here...".to_string(), true, None)));
    }

    /// A place one walk cannot explain is sent as walked, plain: "open" is a mark for the learner, for a second
    /// sighting to settle, and never a reason for a browser at call time. Found on a bank site driven by hand, where
    /// a one-walk body sent its call through the browser (35 to 64 s) where the classifier's answered plain in 1.3 s.
    #[test]
    fn a_place_one_walk_cannot_explain_is_sent_as_walked_and_never_asks_for_a_browser() {
        use crate::lab::sighting::tests::call;
        let mut first = crate::trace::Trace {
            exchanges: vec![
                call("GET", "https://shop.example/p/search?q=lamp", &[], None, "<html></html>"),
                call("POST", "https://shop.example/api/search", &[("content-type", "application/json, application/json"), ("x-client-build", "2611")], Some(r#"{"q":"lamp","v":"x9"}"#), r#"{"items":[{"name":"Desk lamp"}]}"#),
            ],
            inputs: vec![crate::trace::Input::new("q", "lamp")],
        };
        first.exchanges[0].resource_type = Some("Document".into());
        let is_target = |e: &Exchange| e.url.path() == "/api/search";
        let learned = body_by_example(&first, "https://shop.example/p/search?q=lamp", &[], is_target, None).expect("one walk writes a body");
        let step = learned.body.steps.iter().find(|s| s.url.contains("/api/search")).expect("the search is a step");
        let open: Vec<_> = step.holes.iter().filter(|h| h.open).collect();
        assert!(!open.is_empty(), "the walk leaves something unexplained: {}", serde_json::to_string(&learned.body).unwrap());
        for hole in &open {
            assert_eq!(hole.ways[0].rung, 0, "{} is sent as walked, plain", hole.at);
        }
        assert!(!step.page, "an open place is no reason for the page to make the step");
        if let Ok(graph) = crate::body::to_graph(&learned.body) {
            assert!(graph.steps.iter().all(|s| !s.needs_browser && !s.is_page_signed()), "said as a graph, no step asks for a browser");
        }
    }

    /// Without a JavaScript runtime the sending script's constants and functions are not searched, so a header the
    /// script makes stays open: a learn says one line that names which, and says why. A machine with a runtime, or a
    /// call that left no such header open, says nothing.
    #[test]
    fn without_a_runtime_the_search_says_so_and_names_what_it_left_open() {
        use crate::sandbox::Unheld;
        assert_eq!(no_runtime_note(&[], Unheld::NoRuntime), None, "nothing open: nothing said");
        let line = no_runtime_note(&[route::Place::Header("x-sig".into())], Unheld::NoRuntime).expect("a header left open says so");
        assert!(line.contains("no JavaScript runtime"), "it says why: {line}");
        assert!(line.contains("constants or functions"), "it says what was not searched: {line}");
        assert!(line.contains("x-sig"), "it names the place left open: {line}");
        // A runtime there but unable to be held is not said to be none: it is said as the probe found it.
        let old = no_runtime_note(&[route::Place::Header("x-sig".into())], Unheld::Lacks("has no permission model (process.permission); a newer Node has it".into())).expect("a header left open says so");
        assert!(old.contains("has no permission model") && !old.contains("no JavaScript runtime"), "{old}");
    }

    /// The plan's page holds each word it was asked as that slot's `{name}`, in the query, the path and the fragment;
    /// a count stays as walked. A secret's value is never written into the page, whatever it looks like, and the plan
    /// names no slot for it.
    #[test]
    fn a_plan_is_its_page_with_each_asked_word_as_its_slot_and_never_a_secrets_value() {
        let plan = plan_of("https://a.example/s?q=brass+lamp&adults=2", &[], "search", &pairs(&[("q", "brass lamp"), ("adults", "2")]), &[], Vec::new()).unwrap();
        assert_eq!(plan.page, "https://a.example/s?q={q}&adults=2");
        assert_eq!(plan.asked, vec![route::Asked { slot: "q".into(), at: route::AskedAt::Query("q".into()), by: route::AskedBy::OneWalk }]);
        let plan = plan_of("https://a.example/search/iphone%2015/", &[], "search", &pairs(&[("search", "iphone 15")]), &[], Vec::new()).unwrap();
        assert_eq!(plan.page, "https://a.example/search/{search}/");
        assert_eq!(plan.asked[0].at, route::AskedAt::Path(1));
        let plan = plan_of("https://a.example/find#q=bonds&tab=all", &[], "search", &pairs(&[("q", "bonds")]), &[], Vec::new()).unwrap();
        assert_eq!(plan.page, "https://a.example/find#q={q}&tab=all");
        let plan = plan_of("https://a.example/in?user=lewis&code=4471", &[], "sign in", &pairs(&[("user", "lewis")]), &pairs(&[("code", "4471")]), Vec::new()).unwrap();
        assert!(!plan.page.contains("4471"), "{}", plan.page);
        assert_eq!(plan.asked.iter().map(|a| a.slot.as_str()).collect::<Vec<_>>(), ["user"]);
    }

    /// What was done on the page keeps its kind, the field it was done to and the slot its value fills, and never the
    /// value: a word typed in the search box is the slot `q`, a password typed is a step with no slot, and a target
    /// that spells the typed word names its slot instead. A navigation is the plan's page, not a step done on it.
    #[test]
    fn what_was_done_keeps_its_kind_target_and_slot_and_never_a_typed_value() {
        let act = |kind: &str, field: Option<&str>, locator: Option<&str>, value: Option<&str>, secret: bool| crate::session::Action {
            t: 0.0,
            kind: kind.into(),
            selector: Some("#e12".into()),
            field: field.map(String::from),
            locator: locator.map(String::from),
            value: value.map(String::from),
            secret,
            submit: false,
        };
        let actions = [
            act("navigate", None, None, Some("https://a.example/"), false),
            act("type", Some("Search the shop"), None, Some("brass lamp"), false),
            act("click", None, Some("text=brass lamp"), None, false),
            act("type", Some("Password"), None, Some("hunter22"), true),
            act("click", None, Some("button[value=hunter22]"), None, false),
            act("press", None, None, Some("Enter"), false),
        ];
        let done = done_of(&actions, &pairs(&[("q", "brass lamp")]), &pairs(&[("password", "hunter22")]));
        let seen: Vec<(&str, &str, Option<&str>)> = done.iter().map(|d| (d.kind.as_str(), d.target.as_str(), d.slot.as_deref())).collect();
        assert_eq!(seen, [("type", "Search the shop", Some("q")), ("click", "text={q}", None), ("type", "Password", None), ("press", "#e12", None)]);
        let kept = serde_json::to_string(&done).unwrap();
        assert!(!kept.contains("hunter22") && !kept.contains("brass lamp"), "{kept}");
    }

    /// A piece of the path the site wrote itself stays the page's, though one walk reads it as a value: two walks of
    /// the page differ only where the caller's value stands, so that is the one place asked, and the plan says it was
    /// read from two walks.
    #[test]
    fn a_path_piece_that_is_the_sites_word_stays_the_pages() {
        let one_walk = pairs(&[("s", "lisbon"), ("part2", "homes"), ("adults", "2")]);
        let plan = plan_of("https://a.example/s/lisbon/homes?adults=2", &["https://a.example/s/bangkok/homes?adults=2"], "search stays", &one_walk, &[], Vec::new()).unwrap();
        assert_eq!(plan.page, "https://a.example/s/{s}/homes?adults=2");
        assert_eq!(plan.asked, vec![route::Asked { slot: "s".into(), at: route::AskedAt::Path(1), by: route::AskedBy::TwoWalks }]);
        assert_eq!(page_for_another_word(&plan, "oslo").as_deref(), Some("https://a.example/s/oslo/homes?adults=2"));
        // With one walk, that walk's reading stands, and the plan says so.
        let alone = plan_of("https://a.example/s/lisbon/homes?adults=2", &[], "search stays", &one_walk, &[], Vec::new()).unwrap();
        assert_eq!(alone.page, "https://a.example/s/{s}/{part2}?adults=2");
        assert!(alone.asked.iter().all(|a| a.by == route::AskedBy::OneWalk), "{:?}", alone.asked);
    }

    /// A value of the query that is the same on both walks is the page's, whatever its key and however much it looks
    /// like a word; one that differs is asked, under the walk's own name for it. Where nothing differs, one walk's
    /// reading stands.
    #[test]
    fn a_query_value_the_same_on_both_walks_is_the_pages() {
        let one_walk = pairs(&[("searching", "all_posts"), ("dcity", "sha"), ("acity", "sin")]);
        let plan = plan_of("https://a.example/flights?dcity=sha&acity=sin&searching=all_posts", &["https://a.example/flights?dcity=bjs&acity=sin&searching=all_posts"], "flights", &one_walk, &[], Vec::new()).unwrap();
        assert_eq!(plan.page, "https://a.example/flights?dcity={dcity}&acity=sin&searching=all_posts");
        assert_eq!(page_for_another_word(&plan, "hkg").as_deref(), Some("https://a.example/flights?dcity=hkg&acity=sin&searching=all_posts"));
        let same = plan_of("https://a.example/s?q=lamp", &["https://a.example/s?q=lamp"], "search", &pairs(&[("q", "lamp")]), &[], Vec::new()).unwrap();
        assert_eq!((same.page.as_str(), same.asked[0].by), ("https://a.example/s?q={q}", route::AskedBy::OneWalk), "two walks for one word say nothing apart");
    }

    /// A word the page wraps in marks of its own (the same on both walks) is asked inside them: the plan writes the
    /// marks as the page's, and another word goes between them. A value one walk did not read at all is found by the
    /// two, named for the path's word before it.
    #[test]
    fn a_word_the_page_wraps_in_its_own_marks_is_asked_inside_them() {
        let plan = plan_of("https://a.example/search/chicken-", &["https://a.example/search/pasta-"], "recipes", &[], &[], Vec::new()).unwrap();
        assert_eq!(plan.page, "https://a.example/search/{search}-");
        assert_eq!(page_for_another_word(&plan, "lamb").as_deref(), Some("https://a.example/search/lamb-"));
        let fragment = plan_of("https://a.example/funds#/search?q=bonds&tab=all", &["https://a.example/funds#/search?q=gilts&tab=all"], "funds", &pairs(&[("q", "bonds")]), &[], Vec::new()).unwrap();
        assert_eq!(fragment.page, "https://a.example/funds#/search?q={q}&tab=all");
        assert_eq!(page_for_another_word(&fragment, "cash").as_deref(), Some("https://a.example/funds#/search?q=cash&tab=all"));
        // Another walk's address read from its document carries no fragment (a browser never sends one): what the
        // fragment asked is one walk's reading, and the rest of the address is still read from the two.
        let unsent = plan_of("https://a.example/funds/uk#q=bonds&tab=all", &["https://a.example/funds/us"], "funds", &pairs(&[("q", "bonds"), ("tab", "all"), ("market", "uk")]), &[], Vec::new()).unwrap();
        assert_eq!(unsent.page, "https://a.example/funds/{market}#q={q}&tab={tab}");
        assert_eq!(unsent.asked.iter().map(|a| (a.slot.as_str(), a.by)).collect::<Vec<_>>(), [("market", route::AskedBy::TwoWalks), ("q", route::AskedBy::OneWalk), ("tab", route::AskedBy::OneWalk)]);
    }

    /// From the plan alone, the page for another word: the word at every place a slot was asked, and nothing when the
    /// plan was asked nothing.
    #[test]
    fn the_page_for_another_word_is_written_from_the_plan_alone() {
        let plan = plan_of("https://a.example/s?q=brass&sort=new", &[], "search", &pairs(&[("q", "brass")]), &[], Vec::new()).unwrap();
        assert_eq!(page_for_another_word(&plan, "zqx").as_deref(), Some("https://a.example/s?q=zqx&sort=new"));
        let none = plan_of("https://a.example/s?adults=2", &[], "search", &pairs(&[("adults", "2")]), &[], Vec::new()).unwrap();
        assert_eq!(page_for_another_word(&none, "zqx"), None);
    }

    /// One walk's capture in a folder of its own, read as a recording: the page, the call its script `app.js` sent, the
    /// script itself (which ships a table of cities and sends the city's code), and what the page kept in its storage
    /// when it settled and at the end.
    fn recorded_walk(name: &str, script: &str, frame: (usize, usize)) -> crate::recording::Recording {
        let dir = std::env::temp_dir().join(format!("compile-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            serde_json::json!({"type": "request", "t": 1.0, "requestId": "1", "method": "GET", "url": "https://shop.example/search?q=Lisbon", "headers": {}, "resourceType": "Document", "frameId": "MAIN", "initiator": {"type": "other"}}),
            serde_json::json!({"type": "response", "t": 1.5, "requestId": "1", "url": "https://shop.example/search?q=Lisbon", "status": 200, "mimeType": "text/html", "headers": {}, "body": "<html></html>"}),
            serde_json::json!({"type": "request", "t": 3.0, "requestId": "2", "method": "GET", "url": "https://shop.example/api/search?city=LIS&n=2", "headers": {}, "resourceType": "Fetch", "frameId": "MAIN",
                "initiator": {"type": "script", "frames": [{"scriptId": "7", "url": "https://shop.example/app.js", "function": "go", "line": frame.0, "column": frame.1}], "parents": []}}),
            serde_json::json!({"type": "response", "t": 3.5, "requestId": "2", "url": "https://shop.example/api/search?city=LIS&n=2", "status": 200, "mimeType": "application/json", "headers": {}, "body": r#"{"items":[{"name":"Lisbon hotel"}]}"#}),
            serde_json::json!({"type": "script", "t": 1.1, "scriptId": "7", "url": "https://shop.example/app.js", "language": "js", "sha256": crate::blobs::sha256_hex(script.as_bytes()), "length": script.len(), "source": script}),
            serde_json::json!({"type": "origin_storage", "t": 2.0, "at": "settle", "origin": "https://shop.example", "local": {"theme": "dark", "tok": "at-settle"}, "session": {"tab": "one"}}),
            serde_json::json!({"type": "origin_storage", "t": 5.0, "at": "end", "origin": "https://shop.example", "local": {"theme": "dark", "tok": "at-end", "late": "after-settle"}, "session": {}}),
        ];
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(agent_browser_core::session::capture_path(&dir, "w"), text).unwrap();
        let recording = crate::recording::Recording::read(&dir, "w").expect("the walk reads");
        let _ = std::fs::remove_dir_all(&dir);
        recording
    }

    const CITY_SCRIPT: &str = "var CITIES = [{ name: \"Lisbon\", code: \"LIS\" }, { name: \"Oslo\", code: \"OSL\" }, { name: \"Porto\", code: \"OPO\" }];\nfunction go(q) {\n  var code = CITIES.filter(function (c) { return c.name === q; })[0].code;\n  return fetch('/api/search?city=' + code + '&n=2');\n}\n";

    /// What the page kept in its storage when its call was made is read from its recording by origin: what it held when it
    /// settled, with what it stored by the end beside it (a key written later is still one the call could read), the
    /// settled value standing where both hold a key. A recording with nothing of the page's origin, or a page that is
    /// no address, says nothing.
    #[test]
    fn the_pages_storage_is_what_it_held_when_it_settled_with_what_it_stored_by_the_end() {
        let recording = recorded_walk("storage", CITY_SCRIPT, (3, 9));
        let kept = storage_when_called(&recording, "https://shop.example/search?q=Lisbon").expect("the origin kept storage");
        assert_eq!(kept.local, std::collections::HashMap::from([("theme".to_string(), "dark".to_string()), ("tok".to_string(), "at-settle".to_string()), ("late".to_string(), "after-settle".to_string())]));
        assert_eq!(kept.session, std::collections::HashMap::from([("tab".to_string(), "one".to_string())]));
        assert!(storage_when_called(&recording, "https://other.example/").is_none(), "another origin's storage is none of this page's");
        assert!(storage_when_called(&recording, "not an address").is_none());
    }

    /// A call whose recording names the script that sent it learns from that script: the table of cities it ships turns
    /// the caller's word into the city's code, as a lookup the route keeps, and the script's hash is noted on the step's
    /// test, so a deploy that changes the script is seen when the body is checked again. A walk of the page for another
    /// city is a sighting too.
    #[test]
    fn a_call_whose_sending_script_ships_a_table_learns_a_lookup_noted_against_that_script() {
        use crate::lab::sighting::tests::{call, trace};
        if !crate::sandbox::available() {
            eprintln!("no runtime on this machine: the table-reading test is skipped");
            return;
        }
        let line = CITY_SCRIPT.lines().position(|l| l.contains("fetch(")).unwrap();
        let column = CITY_SCRIPT.lines().nth(line).unwrap().find("fetch(").unwrap();
        let recording = recorded_walk("table", CITY_SCRIPT, (line, column));
        let mut first = recording.trace.as_ref().clone();
        first.inputs = vec![crate::trace::Input::new("q", "Lisbon")];
        let mut other_page = call("GET", "https://shop.example/search?q=Oslo", &[], None, "<html></html>");
        other_page.resource_type = Some("Document".into());
        let second = trace(vec![other_page, call("GET", "https://shop.example/api/search?city=OSL&n=2", &[], None, r#"{"items":[{"name":"Oslo hotel"}]}"#)]);
        let is_target = |e: &Exchange| e.url.path() == "/api/search";
        let stores = [None];
        let learned = body_by_example_stored(&first, "https://shop.example/search?q=Lisbon", &[&second], is_target, Some(&recording), &stores).expect("a body");
        let step = learned.body.steps.iter().find(|s| s.url.contains("/api/search")).expect("the search is a step");
        let city = step.holes.iter().find(|h| h.at == route::Place::Query("city".into())).unwrap_or_else(|| panic!("no hole at city: {}", serde_json::to_string(&learned.body).unwrap()));
        assert!(matches!(&city.ways[0].expr, Expr::Lookup { take, .. } if take == "/code"), "{:?}", city.ways[0].expr);
        assert_eq!(learned.body.asked(), ["q"]);
        let sha = crate::blobs::sha256_hex(CITY_SCRIPT.as_bytes());
        let test = learned.body.tests.iter().find(|t| t.step == step.id).expect("the step's test");
        assert_eq!(test.over_scripts, vec![sha], "the script that ships the table is noted on the step's test");
        assert_eq!(test.sightings.len(), 2, "a sighting a walk of the page");
        assert_eq!(learned.body.meaning.kinds.get("q"), Some(&route::meaning::Kind::Listed), "a word the site's table lists is one of its words");
        assert_eq!(learned.body.slots[0].choices, vec!["Lisbon".to_string(), "Oslo".to_string(), "Porto".to_string()]);
    }

    /// A learn from a walk of a page and another walk of it for another word writes a body asked that one word, and the
    /// size of the body and of the graph that says it is told as a person reads it: its steps, and the inputs it asks.
    #[test]
    fn a_learn_from_two_walks_of_a_page_tells_its_size_in_steps_and_inputs() {
        use crate::lab::sighting::tests::{call, trace};
        let walked = |word: &str, found: &str| {
            let mut page = call("GET", &format!("https://shop.example/p/search?q={word}"), &[], None, "<html></html>");
            page.resource_type = Some("Document".into());
            let hits = (0..6).map(|n| format!(r#"{{"name":"{found} number {n}"}}"#)).collect::<Vec<_>>().join(",");
            let mut t = trace(vec![page, call("GET", &format!("https://shop.example/api/search?q={word}"), &[], None, &format!(r#"{{"items":[{hits}]}}"#))]);
            t.inputs = vec![crate::trace::Input::new("q", word)];
            t
        };
        let (first, second) = (walked("lamp", "Desk lamp"), walked("sofa", "Red sofa"));
        let is_target = |e: &Exchange| e.url.path() == "/api/search";
        let learned = body_by_example(&first, "https://shop.example/p/search?q=lamp", &[&second], is_target, None).expect("a body");
        assert_eq!(learned.body.asked(), ["q"]);
        assert_eq!(counted_body(&learned.body), "1 step, 1 input");
        let graph = graph_by_example(&first, "https://shop.example/p/search?q=lamp", &[&second], is_target).expect("a graph says the body");
        assert_eq!(counted(&graph), "1 step, 1 input");
        assert_eq!(graph.steps.len(), 1);
        // Without the other walk, the same call is still one step and one input; a body of two inputs says both, plural.
        let two = {
            let mut t = first.clone();
            t.inputs.push(crate::trace::Input::new("page", "1"));
            t.exchanges[1].url = "https://shop.example/api/search?q=lamp&page=1".parse().unwrap();
            t.exchanges[0].url = "https://shop.example/p/search?q=lamp&page=1".parse().unwrap();
            t
        };
        let learned = body_by_example(&two, "https://shop.example/p/search?q=lamp&page=1", &[], is_target, None).expect("a body");
        assert_eq!(counted_body(&learned.body), "1 step, 2 inputs");
        assert_eq!(counted(&learned.graph.expect("a graph")), "1 step, 2 inputs");
    }

    /// The two walks of one page are one experiment, and neither is the earlier: a door that stopped the walk a corpus
    /// sorts first is no sighting of the page, so the same two walks asked the other way round settle on the page the
    /// site served (eBay Germany walls one walk and serves its results to the other, and the walled walk is the one
    /// whose folder sorts first). The page's own text sets each result of what it was asked, so the route is that
    /// page with the caller's word; where neither order settles, the reason is the one the first reading gave.
    #[test]
    fn a_door_that_stopped_one_walk_leaves_the_experiment_settling_the_other_way_round() {
        use crate::lab::sighting::tests::{call, trace, walk};
        let results = |word: &str| {
            let items: String = (0..6).map(|n| format!("<li><a href='/p/{word}{n}'>{word} machine number {n}</a></li>")).collect();
            format!("<html><head><title>{word} | results</title></head><body><main><h1>Results for {word}</h1><ul>{items}</ul></main></body></html>")
        };
        let page = |word: &str| {
            let mut e = call("GET", &format!("https://shop.example/s?q={word}"), &[], None, &results(word));
            e.response_mime = "text/html".into();
            e.resource_type = Some("Document".into());
            e.main_frame = Some(true);
            e
        };
        let door = |word: &str| {
            let mut e = call("GET", &format!("https://shop.example/s?q={word}"), &[], None, "<html><body><p>Access denied: a check is running</p></body></html>");
            e.status = 403;
            e.response_mime = "text/html".into();
            e.resource_type = Some("Document".into());
            e.main_frame = Some(true);
            e
        };
        let (stopped, served) = (trace(vec![door("glass")]), trace(vec![page("brass")]));
        let walled_first = [walk(&stopped, &[("q", "glass")]), walk(&served, &[("q", "brass")])];
        assert!(settle(&walled_first).is_err(), "the walled walk first settles nothing as the experiment reads it");
        let body = learn(&walled_first, "shop.example").expect("the same experiment settles the other way round");
        assert_eq!(body.steps.iter().map(|s| s.url.as_str()).collect::<Vec<_>>(), ["https://shop.example/s"], "the route is the page the site served");
        assert_eq!(body.asked(), ["q"]);
        assert!(body.answer.page, "the page's own text is the answer");
        // Written from the walk that was served, the same route is what the other order writes.
        let served_first = [walk(&served, &[("q", "brass")]), walk(&stopped, &[("q", "glass")])];
        assert_eq!(learn(&served_first, "shop.example").map(|b| (b.steps.len(), b.asked().join(","))).ok(), Some((body.steps.len(), body.asked().join(","))));
        // Two walks that settle nothing either way round say why as the first reading said it.
        let (one, two) = (trace(vec![page("brass")]), trace(vec![page("glass")]));
        let shells = [walk(&one, &[("q", "brass")]), walk(&two, &[("q", "glass")])];
        let said = learn(&shells, "shop.example").expect_err("a page that answers both values settles nothing");
        assert_eq!(said, Unlearned::Unsettled(settle(&shells).expect_err("nothing settled")));
    }

    /// Why a learn wrote no route is said in plain words: the walks settled no answer, with what unsettled them; or the
    /// answer's call could not be written as a step, naming its place.
    #[test]
    fn why_a_learn_wrote_no_route_is_said_in_words() {
        use crate::lab::sighting::tests::{call, trace, walk};
        assert_eq!(Unlearned::Unwritten(3).to_string(), "call 3 of the first walk could not be written as a step");
        let first = trace(vec![call("GET", "https://shop.example/api/search?q=lamp", &[], None, "{}")]);
        let err = learn(&[walk(&first, &[("q", "lamp")])], "shop.example").expect_err("one walk settles nothing");
        assert_eq!(err, Unlearned::Unsettled(crate::lab::answer::Unsettled::OneWalk));
        assert!(err.to_string().starts_with("the walks settle no answer: "), "{err}");
    }

    /// A step is written by the kind of body its call sent: a form's fields (the asked field a hole, a field the walks
    /// agree on its own fixed text), a body that is neither JSON nor a form kept as one the learner does not write, a
    /// multipart body the same, and a JSON leaf the caller makes keeps the kind the walk sent it as.
    #[test]
    fn a_step_is_written_by_the_kind_of_body_its_call_sent() {
        use crate::lab::sighting::tests::{call, trace, walk};
        let step_of_bodies = |content_type: &str, bodies: [&str; 2], asked: [&[(&str, &str)]; 2]| {
            let walked = |body: &str| trace(vec![call("POST", "https://shop.example/api/send", &[("content-type", content_type)], Some(body), r#"{"ok":true}"#)]);
            let (first, second) = (walked(bodies[0]), walked(bodies[1]));
            let walks = [walk(&first, asked[0]), walk(&second, asked[1])];
            step(&Lab::new(&walks), 0).expect("a step")
        };
        let form = step_of_bodies("application/x-www-form-urlencoded", ["q=lamp&page=1", "q=sofa&page=1"], [&[("q", "lamp")], &[("q", "sofa")]]);
        let Some(route::Form::Fields { fields }) = &form.body else { panic!("{:?}", form.body) };
        assert!(fields.contains(&("q".to_string(), None)) && fields.contains(&("page".to_string(), Some("1".to_string()))), "{fields:?}");
        assert_eq!(form.holes.iter().map(|h| h.at.clone()).filter(|at| matches!(at, route::Place::Form(_))).collect::<Vec<_>>(), vec![route::Place::Form("q".into())], "the asked field is the one field made for the call");
        let text = step_of_bodies("text/plain", ["hello there", "hello again"], [&[("q", "lamp")], &[("q", "sofa")]]);
        assert_eq!(text.body, Some(route::Form::Other), "a body no reader opens is one the learner does not write");
        let multipart = |word: &str| format!("--XyZ\r\nContent-Disposition: form-data; name=\"q\"\r\n\r\n{word}\r\n--XyZ--\r\n");
        let parts = step_of_bodies("multipart/form-data; boundary=XyZ", [&multipart("lamp"), &multipart("sofa")], [&[("q", "lamp")], &[("q", "sofa")]]);
        assert_eq!(parts.body, Some(route::Form::Other), "a multipart body is not written yet");
        let json = step_of_bodies("application/json", [r#"{"term":"lamp","page":2,"exact":false}"#, r#"{"term":"sofa","page":3,"exact":true}"#], [&[("term", "lamp"), ("page", "2"), ("exact", "false")], &[("term", "sofa"), ("page", "3"), ("exact", "true")]]);
        let Some(route::Form::Json { template, types, .. }) = &json.body else { panic!("{:?}", json.body) };
        assert_eq!(template, &serde_json::json!({"term": null, "page": null, "exact": null}));
        assert_eq!(types.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(), [("/exact", "bool"), ("/page", "number"), ("/term", "string")]);
    }

    /// Whether a step writes is read from the body it sends as the ledger's one rule reads it, whatever the body's kind:
    /// a form's fixed field, a multipart part's JSON or text, a binary body's field, and a route's own text beside the
    /// template (a hole whose way is a fixed text) all say what the call asks. A POST that asks a GraphQL query reads;
    /// one that holds a mutation anywhere writes.
    #[test]
    fn a_post_is_a_read_by_whatever_body_says_its_query_and_a_write_where_any_says_a_mutation() {
        use route::{Expr, Form, Hole, Part, Place, Way};
        let post = |url: &str, body: Option<Form>, holes: Vec<Hole>| route::Step { id: "x0".into(), method: "POST".into(), url: url.into(), holes, body, expect: 200, script: None, page: false, writes: true, on_load: false, sets_cookie: false, lifetime: None, shape: None };
        let text = |at: Place, is: &str| Hole { at, ways: vec![Way { rung: 0, expr: Expr::text(is) }], over: false, open: false };
        const ASKS: &str = "query Find { find { id } }";
        const CHANGES: &str = "mutation Add { add { ok } }";
        let graphql = "https://shop.example/graphql";
        let fields = |q: &str| Some(Form::Fields { fields: vec![("query".into(), Some(q.into())), ("note".into(), None)] });
        assert!(!writes(&post(graphql, fields(ASKS), Vec::new())), "a form that asks a query");
        assert!(writes(&post(graphql, fields(CHANGES), Vec::new())), "a form that holds a mutation");
        let multipart = |part: Part| Some(Form::Multipart { boundary: "b".into(), parts: vec![part] });
        let part = |name: &str| Part { name: name.into(), filename: None, content_type: None, text: None, json: None, types: Default::default() };
        assert!(!writes(&post(graphql, multipart(Part { text: Some(ASKS.into()), ..part("operations") }), Vec::new())), "a part's text that asks");
        assert!(writes(&post(graphql, multipart(Part { text: Some(CHANGES.into()), ..part("operations") }), Vec::new())), "a part's text that changes");
        assert!(!writes(&post(graphql, multipart(Part { json: Some(serde_json::json!({"query": ASKS})), ..part("operations") }), Vec::new())), "a part's JSON that asks");
        assert!(writes(&post(graphql, multipart(Part { json: Some(serde_json::json!({"query": CHANGES})), ..part("operations") }), Vec::new())), "a part's JSON that changes");
        let message = |word: &str| {
            let mut b = vec![0x0a, word.len() as u8];
            b.extend(word.as_bytes());
            b
        };
        let wire = |word: &str| Some(Form::Wire { codec: route::wire::Codec::Protobuf, template: route::wire::open(route::wire::Codec::Protobuf, &message(word)).expect("the message opens") });
        assert!(!writes(&post(graphql, wire(ASKS), Vec::new())), "a binary body's field that asks");
        assert!(writes(&post(graphql, wire(CHANGES), Vec::new())), "a binary body's field that changes");
        // A route's own text at a place of the call is what the call says, wherever the place is.
        let own = |at: Place, is: &str| writes(&post(graphql, None, vec![text(at, is)]));
        assert!(!own(Place::Json("/query".into()), ASKS) && own(Place::Json("/query".into()), CHANGES));
        assert!(!own(Place::Form("query".into()), ASKS) && own(Place::Form("query".into()), CHANGES));
        assert!(!own(Place::Part("operations".into(), "/query".into()), ASKS) && own(Place::Part("operations".into(), "/query".into()), CHANGES));
        assert!(!own(Place::Query("query".into()), ASKS) && own(Place::Query("query".into()), CHANGES));
        // A text joined around the caller's word is the route's own text; the caller's word is none of it.
        let joined = Hole { at: Place::Json("/query".into()), ways: vec![Way { rung: 0, expr: Expr::Join { parts: vec![Expr::text("mutation Add { add(q: \""), Expr::Slot { name: "q".into(), or: None, optional: false }, Expr::text("\") { ok } }")], with: String::new() } }], over: false, open: false };
        assert!(writes(&post(graphql, None, vec![joined])), "the fixed pieces around a word say a mutation");
        let by_the_caller = Hole { at: Place::Json("/query".into()), ways: vec![Way { rung: 0, expr: Expr::Slot { name: "q".into(), or: Some(CHANGES.into()), optional: false } }], over: false, open: false };
        assert!(writes(&post(graphql, None, vec![by_the_caller])), "a POST nothing says asks is a write: the caller's value proves nothing");
    }

    /// A call a script made goes out from the page that made it: the origin the call names, or else the origin of the page
    /// that referred it; a page asked for as a page has no script's origin at all.
    #[test]
    fn a_call_a_script_made_is_said_to_come_from_the_page_that_sent_it() {
        use crate::lab::sighting::tests::{call, trace, walk};
        let step_of = |headers: &[(&str, &str)], resource_type: &str| {
            let mut e = call("GET", "https://api.shop.example/find?q=lamp", headers, None, "{}");
            e.resource_type = Some(resource_type.into());
            let t = trace(vec![e]);
            step(&Lab::new(&[walk(&t, &[("q", "lamp")])]), 0).expect("a step")
        };
        assert_eq!(step_of(&[("origin", "https://www.shop.example")], "Fetch").script, Some(route::Caller { origin: Some("https://www.shop.example".into()) }));
        assert_eq!(step_of(&[("referer", "https://www.shop.example/p/1?x=2")], "XHR").script, Some(route::Caller { origin: Some("https://www.shop.example".into()) }));
        assert_eq!(step_of(&[], "XHR").script, Some(route::Caller { origin: None }), "a script's call that names no page");
        assert_eq!(step_of(&[("origin", "https://www.shop.example")], "Document").script, None, "a page is asked for as a page");
    }
}
