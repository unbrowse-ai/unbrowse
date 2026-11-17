//! A site's graph, as a proposer reads it: every layer of two walks of one page, each node with its context.
//!
//! A walk is a sample of a site. Two walks of one page, for two values, are an experiment, and what a proposer needs
//! to decide anything about the site is both of them laid out as one graph: the page, the calls it made, what each
//! answered, what the session held, and what the experiment already settled. The engine writes down what it can
//! measure (what differs, where a value was seen before it was sent, whether that holds on the other walk); the
//! proposer is left what cannot be measured from traffic alone (which answer is the one a person came for, what a
//! value means). Nothing here holds a cookie's value or a header's: a session is named, never shown.

use super::*;
use serde_json::{json, Value};

/// How much of a value a proposer is shown.
const SHOWN: usize = 80;

fn shown(text: &str) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if flat.chars().count() > SHOWN { format!("{}…", flat.chars().take(SHOWN).collect::<String>()) } else { flat }
}

/// A request's parts, each with where it sits: query, path piece, body leaf, form field.
pub(super) fn parts(e: &Exchange) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = e.url.query_pairs().map(|(k, v)| (format!("query {k}"), v.into_owned())).collect();
    out.extend(e.url.path_segments().into_iter().flatten().enumerate().map(|(n, p)| (format!("path {n}"), percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned())));
    if let Some(body) = e.request_body.as_deref() {
        match serde_json::from_str::<Value>(body) {
            Ok(v) => out.extend(unbrowse_learn::slots::json_leaves(&v).into_iter().map(|(k, v)| (format!("body {k}"), v))),
            Err(_) => out.extend(url::form_urlencoded::parse(body.as_bytes()).map(|(k, v)| (format!("form {k}"), v.into_owned()))),
        }
    }
    out
}

/// What a call answered, as data: its own JSON, or the state a page embeds.
fn data_of(e: &Exchange) -> Option<Value> {
    e.json_body()
}

/// Whether `leaf` is `value` as an answer would hold it: the same text, or the same number written to another
/// precision (`48.864062012071955` sent, `48.8640620120720` answered).
fn is_value(leaf: &str, value: &str) -> bool {
    if leaf == value {
        return true;
    }
    match (leaf.parse::<f64>(), value.parse::<f64>()) {
        (Ok(a), Ok(b)) => value.contains('.') && (a - b).abs() <= 1e-6 * b.abs().max(1.0),
        _ => false,
    }
}

/// Where `value` was seen in an answer before call `before` was sent: the call and the pointer, nearest first.
fn seen_before(trace: &Trace, before: usize, value: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    if value.chars().count() < 4 {
        return out;
    }
    for (n, e) in trace.exchanges[..before].iter().enumerate().rev() {
        let Some(v) = data_of(e) else { continue };
        if let Some((pointer, _)) = unbrowse_learn::slots::json_leaves(&v).into_iter().find(|(_, leaf)| is_value(leaf, value)) {
            out.push((n, pointer));
            if out.len() >= 3 {
                break;
            }
        }
    }
    out
}

/// A page's address as a proposer is shown it: what the page was asked stays as it is; any other value of its query
/// is named by its key alone, and a piece of its path the session holds is named, not shown. An address can carry
/// what only its owner should hold (a token in its query), and a proposer needs the place, not that.
fn address_shown(url: &str, asked: &[String], held: &[String]) -> String {
    let Ok(mut u) = url::Url::parse(url) else { return String::new() };
    let is_asked = |v: &str| asked.iter().any(|a| a.eq_ignore_ascii_case(v));
    let of_the_session = |v: &str| of_the_session(v, held);
    let query: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), if is_asked(&v) { v.into_owned() } else { "{value}".to_string() })).collect();
    let path: Vec<String> = u
        .path_segments()
        .into_iter()
        .flatten()
        .map(|p| {
            let said = percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned();
            if !is_asked(&said) && (of_the_session(&said) || reads_as_a_key(p)) { "{session}".to_string() } else { p.to_string() }
        })
        .collect();
    u.set_path(&path.join("/"));
    u.set_fragment(None);
    if query.is_empty() {
        u.set_query(None);
    } else {
        u.query_pairs_mut().clear().extend_pairs(query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    u.to_string()
}

/// Every way `text` reads: as written, then decoded until decoding changes nothing. None when it is still changing
/// after [`DECODED_MOST`] readings: nothing a page wrote to be read, so it is never shown.
fn readings(text: &str) -> Option<Vec<String>> {
    let mut all = vec![text.to_string()];
    for _ in 0..DECODED_MOST {
        let last = &all[all.len() - 1];
        let once = percent_encoding::percent_decode_str(last).decode_utf8_lossy().into_owned();
        if once == *last {
            return Some(all);
        }
        all.push(once);
    }
    None
}

/// Whether `text` carries something the session holds, however many times the address wrote it over.
pub(super) fn of_the_session(text: &str, held: &[String]) -> bool {
    readings(text).is_none_or(|all| all.iter().any(|said| held.iter().any(|h| !h.is_empty() && said.contains(h.as_str()))))
}

/// Whether a piece of an address is written as a key and not as a word, however many times it was written over: a
/// long run of hex, or a long unbroken run mixing letters and digits. The walk's log does not always say what a page
/// kept in its storage or computed, so a piece written this way is named to a proposer whoever holds it; a proposer
/// reads a site by its words.
pub(super) fn reads_as_a_key(piece: &str) -> bool {
    readings(piece).is_none_or(|all| all.iter().any(|said| written_as_a_key(said)))
}

fn written_as_a_key(said: &str) -> bool {
    let hex = said.chars().filter(char::is_ascii_hexdigit).count();
    if hex >= KEY_HEX_LEAST && said.chars().all(|c| c.is_ascii_hexdigit() || c == '-') && said.chars().any(|c| c.is_ascii_digit()) {
        return true;
    }
    said.split(|c: char| !c.is_ascii_alphanumeric()).any(|run| {
        let (digits, letters) = (run.chars().filter(char::is_ascii_digit).count(), run.chars().filter(char::is_ascii_alphabetic).count());
        run.len() >= KEY_RUN_LEAST && digits >= 2 && letters >= 2
    })
}

/// The shortest run of hex, and the shortest unbroken run of letters and digits together, read as a key.
const KEY_HEX_LEAST: usize = 16;
const KEY_RUN_LEAST: usize = 12;

/// How many times a piece of an address is decoded before it is taken as written to hide something.
const DECODED_MOST: usize = 4;

/// A path as a proposer reads it: each piece `hidden` says is the session's is named, never shown.
pub(super) fn path_shown(path: &str, hidden: impl Fn(&str) -> bool) -> String {
    path.split('/').map(|piece| if !piece.is_empty() && hidden(piece) { "{session}" } else { piece }).collect::<Vec<_>>().join("/")
}

/// A call's place as a proposer reads it.
fn place_shown(e: &Exchange, held: &[String]) -> String {
    format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), path_shown(e.url.path(), |p| of_the_session(p, held) || reads_as_a_key(p)))
}

fn place_of(e: &Exchange) -> String {
    format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), e.url.path())
}

/// One walk's layer of the graph. `other` is the other walk of the page and what each was asked.
fn walk_layer(tag: &str, url: &str, trace: &Trace, asked: &[String], other: &Trace, other_asked: &[String]) -> Value {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    let view = view_of(tag, url, &walked_site(&trace.exchanges, &host), trace, 0);
    let says = |v: &Value| -> usize {
        let lines = said_lines(v, &[]);
        asked.iter().map(|a| a.to_lowercase()).map(|a| lines.iter().filter(|l| l.contains(&a)).count()).max().unwrap_or(0)
    };
    let page = trace.exchanges.iter().rev().find(|e| e.is_main_document() && (200..300).contains(&e.status));
    let page_text = page.and_then(|e| e.response_body.as_deref().map(|b| unbrowse_learn::page::read(b, &e.url)));
    // What the site gave the session to hold and hand back (a cookie's value, a token an answer delivered): a
    // proposer is told that a call sent one and where, never the value.
    let held = unbrowse_learn::provenance::session_values(trace);
    let calls: Vec<Value> = view
        .candidates
        .iter()
        .map(|c| {
            let e = &trace.exchanges[c.index];
            let answer = data_of(e);
            let fields: Vec<String> = answer.as_ref().map(|v| unbrowse_learn::fields::paths(v).into_iter().map(|f| f.path).take(14).collect()).unwrap_or_default();
            let sends: Vec<Value> = parts(e)
                .into_iter()
                .filter(|(_, v)| !v.is_empty())
                .take(24)
                .map(|(at, v)| {
                    let relation = if asked.iter().any(|a| a.eq_ignore_ascii_case(&v)) {
                        "the asked value"
                    } else if asked.iter().any(|a| a.chars().count() >= 2 && v.to_lowercase().contains(&a.to_lowercase())) {
                        "holds the asked value"
                    } else {
                        ""
                    };
                    // The asked value is the caller's and is shown. Anything else the session holds, or written as
                    // a key, is named: beside the asked value in one part as much as alone.
                    let of_the_session = relation != "the asked value" && (of_the_session(&v, &held) || reads_as_a_key(&v));
                    let mut part = json!({ "at": at, "value": if of_the_session { "{session}".to_string() } else { shown(&v) } });
                    if !relation.is_empty() {
                        part["is"] = json!(relation);
                    }
                    part
                })
                .collect();
            json!({
                "id": format!("{tag}:{}", c.index),
                "call": place_shown(e, &held),
                "is_the_page": c.page,
                "sends": sends,
                "answer": { "status": e.status, "bytes": c.bytes, "shape": c.shape, "fields": fields, "lines_saying_the_asked_value": answer.as_ref().map(says).unwrap_or(0) },
                "on_the_other_walk": format!("{:?}", experiment::told(trace, c.index, asked, other, other_asked)).to_lowercase(),
            })
        })
        .collect();
    // The session, by name: where each cookie the walk sent was set, and whether the other walk sent another value.
    let sent_cookies = |t: &Trace| -> std::collections::BTreeMap<String, String> { t.exchanges.iter().flat_map(|e| e.cookies()).collect() };
    let (mine, theirs) = (sent_cookies(trace), sent_cookies(other));
    let session: Vec<Value> = mine
        .iter()
        .take(40)
        .map(|(name, value)| {
            let set_by = trace.exchanges.iter().find(|e| e.response_headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("set-cookie") && v.starts_with(&format!("{name}="))));
            json!({ "cookie": name, "set_by": set_by.map(|e| place_shown(e, &held)).unwrap_or_else(|| "before the walk, or by the page's code".into()), "differs_on_the_other_walk": theirs.get(name).is_some_and(|v| v != value) })
        })
        .collect();
    json!({
        "walk": tag,
        "asked": asked,
        "page": {
            "address": address_shown(url, asked, &held),
            "status": page.map(|e| e.status),
            "lines_saying_the_asked_value": page_text.as_ref().map(says).unwrap_or(0),
            "offers": trial::another_word(trace, url, asked),
        },
        "calls": calls,
        "session": session,
    })
}

/// The graph of one page walked for two values, with the engine's draft and what the experiment settled about the
/// drafted call: each part of its request that differs between the walks, what the draft made of it, and, where the
/// value was seen in an earlier answer on both walks at the same place, that place.
pub(super) fn of_two_walks(goal: &str, first: (&str, &Trace), second: (&str, &Trace), draft: Option<&str>) -> Value {
    let (asked, other_asked) = experiment::asked_apart(first.0, second.0);
    let layers = [walk_layer("a", first.0, first.1, &asked, second.1, &other_asked), walk_layer("b", second.0, second.1, &other_asked, first.1, &asked)];
    let at = |t: &Trace| draft.and_then(|call| t.exchanges.iter().rposition(|e| place_of(e).eq_ignore_ascii_case(call)));
    let held = (unbrowse_learn::provenance::session_values(first.1), unbrowse_learn::provenance::session_values(second.1));
    let mut settled = Vec::new();
    if let (Some(i), Some(j)) = (at(first.1), at(second.1)) {
        let (pa, pb) = (parts(&first.1.exchanges[i]), parts(&second.1.exchanges[j]));
        for (key, va) in &pa {
            let Some((_, vb)) = pb.iter().find(|(k, _)| k == key) else { continue };
            if va == vb || va.is_empty() || asked.iter().any(|a| a.eq_ignore_ascii_case(va)) {
                continue;
            }
            // Seen before it was sent, at the same place, on both walks: the experiment's own proof of an edge.
            let from = seen_before(first.1, i, va).into_iter().find_map(|(n, pointer)| {
                let there = place_of(&first.1.exchanges[n]);
                let on_other = second.1.exchanges[..j].iter().rev().filter(|e| place_of(e) == there).filter_map(data_of).any(|v| v.pointer(&pointer).is_some_and(|leaf| is_value(leaf.to_string().trim_matches('"'), vb)));
                on_other.then(|| json!({ "call": place_shown(&first.1.exchanges[n], &held.0), "pointer": pointer }))
            });
            let seen = |v: &str, held: &[String]| if of_the_session(v, held) || reads_as_a_key(v) { "{session}".to_string() } else { shown(v) };
            settled.push(json!({ "at": key, "on_a": seen(va, &held.0), "on_b": seen(vb, &held.1), "comes_from": from }));
        }
    }
    json!({
        "goal": goal,
        "walks": layers,
        "draft": { "answer": draft },
        "differs_between_the_walks_in_the_drafted_call": settled,
    })
}

/// The graph as a proposer is sent it: the calls that could be an answer, most promising first, each cut to what
/// tells them apart. A walk of a busy page makes hundreds of calls; a proposer asked to read them all reads none well.
pub(super) fn for_a_proposer(mut graph: Value) -> Value {
    for walk in graph["walks"].as_array_mut().into_iter().flatten() {
        if let Some(obj) = walk.as_object_mut() {
            obj.remove("session");
        }
        let Some(calls) = walk["calls"].as_array_mut() else { continue };
        calls.sort_by_key(|c| std::cmp::Reverse((c["answer"]["lines_saying_the_asked_value"].as_u64().unwrap_or(0), c["answer"]["bytes"].as_u64().unwrap_or(0))));
        calls.truncate(14);
        for call in calls.iter_mut() {
            if let Some(sends) = call["sends"].as_array_mut() {
                sends.truncate(10);
            }
            if let Some(fields) = call["answer"]["fields"].as_array_mut() {
                fields.truncate(10);
            }
        }
    }
    graph
}

/// What the walk did to the page and what the page then sent, and who in the page's code sent each call: the two
/// layers a trace does not hold, read from the walk's own log. An action is a nudge (a scroll, a press of a control
/// that asks for more) with the calls first sent within two seconds of it; a sender is the innermost frame of the
/// stack the browser reported with the request. A log from before either was recorded yields nothing.
#[cfg(test)]
pub(super) fn actions_and_senders(log: &str) -> (Vec<Value>, std::collections::BTreeMap<String, String>) {
    let lines: Vec<Value> = log.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let at = |v: &Value| v.get("t").and_then(|t| t.as_f64()).unwrap_or_default();
    let is = |v: &Value, kind: &str| v.get("type").and_then(|t| t.as_str()) == Some(kind);
    let place = |v: &Value| -> Option<String> {
        let u = url::Url::parse(v.get("url")?.as_str()?).ok()?;
        Some(format!("{} {}{}", v.get("method").and_then(|m| m.as_str()).unwrap_or("GET"), u.host_str()?, u.path()))
    };
    let calls: Vec<&Value> = lines.iter().filter(|v| is(v, "request") && matches!(v.get("resourceType").and_then(|t| t.as_str()), Some("XHR" | "Fetch"))).collect();
    let mut seen_before: std::collections::BTreeSet<String> = Default::default();
    let mut actions = Vec::new();
    let nudges: Vec<&Value> = lines.iter().filter(|v| is(v, "nudge")).collect();
    for (n, nudge) in nudges.iter().enumerate() {
        let (from, to) = (at(nudge), nudges.get(n + 1).map(|next| at(next)).unwrap_or(f64::MAX).min(at(nudge) + 2.0));
        seen_before.extend(calls.iter().filter(|c| at(c) < from).filter_map(|c| place(c)));
        let mut then: Vec<String> = calls.iter().filter(|c| at(c) >= from && at(c) < to).filter_map(|c| place(c)).filter(|p| !seen_before.contains(p)).collect();
        then.sort();
        then.dedup();
        actions.push(json!({ "did": nudge.get("did").and_then(|d| d.as_str()).unwrap_or_default(), "calls_first_sent_after": then }));
    }
    let mut senders = std::collections::BTreeMap::new();
    for call in &calls {
        let Some(frame) = call.get("sentBy").and_then(|s| s.as_array()).and_then(|s| s.first()) else { continue };
        let script = frame.get("url").and_then(|u| u.as_str()).unwrap_or_default().rsplit('/').next().unwrap_or_default().to_string();
        if let Some(place) = place(call) {
            senders.entry(place).or_insert(format!("{} in {script}", frame.get("function").and_then(|f| f.as_str()).filter(|f| !f.is_empty()).unwrap_or("(anonymous)")));
        }
    }
    (actions, senders)
}

/// What the page kept in the browser's storage, by name, and the calls that sent each value on: a value a call
/// sends that sits in storage was read from there by the page's code. Only a value long enough to be told from
/// chance is traced, and only its name is said.
#[cfg(test)]
pub(super) fn storage_and_readers(log: &str) -> Vec<Value> {
    let lines: Vec<Value> = log.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let is = |v: &Value, kind: &str| v.get("type").and_then(|t| t.as_str()) == Some(kind);
    let Some(kept) = lines.iter().rev().find(|v| is(v, "storage")) else { return Vec::new() };
    let calls: Vec<(String, String)> = lines
        .iter()
        .filter(|v| is(v, "request") && matches!(v.get("resourceType").and_then(|t| t.as_str()), Some("XHR" | "Fetch")))
        .filter_map(|v| {
            let u = url::Url::parse(v.get("url")?.as_str()?).ok()?;
            let place = format!("{} {}{}", v.get("method").and_then(|m| m.as_str()).unwrap_or("GET"), u.host_str()?, u.path());
            Some((place, format!("{} {} {}", u, v.get("postData").and_then(|p| p.as_str()).unwrap_or_default(), v.get("headers").map(|h| h.to_string()).unwrap_or_default())))
        })
        .collect();
    let mut out = Vec::new();
    for kind in ["local", "session"] {
        for (name, value) in kept.get(kind).and_then(|m| m.as_object()).into_iter().flatten() {
            let Some(value) = value.as_str().filter(|v| v.chars().count() >= 8) else { continue };
            let mut sent_to: Vec<&str> = calls.iter().filter(|(_, sent)| sent.contains(value)).map(|(place, _)| place.as_str()).collect();
            sent_to.sort();
            sent_to.dedup();
            if !sent_to.is_empty() {
                out.push(json!({ "storage": name, "kind": kind, "sent_by_calls": sent_to.into_iter().take(5).collect::<Vec<_>>() }));
            }
        }
    }
    out
}

/// Writes each site's graph beside its walks: `UNBROWSE_CORPUS=<folder> UNBROWSE_GRAPH_SITES=a.com,b.com`.
#[test]
fn the_graph_of_a_site_walked_twice() {
    let (Some(corpus), Ok(sites)) = (std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from), std::env::var("UNBROWSE_GRAPH_SITES")) else { return };
    store::scratch_home("sitegraph");
    let mut by_site: std::collections::BTreeMap<String, Vec<(String, String, Trace, String)>> = Default::default();
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus).expect("the corpus folder").flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect();
    dirs.sort_by_key(|d| std::fs::metadata(d.join("case.json")).and_then(|m| m.modified()).ok());
    for dir in dirs {
        let Ok(case) = std::fs::read_to_string(dir.join("case.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) else { continue };
        let said = |key: &str| case.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if !sites.split(',').any(|s| s.trim() == said("site")) {
            continue;
        }
        let Some(capture) = std::fs::read_dir(&dir).ok().and_then(|d| d.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl"))) else { continue };
        let Some(trace) = capture.file_stem().and_then(|s| s.to_str()).and_then(|s| trace_from_walk(&dir, s)) else { continue };
        by_site.entry(said("site")).or_default().push((said("url"), said("goal"), trace, std::fs::read_to_string(&capture).unwrap_or_default()));
    }
    for (site, walks) in &by_site {
        let [(url, goal, first, log), (other_url, _, second, other_log)] = &walks[..] else { continue };
        let draft = corpus::read(url, goal, first.clone(), &[], None);
        let mut graph = of_two_walks(goal, (url, first), (other_url, second), Some(&draft.call).filter(|c| !c.is_empty()).map(String::as_str));
        // The layers a trace does not hold, laid on each walk: what the walk did, and who sent each call.
        for (n, log) in [log, other_log].into_iter().enumerate() {
            let (actions, senders) = actions_and_senders(log);
            graph["walks"][n]["the_walk_did"] = json!(actions);
            graph["walks"][n]["storage_the_calls_read"] = json!(storage_and_readers(log));
            for call in graph["walks"][n]["calls"].as_array_mut().into_iter().flatten() {
                if let Some(sender) = call["call"].as_str().and_then(|place| senders.get(place)) {
                    call["sent_by"] = json!(sender);
                }
            }
        }
        let out = corpus.join(format!("{site}.graph.json"));
        std::fs::write(&out, serde_json::to_string_pretty(&graph).expect("a graph is JSON")).expect("the corpus takes its graphs");
        println!("{site}: {} bytes, {} differing parts, {} with a source on both walks", std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0), graph["differs_between_the_walks_in_the_drafted_call"].as_array().map_or(0, Vec::len), graph["differs_between_the_walks_in_the_drafted_call"].as_array().map_or(0, |a| a.iter().filter(|p| !p["comes_from"].is_null()).count()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A call first sent after the walk pressed a control is laid beside that press, with who in the page's code
    /// sent it; a call the page had already made is not, and a scroll that brought nothing says so.
    #[test]
    fn what_the_walk_did_is_laid_beside_what_the_page_then_sent() {
        let log = [
            r#"{"type":"request","t":1.0,"method":"GET","url":"https://shop.example/api/first?q=lamp","resourceType":"Fetch","sentBy":[{"url":"https://cdn.example/js/app.js","function":"load"}]}"#,
            r#"{"type":"nudge","t":2.0,"did":"pressed: Show more results"}"#,
            r#"{"type":"request","t":2.4,"method":"POST","url":"https://shop.example/api/search","resourceType":"Fetch","sentBy":[{"url":"https://cdn.example/js/list.js","function":"more"}]}"#,
            r#"{"type":"request","t":2.5,"method":"GET","url":"https://shop.example/api/first?q=lamp","resourceType":"Fetch"}"#,
            r#"{"type":"nudge","t":5.0,"did":"scrolled"}"#,
        ]
        .join("\n");
        let (actions, senders) = actions_and_senders(&log);
        assert_eq!(actions[0]["did"], "pressed: Show more results");
        assert_eq!(actions[0]["calls_first_sent_after"], json!(["POST shop.example/api/search"]));
        assert_eq!(actions[1]["calls_first_sent_after"], json!([]));
        assert_eq!(senders.get("POST shop.example/api/search").map(String::as_str), Some("more in list.js"));
    }

    /// A value the page kept in storage and a call then sent is laid on the graph by its name, with the calls that
    /// sent it; a value no call sent, and one too short to tell from chance, are not.
    #[test]
    fn a_stored_value_a_call_sends_names_where_the_call_read_it() {
        let log = [
            r#"{"type":"request","t":1.0,"method":"POST","url":"https://shop.example/api/search","postData":"{\"device\":\"d-7f3a9c21e4\"}","resourceType":"Fetch","headers":{"x-visit":"v-55aa66bb77"}}"#,
            r#"{"type":"request","t":1.2,"method":"GET","url":"https://shop.example/api/menu","resourceType":"Fetch","headers":{}}"#,
            r#"{"type":"storage","t":9.0,"local":{"deviceId":"d-7f3a9c21e4","theme":"dark","unused":"zzzzzzzzzzzz"},"session":{"visit":"v-55aa66bb77"}}"#,
        ]
        .join("\n");
        let read = storage_and_readers(&log);
        assert_eq!(read, vec![json!({"storage": "deviceId", "kind": "local", "sent_by_calls": ["POST shop.example/api/search"]}), json!({"storage": "visit", "kind": "session", "sent_by_calls": ["POST shop.example/api/search"]})]);
    }

    /// A number is the same value at another precision; a word is itself.
    #[test]
    fn a_value_is_found_again_as_an_answer_writes_it() {
        assert!(is_value("48.8640620120720", "48.864062012071955"));
        assert!(!is_value("48.9", "48.864062012071955"));
        assert!(is_value("paris", "paris") && !is_value("Paris", "paris"));
        assert!(!is_value("2", "20"));
    }

    /// What the site gave the session to hand back (a token an earlier answer delivered) is named where a call sent
    /// it and never shown to a proposer; what the page was asked is shown as it is.
    #[test]
    fn a_proposer_is_never_shown_what_the_session_holds() {
        let seen = |method: &str, url: &str, body: &str, doc: bool| Exchange {
            method: method.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: if doc { "text/html".into() } else { "application/json".into() },
            resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        };
        let walk = |word: &str, token: &str| {
            let results = (0..12).map(|n| format!(r#"{{"title":"{word} number {n}","price":{n}}}"#)).collect::<Vec<_>>().join(",");
            Trace {
                exchanges: vec![
                    seen("GET", &format!("https://shop.example/s?q={word}"), "<html><body>results</body></html>", true),
                    seen("GET", "https://shop.example/api/session", &format!(r#"{{"account":{{"token":"{token}"}}}}"#), false),
                    seen("GET", &format!("https://shop.example/api/search?q={word}&token={token}"), &format!(r#"{{"results":[{results}]}}"#), false),
                ],
                inputs: Vec::new(),
            }
        };
        let (a, b) = (walk("brass", "tok9f3aQ77zLm21xP"), walk("glass", "tok5c8dR02yKn64wS"));
        let graph = for_a_proposer(of_two_walks("search the shop", ("https://shop.example/s?q=brass", &a), ("https://shop.example/s?q=glass", &b), None)).to_string();
        assert!(!graph.contains("tok9f3aQ77zLm21xP") && !graph.contains("tok5c8dR02yKn64wS"), "{graph}");
        assert!(graph.contains("{session}") && graph.contains("brass") && graph.contains("glass"), "{graph}");
        // A value a call sends that no answer of the walk delivered (the page made it, or kept it in its storage) is
        // named when it is written as a key, alone or beside the asked value; a word it sends is shown.
        let made = |word: &str| {
            let mut t = walk(word, "tok9f3aQ77zLm21xP");
            t.exchanges[2].url = url::Url::parse(&format!("https://shop.example/api/search?q={word}&device=k7Qm2xP9aL4tZ8&mix={word}.m3Rk8vT2pQ6xW9&sort=newest")).unwrap();
            t
        };
        let graph = for_a_proposer(of_two_walks("search the shop", ("https://shop.example/s?q=brass", &made("brass")), ("https://shop.example/s?q=glass", &made("glass")), None)).to_string();
        assert!(!graph.contains("k7Qm2xP9aL4tZ8") && !graph.contains("m3Rk8vT2pQ6xW9"), "{graph}");
        assert!(graph.contains("newest") && graph.contains("brass"), "{graph}");
        // The address itself: what was asked is shown, any other value of its query is named by its key alone.
        // A call's own place is read by the same rule, however the address wrote the value over.
        let held = vec!["Zx81kQ0pLm".to_string()];
        let call = |path: &str| place_shown(&Exchange { url: url::Url::parse(&format!("https://shop.example{path}")).unwrap(), ..a.exchanges[0].clone() }, &held);
        assert_eq!(call("/api/u/Zx81kQ0pLm/items"), "GET shop.example/api/u/{session}/items");
        assert_eq!(call("/api/u/v2.Zx81kQ0pLm.sig/items"), "GET shop.example/api/u/{session}/items");
        assert_eq!(call("/api/u/Zx81kQ%2530pLm/items"), "GET shop.example/api/u/{session}/items");
        assert_eq!(call("/api/search"), "GET shop.example/api/search");
        // What the page kept in its storage, or computed, the walk's log may not say: a piece written as a key is
        // named all the same, and a piece written as words is shown.
        assert_eq!(call("/api/u/k7Qm2xP9aL4tZ8/items"), "GET shop.example/api/u/{session}/items");
        assert_eq!(call("/api/u/3f2a9c21-77e4-4b1a-9d0e-5a6b7c8d9e0f"), "GET shop.example/api/u/{session}");
        assert_eq!(call("/api/u/%256B%2537%2551%256D%2532%2578%2550%2539%2561%254C%2534%2574%255A%2538/items"), "GET shop.example/api/u/{session}/items", "written over twice");
        assert!(reads_as_a_key("%25252525256B") && !reads_as_a_key("lamp%2520shade"), "still changing after every reading is never shown; a word written over is a word");
        assert_eq!(call("/p/brass-lamp-shade-2024/reviews"), "GET shop.example/p/brass-lamp-shade-2024/reviews");
        assert_eq!(call("/v2/search/iphone%2015"), "GET shop.example/v2/search/iphone%2015");
        let shown = address_shown("https://shop.example/s?q=brass&reset=Zx81kQ0pLm#frag", &["brass".to_string()], &[]);
        assert!(shown.contains("q=brass") && shown.contains("reset=") && !shown.contains("Zx81kQ0pLm") && !shown.contains("frag"), "{shown}");
        // And the drafted call's parts that differ between the walks: a token each walk was given is named.
        let drafted = of_two_walks("search the shop", ("https://shop.example/s?q=brass", &a), ("https://shop.example/s?q=glass", &b), Some("GET shop.example/api/search")).to_string();
        assert!(!drafted.contains("tok9f3aQ77zLm21xP") && !drafted.contains("tok5c8dR02yKn64wS"), "{drafted}");
    }
}
