//! Session state: what the door mints and what the log records.
//!
//! The shape both consumers share: a minted session (the values a browser walk
//! hands to plain HTTP) and the passive capture's lines (what route learning
//! reads). With these in core, the node stops parsing the same files with its
//! own structs and the CLI stops inventing its own.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::capture::{now_secs, CaptureLog};

/// What a browser walk hands to the next caller: cookies and derived tokens.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MintedSession {
    /// Cookie name -> value.
    pub cookies: HashMap<String, String>,
    /// Non-cookie session values a walk issues (headers, tokens).
    pub tokens: HashMap<String, String>,
    /// Cookie name -> the `Domain` the site set it for, as DevTools reports it (with the leading dot): how far down
    /// the site that cookie goes, so a caller sends it where this browser would. A cookie with no entry here was set
    /// for the walked host alone (host-only), and goes to that host and nowhere else.
    #[serde(default)]
    pub domains: HashMap<String, String>,
    /// The page's `localStorage`, name -> value, as the walk left it: where a page's own code keeps a signing key, a
    /// nonce it made up, or a flag it reads on the next visit. A signing bridge that boots the page's scripts again
    /// needs what the page had in front of it.
    #[serde(default)]
    pub local_storage: HashMap<String, String>,
    /// The page's `sessionStorage`, the same way.
    #[serde(default)]
    pub session_storage: HashMap<String, String>,
    /// What the page's own code saw when it fingerprinted the browser: canvas output, WebGL parameters, screen and
    /// navigator fields, timezone. A signing bridge puts this in front of the page's scripts, so a producer that
    /// samples the environment computes the values the browser did, not a generic shim's.
    #[serde(default)]
    pub fingerprint: Option<serde_json::Value>,
    /// Cookie name -> what the browser knew of it beyond its value and domain: the path it goes to and whether a page's
    /// script may read it. A cookie with no entry here is one whose path and script access weren't seen: a caller sends
    /// it as a root-path cookie and never shows it to a page's script.
    #[serde(default)]
    pub facts: HashMap<String, CookieFacts>,
    /// The walk's browser was asked what it holds and `cookies` is its answer: a cookie it doesn't name is one it doesn't
    /// hold, so a caller takes out what its jar held under such a name, even when the browser holds nothing at all.
    #[serde(default)]
    pub judged: bool,
    /// The browser's own answer when asked which cookies it holds (`Network.getAllCookies`), as it gave it: a caller
    /// reads the session's cookies from this, one per name with each one's own reach and facts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_answer: Option<serde_json::Value>,
}

/// What a browser knows of a cookie beyond its value: the path it is sent to and whether it is HttpOnly (sent with
/// requests, never shown to a page's script).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CookieFacts {
    pub path: String,
    pub http_only: bool,
    /// When it runs out, in Unix seconds; None for a cookie that lives as long as its session.
    #[serde(default)]
    pub expires: Option<f64>,
}

impl MintedSession {
    /// Every value the session carries, cookies and tokens alike.
    pub fn values(&self) -> impl Iterator<Item = (&String, &String)> {
        self.cookies.iter().chain(self.tokens.iter())
    }

    /// Merge another session's values over this one.
    pub fn absorb(&mut self, other: MintedSession) {
        // Each cookie comes with its own line's reach and facts, or none: a value never keeps what an older value of the
        // name had.
        for name in other.cookies.keys() {
            match other.domains.get(name) {
                Some(d) => self.domains.insert(name.clone(), d.clone()),
                None => self.domains.remove(name),
            };
            match other.facts.get(name) {
                Some(f) => self.facts.insert(name.clone(), f.clone()),
                None => self.facts.remove(name),
            };
        }
        self.cookies.extend(other.cookies);
        self.tokens.extend(other.tokens);
        self.local_storage.extend(other.local_storage);
        self.session_storage.extend(other.session_storage);
    }
}

/// The session's capture log: one JSON value per line.
pub fn read_capture(path: &Path) -> Vec<serde_json::Value> {
    let Ok(file) = File::open(path) else { return Vec::new() };
    BufReader::new(file)
        .lines()
        .filter_map(|l| l.ok())
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// The capture log for a session inside a capture directory.
pub fn capture_path(dir: &Path, session: &str) -> std::path::PathBuf {
    let name: String = session
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    dir.join(format!("{name}.jsonl"))
}

#[cfg(test)]
mod tests {
    // mint() is exercised through the CLI paths; the unit surface is the
    // session shape and the capture reader.
    use super::*;

    /// A reply the page's script read whose bytes are no text is kept as those bytes, in base64, and the HAR says so;
    /// bytes nobody's script read (an image) are kept as before, which is not at all, and so are bytes past the cap.
    /// A line from before carries no encoding and reads as it did.
    #[test]
    fn a_binary_reply_the_pages_script_read_is_kept_as_its_bytes() {
        use base64::Engine;
        let packed = base64::engine::general_purpose::STANDARD.encode([0x81u8, 0xa1, b'q', 0xa6, b'k', b'e', b't', b't', b'l', b'e']);
        let fetched = serde_json::json!({ "mimeType": "application/x-msgpack", "url": "https://x.example/api", "status": 200, "_resourceType": "Fetch" });
        let image = serde_json::json!({ "mimeType": "image/png", "_resourceType": "Image" });
        assert!(read_by_script(&fetched) && !read_by_script(&image));
        let kept = bytes_kept(&packed, read_by_script(&fetched));
        assert_eq!(kept, Body { text: packed.clone(), base64: true });
        assert_eq!(bytes_kept(&packed, read_by_script(&image)), Body::default());
        let line = body_line("1", &fetched, &kept);
        assert_eq!((line["body"].as_str(), line["encoding"].as_str()), (Some(packed.as_str()), Some("base64")));
        let past = "A".repeat((BYTES_BODY_CAP / 3 + 2) * 4);
        assert_eq!(bytes_kept(&past, true), Body::default(), "bytes past the cap are kept as no body");
        // A request's body of bytes is kept as its bytes, from the parts Chrome gives, and one of text as its text.
        let posted = serde_json::json!({ "postData": "\u{fffd}\u{fffd}", "postDataEntries": [{ "bytes": base64::engine::general_purpose::STANDARD.encode([0x0a, 0x80, 0x01]) }] });
        assert_eq!(post_data(&posted), (serde_json::json!(base64::engine::general_purpose::STANDARD.encode([0x0a, 0x80, 0x01])), serde_json::json!("base64")));
        let typed = serde_json::json!({ "postData": "{}", "postDataEntries": [{ "bytes": base64::engine::general_purpose::STANDARD.encode(b"{}") }] });
        assert_eq!(post_data(&typed), (serde_json::json!("{}"), serde_json::Value::Null));
        assert_eq!(post_data(&serde_json::json!({ "postData": "a=1" })), (serde_json::json!("a=1"), serde_json::Value::Null), "a request from before reads as it did");
        let text = body_line("2", &fetched, &Body { text: "{}".into(), base64: false });
        assert!(text.get("encoding").is_none());
        // The HAR the node reads says the body is base64, and a line from before says nothing.
        let dir = std::env::temp_dir().join(format!("core-bytes-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            serde_json::json!({"type": "request", "requestId": "1", "method": "GET", "url": "https://x.example/api", "headers": {}}),
            line,
            serde_json::json!({"type": "request", "requestId": "2", "method": "GET", "url": "https://x.example/old", "headers": {}}),
            serde_json::json!({"type": "response", "requestId": "2", "url": "https://x.example/old", "status": 200, "mimeType": "application/json", "headers": {}, "body": "{}"}),
        ];
        std::fs::write(capture_path(&dir, "b"), lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
        let har = walk_har(&dir, "b");
        let entries = har["log"]["entries"].as_array().unwrap();
        assert_eq!(entries[0]["response"]["content"]["encoding"], "base64");
        assert_eq!(entries[0]["response"]["content"]["text"], packed.as_str());
        assert!(entries[1]["response"]["content"].get("encoding").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A JSON answer past a megabyte (a search API's page of results) is kept whole, so it still parses; a script that
    /// size is still cut, and a page keeps its own larger allowance.
    #[test]
    fn a_large_json_answer_is_kept_whole() {
        let big = serde_json::json!({ "results": (0..60_000).map(|i| serde_json::json!({ "id": i, "title": format!("item {i}") })).collect::<Vec<_>>() }).to_string();
        assert!(big.len() > BODY_CAP);
        let line = response_line("1", &serde_json::json!({ "mimeType": "application/json", "url": "https://x.example/api", "status": 200 }), &big);
        assert!(serde_json::from_str::<serde_json::Value>(line["body"].as_str().unwrap()).is_ok(), "the answer parses");
        let script = format!("(function () {{ var d = {big}; }})();");
        let js = response_line("2", &serde_json::json!({ "mimeType": "application/javascript" }), &script);
        assert_eq!(js["body"].as_str().unwrap().chars().count(), BODY_CAP);
    }

    /// A walk whose settle time is up waits on while the page is plainly still asking: a call that sends what its
    /// address was asked and has no answer yet, an answer still arriving, a script not yet arrived, and a moment after
    /// each ends. Another call on its way holds it a short while, as before, and nothing open ends it.
    #[test]
    fn a_walk_waits_while_the_page_is_still_asking() {
        let sent = |id: &str, kind: &str, url: &str| serde_json::json!({"method": "Network.requestWillBeSent", "params": {"requestId": id, "type": kind, "request": {"url": url}}});
        let said = |method: &str, id: &str| serde_json::json!({"method": method, "params": {"requestId": id}});
        const PAGE: &str = "https://air.example/flights/showfarefirst?dcity=bjs&acity=sin&n=2";
        let asked = asked_of(PAGE);
        assert!(asked.contains(&"bjs".to_string()) && !asked.contains(&"2".to_string()), "{asked:?}");
        let (secs, t0) = (std::time::Duration::from_secs, tokio::time::Instant::now());
        let mut open = Open::default();
        assert!(!open.holds(secs(0), t0), "nothing open");
        // An ad's call, on its way: a short while.
        open.note(&sent("ad", "XHR", "https://ads.example/bid?slot=top"), PAGE, &asked, t0);
        assert!(open.holds(secs(4), t0) && !open.holds(secs(6), t0));
        // The page asking for its answer: longer, and through the answer's arriving.
        let body = serde_json::json!({"method": "Network.requestWillBeSent", "params": {"requestId": "list", "type": "Fetch", "request": {"url": "https://air.example/api/FlightListSearch", "postData": "{\"dcity\":\"BJS\"}"}}});
        open.note(&body, PAGE, &asked, t0);
        assert!(open.holds(secs(12), t0));
        open.note(&said("Network.responseReceived", "list"), PAGE, &asked, t0);
        assert!(open.holds(secs(20), t0) && !open.holds(secs(26), t0), "bounded");
        open.note(&said("Network.loadingFinished", "list"), PAGE, &asked, t0);
        open.note(&said("Network.loadingFailed", "ad"), PAGE, &asked, t0);
        assert!(open.holds(secs(12), t0), "a moment for the page to act on its answer");
        assert!(!open.holds(secs(14), t0 + secs(2)), "then the page has been answered");
        // A script still arriving: the page has not asked yet. One that never arrives is not waited for long, and one
        // the page made itself is not waited for at all.
        open.note(&sent("app", "Script", "https://cdn.example/app.js"), PAGE, &asked, t0);
        open.note(&sent("made", "Script", "blob:https://air.example/3857b677"), PAGE, &asked, t0);
        assert!(open.holds(secs(7), t0 + secs(2)) && !open.holds(secs(9), t0 + secs(2)));
        // A report of the page carries what it was asked, inside its address: it is not the page asking.
        let mut report = Open::default();
        report.note(&sent("err", "Fetch", "https://errors.example/envelope?page=https%3A%2F%2Fair.example%2Fflights%2Fshowfarefirst%3Fdcity%3Dbjs%26acity%3Dsin%26n%3D2"), PAGE, &asked, t0);
        assert!(!report.holds(secs(6), t0));
        // A stream that has begun holds whatever it carries; a call that has not begun and carries nothing does not.
        let mut other = Open::default();
        other.note(&sent("feed", "Fetch", "https://air.example/api/feed"), PAGE, &asked, t0);
        assert!(!other.holds(secs(6), t0));
        other.note(&said("Network.responseReceived", "feed"), PAGE, &asked, t0);
        assert!(other.holds(secs(6), t0));
        assert!(carries_what_was_asked("https://air.example/s?q=tiny%20house", &["tiny house".to_string()]));
    }

    /// A nudge the page answers with nothing, in any of its contexts, ends the walk's browsing; one it answers with a
    /// call, a script or a new document does not, nor does one whose answer is still arriving or just arrived. What the
    /// page fetches to show (an image) is not the page reading on, and what the browser's own pages ask is not the page.
    #[test]
    fn a_nudge_the_page_does_nothing_with_ends_the_browsing() {
        let sent = |id: &str, kind: &str, url: &str, doc: &str| serde_json::json!({"method": "Network.requestWillBeSent", "params": {"requestId": id, "type": kind, "documentURL": doc, "request": {"url": url}}});
        let said = |method: &str, id: &str| serde_json::json!({"method": method, "params": {"requestId": id}});
        const PAGE: &str = "https://shop.example/search/?q=router";
        let (asked, t0, ms) = (asked_of(PAGE), tokio::time::Instant::now(), std::time::Duration::from_millis);
        let mut open = Open::default();
        open.note(&sent("list", "Fetch", "https://shop.example/api/search?q=router", PAGE), PAGE, &asked, t0);
        open.note(&said("Network.loadingFinished", "list"), PAGE, &asked, t0 + ms(200));
        let nudged = t0 + ms(1500);
        assert!(open.did_nothing_since(nudged, nudged + ms(1500)), "the page was answered before the nudge and sent nothing after");
        open.note(&sent("img", "Image", "https://img.example/a.jpg", PAGE), PAGE, &asked, nudged + ms(100));
        open.note(&sent("bar", "XHR", "https://bar.example/rpc", "chrome://new-tab-page/"), PAGE, &asked, nudged + ms(100));
        assert!(open.did_nothing_since(nudged, nudged + ms(1500)), "an image, and the browser's own page, are not the page reading on");
        let mut worker = open.clone();
        worker.note(&sent("w:more", "Fetch", "https://shop.example/api/search?q=router&page=2", PAGE), PAGE, &asked, nudged + ms(300));
        assert!(!worker.did_nothing_since(nudged, nudged + ms(1500)), "a call after the nudge: the page read on");
        worker.note(&said("Network.loadingFinished", "w:more"), PAGE, &asked, nudged + ms(1400));
        assert!(!worker.did_nothing_since(nudged + ms(1500), nudged + ms(1600)), "just answered: the page is acting on it");
        assert!(worker.did_nothing_since(nudged + ms(1500), nudged + ms(3000)), "the next nudge brought nothing");
        let mut script = open.clone();
        script.note(&sent("chunk", "Script", "https://shop.example/chunk.js", PAGE), PAGE, &asked, nudged + ms(100));
        assert!(!script.did_nothing_since(nudged, nudged + ms(1500)), "a script still arriving");
    }

    /// What the browser's own pages ask for (its new-tab page's bar: a call and a script that never come back) never
    /// holds the walk past its settle time; the same requests made by the walked page do.
    #[test]
    fn the_browsers_own_pages_never_hold_the_walk() {
        let sent = |id: &str, kind: &str, url: &str, doc: &str| serde_json::json!({"method": "Network.requestWillBeSent", "params": {"requestId": id, "type": kind, "documentURL": doc, "request": {"url": url}}});
        const PAGE: &str = "https://shop.example/search/?q=router";
        let (asked, t0) = (asked_of(PAGE), tokio::time::Instant::now());
        let past = std::time::Duration::from_secs(1);
        let mut open = Open::default();
        open.note(&sent("bar", "XHR", "https://bar.example/rpc/GetData", "chrome-untrusted://new-tab-page/one-google-bar"), PAGE, &asked, t0);
        open.note(&sent("og", "Script", "https://static.example/og.js", "chrome://new-tab-page/"), PAGE, &asked, t0);
        assert!(!open.holds(past, t0), "the browser's own page asked: the walk does not wait");
        open.note(&sent("x", "XHR", "https://bar.example/rpc/GetData", PAGE), PAGE, &asked, t0);
        assert!(open.holds(past, t0), "the walked page asked: it waits, as before");
    }

    /// A request the page's code made is kept with the stack that made it: the frames at the send, innermost first,
    /// then the frames that scheduled it. Code with no address names no script, and a request the parser made has
    /// no stack at all.
    #[test]
    fn a_request_says_where_in_the_pages_code_it_was_sent() {
        let event = serde_json::json!({"method": "Network.requestWillBeSent", "params": {"initiator": {"type": "script", "stack": {
            "callFrames": [
                {"functionName": "send", "url": "https://cdn.example/http.js", "lineNumber": 0, "columnNumber": 4812},
                {"functionName": "", "url": "", "lineNumber": 3, "columnNumber": 1},
                {"functionName": "search", "url": "https://cdn.example/app.js", "lineNumber": 12, "columnNumber": 40},
            ],
            "parent": {"description": "await", "callFrames": [{"functionName": "onSubmit", "url": "https://cdn.example/app.js", "lineNumber": 80, "columnNumber": 2}]},
        }}}});
        let frames = sent_by(&event);
        let said: Vec<(&str, u64, u64)> = frames.iter().map(|f| (f["function"].as_str().unwrap(), f["line"].as_u64().unwrap(), f["column"].as_u64().unwrap())).collect();
        assert_eq!(said, vec![("send", 0, 4812), ("search", 12, 40), ("onSubmit", 80, 2)]);
        assert_eq!(frames[0]["url"], "https://cdn.example/http.js");
        let parsed = serde_json::json!({"method": "Network.requestWillBeSent", "params": {"initiator": {"type": "parser", "url": "https://shop.example/"}}});
        assert!(sent_by(&parsed).is_empty());
    }

    /// Data is data under any type: a stream's one long event, JSON behind a guard and JSON inside a callback are kept
    /// whole like a JSON answer, since each cut short parses as nothing.
    #[test]
    fn an_answer_is_kept_whole_whatever_type_it_is_sent_as() {
        let big = serde_json::json!({ "results": (0..60_000).map(|i| serde_json::json!({ "id": i, "title": format!("item {i}") })).collect::<Vec<_>>() }).to_string();
        assert!(big.len() > BODY_CAP);
        for (mime, body) in [
            ("text/event-stream", format!("data:{big}\n\n")),
            ("text/plain", format!("data: {big}\n\n")),
            ("text/javascript", format!(")]}}'\n{big}")),
            ("application/javascript", format!("cb7({big});")),
            ("text/plain", big.clone()),
        ] {
            let line = response_line("1", &serde_json::json!({ "mimeType": mime, "url": "https://x.example/api?callback=cb7", "status": 200 }), &body);
            assert_eq!(line["body"].as_str().unwrap().len(), body.len(), "{mime}: kept whole");
        }
    }

    #[test]
    fn a_cookie_rides_only_to_the_host_it_was_set_for() {
        assert!(sent_to(".shop.example", "www.shop.example"));
        assert!(sent_to("shop.example", "shop.example"));
        assert!(sent_to("www.shop.example", "www.shop.example"));
        assert!(!sent_to(".ads.example", "www.shop.example"));
        assert!(!sent_to("api.shop.example", "www.shop.example"));
        assert!(!sent_to("op.example", "www.shop.example"));
        assert!(!sent_to("", "www.shop.example"));
    }

    #[test]
    fn a_header_token_is_harvested_only_from_calls_to_the_walked_host() {
        let t = |n: &str, v: &str, h: &str| (n.to_string(), v.to_string(), h.to_string());
        let tokens = vec![
            t("x-csrf-token", "OURS", "www.a.test"),
            t("x-xsrf-token", "API", "api.a.test"),
            t("x-csrf-token-b", "OTHER", "b.test"),
            t("x-csrf-token", "LATER_OTHER", "b.test"),
        ];
        // A domain cookie for the walked site lets its sibling hosts' tokens in.
        let kept = tokens_for_host(&tokens, "www.a.test", &[".a.test".to_string()]);
        assert_eq!(kept.get("x-csrf-token").map(String::as_str), Some("OURS"));
        assert_eq!(kept.get("x-xsrf-token").map(String::as_str), Some("API"));
        assert!(!kept.contains_key("x-csrf-token-b"), "another site's token stays out");
        // With only host cookies, only calls to the walked host itself count.
        let kept = tokens_for_host(&tokens, "www.a.test", &["www.a.test".to_string()]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept.get("x-csrf-token").map(String::as_str), Some("OURS"));
        // No host recorded is no host's.
        assert!(tokens_for_host(&[t("x-csrf-token", "X", "")], "www.a.test", &[]).is_empty());
    }

    #[test]
    fn sessions_absorb_over_their_own_values() {
        let mut base = MintedSession {
            cookies: HashMap::from([("a".into(), "1".into())]),
            ..Default::default()
        };
        base.absorb(MintedSession {
            cookies: HashMap::from([("a".into(), "2".into()), ("b".into(), "3".into())]),
            tokens: HashMap::from([("t".into(), "x".into())]),
            domains: HashMap::from([("b".into(), ".shop.test".into())]),
            ..Default::default()
        });
        assert_eq!(base.cookies.get("a").map(String::as_str), Some("2"));
        assert_eq!(base.cookies.len(), 2);
        assert_eq!(base.tokens.len(), 1);
        assert_eq!(base.domains.get("b").map(String::as_str), Some(".shop.test"), "how far a cookie goes travels with its value");
    }

    /// A cookie's reach is what the site's own `Set-Cookie` line says: the `Domain` attribute, read back the way
    /// DevTools reports it (lower case, leading dot), and nothing at all for a cookie set for one host alone. The
    /// cookie's name is never what decides it.
    #[test]
    fn a_cookies_domain_is_read_from_the_line_that_set_it() {
        assert_eq!(set_cookie_domain("sid=1; Domain=shop.test; Path=/"), Some(".shop.test".to_string()));
        assert_eq!(set_cookie_domain("sid=1; Domain=.Shop.Test; Path=/; HttpOnly"), Some(".shop.test".to_string()));
        assert_eq!(set_cookie_domain("sid=1; Path=/; HttpOnly; Secure"), None, "no Domain: the host that set it alone");
        assert_eq!(set_cookie_domain("sid=1"), None);
        assert_eq!(set_cookie_domain("sid=1; domain="), None, "an empty Domain says nothing");
    }

    /// A session cookie the site set for its own host goes back to that host; one set for the whole site goes where it
    /// said.
    #[test]
    fn a_walk_starts_with_the_session_where_the_site_set_it() {
        let host = SeedCookie { name: "JSESSIONID".into(), value: "a1".into(), domain: None, ..Default::default() };
        let site = SeedCookie { name: "pref".into(), value: "b2".into(), domain: Some(".site.example".into()), path: Some("/app".into()), http_only: Some(false) };
        assert_eq!(
            seed_params(&[host, site], "https://bank.site.example/overview.htm"),
            serde_json::json!({ "cookies": [
                { "name": "JSESSIONID", "value": "a1", "url": "https://bank.site.example/overview.htm", "path": "/", "httpOnly": true },
                { "name": "pref", "value": "b2", "domain": ".site.example", "path": "/app", "httpOnly": false },
            ] })
        );
    }

    /// Every refusal loses one thing it could be about: first the memory, then
    /// the lack of a window. A refusal is never the site's answer while a
    /// browser the walk could still be has not asked.
    #[test]
    fn a_refusal_is_asked_again_without_memory_then_with_a_window() {
        let warm = MintOptions { profile: Some("/tmp/site-profile".into()), ..Default::default() };
        // A browser that remembers is asked again with no memory, whether the
        // refusal was a door to pass or the site's plain answer.
        assert_eq!(next_after_refusal(&warm, "refused"), Next::Clean);
        assert_eq!(next_after_refusal(&warm, "challenge"), Next::Clean);
        let clean = MintOptions {
            profile: Some("/tmp/profiles/6f1c".into()),
            adopt: Some("/tmp/profiles/site.example".into()),
            ..Default::default()
        };
        // A clean browser has already answered for its memory, and what is left
        // to change is the window.
        assert_eq!(next_after_refusal(&clean, "refused"), Next::Person);
        // No profile at all: there is no memory to blame, so the window is the
        // first thing left to change.
        assert_eq!(next_after_refusal(&MintOptions::default(), "refused"), Next::Person);
    }

    /// A page that never answered (slow, unreachable, a challenge vendor holding the document) says nothing about the
    /// profile on its own, so the first ask is a window in the same profile. A page that then refuses may have set a
    /// cookie it judges on the next ask, so the same profile is not asked a third time: the window carries nothing.
    #[test]
    fn a_page_that_never_answered_is_asked_in_a_window_then_a_window_that_remembers_nothing() {
        let warm = MintOptions { profile: Some("/tmp/site-profile".into()), ..Default::default() };
        assert_eq!(next_after_refusal(&warm, "loading"), Next::WindowClean);
        assert_eq!(next_after_refusal(&MintOptions { windowless: true, ..warm.clone() }, "loading"), Next::Stop);
        // Past a real refusal the clean browser stands in for the remembered one, and it is that refusal it answers.
        let clean = MintOptions { adopt: Some("/tmp/site-profile".into()), ..warm };
        assert_eq!(next_after_refusal(&clean, "loading"), Next::Person);
    }

    /// An owner who keeps windows off keeps every ask that needs none: the clean browser is still tried, and only the
    /// window goes. A walk stops where a window would have been next.
    #[test]
    fn a_refusal_never_reaches_a_window_the_owner_keeps_off() {
        let warm = MintOptions { profile: Some("/tmp/site-profile".into()), windowless: true, ..Default::default() };
        assert_eq!(next_after_refusal(&warm, "refused"), Next::Clean);
        let clean = MintOptions {
            profile: Some("/tmp/profiles/6f1c".into()),
            adopt: Some("/tmp/profiles/site.example".into()),
            windowless: true,
            ..Default::default()
        };
        assert_eq!(next_after_refusal(&clean, "refused"), Next::Stop);
        assert_eq!(next_after_refusal(&MintOptions { windowless: true, ..Default::default() }, "refused"), Next::Stop);
    }

    /// A site accepts a browser with no past, so that browser is what the next
    /// walk opens from; the refused one is kept, out of the profiles' way.
    #[test]
    fn the_accepted_browser_takes_the_refused_profiles_place() {
        let dir = std::env::temp_dir().join(format!("core-adopt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let remembered = dir.join("site.example");
        let accepted = fresh_beside(&remembered.to_string_lossy());
        std::fs::create_dir_all(&remembered).unwrap();
        std::fs::write(remembered.join("marker"), "old").unwrap();
        std::fs::create_dir_all(&accepted).unwrap();
        std::fs::write(std::path::Path::new(&accepted).join("marker"), "new").unwrap();
        // The clean browser is opened beside the remembered profile, so a
        // rename can put it in its place.
        assert_eq!(std::path::Path::new(&accepted).parent(), Some(dir.as_path()));

        replace_profile(&remembered.to_string_lossy(), &accepted, &dir.join("set-aside"));
        assert_eq!(std::fs::read_to_string(remembered.join("marker")).unwrap(), "new");
        assert!(!std::path::Path::new(&accepted).exists());
        let kept: Vec<String> = std::fs::read_dir(dir.join("refused"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(kept[0].starts_with("site.example."), "{kept:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A profile set aside is listed for the owner, with its size and age, and listing it removes nothing: any one may
    /// hold a sign-in, so only the owner removes one.
    #[test]
    fn a_profile_set_aside_is_listed_for_the_owner_and_never_removed() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("set-aside");
        let profiles = dir.path().join("profiles");
        for (site, bytes) in [("a.example", 1500usize), ("b.example", 20)] {
            let remembered = profiles.join(site);
            std::fs::create_dir_all(remembered.join("Default")).unwrap();
            std::fs::write(remembered.join("Default").join("Cookies"), vec![0u8; bytes]).unwrap();
            let accepted = fresh_beside(&remembered.to_string_lossy());
            std::fs::create_dir_all(&accepted).unwrap();
            replace_profile(&remembered.to_string_lossy(), &accepted, &index);
        }
        let noted = std::fs::read_to_string(&index).unwrap();
        assert_eq!(noted.lines().collect::<Vec<_>>(), [profiles.join("refused").to_string_lossy()], "one folder, noted once");

        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(3 * 86_400);
        let kept = set_aside_profiles(&index, later);
        assert_eq!(kept.len(), 2, "{kept:?}");
        let a = kept.iter().find(|k| k.path.file_name().unwrap().to_string_lossy().starts_with("a.example.")).unwrap();
        assert_eq!(a.bytes, 1500);
        assert!((3 * 86_400..3 * 86_400 + 60).contains(&a.age_secs), "{}", a.age_secs);

        set_aside_profiles(&index, later);
        assert!(kept.iter().all(|k| k.path.join("Default").join("Cookies").exists()), "listing removes nothing");
        assert!(set_aside_profiles(&dir.path().join("no-index"), later).is_empty());
    }

    /// A refused profile that can't be moved aside (here a file stands where the `refused` folder goes) is never
    /// deleted to make room: it may hold a sign-in its owner wants back. The clean browser stays beside it.
    #[test]
    fn a_profile_that_cant_be_set_aside_is_kept() {
        let dir = std::env::temp_dir().join(format!("core-keep-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let remembered = dir.join("site.example");
        let accepted = fresh_beside(&remembered.to_string_lossy());
        std::fs::create_dir_all(&remembered).unwrap();
        std::fs::write(remembered.join("marker"), "old").unwrap();
        std::fs::create_dir_all(&accepted).unwrap();
        std::fs::write(dir.join("refused"), "a file, not a folder").unwrap();

        replace_profile(&remembered.to_string_lossy(), &accepted, &dir.join("set-aside"));
        assert_eq!(std::fs::read_to_string(remembered.join("marker")).unwrap(), "old", "the old profile is kept");
        assert!(std::path::Path::new(&accepted).exists(), "the clean browser is left beside it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A process that dies between the two renames leaves the profile's name empty. Each place it can stop has one way
    /// on, read from what stands on disk.
    #[test]
    fn a_replacement_that_stopped_part_way_has_one_way_on() {
        // Stopped before anything moved, or after everything did.
        assert_eq!(interrupted(true, false, true), Interrupted::Settled);
        assert_eq!(interrupted(true, true, false), Interrupted::Settled);
        // Stopped between the renames.
        assert_eq!(interrupted(false, true, true), Interrupted::Finish);
        // The clean browser went missing while it waited: the one set aside comes back.
        assert_eq!(interrupted(false, true, false), Interrupted::Restore);
        assert_eq!(interrupted(false, false, false), Interrupted::Settled);
    }

    /// The name a replacement emptied is filled from its record, by whoever opens that profile next.
    #[test]
    fn a_replacement_a_process_died_in_is_finished_by_the_next_launch() {
        let dir = tempfile::tempdir().unwrap();
        let remembered = dir.path().join("site.example");
        let accepted = dir.path().join("clean");
        let aside = dir.path().join("refused").join("site.example.1");
        std::fs::create_dir_all(&aside).unwrap();
        std::fs::write(aside.join("marker"), "old").unwrap();
        std::fs::create_dir_all(&accepted).unwrap();
        std::fs::write(accepted.join("marker"), "new").unwrap();
        let moves = serde_json::json!({ "aside": aside, "accepted": accepted }).to_string();
        std::fs::write(replacing_record(&remembered), &moves).unwrap();

        finish_replacing(&remembered);
        assert_eq!(std::fs::read_to_string(remembered.join("marker")).unwrap(), "new");
        assert!(!replacing_record(&remembered).exists());

        // The accepted browser gone with the process: what was set aside is the profile again.
        std::fs::remove_dir_all(&remembered).unwrap();
        std::fs::write(replacing_record(&remembered), &moves).unwrap();
        finish_replacing(&remembered);
        assert_eq!(std::fs::read_to_string(remembered.join("marker")).unwrap(), "old");

        // A record cut short was written before anything moved: it goes, and the profile is left alone.
        std::fs::write(replacing_record(&remembered), "{\"aside").unwrap();
        finish_replacing(&remembered);
        assert!(!replacing_record(&remembered).exists());
        assert_eq!(std::fs::read_to_string(remembered.join("marker")).unwrap(), "old");
    }

    /// The accepted browser that can't take the name leaves the owner's profile at it, not out of sight under `refused/`.
    #[test]
    fn a_clean_browser_that_cant_take_the_name_gives_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let remembered = dir.path().join("site.example");
        std::fs::create_dir_all(&remembered).unwrap();
        std::fs::write(remembered.join("marker"), "old").unwrap();
        let gone = dir.path().join("never-there");

        replace_profile(&remembered.to_string_lossy(), &gone.to_string_lossy(), &dir.path().join("set-aside"));
        assert_eq!(std::fs::read_to_string(remembered.join("marker")).unwrap(), "old");
        assert!(!replacing_record(&remembered).exists());
    }

    /// A throwaway goes when its walk's future is dropped: the only thing that still runs then is a destructor.
    #[test]
    fn a_throwaway_goes_with_a_walk_dropped_mid_way_and_stays_when_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (dropped, kept) = (dir.path().join("dropped"), dir.path().join("kept"));
        std::fs::create_dir_all(&dropped).unwrap();
        std::fs::create_dir_all(&kept).unwrap();
        drop(Throwaway(Some(dropped.to_string_lossy().into_owned())));
        Throwaway(Some(kept.to_string_lossy().into_owned())).keep();
        assert!(!dropped.exists());
        assert!(kept.exists());
    }

    /// One window waits for a person at a site: a second walk of the site that meets the same check opens none. Over
    /// every site no more than a few wait, and a window past that takes the place of the one that has waited longest.
    #[test]
    fn one_window_waits_at_a_site_and_the_longest_waiting_gives_way() {
        assert_eq!(admit(&[], "shop.example", 3), Some(0), "the first window waits");
        assert_eq!(admit(&["shop.example"], "shop.example", 3), None, "a second at the same site is not opened");
        assert_eq!(admit(&["shop.example"], "news.example", 3), Some(0));
        assert_eq!(admit(&["a.example", "b.example", "c.example"], "d.example", 3), Some(1), "the longest-waiting gives way");
        assert_eq!(admit(&["a.example", "b.example", "c.example"], "b.example", 3), None, "full or not, a site has one");
        assert_eq!(admit(&["a.example", "b.example", "c.example", "d.example"], "e.example", 3), Some(2));
        assert_eq!(admit(&["a.example"], "b.example", 0), Some(1), "a window always may wait: it takes the only place");
    }

    /// The places as a node keeps them: a failing call asked a hundred times leaves one window, the fourth site's
    /// window tells the first to close, and a window that has closed gives its place up for the site's next.
    #[test]
    fn a_site_asked_again_and_again_holds_one_window() {
        let told = |w: &std::sync::Arc<std::sync::atomic::AtomicBool>| w.load(std::sync::atomic::Ordering::Relaxed);
        let first = wait_for_a_person_at("one.waits.example").expect("the first window waits");
        for _ in 0..100 {
            assert!(wait_for_a_person_at("one.waits.example").is_none(), "the site already has its window");
        }
        assert!(!told(&first));
        let second = wait_for_a_person_at("two.waits.example").unwrap();
        let third = wait_for_a_person_at("three.waits.example").unwrap();
        assert!(!told(&first) && !told(&second) && !told(&third), "three may wait");
        let fourth = wait_for_a_person_at("four.waits.example").unwrap();
        assert!(told(&first), "the one that waited longest is told to close");
        assert!(!told(&second) && !told(&third) && !told(&fourth));
        // The first is gone from the places already, so its site may have a window again; that takes the second's.
        let again = wait_for_a_person_at("one.waits.example").expect("its place was given up");
        assert!(told(&second));
        // A window that closed by itself gives its place up.
        no_longer_waiting(&third);
        assert!(wait_for_a_person_at("three.waits.example").is_some());
        for word in [&first, &second, &third, &fourth, &again] {
            no_longer_waiting(word);
        }
        assert_eq!(site_walked("https://Shop.Example/search?q=a"), "shop.example");
        assert_eq!(site_walked("https://shop.example:8443/x"), "shop.example", "a site is its host, whatever the port");
    }

    #[test]
    fn a_handoff_ends_when_the_person_finishes_closes_or_never_comes() {
        assert_eq!(handoff_end(false, Some("challenge"), false), None, "still at the door");
        assert_eq!(handoff_end(false, None, false), None, "between looks");
        assert_eq!(handoff_end(false, Some("loading"), false), None, "a page on its way is not through");
        assert_eq!(handoff_end(false, Some("ready"), false), Some(HandoffEnd::Finished));
        assert_eq!(handoff_end(true, Some("ready"), false), Some(HandoffEnd::Closed), "a closed browser is closed");
        assert_eq!(handoff_end(false, Some("challenge"), true), Some(HandoffEnd::NobodyCame));
    }

    /// A person finishing in a window opened on a throwaway profile ends the handoff: the window is closed and the
    /// throwaway removed, and nothing takes the remembered profile's place.
    #[test]
    fn a_finished_handoff_closes_its_window_and_removes_its_throwaway() {
        let dir = tempfile::tempdir().unwrap();
        let remembered = dir.path().join("site.example");
        std::fs::create_dir_all(&remembered).unwrap();
        std::fs::write(remembered.join("marker"), "the owner's").unwrap();
        let throwaway = dir.path().join("0b5e-throwaway");
        std::fs::create_dir_all(throwaway.join("Default")).unwrap();

        let mut states = ["challenge", "challenge", "ready"].into_iter();
        let mut closed = None;
        let end = run_handoff(
            std::time::Duration::from_secs(30),
            || false,
            || states.next().map(String::from),
            |end| closed = Some(end),
            Some(&throwaway.to_string_lossy()),
        );
        assert_eq!(end, HandoffEnd::Finished);
        assert_eq!(closed, Some(HandoffEnd::Finished), "the window is closed when the person is through");
        assert!(!throwaway.exists(), "the throwaway goes with its window");
        assert_eq!(std::fs::read_to_string(remembered.join("marker")).unwrap(), "the owner's", "never adopted");
        assert!(!dir.path().join("refused").exists(), "nothing was set aside for it");
    }

    /// However the handoff ends, a throwaway goes; a remembered profile a window was opened in stays.
    #[test]
    fn a_handoff_nobody_finishes_still_removes_its_throwaway_and_keeps_a_remembered_profile() {
        let dir = tempfile::tempdir().unwrap();
        let throwaway = dir.path().join("closed-by-hand");
        std::fs::create_dir_all(&throwaway).unwrap();
        let end = run_handoff(std::time::Duration::from_secs(30), || true, || None, |_| {}, Some(&throwaway.to_string_lossy()));
        assert_eq!(end, HandoffEnd::Closed);
        assert!(!throwaway.exists());

        let throwaway = dir.path().join("nobody-came");
        std::fs::create_dir_all(&throwaway).unwrap();
        let end = run_handoff(std::time::Duration::ZERO, || false, || None, |_| {}, Some(&throwaway.to_string_lossy()));
        assert_eq!(end, HandoffEnd::NobodyCame);
        assert!(!throwaway.exists());

        let remembered = dir.path().join("remembered");
        std::fs::create_dir_all(&remembered).unwrap();
        let mut states = ["ready"].into_iter();
        run_handoff(std::time::Duration::from_secs(30), || false, || states.next().map(String::from), |_| {}, None);
        assert!(remembered.exists(), "a window in the remembered profile leaves it where it is");
    }

    /// The walk holds a worker at its first line only until the worker's own network is on, and never a frame
    /// (`learn.record`): a worker that called as it started called before its network was on, and the walk heard the
    /// answer without the request (a matrix row, 2 runs in 10). The hold is the attaching task's, bounded, never the
    /// walk loop's, so a walk slow to read its events never stalls the page; a frame held would (one took 14 s to turn
    /// on). This changes the earlier rule that no target is ever held (e24bae06), whose test read this file the same way.
    #[test]
    fn the_walk_holds_only_a_worker_and_only_until_its_network_is_on() {
        assert!(is_a_worker("worker") && is_a_worker("shared_worker") && is_a_worker("service_worker"));
        assert!(!is_a_worker("iframe") && !is_a_worker("page") && !is_a_worker("other"));
        assert!(HOLD_A_WORKER <= std::time::Duration::from_secs(1), "a held worker's page never stalls long");
        let source = include_str!("session.rs");
        // The code, not this test's own text: the last place each is written.
        let release = source.rfind("tokio::time::timeout(HOLD_A_WORKER, turn_on)").expect("the hold is bounded");
        assert!(source[release..release + 120].contains("run().await"), "a held worker is let run once its network is on, or the bound is up");
        let frame = source.rfind("if !held {").expect("a frame is told apart");
        assert!(source[frame..frame + 80].contains("run().await"), "a frame is let run before anything else");
    }

    /// A context slow to turn on never holds up the next (`learn.record`). A frame of the tab's start page took 14 s
    /// to answer `Network.enable`; the worker the page started meanwhile waited behind it and made its call unseen,
    /// and the walk said the page needs hands. Each is now turned on by itself. The slow one here answers only when
    /// the test lets it, so no clock is read.
    #[tokio::test]
    async fn a_context_slow_to_turn_on_never_holds_up_the_next() {
        let (said, mut turned_on) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
        let mut each = EachByItself::default();
        let (answer, answered) = tokio::sync::oneshot::channel::<()>();
        let slow = said.clone();
        each.start(async move {
            let _ = answered.await;
            let _ = slow.send("the slow frame");
        });
        let quick = said.clone();
        each.start(async move {
            let _ = quick.send("the worker");
        });
        assert_eq!(turned_on.recv().await, Some("the worker"), "the worker is on while the slow frame has not answered");
        let _ = answer.send(());
        assert_eq!(turned_on.recv().await, Some("the slow frame"));
        // Dropped with the walk, what is still turning on stops.
        let late = said.clone();
        each.start(async move {
            std::future::pending::<()>().await;
            let _ = late.send("after the walk");
        });
        drop(each);
        drop(said);
        assert_eq!(turned_on.recv().await, None, "nothing runs on past the walk");
    }

    /// A body Chrome hands over encoded is text when its bytes are: an answer of one record a line comes that way,
    /// because Chrome reads its type as no text. Bytes that are no text stay out.
    #[test]
    fn a_body_handed_over_encoded_is_text_when_its_bytes_are() {
        use base64::Engine;
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let lines = "{\"title\":\"kettle one\"}\n{\"title\":\"kettle two\"}\n";
        assert_eq!(body_text(lines, false).as_deref(), Some(lines), "text handed over as text is itself");
        assert_eq!(body_text(&b64(lines.as_bytes()), true).as_deref(), Some(lines), "text handed over encoded is decoded");
        assert_eq!(body_text(&b64("caf\u{e9} \u{6c34}".as_bytes()), true).as_deref(), Some("caf\u{e9} \u{6c34}"));
        assert_eq!(body_text(&b64(&[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), true), None, "a compiled module is no text");
        assert_eq!(body_text(&b64(&[0xff, 0xd8, 0xff, 0xe0]), true), None, "nor is an image");
        assert_eq!(body_text("not base64 at all!", true), None);
    }

    #[test]
    fn capture_lines_parse_and_bad_lines_skip() {
        let dir = std::env::temp_dir().join(format!("core-session-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = capture_path(&dir, "demo session");
        std::fs::write(&path, "{\"type\":\"exchange\"}\nnot json\n\n{\"type\":\"action\"}\n").unwrap();
        let lines = read_capture(&path);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["type"], "exchange");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A request's initiator keeps the frames that sent it and each async hop they were scheduled from, and the HAR
    /// entry carries it; a log from before initiators reads as before, with none.
    #[test]
    fn a_requests_initiator_keeps_its_stack_and_its_hops() {
        let frame = |id: &str, f: &str| serde_json::json!({"scriptId": id, "url": "https://shop.example/app.js", "functionName": f, "lineNumber": 3, "columnNumber": 9});
        let raw = serde_json::json!({"type": "script", "stack": {
            "callFrames": [frame("12", "askForData")],
            "parent": {"description": "await", "callFrames": [frame("12", "load")], "parent": {"description": "setTimeout", "callFrames": [frame("9", "")]}},
        }});
        let kept = initiator(&raw);
        assert_eq!(kept["type"], "script");
        assert_eq!(kept["frames"][0], serde_json::json!({"scriptId": "12", "url": "https://shop.example/app.js", "function": "askForData", "line": 3, "column": 9}));
        assert_eq!(kept["parents"].as_array().unwrap().len(), 2);
        assert_eq!(kept["parents"][0]["description"], "await");
        assert_eq!(kept["parents"][1]["frames"][0]["scriptId"], "9");
        let parser = initiator(&serde_json::json!({"type": "parser", "url": "https://shop.example/", "lineNumber": 4}));
        assert_eq!(parser, serde_json::json!({"type": "parser", "url": "https://shop.example/", "line": 4}));

        let dir = std::env::temp_dir().join(format!("core-initiator-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            serde_json::json!({"type": "request", "requestId": "1", "method": "GET", "url": "https://shop.example/api", "headers": {}, "initiator": kept}),
            serde_json::json!({"type": "response", "requestId": "1", "url": "https://shop.example/api", "status": 200, "mimeType": "application/json", "headers": {}, "body": "{}"}),
            serde_json::json!({"type": "request", "requestId": "2", "method": "GET", "url": "https://shop.example/old", "headers": {}}),
            serde_json::json!({"type": "response", "requestId": "2", "url": "https://shop.example/old", "status": 200, "mimeType": "application/json", "headers": {}, "body": "{}"}),
            serde_json::json!({"type": "script", "scriptId": "12", "url": "https://shop.example/app.js", "language": "js", "sha256": "00", "length": 0}),
        ];
        std::fs::write(capture_path(&dir, "i"), lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
        let har = walk_har(&dir, "i");
        let entries = har["log"]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2, "a script line is no exchange");
        assert_eq!(entries[0]["_initiator"]["frames"][0]["function"], "askForData");
        assert!(entries[1]["_initiator"].is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The walk says what Chrome measured: a beacon is a `Ping` whatever it answers, and a frame's page is not the
    /// walk's page. The main frame is the frame of the walk's first document.
    #[test]
    fn the_walk_keeps_chromes_types_and_frames() {
        let dir = std::env::temp_dir().join(format!("core-frames-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let line = |kind: &str, id: &str, url: &str, ty: &str, frame: &str, mime: &str, body: &str| {
            if kind == "request" {
                serde_json::json!({"type": "request", "requestId": id, "method": "GET", "url": url, "headers": {}, "resourceType": ty, "frameId": frame})
            } else {
                serde_json::json!({"type": "response", "requestId": id, "url": url, "status": 200, "mimeType": mime, "headers": {}, "body": body})
            }
        };
        let walk = [
            line("request", "1", "https://shop.example/", "Document", "MAIN", "", ""),
            line("response", "1", "https://shop.example/", "", "", "text/html", "<html>the page</html>"),
            line("request", "2", "https://shop.example/beacon", "Ping", "MAIN", "", ""),
            line("response", "2", "https://shop.example/beacon", "", "", "application/json", "{\"ok\":true}"),
            line("request", "3", "https://widget.test/frame", "Document", "CHILD", "", ""),
            line("response", "3", "https://widget.test/frame", "", "", "text/html", "<html>a widget</html>"),
        ];
        let text: String = walk.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(capture_path(&dir, "w"), text).unwrap();
        let har = walk_har(&dir, "w");
        let entries = har["log"]["entries"].as_array().unwrap();
        let kinds: Vec<&str> = entries.iter().map(|e| e["_resourceType"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["Document", "Ping", "Document"]);
        let main: Vec<bool> = entries.iter().map(|e| e["_mainFrame"].as_bool().unwrap()).collect();
        assert_eq!(main, [true, true, false]);
        assert_eq!(walk_page(&dir, "w").map(|(_, _, body)| body).as_deref(), Some("<html>the page</html>"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The session's cookies travel as the browser sent them: `requestWillBeSent` omits `Cookie` (it is added at the
    /// network layer), and the same request's extra info carries it. The walk keeps them, so a route's session values
    /// are the ones the browser actually sent.
    #[test]
    fn a_requests_cookies_are_kept_as_sent() {
        let dir = std::env::temp_dir().join(format!("core-cookies-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let walk = [
            serde_json::json!({"type": "request", "requestId": "1", "method": "POST", "url": "https://sg.example/api/search", "headers": {"content-type": "application/json", "Accept": "application/json, text/plain, */*"}, "resourceType": "Fetch", "frameId": "MAIN"}),
            serde_json::json!({"type": "request_extra", "requestId": "1", "headers": {"Cookie": "_RF1=abc; DUID=d-7", "Accept": "*/*"}}),
            serde_json::json!({"type": "response", "requestId": "1", "url": "https://sg.example/api/search", "status": 200, "mimeType": "application/json", "headers": {}, "body": "{}"}),
        ];
        let text: String = walk.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(capture_path(&dir, "w"), text).unwrap();
        let har = walk_har(&dir, "w");
        let entry = &har["log"]["entries"][0]["request"]["headers"].as_array().unwrap();
        let header = |name: &str| entry.iter().find(|h| h["name"] == name).map(|h| h["value"].as_str().unwrap().to_string());
        assert_eq!(header("cookie").as_deref(), Some("_RF1=abc; DUID=d-7"), "the cookie as the browser sent it");
        assert_eq!(header("accept").as_deref(), Some("*/*"), "and the rest of the extra info");
        assert_eq!(header("content-type").as_deref(), Some("application/json"), "the request's own stay");
        // The header the event announced and the one the extra info sent are one header, in the casing the wire uses: a
        // browser sends `accept` once, and a route carrying both sent it twice.
        let accepts = entry.iter().filter(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case("accept"))).count();
        assert_eq!(accepts, 1, "{entry:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A walk the site refused is tried again in another browser, whose page is a new frame. That page is still the
    /// walk's, so the door closes on it and what the site answered after it is the site's data, not the door's; a
    /// frame inside the second browser is still a frame, and so is the browser's own new-tab page, which can load before
    /// the walk's.
    #[test]
    fn a_retried_walk_has_a_main_frame_per_browser() {
        let dir = std::env::temp_dir().join(format!("core-retry-frames-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let req = |id: &str, url: &str, ty: &str, frame: &str| {
            serde_json::json!({"type": "request", "requestId": id, "method": "GET", "url": url, "headers": {}, "resourceType": ty, "frameId": frame})
        };
        let resp = |id: &str, url: &str, status: u16, mime: &str, body: &str| {
            serde_json::json!({"type": "response", "requestId": id, "url": url, "status": status, "mimeType": mime, "headers": {}, "body": body})
        };
        let walk = [
            serde_json::json!({"type": "mint", "url": "https://shop.example/search?q=desk"}),
            req("1", "https://shop.example/search?q=desk", "Document", "FIRST"),
            resp("1", "https://shop.example/search?q=desk", 403, "text/html", "<html>denied</html>"),
            serde_json::json!({"type": "mint", "url": "https://shop.example/search?q=desk"}),
            req("0", "chrome-untrusted://new-tab-page/one-google-bar", "Document", "NEWTAB"),
            req("2", "https://shop.example/search?q=desk", "Document", "SECOND"),
            resp("2", "https://shop.example/search?q=desk", 200, "text/html", "<html>results</html>"),
            req("3", "https://shop.example/api/search", "XHR", "SECOND"),
            resp("3", "https://shop.example/api/search", 200, "application/json", "{\"items\":[]}"),
            req("4", "https://widget.test/frame", "Document", "CHILD"),
            resp("4", "https://widget.test/frame", 200, "text/html", "<html>a widget</html>"),
        ];
        let text: String = walk.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(capture_path(&dir, "w"), text).unwrap();
        let har = walk_har(&dir, "w");
        let main: Vec<bool> = har["log"]["entries"].as_array().unwrap().iter().map(|e| e["_mainFrame"].as_bool().unwrap()).collect();
        assert_eq!(main, [true, true, true, false]);
        assert_eq!(walk_page(&dir, "w").map(|(status, _, body)| (status, body)), Some((200, "<html>results</html>".to_string())));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The mint's settings: where to walk and where the walk's log lands.
#[derive(Clone, Debug, Default)]
pub struct MintOptions {
    /// The door to walk through.
    pub url: String,
    /// The session name whose capture log records the walk.
    pub session: String,
    /// Where the passive log goes; None: no capture.
    pub capture_dir: Option<std::path::PathBuf>,
    /// A persistent profile dir: it accumulates the site's cookies and
    /// reputation, so later walks open easier. A site can also refuse what the
    /// profile remembers (a clearance it has since revoked, a history it holds
    /// against the browser), so a walk the site refuses here is tried once more
    /// in a browser that remembers nothing.
    pub profile: Option<String>,
    /// The profile this walk's browser should take the place of once the site
    /// accepts it. Set when `profile` is a throwaway opened to ask whether the
    /// site's refusal was about what the remembered browser held: the answer is
    /// kept by giving the clean browser the site's name. `Some` also says the
    /// clean browser was already tried, so a refusal now leaves only a person.
    pub adopt: Option<String>,
    /// Show the browser (front doors challenge headless far more readily).
    pub headed: bool,
    /// Never show one, whoever asks: the owner keeps windows off this machine (a server, a test bank). A walk that
    /// only a window could take further ends at its refusal, and says so.
    pub windowless: bool,
    /// Extra Chrome arguments.
    pub args: Vec<String>,
    /// How long to let the walk settle before harvesting.
    pub settle_ms: u64,
    /// A browser that already exists, as a CDP endpoint
    /// (`http://127.0.0.1:PORT` or `ws://...`). When set, the mint attaches to
    /// it and opens a tab there instead of launching Chrome — the node then
    /// owns no browser at all, and the session is the one the human already
    /// has open.
    pub cdp_endpoint: Option<String>,
    /// Where pictures of the walk go while it runs (`screencast`); None: none taken.
    pub frames: Option<crate::screencast::FrameSink>,
    /// Browse a little while the page settles: scroll to the end and press a visible "more" or "next" control a
    /// few times. A page that arrives server-rendered calls its own data API only when the reader asks for more,
    /// so a walk that only waits never sees that call.
    pub browse: bool,
    /// After browsing, try what the page offers for narrowing or ordering what it shows, one control at a time, so the
    /// walk records the call each one sends. Clicking on a page may change what an account holds, so a caller asks for
    /// this only in a profile with no account in it.
    pub try_controls: bool,
    /// Route every request through Rust (`intercept`), which checks the target
    /// resolves public and pins the address. Off by default: the browser's own
    /// connection is part of the identity it presents — its TLS handshake and
    /// HTTP/2 settings are read by the site — and a proxy that answers on its
    /// behalf advertises the proxy instead.
    pub intercept: bool,
    /// The browser program to launch, any Chromium build; None: the engine's
    /// own pick (`cdp::chrome::find_chrome`). Ignored with `cdp_endpoint`.
    pub executable_path: Option<String>,
    /// Cookies the walk's browser holds before it opens the page: the session the caller keeps for the site, so a
    /// page that needs it is walked signed in. A session cookie dies with the browser that got it, and the walk's
    /// browser is often a new one.
    pub cookies: Vec<SeedCookie>,
    /// Set when whoever waits on the walk has given up on it (an agent's request cancelled, its connection dropped):
    /// the walk ends at once, with [`STOPPED`], and its browser and profile go back. Nobody would read what it found.
    pub stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

/// What a walk stopped by its [`MintOptions::stop`] says.
pub const STOPPED: &str = "stopped: whoever waited on this walk gave up on it";

/// How often a walk that can be stopped looks whether it has been.
const STOP_LOOKS_EVERY: std::time::Duration = std::time::Duration::from_millis(250);

/// Whether the walk's [`MintOptions::stop`] has been set.
fn asked_to_stop(opts: &MintOptions) -> bool {
    opts.stop.as_ref().is_some_and(|s| s.load(std::sync::atomic::Ordering::Relaxed))
}

/// A cookie a walk starts with. With no `domain` it is the walked host's alone, as one the host set for itself is.
/// It is set as the browser that earned it had it: on its `path` (the root when none was recorded), and kept from the
/// page's script unless it is known not to be HttpOnly (`http_only` of `Some(false)`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SeedCookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
    pub http_only: Option<bool>,
}

impl SeedCookie {
    /// Whether a page's script may read it: only when it is known not to be HttpOnly.
    pub fn shown_to_script(&self) -> bool {
        self.http_only == Some(false)
    }

    /// The path it goes to: the one recorded, or the root.
    pub fn path(&self) -> &str {
        self.path.as_deref().filter(|p| p.starts_with('/')).unwrap_or("/")
    }
}

/// The cookies as `Network.setCookies` takes them, for a walk of `url`.
pub fn seed_params(cookies: &[SeedCookie], url: &str) -> serde_json::Value {
    let list: Vec<serde_json::Value> = cookies
        .iter()
        .map(|c| {
            let http_only = !c.shown_to_script();
            match &c.domain {
                Some(domain) => serde_json::json!({ "name": c.name, "value": c.value, "domain": domain, "path": c.path(), "httpOnly": http_only }),
                None => serde_json::json!({ "name": c.name, "value": c.value, "url": url, "path": c.path(), "httpOnly": http_only }),
            }
        })
        .collect();
    serde_json::json!({ "cookies": list })
}

/// One nudge of the reader: scroll to the end, and press the first visible control whose words ask for more.
/// Nothing here knows a site; it reads the words pages use.
const NUDGE: &str = r#"(() => {
  window.scrollTo(0, document.documentElement.scrollHeight);
  const words = /^(show|load|view|see)\s+more\b|^more\s+results\b|^next(\s+page)?\b|^›$|^»$/i;
  const el = [...document.querySelectorAll('button, a[role=button], [role=button], a[rel=next]')]
    .find(e => e.offsetParent && words.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
  if (el) { el.scrollIntoView({block: 'center'}); el.click(); return 'pressed: ' + (el.innerText || '').trim().slice(0, 40); }
  return 'scrolled';
})()"#;

/// The most controls a walk tries, and how long each gets to send its call.
const MOST_TRIES: usize = 10;
const TRY_EVERY: std::time::Duration = std::time::Duration::from_millis(900);

/// One try of the page's controls: picks the next it hasn't tried, or puts back the one it just tried, and says what it
/// did. Nothing here knows a site or a word: a control says what it is by its element and role. What a page's chrome
/// holds, a form that posts, a sign-in form and a switch (which changes a setting, not a list) are left alone. Each
/// group gets a turn before any gets a second, and a control that opens a menu or a panel goes last, so what it reveals
/// is tried in its own turn. `__TRIED__`, `__UNDO__` and `__HOME__` are filled in from what earlier tries said.
const TRY_CONTROL: &str = r#"(() => {
  const tried = new Set(__TRIED__), undo = __UNDO__, home = __HOME__;
  if (home !== null && location.pathname !== home) { history.back(); return JSON.stringify({ left: true }); }
  const words = (e) => (e.getAttribute('aria-label') || e.innerText || (e.labels && e.labels[0] && e.labels[0].innerText) || '').trim().slice(0, 60);
  const key = (e) => [e.tagName, e.getAttribute('role') || '', e.name || '', e.value || '', words(e)].join('|');
  const group = (e) => e.name || e.getAttribute('aria-labelledby') || [e.tagName, e.getAttribute('role') || ''].join('|');
  const shown = (e) => ((e.labels && e.labels[0]) || e).getClientRects().length > 0;
  const chrome = 'header, footer, [role=banner], [role=contentinfo], dialog, [role=dialog], [role=alertdialog], [aria-modal=true]';
  const free = (e) => {
    if (e.disabled || e.getAttribute('aria-disabled') === 'true' || e.getAttribute('role') === 'switch' || e.closest(chrome) || !shown(e)) return false;
    const form = e.closest('form');
    return !form || ((form.getAttribute('method') || 'get').toLowerCase() === 'get' && !form.querySelector('input[type=password]'));
  };
  const opens = (e) => e.hasAttribute('aria-haspopup') || e.getAttribute('aria-expanded') === 'false';
  const toggles = (e) => e.type === 'checkbox' || e.hasAttribute('aria-pressed') || /checkbox/.test(e.getAttribute('role') || '');
  const all = [...document.querySelectorAll('select, input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [aria-pressed], [aria-haspopup=listbox], [aria-haspopup=menu], [aria-expanded=false]')].filter(free);
  if (undo !== null) {
    const was = all.find((e) => key(e) === undo);
    if (was) was.click();
    return JSON.stringify({ home: location.pathname, undone: true });
  }
  const turns = {};
  for (const k of tried) { const g = k.split(' ')[0]; turns[g] = (turns[g] || 0) + 1; }
  const left = all.filter((e) => !tried.has(group(e) + ' ' + key(e)));
  left.sort((a, b) => (opens(a) - opens(b)) || ((turns[group(a)] || 0) - (turns[group(b)] || 0)));
  const next = left[0];
  if (!next) return JSON.stringify({ done: true });
  if (next.tagName === 'SELECT') {
    const option = [...next.options].find((o) => !o.selected && o.value && !o.disabled);
    if (option) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(next, option.value);
      next.dispatchEvent(new Event('input', { bubbles: true }));
      next.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } else {
    next.click();
  }
  return JSON.stringify({ home: location.pathname, tried: group(next) + ' ' + key(next), undo: toggles(next) ? key(next) : null });
})()"#;

/// `TRY_CONTROL` with what earlier tries said filled in.
fn try_control(tried: &[String], undo: Option<&str>, home: Option<&str>) -> String {
    let json = |v: serde_json::Value| v.to_string();
    TRY_CONTROL.replace("__TRIED__", &json(serde_json::json!(tried))).replace("__UNDO__", &json(serde_json::json!(undo))).replace("__HOME__", &json(serde_json::json!(home)))
}

// Inspect rendered page state, not cookie presence or URL substrings: a
// Cloudflare interstitial keeps the protected URL and can issue cookies while
// still refusing navigation. Ordinary pages may load Turnstile widgets, so a
// widget alone is not a blocked document.
//
// The document's own answer comes first: a door that refuses the page can say
// so in nothing but its status, and answer with a shell that has no words at
// all (a title, an iframe, an empty body). Read from the navigation entry, the
// status is what the site told this browser, whatever the page then renders.
//
// A refusal is a door only if it shows a person something to do. Words that ask
// for an act, a challenge script, or a widget the person can see and press are a
// door a person can pass; a page that only states the site's decision ("access
// denied", "you have been blocked", a bare 403 shell) is the site's answer, and
// a window would show a person the same answer.
//
// A widget is a frame from another site that a person could actually meet: it
// has a box on the page big enough to hold a control, and the page does not hide
// it. The web is full of framed pixels — beacons, ad slots, social sign-in —
// that are not doors, and a page that is not refusing is not a door whatever it
// frames.
//
// A document the browser never received is not a page at all: Chrome answers an
// address it could not reach with its own error page, which has a body and a
// complete readyState, and nothing on it was written by the site.
/// How many browsers one walk may ask the site in: the remembered one, one that remembers nothing, a window, and a
/// window that remembers nothing. A site that refuses all four has answered in every browser the walk can be, and
/// asking again is the loop the retries exist to end.
const ASKS: u8 = 4;

/// How long a challenge that is showing gets to clear itself: a page's settle is the walk's clock, but a door runs
/// its own script and reloads when it passes, and a real browser (headed, with an accepted profile) often needs
/// 15–20 s. Waiting the settle window instead harvests the challenge.
const DOOR_WAIT: std::time::Duration = std::time::Duration::from_secs(25);

const PAGE_STATE: &str = r#"(() => {
  if (document.querySelector('#main-frame-error')) return 'loading';
  const nav = performance.getEntriesByType('navigation')[0];
  const status = nav && nav.responseStatus;
  const refused = status === 403 || status === 429 || status === 503;
  const title = document.title.toLowerCase();
  const text = (document.body?.innerText || '').slice(0, 16000).toLowerCase();
  const verdict = /access denied|you have been blocked|request blocked|too many requests|forbidden/.test(title);
  // Words and scripts that ask for an act are a door on their own; a widget is
  // one only where the site is refusing, and only if a person could meet it.
  // Cloudflare's bot management puts `_cf_chl_opt` on every page it protects,
  // passed or not, so its mere presence is not a challenge: the challenge
  // config (`cType`, `cRay`, `cvId`) and the challenge's own DOM are. A passed
  // page that carried the object was read as a door and never walked.
  const chl = window._cf_chl_opt;
  const cfConfig = !!chl && (typeof chl.cType === 'string' || typeof chl.cRay === 'string' || chl.cvId !== undefined);
  const cfStage = !!document.querySelector('#challenge-stage, #challenge-running, #challenge-body-text, #cf-challenge-running, #cf-challenge-stage, .cf-browser-verification');
  const asks = cfConfig || cfStage
    || /just a moment|human verification|performing security verification/.test(title)
    || /performing security verification|verify you are human|verify you’re a human/.test(text);
  if (asks) return 'challenge';
  if (refused || verdict) {
    const met = [...document.querySelectorAll('iframe')].some(f => {
      try {
        const u = new URL(f.src, location.href);
        if (!((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== location.origin)) return false;
        const box = f.getBoundingClientRect();
        const style = getComputedStyle(f);
        return box.width >= 100 && box.height >= 40
          && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      } catch { return false; }
    });
    return met ? 'challenge' : 'refused';
  }
  if (location.href === 'about:blank' || document.readyState === 'loading' || !document.body) return 'loading';
  return 'ready';
})()"#;

async fn page_state(client: &crate::cdp::client::CdpClient, session: &str) -> String {
    // A page that did not say is asked again, a few times: one that has just been let through a door reloads, and
    // one busy with its own scripts answers late. Either read as `loading`, and a page that had loaded and answered
    // was given up as one that never did. Only a page that says it is loading, or never says, is.
    for again in 0..4 {
        let said = client
            .send_command(
                "Runtime.evaluate",
                Some(serde_json::json!({"expression": own(PAGE_STATE), "returnByValue": true})),
                Some(session),
            )
            .await
            .ok()
            .and_then(|v| v.pointer("/result/value").and_then(|x| x.as_str()).map(String::from));
        match said {
            Some(state) if state != "loading" || again == 3 => return state,
            _ => tokio::time::sleep(std::time::Duration::from_millis(if cfg!(test) { 10 } else { 1500 })).await,
        }
    }
    "loading".to_string()
}

/// Whether the page gave the site's answer against this browser. `loading` is every way of not getting one: a page
/// still coming, a document the browser never received, a browser that stopped answering. None of those says anything
/// about what the browser holds, so none may cost it what it holds.
fn site_refused(state: &str) -> bool {
    matches!(state, "refused" | "challenge")
}

/// What a walk that didn't land headless does next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Next {
    /// Try again in a browser that remembers nothing: a profile the site refused
    /// may be the reason it refused, and a clean browser answers that question
    /// without a window.
    Clean,
    /// Ask in a browser with a window: the last browser the walk can be.
    Person,
    /// Ask with a window in this same profile. The page never answered, so what the browser remembers isn't in
    /// question and no other browser is owed its place; only the lack of a window is left to change.
    Window,
    /// Ask with a window in a browser that remembers nothing. A page that never answered may still have set a cookie
    /// it judges on the next ask (a challenge vendor's id): the same profile carries it into the window and is
    /// refused again. This is the last ask: a window on a browser that carries nothing.
    WindowClean,
    /// Nothing is left that may be asked: the last browser the walk can be has a window, and the owner keeps windows off.
    Stop,
}

/// How a walk that didn't land continues. A refusal is the site's answer only once the
/// page has been asked in every browser the walk can be: the one that remembers
/// (it may hold a past the site is judging), one that remembers nothing (with
/// nothing to blame, the refusal must be about something else), and one with a
/// window. Headlessness is itself a thing a site can refuse — the same browser,
/// same address, same memory, is a different ask with a window on it — so a
/// windowless refusal is never the last question. What the page showed decides
/// only what a window is for: a page offering a widget is a door for a person to
/// pass, and a page that refuses outright is a question a window can still
/// change the answer to. Only a browser the walk launched gets here: one it
/// attached to is its owner's, and is left for them untouched. An owner who keeps windows off (`windowless`) keeps the
/// clean browser, which needs none, and goes without the last.
///
/// A page that never answered (`state` is not a refusal) has refused nothing. The clean browser is the question "was
/// it what you remember?", and what it finds decides who keeps the profile: a network that came back for it would
/// sign the owner out over nothing, so that question is only asked of a site that refused.
fn next_after_refusal(opts: &MintOptions, state: &str) -> Next {
    let remembers = matches!(&opts.profile, Some(_)) && opts.adopt.is_none();
    match (remembers, site_refused(state), opts.windowless) {
        (true, true, _) => Next::Clean,
        (true, false, false) => Next::WindowClean,
        (false, _, false) => Next::Person,
        (_, _, true) => Next::Stop,
    }
}

/// A profile opened only to ask the site a question. It goes when the asking ends, however it ends: a walk's caller can
/// drop it mid-walk, and nothing after that await would run.
struct Throwaway(Option<String>);

impl Throwaway {
    /// The walk ended leaving this profile with a use: what the site accepted, or a window a person is finishing in.
    fn keep(mut self) {
        self.0 = None;
    }
}

impl Drop for Throwaway {
    fn drop(&mut self) {
        if let Some(dir) = self.0.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// How a browser left open for a person stopped being theirs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HandoffEnd {
    /// The page they were shown reads as the site's own page now: they got through.
    Finished,
    /// They closed the browser.
    Closed,
    /// Nobody came before the handoff's time ran out.
    NobodyCame,
}

/// Whether a handoff is over, from what the browser and its page say. `state` is the walked page's state when it was
/// last read (`None` between reads, or when it couldn't be read).
fn handoff_end(exited: bool, state: Option<&str>, past_deadline: bool) -> Option<HandoffEnd> {
    if exited {
        Some(HandoffEnd::Closed)
    } else if state == Some("ready") {
        Some(HandoffEnd::Finished)
    } else if past_deadline {
        Some(HandoffEnd::NobodyCame)
    } else {
        None
    }
}

/// Waits out a handoff and clears up after it, however it ends: `close` shuts the window (it is given how the
/// handoff ended), then the throwaway profile it was opened in is removed. What a person finished in a throwaway is
/// never adopted: nothing here gives it the remembered profile's name, so a window only ever answers the person who
/// used it, and windows and folders don't pile up (ENGINE-09.1). `exited` and `look` are the browser's and its page's
/// answers, passed in so a test needs no browser.
fn run_handoff(
    ttl: std::time::Duration,
    mut exited: impl FnMut() -> bool,
    mut look: impl FnMut() -> Option<String>,
    close: impl FnOnce(HandoffEnd),
    throwaway: Option<&str>,
) -> HandoffEnd {
    let deadline = std::time::Instant::now() + ttl;
    let end = loop {
        if let Some(end) = handoff_end(exited(), look().as_deref(), std::time::Instant::now() >= deadline) {
            break end;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    close(end);
    if let Some(dir) = throwaway {
        // A browser just gone can hold its files a moment longer.
        for attempt in 0..3 {
            match std::fs::remove_dir_all(dir) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) if attempt < 2 => std::thread::sleep(std::time::Duration::from_millis(200)),
                Err(e) => eprintln!("   [mint] the handoff's throwaway profile {dir} couldn't be removed ({e})"),
            }
        }
    }
    end
}

/// A window this process has left open for a person: the site it was opened at, and the word that tells it to close.
struct Waiting {
    site: String,
    give_way: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// The windows waiting for a person, the one that has waited longest first. A node asked again and again for a site
/// that wants a person would otherwise open a window each time: each waits out its own time, and a call that fails
/// every minute and a half keeps seven of them up for as long as it is asked (an owner's node was found holding 46).
static WAITING: std::sync::Mutex<Vec<Waiting>> = std::sync::Mutex::new(Vec::new());

/// The most windows that wait for a person at once, over every site. One person passes one check at a time; a window
/// past this takes the place of the one that has waited longest.
const MOST_WAITING: usize = 3;

/// What a walk does that would leave a window open for a person at `site`, given the sites windows already wait at
/// (longest first). `None`: one already waits at this site, and it is the window the person is to use, so this walk
/// opens no second. Otherwise the walk's window waits, and the answer is how many of the longest-waiting give way so
/// that no more than `most` wait.
fn admit(waiting: &[&str], site: &str, most: usize) -> Option<usize> {
    if waiting.contains(&site) {
        return None;
    }
    Some((waiting.len() + 1).saturating_sub(most.max(1)))
}

/// Takes a place among the waiting windows for a window at `site`, telling the longest-waiting to close if there
/// are too many. Answers the word this window is told to close by, or `None` when a window already waits at the site.
fn wait_for_a_person_at(site: &str) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
    let mut waiting = WAITING.lock().unwrap_or_else(|e| e.into_inner());
    let sites: Vec<&str> = waiting.iter().map(|w| w.site.as_str()).collect();
    let give_way = admit(&sites, site, MOST_WAITING)?;
    for gone in waiting.drain(..give_way) {
        gone.give_way.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let word = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    waiting.push(Waiting { site: site.to_string(), give_way: word.clone() });
    Some(word)
}

/// Gives up a window's place among the waiting: it has closed, however it came to.
fn no_longer_waiting(word: &std::sync::Arc<std::sync::atomic::AtomicBool>) {
    WAITING.lock().unwrap_or_else(|e| e.into_inner()).retain(|w| !std::sync::Arc::ptr_eq(&w.give_way, word));
}

/// The site a walk of `url` is at, as the waiting windows are told apart: its host.
fn site_walked(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).unwrap_or_else(|| url.to_string())
}

/// Leaves a headed browser open for a person, on a thread of its own: the walk's caller may drop its runtime as soon
/// as the walk returns, and the window must outlive it. The thread reads the walked tab (`target`) once a second over a
/// connection of its own; when the person finishes there, the window is closed through Chrome, so a remembered
/// profile writes what they did, and anything left is killed. `give_way` is its place among the waiting windows
/// ([`wait_for_a_person_at`]): told to give way, it closes as one nobody came to, and its place is given up when it
/// closes, however that happens.
fn leave_open_for_a_person(
    chrome: crate::cdp::chrome::ChromeProcess,
    target: Option<String>,
    throwaway: Option<String>,
    ttl: std::time::Duration,
    give_way: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    std::thread::spawn(move || {
        use crate::cdp::client::CdpClient;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().ok();
        let ws = chrome.ws_url.clone();
        let watcher = rt.as_ref().and_then(|rt| rt.block_on(CdpClient::connect(&ws)).ok());
        let mut page: Option<String> = None;
        let mut next_look = std::time::Instant::now();
        let mut look = || {
            let (Some(rt), Some(watcher), Some(target)) = (&rt, &watcher, &target) else { return None };
            if std::time::Instant::now() < next_look {
                return None;
            }
            next_look = std::time::Instant::now() + std::time::Duration::from_secs(1);
            rt.block_on(async {
                if page.is_none() {
                    page = watcher
                        .send_command("Target.attachToTarget", Some(serde_json::json!({ "targetId": target, "flatten": true })), None)
                        .await
                        .ok()
                        .and_then(|v| v.get("sessionId").and_then(|s| s.as_str()).map(String::from));
                }
                let state = page_state(watcher, page.as_deref()?).await;
                Some(state)
            })
        };
        // Both ends below reach the browser: one asks whether it is gone, the other closes it.
        let chrome = std::cell::RefCell::new(Some(chrome));
        let end = run_handoff(
            ttl,
            || give_way.load(std::sync::atomic::Ordering::Relaxed) || chrome.borrow_mut().as_mut().is_none_or(|c| c.has_exited()),
            &mut look,
            |end| {
                let Some(mut c) = chrome.borrow_mut().take() else { return };
                if end == HandoffEnd::Finished {
                    if let (Some(rt), Some(watcher)) = (&rt, &watcher) {
                        let _ = rt.block_on(watcher.send_command_no_params("Browser.close", None));
                    }
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                    while !c.has_exited() && std::time::Instant::now() < deadline {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                }
                // Kills and reaps whatever is left of the browser and its tree.
                drop(c);
            },
            throwaway.as_deref(),
        );
        no_longer_waiting(&give_way);
        if end == HandoffEnd::Finished {
            eprintln!("   [mint] the person finished in the window left open for them: it is closed");
        }
    });
}

/// A throwaway profile beside the remembered one, for asking the site whether
/// its refusal was about what the remembered browser held. It shares the
/// remembered profile's directory, so a rename can put it in its place.
fn fresh_beside(remembered: &str) -> String {
    let parent = std::path::Path::new(remembered)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    parent.join(uuid::Uuid::new_v4().to_string()).to_string_lossy().into_owned()
}

/// Where a replacement in progress is recorded, beside the profile it replaces.
fn replacing_record(remembered: &std::path::Path) -> std::path::PathBuf {
    let name = remembered.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    remembered.with_file_name(format!(".{name}.replacing"))
}

/// What is left to do for a replacement that stopped part way, from what stands on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Interrupted {
    /// The profile stands at its name: the replacement never started, or it finished. Only the record is left to go.
    Settled,
    /// The profile went aside and the accepted browser still waits: it takes the name, as it was going to.
    Finish,
    /// The profile went aside and the accepted browser is gone: the one set aside is all there is, so it comes back.
    Restore,
}

fn interrupted(remembered: bool, aside: bool, accepted: bool) -> Interrupted {
    match (remembered, accepted, aside) {
        (false, true, _) => Interrupted::Finish,
        (false, false, true) => Interrupted::Restore,
        _ => Interrupted::Settled,
    }
}

/// Finishes a replacement a process died in the middle of, so a walk never opens an empty profile at a name whose
/// browser is one rename away. A record that can't be read was never finished being written, and it is written before
/// anything moves, so nothing moved.
pub(crate) fn finish_replacing(remembered: &std::path::Path) {
    let record = replacing_record(remembered);
    let Ok(text) = std::fs::read_to_string(&record) else { return };
    let moves = serde_json::from_str::<serde_json::Value>(&text).ok();
    let path = |key: &str| moves.as_ref().and_then(|m| m.get(key)).and_then(|v| v.as_str()).map(std::path::PathBuf::from);
    if let (Some(aside), Some(accepted)) = (path("aside"), path("accepted")) {
        let moved = match interrupted(remembered.exists(), aside.exists(), accepted.exists()) {
            Interrupted::Finish => std::fs::rename(&accepted, remembered),
            Interrupted::Restore => std::fs::rename(&aside, remembered),
            Interrupted::Settled => Ok(()),
        };
        // The record stays while the move can't be made: it is all that says where the profile went.
        if let Err(e) = moved {
            eprintln!("   [mint] a replacement of {} that stopped part way can't be finished ({e})", remembered.display());
            return;
        }
    }
    let _ = std::fs::remove_file(&record);
}

/// What the site accepted takes the refused profile's place, so the next walk
/// opens from a browser the site agreed with. The refused one is kept, moved
/// under `refused/` in the same directory: it may hold a sign-in its owner wants
/// back, and a folder that is not a profile name keeps it out of the way.
///
/// Two renames can't be one, so what they will do is written down first: a process that dies between them leaves the
/// profile's name empty, and the next launch reads the record and finishes (`finish_replacing`).
///
/// Nothing ever removes a profile set aside on its own, since any one may hold a sign-in (ENGINE-01.4). Its folder is
/// noted in `index` (`paths::set_aside_index`), and `doctor` lists what is there, with size and age, for the owner.
fn replace_profile(remembered: &str, accepted: &str, index: &std::path::Path) {
    let path = std::path::Path::new(remembered);
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let aside = parent.join("refused").join(format!("{name}.{stamp}"));
    let record = replacing_record(path);
    // Nothing to set aside (a first walk, or the profile already gone): the accepted browser simply takes the name. A
    // profile that is there and can't be moved aside is kept as it is, with the clean browser left beside it: it may
    // hold a sign-in its owner wants back, so it is never deleted to make room.
    let there = path.exists();
    if there {
        let moves = serde_json::json!({ "aside": aside, "accepted": accepted }).to_string();
        let set_aside = std::fs::create_dir_all(aside.parent().unwrap_or(parent))
            .and_then(|()| write_synced(&record, &moves))
            .and_then(|()| std::fs::rename(remembered, &aside));
        if let Err(e) = set_aside {
            let _ = std::fs::remove_file(&record);
            eprintln!("   [mint] the site refused this browser's memory, but {remembered} couldn't be set aside ({e}): it is kept, and the clean browser stays at {accepted}");
            return;
        }
        if let Err(e) = note_set_aside(index, &parent.join("refused")) {
            eprintln!("   [mint] {} couldn't be noted for doctor to list ({e})", aside.display());
        }
    }
    if let Err(e) = std::fs::rename(accepted, remembered) {
        // The name must not stay empty: the next walk would open a new profile there, with the owner's out of sight.
        if there {
            let _ = std::fs::rename(&aside, remembered);
            let _ = std::fs::remove_file(&record);
        }
        eprintln!("   [mint] the clean browser at {accepted} couldn't take {remembered}'s place ({e})");
        return;
    }
    let _ = std::fs::remove_file(&record);
    eprintln!(
        "   [mint] the site refused this browser's memory; a clean browser took its place, the old one kept at {}",
        aside.display()
    );
}

/// Notes a `refused/` folder in the index, once.
fn note_set_aside(index: &std::path::Path, refused: &std::path::Path) -> std::io::Result<()> {
    use std::io::Write as _;
    let line = refused.to_string_lossy();
    let known = std::fs::read_to_string(index).unwrap_or_default();
    if known.lines().any(|l| l == line) {
        return Ok(());
    }
    if let Some(dir) = index.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(index)?;
    writeln!(file, "{line}")
}

/// A profile kept under `refused/` after a site refused it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetAside {
    pub path: std::path::PathBuf,
    /// What it holds on disk, every file under it.
    pub bytes: u64,
    /// How long ago it was set aside: from the stamp in its name (`<profile>.<seconds>`), else its folder's time.
    pub age_secs: u64,
}

/// Every profile kept in the `refused/` folders `index` names, oldest first. Only reads: the owner decides what goes.
pub fn set_aside_profiles(index: &std::path::Path, now: std::time::SystemTime) -> Vec<SetAside> {
    let now_secs = now.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let known = std::fs::read_to_string(index).unwrap_or_default();
    let mut kept: Vec<SetAside> = Vec::new();
    for folder in known.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(entries) = std::fs::read_dir(folder) else { continue };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let stamp = name.rsplit_once('.').and_then(|(_, s)| s.parse::<u64>().ok()).or_else(|| {
                let made = entry.metadata().ok()?.modified().ok()?;
                made.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs())
            });
            kept.push(SetAside {
                path: entry.path(),
                bytes: size_under(&entry.path()),
                age_secs: stamp.map(|s| now_secs.saturating_sub(s)).unwrap_or(0),
            });
        }
    }
    kept.sort_by(|a, b| b.age_secs.cmp(&a.age_secs).then_with(|| a.path.cmp(&b.path)));
    kept
}

/// The bytes of every file under `dir`, links not followed.
fn size_under(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => size_under(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Writes `text` to `path` and waits for the disk, so nothing that follows can reach it first.
fn write_synced(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut file = std::fs::File::create(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

/// How long past its settle time a walk waits for the page's data calls already sent to answer.
const IN_FLIGHT_GRACE: std::time::Duration = std::time::Duration::from_millis(5_000);

/// How long past its settle time a walk waits for what the page is plainly still doing (`Open::still_asking`).
const ASKING_GRACE: std::time::Duration = std::time::Duration::from_millis(25_000);

/// How long past its settle time a walk waits for the page's scripts still arriving. Shorter: a script the network
/// never delivers (a host that does not resolve) says nothing more by being waited for.
const SCRIPT_GRACE: std::time::Duration = std::time::Duration::from_millis(8_000);

/// How long after one of those ends the page is given to act on it: a script that has arrived runs and sends the
/// page's calls, and an answer that has arrived may be followed by the next call.
const ACT_ON_IT: std::time::Duration = std::time::Duration::from_millis(1_200);

/// What a walk still has open once its settle time is up, and so whether the page has been answered. A walk that
/// ends on its clock alone learns from the page's shell on a slow load: the call that answers was sent and not yet
/// answered, or its scripts had not all arrived and it was never sent.
#[derive(Default, Clone)]
struct Open {
    /// Every data call sent and not yet finished.
    calls: std::collections::HashSet<String>,
    /// Of what is open, what says the page is still asking: a data call that sends what the page's address was asked
    /// (the page asking for its answer), and a data call whose answer has begun and is still arriving (a stream). A
    /// call that sends the page's whole address is reporting the page, not asking for it.
    asking: std::collections::HashSet<String>,
    /// The page's scripts still arriving over the network: it has not run them yet. A script the page made itself
    /// (`blob:`) arrives from nowhere and is never reported as finished.
    scripts: std::collections::HashSet<String>,
    /// When the last of those ended.
    last_done: Option<tokio::time::Instant>,
    /// When the page, in any of its contexts (its frames, its workers), last sent something that can carry or fetch
    /// data: a call, a script, a document. What it fetches to show (an image, a font) is not the page reading on.
    last_sent: Option<tokio::time::Instant>,
}

impl Open {
    /// Notes one of the browser's network events. `asked` is what the walked address holds (`asked_of`).
    fn note(&mut self, v: &serde_json::Value, page: &str, asked: &[String], now: tokio::time::Instant) {
        let id = v.pointer("/params/requestId").and_then(|r| r.as_str()).unwrap_or_default().to_string();
        // A request one of the browser's own pages made (its new-tab page, at `chrome://` or `chrome-untrusted://`) is
        // not the walked page's: the page's answer never waits on it. A new-tab page's bar asked for its data and its
        // scripts and never heard back, and the walk sat out the whole grace for them, 6 s of a 15 s walk.
        let by_the_browser = v.pointer("/params/documentURL").and_then(|d| d.as_str()).is_some_and(|d| !d.starts_with("http"));
        match v.get("method").and_then(|m| m.as_str()).unwrap_or_default() {
            "Network.requestWillBeSent" if by_the_browser => {}
            "Network.requestWillBeSent" => {
                let kind = v.pointer("/params/type").and_then(|t| t.as_str());
                if matches!(kind, Some("XHR" | "Fetch" | "Script" | "Document" | "EventSource" | "WebSocket")) {
                    self.last_sent = Some(now);
                }
                self.note_sent(v, kind, id, page, asked);
            }
            // An answer that has begun: until it ends, it is arriving.
            "Network.responseReceived" if self.calls.contains(&id) => {
                self.asking.insert(id);
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                self.calls.remove(&id);
                if self.asking.remove(&id) | self.scripts.remove(&id) {
                    self.last_done = Some(now);
                }
            }
            _ => {}
        }
    }

    /// Notes a request the walked page sent, of Chrome's `kind`.
    fn note_sent(&mut self, v: &serde_json::Value, kind: Option<&str>, id: String, page: &str, asked: &[String]) {
        match kind {
            Some("XHR" | "Fetch") => {
                let sent = format!("{} {}", v.pointer("/params/request/url").and_then(|u| u.as_str()).unwrap_or_default(), v.pointer("/params/request/postData").and_then(|p| p.as_str()).unwrap_or_default());
                if carries_what_was_asked(&sent, asked) && !reports_the_page(&sent, page) {
                    self.asking.insert(id.clone());
                }
                self.calls.insert(id);
            }
            Some("Script") if v.pointer("/params/request/url").and_then(|u| u.as_str()).is_some_and(|u| u.starts_with("http")) => {
                self.scripts.insert(id);
            }
            _ => {}
        }
    }

    /// Whether a nudge made at `nudged` left the page doing nothing: it sent nothing since, in any context, and nothing
    /// it asked is still open or just answered. A reader who scrolls to the end and sees nothing come has read the page.
    fn did_nothing_since(&self, nudged: tokio::time::Instant, now: tokio::time::Instant) -> bool {
        let acting = self.last_done.is_some_and(|at| now.duration_since(at) < ACT_ON_IT);
        self.last_sent.is_none_or(|at| at < nudged) && self.asking.is_empty() && self.scripts.is_empty() && !acting
    }

    /// Whether the walk waits on, `past` its settle time: for what the page is still asking, and a moment after each
    /// ends, up to `ASKING_GRACE`; for any other data call on its way, up to `IN_FLIGHT_GRACE`.
    fn holds(&self, past: std::time::Duration, now: tokio::time::Instant) -> bool {
        let acting = self.last_done.is_some_and(|at| now.duration_since(at) < ACT_ON_IT);
        ((!self.asking.is_empty() || acting) && past < ASKING_GRACE) || (!self.scripts.is_empty() && past < SCRIPT_GRACE) || (!self.calls.is_empty() && past < IN_FLIGHT_GRACE)
    }
}

/// What a page's address was asked: each value of its query and each piece of its path, of three characters or more.
/// Shorter says nothing: any call may send a `2` or an `en`.
fn asked_of(url: &str) -> Vec<String> {
    let Ok(u) = url::Url::parse(url) else { return Vec::new() };
    let pieces = u.path_segments().into_iter().flatten().map(|p| percent_decoded(p));
    u.query_pairs().map(|(_, v)| v.into_owned()).chain(pieces).map(|v| v.to_lowercase()).filter(|v| v.chars().count() >= 3).collect()
}

fn percent_decoded(text: &str) -> String {
    url::form_urlencoded::parse(format!("v={}", text.replace('+', "%2B")).as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default()
}

/// Whether a request sends the walked page's own address, as it is or encoded: an error report, a beacon, an ad
/// request. It tells someone about the page; it does not ask for the page's answer.
fn reports_the_page(sent: &str, page: &str) -> bool {
    let Some((_, address)) = page.split_once("://") else { return false };
    let address = address.to_lowercase();
    let plain = sent.to_lowercase();
    plain.contains(&address) || percent_decoded(&plain.replace('+', " ")).contains(&percent_decoded(&address))
}

/// Whether a request, as its address and its body, sends one of the values the page was asked, however it is
/// written: as it is, or encoded for an address.
fn carries_what_was_asked(sent: &str, asked: &[String]) -> bool {
    let plain = sent.to_lowercase();
    let decoded = percent_decoded(&plain.replace('+', " "));
    asked.iter().any(|v| plain.contains(v.as_str()) || decoded.contains(v.as_str()))
}

/// Mint a session: walk one URL in a real browser and hand back everything the
/// walk issued — cookies and widget tokens — for plain HTTP to carry.
///
/// This is the whole browser dependency in one call: launch, navigate, wait,
/// harvest. An unresolved challenge returns an error, never a partial jar.
/// Headed browsers remain open for a human handoff until the person gets through
/// (the window then closes), closes it, or the handoff times out
/// ([`crate::cdp::chrome::HANDOFF_TTL`]), so a walk nobody finishes never keeps a
/// browser running forever; attached browsers are always
/// left under their original owner's control.
pub async fn mint(opts: MintOptions) -> Result<MintedSession, String> {
    // How many browsers one walk may ask the site in: the remembered one, one that remembers nothing, a window, and a
    // window that remembers nothing. A site that refuses all four has answered in every browser the walk can be, and
    // asking again is the loop the door wait and the retries exist to end.
    // A walk whose caller has already given up launches nothing.
    if asked_to_stop(&opts) {
        return Err(STOPPED.to_string());
    }
    mint_at(opts, 0).await
}

/// [`mint`] with the asks it has already made: a recursive walk counts them, so a site that keeps refusing ends in an
/// answer instead of a new browser.
async fn mint_at(opts: MintOptions, asked: u8) -> Result<MintedSession, String> {
    use crate::cdp::chrome::{launch_chrome, LaunchOptions};
    use crate::cdp::client::CdpClient;

    // Attach when the caller names a browser, launch only when it does not.
    let (client, launched) = match &opts.cdp_endpoint {
        Some(endpoint) => {
            let ws = if endpoint.starts_with("ws://") || endpoint.starts_with("wss://") {
                endpoint.clone()
            } else {
                // An http endpoint: ask it for its browser websocket.
                let base = endpoint.trim_end_matches('/');
                let body = reqwest::get(format!("{base}/json/version"))
                    .await
                    .map_err(|e| format!("cdp endpoint: {e}"))?
                    .text()
                    .await
                    .map_err(|e| format!("cdp endpoint: {e}"))?;
                serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("webSocketDebuggerUrl").and_then(|u| u.as_str()).map(String::from))
                    .ok_or("cdp endpoint has no webSocketDebuggerUrl")?
            };
            (CdpClient::connect(&ws).await?, None)
        }
        None => {
            let mut launch = LaunchOptions::default();
            launch.headless = !opts.headed || opts.windowless;
            launch.profile = opts.profile.clone();
            launch.args = opts.args.clone();
            launch.executable_path = opts.executable_path.clone();
            let chrome = launch_chrome(&launch)?;
            (CdpClient::connect(&chrome.ws_url).await?, Some(chrome))
        }
    };
    let client = std::sync::Arc::new(client);
    let mut chrome = launched;

    // Which page session to walk: when attaching, open our own tab so the
    // human's open tabs are untouched; when launching, the browser's first
    // page (Chrome replaces its initial about:blank target as it starts, so
    // list and attach together, and retry).
    let mut session_id = String::new();
    let mut own_tab: Option<String> = None;
    if opts.cdp_endpoint.is_some() {
        if let Ok(created) = client
            .send_command(
                "Target.createTarget",
                Some(serde_json::json!({ "url": "about:blank" })),
                None,
            )
            .await
        {
            if let Some(id) = created.get("targetId").and_then(|v| v.as_str()) {
                own_tab = Some(id.to_string());
                if let Ok(attached) = client
                    .send_command(
                        "Target.attachToTarget",
                        Some(serde_json::json!({ "targetId": id, "flatten": true })),
                        None,
                    )
                    .await
                {
                    if let Some(sid) = attached.get("sessionId").and_then(|v| v.as_str()) {
                        session_id = sid.to_string();
                    }
                }
            }
        }
    }
    for attempt in 0..5 {
        if !session_id.is_empty() {
            break;
        }
        let targets = client
            .send_command("Target.getTargets", Some(serde_json::json!({})), None)
            .await?;
        let page_ids: Vec<String> = targets
            .pointer("/targetInfos")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|t| t.get("type").and_then(|x| x.as_str()) == Some("page"))
                    .filter_map(|t| t.get("targetId").and_then(|x| x.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        for page_id in page_ids {
            if let Ok(attached) = client
                .send_command(
                    "Target.attachToTarget",
                    Some(serde_json::json!({ "targetId": page_id, "flatten": true })),
                    None,
                )
                .await
            {
                if let Some(id) = attached.get("sessionId").and_then(|v| v.as_str()) {
                    session_id = id.to_string();
                    break;
                }
            }
        }
        if session_id.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(300 * (attempt + 1))).await;
        }
    }

    if session_id.is_empty() {
        if let Some(c) = chrome.as_mut() {
            c.kill();
        }
        return Err("no attachable page target".to_string());
    }

    let walked = walk_tab(&client, &session_id, &mut chrome, &opts, asked).await;
    // The tab the walk opened in someone else's browser closes with the walk: a burst of walks must not leave a tab
    // each. Only a door left for a person to pass keeps its tab open: a plain refusal or a page that never answered
    // shows them nothing to do.
    if let Some(id) = own_tab {
        if !walked.as_ref().is_err_and(|e| e.starts_with("mint unresolved (challenge)")) {
            let _ = client.send_command("Target.closeTarget", Some(serde_json::json!({ "targetId": id })), None).await;
        }
    }
    walked
}

/// Runs before the page's own scripts: records what they fingerprint the browser with — a canvas drawn and read
/// back, a WebGL parameter, the image data behind a canvas hash. A signing bridge replays these, so the page's
/// producer sees the same sample the walk's browser showed it.
const FINGERPRINT_PROBE: &str = r#"(() => {
  const fp = (window.__unbrowse_fp = window.__unbrowse_fp || { canvas: [], webgl: {}, pixels: null });
  const keep = (v) => { try { if (typeof v === 'string' && v.length && fp.canvas.length < 4 && fp.canvas.indexOf(v) < 0) fp.canvas.push(v); } catch (e) {} };
  try { const t = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = function () { const v = t.apply(this, arguments); keep(v); return v; }; } catch (e) {}
  try { const g = CanvasRenderingContext2D.prototype.getImageData; CanvasRenderingContext2D.prototype.getImageData = function () { const v = g.apply(this, arguments); try { if (!fp.pixels && v && v.data) { fp.pixels = Array.from(v.data.slice(0, 64)); fp.pixelsAt = [v.width, v.height]; } } catch (e) {} return v; }; } catch (e) {}
  try { const p = WebGLRenderingContext.prototype.getParameter; WebGLRenderingContext.prototype.getParameter = function (n) { const v = p.call(this, n); try { fp.webgl[String(n)] = (v && v.length !== undefined) ? Array.from(v) : v; } catch (e) {} return v; }; } catch (e) {}
  try { const p = WebGL2RenderingContext.prototype.getParameter; WebGL2RenderingContext.prototype.getParameter = function (n) { const v = p.call(this, n); try { fp.webgl[String(n)] = (v && v.length !== undefined) ? Array.from(v) : v; } catch (e) {} return v; }; } catch (e) {}
})();"#;

/// The sample the page left: what the probe recorded, and the fields every fingerprint script reads.
/// The page's own signing, as it happens: for each request header its code sets, the last string it built (a producer
/// hashes a joined tuple, and the page builds it with `concat`), the header, and the call. Bounded and narrow: only a
/// header whose value reads like a signature (a hash, a token, a request id) and only strings holding a separator.
/// `UNBROWSE_SIGN_PROBE=1` installs it for a walk; a route's recipe is fitted from it.
const SIGN_PROBE: &str = r#"(() => {
  try { window.__ub_sign = []; window.__ub_last = ''; } catch (e) {}
  const worth = (k) => /(sig|sign|token|auth|req|nonce|payload|key|ts|time)/i.test(String(k));
  const orig = String.prototype.concat;
  String.prototype.concat = function (...args) {
    const out = orig.apply(this, args);
    try { if (typeof out === 'string' && out.length < 4096 && out.indexOf(';') >= 0) window.__ub_last = out; } catch (e) {}
    return out;
  };
  // What a header's payload was before it was encoded: a base64 header (a packed blob) holds the string its code
  // encoded, and that string is what a recipe would have to rebuild. Kept in order, so the one a header carries is
  // found by containment.
  try { window.__ub_b64 = []; } catch (e) {}
  const btoaOrig = window.btoa;
  window.btoa = function (v) {
    const out = btoaOrig.apply(this, arguments);
    try { if (window.__ub_b64.length < 400) window.__ub_b64.push([String(v), out]); } catch (e) {}
    return out;
  };
  const inner = (v) => {
    try {
      const s = String(v);
      for (let i = (window.__ub_b64 || []).length - 1; i >= 0; i--) {
        const p = window.__ub_b64[i];
        if (p[1] && s.indexOf(p[1]) >= 0) return p[0];
      }
    } catch (e) {}
    return '';
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { try { this.__ub_url = String(u); } catch (e) {} return open.apply(this, arguments); };
  const set = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (worth(k) && window.__ub_sign.length < 600) window.__ub_sign.push([String(k), String(v), this.__ub_url || '', window.__ub_last || '', inner(v)]); } catch (e) {}
    return set.apply(this, arguments);
  };
  const f = window.fetch;
  window.fetch = function (i, init) {
    try {
      const url = typeof i === 'string' ? i : (i && i.url) || '';
      const hh = (init && init.headers) || (i && i.headers);
      const put = (k, v) => { if (worth(k) && window.__ub_sign.length < 600) window.__ub_sign.push([String(k), String(v), String(url), window.__ub_last || '', inner(v)]); };
      if (hh) {
        if (typeof hh.forEach === 'function' && !Array.isArray(hh)) hh.forEach((v, k) => put(k, v));
        else if (Array.isArray(hh)) hh.forEach(([k, v]) => put(k, v));
        else Object.keys(hh).forEach((k) => put(k, hh[k]));
      }
    } catch (e) {}
    return f.apply(this, arguments);
  };
})();"#;

const FINGERPRINT_READ: &str = "JSON.stringify(Object.assign({}, window.__unbrowse_fp || {}, {screen: {width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth}, dpr: devicePixelRatio, lang: navigator.language, langs: navigator.languages, platform: navigator.platform, vendor: navigator.vendor, cores: navigator.hardwareConcurrency, touch: navigator.maxTouchPoints, tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || ''), ua: navigator.userAgent, uaData: (navigator.userAgentData ? { brands: (navigator.userAgentData.brands || []).map((b) => ({ brand: b.brand, version: b.version })), mobile: !!navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null)}))";

/// The walk itself, in the page session the mint chose.
async fn walk_tab(
    client: &std::sync::Arc<crate::cdp::client::CdpClient>,
    session_id: &String,
    chrome: &mut Option<crate::cdp::chrome::ChromeProcess>,
    opts: &MintOptions,
    asked: u8,
) -> Result<MintedSession, String> {
    // A walk with the network off would land with no calls and say nothing of why.
    client
        .send_command(
            "Network.enable",
            Some(serde_json::json!({})),
            Some(&session_id),
        )
        .await?;
    // Subscribe before navigating: the walk's first exchange is the page
    // itself, and a subscription made after the navigation misses it.
    let mut events = client.relay();
    let mut missed: u64 = 0;
    // Whether the browser's line ended before the walk did: then the record is not whole.
    let mut cut_off = false;
    client
        .send_command(
            "Page.enable",
            Some(serde_json::json!({})),
            Some(&session_id),
        )
        .await?;
    // Workers and out-of-process frames make calls of their own: attach to them as they start, so their traffic is
    // in the walk too (a signed call made inside a worker is otherwise invisible). Flattened, so one connection
    // carries every session's events.
    //
    // A task of its own turns each one's network on the moment it starts. The walk's loop reads events one at a time
    // and waits on the browser between them, so a worker whose network were turned on from there would have made its
    // first call before anyone was reading: the call a worker makes as it starts would not be in the walk.
    //
    // Even turned on at once, a worker that calls as it starts can call before its network is on: Chrome hears the
    // answer and never the request, and the walk holds no call to learn (a matrix row failed 2 runs in 10 so, on a
    // loaded machine). So a worker is held at its first line until its own network is on, then let run, by this task,
    // never by the walk's loop, and for no longer than `HOLD_A_WORKER`, so a walk slow to read its events never stalls
    // the page. A frame is never held: it is let run the moment it is announced, as before (a frame of a start page
    // once took 14 s to turn on, and its page would have stalled that long). Once the walk ends, nothing new is held.
    //
    // Each context is turned on by itself ([`EachByItself`]): a frame whose network takes seconds to answer (a start
    // page's own frame did, 14 s) never holds up the worker announced after it, whose first call would go by unseen.
    //
    // Each such session, and what Chrome says it is (`worker`, `iframe`, `service_worker`).
    let contexts: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>> = Default::default();
    let _attaching = {
        let (client, contexts, mut started) = (client.clone(), contexts.clone(), client.relay());
        // Stopped with the walk, however it ends: nothing more is attached to for it, and what is being turned on
        // stops with it.
        StopsWithTheWalk(tokio::spawn(async move {
            let mut each = EachByItself::default();
            while let Some(next) = started.recv().await {
                let Ok(msg) = next else { continue };
                if !msg.text.contains("\"Target.attachedToTarget\"") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg.text) else { continue };
                let Some(child) = v.pointer("/params/sessionId").and_then(|s| s.as_str()).map(String::from) else { continue };
                let kind = v.pointer("/params/targetInfo/type").and_then(|t| t.as_str()).unwrap_or("other").to_string();
                let held = is_a_worker(&kind);
                if let Ok(mut known) = contexts.lock() {
                    known.insert(child.clone(), kind);
                }
                let client = client.clone();
                each.start(async move {
                    let child = child.as_str();
                    let run = || client.send_command("Runtime.runIfWaitingForDebugger", Some(serde_json::json!({})), Some(child));
                    if !held {
                        let _ = run().await;
                    }
                    let turn_on = async {
                        let _ = client.send_command("Network.enable", Some(serde_json::json!({})), Some(child)).await;
                        // Its code is read as the page's is (`learn.record`).
                        read_the_pages_code(&client, child).await;
                    };
                    if held {
                        let _ = tokio::time::timeout(HOLD_A_WORKER, turn_on).await;
                        let _ = run().await;
                    } else {
                        turn_on.await;
                    }
                    // A worker may start a worker, held the same way.
                    let _ = client
                        .send_command(
                            "Target.setAutoAttach",
                            Some(serde_json::json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })),
                            Some(child),
                        )
                        .await;
                });
            }
        }))
    };
    let context_of = |session: &str| contexts.lock().ok().and_then(|known| known.get(session).cloned());
    if let Err(e) = client
        .send_command(
            "Target.setAutoAttach",
            Some(serde_json::json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })),
            Some(&session_id),
        )
        .await
    {
        eprintln!("[mint] workers weren't attached: {e}");
    }
    // The probe goes in before any page script, so the page's own fingerprinting is what is recorded.
    if let Err(e) = client
        .send_command(
            "Page.addScriptToEvaluateOnNewDocument",
            Some(serde_json::json!({ "source": own(FINGERPRINT_PROBE) })),
            Some(&session_id),
        )
        .await
    {
        eprintln!("[mint] the fingerprint probe wasn't installed: {e}");
    }
    // What the page's own code built when it signed (`UNBROWSE_SIGN_PROBE=1`): the input of a signed header, so a
    // route can carry the computation rather than the code.
    if std::env::var_os("UNBROWSE_SIGN_PROBE").is_some() {
        if let Err(e) = client
            .send_command(
                "Page.addScriptToEvaluateOnNewDocument",
                Some(serde_json::json!({ "source": own(SIGN_PROBE) })),
                Some(&session_id),
            )
            .await
        {
            eprintln!("[mint] the signing probe wasn't installed: {e}");
        }
    }
    // The page's code, read the way DevTools reads it (`learn.record`): each script it parses, the stack behind each
    // request, and its storage. The walk's own probes above go by the walk's name, so the script list leaves them out.
    read_the_pages_code(client, session_id).await;
    let _ = client.send_command("DOMStorage.enable", Some(serde_json::json!({})), Some(&session_id)).await;

    // The browser's own identity, before the page reads it: a launch mode is
    // not a product, and a page that can see the mode knows the session is
    // machine-driven before any script runs.
    if let Err(e) = crate::fingerprint::apply_browser_identity(&client, &session_id).await {
        eprintln!("[identity] {e}");
    }
    // A window is bigger than its page and fits on a screen. Headless reports
    // the opposite of both, which no real display produces.
    if let Err(e) =
        crate::fingerprint::apply_window_metrics(&client, &session_id, (1280, 720)).await
    {
        eprintln!("[identity] {e}");
    }

    // Fetch interception: every HTTP request goes through Rust with DNS pinning
    // and public-IP validation. The browser cannot connect out on its own.
    // Off unless asked for: the connection is part of what the browser is,
    // and a request answered from Rust carries Rust's handshake, not Chrome's.
    let _intercept = if opts.intercept {
        let tap = client.subscribe_methods(&["Fetch.requestPaused"]);
        match crate::intercept::enable_fetch_interception(&client, &session_id).await {
            Ok(()) => Some(crate::intercept::InterceptGuard::new(
                crate::intercept::spawn_intercept_loop(
                    std::sync::Arc::clone(&client),
                    session_id.clone(),
                    tap,
                ),
            )),
            // Asked for, interception is what checks each request resolves to a public address: a walk without it
            // would open the page over the browser's own connections, the ones the caller asked to have checked.
            Err(e) => {
                return Err(format!(
                    "interception was asked for and the browser refused it (Fetch.enable: {e}); the page wasn't opened"
                ))
            }
        }
    } else {
        None
    };

    // The session the caller keeps for the site, before the page asks for it.
    if !opts.cookies.is_empty() {
        if let Err(e) = client.send_command("Network.setCookies", Some(seed_params(&opts.cookies, &opts.url)), Some(&session_id)).await {
            eprintln!("[mint] the walk starts without the site's session: {e}");
        }
    }

    // Pictures for whoever watches the walk: started before the page, so the first paint is in them.
    let mut cast = match opts.frames.clone() {
        Some(sink) => crate::screencast::Screencast::start(&client, &session_id, sink).await,
        None => None,
    };
    client
        .send_command(
            "Page.navigate",
            Some(serde_json::json!({ "url": opts.url })),
            Some(&session_id),
        )
        .await?;

    // The walk: let the page load, run its scripts, and settle — recording the
    // requests the browser makes, so a caller can replay the exact shape the
    // site's door expects (its headers, not merely its cookies).
    let mut log = opts
        .capture_dir
        .as_ref()
        .and_then(|dir| CaptureLog::open_in(dir, &opts.session));
    if let Some(log) = log.as_mut() {
        log.write(serde_json::json!({
            "type": "mint",
            "url": opts.url,
            "t": now_secs(),
        }));
        // This capture records every address the walk's browser was at (`address` and `target` lines, below), and ends
        // with a line that counts them (`addresses_end`): a reader takes the record as whole only with that line.
        log.write(serde_json::json!({ "type": "addresses", "recorded": true, "t": now_secs() }));
    }
    // Wait for the door, not for the clock: a challenge page runs its own
    // script and reloads when it passes, so a fixed wait harvests the
    // challenge. Poll the document until it is no longer a challenge (or the
    // caller's settle time runs out), and only then harvest. A challenge gets
    // a door's own budget: a non-interactive check that resolves on its own
    // takes far longer than a page's settle (a headed browser often needs
    // 15–20 s), and reading it at the settle window harvests the challenge.
    // A refusal is the site's answer already, and waiting changes nothing.
    let settled_at = tokio::time::Instant::now() + std::time::Duration::from_millis(opts.settle_ms.max(3_000));
    let door_deadline = tokio::time::Instant::now() + DOOR_WAIT;
    let mut pass_deadline = settled_at;
    loop {
        if asked_to_stop(opts) {
            return Err(STOPPED.to_string());
        }
        if tokio::time::Instant::now() >= pass_deadline || events.line_closed() {
            break;
        }
        match page_state(&client, &session_id).await.as_str() {
            "ready" => break,
            "refused" => break,
            "challenge" => pass_deadline = pass_deadline.max(door_deadline),
            _ => {}
        }
        match cast.as_mut() {
            Some(c) => c.pump(&client, &session_id, std::time::Duration::from_millis(400)).await,
            None => tokio::time::sleep(std::time::Duration::from_millis(400)).await,
        }
    }
    if let Some(c) = cast.as_mut() {
        c.stop_pumping();
    }
    // What the page keeps in its storage once it has settled: a value a call sends can come from there.
    if let Some(log) = log.as_mut() {
        for line in storage_lines(client, session_id, "settle").await {
            log.write(line);
        }
    }

    let mut awaiting_body: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    // How many address and target lines the walk wrote: its closing line says so.
    let mut addresses_written: u64 = 0;
    // The body text this walk keeps, in all (`WALK_BODIES_CAP`).
    let mut kept_bodies = KeptBodies::default();
    // The session each logged request came from: its body is read on that session, not the page's.
    let mut request_sessions: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // Anti-forgery tokens the page sent in its calls' headers (`csrf-token`, `x-xsrf-token`): session values like
    // its cookies, bound to them, and often handed to the page where no response shows them on their own. Each is
    // kept with the host its call went to, in the order sent, so only the walked host's are harvested.
    let mut header_tokens: Vec<(String, String, String)> = Vec::new();
    // The hashes of the script bodies already written: a body is kept once per walk, however often it is parsed.
    let mut kept_scripts: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut deadline = tokio::time::Instant::now()
        + std::time::Duration::from_millis(opts.settle_ms.max(3_000));
    // Browsing: a nudge every 1.5 s, up to four, each giving the page time to answer before the walk ends.
    let nudge_every = std::time::Duration::from_millis(1_500);
    let mut next_nudge = tokio::time::Instant::now() + nudge_every;
    let mut nudges = 0;
    // When the last nudge was made: browsing ends at the next nudge's turn when that one made the page do nothing.
    let mut nudged_at: Option<tokio::time::Instant> = None;
    // Trying the page's controls, once browsing is done: what has been tried, the one to put back, and the page's path.
    let (mut tried, mut undo, mut home): (Vec<String>, Option<String>, Option<String>) = (Vec::new(), None, None);
    let (mut tries, mut trying) = (0, opts.try_controls);
    let mut next_try = tokio::time::Instant::now();
    // The page's own data calls still on their way: the walk waits for them past its settle time, up to
    // `IN_FLIGHT_GRACE`, so a page that asks for its data a moment late is learned from its data, not its shell.
    // And for what the page is plainly still doing, longer (`Open`): the walk ends when the page has been answered.
    let mut open = Open::default();
    let page_asked = asked_of(&opts.url);
    let settle_at = deadline;
    loop {
        let now = tokio::time::Instant::now();
        if asked_to_stop(opts) {
            return Err(STOPPED.to_string());
        }
        if now >= deadline {
            if open.holds(now.saturating_duration_since(settle_at), now) && !events.line_closed() {
                deadline = now + std::time::Duration::from_millis(250);
                continue;
            }
            break;
        }
        if opts.browse && nudges < 4 && now >= next_nudge && nudged_at.is_some_and(|at| open.did_nothing_since(at, now)) {
            // The last nudge made the page do nothing, in any of its contexts, and nothing it asked is still open: it
            // has no more to give, and the walk ends here rather than at its fixed settle time and three nudges more.
            if let Some(log) = log.as_mut() {
                log.write(serde_json::json!({ "type": "walk_end", "t": now_secs(), "why": "the last nudge made the page do nothing" }));
            }
            nudges = 4;
            if !trying {
                deadline = now;
            }
            continue;
        }
        if opts.browse && nudges < 4 && now >= next_nudge {
            nudged_at = Some(now);
            let did = client
                .send_command("Runtime.evaluate", Some(serde_json::json!({ "expression": own(NUDGE), "returnByValue": true })), Some(&session_id))
                .await
                .ok()
                .and_then(|r| r.pointer("/result/value").and_then(|v| v.as_str()).map(String::from));
            // What the walk did to the page, beside what the page then sent: a call made only after a nudge is the
            // page reading on, and a nudge that did nothing says the page had no more to give.
            if let Some(log) = log.as_mut() {
                log.write(serde_json::json!({ "type": "nudge", "t": now_secs(), "did": did.unwrap_or_else(|| "nothing: the page did not answer".into()) }));
            }
            nudges += 1;
            next_nudge = now + nudge_every;
            deadline = deadline.max(now + std::time::Duration::from_millis(2_500));
            continue;
        }
        let browsing = opts.browse && nudges < 4;
        if trying && !browsing && now >= next_try {
            let said = client
                .send_command("Runtime.evaluate", Some(serde_json::json!({ "expression": own(&try_control(&tried, undo.as_deref(), home.as_deref())), "returnByValue": true })), Some(&session_id))
                .await
                .ok()
                .and_then(|r| r.pointer("/result/value").and_then(|v| v.as_str()).and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()))
                .unwrap_or_else(|| serde_json::json!({ "done": true }));
            tries += 1;
            undo = said["undo"].as_str().map(String::from);
            home = home.or_else(|| said["home"].as_str().map(String::from));
            tried.extend(said["tried"].as_str().map(String::from));
            trying = tries < MOST_TRIES && said["done"].is_null() && said["left"].is_null();
            next_try = now + TRY_EVERY;
            deadline = deadline.max(now + TRY_EVERY * 2);
            continue;
        }
        let wait_until = match (browsing, trying) {
            (true, _) => deadline.min(next_nudge),
            (false, true) => deadline.min(next_try),
            _ => deadline,
        };
        // A walk that can be stopped looks at its flag at least this often, however quiet the page.
        let wait_until = if opts.stop.is_some() { wait_until.min(now + STOP_LOOKS_EVERY) } else { wait_until };
        match tokio::time::timeout(wait_until - now, events.recv()).await {
            Ok(Some(Ok(msg))) => {
                // Which session the event is from: the page's, or a worker's/out-of-process frame's. Its requests
                // are logged under the session's name so a same-numbered request on another session never pairs
                // with the wrong answer.
                let event_session = msg.session_id.clone().unwrap_or_else(|| session_id.clone());
                // A message that doesn't read is an event the walk lost: it may have been a move to an address with a
                // fragment, so it is counted with the events the relay dropped (`missed`), and the record's close says so.
                if event_lost(&msg.text) {
                    missed += 1;
                    continue;
                }
                // A session attaching (its network and code are turned on by the walk's own task, `_attaching`): an
                // out-of-process frame says where it navigates only once asked to, so every address the walk's browser
                // was at is recorded, a frame's included. The target's own address as it attached, and whether its moves
                // can be recorded: a frame or a page that can't be asked is said to be so, and a reader reads the walk as
                // one that can't say where it was. A worker has no such domain.
                if msg.text.contains("Target.attachedToTarget") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg.text) {
                        if let Some(child) = v.pointer("/params/sessionId").and_then(|x| x.as_str()) {
                            let info = v.pointer("/params/targetInfo").cloned().unwrap_or_default();
                            let kind = info.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_string();
                            let navigates = matches!(kind.as_str(), "iframe" | "page");
                            let enabled = !navigates || client.send_command("Page.enable", Some(serde_json::json!({})), Some(child)).await.is_ok();
                            if let Some(log) = log.as_mut() {
                                log.write(serde_json::json!({ "type": "target", "t": now_secs(), "session": child, "kind": kind, "url": info.get("url").cloned().unwrap_or_default() }));
                                addresses_written += 1;
                                if !enabled {
                                    log.write(serde_json::json!({ "type": "address_off", "t": now_secs(), "session": child }));
                                }
                            }
                        }
                    }
                }
                if msg.text.contains("\"Network.") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg.text) {
                        open.note(&v, &opts.url, &page_asked, now);
                    }
                }
                if let Some(c) = cast.as_mut() {
                    c.tick();
                    if msg.text.contains("\"Page.screencastFrame\"") {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg.text) {
                            c.take(&client, &session_id, &v).await;
                        }
                        continue;
                    }
                }
                // Before the log: these tokens are part of the session the walk hands back, log or no log.
                if msg.text.contains("\"Network.requestWillBeSent\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg.text) {
                        note_header_tokens(&v, &mut header_tokens);
                    }
                }
                if let Some(log) = log.as_mut() {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg.text) {
                        // Responses too: the route DAG is built from the whole
                        // walk — requests and what they answered — not just the
                        // requests. A trace without responses cannot be learned.
                        // A response's headers arrive before its body has loaded (a fetch or XHR streams in
                        // after `responseReceived`), so the headers wait here and the body is read when Chrome
                        // reports the load finished. Asking at `responseReceived` returns nothing for most API calls.
                        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or_default();
                        let request_id = v
                            .pointer("/params/requestId")
                            .and_then(|r| r.as_str())
                            .unwrap_or_default()
                            .to_string();
                        // A script the page (or one of its workers) parsed: listed once per parse, its body kept once
                        // per hash. The walk's own reads of the page are not the page's code.
                        if method == "Debugger.scriptParsed" {
                            let params = v.get("params").cloned().unwrap_or_default();
                            if params.get("url").and_then(|u| u.as_str()) != Some(WALK_SOURCE) {
                                let context = context_of(&event_session);
                                if let Some(line) = script_line(client, &event_session, &params, context, &mut kept_scripts).await {
                                    log.write(line);
                                }
                            }
                        }
                        let log_id = if event_session == *session_id { request_id.clone() } else { format!("{event_session}:{request_id}") };
                        if method == "Network.requestWillBeSent" {
                            request_sessions.insert(log_id.clone(), event_session.clone());
                        }
                        // Every address the page itself was at, fragment and all: a navigation of the main frame
                        // (its address and the fragment Chrome reports apart), and a move within the document (a
                        // hash change, a history push). A request's own address never carries its fragment, so
                        // these lines are the only record of what the page's code could read from `location.hash`.
                        if let Some((url, frame)) = page_address(method, &v) {
                            let from = (event_session != *session_id).then(|| event_session.clone());
                            log.write(serde_json::json!({ "type": "address", "t": now_secs(), "url": url, "session": from, "frame": frame }));
                            addresses_written += 1;
                        }
                        if method == "Network.responseReceived" {
                            let mut resp = v.pointer("/params/response").cloned().unwrap_or_default();
                            // Who asked for it, as Chrome names it: a reply the page's own script read is kept as its
                            // bytes whatever its type (`response_body`).
                            if let (Some(o), Some(kind)) = (resp.as_object_mut(), v.pointer("/params/type").cloned()) {
                                o.insert("_resourceType".into(), kind);
                            }
                            awaiting_body.insert(log_id.clone(), resp);
                        }
                        if method == "Network.loadingFinished" || method == "Network.loadingFailed" {
                            if let Some(resp) = awaiting_body.remove(&log_id) {
                                let from = request_sessions.get(&log_id).cloned().unwrap_or_else(|| session_id.clone());
                                let body = if method == "Network.loadingFinished" {
                                    response_body(client, &from, &request_id, read_by_script(&resp)).await
                                } else {
                                    Body::default()
                                };
                                log.write(kept_bodies.body_line(&log_id, &resp, &body));
                            }
                        }
                        // The headers Chrome sent, which `requestWillBeSent` does not carry: a `Cookie` is added at
                        // the network layer and reported here, in the same request's extra info. The walk keeps them,
                        // so a route's session values are the ones the browser actually sent.
                        if method == "Network.requestWillBeSentExtraInfo" {
                            let headers: serde_json::Map<String, serde_json::Value> = v
                                .pointer("/params/headers")
                                .and_then(|h| h.as_object())
                                .cloned()
                                .unwrap_or_default();
                            log.write(serde_json::json!({
                                "type": "request_extra",
                                "t": now_secs(),
                                "requestId": log_id,
                                "headers": headers,
                            }));
                        }
                        if v.get("method").and_then(|m| m.as_str()) == Some("Network.requestWillBeSent") {
                            let req = v.pointer("/params/request").cloned().unwrap_or_default();
                            let headers: serde_json::Map<String, serde_json::Value> = req
                                .get("headers")
                                .and_then(|h| h.as_object())
                                .map(|h| {
                                    h.iter()
                                        .map(|(k, v)| (k.clone(), v.clone()))
                                        .collect()
                                })
                                .unwrap_or_default();
                            log.write(serde_json::json!({
                                "type": "request",
                                "t": now_secs(),
                                "requestId": log_id,
                                "method": req.get("method").cloned().unwrap_or_default(),
                                "url": req.get("url").cloned().unwrap_or_default(),
                                "headers": headers,
                                // A POST's body: the route needs it to know what the call sends. Its bytes where they are no
                                // text, in base64, said by `postDataEncoding` (`post_data`).
                                "postData": post_data(&req).0,
                                "postDataEncoding": post_data(&req).1,
                                // What Chrome says the request is, and which frame made it: measured, not
                                // guessed from the answer's type. The walk's first document is the main frame.
                                "resourceType": v.pointer("/params/type").cloned().unwrap_or_default(),
                                "frameId": v.pointer("/params/frameId").cloned().unwrap_or_default(),
                                // Where in the page's code the request was made, when its code made it: the place a
                                // search for what wrote the request's values starts.
                                "sentBy": sent_by(&v),
                                // What made the request when it wasn't the page itself: a worker, or a frame Chrome
                                // runs apart from the page.
                                "context": context_of(&event_session),
                                // The code that sent it: Chrome's account of the initiator, with the stack (and the
                                // stacks it was scheduled from) by script id, so the learner can find the function.
                                "initiator": v.pointer("/params/initiator").map(initiator),
                            }));
                        }
                    }
                }
            }
            // Events came faster than the walk read them: those are missed, and the walk goes on with the rest. Only
            // the line closing ends it.
            Ok(Some(Err(n))) => {
                missed += n;
                continue;
            }
            // The line to the browser closed before the walk was done with it (the browser went, or its connection
            // broke): the walk didn't end its record itself, so the record says so.
            Ok(None) => {
                cut_off = true;
                break;
            }
            // The wait ran out: the walk's end, or the next nudge's turn.
            Err(_) => continue,
        }
    }
    // The walk has ended: a worker the page starts from here on runs at once, as it would in a browser nobody walks.
    let _ = client
        .send_command("Target.setAutoAttach", Some(serde_json::json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true })), Some(session_id))
        .await;
    if missed > 0 {
        eprintln!("   [mint] {missed} of the browser's events came faster than the walk read them and weren't seen");
    }

    // Responses still loading when the walk ends: read what Chrome has, so a slow call still pairs with its request.
    if let Some(log) = log.as_mut() {
        for (request_id, resp) in awaiting_body.drain() {
            let body = response_body(client, session_id, &request_id, read_by_script(&resp)).await;
            log.write(kept_bodies.body_line(&request_id, &resp, &body));
        }
        // What the storage holds when the walk ends: what the page wrote while it ran.
        for line in storage_lines(client, session_id, "end").await {
            log.write(line);
        }
        // The record of addresses closes with how many it holds, whether any line failed to reach the file, and how many
        // of the browser's events the walk knows it lost (`missed`): a lost one may have been a move to an address with a
        // fragment, so a reader takes a record that lost any as no record.
        log.write(serde_json::json!({ "type": "addresses_end", "t": now_secs(), "written": addresses_written, "failed": log.failed(), "missed": missed, "cut_off": cut_off }));
    }

    if let Some(c) = cast.take() {
        c.settle(&client, &session_id).await;
    }

    // Recheck after recording too: the document can re-enter a challenge
    // after issuing clearance. Preserve the capture and browser, not a false
    // successful mint, so a human can finish verification in this session.
    let state = page_state(&client, &session_id).await;
    if state != "ready" {
        let handoff = if let Some(c) = chrome.take() {
            if opts.headed {
                // Already headed: a person can see it. Keep it open for them, until they finish, close it, or don't
                // come. A profile opened only to ask the site (`adopt` set) is a throwaway and goes with the window;
                // the remembered profile a window was opened in keeps what the person did there.
                let endpoint = c.ws_url.clone();
                let target = client
                    .send_command("Target.getTargetInfo", None, Some(session_id))
                    .await
                    .ok()
                    .and_then(|v| v.pointer("/targetInfo/targetId").and_then(|t| t.as_str()).map(String::from));
                let throwaway = opts.adopt.as_ref().and(opts.profile.clone());
                // One window waits for a person at a site. A walk that meets the same check while one waits opens no
                // second: its browser closes, and the caller's own guard removes the throwaway it was opened in.
                match wait_for_a_person_at(&site_walked(&opts.url)) {
                    Some(give_way) => {
                        leave_open_for_a_person(c, target, throwaway, crate::cdp::chrome::HANDOFF_TTL, give_way);
                        format!("browser left open for verification; reconnect at {endpoint}")
                    }
                    None => {
                        drop(c);
                        "a window is already open for a person at this site, so this browser is closed".to_string()
                    }
                }
            } else if asked >= ASKS {
                // Every browser the walk can be has asked: this is the site's answer, not another question.
                drop(c);
                "the walk asked in every browser it can be and the site refused them all".to_string()
            } else {
                drop(c);
                match next_after_refusal(opts, &state) {
                    // The site refused a browser that remembers. What it
                    // remembers may be the refusal itself: a clearance it has
                    // since revoked, a history it holds against this browser. A
                    // browser that remembers nothing is the honest retry, and it
                    // costs no window; a past the site has already judged is not
                    // made better by asking a person to look at it.
                    Next::Clean => {
                        let remembered = opts.profile.clone().unwrap_or_default();
                        // Beside the remembered profile, so what the site
                        // accepts can take its place with one rename.
                        let clean = fresh_beside(&remembered);
                        let mut retry = opts.clone();
                        retry.profile = Some(clean.clone());
                        retry.adopt = Some(remembered);
                        let throwaway = Throwaway(Some(clean));
                        let walked = Box::pin(mint_at(retry, asked + 1)).await;
                        // This browser was refused and closed. Even when the
                        // walk goes on to leave a *headed* browser open for a
                        // person, that is another browser and another profile:
                        // this one remembers nothing the site wants, and no
                        // walk will open from it.
                        if walked.is_ok() {
                            throwaway.keep();
                        }
                        return walked;
                    }
                    // What is left to change is the window. It is still asked
                    // by a browser that carries nothing from the refusal: what a
                    // refused browser holds — including the cookies the refusal
                    // itself handed it — is one more thing the site may be
                    // judging, and a window on a browser it has already judged
                    // shows a person the same answer.
                    Next::Person => {
                        let mut retry = opts.clone();
                        retry.headed = true;
                        if let Some(remembered) = opts.adopt.clone().or_else(|| opts.profile.clone()) {
                            // The clean browser that brought the walk here was refused too, and the window is a new
                            // browser: no walk opens from this one, whatever the window finds.
                            if opts.adopt.is_some() {
                                if let Some(refused) = &opts.profile {
                                    let _ = std::fs::remove_dir_all(refused);
                                }
                            }
                            let clean = fresh_beside(&remembered);
                            retry.profile = Some(clean.clone());
                            retry.adopt = Some(remembered);
                            let throwaway = Throwaway(Some(clean));
                            let walked = Box::pin(mint_at(retry, asked + 1)).await;
                            // A refusal that ends the walk left no memory worth
                            // keeping. One left open for a person is the
                            // handoff's to remove when its window closes
                            // (`leave_open_for_a_person`), and is never adopted.
                            if !walked.as_ref().is_err_and(|e| !e.contains("browser left open")) {
                                throwaway.keep();
                            }
                            return walked;
                        }
                        return Box::pin(mint_at(retry, asked + 1)).await;
                    }
                    Next::WindowClean => {
                        let remembered = opts.adopt.clone().or_else(|| opts.profile.clone()).unwrap_or_default();
                        // A window on a browser that carries nothing, opened beside the profile it may replace.
                        let clean = fresh_beside(&remembered);
                        let mut retry = opts.clone();
                        retry.headed = true;
                        retry.profile = Some(clean.clone());
                        retry.adopt = opts.adopt.clone().or_else(|| opts.profile.clone());
                        let throwaway = Throwaway(Some(clean));
                        let walked = Box::pin(mint_at(retry, asked + 1)).await;
                        // A refusal that ends the walk left no memory worth keeping; one left open for a person
                        // keeps its profile for whatever they finish there.
                        if !walked.as_ref().is_err_and(|e| !e.contains("browser left open")) {
                            throwaway.keep();
                        }
                        return walked;
                    }
                    Next::Window => return Box::pin(mint_at(MintOptions { headed: true, ..opts.clone() }, asked + 1)).await,
                    Next::Stop if site_refused(&state) => "the browser is closed: only a window could ask again, and the owner keeps windows off".to_string(),
                    Next::Stop => "the page never answered, so the site refused nothing: the browser is closed and its profile stays as it was".to_string(),
                }
            }
        } else if state == "challenge" {
            "attached browser left open for verification".to_string()
        } else {
            "the walk's tab is closed: it had nothing on it for a person to do".to_string()
        };
        return Err(format!("mint unresolved ({state}); {handoff}"));
    }

    // What the page kept for its own code: a signing key, a nonce it made up, a flag. A signing bridge that runs the
    // page's scripts again boots them with this in front of it, or the bundle signs for a page it never saw.
    let storage = client
        .send_command(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": "(()=>{const m=(s)=>{try{return Object.fromEntries(Object.entries(s).slice(0,200))}catch(_){return {}}};return JSON.stringify({local:m(localStorage),session:m(sessionStorage)})})()",
                "returnByValue": true,
            })),
            Some(&session_id),
        )
        .await
        .ok()
        .and_then(|v| v.pointer("/result/value").and_then(|x| x.as_str()).map(String::from))
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_default();
    // A bundle may write its whole state into storage: a route carries a bounded sample of it, the keys a signing
    // script is likeliest to read (everything up to the cap, in page order).
    const STORAGE_CAP: usize = 64 * 1024;
    let pairs = |k: &str| -> HashMap<String, String> {
        let mut out = HashMap::new();
        let mut bytes = 0usize;
        for (name, value) in storage.get(k).and_then(|m| m.as_object()).into_iter().flatten() {
            let Some(value) = value.as_str() else { continue };
            bytes += name.len() + value.len();
            if bytes > STORAGE_CAP {
                break;
            }
            out.insert(name.clone(), value.to_string());
        }
        out
    };
    let (local_storage, session_storage) = (pairs("local"), pairs("session"));
    // What the page kept in the browser's storage by the end of the walk: a value a call sends may have been read
    // from here, and the walk's log is where a reader of the walk looks for where a value came from.
    if let Some(log) = log.as_mut() {
        log.write(serde_json::json!({ "type": "storage", "t": now_secs(), "local": local_storage, "session": session_storage }));
    }
    // What the page's own code saw when it fingerprinted the browser, for a signing bridge to put back in front of
    // it. A page that never looked leaves none.
    let fingerprint = client
        .send_command(
            "Runtime.evaluate",
            Some(serde_json::json!({ "expression": FINGERPRINT_READ, "returnByValue": true })),
            Some(&session_id),
        )
        .await
        .ok()
        .and_then(|v| v.pointer("/result/value").and_then(|x| x.as_str()).map(String::from))
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v.as_object().is_some_and(|o| o.len() > 0));

    // What the page's own code built when it signed: kept in the walk, so a recipe can be fitted from it.
    if std::env::var_os("UNBROWSE_SIGN_PROBE").is_some() {
        if let Some(log) = log.as_mut() {
            let said = client
                .send_command(
                    "Runtime.evaluate",
                    Some(serde_json::json!({ "expression": "JSON.stringify(window.__ub_sign || [])", "returnByValue": true })),
                    Some(&session_id),
                )
                .await
                .ok()
                .and_then(|v| v.pointer("/result/value").and_then(|x| x.as_str()).map(String::from))
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .unwrap_or_else(|| serde_json::json!([]));
            log.write(serde_json::json!({ "type": "sign_probe", "t": now_secs(), "probes": said }));
        }
    }

    // Harvest: the cookies the browser would send are the session.
    let cookies = client
        .send_command("Network.getAllCookies", Some(serde_json::json!({})), Some(&session_id))
        .await
        .map_err(|e| format!("cookies: {e}"))?;
    let mut session = MintedSession { browser_answer: Some(cookies.clone()), ..Default::default() };
    session.local_storage = local_storage;
    session.session_storage = session_storage;
    session.fingerprint = fingerprint;
    // Only the cookies the browser would send to the walked page: the browser also holds every frame's and every
    // other site's, and sent along they swell the request past what the site accepts.
    let host = url::Url::parse(&opts.url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    let mut jar_domains: Vec<String> = Vec::new();
    if let Some(list) = cookies.pointer("/cookies").and_then(|v| v.as_array()) {
        for c in list {
            if let (Some(n), Some(v)) = (
                c.get("name").and_then(|x| x.as_str()),
                c.get("value").and_then(|x| x.as_str()),
            ) {
                let domain = c.get("domain").and_then(|x| x.as_str()).unwrap_or_default();
                if !sent_to(domain, &host) {
                    continue;
                }
                // DevTools reports a cookie set with a `Domain` with the leading dot, a host-only one bare: the
                // domain cookie's reach is kept beside its value, so a caller can send it down the site.
                if domain.starts_with('.') {
                    session.domains.insert(n.to_string(), domain.to_ascii_lowercase());
                }
                jar_domains.push(domain.to_string());
                session.cookies.insert(n.to_string(), v.to_string());
            }
        }
    }
    session.tokens.extend(tokens_for_host(&header_tokens, &host, &jar_domains));

    // The walk's own log, if the caller wants it.
    if let Some(dir) = &opts.capture_dir {
        let path = capture_path(dir, &opts.session);
        for line in read_capture(&path) {
            if line.get("type").and_then(|v| v.as_str()) == Some("exchange") {
                if let Some(headers) = line
                    .pointer("/entry/response/headers")
                    .and_then(|v| v.as_array())
                {
                    for h in headers {
                        if h.get("name").and_then(|v| v.as_str()) == Some("set-cookie") {
                            if let Some(raw) = h.get("value").and_then(|v| v.as_str()) {
                                if let Some((pair, _)) = raw.split_once(';') {
                                    if let Some((n, v)) = pair.split_once('=') {
                                        session
                                            .cookies
                                            .insert(n.trim().to_string(), v.trim().to_string());
                                        if let Some(domain) = set_cookie_domain(raw) {
                                            session.domains.insert(n.trim().to_string(), domain);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let ours = chrome.is_some();
    if ours {
        // Close through Chrome, not around it: what the site handed this
        // browser (its cookies, its storage) is the profile, and a browser
        // killed outright may not have written it. The memory is the point of
        // walking in a profile at all.
        let _ = client.send_command_no_params("Browser.close", None).await;
        if let Some(c) = chrome.as_mut() {
            // Waited for here, not in a blocking call: this runs on a worker other walks may share.
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            while !c.has_exited() && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            if !c.has_exited() {
                c.kill();
            }
        }
    } else if let Some(c) = chrome.as_mut() {
        c.kill();
    }
    // The site accepted a browser that remembered nothing, so what that browser
    // remembers now is what the site agrees with: it takes the refused
    // profile's place, and the next walk opens from it. Only a browser the walk
    // launched is ours to move; one it attached to belongs to its owner.
    if ours {
        if let (Some(remembered), Some(clean)) = (&opts.adopt, &opts.profile) {
            replace_profile(remembered, clean, &crate::paths::set_aside_index());
        }
    }
    Ok(session)
}

/// Keeps the anti-forgery tokens a request carries, with the host it went to, in the order sent.
fn note_header_tokens(event: &serde_json::Value, tokens: &mut Vec<(String, String, String)>) {
    let Some(request) = event.pointer("/params/request") else { return };
    let Some(headers) = request.get("headers").and_then(|h| h.as_object()) else { return };
    let to_host = request
        .get("url")
        .and_then(|u| u.as_str())
        .and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        if name.contains("csrf") || name.contains("xsrf") {
            if let Some(value) = value.as_str() {
                tokens.push((name, value.to_string(), to_host.clone()));
            }
        }
    }
}

/// The header tokens that are the walked host's: those its calls sent to the walked host itself, or to a host a
/// domain cookie in the walked host's jar also goes to (`.example.com` reaches `api.example.com`). A browser never
/// lets a domain cookie span two sites, so a token sent to another site, from a frame or a redirect, stays out of
/// the walked host's session. A later token of one name replaces an earlier one, as the page sent them.
pub fn tokens_for_host(
    tokens: &[(String, String, String)],
    walked: &str,
    jar_domains: &[String],
) -> std::collections::HashMap<String, String> {
    let walked = walked.trim_end_matches('.').to_ascii_lowercase();
    let ours = |to: &str| {
        let to = to.trim_end_matches('.').to_ascii_lowercase();
        !to.is_empty()
            && (to == walked
                || jar_domains
                    .iter()
                    .any(|d| d.starts_with('.') && sent_to(d, &to)))
    };
    let mut kept = std::collections::HashMap::new();
    for (name, value, to) in tokens {
        if ours(to) {
            kept.insert(name.clone(), value.clone());
        }
    }
    kept
}

/// Whether a cookie set for `domain` is sent to `host`: the host is the domain, or under it.
pub fn sent_to(domain: &str, host: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

/// The `Domain` a `Set-Cookie` line sets its cookie for, as DevTools reports it (lower case, with the leading dot),
/// or `None` for a cookie set for the host that set it alone (host-only), which then goes to that host and nowhere
/// else. The site's own line is what says how far the cookie goes; nothing here reads the cookie's name.
pub fn set_cookie_domain(raw: &str) -> Option<String> {
    for attr in raw.split(';').skip(1) {
        let (k, v) = attr.split_once('=').map(|(k, v)| (k.trim(), v.trim())).unwrap_or((attr.trim(), ""));
        if k.eq_ignore_ascii_case("domain") && !v.is_empty() {
            return Some(format!(".{}", v.trim_start_matches('.').to_ascii_lowercase()));
        }
    }
    None
}

/// The longest a worker is held at its first line while its network is turned on: well past the few milliseconds that
/// takes, and short enough that a browser slow to answer never stalls the page for long.
const HOLD_A_WORKER: std::time::Duration = std::time::Duration::from_millis(1_000);

/// Whether Chrome's kind of target is a worker: a context that runs the page's script with no document of its own, and
/// can call as it starts. A frame (`iframe`, `page`) is not.
fn is_a_worker(kind: &str) -> bool {
    kind.ends_with("worker") || kind == "worklet"
}

/// The address a frame of the walk is at after a DevTools event, when the event moved it: `Page.frameNavigated` (its
/// `url` and the `urlFragment` Chrome reports apart), or `Page.navigatedWithinDocument` (a hash change or a history push
/// or replace, whose `url` is whole). Every frame counts, the page's own and every frame inside it: each is an address
/// the walk's browser was at, and its own code can read its own fragment. With the address, the frame's id.
pub fn page_address(method: &str, event: &serde_json::Value) -> Option<(String, String)> {
    page_address_of(method, event)
}

/// Whether a message from the browser is one the walk can't read, and so lost: anything that isn't JSON, a frame that
/// wasn't UTF-8 and was handed on with its bad bytes replaced included. A walk counts each with the events the relay
/// dropped (`missed`).
pub fn event_lost(text: &str) -> bool {
    serde_json::from_str::<serde::de::IgnoredAny>(text).is_err()
}

fn page_address_of(method: &str, event: &serde_json::Value) -> Option<(String, String)> {
    match method {
        "Page.frameNavigated" => {
            let frame = event.pointer("/params/frame")?;
            let url = frame.get("url").and_then(|u| u.as_str())?;
            let fragment = frame.get("urlFragment").and_then(|f| f.as_str()).unwrap_or_default();
            let id = frame.get("id").and_then(|i| i.as_str()).unwrap_or_default();
            Some((format!("{url}{fragment}"), id.to_string()))
        }
        "Page.navigatedWithinDocument" => {
            let url = event.pointer("/params/url").and_then(|u| u.as_str())?;
            let id = event.pointer("/params/frameId").and_then(|i| i.as_str()).unwrap_or_default();
            Some((url.to_string(), id.to_string()))
        }
        _ => None,
    }
}

/// The response's body while Chrome still holds it, as text. Chrome hands a body over encoded when the type the
/// site gave it is not one Chrome reads as text, and that says nothing of the bytes: an answer of one record a line,
/// or data under a type of the site's own, is text all the same. So what a body is is read from its bytes
/// ([`body_text`]), and only one that isn't text is left out.
/// A task of the walk's, stopped when the walk is over, whichever way it ends.
/// What turns on the contexts a page starts, each in a task of its own: one slow to answer never holds up the next.
/// Dropped with the walk, it stops every one still running.
#[derive(Default)]
struct EachByItself(tokio::task::JoinSet<()>);

impl EachByItself {
    fn start(&mut self, turning_on: impl std::future::Future<Output = ()> + Send + 'static) {
        while self.0.try_join_next().is_some() {}
        self.0.spawn(turning_on);
    }
}

struct StopsWithTheWalk(tokio::task::JoinHandle<()>);

impl Drop for StopsWithTheWalk {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The name the walk's own reads of a page go by, so the script list leaves them out: what the walk evaluates to read
/// the page's state is not the page's code. The name goes to DevTools, not to the page.
const WALK_SOURCE: &str = "agent-browser:walk";

/// One of the walk's own expressions, named so its parse is known as the walk's.
fn own(expression: &str) -> String {
    format!("{expression}\n//# sourceURL={WALK_SOURCE}")
}

/// How many async hops of a stack Chrome keeps for a request's initiator: a call a page signs after an `await` or a
/// timer is sent from a stack whose signer is a hop or two back.
const ASYNC_STACK_DEPTH: u64 = 32;

/// Turns on what lets the walk read a session's code (`learn.record`): its parsed scripts, and stacks that reach back
/// across async hops. Pauses are skipped, so a `debugger` statement in the page runs as it would with no one reading.
/// Nothing is evaluated in the page and nothing is put on it.
async fn read_the_pages_code(client: &crate::cdp::client::CdpClient, session_id: &str) {
    let empty = Some(serde_json::json!({}));
    let _ = client.send_command("Debugger.enable", empty.clone(), Some(session_id)).await;
    let _ = client.send_command("Debugger.setSkipAllPauses", Some(serde_json::json!({ "skip": true })), Some(session_id)).await;
    let _ = client
        .send_command("Debugger.setAsyncCallStackDepth", Some(serde_json::json!({ "maxDepth": ASYNC_STACK_DEPTH })), Some(session_id))
        .await;
}

/// A request's initiator as the capture keeps it: what kind of thing sent it (`parser`, `script`, `preflight`, ...),
/// where (for a parser, the document and line), and, for a script, the stack: its own frames and those of each async
/// hop it was scheduled from (`parents`), each frame by script id, url, function, line and column (zero-based).
pub fn initiator(raw: &serde_json::Value) -> serde_json::Value {
    fn frames(stack: &serde_json::Value) -> Vec<serde_json::Value> {
        stack
            .get("callFrames")
            .and_then(|f| f.as_array())
            .map(|fs| {
                fs.iter()
                    .map(|f| {
                        serde_json::json!({
                            "scriptId": f.get("scriptId").cloned().unwrap_or_default(),
                            "url": f.get("url").cloned().unwrap_or_default(),
                            "function": f.get("functionName").cloned().unwrap_or_default(),
                            "line": f.get("lineNumber").cloned().unwrap_or_default(),
                            "column": f.get("columnNumber").cloned().unwrap_or_default(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    let mut out = serde_json::json!({ "type": raw.get("type").cloned().unwrap_or_default() });
    for (from, to) in [("url", "url"), ("lineNumber", "line"), ("columnNumber", "column"), ("requestId", "requestId")] {
        if let Some(v) = raw.get(from) {
            out[to] = v.clone();
        }
    }
    if let Some(stack) = raw.get("stack") {
        out["frames"] = serde_json::Value::Array(frames(stack));
        let mut parents = Vec::new();
        let mut next = stack.get("parent");
        while let Some(hop) = next {
            parents.push(serde_json::json!({
                "description": hop.get("description").cloned().unwrap_or_default(),
                "frames": frames(hop),
            }));
            next = hop.get("parent");
        }
        out["parents"] = serde_json::Value::Array(parents);
    }
    out
}

/// The hex sha256 of a body.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// A parsed script as the capture lists it: its id in the session that parsed it, its url (empty for an inline or
/// evaluated one), its language (`js` or `wasm`), the sha256 and length of its body, and the body itself the first
/// time that hash is met in the walk: a script's text as `source`, a wasm module's bytes as `bytes` (base64). A body
/// Chrome won't give is listed without its hash, so the list still says the script ran.
async fn script_line(
    client: &crate::cdp::client::CdpClient,
    session_id: &str,
    params: &serde_json::Value,
    context: Option<String>,
    kept: &mut std::collections::HashSet<String>,
) -> Option<serde_json::Value> {
    use base64::Engine;
    let script_id = params.get("scriptId").and_then(|s| s.as_str())?;
    let wasm = params.get("scriptLanguage").and_then(|l| l.as_str()) == Some("WebAssembly");
    let got = client
        .send_command("Debugger.getScriptSource", Some(serde_json::json!({ "scriptId": script_id })), Some(session_id))
        .await
        .ok();
    let mut line = serde_json::json!({
        "type": "script",
        "t": now_secs(),
        "scriptId": script_id,
        "url": params.get("url").cloned().unwrap_or_default(),
        "language": if wasm { "wasm" } else { "js" },
        "module": params.get("isModule").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "context": context,
    });
    let body: Option<Vec<u8>> = if wasm {
        let encoded = match got.as_ref().and_then(|g| g.get("bytecode")).and_then(|b| b.as_str()) {
            Some(b) => Some(b.to_string()),
            // An older Chrome hands a module's bytes over by their own command.
            None => client
                .send_command("Debugger.getWasmBytecode", Some(serde_json::json!({ "scriptId": script_id })), Some(session_id))
                .await
                .ok()
                .and_then(|g| g.get("bytecode").and_then(|b| b.as_str()).map(String::from)),
        };
        encoded.and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
    } else {
        got.as_ref().and_then(|g| g.get("scriptSource")).and_then(|s| s.as_str()).map(|s| s.as_bytes().to_vec())
    };
    if let Some(body) = body {
        let sha = sha256_hex(&body);
        line["sha256"] = serde_json::Value::String(sha.clone());
        line["length"] = serde_json::json!(body.len());
        if kept.insert(sha) {
            if wasm {
                line["bytes"] = serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(&body));
            } else {
                line["source"] = serde_json::Value::String(String::from_utf8_lossy(&body).into_owned());
            }
        }
    }
    Some(line)
}

/// The page's storage, one line per origin its frames are on: what local and session storage hold, read over
/// DevTools at `at` (`settle` or `end`). An origin whose storage can't be read is left out.
/// The lines are `origin_storage`: the walk's one `storage` line at its end is the walked page's alone, and its
/// readers take the last of that name.
async fn storage_lines(client: &crate::cdp::client::CdpClient, session_id: &str, at: &str) -> Vec<serde_json::Value> {
    fn frames(node: &serde_json::Value, out: &mut Vec<(String, String)>) {
        if let Some(frame) = node.get("frame") {
            let id = frame.get("id").and_then(|i| i.as_str()).unwrap_or_default();
            let origin = frame.get("securityOrigin").and_then(|o| o.as_str()).unwrap_or_default();
            if origin.starts_with("http") && !out.iter().any(|(_, o)| o == origin) {
                out.push((id.to_string(), origin.to_string()));
            }
        }
        for child in node.get("childFrames").and_then(|c| c.as_array()).into_iter().flatten() {
            frames(child, out);
        }
    }
    let Ok(tree) = client.send_command("Page.getFrameTree", Some(serde_json::json!({})), Some(session_id)).await else {
        return Vec::new();
    };
    let mut origins = Vec::new();
    if let Some(root) = tree.get("frameTree") {
        frames(root, &mut origins);
    }
    let mut lines = Vec::new();
    for (frame, origin) in origins {
        let key = client
            .send_command("Storage.getStorageKeyForFrame", Some(serde_json::json!({ "frameId": frame })), Some(session_id))
            .await
            .ok()
            .and_then(|k| k.get("storageKey").and_then(|s| s.as_str()).map(String::from));
        let mut line = serde_json::json!({ "type": "origin_storage", "t": now_secs(), "at": at, "origin": origin });
        let mut read_any = false;
        for (local, field) in [(true, "local"), (false, "session")] {
            let id = match &key {
                Some(key) => serde_json::json!({ "storageKey": key, "isLocalStorage": local }),
                None => serde_json::json!({ "securityOrigin": origin, "isLocalStorage": local }),
            };
            let Ok(items) = client
                .send_command("DOMStorage.getDOMStorageItems", Some(serde_json::json!({ "storageId": id })), Some(session_id))
                .await
            else {
                continue;
            };
            let mut map = serde_json::Map::new();
            for pair in items.get("entries").and_then(|e| e.as_array()).into_iter().flatten() {
                if let (Some(k), Some(v)) = (pair.get(0).and_then(|k| k.as_str()), pair.get(1).and_then(|v| v.as_str())) {
                    map.insert(k.to_string(), serde_json::Value::String(v.to_string()));
                }
            }
            line[field] = serde_json::Value::Object(map);
            read_any = true;
        }
        if read_any {
            lines.push(line);
        }
    }
    lines
}

/// A request's body as the walk keeps it, from what Chrome says it sent (`request.postData`, and the bytes of each
/// part in `postDataEntries`): its text where its bytes are text, else the bytes in base64, with `base64` as the second.
/// Chrome's `postData` of bytes that are no text is not those bytes, so the parts are read where Chrome gives them.
fn post_data(req: &serde_json::Value) -> (serde_json::Value, serde_json::Value) {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let parts: Option<Vec<u8>> = req.get("postDataEntries").and_then(|e| e.as_array()).filter(|e| !e.is_empty()).map(|entries| {
        entries.iter().filter_map(|e| e.get("bytes").and_then(|b| b.as_str())).filter_map(|b| b64.decode(b).ok()).flatten().collect()
    });
    match parts {
        Some(bytes) if !bytes.is_empty() => match String::from_utf8(bytes.clone()) {
            Ok(text) if !text.contains('\0') => (serde_json::Value::String(text), serde_json::Value::Null),
            _ => (serde_json::Value::String(b64.encode(&bytes)), serde_json::json!("base64")),
        },
        _ => (req.get("postData").cloned().unwrap_or_default(), serde_json::Value::Null),
    }
}

/// A reply's body as the walk keeps it: its text, or, for bytes that are no text, those bytes in base64.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Body {
    text: String,
    /// `text` is the reply's bytes in base64.
    base64: bool,
}

/// Whether a reply is one the page's own script asked for and read (a `fetch`, an XHR), as Chrome named its resource
/// type when it answered: its body is the page's data whatever its type says.
fn read_by_script(resp: &serde_json::Value) -> bool {
    matches!(resp.get("_resourceType").and_then(|t| t.as_str()), Some("Fetch" | "XHR"))
}

/// The most bytes of a binary reply the walk keeps. A binary answer is cut short into nothing a reader opens, so one
/// past this is kept with no body at all, and the walk says so.
const BYTES_BODY_CAP: usize = 4_000_000;

/// A reply's body as Chrome holds it: text as text; bytes that are no text kept in base64 where the page's script read
/// them (`keep_bytes`), up to [`BYTES_BODY_CAP`], and otherwise nothing, as before.
///
/// What is bounded and what isn't: the walk keeps at most each body's own cap and [`WALK_BODIES_CAP`] in all
/// ([`KeptBodies`]), so the capture written to disk and read back is bounded. The body asked for here is not: it comes
/// whole from the browser, as large as whatever the browser itself kept of the answer, and is held in memory until
/// `KeptBodies` cuts it. The walk passes the browser no buffer limit (`Network.enable`'s `maxResourceBufferSize`), so a
/// single answer the browser already holds bounds this read, and the node does not.
async fn response_body(client: &crate::cdp::client::CdpClient, session_id: &str, request_id: &str, keep_bytes: bool) -> Body {
    let Some(b) = client.send_command("Network.getResponseBody", Some(serde_json::json!({ "requestId": request_id })), Some(session_id)).await.ok() else { return Body::default() };
    let raw = b.get("body").and_then(|x| x.as_str()).unwrap_or_default();
    let encoded = b.get("base64Encoded").and_then(|x| x.as_bool()).unwrap_or(false);
    if let Some(text) = body_text(raw, encoded) {
        return Body { text, base64: false };
    }
    bytes_kept(raw, encoded && keep_bytes)
}

/// The base64 of a binary reply the walk keeps, within [`BYTES_BODY_CAP`]; one past the cap is kept as no body, said.
fn bytes_kept(base64: &str, keep: bool) -> Body {
    if !keep {
        return Body::default();
    }
    let bytes = base64.len() / 4 * 3;
    if bytes > BYTES_BODY_CAP {
        eprintln!("   [mint] a reply the page's script read is {bytes} bytes, past the {BYTES_BODY_CAP} bytes the walk keeps of a binary reply: kept with no body");
        return Body::default();
    }
    Body { text: base64.to_string(), base64: true }
}

/// A body as text: as it is when Chrome handed it over as text, and decoded when Chrome encoded it and its bytes are
/// text (UTF-8, with nothing a text never holds: no NUL). Bytes that aren't text (an image, a compiled module) are no
/// text, whatever their type says.
fn body_text(body: &str, encoded: bool) -> Option<String> {
    if !encoded {
        return Some(body.to_string());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(body).ok()?;
    String::from_utf8(bytes).ok().filter(|text| !text.contains('\0'))
}

/// How much of a body the walk keeps. A server-rendered page carries the state its scripts are handed (and the
/// tokens its calls send back, such as a CSRF token) after its markup, megabytes in: cut short, those values have no
/// traceable source. Other bodies are data or assets and stay smaller.
const PAGE_BODY_CAP: usize = 4_000_000;
/// A JSON answer is the data a route hands back, and cut short it parses as nothing: a search API's page of results
/// runs past a megabyte (Target's listing page answers 1.4 MB). It is kept whole up to this.
const DATA_BODY_CAP: usize = 16_000_000;
const BODY_CAP: usize = 1_000_000;

/// Whether a body is data a route may hand back, read from what it is and not only from what its type says: JSON by
/// its type or its first character, a stream of events (`text/event-stream`, `data:` lines), JSON behind a guard
/// (`)]}'`), or JSON inside a call of a short name (`cb({…})`). A site sends its answers under whatever type its
/// framework sets, and one cut at a script's allowance parses as nothing: a flight search streamed as one event of
/// more than a megabyte was dropped from the walk's candidates whenever the list ran long.
fn is_data(mime: &str, body: &str) -> bool {
    if mime.contains("json") || mime.contains("event-stream") {
        return true;
    }
    let head: String = body.trim_start().chars().take(96).collect();
    if head.starts_with(['{', '[']) || head.starts_with("data:") || head.starts_with("event:") || head.starts_with(")]}'") {
        return true;
    }
    // A callback's name, then the JSON it is handed: `cb7({`, `jQuery1234_5678([`.
    head.split_once('(').is_some_and(|(name, rest)| {
        let name = name.trim();
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '.')) && rest.trim_start().starts_with(['{', '['])
    })
}

/// The most body text one walk keeps in all, in bytes, whatever each body's own cap allows: a page that draws answer
/// after answer of data-sized bodies would otherwise grow the capture (and the memory that reads it back) without end.
/// The same total the browser's own HAR recording keeps.
pub const WALK_BODIES_CAP: usize = 128 * 1024 * 1024;

/// What is left of a walk's [`WALK_BODIES_CAP`]: each body is kept up to its own cap (by what it is) and to no more
/// than what is left, so however many answers a page draws, one walk's capture holds a bounded amount of body text.
/// Once it is spent, a body is recorded empty; the request and its answer's status and headers still are.
pub struct KeptBodies {
    left: usize,
}

impl Default for KeptBodies {
    fn default() -> Self {
        Self::within(WALK_BODIES_CAP)
    }
}

impl KeptBodies {
    /// A walk's allowance of `total` bytes of body text.
    pub fn within(total: usize) -> Self {
        Self { left: total }
    }

    /// The bytes of body text the walk may still keep.
    pub fn left(&self) -> usize {
        self.left
    }

    /// The capture's line for an answer, its body kept within its own cap and what is left of the walk's.
    pub fn line(&mut self, request_id: &str, resp: &serde_json::Value, body: &str) -> serde_json::Value {
        let mime = resp.get("mimeType").and_then(|m| m.as_str()).unwrap_or_default();
        let cap = if mime.starts_with("text/html") {
            PAGE_BODY_CAP
        } else if is_data(mime, body) {
            DATA_BODY_CAP
        } else {
            BODY_CAP
        };
        let mut kept = String::new();
        for c in body.chars().take(cap) {
            if kept.len() + c.len_utf8() > self.left {
                break;
            }
            kept.push(c);
        }
        self.left -= kept.len();
        answer_line(request_id, resp, kept)
    }

    /// The capture's line for an answer read as [`Body`]: text kept as [`KeptBodies::line`] keeps it; bytes kept in
    /// base64 whole or not at all (`bytes_kept`: base64 cut short opens as nothing), and only within what is left of the
    /// walk's total, which they spend like text.
    fn body_line(&mut self, request_id: &str, resp: &serde_json::Value, body: &Body) -> serde_json::Value {
        if !body.base64 {
            return self.line(request_id, resp, &body.text);
        }
        let mut line = answer_line(request_id, resp, String::new());
        if body.text.len() > self.left {
            eprintln!("   [mint] a reply the page's script read is past what is left of the walk's {WALK_BODIES_CAP} bytes of bodies: kept with no body");
            return line;
        }
        self.left -= body.text.len();
        line["body"] = serde_json::Value::String(body.text.clone());
        line["encoding"] = serde_json::json!("base64");
        line
    }
}

/// An answer's line read as [`Body`], with no walk's total to keep to.
#[cfg(test)]
fn body_line(request_id: &str, resp: &serde_json::Value, body: &Body) -> serde_json::Value {
    KeptBodies::within(usize::MAX).body_line(request_id, resp, body)
}

/// An answer's line with no walk's total to keep to: a body kept up to its own cap.
#[cfg(test)]
fn response_line(request_id: &str, resp: &serde_json::Value, body: &str) -> serde_json::Value {
    KeptBodies::within(usize::MAX).line(request_id, resp, body)
}

fn answer_line(request_id: &str, resp: &serde_json::Value, body: String) -> serde_json::Value {
    serde_json::json!({
        "type": "response",
        "t": now_secs(),
        "requestId": request_id,
        "url": resp.get("url").cloned().unwrap_or_default(),
        "status": resp.get("status").cloned().unwrap_or_default(),
        "mimeType": resp.pointer("/mimeType").cloned().unwrap_or_default(),
        "headers": resp.get("headers").cloned().unwrap_or_default(),
        "body": body,
    })
}


/// The walk as HAR 1.2: the capture's request/response lines paired into
/// entries. This is the harness-level hand-off — a mint produces a trace that
/// route learning can build a graph from, with no CLI and no daemon involved.
/// Who sent a request, as the browser reports it with `Network.requestWillBeSent`: the frames of the stack when the
/// page's own code made the call, innermost first, then the frames that scheduled it where the browser kept them
/// (`parent`). Each is a script's address and a zero-based line and column in it. A request the parser made (a tag
/// in the markup) has none, and a frame of code with no address (an `eval`, the console) names no script to read.
fn sent_by(event: &serde_json::Value) -> Vec<serde_json::Value> {
    /// A deep stack is a framework's own layers: the frames nearest the send are the ones that say who sent it.
    const MOST: usize = 24;
    let mut frames = Vec::new();
    let mut stack = event.pointer("/params/initiator/stack");
    while let Some(s) = stack {
        for f in s.get("callFrames").and_then(|f| f.as_array()).into_iter().flatten() {
            let url = f.get("url").and_then(|u| u.as_str()).unwrap_or_default();
            if url.is_empty() || frames.len() >= MOST {
                continue;
            }
            frames.push(serde_json::json!({
                "url": url,
                "line": f.get("lineNumber").and_then(|n| n.as_u64()).unwrap_or_default(),
                "column": f.get("columnNumber").and_then(|n| n.as_u64()).unwrap_or_default(),
                "function": f.get("functionName").and_then(|n| n.as_str()).unwrap_or_default(),
            }));
        }
        stack = s.get("parent");
    }
    frames
}

pub fn walk_har(capture_dir: &Path, session: &str) -> serde_json::Value {
    let lines = read_capture(&capture_path(capture_dir, session));
    let mut pending: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    let mut entries: Vec<serde_json::Value> = Vec::new();
    // What Chrome sent on the wire, per request: `requestWillBeSent` omits the session's `Cookie`, which arrives in
    // the same request's extra info. Merged into the request it belongs to, the walk shows the request as sent.
    let mut extras: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    for v in &lines {
        if v.get("type").and_then(|t| t.as_str()) == Some("request_extra") {
            if let Some(id) = v.get("requestId").and_then(|r| r.as_str()) {
                extras.insert(id.to_string(), v.get("headers").cloned().unwrap_or_default());
            }
        }
    }
    let main = main_frames(&lines);
    for v in lines {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("request") => {
                let url = v.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_string();
                if url.starts_with("data:") || url.starts_with("blob:") {
                    continue;
                }
                // Paired by Chrome's request ID when the log has one (a page often asks the same URL twice);
                // older logs pair by URL.
                let key = v.get("requestId").and_then(|r| r.as_str()).map(String::from).unwrap_or(url);
                pending.insert(key, v);
            }
            Some("response") => {
                let url = v.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_string();
                let key = v.get("requestId").and_then(|r| r.as_str()).map(String::from).unwrap_or_else(|| url.clone());
                let Some(req) = pending.remove(&key).or_else(|| pending.remove(&url)) else { continue };
                let pairs = |o: Option<&serde_json::Value>| -> Vec<serde_json::Value> {
                    o.and_then(|h| h.as_object())
                        .map(|h| {
                            h.iter()
                                .map(|(k, val)| serde_json::json!({ "name": k, "value": val }))
                                .collect()
                        })
                        .unwrap_or_default()
                };
                let mime = v.get("mimeType").and_then(|m| m.as_str()).unwrap_or("").to_string();
                // Chrome's own word for the request when the log has it; older logs guess from the answer.
                let recorded = req.get("resourceType").and_then(|t| t.as_str()).filter(|t| !t.is_empty());
                let resource_type = if let Some(t) = recorded {
                    t
                } else if mime.contains("html") {
                    "Document"
                } else if mime.contains("json") {
                    "XHR"
                } else if mime.contains("css") {
                    "Stylesheet"
                } else if mime.contains("javascript") {
                    "Script"
                } else {
                    "Other"
                };
                let mut sent = req.get("headers").cloned().unwrap_or_default();
                if let (Some(sent), Some(extra)) = (sent.as_object_mut(), extras.get(v.get("requestId").and_then(|r| r.as_str()).unwrap_or_default()).and_then(|e| e.as_object())) {
                    for (k, val) in extra {
                        // Header names are case-insensitive, and the HAR's are Chrome's own (lowercase). The extra info is
                        // the same request's headers as they went out, so it replaces what the event announced under any
                        // casing: one entry per name, as a browser sends. Left both, a route carried `accept` and
                        // `referer` twice and sent each twice — not a shape any browser has (ieeexplore, 2026-11-11).
                        let lower = k.to_ascii_lowercase();
                        let same: Vec<String> = sent.keys().filter(|n| n.eq_ignore_ascii_case(&lower)).cloned().collect();
                        for n in same {
                            sent.remove(&n);
                        }
                        sent.insert(lower, val.clone());
                    }
                }
                entries.push(serde_json::json!({
                    "_resourceType": resource_type,
                    "_mainFrame": in_main_frame(&req, &main),
                    // Which code sent it, as the walk recorded it (`initiator`); absent in logs from before.
                    "_initiator": req.get("initiator").cloned().filter(|i| !i.is_null()),
                    "request": {
                        "method": req.get("method").cloned().unwrap_or_default(),
                        "url": url,
                        "headers": pairs(Some(&sent)),
                        "postData": req.get("postData").and_then(|p| p.as_str()).filter(|p| !p.is_empty()).map(|text| {
                            let mut post = serde_json::json!({
                                "mimeType": req.pointer("/headers/Content-Type").or_else(|| req.pointer("/headers/content-type")).cloned().unwrap_or_default(),
                                "text": text,
                            });
                            // Bytes that are no text, in base64: said as HAR says it of a reply. A line from before says
                            // nothing, and reads as it did.
                            if let Some(encoding) = req.get("postDataEncoding").and_then(|e| e.as_str()) {
                                post["_encoding"] = serde_json::json!(encoding);
                            }
                            post
                        }),
                    },
                    "response": {
                        "status": v.get("status").cloned().unwrap_or(serde_json::json!(200)),
                        "headers": pairs(v.get("headers")),
                        // A body kept as bytes is base64 in the recording, and says so as HAR does; a line from before
                        // carries no encoding, and reads as it always did.
                        "content": match v.get("encoding").and_then(|e| e.as_str()) {
                            Some(encoding) => serde_json::json!({ "mimeType": mime, "text": v.get("body").cloned().unwrap_or_default(), "encoding": encoding }),
                            None => serde_json::json!({ "mimeType": mime, "text": v.get("body").cloned().unwrap_or_default() }),
                        },
                    },
                }));
            }
            _ => {}
        }
    }
    serde_json::json!({ "log": { "entries": entries } })
}

/// The walk's main frames: the frame of each browser's first document, the navigation the walk made in it. A walk
/// the site refused is tried again in another browser (see `next_after_refusal`), and each try starts with its own
/// `mint` line: its page is a new frame, and still the walk's page, not a frame inside it. A browser's own pages
/// (`chrome-untrusted://new-tab-page/…`, loading as it opens) are never the walk's navigation. Empty for logs that
/// predate frames.
fn main_frames(lines: &[serde_json::Value]) -> Vec<String> {
    let mut frames = Vec::new();
    let mut opened = true;
    for v in lines {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("mint") => opened = true,
            Some("request")
                if opened
                    && v.get("resourceType").and_then(|t| t.as_str()) == Some("Document")
                    && v.get("url").and_then(|u| u.as_str()).is_some_and(|u| u.starts_with("http://") || u.starts_with("https://")) =>
            {
                if let Some(f) = v.get("frameId").and_then(|f| f.as_str()).filter(|f| !f.is_empty()) {
                    frames.push(f.to_string());
                }
                opened = false;
            }
            _ => {}
        }
    }
    frames
}

/// Whether a request was made by a main frame; `None` when the log does not say.
fn in_main_frame(request: &serde_json::Value, main: &[String]) -> Option<bool> {
    let frame = request.get("frameId").and_then(|f| f.as_str()).filter(|f| !f.is_empty())?;
    if main.is_empty() {
        return None;
    }
    Some(main.iter().any(|m| m == frame))
}

/// What the walk recorded for a URL: status, mime and body. The browser
/// fetched it during the mint, so a browserless call that a door refuses can
/// still be answered — with the page the browser itself received.
pub fn walk_response(
    capture_dir: &Path,
    session: &str,
    url: &str,
) -> Option<(u16, String, String)> {
    let lines = read_capture(&capture_path(capture_dir, session));
    let mut best: Option<(u16, String, String)> = None;
    for v in lines {
        if v.get("type").and_then(|t| t.as_str()) != Some("response") {
            continue;
        }
        let recorded = v.get("url").and_then(|u| u.as_str()).unwrap_or_default();
        // Exact URL first; a query-less match is the next best thing, since
        // sites append tracking parameters to the same page.
        let exact = recorded == url;
        let loose = recorded.split('?').next() == url.split('?').next();
        if !exact && !loose {
            continue;
        }
        let status = v.get("status").and_then(|s| s.as_u64()).unwrap_or(200) as u16;
        let mime = v.get("mimeType").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let body = v.get("body").and_then(|b| b.as_str()).unwrap_or_default().to_string();
        if body.is_empty() {
            continue;
        }
        // Several responses can share a URL (a redirect chain, a re-render);
        // the largest is the page, not the stub.
        let better = match &best {
            Some((_, _, b)) => body.len() > b.len(),
            None => true,
        };
        if better || exact && best.is_none() {
            best = Some((status, mime, body));
        }
    }
    best
}

/// The page the walk ended on: the last http(s) document the main frame was
/// served. A redirect makes this the right fallback when the requested URL is
/// not what the browser ended up at; frames (a challenge widget, an ad, a
/// consent banner) load their own documents and are never the page.
pub fn walk_page(capture_dir: &Path, session: &str) -> Option<(u16, String, String)> {
    let lines = read_capture(&capture_path(capture_dir, session));
    let main = main_frames(&lines);
    let requests: std::collections::HashMap<&str, &serde_json::Value> = lines
        .iter()
        .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("request"))
        .filter_map(|v| Some((v.get("requestId")?.as_str()?, v)))
        .collect();
    let mut best: Option<(u16, String, String)> = None;
    for v in &lines {
        if v.get("type").and_then(|t| t.as_str()) != Some("response") {
            continue;
        }
        let url = v.get("url").and_then(|u| u.as_str()).unwrap_or_default();
        let Ok(parsed) = url::Url::parse(url) else { continue };
        if !matches!(parsed.scheme(), "http" | "https") {
            continue;
        }
        let request = v.get("requestId").and_then(|r| r.as_str()).and_then(|id| requests.get(id));
        if request.is_some_and(|r| in_main_frame(r, &main) == Some(false)) {
            continue;
        }
        let mime = v.get("mimeType").and_then(|m| m.as_str()).unwrap_or("");
        if !mime.starts_with("text/html") {
            continue;
        }
        let body = v.get("body").and_then(|b| b.as_str()).unwrap_or_default().to_string();
        if body.is_empty() {
            continue;
        }
        let status = v.get("status").and_then(|s| s.as_u64()).unwrap_or(200) as u16;
        // Later documents win: the browser navigates forward, and the last
        // page it settled on is the answer.
        best = Some((status, mime.to_string(), body));
    }
    best
}
