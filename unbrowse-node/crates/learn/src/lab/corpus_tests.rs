//! The corpus reports of `lab::corpus`, run over a corpus the test lays down itself (no site, no real capture).

use super::*;
use crate::lab::kept::{case, Case};
use crate::replay::Fetch;

/// A corpus folder of its own, gone when it drops.
struct Dir(PathBuf);
impl Dir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("corpus-reports-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    /// One walk of a page: its calls, each as (address, headers, reply), the first being the page's own document. `learned`
    /// names the call kept from it (method, host and path), when it does.
    fn raw(&self, folder: &str, site: &str, word: &str, calls: &[(String, serde_json::Value, String)], learned: Option<&str>) -> &Self {
        let dir = self.0.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let page = format!("https://{site}/search?q={word}");
        std::fs::write(dir.join("case.json"), serde_json::json!({"site": site, "url": page, "value": word}).to_string()).unwrap();
        let mut lines = vec![
            serde_json::json!({"type": "request", "t": 1.0, "requestId": "1", "method": "GET", "url": page, "headers": {}, "resourceType": "Document", "frameId": "MAIN"}),
            serde_json::json!({"type": "response", "t": 1.5, "requestId": "1", "url": page, "status": 200, "mimeType": "text/html", "headers": {}, "body": "<html></html>"}),
        ];
        for (n, (url, headers, reply)) in calls.iter().enumerate() {
            let (id, t) = (format!("{}", n + 2), 2.0 + n as f64);
            // A call written `POST|<address>|<body>` is a post of that body.
            let (method, url, body) = match url.strip_prefix("POST|").and_then(|r| r.split_once('|')) {
                Some((url, body)) => ("POST", url.to_string(), Some(body.to_string())),
                None => ("GET", url.clone(), None),
            };
            lines.push(serde_json::json!({"type": "request", "t": t, "requestId": id, "method": method, "url": url, "headers": headers, "resourceType": "Fetch", "frameId": "MAIN", "postData": body}));
            lines.push(serde_json::json!({"type": "response", "t": t + 0.5, "requestId": id, "url": url, "status": 200, "mimeType": "application/json", "headers": {}, "body": reply}));
        }
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(agent_browser_core::session::capture_path(&dir, "learn_w"), text).unwrap();
        if let Some(call) = learned {
            std::fs::write(dir.join("learned.json"), serde_json::json!({"call": call}).to_string()).unwrap();
        }
        self
    }

    /// One walk of a shop's page for `word`: it asks for a token, then searches with it. What the search finds
    /// is other things for another word.
    fn walk(&self, folder: &str, site: &str, word: &str, token: &str, learned: Option<&str>) -> &Self {
        let found = match word {
            "lamp" => ["Desk lamp", "Floor lamp", "Night light", "Bulb", "Shade", "Lantern"],
            _ => ["Red sofa", "Armchair", "Ottoman", "Settee", "Futon", "Daybed"],
        };
        let items: Vec<String> = found.iter().map(|name| format!(r#"{{"name":"{name} for {word}"}}"#)).collect();
        self.raw(
            folder,
            site,
            word,
            &[
                (format!("https://{site}/api/session"), serde_json::json!({}), format!(r#"{{"token":"{token}"}}"#)),
                (format!("https://{site}/api/find?q={word}&size=20"), serde_json::json!({"x-token": token, "sec-ch-viewport-width": if word == "lamp" { "1280" } else { "1366" }}), format!(r#"{{"items":[{}]}}"#, items.join(","))),
            ],
            learned,
        )
    }

    /// A corpus of one shop walked twice (its kept call named), a site walked once, and a site whose walk kept no call.
    fn shops(name: &str) -> Self {
        let dir = Self::new(name);
        dir.walk("a1", "shop.example", "lamp", "tok_9f8e7d6c5b", Some("GET shop.example/api/find"))
            .walk("a2", "shop.example", "sofa", "tok_1a2b3c4d5e", Some("GET shop.example/api/find"))
            .walk("b1", "lone.example", "lamp", "tok_aaaaaaaaaa", Some("GET lone.example/api/find"))
            .walk("c1", "unkept.example", "lamp", "tok_bbbbbbbbbb", None)
            .walk("c2", "unkept.example", "sofa", "tok_cccccccccc", None)
            // The learner kept the token's call: the walks say the search is the answer.
            .walk("d1", "differ.example", "lamp", "tok_dddddddddd", Some("GET differ.example/api/session"))
            .walk("d2", "differ.example", "sofa", "tok_eeeeeeeeee", Some("GET differ.example/api/session"))
            // A call the walk never made.
            .walk("e1", "absent.example", "lamp", "tok_ffffffffff", Some("GET absent.example/api/gone"))
            .walk("e2", "absent.example", "sofa", "tok_gggggggggg", Some("GET absent.example/api/gone"));
        // A search that posts the word: the learned answer is a post, which only asks.
        let post = |word: &str| {
            let found = if word == "lamp" { ["Desk lamp", "Floor lamp", "Night light", "Bulb", "Shade", "Lantern"] } else { ["Red sofa", "Armchair", "Ottoman", "Settee", "Futon", "Daybed"] };
            let items: Vec<String> = found.iter().map(|name| format!(r#"{{"name":"{name} for {word}"}}"#)).collect();
            [(format!(r#"POST|https://post.example/api/find|{{"term":"{word}","page":1}}"#), serde_json::json!({"content-type": "application/json"}), format!(r#"{{"items":[{}]}}"#, items.join(",")))]
        };
        dir.raw("h1", "post.example", "lamp", &post("lamp"), Some("POST post.example/api/find")).raw("h2", "post.example", "sofa", &post("sofa"), Some("POST post.example/api/find"));
        // A search whose reply does not change with the word: the walks settle nothing, the learner kept it anyway.
        let same = |word: &str| [(format!("https://deaf.example/api/find?q={word}"), serde_json::json!({}), r#"{"items":[{"name":"Always the same"}]}"#.to_string())];
        dir.raw("f1", "deaf.example", "lamp", &same("lamp"), Some("GET deaf.example/api/find")).raw("f2", "deaf.example", "sofa", &same("sofa"), Some("GET deaf.example/api/find"));
        // The second walk never made the call the first kept.
        dir.raw("g1", "once.example", "lamp", &[("https://once.example/api/find?q=lamp".to_string(), serde_json::json!({}), r#"{"items":[{"name":"Desk lamp"}]}"#.to_string())], Some("GET once.example/api/find"))
            .raw("g2", "once.example", "sofa", &[("https://once.example/api/other".to_string(), serde_json::json!({}), "{}".to_string())], None);
        dir
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The reports read the corpus the environment names, so the tests that run them take turns with it.
static NAMED: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Runs `report` with `UNBROWSE_CORPUS` naming `corpus`. The variable is read only by the reports, which say what they
/// read and judge by what they are handed; a report that runs beside this one reads the same corpus.
fn naming(corpus: &Dir, report: fn()) {
    let _turn = NAMED.lock().unwrap_or_else(|e| e.into_inner());
    // Held under NAMED so two namings never race.
    std::env::set_var("UNBROWSE_CORPUS", &corpus.0);
    let result = std::panic::catch_unwind(report);
    std::env::remove_var("UNBROWSE_CORPUS");
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

/// The shop's two walks, read as a learner reads them.
fn two_shop_walks(dir: &Dir) -> (Case, Case) {
    (case(&dir.0.join("a1")).expect("the first walk"), case(&dir.0.join("a2")).expect("the second walk"))
}

#[test]
fn the_report_of_each_place_of_a_kept_call_reads_every_site_that_was_walked_twice() {
    let dir = Dir::shops("places");
    let (first, _) = two_shop_walks(&dir);
    assert!(kept_call(&first).is_some(), "the corpus this report reads holds the kept call");
    naming(&dir, what_two_walks_say_of_each_place_of_each_kept_call);
}

#[test]
fn a_route_written_from_two_walks_is_called_against_each_recording_and_written_the_same_twice() {
    let dir = Dir::shops("route");
    naming(&dir, a_route_the_learner_writes_from_two_walks_is_called_against_each_walks_recording);
}

#[test]
fn the_pick_of_the_walks_is_set_beside_the_call_that_was_kept() {
    let dir = Dir::shops("pick");
    naming(&dir, which_call_two_walks_say_is_the_answer_beside_the_kept_call);
}

#[test]
fn a_body_said_as_a_graph_fills_and_runs_as_the_body_does() {
    let dir = Dir::shops("graph");
    naming(&dir, a_learned_body_said_as_a_graph_is_run_by_the_nodes_caller_as_by_the_learners);
    naming(&dir, a_learned_body_runs_as_the_graph_it_says_runs);
}

#[test]
fn the_sites_tests_are_judged_over_each_walks_recording_and_shrinking_is_tried_of_each_body() {
    let dir = Dir::shops("tests");
    naming(&dir, the_sites_tests_over_each_walks_recording);
    naming(&dir, what_shrinking_would_try_of_each_learned_body);
}

/// The transport answers an ask from the walk's recording: the reply the walk heard for what it sent, and a failure
/// that names the places an ask differs at when the recording holds no such ask. Every request is kept, whole.
#[test]
fn a_transport_over_a_recording_answers_what_the_walk_heard_and_names_where_an_unheard_ask_differs() {
    let _offline = crate::http::offline();
    let dir = Dir::shops("answering");
    let (first, second) = two_shop_walks(&dir);
    let walks = [Walk { trace: &first.trace, asked: asked(&first), session: 1 }, Walk { trace: &second.trace, asked: asked(&second), session: 1 }];
    let body = crate::lab::compile::learn(&walks, "shop.example").expect("the walks settle the answer");
    let at = kept_call(&first).expect("the kept call is in the walk");
    let jar = std::collections::HashMap::from([("sid".to_string(), "s-1".to_string())]);
    let mut over = Answering { walk: &walks[0], body: &body, jar: &jar, heard: Vec::new(), sent: Vec::new() };
    let walked = &first.trace.exchanges[at];
    let ask = crate::replay::Request { method: "GET".into(), url: walked.url.clone(), exchange: at, headers: walked.request_headers.clone(), body: None };
    let reply = over.fetch(&ask).expect("the walk heard this ask");
    assert_eq!(reply.response_body, walked.response_body, "the reply is the one the walk got");
    assert_eq!(over.heard, [(crate::body::step_id(at), Some(at))]);
    assert_eq!(over.sent.len(), 1);
    assert!(over.sent[0].starts_with("GET https://shop.example/api/find?q=lamp"), "{:?}", over.sent);
    assert_eq!(over.fetch_unredirected(&ask).expect("the same ask").response_body, walked.response_body);
    assert_eq!(over.sent.len(), 2, "an ask made without following redirects is kept too");
    assert_eq!(over.minted("sid").as_deref(), Some("s-1"), "what the session holds is what it minted");
    assert_eq!(over.minted("other"), None);
    // The same call asked for a word the walk never sent: unheard, and where it differs is said.
    let mut other = ask.clone();
    other.url = "https://shop.example/api/find?q=chair&size=20".parse().unwrap();
    let err = format!("{:?}", over.fetch(&other).expect_err("the recording holds no such ask"));
    assert!(err.contains("the recording holds no such ask") && err.contains("q"), "{err}");
    assert_eq!(over.sent.len(), 3, "an ask that was refused was still sent");
    // A call the body holds no step for.
    let mut stray = ask.clone();
    stray.exchange = 99;
    let err = format!("{:?}", over.fetch(&stray).expect_err("no step"));
    assert!(err.contains("no step x99 in the body"), "{err}");
}
