//! `quiet::set_pages` against a fake browser's DevTools socket: which targets are frozen, closed, kept or skipped, and
//! what the owner is told of the ones that couldn't be.

use super::*;
use std::sync::{Arc, Mutex};

type Seen = Arc<Mutex<Vec<(String, Option<String>, Value)>>>;

/// A DevTools socket on 127.0.0.1 that lists `targets`, hands out the session `session` (none when `None`), fails
/// every command named in `fail`, and records every command it is sent (method, session, params).
fn fake_devtools(targets: Value, session: Option<&'static str>, fail: &'static [&'static str]) -> (String, Seen) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Seen = Arc::default();
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (targets, log) = (targets.clone(), log.clone());
            std::thread::spawn(move || {
                let Ok(mut socket) = tokio_tungstenite::tungstenite::accept(stream) else { return };
                while let Ok(msg) = socket.read() {
                    let Ok(text) = msg.to_text() else { continue };
                    let Ok(cmd) = serde_json::from_str::<Value>(text) else { continue };
                    let method = cmd["method"].as_str().unwrap_or_default().to_string();
                    log.lock().unwrap().push((method.clone(), cmd["sessionId"].as_str().map(String::from), cmd["params"].clone()));
                    let reply = if fail.contains(&method.as_str()) {
                        json!({ "id": cmd["id"], "error": { "code": -32000, "message": format!("{method} refused") } })
                    } else {
                        let result = match method.as_str() {
                            "Target.getTargets" => json!({ "targetInfos": targets }),
                            "Target.attachToTarget" => session.map_or(json!({}), |s| json!({ "sessionId": s })),
                            _ => json!({}),
                        };
                        json!({ "id": cmd["id"], "result": result })
                    };
                    let _ = socket.send(tokio_tungstenite::tungstenite::Message::text(reply.to_string()));
                }
            });
        }
    });
    (format!("ws://127.0.0.1:{port}/devtools/browser/fake"), seen)
}

fn targets() -> Value {
    json!([
        { "targetId": "tab-a", "type": "page", "url": "https://a.example/" },
        { "targetId": "tab-keep", "type": "page", "url": "https://keep.example/" },
        { "targetId": "sw-1", "type": "service_worker", "url": "https://a.example/sw.js" },
        { "targetId": "sh-1", "type": "shared_worker", "url": "https://a.example/shared.js" },
        { "targetId": "bg-1", "type": "background_page", "url": "chrome-extension://x/" }
    ])
}

fn methods(seen: &Seen) -> Vec<String> {
    seen.lock().unwrap().iter().map(|(m, _, _)| m.clone()).collect()
}

fn targeted(seen: &Seen, method: &str) -> Vec<String> {
    seen.lock().unwrap().iter().filter(|(m, _, _)| m == method).map(|(_, _, p)| p["targetId"].as_str().unwrap_or_default().to_string()).collect()
}

#[test]
fn a_hold_freezes_every_page_but_the_checkouts_and_closes_every_worker() {
    let (ws, seen) = fake_devtools(targets(), Some("s1"), &[]);
    let q = run(set_pages(&ws, Some("tab-keep"), "frozen")).unwrap();
    assert!(q.failed.is_empty(), "nothing failed: {:?}", q.failed);
    assert_eq!(q.done, 3, "one page frozen, a service worker and a shared worker closed; the kept tab and the odd target left");
    assert_eq!(targeted(&seen, "Target.attachToTarget"), vec!["tab-a"], "only the other page is attached to");
    assert_eq!(targeted(&seen, "Target.closeTarget"), vec!["sw-1", "sh-1"]);
    let log = seen.lock().unwrap();
    let frozen = log.iter().find(|(m, _, _)| m == "Page.setWebLifecycleState").expect("the page was told its state");
    assert_eq!(frozen.1.as_deref(), Some("s1"), "on the page's own session");
    assert_eq!(frozen.2["state"], "frozen");
    drop(log);
    let order = methods(&seen);
    let at = |m: &str| order.iter().position(|x| x == m).unwrap_or_else(|| panic!("{m} was never sent: {order:?}"));
    assert!(at("Page.stopLoading") < at("Page.setWebLifecycleState"), "its loading stops before it is frozen: {order:?}");
    assert!(at("Page.setWebLifecycleState") < at("Target.detachFromTarget"), "and the session is let go after: {order:?}");
}

#[test]
fn waking_makes_pages_active_and_leaves_the_workers_closed_at_the_hold_alone() {
    let (ws, seen) = fake_devtools(targets(), Some("s1"), &[]);
    let q = run(set_pages(&ws, None, "active")).unwrap();
    assert_eq!(q.done, 2, "both pages, no worker");
    assert!(q.failed.is_empty());
    assert_eq!(targeted(&seen, "Target.attachToTarget"), vec!["tab-a", "tab-keep"]);
    assert!(targeted(&seen, "Target.closeTarget").is_empty(), "a worker is not closed when waking");
    let order = methods(&seen);
    assert!(!order.iter().any(|m| m == "Page.stopLoading"), "a page waking is not stopped: {order:?}");
    assert!(seen.lock().unwrap().iter().any(|(m, _, p)| m == "Page.setWebLifecycleState" && p["state"] == "active"));
}

#[test]
fn a_browser_that_cannot_list_its_targets_is_said_so() {
    let (ws, _) = fake_devtools(targets(), Some("s1"), &["Target.getTargets"]);
    let err = run(set_pages(&ws, None, "frozen")).unwrap_err();
    assert!(err.starts_with("couldn't list the browser's pages and workers"), "{err}");
    assert!(err.contains("Target.getTargets refused"), "with the browser's own reason: {err}");
}

#[test]
fn a_browser_nobody_answers_for_is_said_unreachable() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let err = run(set_pages(&format!("ws://127.0.0.1:{port}/devtools/browser/gone"), None, "frozen")).unwrap_err();
    assert!(err.starts_with("couldn't reach the browser's DevTools"), "{err}");
}

#[test]
fn a_page_that_would_not_freeze_is_named_with_its_url_and_the_rest_still_are() {
    let (ws, seen) = fake_devtools(targets(), Some("s1"), &["Page.setWebLifecycleState"]);
    let q = run(set_pages(&ws, Some("tab-keep"), "frozen")).unwrap();
    assert_eq!(q.done, 2, "the two workers were closed all the same");
    assert_eq!(q.failed.len(), 1, "{:?}", q.failed);
    assert!(q.failed[0].starts_with("page at https://a.example/: "), "{}", q.failed[0]);
    assert!(q.failed[0].contains("Page.setWebLifecycleState refused"), "{}", q.failed[0]);
    assert!(methods(&seen).iter().any(|m| m == "Target.detachFromTarget"), "the session is let go even when freezing failed");
}

#[test]
fn a_worker_that_would_not_close_is_named_by_its_kind_and_url() {
    let (ws, _) = fake_devtools(targets(), Some("s1"), &["Target.closeTarget"]);
    let q = run(set_pages(&ws, None, "frozen")).unwrap();
    assert_eq!(q.done, 2, "the two pages");
    assert_eq!(q.failed.len(), 2, "{:?}", q.failed);
    assert!(q.failed.iter().any(|f| f.starts_with("service_worker at https://a.example/sw.js: ")), "{:?}", q.failed);
    assert!(q.failed.iter().any(|f| f.starts_with("shared_worker at https://a.example/shared.js: ")), "{:?}", q.failed);
}

#[test]
fn a_page_the_browser_gives_no_session_for_is_said_so_and_never_frozen() {
    let (ws, seen) = fake_devtools(json!([{ "targetId": "tab-a", "type": "page", "url": "https://a.example/" }]), None, &[]);
    let q = run(set_pages(&ws, None, "frozen")).unwrap();
    assert_eq!(q.done, 0);
    assert_eq!(q.failed, vec!["page at https://a.example/: no session".to_string()]);
    assert!(!methods(&seen).iter().any(|m| m == "Page.setWebLifecycleState"), "nothing was frozen without a session");
}

#[test]
fn a_page_that_would_not_be_attached_to_is_named() {
    let (ws, _) = fake_devtools(json!([{ "targetId": "tab-a", "type": "page", "url": "https://a.example/" }]), Some("s1"), &["Target.attachToTarget"]);
    let q = run(set_pages(&ws, None, "frozen")).unwrap();
    assert_eq!(q.done, 0);
    assert!(q.failed[0].starts_with("page at https://a.example/: ") && q.failed[0].contains("attachToTarget refused"), "{:?}", q.failed);
}
