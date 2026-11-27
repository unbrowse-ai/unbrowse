//! Tests of `learn` (UNB-208 coverage climb).

use super::*;

/// A call of a walk, as the walk's browser saw it.
fn walked(method: &str, url: &str, body: &str, doc: bool) -> Exchange {
    Exchange {
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
    }
}

fn records(word: &str) -> String {
    format!(r#"{{"results":[{}]}}"#, (0..6).map(|n| format!(r#"{{"id":"p{n}","name":"{word} number {n}"}}"#)).collect::<Vec<_>>().join(","))
}

/// What a site that hears its caller lists for `word`: its own records, which are not the same ones for another word.
fn records_that_hear(word: &str) -> String {
    let kinds = ["brass", "walnut", "linen", "copper", "ceramic", "oak", "velvet", "cedar", "marble", "bamboo", "wicker", "pewter"];
    format!(r#"{{"results":[{}]}}"#, (0..8).map(|n| format!(r#"{{"id":"p{n}","name":"{word} {} number {n}"}}"#, kinds[(n + word.len()) % kinds.len()])).collect::<Vec<_>>().join(","))
}

/// A walk of a shop's search page for `word` on `base`: the page and the call that lists the records.
fn a_walk_of(base: &str, word: &str) -> (String, Trace) {
    let page = format!("{base}/search?q={word}");
    let trace = Trace {
        exchanges: vec![walked("GET", &page, "<html><body>a shop</body></html>", true), walked("GET", &format!("{base}/api/search?q={word}"), &records(word), false)],
        inputs: walk_inputs(&page, &[], &[]),
    };
    (page, trace)
}

fn a_walk_in_memory(url: &str, trace: Trace, age: u64) -> Walk {
    Walk { url: url.to_string(), trace: trace.into(), probes: Vec::new(), recording: None, at: std::time::Instant::now() + Duration::from_secs(age), addresses: None }
}

/// A site on this machine that answers every call by what `answer` says of its path and query (kind, body; the kind
/// "404" is a call it has no page for); it keeps the address of every call it is asked.
fn a_site_that_answers(answer: impl Fn(&str) -> (&'static str, String) + Send + 'static) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
    use std::io::{BufRead, Write};
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", site.local_addr().unwrap().port());
    let asked = std::sync::Arc::new(Mutex::new(Vec::new()));
    let kept = asked.clone();
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
            let target = first.split_whitespace().nth(1).unwrap_or("/").to_string();
            kept.locked().push(target.clone());
            let (kind, body) = answer(&target);
            let status = if kind == "404" { "404 Not Found" } else { "200 OK" };
            let kind = if kind == "404" { "text/plain" } else { kind };
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    (base, asked)
}

/// What a walk's capture log says of a response, as a window's eye hears it: (method, path, status, bytes, sort).
fn heard(events: &Mutex<Vec<Eye>>) -> Vec<(String, String, u16, usize, &'static str)> {
    events
        .locked()
        .iter()
        .filter_map(|e| match e {
            Eye::Seen { method, path, status, bytes, sort, .. } => Some((method.clone(), path.clone(), *status, *bytes, *sort)),
            _ => None,
        })
        .collect()
}

/// The window's stream reads a walk's capture log as it lands: each response is told by its kind (the door, noise,
/// data, a page, an asset), the method its request had, and the size of its body; a response off the site's own host
/// or one the door refused opens the door for what follows, a beacon that carries the page's address is noise, the
/// browser's own addresses are not the site, a refused walk tried again starts the door afresh, and a half-written
/// line waits for its end.
#[test]
fn the_stream_tells_each_response_of_the_walks_log_by_its_kind() {
    let _home = store::scratch_home("walk-follow");
    let log = store::home().join("learn_w.jsonl");
    let lines = [
        serde_json::json!({ "type": "request", "requestId": "r1", "method": "GET", "url": "https://shop.example/search?q=a", "resourceType": "Document", "frameId": "f1" }),
        serde_json::json!({ "type": "response", "requestId": "r1", "url": "https://shop.example/search?q=a", "status": 200, "mimeType": "text/html", "body": "<html>" }),
        serde_json::json!({ "type": "request", "requestId": "r2", "method": "POST", "url": "https://shop.example/api/items", "resourceType": "XHR", "frameId": "f1" }),
        serde_json::json!({ "type": "response", "requestId": "r2", "url": "https://shop.example/api/items", "status": 200, "mimeType": "application/json", "body": "{\"a\":1}" }),
        serde_json::json!({ "type": "request", "requestId": "r3", "method": "POST", "url": "https://stats.example/hit", "resourceType": "XHR", "postData": "page=shop.example/search" }),
        serde_json::json!({ "type": "response", "requestId": "r3", "url": "https://stats.example/hit", "status": 200, "mimeType": "application/json", "body": "{}" }),
        serde_json::json!({ "type": "response", "requestId": "r4", "url": "https://shop.example/logo.png", "status": 200, "mimeType": "image/png" }),
        serde_json::json!({ "type": "response", "requestId": "r5", "url": "https://shop.example/api/empty", "status": 204, "mimeType": "application/json" }),
        serde_json::json!({ "type": "response", "requestId": "r6", "url": "chrome://newtab/", "status": 200, "mimeType": "text/html" }),
        serde_json::json!({ "type": "response", "requestId": "r7", "url": "https://shop.example/data.bin", "status": 200, "mimeType": "application/octet-stream" }),
        serde_json::json!({ "type": "console", "text": "ignored" }),
        // The door: the main frame's next page is off the site, then refused.
        serde_json::json!({ "type": "request", "requestId": "r8", "method": "GET", "url": "https://check.example/wait", "resourceType": "Document", "frameId": "f1" }),
        serde_json::json!({ "type": "response", "requestId": "r8", "url": "https://check.example/wait", "status": 200, "mimeType": "text/html", "body": "wait" }),
        serde_json::json!({ "type": "response", "requestId": "r9", "url": "https://shop.example/api/after", "status": 200, "mimeType": "application/json", "body": "{}" }),
        serde_json::json!({ "type": "request", "requestId": "r10", "method": "GET", "url": "https://shop.example/search?q=a", "resourceType": "Document", "frameId": "f1" }),
        serde_json::json!({ "type": "response", "requestId": "r10", "url": "https://shop.example/search?q=a", "status": 403, "mimeType": "text/html", "body": "no" }),
        serde_json::json!({ "type": "response", "requestId": "r11", "url": "https://shop.example/api/after2", "status": 200, "mimeType": "application/json" }),
        // A walk tried again in another browser starts its main frame over: its first page is a main frame too.
        serde_json::json!({ "type": "mint" }),
        serde_json::json!({ "type": "request", "requestId": "r12", "method": "GET", "url": "https://shop.example/search?q=a", "resourceType": "Document", "frameId": "f2" }),
        serde_json::json!({ "type": "response", "requestId": "r12", "url": "https://shop.example/search?q=a", "status": 200, "mimeType": "text/html", "body": "ok" }),
        serde_json::json!({ "type": "response", "requestId": "r13", "url": "https://shop.example/api/last", "status": 200, "mimeType": "application/json", "body": "[]" }),
    ];
    let mut text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    text.push_str("{\"type\":\"response\",\"requestId\":\"r14\",\"url\":\"https://shop.example/api/half\"");
    std::fs::write(&log, text).unwrap();
    let events = Mutex::new(Vec::new());
    let done = AtomicBool::new(true);
    follow(&log, "w", "shop.example", Some("shop.example/search"), &done, &|e| events.locked().push(e));
    let got = heard(&events);
    let kinds: Vec<(&str, &str, &'static str)> = got.iter().map(|(m, p, _, _, s)| (m.as_str(), p.as_str(), *s)).collect();
    assert_eq!(
        kinds,
        [
            ("GET", "/search", "page"),
            ("POST", "/api/items", "data"),
            ("POST", "/hit", "noise"),
            ("GET", "/logo.png", "asset"),
            ("GET", "/api/empty", "noise"),
            ("GET", "/data.bin", "asset"),
            ("GET", "/wait", "gate"),
            ("GET", "/api/after", "gate"),
            ("GET", "/search", "gate"),
            ("GET", "/api/after2", "gate"),
            ("GET", "/search", "page"),
            ("GET", "/api/last", "data"),
        ],
        "{got:?}"
    );
    assert_eq!((got[0].2, got[0].3), (200, 6), "the status and the size of the body ride along");
    assert_eq!(got[8].2, 403);
    let numbered: Vec<usize> = events.locked().iter().filter_map(|e| if let Eye::Seen { n, .. } = e { Some(*n) } else { None }).collect();
    assert_eq!(numbered, (1..=12).collect::<Vec<_>>(), "each response is numbered in the order it landed");
}

/// What kind of thing a response is, by where it came in the walk, its type and what it did.
#[test]
fn a_response_is_sorted_by_the_door_then_what_it_reported_then_its_type() {
    assert_eq!(sort_of(true, "application/json", 200, true), "gate", "the door outranks all");
    assert_eq!(sort_of(false, "application/json", 200, true), "noise", "a call that reported the page");
    assert_eq!(sort_of(false, "application/json", 204, false), "noise", "an answer of nothing");
    assert_eq!(sort_of(false, "application/vnd.api+json", 200, false), "data");
    assert_eq!(sort_of(false, "text/html; charset=utf-8", 200, false), "page");
    assert_eq!(sort_of(false, "font/woff2", 200, false), "asset");
}

/// A page's walk key is the page's own: the same address names the same walk whoever asks and however it is padded,
/// another address another walk, and each walk of one page has an id of its own.
#[test]
fn a_page_has_one_walk_key_and_each_walk_of_it_an_id_of_its_own() {
    let key = walk_key("https://shop.example/search?q=lamp");
    assert!(key.starts_with("walk_") && key.len() == "walk_".len() + 12, "{key}");
    assert_eq!(walk_key("  https://shop.example/search?q=lamp \n"), key);
    assert_ne!(walk_key("https://shop.example/search?q=sofa"), key);
    let _home = store::scratch_home("walk-id");
    let (a, b) = (walk_id("https://shop.example/"), walk_id("https://shop.example/other"));
    assert!(a.len() == 12 && a != b, "{a} {b}");
}

/// What a walk showed is listed again without walking: its candidates, on the site the page's host belongs to, with
/// no cookies counted; a walk nobody holds shows nothing.
#[test]
fn a_walk_held_is_viewed_again_as_the_owner_saw_it() {
    let walks = Walks::default();
    let (page, trace) = a_walk_of("https://shop.example", "lamp");
    keep_walk(&mut walks.0.locked(), "w1".into(), a_walk_in_memory(&page, trace, 0));
    let view = view(&walks, "w1").expect("the walk is held");
    assert_eq!((view.walk.as_str(), view.url.as_str(), view.site.as_str(), view.exchanges, view.cookies), ("w1", page.as_str(), "shop.example", 2, 0));
    assert!(view.candidates.iter().any(|c| c.path.starts_with("/api/search") && c.method == "GET"), "the call is a candidate");
    assert!(super::view(&walks, "w2").is_none(), "an expired walk shows nothing");
    let mut bad = a_walk_in_memory("not a url", Trace { exchanges: Vec::new(), inputs: Vec::new() }, 0);
    bad.url = "not a url".into();
    walks.0.locked().insert("w3".into(), bad);
    assert!(super::view(&walks, "w3").is_none(), "a walk of no address shows nothing");
}

/// The walk's own refusals come before any browser: a page that is not one the node walks, and a site whose door
/// refused this node a moment ago and is rested, with how long is left and the door's name.
#[test]
fn a_walk_that_cannot_start_says_why_before_any_browser() {
    let _home = store::scratch_home("walk-refusals");
    let walks = Walks::default();
    for (url, said) in [("ftp://files.example/a", "only http and https"), ("not a url", "not a URL"), ("mailto:someone@example.com", "only http and https")] {
        let why = walk_as(&walks, url, "w", "agent", &no_eye).err().expect("refused");
        assert!(why.contains(said), "{url}: {why}");
    }
    REFUSED.locked().insert("rested-walk.example".to_string(), std::time::Instant::now());
    let why = walk_as(&walks, "https://www.rested-walk.example/search?q=a", "w", "agent", &no_eye).err().expect("refused");
    assert!(why.contains("refused this node's browser a moment ago") && why.contains("it is rested for another"), "{why}");
    // The door met ends the rest of the site, whichever of its hosts names it.
    the_door_was_met("shop.rested-walk.example");
    assert!(!REFUSED.locked().contains_key("rested-walk.example"));
}

/// A cookie a later call of the walk sent that an earlier step set is the session's: the jar keeps its value beside
/// the ones it held and the step names it as minted. A route with none leaves the jar alone.
#[test]
fn a_cookie_the_walks_later_call_sent_is_put_in_the_jar_and_named() {
    let _home = store::scratch_home("walk-cookies");
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
        "provisional": false,
        "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": "https://cookies.example/api/boot", "needs_browser": false, "fields": [] },
            { "exchange": 1, "method": "GET", "status": 200, "url": "https://cookies.example/api/items", "needs_browser": false,
              "fields": [{ "loc": { "in": "cookie", "key": "sid" }, "class": "derived", "origin": { "exchange": 0, "url": "https://cookies.example/api/boot", "at": { "from": "json", "pointer": "/sid" } } }] }
        ]
    }))
    .unwrap();
    let mut route = Route::from_graph("r".into(), "list items".into(), "https://cookies.example/items".into(), graph).unwrap();
    let mut call = walked("GET", "https://cookies.example/api/items", "{}", false);
    call.request_headers.push(("Cookie".into(), "theme=dark; sid=s-123".into()));
    let trace = Trace { exchanges: vec![walked("GET", "https://cookies.example/api/boot", "{}", false), call], inputs: Vec::new() };
    store::write_json(&store::jar_path("cookies.example"), &unbrowse_files::JAR, &std::collections::BTreeMap::from([("held".to_string(), "h1".to_string())])).unwrap();
    mint_walked_cookies(&mut route, &trace);
    let jar: std::collections::BTreeMap<String, String> = store::read_json(&store::jar_path("cookies.example"), &unbrowse_files::JAR);
    assert_eq!(jar, std::collections::BTreeMap::from([("held".to_string(), "h1".to_string()), ("sid".to_string(), "s-123".to_string())]));
    assert!(matches!(&route.graph.steps[1].fields[0].class, unbrowse_learn::graph::Class::Minted { name } if name == "sid"));
    // Nothing the walk sent: the jar of another site is never made.
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
        "provisional": false,
        "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": "https://other.example/api/boot", "needs_browser": false, "fields": [] },
            { "exchange": 1, "method": "GET", "status": 200, "url": "https://other.example/api/items", "needs_browser": false,
              "fields": [{ "loc": { "in": "cookie", "key": "sid" }, "class": "derived", "origin": { "exchange": 0, "url": "https://other.example/api/boot", "at": { "from": "json", "pointer": "/sid" } } }] }
        ]
    }))
    .unwrap();
    let mut other = Route::from_graph("r2".into(), "list items".into(), "https://other.example/items".into(), graph).unwrap();
    mint_walked_cookies(&mut other, &Trace { exchanges: vec![walked("GET", "https://other.example/api/items", "{}", false)], inputs: Vec::new() });
    assert!(!store::jar_path("other.example").exists());
}

/// The other walks of the page held in memory are its extra sightings: the page's own other walks, or ones for the same
/// shape of path on the site, the newest three, and never the walk itself or another site's.
#[test]
fn a_walk_is_given_the_pages_other_walks_as_sightings_newest_first() {
    let walk_of = |url: &str, age: u64| {
        let trace = Trace { exchanges: vec![walked("GET", url, "<html></html>", true)], inputs: Vec::new() };
        a_walk_in_memory(url, trace, age)
    };
    let mut walks: HashMap<String, Walk> = HashMap::new();
    walks.insert("me".into(), walk_of("https://shop.example/c/lamps/p", 0));
    walks.insert("same".into(), walk_of("https://shop.example/c/lamps/p", 1));
    walks.insert("other-word".into(), walk_of("https://shop.example/c/sofas/p", 5));
    walks.insert("other-shape".into(), walk_of("https://shop.example/x/y/z/w", 6));
    walks.insert("other-site".into(), walk_of("https://elsewhere.example/c/lamps/p", 7));
    walks.insert("bad".into(), walk_of("https://shop.example/c/lamps/p", 8));
    walks.get_mut("bad").unwrap().url = "nonsense".into();
    walks.insert("newest".into(), walk_of("https://www.shop.example/c/chairs/p", 9));
    walks.insert("oldest".into(), walk_of("https://shop.example/c/lamps/p", 2));
    let found = history_of(&walks, "me", "https://shop.example/c/lamps/p");
    let seen: Vec<&str> = found.iter().map(|(t, _)| t.exchanges[0].url.as_str()).collect();
    assert_eq!(seen, ["https://www.shop.example/c/chairs/p", "https://shop.example/c/sofas/p", "https://shop.example/c/lamps/p"], "{seen:?}");
    assert!(history_of(&walks, "me", "nonsense").is_empty());
    assert!(history_of(&walks, "me", "file:///tmp/a").is_empty(), "an address of no host has no site");
}

/// What the build reads of the walk it is for is set around it and put back after, whatever was there before: the
/// recording of the walk, and what each other walk of the page kept in its storage.
#[test]
fn the_walks_recording_and_storage_are_set_for_one_build_and_put_back() {
    let rec = |at: &str| {
        let mut r = unbrowse_learn::recording::Recording::from_log("").unwrap();
        r.storage.push(unbrowse_learn::recording::StorageSnapshot { at: at.into(), origin: "https://shop.example".into(), local: [("k".to_string(), "v".to_string())].into(), session: Default::default() });
        r
    };
    assert!(THE_RECORDING.with(|r| r.borrow().is_none()));
    let inside = with_the_recording(Some(rec("end")), || THE_RECORDING.with(|r| r.borrow().as_ref().map(|r| r.storage.len())));
    assert_eq!(inside, Some(1));
    assert!(THE_RECORDING.with(|r| r.borrow().is_none()), "put back");
    let nested = with_the_recording(Some(rec("end")), || with_the_recording(None, || THE_RECORDING.with(|r| r.borrow().is_none())));
    assert!(nested);

    let stored = vec![("page#1".to_string(), unbrowse_learn::sandbox::Storage::default())];
    let inside = with_the_others_stored(stored, || THE_OTHERS_STORED.with(|r| r.borrow().len()));
    assert_eq!(inside, 1);
    assert!(THE_OTHERS_STORED.with(|r| r.borrow().is_empty()), "put back");

    // The other walks' storage, by the walk each is: the recorded ones only, never the walk itself.
    let mut walks: HashMap<String, Walk> = HashMap::new();
    let url = "https://shop.example/search?q=a";
    let trace = || Trace { exchanges: vec![walked("GET", url, "<html></html>", true)], inputs: Vec::new() };
    let mut mine = a_walk_in_memory(url, trace(), 0);
    mine.recording = Some(rec("end"));
    let mut theirs = a_walk_in_memory(url, trace(), 1);
    theirs.recording = Some(rec("settle"));
    walks.insert("me".into(), mine);
    walks.insert("them".into(), theirs);
    walks.insert("unrecorded".into(), a_walk_in_memory(url, trace(), 2));
    let others = stored_of_others(&walks, "me", url);
    assert_eq!(others.len(), 1);
    assert_eq!(others[0].0, walked_as(&trace()));
    assert_eq!(others[0].0, format!("{url}#1"));
    assert_eq!(others[0].1.local.get("k").map(String::as_str), Some("v"));
}

/// A route of two calls: an earlier one that hands out an installation id, and the search that sends it as a header.
fn a_search_after_an_installation(base: &str) -> (Route, Trace) {
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
        "provisional": false,
        "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": format!("{base}/api/experiments"), "needs_browser": false, "fields": [] },
            { "exchange": 1, "method": "GET", "status": 200, "url": format!("{base}/api/search?q={{q}}"), "needs_browser": false,
              "fields": [
                { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp" },
                { "loc": { "in": "header", "key": "x-installation-id" }, "class": "derived", "origin": { "exchange": 0, "url": format!("{base}/api/experiments"), "at": { "from": "json", "pointer": "/installation" } } }
              ] }
        ]
    }))
    .unwrap();
    let route = Route::from_graph("r".into(), "search the shop".into(), format!("{base}/search?q=lamp"), graph).unwrap();
    let mut search = walked("GET", &format!("{base}/api/search?q=lamp"), &records("lamp"), false);
    search.request_headers.push(("x-installation-id".into(), "i-1".into()));
    let trace = Trace { exchanges: vec![walked("GET", &format!("{base}/api/experiments"), r#"{"installation":"i-1"}"#, false), search], inputs: Vec::new() };
    (route, trace)
}

/// A chain that fails to answer as built is asked as its call alone, and the call is kept alone only if, asked what the
/// walk asked, it answers as fully as the walk's call did: a site that answers a call it distrusts with the frame
/// and none of the records (a word the walk found things for, found nothing for now) has not answered it.
#[test]
fn a_call_alone_is_kept_only_where_it_answers_as_fully_as_the_walk_did() {
    let _home = store::scratch_home("walk-mint-alone");
    let _old = crate::learn::own_asks::as_the_old_node();
    // The site hands out nothing at the earlier call, and answers the search itself for every word.
    let (base, asked) = a_site_that_answers(|target| match target.split('?').next().unwrap_or_default() {
        "/api/search" => ("application/json", records("lamp")),
        _ => ("text/html", "not here".into()),
    });
    let (route, trace) = a_search_after_an_installation(&base);
    let out = mint_if_the_site_answers(route, &trace);
    assert_eq!((out.graph.steps.len(), out.steps, out.plain_trial), (1, 1, Some(true)), "the call answers alone and is kept alone");
    assert!(out.graph.steps[0].fields.iter().all(|f| f.loc != unbrowse_learn::Loc::Header("x-installation-id".into())));
    assert!(asked.locked().iter().any(|t| t.starts_with("/api/search?q=lamp")), "it was asked what the walk asked: {:?}", asked.locked());

    // The same site, but asked the walked word it answers with its lists emptied: the walk's answer was not given.
    let (base, _) = a_site_that_answers(|target| match target.split('?').next().unwrap_or_default() {
        "/api/search" if target.contains("q=lamp") => ("application/json", r#"{"results":[]}"#.into()),
        "/api/search" => ("application/json", records("other")),
        _ => ("text/html", "not here".into()),
    });
    let (route, trace) = a_search_after_an_installation(&base);
    let out = mint_if_the_site_answers(route, &trace);
    assert_eq!(out.graph.steps.len(), 2, "the chain stays as built when the call alone was handed nothing");
    assert_ne!(out.plain_trial, Some(true));
}

/// A route kept from a walk a person chose is learned, tried against the site, saved and told in the activity; a site the
/// owner excluded in Settings keeps nothing, and a walk that has gone says it has expired.
#[test]
fn a_call_chosen_from_a_walk_is_kept_as_a_route_and_told() {
    let _home = store::scratch_home("walk-keep");
    let _old = crate::learn::own_asks::as_the_old_node();
    let (base, asked) = a_site_that_answers(|target| {
        let word = target.split("q=").nth(1).unwrap_or_default().split('&').next().unwrap_or_default().to_string();
        if target.starts_with("/api/search") { ("application/json", records(&word)) } else { ("text/html", "<html><body>a shop</body></html>".into()) }
    });
    let walks = Walks::default();
    for (id, word, age) in [("w1", "lamp", 0), ("w2", "sofa", 1)] {
        let (page, trace) = a_walk_of(&base, word);
        keep_walk(&mut walks.0.locked(), id.into(), a_walk_in_memory(&page, trace, age));
    }
    let route = keep_candidate(&walks, "w1", 1, "search the shop", "an agent").expect("kept");
    assert_eq!((route.method.as_str(), route.what.as_str()), ("GET", "search the shop"));
    assert!(route.inputs.iter().any(|i| i.name == "q" && i.default.as_deref() == Some("lamp")), "{:?}", route.inputs);
    assert!(route.given.is_empty());
    assert_eq!(store::load_route(&route.id).map(|r| r.what), Some("search the shop".to_string()), "it is saved");
    let told = store::read_activity(10);
    assert!(told.iter().any(|a| a.who == "an agent" && a.what == "Learned search the shop" && a.result == "done" && a.kind == "learn"), "{told:?}");
    assert!(asked.locked().is_empty() || asked.locked().iter().all(|t| t.starts_with("/api/")), "only the call was asked: {:?}", asked.locked());

    let gone = keep_candidate(&walks, "w9", 1, "search the shop", "an agent").expect_err("expired");
    assert!(gone.contains("expired"), "{gone}");
    let mut settings = store::load_settings();
    settings.excluded = vec!["127.0.0.1".into()];
    store::save_settings(&settings).unwrap();
    let shut = keep_candidate(&walks, "w1", 1, "search the shop", "an agent").expect_err("excluded");
    assert!(shut.contains("127.0.0.1 is excluded from mapping in Settings"), "{shut}");
}

/// A hotel-style route whose search call needs the page's own code (`needs_browser`) and reads an app's version off the
/// page; `between` is the step the target takes its second value from, when it has one.
fn a_walled_search(base: &str, between: &str) -> (Route, Trace) {
    let page = format!("{base}/en/search/?query=paris");
    let app = serde_json::json!({ "loc": { "in": "query", "key": "app" }, "class": "derived", "origin": { "exchange": 0, "url": format!("{base}/en/search/"), "at": { "from": "text", "before": "v=", "after": "\"", "nth": 0 } } });
    let q = serde_json::json!({ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "paris" });
    let mut steps = vec![serde_json::json!({ "exchange": 0, "method": "GET", "status": 200, "url": format!("{base}/en/search/?query={{q}}"), "needs_browser": false, "reads_page": true, "fields": [q.clone()] })];
    let (second, target_url, sent) = if between == "config" {
        steps.push(serde_json::json!({ "exchange": 1, "method": "GET", "status": 200, "url": format!("{base}/api/config"), "needs_browser": false, "fields": [] }));
        let id = serde_json::json!({ "loc": { "in": "query", "key": "id" }, "class": "derived", "origin": { "exchange": 1, "url": format!("{base}/api/config"), "at": { "from": "json", "pointer": "/id" } } });
        (vec![app, id, q], format!("{base}/graphql?app={{app}}&id={{id}}&q={{q}}"), format!("{base}/graphql?app=v9&id=c7&q=paris"))
    } else {
        steps.push(serde_json::json!({ "exchange": 1, "method": "POST", "status": 200, "url": format!("{base}/sensor"), "needs_browser": false, "fields": [] }));
        let token = serde_json::json!({ "loc": { "in": "header", "key": "x-sensor" }, "class": "derived", "origin": { "exchange": 1, "url": format!("{base}/sensor"), "at": { "from": "json", "pointer": "/token" } } });
        (vec![app, token, q], format!("{base}/graphql?app={{app}}&q={{q}}"), format!("{base}/graphql?app=v9&q=paris"))
    };
    steps.push(serde_json::json!({ "exchange": 2, "method": "GET", "status": 200, "url": target_url, "needs_browser": true, "fields": second }));
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "page": page, "steps": steps })).unwrap();
    let mut route = Route::from_graph("r".into(), "search hotels".into(), page.clone(), graph).unwrap();
    route.browser_assisted = true;
    let mut call = walked("GET", &sent, r#"{"data":{"hotels":[{"name":"a"},{"name":"b"}]}}"#, false);
    call.request_headers.push(("x-sensor".into(), "s-1".into()));
    let middle = if between == "config" { walked("GET", &format!("{base}/api/config"), r#"{"id":"c7"}"#, false) } else { walked("POST", &format!("{base}/sensor"), r#"{"token":"s-1"}"#, false) };
    let trace = Trace { exchanges: vec![walked("GET", &page, r#"<html><script>x="app?v=v9"</script></html>"#, true), middle, call], inputs: Vec::new() };
    (route, trace)
}

/// A call a site walls the page of, and answers only with what its other calls handed over, is kept as the chain
/// without its page, what it read off the page sent as the walk sent it: the shorter chains (its call alone, its
/// least chain) are asked first, and are not the answer where the site wants the call the walk made beside it.
#[test]
fn a_chain_the_site_answers_only_without_its_page_is_kept_without_it() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let (route, trace) = a_walled_search("https://stay.example", "sensor");
    // The site walls the page, and wants the sensor's post beside the call.
    let mut answers = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| g.steps.iter().any(|s| s.url.ends_with("/sensor")) && !g.steps.iter().any(|s| s.reads_page);
    let out = mint_trial(route.clone(), &trace, &mut answers);
    assert_eq!((out.graph.steps.len(), out.steps, out.plain_trial, out.browser_assisted), (2, 2, Some(true), false), "the page is left out, the sensor stays");
    assert!(out.graph.provisional, "what it took from the page is the walk's, seen once");
    let target = out.graph.steps.last().unwrap();
    assert!(target.fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Query("app".into()) && matches!(&f.class, unbrowse_learn::graph::Class::Unconfirmed { value } if value == "v9")), "{:?}", target.fields);
    assert!(target.fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Header("x-sensor".into())), "the header the sensor filled is still the sensor's");
    // A site that answers none of the shorter chains keeps the route as it was.
    let mut never = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| false;
    let kept = mint_trial(route, &trace, &mut never);
    assert_eq!((kept.graph.steps.len(), kept.plain_trial), (3, None));
}

/// The widest of the shorter chains is the call by itself as the walk sent it: where the site answers only that, and
/// not the chain with the config call that filled one of its values, the call is kept alone with every value the
/// walk sent for it.
#[test]
fn a_call_the_site_answers_only_by_itself_is_kept_with_what_the_walk_sent() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let (route, trace) = a_walled_search("https://stay.example", "config");
    let mut site = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| g.steps.len() == 1;
    let out = mint_trial(route.clone(), &trace, &mut site);
    assert_eq!((out.graph.steps.len(), out.steps, out.plain_trial, out.browser_assisted), (1, 1, Some(true), false));
    assert!(out.graph.provisional);
    let sent: Vec<(unbrowse_learn::Loc, String)> = out.graph.steps[0].fields.iter().filter_map(|f| if let unbrowse_learn::graph::Class::Unconfirmed { value } = &f.class { Some((f.loc.clone(), value.clone())) } else { None }).collect();
    assert_eq!(sent, [(unbrowse_learn::Loc::Query("app".into()), "v9".to_string()), (unbrowse_learn::Loc::Query("id".into()), "c7".to_string())]);
    // Asked what the walk asked, the call alone must answer as fully as the walk's did (`as_walked`).
    let mut refused_as_walked = |_: &unbrowse_learn::Graph| false;
    let mut answers = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| g.steps.len() == 1;
    let kept = mint_trial_as_walked(route, &trace, &mut answers, &mut refused_as_walked);
    assert_eq!(kept.graph.steps.len(), 3, "a call that answers a moved word and not the walked one is not kept alone");
}

/// A value the page's code writes into a header, that the site answers when it is sent as the walk sent it on another
/// call, is the session's: the jar keeps it by name and the step only names it. Where no answer comes of it, the
/// route keeps the page's value, marked unproven when it rests on a value seen once; a value one call handed the page
/// during the visit is never kept either way.
#[test]
fn a_header_the_pages_code_writes_is_kept_in_the_jar_where_the_site_answers_with_it() {
    let _home = store::scratch_home("walk-header-jar");
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    let _old = crate::learn::own_asks::as_the_old_node();
    let signed = "sig-0123456789abcdef";
    let route = || {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://sig.example/api/search?q={q}&v=1", "needs_browser": false,
                "fields": [
                    { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "paris" },
                    { "loc": { "in": "query", "key": "v" }, "class": "unconfirmed", "value": "1" },
                    { "loc": { "in": "header", "key": "x-sig" }, "class": "computed" },
                    { "loc": { "in": "header", "key": "x-seen" }, "class": "computed" }
                ] }]
        }))
        .unwrap();
        Route::from_graph("r".into(), "search".into(), "https://sig.example/search?q=paris".into(), graph).unwrap()
    };
    let call = |seen_at: Option<&str>| {
        let mut e = walked("GET", "https://sig.example/api/search?q=paris&v=1", r#"{"results":[1,2,3]}"#, false);
        e.request_headers.push(("x-sig".into(), signed.into()));
        e.request_headers.push(("X-Seen".into(), "from-the-walk".into()));
        let mut exchanges = vec![e];
        if let Some(value) = seen_at {
            exchanges.insert(0, walked("GET", "https://sig.example/api/challenge", &format!(r#"{{"answer":"{value}"}}"#), false));
        }
        Trace { exchanges, inputs: Vec::new() }
    };
    // The site answers whenever the page's values ride as the walk sent them.
    let mut with_them = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
        let held = |name: &str| g.steps[0].fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Header(name.into()) && matches!(f.class, unbrowse_learn::graph::Class::Unconfirmed { .. }));
        held("x-sig") && held("x-seen")
    };
    let out = mint_trial(route(), &call(None), &mut with_them);
    assert_eq!(out.plain_trial, Some(false));
    let named = |name: &str| out.graph.steps[0].fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Header(name.into()) && matches!(&f.class, unbrowse_learn::graph::Class::Minted { name: n } if n == name));
    assert!(named("x-sig") && named("x-seen"), "{:?}", out.graph.steps[0].fields);
    let jar: std::collections::BTreeMap<String, String> = store::read_json(&store::jar_path("sig.example"), &unbrowse_files::JAR);
    assert_eq!(jar.get("x-sig").map(String::as_str), Some(signed));
    assert_eq!(jar.get("x-seen").map(String::as_str), Some("from-the-walk"));

    // A site that answers nothing the page did not write itself: the route keeps the values as the page's.
    let mut never = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| false;
    let kept = mint_trial(route(), &call(None), &mut never);
    assert_eq!(kept.plain_trial, Some(false));
    assert!(kept.graph.provisional, "it rests on a value seen once");
    // The one a call handed the page this very visit is left to the page, and does not unmark the route.
    let issued = mint_trial(route(), &call(Some(signed)), &mut never);
    assert_eq!(issued.plain_trial, Some(false));
    assert!(!issued.graph.provisional, "a value made for the visit is the page's, said so, and nothing is guessed of the rest");
}

/// A route whose last step is a call at `url` taking the caller's word `q` (default `lamp`) and a counting value, as the
/// walk of a shop's list made it.
fn a_list_route(query: &str) -> Route {
    let url = format!("https://list.walk-budget.example/api/list?q=lamp&{query}");
    let trace = Trace { exchanges: vec![walked("GET", &url, "{}", false)], inputs: vec![unbrowse_learn::Input::new("q", "lamp")] };
    route_of(&trace, 0, "search the shop", "https://list.walk-budget.example/search?q=lamp", true, &[], &[], None).unwrap()
}

/// How a route reads on is the site's to say, and the word the site was heard to say back is lent to the question only:
/// a walk that found one record asks again with the second word where there is one, and the route comes back with
/// the word it had. A site that has said it has few asks left is not asked, and a route that already holds a word
/// keeps it.
#[test]
fn a_route_is_asked_to_read_on_with_the_second_word_lent_and_taken_back() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let items = |from: u64| Some(serde_json::json!({ "items": (from..from + 10).map(|n| format!("brass lamp number {n}")).collect::<Vec<_>>() }));
    let offset = |g: &unbrowse_learn::Graph| -> u64 {
        g.steps[0].fields.iter().find(|f| f.loc == unbrowse_learn::Loc::Query("offset".into())).and_then(|f| match &f.class {
            unbrowse_learn::Class::Constant { value, .. } | unbrowse_learn::Class::Unconfirmed { value } => value.parse().ok(),
            unbrowse_learn::Class::Input { default: Some(v), .. } => v.parse().ok(),
            _ => None,
        }).unwrap_or(0)
    };
    // The walked word lists one record; the second word lists forty, and reads on.
    let mut site = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
        if i.get("q").map(String::as_str) == Some("lamp") {
            return Some(serde_json::json!({ "items": ["the only brass lamp there is"] }));
        }
        items(offset(g))
    };
    let counted = Some(unbrowse_learn::paging::Paging::Count { input: "offset".into(), step: 10 });
    let read = read_on_by_trial_with(a_list_route("offset=0"), Some("chandelier"), false, &mut site);
    assert_eq!(read.paging, counted);
    assert_eq!(read.heard.said_back, None, "the word was lent for the question only");
    assert_eq!(read_on_by_trial_with(a_list_route("offset=0"), None, false, &mut site).paging, None, "with no second word, one record reads on nowhere");
    let mut heard = a_list_route("offset=0");
    heard.heard.said_back = Some("chandelier".into());
    let read = read_on_by_trial_with(heard, Some("sofa"), false, &mut site);
    assert_eq!((read.paging, read.heard.said_back.as_deref()), (counted, Some("chandelier")), "the word the site was heard to say stays");
    // A site with few asks left is spared the question, and the route comes back as it was.
    let limited = {
        let mut e = walked("GET", "https://list.walk-budget.example/api/list?q=lamp&offset=0", "{}", false);
        e.response_headers.push(("x-ratelimit-remaining".into(), "1".into()));
        e
    };
    let mut asked = 0;
    let mut counting = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
        asked += 1;
        None
    };
    unbrowse_learn::budget::note(&limited);
    let spared = read_on_by_trial_with(a_list_route("offset=0"), Some("chandelier"), false, &mut counting);
    assert_eq!((asked, spared.paging), (0, None), "the site was asked nothing");
    // The second look to come makes the question wait on more asks than a site can spare.
    assert!(!spares(&a_list_route("offset=0"), PAGING_ASKS + SECOND_LOOK_ASKS) && !spares(&a_list_route("offset=0"), 2));
}

/// The wrappers that ask the site for real (a route's own client) reach the site and decide as the pure trials do: a
/// piece of the path the site has no call without is the call's address, two words go into a path the way the site
/// answers them, and a word that rides inside a packed value is held where the site's answer changes with it.
#[test]
fn the_trials_that_ask_a_site_for_real_decide_as_it_answers() {
    let _home = store::scratch_home("walk-wrappers");
    let _old = crate::learn::own_asks::as_the_old_node();
    // A paper index: `/rest/<piece>` has no page for a made-up piece, and a made-up query still answers.
    let (base, _) = a_site_that_answers(|target| if target.starts_with("/rest/search?") { ("application/json", r#"{"hits":["a","b","c"]}"#.into()) } else { ("404", "no such call".into()) });
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
        "provisional": false,
        "steps": [{
            "exchange": 0, "method": "GET", "status": 200, "url": format!("{base}/rest/{{path[1]}}?queryText={{queryText}}"), "needs_browser": false,
            "fields": [
                { "loc": { "in": "path", "key": 0 }, "class": "constant", "value": "rest" },
                { "loc": { "in": "path", "key": 1 }, "class": "input", "name": "part0", "secret": false, "default": "search" },
                { "loc": { "in": "query", "key": "queryText" }, "class": "input", "name": "queryText", "secret": false, "default": "robotics" }
            ]
        }]
    }))
    .unwrap();
    let route = Route::from_graph("r".into(), "search papers".into(), format!("{base}/search/searchresult.jsp?queryText=robotics"), graph).unwrap();
    let out = the_calls_address(route);
    assert_eq!(out.inputs.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["queryText"], "the piece is the call's address, no longer the caller's");
    assert_eq!(out.graph.steps[0].url, format!("{base}/rest/search?queryText={{queryText}}"));

    // A recipe site: `/search/<word>-`, answered for two words only the dashed way.
    let (base, _) = a_site_that_answers(|target| {
        let lines = |what: &str| ("application/json", serde_json::json!({ "text": (0..20).map(|n| format!("{what} {n}")).collect::<Vec<_>>().join("\n") }).to_string());
        if target.contains("chicken-chicken") { lines("roast chicken recipe") } else { lines("nothing matched, try these") }
    });
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
        "provisional": false,
        "steps": [{
            "exchange": 0, "method": "GET", "status": 200, "url": format!("{base}/search/{{path[1]}}"), "needs_browser": false,
            "held": [{ "loc": { "in": "path", "key": 1 }, "input": "search", "sits": "chicken", "written": "plain" }],
            "fields": [{ "loc": { "in": "path", "key": 1 }, "class": "constant", "value": "chicken-", "origin": null }]
        }]
    }))
    .unwrap();
    let mut route = Route::from_graph("r".into(), "search recipes".into(), format!("{base}/search/chicken-"), graph).unwrap();
    route.inputs = vec![store::RouteInput { name: "search".into(), secret: false, default: Some("chicken".into()), file: false, optional: false, options: Vec::new() }];
    let out = spaced_as_the_site_writes(route, "");
    assert_eq!(out.graph.steps[0].held[0].written, unbrowse_learn::graph::Written::Dashed);

    // A places search: the walked word rides in `q` and inside a packed value; the site reads the packed one.
    let (base, _) = a_site_that_answers(|target| {
        let kind = if target.contains("ramen") && target.contains("pb=") { "noodle" } else { "unrelated" };
        let kind = if target.contains("q=ramen") { "noodle" } else { kind };
        ("application/json", serde_json::json!({ "places": (0..20).map(|n| format!("{kind} house number {n}")).collect::<Vec<_>>() }).to_string())
    });
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
        "provisional": false,
        "steps": [{
            "exchange": 0, "method": "GET", "status": 200, "url": format!("{base}/search?q={{q}}&pb=%211sramen%217i20"), "needs_browser": false,
            "fields": [
                { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "search", "secret": false, "default": "ramen" },
                { "loc": { "in": "query", "key": "pb" }, "class": "constant", "value": "!1sramen!7i20", "origin": null }
            ]
        }]
    }))
    .unwrap();
    let route = Route::from_graph("r".into(), "search places".into(), format!("{base}/maps/search/ramen"), graph).unwrap();
    let kept = held_where_the_site_hears(route);
    assert_eq!(kept.graph.steps[0].held.len(), 1, "the word rides in the packed value too");
}

/// What a page that was not learned came to: each kind says its outcome and the reader that read it, more said after
/// it keeps its kind (a page that needed hands still needs them), the kinds that were never hands stay as they were,
/// and only the pages someone on them may get further on are for hands.
#[test]
fn a_page_that_was_not_learned_says_what_it_came_to_and_keeps_its_kind_when_told_more() {
    use crate::outcome::Outcome;
    let outcome = |u: Unlearned| u.outcome();
    assert_eq!(outcome(Unlearned::Loading), (Outcome::NeedsHands, "learn.loading"));
    assert_eq!(outcome(Unlearned::Hands("x".into())), (Outcome::NeedsHands, "unread"));
    assert_eq!(outcome(Unlearned::Door("x".into(), "trace.door")), (Outcome::Refused, "trace.door"));
    assert_eq!(outcome(Unlearned::SignIn("x".into(), "answer.sent_to_sign_in")), (Outcome::NeedsPerson, "answer.sent_to_sign_in"));
    assert_eq!(outcome(Unlearned::Check("x".into(), "mint.state")), (Outcome::Challenge, "mint.state"));
    assert_eq!(outcome(Unlearned::Unwalkable("x".into())), (Outcome::NotAllowed, "learn.unwalkable"));
    assert_eq!(outcome(Unlearned::Gone("x".into())), (Outcome::Gone, "learn.gone"));
    assert_eq!(outcome(Unlearned::Elsewhere("x".into())), (Outcome::AnsweredEmpty, "learn.elsewhere"));
    assert_eq!(outcome(Unlearned::Nothing("x".into())), (Outcome::AnsweredEmpty, "learn.nothing"));
    assert_eq!(outcome(Unlearned::Runtime("x".into())).0, Outcome::NoRoute);

    assert_eq!(Unlearned::Loading.and("more").to_string(), format!("{NEEDS_HANDS}; more"));
    assert_eq!(Unlearned::Loading.and("more"), Unlearned::Hands(format!("{NEEDS_HANDS}; more")));
    assert_eq!(Unlearned::Hands("stuck".into()).and("more"), Unlearned::Hands("stuck; more".into()));
    assert_eq!(Unlearned::Door("shut".into(), "trace.door").and("more"), Unlearned::Door("shut; more".into(), "trace.door"));
    assert_eq!(Unlearned::SignIn("in".into(), "a").and("more"), Unlearned::SignIn("in; more".into(), "a"));
    assert_eq!(Unlearned::Check("who".into(), "b").and("more"), Unlearned::Check("who; more".into(), "b"));
    assert_eq!(Unlearned::Gone("gone".into()).and("more"), Unlearned::Gone("gone".into()), "what was never for hands is told no more");
    assert_eq!(Unlearned::Nothing("none".into()).and("more").to_string(), "none");

    assert!(Unlearned::Loading.for_hands() && Unlearned::Hands("x".into()).for_hands() && Unlearned::Door("x".into(), "a").for_hands());
    assert!(Unlearned::SignIn("x".into(), "a").for_hands() && Unlearned::Check("x".into(), "a").for_hands());
    for never in [Unlearned::Unwalkable("x".into()), Unlearned::Gone("x".into()), Unlearned::Elsewhere("x".into()), Unlearned::Nothing("x".into()), Unlearned::Runtime("x".into())] {
        assert!(!never.for_hands(), "{never:?}");
    }
    assert_eq!(Unlearned::from("because"), Unlearned::Hands("because".into()));
    assert_eq!(Unlearned::from(String::from("because")).to_string(), "because");
}

fn a_check_page(url: &str) -> Exchange {
    walked("GET", url, "<html><head><title>Verify</title></head><body><p>Please enter the captcha to continue.</p><div class=\"g-recaptcha\" data-sitekey=\"k-123\"></div><form><input name=code><a href='/help'>Help with this check</a></form></body></html>", true)
}

/// A walk that failed says what its capture shows it stood at: the engine's own word that the site kept challenging it
/// is a check, a page that asks for a person is a check, a stopped walk says where it stopped, and a page that
/// is already something else (a page never walked, a nothing found) is not read again.
#[test]
fn a_walk_that_failed_is_said_as_what_stood_in_its_way() {
    let page = "https://shop.example/search?q=lamp";
    let check = Trace { exchanges: vec![a_check_page("https://shop.example/captcha/?from=1")], inputs: Vec::new() };
    let nothing = Trace { exchanges: vec![walked("GET", page, "<html><body>a shop of many things to browse and see, nothing more</body></html>", true)], inputs: Vec::new() };
    assert_eq!(walk_failed("mint unresolved (challenge)", "refused".into(), None, page), Unlearned::Check("refused".into(), "mint.state"));
    assert_eq!(walk_failed("the site kept challenging the browser", "refused".into(), Some(&nothing), page), Unlearned::Check("refused".into(), "mint.state"));
    assert_eq!(walk_failed("timed out", "it timed out".into(), None, page), Unlearned::Hands("it timed out".into()));
    assert_eq!(walk_failed("timed out", "it timed out".into(), Some(&check), page), Unlearned::Check("it timed out".into(), "challenge.asks_a_person"));
    let stopped = agent_browser_core::session::STOPPED;
    assert_eq!(walk_failed(stopped, "it stopped".into(), Some(&check), page), Unlearned::Check("it stopped, on a page that asks for a person".into(), "challenge.asks_a_person"));
    assert_eq!(walk_failed(stopped, "it stopped".into(), Some(&nothing), page), Unlearned::Hands("it stopped".into()), "a stop that stood nowhere in particular says only that");
    let sent = Trace {
        exchanges: vec![{
            let mut e = walked("GET", "https://shop.example/login?next=%2Fsearch", "<html><body><form action=/session method=post><input name=email><input type=password name=password></form></body></html>", true);
            e.status = 200;
            e
        }],
        inputs: Vec::new(),
    };
    assert!(matches!(walk_failed(stopped, "it stopped".into(), Some(&sent), page), Unlearned::SignIn(why, _) if why == "it stopped, on the sign-in the site sent the page to"));
    let refused = Trace { exchanges: vec![{ let mut e = walked("GET", page, "<html><body>Access denied</body></html>", true); e.status = 403; e }], inputs: Vec::new() };
    assert!(matches!(walk_failed(stopped, "it stopped".into(), Some(&refused), page), Unlearned::Door(why, "trace.door") if why == "it stopped, at the site's door, which had refused the page"));
    // Only what was never read is read again: a nothing found, a page never walked, stay as they were.
    assert_eq!(stood_in_the_way(&check, page, Unlearned::Nothing("none".into())), Unlearned::Nothing("none".into()));
    assert_eq!(stood_in_the_way(&check, page, Unlearned::Unwalkable("never".into())), Unlearned::Unwalkable("never".into()));
    assert!(matches!(stood_in_the_way(&check, page, Unlearned::Door("shut".into(), "x")), Unlearned::Check(..)), "a door that stood at a check is the check");
    assert!(matches!(stood_in_the_way(&refused, page, Unlearned::Door("shut".into(), "x")), Unlearned::Door(why, "x") if why == "shut"));
}

/// A call the site answered by sending the walk to its check for a person is the site's refusal of the page's own ask,
/// whether the address of the check is a value, in a list, or in an object of the answer.
#[test]
fn a_call_answered_with_the_address_of_the_sites_check_was_refused() {
    let page = "https://shop.example/search/surfing/videos";
    let call = |body: &str| walked("GET", "https://shop.example/api/videos?variables=%7B%22query%22%3A%22surfing%22%7D", body, false);
    let at = |answer: &str| Trace { exchanges: vec![walked("GET", page, "<html><body>videos</body></html>", true), call(answer), a_check_page("https://shop.example/captcha/")], inputs: Vec::new() };
    for answer in [
        r#"{"next":"https://shop.example/captcha/"}"#,
        r#"{"next":["https://shop.example/captcha/"]}"#,
        r#"{"next":[{"to":{"url":"https://shop.example/captcha/"}}]}"#,
    ] {
        let why = the_pages_ask_was_refused(&at(answer), page, "shop.example");
        assert!(why.as_deref().is_some_and(|w| w.contains("refused the page's own call for \"surfing\"") && w.contains("check for a person")), "{answer}: {why:?}");
    }
    assert_eq!(the_pages_ask_was_refused(&at(r#"{"next":"https://shop.example/elsewhere/"}"#), page, "shop.example"), None, "an address that is no check is no refusal");
    assert_eq!(the_pages_ask_was_refused(&at(r#"{"next":"https://other.example/captcha/"}"#), page, "shop.example"), None, "nor is another site's");
}

/// A route learned from a plain request for the page: the site answered it with data that hears the caller, so the
/// route is kept and says it hears; one that answers the same whatever is asked is a frame the page fills in, and is
/// walked; a page, a refusal in the site's words, an excluded site, or a site that cannot be reached is not learned.
#[test]
fn a_plain_request_that_answers_with_data_is_learned_and_the_rest_is_left_to_the_walk() {
    let _home = store::scratch_home("walk-plain");
    let _old = crate::learn::own_asks::as_the_old_node();
    let (base, asked) = a_site_that_answers(|target| {
        let path = target.split('?').next().unwrap_or_default();
        let word = target.split("q=").nth(1).unwrap_or_default().split('&').next().unwrap_or_default().to_string();
        match path {
            "/api/search" => ("application/json", records_that_hear(&word)),
            "/api/frame" => ("application/json", records("fixed")),
            "/page" => ("text/html", "<html><body>a page</body></html>".into()),
            "/api/denied" => ("404", r#"{"error":"nothing here"}"#.into()),
            _ => ("404", "no".into()),
        }
    });
    let heard = learn_plain(&format!("{base}/api/search?q=lamp"), "search the shop", "an agent");
    let Plain::Route(route) = heard else { panic!("a route was expected: {heard:?}") };
    assert!(route.heard.probed && route.heard.deaf.is_empty(), "it was asked, and it hears: {:?}", route.heard);
    assert!(route.inputs.iter().any(|i| i.name == "q" && i.default.as_deref() == Some("lamp")));
    assert_eq!(store::load_route(&route.id).map(|r| r.heard.probed), Some(true));
    assert!(store::read_activity(5).iter().any(|a| a.what == "Learned search the shop"));

    let frame = learn_plain(&format!("{base}/api/frame?q=lamp"), "search the shop", "an agent");
    assert!(matches!(frame, Plain::Page(None)), "answers the same whatever is asked: the page is walked: {frame:?}");
    assert!(store::load_routes().iter().all(|r| !r.path.contains("/api/frame")), "and no route is left of it");
    assert!(matches!(learn_plain(&format!("{base}/page"), "read the page", "an agent"), Plain::Page(None)));
    let said = learn_plain(&format!("{base}/api/denied?q=lamp"), "search the shop", "an agent");
    assert!(matches!(&said, Plain::Refused(why) if why.contains("the site answered 404")), "{said:?}");
    let bare = learn_plain(&format!("{base}/nowhere"), "search the shop", "an agent");
    assert!(matches!(&bare, Plain::Page(Some(why)) if why.contains("the site answered 404") && why.contains("to a plain request for the page")), "{bare:?}");
    assert!(matches!(learn_plain("not a url", "x", "an agent"), Plain::Page(None)));
    assert!(matches!(learn_plain("ftp://files.example/a", "x", "an agent"), Plain::Page(None)));
    let mut settings = store::load_settings();
    settings.excluded = vec!["127.0.0.1".into()];
    store::save_settings(&settings).unwrap();
    let before = asked.locked().len();
    assert!(matches!(learn_plain(&format!("{base}/api/search?q=lamp"), "search the shop", "an agent"), Plain::Page(None)));
    assert_eq!(asked.locked().len(), before, "an excluded site is not asked");
}

/// A call the owner's own record or a listed route already holds stands as it is when the learn finds it again: the
/// activity says it was already known, not learned, and says why.
#[test]
fn a_call_already_held_as_listed_or_the_owners_own_is_told_as_known_not_learned() {
    let _home = store::scratch_home("walk-known");
    let mut route = Route::from_graph(
        "r".into(),
        "search the shop".into(),
        "https://known.example/search?q=lamp".into(),
        serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://known.example/api/search?q={q}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp" }] }]
        }))
        .unwrap(),
    )
    .unwrap();
    let id = route.id.clone();
    let learned = save_learned(route.clone(), "an agent").expect("learned");
    assert_eq!(learned.id, id);
    let told = || store::read_activity(10);
    assert!(told().iter().any(|a| a.what == "Learned search the shop" && a.result == "done"));
    // The owner's own stands over a learn that is not theirs.
    let mut own = route.clone();
    own.yours = true;
    store::save_route(&own).unwrap();
    let held = save_learned(route.clone(), "an agent").expect("held");
    assert!(held.yours);
    assert!(told().iter().any(|a| a.what == "Already knows search the shop" && a.result == "skipped" && a.note.as_deref() == Some("it is the owner's own, so it stays theirs")), "{:?}", told());
    // A listed route stands over any learn.
    route.listing = Some(store::Listing { entry_id: "0xab".into(), tx: "0xcd".into(), listed_at: 1, live: true });
    store::save_route(&route).unwrap();
    let listed = save_learned(route.clone(), "an agent").expect("listed");
    assert!(listed.listing.is_some());
    assert!(told().iter().any(|a| a.note.as_deref() == Some("it is listed, so it stays as listed")), "{:?}", told());
}

/// A page's own markup says which pieces of its address are the site's: a form that submits to a piece of the path
/// writes it, and a piece most of the page's own links carry in the same place is where the site lives. Neither is the
/// caller's value, though a call the page makes sends it as one; the value that is left is named for the piece before
/// it, and the site's word is kept for every later reading of its addresses.
#[test]
fn a_piece_of_the_path_the_pages_own_markup_writes_is_the_sites_and_not_the_callers() {
    let call = |host: &str, scope: &str, word: &str| {
        let body = serde_json::json!({ "query": word, "hits": (0..6).map(|n| serde_json::json!({ "id": n, "title": format!("{word} dish number {n}") })).collect::<Vec<_>>() }).to_string();
        walked("GET", &format!("https://{host}/api/find?scope={scope}&q={word}"), &body, false)
    };
    // A form at `/search` on the page `/search/lasagna`.
    let url = "https://formshop.example/search/lasagna";
    let page = walked("GET", url, r#"<html><body><form action="/search" method="get"><input name="q"></form><p>lasagna</p></body></html>"#, true);
    let trace = Trace { exchanges: vec![page, call("formshop.example", "search", "lasagna")], inputs: Vec::new() };
    assert_eq!(path_inputs(url, "find a recipe", &trace), (vec![("search".to_string(), "lasagna".to_string())], "the rule"), "the form's piece is the site's; the value is named for it");
    assert_eq!(path_inputs("https://formshop.example/search/risotto", "find a recipe", &Trace { exchanges: Vec::new(), inputs: Vec::new() }), (vec![], "the rule"), "and the site's word is kept for every later reading");
    // Fourteen links, each under `/recipes/`.
    let url = "https://linkshop.example/recipes/lasagna";
    let links: String = (0..14).map(|n| format!(r#"<a href="/recipes/pasta-{n}">Pasta {n}</a>"#)).collect();
    let page = walked("GET", url, &format!("<html><body>{links}<h1>lasagna</h1></body></html>"), true);
    let trace = Trace { exchanges: vec![page, call("linkshop.example", "recipes", "lasagna")], inputs: Vec::new() };
    assert_eq!(path_inputs(url, "find a recipe", &trace), (vec![("recipes".to_string(), "lasagna".to_string())], "the rule"));
    // Where the page was asked nothing but the piece its links carry (a profile's own name), it stays the caller's.
    let url = "https://profileshop.example/someone";
    let links: String = (0..14).map(|n| format!(r#"<a href="/someone/project-{n}">Project {n}</a>"#)).collect();
    let page = walked("GET", url, &format!("<html><body>{links}<h1>someone</h1></body></html>"), true);
    let trace = Trace { exchanges: vec![page, call("profileshop.example", "someone", "someone")], inputs: Vec::new() };
    assert_eq!(path_inputs(url, "see a profile", &trace).0, vec![("part0".to_string(), "someone".to_string())]);
}

/// The page's own script, which unpacks a reply the site ciphers (base64 of bytes xor 0x5a) and hands it to a callback.
const A_DECODER_SCRIPT: &str = "(function () {\n  function unpack(t) { var raw = atob(t), out = ''; for (var i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ 0x5a); return JSON.parse(out); }\n  window.searchCipher = function (q, done) {\n    fetch('/api/search?q=' + encodeURIComponent(q)).then(function (r) { return r.text(); }).then(function (t) { done(unpack(t)); });\n  };\n})();\n";

/// A walk of a page whose search call's reply is ciphered, as the walk's recording and trace hold it: the recording
/// names the script that sent the call, and keeps its code under its hash.
fn a_ciphered_walk(sender: &str) -> (Trace, unbrowse_learn::recording::Recording) {
    use base64::Engine;
    use sha2::Digest;
    let records = r#"{"query":"lamp","results":[{"title":"lamp one"},{"title":"lamp two"}]}"#;
    let ciphered = base64::engine::general_purpose::STANDARD.encode(records.bytes().map(|b| b ^ 0x5a).collect::<Vec<u8>>());
    let mut call = walked("GET", "https://shop.example/api/search?q=lamp", &ciphered, false);
    call.response_mime = "text/plain".into();
    let trace = Trace { exchanges: vec![walked("GET", "https://shop.example/search?q=lamp", "<html><body>a shop</body></html>", true), call], inputs: Vec::new() };
    let lines = [
        serde_json::json!({ "type": "script", "scriptId": "s1", "url": "https://shop.example/s/app.js", "language": "js", "sha256": hex::encode(sha2::Sha256::digest(A_DECODER_SCRIPT.as_bytes())), "source": A_DECODER_SCRIPT }),
        serde_json::json!({ "type": "request", "requestId": "r1", "method": "GET", "url": "https://shop.example/search?q=lamp", "resourceType": "Document", "frameId": "f1", "headers": {} }),
        serde_json::json!({ "type": "response", "requestId": "r1", "url": "https://shop.example/search?q=lamp", "status": 200, "mimeType": "text/html", "headers": {}, "body": "<html><body>a shop</body></html>" }),
        serde_json::json!({ "type": "request", "requestId": "r2", "method": "GET", "url": "https://shop.example/api/search?q=lamp", "resourceType": "XHR", "frameId": "f1", "headers": {}, "initiator": { "type": "script", "frames": [{ "scriptId": sender, "url": "https://shop.example/s/app.js" }] } }),
        serde_json::json!({ "type": "response", "requestId": "r2", "url": "https://shop.example/api/search?q=lamp", "status": 200, "mimeType": "text/plain", "headers": {}, "body": ciphered }),
    ];
    let log: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let dir = store::home().join("walks");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("learn_{sender}.jsonl")), log).unwrap();
    (trace, unbrowse_learn::recording::Recording::read(&dir, &format!("learn_{sender}")).expect("a recording"))
}

fn a_ciphered_route(word: &str) -> Route {
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
        "provisional": false,
        "steps": [{ "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}", "needs_browser": false,
            "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": word }] }]
    }))
    .unwrap();
    Route::from_graph("r".into(), "search the shop".into(), "https://shop.example/search?q=lamp".into(), graph).unwrap()
}

/// A reply only the site's own script reads is read as the page read it: the decoder is cut from the script that sent
/// the call and carried on the route's body, with the script's hash on the answer step's test, when it turns the
/// walked reply into JSON that says the walked word back. A reply a standard reader reads, a call no script of the
/// recording sent, a script whose code the recording lost, a decoder whose answer is not the walked word's, and a walk
/// with no recording leave the route as it was; the same readings, over the whole trace, are what recognition reads.
#[test]
fn a_reply_only_the_sites_own_script_reads_is_carried_on_the_route_as_its_decoder() {
    if !unbrowse_learn::sandbox::available() {
        eprintln!("no signing runtime on this machine: the page's decoder is skipped");
        return;
    }
    let _home = store::scratch_home("walk-decoder");
    let (trace, rec) = a_ciphered_walk("s1");
    let mut route = a_ciphered_route("lamp");
    attach_a_decoder(&mut route, &trace, Some(&rec));
    let decode = route.body.as_ref().and_then(|b| b.answer.decode.as_ref()).expect("the decoder is carried");
    assert!(decode.source.contains("function sign(") && decode.source.contains("searchCipher"), "cut from the script that sent the call");
    let sha = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(A_DECODER_SCRIPT.as_bytes()));
    let body = route.body.as_ref().unwrap();
    assert!(body.tests.iter().filter(|t| t.step == body.answer.step).all(|t| t.over_scripts.contains(&sha)), "the answer step's test names the script");

    let untouched = |route: &Route| route.body.as_ref().and_then(|b| b.answer.decode.as_ref()).is_none();
    let mut none = a_ciphered_route("lamp");
    attach_a_decoder(&mut none, &trace, None);
    assert!(none.body.is_none() && untouched(&none), "no recording, no decoder");
    let mut other_word = a_ciphered_route("kettle");
    attach_a_decoder(&mut other_word, &trace, Some(&rec));
    assert!(untouched(&other_word), "a decoder whose answer does not say the walked word back is no reading of this reply");
    let mut no_word = a_ciphered_route("la");
    attach_a_decoder(&mut no_word, &trace, Some(&rec));
    assert!(untouched(&no_word), "a word too short to say is not said back");
    let (_, unsent) = a_ciphered_walk("s9");
    let mut unlisted = a_ciphered_route("lamp");
    attach_a_decoder(&mut unlisted, &trace, Some(&unsent));
    assert!(untouched(&unlisted), "a call no listed script sent is the page's, not a script's to decode");
    let mut plain = trace.clone();
    plain.exchanges[1].response_body = Some(r#"{"results":[{"title":"lamp"}]}"#.into());
    let mut read = a_ciphered_route("lamp");
    attach_a_decoder(&mut read, &plain, Some(&rec));
    assert!(untouched(&read), "a reply read as it stands is not decoded");
    let mut page = trace.clone();
    page.exchanges[1].response_body = Some("<html><body>lamp</body></html>".into());
    page.exchanges[1].response_mime = "text/html".into();
    let mut markup = a_ciphered_route("lamp");
    attach_a_decoder(&mut markup, &page, Some(&rec));
    assert!(untouched(&markup), "a page is not decoded");
    let mut blank = trace.clone();
    blank.exchanges[1].response_body = Some("  ".into());
    let mut empty = a_ciphered_route("lamp");
    attach_a_decoder(&mut empty, &blank, Some(&rec));
    assert!(untouched(&empty), "a reply of nothing is not decoded");
    let mut of_the_post = trace.clone();
    of_the_post.exchanges[1].method = "POST".into();
    let mut by_method = a_ciphered_route("lamp");
    attach_a_decoder(&mut by_method, &of_the_post, Some(&rec));
    assert!(untouched(&by_method), "the call is found by its method and address");

    // The reading over the whole walk: one program for each script that sent a reply of the site's own.
    let programs = decoded_overlay_of(&trace, Some(&rec), "shop.example");
    assert_eq!(programs.len(), 1);
    assert!(programs[0].contains("function sign("));
    assert!(decoded_overlay_of(&trace, None, "shop.example").is_empty());
    assert!(decoded_overlay_of(&trace, Some(&rec), "other.example").is_empty(), "a call of another site is not this site's to decode");
    assert!(decoded_overlay_of(&plain, Some(&rec), "shop.example").is_empty() && decoded_overlay_of(&page, Some(&rec), "shop.example").is_empty() && decoded_overlay_of(&blank, Some(&rec), "shop.example").is_empty());
    assert!(decoded_overlay_of(&trace, Some(&unsent), "shop.example").is_empty());
    let mut twice = trace.clone();
    twice.exchanges.push(twice.exchanges[1].clone());
    assert_eq!(decoded_overlay_of(&twice, Some(&rec), "shop.example").len(), 1, "a script's decoder is cut once");
    assert!(left_to_page_code(&trace, Some(&rec), "shop.example").is_none(), "a machine that runs the page's code leaves nothing to it");
}

/// A route kept from a walk whose reply the page's script ciphers carries the page's decoder, and is saved so.
#[test]
fn a_call_chosen_from_a_walk_with_a_ciphered_reply_is_kept_with_the_pages_decoder() {
    if !unbrowse_learn::sandbox::available() {
        eprintln!("no signing runtime on this machine: the page's decoder is skipped");
        return;
    }
    let _home = store::scratch_home("walk-keep-decoder");
    let _old = crate::learn::own_asks::as_the_old_node();
    let (trace, rec) = a_ciphered_walk("s1");
    let walks = Walks::default();
    let mut walk = a_walk_in_memory("https://shop.example/search?q=lamp", Trace { inputs: walk_inputs("https://shop.example/search?q=lamp", &[], &[]), ..trace }, 0);
    walk.recording = Some(rec);
    keep_walk(&mut walks.0.locked(), "w1".into(), walk);
    let route = keep_candidate(&walks, "w1", 1, "search the shop", "an agent").expect("kept");
    assert!(route.body.as_ref().is_some_and(|b| b.answer.decode.is_some()), "the decoder rides on the route");
    let saved = store::load_route(&route.id).expect("saved");
    assert!(saved.body.as_ref().is_some_and(|b| b.answer.decode.as_ref().is_some_and(|d| d.source.contains("searchCipher"))), "and is saved with it");
}

/// The route learned by example from two walks of the shop at `base` whose search is at `path`, kept: its body carries
/// the plan it was learned by.
fn learned_by_example_on(base: &str, path: &str) -> Route {
    let walk = |word: &str| {
        let root = format!("{base}/search?q={}", word.replace(' ', "+"));
        Trace { exchanges: vec![walked("GET", &root, "<html><body>a shop</body></html>", true), walked("GET", &format!("{base}{path}?q={}", word.replace(' ', "+")), &records_that_hear(word), false)], inputs: walk_inputs(&root, &[], &[]) }
    };
    let (first, history) = (walk("red lamp"), vec![(walk("blue sofa"), Vec::new())]);
    let route = route_of_by(&first, 1, "search the shop", &format!("{base}/search?q=red+lamp"), true, &[], &history, None, true).unwrap();
    store::save_route(&route).unwrap();
    route
}

/// A route learned again from its plan: the plan's page is written with the caller's values and learned as any learn
/// is, and the route that stands takes the old one's place. A route with no plan, a page that does not read as an
/// address, a page that still asks what the call does not give, and a site with few asks left are told why not, and
/// nothing is walked; an owner's own route stands beside the new one.
#[test]
fn a_route_is_learned_again_from_its_plan_only_where_the_plan_can_be_followed() {
    let _home = store::scratch_home("walk-learned-again");
    let _old = crate::learn::own_asks::as_the_old_node();
    let (base, _) = a_site_that_answers(|target| {
        let word = target.split("q=").nth(1).unwrap_or_default().split('&').next().unwrap_or_default().replace('+', " ");
        if target.starts_with("/api/") { ("application/json", records_that_hear(&word)) } else { ("text/html", "<html><body>a shop</body></html>".into()) }
    });
    let old = learned_by_example_on(&base, "/api/lookup");
    let chair = HashMap::from([("q".to_string(), "green chair".to_string())]);
    let handed = std::rc::Rc::new(std::cell::RefCell::new(Vec::<(String, String)>::new()));
    let learner = |base: String, handed: std::rc::Rc<std::cell::RefCell<Vec<(String, String)>>>| {
        move |page: &str, goal: &str| {
            handed.borrow_mut().push((page.to_string(), goal.to_string()));
            Ok(learned_by_example_on(&base, "/api/v2/search"))
        }
    };

    let mut planless = old.clone();
    planless.body.as_mut().unwrap().plan = None;
    let not = learning_again_by(learner(base.clone(), handed.clone()), || learned_again(&planless, &chair, "You", None)).expect_err("no plan");
    assert_eq!(not, "the route carries no plan");
    let mut unreadable = old.clone();
    unreadable.body.as_mut().unwrap().plan.as_mut().unwrap().page = "not an address {q}".into();
    let not = learning_again_by(learner(base.clone(), handed.clone()), || learned_again(&unreadable, &chair, "You", None)).expect_err("no address");
    assert_eq!(not, "the plan's page does not read as an address");
    let mut asking_more = old.clone();
    asking_more.body.as_mut().unwrap().plan.as_mut().unwrap().page = format!("{base}/search?q={{q}}&shelf={{shelf}}");
    let not = learning_again_by(learner(base.clone(), handed.clone()), || learned_again(&asking_more, &chair, "You", None)).expect_err("still asks");
    assert_eq!(not, "its page still asks shelf, which the call does not give");
    assert!(handed.borrow().is_empty(), "nothing was walked");

    // The site said it has few asks left: a learn would spend the caller's.
    let mut limited = walked("GET", &format!("{base}/api/lookup?q=lamp"), "{}", false);
    limited.response_headers.push(("x-ratelimit-remaining".into(), "1".into()));
    unbrowse_learn::budget::note(&limited);
    let not = learning_again_by(learner(base.clone(), handed.clone()), || learned_again(&old, &chair, "You", None)).expect_err("few asks");
    assert!(not.contains("few asks left"), "{not}");
    assert!(handed.borrow().is_empty());
}

/// The route that stands after a learn again takes the old one's place and is handed the plan's page for the caller's
/// value; where the old one is the owner's own, it is not retired and stands beside the new one.
#[test]
fn the_route_learned_again_takes_the_place_of_the_old_unless_the_old_is_the_owners_own() {
    let _home = store::scratch_home("walk-learned-again-place");
    let _old = crate::learn::own_asks::as_the_old_node();
    let (base, _) = a_site_that_answers(|target| {
        let word = target.split("q=").nth(1).unwrap_or_default().split('&').next().unwrap_or_default().replace('+', " ");
        if target.starts_with("/api/") { ("application/json", records_that_hear(&word)) } else { ("text/html", "<html><body>a shop</body></html>".into()) }
    });
    let chair = HashMap::from([("q".to_string(), "green chair".to_string())]);
    let handed = std::rc::Rc::new(std::cell::RefCell::new(Vec::<(String, String)>::new()));
    let learner = |base: String, handed: std::rc::Rc<std::cell::RefCell<Vec<(String, String)>>>| {
        move |page: &str, goal: &str| {
            handed.borrow_mut().push((page.to_string(), goal.to_string()));
            Ok(learned_by_example_on(&base, "/api/v2/search"))
        }
    };
    let old = learned_by_example_on(&base, "/api/search");
    let standing = learning_again_by(learner(base.clone(), handed.clone()), || learned_again(&old, &chair, "You", None)).expect("learned again");
    assert_ne!(standing.id, old.id);
    assert_eq!(handed.borrow().as_slice(), [(format!("{base}/search?q=green+chair"), "search the shop".to_string())]);
    assert!(store::load_route(&old.id).is_none(), "the old route is retired");
    assert_eq!(store::took_the_place_of(&old.id).map(|r| r.id), Some(standing.id.clone()));

    let mut theirs = learned_by_example_on(&base, "/api/search");
    theirs.yours = true;
    store::save_route(&theirs).unwrap();
    let standing = learning_again_by(learner(base.clone(), handed.clone()), || learned_again(&theirs, &chair, "You", None)).expect("learned again");
    assert_ne!(standing.id, theirs.id);
    assert!(store::load_route(&theirs.id).is_some_and(|r| r.yours), "the owner's own is not retired");
    assert!(store::load_route(&standing.id).is_some());
}

/// How many things a route's answer lists is asked of the site as its walk asked it: the longest list of its answer, or
/// its page's links; nothing at all where the site does not answer.
#[test]
fn how_many_things_a_routes_answer_lists_is_asked_of_the_site() {
    let _home = store::scratch_home("walk-things");
    let _old = crate::learn::own_asks::as_the_old_node();
    let (base, _) = a_site_that_answers(|target| match target.split('?').next().unwrap_or_default() {
        "/api/list" => ("application/json", records_that_hear("lamp")),
        _ => ("404", "no".into()),
    });
    let route = |path: &str| {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("{base}{path}?q={{q}}"), "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp" }] }]
        }))
        .unwrap();
        Route::from_graph("r".into(), "list the lamps".into(), format!("{base}/search?q=lamp"), graph).unwrap()
    };
    assert_eq!(things_listed(&route("/api/list")), Some(8));
    assert_eq!(things_listed(&route("/api/gone")), None, "a site that does not answer lists nothing");
}
