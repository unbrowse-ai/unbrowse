//! The browser program as a script (UNB-208): `answered_on_page` and `execute` run against it, so what the node asks
//! the browser, and what it makes of the answers, is checked without a Chrome.
use super::*;
use std::os::unix::fs::PermissionsExt;

/// A program that logs every command line and answers by the first `(pattern, answer)` whose pattern the line contains.
fn scripted(dir: &std::path::Path, cases: &[(&str, &str)]) -> (String, std::path::PathBuf) {
    std::fs::create_dir_all(dir).unwrap();
    let (program, log) = (dir.join("program"), dir.join("said.log"));
    let mut sh = format!("#!/bin/sh\necho \"$*\" >> '{}'\ncase \"$*\" in\n", log.display());
    for (i, (pattern, answer)) in cases.iter().enumerate() {
        let file = dir.join(format!("answer{i}"));
        std::fs::write(&file, answer).unwrap();
        sh.push_str(&format!("  *'{pattern}'*) cat '{}' ;;\n", file.display()));
    }
    sh.push_str("esac\n");
    std::fs::write(&program, sh).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    (program.to_string_lossy().into_owned(), log)
}

fn a_mint(browser: String, dir: &std::path::Path) -> BrowserMint {
    BrowserMint { browser, session: "learn_cov".into(), capture_dir: dir.join("capture"), _host: "site.example".into(), user_agent: None, cdp_endpoint: None, profile: None, try_controls: false, frames: None, seed: Vec::new() }
}

fn a_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("unbrowse-mint-cov-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn a_page() -> String {
    format!("<html><head><title>Lamps</title></head><body><p>{}</p></body></html>", "a lamp for the desk ".repeat(200))
}

fn a_request(method: &str, headers: &[(&str, &str)], body: Option<Vec<u8>>) -> crate::replay::Request {
    crate::replay::Request { method: method.into(), url: "https://shop.example/search?q=lamp".parse().unwrap(), exchange: 0, headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body }
}

const LISTED: &str = r#"{"success":true,"data":{"requests":[
  {"requestId":"r1","method":"POST","url":"https://shop.example/api","status":200,"postData":"{\"op\":\"search\"}","mimeType":"application/json"},
  {"requestId":"r2","method":"POST","url":"https://shop.example/api","status":500,"postData":"{\"op\":\"search\"}"},
  {"requestId":"r3","method":"POST","url":"https://shop.example/api","status":200,"postData":"{\"op\":\"cart\"}"},
  {"requestId":"r4","method":"GET","url":"https://shop.example/img.png","status":200}]}}"#;

/// The page's own answer is the last call it made that the caller names and the site answered 2xx: not a newer one the
/// site refused, and not one for another operation at the same address.
#[test]
fn the_answer_the_page_got_is_its_last_call_the_site_accepted_that_the_caller_named() {
    let dir = a_dir("answered");
    let (program, log) = scripted(&dir, &[("network request r1", r#"{"data":{"responseBody":"{\"hits\":3}"}}"#), ("network requests", LISTED)]);
    let mint = a_mint(program, &dir);
    let got = mint.answered_on_page(&|m, u, b| m == "POST" && u.ends_with("/api") && b.is_some_and(|b| b.contains("search"))).expect("the page's answer");
    assert_eq!((got.status, got.response_body.as_deref(), got.response_mime.as_str()), (200, Some("{\"hits\":3}"), "application/json"));
    assert_eq!(got.url.as_str(), "https://shop.example/api");
    assert!(std::fs::read_to_string(&log).unwrap().contains("network request r1"), "the body is asked for by the call's id");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A page that made no call the caller names, or whose answer the browser holds only as bytes, gave no text answer.
#[test]
fn a_page_with_no_such_call_or_only_bytes_for_one_gave_no_answer() {
    let dir = a_dir("answered-none");
    let (program, _) = scripted(&dir, &[("network request r1", r#"{"data":{"responseBody":"[base64, AAAA]"}}"#), ("network requests", LISTED)]);
    let mint = a_mint(program, &dir);
    assert!(mint.answered_on_page(&|_, u, _| u.ends_with("/nothing")).is_none(), "no call named");
    assert!(mint.answered_on_page(&|m, u, b| m == "POST" && u.ends_with("/api") && b.is_some_and(|b| b.contains("search"))).is_none(), "bytes are not text");
    let (program, _) = scripted(&dir, &[("network request r1", r#"{"data":{"responseBody":""}}"#), ("network requests", LISTED)]);
    assert!(a_mint(program, &dir).answered_on_page(&|m, _, b| m == "POST" && b.is_some_and(|b| b.contains("search"))).is_none(), "an empty body is no answer");
    let (program, _) = scripted(&dir, &[("network requests", "the program said nothing in JSON")]);
    assert!(a_mint(program, &dir).answered_on_page(&|_, _, _| true).is_none(), "an unreadable list is no answer");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A step that is a page is run by going to it: the page the browser lands on is the exchange, with the cookies the
/// browser holds for the host as its Set-Cookie headers. From a cold browser it is closed first; where the browser
/// already stands on the site, the page is opened as it is.
#[test]
fn a_step_that_is_a_page_is_answered_by_the_page_the_browser_lands_on() {
    let dir = a_dir("navigate");
    let html = a_page();
    let cookies = r#"{"success":true,"data":{"cookies":[{"name":"sid","value":"s9","domain":"shop.example"},{"name":"ad","value":"x","domain":".ads.example"}]}}"#;
    let page = serde_json::to_string(&html).unwrap();
    let (program, log) = scripted(&dir, &[("cookies get", cookies), ("outerHTML", &page)]);
    let mut mint = a_mint(program, &dir);
    let got = mint.execute(&a_request("GET", &[("Sec-Fetch-Mode", "navigate")], None)).expect("the page");
    assert_eq!((got.status, got.resource_type.as_deref(), got.main_frame, got.response_mime.as_str()), (200, Some("Document"), Some(true), "text/html"));
    assert_eq!(got.url.as_str(), "https://shop.example/search?q=lamp", "where the browser says nothing of, the asked address");
    assert_eq!(got.response_body.as_deref(), Some(html.as_str()));
    assert_eq!(got.response_headers, vec![("set-cookie".to_string(), "sid=s9; Path=/".to_string())], "this host's cookie, not another site's");
    let said = std::fs::read_to_string(&log).unwrap();
    assert!(said.contains("open https://shop.example/search?q=lamp"), "{said}");
    assert!(said.lines().any(|l| l.ends_with(" close")), "a cold page starts from a closed browser: {said}");
    let _ = std::fs::remove_dir_all(&dir);

    let dir = a_dir("navigate-warm");
    let (program, log) = scripted(&dir, &[("cookies get", cookies), ("outerHTML", &page), ("get url", "https://shop.example/landed\n")]);
    let got = a_mint(program, &dir).execute(&a_request("GET", &[("Sec-Fetch-Mode", "navigate")], None)).expect("the page");
    assert_eq!(got.url.as_str(), "https://shop.example/landed", "where the browser stands after");
    let said = std::fs::read_to_string(&log).unwrap();
    assert!(!said.lines().any(|l| l.ends_with(" close")), "a warm browser is kept: {said}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A door that never gives way ends the call, and the browser the call opened is closed with it.
#[test]
fn a_door_that_never_gives_way_ends_the_call_and_closes_its_browser() {
    let dir = a_dir("door");
    let door = "<html><head><title>One moment</title><script src=/check.js></script></head><body><p>Checking your browser.</p></body></html>";
    let (program, log) = scripted(&dir, &[("outerHTML", &serde_json::to_string(door).unwrap())]);
    let mut mint = a_mint(program, &dir);
    let err = mint.execute(&a_request("GET", &[("sec-fetch-dest", "document")], None)).expect_err("the door held");
    assert!(err.to_string().contains("kept challenging"), "{err}");
    let said = std::fs::read_to_string(&log).unwrap();
    assert!(said.lines().filter(|l| l.ends_with(" close")).count() >= 2, "opened closed, and closed again on failing: {said}");
    let _ = std::fs::remove_dir_all(&dir);
    // The same door met by a call that is a script's: the origin is tried four times, then the call fails.
    let dir = a_dir("door-fetch");
    let (program, log) = scripted(&dir, &[("outerHTML", &serde_json::to_string(door).unwrap())]);
    let err = a_mint(program, &dir).execute(&a_request("GET", &[], None)).expect_err("the door held");
    assert!(err.to_string().contains("kept challenging"), "{err}");
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().filter(|l| l.contains(" open https://shop.example/")).count(), 4);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A call a script made is fetched from the page the browser holds open on the site: what the fetch answered, where it
/// landed, and the cookies it set (and the jar's others) come back as the exchange.
#[test]
fn a_script_call_is_fetched_in_the_warm_page_and_answered_as_the_site_did() {
    let dir = a_dir("fetch");
    let page = serde_json::to_string(&a_page()).unwrap();
    let fetched = serde_json::to_string(&r#"[201,"application/json",["a=b","c=d"],"{\"ok\":1}","https://shop.example/final"]"#).unwrap();
    let cookies = r#"{"data":{"cookies":[{"name":"a","value":"b","domain":"shop.example"},{"name":"jar","value":"j","domain":"shop.example"}]}}"#;
    let (program, log) = scripted(&dir, &[("cookies get", cookies), ("fetch(", &fetched), ("outerHTML", &page), ("get url", "https://shop.example/home")]);
    let mut mint = a_mint(program, &dir);
    let got = mint.execute(&a_request("POST", &[("x-sig", "s1")], Some(b"q=lamp".to_vec()))).expect("the fetch");
    assert_eq!((got.status, got.response_mime.as_str(), got.response_body.as_deref()), (201, "application/json", Some("{\"ok\":1}")));
    assert_eq!(got.url.as_str(), "https://shop.example/final", "where the fetch landed");
    let sets: Vec<&str> = got.response_headers.iter().map(|(_, v)| v.as_str()).collect();
    assert_eq!(sets, ["a=b; Path=/", "c=d; Path=/", "jar=j; Path=/"], "its own cookies, then a jar cookie it didn't re-issue, none twice");
    let said = std::fs::read_to_string(&log).unwrap();
    assert!(said.contains("\"x-sig\":\"s1\"") && said.contains("\"q=lamp\""), "the call's header and body ride in the page's fetch: {said}");
    assert!(!said.lines().any(|l| l.ends_with(" close")), "a warm page is kept: {said}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A file's bytes can't go through a page's script, and a fetch answer the browser garbled is no exchange.
#[test]
fn an_upload_is_not_sent_from_a_page_and_a_garbled_fetch_answer_is_an_error() {
    let dir = a_dir("fetch-bad");
    let page = serde_json::to_string(&a_page()).unwrap();
    let (program, _) = scripted(&dir, &[("fetch(", "this is not the array"), ("outerHTML", &page), ("get url", "https://shop.example/home")]);
    let mut mint = a_mint(program, &dir);
    let err = mint.execute(&a_request("POST", &[], Some(vec![0xff, 0xfe, 0x00]))).expect_err("bytes");
    assert!(err.to_string().contains("upload"), "{err}");
    let err = mint.execute(&a_request("POST", &[], Some(b"x=1".to_vec()))).expect_err("garbled");
    assert!(err.to_string().contains("fetch result"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}
