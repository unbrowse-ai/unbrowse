//! Behaviour tests for the parts of `report.rs` the main tests leave out: the scrub's odd inputs, the relay's own
//! limits, the owner's queue, and the sender against a relay on 127.0.0.1.

use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

const ID: &str = "0123456789abcdef0123456789abcdef";

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

fn cfg(endpoint: &str) -> Config {
    Config { on: true, endpoint: endpoint.into(), timeout: Duration::from_millis(800), version: "1.4.2".into(), install_id: ID.into() }
}

fn saved_on() {
    store::write_json(&saved_path(), &unbrowse_files::REPORTS, &Saved { on: true }).unwrap();
}

/// A relay on 127.0.0.1 that answers each report with `status` and `body`, and keeps what it was sent.
fn relay(status: u16, body: Value) -> (String, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1/reports", listener.local_addr().unwrap());
    let got = Arc::new(Mutex::new(Vec::new()));
    let kept = got.clone();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                let Some(end) = text.find("\r\n\r\n") else { continue };
                let len: usize = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0))).unwrap_or(0);
                if buf.len() >= end + 4 + len {
                    if let Ok(v) = serde_json::from_slice(&buf[end + 4..end + 4 + len]) {
                        kept.locked().push(v);
                    }
                    let b = body.to_string();
                    let _ = stream.write_all(format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}", b.len()).as_bytes());
                    break;
                }
            }
        }
    });
    (url, got)
}

fn report_of(kind: &str, summary: &str, url: &str) -> Value {
    let asked = Asked { kind: kind.into(), summary: summary.into(), url: url.into(), ..Asked::default() };
    build(&asked, &Context { source: "agent", version: "1.4.2", install_id: ID, known: &Known::none(), last: None, now: 1_000_000 }).0
}

fn a_route() -> store::Route {
    serde_json::from_value(json!({
        "id": "r1", "site": "api.example.com", "what": "stars", "method": "get",
        "path": "https://api.example.com/repos/{owner}/stars", "root": "https://example.com/", "inputs": [], "steps": 1,
        "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false,
        "provisional": false, "learned_at": 1, "graph": { "steps": [], "provisional": false }
    }))
    .unwrap()
}

/// Escapes that decode to nothing a person could read, or to bytes that aren't text, stay as they were written.
#[test]
fn an_escape_that_makes_no_character_is_left_as_written() {
    assert_eq!(prepare("a\\u0000b"), "a\\u0000b", "a NUL isn't made from an escape");
    assert_eq!(prepare("a&#0;b"), "a&#0;b");
    assert_eq!(prepare("a&#xD800;b"), "a&#xD800;b", "a surrogate is no character");
    assert_eq!(prepare("a&#;b &#x;c &#12345678;d"), "a&#;b &#x;c &#12345678;d", "no digits, or too many");
    assert_eq!(prepare("a%ff%feb"), "a%ff%feb", "percent-escapes that aren't UTF-8 stay");
    assert_eq!(prepare("%41%42"), "AB", "while ones that are text decode");
    assert_eq!(prepare("x\u{200b}y\u{202e}z"), "xyz", "and nothing invisible survives");
}

/// An address is an address in whichever form: more than one `::` is none.
#[test]
fn a_run_of_hex_with_two_gaps_is_not_an_ipv6_address() {
    assert!(is_ipv6("2001:db8::1"));
    assert!(!is_ipv6("1::2::3"));
    assert!(!is_ipv6("1::2::3:4:5:6:7:8"), "two gaps, even with eight groups");
    assert!(!is_ipv6("1:2:3:4:5:6:7"), "seven groups and no gap");
    assert!(!is_ipv6("12345::1"), "a group of five digits");
}

#[test]
fn text_is_classified_as_what_a_report_must_not_carry() {
    assert_eq!(classify("see Vault:github.com", false), Some("vault"));
    assert_eq!(classify("a@b.example", false), Some("email"));
    assert_eq!(classify("10.0.0.1", false), Some("ip"));
    assert_eq!(classify("10.0.0.1:8080", false), Some("ip"));
    assert_eq!(classify("123456789", false), Some("number"));
    assert_eq!(classify("1234", false), None);
    assert_eq!(classify("1234", true), Some("number"), "four digits make a number in a path");
    assert_eq!(classify("0xdead0eef", false), Some("hex"));
    assert_eq!(classify("abcdef0123456789", false), Some("hex"));
    assert_eq!(classify("", false), None);
    assert_eq!(classify("repos", false), None);
}

#[test]
fn a_host_is_masked_by_what_it_is() {
    let mut c = Counts::new();
    assert_eq!(mask_host("[::1]", &mut c, false), "[ip]");
    assert_eq!(mask_host("[local]", &mut c, false), "[local]", "a mask already in place is kept");
    assert_eq!(mask_host("2001:db8::1", &mut c, false), "[ip]");
    assert_eq!(mask_host("10.1.2.3:8080", &mut c, true), "[ip]");
    assert_eq!(mask_host("localhost", &mut c, false), "[internal]");
    assert_eq!(mask_host("a.example.com:8080", &mut c, true), "[internal]", "a port other than the web's is a machine's");
    assert_eq!(mask_host("alice.example.com:443", &mut c, true), "*.example.com");
    assert_eq!(mask_host("a.b.example.co.uk", &mut c, false), "*.example.co.uk");
    assert_eq!(mask_host("", &mut c, false), "");
    assert_eq!(c["ip"], 3);
    assert_eq!(c["internal"], 2);
}

/// What follows a secret key's name in a URL's path, query-ish or not, is masked up to the next `&`.
#[test]
fn a_value_after_a_secret_key_is_masked_to_the_next_ampersand() {
    let mut c = Counts::new();
    assert_eq!(scrub("password=hunter2hunter2=x&page=2", &mut c), "password=[secret]&page=2");
    assert_eq!(c["secret"], 1);
    let mut c = Counts::new();
    assert_eq!(scrub("token:abc:def", &mut c), "token:[secret]");
    let mut c = Counts::new();
    assert_eq!(scrub("password =hunter2abc", &mut c), "password =[secret]", "a key, a space, then its value");
    assert_eq!(c["secret"], 1);
    let mut c = Counts::new();
    assert_eq!(scrub("password = hunter2abc", &mut c), "password = [secret]");
    let mut c = Counts::new();
    assert_eq!(scrub("password =", &mut c), "password =");
    let mut c = Counts::new();
    assert_eq!(scrub("password =true", &mut c), "password =true", "a plain value says nothing");
    assert!(c.is_empty());
}

#[test]
fn a_url_is_kept_as_scheme_host_and_path_only() {
    let mut c = Counts::new();
    assert_eq!(reduce_url("not a url", &mut c), "[url]");
    assert_eq!(reduce_url("1http://x.example.com/a", &mut c), "[url]", "a scheme starts with a letter");
    assert_eq!(reduce_url("ht tp://x.example.com/a", &mut c), "[url]");
    assert_eq!(c["url"], 3);
    let mut c = Counts::new();
    assert_eq!(reduce_url("HTTPS://bob:pw@x.example.com/a?q=1#f", &mut c), "https://*.example.com/a");
    assert_eq!((c["login"], c["query"]), (1, 1));
    assert_eq!(scrub_word("", &mut Counts::new()), (String::new(), None));
}

#[test]
fn text_without_its_trailing_newline_is_one_clean_line() {
    assert_eq!(clean("a\n", true), "a");
    assert_eq!(clean("a\nb\t\tc\u{7}", true), "a b c");
    assert_eq!(clean(" a\nb \n", false), "a\nb");
}

#[test]
fn a_word_inside_another_word_is_not_the_owners_word() {
    let mut c = Counts::new();
    assert_eq!(replace_word("johnson and John.", "john", "[user]", &mut c), "johnson and [user].");
    assert_eq!(c["personal"], 1);
    let known = Known::of(&[("alice", "[user]"), ("/", "x"), ("true", "[account]"), ("al", "[node]")]);
    let mut c = Counts::new();
    assert_eq!(known.apply("alice said true to al", &mut c), "[user] said true to al", "short words, the root and a report's own words are left");
}

/// The words a report masks are read from this machine: the home folder, the user, the node's name, the vault's accounts.
#[test]
fn what_this_machine_knows_is_read_from_its_home_and_vault() {
    let _home = store::scratch_home("report-known");
    store::write_json(
        &store::home().join("vault.json"),
        &unbrowse_files::VAULT,
        &vec![serde_json::from_value::<crate::vault::Login>(json!({ "site": "github.com", "account": "zelda-the-tester", "kind": "derived", "created": 1 })).unwrap()],
    )
    .ok();
    let known = Known::here("workshop-box");
    let mut c = Counts::new();
    let user = unbrowse_files::private::user_home().file_name().map(|u| u.to_string_lossy().to_string()).unwrap_or_default();
    let told = known.apply("on workshop-box as zelda-the-tester", &mut c);
    assert!(told.contains("[node]") && !told.contains("workshop-box"), "{told}");
    if user.chars().count() >= 4 {
        assert!(known.apply(&format!("hi {user}!"), &mut c).contains("[user]"));
    }
    let home = unbrowse_files::private::user_home().to_string_lossy().to_string();
    if home.chars().count() >= 4 && home != "/" {
        assert!(known.apply(&format!("at {home}/x"), &mut c).starts_with("at ~"));
    }
}

/// A page keeps its scheme, host and plain path; what isn't a URL character is escaped, and what isn't a web page is nothing.
#[test]
fn a_page_is_kept_as_a_public_host_and_a_plain_path() {
    let none = Known::none();
    let mut c = Counts::new();
    assert_eq!(page("ftp://files.example.com/a", &none, &mut c), None, "not a web address");
    assert_eq!(page("example.com/a", &none, &mut c), None, "no scheme");
    assert_eq!(page("https://exa mple.com/a", &none, &mut c), None, "a host with a space isn't one");
    assert_eq!(page("https://www.example.com/caf\u{e9}/x", &none, &mut c).as_deref(), Some("https://*.example.com/{id}/x"));
    assert_eq!(path_chars("/caf\u{e9} au"), "/caf%C3%A9%20au");
    assert_eq!(path_chars("plain"), "/plain");
    assert_eq!(page("https://u:p@127.0.0.1:8080/x?y=1", &none, &mut c).as_deref(), Some("https://[ip]/x"));
    assert_eq!((c["login"], c["query"]), (1, 1));
}

#[test]
fn a_host_the_public_dns_doesnt_answer_for_is_internal() {
    let none = Known::none();
    let mut c = Counts::new();
    assert_eq!(public_host("[abc]", &none, &mut c), "[abc]", "a mask is kept");
    assert_eq!(public_host("[fe80::1]", &none, &mut c), "[ip]");
    assert_eq!(public_host("intranet.corp", &none, &mut c), "[internal]");
    assert_eq!(public_host("localhost:3000", &none, &mut c), "[internal]");
    assert_eq!(public_host("co.uk", &none, &mut c), "[internal]", "a suffix is no one's site");
    assert_eq!(public_host("a.b.example.com.", &none, &mut c), "*.example.com");
    assert_eq!(public_host("x.github.io", &none, &mut c), "*.github.io", "a tenant's name goes");
    let owner = Known::of(&[("example", "[user]")]);
    assert_eq!(public_host("www.example.com", &owner, &mut c), "[personal]", "the owner's own site names them");
}

#[test]
fn a_route_that_isnt_http_shaped_is_no_shape() {
    let none = Known::none();
    let mut r = a_route();
    r.method = "FETCH".into();
    assert!(shape(&r, &none, &mut Counts::new()).is_none(), "a method the relay doesn't know");
    let mut r = a_route();
    r.path = "https://exa mple.com/a".into();
    assert!(shape(&r, &none, &mut Counts::new()).is_none(), "a host that isn't one");
    let mut c = Counts::new();
    let mut r = a_route();
    r.path = "https://api.example.com/x/{id}?a={b}".into();
    r.inputs = vec![store::RouteInput { name: "q r!".into(), secret: false, default: None, file: false, optional: false, options: Vec::new() }];
    let s = shape(&r, &none, &mut c).unwrap();
    assert_eq!(s["method"], "GET");
    assert_eq!(s["path"], "/x/{id}");
    assert_eq!(s["inputs"], json!(["q_r_"]));
    assert_eq!(c["query"], 1);
}

#[test]
fn a_report_the_relay_would_refuse_says_why() {
    let ok = report_of("failed", "it broke", "");
    assert!(check(&ok).is_ok());
    let with = |f: &dyn Fn(&mut Map<String, Value>)| {
        let mut r = ok.clone();
        f(r.as_object_mut().unwrap());
        check(&r).unwrap_err()
    };
    assert_eq!(check(&json!([1])).unwrap_err(), "a report is an object");
    assert_eq!(with(&|o| { o.remove("os"); }), "missing field: os");
    assert!(with(&|o| { o.insert("kind".into(), json!("nope")); }).starts_with("kind is one of wrong_data"));
    assert_eq!(with(&|o| { o.insert("source".into(), json!("web")); }), "source is agent or node");
    assert_eq!(with(&|o| { o.insert("summary".into(), json!("  ")); }), "summary says what went wrong");
    assert_eq!(with(&|o| { o.insert("got".into(), json!("x".repeat(100_000))); }), format!("got is at most {} characters", max("got")));
    assert_eq!(with(&|o| { o.insert("tool".into(), json!("rm")); }), "tool is not an allowed value");
    for u in ["https://x.example.com/a?q=1", "https://x.example.com/a b", "https://u@x.example.com/"] {
        assert_eq!(with(&|o| { o.insert("url".into(), json!(u)); }), "url is a scheme, host and path only", "{u}");
    }
    assert_eq!(with(&|o| { o.insert("route".into(), json!("r1")); }), "route is an object");
    assert_eq!(with(&|o| { o.insert("route".into(), json!({ "cookie": "x" })); }), "route field not allowed: cookie");
    assert_eq!(with(&|o| { o.insert("last_error".into(), json!(3)); }), "last_error is an object");
    assert_eq!(with(&|o| { o.insert("last_error".into(), json!({ "body": "x" })); }), "last_error field not allowed: body");
    assert_eq!(with(&|o| { o.insert("extra".into(), json!(1)); }), "field not allowed: extra");
}

#[test]
fn the_reports_command_saves_the_owners_choice_and_says_when_it_cant() {
    let home = store::scratch_home("report-cli");
    assert_eq!(cli(&["bogus".into()]), 2, "an unknown word is a usage error");
    assert_eq!(cli(&["off".into()]), 0);
    assert!(!load_saved().on);
    assert_eq!(cli(&["on".into()]), 0);
    assert!(load_saved().on);
    assert_eq!(cli(&[]), 0);
    // A folder where the choice is kept: it can't be saved, and the command fails.
    std::fs::remove_file(home.join("reports.json")).unwrap();
    std::fs::create_dir(home.join("reports.json")).unwrap();
    assert_eq!(cli(&["off".into()]), 1);
}

#[test]
fn a_choice_a_newer_node_wrote_reads_as_off() {
    let home = store::scratch_home("report-newer");
    std::fs::write(home.join("reports.json"), r#"{"v": 9999, "on": true}"#).unwrap();
    assert!(!load_saved().on, "an owner's off must never be read as on");
    std::fs::remove_file(home.join("reports.json")).unwrap();
    assert!(load_saved().on, "no choice is on");
}

/// An owner's queue holds at most fifty, one per problem, the oldest let go first.
#[test]
fn the_owners_queue_holds_fifty_and_lets_the_oldest_go() {
    let _home = store::scratch_home("report-queue-cap");
    let now = store::now();
    let mut first = String::new();
    for i in 0..52 {
        let r = report_of("failed", "it broke", &format!("https://site{i}.org/"));
        if i == 0 {
            first = fingerprint(&r);
        }
        hold_for_owner(&r, &Counts::new(), now + i);
    }
    let w = waiting();
    assert_eq!(w.len(), QUEUE_MAX);
    assert!(w.iter().all(|e| e["fingerprint"] != json!(first)), "the oldest is gone");
    assert!(waiting_text(&first).is_none());
    assert!(discard_waiting(&first).is_err());
    // The same problem again replaces its place, not adds one.
    let again = report_of("failed", "still broke", "https://site51.org/");
    hold_for_owner(&again, &Counts::new(), now + 60);
    assert_eq!(waiting().len(), QUEUE_MAX);
}

/// The owner's go-ahead on a node that isn't on the network sends nothing: the report comes back as it would have gone.
#[test]
fn a_report_the_owner_sends_from_a_node_off_the_network_goes_nowhere() {
    let _home = store::scratch_home("report-send-off");
    let r = report_of("failed", "it broke", "");
    hold_for_owner(&r, &Counts::new(), store::now());
    let fp = fingerprint(&r);
    let sent = rt().block_on(send_waiting(&fp)).unwrap();
    assert_eq!(sent["report"], "off", "{sent}");
    assert!(sent["why"].as_str().unwrap().contains("bug reports off"));
    assert!(rt().block_on(send_waiting(&fp)).unwrap_err().contains("no report waits"), "it left the queue");
}

#[test]
fn a_node_off_the_network_shows_an_agent_its_report_and_sends_nothing() {
    let home = store::scratch_home("report-from-agent");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    let node = Arc::new(Node {
        keys: Box::new(keys),
        identity: std::sync::RwLock::new(None),
        info: crate::NodeInfo { name: "workshop-box".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: crate::chain::Chain::default(),
        chain_error: Mutex::new(None),
        events: crate::api::Events::default(),
        net: OnceLock::new(),
        share: crate::share::Share::default(),
    });
    let bad = rt.block_on(from_agent(&node, "a1", &json!({ "kind": "nonsense", "summary": "x" }))).unwrap_err();
    assert_eq!(bad.0, StatusCode::BAD_REQUEST);
    assert!(bad.1.starts_with("kind is one of"));
    // A call the agent just made that failed: the report names it.
    observe("a1", "unbrowse_do", &json!({}), &Err((StatusCode::BAD_GATEWAY, "x".into())));
    let said = rt.block_on(from_agent(&node, "a1", &json!({ "kind": "failed", "summary": "it broke on workshop-box", "tool": "do", "url": "https://x.example.com/a?q=1" }))).unwrap();
    assert_eq!(said["report"], "off", "{said}");
    assert!(said["why"].as_str().unwrap().contains("off the network"));
    assert_eq!(said["contents"]["version"], "0.0.0", "a version the relay can't take reports as 0.0.0");
    assert_eq!(said["contents"]["summary"], "it broke on [node]");
    assert_eq!(said["contents"]["tool"], "unbrowse_do");
    assert_eq!(said["contents"]["last_error"]["error"], "the node answered 502");
    assert!(said["contents"].get("install_id").is_none(), "the owner is shown no install id");
    assert_eq!(said["contents"]["url"], "https://*.example.com/a");
}

#[test]
fn a_node_that_cannot_make_its_report_key_sends_nothing() {
    let home = store::scratch_home("report-nokey");
    std::fs::create_dir(home.join("report.key")).unwrap();
    let (url, got) = relay(200, json!({}));
    let out = rt().block_on(send(&cfg(&url), &report_of("failed", "it broke", "")));
    assert_eq!(out, Outcome::Later("the node's report key couldn't be made".into()));
    std::thread::sleep(Duration::from_millis(150));
    assert!(got.locked().is_empty());
}

#[test]
fn a_report_that_cant_be_sent_is_kept_for_later_and_the_relays_word_is_read() {
    let _home = store::scratch_home("report-send-outcomes");
    let r = report_of("failed", "it broke", "");
    let (url, got) = relay(201, json!({ "issue": "https://github.com/x/y/issues/3", "new": true, "reports": 4 }));
    assert_eq!(rt().block_on(send(&cfg(&url), &r)), Outcome::Sent { issue: Some("https://github.com/x/y/issues/3".into()), new: true, reports: Some(4) });
    let sent = got.locked().clone();
    assert_eq!(sent, vec![r.clone()], "the relay got the report as built");
    let (url, _) = relay(422, json!({ "error": "summary too vague" }));
    assert_eq!(rt().block_on(send(&cfg(&url), &r)), Outcome::Refused("summary too vague".into()));
    let (url, _) = relay(404, Value::Null);
    assert!(matches!(rt().block_on(send(&cfg(&url), &r)), Outcome::Refused(m) if m.contains("404")));
    let (url, _) = relay(503, json!({ "error": "busy" }));
    assert_eq!(rt().block_on(send(&cfg(&url), &r)), Outcome::Later("busy".into()));
    let (url, _) = relay(500, Value::Null);
    assert!(matches!(rt().block_on(send(&cfg(&url), &r)), Outcome::Later(m) if m.contains("500")));
    assert_eq!(rt().block_on(send(&cfg("http://127.0.0.1:1/v1/reports"), &r)), Outcome::Later("the relay didn't answer (offline?)".into()));
}

/// What waited over a week is let go rather than sent: the relay hears nothing of it.
#[test]
fn a_report_that_waited_over_a_week_is_dropped_not_sent() {
    let _home = store::scratch_home("report-flush-old");
    saved_on();
    let now = 100 * 86_400;
    let (url, got) = relay(201, json!({ "issue": "i", "new": true }));
    let old = report_of("failed", "old trouble", "");
    let fresh = report_of("slow", "fresh trouble", "");
    store::write_json(&queue_path(), &unbrowse_files::REPORTS_QUEUE, &vec![Queued { at: now - 8 * 86_400, report: old }, Queued { at: now - 86_400, report: fresh.clone() }]).unwrap();
    assert_eq!(rt().block_on(flush(&cfg(&url), now)), 1);
    assert_eq!(got.locked().as_slice(), std::slice::from_ref(&fresh), "only the fresh one went");
    let left: Vec<Queued> = store::read_json(&queue_path(), &unbrowse_files::REPORTS_QUEUE);
    assert!(left.is_empty(), "both are off the queue");
    assert_eq!(rt().block_on(flush(&Config::off(), now)), 0, "a node with reports off flushes nothing");
}

#[test]
fn a_node_sends_at_most_its_reports_a_day() {
    let _home = store::scratch_home("report-limit");
    saved_on();
    let now = 100 * 86_400;
    let (url, got) = relay(201, json!({ "issue": "i", "new": true }));
    let state = State { day: day_of(now), agent: AGENT_PER_DAY, node: 0, sent: BTreeMap::new() };
    store::write_json(&state_path(), &unbrowse_files::REPORTS_STATE, &state).unwrap();
    let r = report_of("failed", "it broke", "");
    let out = rt().block_on(file(&cfg(&url), r.clone(), Counts::new(), "agent", now));
    assert_eq!(out["report"], "limited", "{out}");
    assert!(out["why"].as_str().unwrap().contains("at most 20 reports a day"));
    assert!(got.locked().is_empty(), "nothing was sent");
    // The node's own reports have their own, smaller, allowance.
    let out = rt().block_on(file(&cfg(&url), r, Counts::new(), "node", now));
    assert_eq!(out["report"], "sent", "{out}");
}

#[test]
fn a_problem_the_node_noticed_is_not_reported_when_reports_never_started() {
    let _home = store::scratch_home("report-by-node");
    by_node("failed", "it broke", Some("unbrowse_do"), None, "the node answered 500");
    internal_error("unbrowse_do", Some("no-such-route"), "boom");
    internal_error("unbrowse_do", None, "worker panicked at x.rs:1");
    failed_use(&a_route(), false, 10, Some("Failed: step 1 answered 500"));
    assert!(!queue_path().exists(), "a node with reports off queues nothing");
    assert!(FAILED_USES.locked().iter().any(|u| u.0 == "r1" && !u.3), "an own route's failure isn't reported");
}

#[test]
fn a_failed_calls_variant_is_noted_for_the_report_that_follows() {
    note_failure("route-x", "Failed: step 2 answered 500");
    assert_eq!(failure_of(Some("route-x")), "Failed: step 2 answered 500");
    assert_eq!(failure_of(Some("route-never")), "");
    assert_eq!(failure_of(None), "");
    let args = json!({ "route_id": "route-x" });
    observe("agent-z", "unbrowse_call", &args, &Ok(json!({ "ok": false })));
    let last = last_of("agent-z").unwrap();
    assert_eq!(last.route_id.as_deref(), Some("route-x"));
    assert_eq!(last.failure.unwrap().error, "Failed: step 2 answered 500");
    // A later call that went well keeps the failure that came before it.
    observe("agent-z", "unbrowse_call", &json!({}), &Ok(json!({ "ok": true, "route": { "id": "route-y" } })));
    let last = last_of("agent-z").unwrap();
    assert_eq!(last.route_id.as_deref(), Some("route-y"));
    assert!(last.failure.is_some());
}

#[test]
fn reports_are_started_off_in_a_node_whose_telemetry_is_off() {
    // Telemetry never started in a test, so a start says off and leaves no sender or panic hook behind.
    start("1.2.3", true, "workshop-box");
    assert!(GLOBAL.get().is_some_and(|g| !g.cfg.on && g.cfg.version == "1.2.3"));
    assert!(WAKE.get().is_none());
}
