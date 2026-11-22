//! Learning a route from a walk: the harness-level pipeline.
//!
//! The browser walks once (in-process, `agent_browser_core::session::mint`),
//! the walk is a trace, and the trace is a route graph. This module is the
//! seam between those — no CLI, no daemon, no HAR files on disk.

use std::path::Path;

use crate::identity::site_of;
use crate::trace::Trace;

/// Where the walk actually landed: the site suffix of the last page the main
/// frame was let through to. The walk's first document is its own navigation,
/// so it names the site even when the door refused it; a log without frames
/// cannot tell the main frame's later pages from a widget's or an ad's, and
/// there the first document is all it has.
pub fn landed_site(trace: &Trace) -> Option<String> {
    let pages = || {
        trace
            .exchanges
            .iter()
            .filter(|e| matches!(e.url.scheme(), "http" | "https"))
            .filter(|e| e.is_main_document())
    };
    let framed = trace.exchanges.iter().any(|e| e.main_frame.is_some());
    let through = if framed { pages().rfind(|e| !e.is_refused()) } else { None };
    through.or_else(|| pages().next()).and_then(|e| e.url.host_str()).map(site_of)
}

/// The walk's trace, for callers that want to inspect it first.
pub fn trace_from_walk(capture_dir: &Path, session: &str) -> Option<Trace> {
    let har = agent_browser_core::session::walk_har(capture_dir, session);
    Trace::from_har(&har.to_string(), vec![]).ok()
}

/// Every address the walk's browser was at, fragment and all, in order, when the capture shows the record is whole;
/// None when it doesn't, which a reader takes as a walk that may have been at an address with a fragment. Missing,
/// unverifiable or contradictory evidence never reads as clean.
///
/// The record is whole only when every one of these holds ([`addresses_in`]):
/// - every line of the capture reads as JSON (a line that doesn't may have been any of these);
/// - the capture says it records addresses (`addresses`), before any request, address or target line;
/// - it closes with exactly one line (`addresses_end`), after every request, address and target line, whose count
///   matches the `address` and `target` lines it holds, that says no line failed to reach the file, that says the
///   walk lost none of the browser's events (`missed` is 0, and present), and that says the walk ended the record
///   itself rather than its browser's line closing under it (`cut_off` is false, and present);
/// - no target's recording was off (`address_off`), and it holds no exchange of another kind than this walk writes
///   (an `exchange` line ties to no frame);
/// - every address and target line has its address as text and a time, and every target line its target;
/// - every request has its id and a time, and came from somewhere the record covers: a request of an attached target
///   (its id is the request's prefix) only after that target's own address was recorded; a request of the page's
///   frames only after an address of that same frame was (a frame's own document arrives before its navigation is
///   reported, so it needs one at some point; anything else it asks for needs one first). A request with no frame, or a
///   frame the record has no address for, is not covered: nothing ties it to a place. A CORS preflight (its initiator
///   says `preflight` and names the request it was sent for, on its own session) is covered by that request, and only
///   when that request is. A frame's address counts whichever session reported it: a frame in a process of its own
///   reports its moves on its target's session, and the page the request for its document.
pub fn addresses_from_walk(capture_dir: &Path, session: &str) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(capture_dir.join(format!("{session}.jsonl"))).ok()?;
    addresses_in(&text)
}

/// [`addresses_from_walk`] with the fragments that are not the owner's taken off: what the share guard reads
/// (`learn::walk_without_fragment`). A fragment never reaches a server, so one the walk was at may be what only the owner
/// had (a token a sign-in handed back in its redirect, a word typed into the page). One whose text an answer handed the
/// page *before* the walk reached it (an anchor the page's own markup or code names, `#hp-just-for-you`) is no such
/// thing: a server had it first. So is one with no letter or digit in it (`#?`). Everything else stays as recorded.
pub fn owners_addresses_from_walk(capture_dir: &Path, session: &str) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(capture_dir.join(format!("{session}.jsonl"))).ok()?;
    owners_addresses_in(&text)
}

/// [`owners_addresses_from_walk`] over a capture's text.
pub fn owners_addresses_in(text: &str) -> Option<Vec<String>> {
    let visited = addresses_in(text)?;
    let lines: Vec<serde_json::Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let kind = |v: &serde_json::Value| v.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    let t = |v: &serde_json::Value| v.get("t").and_then(|t| t.as_f64());
    // Each recorded address with the time it was reached, in the record's order.
    let reached: Vec<(String, f64)> = lines
        .iter()
        .filter(|v| matches!(kind(v).as_str(), "address" | "target"))
        .filter_map(|v| Some((v.get("url")?.as_str()?.to_string(), t(v)?)))
        .collect();
    let answers: Vec<(f64, &str)> = lines.iter().filter(|v| kind(v) == "response").filter_map(|v| Some((t(v)?, v.get("body")?.as_str()?))).collect();
    let handed_before = |piece: &str, at: f64| answers.iter().any(|(when, body)| *when < at && stands_whole_in(body, piece));
    Some(
        visited
            .into_iter()
            .map(|url| {
                let Some((head, fragment)) = url.split_once('#') else { return url };
                let words = percent_encoding::percent_decode_str(fragment).decode_utf8_lossy().trim_matches(|c: char| !c.is_alphanumeric()).to_string();
                let at = reached.iter().find(|(u, _)| *u == url).map(|(_, t)| *t).unwrap_or(f64::MAX);
                if words.is_empty() || handed_before(&words, at) {
                    head.to_string()
                } else {
                    url
                }
            })
            .collect(),
    )
}

/// Whether `piece` is in `text` whole: no letter or digit runs on across either of its edges.
fn stands_whole_in(text: &str, piece: &str) -> bool {
    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    text.match_indices(piece).any(|(at, _)| !word(text[..at].chars().next_back()) && !word(text[at + piece.len()..].chars().next()))
}

/// The version of the rule [`addresses_in`] accepts a record by. Bump it whenever that rule changes (what makes a
/// record whole, what covers a request): a route whose walk was judged by any other version, or by none, is read as one
/// whose walk may have been at an address with a fragment (`recipe::compile_with`). 1 took the opening line's word; 2
/// asked for a matching close and covered requests; 3 also asks that no event was lost and that every request names
/// its frame, and reads a line that doesn't, a second close or anything outside the record as no record; 4 also asks
/// that the walk, not its browser's line closing, ended the record (`cut_off` false, and present); 5 covers a CORS
/// preflight by the request it was sent for, and ties a frame to its address whichever session reported it; 6 reads a
/// fragment an answer handed the page before the walk reached it as the site's (`owners_addresses_in`).
pub const ADDRESS_READER: u32 = 6;

/// The oldest reader whose verdict still stands: 5 and 6 only ever find more of a walk's record whole (a preflight
/// covered, a frame's address from any session) and fewer of its fragments the owner's (one the site handed over), so a
/// walk 4 read as whole and without the owner's fragment reads so still. One 4 refused stays refused until walked again.
pub const OLDEST_TRUSTED_ADDRESS_READER: u32 = 4;

/// [`addresses_from_walk`] over a capture's text.
pub fn addresses_in(text: &str) -> Option<Vec<String>> {
    let mut lines: Vec<serde_json::Value> = Vec::new();
    for l in text.lines().filter(|l| !l.trim().is_empty()) {
        lines.push(serde_json::from_str(l).ok()?);
    }
    let kind = |v: &serde_json::Value| v.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    let t = |v: &serde_json::Value| v.get("t").and_then(|t| t.as_f64());
    let text_of = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
    let tracked = |k: &str| matches!(k, "request" | "address" | "target");
    // Opened before anything it records, and closed once, after everything it records.
    let opened = lines.iter().position(|v| kind(v) == "addresses" && v.get("recorded").and_then(|r| r.as_bool()) == Some(true))?;
    if lines[..opened].iter().any(|v| tracked(&kind(v))) {
        return None;
    }
    let ends: Vec<usize> = lines.iter().enumerate().filter(|(_, v)| kind(v) == "addresses_end").map(|(i, _)| i).collect();
    let [closed] = ends[..] else { return None };
    if lines[closed..].iter().any(|v| tracked(&kind(v))) {
        return None;
    }
    if lines.iter().any(|v| matches!(kind(v).as_str(), "address_off" | "exchange")) {
        return None;
    }
    let recorded: Vec<&serde_json::Value> = lines.iter().filter(|v| matches!(kind(v).as_str(), "address" | "target")).collect();
    let end = &lines[closed];
    let whole = end.get("written").and_then(|n| n.as_u64()) == Some(recorded.len() as u64)
        && end.get("failed").and_then(|f| f.as_bool()) == Some(false)
        && end.get("missed").and_then(|m| m.as_u64()) == Some(0)
        && end.get("cut_off").and_then(|c| c.as_bool()) == Some(false);
    if !whole {
        return None;
    }
    // Each address with its place: an attached target's own (by its session), or a frame of the page's (by its id).
    let mut targets: Vec<(String, f64)> = Vec::new();
    let mut frames: Vec<(String, f64)> = Vec::new();
    let mut urls = Vec::new();
    for v in &recorded {
        let (Some(url), Some(at)) = (text_of(v, "url"), t(v)) else { return None };
        if kind(v) == "target" {
            targets.push((text_of(v, "session").filter(|s| !s.is_empty())?, at));
        } else if let Some(frame) = text_of(v, "frame").filter(|f| !f.is_empty()) {
            // An address tied to its frame, whichever session reported it: a frame's id names one frame across the
            // browser, and a frame in a process of its own reports its moves on its own target's session while the page
            // reports the request for its document.
            frames.push((frame, at));
        }
        urls.push(url);
    }
    let requests: Vec<&serde_json::Value> = lines.iter().filter(|v| kind(v) == "request").collect();
    let covered = |r: &serde_json::Value| -> Option<bool> {
        let (Some(id), Some(at)) = (text_of(r, "requestId").filter(|i| !i.is_empty()), t(r)) else { return None };
        let frame = text_of(r, "frameId").unwrap_or_default();
        Some(match id.split_once(':') {
            Some((target, _)) => targets.iter().any(|(s, when)| s == target && *when <= at),
            None if frame.is_empty() => false,
            None if text_of(r, "resourceType").as_deref() == Some("Document") => frames.iter().any(|(f, _)| *f == frame),
            None => frames.iter().any(|(f, when)| *f == frame && *when <= at),
        })
    };
    for r in &requests {
        if covered(r)? {
            continue;
        }
        // A CORS preflight is the browser's own, sent for one request of the page's (its initiator names it, on the
        // same session): it was where that request was. It is covered when the request it was sent for is, and by
        // nothing else.
        let preflight_for = r.pointer("/initiator/type").and_then(|k| k.as_str()).filter(|k| *k == "preflight").and(r.pointer("/initiator/requestId").and_then(|i| i.as_str()));
        let session = text_of(r, "requestId").and_then(|id| id.split_once(':').map(|(s, _)| s.to_string()));
        let served = preflight_for.map(|of| match &session {
            Some(s) => format!("{s}:{of}"),
            None => of.to_string(),
        });
        let theirs = served.and_then(|of| requests.iter().find(|q| text_of(q, "requestId").as_deref() == Some(of.as_str())).copied());
        let theirs = theirs.filter(|q| q.pointer("/initiator/type").and_then(|k| k.as_str()) != Some("preflight"))?;
        if !covered(theirs)? {
            return None;
        }
    }
    Some(urls)
}

#[cfg(test)]
mod addresses_tests {
    /// A walk's capture records every address its browser was at, fragment and all: a navigation of any frame (its
    /// fragment reported apart), the page's own and one inside it, and a move within a document. A capture that doesn't record
    /// addresses says nothing, which is not the same as a walk that was at none with a fragment.
    #[test]
    fn a_walk_records_every_address_its_page_was_at() {
        use agent_browser_core::session::page_address;
        let nav = serde_json::json!({ "params": { "frame": { "id": "F1", "url": "https://bank.example.com/callback", "urlFragment": "#code=7391" } } });
        assert_eq!(page_address("Page.frameNavigated", &nav).map(|a| a.0).as_deref(), Some("https://bank.example.com/callback#code=7391"));
        let child = serde_json::json!({ "params": { "frame": { "id": "F2", "parentId": "F1", "url": "https://login.example.net/frame", "urlFragment": "#t=ab12" } } });
        assert_eq!(page_address("Page.frameNavigated", &child).map(|a| a.0).as_deref(), Some("https://login.example.net/frame#t=ab12"), "a frame inside the page is an address too");
        let hash = serde_json::json!({ "params": { "frameId": "F1", "url": "https://bank.example.com/app#/reset/ab12" } });
        assert_eq!(page_address("Page.navigatedWithinDocument", &hash), Some(("https://bank.example.com/app#/reset/ab12".to_string(), "F1".to_string())));
        assert_eq!(page_address("Network.requestWillBeSent", &hash), None);
    }

    /// The record of where a walk's browser was is evidence only when it is whole: it closes with a matching count and
    /// no failed write, no target's recording was off, and every request came from a frame or a target whose address
    /// was recorded first. Anything less is no record at all, read as a walk that may have been at an address with a
    /// fragment.
    #[test]
    fn a_walks_address_record_counts_only_when_it_is_whole() {
        let line = |v: serde_json::Value| v.to_string();
        let marker = line(serde_json::json!({ "type": "addresses", "recorded": true, "t": 0.0 }));
        let nav = line(serde_json::json!({ "type": "address", "t": 2.0, "url": "https://bank.example.com/start", "session": null, "frame": "F1" }));
        let doc = line(serde_json::json!({ "type": "request", "t": 1.0, "requestId": "1.1", "resourceType": "Document", "frameId": "F1" }));
        let call = line(serde_json::json!({ "type": "request", "t": 3.0, "requestId": "1.2", "resourceType": "Fetch", "frameId": "F1" }));
        let end = |n: u64, failed: bool| line(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": n, "failed": failed, "missed": 0, "cut_off": false }));
        let walk = |l: &[&String]| super::addresses_in(&l.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n"));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &end(1, false)]), Some(vec!["https://bank.example.com/start".to_string()]), "a whole record");
        assert_eq!(walk(&[&marker, &doc, &nav, &call]), None, "no closing line");
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &end(2, false)]), None, "a count that doesn't match");
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &end(1, true)]), None, "a line failed to reach the file");
        let off = line(serde_json::json!({ "type": "address_off", "t": 2.5, "session": "S2" }));
        assert_eq!(walk(&[&marker, &doc, &nav, &off, &call, &end(1, false)]), None, "a target whose moves weren't recorded");
        // A request from an attached target whose address wasn't recorded first, or from a frame with none at all.
        let child = line(serde_json::json!({ "type": "request", "t": 4.0, "requestId": "S2:7.1", "resourceType": "Fetch", "frameId": "F9" }));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &child, &end(1, false)]), None, "a target the record doesn't cover");
        let target = line(serde_json::json!({ "type": "target", "t": 3.5, "session": "S2", "kind": "iframe", "url": "https://id.example/cb#code=7391" }));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &target, &child, &end(2, false)]).map(|a| a.len()), Some(2), "covered, its address recorded");
        let early = line(serde_json::json!({ "type": "request", "t": 1.5, "requestId": "1.3", "resourceType": "Fetch", "frameId": "F1" }));
        assert_eq!(walk(&[&marker, &doc, &early, &nav, &end(1, false)]), None, "a call before its frame's address was recorded");
        let elsewhere = line(serde_json::json!({ "type": "request", "t": 5.0, "requestId": "1.4", "resourceType": "Script", "frameId": "F7" }));
        assert_eq!(walk(&[&marker, &doc, &nav, &elsewhere, &end(1, false)]), None, "a frame with no address recorded");
        assert_eq!(walk(&[&doc, &nav, &call, &end(1, false)]), None, "a capture that doesn't say it records addresses");
    }

    /// A message from the browser the walk can't read is an event it lost, counted with the relay's drops: one that isn't
    /// JSON, or a frame that wasn't UTF-8, handed on with its bad bytes replaced, that no longer reads. One that reads is
    /// read.
    #[test]
    fn a_message_the_walk_cannot_read_is_a_lost_event() {
        use agent_browser_core::session::event_lost;
        assert!(!event_lost(r#"{"method":"Page.navigatedWithinDocument","params":{"frameId":"F1","url":"https://a.example/#t=1"}}"#));
        assert!(event_lost(r#"{"method":"Page.navigatedWithinDocument","params":{"frameId":"F1","url":"https://a.exa"#), "cut short");
        let mangled = String::from_utf8_lossy(&[b'{', 0xff, b'"', b'm']).into_owned();
        assert!(event_lost(&mangled), "a frame that wasn't UTF-8");
        assert!(event_lost(""));
    }

    /// Every field the reader trusts reads as no record when it is absent, empty, duplicated, out of order or says
    /// otherwise than another line: events the walk knows it lost, a request with no frame, a line that isn't JSON, a
    /// second closing line, a request after the close or before the opening, an address with no address or no time, a
    /// request with no id or no time, a line of another kind of capture. Only the whole, consistent record is evidence.
    #[test]
    fn missing_or_unverifiable_address_evidence_reads_as_guarded() {
        let line = |v: serde_json::Value| v.to_string();
        let marker = line(serde_json::json!({ "type": "addresses", "recorded": true, "t": 0.0 }));
        let doc = line(serde_json::json!({ "type": "request", "t": 1.0, "requestId": "1.1", "resourceType": "Document", "frameId": "F1" }));
        let nav = line(serde_json::json!({ "type": "address", "t": 2.0, "url": "https://bank.example.com/start", "session": null, "frame": "F1" }));
        let call = line(serde_json::json!({ "type": "request", "t": 3.0, "requestId": "1.2", "resourceType": "Fetch", "frameId": "F1" }));
        let end = |v: serde_json::Value| line(v);
        let closing = end(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": 1, "failed": false, "missed": 0, "cut_off": false }));
        let walk = |l: &[&str]| super::addresses_in(&l.join("\n"));
        assert!(walk(&[&marker, &doc, &nav, &call, &closing]).is_some(), "the whole record is evidence");
        let lost = end(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": 1, "failed": false, "missed": 3, "cut_off": false }));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &lost]), None, "the walk lost events, one may have been a move to a fragment");
        let unsaid = end(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": 1, "failed": false }));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &unsaid]), None, "a close that doesn't say whether events were lost");
        // The browser's line closed under the walk (it went, or its connection broke): the walk didn't end the record.
        let cut = end(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": 1, "failed": false, "missed": 0, "cut_off": true }));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &cut]), None, "a record its source ended, not the walk");
        let silent = end(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": 1, "failed": false, "missed": 0 }));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &silent]), None, "a close that doesn't say who ended the record");
        let frameless = line(serde_json::json!({ "type": "request", "t": 4.0, "requestId": "1.3", "resourceType": "Ping", "frameId": "" }));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &frameless, &closing]), None, "a request tied to no frame");
        let unnamed = line(serde_json::json!({ "type": "request", "t": 4.0, "requestId": "1.3", "resourceType": "Fetch" }));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &unnamed, &closing]), None, "a request naming no frame");
        assert_eq!(walk(&[&marker, &doc, &nav, &call, "{not json", &closing]), None, "a line that doesn't read");
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &closing, &closing]), None, "two closing lines");
        assert_eq!(walk(&[&marker, &doc, &nav, &closing, &call]), None, "a request after the close");
        assert_eq!(walk(&[&doc, &marker, &nav, &call, &closing]), None, "a request before the record opened");
        let nowhere = line(serde_json::json!({ "type": "address", "t": 2.0, "session": null, "frame": "F1" }));
        assert_eq!(walk(&[&marker, &doc, &nowhere, &call, &closing]), None, "an address with no address");
        let timeless = line(serde_json::json!({ "type": "address", "url": "https://bank.example.com/start", "session": null, "frame": "F1" }));
        assert_eq!(walk(&[&marker, &doc, &timeless, &call, &closing]), None, "an address with no time");
        let untimed = line(serde_json::json!({ "type": "request", "requestId": "1.2", "resourceType": "Fetch", "frameId": "F1" }));
        assert_eq!(walk(&[&marker, &doc, &nav, &untimed, &closing]), None, "a request with no time");
        let anonymous = line(serde_json::json!({ "type": "request", "t": 3.0, "resourceType": "Fetch", "frameId": "F1" }));
        assert_eq!(walk(&[&marker, &doc, &nav, &anonymous, &closing]), None, "a request with no id");
        let theirs = line(serde_json::json!({ "type": "exchange", "t": 3.5, "entry": {} }));
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &theirs, &closing]), None, "an exchange of another kind of capture");
        let blank_target = line(serde_json::json!({ "type": "target", "t": 2.5, "session": "", "kind": "iframe", "url": "https://x.example/" }));
        let two = end(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": 2, "failed": false, "missed": 0, "cut_off": false }));
        assert_eq!(walk(&[&marker, &doc, &nav, &blank_target, &call, &two]), None, "a target naming no target");
        let other_frame = line(serde_json::json!({ "type": "address", "t": 2.0, "url": "https://bank.example.com/start", "session": null, "frame": "F2" }));
        assert_eq!(walk(&[&marker, &doc, &other_frame, &call, &closing]), None, "an address of another frame covers nothing here");
    }

    /// A CORS preflight names no frame: the browser sends it, for one request of the page's that its initiator names.
    /// It was where that request was, so it is covered when that request is, and only then: a preflight for a request
    /// the record doesn't cover, for none it holds, for another preflight, or one on another session than its request's
    /// leaves the record unwhole.
    #[test]
    fn a_preflight_is_covered_by_the_request_it_was_sent_for() {
        let line = |v: serde_json::Value| v.to_string();
        let marker = line(serde_json::json!({ "type": "addresses", "recorded": true, "t": 0.0 }));
        let doc = line(serde_json::json!({ "type": "request", "t": 1.0, "requestId": "1.1", "resourceType": "Document", "frameId": "F1" }));
        let nav = line(serde_json::json!({ "type": "address", "t": 2.0, "url": "https://shop.example.com/search", "session": null, "frame": "F1" }));
        let call = line(serde_json::json!({ "type": "request", "t": 3.0, "requestId": "1.2", "resourceType": "Fetch", "frameId": "F1" }));
        let preflight = |id: &str, of: &str| line(serde_json::json!({ "type": "request", "t": 3.0, "requestId": id, "resourceType": "Other", "frameId": null, "initiator": { "type": "preflight", "url": "https://api.example.net/x", "requestId": of } }));
        let closing = |n: u64| line(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": n, "failed": false, "missed": 0, "cut_off": false }));
        let walk = |l: &[&str]| super::addresses_in(&l.join("\n"));
        assert!(walk(&[&marker, &doc, &nav, &preflight("AB12", "1.2"), &call, &closing(1)]).is_some(), "sent for a covered request");
        let early = line(serde_json::json!({ "type": "request", "t": 1.5, "requestId": "1.3", "resourceType": "Fetch", "frameId": "F1" }));
        assert_eq!(walk(&[&marker, &doc, &early, &nav, &preflight("AB13", "1.3"), &closing(1)]), None, "sent for a request the record doesn't cover");
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &preflight("AB14", "9.9"), &closing(1)]), None, "sent for no request the record holds");
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &preflight("AB15", "AB16"), &preflight("AB16", "1.2"), &closing(1)]), None, "sent for another preflight");
        let target = line(serde_json::json!({ "type": "target", "t": 2.5, "session": "S2", "kind": "iframe", "url": "https://pay.example.org/frame" }));
        let child_call = line(serde_json::json!({ "type": "request", "t": 4.0, "requestId": "S2:7.1", "resourceType": "Fetch", "frameId": "F9" }));
        assert!(walk(&[&marker, &doc, &nav, &target, &child_call, &preflight("S2:CD01", "7.1"), &closing(2)]).is_some(), "on a target's session, for that target's request");
        assert_eq!(walk(&[&marker, &doc, &nav, &call, &target, &child_call, &preflight("CD02", "7.1"), &closing(2)]), None, "a request of another session");
    }

    /// A fragment an answer handed the page before the walk reached it (an anchor the page's own code names) is the
    /// site's, and the share guard reads that address without it; one no answer gave first (a token a sign-in handed
    /// back, a word typed in), or gave only afterwards, stays the owner's. A fragment of no letter or digit carries
    /// nothing. The record itself is untouched.
    #[test]
    fn a_fragment_the_site_handed_over_first_is_not_the_owners() {
        let line = |v: serde_json::Value| v.to_string();
        let walk = |anchor_at: f64, served: &str, served_at: f64| {
            [
                line(serde_json::json!({ "type": "addresses", "recorded": true, "t": 0.0 })),
                line(serde_json::json!({ "type": "request", "t": 1.0, "requestId": "1.1", "resourceType": "Document", "frameId": "F1" })),
                line(serde_json::json!({ "type": "address", "t": 2.0, "url": "https://shop.example.com/", "session": null, "frame": "F1" })),
                line(serde_json::json!({ "type": "response", "t": served_at, "requestId": "1.2", "url": "https://cdn.example.net/app.js", "status": 200, "body": served })),
                line(serde_json::json!({ "type": "address", "t": anchor_at, "url": "https://shop.example.com/#hp-just-for-you", "session": null, "frame": "F1" })),
                line(serde_json::json!({ "type": "address", "t": anchor_at + 0.1, "url": "https://shop.example.com/#?", "session": null, "frame": "F1" })),
                line(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": 3, "failed": false, "missed": 0, "cut_off": false })),
            ]
            .join("\n")
        };
        let anchor = r#"el.id="hp-just-for-you";location.hash="hp-just-for-you""#;
        let read = |text: &str| super::owners_addresses_in(text).expect("a whole record");
        assert_eq!(read(&walk(5.0, anchor, 3.0)), ["https://shop.example.com/", "https://shop.example.com/", "https://shop.example.com/"], "handed over first");
        assert!(read(&walk(5.0, anchor, 6.0)).iter().any(|u| u.ends_with("#hp-just-for-you")), "handed over only afterwards: the owner's");
        assert!(read(&walk(5.0, "just-for-you-hp-just-for-youx", 3.0)).iter().any(|u| u.ends_with("#hp-just-for-you")), "never handed over whole");
        assert!(super::addresses_in(&walk(5.0, anchor, 3.0)).unwrap().iter().any(|u| u.contains('#')), "the record keeps every address as it was");
    }

    /// A frame in a process of its own reports where it navigates on its own target's session, while the page reports
    /// the request for its document with the frame's id: that address covers the frame's requests as the page's own
    /// would. A frame no session reported an address for covers nothing.
    #[test]
    fn a_frames_address_counts_whichever_session_reported_it() {
        let line = |v: serde_json::Value| v.to_string();
        let marker = line(serde_json::json!({ "type": "addresses", "recorded": true, "t": 0.0 }));
        let doc = line(serde_json::json!({ "type": "request", "t": 1.0, "requestId": "1.1", "resourceType": "Document", "frameId": "F1" }));
        let nav = line(serde_json::json!({ "type": "address", "t": 2.0, "url": "https://shop.example.com/search", "session": null, "frame": "F1" }));
        let target = line(serde_json::json!({ "type": "target", "t": 2.5, "session": "S2", "kind": "iframe", "url": "" }));
        let framed_doc = line(serde_json::json!({ "type": "request", "t": 3.0, "requestId": "F5", "resourceType": "Document", "frameId": "F5" }));
        let framed_nav = line(serde_json::json!({ "type": "address", "t": 3.2, "url": "https://check.example.net/anchor", "session": "S2", "frame": "F5" }));
        let framed_script = line(serde_json::json!({ "type": "request", "t": 3.5, "requestId": "F5.2", "resourceType": "Script", "frameId": "F5" }));
        let closing = |n: u64| line(serde_json::json!({ "type": "addresses_end", "t": 9.0, "written": n, "failed": false, "missed": 0, "cut_off": false }));
        let walk = |l: &[&str]| super::addresses_in(&l.join("\n"));
        assert_eq!(walk(&[&marker, &doc, &nav, &target, &framed_doc, &framed_nav, &framed_script, &closing(3)]).map(|a| a.len()), Some(3), "covered by its own session's address");
        assert_eq!(walk(&[&marker, &doc, &nav, &target, &framed_doc, &framed_script, &closing(2)]), None, "a frame no session gave an address for");
        let script_first = line(serde_json::json!({ "type": "request", "t": 3.1, "requestId": "F5.1", "resourceType": "Script", "frameId": "F5" }));
        assert_eq!(walk(&[&marker, &doc, &nav, &target, &framed_doc, &script_first, &framed_nav, &closing(3)]), None, "a frame's script before its address");
    }
}

/// What the browser saw the page's own code do, call by call. Two kinds of sighting, both read from the walk's log:
/// what the page built when it signed (`UNBROWSE_SIGN_PROBE=1`: each header the probe saw, its value, the call, and
/// the string the page's code hashed just before), and the stack that sent each of the page's own calls, which the
/// browser reports with the request (`sentBy`). A walk that probed nothing and predates stacks has none.
pub fn probes_from_walk(capture_dir: &Path, session: &str) -> Vec<crate::trace::Probe> {
    let Ok(text) = std::fs::read_to_string(capture_dir.join(format!("{session}.jsonl"))) else { return Vec::new() };
    probes_in(&text)
}

fn probes_in(log: &str) -> Vec<crate::trace::Probe> {
    let mut out = Vec::new();
    for line in log.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("sign_probe") => {
                for p in v.get("probes").and_then(|p| p.as_array()).into_iter().flatten() {
                    let Some(a) = p.as_array() else { continue };
                    let at = |n: usize| a.get(n).and_then(|x| x.as_str()).unwrap_or_default().to_string();
                    let probe = crate::trace::Probe { header: at(0), value: at(1), url: at(2), input: at(3), pre: at(4), stack: Vec::new() };
                    if !probe.value.is_empty() && !probe.input.is_empty() && !probe.header.is_empty() {
                        out.push(probe);
                    }
                }
            }
            // A call the page's code made, with where it made it. An image or a stylesheet a script asks for has a
            // stack too and carries no value a route sends: only the page's calls are kept.
            Some("request") if matches!(v.get("resourceType").and_then(|t| t.as_str()), Some("XHR" | "Fetch")) => {
                let said = |f: &serde_json::Value, key: &str| f.get(key).and_then(|x| x.as_u64()).unwrap_or_default() as u32;
                let stack: Vec<crate::trace::Frame> = v
                    .get("sentBy")
                    .and_then(|s| s.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|f| {
                        let script = f.get("url").and_then(|u| u.as_str()).filter(|u| !u.is_empty())?.to_string();
                        Some(crate::trace::Frame { script, line: said(f, "line"), column: said(f, "column"), function: f.get("function").and_then(|n| n.as_str()).unwrap_or_default().to_string() })
                    })
                    .collect();
                let url = v.get("url").and_then(|u| u.as_str()).unwrap_or_default();
                if !stack.is_empty() && !url.is_empty() {
                    out.push(crate::trace::Probe { url: url.to_string(), stack, ..Default::default() });
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The stack that sent a call is read from the walk's log beside what the page signed: one sighting a call the
    /// page's code made, with its frames in the browser's order. An image a script asked for is no call, and a call
    /// the log has no stack for says nothing.
    #[test]
    fn the_stack_that_sent_a_call_is_read_from_the_walk() {
        let log = [
            r#"{"type":"request","requestId":"1","method":"POST","url":"https://shop.example/api/search","resourceType":"Fetch","sentBy":[{"url":"https://cdn.example/http.js","line":0,"column":4812,"function":"send"},{"url":"https://cdn.example/app.js","line":12,"column":40,"function":"search"}]}"#,
            r#"{"type":"request","requestId":"2","method":"GET","url":"https://cdn.example/logo.png","resourceType":"Image","sentBy":[{"url":"https://cdn.example/app.js","line":1,"column":1,"function":"draw"}]}"#,
            r#"{"type":"request","requestId":"3","method":"GET","url":"https://shop.example/api/cart","resourceType":"XHR","sentBy":[]}"#,
            r#"{"type":"sign_probe","probes":[["x-sig","abc","/api/search","q=lamps",""]]}"#,
        ]
        .join("\n");
        let probes = probes_in(&log);
        assert_eq!(probes.len(), 2, "{probes:?}");
        let sent = probes.iter().find(|p| !p.stack.is_empty()).expect("the call's stack");
        assert_eq!((sent.url.as_str(), sent.header.as_str()), ("https://shop.example/api/search", ""));
        assert_eq!(sent.stack.iter().map(|f| (f.function.as_str(), f.line, f.column)).collect::<Vec<_>>(), vec![("send", 0, 4812), ("search", 12, 40)]);
        assert!(probes.iter().any(|p| p.header == "x-sig" && p.stack.is_empty()), "what the page signed is read as before");
    }
    use crate::trace::Exchange;

    fn ex(url: &str, kind: &str, status: u16, main_frame: Option<bool>) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status,
            response_headers: Vec::new(),
            response_body: None,
            response_mime: String::new(),
            resource_type: Some(kind.into()),
            main_frame,
        }
    }

    /// A challenge: the page is refused, the door's scripts and frame run, and the page is let through. The door
    /// is read from that order and those statuses; no host is named.
    #[test]
    fn the_door_is_read_from_the_walk() {
        let trace = Trace {
            exchanges: vec![
                ex("https://shop.example/", "Document", 403, Some(true)),
                ex("https://shop.example/door/probe", "XHR", 200, Some(true)),
                ex("https://widget.vendor.test/frame", "Document", 200, Some(false)),
                ex("https://widget.vendor.test/answer", "XHR", 200, Some(false)),
                ex("https://shop.example/", "Document", 200, Some(true)),
                ex("https://api.shop.example/items", "Fetch", 200, Some(true)),
            ],
            inputs: Vec::new(),
        };
        assert_eq!(trace.door("shop.example"), vec![0, 1, 2, 3]);
        assert_eq!(trace.gates("shop.example"), vec!["shop.example", "widget.vendor.test"]);
        assert_eq!(trace.without_door("shop.example").exchanges.len(), 2);
        assert_eq!(landed_site(&trace).as_deref(), Some("shop.example"));
    }

    /// A waiting room is another site's page in the main frame; the walk is through once the site's own answers.
    #[test]
    fn a_waiting_room_is_a_door() {
        let trace = Trace {
            exchanges: vec![
                ex("https://wait.room.test/?c=shop", "Document", 200, Some(true)),
                ex("https://wait.room.test/status", "XHR", 200, Some(true)),
                ex("https://shop.example/", "Document", 200, Some(true)),
            ],
            inputs: Vec::new(),
        };
        assert_eq!(trace.door("shop.example"), vec![0, 1]);
        assert_eq!(landed_site(&trace).as_deref(), Some("shop.example"));
    }

    /// Without frames, the refused first page still names the site, and the widget's page after it does not; the
    /// door runs from the refusal to the site's own page.
    #[test]
    fn without_frames_the_first_page_names_the_site() {
        let trace = Trace {
            exchanges: vec![
                ex("https://shop.example/", "Document", 403, None),
                ex("https://widget.vendor.test/frame", "Document", 200, None),
                ex("https://shop.example/door/probe", "XHR", 200, None),
                ex("https://shop.example/", "Document", 200, None),
                ex("https://shop.example/api/items", "XHR", 200, None),
            ],
            inputs: Vec::new(),
        };
        assert_eq!(landed_site(&trace).as_deref(), Some("shop.example"));
        assert_eq!(trace.door("shop.example"), vec![0, 1, 2]);
    }

    /// Without frames, another site's document may be an ad's frame: it opens no door.
    #[test]
    fn without_frames_another_sites_document_is_no_door() {
        let trace = Trace {
            exchanges: vec![
                ex("https://shop.example/", "Document", 200, None),
                ex("https://ads.test/frame", "Document", 200, None),
                ex("https://shop.example/api/items", "XHR", 200, None),
            ],
            inputs: Vec::new(),
        };
        assert!(trace.door("shop.example").is_empty());
        assert_eq!(landed_site(&trace).as_deref(), Some("shop.example"));
    }

    #[test]
    fn landed_site_names_the_page_the_walk_was_let_through_to() {
        let trace = Trace {
            exchanges: vec![
                ex("https://www.shop.example/", "Document", 200, Some(true)),
                ex("https://api.shop.example/items", "XHR", 200, Some(true)),
            ],
            inputs: Vec::new(),
        };
        assert_eq!(landed_site(&trace).as_deref(), Some("shop.example"));
    }
}
