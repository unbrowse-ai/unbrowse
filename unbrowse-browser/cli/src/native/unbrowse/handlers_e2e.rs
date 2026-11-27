//! Upstream's daemon handlers in a real browser, held by the fork (UNB-208): the commands upstream's own e2e suite
//! leaves unrun, or runs only through an `evaluate` probe the agent's world refuses (`tests-not-run.tsv`). Each
//! test drives the daemon as a command does and checks the page through `page_evaluate`, the test's own script in
//! the page's world (`world_e2e.rs`). They need Chrome and are `#[ignore]`d like upstream's e2e tests:
//! `cargo test --manifest-path unbrowse-browser/cli/Cargo.toml unbrowse::handlers_e2e -- --ignored --test-threads=1`.

use serde_json::{json, Value};

use super::super::actions::DaemonState;
use super::world_e2e::{assert_success, run, start_routed_server};

fn page_route(_method: &str, path: &str) -> (u16, String, String) {
    let page = r#"<!doctype html><title>start</title><link rel=icon href='data:,'>
        <ul id=list><li class=row onclick="document.title='row 1'">one</li><li class=row onclick="document.title='row 2'">two</li>
        <li class=row onclick="document.title='row 3'">three</li></ul>
        <input id=q><button id=warn onclick="alert('careful'); document.title = 'warned'">warn</button><button id=ask onclick="document.title = 'said ' + prompt('name?')">ask</button>
        <div id=touch style="width:400px;height:400px"></div>
        <iframe id=f src="/inner"></iframe>
        <script>
          window.touches = 0;
          document.getElementById('touch').addEventListener('touchmove', () => window.touches++);
          document.addEventListener('touchmove', () => window.touches++);
          setTimeout(() => { const p = document.createElement('p'); p.id = 'late'; document.body.appendChild(p); }, 300);
          setInterval(() => fetch('/data').catch(() => {}), 150);
        </script>"#;
    match path {
        "/" => (200, String::new(), page.to_string()),
        "/inner" => (200, String::new(), "<p id=inner>inside</p><p id=gone style='display:none'>x</p>".to_string()),
        "/data" => (200, String::new(), "payload-42".to_string()),
        _ => (404, String::new(), "no".to_string()),
    }
}

async fn launched(base_url: &str) -> DaemonState {
    let mut state = DaemonState::new();
    assert_success(&run(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&run(&json!({ "id": "open", "action": "navigate", "url": format!("{base_url}/") }), &mut state).await);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    state
}

async fn page(state: &mut DaemonState, script: &str) -> Value {
    let resp = run(&json!({ "id": "p", "action": "page_evaluate", "script": script }), state).await;
    assert_success(&resp);
    resp["data"]["result"].clone()
}

async fn ok(state: &mut DaemonState, cmd: Value) -> Value {
    let resp = run(&cmd, state).await;
    assert_success(&resp);
    resp["data"].clone()
}

async fn fails(state: &mut DaemonState, cmd: Value) -> String {
    let resp = run(&cmd, state).await;
    assert_eq!(resp["success"], false, "{cmd} should fail: {resp}");
    resp["error"].as_str().unwrap_or_default().to_string()
}

/// `nth` acts on the element at an index (from the end when negative) and names the index it can't find; `wait` for a
/// selector reads inside the frame `frame` picked, in each state, until `mainframe`; `waitforfunction` waits for a
/// condition to hold.
#[tokio::test]
#[ignore]
async fn e2e_nth_frames_and_waits_act_where_they_are_pointed() {
    let (base_url, server) = start_routed_server(page_route).await;
    let mut state = launched(&base_url).await;

    ok(&mut state, json!({ "id": "n", "action": "nth", "selector": ".row", "index": -1, "subaction": "click" })).await;
    assert_eq!(page(&mut state, "document.title").await, "row 3");
    ok(&mut state, json!({ "id": "n", "action": "nth", "selector": ".row", "index": 1, "subaction": "click" })).await;
    assert_eq!(page(&mut state, "document.title").await, "row 2");
    let missing = fails(&mut state, json!({ "id": "n", "action": "nth", "selector": ".row", "index": 9, "subaction": "click" })).await;
    assert!(missing.contains("No element at index 9 for selector '.row'"), "{missing}");
    assert_eq!(page(&mut state, "document.querySelectorAll('[data-agent-browser-located]').length").await, 0, "the mark is taken off");

    let done = ok(&mut state, json!({ "id": "w", "action": "waitforfunction", "expression": "document.getElementById('late') !== null", "timeout": 5000 })).await;
    assert_eq!(done["result"], true, "{done}");
    let late = fails(&mut state, json!({ "id": "w", "action": "waitforfunction", "expression": "document.getElementById('never') !== null", "timeout": 300 })).await;
    assert!(!late.is_empty());

    ok(&mut state, json!({ "id": "f", "action": "frame", "selector": "#f" })).await;
    for (selector, wanted) in [("#inner", "visible"), ("#inner", "attached"), ("#gone", "hidden"), ("#nothing", "detached")] {
        ok(&mut state, json!({ "id": "w", "action": "wait", "selector": selector, "state": wanted, "timeout": 3000 })).await;
    }
    let absent = fails(&mut state, json!({ "id": "w", "action": "wait", "selector": "#nothing", "state": "visible", "timeout": 300 })).await;
    assert!(!absent.is_empty());
    let text = ok(&mut state, json!({ "id": "g", "action": "gettext", "selector": "#inner" })).await;
    assert_eq!(text["text"], "inside", "{text}");
    ok(&mut state, json!({ "id": "m", "action": "mainframe" })).await;
    let outside = fails(&mut state, json!({ "id": "w", "action": "wait", "selector": "#inner", "state": "visible", "timeout": 300 })).await;
    assert!(!outside.is_empty(), "back in the main frame, the frame's element is not found");

    let _ = run(&json!({ "id": "close", "action": "close" }), &mut state).await;
    server.abort();
}

/// A route answers matching requests with its own body, or aborts them, until it is removed; `responsebody` hands
/// back the body of the next response that matches; `requests` lists what the page fetched.
#[tokio::test]
#[ignore]
async fn e2e_routes_answer_or_abort_and_responses_are_read_back() {
    let (base_url, server) = start_routed_server(page_route).await;
    let mut state = launched(&base_url).await;

    let body = ok(&mut state, json!({ "id": "r", "action": "responsebody", "url": "/data", "timeout": 5000 })).await;
    assert!(body.to_string().contains("payload-42"), "{body}");
    let none = fails(&mut state, json!({ "id": "r", "action": "responsebody", "url": "/never", "timeout": 300 })).await;
    assert!(none.contains("timed out"), "a response that never comes times out: {none}");

    ok(&mut state, json!({ "id": "rt", "action": "route", "url": "**/mock", "response": { "status": 201, "body": "{\"mocked\":1}", "contentType": "application/json" } })).await;
    ok(&mut state, json!({ "id": "rt", "action": "route", "url": "**/blocked", "abort": true })).await;
    let mocked = page(&mut state, "fetch('/mock').then(async r => r.status + ' ' + await r.text())").await;
    assert_eq!(mocked, "201 {\"mocked\":1}");
    let blocked = page(&mut state, "fetch('/blocked').then(() => 'reached', () => 'aborted')").await;
    assert_eq!(blocked, "aborted");
    ok(&mut state, json!({ "id": "u", "action": "unroute", "url": "**/mock" })).await;
    let real = page(&mut state, "fetch('/mock').then(r => r.status)").await;
    assert_eq!(real, 404, "the route is gone");

    // Tracking starts with the first `requests` call: what the page fetched before it is not listed.
    let before = ok(&mut state, json!({ "id": "q", "action": "requests", "filter": "/data" })).await;
    assert_eq!(before["requests"], json!([]), "{before}");
    page(&mut state, "fetch('/data').then(r => r.status)").await;
    page(&mut state, "fetch('/mock', { method: 'POST', body: 'x' }).then(r => r.status)").await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let requests = ok(&mut state, json!({ "id": "q", "action": "requests", "filter": "/data" })).await;
    let listed = requests["requests"].as_array().cloned().unwrap_or_default();
    assert!(!listed.is_empty() && listed.iter().all(|r| r.to_string().contains("/data")), "{requests}");
    let posts = ok(&mut state, json!({ "id": "q", "action": "requests", "method": "POST", "status": "4xx" })).await;
    let posted = posts["requests"].as_array().cloned().unwrap_or_default();
    assert!(!posted.is_empty() && posted.iter().all(|r| r.to_string().contains("/mock")), "{posts}");
    let none = ok(&mut state, json!({ "id": "q", "action": "requests", "method": "PUT" })).await;
    assert_eq!(none["requests"], json!([]), "{none}");
    assert_eq!(ok(&mut state, json!({ "id": "q", "action": "requests", "clear": true })).await["cleared"], true);

    let _ = run(&json!({ "id": "close", "action": "close" }), &mut state).await;
    server.abort();
}

/// An alert is dismissed by itself; a prompt waits, `dialog status` names it, and `dialog accept` answers it with the
/// text given; keys typed go to the focused field; a swipe
/// sends touch moves; a new window is a new tab; the clipboard keeps what was written to it.
#[tokio::test]
#[ignore]
async fn e2e_dialogs_keys_touch_windows_and_clipboard_reach_the_page() {
    let (base_url, server) = start_routed_server(page_route).await;
    let mut state = launched(&base_url).await;

    ok(&mut state, json!({ "id": "c", "action": "click", "selector": "#warn" })).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(page(&mut state, "document.title").await, "warned", "an alert is dismissed by itself");
    let _ = run(&json!({ "id": "c", "action": "click", "selector": "#ask" }), &mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let open = ok(&mut state, json!({ "id": "d", "action": "dialog", "response": "status" })).await;
    assert_eq!((&open["hasDialog"], &open["type"], &open["message"]), (&json!(true), &json!("prompt"), &json!("name?")), "{open}");
    let handled = ok(&mut state, json!({ "id": "d", "action": "dialog", "response": "accept", "promptText": "Ada" })).await;
    assert_eq!(handled["accepted"], true, "{handled}");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(page(&mut state, "document.title").await, "said Ada");
    let closed = ok(&mut state, json!({ "id": "d", "action": "dialog", "response": "status" })).await;
    assert_eq!(closed["hasDialog"], false, "{closed}");

    ok(&mut state, json!({ "id": "f", "action": "focus", "selector": "#q" })).await;
    assert_eq!(ok(&mut state, json!({ "id": "k", "action": "keyboard", "subaction": "type", "text": "abc" })).await["typed"], "abc");
    ok(&mut state, json!({ "id": "k", "action": "keyboard", "subaction": "insertText", "text": "-x" })).await;
    assert_eq!(page(&mut state, "document.getElementById('q').value").await, "abc-x");

    let swiped = ok(&mut state, json!({ "id": "s", "action": "swipe", "direction": "left", "distance": 100 })).await;
    assert!(!swiped.is_null(), "{swiped}");
    ok(&mut state, json!({ "id": "s", "action": "swipe", "startX": 100, "startY": 300, "endX": 100, "endY": 100 })).await;
    let touches = page(&mut state, "window.touches").await;
    assert!(touches.as_i64().unwrap_or(0) > 0, "no touch move reached the page: {touches}");

    let window = ok(&mut state, json!({ "id": "w", "action": "window_new" })).await;
    assert!(window["total"].as_u64().unwrap_or(0) >= 2, "{window}");

    let written = run(&json!({ "id": "cb", "action": "clipboard", "operation": "write", "text": "copied text" }), &mut state).await;
    if written["success"] == true {
        let read = ok(&mut state, json!({ "id": "cb", "action": "clipboard", "operation": "read" })).await;
        assert!(read.to_string().contains("copied text"), "{read}");
    }

    let _ = run(&json!({ "id": "close", "action": "close" }), &mut state).await;
    server.abort();
}

/// A snapshot keeps to its selector and depth and lists links when asked; a screenshot compared with itself matches;
/// `vitals` reports the page's measures.
#[tokio::test]
#[ignore]
async fn e2e_snapshots_screenshot_diffs_and_vitals_describe_the_page() {
    let (base_url, server) = start_routed_server(page_route).await;
    let mut state = launched(&base_url).await;

    let scoped = ok(&mut state, json!({ "id": "s", "action": "snapshot", "selector": "#list", "compact": true, "maxDepth": 3, "urls": true })).await;
    let tree = scoped["snapshot"].as_str().unwrap_or_default().to_string();
    assert!(tree.contains("three") && !tree.contains("ask"), "{scoped}");
    let full = ok(&mut state, json!({ "id": "s", "action": "snapshot", "interactive": true })).await;
    assert!(full["snapshot"].as_str().unwrap_or_default().contains("ask"), "{full}");

    let dir = tempfile::tempdir().unwrap();
    let shot = dir.path().join("base.png");
    ok(&mut state, json!({ "id": "sh", "action": "screenshot", "path": shot.to_string_lossy() })).await;
    let same = ok(&mut state, json!({ "id": "d", "action": "diff_screenshot", "baseline": shot.to_string_lossy(),
        "output": dir.path().join("diff.png").to_string_lossy(), "threshold": 0.1 })).await;
    assert_eq!(same["match"], true, "{same}");
    let missing = fails(&mut state, json!({ "id": "d", "action": "diff_screenshot", "baseline": dir.path().join("none.png").to_string_lossy() })).await;
    assert!(!missing.is_empty());

    let vitals = ok(&mut state, json!({ "id": "v", "action": "vitals" })).await;
    assert!(vitals.is_object() && !vitals.as_object().unwrap().is_empty(), "{vitals}");

    let _ = run(&json!({ "id": "close", "action": "close" }), &mut state).await;
    server.abort();
}
