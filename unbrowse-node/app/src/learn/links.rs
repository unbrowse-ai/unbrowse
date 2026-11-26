//! The links of a route, proposed and verified. A route is a chain of calls whose values are tied together by what
//! one walk showed: a value an earlier answer held and a later request sent is read from that answer from then on.
//! One walk cannot say which of those ties are real. A number an advert service answered with and the search also
//! sends, a tracing header the page writes, a request id a server stamps: each is kept as a link or as a value only
//! the page can make, and a route that carries them fails when any of them does.
//!
//! So the chain is laid out for a proposer, one row for every value that is not plainly fixed or the caller's: where
//! it sits, what it is now, what the walk sent there, and which step it is read from. The proposer says of each
//! whether to keep the tie, send the walked value as it was, or leave the value out. The engine applies that to the
//! same graph, drops the steps nothing reads any more, and asks the site: the route as walked, and for a second
//! word. It is kept only if both answer and the second answer is its own. Learn time only; nothing here is in the
//! call path, and a proposal the site does not bear out changes nothing.
//!
//! Two walks say some of it before anyone is asked. A learn walks its page a second time for another word, in the
//! same session. A value both walks sent the same did not move with the word or with the clock, whatever one walk
//! tied it to; a header that differs between them and that neither walk shows a source for is written fresh on each
//! load. That is measured (`measured`), applied to the same graph and put to the site first (`by_two_walks`), with
//! no proposer. What two walks leave open is the proposer's, who is shown both values.

use super::*;
use unbrowse_learn::{Class, Field, Graph, Loc, Step};

/// What a proposer is asked of a chain.
const LINKS: &str = "This is a chain of HTTP calls a website's page made, ending in the call that answers the goal (the last step). Each step lists the values it sends that are not plainly fixed: where the value sits (at), what the engine took it for (now: `from_step` it is read from an earlier step's answer, `page` only the page's own code can make it, `walked` it was seen once with no source, `session` the browser's session holds it), the value the walk sent, the value a second walk of the same page sent there when it was asked another word in the same session (`again`, where there was one: the same value twice did not move with the word or the time; two values with no source are written fresh on each load), and for `from_step` the step it is read from. Many ties are chance: an unrelated service answered with the same number, a tracing or telemetry header, a request id. Say for each value what a plain replay should do: `keep` (the tie is real: the value changes from call to call and the later call needs the fresh one, such as an operation's signature, a token or an id read from the site's own page), `fixed` (send the walked value as it was: a setting, a version, a number of no consequence), or `drop` (a header the site does not need: tracing, telemetry, request ids; headers only), or `session` (a header whose value the page keeps in its own storage, shown as page_keeps_it_as: the browser's session holds it and it is sent from there), or `input:<name>` (the value is what the caller asked for, under the name of an input the route already takes, where the walked value is exactly that input's). A value that is a plain name or word (an operation's name, an app's name, a language, a version) is `fixed` even where an earlier answer happens to contain the same word: that tie is chance. Prefer the fewest steps: a step on another site, or a report or sensor post, is almost never needed for the answer. Reply with JSON only: {\"fields\":[{\"step\":<step>,\"at\":\"<at>\",\"is\":\"keep|fixed|drop|session|input:<name>\"}]}, listing only the values you would change from what they are now.";

/// How a place in a request is named to a proposer: `header:x-request-id`, `json:/variables/id`.
pub(super) fn place(loc: &Loc) -> String {
    let v = serde_json::to_value(loc).unwrap_or_default();
    let key = match &v["key"] {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    };
    format!("{}:{key}", v["in"].as_str().unwrap_or_default())
}

/// The walk's own sighting of the call `step` stands for. Several calls may share its address (the operations of
/// one GraphQL endpoint): the sighting is the one that sends the most of what the step fixes, a query's text or an
/// operation's name among them.
pub(super) fn sighting<'t>(walked: &'t Trace, step: &Step) -> Option<&'t Exchange> {
    let fixed: Vec<(&Loc, &String)> = step
        .fields
        .iter()
        .filter_map(|f| match &f.class {
            Class::Constant { value, .. } | Class::Unconfirmed { value } => Some((&f.loc, value)),
            _ => None,
        })
        .collect();
    walked
        .exchanges
        .iter()
        .filter(|e| (200..300).contains(&e.status) && same_call(step, &e.method, &e.url, e.request_body.as_deref()))
        .map(|e| {
            let sent = unbrowse_learn::slots::slots(e);
            let agree = fixed.iter().filter(|(loc, value)| sent.iter().any(|s| s.loc == **loc && s.value == **value)).count();
            // Where what the step fixes does not tell two operations apart (its name and text are read from
            // elsewhere), the shape of what it sends does: the places in its body, against the places in theirs.
            // Each place of the step's the request also has counts for it, each place of either's the other lacks
            // against, so a request with other variables is never taken for this step's.
            let in_body = |loc: &Loc| matches!(loc, Loc::Json(_) | Loc::Form(_));
            let ours: Vec<&Loc> = step.fields.iter().map(|f| &f.loc).filter(|l| in_body(l)).collect();
            let theirs: Vec<&Loc> = sent.iter().map(|s| &s.loc).filter(|l| in_body(l)).collect();
            let shared = ours.iter().filter(|l| theirs.contains(l)).count() as i64;
            let apart = (ours.len() as i64 - shared) + (theirs.len() as i64 - shared);
            ((agree, shared - apart), e)
        })
        // The first of those that agree most: a later repeat of the call is its next page.
        .fold(None, |best: Option<((usize, i64), &Exchange)>, (n, e)| if best.is_none_or(|(most, _)| n > most) { Some((n, e)) } else { best })
        .map(|(_, e)| e)
}

/// The call `step` stands for, as a walk of the same page for another word made it: the request of `again` that is
/// the same call as the first walk's sighting of the step, by the one reader for that
/// (`graph::the_same_call_there`). `asked` is what the first walk's page was asked: where a piece of the call's own
/// path is one of those, the other walk's differs there and is the same call still.
fn sighting_again<'t>(walked: &Trace, again: &'t Trace, step: &Step, asked: &[String]) -> Option<&'t Exchange> {
    let first = sighting(walked, step)?;
    let at = walked.exchanges.iter().position(|e| std::ptr::eq(e, first))?;
    let there = unbrowse_learn::graph::the_same_call_there(walked, at, again, asked, None)?;
    again.exchanges.get(there).filter(|e| (200..300).contains(&e.status))
}

/// What a route's page was asked, as its graph holds it: each input's walked value, and each caller's value the
/// graph writes inside a longer one.
fn asked_of(graph: &Graph) -> Vec<String> {
    let mut asked: Vec<String> = Vec::new();
    for step in &graph.steps {
        let inputs = step.fields.iter().filter_map(|f| match &f.class {
            Class::Input { default: Some(value), secret: false, .. } => Some(value.clone()),
            _ => None,
        });
        for value in inputs.chain(step.held.iter().map(|h| h.sits.clone())) {
            if !asked.contains(&value) {
                asked.push(value);
            }
        }
    }
    asked
}

/// What the walk sent at `loc` on the call `step` stands for.
/// A value by its shape alone: `{session}`, its length, and what it is written in.
fn shape_of(value: &str) -> String {
    let all = |f: fn(char) -> bool| !value.is_empty() && value.chars().all(f);
    let written = if all(|c| c.is_ascii_digit()) {
        "digits"
    } else if all(|c| c.is_ascii_hexdigit() || c == '-') {
        "hex"
    } else if all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '+' | '/')) {
        "letters and digits"
    } else {
        "text"
    };
    format!("{{session}} ({} characters, {written})", value.chars().count())
}

pub(super) fn walked_at(walked: &Trace, step: &Step, loc: &Loc) -> Option<String> {
    unbrowse_learn::slots::slots(sighting(walked, step)?).into_iter().find(|s| s.loc == *loc).map(|s| s.value)
}

/// The chain as a proposer reads it.
/// The key the page keeps `value` under in its own storage, when it keeps it whole: the session's, wherever a
/// request then sends it.
fn stored_as(stored: &unbrowse_learn::sandbox::Storage, value: &str) -> Option<String> {
    if value.chars().count() < 8 {
        return None;
    }
    stored.local.iter().chain(stored.session.iter()).find(|(_, kept)| kept.as_str() == value || kept.trim_matches('"') == value).map(|(key, _)| key.clone())
}

/// Whether `text` is, carries, or is a piece of something the page keeps in its storage: kept whole inside a longer
/// value a request sends, or sent as one part of what is kept.
fn of_the_store(stored: &unbrowse_learn::sandbox::Storage, text: &str) -> bool {
    let kept: Vec<String> = stored.local.values().chain(stored.session.values()).map(|k| k.trim_matches('"').to_string()).filter(|k| k.chars().count() >= 8).collect();
    super::sitegraph::of_the_session(text, &kept) || (text.chars().count() >= 8 && kept.iter().any(|k| k.contains(text)))
}

pub(super) fn chain_of(graph: &Graph, walked: &Trace, again: Option<&Trace>, stored: &unbrowse_learn::sandbox::Storage, goal: &str) -> serde_json::Value {
    let home = graph.steps.last().and_then(|s| unbrowse_learn::replay::step_host(&s.url)).unwrap_or_default();
    let step_of = |exchange: usize| graph.steps.iter().position(|s| s.exchange == exchange);
    let asked = asked_of(graph);
    // What the site gave the session to hold and hand back (a cookie's value, a token an answer delivered) is told to
    // a proposer by its shape, never shown: how long it is and what it is written in say whether it is a key, and
    // the key itself is the owner's.
    let held = unbrowse_learn::provenance::session_values(walked);
    let cut = |v: String| {
        // What the page keeps in its storage is the session's too, as an agent's script is shown it.
        if super::sitegraph::of_the_session(&v, &held) || of_the_store(stored, &v) || super::sitegraph::reads_as_a_key(&v) {
            return shape_of(&v);
        }
        if v.chars().count() > 60 { format!("{}…", v.chars().take(60).collect::<String>()) } else { v }
    };
    // The name the page keeps a value under is the page's to choose, so it is read by the same rule as a value: a
    // name that is itself what the session holds, what the page stores, or written as a key, is not shown.
    let named = |key: String| if super::sitegraph::of_the_session(&key, &held) || of_the_store(stored, &key) || super::sitegraph::reads_as_a_key(&key) { "{session}".to_string() } else { key };
    let steps: Vec<serde_json::Value> = graph
        .steps
        .iter()
        .enumerate()
        .map(|(n, step)| {
            let own = unbrowse_learn::replay::step_host(&step.url).is_some_and(|h| unbrowse_learn::identity::same_site(&h, &home));
            let resent_all: Option<Vec<unbrowse_learn::slots::Slot>> = again.and_then(|t| sighting_again(walked, t, step, &asked)).map(unbrowse_learn::slots::slots);
            let mut rows: Vec<serde_json::Value> = Vec::new();
            for f in step.fields.iter().filter(|f| !matches!(f.loc, Loc::Cookie(_))) {
                let (now, from) = match &f.class {
                    Class::Derived { origin } => ("from_step", step_of(origin.exchange)),
                    Class::Unconfirmed { .. } => ("walked", None),
                    Class::Computed | Class::Script { .. } | Class::Generated { .. } | Class::Recipe { .. } => ("page", None),
                    Class::Minted { .. } => ("session", None),
                    _ => continue,
                };
                let value = match &f.class {
                    Class::Unconfirmed { value } => Some(value.clone()),
                    _ => walked_at(walked, step, &f.loc),
                };
                let kept = value.as_deref().and_then(|v| stored_as(stored, v));
                // The session's own value is named by its shape whatever the walk can trace of it.
                let value = if now == "session" { value.as_deref().map(shape_of) } else { value.map(cut) };
                let resent = resent_all.as_ref().and_then(|all| all.iter().find(|s| s.loc == f.loc).map(|s| s.value.clone()));
                let resent = if now == "session" { resent.as_deref().map(shape_of) } else { resent.map(cut) };
                rows.push(serde_json::json!({ "at": place(&f.loc), "now": now, "value": value, "again": resent, "from_step": from, "page_keeps_it_as": kept.map(named) }));
            }
            for p in step.page_producers.iter().filter(|p| !step.fields.iter().any(|f| f.loc == p.loc)) {
                let value = walked_at(walked, step, &p.loc);
                let kept = value.as_deref().and_then(|v| stored_as(stored, v));
                let resent = resent_all.as_ref().and_then(|all| all.iter().find(|s| s.loc == p.loc).map(|s| s.value.clone()));
                rows.push(serde_json::json!({ "at": place(&p.loc), "now": "page", "value": value.map(cut), "again": resent.map(cut), "from_step": null, "page_keeps_it_as": kept.map(named) }));
            }
            rows.truncate(80);
            // The call's address is read by the same rule as its values: a piece of it the session holds, or the
            // page keeps in its storage, is named and never shown, whatever put it there.
            let call = super::sitegraph::path_shown(step.url.split('?').next().unwrap_or_default(), |piece| super::sitegraph::of_the_session(piece, &held) || of_the_store(stored, piece));
            serde_json::json!({ "step": n, "call": format!("{} {call}", step.method), "site": if own { "the page's own" } else { "another site" }, "values": rows })
        })
        .collect();
    serde_json::json!({ "goal": goal, "steps": steps })
}

/// One thing a proposer said of one value.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Said {
    step: usize,
    at: String,
    is: String,
}

/// What a proposer said, wherever the JSON sits in what it wrote. Anything not of the asked shape is left out.
pub(super) fn said_in(text: &str) -> Vec<Said> {
    let parsed: Option<serde_json::Value> = text.find('{').zip(text.rfind('}')).and_then(|(a, b)| serde_json::from_str(text.get(a..=b)?).ok());
    parsed
        .as_ref()
        .and_then(|v| v["fields"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|f| Some(Said { step: f["step"].as_u64()? as usize, at: f["at"].as_str()?.to_string(), is: f["is"].as_str()?.to_string() }))
        .filter(|s| a_saying(&s.is))
        .collect()
}

/// Whether `is` is something that can be said of a value: `keep`, `fixed`, `drop`, `session`, `input:<name>`, or
/// `from:<step>:<pointer>` (read from the JSON answer of an earlier step, at that pointer).
fn a_saying(is: &str) -> bool {
    matches!(is, "keep" | "fixed" | "drop" | "session") || is.starts_with("input:") || read_from(is).is_some()
}

/// The step and the JSON pointer of a `from:<step>:<pointer>`, the step as the chain numbers it from 0.
fn read_from(is: &str) -> Option<(usize, &str)> {
    let (step, pointer) = is.strip_prefix("from:")?.split_once(':')?;
    (pointer.is_empty() || pointer.starts_with('/')).then_some((step.trim().parse().ok()?, pointer))
}

impl Said {
    /// One thing said of one value, when it is something that can be said (`a_saying`).
    pub(super) fn new(step: usize, at: &str, is: &str) -> Option<Said> {
        a_saying(is).then(|| Said { step, at: at.to_string(), is: is.to_string() })
    }
}

/// `graph` as a proposer would have it. A value is fixed only where the walk shows what was sent; only a header is
/// dropped; a step whose page-made values are all gone is a plain step; and a step nothing reads from any more,
/// other than the last, is left out (a cookie it set is the session's).
pub(super) fn applied(graph: &Graph, walked: &Trace, stored: &unbrowse_learn::sandbox::Storage, said: &[Said]) -> Graph {
    let mut g = graph.clone();
    // The caller's values as the route already takes them, by name: a value may be named an input only where the
    // walk sent exactly what one of them was. Nothing new is the caller's on a proposer's word alone.
    let inputs: Vec<(String, String)> = graph
        .steps
        .iter()
        .flat_map(|s| &s.fields)
        .filter_map(|f| match &f.class {
            Class::Input { name, default: Some(value), secret: false, .. } => Some((name.clone(), value.clone())),
            _ => None,
        })
        .collect();
    for s in said {
        let Some(step) = g.steps.get_mut(s.step) else { continue };
        let Some(loc) = step.fields.iter().map(|f| f.loc.clone()).chain(step.page_producers.iter().map(|p| p.loc.clone())).find(|l| place(l) == s.at) else { continue };
        match s.is.as_str() {
            "drop" if matches!(loc, Loc::Header(_)) => {
                step.fields.retain(|f| f.loc != loc);
                step.page_producers.retain(|p| p.loc != loc);
            }
            "fixed" => {
                let known = step.fields.iter().find(|f| f.loc == loc).and_then(|f| if let Class::Unconfirmed { value } = &f.class { Some(value.clone()) } else { None });
                let Some(value) = known.or_else(|| walked_at(walked, step, &loc)) else { continue };
                step.page_producers.retain(|p| p.loc != loc);
                match step.fields.iter_mut().find(|f| f.loc == loc) {
                    Some(f) => f.class = Class::Unconfirmed { value },
                    None => step.fields.push(Field { loc, class: Class::Unconfirmed { value } }),
                }
            }
            // A reading of the clock the call makes for itself: the walked value, read anew on each call where the
            // walk's own reading stood. Which digits those are is `fresh`'s to say, from the walk.
            "clock" => {
                let Some(value) = walked_at(walked, step, &loc) else { continue };
                let Some(i) = sighting(walked, step).and_then(|e| walked.exchanges.iter().position(|x| std::ptr::eq(x, e))) else { continue };
                let Some((id, clock)) = unbrowse_learn::fresh::reading_of(walked, i, &value) else { continue };
                step.page_producers.retain(|p| p.loc != loc);
                let class = Class::Fresh { value, id, clock };
                match step.fields.iter_mut().find(|f| f.loc == loc) {
                    Some(f) => f.class = class,
                    None => step.fields.push(Field { loc, class }),
                }
            }
            // The session's: only a header, and only where the page's own storage holds exactly what the walk sent.
            // It is then sent from the jar by the header's name, as a cookie is.
            "session" => {
                let Loc::Header(name) = &loc else { continue };
                let Some(value) = walked_at(walked, step, &loc) else { continue };
                if stored_as(stored, &value).is_none() {
                    continue;
                }
                let class = Class::Minted { name: name.to_ascii_lowercase() };
                step.page_producers.retain(|p| p.loc != loc);
                match step.fields.iter_mut().find(|f| f.loc == loc) {
                    Some(f) => f.class = class,
                    None => step.fields.push(Field { loc: loc.clone(), class }),
                }
            }
            // Read from an earlier step's answer: only where the walk bears it out. That step's answer, at that place,
            // must hold exactly what the walk then sent here. A tie nobody saw is not written on anyone's word.
            from if read_from(from).is_some() => {
                let Some((source, pointer)) = read_from(from) else { continue };
                if source >= s.step {
                    continue;
                }
                let Some(sent) = walked_at(walked, &graph.steps[s.step], &loc) else { continue };
                let Some(origin) = graph.steps.get(source) else { continue };
                let held = sighting(walked, origin).and_then(|e| e.own_json()).and_then(|answer| answer.pointer(pointer).map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())));
                if held.as_deref() != Some(sent.as_str()) {
                    continue;
                }
                let class = Class::Derived { origin: unbrowse_learn::provenance::Origin { exchange: origin.exchange, url: origin.url.split('?').next().unwrap_or_default().to_string(), at: unbrowse_learn::provenance::At::Json { pointer: pointer.to_string() }, wrap: None } };
                step.page_producers.retain(|p| p.loc != loc);
                match step.fields.iter_mut().find(|f| f.loc == loc) {
                    Some(f) => f.class = class,
                    None => step.fields.push(Field { loc, class }),
                }
            }
            named if named.starts_with("input:") => {
                let name = &named["input:".len()..];
                let sent = step.fields.iter().find(|f| f.loc == loc).and_then(|f| if let Class::Unconfirmed { value } | Class::Constant { value, .. } = &f.class { Some(value.clone()) } else { None }).or_else(|| walked_at(walked, step, &loc));
                let Some((_, value)) = inputs.iter().find(|(n, v)| n == name && sent.as_ref().is_some_and(|s| s.eq_ignore_ascii_case(v))) else { continue };
                let class = Class::Input { name: name.to_string(), secret: false, default: Some(value.clone()), optional: false };
                step.page_producers.retain(|p| p.loc != loc);
                match step.fields.iter_mut().find(|f| f.loc == loc) {
                    Some(f) => f.class = class,
                    None => step.fields.push(Field { loc, class }),
                }
            }
            _ => {}
        }
    }
    for step in g.steps.iter_mut() {
        let signed = !step.page_producers.is_empty() || step.fields.iter().any(|f| matches!(f.class, Class::Computed | Class::Script { .. }));
        step.page_signed = signed;
        step.needs_browser = signed;
    }
    let Some(target) = g.steps.last().map(|s| s.exchange) else { return g };
    let mut needed = vec![target];
    let mut at = 0;
    while at < needed.len() {
        // A step the page still makes takes the page's own request whole: nothing before it feeds it.
        if let Some(step) = g.steps.iter().find(|s| s.exchange == needed[at]).filter(|s| !s.is_page_signed()) {
            for f in step.fields.iter().filter(|f| !matches!(f.loc, Loc::Cookie(_))) {
                if let Class::Derived { origin } = &f.class {
                    if !needed.contains(&origin.exchange) && g.steps.iter().any(|s| s.exchange == origin.exchange) {
                        needed.push(origin.exchange);
                    }
                }
            }
        }
        at += 1;
    }
    g.steps.retain(|s| needed.contains(&s.exchange));
    // What a kept step read from one now left out: the walked value where the walk shows it (the step is found
    // among the page's calls by its address and its names), else not sent.
    for step in g.steps.iter_mut() {
        let own = step.clone();
        step.fields.retain_mut(|f| match (&f.loc, &f.class) {
            (Loc::Cookie(_), _) => true,
            (loc, Class::Derived { origin }) if !needed.contains(&origin.exchange) => match walked_at(walked, &own, loc) {
                Some(value) if !matches!(loc, Loc::Header(_)) => {
                    f.class = Class::Unconfirmed { value };
                    true
                }
                _ => false,
            },
            _ => true,
        });
    }
    for f in g.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
        if let (Loc::Cookie(name), Class::Derived { origin }) = (&f.loc, &f.class) {
            if !needed.contains(&origin.exchange) {
                f.class = Class::Minted { name: name.clone() };
            }
        }
    }
    if !g.steps.iter().any(|s| s.is_page_signed()) {
        g.scripts.clear();
        g.api.clear();
    }
    g.provisional = g.steps.iter().flat_map(|s| &s.fields).any(|f| matches!(f.class, Class::Unconfirmed { .. }));
    g
}

/// Whether `walk` shows `value` in an answer before it sent `sent`: a source it could have been read from.
fn seen_before(walk: &Trace, sent: &Exchange, value: &str) -> bool {
    value.chars().count() >= 8 && walk.exchanges.iter().take_while(|e| !std::ptr::eq(*e, sent)).any(|e| e.response_body.as_deref().is_some_and(|b| b.contains(value)))
}

/// What two walks of one page say of a chain, with no proposer: `walked` and `again`, asked two different words in
/// one session. Of each value the page makes, or that one walk tied to an earlier answer or saw with no source:
///
/// - both walks sent it the same: it did not move with the word or the clock, so it is sent as walked (`fixed`), or
///   from the session where the page keeps exactly that in its storage (`session`, a header). A tie to an earlier
///   answer that never moved carries nothing a replay needs;
/// - the two sent it differently, and the second walk shows the value it sent in an answer before it: the tie holds
///   on both walks and is left as it is (a region read for a city, an id for a name);
/// - the two sent it differently, and the second's is the first's with the second walk's word where the first
///   walk's sat, in a value the step already writes the caller's word into (`held`): it is the caller's word in a
///   wrapping of the page's (its own address, sent along), not a read, whatever earlier answer says it back. It is
///   sent as walked, and the word is written into it at call time as it already is (`fixed`);
/// - a header the two sent differently, that the second walk shows no source for and the page does not keep:
///   written fresh on each load (`drop`). Whether the site needs it is the site's to say.
///
/// Everything the second walk never sent is left alone: a step it did not make says nothing. A value that lasts
/// the session and no longer is sent as walked here, and a route holding one says so (`provisional`); the site's
/// answer to a later call is what finds it out.
pub(super) fn measured(graph: &Graph, walked: &Trace, again: &Trace, stored: &unbrowse_learn::sandbox::Storage, asked: &[String], word: &str) -> Vec<Said> {
    // Whether `b` is `a` with the second walk's word where one of the first walk's sat, as written or as an address
    // writes it.
    let the_word_moved = |a: &str, b: &str| {
        let enc = |w: &str| percent_encoding::utf8_percent_encode(w, percent_encoding::NON_ALPHANUMERIC).to_string();
        asked.iter().filter(|w| w.chars().count() >= 2).any(|w| a.replace(w.as_str(), word) == b || a.replace(&enc(w), &enc(word)) == b || a.replace(&w.replace(' ', "+"), &word.replace(' ', "+")) == b)
    };
    let mut said = Vec::new();
    for (n, step) in graph.steps.iter().enumerate() {
        let (Some(first), Some(second)) = (sighting(walked, step), sighting_again(walked, again, step, asked)) else { continue };
        let (sent, resent) = (unbrowse_learn::slots::slots(first), unbrowse_learn::slots::slots(second));
        let at = |all: &[unbrowse_learn::slots::Slot], loc: &Loc| all.iter().find(|s| s.loc == *loc).map(|s| s.value.clone());
        let read_anew = |first: &Exchange, a: &str, second: &Exchange, b: &str| {
            let (i, j) = (walked.exchanges.iter().position(|e| std::ptr::eq(e, first)), again.exchanges.iter().position(|e| std::ptr::eq(e, second)));
            i.zip(j).is_some_and(|(i, j)| unbrowse_learn::fresh::read_anew(walked, i, a, again, j, b).is_some())
        };
        let fields = step.fields.iter().filter(|f| !matches!(f.loc, Loc::Cookie(_))).map(|f| (&f.loc, Some(&f.class)));
        let made = step.page_producers.iter().filter(|p| !step.fields.iter().any(|f| f.loc == p.loc)).map(|p| (&p.loc, None));
        for (loc, class) in fields.chain(made) {
            let page_made = matches!(class, None | Some(Class::Computed | Class::Script { .. } | Class::Generated { .. } | Class::Recipe { .. }));
            let tied = matches!(class, Some(Class::Derived { .. }));
            let seen_once = matches!(class, Some(Class::Unconfirmed { .. }));
            if !(page_made || tied || seen_once) {
                continue;
            }
            let (Some(a), Some(b)) = (at(&sent, loc), at(&resent, loc)) else { continue };
            let header = matches!(loc, Loc::Header(_));
            let is = if a == b {
                match (seen_once, header && stored_as(stored, &a).is_some()) {
                    (true, _) => continue,
                    (false, true) => "session",
                    (false, false) => "fixed",
                }
            } else if !seen_once && step.held.iter().any(|h| h.loc == *loc) && the_word_moved(&a, &b) {
                "fixed"
            } else if header && !seen_before(again, second, &b) && (tied || !seen_before(walked, first, &a)) && stored_as(stored, &a).is_none() {
                "drop"
            } else if !tied && read_anew(first, &a, second, &b) {
                // Each walk sent its own reading of the clock here, as near to its own request (`fresh::read_anew`).
                "clock"
            } else {
                continue;
            };
            said.push(Said { step: n, at: place(loc), is: is.to_string() });
        }
    }
    said
}

/// `route` as two walks measure it (`measured`), when that makes the chain shorter or plain and the site bears it
/// out. Tried with the headers written fresh on each load left out; where the site refuses that, once more with
/// them kept, since one of them may be what the site checks. The route as it was, otherwise. No proposer is asked.
pub(super) fn by_two_walks(
    route: Route,
    walked: &Trace,
    again: &Trace,
    stored: &unbrowse_learn::sandbox::Storage,
    asked: &[String],
    word: &str,
    answers: &mut impl FnMut(&Graph, &HashMap<String, String>) -> Option<serde_json::Value>,
) -> Route {
    if route.write || route.socket.is_some() || (route.graph.steps.len() < 2 && !route.graph.steps.iter().any(|s| s.is_page_signed())) {
        return route;
    }
    let all = measured(&route.graph, walked, again, stored, asked, word);
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        let made = route.graph.steps.iter().filter(|s| sighting_again(walked, again, s, asked).is_some()).count();
        eprintln!("   [links] two walks: the second made {made} of the chain's {} step(s); measured {}", route.graph.steps.len(), all.iter().map(|s| format!("{} {} {}", s.step, s.at, s.is)).collect::<Vec<_>>().join(", "));
    }
    put_to_the_site(route, walked, stored, all, "two walks", asked, word, answers)
}

/// `route` with `said` applied, when that makes the chain shorter or plain and the site bears it out. Tried with the
/// headers left out as said; where the site refuses that, once more with them kept, since one of them may be what
/// the site checks. The route as it was, otherwise. `by` says whose reading it is, for the log.
#[allow(clippy::too_many_arguments)]
fn put_to_the_site(mut route: Route, walked: &Trace, stored: &unbrowse_learn::sandbox::Storage, all: Vec<Said>, by: &str, asked: &[String], word: &str, answers: &mut impl FnMut(&Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Route {
    let kept: Vec<Said> = all.iter().filter(|s| s.is != "drop").cloned().collect();
    let tries = if kept.len() == all.len() { vec![all] } else { vec![all, kept] };
    for said in tries.into_iter().filter(|s| !s.is_empty()) {
        let graph = applied(&route.graph, walked, stored, &said);
        let signed = |g: &Graph| g.steps.iter().any(|s| s.is_page_signed());
        if graph.steps.len() >= route.graph.steps.len() && (signed(&graph) || !signed(&route.graph)) {
            continue;
        }
        keep_for_the_session(&graph, &handed(&graph, &route, walked));
        let count = |is: &str| said.iter().filter(|s| s.is == is).count();
        let what = format!("{} sent as walked, {} left out", count("fixed") + count("session"), count("drop"));
        match borne_out(&graph, &route, asked, word, answers) {
            Ok(()) => {
                eprintln!("   [links] {by}: {what}; {} step(s) where there were {}, {}: the site answers both words", graph.steps.len(), route.graph.steps.len(), if signed(&graph) { "the last still the page's to make" } else { "all plain" });
                let plain = !signed(&graph);
                route.steps = graph.steps.len();
                route.browser_assisted = !plain && route.browser_assisted;
                route.plain_trial = plain.then_some(true).or(route.plain_trial);
                route.graph = graph;
                return route;
            }
            Err(why) => eprintln!("   [links] {by}: {what}; not kept: {why}"),
        }
    }
    route
}

/// What the site settles with nobody's word: `route` asked as its last call alone. One walk cannot say which of that
/// call's values the site reads, and where there was no second walk and there is no proposer, nothing else can
/// either. So the plainest reading is put to the site: every value the call read from another step is sent as the
/// walk sent it, every header the page writes is left out, and the call stands by itself. The site answers it for
/// two words, or it does not; a header it turns out to check is put back (`put_to_the_site`). The step that earned
/// the call's authorization is never left out this way. The route as it was where it is already one plain call,
/// where it writes, or where the site does not bear the reading out.
pub(super) fn by_the_site_alone(route: Route, walked: &Trace, stored: &unbrowse_learn::sandbox::Storage, asked: &[String], word: &str, answers: &mut impl FnMut(&Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Route {
    if route.write || route.socket.is_some() || (route.graph.steps.len() < 2 && !route.graph.steps.iter().any(|s| s.is_page_signed())) {
        return route;
    }
    if own_asks::held_at(own_asks::Ask::Shrink, "learn::links::by_the_site_alone") {
        return route;
    }
    let Some((n, last)) = route.graph.steps.iter().enumerate().next_back() else { return route };
    let mut said = Vec::new();
    for f in last.fields.iter().filter(|f| !matches!(f.loc, Loc::Cookie(_)) && !authorizes(&f.loc)) {
        let is = match (&f.class, &f.loc) {
            (Class::Derived { .. }, _) => "fixed",
            (Class::Computed | Class::Script { .. } | Class::Generated { .. } | Class::Recipe { .. }, Loc::Header(_)) => "drop",
            (Class::Computed | Class::Script { .. } | Class::Generated { .. } | Class::Recipe { .. }, _) => "fixed",
            _ => continue,
        };
        said.push(Said { step: n, at: place(&f.loc), is: is.to_string() });
    }
    for p in last.page_producers.iter().filter(|p| !last.fields.iter().any(|f| f.loc == p.loc) && !authorizes(&p.loc)) {
        said.push(Said { step: n, at: place(&p.loc), is: if matches!(p.loc, Loc::Header(_)) { "drop" } else { "fixed" }.to_string() });
    }
    put_to_the_site(route, walked, stored, said, "the last call alone", asked, word, answers)
}

/// The header values `graph` hands to the session that `route` did not: what goes into the jar before a trial.
fn handed(graph: &Graph, route: &Route, walked: &Trace) -> Vec<(String, String)> {
    graph
        .steps
        .iter()
        .flat_map(|step| step.fields.iter().map(move |f| (step, f)))
        .filter_map(|(step, f)| match (&f.loc, &f.class) {
            (Loc::Header(_), Class::Minted { name }) if !route.graph.steps.iter().flat_map(|s| &s.fields).any(|o| o.loc == f.loc && matches!(o.class, Class::Minted { .. })) => walked_at(walked, step, &f.loc).map(|v| (name.clone(), v)),
            _ => None,
        })
        .collect()
}

/// `route` with the links a proposer named, when the site bears them out: the route as walked answers, and so does
/// a second `word` in place of each of `asked`, with an answer of its own. The route as it was, otherwise.
/// `propose` is the proposer and `answers` the site, as parameters: a test decides it without either.
pub(super) fn proposed(
    mut route: Route,
    walked: &Trace,
    again: Option<&Trace>,
    stored: &unbrowse_learn::sandbox::Storage,
    goal: &str,
    asked: &[String],
    word: &str,
    propose: &mut impl FnMut(&serde_json::Value) -> Option<String>,
    answers: &mut impl FnMut(&Graph, &HashMap<String, String>) -> Option<serde_json::Value>,
) -> Route {
    if route.write || route.socket.is_some() || (route.graph.steps.len() < 2 && !route.graph.steps.iter().any(|s| s.is_page_signed())) {
        return route;
    }
    let ask = serde_json::json!({ "ask": "links", "instruction": LINKS, "chain": chain_of(&route.graph, walked, again, stored, goal) });
    let Some(said) = propose(&ask).map(|text| said_in(&text)).filter(|s| !s.is_empty()) else { return route };
    let graph = applied(&route.graph, walked, stored, &said);
    // What the proposal hands to the session goes into the jar before the site is asked: the trial sends it from there.
    keep_for_the_session(&graph, &handed(&graph, &route, walked));
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        let count = |is: &str| said.iter().filter(|s| s.is == is).count();
        eprintln!("   [links] proposed: {} fixed, {} dropped, {} kept; the chain would be {} step(s) of {}, {}", count("fixed"), count("drop"), count("keep"), graph.steps.len(), route.graph.steps.len(), if graph.steps.iter().any(|s| s.is_page_signed()) { "the last still the page's to make" } else { "all plain" });
    }
    if graph.steps.iter().any(|s| s.is_page_signed()) && graph.steps.len() >= route.graph.steps.len() {
        eprintln!("   [links] the proposal leaves the chain as long and still the page's to make: not tried");
        return route;
    }
    match borne_out(&graph, &route, asked, word, answers) {
        Ok(()) => {
            eprintln!("   [links] {} step(s) where there were {}, {} value(s) changed as proposed: the site answers both words", graph.steps.len(), route.graph.steps.len(), said.len());
            let plain = !graph.steps.iter().any(|s| s.is_page_signed());
            route.steps = graph.steps.len();
            route.browser_assisted = !plain && route.browser_assisted;
            route.plain_trial = plain.then_some(true).or(route.plain_trial);
            route.graph = graph;
            route
        }
        Err(why) => {
            eprintln!("   [links] the proposal was not kept: {why}");
            route
        }
    }
}

/// `route` as an agent wired it (`said`, in a proposer's words), when the site bears it out for `word`: the agent
/// read the route (`unbrowse_inspect`) and its answers, and says of some values what they are. Its word is a
/// proposal like any other: applied to the same graph, checked against the walk where it names a source, and kept
/// only when the site answers the route as walked and for `word` with an answer of its own. Why not, otherwise;
/// nothing is changed then.
pub(super) fn by_an_agent(mut route: Route, walked: &Trace, stored: &unbrowse_learn::sandbox::Storage, said: &[Said], asked: &[String], word: &str, answers: &mut impl FnMut(&Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Result<Route, String> {
    if route.write || route.socket.is_some() {
        return Err("a route that writes is not wired by trial: nothing is sent to try it".into());
    }
    let graph = applied(&route.graph, walked, stored, said);
    // What was said took effect only where the graph differs from the same graph with nothing said: applying
    // nothing still drops the steps that feed nothing.
    if serde_json::to_value(&graph).ok() == serde_json::to_value(applied(&route.graph, walked, stored, &[])).ok() {
        return Err("nothing changed: each value named is already that, or the walk does not bear it out (a value is fixed or read from a step only where the walk shows it; only a header is dropped; an input is one the route takes, where the walk sent exactly its value)".into());
    }
    keep_for_the_session(&graph, &handed(&graph, &route, walked));
    borne_out(&graph, &route, asked, word, answers).map_err(|why| format!("the site did not bear it out: {why}"))?;
    let plain = !graph.steps.iter().any(|s| s.is_page_signed());
    eprintln!("   [links] wired by an agent: {} step(s) where there were {}, {}: the site answers both words", graph.steps.len(), route.graph.steps.len(), if plain { "all plain" } else { "the last still the page's to make" });
    route.steps = graph.steps.len();
    route.browser_assisted = !plain && route.browser_assisted;
    route.plain_trial = plain.then_some(true).or(route.plain_trial);
    route.graph = graph;
    Ok(route)
}

/// The walk a route was learned from, among those the node still holds: the newest whose calls include every step
/// of the route. And the same page walked for another word, if that is held too: one that made the route's last
/// call and is not the first.
pub(super) fn walks_of(walks: &Walks, route: &Route) -> Option<(Trace, Option<Trace>)> {
    let held = walks.0.locked();
    let mut newest: Vec<&Walk> = held.values().collect();
    newest.sort_by_key(|w| std::cmp::Reverse(w.at));
    let first = newest.iter().find(|w| route.graph.steps.iter().all(|s| sighting(&w.trace, s).is_some()))?;
    let last = route.graph.steps.last()?;
    let asked = asked_of(&route.graph);
    let again = newest.iter().find(|w| !std::ptr::eq(**w, *first) && w.url != first.url && sighting_again(&first.trace, &w.trace, last, &asked).is_some());
    Some((first.trace.as_ref().clone(), again.map(|w| w.trace.as_ref().clone())))
}

/// `by_an_agent`, with the node's walks and the site. `links` is each value as the agent named it: the step as
/// `unbrowse_inspect` numbers it (from 1), the value's place (`at`), and what it is. `word` is the second value the
/// agent would ask the site; else the one the route already answered, or the one the page was walked for again.
pub(super) fn wired_by_an_agent(walks: &Walks, route: Route, links: &[(usize, String, String)], word: Option<&str>) -> Result<Route, String> {
    let said: Vec<Said> = links.iter().filter_map(|(step, at, is)| Said::new(step.checked_sub(1)?, at, is)).collect();
    if said.len() != links.len() {
        return Err("each link is a step (as unbrowse_inspect numbers them, from 1), a place (at, as unbrowse_inspect names it) and what the value is: keep, fixed, drop, session, input:<name>, or from:<step>:<json pointer>".into());
    }
    // A `from` names its step as the agent counts them; the chain counts from 0.
    let said: Vec<Said> = said
        .into_iter()
        .map(|s| match read_from(&s.is) {
            Some((step, pointer)) if step >= 1 => Said { is: format!("from:{}:{pointer}", step - 1), ..s },
            _ => s,
        })
        .collect();
    let Some((walked, again)) = walks_of(walks, &route) else {
        return Err("the node no longer holds the walk this route was learned from: learn the page again (unbrowse_do with its url), then say it".into());
    };
    let url = route.graph.page.clone().filter(|p| !p.contains('{')).unwrap_or_else(|| route.root.clone());
    let asked: Vec<String> = route.inputs.iter().filter_map(|i| i.default.clone()).collect();
    let resaid = again.as_ref().and_then(|t| t.exchanges.iter().find(|e| e.is_main_document())).and_then(|page| experiment::asked_apart(&url, page.url.as_str()).1.into_iter().next());
    let Some(word) = word.map(String::from).filter(|w| !w.trim().is_empty()).or_else(|| route.heard.said_back.clone()).or(resaid) else {
        return Err("give a second value to ask the site with (word): the wiring is kept only when the site answers it too".into());
    };
    let host = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    let stored: unbrowse_learn::sandbox::Storage = store::read_json(&unbrowse_learn::client::storage_path(&store::jars_dir(), &host), &unbrowse_files::JAR);
    let trial_of = route.clone();
    let mut answers = |g: &Graph, i: &HashMap<String, String>| {
        if !g.steps.iter().any(|s| s.is_page_signed()) {
            return trial::asks_the_site(g, i);
        }
        let mut tried = trial_of.clone();
        tried.id = format!("trial-{}", trial_of.id);
        tried.steps = g.steps.len();
        tried.graph = g.clone();
        let called = crate::run::call_watched(tried, &crate::vault::Filled { values: i.clone(), secrets: Vec::new(), held: Vec::new() }, "the node", None, &["*".to_string()], None).ok()?;
        called.data.filter(|_| called.ok)
    };
    let route = by_an_agent(route, &walked, &stored, &said, &asked, &word, &mut answers)?;
    store::save_route(&route).map_err(|e| e.to_string())?;
    Ok(route)
}

/// Puts the values a proposal handed to the session into the site's jar, by name.
fn keep_for_the_session(graph: &Graph, handed: &[(String, String)]) {
    if handed.is_empty() || cfg!(test) {
        return;
    }
    let Some(name) = unbrowse_learn::client::jar_name(graph) else { return };
    let path = store::jar_path(&name);
    let mut jar: std::collections::BTreeMap<String, String> = store::read_json(&path, &unbrowse_files::JAR);
    if !added_to(&mut jar, handed) {
        return;
    }
    let _ = store::write_json(&path, &unbrowse_files::JAR, &jar);
}

/// Puts each handed value in the jar under its name, where the jar holds nothing by that name. A name the jar
/// already holds is a cookie or a value the site gave the session, and what a page keeps in its storage never
/// takes its place: a page's script cannot rewrite a cookie it is kept from, and it does not do so by this road.
/// Whether anything was added.
fn added_to(jar: &mut std::collections::BTreeMap<String, String>, handed: &[(String, String)]) -> bool {
    let mut added = false;
    for (name, value) in handed {
        if !jar.contains_key(name) {
            jar.insert(name.clone(), value.clone());
            added = true;
        }
    }
    added
}

/// Whether the site bears `graph` out as `route`'s chain: asked as walked it answers, and asked a second `word` in
/// place of each of `asked` it answers with an answer of its own. Why not, otherwise.
fn borne_out(graph: &Graph, route: &Route, asked: &[String], word: &str, answers: &mut impl FnMut(&Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Result<(), &'static str> {
    let was: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    let mut moved = was.clone();
    let probed = words_asked(route, asked);
    if probed.is_empty() {
        return Err("no input of the route takes a word to move");
    }
    for i in &probed {
        moved.insert(i.name.clone(), word.to_string());
    }
    let walked_words: Vec<&str> = probed.iter().filter_map(|i| i.default.as_deref()).collect();
    let first = answers(graph, &was).ok_or("the site did not answer it as walked")?;
    let second = answers(graph, &moved).ok_or("the site did not answer it for a second word")?;
    let (a, b) = (said_lines(&first, &walked_words), said_lines(&second, &[word]));
    if b.len() < TOO_LITTLE_TO_TELL || nothing_of_its_own(&b, &a) {
        return Err("its answer to a second word is the first word's");
    }
    Ok(())
}

/// A plain route that does not hear its caller, on a page that does: the page works out what the call sends from
/// what it was asked (the region a city lies in, an id for a name), and no tie between answers carries that. The
/// call is then the page's to make: the route is its last step alone, made by the page opened for the caller's
/// value, and it is kept only if the site, asked that way for a second word, answers with an answer of its own.
/// The route as it was where it already hears, where the page-made call does not either, or where it writes.
pub(super) fn made_by_the_page(mut route: Route, walked: &Trace, asked: &[String], word: &str, answers: &mut impl FnMut(&Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Route {
    if route.write || route.socket.is_some() || route.graph.page.is_none() {
        return route;
    }
    // A chain that still needs the page for its last step, behind steps of its own: the page makes that request
    // whole, so nothing before it feeds it, and it is tried alone. A lone step the page already makes is that.
    let needs_the_page = route.graph.steps.iter().any(|s| s.is_page_signed());
    if needs_the_page && route.graph.steps.len() < 2 {
        return route;
    }
    if !needs_the_page {
        match borne_out(&route.graph, &route, asked, word, answers) {
            Err("its answer to a second word is the first word's") => {}
            other => {
                if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                    eprintln!("   [links] the plain route, asked {word:?}: {}", other.err().unwrap_or("it hears its caller"));
                }
                return route;
            }
        }
    }
    let mut graph = route.graph.clone();
    let Some(mut target) = graph.steps.pop() else { return route };
    let own = target.clone();
    // Found among the page's calls by its address and its names: what it read from steps now gone goes as walked.
    target.fields.retain_mut(|f| match (&f.loc, &f.class) {
        (Loc::Cookie(_), _) => true,
        (loc, Class::Derived { .. }) => match walked_at(walked, &own, loc) {
            Some(value) if !matches!(loc, Loc::Header(_)) => {
                f.class = Class::Unconfirmed { value };
                true
            }
            _ => false,
        },
        _ => true,
    });
    target.page_signed = true;
    target.needs_browser = true;
    graph.steps = vec![target];
    match borne_out(&graph, &route, asked, word, answers) {
        Ok(()) => {
            eprintln!("   [links] made by the page alone, the call answers {word:?} with an answer of its own: the call is the page's to make");
            route.steps = 1;
            route.plain_trial = Some(false);
            route.graph = graph;
            route
        }
        Err(why) => {
            eprintln!("   [links] tried as the page's own call, alone: {why}");
            route
        }
    }
}

/// The links step for `route`: what two walks measure (`by_two_walks`, where the page was walked `again`), then the
/// last call alone as the site settles it (`by_the_site_alone`), then what the configured proposer says of the rest
/// (`proposed`), each put to the site. The route as it was when there is no second word to ask the site with.
pub(super) fn with_proposed_links(route: Route, walked: &Trace, again: Option<&Trace>, url: &str, goal: &str) -> Route {
    // Held, the chain stands as walked: no tie is left out on the site's word, nor on a proposer's put to the site.
    if own_asks::held_at(own_asks::Ask::Shrink, "learn::links::with_proposed_links") {
        return route;
    }
    let command = super::trial::proposer();
    // A second walk that never reached the page's calls measures nothing.
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [links] a second walk {}", match again { None => "was not kept".to_string(), Some(t) => format!("of {} exchange(s), the route's call {}", t.exchanges.len(), if route.graph.steps.last().is_some_and(|s| sighting_again(walked, t, s, &asked_of(&route.graph)).is_some()) { "among them" } else { "not among them" }) });
    }
    let again = again.filter(|t| route.graph.steps.last().is_some_and(|s| sighting_again(walked, t, s, &asked_of(&route.graph)).is_some()));
    let asked = asked_values(url, &path_inputs(url, goal, walked).0);
    // The word the second walk asked, read from its page's address beside the first's.
    let resaid = again.and_then(|t| t.exchanges.iter().find(|e| e.is_main_document())).and_then(|page| experiment::asked_apart(url, page.url.as_str()).1.into_iter().next());
    // Then a proposer's, and last a word the page itself offers beside the one it was asked.
    let Some(word) = route.heard.said_back.clone().or(resaid).or_else(|| trial::proposed_word(url, goal, &asked, &[], &unbrowse_learn::provenance::session_values(walked))).or_else(|| trial::another_word(walked, url, &asked)) else { return route };
    let mut propose = |ask: &serde_json::Value| command.as_ref().and_then(|c| unbrowse_learn::generated::run_agent(c, &ask.to_string()));
    // The site, asked as a call asks it: plain where the chain is plain, through the node's browser where a step is
    // still the page's. Under a name of its own, so nothing a trial does is kept against the route.
    let trial_of = route.clone();
    let mut answers = |g: &Graph, i: &HashMap<String, String>| {
        if !g.steps.iter().any(|s| s.is_page_signed()) {
            return trial::asks_the_site(g, i);
        }
        let mut tried = trial_of.clone();
        tried.id = format!("trial-{}", trial_of.id);
        tried.steps = g.steps.len();
        tried.graph = g.clone();
        // The trial is of this graph: a body beside the route's own is not what is tried.
        tried.body = None;
        let called = crate::run::call_watched(tried, &crate::vault::Filled { values: i.clone(), secrets: Vec::new(), held: Vec::new() }, "the node", None, &["*".to_string()], None).ok()?;
        called.data.filter(|_| called.ok)
    };
    let id = route.id.clone();
    let walked_chain = route.graph.clone();
    let before = (route.graph.steps.len(), route.graph.steps.iter().any(|s| s.is_page_signed()));
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    let stored: unbrowse_learn::sandbox::Storage = store::read_json(&unbrowse_learn::client::storage_path(&store::jars_dir(), &host), &unbrowse_files::JAR);
    let route = match again {
        Some(again) => by_two_walks(route, walked, again, &stored, &asked, &word, &mut answers),
        None => route,
    };
    // What two walks did not settle, or could not for want of a second walk, the site is asked outright.
    let route = by_the_site_alone(route, walked, &stored, &asked, &word, &mut answers);
    let route = proposed(route, walked, again, &stored, goal, &asked, &word, &mut propose, &mut answers);
    // A route no second word has yet been heard by is asked; one that already said a second word back is not.
    let route = if route.heard.said_back.is_none() { made_by_the_page(route, walked, &asked, &word, &mut answers) } else { route };
    super::own_asks::say_left_out(&walked_chain, &route.graph);
    if (route.graph.steps.len(), route.graph.steps.iter().any(|s| s.is_page_signed())) != before && route.id == id {
        let _ = store::save_route(&route);
    }
    route
}

/// What a proposer is asked of an answer's fields.
const FIELDS: &str = "A website's call answered the goal given. These are the fields of its answer: each field's path, the kind of value it holds, one of its values (example), and where the same page was asked another word, one of its values in that other answer (again) and whether what the field holds differs between the two answers (moves). Name the fields a person asking for the goal came for: what each result is called, and what the goal asks of it (a price, a date, a place, a picture, a link to it). Leave out the page's own furniture: filters, menus, tabs, tracking, counts of no interest, settings. Prefer fields that sit in the list of results and that move with the word. Use only paths given, exactly as given. At most 12. Reply with JSON only: {\"fields\":[\"<path>\", ...]}.";

/// The most fields a proposer may name as an answer's defaults, and the most it is shown.
const FIELDS_NAMED: usize = 12;
const FIELDS_SHOWN: usize = 400;

/// The default fields of an answer, as a proposer names them: which fields are the result is a judgement about what
/// the goal means, and the rule's (`fields::defaults_on`) reads it from the fields' names. The proposer is shown
/// every field of `first`, the answer the walk got, beside the same field of `second`, the answer the page got when
/// it was asked another word. Of what it names, only paths the answer has are taken, and with two answers only
/// paths both have. They stand only where what they hold differs between the two answers: fields that say the same
/// for two words are not what was asked for. Empty where nothing passes, and the rule's defaults stay.
pub(super) fn fields_named(first: &serde_json::Value, second: Option<&serde_json::Value>, goal: &str, propose: &mut impl FnMut(&serde_json::Value) -> Option<String>) -> Vec<String> {
    let all = unbrowse_learn::fields::paths(first);
    let other = second.map(unbrowse_learn::fields::paths);
    let held = |answer: &serde_json::Value, path: &str| unbrowse_learn::fields::project(answer, &[path.to_string()]);
    let rows: Vec<serde_json::Value> = all
        .iter()
        .take(FIELDS_SHOWN)
        .map(|f| {
            let again = other.as_ref().and_then(|o| o.iter().find(|x| x.path == f.path));
            let moves = second.filter(|_| again.is_some()).map(|s| held(first, &f.path) != held(s, &f.path));
            serde_json::json!({ "path": f.path, "kind": f.kind, "example": f.example, "again": again.and_then(|x| x.example.clone()), "moves": moves })
        })
        .collect();
    let ask = serde_json::json!({ "ask": "fields", "instruction": FIELDS, "goal": goal, "fields": rows });
    let Some(text) = propose(&ask) else { return Vec::new() };
    let parsed: Option<serde_json::Value> = text.find('{').zip(text.rfind('}')).and_then(|(a, b)| serde_json::from_str(text.get(a..=b)?).ok());
    let mut named: Vec<String> = Vec::new();
    for path in parsed.as_ref().and_then(|v| v["fields"].as_array()).into_iter().flatten().filter_map(|p| p.as_str()) {
        let known = all.iter().any(|f| f.path == path) && other.as_ref().is_none_or(|o| o.iter().any(|f| f.path == path));
        if known && !named.iter().any(|n| n == path) && named.len() < FIELDS_NAMED {
            named.push(path.to_string());
        }
    }
    let hears = second.is_none_or(|s| held_all(first, &named) != held_all(s, &named));
    // An answer that lists things was asked for those things: a naming that takes nothing from any list of them (its
    // count, the caller's own word said back) is not its result, however much those differ between two words.
    let listed = lists_of_things(first);
    let lists = listed.is_empty() || named.iter().any(|n| listed.iter().any(|l| n.starts_with(l.as_str())));
    // Every field named must be one the answer holds something at, read back the way a call reads it. A path through
    // a key that itself holds a dot reads nothing back; a naming with such a path would hand back the rest and leave
    // out, unseen, what the proposer chose it for (each record's title).
    let read_back = named.iter().all(|n| says_something(&held(first, n)));
    if hears && lists && read_back { named } else { Vec::new() }
}

/// Whether a projection holds anything at all: a text that is not empty, a number, a flag.
fn says_something(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => false,
        serde_json::Value::String(s) => !s.trim().is_empty(),
        serde_json::Value::Array(a) => a.iter().any(says_something),
        serde_json::Value::Object(o) => o.values().any(says_something),
        _ => true,
    }
}

/// The paths of the lists an answer holds two or more things in, as `fields::paths` writes them (`result.items[]`).
/// A list of one (the caller's own query said back, a single banner) is not a list of things found.
fn lists_of_things(answer: &serde_json::Value) -> Vec<String> {
    fn walk(v: &serde_json::Value, at: String, depth: usize, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Array(a) => {
                let here = format!("{at}[]");
                if a.iter().filter(|x| x.is_object()).count() >= 2 && !out.contains(&here) {
                    out.push(here.clone());
                }
                if depth < 6 {
                    a.iter().take(3).for_each(|x| walk(x, here.clone(), depth + 1, out));
                }
            }
            serde_json::Value::Object(o) if depth < 6 => o.iter().for_each(|(k, x)| walk(x, if at.is_empty() { k.clone() } else { format!("{at}.{k}") }, depth + 1, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(answer, String::new(), 0, &mut out);
    out
}

/// What `answer` holds at `paths`, together.
fn held_all(answer: &serde_json::Value, paths: &[String]) -> serde_json::Value {
    unbrowse_learn::fields::project(answer, paths)
}

/// `route` with the default fields the configured proposer names for its answer (`fields_named`), read from the
/// answers the two walks got: no site is asked. A call's answer is its JSON; a page's is what the page holds, read
/// as a call of the route reads it (`page::answer`). The route as it was when no proposer is configured, when an
/// agent already said which fields are the answer, when the walk's answer is neither, or when there is no second
/// walk's answer to hold the naming to.
pub(super) fn with_proposed_fields(mut route: Route, walked: &Trace, again: Option<&Trace>, goal: &str) -> Route {
    let Some(command) = super::trial::proposer() else { return route };
    if route.judged.fields || route.write {
        return route;
    }
    let Some(last) = route.graph.steps.last() else { return route };
    let answer_of = |e: &Exchange| e.own_json().or_else(|| e.response_body.as_deref().filter(|_| e.is_main_document()).map(|body| unbrowse_learn::page::answer(body, &e.url).0).filter(|v| !v.is_null()));
    let Some(first) = sighting(walked, last).and_then(answer_of) else { return route };
    // One answer cannot bear a naming out: without the second word's answer nothing is asked and the rule's stay.
    let Some(second) = again.and_then(|t| sighting_again(walked, t, last, &asked_of(&route.graph))).and_then(answer_of) else { return route };
    let mut propose = |ask: &serde_json::Value| unbrowse_learn::generated::run_agent(&command, &ask.to_string());
    let named = fields_named(&first, Some(&second), goal, &mut propose);
    if named.is_empty() {
        eprintln!("   [fields] the proposer named no fields that stand: the rule's defaults stay");
        return route;
    }
    eprintln!("   [fields] the proposer names {} field(s) as the answer, and they differ between the two words' answers: {}", named.len(), named.join(", "));
    route.fields = named;
    route.stats.fields_rule = unbrowse_learn::fields::DEFAULTS_RULE;
    let _ = store::save_route(&route);
    route
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain() -> Graph {
        serde_json::from_value(serde_json::json!({
            "provisional": false,
            "scripts": [{ "url": "https://www.stay.example/app.js", "body": "h['traceparent']=id()" }],
            "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://www.stay.example/search?dest={dest}", "needs_browser": false,
                  "fields": [{ "loc": { "in": "query", "key": "dest" }, "class": "input", "name": "dest", "secret": false, "default": "paris" }] },
                { "exchange": 1, "method": "POST", "status": 200, "url": "https://ads.example/deliver", "needs_browser": false, "fields": [] },
                { "exchange": 2, "method": "POST", "status": 200, "url": "https://www.stay.example/query/{path[1]}", "needs_browser": true, "page_signed": true,
                  "page_producers": [{ "loc": { "in": "header", "key": "traceparent" }, "producer": { "script": "https://www.stay.example/app.js", "at": 1 } }],
                  "body": { "kind": "json", "template": { "distance": null, "dest": null }, "types": { "/distance": "number", "/dest": "string" } },
                  "fields": [
                    { "loc": { "in": "path", "key": 1 }, "class": "derived", "origin": { "exchange": 0, "url": "https://www.stay.example/search", "at": { "from": "json", "pointer": "/props/signature" } } },
                    { "loc": { "in": "json", "key": "/dest" }, "class": "input", "name": "dest", "secret": false, "default": "paris" },
                    { "loc": { "in": "json", "key": "/distance" }, "class": "derived", "origin": { "exchange": 1, "url": "https://ads.example/deliver", "at": { "from": "json", "pointer": "/d" } } }
                  ] }
            ]
        }))
        .unwrap()
    }

    fn walk() -> Trace {
        let ex = |method: &str, url: &str, sent: Option<&str>, headers: &[(&str, &str)]| Exchange {
            method: method.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: sent.map(String::from),
            status: 200,
            response_headers: Vec::new(),
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        Trace { exchanges: vec![ex("POST", "https://www.stay.example/query/abc123", Some(r#"{"distance":50,"dest":"paris"}"#), &[("traceparent", "00-aa-bb-01")])], inputs: Vec::new() }
    }

    /// What a page keeps in its storage never replaces what the jar already holds under a name: a cookie of that
    /// name stays as the site set it.
    #[test]
    fn a_stored_value_never_takes_the_place_of_what_the_jar_holds() {
        let mut jar = std::collections::BTreeMap::from([("sid".to_string(), "the-sites-own".to_string())]);
        assert!(added_to(&mut jar, &[("sid".into(), "from-storage".into()), ("x-visitor".into(), "v-1".into())]));
        assert_eq!(jar["sid"], "the-sites-own");
        assert_eq!(jar["x-visitor"], "v-1");
        assert!(!added_to(&mut jar, &[("sid".into(), "again".into())]));
    }

    /// A value the site gave the session to hand back (a token an earlier answer delivered, sent on in the call)
    /// is told to a proposer by its shape and never shown; a value the session does not hold is shown as it is.
    #[test]
    fn a_proposer_is_shown_the_shape_of_what_the_session_holds_never_the_value() {
        let token = "tok9f3aQ77zLm21xP";
        let ex = |method: &str, url: &str, sent: Option<&str>, answer: &str| Exchange {
            method: method.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: sent.map(String::from),
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(answer.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        let walked = Trace {
            exchanges: vec![
                ex("GET", "https://www.stay.example/search?dest=paris", None, &format!(r#"{{"props":{{"signature":"{token}"}}}}"#)),
                ex("POST", &format!("https://www.stay.example/query/{token}"), Some(r#"{"distance":50,"dest":"paris"}"#), r#"{"hotels":[]}"#),
            ],
            inputs: Vec::new(),
        };
        let shown = chain_of(&chain(), &walked, None, &Default::default(), "search stays").to_string();
        assert!(!shown.contains(token), "{shown}");
        assert!(shown.contains("{session} (17 characters, letters and digits)"), "{shown}");
        assert!(shown.contains(r#""value":"50""#), "a value the session does not hold is shown: {shown}");
        assert_eq!(shape_of("0123456789"), "{session} (10 characters, digits)");

        // A piece of the call's own address the page's script wrote there is no template hole: it is the session's
        // all the same, and so is one the page keeps in its storage.
        let kept = "st0red-Key-77aQ9zLm";
        let mut literal = chain();
        let last_of = |g: &mut Graph| g.steps.len() - 1;
        let n = last_of(&mut literal);
        literal.steps[n].url = format!("https://www.stay.example/query/{token}/{kept}?dest=paris");
        literal.steps[n].fields.retain(|f| !matches!(f.loc, Loc::Path(_)));
        let mut stored = unbrowse_learn::sandbox::Storage::default();
        stored.local.insert("auth".into(), format!("\"{kept}\""));
        let shown = chain_of(&literal, &walked, None, &stored, "search stays").to_string();
        assert!(!shown.contains(token) && !shown.contains(kept), "{shown}");
        assert!(shown.contains("/query/{session}/{session}"), "{shown}");

        // The name the page keeps it under is told only when it is a name: a token kept under itself is not.
        let mut under_itself = unbrowse_learn::sandbox::Storage::default();
        under_itself.local.insert(kept.into(), kept.into());
        under_itself.session.insert("visitor".into(), "v-55aa66bb77cc".into());
        let mut sends = chain();
        let n2 = sends.steps.len() - 1;
        sends.steps[n2].fields.push(unbrowse_learn::graph::Field { loc: Loc::Header("x-auth".into()), class: Class::Unconfirmed { value: kept.into() } });
        sends.steps[n2].fields.push(unbrowse_learn::graph::Field { loc: Loc::Header("x-visit".into()), class: Class::Unconfirmed { value: "v-55aa66bb77cc".into() } });
        let shown = chain_of(&sends, &walked, None, &under_itself, "search stays").to_string();
        assert!(!shown.contains(kept) && shown.contains(r#""page_keeps_it_as":"{session}""#) && shown.contains(r#""page_keeps_it_as":"visitor""#), "{shown}");

        // Carried inside a longer piece, or written over twice, it is the session's still.
        literal.steps[n].url = format!("https://www.stay.example/query/v2.{kept}.sig/{}", token.replace('9', "%2539"));
        let shown = chain_of(&literal, &walked, None, &stored, "search stays").to_string();
        assert!(!shown.contains(kept) && !shown.contains("%2539") && shown.contains("/query/{session}/{session}"), "{shown}");
    }

    /// The walk that exposed it: a hotel search tied by one walk to an advert service that answered with a number the
    /// search also sends, and to a tracing header the page writes. A proposer reads the chain and says the number is
    /// fixed and the header is not needed; applied, the advert step is gone, the step is plain, and the operation's
    /// signature is still read from the page. The site's two answers decide whether it is kept.
    #[test]
    fn a_proposed_chain_is_kept_only_when_the_site_answers_both_words() {
        let route = || {
            let mut r = Route::from_graph("r".into(), "search stays".into(), "https://www.stay.example/search?dest=paris".into(), chain()).unwrap();
            // Sent by the page as it loaded: a read, as the walked route is.
            r.write = false;
            r.inputs = vec![store::RouteInput { name: "dest".into(), secret: false, default: Some("paris".into()), file: false, optional: false, options: Vec::new() }];
            r
        };
        let rows = chain_of(&chain(), &walk(), None, &Default::default(), "search stays");
        assert_eq!(rows["steps"][1]["site"], "another site");
        let listed: Vec<String> = rows["steps"][2]["values"].as_array().unwrap().iter().map(|v| format!("{} {}", v["at"].as_str().unwrap(), v["now"].as_str().unwrap())).collect();
        assert_eq!(listed, ["path:1 from_step", "json:/distance from_step", "header:traceparent page"]);
        assert_eq!(rows["steps"][2]["values"][1]["value"], "50");

        let said = r#"Here: {"fields":[{"step":2,"at":"json:/distance","is":"fixed"},{"step":2,"at":"header:traceparent","is":"drop"},{"step":2,"at":"path:1","is":"keep"},{"step":9,"at":"x","is":"drop"},{"step":2,"at":"json:/dest","is":"delete"}]}"#;
        let g = applied(&chain(), &walk(), &Default::default(), &said_in(said));
        assert_eq!(g.steps.iter().map(|s| s.exchange).collect::<Vec<_>>(), [0, 2]);
        let target = g.steps.last().unwrap();
        assert!(!target.is_page_signed() && g.scripts.is_empty());
        assert!(target.fields.iter().any(|f| f.loc == Loc::Json("/distance".into()) && f.class == Class::Unconfirmed { value: "50".into() }));
        assert!(target.fields.iter().any(|f| f.loc == Loc::Path(1) && matches!(f.class, Class::Derived { .. })));

        // A value the walk sent that is exactly the caller's is named an input; one that is not stays as it was.
        let named = applied(&chain(), &walk(), &Default::default(), &said_in(r#"{"fields":[{"step":2,"at":"json:/distance","is":"input:dest"},{"step":2,"at":"header:traceparent","is":"input:dest"}]}"#));
        assert!(named.steps.last().unwrap().fields.iter().any(|f| f.loc == Loc::Json("/distance".into()) && !matches!(f.class, Class::Input { .. })), "50 is not paris");
        let mut same = walk();
        same.exchanges[0].request_headers = vec![("x-city".into(), "Paris".into())];
        let mut with_header = chain();
        with_header.steps[2].fields.push(Field { loc: Loc::Header("x-city".into()), class: Class::Unconfirmed { value: "Paris".into() } });
        let named = applied(&with_header, &same, &Default::default(), &said_in(r#"{"fields":[{"step":2,"at":"header:x-city","is":"input:dest"}]}"#));
        assert!(named.steps.last().unwrap().fields.iter().any(|f| f.loc == Loc::Header("x-city".into()) && matches!(&f.class, Class::Input { name, .. } if name == "dest")));

        // A header the page keeps in its storage is the session's; one it does not keep is not, whatever is said.
        let mut kept = unbrowse_learn::sandbox::Storage::default();
        kept.local.insert("visitor".into(), "\"00-aa-bb-01\"".into());
        let session = r#"{"fields":[{"step":2,"at":"header:traceparent","is":"session"}]}"#;
        let rows = chain_of(&chain(), &walk(), None, &kept, "search stays");
        assert_eq!(rows["steps"][2]["values"][2]["page_keeps_it_as"], "visitor");
        let g2 = applied(&chain(), &walk(), &kept, &said_in(session));
        assert!(g2.steps.last().unwrap().fields.iter().any(|f| f.class == Class::Minted { name: "traceparent".into() }) && !g2.steps.last().unwrap().is_page_signed());
        assert!(applied(&chain(), &walk(), &Default::default(), &said_in(session)).steps.last().unwrap().is_page_signed());

        let hotels = |city: &str| Some(serde_json::json!({ "hotels": (0..12).map(|n| format!("{city} house number {n}")).collect::<Vec<_>>() }));
        let asked = vec!["paris".to_string()];
        let mut propose = |_: &serde_json::Value| Some(said.to_string());
        let mut hears = |_: &Graph, i: &HashMap<String, String>| hotels(if i["dest"] == "paris" { "riverside" } else { "harbour" });
        let kept = proposed(route(), &walk(), None, &Default::default(), "search stays", &asked, "tokyo", &mut propose, &mut hears);
        assert_eq!((kept.graph.steps.len(), kept.steps, kept.plain_trial), (2, 2, Some(true)));
        let mut deaf = |_: &Graph, _: &HashMap<String, String>| hotels("riverside");
        assert_eq!(proposed(route(), &walk(), None, &Default::default(), "search stays", &asked, "tokyo", &mut propose, &mut deaf).graph.steps.len(), 3, "the same answer for both words");
        let mut refuses = |_: &Graph, _: &HashMap<String, String>| None;
        assert_eq!(proposed(route(), &walk(), None, &Default::default(), "search stays", &asked, "tokyo", &mut propose, &mut refuses).graph.steps.len(), 3);
        // A plain chain deaf to its caller, on a page that hears: the last step alone, made by the page.
        let mut plain = route();
        plain.graph = g.clone();
        plain.graph.page = Some("https://www.stay.example/search?dest={dest}".into());
        let mut by_page = |g: &Graph, i: &HashMap<String, String>| hotels(if g.steps.iter().any(|s| s.is_page_signed()) && i["dest"] != "paris" { "harbour" } else { "riverside" });
        let made = made_by_the_page(plain.clone(), &walk(), &asked, "tokyo", &mut by_page);
        assert!(made.graph.steps.len() == 1 && made.graph.steps[0].is_page_signed());
        assert!(made.graph.steps[0].fields.iter().any(|f| f.loc == Loc::Path(1) && f.class == Class::Unconfirmed { value: "abc123".into() }));
        assert_eq!(made_by_the_page(plain.clone(), &walk(), &asked, "tokyo", &mut hears).graph.steps.len(), 2, "it hears already");
        assert_eq!(made_by_the_page(plain, &walk(), &asked, "tokyo", &mut deaf).graph.steps.len(), 2, "the page's own call is deaf too");
        // A chain whose last step is still the page's, behind steps of its own: that step alone, made by the page.
        let mut chained = route();
        chained.graph.page = Some("https://www.stay.example/search?dest={dest}".into());
        let alone = made_by_the_page(chained, &walk(), &asked, "tokyo", &mut by_page);
        assert!(alone.graph.steps.len() == 1 && alone.graph.steps[0].is_page_signed() && alone.steps == 1);
        let mut silent = |_: &serde_json::Value| None;
        assert_eq!(proposed(route(), &walk(), None, &Default::default(), "search stays", &asked, "tokyo", &mut silent, &mut hears).graph.steps.len(), 3, "no proposer, no change");
    }

    /// A search that sends the time it was made, read from the clock by the page's own code. One walk saw the number
    /// once and could say nothing of it, so it was sent as walked and grew older on every call. The page walked
    /// again four minutes on sent another number there, as near to its own request: two sightings say the call reads
    /// the clock for itself, and the route reads it anew on every call. A number both walks sent the same stays as
    /// it is, and so does one that moved to nowhere near the second walk's time.
    #[test]
    fn a_value_each_walk_read_from_the_clock_is_read_anew_on_every_call() {
        // 1_793_383_794 is Fri, 30 Oct 2026 18:09:54 GMT.
        let at = |body: &str, date: &str| {
            let mut w = walk();
            w.exchanges[0].request_body = Some(body.into());
            w.exchanges[0].response_headers.push(("date".into(), date.into()));
            w
        };
        let walked = at(r#"{"distance":50,"dest":"paris","now":1793383794120}"#, "Fri, 30 Oct 2026 18:09:54 GMT");
        let again = at(r#"{"distance":50,"dest":"tokyo","now":1793384034733}"#, "Fri, 30 Oct 2026 18:13:54 GMT");
        let mut graph = chain();
        graph.steps[2].fields.push(Field { loc: Loc::Json("/now".into()), class: Class::Unconfirmed { value: "1793383794120".into() } });
        let asked = vec!["paris".to_string()];
        let said = measured(&graph, &walked, &again, &Default::default(), &asked, "tokyo");
        assert!(said.iter().any(|s| s.step == 2 && s.at == "json:/now" && s.is == "clock"), "{:?}", said.iter().map(|s| format!("{} {} {}", s.step, s.at, s.is)).collect::<Vec<_>>());
        let g = applied(&graph, &walked, &Default::default(), &said);
        let now = g.steps.last().unwrap().fields.iter().find(|f| f.loc == Loc::Json("/now".into())).map(|f| f.class.clone());
        assert!(matches!(&now, Some(Class::Fresh { value, id, clock: unbrowse_learn::fresh::Clock::Millis }) if value == "1793383794120" && id == "1793383794120"), "{now:?}");

        let same = at(r#"{"distance":50,"dest":"tokyo","now":1793383794120}"#, "Fri, 30 Oct 2026 18:13:54 GMT");
        assert!(!measured(&graph, &walked, &same, &Default::default(), &asked, "tokyo").iter().any(|s| s.at == "json:/now"), "the same on both walks: seen once, as it was");
        let far = at(r#"{"distance":50,"dest":"tokyo","now":1793000000000}"#, "Fri, 30 Oct 2026 18:13:54 GMT");
        assert!(!measured(&graph, &walked, &far, &Default::default(), &asked, "tokyo").iter().any(|s| s.is == "clock"), "nowhere near the second walk's request");
        // Said of a value that holds no reading of the walk's clock, it changes nothing.
        let named = applied(&graph, &walked, &Default::default(), &[Said { step: 2, at: "json:/distance".into(), is: "clock".into() }]);
        assert!(!named.steps.last().unwrap().fields.iter().any(|f| matches!(f.class, Class::Fresh { .. })));
    }

    /// The walk that exposed it: a hotel search one walk tied to an advert service's number and to a tracing header
    /// the page writes, so the route was three steps and needed the page. The page walked again for another city, in
    /// the same session, sent the same number, the same signature and another tracing header. With no proposer, the
    /// number and the signature are sent as walked, the header is left out, and the chain is the search alone, plain.
    /// Kept only when the site answers both cities. A value the two walks sent differently, each read from its own
    /// walk's page, is a tie that holds on both and stays tied.
    #[test]
    fn a_value_two_walks_sent_the_same_is_fixed_whatever_one_walk_tied_it_to() {
        let route = || {
            let mut r = Route::from_graph("r".into(), "search stays".into(), "https://www.stay.example/search?dest=paris".into(), chain()).unwrap();
            r.write = false;
            r.inputs = vec![store::RouteInput { name: "dest".into(), secret: false, default: Some("paris".into()), file: false, optional: false, options: Vec::new() }];
            r
        };
        let mut again = walk();
        again.exchanges[0].request_body = Some(r#"{"distance":50,"dest":"tokyo"}"#.into());
        again.exchanges[0].request_headers = vec![("traceparent".into(), "00-cc-dd-01".into())];

        let asked = vec!["paris".to_string()];
        let said = measured(&chain(), &walk(), &again, &Default::default(), &asked, "tokyo");
        let read: Vec<String> = said.iter().map(|s| format!("{} {} {}", s.step, s.at, s.is)).collect();
        assert_eq!(read, ["2 path:1 fixed", "2 json:/distance fixed", "2 header:traceparent drop"]);
        // A tie that holds on both walks: each walk's page answered with the piece that walk then sent.
        let page = |holds: &str| Exchange { url: url::Url::parse("https://www.stay.example/search").unwrap(), method: "GET".into(), response_body: Some(format!(r#"{{"props":{{"signature":"{holds}"}}}}"#)), ..walk().exchanges[0].clone() };
        let (mut read_a, mut read_b) = (walk(), again.clone());
        read_a.exchanges.insert(0, page("abc12345"));
        read_a.exchanges[1].url = url::Url::parse("https://www.stay.example/query/abc12345").unwrap();
        read_b.exchanges.insert(0, page("def67890"));
        read_b.exchanges[1].url = url::Url::parse("https://www.stay.example/query/def67890").unwrap();
        assert!(!measured(&chain(), &read_a, &read_b, &Default::default(), &asked, "tokyo").iter().any(|s| s.at == "path:1"), "read afresh on each walk: left tied");
        // A header both walks sent the same was not written fresh: it is sent as walked, or from the session where
        // the page keeps it.
        let mut kept = unbrowse_learn::sandbox::Storage::default();
        kept.local.insert("visitor".into(), "00-aa-bb-01".into());
        assert!(measured(&chain(), &walk(), &walk(), &Default::default(), &asked, "tokyo").iter().any(|s| s.at == "header:traceparent" && s.is == "fixed"));
        assert!(measured(&chain(), &walk(), &walk(), &kept, &asked, "tokyo").iter().any(|s| s.at == "header:traceparent" && s.is == "session"));
        // The other walk's request is found by its address and operation: it differs wherever the word sits, here in
        // a value of the query the step fixes, and a walk held to that value would never be found.
        let mut fixes_a_word = chain();
        fixes_a_word.steps[2].url = "https://www.stay.example/query/{path[1]}?from=%2Fsearch%3Fdest%3Dparis".into();
        let (mut one, mut two) = (walk(), again.clone());
        one.exchanges[0].url = url::Url::parse("https://www.stay.example/query/abc123?from=%2Fsearch%3Fdest%3Dparis").unwrap();
        two.exchanges[0].url = url::Url::parse("https://www.stay.example/query/abc123?from=%2Fsearch%3Fdest%3Dtokyo").unwrap();
        assert!(measured(&fixes_a_word, &one, &two, &Default::default(), &asked, "tokyo").iter().any(|s| s.at == "json:/distance" && s.is == "fixed"));
        // A walk that never made the call measures nothing.
        assert!(measured(&chain(), &walk(), &Trace { exchanges: Vec::new(), inputs: Vec::new() }, &Default::default(), &asked, "tokyo").is_empty());

        // The page's own address, sent along with the word in it and said back by the page before: one walk read it
        // from that answer. Two walks show it is the first's with the other word where the first's sat, in a value
        // the step writes the caller's word into. It is the caller's, sent as walked, and needs no earlier step.
        let mut echoed = chain();
        echoed.steps[2].fields.push(Field { loc: Loc::Header("x-from".into()), class: serde_json::from_value(serde_json::json!({ "class": "derived", "origin": { "exchange": 0, "url": "https://www.stay.example/search", "at": { "from": "json", "pointer": "/from" } } })).unwrap() });
        echoed.steps[2].held = serde_json::from_value(serde_json::json!([{ "loc": { "in": "header", "key": "x-from" }, "input": "dest", "sits": "paris", "written": "plain" }])).unwrap();
        let (mut from_a, mut from_b) = (read_a.clone(), read_b.clone());
        from_a.exchanges[0].response_body = Some(r#"{"props":{"signature":"abc12345"},"from":"/search?dest=paris"}"#.into());
        from_b.exchanges[0].response_body = Some(r#"{"props":{"signature":"def67890"},"from":"/search?dest=tokyo"}"#.into());
        from_a.exchanges[1].request_headers.push(("x-from".into(), "/search?dest=paris".into()));
        from_b.exchanges[1].request_headers.push(("x-from".into(), "/search?dest=tokyo".into()));
        assert!(measured(&echoed, &from_a, &from_b, &Default::default(), &asked, "tokyo").iter().any(|s| s.at == "header:x-from" && s.is == "fixed"));
        from_b.exchanges[1].request_headers.last_mut().unwrap().1 = "/elsewhere?dest=tokyo".into();
        assert!(!measured(&echoed, &from_a, &from_b, &Default::default(), &asked, "tokyo").iter().any(|s| s.at == "header:x-from" && s.is == "fixed"), "more than the word moved: not the caller's");

        let hotels = |city: &str| Some(serde_json::json!({ "hotels": (0..12).map(|n| format!("{city} house number {n}")).collect::<Vec<_>>() }));
        let mut hears = |_: &Graph, i: &HashMap<String, String>| hotels(if i["dest"] == "paris" { "riverside" } else { "harbour" });
        let plain = by_two_walks(route(), &walk(), &again, &Default::default(), &asked, "tokyo", &mut hears);
        assert_eq!(plain.graph.steps.iter().map(|s| s.exchange).collect::<Vec<_>>(), [2]);
        assert!(!plain.graph.steps[0].is_page_signed() && plain.plain_trial == Some(true) && plain.graph.provisional);
        assert!(plain.graph.steps[0].fields.iter().any(|f| f.loc == Loc::Json("/distance".into()) && f.class == Class::Unconfirmed { value: "50".into() }));
        assert!(plain.graph.steps[0].fields.iter().any(|f| f.loc == Loc::Path(1) && f.class == Class::Unconfirmed { value: "abc123".into() }));

        // A site that checks the header written on each load: without it nothing answers, so it is kept and the step
        // stays the page's to make. The page makes that request whole, so it stands alone: the advert step is gone.
        let mut checks = |g: &Graph, i: &HashMap<String, String>| if g.steps.iter().any(|s| s.is_page_signed()) { hotels(if i["dest"] == "paris" { "riverside" } else { "harbour" }) } else { None };
        let signed = by_two_walks(route(), &walk(), &again, &Default::default(), &asked, "tokyo", &mut checks);
        assert!(signed.graph.steps.len() == 1 && signed.graph.steps[0].is_page_signed());

        // A site deaf to the second city, or one that does not answer: the route as it was.
        let mut deaf = |_: &Graph, _: &HashMap<String, String>| hotels("riverside");
        assert_eq!(by_two_walks(route(), &walk(), &again, &Default::default(), &asked, "tokyo", &mut deaf).graph.steps.len(), 3);
        let mut refuses = |_: &Graph, _: &HashMap<String, String>| None;
        assert_eq!(by_two_walks(route(), &walk(), &again, &Default::default(), &asked, "tokyo", &mut refuses).graph.steps.len(), 3);

        // What two walks leave open is shown to a proposer with both values.
        let rows = chain_of(&chain(), &walk(), Some(&again), &Default::default(), "search stays");
        assert_eq!((rows["steps"][2]["values"][2]["value"].as_str(), rows["steps"][2]["values"][2]["again"].as_str()), (Some("00-aa-bb-01"), Some("00-cc-dd-01")));
    }
    /// The walk that exposed it: a picture search whose answer lists a filter bar before its results, so the fields
    /// chosen by their names were the filters and a caller got no pictures. Which fields are the result is a
    /// proposer's to say, from both words' answers side by side; what it names stands only where the answer has
    /// those fields for both words and they hold something else for each.
    #[test]
    fn fields_that_name_nothing_of_what_the_answer_lists_are_not_its_result() {
        // The walk that exposed it: a site search whose answer holds a count, the caller's word said back, and the
        // list of pages found. A proposer named the count and the word. Both differ between two words, so they stood,
        // and every call came back `ok` with a count of results and none of them.
        let answer = |word: &str, n: usize| serde_json::json!({"result": {"total": n * 100, "asked": [{"q": word}], "found": (0..n).map(|i| serde_json::json!({"title": format!("{word} page {i}"), "path": format!("/{word}/{i}")})).collect::<Vec<_>>()}});
        let (first, second) = (answer("mortgage", 5), answer("savings", 4));
        assert_eq!(lists_of_things(&first), ["result.found[]"], "the word said back is a list of one");
        let mut count_and_word = |_: &serde_json::Value| Some(r#"{"fields":["result.total","result.asked[].q"]}"#.to_string());
        assert!(fields_named(&first, Some(&second), "search the site", &mut count_and_word).is_empty(), "the rule's defaults stay");
        let mut with_the_list = |_: &serde_json::Value| Some(r#"{"fields":["result.found[].title","result.found[].path","result.total"]}"#.to_string());
        assert_eq!(fields_named(&first, Some(&second), "search the site", &mut with_the_list), ["result.found[].title", "result.found[].path", "result.total"]);
        // A field named that reads nothing back (a key that holds a dot of its own) leaves the naming untrusted: kept,
        // it would hand back the dates and drop the titles it was chosen for, unseen.
        let dotted = |word: &str| serde_json::json!({"results": (0..3).map(|i| serde_json::json!({"fields": {"title.default": format!("{word} {i}"), "date": format!("2026-0{}-01", i + 1)}})).collect::<Vec<_>>()});
        let mut titles = |_: &serde_json::Value| Some(r#"{"fields":["results[].fields.title.default","results[].fields.date"]}"#.to_string());
        let stood = fields_named(&dotted("themes"), Some(&dotted("domains")), "search help", &mut titles);
        assert!(stood.is_empty() || stood.iter().all(|p| says_something(&unbrowse_learn::fields::project(&dotted("themes"), std::slice::from_ref(p)))), "{stood:?}");
        // An answer that lists nothing has no list to be held to.
        let one = |name: &str| serde_json::json!({"name": name, "price": "12.00"});
        assert!(lists_of_things(&one("lamp")).is_empty());
        let mut named = |_: &serde_json::Value| Some(r#"{"fields":["name","price"]}"#.to_string());
        assert_eq!(fields_named(&one("lamp"), Some(&one("chair")), "look up a thing", &mut named), ["name", "price"]);
    }

    #[test]
    fn the_fields_a_proposer_names_stand_only_where_they_differ_between_two_words() {
        let answer = |word: &str| serde_json::json!({ "bar": [{ "title": "Filters" }, { "title": "All" }], "results": (0..3).map(|n| serde_json::json!({ "id": format!("{word}-{n}"), "image": format!("https://img.example/{word}/{n}.jpg") })).collect::<Vec<_>>(), "only_here": "x" });
        let (garden, mut tattoo) = (answer("garden"), answer("tattoo"));
        tattoo.as_object_mut().unwrap().remove("only_here");
        let mut shown = serde_json::Value::Null;
        let mut results = |ask: &serde_json::Value| {
            shown = ask.clone();
            Some(r#"Sure: {"fields":["results[].image","results[].id","results[].nothing","only_here","results[].image"]}"#.to_string())
        };
        assert_eq!(fields_named(&garden, Some(&tattoo), "search pictures", &mut results), ["results[].image", "results[].id"], "a path no answer has, one only the first has, and a repeat are left out");
        let row = |path: &str| shown["fields"].as_array().unwrap().iter().find(|r| r["path"] == path).cloned().unwrap();
        assert_eq!((row("results[].id")["moves"].as_bool(), row("bar[].title")["moves"].as_bool()), (Some(true), Some(false)), "the proposer is shown what moves with the word");
        let mut furniture = |_: &serde_json::Value| Some(r#"{"fields":["bar[].title"]}"#.to_string());
        assert!(fields_named(&garden, Some(&tattoo), "search pictures", &mut furniture).is_empty(), "the same for both words is not the result");
        assert_eq!(fields_named(&garden, None, "search pictures", &mut furniture), ["bar[].title"], "one answer cannot say");
        let mut silent = |_: &serde_json::Value| None;
        assert!(fields_named(&garden, Some(&tattoo), "search pictures", &mut silent).is_empty());
    }
    /// An agent that read a route says how its values are wired, in a proposer's words and one more: a value read
    /// from an earlier step's answer, at a place it names. The walk has to bear that out (the step's answer holds
    /// there exactly what was then sent), and the site has to answer the route so wired for a second value. A
    /// place that does not hold the value, a site that does not hear, and a route that writes change nothing.
    #[test]
    fn an_agents_wiring_is_kept_only_where_the_walk_and_the_site_bear_it_out() {
        let route = || {
            let mut r = Route::from_graph("r".into(), "search stays".into(), "https://www.stay.example/search?dest=paris".into(), chain()).unwrap();
            r.write = false;
            r.inputs = vec![store::RouteInput { name: "dest".into(), secret: false, default: Some("paris".into()), file: false, optional: false, options: Vec::new() }];
            r
        };
        // The page said how far to look, and the search then sent that number: one walk tied it to an advert's answer.
        let mut walked = walk();
        walked.exchanges.insert(0, Exchange { url: url::Url::parse("https://www.stay.example/search?dest=paris").unwrap(), method: "GET".into(), request_body: None, response_body: Some(r#"{"props":{"signature":"abc123","limit":50,"other":7}}"#.into()), ..walk().exchanges[0].clone() });
        assert_eq!(read_from("from:0:/props/limit"), Some((0, "/props/limit")));
        assert!(read_from("from:x:/a").is_none() && read_from("from:0:props").is_none() && Said::new(2, "json:/distance", "from the page").is_none());

        let wired = [Said::new(2, "json:/distance", "from:0:/props/limit").unwrap(), Said::new(2, "header:traceparent", "drop").unwrap()];
        let g = applied(&chain(), &walked, &Default::default(), &wired);
        assert_eq!(g.steps.iter().map(|s| s.exchange).collect::<Vec<_>>(), [0, 2], "the advert step feeds nothing now");
        assert!(g.steps[1].fields.iter().any(|f| f.loc == Loc::Json("/distance".into()) && matches!(&f.class, Class::Derived { origin } if origin.exchange == 0 && origin.at == unbrowse_learn::provenance::At::Json { pointer: "/props/limit".into() })));
        // A place that holds something else, a step that comes later, and a step that is not there: left as they were.
        for is in ["from:0:/props/other", "from:2:/props/limit", "from:9:/props/limit"] {
            let g = applied(&chain(), &walked, &Default::default(), &[Said::new(2, "json:/distance", is).unwrap(), Said::new(2, "header:traceparent", "drop").unwrap()]);
            assert!(g.steps.iter().any(|s| s.exchange == 1), "{is}: still read from the advert's answer");
        }

        let hotels = |city: &str| Some(serde_json::json!({ "hotels": (0..12).map(|n| format!("{city} house number {n}")).collect::<Vec<_>>() }));
        let asked = vec!["paris".to_string()];
        let mut hears = |_: &Graph, i: &HashMap<String, String>| hotels(if i["dest"] == "paris" { "riverside" } else { "harbour" });
        let kept = by_an_agent(route(), &walked, &Default::default(), &wired, &asked, "tokyo", &mut hears).unwrap();
        assert!(kept.graph.steps.len() == 2 && kept.steps == 2 && kept.plain_trial == Some(true));
        let mut deaf = |_: &Graph, _: &HashMap<String, String>| hotels("riverside");
        assert!(by_an_agent(route(), &walked, &Default::default(), &wired, &asked, "tokyo", &mut deaf).unwrap_err().contains("did not bear it out"));
        let unborne = [Said::new(1, "json:/distance", "from:0:/props/other").unwrap()];
        assert!(by_an_agent(route(), &walked, &Default::default(), &unborne, &asked, "tokyo", &mut hears).unwrap_err().contains("nothing changed"), "no such value on that step");
        let mut writes = route();
        writes.write = true;
        assert!(by_an_agent(writes, &walked, &Default::default(), &wired, &asked, "tokyo", &mut hears).is_err());
    }
    /// The walk that exposed it: a hotel search behind a door that refused the page a second walk, on a node with no
    /// proposer. The route stood as a chain that needed the browser, and nothing in the engine asked the one question
    /// that settles it. Now the site is asked: the last call alone, what it read from other steps sent as walked,
    /// the headers the page writes left out. Kept where the site answers two words; a header the site checks is put
    /// back; a site that does not hear leaves the route as it was.
    /// Shrinking held, the chain stands as the walk made it and the site is asked nothing.
    #[test]
    fn a_held_shrink_keeps_the_chain_as_walked() {
        let mut route = Route::from_graph("r".into(), "search stays".into(), "https://www.stay.example/search?dest=paris".into(), chain()).unwrap();
        route.write = false;
        route.inputs = vec![store::RouteInput { name: "dest".into(), secret: false, default: Some("paris".into()), file: false, optional: false, options: Vec::new() }];
        let mut asked = 0;
        let (kept, said) = super::own_asks::holding(super::own_asks::Ask::Shrink, || {
            let mut answers = |_: &Graph, _: &HashMap<String, String>| {
                asked += 1;
                Some(serde_json::json!({ "hotels": ["one"] }))
            };
            by_the_site_alone(route.clone(), &walk(), &Default::default(), &["paris".to_string()], "tokyo", &mut answers)
        });
        assert_eq!(asked, 0);
        assert_eq!(kept.graph.steps.len(), route.graph.steps.len(), "every step the walk made is kept");
        assert_eq!(said, vec!["   [own-ask] held: shrink at learn::links::by_the_site_alone".to_string()]);
    }

    #[test]
    fn a_chain_is_asked_of_the_site_as_its_last_call_alone_without_what_the_page_writes() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let route = || {
            let mut r = Route::from_graph("r".into(), "search stays".into(), "https://www.stay.example/search?dest=paris".into(), chain()).unwrap();
            r.write = false;
            r.inputs = vec![store::RouteInput { name: "dest".into(), secret: false, default: Some("paris".into()), file: false, optional: false, options: Vec::new() }];
            r
        };
        let hotels = |city: &str| Some(serde_json::json!({ "hotels": (0..12).map(|n| format!("{city} house number {n}")).collect::<Vec<_>>() }));
        let asked = vec!["paris".to_string()];
        let mut hears = |_: &Graph, i: &HashMap<String, String>| hotels(if i["dest"] == "paris" { "riverside" } else { "harbour" });
        let alone = by_the_site_alone(route(), &walk(), &Default::default(), &asked, "tokyo", &mut hears);
        assert_eq!(alone.graph.steps.iter().map(|s| s.exchange).collect::<Vec<_>>(), [2]);
        assert!(!alone.graph.steps[0].is_page_signed() && alone.plain_trial == Some(true) && alone.graph.provisional);
        assert!(alone.graph.steps[0].fields.iter().any(|f| f.loc == Loc::Json("/distance".into()) && f.class == Class::Unconfirmed { value: "50".into() }));
        assert!(!alone.graph.steps[0].fields.iter().any(|f| f.loc == Loc::Header("traceparent".into())) && alone.graph.steps[0].page_producers.is_empty());
        // The site checks the header the page writes: it is put back, and the call is the page's to make, alone.
        let mut checks = |g: &Graph, i: &HashMap<String, String>| if g.steps.iter().any(|s| s.is_page_signed()) { hotels(if i["dest"] == "paris" { "riverside" } else { "harbour" }) } else { None };
        let signed = by_the_site_alone(route(), &walk(), &Default::default(), &asked, "tokyo", &mut checks);
        assert!(signed.graph.steps.len() == 1 && signed.graph.steps[0].is_page_signed());
        let mut deaf = |_: &Graph, _: &HashMap<String, String>| hotels("riverside");
        assert_eq!(by_the_site_alone(route(), &walk(), &Default::default(), &asked, "tokyo", &mut deaf).graph.steps.len(), 3);
        // One plain call already, and a route that writes: nothing is asked.
        let mut asked_at_all = 0;
        let mut counts = |_: &Graph, _: &HashMap<String, String>| {
            asked_at_all += 1;
            hotels("riverside")
        };
        let mut writes = route();
        writes.write = true;
        by_the_site_alone(writes, &walk(), &Default::default(), &asked, "tokyo", &mut counts);
        by_the_site_alone(alone, &walk(), &Default::default(), &asked, "tokyo", &mut counts);
        assert_eq!(asked_at_all, 0);
    }

    /// A hotel site on this machine: its search page hands out the signature the booking call is sent to, and the
    /// booking answers with hotels of the city named in its body. Counts the requests it has had.
    fn a_hotel_site() -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let target = request.split_whitespace().nth(1).unwrap_or("").to_string();
                let sent = request.split("\r\n\r\n").nth(1).unwrap_or("");
                let body = if target.starts_with("/search") {
                    r#"{"props":{"signature":"abc123","limit":50,"other":7}}"#.to_string()
                } else if target.starts_with("/query/") {
                    let city = if sent.contains("tokyo") { "harbour" } else { "riverside" };
                    serde_json::json!({ "hotels": (0..12).map(|n| format!("{city} house number {n}")).collect::<Vec<_>>() }).to_string()
                } else {
                    r#"{"d":50}"#.to_string()
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (port, seen)
    }

    /// The hotel chain as `base` serves it, and the walk that made it.
    fn on_the_site(base: &str) -> (Route, Trace) {
        let text = serde_json::to_string(&chain()).unwrap().replace("https://www.stay.example", base).replace("https://ads.example", base);
        let graph: Graph = serde_json::from_str(&text).unwrap();
        let mut route = Route::from_graph("links-test-hotels".into(), "search stays".into(), format!("{base}/search?dest=paris"), graph).unwrap();
        route.write = false;
        route.inputs = vec![store::RouteInput { name: "dest".into(), secret: false, default: Some("paris".into()), file: false, optional: false, options: Vec::new() }];
        let ex = |method: &str, url: String, sent: Option<&str>, headers: &[(&str, &str)], answer: &str, doc: bool| Exchange {
            method: method.into(),
            url: url::Url::parse(&url).unwrap(),
            request_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: sent.map(String::from),
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(answer.into()),
            response_mime: if doc { "text/html".into() } else { "application/json".into() },
            resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        };
        let walked = Trace {
            exchanges: vec![
                ex("GET", format!("{base}/search?dest=paris"), None, &[], r#"{"props":{"signature":"abc123","limit":50,"other":7}}"#, false),
                ex("POST", format!("{base}/deliver"), Some("{}"), &[], r#"{"d":50}"#, false),
                ex("POST", format!("{base}/query/abc123"), Some(r#"{"distance":50,"dest":"paris"}"#), &[("traceparent", "00-aa-bb-01")], r#"{"hotels":[]}"#, false),
            ],
            inputs: Vec::new(),
        };
        (route, walked)
    }

    fn walk_held(trace: &Trace, url: &str, age: u64) -> Walk {
        Walk { url: url.into(), trace: trace.clone().into(), probes: Vec::new(), recording: None, at: std::time::Instant::now() - std::time::Duration::from_secs(age), addresses: None }
    }

    /// The walk a route was learned from is the newest one the node holds that made every call of it; the same page
    /// walked for another word is the next that made its last call too, and a node that holds neither says so.
    #[test]
    fn the_walks_a_route_was_learned_from_are_found_among_those_held() {
        let (route, walked) = on_the_site("http://127.0.0.1:9");
        let walks = Walks::default();
        assert!(walks_of(&walks, &route).is_none(), "no walk held");
        let page = "http://127.0.0.1:9/search?dest=paris";
        walks.0.locked().insert("old".into(), walk_held(&Trace { exchanges: walked.exchanges[..1].to_vec(), inputs: Vec::new() }, page, 30));
        assert!(walks_of(&walks, &route).is_none(), "a walk that did not make every call is not the route's");
        walks.0.locked().insert("first".into(), walk_held(&walked, page, 20));
        let (first, again) = walks_of(&walks, &route).expect("the walk");
        assert_eq!(first.exchanges.len(), 3);
        assert!(again.is_none(), "no other word was walked");
        let mut tokyo = walked.clone();
        tokyo.exchanges[0].url = url::Url::parse("http://127.0.0.1:9/search?dest=tokyo").unwrap();
        tokyo.exchanges[2].request_body = Some(r#"{"distance":50,"dest":"tokyo"}"#.into());
        walks.0.locked().insert("second".into(), walk_held(&tokyo, "http://127.0.0.1:9/search?dest=tokyo", 10));
        let (first, again) = walks_of(&walks, &route).expect("the walks");
        assert_eq!(first.exchanges[0].url.query(), Some("dest=tokyo"), "the newest walk that made every call is the first");
        assert!(again.is_some(), "and the page walked for another word is held beside it");
    }

    /// An agent's wiring is read as the walk the node holds and the site bear it out: said wrongly, nothing is
    /// kept; with no walk held, or no second value to ask with, it says so; said as the walk shows and the site
    /// answers, the route is kept as wired.
    #[test]
    fn an_agents_links_are_put_to_the_walk_the_node_holds_and_the_site() {
        let (port, _) = a_hotel_site();
        let base = format!("http://127.0.0.1:{port}");
        let (route, walked) = on_the_site(&base);
        let walks = Walks::default();
        let links = vec![(3, "json:/distance".to_string(), "from:1:/props/limit".to_string()), (3, "header:traceparent".to_string(), "drop".to_string())];
        let said_wrong = wired_by_an_agent(&walks, route.clone(), &[(0, "json:/distance".into(), "fixed".into())], Some("tokyo")).unwrap_err();
        assert!(said_wrong.contains("each link is a step"), "{said_wrong}");
        let none_held = wired_by_an_agent(&walks, route.clone(), &links, Some("tokyo")).unwrap_err();
        assert!(none_held.contains("no longer holds the walk"), "{none_held}");
        walks.0.locked().insert("first".into(), walk_held(&walked, &format!("{base}/search?dest=paris"), 5));
        let no_word = wired_by_an_agent(&walks, route.clone(), &links, Some("  ")).unwrap_err();
        assert!(no_word.contains("give a second value"), "{no_word}");
        let unborne = wired_by_an_agent(&walks, route.clone(), &[(3, "json:/distance".into(), "from:1:/props/other".into())], Some("tokyo")).unwrap_err();
        assert!(unborne.contains("nothing changed"), "{unborne}");
        let kept = wired_by_an_agent(&walks, route.clone(), &links, Some("tokyo")).expect("the site answers both words");
        assert_eq!((kept.graph.steps.len(), kept.steps, kept.plain_trial), (2, 2, Some(true)), "the advert step feeds nothing now");
        assert_eq!(store::load_route(&route.id).map(|r| r.steps), Some(2), "and the route is kept as wired");
        // The word the route already said back is the second value when the agent names none.
        let mut heard = route.clone();
        heard.heard.said_back = Some("tokyo".into());
        assert!(wired_by_an_agent(&walks, heard, &links, None).is_ok());
    }

    /// The links step asks the site for the route's last call alone with the word the route already said back, and
    /// keeps that one call where the site answers both words; held, or with no word, it asks nothing.
    #[test]
    fn the_links_step_shrinks_the_chain_by_what_the_site_answers() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let (port, seen) = a_hotel_site();
        let base = format!("http://127.0.0.1:{port}");
        let (mut route, walked) = on_the_site(&base);
        let url = format!("{base}/search?dest=paris");
        // No second word is known, none offered: the chain stands and the site hears nothing.
        let same = super::trial::with_a_proposer("", || with_proposed_links(route.clone(), &walked, None, &url, "search stays"));
        assert_eq!(same.graph.steps.len(), 3);
        assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), 0);
        route.heard.said_back = Some("tokyo".into());
        let (held, said) = super::own_asks::holding(super::own_asks::Ask::Shrink, || super::trial::with_a_proposer("", || with_proposed_links(route.clone(), &walked, None, &url, "search stays")));
        assert_eq!(held.graph.steps.len(), 3, "held, the chain stands as walked");
        assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), 0, "and the site is asked nothing");
        assert_eq!(said, vec!["   [own-ask] held: shrink at learn::links::with_proposed_links".to_string()]);
        let shrunk = super::trial::with_a_proposer("", || with_proposed_links(route.clone(), &walked, None, &url, "search stays"));
        assert_eq!(shrunk.graph.steps.iter().map(|s| s.exchange).collect::<Vec<_>>(), [2], "the last call alone answers both words");
        assert!(seen.load(std::sync::atomic::Ordering::SeqCst) >= 2);
        assert_eq!(store::load_route(&route.id).map(|r| r.steps), Some(1), "and the shorter route is kept");
    }

    /// A proposer's naming of the fields that are the answer is taken only where the two walks' answers differ by
    /// it, and is kept on the route; with no proposer, no second walk, or an agent's own say, the rule's stand.
    #[test]
    fn the_fields_a_proposer_names_are_kept_on_the_route_it_was_shown_two_walks_of() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp" }] }]
        }))
        .unwrap();
        let route = || {
            let mut r = Route::from_graph("links-test-fields".into(), "search".into(), "https://shop.example/s?q=lamp".into(), graph.clone()).unwrap();
            r.write = false;
            r
        };
        let page = |word: &str| {
            let answer = serde_json::json!({ "bar": [{ "title": "Filters" }, { "title": "All" }], "results": (0..3).map(|n| serde_json::json!({ "id": format!("{word}-{n}"), "image": format!("https://img.example/{word}/{n}.jpg") })).collect::<Vec<_>>() });
            let ex = |url: String, body: String, doc: bool| Exchange {
                method: "GET".into(),
                url: url::Url::parse(&url).unwrap(),
                request_headers: Vec::new(),
                request_body: None,
                status: 200,
                response_headers: Vec::new(),
                response_body: Some(body),
                response_mime: if doc { "text/html".into() } else { "application/json".into() },
                resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
                main_frame: Some(true),
            };
            Trace { exchanges: vec![ex(format!("https://shop.example/s?q={word}"), "<html></html>".into(), true), ex(format!("https://shop.example/api/search?q={word}"), answer.to_string(), false)], inputs: Vec::new() }
        };
        let (lamp, kettle) = (page("lamp"), page("kettle"));
        let names = r#"Here: {"fields":["results[].image","results[].id"]}"#;
        let program = format!("cat >/dev/null; echo '{names}'");
        let wired = super::trial::with_a_proposer(&program, || with_proposed_fields(route(), &lamp, Some(&kettle), "search pictures"));
        assert_eq!(wired.fields, ["results[].image", "results[].id"]);
        assert_eq!(store::load_route(&wired.id).map(|r| r.fields), Some(wired.fields.clone()), "kept on the route");
        assert_eq!(wired.stats.fields_rule, unbrowse_learn::fields::DEFAULTS_RULE);
        let furniture = super::trial::with_a_proposer("cat >/dev/null; echo '{\"fields\":[\"bar[].title\"]}'", || with_proposed_fields(route(), &lamp, Some(&kettle), "search pictures"));
        assert!(furniture.fields.is_empty(), "what is the same for both words is not the result");
        assert!(super::trial::with_a_proposer("", || with_proposed_fields(route(), &lamp, Some(&kettle), "search pictures")).fields.is_empty(), "no proposer, the rule's stay");
        let one_walk = super::trial::with_a_proposer(&program, || with_proposed_fields(route(), &lamp, None, "search pictures"));
        assert!(one_walk.fields.is_empty(), "one answer cannot bear a naming out");
        let mut said = route();
        said.judged.fields = true;
        assert!(super::trial::with_a_proposer(&program, || with_proposed_fields(said, &lamp, Some(&kettle), "search pictures")).fields.is_empty(), "an agent already said which fields");
        let mut writes = route();
        writes.write = true;
        assert!(super::trial::with_a_proposer(&program, || with_proposed_fields(writes, &lamp, Some(&kettle), "search pictures")).fields.is_empty());
    }
}
