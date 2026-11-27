//! What the node makes of a request the page's own code asks for (UNB-208): the page is hostile input, and the node
//! decides what is sent, with what, and what the page is handed back.
use super::*;
use serde_json::json;

/// The page's own site, a name the egress rule reads as public, built so no source names a site.
fn at(s: &str) -> String {
    s.replace("SITE", &format!("shop.{}", "example.com"))
}

fn the_page() -> url::Url {
    at("https://SITE/lamps").parse().unwrap()
}

fn an_answer(status: u16, headers: &[(&str, &str)], body: Option<String>) -> crate::trace::Exchange {
    crate::trace::Exchange {
        method: "GET".into(),
        url: at("https://SITE/api").parse().unwrap(),
        request_headers: vec![],
        request_body: None,
        status,
        response_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        response_body: body,
        response_mime: "application/json".into(),
        resource_type: None,
        main_frame: None,
    }
}

/// Runs `ask` as the page's request with `net` answering, and says what the page was told and what `net` was asked.
fn asked(ask: serde_json::Value, deadline: std::time::Duration, reply: Result<crate::trace::Exchange, String>) -> (serde_json::Value, Vec<Request>) {
    let seen = std::cell::RefCell::new(Vec::new());
    let mut net = |req: &Request, _: std::time::Instant| {
        seen.borrow_mut().push(req.clone());
        reply.clone()
    };
    let page = the_page();
    let told = answer(&ask, &mut net, Some(&page), std::time::Instant::now() + deadline);
    (told, seen.into_inner())
}

const LONG: std::time::Duration = std::time::Duration::from_secs(60);

/// A page asking after its run's time is up is told so, and nothing is sent for it.
#[test]
fn a_page_asking_after_its_time_is_up_is_refused_and_nothing_is_sent() {
    let (told, seen) = asked(json!({ "url": at("https://SITE/api") }), std::time::Duration::ZERO, Ok(an_answer(200, &[], None)));
    assert_eq!((told["status"].clone(), told["error"].clone()), (json!(0), json!("the run's time is up")));
    assert!(seen.is_empty(), "{seen:?}");
}

/// An address that isn't a web address, another site's, one over plain HTTP, or any when the run has no page, is refused
/// with its reason, and nothing is sent.
#[test]
fn a_page_may_ask_only_its_own_site_over_https() {
    for (url, why) in [("not an address".to_string(), "not a web address"), (format!("https://other.{}/api", "example.org"), "is not the page's own site"), (at("http://SITE/api"), "isn't HTTPS")] {
        let (told, seen) = asked(json!({ "url": url }), LONG, Ok(an_answer(200, &[], None)));
        assert!(told["error"].as_str().unwrap().contains(why), "{url}: {told}");
        assert!(seen.is_empty(), "{url}");
    }
    let mut net = |_: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> { panic!("nothing is sent") };
    let told = answer(&json!({ "url": at("https://SITE/api") }), &mut net, None, std::time::Instant::now() + LONG);
    assert_eq!(told["error"], "the run has no page");
}

/// The method is a word; what is not one is refused before anything is sent.
#[test]
fn a_method_that_is_not_a_word_is_refused() {
    for method in ["", "GET /x HTTP/1.1", "GE1", "ABCDEFGHIJKLMNOPQ"] {
        let (told, seen) = asked(json!({ "url": at("https://SITE/api"), "method": method }), LONG, Ok(an_answer(200, &[], None)));
        assert_eq!(told["error"], "not a method", "{method:?}");
        assert!(seen.is_empty());
    }
    let (_, seen) = asked(json!({ "url": at("https://SITE/api"), "method": "post" }), LONG, Ok(an_answer(200, &[], None)));
    assert_eq!(seen[0].method, "POST", "a method is written in capitals");
}

/// What the page sets on its request is checked as hostile input: a header the browser keeps, one whose name isn't a
/// token, one whose value breaks a line, and one past the length limits are dropped; the rest go as sent.
#[test]
fn a_request_the_page_makes_loses_every_header_a_browser_would_not_send() {
    let long_value = "v".repeat(9_000);
    let ask = json!({ "url": at("https://SITE/api"), "method": "POST", "body": "q=1", "headers": {
        "x-token": "t1", "Cookie": "sid=owner", "sec-fetch-mode": "cors", "proxy-authorization": "x", "Host": "evil.example",
        "bad name": "v", "": "v", "x-split": "a\r\nx-injected: 1", "x-nul": "a\u{0}b", "x-long": long_value } });
    let (told, seen) = asked(ask, LONG, Ok(an_answer(200, &[], Some("{}".into()))));
    assert_eq!(told["status"], 200);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].headers, vec![("x-token".to_string(), "t1".to_string())]);
    assert_eq!((seen[0].body.as_deref(), seen[0].exchange), (Some(&b"q=1"[..]), usize::MAX), "its body, and no step of any route");
}

/// A request body larger than the node sends for a page is refused and not sent.
#[test]
fn a_body_larger_than_the_node_sends_for_a_page_is_refused() {
    let (told, seen) = asked(json!({ "url": at("https://SITE/api"), "method": "POST", "body": "x".repeat(PAGE_BODY_MAX + 1) }), LONG, Ok(an_answer(200, &[], None)));
    assert_eq!(told["error"], "the page's request body is larger than the node sends for it");
    assert!(seen.is_empty());
    let (told, _) = asked(json!({ "url": at("https://SITE/api"), "method": "POST", "body": "x".repeat(PAGE_BODY_MAX) }), LONG, Ok(an_answer(201, &[], None)));
    assert_eq!(told["status"], 201, "a body at the limit is sent");
}

/// The page is handed the answer's status, its headers by lowercase name and its body, never the cookies the site set;
/// an answer larger than the page is handed, and a call the node couldn't make, are refusals.
#[test]
fn the_page_is_handed_the_answer_without_cookies_and_never_an_oversize_one() {
    let answered = an_answer(200, &[("Content-Type", "application/json"), ("Set-Cookie", "sid=s"), ("set-cookie2", "x=y"), ("X-Trace", "T1")], Some("{\"ok\":true}".into()));
    let (told, _) = asked(json!({ "url": at("https://SITE/api") }), LONG, Ok(answered));
    assert_eq!(told, json!({ "status": 200, "headers": [["content-type", "application/json"], ["x-trace", "T1"]], "body": "{\"ok\":true}" }));
    let (told, _) = asked(json!({ "url": at("https://SITE/api") }), LONG, Ok(an_answer(200, &[], None)));
    assert_eq!(told["body"], "", "no body is an empty one");
    let (told, _) = asked(json!({ "url": at("https://SITE/api") }), LONG, Ok(an_answer(200, &[], Some("x".repeat(crate::egress::FOREIGN_ANSWER_MAX + 1)))));
    assert_eq!(told["error"], "the answer is larger than the page is handed");
    assert_eq!(told["body"], "");
    let (told, _) = asked(json!({ "url": at("https://SITE/api") }), LONG, Err("the site refused".into()));
    assert_eq!((told["status"].clone(), told["error"].clone()), (json!(0), json!("the site refused")));
}

// ---- the conversation with a confined run: a shell script stands in for the run, saying what a run says ----

fn a_run(script: &str) -> std::process::Child {
    std::process::Command::new("sh").args(["-c", script]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().expect("sh")
}

fn limits(ready_ms: u64, wall_ms: u64) -> Limits {
    Limits { ready: std::time::Duration::from_millis(ready_ms), wall: std::time::Duration::from_millis(wall_ms), memory_mb: 1 << 20, said_bytes: 1 << 20 }
}

fn a_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("unbrowse-sandbox-cov-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A run that asks the node for a call when the node gave it no line is refused with that reason, by the id it asked
/// under, and the run's own answer is still read.
#[test]
fn a_run_with_no_line_to_the_node_is_refused_its_calls_and_still_answers() {
    let dir = a_dir("noline");
    let said = dir.join("said");
    let script = format!("echo '{{\"t\":\"ready\"}}'; echo '{{\"t\":\"other\"}}'; echo '{{\"t\":\"net\",\"id\":7,\"req\":{{\"url\":\"https://SITE/x\"}}}}'; read reply; echo \"$reply\" > '{}'; echo '{{\"t\":\"done\",\"out\":\"fin\"}}'", said.display());
    let mut child = a_run(&script);
    assert_eq!(converse(&mut child, None, None, limits(20_000, 20_000)), Some("fin".to_string()));
    let reply: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&said).unwrap()).unwrap();
    assert_eq!((reply["id"].clone(), reply["status"].clone(), reply["error"].clone()), (json!(7), json!(0), json!("this run has no line to the node")));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A run that makes more calls than a page makes in one is refused the rest, with the count said.
#[test]
fn a_run_that_calls_past_the_most_a_page_makes_is_refused_the_rest() {
    let dir = a_dir("calls");
    let said = dir.join("said");
    let script = format!("echo '{{\"t\":\"ready\"}}'; i=0; while [ $i -lt {} ]; do echo '{{\"t\":\"net\",\"id\":1,\"req\":{{\"url\":\"nothing\"}}}}'; read reply; i=$((i+1)); done; echo \"$reply\" > '{}'; echo '{{\"t\":\"done\",\"out\":\"fin\"}}'", PAGE_CALLS_MAX + 1, said.display());
    let mut child = a_run(&script);
    let mut seen = 0usize;
    let mut net = |_: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
        seen += 1;
        Err("never reached".into())
    };
    let page = the_page();
    assert_eq!(converse(&mut child, Some(&mut net), Some(&page), limits(20_000, 20_000)), Some("fin".to_string()));
    assert_eq!(seen, 0, "every call here is refused before it is made");
    let reply: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&said).unwrap()).unwrap();
    assert_eq!(reply["error"], format!("the page made more than {PAGE_CALLS_MAX} calls in one run"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A run that never says it is ready, one that says what is no line of JSON, one that holds more memory than it may,
/// and one that closes its end and keeps talking, give no answer to be used (and are not waited on past their time).
#[test]
fn a_run_that_is_late_garbled_or_too_large_gives_no_answer() {
    let started = std::time::Instant::now();
    assert_eq!(converse(&mut a_run("exec sleep 30"), None, None, limits(150, 20_000)), None, "no ready in time");
    assert!(started.elapsed() < std::time::Duration::from_secs(20), "the run was cut at its time");
    assert_eq!(converse(&mut a_run("echo '{\"t\":\"ready\"}'; sleep 1; echo 'this is not json'"), None, None, limits(20_000, 20_000)), None, "a line that is no JSON ends the run");
    assert_eq!(converse(&mut a_run("echo '{\"t\":\"ready\"}'; exec sleep 30"), None, None, limits(20_000, 200)), None, "no answer inside the time once started");
    let heavy = Limits { memory_mb: 0, ..limits(20_000, 20_000) };
    assert_eq!(converse(&mut a_run("echo '{\"t\":\"ready\"}'; exec sleep 30"), None, None, heavy), None, "a run past its memory is cut");
    // A run that stops listening: the node's replies go nowhere, and its answer after them is still read.
    let script = "echo '{\"t\":\"ready\"}'; exec 0<&-; echo '{\"t\":\"net\",\"id\":1,\"req\":{}}'; sleep 0.3; echo '{\"t\":\"net\",\"id\":2,\"req\":{}}'; echo '{\"t\":\"done\",\"out\":\"fin\"}'";
    assert_eq!(converse(&mut a_run(script), None, None, limits(20_000, 20_000)), Some("fin".to_string()));
}

/// A run that says more than it may in all is cut, down to the last byte, and what it said by then is not an answer.
#[test]
fn a_run_that_says_more_than_it_may_is_cut_down_to_the_byte() {
    let script = "echo '{\"t\":\"ready\"}'; echo '{\"t\":\"done\",\"out\":\"x\"}'";
    // The two lines are 14 and 23 bytes with their line ends.
    assert_eq!(converse(&mut a_run(script), None, None, Limits { said_bytes: 37, ..limits(20_000, 20_000) }), Some("x".to_string()), "what is said is just what it may");
    assert_eq!(converse(&mut a_run(script), None, None, Limits { said_bytes: 36, ..limits(20_000, 20_000) }), None, "one byte more than it may");
    let long = "echo '{\"t\":\"ready\"}'; echo '{\"t\":\"other\",\"pad\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}'; echo '{\"t\":\"done\",\"out\":\"x\"}'";
    assert_eq!(converse(&mut a_run(long), None, None, Limits { said_bytes: 64, ..limits(20_000, 20_000) }), None, "a line past what is left of it");
}

// ---- the node's own helpers and the page's scripts, run in the confined runtime ----

/// A helper the node runs on adversarial input is answered by what it wrote, and is cut when it runs past its time
/// or fails.
#[test]
fn a_helper_is_answered_by_what_it_wrote_and_cut_when_it_runs_over_or_fails() {
    if !available() {
        eprintln!("no signing runtime on this machine: the sandbox is skipped");
        return;
    }
    let wall = std::time::Duration::from_secs(20);
    assert_eq!(run_helper("cov", &[("h.js", b"process.stdout.write('hello')")], "h.js", &[], wall), Some(b"hello".to_vec()));
    assert_eq!(run_helper("cov", &[("h.js", b"process.exit(3)")], "h.js", &[], wall), None, "a helper that fails gives no answer");
    let started = std::time::Instant::now();
    assert_eq!(run_helper("cov", &[("h.js", b"while (true) {}")], "h.js", &[], std::time::Duration::from_millis(400)), None, "a helper that never ends is cut");
    assert!(started.elapsed() < std::time::Duration::from_secs(15), "cut at its time: {:?}", started.elapsed());
}

/// The page's own code signs the call it makes (`sign`), and a global it leaves behind is read after the boot
/// (`read_global`): present when the page set it, absent when it never did.
#[test]
fn the_pages_signed_call_and_the_global_it_leaves_behind_are_read_back() {
    if !available() {
        eprintln!("no signing runtime on this machine: the sandbox is skipped");
        return;
    }
    let bundle: Bundle = vec![(at(&format!("https://{}.SITE/app.js", "cdn")), "window.__proof = 'p-' + (location.search || '?').slice(1); fetch('/api/find', { method: 'POST', headers: { 'x-sig': window.__proof }, body: '{}' });".into())];
    let asked = Request { method: "POST".into(), url: at("https://SITE/api/find").parse().unwrap(), exchange: 0, headers: vec![], body: Some(b"{}".to_vec()) };
    let signed = sign(&bundle, &at("https://SITE/page?q=1"), &asked, "", &Storage::default(), "", &serde_json::Value::Null, &[], None).expect("the page's signed call");
    assert_eq!(signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-sig")).map(|(_, v)| v.as_str()), Some("p-q=1"));
    assert!(sign(&bundle, &at("https://SITE/page?q=1"), &Request { url: at("https://SITE/api/other").parse().unwrap(), ..asked.clone() }, "", &Storage::default(), "", &serde_json::Value::Null, &[], None).is_none(), "no call at that address");
    let read = read_global("__proof", &bundle, &at("https://SITE/page?q=2"), "", &Storage::default(), "", &serde_json::Value::Null, &[], None);
    assert_eq!(read.as_deref(), Some("p-q=2"));
    assert_eq!(read_global("__never_set", &bundle, &at("https://SITE/page"), "", &Storage::default(), "", &serde_json::Value::Null, &[], None), None);
}

/// A run that says a line that is no JSON, then more lines than the channel holds, leaves
/// `converse` waiting forever: the reader is blocked sending into a full channel, and `converse` joins it before the
/// receiving end is dropped.
#[test]
fn a_run_that_garbles_a_line_and_keeps_talking_does_not_hold_the_call_for_ever() {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let script = "echo '{\"t\":\"ready\"}'; echo 'this is not json'; echo '{\"t\":\"other\"}'; echo '{\"t\":\"other\"}'; echo '{\"t\":\"other\"}'";
        let _ = tx.send(converse(&mut a_run(script), None, None, limits(20_000, 20_000)));
    });
    let got = rx.recv_timeout(std::time::Duration::from_secs(15)).expect("converse returned");
    assert_eq!(got, None);
}
