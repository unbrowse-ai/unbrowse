//! End-to-end tests for the native daemon.
//!
//! These tests launch a real Chrome instance and exercise the full command
//! pipeline. They require Chrome to be installed and are marked `#[ignore]`
//! so they don't run during normal `cargo test`.
//!
//! Run serially to avoid Chrome instance contention:
//!   cargo test e2e -- --ignored --test-threads=1

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::test_utils::EnvGuard;

use super::actions::{
    close_current_browser, execute_command, maybe_autosave_restore_state, DaemonState,
};

fn assert_success(resp: &Value) {
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "Expected success but got: {}",
        serde_json::to_string_pretty(resp).unwrap_or_default()
    );
}

fn get_data(resp: &Value) -> &Value {
    resp.get("data").expect("Missing 'data' in response")
}

async fn select_values(
    state: &mut DaemonState,
    id: &str,
    selector: &str,
    values: &[&str],
) -> Value {
    execute_command(
        &json!({ "id": id, "action": "select", "selector": selector, "values": values }),
        state,
    )
    .await
}

async fn assert_evaluate(state: &mut DaemonState, id: &str, script: &str, expected: Value) {
    let resp = execute_command(
        &json!({ "id": id, "action": "page_evaluate", "script": script }),
        state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], expected);
}

/// A control whose state follows its click by a moment, as a framework's does after a round of its own. Read too soon it
/// looks unclicked, and clicking it again left it wrong.
#[tokio::test]
#[ignore]
async fn e2e_a_control_that_answers_late_is_clicked_once() {
    let mut state = DaemonState::new();
    let page = "data:text/html,<div id=c role=checkbox aria-checked=false tabindex=0 style='width:80px;height:40px'>c</div><script>\
        window.clicks = 0; const c = document.getElementById('c');\
        c.addEventListener('click', () => { clicks++; setTimeout(() => \
        c.setAttribute('aria-checked', c.getAttribute('aria-checked') === 'true' ? 'false' : 'true'), 150); });</script>";
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "navigate", "url": page }),
        json!({ "id": "3", "action": "check", "selector": "#c" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_evaluate(&mut state, "4", "[clicks, c.getAttribute('aria-checked')].join()", json!("1,true")).await;

    assert_success(&execute_command(&json!({ "id": "5", "action": "uncheck", "selector": "#c" }), &mut state).await);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_evaluate(&mut state, "6", "[clicks, c.getAttribute('aria-checked')].join()", json!("2,false")).await;
    assert_success(&execute_command(&json!({ "id": "7", "action": "close" }), &mut state).await);
}

/// A box that takes the page elsewhere when ticked has done what it was asked: there is just nothing left to read.
#[tokio::test]
#[ignore]
async fn e2e_a_check_that_leaves_the_page_succeeded() {
    let mut state = DaemonState::new();
    let page = "data:text/html,<input id=c type=checkbox onclick=\"document.body.innerHTML='gone'\">";
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "navigate", "url": page }),
        json!({ "id": "3", "action": "check", "selector": "#c" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    assert_success(&execute_command(&json!({ "id": "4", "action": "close" }), &mut state).await);
}

fn assert_error_code(resp: &Value, code: &str) {
    assert_eq!(
        resp.get("success").and_then(Value::as_bool),
        Some(false),
        "Expected failure but got: {}",
        serde_json::to_string_pretty(resp).unwrap_or_default()
    );
    assert_eq!(resp.get("code").and_then(Value::as_str), Some(code));
}

fn native_test_fixture_html(name: &str) -> &'static str {
    match name {
        "drag_probe" => include_str!("test_fixtures/drag_probe.html"),
        "html5_drag_probe" => include_str!("test_fixtures/html5_drag_probe.html"),
        "pointer_capture_probe" => include_str!("test_fixtures/pointer_capture_probe.html"),
        "snapshot_diff_probe" => include_str!("test_fixtures/snapshot_diff_probe.html"),
        "upload_probe" => include_str!("test_fixtures/upload_probe.html"),
        "webmcp_delayed_probe" => include_str!("test_fixtures/webmcp_delayed_probe.html"),
        "webmcp_frame_probe" => include_str!("test_fixtures/webmcp_frame_probe.html"),
        "webmcp_probe" => include_str!("test_fixtures/webmcp_probe.html"),
        "webmcp_context_probe" => include_str!("test_fixtures/webmcp_context_probe.html"),
        _ => panic!("Unknown native test fixture: {}", name),
    }
}

#[tokio::test]
#[ignore]
async fn e2e_webmcp_discovery_invocation_and_cancellation() {
    let (fixture_url, fixture_server) = start_webmcp_server().await;
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": fixture_url
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["webmcp"]["experimental"], true);
    assert_eq!(get_data(&resp)["webmcp"]["available"], true);
    assert!(
        get_data(&resp)["webmcp"]["toolCount"]
            .as_u64()
            .is_some_and(|count| count >= 4),
        "navigation did not advertise the fixture's WebMCP tools: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );
    let child_ready = tokio::time::timeout(tokio::time::Duration::from_secs(5), async {
        loop {
            let resp = execute_command(
                &json!({
                    "id": "2b",
                    "action": "page_evaluate",
                    "script": "document.getElementById('tool-frame')?.contentDocument?.body?.dataset?.webmcpReady === 'true'"
                }),
                &mut state,
            )
            .await;
            if get_data(&resp)["result"] == true {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(
        child_ready.is_ok(),
        "child WebMCP fixture did not become ready"
    );
    state.drain_cdp_events_background().await.unwrap();

    let resp = execute_command(&json!({ "id": "3", "action": "webmcp_list" }), &mut state).await;
    assert_success(&resp);
    let tools = get_data(&resp)["tools"].as_array().unwrap();
    let tool = tools
        .iter()
        .find(|tool| tool["name"] == "set_message")
        .expect("set_message should be discovered");
    assert!(tool["frameId"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(tool["origin"]
        .as_str()
        .is_some_and(|origin| origin.starts_with("http://127.0.0.1:")));
    assert_eq!(tool["inputSchema"]["type"], "object");
    let duplicate_tools = tools
        .iter()
        .filter(|tool| tool["name"] == "duplicate_tool")
        .collect::<Vec<_>>();
    assert_eq!(
        duplicate_tools.len(),
        2,
        "unexpected tools: {}",
        serde_json::to_string_pretty(tools).unwrap_or_default()
    );
    let main_frame_id = tool["frameId"].as_str().unwrap();
    let child_frame_id = duplicate_tools
        .iter()
        .find_map(|tool| {
            let frame_id = tool["frameId"].as_str()?;
            (frame_id != main_frame_id).then_some(frame_id)
        })
        .unwrap()
        .to_string();

    let resp = execute_command(
        &json!({
            "id": "3b",
            "action": "webmcp_invoke",
            "tool": "duplicate_tool",
            "params": {}
        }),
        &mut state,
    )
    .await;
    assert_error_code(&resp, "webmcp_ambiguous_tool");

    let resp = execute_command(
        &json!({
            "id": "3c",
            "action": "webmcp_invoke",
            "tool": "duplicate_tool",
            "frameId": child_frame_id,
            "params": {},
            "timeout": 5000
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["output"]["scope"], "frame");

    let resp = execute_command(
        &json!({
            "id": "4",
            "action": "webmcp_invoke",
            "tool": "set_message",
            "params": { "message": "WebMCP works" },
            "timeout": 5000
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["status"], "completed");
    assert_eq!(get_data(&resp)["output"]["message"], "WebMCP works");

    let resp = execute_command(
        &json!({
            "id": "4b",
            "action": "webmcp_invoke",
            "tool": "fail_tool",
            "params": {},
            "timeout": 5000
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["status"], "failed");
    assert!(get_data(&resp)["error"].is_string());

    let resp = execute_command(
        &json!({
            "id": "5",
            "action": "page_evaluate",
            "script": "document.getElementById('result').textContent"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "WebMCP works");

    let resp = execute_command(
        &json!({
            "id": "6",
            "action": "webmcp_invoke",
            "tool": "wait_for_cancel",
            "params": {},
            "detach": true
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let invocation_id = get_data(&resp)["invocationId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(get_data(&resp)["status"], "pending");
    let pending = execute_command(
        &json!({
            "id": "6b",
            "action": "webmcp_result",
            "invocationId": invocation_id,
            "timeout": 10
        }),
        &mut state,
    )
    .await;
    assert_success(&pending);
    assert_eq!(get_data(&pending)["status"], "pending");
    let resp = execute_command(
        &json!({ "id": "6b2", "action": "webmcp_cancel", "invocationId": invocation_id, "timeout": 5000 }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["status"], "canceled", "the poll must have left it running: {resp}");

    let resp = execute_command(
        &json!({
            "id": "6c",
            "action": "webmcp_invoke",
            "tool": "wait_for_cancel",
            "params": {},
            "detach": true
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let invocation_id = get_data(&resp)["invocationId"]
        .as_str()
        .unwrap()
        .to_string();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    state.drain_cdp_events_background().await.unwrap();
    assert_eq!(
        state.webmcp.invocations[&invocation_id].status,
        "pending",
        "long-running fixture terminated before cancellation: {}",
        state.webmcp.invocations[&invocation_id].to_json()
    );

    let resp = execute_command(
        &json!({
            "id": "7",
            "action": "webmcp_cancel",
            "invocationId": invocation_id,
            "timeout": 5000
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["status"], "canceled");

    let resp = execute_command(
        &json!({
            "id": "8",
            "action": "webmcp_invoke",
            "tool": "wait_for_cancel",
            "params": {},
            "timeout": 25
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["status"], "timed_out");

    let resp = execute_command(
        &json!({
            "id": "9",
            "action": "webmcp_invoke",
            "tool": "missing_tool",
            "params": {}
        }),
        &mut state,
    )
    .await;
    assert_error_code(&resp, "webmcp_tool_not_found");

    let resp = execute_command(
        &json!({
            "id": "10",
            "action": "webmcp_invoke",
            "tool": "set_message",
            "params": ["not", "an", "object"]
        }),
        &mut state,
    )
    .await;
    assert_error_code(&resp, "webmcp_invalid_input");

    let resp = execute_command(
        &json!({
            "id": "11",
            "action": "webmcp_invoke",
            "tool": "wait_for_cancel",
            "params": {},
            "detach": true
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let stale_id = get_data(&resp)["invocationId"]
        .as_str()
        .unwrap()
        .to_string();
    let resp = execute_command(
        &json!({
            "id": "12",
            "action": "navigate",
            "url": "about:blank"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({
            "id": "13",
            "action": "webmcp_result",
            "invocationId": stale_id,
            "timeout": 100
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["status"], "failed");
    assert!(get_data(&resp)["error"]
        .as_str()
        .is_some_and(|error| error.starts_with("webmcp_context_changed:")));

    let resp = execute_command(
        &json!({
            "id": "14",
            "action": "navigate",
            "url": fixture_url
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "15", "action": "webmcp_list" }), &mut state).await;
    assert_success(&resp);
    let frame_id = get_data(&resp)["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "frame_wait")
        .and_then(|tool| tool["frameId"].as_str())
        .unwrap()
        .to_string();
    let resp = execute_command(
        &json!({
            "id": "16",
            "action": "webmcp_invoke",
            "tool": "frame_wait",
            "frameId": frame_id,
            "params": {},
            "detach": true
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let frame_invocation_id = get_data(&resp)["invocationId"]
        .as_str()
        .unwrap()
        .to_string();
    let resp = execute_command(
        &json!({
            "id": "17",
            "action": "page_evaluate",
            "script": "document.getElementById('tool-frame').remove()"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    let resp = execute_command(
        &json!({
            "id": "18",
            "action": "webmcp_result",
            "invocationId": frame_invocation_id,
            "timeout": 100
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["status"], "failed");
    assert!(get_data(&resp)["error"]
        .as_str()
        .is_some_and(|error| error.starts_with("webmcp_context_changed:")));

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    assert!(state.webmcp.invocations.is_empty());
    fixture_server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_webmcp_delayed_registration_appears_on_next_action() {
    let (fixture_url, fixture_server) = start_webmcp_server().await;
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": format!("{fixture_url}/delayed.html")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let already_observed = get_data(&resp).get("webmcp").is_some();
    let resp = execute_command(
        &json!({"id": "wait", "action": "wait", "timeout": 150}),
        &mut state,
    )
    .await;
    assert_success(&resp);
    if !already_observed {
        assert_eq!(get_data(&resp)["webmcp"]["experimental"], true);
        assert_eq!(get_data(&resp)["webmcp"]["available"], true);
        assert_eq!(get_data(&resp)["webmcp"]["toolCount"], 1);
    }

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    fixture_server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_webmcp_context_follows_actions_without_explicit_discovery() {
    let (url, server) = start_webmcp_server().await;
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({"id": "launch", "action": "launch", "headless": true}),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let commands = [
        (
            json!({"action": "navigate", "url": format!("{url}/context.html")}),
            -1,
        ),
        (json!({"action": "click", "selector": "#register"}), 1),
        (json!({"action": "snapshot"}), -1),
        (json!({"action": "webmcp_list", "tool": "set_message"}), -1),
        (
            json!({"action": "fill", "selector": "#description", "value": "Updated description"}),
            1,
        ),
        (
            json!({"action": "webmcp_invoke", "tool": "set_message", "params": {"message": "Hello from discovered tool"}}),
            -1,
        ),
        (json!({"action": "gettext", "selector": "#result"}), -1),
        (
            json!({"action": "page_evaluate", "script": "history.pushState({}, '', '#route')"}),
            -1,
        ),
        (
            json!({"action": "tab_new", "url": format!("{url}/empty.html")}),
            0,
        ),
        (json!({"action": "tab_switch", "tabId": "t1"}), 1),
        (json!({"action": "tab_close", "tabId": "t2"}), -1),
        (json!({"action": "click", "selector": "#remove"}), 0),
        (json!({"action": "wait", "timeout": 50}), -1),
        (json!({"action": "click", "selector": "#register"}), 1),
        (
            json!({"action": "navigate", "url": format!("{url}/empty.html")}),
            0,
        ),
    ];
    for (mut cmd, count) in commands {
        cmd["id"] = json!("context");
        let resp = execute_command(&cmd, &mut state).await;
        assert_success(&resp);
        let mut context = get_data(&resp)["webmcp"].clone();
        // Chrome may deliver tool events after the action's reply. Passive
        // observation reports them on a later ordinary action, without listing
        // tools or retrying the mutation. Re-registration can also briefly
        // report removal before the replacement tool is observed.
        if count >= 0 && context["toolCount"] != count {
            context = tokio::time::timeout(std::time::Duration::from_secs(1), async {
                loop {
                    let update = execute_command(
                        &json!({"id": "context-update", "action": "wait", "timeout": 50}),
                        &mut state,
                    )
                    .await;
                    assert_success(&update);
                    let context = &get_data(&update)["webmcp"];
                    if context["toolCount"] == count {
                        break context.clone();
                    }
                }
            })
            .await
            .unwrap_or_else(|_| panic!("Missing WebMCP update after {cmd}: {resp}"));
        }
        if count == -1 {
            assert!(
                context.is_null(),
                "Unchanged or empty page must stay quiet: {cmd}: {resp}"
            );
        } else {
            assert_eq!(context["status"], "ready", "{cmd}: {resp}");
            assert_eq!(context["toolCount"], count, "{cmd}: {resp}");
            assert_eq!(context["available"], count > 0);
        }
        if count > 0 {
            let tool = &context["tools"][0];
            assert_eq!(tool["name"], "set_message");
            assert!(tool.get("inputSchema").is_none());
            assert!(tool["frameId"].as_str().is_some_and(|id| !id.is_empty()));
            assert_eq!(tool["origin"], url);
            if cmd["action"] == "fill" {
                assert_eq!(tool["description"], "Updated description");
            }
        }
        if cmd["action"] == "webmcp_list" {
            assert_eq!(get_data(&resp)["tools"].as_array().unwrap().len(), 1);
            assert_eq!(
                get_data(&resp)["tools"][0]["inputSchema"]["required"],
                json!(["message"])
            );
        }
        if cmd["action"] == "gettext" {
            assert_eq!(get_data(&resp)["text"], "Hello from discovered tool");
        }
    }
    let resp = execute_command(&json!({"id": "close", "action": "close"}), &mut state).await;
    assert_success(&resp);
    assert!(get_data(&resp).get("webmcp").is_none());
    server.abort();
}

/// Opening or switching tabs leaves a call running in its page, and a cancel from another tab reaches it there. Only the
/// page itself going ends it.
#[tokio::test]
#[ignore]
async fn e2e_webmcp_a_tab_change_leaves_a_pending_call_running() {
    let (url, server) = start_webmcp_server().await;
    let mut state = DaemonState::new();
    for mut cmd in [
        json!({"action": "launch", "headless": true}),
        json!({"action": "navigate", "url": url}),
    ] {
        cmd["id"] = json!("setup");
        assert_success(&execute_command(&cmd, &mut state).await);
    }
    let invoke = json!({"id": "invoke", "action": "webmcp_invoke", "tool": "wait_for_cancel", "params": {}, "detach": true});
    let resp = execute_command(&invoke, &mut state).await;
    assert_success(&resp);
    let first = get_data(&resp)["invocationId"].as_str().unwrap().to_string();

    assert_success(&execute_command(&json!({"id": "new", "action": "tab_new"}), &mut state).await);
    assert_eq!(state.webmcp.invocations[&first].status, "pending", "a new tab must not end a call in another");

    let resp = execute_command(
        &json!({"id": "cancel", "action": "webmcp_cancel", "invocationId": first, "timeout": 5000}),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["status"], "canceled", "the cancel must reach the page the call runs in: {resp}");

    assert_success(&execute_command(&json!({"id": "back", "action": "tab_switch", "tabId": "t1"}), &mut state).await);
    let resp = execute_command(&invoke, &mut state).await;
    assert_success(&resp);
    let second = get_data(&resp)["invocationId"].as_str().unwrap().to_string();
    assert_success(&execute_command(&json!({"id": "away", "action": "tab_switch", "tabId": "t2"}), &mut state).await);
    assert_eq!(state.webmcp.invocations[&second].status, "pending", "a switch must not end it either");
    assert_success(&execute_command(&json!({"id": "shut", "action": "tab_close", "tabId": "t1"}), &mut state).await);
    assert_eq!(state.webmcp.invocations[&second].status, "failed", "its page closing does");

    let _ = execute_command(&json!({"id": "close", "action": "close"}), &mut state).await;
    server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_webmcp_same_document_navigation_preserves_catalog_and_invocations() {
    let (url, server) = start_webmcp_server().await;
    let mut state = DaemonState::new();
    for mut cmd in [
        json!({"action": "launch", "headless": true}),
        json!({"action": "navigate", "url": url}),
    ] {
        cmd["id"] = json!("setup");
        let resp = execute_command(&cmd, &mut state).await;
        assert_success(&resp);
    }
    let resp = execute_command(
        &json!({"id": "invoke", "action": "webmcp_invoke", "tool": "wait_for_cancel", "params": {}, "detach": true}),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let invocation_id = get_data(&resp)["invocationId"]
        .as_str()
        .unwrap()
        .to_string();
    let browser = state.browser.as_ref().unwrap();
    let session = browser.active_session_id().unwrap().to_string();
    // Stop tool events so this test cannot pass by silently rediscovering the
    // catalog. Page navigation events remain enabled for document invalidation.
    browser
        .client
        .send_command_no_params("WebMCP.disable", Some(&session))
        .await
        .unwrap();
    let resp = execute_command(&json!({"id": "settle", "action": "title"}), &mut state).await;
    assert_success(&resp);
    let tools = state.webmcp.tools(&session).unwrap();
    assert!(tools.iter().any(|tool| tool.name == "wait_for_cancel"));
    assert_eq!(state.webmcp.invocations[&invocation_id].status, "pending");

    for mut cmd in [
        json!({"action": "navigate", "url": format!("{url}/#route")}),
        json!({"action": "snapshot"}),
        json!({"action": "navigate", "url": format!("{url}/#next")}),
        json!({"action": "page_evaluate", "script": "history.pushState({}, '', '#history')"}),
        json!({"action": "title"}),
    ] {
        cmd["id"] = json!("same-document");
        let resp = execute_command(&cmd, &mut state).await;
        assert_success(&resp);
        assert!(get_data(&resp).get("webmcp").is_none(), "{cmd}: {resp}");
        assert_eq!(state.webmcp.tools(&session).unwrap(), tools, "{cmd}");
        assert_eq!(state.webmcp.invocations[&invocation_id].status, "pending");
    }

    let resp = execute_command(
        &json!({"id": "new-document", "action": "navigate", "url": format!("{url}/empty.html")}),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["webmcp"]["toolCount"], 0);
    assert!(state.webmcp.tools(&session).unwrap().is_empty());
    assert!(state.webmcp.invocations[&invocation_id].to_json()["error"]
        .as_str()
        .is_some_and(|error| error.starts_with("webmcp_context_changed:")));

    // New documents still populate the catalog through the existing
    // subscription and reannounce tools even when the records are identical.
    state
        .browser
        .as_ref()
        .unwrap()
        .client
        .send_command_no_params("WebMCP.enable", Some(&session))
        .await
        .unwrap();
    for _ in 0..2 {
        let resp = execute_command(
            &json!({"id": "reload", "action": "navigate", "url": url}),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert!(get_data(&resp)["webmcp"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "wait_for_cancel"));
    }
    let resp = execute_command(&json!({"id": "close", "action": "close"}), &mut state).await;
    assert_success(&resp);
    server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_webmcp_ordinary_page_stays_quiet_without_reprobing() {
    let (url, server) = start_webmcp_server().await;
    let mut state = DaemonState::new();
    for (index, mut cmd) in [
        json!({"action": "launch", "headless": true}),
        json!({"action": "navigate", "url": format!("{url}/empty.html")}),
        json!({"action": "snapshot"}),
        json!({"action": "title"}),
        json!({"action": "page_evaluate", "script": "document.title"}),
        json!({"action": "wait", "timeout": 1}),
    ]
    .into_iter()
    .enumerate()
    {
        cmd["id"] = json!(index.to_string());
        let resp = execute_command(&cmd, &mut state).await;
        assert_success(&resp);
        assert!(get_data(&resp).get("webmcp").is_none(), "{cmd}: {resp}");
    }
    // Disable browser-side events behind the daemon. If ordinary commands
    // re-enable discovery, the registration below would incorrectly appear.
    let browser = state.browser.as_ref().unwrap();
    let session = browser.active_session_id().unwrap().to_string();
    browser
        .client
        .send_command_no_params("WebMCP.disable", Some(&session))
        .await
        .unwrap();
    let resp = execute_command(&json!({"id": "register", "action": "page_evaluate", "script": "document.modelContext.registerTool({name: 'probe', description: 'probe', inputSchema: {type: 'object'}, execute: async () => ({ok: true})}); true"}), &mut state).await;
    assert_success(&resp);
    assert!(get_data(&resp).get("webmcp").is_none());
    assert_eq!(state.webmcp.observations.len(), 1);
    let resp = execute_command(&json!({"id": "snapshot", "action": "snapshot"}), &mut state).await;
    assert_success(&resp);
    assert!(get_data(&resp).get("webmcp").is_none());
    execute_command(&json!({"id": "close", "action": "close"}), &mut state).await;
    server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_webmcp_opt_out_returns_no_tools() {
    let (fixture_url, fixture_server) = start_webmcp_server().await;
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({
            "id": "1",
            "action": "launch",
            "headless": true,
            "webmcp": false
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "2", "action": "webmcp_list" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["tools"], json!([]));

    let resp = execute_command(
        &json!({ "id": "3", "action": "navigate", "url": fixture_url }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(get_data(&resp).get("webmcp").is_none());

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    fixture_server.abort();
}

fn native_test_fixture_url(name: &str) -> String {
    format!(
        "data:text/html;base64,{}",
        STANDARD.encode(native_test_fixture_html(name))
    )
}

async fn create_storage_state_with_cookie(path: &str, cookie_name: &str, cookie_value: &str) {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({
            "id": "1",
            "action": "launch",
            "headless": true,
            "args": ["--no-sandbox", "--disable-dev-shm-usage"]
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "cookies_set",
            "name": cookie_name,
            "value": cookie_value,
            "domain": ".example.com",
            "path": "/",
            "expires": 2000000000
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "4", "action": "state_save", "path": path }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

async fn create_restore_state_with_cookie(
    restore_key: &str,
    cookie_name: &str,
    cookie_value: &str,
) {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({
            "id": "1",
            "action": "navigate",
            "url": "https://example.com",
            "restoreKey": restore_key
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "cookies_set",
            "name": cookie_name,
            "value": cookie_value,
            "domain": ".example.com",
            "path": "/",
            "expires": 2000000000
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "close" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["saveStatus"], "saved");
}

fn cleanup_restore_state_files(restore_key: &str) {
    let Some(sessions_dir) = dirs::home_dir().map(|home| home.join(".agent-browser/sessions"))
    else {
        return;
    };

    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with(&format!("{}-", restore_key)) {
                let path = entry.path();
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(format!("{}.previous", path.to_string_lossy()));
            }
        }
    }
}

async fn send_raw_http_request(port: u64, request: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .expect("HTTP client should connect to stream server");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("HTTP request should be written");
    stream
        .shutdown()
        .await
        .expect("HTTP client write side should shut down");

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("HTTP response should be read");
    String::from_utf8(response).expect("HTTP response should be utf-8")
}

#[cfg(unix)]
async fn spawn_fake_daemon_socket(
    socket_dir: &std::path::Path,
    session_name: &str,
) -> tokio::sync::oneshot::Receiver<String> {
    use tokio::io::AsyncBufReadExt;

    let socket_path = socket_dir.join(format!("{session_name}.sock"));
    let _ = std::fs::remove_file(&socket_path);
    let listener =
        tokio::net::UnixListener::bind(&socket_path).expect("fake daemon socket should bind");
    let (tx, rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let mut reader = tokio::io::BufReader::new(stream);
        let mut command = String::new();
        if reader.read_line(&mut command).await.is_err() {
            return;
        }

        let mut stream = reader.into_inner();
        let _ = stream
            .write_all(br#"{"success":true,"data":{"ok":true}}"#)
            .await;
        let _ = stream.write_all(b"\n").await;
        let _ = tx.send(command);
    });

    rx
}

// ---------------------------------------------------------------------------
// Core: launch, navigate, evaluate, url, title, close
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_launch_navigate_evaluate_close() {
    let mut state = DaemonState::new();

    // Launch headless Chrome
    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["launched"], true);

    // Navigate to example.com
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], "https://example.com/");
    assert_eq!(get_data(&resp)["title"], "Example Domain");

    // Get URL
    let resp = execute_command(&json!({ "id": "3", "action": "url" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], "https://example.com/");

    // Get title
    let resp = execute_command(&json!({ "id": "4", "action": "title" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["title"], "Example Domain");

    // Evaluate JS
    let resp = execute_command(
        &json!({ "id": "5", "action": "evaluate", "script": "1 + 2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], 3);

    // Evaluate document.title
    let resp = execute_command(
        &json!({ "id": "6", "action": "evaluate", "script": "document.title" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Example Domain");

    // Close
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["closed"], true);
}

#[tokio::test]
#[ignore]
async fn e2e_lightpanda_launch_can_open_page() {
    let lightpanda_bin = match std::env::var("LIGHTPANDA_BIN") {
        Ok(path) if !path.is_empty() => path,
        _ => return,
    };

    let mut state = DaemonState::new();

    let resp = tokio::time::timeout(
        tokio::time::Duration::from_secs(20),
        execute_command(
            &json!({
                "id": "1",
                "action": "launch",
                "headless": true,
                "engine": "lightpanda",
                "executablePath": lightpanda_bin,
            }),
            &mut state,
        ),
    )
    .await
    .expect("Lightpanda launch should not hang");

    assert_success(&resp);
    assert_eq!(get_data(&resp)["launched"], true);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], "https://example.com/");
    assert_eq!(get_data(&resp)["title"], "Example Domain");

    let resp = execute_command(&json!({ "id": "3", "action": "close" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["closed"], true);
}

#[tokio::test]
#[ignore]
async fn e2e_lightpanda_auto_launch_can_open_page() {
    let lightpanda_bin = match std::env::var("LIGHTPANDA_BIN") {
        Ok(path) if !path.is_empty() => path,
        _ => return,
    };

    let prev_engine = std::env::var("AGENT_BROWSER_ENGINE").ok();
    let prev_path = std::env::var("AGENT_BROWSER_EXECUTABLE_PATH").ok();
    std::env::set_var("AGENT_BROWSER_ENGINE", "lightpanda");
    std::env::set_var("AGENT_BROWSER_EXECUTABLE_PATH", &lightpanda_bin);

    let mut state = DaemonState::new();

    let resp = tokio::time::timeout(
        tokio::time::Duration::from_secs(20),
        execute_command(
            &json!({ "id": "1", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        ),
    )
    .await
    .expect("Lightpanda auto-launch should not hang");

    match prev_engine {
        Some(value) => std::env::set_var("AGENT_BROWSER_ENGINE", value),
        None => std::env::remove_var("AGENT_BROWSER_ENGINE"),
    }
    match prev_path {
        Some(value) => std::env::set_var("AGENT_BROWSER_EXECUTABLE_PATH", value),
        None => std::env::remove_var("AGENT_BROWSER_EXECUTABLE_PATH"),
    }

    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], "https://example.com/");
    assert_eq!(get_data(&resp)["title"], "Example Domain");

    let resp = execute_command(&json!({ "id": "2", "action": "close" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["closed"], true);
}

#[tokio::test]
#[ignore = "the Unbrowse build refuses the Obscura engine; unbrowse_policy tests the refusal"]
async fn test_obscura_launch_uses_request_proxy_bypass() {
    let env = EnvGuard::new(&["AGENT_BROWSER_PROXY_BYPASS"]);
    env.set("AGENT_BROWSER_PROXY_BYPASS", "stale-daemon-value");
    for (options, expected) in [
        (json!({"proxyBypass": "localhost"}), "--proxy-bypass"),
        (json!({"proxyBypass": null}), "Failed to launch Obscura"),
        (json!({"proxy": {"bypass": "localhost"}}), "--proxy-bypass"),
        (json!({}), "Failed to launch Obscura"),
    ] {
        let mut state = DaemonState::new();
        let mut request = json!({
            "id": "1", "action": "launch", "headless": true,
            "engine": "obscura", "executablePath": "/nonexistent/obscura",
        });
        request
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        let resp = execute_command(&request, &mut state).await;
        assert_eq!(resp["success"], false, "{resp}");
        assert!(
            resp["error"]
                .as_str()
                .is_some_and(|error| error.contains(expected)),
            "{resp}"
        );
    }
}

fn required_obscura_binary() -> String {
    let path = std::env::var("OBSCURA_BIN")
        .expect("OBSCURA_BIN is required for explicitly invoked Obscura E2E verification");
    assert!(!path.trim().is_empty(), "OBSCURA_BIN must not be empty");
    assert!(
        std::path::Path::new(&path).is_file(),
        "OBSCURA_BIN must point to an existing executable: {path}"
    );
    path
}

struct ObscuraFixture {
    url: String,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for ObscuraFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn obscura_fixture() -> ObscuraFixture {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request).await;
            let body = include_str!("test_fixtures/obscura_probe.html");
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    ObscuraFixture { url, server }
}

async fn obscura_command(state: &mut DaemonState, command: Value) -> Value {
    tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        execute_command(&command, state),
    )
    .await
    .expect("Obscura command must not hang")
}

fn obscura_test_environment() -> EnvGuard<'static> {
    let env = EnvGuard::new(&[
        "AGENT_BROWSER_CDP",
        "AGENT_BROWSER_AUTO_CONNECT",
        "AGENT_BROWSER_PROVIDER",
        "AGENT_BROWSER_ENGINE",
        "AGENT_BROWSER_EXECUTABLE_PATH",
        "OBSCURA_ALLOW_PRIVATE_NETWORK",
        "AGENT_BROWSER_OBSCURA_STEALTH",
        "AGENT_BROWSER_PROXY",
        "AGENT_BROWSER_PROXY_BYPASS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ]);
    for key in [
        "AGENT_BROWSER_CDP",
        "AGENT_BROWSER_AUTO_CONNECT",
        "AGENT_BROWSER_PROVIDER",
        "AGENT_BROWSER_ENGINE",
        "AGENT_BROWSER_EXECUTABLE_PATH",
        "AGENT_BROWSER_OBSCURA_STEALTH",
        "AGENT_BROWSER_PROXY",
        "AGENT_BROWSER_PROXY_BYPASS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        env.remove(key);
    }
    env.set("OBSCURA_ALLOW_PRIVATE_NETWORK", "1");
    env
}

async fn verify_obscura_page(auto_launch: bool) {
    let obscura_bin = required_obscura_binary();
    let env = obscura_test_environment();
    let fixture = obscura_fixture().await;
    let mut state = DaemonState::new();
    if auto_launch {
        env.set("AGENT_BROWSER_ENGINE", "obscura");
        env.set("AGENT_BROWSER_EXECUTABLE_PATH", &obscura_bin);
    } else {
        let resp = obscura_command(
            &mut state,
            json!({
                "id": "1", "action": "launch", "headless": true,
                "engine": "obscura", "executablePath": obscura_bin,
            }),
        )
        .await;
        assert_success(&resp);
        assert_eq!(get_data(&resp)["launched"], true);
    }
    let resp = obscura_command(
        &mut state,
        json!({
            "id": "2", "action": "navigate", "url": fixture.url,
        }),
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], fixture.url);
    assert_eq!(get_data(&resp)["title"], "Obscura adapter probe");
    assert_eq!(state.engine, "obscura");
    assert!(
        state
            .browser
            .as_ref()
            .is_some_and(|manager| manager.owns_obscura_process()),
        "Obscura verification must own an Obscura process, not an attached browser"
    );

    let resp = obscura_command(&mut state, json!({
        "id": "3", "action": "page_evaluate", "script": "document.querySelector('#message').textContent",
    })).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "JavaScript ready");

    let resp = obscura_command(
        &mut state,
        json!({
            "id": "4", "action": "snapshot",
        }),
    )
    .await;
    assert_success(&resp);
    assert!(
        get_data(&resp)["snapshot"]
            .as_str()
            .is_some_and(|text| text.contains("Adapter probe")),
        "{resp}"
    );

    let resp = obscura_command(&mut state, json!({ "id": "5", "action": "close" })).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["closed"], true);
}

#[test]
fn test_obscura_e2e_clears_inherited_connection_modes() {
    const PROBE: &str = "OBSCURA_TEST_ENV_PROBE";
    let keys = [
        "AGENT_BROWSER_CDP",
        "AGENT_BROWSER_AUTO_CONNECT",
        "AGENT_BROWSER_PROVIDER",
    ];
    if std::env::var(PROBE).as_deref() == Ok("1") {
        let _env = obscura_test_environment();
        for key in keys {
            assert!(
                std::env::var_os(key).is_none(),
                "Obscura E2E must clear {key}"
            );
        }
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .env_clear()
        .env("HOME", dir.path())
        .env(PROBE, "1")
        .env(keys[0], format!("ws://{}", listener.local_addr().unwrap()))
        .env(keys[1], "1")
        .env(keys[2], "obscura-test-not-a-provider")
        .args([
            "--exact",
            "native::e2e_tests::test_obscura_e2e_clears_inherited_connection_modes",
            "--nocapture",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "the Unbrowse build refuses the Obscura engine; unbrowse_policy tests the refusal"]
async fn test_obscura_e2e_unlaunchable_binary_does_not_attach_to_inherited_cdp() {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let accepted = Arc::new(AtomicUsize::new(0));
    let server_accepted = accepted.clone();
    let server = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            server_accepted.fetch_add(1, Ordering::SeqCst);
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                match message {
                    Message::Text(text) => {
                        let command: Value = serde_json::from_str(&text).unwrap();
                        let response = json!({"id": command["id"], "error": {
                            "code": -32000, "message": "controlled CDP endpoint must not be used by Obscura verification"
                        }});
                        let _ = ws.send(Message::Text(response.to_string())).await;
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    });
    let fixture = ObscuraFixture {
        url: endpoint.clone(),
        server,
    };
    let dir = tempfile::tempdir().unwrap();
    let false_bin = if std::path::Path::new("/usr/bin/false").is_file() {
        "/usr/bin/false"
    } else {
        "/bin/false"
    };
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .env_clear()
        .env("HOME", dir.path())
        .env("AGENT_BROWSER_SOCKET_DIR", dir.path())
        .env("OBSCURA_BIN", false_bin)
        .env("AGENT_BROWSER_CDP", &fixture.url)
        .env("AGENT_BROWSER_PROVIDER", "obscura-test-not-a-provider")
        .args([
            "--exact",
            "native::e2e_tests::e2e_obscura_auto_launch_can_open_page",
            "--ignored",
            "--nocapture",
        ])
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .expect("Obscura false-binary probe must terminate")
        .unwrap();
    let diagnostics = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.status.code(), Some(101), "{diagnostics}");
    assert!(
        diagnostics.contains("Obscura exited before CDP became ready"),
        "accepted {} inherited CDP connections\n{diagnostics}",
        accepted.load(Ordering::SeqCst)
    );
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        0,
        "Obscura E2E attached to the inherited endpoint"
    );
}

/// Requires a real OBSCURA_BIN; missing binaries fail rather than silently skip verification.
#[tokio::test]
#[ignore = "requires OBSCURA_BIN; run serially"]
async fn e2e_obscura_launch_can_open_page() {
    verify_obscura_page(false).await;
}

#[tokio::test]
#[ignore = "requires OBSCURA_BIN; run serially"]
async fn e2e_obscura_auto_launch_can_open_page() {
    verify_obscura_page(true).await;
}

// ---------------------------------------------------------------------------
// Runtime stream lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_runtime_stream_enable_before_launch_attaches_and_disables() {
    let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_SESSION"]);
    let socket_dir = std::env::temp_dir().join(format!(
        "agent-browser-e2e-stream-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&socket_dir).expect("socket dir should be created");
    guard.set(
        "AGENT_BROWSER_SOCKET_DIR",
        socket_dir.to_str().expect("socket dir should be utf-8"),
    );
    guard.set("AGENT_BROWSER_SESSION", "e2e-runtime-stream");

    let mut state = DaemonState::new();

    let resp = execute_command(&json!({ "id": "1", "action": "stream_status" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["enabled"], false);

    let resp = execute_command(
        &json!({ "id": "2", "action": "stream_enable", "port": 0 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let port = get_data(&resp)["port"]
        .as_u64()
        .expect("stream enable should report the bound port");
    assert_eq!(get_data(&resp)["connected"], false);

    let stream_path = socket_dir.join("e2e-runtime-stream.stream");
    assert!(
        stream_path.exists(),
        "runtime enable should create .stream metadata"
    );

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
        .await
        .expect("websocket client should connect to runtime stream");

    let initial = tokio::time::timeout(tokio::time::Duration::from_secs(5), ws.next())
        .await
        .expect("websocket should emit initial status")
        .expect("websocket should stay open")
        .expect("websocket message should be valid");
    let initial_text = initial.into_text().expect("initial message should be text");
    let initial_status: Value =
        serde_json::from_str(&initial_text).expect("status JSON should parse");
    assert_eq!(initial_status["type"], "status");
    assert_eq!(initial_status["connected"], false);

    let resp = execute_command(
        &json!({ "id": "3", "action": "navigate", "url": "data:text/html,<h1>Runtime Stream</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let mut observed_connected = false;
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let Some(message) = tokio::time::timeout(tokio::time::Duration::from_secs(2), ws.next())
            .await
            .expect("websocket should emit status after browser launch")
        else {
            continue;
        };
        let message = message.expect("websocket message should be valid");
        if !message.is_text() {
            continue;
        }
        let parsed: Value =
            serde_json::from_str(message.to_text().expect("text message should be readable"))
                .expect("runtime stream payload should be valid JSON");
        if parsed.get("type") == Some(&json!("status"))
            && parsed.get("connected") == Some(&json!(true))
        {
            observed_connected = true;
            break;
        }
    }
    assert!(
        observed_connected,
        "runtime stream should report connected=true after browser launch"
    );

    let resp = execute_command(
        &json!({ "id": "4", "action": "stream_disable" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["disabled"], true);
    assert!(
        !stream_path.exists(),
        "stream disable should remove .stream metadata"
    );

    let close_message = tokio::time::timeout(tokio::time::Duration::from_secs(5), ws.next())
        .await
        .expect("websocket should close after disable");
    assert!(
        close_message.is_none() || close_message.expect("ws result should exist").is_ok(),
        "websocket should shut down cleanly when the runtime stream is disabled"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    let _ = std::fs::remove_dir_all(&socket_dir);
}

#[cfg(unix)]
#[tokio::test]
#[ignore]
async fn e2e_stream_command_requires_same_origin_before_daemon_relay() {
    let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_SESSION"]);
    let temp_parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("t");
    std::fs::create_dir_all(&temp_parent).expect("socket temp parent should be created");
    let socket_dir = tempfile::Builder::new()
        .prefix("ab-e2e-")
        .tempdir_in(temp_parent)
        .expect("socket dir should be created");
    guard.set(
        "AGENT_BROWSER_SOCKET_DIR",
        socket_dir
            .path()
            .to_str()
            .expect("socket dir should be utf-8"),
    );
    guard.set("AGENT_BROWSER_SESSION", "x");

    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({ "id": "1", "action": "stream_enable", "port": 0 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let port = get_data(&resp)["port"]
        .as_u64()
        .expect("stream enable should report the bound port");

    let mut daemon_command = spawn_fake_daemon_socket(socket_dir.path(), "x").await;
    let body = r#"{"action":"tabs"}"#;
    let cross_origin_request = format!(
        "POST /api/command HTTP/1.1\r\nHost: localhost:{port}\r\nOrigin: https://evil.example\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );

    let response = send_raw_http_request(port, &cross_origin_request).await;
    assert!(
        response.starts_with("HTTP/1.1 403 Forbidden"),
        "unexpected cross-origin response: {response}"
    );
    assert!(
        !response.contains("Access-Control-Allow-Origin: *"),
        "forbidden command response exposed wildcard CORS: {response}"
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut daemon_command)
            .await
            .is_err(),
        "cross-origin command request reached daemon relay"
    );

    let same_origin_request = format!(
        "POST /api/command HTTP/1.1\r\nHost: localhost:{port}\r\nOrigin: http://localhost:{port}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        super::stream::stream_token(),
        body.len(),
        body
    );
    let response = send_raw_http_request(port, &same_origin_request).await;
    assert!(
        response.starts_with("HTTP/1.1 200 OK"),
        "unexpected same-origin response: {response}"
    );
    assert!(
        response.contains(&format!(
            "Access-Control-Allow-Origin: http://localhost:{port}"
        )),
        "same-origin command response did not reflect origin: {response}"
    );
    assert!(
        !response.contains("Access-Control-Allow-Origin: *"),
        "same-origin command response exposed wildcard CORS: {response}"
    );

    let relayed = tokio::time::timeout(std::time::Duration::from_secs(1), daemon_command)
        .await
        .expect("same-origin request should reach fake daemon")
        .expect("fake daemon should return relayed command");
    assert!(relayed.contains(r#""action":"tabs""#), "{relayed}");

    let resp = execute_command(
        &json!({ "id": "2", "action": "stream_disable" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Snapshot with refs and ref-based click
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_snapshot_and_click_ref() {
    let (base_url, _server) = start_link_fixture_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": base_url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Take snapshot
    let resp = execute_command(&json!({ "id": "3", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();
    assert!(
        snapshot.contains("Example Domain"),
        "Snapshot should contain heading"
    );
    assert!(snapshot.contains("ref=e1"), "Snapshot should have ref e1");
    assert!(snapshot.contains("ref=e2"), "Snapshot should have ref e2");
    assert!(
        snapshot.contains("link"),
        "Snapshot should have a link element"
    );

    // Click the link by ref (e2 is the "Next page" link)
    let resp = execute_command(
        &json!({ "id": "4", "action": "click", "selector": "e2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Wait for navigation
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Verify URL changed
    let resp = execute_command(&json!({ "id": "5", "action": "url" }), &mut state).await;
    assert_success(&resp);
    let url = get_data(&resp)["url"].as_str().unwrap();
    assert!(
        url.ends_with("/next"),
        "Should have navigated to /next, got: {}",
        url
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_snapshot_refs_survive_dom_updates_and_never_recycle() {
    let mut state = DaemonState::new();
    assert_success(
        &execute_command(
            &json!({ "id": "1", "action": "launch", "headless": true }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "about:blank" }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "3", "action": "setcontent", "html": "<button id='a'>Alpha</button><button id='b'>Beta</button>" }),
            &mut state,
        )
        .await,
    );

    let first = execute_command(&json!({ "id": "4", "action": "snapshot" }), &mut state).await;
    assert_success(&first);
    let alpha_ref = get_data(&first)["refs"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, node)| node["name"] == "Alpha")
        .map(|(ref_id, _)| ref_id.clone())
        .unwrap();

    assert_success(
        &execute_command(
            &json!({ "id": "5", "action": "page_evaluate", "script": "document.body.prepend(document.getElementById('a')); document.getElementById('b').remove()" }),
            &mut state,
        )
        .await,
    );
    let second = execute_command(&json!({ "id": "6", "action": "snapshot" }), &mut state).await;
    assert_success(&second);
    assert_eq!(get_data(&second)["refs"][&alpha_ref]["name"], "Alpha");
    assert_eq!(
        get_data(&second)["removedRefs"].as_array().unwrap().len(),
        1
    );

    assert_success(
        &execute_command(
            &json!({ "id": "7", "action": "navigate", "url": "about:blank?new-document" }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "8", "action": "setcontent", "html": "<button>Alpha</button>" }),
            &mut state,
        )
        .await,
    );
    let third = execute_command(&json!({ "id": "9", "action": "snapshot" }), &mut state).await;
    assert_success(&third);
    assert!(get_data(&third)["refs"].get(&alpha_ref).is_none());
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

#[tokio::test]
#[ignore]
async fn e2e_snapshot_refs_invalidate_iframe_navigation() {
    let mut state = DaemonState::new();
    for command in [
        json!({"action": "launch", "headless": true}),
        json!({"action": "navigate", "url": "about:blank"}),
        json!({"action": "setcontent", "html": "<button>Parent</button><iframe id='child'></iframe>"}),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let replace = json!({"action": "page_evaluate", "script": "new Promise(resolve => { const f = document.getElementById('child'); f.onload = () => resolve(true); f.srcdoc = '<button>Child</button>'; })"});
    assert_success(&execute_command(&replace, &mut state).await);
    let first = execute_command(&json!({"action": "snapshot"}), &mut state).await;
    assert_success(&first);
    let find_ref = |snapshot: &Value, name: &str| {
        get_data(snapshot)["refs"]
            .as_object()
            .unwrap()
            .iter()
            .find(|(_, node)| node["name"] == name)
            .unwrap()
            .0
            .clone()
    };
    let parent = find_ref(&first, "Parent");
    let child = find_ref(&first, "Child");
    let unchanged = execute_command(&json!({"action": "snapshot"}), &mut state).await;
    assert_eq!(find_ref(&unchanged, "Child"), child);
    assert_success(&execute_command(&replace, &mut state).await);
    let replaced = execute_command(&json!({"action": "snapshot"}), &mut state).await;
    assert_success(&replaced);
    assert_eq!(find_ref(&replaced, "Parent"), parent);
    assert_ne!(find_ref(&replaced, "Child"), child);
    assert!(get_data(&replaced)["removedRefs"]
        .as_array()
        .unwrap()
        .contains(&json!(format!("@{child}"))));
    assert_success(&execute_command(&json!({"action": "close"}), &mut state).await);
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_screenshot() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Default screenshot
    let resp = execute_command(&json!({ "id": "3", "action": "screenshot" }), &mut state).await;
    assert_success(&resp);
    let path = get_data(&resp)["path"].as_str().unwrap();
    assert!(path.ends_with(".png"), "Screenshot path should be .png");
    let metadata = std::fs::metadata(path).expect("Screenshot file should exist");
    assert!(
        metadata.len() > 1000,
        "Screenshot should be non-trivial size"
    );

    // Named screenshot
    let tmp_path = crate::native::file_root::root()
        .join("agent-browser-e2e-test-screenshot.png")
        .to_string_lossy()
        .to_string();
    let resp = execute_command(
        &json!({ "id": "4", "action": "screenshot", "path": tmp_path }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(std::path::Path::new(&tmp_path).exists());
    let _ = std::fs::remove_file(&tmp_path);

    let resp = execute_command(
        &json!({ "id": "4a", "action": "screenshot", "ifChanged": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["changed"], true);
    assert_eq!(get_data(&resp)["revision"], 1);
    let conditional_path = get_data(&resp)["path"].as_str().unwrap().to_string();

    let resp = execute_command(
        &json!({ "id": "4b", "action": "screenshot", "ifChanged": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["changed"], false);
    assert_eq!(get_data(&resp)["revision"], 2);
    assert_eq!(get_data(&resp)["pixelChangeRatio"], 0.0);
    assert!(get_data(&resp).get("path").is_none());
    let _ = std::fs::remove_file(conditional_path);

    let resp = execute_command(
        &json!({
            "id": "5",
            "action": "setcontent",
            "html": r##"
                <html><body>
                  <button onclick="document.getElementById('result').textContent = 'clicked'">Submit</button>
                  <a href="#">Home</a>
                  <div id="result"></div>
                </body></html>
            "##,
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5a", "action": "screenshot", "ifChanged": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["changed"], true);
    assert_eq!(get_data(&resp)["revision"], 3);
    assert!(get_data(&resp)["pixelChangeRatio"].as_f64().unwrap() > 0.0);
    let _ = std::fs::remove_file(get_data(&resp)["path"].as_str().unwrap());

    let resp = execute_command(
        &json!({ "id": "6", "action": "screenshot", "annotate": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let annotations = get_data(&resp)["annotations"]
        .as_array()
        .expect("Annotated screenshot should return annotations");
    assert!(
        !annotations.is_empty(),
        "Annotated screenshot should have at least one annotation"
    );

    let submit_ref = annotations
        .iter()
        .find(|ann| ann.get("name").and_then(|v| v.as_str()) == Some("Submit"))
        .and_then(|ann| ann.get("ref").and_then(|v| v.as_str()))
        .expect("Expected a Submit annotation");

    let resp = execute_command(
        &json!({
            "id": "7",
            "action": "page_evaluate",
            "script": "document.getElementById('__agent_browser_annotations__') === null"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], true);

    let resp = execute_command(
        &json!({ "id": "8", "action": "click", "selector": format!("@{}", submit_ref) }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "9",
            "action": "page_evaluate",
            "script": "document.getElementById('result').textContent"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "clicked");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Form interaction: fill, type, select, check
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_form_interaction() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body>",
        "<input id='name' type='text' placeholder='Name'>",
        "<input id='email' type='email'>",
        "<select id='color'><option value='red'>Red</option><option value='blue'>Blue</option></select>",
        "<input id='agree' type='checkbox'>",
        "<textarea id='bio'></textarea>",
        "<button id='submit'>Submit</button>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Fill name
    let resp = execute_command(
        &json!({ "id": "10", "action": "fill", "selector": "#name", "value": "John Doe" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Verify fill
    let resp = execute_command(
        &json!({ "id": "11", "action": "page_evaluate", "script": "document.getElementById('name').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "John Doe");

    // Type email – the type action now correctly handles punctuation like '.'
    let resp = execute_command(
        &json!({ "id": "12", "action": "type", "selector": "#email", "text": "john@example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "13", "action": "page_evaluate", "script": "document.getElementById('email').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "john@example.com");

    // Select option
    let resp = execute_command(
        &json!({ "id": "14", "action": "select", "selector": "#color", "values": ["blue"] }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "15", "action": "page_evaluate", "script": "document.getElementById('color').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "blue");

    // Check checkbox
    let resp = execute_command(
        &json!({ "id": "16", "action": "check", "selector": "#agree" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "17", "action": "ischecked", "selector": "#agree" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], true);

    // Uncheck
    let resp = execute_command(
        &json!({ "id": "18", "action": "uncheck", "selector": "#agree" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "19", "action": "ischecked", "selector": "#agree" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], false);

    // Snapshot should show form state
    let resp = execute_command(&json!({ "id": "20", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let snap = get_data(&resp)["snapshot"].as_str().unwrap();
    assert!(
        snap.contains("John Doe"),
        "Snapshot should show filled value"
    );
    assert!(snap.contains("textbox"), "Snapshot should show textbox");
    assert!(snap.contains("button"), "Snapshot should show button");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_select_option_label_override_names() {
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<html><body></body></html>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let script = r#"(() => {
        const select = document.createElement('select');
        select.id = 'label-overrides';
        for (const [value, label, text] of [
            ['initial', 'Initial', 'Initial'],
            ['target', 'Capital\u00A0Federal', 'Target source'],
            ['decoy', 'Other Province', 'Capital\u00A0\u00A0Federal'],
            ['hidden', 'Visible Province', 'Hidden\u00A0Only'],
            ['plain', null, 'Plain\u00A0Text']
        ]) {
            const option = document.createElement('option');
            option.value = value;
            if (label !== null) option.label = label;
            option.textContent = text;
            select.appendChild(option);
        }
        select.value = 'initial';
        select.dataset.changes = '0';
        select.addEventListener('change', () => select.dataset.changes++);
        document.body.appendChild(select);
        const multi = select.cloneNode(true);
        multi.id = 'label-overrides-multi';
        multi.multiple = true;
        multi.value = 'initial';
        multi.addEventListener('change', () => multi.dataset.changes++);
        document.body.appendChild(multi);
    })()"#;
    let resp = execute_command(
        &json!({ "id": "3", "action": "page_evaluate", "script": script }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let snapshot = execute_command(&json!({ "id": "4", "action": "snapshot" }), &mut state).await;
    let mut results = Vec::new();
    for (selector, values, expected_values, changes, success) in [
        (
            "#label-overrides",
            vec!["Capital Federal"],
            vec!["target"],
            "1",
            true,
        ),
        (
            "#label-overrides",
            vec!["Hidden Only"],
            vec!["target"],
            "1",
            false,
        ),
        ("#label-overrides", vec!["decoy"], vec!["decoy"], "2", true),
        (
            "#label-overrides",
            vec!["Capital\u{00A0}Federal"],
            vec!["target"],
            "3",
            true,
        ),
        (
            "#label-overrides",
            vec!["Hidden\u{00A0}Only"],
            vec!["hidden"],
            "4",
            true,
        ),
        (
            "#label-overrides",
            vec!["Plain Text"],
            vec!["plain"],
            "5",
            true,
        ),
        (
            "#label-overrides-multi",
            vec!["target", "Hidden Only"],
            vec!["initial"],
            "0",
            false,
        ),
    ] {
        let selection = select_values(&mut state, "select", selector, &values).await;
        let script = format!(
            "(() => {{ const select = document.querySelector('{}'); return {{ values: [...select.selectedOptions].map(option => option.value), changes: select.dataset.changes }}; }})()",
            selector
        );
        let actual = execute_command(
            &json!({ "id": "state", "action": "page_evaluate", "script": script }),
            &mut state,
        )
        .await;
        results.push((selection, actual, expected_values, changes, success));
    }
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    assert_success(&snapshot);
    let snapshot = get_data(&snapshot)["snapshot"].as_str().unwrap();
    assert!(snapshot.contains("option \"Capital Federal\""));
    assert!(snapshot.contains("option \"Other Province\""));
    assert!(!snapshot.contains("option \"Hidden Only\""));
    for (selection, actual, expected_values, changes, success) in results {
        assert_eq!(selection["success"], success, "{selection}");
        if !success {
            assert!(selection["error"]
                .as_str()
                .unwrap()
                .contains("No option matched"));
        }
        assert_success(&actual);
        assert_eq!(
            get_data(&actual)["result"],
            json!({ "values": expected_values, "changes": changes })
        );
    }
}

#[tokio::test]
#[ignore]
async fn e2e_select_option_normalized_names() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<html><body></body></html>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let script = r#"(() => {
        const add = (select, value, label, selected = false) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            option.selected = selected;
            select.appendChild(option);
        };
        const province = document.createElement('select');
        province.id = 'province';
        add(province, '', 'Provincia');
        add(province, 'B', 'Buenos\u00A0Aires', true);
        add(province, 'C', 'Capital\u00A0Federal');
        add(province, 'Z', 'Zero\u200BWidth');
        province.dataset.changes = '0';
        province.addEventListener('change', () => province.dataset.changes++);
        document.body.appendChild(province);

        const collision = document.createElement('select');
        collision.id = 'collision';
        add(collision, 'ascii', 'Alpha Beta', true);
        add(collision, 'nbsp', 'Alpha\u00A0Beta');
        document.body.appendChild(collision);

        const cases = document.createElement('select');
        cases.id = 'cases';
        add(cases, 'US', 'Upper');
        add(cases, 'us', 'Lower');
        document.body.appendChild(cases);

        const multi = document.createElement('select');
        multi.id = 'multi';
        multi.multiple = true;
        add(multi, 'a', 'One\u00A0A');
        add(multi, 'b', 'Two B');
        document.body.appendChild(multi);
    })()"#;
    let resp = execute_command(
        &json!({ "id": "3", "action": "page_evaluate", "script": script }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "4", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();
    assert!(snapshot.contains("option \"Capital Federal\""));
    assert!(!snapshot.contains("CapitalFederal"));
    assert!(snapshot.contains("option \"ZeroWidth\""));

    let resp = select_values(&mut state, "5", "#province", &["Capital Federal"]).await;
    assert_success(&resp);
    assert_evaluate(
        &mut state,
        "6",
        "({ value: province.value, changes: province.dataset.changes })",
        json!({ "value": "C", "changes": "1" }),
    )
    .await;

    let resp = select_values(&mut state, "7", "#province", &["missing"]).await;
    assert_eq!(resp["success"], false);
    assert_evaluate(
        &mut state,
        "8",
        "({ value: province.value, changes: province.dataset.changes })",
        json!({ "value": "C", "changes": "1" }),
    )
    .await;

    let resp = select_values(&mut state, "9", "#collision", &["Alpha Beta"]).await;
    assert_success(&resp);
    assert_evaluate(&mut state, "10", "collision.value", json!("ascii")).await;

    let resp = select_values(&mut state, "11", "#collision", &["Alpha  Beta"]).await;
    assert_eq!(resp["success"], false);
    assert!(resp["error"]
        .as_str()
        .unwrap()
        .contains("Multiple options matched"));
    assert_evaluate(&mut state, "12", "collision.value", json!("ascii")).await;

    let resp = select_values(&mut state, "13", "#cases", &["us"]).await;
    assert_success(&resp);
    assert_evaluate(&mut state, "14", "cases.value", json!("us")).await;

    let resp = select_values(&mut state, "15", "#multi", &["One A", "b"]).await;
    assert_success(&resp);
    assert_evaluate(
        &mut state,
        "16",
        "[...multi.selectedOptions].map(option => option.value)",
        json!(["a", "b"]),
    )
    .await;

    let resp = select_values(&mut state, "17", "#multi", &["a", "missing"]).await;
    assert_eq!(resp["success"], false);
    assert_evaluate(
        &mut state,
        "18",
        "[...multi.selectedOptions].map(option => option.value)",
        json!(["a", "b"]),
    )
    .await;

    let resp = select_values(&mut state, "19", "#province", &["ZeroWidth"]).await;
    assert_success(&resp);
    assert_evaluate(&mut state, "20", "province.value", json!("Z")).await;

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Navigation: back, forward, reload
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_navigation_history() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to page 1
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Page 1</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to page 2
    let resp = execute_command(
        &json!({ "id": "3", "action": "navigate", "url": "data:text/html,<h1>Page 2</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Back
    let resp = execute_command(&json!({ "id": "4", "action": "back" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5", "action": "page_evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Page 1");

    // Forward
    let resp = execute_command(&json!({ "id": "6", "action": "forward" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "7", "action": "page_evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Page 2");

    // Reload
    let resp = execute_command(&json!({ "id": "8", "action": "reload" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "9", "action": "page_evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Page 2");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_cookies() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set cookie
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "cookies_set",
            "name": "test_cookie",
            "value": "hello123"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Get cookies
    let resp = execute_command(&json!({ "id": "4", "action": "cookies_get" }), &mut state).await;
    assert_success(&resp);
    let cookies = get_data(&resp)["cookies"].as_array().unwrap();
    let found = cookies
        .iter()
        .any(|c| c["name"] == "test_cookie" && c["value"] == "hello123");
    assert!(found, "Should find the set cookie");

    // Clear cookies
    let resp = execute_command(&json!({ "id": "5", "action": "cookies_clear" }), &mut state).await;
    assert_success(&resp);

    // Verify cleared
    let resp = execute_command(&json!({ "id": "6", "action": "cookies_get" }), &mut state).await;
    assert_success(&resp);
    let cookies = get_data(&resp)["cookies"].as_array().unwrap();
    let found = cookies.iter().any(|c| c["name"] == "test_cookie");
    assert!(!found, "Cookie should be cleared");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// localStorage / sessionStorage
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_storage() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set local storage
    let resp = execute_command(
        &json!({ "id": "3", "action": "storage_set", "type": "local", "key": "mykey", "value": "myvalue" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Get local storage key
    let resp = execute_command(
        &json!({ "id": "4", "action": "storage_get", "type": "local", "key": "mykey" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "myvalue");

    // Get all local storage
    let resp = execute_command(
        &json!({ "id": "5", "action": "storage_get", "type": "local" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["data"]["mykey"], "myvalue");

    // Clear
    let resp = execute_command(
        &json!({ "id": "6", "action": "storage_clear", "type": "local" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Verify cleared
    let resp = execute_command(
        &json!({ "id": "7", "action": "storage_get", "type": "local" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = &get_data(&resp)["data"];
    assert!(
        data.as_object().map(|m| m.is_empty()).unwrap_or(true),
        "Storage should be empty after clear"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_tabs() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Tab 1</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Tab list should show 1 tab with tabId 1
    let resp = execute_command(&json!({ "id": "3", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0]["active"], true);
    assert_eq!(tabs[0]["tabId"], "t1", "First tab should have tabId t1");

    // Open new tab
    let resp = execute_command(
        &json!({ "id": "4", "action": "tab_new", "url": "data:text/html,<h1>Tab 2</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["tabId"],
        "t2",
        "New tab should have tabId t2"
    );
    assert_eq!(get_data(&resp)["total"], 2);

    // Tab list should show 2 tabs with distinct, incrementing tabIds
    let resp = execute_command(&json!({ "id": "5", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 2);
    assert_eq!(tabs[1]["active"], true);
    assert_eq!(tabs[0]["tabId"], "t1", "First tab should keep tabId t1");
    assert_eq!(tabs[1]["tabId"], "t2", "Second tab should have tabId t2");

    // Switch to first tab
    let resp = execute_command(
        &json!({ "id": "6", "action": "tab_switch", "tabId": "t1" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "7", "action": "page_evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Tab 1");

    // Close second tab
    let resp = execute_command(
        &json!({ "id": "8", "action": "tab_close", "tabId": "t2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Should have 1 tab left
    let resp = execute_command(&json!({ "id": "9", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 1);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_tab_ids_not_reused() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // First tab gets tabId 1
    let resp = execute_command(&json!({ "id": "2", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(tabs[0]["tabId"], "t1");

    // Open tab 2 and tab 3
    let resp = execute_command(
        &json!({ "id": "3", "action": "tab_new", "url": "data:text/html,<h1>Tab 2</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["tabId"], "t2");

    let resp = execute_command(
        &json!({ "id": "4", "action": "tab_new", "url": "data:text/html,<h1>Tab 3</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["tabId"], "t3");

    // Close tab 2
    let resp = execute_command(
        &json!({ "id": "5", "action": "tab_close", "tabId": "t2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Open a new tab — should get tabId 4, NOT 2
    let resp = execute_command(
        &json!({ "id": "6", "action": "tab_new", "url": "data:text/html,<h1>Tab 4</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["tabId"],
        "t4",
        "Tab IDs must not be reused after closing"
    );

    // Verify final state: tabs t1, t3, t4
    let resp = execute_command(&json!({ "id": "7", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 3);
    let ids: Vec<String> = tabs
        .iter()
        .map(|t| t["tabId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["t1", "t3", "t4"]);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// `tab_close` with an explicit `tabId` must close that tab regardless of
/// whether it's active, and leave the remaining tab active without leaking
/// per-tab state (refs, iframe sessions, frame id) from the closed tab.
#[tokio::test]
#[ignore]
async fn e2e_tab_close_with_tab_id_closes_active_tab() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<title>A</title>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "tab_new", "url": "data:text/html,<title>B</title>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "4", "action": "tab_close", "tabId": "t2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "5", "action": "title" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["title"], "A");
    assert!(state.ref_map.get("e1").is_none());
    assert!(state.iframe_sessions.is_empty());
    assert!(state.active_frame_id.is_none());

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Tabs can be opened with a user-assigned label and then addressed by that
/// label anywhere a `t<N>` id is accepted (switch, close, and JSON `tabId`
/// on `tab_switch` / `tab_close`). Labels are the agent-friendly way to
/// write multi-tab workflows without memorizing ids.
#[tokio::test]
#[ignore]
async fn e2e_tab_new_with_label_can_be_switched_and_closed() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<title>Home</title>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Open a labeled tab and verify the response echoes the label and a
    // `t<N>` style tabId.
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "tab_new",
            "url": "data:text/html,<title>Docs</title>",
            "label": "docs",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["tabId"], "t2");
    assert_eq!(get_data(&resp)["label"], "docs");

    // tab_list exposes the label alongside the id.
    let resp = execute_command(&json!({ "id": "4", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    let docs = tabs
        .iter()
        .find(|t| t["tabId"] == "t2")
        .expect("docs tab should be present");
    assert_eq!(docs["label"], "docs");

    // tab_switch accepts the label.
    let resp = execute_command(
        &json!({ "id": "5", "action": "tab_switch", "tabId": "t1" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(state.browser.as_ref().unwrap().active_tab_id(), Some(1));

    let resp = execute_command(
        &json!({ "id": "6", "action": "tab_switch", "tabId": "docs" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(state.browser.as_ref().unwrap().active_tab_id(), Some(2));

    // Once switched, the active tab is the labeled one and normal commands
    // work against it.
    let resp = execute_command(&json!({ "id": "7", "action": "title" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["title"], "Docs");

    // tab_close accepts the label.
    let resp = execute_command(
        &json!({ "id": "8", "action": "tab_close", "tabId": "docs" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["label"], "docs");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Unbrowse fork: commands that name their tab (`tab`, from AGENT_BROWSER_TAB) each act on their own
/// page, made the first time it is named (the browser's blank first page is taken, not left over), and a
/// tab's snapshot refs survive another tab's commands in between: two sessions sharing one browser never
/// read or click each other's page.
#[tokio::test]
#[ignore]
async fn e2e_commands_naming_their_tab_each_act_on_their_own_page() {
    let mut state = DaemonState::new();
    let page = |title: &str| {
        format!("data:text/html,<title>{title}</title><button onclick=\"document.title='{title} clicked'\">{title}</button>")
    };
    let resp = execute_command(&json!({ "id": "1", "action": "navigate", "url": page("A"), "tab": "ua" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(state.browser.as_ref().unwrap().page_count(), 1, "the first tab named takes the blank page");
    let resp = execute_command(&json!({ "id": "2", "action": "navigate", "url": page("B"), "tab": "ub" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(state.browser.as_ref().unwrap().page_count(), 2);

    let title = |r: &Value| get_data(r)["title"].as_str().unwrap_or_default().to_string();
    let resp = execute_command(&json!({ "id": "3", "action": "title", "tab": "ua" }), &mut state).await;
    assert_eq!(title(&resp), "A", "ua reads its own page, though ub opened last");

    let resp = execute_command(&json!({ "id": "4", "action": "snapshot", "interactive": true, "tab": "ua" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "5", "action": "snapshot", "interactive": true, "tab": "ub" }), &mut state).await;
    assert_success(&resp);
    // ua's @e1 is still ua's button, after ub's snapshot numbered its own.
    let resp = execute_command(&json!({ "id": "6", "action": "click", "selector": "@e1", "tab": "ua" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "7", "action": "title", "tab": "ua" }), &mut state).await;
    assert_eq!(title(&resp), "A clicked");
    let resp = execute_command(&json!({ "id": "8", "action": "title", "tab": "ub" }), &mut state).await;
    assert_eq!(title(&resp), "B", "ub's page was never clicked");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Unbrowse fork: closing one session's tab never clears the refs another session's tab numbered,
/// and once the active tab closes, the tab that takes its place gets back the refs its session parked.
#[tokio::test]
#[ignore]
async fn e2e_closing_a_tab_keeps_the_other_sessions_refs() {
    let mut state = DaemonState::new();
    let page = |title: &str| {
        format!("data:text/html,<title>{title}</title><button onclick=\"document.title='{title} clicked'\">{title}</button>")
    };
    let title = |r: &Value| get_data(r)["title"].as_str().unwrap_or_default().to_string();
    for (id, tab, t) in [("1", "ua", "A"), ("2", "ub", "B"), ("3", "uc", "C")] {
        let resp = execute_command(&json!({ "id": id, "action": "navigate", "url": page(t), "tab": tab }), &mut state).await;
        assert_success(&resp);
    }
    for (id, tab) in [("4", "ua"), ("5", "uc"), ("6", "ub")] {
        let resp = execute_command(&json!({ "id": id, "action": "snapshot", "interactive": true, "tab": tab }), &mut state).await;
        assert_success(&resp);
    }
    // ub is active; another session closes its own tab, uc.
    let resp = execute_command(&json!({ "id": "7", "action": "tab_close", "tabId": "uc" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "8", "action": "click", "selector": "@e1", "tab": "ub" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "9", "action": "title", "tab": "ub" }), &mut state).await;
    assert_eq!(title(&resp), "B clicked", "ub's @e1 survived uc's close");

    // The active tab, ub, closes: ua comes to the front with the refs it numbered.
    let resp = execute_command(&json!({ "id": "10", "action": "tab_close", "tabId": "ub" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "11", "action": "click", "selector": "@e1", "tab": "ua" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "12", "action": "title", "tab": "ua" }), &mut state).await;
    assert_eq!(title(&resp), "A clicked", "ua's @e1 came back with it");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// A page that opens a popup, whose own script notes what it finds as its first document loads. Served, since a page may
/// not open a `data:` address as a top frame, and on another origin: a same-origin popup keeps the `Window` of the blank
/// page it began as, so a count kept on it would add that page's run to its own.
async fn serve_opener_of_a_noting_popup() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let body = if String::from_utf8_lossy(&buf[..n]).starts_with("GET /popup") {
                    "<title>popup</title><script>window.first = { ua: navigator.userAgent, \
                     zone: Intl.DateTimeFormat().resolvedOptions().timeZone, \
                     ran: window.ranHere || 0 };</script>"
                } else {
                    "<title>opener</title><button id=open \
                     onclick=\"window.open(location.origin.replace('127.0.0.1', 'localhost') + '/popup')\">open</button>"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (base_url, handle)
}

/// The page the opener opened, made active once it has appeared.
async fn enter_popup(state: &mut DaemonState) {
    for attempt in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let list = execute_command(&json!({ "id": format!("list{attempt}"), "action": "tab_list" }), state).await;
        let tabs = get_data(&list)["tabs"].as_array().cloned().unwrap_or_default();
        if let [_, popup] = tabs.as_slice() {
            assert_success(&execute_command(&json!({ "id": "enter", "action": "tab_switch", "tabId": popup["tabId"] }), state).await);
            return;
        }
    }
    panic!("the popup never appeared");
}

/// "One identity end to end": a page a page opens is the same person. Its first document, the one a site reads, has the
/// session's user agent, time zone and init script, and that script runs once.
#[tokio::test]
#[ignore]
async fn e2e_a_popup_has_the_sessions_identity_from_its_first_document() {
    let (opener, server) = serve_opener_of_a_noting_popup().await;
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "useragent", "userAgent": "one-identity/1.0" }),
        json!({ "id": "3", "action": "timezone", "timezoneId": "Asia/Tokyo" }),
        json!({ "id": "4", "action": "addinitscript", "script": "window.ranHere = (window.ranHere || 0) + 1" }),
        json!({ "id": "5", "action": "navigate", "url": opener }),
        json!({ "id": "6", "action": "click", "selector": "#open" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    enter_popup(&mut state).await;
    for _ in 0..30 {
        let read = execute_command(&json!({ "id": "6b", "action": "page_evaluate", "script": "!!window.first" }), &mut state).await;
        if get_data(&read)["result"] == true {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_evaluate(&mut state, "7", "window.first", json!({ "ua": "one-identity/1.0", "zone": "Asia/Tokyo", "ran": 1 })).await;

    // The session's identity lasts: preparing the popup's session must not put the browser's own back.
    assert_success(&execute_command(&json!({ "id": "7b", "action": "navigate", "url": "data:text/html,<h1>on</h1>" }), &mut state).await);
    assert_evaluate(&mut state, "7c", "navigator.userAgent", json!("one-identity/1.0")).await;

    // Reaching a copy of a script: a removed one stays out of the popup's later documents.
    let handle = state.session_setup.init_scripts[0].identifier.clone();
    assert_success(&execute_command(&json!({ "id": "8", "action": "removeinitscript", "identifier": handle }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "9", "action": "navigate", "url": "data:text/html,<h1>after</h1>" }), &mut state).await);
    assert_evaluate(&mut state, "10", "window.ranHere === undefined", json!(true)).await;
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
    server.abort();
}

/// Going back to a tab prepares its session again, which must not put the browser's own user agent back.
#[tokio::test]
#[ignore]
async fn e2e_switching_tabs_keeps_the_sessions_user_agent() {
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "useragent", "userAgent": "one-identity/1.0" }),
        json!({ "id": "3", "action": "tab_new" }),
        json!({ "id": "4", "action": "tab_switch", "tabId": "t1" }),
        json!({ "id": "5", "action": "navigate", "url": "data:text/html,<h1>back</h1>" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    assert_evaluate(&mut state, "6", "navigator.userAgent", json!("one-identity/1.0")).await;
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

/// `window new` is a page of the same session too.
#[tokio::test]
#[ignore]
async fn e2e_a_new_window_has_the_sessions_identity() {
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "useragent", "userAgent": "one-identity/1.0" }),
        json!({ "id": "3", "action": "window_new" }),
        json!({ "id": "4", "action": "navigate", "url": "data:text/html,<h1>window</h1>" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    assert_evaluate(&mut state, "5", "navigator.userAgent", json!("one-identity/1.0")).await;
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

/// Unbrowse fork: a page a session's tab opens (a popup, a `target=_blank` page, a 3-D Secure window)
/// is that session's: its next command acts there, another session's commands stay on their own page,
/// and once the popup closes the session is back on its tab.
#[tokio::test]
#[ignore]
async fn e2e_a_popup_belongs_to_the_session_whose_tab_opened_it() {
    let mut state = DaemonState::new();
    let opener = "data:text/html,<title>A</title><button onclick=\"var w=window.open('about:blank');w.document.title='Popup'\">Pay</button>";
    let title = |r: &Value| get_data(r)["title"].as_str().unwrap_or_default().to_string();
    let resp = execute_command(&json!({ "id": "1", "action": "navigate", "url": opener, "tab": "ua" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "2", "action": "navigate", "url": "data:text/html,<title>B</title>", "tab": "ub" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "3", "action": "snapshot", "interactive": true, "tab": "ua" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "4", "action": "click", "selector": "@e1", "tab": "ua" }), &mut state).await;
    assert_success(&resp);

    // The popup's own events arrive shortly after the click.
    let mut popup = None;
    for _ in 0..50 {
        let resp = execute_command(&json!({ "id": "5", "action": "tab_list" }), &mut state).await;
        popup = get_data(&resp)["tabs"].as_array().and_then(|t| t.iter().find(|t| t["label"].is_null()).cloned());
        if popup.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let popup = popup.expect("the click opened a popup");

    let resp = execute_command(&json!({ "id": "6", "action": "title", "tab": "ub" }), &mut state).await;
    assert_eq!(title(&resp), "B", "another session stays on its own page");
    let resp = execute_command(&json!({ "id": "7", "action": "title", "tab": "ua" }), &mut state).await;
    assert_eq!(title(&resp), "Popup", "the session that opened it acts in its popup");
    let resp = execute_command(&json!({ "id": "8", "action": "title", "tab": "ub" }), &mut state).await;
    assert_eq!(title(&resp), "B");

    let resp = execute_command(&json!({ "id": "9", "action": "tab_close", "tabId": popup["tabId"] }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "10", "action": "title", "tab": "ua" }), &mut state).await;
    assert_eq!(title(&resp), "A", "the popup closed: back on its own tab");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Unbrowse fork: a page a session's link opens in a new tab with `rel=noopener` is the session's too.
#[tokio::test]
#[ignore]
async fn e2e_a_noopener_page_belongs_to_the_session_whose_link_opened_it() {
    let mut state = DaemonState::new();
    let opener = "data:text/html,<title>A</title><a href=\"about:blank%23opened\" target=\"_blank\" rel=\"noopener\">Open</a>";
    let resp = execute_command(&json!({ "id": "1", "action": "navigate", "url": opener, "tab": "ua" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "2", "action": "navigate", "url": "data:text/html,<title>B</title>", "tab": "ub" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "3", "action": "snapshot", "interactive": true, "tab": "ua" }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "4", "action": "click", "selector": "@e1", "tab": "ua" }), &mut state).await;
    assert_success(&resp);
    for _ in 0..50 {
        let resp = execute_command(&json!({ "id": "5", "action": "tab_list" }), &mut state).await;
        if get_data(&resp)["tabs"].as_array().is_some_and(|t| t.iter().any(|t| t["label"].is_null())) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let resp = execute_command(&json!({ "id": "6", "action": "url", "tab": "ua" }), &mut state).await;
    assert!(get_data(&resp)["url"].as_str().unwrap_or_default().ends_with("#opened"), "{resp}");
    let resp = execute_command(&json!({ "id": "7", "action": "title", "tab": "ub" }), &mut state).await;
    assert_eq!(get_data(&resp)["title"], "B");
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Duplicate labels must be rejected so agents can treat a label as a unique
/// handle. The first tab keeps the label; the second tab's creation errors.
#[tokio::test]
#[ignore]
async fn e2e_tab_new_with_duplicate_label_errors() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "tab_new", "url": "about:blank", "label": "docs" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "tab_new", "url": "about:blank", "label": "docs" }),
        &mut state,
    )
    .await;
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "duplicate label should error: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );
    let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("");
    assert!(
        err.contains("already used"),
        "error should explain the collision: {}",
        err
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Positional integers passed as `tabId` on tab-switch / tab-close must be
/// rejected by the daemon-layer parser, not silently coerced. The error
/// should teach the user the correct form (`t<N>`).
#[tokio::test]
#[ignore]
async fn e2e_tab_switch_rejects_bare_integer() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "tab_switch", "tabId": "2" }),
        &mut state,
    )
    .await;
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "bare integer tabId on tab_switch should error: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );
    let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("");
    assert!(
        err.contains("t2") && err.contains("positional integers"),
        "error should teach `t<N>` convention: {}",
        err
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Element queries: isvisible, isenabled, gettext, getattribute
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_element_queries() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body>",
        "<p id='visible'>Hello World</p>",
        "<p id='hidden' style='display:none'>Hidden</p>",
        "<input id='enabled' value='test'>",
        "<input id='disabled' disabled value='nope'>",
        "<a id='link' href='https://example.com' data-testid='my-link'>Click me</a>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // isvisible
    let resp = execute_command(
        &json!({ "id": "3", "action": "isvisible", "selector": "#visible" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["visible"], true);

    let resp = execute_command(
        &json!({ "id": "4", "action": "isvisible", "selector": "#hidden" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["visible"], false);

    // isenabled
    let resp = execute_command(
        &json!({ "id": "5", "action": "isenabled", "selector": "#enabled" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["enabled"], true);

    let resp = execute_command(
        &json!({ "id": "6", "action": "isenabled", "selector": "#disabled" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["enabled"], false);

    // gettext
    let resp = execute_command(
        &json!({ "id": "7", "action": "gettext", "selector": "#visible" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "Hello World");

    // getattribute
    let resp = execute_command(
        &json!({ "id": "8", "action": "getattribute", "selector": "#link", "attribute": "href" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "https://example.com");

    let resp = execute_command(
        &json!({ "id": "9", "action": "getattribute", "selector": "#link", "attribute": "data-testid" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "my-link");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_getbyrole_uses_accessibility_tree_for_implicit_roles() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "<html><head>",
        "<link rel='stylesheet' href='data:text/css,body{}'>",
        "</head><body>",
        "<h1 style='text-transform:uppercase'>Welcome</h1>",
        "<a id='services' href='#services' onclick='window.__clicked = \"services\"'>Services</a>",
        "<button id='submit'>Submit</button>",
        "</body></html>"
    );
    let url = format!("data:text/html;base64,{}", STANDARD.encode(html));

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Implicit role from a plain HTML tag (<h1> -> heading), matched
    // case-insensitively against the accessible name despite the CSS
    // text-transform rendering it as "WELCOME".
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "getbyrole",
            "role": "heading",
            "name": "welcome",
            "subaction": "text"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "WELCOME");

    // A real <a href> must win over the unrelated <link rel="stylesheet">
    // element, which is not exposed as an AX "link" node at all.
    let resp = execute_command(
        &json!({
            "id": "4",
            "action": "getbyrole",
            "role": "link",
            "name": "Services",
            "exact": true,
            "subaction": "click"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5", "action": "page_evaluate", "script": "window.__clicked" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "services");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Wait command
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_wait() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body>",
        "<div id='target' style='display:none'>Appeared!</div>",
        "<script>setTimeout(() => document.getElementById('target').style.display='block', 500)</script>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Wait for selector to become visible
    let resp = execute_command(
        &json!({ "id": "3", "action": "wait", "selector": "#target", "state": "visible", "timeout": 5000 }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Wait for text
    let resp = execute_command(
        &json!({ "id": "4", "action": "wait", "text": "Appeared!", "timeout": 5000 }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Timeout wait
    let start = std::time::Instant::now();
    let resp = execute_command(
        &json!({ "id": "5", "action": "wait", "timeout": 200 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(
        start.elapsed().as_millis() >= 150,
        "Timeout wait should sleep at least 150ms"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// wait --load on a page that already finished loading must resolve
// immediately instead of waiting for a Page.loadEventFired that will never
// come (the common case after a click that triggers an SPA navigation).
#[tokio::test]
#[ignore]
async fn e2e_wait_load_state_resolves_immediately_when_already_loaded() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Loaded</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    for (id, load_state) in [("3", "load"), ("4", "domcontentloaded")] {
        let start = std::time::Instant::now();
        let resp = execute_command(
            &json!({ "id": id, "action": "waitforloadstate", "state": load_state, "timeout": 10000 }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert!(
            start.elapsed().as_millis() < 3000,
            "wait --load {} on an already-loaded page should resolve immediately, took {}ms",
            load_state,
            start.elapsed().as_millis()
        );
    }

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Same-document navigation regression test
// ---------------------------------------------------------------------------
//
// Chrome may perform a same-document navigation when it determines the target
// URL is the same document as the current page (ignoring fragment). This
// causes Page.loadEventFired to not fire, making wait_for_lifecycle
// hang forever waiting for an event that never comes.
//
// The fix checks loader_id in the Page.navigate response - if None,
// it's a same-document navigation and we skip waiting for lifecycle events.

#[tokio::test]
#[ignore]
async fn e2e_navigate_same_url_twice_should_not_hang() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to about:blank first to start from a known state
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "about:blank" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Create a simple HTML page that changes its own URL via history.pushState
    // This simulates SPA routing behavior which triggers same-document navigation
    let base_page = "data:text/html,<html><body><script>
        // On first load, change URL via pushState without navigation
        history.pushState({}, '', '/#/home');
    </script><h1>Test</h1></body></html>";

    // Navigate to the page (first time)
    let resp = execute_command(
        &json!({ "id": "3", "action": "navigate", "url": base_page }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Verify URL changed due to pushState
    let resp = execute_command(&json!({ "id": "4", "action": "url" }), &mut state).await;
    assert_success(&resp);
    let url_after_push = get_data(&resp)["url"].as_str().unwrap();
    // URL should have changed to include /#/home due to pushState
    assert!(
        url_after_push.contains("/%23/home") || url_after_push.contains("/#/home"),
        "URL should have changed via pushState, got: {}",
        url_after_push
    );

    // Navigate to the SAME base URL again
    // Without fix: Chrome may do same-document nav, wait_for_lifecycle hangs
    // With fix: We detect loader_id is None and skip waiting
    let start = std::time::Instant::now();
    let resp = execute_command(
        &json!({ "id": "5", "action": "navigate", "url": base_page }),
        &mut state,
    )
    .await;
    let elapsed = start.elapsed().as_secs();

    // Should complete quickly (< 5 seconds) without hanging
    // Without fix, this times out after 25 seconds (default_timeout_ms)
    assert!(
        elapsed < 5,
        "Second navigation should not hang, but took {}s",
        elapsed
    );
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Viewport with deviceScaleFactor (retina)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_viewport_scale_factor() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "about:blank" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Default devicePixelRatio should be 1
    let resp = execute_command(
        &json!({ "id": "3", "action": "page_evaluate", "script": "window.devicePixelRatio" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let default_dpr = get_data(&resp)["result"].as_f64().unwrap();
    assert_eq!(default_dpr, 1.0, "Default devicePixelRatio should be 1");

    // Set viewport with 2x scale factor
    let resp = execute_command(
        &json!({ "id": "4", "action": "viewport", "width": 1920, "height": 1080, "deviceScaleFactor": 2.0 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["width"], 1920);
    assert_eq!(get_data(&resp)["height"], 1080);
    assert_eq!(get_data(&resp)["deviceScaleFactor"], 2.0);

    // devicePixelRatio should now be 2
    let resp = execute_command(
        &json!({ "id": "5", "action": "page_evaluate", "script": "window.devicePixelRatio" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let new_dpr = get_data(&resp)["result"].as_f64().unwrap();
    assert_eq!(
        new_dpr, 2.0,
        "devicePixelRatio should be 2 after setting scale factor"
    );

    // CSS viewport width should still be 1920 (not 3840)
    let resp = execute_command(
        &json!({ "id": "6", "action": "page_evaluate", "script": "window.innerWidth" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let css_width = get_data(&resp)["result"].as_i64().unwrap();
    assert_eq!(css_width, 1920, "CSS width should remain 1920 at 2x scale");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Viewport and emulation
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_viewport_emulation() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Viewport</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Get initial width
    let resp = execute_command(
        &json!({ "id": "3", "action": "page_evaluate", "script": "window.innerWidth" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let initial_width = get_data(&resp)["result"].as_i64().unwrap();

    // Set viewport to a different size
    let resp = execute_command(
        &json!({ "id": "4", "action": "viewport", "width": 375, "height": 812, "deviceScaleFactor": 3.0, "mobile": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["width"], 375);
    assert_eq!(get_data(&resp)["height"], 812);
    assert_eq!(get_data(&resp)["mobile"], true);

    // Reload to apply viewport change
    let resp = execute_command(&json!({ "id": "5", "action": "reload" }), &mut state).await;
    assert_success(&resp);

    // Width should differ from default (setDeviceMetricsOverride applied)
    let resp = execute_command(
        &json!({ "id": "6", "action": "page_evaluate", "script": "window.innerWidth" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let new_width = get_data(&resp)["result"].as_i64().unwrap();
    assert!(
        new_width != initial_width || new_width == 375,
        "Viewport should change from {} after setDeviceMetricsOverride (got {})",
        initial_width,
        new_width
    );

    // Set user agent
    let resp = execute_command(
        &json!({ "id": "5", "action": "user_agent", "userAgent": "TestBot/1.0" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "page_evaluate", "script": "navigator.userAgent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "TestBot/1.0");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Hover, scroll, press
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_hover_scroll_press() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body style='height:3000px'>",
        "<button id='btn' onmouseover=\"this.textContent='hovered'\">Hover me</button>",
        "<input id='input' onkeydown=\"this.dataset.key=event.key\">",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Hover
    let resp = execute_command(
        &json!({ "id": "3", "action": "hover", "selector": "#btn" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Scroll
    let resp = execute_command(
        &json!({ "id": "4", "action": "scroll", "y": 500 }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5", "action": "page_evaluate", "script": "window.scrollY" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let scroll_y = get_data(&resp)["result"].as_f64().unwrap();
    assert!(scroll_y > 0.0, "Should have scrolled down");

    // Press key
    let resp = execute_command(
        &json!({ "id": "6", "action": "press", "key": "Enter" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["pressed"], "Enter");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Raw mouse regressions
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_mouse_down_move_up_preserves_drag_state() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": native_test_fixture_url("drag_probe")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "page_evaluate",
            "script": r#"(() => {
                const rect = document.getElementById('target').getBoundingClientRect();
                return {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2)
                };
            })()"#
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let start = &get_data(&resp)["result"];
    let initial_left = start["left"]
        .as_i64()
        .expect("target left should be numeric");
    let initial_top = start["top"].as_i64().expect("target top should be numeric");
    let start_x = start["x"].as_i64().expect("target x should be numeric");
    let start_y = start["y"].as_i64().expect("target y should be numeric");
    let end_x = start_x + 80;
    let end_y = start_y + 60;

    let resp = execute_command(
        &json!({ "id": "4", "action": "mousemove", "x": start_x, "y": start_y }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5", "action": "mousedown", "button": "left" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "mousemove", "x": end_x, "y": end_y }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "7", "action": "mouseup", "button": "left" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "8", "action": "page_evaluate", "script": "window.__dragProbe" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let probe = &get_data(&resp)["result"];
    assert_eq!(probe["finalLeft"].as_i64(), Some(initial_left + 80));
    assert_eq!(probe["finalTop"].as_i64(), Some(initial_top + 60));

    let events = probe["events"]
        .as_array()
        .expect("drag probe should expose events");
    assert!(
        events.iter().any(|event| {
            event["type"] == "mousedown"
                && event["x"].as_f64() == Some(start_x as f64)
                && event["y"].as_f64() == Some(start_y as f64)
                && event["buttons"].as_i64() == Some(1)
        }),
        "Expected a non-zero mousedown event in drag probe"
    );
    assert!(
        events.iter().any(|event| {
            event["type"] == "mousemove"
                && event["x"].as_f64() == Some(end_x as f64)
                && event["y"].as_f64() == Some(end_y as f64)
                && event["buttons"].as_i64() == Some(1)
        }),
        "Expected a drag mousemove with the button still pressed"
    );
    assert!(
        events.iter().any(|event| {
            event["type"] == "mouseup"
                && event["x"].as_f64() == Some(end_x as f64)
                && event["y"].as_f64() == Some(end_y as f64)
                && event["buttons"].as_i64() == Some(0)
        }),
        "Expected mouseup at the last drag position"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_mouse_drag_reaches_pointer_capture_target() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": native_test_fixture_url("pointer_capture_probe")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "page_evaluate",
            "script": r#"(() => {
                const rect = document.getElementById('handle').getBoundingClientRect();
                return {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2)
                };
            })()"#
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let start = &get_data(&resp)["result"];
    let start_x = start["x"].as_i64().expect("handle x should be numeric");
    let start_y = start["y"].as_i64().expect("handle y should be numeric");
    let end_x = start_x + 80;
    let end_y = start_y + 60;

    let resp = execute_command(
        &json!({ "id": "4", "action": "mousemove", "x": start_x, "y": start_y }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5", "action": "mousedown", "button": "left" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "mousemove", "x": end_x, "y": end_y }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "7", "action": "mouseup", "button": "left" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "8", "action": "page_evaluate", "script": "window.__pointerCaptureProbe" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let probe = &get_data(&resp)["result"];
    assert_eq!(probe["moved"].as_bool(), Some(true));

    let events = probe["events"]
        .as_array()
        .expect("pointer capture probe should expose events");
    assert!(
        events.iter().any(|event| {
            event["type"] == "pointermove"
                && event["phase"] == "drag"
                && event["hasCapture"].as_bool() == Some(true)
                && event["x"].as_f64() == Some(end_x as f64)
                && event["y"].as_f64() == Some(end_y as f64)
        }),
        "Expected pointermove with capture during the drag"
    );
    assert!(
        events.iter().any(|event| {
            event["type"] == "pointerup"
                && event["phase"] == "up"
                && event["hadCapture"].as_bool() == Some(true)
        }),
        "Expected pointerup to observe an active pointer capture"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_drag_action_sends_buttons_during_move() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": native_test_fixture_url("html5_drag_probe")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "drag",
            "source": "#source",
            "target": "#dest"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["dragged"].as_bool(), Some(true));

    let resp = execute_command(
        &json!({ "id": "4", "action": "page_evaluate", "script": "window.__html5DragProbe" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let probe = &get_data(&resp)["result"];
    let events = probe["events"]
        .as_array()
        .expect("html5 drag probe should expose events");

    // The mousemove events emitted while the button is held should carry
    // buttons == 1 so the browser recognises the gesture as a drag.
    assert!(
        events
            .iter()
            .any(|event| { event["type"] == "mousemove" && event["buttons"].as_i64() == Some(1) }),
        "Expected at least one mousemove with buttons == 1 during drag"
    );

    // dragstart must fire on the source element.
    assert!(
        events.iter().any(|event| event["type"] == "dragstart"),
        "Expected dragstart to fire on the source element"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// State save/load, state management
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_state_management() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set some storage
    let resp = execute_command(
        &json!({ "id": "3", "action": "storage_set", "type": "local", "key": "persist_key", "value": "persist_val" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Save state
    let tmp_state = std::env::temp_dir()
        .join("agent-browser-e2e-state.json")
        .to_string_lossy()
        .to_string();
    let resp = execute_command(
        &json!({ "id": "4", "action": "state_save", "path": &tmp_state }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(std::path::Path::new(&tmp_state).exists());

    // State show
    let resp = execute_command(
        &json!({ "id": "5", "action": "state_show", "path": &tmp_state }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let state_data = get_data(&resp);
    assert!(state_data.get("state").is_some());

    // State list
    let resp = execute_command(&json!({ "id": "6", "action": "state_list" }), &mut state).await;
    assert_success(&resp);
    assert!(get_data(&resp)["files"].is_array());

    // Clean up
    let _ = std::fs::remove_file(&tmp_state);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Cross-domain state save (issue #1060)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_save_state_cross_domain() {
    let mut state = DaemonState::new();

    // Launch
    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to domain A and set cookie + localStorage
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://httpbin.org/html" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3", "action": "cookies_set",
            "name": "domainA_cookie", "value": "from_httpbin"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "4", "action": "storage_set",
            "type": "local", "key": "domainA_key", "value": "domainA_val"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to domain B and set cookie + localStorage
    let resp = execute_command(
        &json!({ "id": "5", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "6", "action": "cookies_set",
            "name": "domainB_cookie", "value": "from_example"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "7", "action": "storage_set",
            "type": "local", "key": "domainB_key", "value": "domainB_val"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Save state (currently on example.com)
    let tmp_state = std::env::temp_dir()
        .join("agent-browser-e2e-cross-domain-state.json")
        .to_string_lossy()
        .to_string();
    let resp = execute_command(
        &json!({ "id": "8", "action": "state_save", "path": &tmp_state }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Read and verify saved state
    let saved = std::fs::read_to_string(&tmp_state).expect("State file should exist");
    let state_data: serde_json::Value = serde_json::from_str(&saved).unwrap();

    // Verify BOTH domain cookies are present
    let cookies = state_data["cookies"].as_array().unwrap();
    let has_domain_a = cookies.iter().any(|c| c["name"] == "domainA_cookie");
    let has_domain_b = cookies.iter().any(|c| c["name"] == "domainB_cookie");
    assert!(
        has_domain_a,
        "Should include cross-domain cookie from httpbin.org: {:?}",
        cookies
    );
    assert!(
        has_domain_b,
        "Should include cookie from example.com: {:?}",
        cookies
    );

    // Verify BOTH origins' localStorage are present
    let origins = state_data["origins"].as_array().unwrap();
    let has_origin_a = origins.iter().any(|o| {
        o["origin"].as_str().is_some_and(|s| s.contains("httpbin"))
            && o["localStorage"]
                .as_array()
                .is_some_and(|ls| ls.iter().any(|e| e["name"] == "domainA_key"))
    });
    let has_origin_b = origins.iter().any(|o| {
        o["origin"].as_str().is_some_and(|s| s.contains("example"))
            && o["localStorage"]
                .as_array()
                .is_some_and(|ls| ls.iter().any(|e| e["name"] == "domainB_key"))
    });
    assert!(
        has_origin_a,
        "Should include localStorage from httpbin.org origin: {:?}",
        origins
    );
    assert!(
        has_origin_b,
        "Should include localStorage from example.com origin: {:?}",
        origins
    );

    // Clean up
    let _ = std::fs::remove_file(&tmp_state);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Domain filter
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_domain_filter() {
    let mut state = DaemonState::new();

    // Set domain filter BEFORE launch so Fetch.enable is called during
    // launch and the background fetch handler intercepts from the start.
    {
        let mut df = state.domain_filter.write().await;
        *df = Some(super::network::DomainFilter::new("example.com"));
    }

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // The active about:blank document must be patched immediately, not only
    // after a later navigation.
    let resp = execute_command(
        &json!({
            "id": "1-rtc", "action": "page_evaluate",
            "script": "(() => { try { new RTCPeerConnection({iceServers:[{urls:'stun:secret.blocked.com:3478'}]}); return 'NOT_BLOCKED'; } catch (error) { return error.name; } })()",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "SecurityError");

    // New tabs created after launch must receive the same controls before a
    // requested URL starts loading.
    let resp = execute_command(
        &json!({ "id": "1-tab", "action": "tab_new", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({
            "id": "1-tab-rtc", "action": "page_evaluate",
            "script": "(() => { try { new RTCPeerConnection({iceServers:[{urls:'stun:secret.blocked.com:3478'}]}); return 'NOT_BLOCKED'; } catch (error) { return error.name; } })()",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "SecurityError");

    let resp = execute_command(
        &json!({ "id": "1-tab-blocked", "action": "tab_new", "url": "https://blocked.com" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    let error = resp["error"].as_str().unwrap_or("");
    assert!(
        error.contains("blocked.com") || error.contains("not allowed"),
        "Blocked tab URL should fail before loading, got: {}",
        error
    );

    let resp = execute_command(
        &json!({ "id": "1-window", "action": "window_new" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({
            "id": "1-window-rtc", "action": "page_evaluate",
            "script": "(() => { try { new RTCPeerConnection({iceServers:[{urls:'stun:secret.blocked.com:3478'}]}); return 'NOT_BLOCKED'; } catch (error) { return error.name; } })()",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "SecurityError");

    // Allowed domain
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Blocked domain
    let resp = execute_command(
        &json!({ "id": "3", "action": "navigate", "url": "https://blocked.com" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    let error = resp["error"].as_str().unwrap();
    assert!(
        error.contains("blocked") || error.contains("not allowed"),
        "Should reject blocked domain, got: {}",
        error
    );

    // Verify that in-page fetch to a blocked domain is also blocked by
    // the Fetch interception layer (not just the navigate-level check).
    // First navigate to the allowed domain.
    let resp = execute_command(
        &json!({ "id": "4", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Attempt a cross-origin fetch to a blocked domain from the page.
    let resp = execute_command(
        &json!({
            "id": "5", "action": "page_evaluate",
            "script": "fetch('https://blocked.com/data').then(() => 'ok').catch(e => 'blocked:' + e.message)",
            "await": true,
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let result = get_data(&resp)["result"].as_str().unwrap_or("");
    assert!(
        result.starts_with("blocked:"),
        "Fetch to blocked domain should fail, got: {}",
        result,
    );

    // WebRTC uses DNS and UDP outside CDP Fetch interception, so the domain
    // filter must disable both Chromium constructor names before page scripts
    // can create a peer connection.
    let resp = execute_command(
        &json!({
            "id": "6", "action": "page_evaluate",
            "script": "['RTCPeerConnection','webkitRTCPeerConnection'].filter(name => typeof window[name] === 'function').map(name => { try { new window[name]({iceServers:[{urls:'stun:secret.blocked.com:3478'}]}); return name + ':NOT_BLOCKED'; } catch (error) { return name + ':' + error.name; } })",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let results = get_data(&resp)["result"].as_array().unwrap();
    assert!(
        !results.is_empty(),
        "RTCPeerConnection should be available in Chrome"
    );
    assert!(
        results.iter().all(|result| result
            .as_str()
            .is_some_and(|value| value.ends_with(":SecurityError"))),
        "Every peer connection constructor should be blocked, got: {:?}",
        results,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_domain_filter_reports_blocked_redirect() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let requests_for_server = requests.clone();
    let server = tokio::spawn(async move {
        for _ in 0..20 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let requests = requests_for_server.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let request_line = request.lines().next().unwrap_or("").to_string();
                let response = if request_line.contains(" /redirect ") {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/denied\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        port,
                    )
                } else {
                    let body = "<!doctype html><title>Blocked</title>allowed";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body,
                    )
                };
                if let Ok(mut logged) = requests.lock() {
                    logged.push(request_line);
                }
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    let mut state = DaemonState::new();
    {
        let mut df = state.domain_filter.write().await;
        *df = Some(super::network::DomainFilter::new("localhost"));
    }

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": format!("http://localhost:{}/redirect", port),
        }),
        &mut state,
    )
    .await;
    assert_eq!(
        resp["success"], false,
        "Blocked redirect reported success: {}",
        resp
    );
    let error = resp["error"].as_str().unwrap_or("");
    assert!(
        error.contains(&format!("http://127.0.0.1:{}/denied", port))
            && error.contains("domain filter"),
        "Blocked redirect should name the blocked URL, got: {}",
        error
    );
    let logged = requests.lock().unwrap().clone();
    assert!(
        !logged.iter().any(|line| line.contains(" /denied ")),
        "Blocked redirect target was requested: {:?}",
        logged
    );

    // An allowed page whose own title is "Blocked" is still a success.
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "navigate",
            "url": format!("http://localhost:{}/", port),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_domain_filter_blocks_page_created_popup_before_first_request() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let requests_for_server = requests.clone();
    let server = tokio::spawn(async move {
        for _ in 0..20 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let requests = requests_for_server.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let request_line = request.lines().next().unwrap_or("").to_string();
                if let Ok(mut logged) = requests.lock() {
                    logged.push(request_line);
                }

                let body = "<!doctype html><title>allowed</title><button id=\"go\">go</button>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    let mut state = DaemonState::new();
    {
        let mut df = state.domain_filter.write().await;
        *df = Some(super::network::DomainFilter::new("localhost"));
    }

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": format!("http://localhost:{}/", port),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "page_evaluate",
            "script": format!("window.open('http://127.0.0.1:{}/leak'); 'done'", port),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    let logged = requests.lock().unwrap().clone();
    assert!(
        !logged.iter().any(|line| line.contains(" /leak ")),
        "Blocked popup made a server request: {:?}",
        logged
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_domain_filter_blocks_service_worker_requests() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let requests_for_server = requests.clone();
    let server = tokio::spawn(async move {
        for _ in 0..20 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let requests = requests_for_server.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let request_line = request.lines().next().unwrap_or("").to_string();
                if let Ok(mut logged) = requests.lock() {
                    logged.push(request_line.clone());
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");

                let (content_type, body) = if path == "/sw.js" {
                    (
                        "application/javascript",
                        format!(
                            r#"self.addEventListener('message', event => {{
    event.source && event.source.postMessage('started');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    fetch('http://127.0.0.1:{}/leak', {{ mode: 'no-cors', signal: controller.signal }})
        .then(() => event.source && event.source.postMessage('leaked'))
        .catch(error => event.source && event.source.postMessage('blocked:' + error.name));
}});"#,
                            port
                        ),
                    )
                } else {
                    (
                        "text/html",
                        r#"<!doctype html><title>allowed</title><script>
window.swResult = 'pending';
navigator.serviceWorker.register('/sw.js').then(async reg => {
    await navigator.serviceWorker.ready;
    const sw = reg.active || reg.waiting || reg.installing;
    navigator.serviceWorker.addEventListener('message', event => {
        window.swResult = event.data;
    });
    sw.postMessage('go');
}).catch(error => {
    window.swResult = 'register:' + error.name;
});
</script>"#
                            .to_string(),
                    )
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    content_type,
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    let mut state = DaemonState::new();
    {
        let mut df = state.domain_filter.write().await;
        *df = Some(super::network::DomainFilter::new("localhost"));
    }

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": format!("http://localhost:{}/", port),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let mut sw_result = "pending".to_string();
    for _ in 0..50 {
        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "page_evaluate",
                "script": "window.swResult || 'pending'",
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        sw_result = get_data(&resp)["result"]
            .as_str()
            .unwrap_or("pending")
            .to_string();
        if !matches!(sw_result.as_str(), "pending" | "started") {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    let logged = requests.lock().unwrap().clone();
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    server.abort();

    assert!(
        sw_result.starts_with("blocked:"),
        "Service worker request should be blocked, got: {}",
        sw_result
    );
    assert!(
        !logged.iter().any(|line| line.contains(" /leak ")),
        "Blocked service worker request reached the server: {:?}",
        logged
    );
}

#[tokio::test]
#[ignore]
async fn e2e_domain_filter_blocks_worker_websocket_requests() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let requests_for_server = requests.clone();
    let server = tokio::spawn(async move {
        for _ in 0..20 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let requests = requests_for_server.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let request_line = request.lines().next().unwrap_or("").to_string();
                if let Ok(mut logged) = requests.lock() {
                    logged.push(request_line.clone());
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");

                let (content_type, body) = if path == "/worker.js" {
                    (
                        "application/javascript",
                        format!(
                            r#"self.addEventListener('message', async () => {{
    try {{
        const response = await fetch('/worker-ping');
        const text = await response.text();
        if (text !== 'pong') {{
            self.postMessage('fetch:' + text);
            return;
        }}
    }} catch (error) {{
        self.postMessage('fetch-error:' + error.name);
        return;
    }}

    try {{
        const ws = new WebSocket('ws://127.0.0.1:{}/leak');
        ws.onopen = () => self.postMessage('leaked');
        ws.onerror = () => self.postMessage('blocked:error');
    }} catch (error) {{
        self.postMessage('blocked:' + error.name);
    }}
}});"#,
                            port
                        ),
                    )
                } else if path == "/worker-ping" {
                    ("text/plain", "pong".to_string())
                } else {
                    (
                        "text/html",
                        r#"<!doctype html><title>allowed</title><script>
window.workerWsResult = 'pending';
const worker = new Worker('/worker.js');
worker.onmessage = event => {
    window.workerWsResult = event.data;
};
worker.onerror = () => {
    window.workerWsResult = 'worker:error';
};
worker.postMessage('go');
</script>"#
                            .to_string(),
                    )
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    content_type,
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    let mut state = DaemonState::new();
    {
        let mut df = state.domain_filter.write().await;
        *df = Some(super::network::DomainFilter::new("localhost"));
    }

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": format!("http://localhost:{}/", port),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let mut worker_result = "pending".to_string();
    for _ in 0..50 {
        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "page_evaluate",
                "script": "window.workerWsResult || 'pending'",
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        worker_result = get_data(&resp)["result"]
            .as_str()
            .unwrap_or("pending")
            .to_string();
        if worker_result != "pending" {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    let logged = requests.lock().unwrap().clone();
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    server.abort();

    assert!(
        worker_result.starts_with("blocked:"),
        "Worker WebSocket should be blocked, got: {}",
        worker_result
    );
    assert!(
        !logged.iter().any(|line| line.contains(" /leak ")),
        "Blocked worker WebSocket reached the server: {:?}",
        logged
    );
}

#[tokio::test]
#[ignore]
async fn e2e_domain_filter_blocks_csp_self_worker_fallback() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let requests_for_server = requests.clone();
    let server = tokio::spawn(async move {
        for _ in 0..20 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let requests = requests_for_server.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let request_line = request.lines().next().unwrap_or("").to_string();
                if let Ok(mut logged) = requests.lock() {
                    logged.push(request_line.clone());
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");

                let (content_type, body, csp) = if path == "/worker.js" {
                    (
                        "application/javascript",
                        format!(
                            r#"self.addEventListener('message', async () => {{
    try {{
        const response = await fetch('/worker-ping');
        const text = await response.text();
        try {{
            await fetch('http://127.0.0.1:{}/leak', {{ mode: 'no-cors' }});
            self.postMessage('leaked');
        }} catch (error) {{
            self.postMessage('started:' + text + ';blocked:' + error.name);
        }}
    }} catch (error) {{
        self.postMessage('blocked:' + error.name);
    }}
}});"#,
                            port
                        ),
                        None,
                    )
                } else if path == "/worker-ping" {
                    ("text/plain", "pong".to_string(), None)
                } else {
                    (
                        "text/html",
                        r#"<!doctype html><title>allowed</title><script>
window.workerCspResult = 'pending';
const worker = new Worker('/worker.js');
worker.onmessage = event => {
    window.workerCspResult = event.data;
};
worker.onerror = () => {
    window.workerCspResult = 'worker:error';
};
worker.postMessage('go');
</script>"#
                            .to_string(),
                        Some("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'\r\n"),
                    )
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    content_type,
                    csp.unwrap_or(""),
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    let mut state = DaemonState::new();
    {
        let mut df = state.domain_filter.write().await;
        *df = Some(super::network::DomainFilter::new("localhost"));
    }

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": format!("http://localhost:{}/", port),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let mut worker_result = "pending".to_string();
    for _ in 0..50 {
        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "page_evaluate",
                "script": "window.workerCspResult || 'pending'",
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        worker_result = get_data(&resp)["result"]
            .as_str()
            .unwrap_or("pending")
            .to_string();
        if worker_result != "pending" {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    let logged = requests.lock().unwrap().clone();
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    server.abort();

    assert_eq!(
        worker_result, "worker:error",
        "CSP-blocked worker bootstrap must fail closed instead of running an unguarded worker"
    );
    assert!(
        !logged.iter().any(|line| line.contains(" /leak ")),
        "Blocked CSP fallback worker request reached the server: {:?}",
        logged
    );
}

#[tokio::test]
#[ignore]
async fn e2e_domain_filter_blocks_module_worker_top_level_requests() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let requests_for_server = requests.clone();
    let server = tokio::spawn(async move {
        for _ in 0..20 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let requests = requests_for_server.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let request_line = request.lines().next().unwrap_or("").to_string();
                if let Ok(mut logged) = requests.lock() {
                    logged.push(request_line.clone());
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");

                let (content_type, body) = if path == "/module-worker.js" {
                    (
                        "application/javascript",
                        format!(
                            r#"try {{
    await fetch('http://127.0.0.1:{}/leak', {{ mode: 'no-cors' }});
    self.postMessage('leaked');
}} catch (error) {{
    self.postMessage('blocked:' + error.name);
}}"#,
                            port
                        ),
                    )
                } else {
                    (
                        "text/html",
                        r#"<!doctype html><title>allowed</title><script>
window.moduleWorkerResult = 'pending';
const worker = new Worker('/module-worker.js', { type: 'module' });
worker.onmessage = event => {
    window.moduleWorkerResult = event.data;
};
worker.onerror = () => {
    window.moduleWorkerResult = 'worker:error';
};
</script>"#
                            .to_string(),
                    )
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    content_type,
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    let mut state = DaemonState::new();
    {
        let mut df = state.domain_filter.write().await;
        *df = Some(super::network::DomainFilter::new("localhost"));
    }

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": format!("http://localhost:{}/", port),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let mut worker_result = "pending".to_string();
    for _ in 0..50 {
        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "page_evaluate",
                "script": "window.moduleWorkerResult || 'pending'",
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        worker_result = get_data(&resp)["result"]
            .as_str()
            .unwrap_or("pending")
            .to_string();
        if worker_result != "pending" {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    let logged = requests.lock().unwrap().clone();
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    server.abort();

    assert!(
        worker_result.starts_with("blocked:"),
        "Module worker top-level request should be blocked, got: {}",
        worker_result
    );
    assert!(
        !logged.iter().any(|line| line.contains(" /leak ")),
        "Blocked module worker request reached the server: {:?}",
        logged
    );
}

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_diff_snapshot() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": native_test_fixture_url("snapshot_diff_probe")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Take a snapshot and use it as baseline for diff
    let resp = execute_command(&json!({ "id": "3", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let baseline = get_data(&resp)["snapshot"].as_str().unwrap().to_string();
    assert!(baseline.starts_with("- button \"Primary action\" [ref=e1]"));
    std::fs::create_dir_all(crate::native::file_root::root()).unwrap();
    let baseline_dir = tempfile::tempdir_in(crate::native::file_root::root()).unwrap();
    let baseline_path = baseline_dir.path().join("baseline.txt");
    std::fs::write(&baseline_path, format!("{}\n", baseline)).unwrap();

    // A failed diff must preserve the refs from the last successful snapshot.
    let resp = execute_command(
        &json!({
            "id": "4",
            "action": "diff_snapshot",
            "baseline": baseline_path,
            "selector": "#missing"
        }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(resp["error"]
        .as_str()
        .unwrap()
        .contains("did not match any element"));

    let resp = execute_command(
        &json!({ "id": "5", "action": "click", "selector": "e1" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Repeated diffs preserve document refs and report no content changes.
    for id in ["6", "7"] {
        let resp = execute_command(
            &json!({ "id": id, "action": "diff_snapshot", "baseline": baseline_path }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        let data = get_data(&resp);
        assert_eq!(data["changed"], false);
        assert_eq!(data["additions"], 0);
        assert_eq!(data["removals"], 0);
        assert_eq!(data["diff"], "");
    }

    // Modify the page
    let resp = execute_command(
        &json!({
            "id": "8",
            "action": "page_evaluate",
            "script": "document.querySelector('#primary-action').textContent = 'Updated action'"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Diff against baseline
    let resp = execute_command(
        &json!({ "id": "9", "action": "diff_snapshot", "baseline": baseline_path }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(
        data["changed"], true,
        "Diff should detect the button change"
    );
    assert_eq!(data["additions"], 1);
    assert_eq!(data["removals"], 1);
    assert!(data["diff"].as_str().unwrap().contains("Updated action"));

    // With no baseline it compares with the last snapshot: the diff above, then this one after a change.
    let resp = execute_command(
        &json!({
            "id": "10",
            "action": "page_evaluate",
            "script": "document.querySelector('#primary-action').textContent = 'Changed again'"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "11", "action": "diff_snapshot" }), &mut state).await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["additions"], 1);
    assert_eq!(data["removals"], 1);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_diff_url_aligns_refs_after_snapshot() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let stale_url = "data:text/html,<button id='stale-action'>Stale action</button>";
    let url = native_test_fixture_url("snapshot_diff_probe");
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": stale_url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Populate refs that must be invalidated once the URL diff starts navigating.
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "snapshot",
            "selector": "#stale-action"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(state.ref_map.get("e1").is_some());

    let resp = execute_command(
        &json!({
            "id": "4",
            "action": "diff_url",
            "url1": url,
            "url2": "http://[invalid"
        }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(state.ref_map.entries_sorted().is_empty());

    let resp = execute_command(
        &json!({
            "id": "5",
            "action": "page_evaluate",
            "script": "document.querySelector('#primary-action')?.textContent"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Primary action");

    let resp = execute_command(
        &json!({ "id": "6", "action": "click", "selector": "e1" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(resp["error"].as_str().unwrap().contains("Unknown ref: e1"));

    // Populate the session ref map before comparing the same URL to itself.
    let resp = execute_command(&json!({ "id": "7", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "8",
            "action": "diff_url",
            "url1": url,
            "url2": url
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["diff"]["identical"], true);
    assert_eq!(data["diff"]["changed"], false);
    assert_eq!(data["diff"]["additions"], 0);
    assert_eq!(data["diff"]["removals"], 0);
    assert_ne!(
        data["snapshot1"], data["snapshot2"],
        "Replaced documents must not recycle actionable IDs"
    );
    assert_eq!(
        super::diff::snapshot_comparison_text(data["snapshot1"].as_str().unwrap()),
        super::diff::snapshot_comparison_text(data["snapshot2"].as_str().unwrap())
    );
    let primary_ref = state
        .ref_map
        .entries_sorted()
        .into_iter()
        .find(|(_, entry)| entry.name == "Primary action")
        .unwrap()
        .0;
    let next = execute_command(&json!({"id": "9", "action": "snapshot"}), &mut state).await;
    assert_success(&next);
    assert_eq!(
        get_data(&next)["refs"][&primary_ref]["name"],
        "Primary action"
    );
    assert_success(
        &execute_command(
            &json!({"id": "10", "action": "click", "selector": primary_ref}),
            &mut state,
        )
        .await,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Phase 8 commands: focus, clear, count, boundingbox, innertext, setvalue
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_phase8_commands() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body>",
        "<input id='a' value='original'>",
        "<input id='b' value='other'>",
        "<p class='item'>One</p>",
        "<p class='item'>Two</p>",
        "<p class='item'>Three</p>",
        "<div id='box' style='width:200px;height:100px;background:red'>Box</div>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Focus
    let resp = execute_command(
        &json!({ "id": "10", "action": "focus", "selector": "#a" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Clear
    let resp = execute_command(
        &json!({ "id": "11", "action": "clear", "selector": "#a" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "12", "action": "page_evaluate", "script": "document.getElementById('a').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "");

    // Set value
    let resp = execute_command(
        &json!({ "id": "13", "action": "setvalue", "selector": "#b", "value": "new-value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "14", "action": "inputvalue", "selector": "#b" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "new-value");

    // Count
    let resp = execute_command(
        &json!({ "id": "15", "action": "count", "selector": ".item" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["count"], 3);

    // Bounding box
    let resp = execute_command(
        &json!({ "id": "16", "action": "boundingbox", "selector": "#box" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let bbox = get_data(&resp);
    assert_eq!(bbox["width"], 200.0);
    assert_eq!(bbox["height"], 100.0);
    assert!(bbox["x"].as_f64().is_some());
    assert!(bbox["y"].as_f64().is_some());

    // Inner text
    let resp = execute_command(
        &json!({ "id": "17", "action": "innertext", "selector": "#box" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "Box");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Auto-launch (tests that commands auto-launch when no browser exists)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_auto_launch() {
    let mut state = DaemonState::new();

    // Navigate without explicit launch -- should auto-launch
    let resp = execute_command(
        &json!({ "id": "1", "action": "navigate", "url": "data:text/html,<h1>Auto</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(state.browser.is_some(), "Browser should be auto-launched");

    let resp = execute_command(
        &json!({ "id": "2", "action": "page_evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Auto");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_error_handling() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Errors</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Unknown action
    let resp = execute_command(
        &json!({ "id": "10", "action": "nonexistent_action" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(resp["error"]
        .as_str()
        .unwrap()
        .contains("Not yet implemented"));

    // Missing required parameter
    let resp = execute_command(
        &json!({ "id": "11", "action": "fill", "selector": "#x" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(resp["error"].as_str().unwrap().contains("value"));

    // Click on non-existent element
    let resp = execute_command(
        &json!({ "id": "12", "action": "click", "selector": "#does-not-exist" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);

    // Evaluate syntax error
    let resp = execute_command(
        &json!({ "id": "13", "action": "page_evaluate", "script": "}{invalid" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(resp["error"].as_str().unwrap().contains("error"));

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_click_reports_covering_overlay() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = r#"
        <html>
        <body>
            <button id="target" onclick="document.getElementById('result').textContent = 'clicked'">
                Target
            </button>
            <div id="consent-banner" style="position:fixed;inset:0;z-index:10;background:rgba(0,0,0,0.1)">
                <button id="dismiss" style="position:absolute;right:20px;bottom:20px"
                    onclick="document.getElementById('consent-banner').remove()">
                    Dismiss
                </button>
            </div>
            <div id="result">idle</div>
        </body>
        </html>
    "#;
    let url = format!("data:text/html;base64,{}", STANDARD.encode(html));
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "click", "selector": "#target" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false, "covered target should fail: {resp}");
    let error = resp["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("covered by <div#consent-banner>"),
        "unexpected covered-click error: {}",
        error
    );

    let resp = execute_command(
        &json!({ "id": "4", "action": "gettext", "selector": "#result" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "idle");

    let resp = execute_command(
        &json!({ "id": "5", "action": "click", "selector": "#dismiss" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "click", "selector": "#target" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "7", "action": "gettext", "selector": "#result" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "clicked");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// The text of the element `selector` names.
async fn text_of(state: &mut DaemonState, selector: &str) -> String {
    let resp = execute_command(&json!({ "id": "t", "action": "gettext", "selector": selector }), state).await;
    assert_success(&resp);
    get_data(&resp)["text"].as_str().unwrap_or_default().to_string()
}

/// A part of the target's own control drawn over it (a ripple or icon over a
/// styled checkbox's input, the shown value over a select's input) is where a
/// person clicks that control, so it is not a cover. A cover whose nearest
/// common wrapper with the target holds another control still is.
#[tokio::test]
#[ignore]
async fn e2e_a_part_of_the_targets_own_control_is_not_a_cover() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Built from the two controls a Vuetify form refused: a checkbox whose
    // input sits under its ripple, and a select whose input sits under the
    // paragraph showing its value. Each wrapper takes the click itself.
    let html = r#"
        <html>
        <body>
            <div id="cb-wrap" style="position:relative;width:24px;height:24px"
                onclick="var i=document.getElementById('cb');i.checked=!i.checked;document.getElementById('result').textContent='cb:'+i.checked">
                <input id="cb" type="checkbox" role="checkbox" style="position:absolute;inset:0;opacity:0;margin:0">
                <div class="selection-controls__ripple" style="position:absolute;inset:-12px;z-index:1;border-radius:50%"></div>
            </div>
            <div id="sel-wrap" role="button" style="position:relative;width:200px;height:32px;margin-top:20px"
                onclick="document.getElementById('result').textContent='menu open'">
                <div class="select__selections" style="position:relative;width:200px;height:32px">
                    <p class="address-type-text" style="position:absolute;inset:0;margin:0;z-index:1">Registered office</p>
                    <input id="sel" readonly style="width:200px;height:32px">
                </div>
            </div>
            <div id="card" style="position:relative;width:200px;height:40px;margin-top:20px">
                <button id="under" onclick="document.getElementById('result').textContent='under'">Under</button>
                <div id="mask" style="position:absolute;inset:0;z-index:1">
                    <button id="other" style="position:absolute;right:0;bottom:0">Other</button>
                </div>
            </div>
            <div id="result">idle</div>
        </body>
        </html>
    "#;
    let url = format!("data:text/html;base64,{}", STANDARD.encode(html));
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "click", "selector": "#cb" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(text_of(&mut state, "#result").await, "cb:true");

    let resp = execute_command(
        &json!({ "id": "4", "action": "click", "selector": "#sel" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(text_of(&mut state, "#result").await, "menu open");

    let resp = execute_command(
        &json!({ "id": "5", "action": "click", "selector": "#under" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false, "a cover holding another control is a cover: {resp}");
    let error = resp["error"].as_str().unwrap_or_default();
    assert!(error.contains("covered by <div#mask>"), "unexpected covered-click error: {error}");
    assert_eq!(text_of(&mut state, "#result").await, "menu open");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// What `fill` and `type` leave in a field reaches a model the page binds to
/// typing's events, as a person's keys would: the field's model from `input`,
/// its totals from `keyup` (a Vue/Vuetify form recomputes on key release).
/// A field that already held text is replaced, not appended to.
#[tokio::test]
#[ignore]
async fn e2e_fill_and_type_reach_a_model_bound_to_typing_events() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = r#"
        <html>
        <body>
            <input id="qty" value="1">
            <input id="price" value="10">
            <div id="model"></div>
            <script>
                const model = { qty: '1', price: '10', total: 10 };
                const show = () => document.getElementById('model').textContent =
                    model.qty + '|' + model.price + '|' + model.total;
                for (const id of ['qty', 'price']) {
                    const el = document.getElementById(id);
                    el.addEventListener('input', (e) => { model[id] = e.target.value; show(); });
                    el.addEventListener('keyup', () => { model.total = Number(model.qty) * Number(model.price); show(); });
                }
                show();
            </script>
        </body>
        </html>
    "#;
    let url = format!("data:text/html;base64,{}", STANDARD.encode(html));
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "fill", "selector": "#qty", "value": "3" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(text_of(&mut state, "#model").await, "3|10|30", "fill reaches the model and its totals");

    let resp = execute_command(
        &json!({ "id": "4", "action": "type", "selector": "#price", "text": "25", "clear": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(text_of(&mut state, "#model").await, "3|25|75", "type reaches the model and its totals");

    let resp = execute_command(
        &json!({ "id": "5", "action": "page_evaluate", "script": "document.getElementById('qty').value + ',' + document.getElementById('price').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "3,25", "the fields hold what the model holds");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Profile cookie persistence across restarts
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_profile_cookie_persistence() {
    let profile_dir = std::env::temp_dir().join(format!(
        "agent-browser-e2e-profile-{}",
        uuid::Uuid::new_v4()
    ));

    // Session 1: launch with profile, set a cookie, close
    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({
                "id": "1",
                "action": "launch",
                "headless": true,
                "profile": profile_dir.to_str().unwrap()
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "cookies_set",
                "name": "persist_test",
                "value": "should_survive_restart",
                "domain": ".example.com",
                "path": "/",
                "expires": 2000000000
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        // Verify cookie is set
        let resp =
            execute_command(&json!({ "id": "4", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies
            .iter()
            .any(|c| c["name"] == "persist_test" && c["value"] == "should_survive_restart");
        assert!(found, "Cookie should exist before close");

        let resp = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    // Session 2: reopen with the same profile, verify cookie persisted
    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({
                "id": "10",
                "action": "launch",
                "headless": true,
                "profile": profile_dir.to_str().unwrap()
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "11", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp =
            execute_command(&json!({ "id": "12", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies
            .iter()
            .any(|c| c["name"] == "persist_test" && c["value"] == "should_survive_restart");
        assert!(
            found,
            "Cookie should persist across restart with --profile. Cookies found: {:?}",
            cookies
                .iter()
                .map(|c| c["name"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
        );

        let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    let _ = std::fs::remove_dir_all(&profile_dir);
}

// ---------------------------------------------------------------------------
// Inspect / CDP URL
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_get_cdp_url() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "2", "action": "cdp_url" }), &mut state).await;
    assert_success(&resp);
    let cdp_url = get_data(&resp)["cdpUrl"]
        .as_str()
        .expect("cdpUrl should be a string");
    assert!(
        cdp_url.starts_with("ws://"),
        "CDP URL should start with ws://, got: {}",
        cdp_url
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_inspect() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "inspect" }), &mut state).await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["opened"], true);
    let url = data["url"]
        .as_str()
        .expect("inspect url should be a string");
    // A launched browser's debugger is on a pipe, with no HTTP server to serve DevTools from: DevTools opens as a tab of
    // that browser, from the copy it carries, pointed at the daemon's inspect proxy.
    let proxy = url
        .strip_prefix("devtools://devtools/bundled/devtools_app.html?ws=")
        .unwrap_or_else(|| panic!("Inspect URL should be the browser's own DevTools, got: {url}"));
    assert!(proxy.starts_with("127.0.0.1:"), "{url}");
    let (_ws, _) = tokio_tungstenite::connect_async(format!("ws://{proxy}"))
        .await
        .expect("the inspect proxy DevTools is pointed at answers");
    let targets = state.browser.as_ref().unwrap().client.send_command("Target.getTargets", None, None).await.unwrap();
    assert!(targets.to_string().contains("devtools://devtools/bundled/devtools_app.html"), "DevTools opened as a tab: {targets}");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Stale ref fallback (#805): clicking a ref after the DOM has been replaced
// should fall back to role/name lookup instead of failing.
// ---------------------------------------------------------------------------

/// A page whose only control has the name the next page's has, and leads there. The next page says if it was pressed.
/// Served, since a page's script may not navigate the top frame to a `data:` address.
async fn serve_pages_with_a_control_of_the_same_name() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let body = if String::from_utf8_lossy(&buf[..n]).starts_with("GET /next") {
                    "<title>next</title><button onclick=\"document.title='pressed'\">Go</button>"
                } else {
                    "<title>first</title><button onclick=\"location.href='/next'\">Go</button>"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (base_url, handle)
}

/// A ref names an element of the document a snapshot numbered it in. Clicking one that navigated must not press the
/// same-named control on the page it led to and report success.
#[tokio::test]
#[ignore]
async fn e2e_a_ref_never_presses_the_same_named_control_on_the_next_page() {
    let (page, server) = serve_pages_with_a_control_of_the_same_name().await;
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "navigate", "url": page }),
        json!({ "id": "3", "action": "snapshot" }),
        json!({ "id": "4", "action": "click", "selector": "@e1" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    assert_evaluate(&mut state, "4b", "document.title", json!("next")).await;
    let again = execute_command(&json!({ "id": "5", "action": "click", "selector": "@e1" }), &mut state).await;
    assert_eq!(again["success"], false, "{again}");
    assert!(again["error"].as_str().unwrap_or_default().contains("stale"), "{again}");
    assert_evaluate(&mut state, "6", "document.title", json!("next")).await;

    // A new snapshot names the page now showing.
    let snapshot = execute_command(&json!({ "id": "8", "action": "snapshot" }), &mut state).await;
    let press = get_data(&snapshot)["snapshot"].as_str().unwrap().split("ref=").nth(1).unwrap().split(']').next().unwrap().to_string();
    assert_success(&execute_command(&json!({ "id": "9", "action": "click", "selector": format!("@{press}") }), &mut state).await);
    assert_evaluate(&mut state, "10", "document.title", json!("pressed")).await;
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
    server.abort();
}

/// `setcontent` replaces every node under the same loader, so the document's identity can't show it: it says so itself.
#[tokio::test]
#[ignore]
async fn e2e_setcontent_takes_the_refs_of_what_it_replaced() {
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "setcontent", "html": "<button>Go</button>" }),
        json!({ "id": "3", "action": "snapshot" }),
        json!({ "id": "4", "action": "setcontent", "html": "<button onclick=\"document.title='pressed'\">Go</button>" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let press = execute_command(&json!({ "id": "5", "action": "click", "selector": "@e1" }), &mut state).await;
    assert_eq!(press["success"], false, "{press}");
    assert_evaluate(&mut state, "6", "document.title", json!("")).await;
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

/// A frame selection is of a document. Once the page has moved on, by any command or by itself, a selector means the
/// top of the page again, and a step back answers from the page it reached.
#[tokio::test]
#[ignore]
async fn e2e_a_frame_selection_goes_with_the_page_that_held_it() {
    let mut state = DaemonState::new();
    let framed = format!(
        "data:text/html;base64,{}",
        STANDARD.encode("<title>framed</title><iframe id=f srcdoc=\"<button id=inner>in</button>\"></iframe>")
    );
    let plain = format!("data:text/html;base64,{}", STANDARD.encode("<title>plain</title><button id=top>top</button>"));
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "navigate", "url": plain }),
        json!({ "id": "3", "action": "navigate", "url": framed }),
        json!({ "id": "4", "action": "frame", "selector": "#f" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    assert!(state.active_frame_id.is_some());
    let back = execute_command(&json!({ "id": "5", "action": "back" }), &mut state).await;
    assert_success(&back);
    assert!(get_data(&back)["url"].as_str().unwrap_or_default().contains(&plain[..40]), "{back}");
    assert!(state.active_frame_id.is_none());
    assert_success(&execute_command(&json!({ "id": "6", "action": "click", "selector": "#top" }), &mut state).await);

    // The same when a page's own script moved it.
    assert_success(&execute_command(&json!({ "id": "7", "action": "forward" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "8", "action": "frame", "selector": "#f" }), &mut state).await);
    let script = "setTimeout(() => history.back(), 0); true";
    assert_success(&execute_command(&json!({ "id": "9", "action": "page_evaluate", "script": script }), &mut state).await);
    tokio::time::sleep(tokio::time::Duration::from_millis(600)).await;
    assert_success(&execute_command(&json!({ "id": "10", "action": "click", "selector": "#top" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

/// A navigation refused before it starts leaves the page where it was, so what was numbered on it still holds. (One the
/// network fails is not this: Chrome commits an error page, and the ref then refuses itself as stale.)
#[tokio::test]
#[ignore]
async fn e2e_a_navigation_that_failed_keeps_the_refs_of_the_page_still_showing() {
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "navigate", "url": "data:text/html,<button onclick=\"document.title='pressed'\">Go</button>" }),
        json!({ "id": "3", "action": "snapshot" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let failed = execute_command(&json!({ "id": "4", "action": "navigate", "url": "http://[invalid" }), &mut state).await;
    assert_eq!(failed["success"], false, "{failed}");
    assert_success(&execute_command(&json!({ "id": "5", "action": "click", "selector": "@e1" }), &mut state).await);
    assert_evaluate(&mut state, "6", "document.title", json!("pressed")).await;
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

/// A real trace and profile end, with what Chrome sent, through the reader that loses nothing.
#[tokio::test]
#[ignore]
async fn e2e_a_trace_and_a_profile_come_back_with_their_events() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = DaemonState::new();
    let page = "data:text/html,<h1>traced</h1>";
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    for (start, stop, file) in [("trace_start", "trace_stop", "t.json"), ("profiler_start", "profiler_stop", "p.json")] {
        assert_success(&execute_command(&json!({ "id": "2", "action": start }), &mut state).await);
        assert_success(&execute_command(&json!({ "id": "3", "action": "navigate", "url": page }), &mut state).await);
        let path = dir.path().join(file);
        let stopped = execute_command(&json!({ "id": "4", "action": stop, "path": path.to_str() }), &mut state).await;
        assert_success(&stopped);
        assert!(get_data(&stopped)["eventCount"].as_u64().unwrap_or_default() > 0, "{stopped}");
    }
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

#[tokio::test]
#[ignore]
async fn e2e_click_stale_ref_falls_back_to_role_name() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to a page with a button that replaces the DOM when clicked.
    let html = r#"data:text/html,<body>
        <div id="c">
            <button onclick="
                var c = document.getElementById('c');
                c.innerHTML = '';
                var b = document.createElement('button');
                b.textContent = 'Target';
                b.onclick = function() { document.title = 'clicked'; };
                c.appendChild(b);
                document.title = 'replaced';
            ">Replace</button>
            <button>Target</button>
        </div>
    </body>"#;

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Snapshot to populate the ref_map with backend_node_ids.
    let resp = execute_command(&json!({ "id": "3", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();
    assert!(
        snapshot.contains("Replace"),
        "Snapshot should contain Replace button"
    );
    assert!(
        snapshot.contains("Target"),
        "Snapshot should contain Target button"
    );

    // Click "Replace" — this removes all DOM nodes and recreates them,
    // making the backend_node_id for "Target" stale.
    let resp = execute_command(
        &json!({ "id": "4", "action": "click", "selector": "e1" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    // Verify the DOM was actually replaced.
    let resp = execute_command(&json!({ "id": "5", "action": "title" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["title"], "replaced");

    // Now click the stale "Target" ref. Before the fix this returned:
    //   "CDP error (DOM.getBoxModel): Could not compute box model."
    // After the fix it falls back to role/name lookup and succeeds.
    let resp = execute_command(
        &json!({ "id": "6", "action": "click", "selector": "e2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    // Verify the fallback click hit the right (recreated) button.
    let resp = execute_command(&json!({ "id": "7", "action": "title" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["title"],
        "clicked",
        "Stale ref should have been resolved via role/name fallback"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Regression: Material Design checkbox/radio (#832)
//
// Material Design controls hide the native <input> off-screen and place
// overlay elements (ripple, touch-target) on top.  Coordinate-based CDP
// clicks may therefore miss the actual input.  The check/uncheck actions
// must detect this and fall back to a JS .click() — matching the behaviour
// that Playwright provided in v0.19.0.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_material_checkbox_check_uncheck() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Inline HTML that reproduces the Material Design DOM pattern:
    // - Native <input> is visually hidden (position:absolute, opacity:0, off-screen)
    // - A ripple overlay sits on top with pointer-events:all, intercepting coordinate clicks
    // - An ARIA-only checkbox uses role="checkbox" + aria-checked (no native input)
    let html = concat!(
        "data:text/html,<html><body>",
        // -- Native baseline --
        "<input id='native' type='checkbox'>",
        // -- Material-style hidden-input checkbox --
        "<div id='mat' style='position:relative;padding:12px'>",
          "<input id='mat-input' type='checkbox' style='position:absolute;opacity:0;width:1px;height:1px;top:-9999px;left:-9999px;pointer-events:none'>",
          "<div style='position:absolute;top:0;left:0;width:48px;height:48px;pointer-events:all;z-index:10'></div>",
          "<span>Material CB</span>",
        "</div>",
        // -- ARIA-only checkbox (no native input) --
        "<div id='aria' role='checkbox' aria-checked='false' tabindex='0'>ARIA CB</div>",
        "<script>",
          "document.getElementById('aria').addEventListener('click',function(){",
            "var c=this.getAttribute('aria-checked')==='true';",
            "this.setAttribute('aria-checked',String(!c));",
          "});",
        "</script>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // ---- Native checkbox (sanity baseline) ----
    let resp = execute_command(
        &json!({ "id": "10", "action": "ischecked", "selector": "#native" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], false);

    let resp = execute_command(
        &json!({ "id": "11", "action": "check", "selector": "#native" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "12", "action": "ischecked", "selector": "#native" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], true, "native check failed");

    // ---- Material checkbox (hidden input + overlay) ----
    // ischecked on the wrapper should detect the nested hidden input's state
    let resp = execute_command(
        &json!({ "id": "20", "action": "ischecked", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], false);

    let resp = execute_command(
        &json!({ "id": "21", "action": "check", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "22", "action": "ischecked", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["checked"],
        true,
        "Material checkbox should be checked after check action (#832)"
    );

    // Idempotency: check again should be a no-op
    let resp = execute_command(
        &json!({ "id": "23", "action": "check", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "24", "action": "ischecked", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["checked"],
        true,
        "Material checkbox should stay checked on redundant check"
    );

    // Uncheck
    let resp = execute_command(
        &json!({ "id": "25", "action": "uncheck", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "26", "action": "ischecked", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["checked"],
        false,
        "Material checkbox should be unchecked after uncheck action"
    );

    // ---- ARIA-only checkbox ----
    let resp = execute_command(
        &json!({ "id": "30", "action": "ischecked", "selector": "#aria" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], false);

    let resp = execute_command(
        &json!({ "id": "31", "action": "check", "selector": "#aria" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "32", "action": "ischecked", "selector": "#aria" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["checked"],
        true,
        "ARIA checkbox should be checked after check action"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Issue #841 – snapshot -C and screenshot --annotate must not hang over WSS
// (PS: -C is deprecated, cursor-interactive elements are referred by default now)
// ---------------------------------------------------------------------------

/// Verifies that `snapshot` detects elements with cursor:pointer / onclick / tabindex,
/// produces the correct v0.19.0-compatible output format, deduplicates against the ARIA
/// tree, and completes in bounded time (no sequential CDP round-trip explosion).
#[tokio::test]
#[ignore]
async fn e2e_snapshot_cursor_interactive() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Page with:
    //  - <button> and <a> (standard interactive – ARIA tree)
    //  - <div cursor:pointer onclick> (clickable – cursor section)
    //  - <div tabindex=0> (focusable – cursor section)
    //  - <span cursor:pointer> (clickable – cursor section)
    //  - <span cursor:pointer> child of <div cursor:pointer> (inherited – skip)
    let html = concat!(
        "<html><body>",
        "<a href='#'>Link</a>",
        "<button>Btn</button>",
        "<div style='cursor:pointer' onclick='x()'>ClickDiv</div>",
        "<div tabindex='0'>FocusDiv</div>",
        "<span style='cursor:pointer'>PointerSpan</span>",
        "<div style='cursor:pointer'><span>InheritChild</span></div>",
        "</body></html>",
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "setcontent", "html": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // snapshot -i: interactive tree
    let start = std::time::Instant::now();
    let resp = execute_command(
        &json!({ "id": "3", "action": "snapshot", "interactive": true }),
        &mut state,
    )
    .await;
    let elapsed = start.elapsed();
    assert_success(&resp);

    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();

    // v0.19.0 output format: role + hints
    assert!(
        snapshot.contains("clickable") && snapshot.contains("[cursor:pointer"),
        "Expected v0.19.0-format cursor output with hints:\n{}",
        snapshot,
    );

    // Role differentiation: tabindex-only → focusable
    assert!(
        snapshot.contains("focusable") && snapshot.contains("[tabindex]"),
        "Expected focusable role for tabindex-only element:\n{}",
        snapshot,
    );

    // Text dedup: "Link" and "Btn" are in the ARIA tree, so must NOT suffix
    // with cursor-interactive info. Verify line by line.
    for line in snapshot.lines() {
        assert!(
            !(line.contains("\"Link\"")
                && (line.contains("clickable")
                    || line.contains("focusable")
                    || line.contains("editable"))),
            "Standard <a> element should not have cursor-interactive info:\n{}",
            line
        );
        assert!(
            !(line.contains("\"Btn\"")
                && (line.contains("clickable")
                    || line.contains("focusable")
                    || line.contains("editable"))),
            "Standard <button> element should not have cursor-interactive info:\n{}",
            line
        );
    }

    // Must complete quickly (< 5s), not hit the 30s CDP timeout
    assert!(
        elapsed.as_secs() < 5,
        "snapshot took {:?}, expected < 5s (Issue #841 regression)",
        elapsed,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Verifies that `screenshot --annotate` completes in bounded time even with
/// many interactive elements. Guards against the sequential CDP round-trip
/// regression that caused hangs over high-latency WSS (Issue #841).
#[tokio::test]
#[ignore]
async fn e2e_screenshot_annotate_many_elements() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // 50 buttons: old sequential code would do 50×2×200ms ≈ 20s over WSS.
    let mut html = String::from("<html><body>");
    for i in 1..=50 {
        html.push_str(&format!("<button>Button {}</button>", i));
    }
    html.push_str("</body></html>");

    let resp = execute_command(
        &json!({ "id": "2", "action": "setcontent", "html": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let start = std::time::Instant::now();
    let resp = execute_command(
        &json!({ "id": "3", "action": "screenshot", "annotate": true }),
        &mut state,
    )
    .await;
    let elapsed = start.elapsed();
    assert_success(&resp);

    let annotations = get_data(&resp)["annotations"]
        .as_array()
        .expect("Annotated screenshot should return annotations");

    assert!(
        annotations.len() >= 50,
        "Expected at least 50 annotations, got {}",
        annotations.len(),
    );

    // Must complete quickly (< 10s), not hit the 30s CDP timeout
    assert!(
        elapsed.as_secs() < 10,
        "screenshot --annotate with 50 elements took {:?}, expected < 10s (Issue #841)",
        elapsed,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Verifies `snapshot` with many cursor-interactive elements completes in
/// bounded time. Direct regression test for Issue #841's root cause: N×2
/// sequential CDP round-trips per cursor-interactive element.
#[tokio::test]
#[ignore]
async fn e2e_snapshot_cursor_many_elements() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // 100 cursor-interactive divs: old code = 200 sequential CDP calls,
    // at 200ms WSS latency = 40s timeout. New code must finish in seconds.
    let mut html = String::from("<html><body>");
    for i in 1..=100 {
        html.push_str(&format!(
            "<div style='cursor:pointer' onclick='x()'>Item {}</div>",
            i,
        ));
    }
    html.push_str("</body></html>");

    let resp = execute_command(
        &json!({ "id": "2", "action": "setcontent", "html": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let start = std::time::Instant::now();
    let resp = execute_command(
        &json!({ "id": "3", "action": "snapshot", "interactive": true }),
        &mut state,
    )
    .await;
    let elapsed = start.elapsed();
    assert_success(&resp);

    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();

    // All 100 items should appear
    assert!(
        snapshot.contains("Item 1") && snapshot.contains("Item 100"),
        "Expected all 100 cursor-interactive items in output",
    );

    // All should have v0.19.0-format hints
    assert!(
        snapshot.contains("[cursor:pointer, onclick]"),
        "Expected v0.19.0-format hints",
    );

    // Must complete quickly
    assert!(
        elapsed.as_secs() < 10,
        "snapshot with 100 cursor elements took {:?}, expected < 10s (Issue #841)",
        elapsed,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Test that a selector-scoped snapshot of a web component includes the
/// content of its shadow root.
#[tokio::test]
#[ignore]
async fn e2e_snapshot_selector_includes_shadow_root() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html =
        "data:text/html,<my-card><span>Slotted</span></my-card><button>Outside</button><script>\
        customElements.define('my-card', class extends HTMLElement { constructor() { \
        super(); this.attachShadow({ mode: 'open' }).innerHTML = \
        '<button>Inside shadow</button><slot></slot>'; } });</script>";

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "snapshot", "selector": "my-card" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();

    assert!(
        snapshot.contains("button \"Inside shadow\""),
        "Snapshot should contain the shadow root button: {}",
        snapshot
    );
    assert!(
        snapshot.contains("Slotted"),
        "Snapshot should contain the slotted text: {}",
        snapshot
    );
    assert!(
        !snapshot.contains("Outside"),
        "Snapshot should not contain content outside the selector: {}",
        snapshot
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Test that InlineTextBox nodes are filtered from snapshot output while preserving
/// the actual text content from parent elements.
#[tokio::test]
#[ignore]
async fn e2e_snapshot_continuous_static_text() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Simple HTML with text content that would generate InlineTextBox nodes and sperate to multiple StaticText nodes
    let html =
        "data:text/html,<html><body><div><span>Hello</span> <span>World</span></div></body></html>";

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Take snapshot to capture full output and verify InlineTextBox filtering and StaticText aggregation
    let start = std::time::Instant::now();
    let resp = execute_command(&json!({ "id": "3", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let elapsed = start.elapsed();

    let snapshot_output = get_data(&resp)["snapshot"].as_str().unwrap();

    // Verify that InlineTextBox does not appear in the output
    assert!(
        !snapshot_output.contains("InlineTextBox"),
        "Snapshot output should not contain InlineTextBox: {}",
        snapshot_output
    );

    // Verify that the actual text content is preserved
    assert!(
        snapshot_output.contains("Hello World"),
        "Snapshot should contain 'Hello World': {}",
        snapshot_output
    );

    // Must complete quickly
    assert!(
        elapsed.as_secs() < 5,
        "snapshot with InlineTextBox filtering took {:?}, expected < 5s",
        elapsed,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Test that a selector-scoped snapshot renders each element once when plain
/// wrapper elements (ignored in the AX tree) sit between the matched element
/// and its descendants.
#[tokio::test]
#[ignore]
async fn e2e_snapshot_selector_no_duplicates() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = "data:text/html,<main><div><div><button>Save</button></div></div>\
        <select><option>Small</option><option>Large</option></select></main>\
        <footer><button>Outside</button></footer>";

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "snapshot", "selector": "main" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();

    for name in ["button \"Save\"", "option \"Small\"", "option \"Large\""] {
        assert_eq!(
            snapshot.matches(name).count(),
            1,
            "{} should appear once: {}",
            name,
            snapshot
        );
    }
    assert!(
        !snapshot.contains("Outside"),
        "Snapshot should not contain content outside the selector: {}",
        snapshot
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Helper: tiny HTTP server that echoes request headers as JSON
// ---------------------------------------------------------------------------

/// Starts a TCP listener on localhost:0 and spawns a task that accepts
/// connections, reads the HTTP request, and responds with a JSON body
/// containing all received request headers. Returns the server's base URL.
async fn start_link_fixture_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/", listener.local_addr().unwrap());

    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]);
            let body = if request.starts_with("GET /next ") {
                "<!doctype html><title>Next</title><h1>Next page</h1>"
            } else {
                "<!doctype html><title>Example Domain</title><h1>Example Domain</h1>\
                 <a href=\"/next\">Next page</a>"
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });

    (base_url, handle)
}

async fn start_echo_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let base_url = format!("http://127.0.0.1:{}", port);

    let handle = tokio::spawn(async move {
        // Serve up to 20 requests then exit (enough for all tests).
        for _ in 0..20 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);

                // Parse headers from the HTTP request.
                let mut headers = serde_json::Map::new();
                for line in request.lines().skip(1) {
                    if line.is_empty() {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(": ") {
                        headers.insert(key.to_string(), Value::String(value.to_string()));
                    }
                }

                let body = serde_json::to_string(&json!({ "headers": headers })).unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                     Access-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\
                     Connection: close\r\n\r\n{}",
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    (base_url, handle)
}

async fn start_webmcp_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let request = String::from_utf8_lossy(&buffer);
                let body = if request.starts_with("GET /frame.html ") {
                    native_test_fixture_html("webmcp_frame_probe")
                        .replace("__PORT__", &port.to_string())
                } else if request.starts_with("GET /context.html ") {
                    native_test_fixture_html("webmcp_context_probe").to_string()
                } else if request.starts_with("GET /empty.html ") {
                    "<!doctype html><title>No page tools</title>".to_string()
                } else if request.starts_with("GET /delayed.html ") {
                    native_test_fixture_html("webmcp_delayed_probe").to_string()
                } else {
                    native_test_fixture_html("webmcp_probe").replace("__PORT__", &port.to_string())
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), handle)
}

/// Starts a tiny cookie-gated app that behaves like a Next dev target with
/// cookie-backed login state.
async fn start_cookie_login_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let base_url = format!("http://127.0.0.1:{}", port);

    let handle = tokio::spawn(async move {
        for _ in 0..100 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };

            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let request_line = request.lines().next().unwrap_or_default();
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");
                let has_auth_cookie = request.lines().any(|line| {
                    line.to_ascii_lowercase().starts_with("cookie:")
                        && line.contains("next_dev_loop_auth=1")
                });

                let mut headers = vec!["Content-Type: text/html".to_string()];
                let body = if path.starts_with("/login") {
                    headers.push(
                        "Set-Cookie: next_dev_loop_auth=1; Path=/; Max-Age=3600; SameSite=Lax"
                            .to_string(),
                    );
                    "<!doctype html><title>Logged in</title><main>Login complete</main>".to_string()
                } else if has_auth_cookie {
                    "<!doctype html><title>Home</title><main>Welcome back</main>".to_string()
                } else {
                    "<!doctype html><title>Home</title><main>Please sign in</main>".to_string()
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\n{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    headers.join("\r\n"),
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    (base_url, handle)
}

/// Starts a tiny HTTP server that serves a delayed-render login form.
///
/// The page continuously fetches `/ping` so `networkidle` is hard to reach,
/// while the login form itself appears after `render_delay_ms`.
async fn start_delayed_login_server(
    render_delay_ms: u64,
    ping_interval_ms: u64,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let base_url = format!("http://127.0.0.1:{}", port);

    let handle = tokio::spawn(async move {
        // Serve enough requests for navigation + many background /ping calls.
        for _ in 0..1000 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };

            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let request_line = request.lines().next().unwrap_or_default();
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");

                let (status, content_type, body) = if path.starts_with("/ping") {
                    ("204 No Content", "text/plain", String::new())
                } else {
                    let html = format!(
                        r#"<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Delayed Login</title></head>
  <body>
    <input id="search" type="text" name="search" />
    <div id="root">loading...</div>
    <script>
      setInterval(() => {{
        fetch('/ping?ts=' + Date.now()).catch(() => {{}});
      }}, {ping_interval_ms});

      setTimeout(() => {{
        const root = document.getElementById('root');
        root.innerHTML = `
          <form id="login-form">
            <input type="email" name="email" />
            <input type="password" name="password" />
            <button type="submit">Sign in</button>
          </form>
        `;
        document.getElementById('login-form').addEventListener('submit', function(e) {{
          e.preventDefault();
          e.stopPropagation();
          window.__submitted = true;
        }});
      }}, {render_delay_ms});
    </script>
  </body>
</html>"#,
                    );
                    ("200 OK", "text/html", html)
                };

                let response = format!(
                    "HTTP/1.1 {}\r\nContent-Type: {}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    content_type,
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    (base_url, handle)
}

/// Starts a stateful login page whose form appears only after an in-page
/// action. The counter covers top-level documents so tests can prove that
/// no-navigation login did not reload or replace the page.
/// Answers each request with what `route` says for its method and path: a status, extra header lines and a body.
async fn start_routed_server(route: fn(&str, &str) -> (u16, String, String)) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut seen = Vec::new();
                let mut buf = vec![0u8; 65536];
                let head_end = loop {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    seen.extend_from_slice(&buf[..n]);
                    if let Some(i) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&seen[..head_end]).to_string();
                let length: usize = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                    .unwrap_or(0);
                while seen.len() < head_end + length {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    seen.extend_from_slice(&buf[..n]);
                }
                let mut first = head.lines().next().unwrap_or("").split_whitespace();
                let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or("/"));
                let (status, headers, body) = route(method, path);
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (base_url, handle)
}

/// What a walk's log holds once the session closes, which writes everything held back.
async fn walk_after_close(state: &mut DaemonState, dir: &std::path::Path) -> Vec<Value> {
    assert_success(&execute_command(&json!({ "id": "close", "action": "close" }), state).await);
    let log = std::fs::read_to_string(dir.join(format!("{}.jsonl", state.session_id))).unwrap_or_default();
    log.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// The exchanges of a capture log, by the end of their request's address.
fn exchange<'a>(lines: &'a [Value], path: &str) -> Option<&'a Value> {
    lines.iter().find(|l| {
        l["type"] == "exchange" && l["entry"]["request"]["url"].as_str().is_some_and(|u| u.ends_with(path))
    })
}

fn header_says(entry: &Value, side: &str, name: &str) -> String {
    entry["entry"][side]["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .filter_map(|h| h["value"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn walk_route(method: &str, path: &str) -> (u16, String, String) {
    let page = "<!doctype html><title>t</title><link rel=icon href='data:,'><h1>page</h1>".to_string();
    match (method, path) {
        ("GET", "/signin") => (302, "Location: /second\r\nSet-Cookie: first=one; Path=/\r\n".into(), String::new()),
        ("GET", "/second") => (302, "Location: /landed\r\nSet-Cookie: second=two; Path=/\r\n".into(), String::new()),
        ("GET", "/landed") => (200, "Set-Cookie: landed=three; Path=/\r\n".into(), page),
        ("POST", "/held-back-blob") => (200, String::new(), "{}".into()),
        ("GET", "/frame") => (200, String::new(), "<script>setTimeout(() => fetch('/from-the-frame'), 1000)</script>".into()),
        _ => (200, String::new(), page),
    }
}

fn session_route(_method: &str, path: &str) -> (u16, String, String) {
    let page = "<!doctype html><title>t</title><link rel=icon href='data:,'><script>\
        localStorage.setItem('authState', 'St0rageSessionToken55'); window.appState = 'the page';\
        document.title = document.cookie.indexOf('ScriptReadableSession77') >= 0 ? 'sees its cookie' : 'blind';\
        </script><p id=p>app</p><a id=js href=\"javascript:document.title='ran'\">run</a>\
        <a id=noop href=\"javascript:void(0)\" onclick=\"document.title='noop clicked'\">noop</a>\
        <form id=f action=\"javascript:document.title='submitted'\"><input id=q name=q><button id=go>go</button></form>\
        <form id=f2 action=\"/ok\"><input type=submit id=s formaction=\"javascript:document.title='label'\"></form><label id=l for=s>by label</label>\
        <label id=l2><span id=inl>inside a label</span><input type=image form=f2 formaction=\"javascript:document.title='nested'\"></label>\
        <form id=f3 action=\"javascript:document.title='form attribute'\"></form><button id=b3 form=f3>owned from outside</button>\
        <form id=f4 action=\"/ok\"><input id=q4 name=q4><button formaction=\"javascript:document.title='implicit'\">default</button></form>\
        <img id=m usemap=\"#mp\" width=10 height=10 src=\"data:image/gif;base64,R0lGODlhAQABAAAAACw=\"><map name=mp><area href=\"javascript:document.title='map'\" shape=rect coords=\"0,0,10,10\"></map>\
        <details><summary id=sm>more</summary>details</details>\
        <a id=ak accesskey=k href=\"javascript:document.title='access key'\">by access key</a><input id=plain>"
        .to_string();
    match path {
        "/" => (200, "Set-Cookie: sid=HttpOnlySession66; Path=/; HttpOnly\r\nSet-Cookie: pref=ScriptReadableSession77; Path=/\r\n".into(), page),
        _ => (200, String::new(), page),
    }
}

/// A caller's script runs in a world of its own, where the site's session reads as `{session}` before the script can
/// change it: `evaluate`, a wait on a function and a handle all read the stand-in, a frame the script makes does too,
/// writes and what can't be a stand-in are refused, and the page's own code still sees its cookie and its globals.
#[tokio::test]
#[ignore]
async fn e2e_a_callers_script_reads_the_session_as_a_stand_in() {
    let (base_url, server) = start_routed_server(session_route).await;
    let mut state = DaemonState::new();
    for command in [json!({ "id": "launch", "action": "launch", "headless": true }), json!({ "id": "open", "action": "navigate", "url": format!("{base_url}/") })] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let said = |r: &Value| r["data"]["result"].clone();
    for (script, want) in [
        ("document.title", json!("sees its cookie")),
        // Another server on this machine may have left a cookie on 127.0.0.1 (a cookie isn't kept by port): the page's
        // own is read out of the rest.
        ("PREF(document.cookie)", json!("pref={session}")),
        ("btoa(PREF(document.cookie))", json!("cHJlZj17c2Vzc2lvbn0=")),
        ("[...PREF(document.cookie)].reverse().join('')", json!("}noisses{=ferp")),
        ("(() => { const f = document.createElement('iframe'); document.body.appendChild(f); return [PREF(f.contentWindow.document.cookie), PREF(window[window.length - 1].document.cookie)].join(' | '); })()", json!("pref={session} | pref={session}")),
        ("document.cookie.indexOf('Session') < 0 && document.cookie.indexOf('{session}') >= 0", json!(true)),
        ("localStorage.getItem('authState') + ' ' + JSON.stringify(localStorage)", json!("{session} {\"authState\":\"{session}\"}")),
        ("typeof window.appState", json!("undefined")),
    ] {
        let script = script.replace("PREF(", "((c) => c.split('; ').filter((p) => p.startsWith('pref=')).join())(");
        let resp = execute_command(&json!({ "id": "e", "action": "evaluate", "script": script }), &mut state).await;
        assert_success(&resp);
        assert_eq!(said(&resp), want, "{script}");
    }
    for script in ["document.cookie = 'pref=x'", "localStorage.setItem('authState', 'x')", "indexedDB", "document.createElement('script')", "document.body.innerHTML = '<img src=x onerror=1>'", "typeof caches", "indexedDB.open('x')", "new Worker('data:,')", "new SharedWorker('data:,')", "navigator.serviceWorker.register('/sw.js')", "cookieStore.get('pref')", "navigator.storage.estimate()", "document.body.setAttribute('onclick', '1')"] {
        let resp = execute_command(&json!({ "id": "r", "action": "evaluate", "script": script }), &mut state).await;
        assert!(resp.to_string().contains("isn't open to an agent's script"), "{script}: {resp}");
    }
    // No script address is written from this world, by any property or attribute, however it is spelled.
    for script in [
        "(() => { const a = document.createElementNS('http://www.w3.org/2000/svg', 'a'); a.href.baseVal = 'javascript:document.title=1'; return 1; })()",
        "(() => { const a = document.createElementNS('http://www.w3.org/2000/svg', 'a'); a.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', ' \\u0001JaVa\\tScRiPt:document.title=1'); return 1; })()",
        "(() => { const m = document.createElement('meta'); m.content = '0;url=javascript:document.title=1'; return 1; })()",
        "(() => { const v = document.createElementNS('http://www.w3.org/2000/svg', 'animate'); v.setAttribute('values', 'x;javascript:document.title=1'); return 1; })()",
        "(() => { document.getElementById('f').action = 'javascript:document.title=1'; return 1; })()",
        "(() => { const a = document.createElement('a'); a.setAttribute('href', { toString: (() => { let n = 0; return () => n++ ? 'https://ok.example/' : 'javascript:document.title=1'; })() }); return 1; })()",
        // What the page holds, activated by the script itself.
        "document.getElementById('js').click()",
        "document.getElementById('js').dispatchEvent(new MouseEvent('click', { bubbles: true }))",
        "document.getElementById('f').requestSubmit()",
        "document.getElementById('f').submit()",
        // Activation the platform forwards: a label to its control, a span inside a label, a control to the form its
        // `form` attribute names from outside, an image to its map's areas, Enter in a field to its form's default button.
        "document.getElementById('l').click()",
        "document.getElementById('l').dispatchEvent(new MouseEvent('click', { bubbles: true }))",
        "document.getElementById('inl').click()",
        "document.getElementById('b3').click()",
        "document.getElementById('m').click()",
        "document.getElementById('q4').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))",
        "document.getElementById('f4').requestSubmit()",
        // A pattern's own replace, swapped by the script, reaches nothing the world reads an address with.
        "(() => { RegExp.prototype[Symbol.replace] = () => 'https://ok.example/'; String.prototype.replace = () => 'https://ok.example/'; document.createElement('a').href = 'javascript:document.title=1'; })()",
        "(() => { Array.prototype.shift = () => undefined; Array.prototype.indexOf = () => 0; document.getElementById('l').click(); })()",
        "typeof navigation",
        // Markup for a frame, and the page's own scripts: no code of the agent's is parsed into the page's world.
        "document.createElement('iframe').srcdoc = '<script>document.title = 1</script>'",
        "document.createElement('div').append(document.createElement('div'), document.querySelector('script'))",
    ] {
        let resp = execute_command(&json!({ "id": "a", "action": "evaluate", "script": script }), &mut state).await;
        assert!(resp.to_string().contains("isn't open to an agent's script"), "{script}: {resp}");
    }
    // A text that changes between reads is read once, and that text is what is written.
    let resp = execute_command(&json!({ "id": "b", "action": "evaluate", "script": "(() => { const b = document.createElement('base'); b.href = { toString: (() => { let n = 0; return () => n++ ? 'javascript:document.title=1' : 'https://ok.example/'; })() }; return b.getAttribute('href'); })()" }), &mut state).await;
    assert_eq!(said(&resp), json!("https://ok.example/"), "{resp}");
    // The page's own world is poisoned before the browser's commands: the guard reads in a world of its own, so what
    // the page replaced there changes nothing it sees.
    let poison = "(() => { Array.prototype.filter = () => []; Array.prototype.map = () => []; Array.prototype.includes = () => false; \
        Array.prototype.indexOf = () => -1; Array.prototype.push = () => 0; String.prototype.indexOf = () => -1; String.prototype.startsWith = () => false; \
        String.prototype.toLowerCase = () => 'https://ok.example/'; String.prototype.replace = () => ''; JSON.stringify = () => '[]'; \
        Element.prototype.getAttribute = () => null; Element.prototype.closest = () => null; \
        Object.defineProperty(Document.prototype, 'activeElement', { get() { return document.body; } }); return 1; })()";
    let resp = execute_command(&json!({ "id": "poison", "action": "page_evaluate", "script": poison }), &mut state).await;
    assert_success(&resp);
    // The browser's own commands never activate a script address the page holds either; a literal no-op is clicked.
    for (command, refused) in [
        (json!({ "id": "c1", "action": "click", "selector": "#js" }), true),
        (json!({ "id": "c2", "action": "click", "selector": "#go" }), true),
        (json!({ "id": "c3", "action": "type", "selector": "#q", "text": "x\n" }), true),
        (json!({ "id": "c4", "action": "focus", "selector": "#js" }), false),
        (json!({ "id": "c5", "action": "press", "key": "Enter" }), true),
        (json!({ "id": "c6", "action": "click", "selector": "#noop" }), false),
        (json!({ "id": "c7", "action": "click", "selector": "#l" }), true),
        (json!({ "id": "c8", "action": "click", "selector": "#inl" }), true),
        (json!({ "id": "c9", "action": "click", "selector": "#b3" }), true),
        (json!({ "id": "c10", "action": "click", "selector": "#m" }), true),
        (json!({ "id": "c11", "action": "type", "selector": "#q4", "text": "x\n" }), true),
        (json!({ "id": "c12", "action": "focus", "selector": "#q4" }), false),
        (json!({ "id": "c13", "action": "press", "key": "Enter" }), true),
        (json!({ "id": "c14", "action": "click", "selector": "#sm" }), false),
        // A chord a platform reads as an access key may activate any element that has one, whatever has the focus.
        (json!({ "id": "c15", "action": "focus", "selector": "#plain" }), false),
        (json!({ "id": "c16", "action": "press", "key": "Alt+k" }), true),
        (json!({ "id": "c17", "action": "press", "key": "Control+Alt+k" }), true),
        (json!({ "id": "c18", "action": "press", "key": "k" }), false),
        // `find` clicks when it names no action: held to the same guard.
        (json!({ "id": "c19", "action": "getbytext", "text": "run", "subaction": "click", "exact": true }), true),
    ] {
        let resp = execute_command(&command, &mut state).await;
        assert_eq!(resp.to_string().contains("script address"), refused, "{command}: {resp}");
    }
    let resp = execute_command(&json!({ "id": "t", "action": "page_evaluate", "script": "document.title" }), &mut state).await;
    assert_eq!(said(&resp), json!("noop clicked"), "only the no-op ran, by the page's own handler");
    // A wait on a function, and a function waited for, read the same world.
    let resp = execute_command(&json!({ "id": "w", "action": "wait", "function": "document.cookie.indexOf('pref={session}') >= 0", "timeout": 2000 }), &mut state).await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "w2", "action": "waitforfunction", "expression": "document.cookie.indexOf('ScriptReadableSession77') < 0 && document.cookie.indexOf('pref={session}') >= 0", "timeout": 2000 }), &mut state).await;
    assert_success(&resp);
    assert_eq!(said(&resp), json!(true));
    // The page's own world keeps the real values.
    // (Read a character at a time: the page's own `String.prototype.indexOf` was poisoned above.)
    let resp = execute_command(&json!({ "id": "p", "action": "page_evaluate", "script": "(() => { const c = document.cookie, w = 'pref=ScriptReadableSession77'; let has = false; for (let i = 0; i + w.length <= c.length; i++) { let ok = true; for (let j = 0; j < w.length; j++) if (c[i + j] !== w[j]) ok = false; if (ok) has = true; } return has && window.appState === 'the page'; })()" }), &mut state).await;
    assert_eq!(said(&resp), json!(true));
    let _ = execute_command(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

fn guard_route(_method: &str, path: &str) -> (u16, String, String) {
    let head = "<!doctype html><link rel=icon href='data:,'>";
    let body = match path {
        // Access keys two frames deep, in this page's own process.
        "/frames" => "<title>top</title><input id=plain><iframe id=f1 src=/inner1></iframe>".to_string(),
        "/inner1" => "<title>inner1</title><iframe id=f2 src=/inner2></iframe>".to_string(),
        "/inner2" => "<title>inner2</title><a accesskey=k href=\"javascript:document.title='ran in a frame'\">deep</a>".to_string(),
        // An access key inside a closed shadow root.
        "/shadow" => "<title>shadow</title><input id=plain><div id=host></div><script>\
            const r = document.getElementById('host').attachShadow({ mode: 'closed' });\
            r.innerHTML = \"<a accesskey=k href=\\\"javascript:document.title='ran in a shadow'\\\">hidden</a>\";</script>"
            .to_string(),
        // An access key in a frame of another site (another process, under site isolation).
        "/cross" => "<title>cross</title><input id=plain><script>const f = document.createElement('iframe');\
            f.src = location.href.replace('127.0.0.1', 'localhost').replace('/cross', '/xframe'); document.body.append(f);</script>"
            .to_string(),
        "/xframe" => "<title>xframe</title><a accesskey=k href=\"javascript:document.title='ran cross-site'\">far</a>".to_string(),
        // A benign access key: the chord goes through.
        "/benign" => "<title>benign</title><input id=plain><a accesskey=k href=\"#reached\">ok</a>".to_string(),
        // The race: a button whose form owner the agent's own timer swaps.
        "/race" => "<title>race</title><form id=safe action=\"javascript:void(0)\"><button id=b3>in a form</button></form>\
            <form id=jsform action=\"javascript:document.title='race won'\"></form><button id=b form=safe>go</button>\
            <form id=safe2 action=\"javascript:void(0)\"><button id=b2>moved</button></form>\
            <input type=submit id=s form=jsform formaction=\"javascript:document.title='label race won'\"><label id=l2>label</label>\
            <a id=jl href=\"javascript:document.title='link race won'\">a script link</a><span id=b4>outside any link</span>"
            .to_string(),
        // The page's own handler rewrites the link it was clicked on.
        "/pagerace" => "<title>pagerace</title><a id=pl href=\"#benign\">x</a><script>\
            document.getElementById('pl').addEventListener('click', () => { document.getElementById('pl').href = \"javascript:document.title='page rewrote it'\"; });</script>"
            .to_string(),
        // A page that evaluates what it is sent: its own code.
        "/gadget" => "<title>gadget</title><script>window.addEventListener('message', (e) => {\
            if (typeof e.data === 'string' && e.data.startsWith('code:')) eval(e.data.slice(5)); });</script>"
            .to_string(),
        _ => "<title>t</title>".to_string(),
    };
    let cookie = if path == "/gadget" || path == "/race" { "Set-Cookie: pref=ScriptReadableSession77; Path=/\r\nSet-Cookie: sid=HttpOnlySession66; Path=/; HttpOnly\r\n" } else { "" };
    (200, cookie.into(), format!("{head}{body}"))
}

async fn open_page(state: &mut DaemonState, url: &str) {
    assert_success(&execute_command(&json!({ "id": "open", "action": "navigate", "url": url }), state).await);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
}

async fn page_title(state: &mut DaemonState) -> Value {
    execute_command(&json!({ "id": "t", "action": "page_evaluate", "script": "document.title" }), state).await["data"]["result"].clone()
}

/// An access-key chord never activates a script address, wherever the element with the key is: two frames deep in this
/// page's process, inside a closed shadow root, or in a frame of another site; a benign access key goes through. The
/// chords are Alt and Control+Alt (on macOS the platform's own is Control+Option; the guard reads any chord with Alt or
/// Control).
#[tokio::test]
#[ignore]
async fn e2e_an_access_key_reaches_no_script_address_in_any_frame() {
    let (base_url, server) = start_routed_server(guard_route).await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    for page in ["/frames", "/shadow", "/cross"] {
        open_page(&mut state, &format!("{base_url}{page}")).await;
        let frames = execute_command(&json!({ "id": "fr", "action": "page_evaluate", "script": "window.frames.length" }), &mut state).await;
        eprintln!("{page}: frames {}, iframe sessions {}", frames["data"]["result"], state.iframe_sessions.len());
        assert_success(&execute_command(&json!({ "id": "f", "action": "focus", "selector": "#plain" }), &mut state).await);
        for chord in ["Alt+k", "Control+Alt+k"] {
            let resp = execute_command(&json!({ "id": "p", "action": "press", "key": chord }), &mut state).await;
            assert!(resp.to_string().contains("script address") || resp.to_string().contains("couldn't be told"), "{page} {chord}: {resp}");
        }
        let title = page_title(&mut state).await;
        assert!(!title.to_string().contains("ran"), "{page}: {title}");
    }
    open_page(&mut state, &format!("{base_url}/benign")).await;
    assert_success(&execute_command(&json!({ "id": "f", "action": "focus", "selector": "#plain" }), &mut state).await);
    for chord in ["Alt+k", "Control+Alt+k"] {
        let resp = execute_command(&json!({ "id": "p", "action": "press", "key": chord }), &mut state).await;
        assert_success(&resp);
    }
    let _ = execute_command(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

/// The race between the guard's read and the dispatch, and the dispatch itself. The agent's own script may not change
/// where an activation goes (a control's `form`, a label's `for`, `type`) nor stop an event; what it still may do is
/// move nodes. So its timer moves a button between a no-op form and a script-action one, and a script-`formaction`
/// submit into and out of a label, while the browser clicks again and again; and its listener on a button, running
/// during the click's dispatch, moves the button into the script-action form before the default action. None of it
/// may run a script address: the guard's check at the moment of activation reads the click and the submit as they
/// happen. And a page's own click handler that rewrites its link to a `javascript:` address during the click: the
/// record says what this browser then does (SECURITY.md, limit 1).
#[tokio::test]
#[ignore]
async fn e2e_the_race_between_the_guard_and_the_click() {
    let (base_url, server) = start_routed_server(guard_route).await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    open_page(&mut state, &format!("{base_url}/race")).await;
    // Where an activation goes is not the agent's to change, nor may it hide an event.
    for script in [
        "document.getElementById('b').setAttribute('form', 'jsform')",
        "document.getElementById('b').removeAttribute('form')",
        "document.getElementById('l2').htmlFor = 's'",
        "document.getElementById('b3').type = 'button'",
        "new Event('click').stopImmediatePropagation()",
        "new Event('click').stopPropagation()",
        "new Event('click').cancelBubble = true",
    ] {
        let resp = execute_command(&json!({ "id": "w", "action": "evaluate", "script": script }), &mut state).await;
        assert!(resp.to_string().contains("isn't open to an agent's script"), "{script}: {resp}");
    }
    // Moves on a timer, while the browser clicks.
    let arm = "(() => { const b2 = document.getElementById('b2'), s = document.getElementById('s'), l2 = document.getElementById('l2'); \
        const safe2 = document.getElementById('safe2'), js = document.getElementById('jsform'); \
        setInterval(() => { (b2.parentNode === safe2 ? js : safe2).append(b2); if (s.parentNode === l2) document.body.append(s); else l2.append(s); }, 0); return 1; })()";
    assert_success(&execute_command(&json!({ "id": "arm", "action": "evaluate", "script": arm }), &mut state).await);
    let (mut before, mut at_activation, mut clicked) = (0, 0, 0);
    for i in 0..200 {
        for selector in ["#b2", "#l2"] {
            let resp = execute_command(&json!({ "id": format!("r{i}"), "action": "click", "selector": selector }), &mut state).await;
            let said = resp.to_string();
            if said.contains("at the moment of activation") { at_activation += 1 } else if said.contains("script address") { before += 1 } else if resp["success"] == json!(true) { clicked += 1 }
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let title = page_title(&mut state).await;
    eprintln!("moves on a timer: {before} refused before the click, {at_activation} refused at the moment of activation, {clicked} clicked through, title {title}");
    assert_eq!(title, json!("race"), "a move by the agent's own timer slipped a script target past the guard");
    // A move during the click's own dispatch, by the agent's listener on the button.
    let during = "(() => { const b3 = document.getElementById('b3'); b3.addEventListener('click', () => document.getElementById('jsform').append(b3)); return 1; })()";
    assert_success(&execute_command(&json!({ "id": "during", "action": "evaluate", "script": during }), &mut state).await);
    let resp = execute_command(&json!({ "id": "d", "action": "click", "selector": "#b3" }), &mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let title = page_title(&mut state).await;
    eprintln!("a move during the dispatch: command {}, title {title}", resp.get("error").cloned().unwrap_or(json!("clicked")));
    assert_eq!(title, json!("race"), "a move during the dispatch slipped a script target past the guard");
    // A move of the clicked element into a page's script link, during the dispatch.
    let into = "(() => { const b4 = document.getElementById('b4'); b4.addEventListener('click', () => document.getElementById('jl').append(b4)); return 1; })()";
    assert_success(&execute_command(&json!({ "id": "into", "action": "evaluate", "script": into }), &mut state).await);
    let resp = execute_command(&json!({ "id": "d2", "action": "click", "selector": "#b4" }), &mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let title = page_title(&mut state).await;
    eprintln!("a move into a script link during the dispatch: command {}, title {title}", resp.get("error").cloned().unwrap_or(json!("clicked")));
    assert_eq!(title, json!("race"), "a move into a script link during the dispatch ran it");
    // The page's own handler rewrites the link during the click.
    open_page(&mut state, &format!("{base_url}/pagerace")).await;
    let resp = execute_command(&json!({ "id": "pr", "action": "click", "selector": "#pl" }), &mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let title = page_title(&mut state).await;
    let shown = execute_command(&json!({ "id": "sh", "action": "page_evaluate", "script": "location.href + ' | ' + (document.body ? document.body.innerText : '')" }), &mut state).await;
    eprintln!("the page's own rewrite during the click: command {}, title after {title}, page now {}", resp.get("error").cloned().unwrap_or(json!("clicked")), shown["data"]["result"]);
    let _ = execute_command(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

/// What the agent's world reaches at runtime beyond its setters: a `data:` frame it makes runs in an opaque origin and
/// reads nothing of the page; a page that evaluates what it is sent runs it as its own code; and a `javascript:` address
/// the agent gives the page's `location` runs in the page's world, reading what the page's script can (the
/// script-readable cookie, not the HttpOnly one).
#[tokio::test]
#[ignore]
async fn e2e_what_the_agents_world_reaches_beyond_its_setters() {
    let (base_url, server) = start_routed_server(guard_route).await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    open_page(&mut state, &format!("{base_url}/gadget")).await;
    let data = "(() => { window.addEventListener('message', (e) => { window.__heard = String(e.data); }); \
        const f = document.createElement('iframe'); \
        f.src = 'data:text/html,<script>let r; try { r = String(document.cookie); } catch (e) { r = e.name; } let p; try { p = parent.document.title; } catch (e) { p = e.name; } parent.postMessage(r + \"|\" + p, \"*\");</script>'; \
        document.body.append(f); return new Promise((ok) => setTimeout(() => ok(String(window.__heard)), 800)); })()";
    let resp = execute_command(&json!({ "id": "d", "action": "evaluate", "script": data }), &mut state).await;
    eprintln!("a data: frame the agent made says: {}", resp["data"]["result"]);
    assert_eq!(resp["data"]["result"], json!("SecurityError|SecurityError"), "{resp}");
    let resp = execute_command(&json!({ "id": "g", "action": "evaluate", "script": "window.postMessage('code:document.title = \"gadget ran: \" + btoa(document.cookie)', '*'); 1" }), &mut state).await;
    assert_success(&resp);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let gadget = page_title(&mut state).await;
    eprintln!("the page's eval gadget, sent code by postMessage: title {gadget}");
    let resp = execute_command(&json!({ "id": "l", "action": "evaluate", "script": "location.href = 'javascript:void(document.title = \"location ran: \" + document.cookie)'; 1" }), &mut state).await;
    assert_success(&resp);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let located = page_title(&mut state).await;
    eprintln!("location = javascript: from the agent's world: title {located}");
    assert!(located.to_string().contains("pref=ScriptReadableSession77") && !located.to_string().contains("HttpOnlySession66"), "{located}");
    let _ = execute_command(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

fn sinks_route(_method: &str, path: &str) -> (u16, String, String) {
    let page = "<!doctype html><title>sinks</title><link rel=icon href='data:,'>\
        <script type=text/plain id=inert></script><script id=empty></script>\
        <svg><script id=svgs type=text/plain></script></svg>\
        <template id=tpl><script>top.document.title = 'template ran: ' + document.cookie;</script></template><p id=p>sinks</p>"
        .to_string();
    let cookie = if path == "/" { "Set-Cookie: pref=ScriptReadableSession77; Path=/\r\n" } else { "" };
    (200, cookie.into(), page)
}

/// Every way the agent's world could hand markup or code to the page's own world, tried at runtime: each code writes
/// the real cookie into the page's title, which the agent's world can't do itself (it reads `{session}`), so a title
/// holding the real value is code that ran in the page's world. (The name of each, and what it did, is printed.)
#[tokio::test]
#[ignore]
async fn e2e_no_markup_or_code_sink_reaches_the_pages_world() {
    let (base_url, server) = start_routed_server(sinks_route).await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    open_page(&mut state, &format!("{base_url}/")).await;
    // No quotes: it goes inside every kind of string the probes write.
    let code = "top.document.title = String.fromCharCode(114, 97, 110, 58, 32) + document.cookie";
    let sinks: Vec<(&str, String)> = vec![
        ("iframe.srcdoc", format!("(() => {{ const f = document.createElement('iframe'); f.srcdoc = '<script>{code}</script>'; document.body.append(f); return 1; }})()")),
        ("innerHTML", format!("document.body.innerHTML += '<img src=x onerror=\"{code}\">'")),
        ("outerHTML", format!("document.getElementById('p').outerHTML = '<img src=x onerror=\"{code}\">'")),
        ("ShadowRoot.innerHTML", format!("document.getElementById('p').attachShadow({{ mode: 'open' }}).innerHTML = '<img src=x onerror=\"{code}\">'")),
        ("template.innerHTML", format!("(() => {{ const t = document.createElement('template'); t.innerHTML = '<img src=x onerror=\"{code}\">'; document.body.append(t.content.cloneNode(true)); return 1; }})()")),
        ("insertAdjacentHTML", format!("document.body.insertAdjacentHTML('beforeend', '<img src=x onerror=\"{code}\">')")),
        ("setHTMLUnsafe", format!("document.body.setHTMLUnsafe('<img src=x onerror=\"{code}\">')")),
        ("setHTML", format!("(typeof document.body.setHTML === 'function') ? (document.body.setHTML('<img src=x onerror=\"{code}\"><script>{code}</script>'), 'called') : 'absent'")),
        ("Document.parseHTMLUnsafe", format!("document.body.append(...Document.parseHTMLUnsafe('<img src=x onerror=\"{code}\">').body.childNodes)")),
        ("Document.parseHTML", format!("(typeof Document.parseHTML === 'function') ? (document.body.append(...Document.parseHTML('<img src=x onerror=\"{code}\">').body.childNodes), 'called') : 'absent'")),
        ("document.write", format!("document.write('<img src=x onerror=\"{code}\">')")),
        ("document.writeln", format!("document.writeln('<img src=x onerror=\"{code}\">')")),
        ("document.open", format!("(() => {{ const w = document.open('javascript:{code}', '', ''); return String(w); }})()")),
        ("Range.createContextualFragment", format!("document.body.append(document.createRange().createContextualFragment('<img src=x onerror=\"{code}\">'))")),
        ("DOMParser + importNode", format!("document.body.append(document.importNode(new DOMParser().parseFromString('<img src=x onerror=\"{code}\">', 'text/html').body.firstChild, true))")),
        ("createHTMLDocument + adoptNode", format!("(() => {{ const d = document.implementation.createHTMLDocument(''); d.body.innerHTML = '<img src=x onerror=\"{code}\">'; document.body.append(document.adoptNode(d.body.firstChild)); return 1; }})()")),
        ("XSLTProcessor", "new XSLTProcessor()".to_string()),
        ("execCommand insertHTML", format!("(() => {{ document.body.contentEditable = 'true'; document.body.focus(); return document.execCommand('insertHTML', false, '<img src=x onerror=\"{code}\">'); }})()")),
        ("a page's inert script: type and text, re-inserted", format!("(() => {{ const s = document.getElementById('inert'); s.type = 'text/javascript'; s.text = \"{code}\"; s.remove(); document.body.append(s); return 1; }})()")),
        ("a page's empty script: text, re-inserted", format!("(() => {{ const s = document.getElementById('empty'); s.textContent = \"{code}\"; s.remove(); document.body.append(s); return 1; }})()")),
        ("a page's empty script: src to a data: address", format!("(() => {{ const s = document.getElementById('empty'); s.src = 'data:text/javascript,' + encodeURIComponent(\"{code}\"); s.remove(); document.body.append(s); return 1; }})()")),
        ("a page's inert script: cloned", format!("(() => {{ const s = document.getElementById('inert').cloneNode(true); s.type = 'text/javascript'; s.text = \"{code}\"; document.body.append(s); return 1; }})()")),
        ("an SVG script's href", format!("(() => {{ const s = document.getElementById('svgs'); s.setAttribute('type', 'text/javascript'); s.href.baseVal = 'data:text/javascript,' + encodeURIComponent(\"{code}\"); s.remove(); document.querySelector('svg').append(s); return 1; }})()")),
        ("a page's template script, imported", "document.body.append(document.importNode(document.getElementById('tpl').content, true))".to_string()),
        ("object.data data:", format!("(() => {{ const o = document.createElement('object'); o.data = 'data:text/html,' + encodeURIComponent('<script>try {{ {code} }} catch (e) {{ }}</script>'); document.body.append(o); return 1; }})()")),
        ("embed.src data:", format!("(() => {{ const o = document.createElement('embed'); o.src = 'data:text/html,' + encodeURIComponent('<script>try {{ {code} }} catch (e) {{ }}</script>'); document.body.append(o); return 1; }})()")),
        ("iframe.src data:", format!("(() => {{ const f = document.createElement('iframe'); f.src = 'data:text/html,' + encodeURIComponent('<script>try {{ {code} }} catch (e) {{ }}</script>'); document.body.append(f); return 1; }})()")),
        ("iframe about:blank + contentDocument.write", format!("(() => {{ const f = document.createElement('iframe'); document.body.append(f); f.contentDocument.write('<script>{code}</script>'); return 1; }})()")),
        ("iframe about:blank + contentDocument innerHTML", format!("(() => {{ const f = document.createElement('iframe'); document.body.append(f); f.contentDocument.body.innerHTML = '<img src=x onerror=\"{code}\">'; return 1; }})()")),
        ("iframe about:blank + contentWindow.eval", format!("(() => {{ const f = document.createElement('iframe'); document.body.append(f); f.contentWindow.eval(\"{code}\"); return document.title; }})()")),
        ("iframe.src about:srcdoc", "(() => { const f = document.createElement('iframe'); f.src = 'about:srcdoc'; document.body.append(f); return 1; })()".to_string()),
        ("blob: address", "URL.createObjectURL(new Blob(['x'], { type: 'text/html' }))".to_string()),
        ("Worklet.addModule", format!("(typeof CSS !== 'undefined' && CSS.paintWorklet) ? CSS.paintWorklet.addModule('data:text/javascript,' + encodeURIComponent(\"{code}\")).then(() => 'added', (e) => 'failed: ' + e) : 'absent'")),
        ("import() of a data: module", "import('data:text/javascript,export default document.cookie').then((m) => 'module read: ' + m.default, (e) => 'failed: ' + e)".to_string()),
        ("setTimeout(string)", format!("setTimeout(\"{code}\", 0); 1")),
        ("Function", format!("new Function(\"{code}\")(); document.title")),
    ];
    // Allowed, each for a reason measured here: what it parses or runs can't reach the page's world with the page's
    // cookie (a sanitizer drops code; a `data:` document has an origin of its own; an `about:srcdoc` frame is empty; a
    // blank frame's `eval`, an imported module, a timer's string and `Function` run in the agent's own world). Every
    // other sink is refused outright. Not in this browser: XSLTProcessor (refused too, were it there).
    let allowed = ["setHTML", "Document.parseHTML", "object.data data:", "embed.src data:", "iframe.src data:", "iframe.src about:srcdoc", "iframe about:blank + contentWindow.eval", "import() of a data: module", "setTimeout(string)", "Function"];
    for (name, script) in sinks {
        // Each from a fresh page, with the page's own inert scripts and template in it.
        open_page(&mut state, &format!("{base_url}/")).await;
        let resp = execute_command(&json!({ "id": "s", "action": "evaluate", "script": script }), &mut state).await;
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let title = page_title(&mut state).await;
        let said = if resp["success"] == json!(true) { format!("ran, answered {}", resp["data"]["result"]) } else { format!("refused: {}", resp["error"]) };
        let leaked = title.to_string().contains("ScriptReadableSession77");
        eprintln!("SINK {name} | {said} | page title {title} | {}", if leaked { "LEAKED" } else { "held" });
        assert!(!leaked, "{name}: agent code ran in the page's world: {title}");
        if name == "XSLTProcessor" {
            assert!(resp.to_string().contains("not defined") || resp.to_string().contains("isn't open to an agent's script"), "{name}: {resp}");
        } else if !allowed.contains(&name) {
            assert!(resp.to_string().contains("isn't open to an agent's script"), "{name} is refused: {resp}");
        }
    }
    let _ = execute_command(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

/// Runtime inventory of interface setters and mutation entry points exposed to the isolated agent world.
/// Each probe attempts to create a page-world cookie leak; refusals and accepted inert operations are reported.
#[tokio::test]
#[ignore]
async fn e2e_agent_world_setter_and_mutation_fuzz() {
    let (base_url, server) = start_routed_server(sinks_route).await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({"id":"launch","action":"launch","headless":true}), &mut state).await);
    open_page(&mut state, &format!("{base_url}/")).await;
    let payload = "top.document.title='fuzz:'+document.cookie";
    let script = format!(r#"(() => {{
      const code = {payload:?}, attempts = [], accepted = [], interfaces = [];
      for (const n of Object.getOwnPropertyNames(window)) {{ try {{ if (typeof window[n] === 'function') interfaces.push(n); }} catch (_) {{}} }}
      const el = document.createElement('div');
      for (const name of interfaces) {{
        let ctor; try {{ ctor = window[name]; }} catch (_) {{ continue; }}
        let proto; try {{ proto = ctor.prototype; }} catch (_) {{ continue; }}
        if (!proto) continue;
        for (const key of Object.getOwnPropertyNames(proto)) {{
          const d = Object.getOwnPropertyDescriptor(proto, key);
          if (!d || !d.set) continue;
          attempts.push(name+'.'+key);
          try {{ el[key] = key.toLowerCase().includes('srcdoc') ? '<script>'+code+'</script>' :
            key.toLowerCase().includes('href') || key.toLowerCase().includes('src') || key.toLowerCase().includes('action') ? 'javascript:'+code :
            key.toLowerCase().includes('on') ? code : 'x'; accepted.push(name+'.'+key); }} catch (_) {{}}
        }}
      }}
      const methods = ['setAttribute','setAttributeNS','setAttributeNode','toggleAttribute','insertAdjacentElement','insertAdjacentHTML','insertAdjacentText','append','prepend','replaceWith','replaceChildren','after','before','insertBefore','appendChild','replaceChild','cloneNode','importNode','adoptNode','attachShadow','setHTMLUnsafe','setHTML','write'];
      for (const m of methods) {{ attempts.push(m); try {{
        if (m==='setAttribute') el[m]('onclick',code);
        else if (m==='setAttributeNS') el[m]('http://www.w3.org/1999/xlink','xlink:href','javascript:'+code);
        else if (m==='setAttributeNode') {{ const a=document.createAttribute('onclick'); a.value=code; el[m](a); }}
        else if (m==='insertAdjacentHTML') el[m]('beforeend','<img src=x onerror="'+code+'">');
        else if (m==='insertAdjacentText') el[m]('beforeend',code);
        else if (m==='setHTMLUnsafe') el[m]('<script>'+code+'</script>');
        else if (m==='setHTML') el[m]('<img src=x onerror="'+code+'">');
        else if (m==='write') document[m]('<script>'+code+'</script>');
        else if (m==='attachShadow') el[m]({{mode:'open'}});
        else if (m==='cloneNode') document.querySelector('#inert')[m](true);
        else if (m==='importNode') document[m](document.querySelector('#inert'),true);
        else if (m==='adoptNode') document[m](document.createElement('span'));
        else el[m](document.createElement('span'));
        accepted.push(m);
      }} catch (_) {{}} }}
      return JSON.stringify({{interfaces:interfaces.length,attempts:attempts.length,accepted}});
    }})()"#);
    let resp = execute_command(&json!({"id":"fuzz","action":"evaluate","script":script}), &mut state).await;
    assert_success(&resp);
    let fuzz: Value = serde_json::from_str(resp["data"]["result"].as_str().expect("fuzz JSON result")).unwrap();
    let accepted = fuzz["accepted"].as_array().expect("accepted operation list");
    let inventory_dir = tempfile::tempdir().unwrap();
    let inventory_path = inventory_dir.path().join("accepted-operations.json");
    std::fs::write(&inventory_path, serde_json::to_vec_pretty(accepted).unwrap()).unwrap();
    eprintln!("fuzz interfaces={} attempts={} accepted={} list={}", fuzz["interfaces"], fuzz["attempts"], accepted.len(), inventory_path.display());
    for item in accepted { eprintln!("accepted operation: {}", item.as_str().unwrap_or("?")); }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let title = page_title(&mut state).await;
    eprintln!("page title after fuzz: {title}");
    assert!(!title.to_string().contains("ScriptReadableSession77"), "agent-supplied code reached page world: {title}");
    let _ = execute_command(&json!({"id":"close","action":"close"}), &mut state).await;
    server.abort();
}

/// Every property an element of every kind takes, written from the agent's world on a real element of that kind with
/// each text that would be code in the page's world (a script address, markup holding a script, markup holding a
/// handler, handler text, and a value that reads differently each time it is turned to text), then put in the page and
/// clicked. Code that ran in the page's world leaves a mark there (`top.__ran`), which the agent's world can neither
/// make nor see: the test reads it through the page's own world. Nothing an agent's script writes may leave one.
#[tokio::test]
#[ignore]
async fn e2e_no_property_of_any_element_carries_an_agents_code_into_the_pages_world() {
    let (base_url, server) = start_routed_server(sinks_route).await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    open_page(&mut state, &format!("{base_url}/")).await;
    // Test fixture data: the kinds of element there are. The setters are found on each, not listed.
    let html = "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form frame frameset h1 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark marquee menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr applet font center dir";
    let svg = "a animate animateMotion animateTransform circle clipPath defs desc ellipse feImage filter foreignObject g image line linearGradient marker mask metadata mpath path pattern polygon polyline radialGradient rect set stop style svg switch symbol text textPath title tspan use view";
    let math = "math mi mo mn ms mtext annotation annotation-xml semantics maction";
    let kinds: Vec<(String, String)> = html
        .split(' ')
        .map(|t| (t.to_string(), format!("document.createElement('{t}')")))
        .chain(svg.split(' ').map(|t| (format!("svg:{t}"), format!("document.createElementNS('http://www.w3.org/2000/svg', '{t}')"))))
        .chain(math.split(' ').map(|t| (format!("math:{t}"), format!("document.createElementNS('http://www.w3.org/1998/Math/MathML', '{t}')"))))
        .collect();
    // One kind a script, so a kind that never returns is known by name. Each written text marks itself by number
    // (`base + n`), and the script says which number is which property.
    let probe = r#"(() => {
      const make = () => MAKE;
      const base = BASE, from = FROM, to = TO, mfrom = MFROM, mto = MTO;
      const names = [];
      const mark = (n) => 'top.__ran=(top.__ran||[]),top.__ran.push(' + (base + n) + ')';
      const texts = (n) => [
        'javascript:' + mark(n),
        ' \tJaVa\nScRiPt:' + mark(n),
        '<script>' + mark(n) + '</scr' + 'ipt>',
        '<img src=x onerror=' + mark(n) + '>',
        mark(n),
        'data:text/html,<script>' + mark(n) + '</scr' + 'ipt>',
      ];
      const tally = { setters: 0, tried: 0, accepted: 0, refused: 0 };
      let probe;
      try { probe = make(); } catch (e) { return JSON.stringify({ unmade: String(e), tally, names }); }
      const keys = [];
      for (let o = Object.getPrototypeOf(probe); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const k of Object.getOwnPropertyNames(o)) {
          const d = Object.getOwnPropertyDescriptor(o, k);
          if (d && d.set && keys.indexOf(k) < 0) keys.push(k);
        }
      }
      tally.setters = keys.length;
      const box = document.createElement('div');
      document.body.append(box);
      for (let at = from; at < keys.length && at < to; at++) {
        const k = keys[at];
        for (let which = 0; which < 7; which++) {
          let el;
          try { el = make(); } catch (_) { break; }
          const n = names.length;
          names.push(k + '#' + which);
          const all = texts(n);
          let value;
          if (which < 6) value = all[which];
          else { let turn = 0; value = { toString() { return turn++ ? all[0] : 'x'; } }; }
          tally.tried++;
          try {
            el[k] = value;
            const held = el[k];
            if (held && typeof held === 'object' && 'baseVal' in held) { try { held.baseVal = value; } catch (_) {} }
            tally.accepted++;
          } catch (_) { tally.refused++; continue; }
          try { box.append(el); } catch (_) { continue; }
          try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) {}
          try { el.remove(); } catch (_) {}
        }
        // The same name as an attribute, each way an attribute is written: by name, by namespace, as a node, and
        // toggled on then written.
        const attr = k.toLowerCase();
        const ways = [
          (el, v) => el.setAttribute(attr, v),
          (el, v) => el.setAttributeNS(null, attr, v),
          (el, v) => el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:' + attr, v),
          (el, v) => { const a = document.createAttribute(attr); a.value = v; el.setAttributeNode(a); },
          (el, v) => { el.toggleAttribute(attr, true); el.attributes[attr].value = v; },
        ];
        for (let way = 0; way < ways.length; way++) {
          for (let which = 0; which < 6; which++) {
            let el;
            try { el = make(); } catch (_) { break; }
            const n = names.length;
            names.push('@' + attr + '/' + way + '#' + which);
            tally.tried++;
            try { ways[way](el, texts(n)[which]); tally.accepted++; } catch (_) { tally.refused++; continue; }
            try { box.append(el); } catch (_) { continue; }
            try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) {}
            try { el.remove(); } catch (_) {}
          }
        }
      }
      // Every method an element of this kind has that takes text or nodes, called with each text, and with a node
      // holding it; once for the kind, when the first batch of its properties is written.
      if (mto > 0) {
        const methods = [];
        for (let o = Object.getPrototypeOf(probe); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          for (const m of Object.getOwnPropertyNames(o)) {
            const d = Object.getOwnPropertyDescriptor(o, m);
            if (d && typeof d.value === 'function' && m !== 'constructor' && methods.indexOf(m) < 0) methods.push(m);
          }
        }
        // Not called: they leave the page, wait on the user, or take the element out from under the probe.
        const skip = ['click', 'remove', 'requestFullscreen', 'requestPointerLock', 'showModal', 'showPicker', 'showPopover', 'requestSubmit', 'submit', 'reset', 'focus', 'blur', 'scrollIntoView', 'scrollIntoViewIfNeeded', 'animate', 'play', 'load', 'pause', 'webkitRequestFullscreen', 'webkitRequestFullScreen', 'reportValidity', 'checkValidity', 'select', 'stepUp', 'stepDown', 'close', 'show', 'hidePopover', 'togglePopover', 'requestPictureInPicture', 'captureStream', 'toBlob', 'transferControlToOffscreen', 'getContext', 'attachInternals', 'before', 'after', 'replaceWith'];
        tally.methods = methods.length;
        for (let mi = mfrom; mi < methods.length && mi < mto; mi++) {
          const m = methods[mi];
          if (skip.indexOf(m) >= 0) continue;
          for (let which = 0; which < 6; which++) {
            for (let shape = 0; shape < 3; shape++) {
              let el;
              try { el = make(); } catch (_) { break; }
              const n = names.length;
              names.push(m + '()/' + shape + '#' + which);
              const t = texts(n)[which];
              tally.tried++;
              try {
                box.append(el);
                if (shape === 0) el[m](t);
                else if (shape === 1) el[m](t, t);
                else el[m]('beforeend', t);
                tally.accepted++;
              } catch (_) { tally.refused++; }
              try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) {}
              try { el.remove(); } catch (_) {}
            }
          }
        }
      }
      box.remove();
      return JSON.stringify({ tally, names });
    })()"#;
    let (mut setters, mut methods, mut tried, mut accepted, mut refused) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut names: Vec<String> = Vec::new();
    let mut unfinished: Vec<String> = Vec::new();
    let mut unmade: Vec<String> = Vec::new();
    // A few properties a script, so one that never returns is known by name and costs the rest nothing.
    const AT_ONCE: usize = 25;
    for (kind, make) in &kinds {
        let (mut from, mut of) = (0usize, usize::MAX);
        while from < of {
            let script = probe.replace("MAKE", make).replace("BASE", &names.len().to_string()).replace("MFROM", "0").replace("MTO", "0").replace("FROM", &from.to_string()).replace("TO", &(from + AT_ONCE).to_string());
            let resp = execute_command(&json!({ "id": "write", "action": "evaluate", "script": script, "timeout": 120000 }), &mut state).await;
            let Some(text) = resp["data"]["result"].as_str() else {
                unfinished.push(format!("{kind} properties {from}..{}: {}", from + AT_ONCE, resp["error"].as_str().unwrap_or("no answer")));
                // Writes that didn't answer may have left the page somewhere else: start it again.
                open_page(&mut state, &format!("{base_url}/")).await;
                if of == usize::MAX {
                    break;
                }
                from += AT_ONCE;
                continue;
            };
            let said: Value = serde_json::from_str(text).unwrap();
            if said.get("unmade").is_some() {
                unmade.push(kind.clone());
                break;
            }
            let n = |k: &str| said["tally"][k].as_u64().unwrap_or(0);
            if of == usize::MAX {
                of = n("setters") as usize;
                setters += n("setters");
            }
            tried += n("tried");
            accepted += n("accepted");
            refused += n("refused");
            for name in said["names"].as_array().into_iter().flatten() {
                names.push(format!("{kind}.{}", name.as_str().unwrap_or("?")));
            }
            // What ran in the page's world so far, read there, while this page is still the one written to.
            let ran = execute_command(&json!({ "id": "ran", "action": "page_evaluate", "script": "JSON.stringify(window.__ran || [])" }), &mut state).await;
            let marks: Vec<usize> = serde_json::from_str(ran["data"]["result"].as_str().unwrap_or("[]")).unwrap_or_default();
            let which: Vec<&str> = marks.iter().map(|m| names.get(*m).map(String::as_str).unwrap_or("?")).collect();
            assert!(which.is_empty(), "an agent's text ran as code in the page's world through: {which:?}");
            from += AT_ONCE;
        }
        // Then its methods, a few a script for the same reason.
        const METHODS_AT_ONCE: usize = 12;
        let (mut from, mut of) = (0usize, usize::MAX);
        while from < of {
            let script = probe
                .replace("MAKE", make)
                .replace("BASE", &names.len().to_string())
                .replace("MFROM", &from.to_string())
                .replace("MTO", &(from + METHODS_AT_ONCE).to_string())
                .replace("FROM", "0")
                .replace("TO", "0");
            let resp = execute_command(&json!({ "id": "call", "action": "evaluate", "script": script, "timeout": 120000 }), &mut state).await;
            let Some(text) = resp["data"]["result"].as_str() else {
                unfinished.push(format!("{kind} methods {from}..{}: {}", from + METHODS_AT_ONCE, resp["error"].as_str().unwrap_or("no answer")));
                open_page(&mut state, &format!("{base_url}/")).await;
                if of == usize::MAX {
                    break;
                }
                from += METHODS_AT_ONCE;
                continue;
            };
            let said: Value = serde_json::from_str(text).unwrap();
            let n = |k: &str| said["tally"][k].as_u64().unwrap_or(0);
            if of == usize::MAX {
                of = n("methods") as usize;
                methods += n("methods");
            }
            tried += n("tried");
            accepted += n("accepted");
            refused += n("refused");
            for name in said["names"].as_array().into_iter().flatten() {
                names.push(format!("{kind}.{}", name.as_str().unwrap_or("?")));
            }
            let ran = execute_command(&json!({ "id": "ran", "action": "page_evaluate", "script": "JSON.stringify(window.__ran || [])" }), &mut state).await;
            let marks: Vec<usize> = serde_json::from_str(ran["data"]["result"].as_str().unwrap_or("[]")).unwrap_or_default();
            let which: Vec<&str> = marks.iter().map(|m| names.get(*m).map(String::as_str).unwrap_or("?")).collect();
            assert!(which.is_empty(), "an agent's text ran as code in the page's world through: {which:?}");
            from += METHODS_AT_ONCE;
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    let ran = execute_command(&json!({ "id": "ran", "action": "page_evaluate", "script": "JSON.stringify(window.__ran || [])" }), &mut state).await;
    let marks: Vec<usize> = serde_json::from_str(ran["data"]["result"].as_str().unwrap_or("[]")).unwrap_or_default();
    let which: Vec<&str> = marks.iter().map(|m| names.get(*m).map(String::as_str).unwrap_or("?")).collect();
    let title = page_title(&mut state).await;
    eprintln!(
        "every element's setters, from the agent's world: {} kinds ({} not made: {unmade:?}), {setters} setters (each also as an attribute, five ways), {methods} methods, {tried} written or called, {accepted} accepted, {refused} refused; did not finish: {unfinished:?}",
        kinds.len(),
        unmade.len()
    );
    eprintln!("ran in the page's world: {which:?}; the page's title: {title}");
    assert!(tried > 10_000, "the probe wrote to every setter");
    assert!(which.is_empty(), "an agent's text ran as code in the page's world through: {which:?}");
    assert!(!title.to_string().contains("ScriptReadableSession77"), "{title}");
    assert!(unfinished.is_empty(), "a kind's writes never returned: {unfinished:?}");
    // The mark is one this test can see: code that does run in the page's world (the one way the agent's world has,
    // a script address given to the page's own location) leaves it, and it is read back.
    let _ = execute_command(&json!({ "id": "known", "action": "evaluate", "script": "location.href = 'javascript:void(top.__ran=[424242])'; 1" }), &mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let seen = execute_command(&json!({ "id": "seen", "action": "page_evaluate", "script": "JSON.stringify(window.__ran || [])" }), &mut state).await;
    assert_eq!(seen["data"]["result"].as_str(), Some("[424242]"), "code that runs in the page's world leaves a mark this test reads");
    let _ = execute_command(&json!({ "id": "close", "action": "close" }), &mut state).await;
    server.abort();
}

/// A page-installed capture listener is present before guard arming; determine whether it suppresses command protection.
#[tokio::test]
#[ignore]
async fn e2e_hostile_page_capture_listener_and_builtin_poisoning() {
    let (base_url, server) = start_routed_server(session_route).await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({"id":"launch","action":"launch","headless":true}), &mut state).await);
    open_page(&mut state, &format!("{base_url}/")).await;
    let install = "window.addEventListener('click',e=>e.stopImmediatePropagation(),true); window.addEventListener('submit',e=>e.stopImmediatePropagation(),true); window.addEventListener('keydown',e=>e.stopImmediatePropagation(),true); Array.prototype.filter=()=>[]; Array.prototype.includes=()=>false; String.prototype.toLowerCase=()=>''; EventTarget.prototype.addEventListener=()=>{}; Event.prototype.preventDefault=()=>{}; Object.defineProperty=()=>{}; true";
    assert_success(&execute_command(&json!({"id":"hostile","action":"page_evaluate","script":install}), &mut state).await);
    for (id, prepare, action) in [
      ("js", "", json!({"action":"click","selector":"#js"})),
      ("dblclick", "", json!({"action":"dblclick","selector":"#js"})),
      ("label", "", json!({"action":"click","selector":"#l"})),
      ("area", "", json!({"action":"click","selector":"area"})),
      ("access", "", json!({"action":"press","key":"Alt+k"})),
      ("enter", "document.getElementById('js').focus()", json!({"action":"press","key":"Enter"})),
      ("newline", "", json!({"action":"type","selector":"#q4","text":"x\n"})),
      ("find", "", json!({"action":"getbytext","text":"run"})),
      ("check", "(() => { const l=document.createElement('label'); l.textContent='box'; const c=document.createElement('input'); c.type='checkbox'; const s=document.createElement('input'); s.type='submit'; s.id='hostile-submit'; s.setAttribute('formaction',\"javascript:document.title='check ran'\"); const f=document.createElement('form'); f.id='hostile-form'; f.append(s); document.body.append(f); l.htmlFor=s.id; l.append(c); document.body.append(l); })()", json!({"action":"check","selector":"input[type=checkbox]"})),
    ] {
      if !prepare.is_empty() { assert_success(&execute_command(&json!({"id":format!("prep-{id}"),"action":"page_evaluate","script":prepare}),&mut state).await); }
      let mut command=action; command["id"]=json!(id);
      let result=execute_command(&command,&mut state).await;
      tokio::time::sleep(std::time::Duration::from_millis(100)).await;
      let title=page_title(&mut state).await;
      eprintln!("hostile {id}: response={result} title={title}");
      // Each is refused before anything is dispatched, and nothing of the page's ran: the title is as it was served.
      assert_eq!(result["success"], json!(false), "{id} was let through: {result}");
      assert!(result["error"].as_str().is_some_and(|e| e.contains("script address")), "{id}: {result}");
      assert!(title.to_string().contains("sees its cookie"), "{id} ran the page's script address: {title}");
      if id=="enter" || id=="newline" || id=="find" || id=="check" { open_page(&mut state,&format!("{base_url}/")).await; assert_success(&execute_command(&json!({"id":format!("hostile-reset-{id}"),"action":"page_evaluate","script":install}),&mut state).await); }
    }
    open_page(&mut state,&format!("{base_url}/")).await;
    assert_success(&execute_command(&json!({"id":"mousedown-rewrite","action":"page_evaluate","script":"document.getElementById('noop').addEventListener('mousedown',e=>{e.currentTarget.href=\"javascript:document.title='rewritten'\"})"}),&mut state).await);
    let rewrite=execute_command(&json!({"id":"rewrite-click","action":"click","selector":"#noop"}),&mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let title=page_title(&mut state).await;
    eprintln!("page mousedown rewrite: command={rewrite} title={title}");
    // The read before the click saw a harmless link; only the check at the moment of activation can stop this one.
    assert_eq!(rewrite["success"], json!(false), "{rewrite}");
    assert!(rewrite["error"].as_str().is_some_and(|e| e.contains("at the moment of activation")), "{rewrite}");
    assert!(title.to_string().contains("sees its cookie"), "{title}");
    // The same, with the page's own capturing listeners (registered first, stopping every click) and its poisoned
    // built-ins in place: whether the page can keep the check from hearing the click.
    open_page(&mut state,&format!("{base_url}/")).await;
    assert_success(&execute_command(&json!({"id":"hostile-again","action":"page_evaluate","script":install}),&mut state).await);
    assert_success(&execute_command(&json!({"id":"mousedown-rewrite-2","action":"page_evaluate","script":"document.getElementById('noop').addEventListener('mousedown',e=>{e.currentTarget.href=\"javascript:document.title='rewritten'\"})"}),&mut state).await);
    let hostile_rewrite=execute_command(&json!({"id":"rewrite-click-2","action":"click","selector":"#noop"}),&mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let title=page_title(&mut state).await;
    eprintln!("page mousedown rewrite under the page's capturing listeners: command={hostile_rewrite} title={title}");
    assert!(title.to_string().contains("sees its cookie"), "the page's listeners kept the check from the click, and its rewritten address ran: {title}");
    let _ = execute_command(&json!({"id":"close","action":"close"}), &mut state).await;
    server.abort();
}

/// Same-origin reflected markup and script execute with the site's real, script-readable cookie.
#[tokio::test]
#[ignore]
async fn e2e_same_origin_reflection_runs_site_code_and_records_cookie() {
    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = received.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let base_for_server = base.clone();
    let server = tokio::spawn(async move {
      while let Ok((mut s,_))=listener.accept().await { let seen=seen.clone(); let base=base_for_server.clone(); tokio::spawn(async move {
        let mut b=vec![0u8;32768]; let n=s.read(&mut b).await.unwrap_or(0); let req=String::from_utf8_lossy(&b[..n]).to_string();
        let path=req.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("/").to_string();
        let body=if path.starts_with("/collect") { seen.lock().unwrap().push(path.clone()); "ok".to_string() }
          else if path.starts_with("/script?") { let q=path.split_once("?").map(|x|x.1).unwrap_or(""); format!("<title>script-reflect</title><script>fetch('/collect?'+encodeURIComponent(document.cookie))</script><p>{q}</p>") }
          else if path.starts_with("/html?") { let q=path.split_once("?").map(|x|x.1).unwrap_or(""); format!("<title>html-reflect</title>{q}") }
          else { format!("<title>reflection</title><iframe id=f></iframe><a id=l>go</a><form id=form><input id=q name=q><button>go</button></form><script>document.cookie</script>{base}") };
        let extra=if path=="/" { "Set-Cookie: pref=ScriptReadableSession77; Path=/\r\nSet-Cookie: sid=HttpOnlySession66; Path=/; HttpOnly\r\n" } else { "" };
        let res=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}",body.len(),extra,body); let _=s.write_all(res.as_bytes()).await;
      }); }
    });
    let mut state=DaemonState::new();
    assert_success(&execute_command(&json!({"id":"launch","action":"launch","headless":true}),&mut state).await);
    open_page(&mut state,&base).await;
    let payload_html="<img src=x onerror=\"fetch('/collect?'+encodeURIComponent(document.cookie))\">";
    let query=|s:&str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    for (label,setup) in [
      ("frame.src",format!("f.src='{base}/html?{}'",query(payload_html))),
      ("link.href+click",format!("l.href='{base}/script?x';l.click()")),
      ("form.submit",format!("q.value='{}';form.action='{base}/html';form.method='get';form.submit()",payload_html)),
    ] {
      open_page(&mut state,&base).await;
      let r=execute_command(&json!({"id":"attack","action":"evaluate","script":setup}),&mut state).await;
      eprintln!("reflection {label}, agent result {}",r["data"]["result"]);
      tokio::time::sleep(std::time::Duration::from_millis(350)).await;
      let back=execute_command(&json!({"id":"read","action":"evaluate","script":"document.body.innerText+'|'+document.cookie"}),&mut state).await;
      eprintln!("reflection {label}, isolated read {}",back["data"]["result"]);
      // Whatever the site's page ran, the agent's own read of it says the session as a stand-in.
      let read=back["data"]["result"].as_str().unwrap_or_default();
      assert!(read.contains("pref={session}") && !read.contains("ScriptReadableSession77") && !read.contains("HttpOnlySession66"), "{label}: {read}");
    }
    open_page(&mut state,&base).await;
    let nav=execute_command(&json!({"id":"navigate","action":"navigate","url":format!("{base}/script?x")}),&mut state).await;
    eprintln!("reflection navigate response {}",nav);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let got=received.lock().unwrap().clone();
    eprintln!("reflection collector {got:?}");
    // The stated limit, held to what it says: a site that reflects runs the agent's text, and that code reads the
    // cookie a script can read (so this is seen, not hoped away) and never the one a script can't.
    assert!(got.iter().any(|g| g.contains("ScriptReadableSession77")), "the reflecting site ran nothing: {got:?}");
    assert!(got.iter().all(|g| !g.contains("HttpOnlySession66")), "an HttpOnly cookie reached the site's script: {got:?}");
    let _=execute_command(&json!({"id":"close","action":"close"}),&mut state).await; server.abort();
}

/// A sign-in usually lands by a redirect: the cookie it sets comes on the hop, and each hop has to keep its own answer
/// and the cookies it sent.
#[tokio::test]
#[ignore]
async fn e2e_a_redirect_hop_keeps_its_own_cookies_in_the_log() {
    let env = EnvGuard::new(&["UNBROWSE_CAPTURE_DIR"]);
    let dir = tempfile::tempdir().unwrap();
    env.set("UNBROWSE_CAPTURE_DIR", dir.path().to_str().unwrap());
    let (base_url, server) = start_routed_server(walk_route).await;
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "launch", "action": "launch", "headless": true }),
        json!({ "id": "open", "action": "navigate", "url": format!("{base_url}/signin") }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let lines = walk_after_close(&mut state, dir.path()).await;
    server.abort();
    let (signin, second, landed) = (
        exchange(&lines, "/signin").expect("the first hop"),
        exchange(&lines, "/second").expect("the second hop"),
        exchange(&lines, "/landed").expect("the last hop"),
    );
    assert!(header_says(signin, "response", "set-cookie").contains("first=one"), "{signin}");
    assert!(header_says(second, "response", "set-cookie").contains("second=two"), "{second}");
    assert!(header_says(landed, "response", "set-cookie").contains("landed=three"), "{landed}");
    assert!(!header_says(landed, "response", "set-cookie").contains("first"), "{landed}");
    assert!(!header_says(signin, "request", "cookie").contains("first=one"), "{signin}");
    assert!(header_says(second, "request", "cookie").contains("first=one"), "{second}");
    assert!(!header_says(second, "request", "cookie").contains("second=two"), "{second}");
    assert!(header_says(landed, "request", "cookie").contains("second=two"), "{landed}");
}

/// A session's page keeps working while another tab is active, and that holds for a frame of it in its own process too.
#[tokio::test]
#[ignore]
async fn e2e_a_frame_in_a_tab_not_active_is_in_the_walk() {
    let env = EnvGuard::new(&["UNBROWSE_CAPTURE_DIR"]);
    let dir = tempfile::tempdir().unwrap();
    env.set("UNBROWSE_CAPTURE_DIR", dir.path().to_str().unwrap());
    let (base_url, server) = start_routed_server(walk_route).await;
    let mut state = DaemonState::new();
    let frame = "const f = document.createElement('iframe'); \
        f.src = location.href.replace('127.0.0.1', 'localhost') + 'frame'; document.body.append(f); true";
    for command in [
        json!({ "id": "launch", "action": "launch", "headless": true }),
        json!({ "id": "open", "action": "navigate", "url": base_url }),
        json!({ "id": "frame", "action": "page_evaluate", "script": frame }),
        json!({ "id": "other", "action": "tab_new" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let lines = walk_after_close(&mut state, dir.path()).await;
    server.abort();
    assert!(exchange(&lines, "/frame").is_some(), "the frame loaded");
    assert!(exchange(&lines, "/from-the-frame").is_some());
}

/// Chrome sends a string's body with the request, however long, but holds back a blob's (`hasPostData` with no
/// `postData`). The learner needs it: without it the call has no input. A blob answered by a redirect stays bodyless:
/// measured, Chrome has moved the id on to the next hop by the time it can be asked.
#[tokio::test]
#[ignore]
async fn e2e_a_body_chrome_held_back_reaches_the_log() {
    let env = EnvGuard::new(&["UNBROWSE_CAPTURE_DIR"]);
    let dir = tempfile::tempdir().unwrap();
    env.set("UNBROWSE_CAPTURE_DIR", dir.path().to_str().unwrap());
    let (base_url, server) = start_routed_server(walk_route).await;
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "launch", "action": "launch", "headless": true }),
        json!({ "id": "open", "action": "navigate", "url": base_url }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let send = "(async () => { const body = 'q='.padEnd(200000, 'x'); \
        await fetch('/held-back-blob', { method: 'POST', body: new Blob([body]) }); return true; })()";
    assert_success(&execute_command(&json!({ "id": "send", "action": "page_evaluate", "script": send }), &mut state).await);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let lines = walk_after_close(&mut state, dir.path()).await;
    server.abort();
    let entry = exchange(&lines, "/held-back-blob").expect("the call is in the log");
    assert_eq!(entry["entry"]["request"]["postData"]["text"].as_str().unwrap_or("").len(), 200000);
}

async fn start_stateful_auth_login_server(
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let base_url = format!("http://127.0.0.1:{}", port);
    let document_requests = Arc::new(AtomicUsize::new(0));
    let counter = document_requests.clone();

    let handle = tokio::spawn(async move {
        for _ in 0..100 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let counter = counter.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                if !path.starts_with("/favicon") {
                    counter.fetch_add(1, Ordering::SeqCst);
                }

                let body = r#"<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Stateful Login</title><link rel="icon" href="data:," /></head>
  <body>
    <button id="reveal" type="button">Continue to login</button>
    <form id="login-form" style="display:none">
      <input type="email" name="email" />
      <input type="password" name="password" />
      <button type="submit">Sign in</button>
    </form>
    <script>
      document.getElementById('reveal').addEventListener('click', () => {
        document.getElementById('login-form').style.display = 'block';
        window.__revealed = true;
      });
      document.getElementById('login-form').addEventListener('submit', (event) => {
        event.preventDefault();
        window.__submitted = true;
      });
    </script>
  </body>
</html>"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    (base_url, document_requests, handle)
}

/// A page whose calls to `/slow...` take a second to answer and whose other calls are quick.
async fn start_slow_call_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                if path.starts_with("/slow") {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                let (kind, body) = match path.as_str() {
                    "/" => ("text/html", "<!doctype html><title>t</title><link rel=icon href='data:,'>".to_string()),
                    _ => ("application/json", format!("{{\"answer\":\"{}\"}}", path.trim_start_matches('/'))),
                };
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (base_url, handle)
}

/// A HAR recording runs beside the walk on the same entries. Whatever it is asked to keep, and whenever it starts and
/// stops, the walk keeps every call with its answer.
#[tokio::test]
#[ignore]
async fn e2e_a_har_recording_leaves_the_walk_whole() {
    let env = EnvGuard::new(&["UNBROWSE_CAPTURE_DIR", "AGENT_BROWSER_FILE_ROOT"]);
    let dir = tempfile::tempdir().unwrap();
    env.set("UNBROWSE_CAPTURE_DIR", dir.path().to_str().unwrap());
    env.set("AGENT_BROWSER_FILE_ROOT", dir.path().to_str().unwrap());
    let har = dir.path().join("kept.har");
    let (base_url, server) = start_slow_call_server().await;
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "navigate", "url": base_url }),
        // Asked just before the recording starts, answered inside it.
        json!({ "id": "3", "action": "page_evaluate", "script": "fetch('/slow-before').then(r => r.text()); true" }),
        json!({ "id": "4", "action": "har_start", "content": "none" }),
        json!({ "id": "5", "action": "page_evaluate", "script": "fetch('/during').then(r => r.text())" }),
        // Asked inside the recording, answered after it stops.
        json!({ "id": "6", "action": "page_evaluate", "script": "fetch('/slow-across').then(r => r.text()); true" }),
        json!({ "id": "7", "action": "har_stop", "path": har.to_str().unwrap() }),
        json!({ "id": "8", "action": "page_evaluate", "script": "fetch('/after').then(r => r.text())" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    assert_success(&execute_command(&json!({ "id": "9", "action": "url" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "10", "action": "close" }), &mut state).await);
    server.abort();
    let log = std::fs::read_to_string(dir.path().join(format!("{}.jsonl", state.session_id))).unwrap_or_default();
    for answer in ["slow-before", "during", "slow-across", "after"] {
        assert!(log.contains(&format!("{{\\\"answer\\\":\\\"{answer}\\\"}}")), "{answer} with its answer: {log}");
    }
    let file = std::fs::read_to_string(&har).unwrap();
    assert!(file.contains("/during") && !file.contains("answer"), "the recording asked for no bodies: {file}");
}

/// These fixtures take a form and keep showing it, so the login was sent and reads as not having worked.
fn login_form_was_sent(login: &Value) -> bool {
    login["success"] == true || login["error"].as_str().is_some_and(|e| e.contains("still showing"))
}

/// A site that signs in only with the right password, in the three ways a site answers: a new page, a new page asking
/// for a code, and the form again.
async fn start_site_that_checks_the_password() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let form = "<title>sign in</title><form method=post action=/login>\
                    <input type=email name=email><input type=password name=password>\
                    <button type=submit>Sign in</button></form>";
                let body = if !request.starts_with("POST") {
                    form
                } else if request.contains("password=right") {
                    "<title>home</title><h1>Welcome</h1>"
                } else if request.contains("password=needs-code") {
                    "<title>code</title><input autocomplete=one-time-code>"
                } else {
                    form
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (base_url, handle)
}

/// `loggedIn` was true whatever the page answered. A wrong password, or a page that wants a code, is not a login.
#[tokio::test]
#[ignore]
async fn e2e_a_login_reads_logged_in_only_when_the_page_stopped_asking() {
    let (base_url, server) = start_site_that_checks_the_password().await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    let mut answers = Vec::new();
    for password in ["right", "wrong", "needs-code"] {
        let profile = unique_auth_profile_name(password);
        let save = json!({ "id": "2", "action": "auth_save", "name": profile, "url": base_url,
            "username": "user@example.test", "password": password });
        assert_success(&execute_command(&save, &mut state).await);
        answers.push(execute_command(&json!({ "id": "3", "action": "auth_login", "name": profile }), &mut state).await);
        let _ = execute_command(&json!({ "id": "4", "action": "auth_delete", "name": profile }), &mut state).await;
    }
    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    server.abort();
    assert_success(&answers[0]);
    assert_eq!(get_data(&answers[0])["loggedIn"], true);
    assert_eq!(answers[1]["success"], false, "{}", answers[1]);
    assert!(answers[1]["error"].as_str().unwrap_or_default().contains("still showing"), "{}", answers[1]);
    assert_eq!(answers[2]["success"], false, "{}", answers[2]);
    assert!(answers[2]["error"].as_str().unwrap_or_default().contains("one-time code"), "{}", answers[2]);
}

fn unique_auth_profile_name(suffix: &str) -> String {
    format!(
        "e2e-auth-login-{}-{}",
        suffix,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_else(|_| std::time::Duration::from_secs(0))
            .as_nanos()
    )
}

#[tokio::test]
#[ignore]
async fn e2e_auth_login_selects_usable_controls_and_preserves_credential_targets() {
    let (base_url, _, server) = start_stateful_auth_login_server().await;
    let mut state = DaemonState::new();
    let profile = unique_auth_profile_name("changed-target");
    for command in [
        json!({ "id": "launch", "action": "launch", "headless": true }),
        json!({ "id": "open", "action": "navigate", "url": base_url }),
        json!({ "id": "save", "action": "auth_save", "name": profile,
            "url": base_url, "username": "target@example.test", "password": "target-password" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let mut results = Vec::new();
    for field in ["user", "pass"] {
        for phase in [
            "normal",
            "selection",
            "focus-detach",
            "focus-redirect",
            "select-redirect",
            "focus-readonly",
            "input-detach",
            "exception",
            "textarea",
            "contenteditable",
            "no-native-edit",
            "no-native-edit-textarea",
            "no-native-edit-contenteditable",
        ] {
            let script = format!(
                r#"(() => {{
                    document.body.innerHTML = '<form><input id="decoy" value="decoy:"><input id="hidden-user" type="email" autocomplete="username" hidden><input id="user" type="email" autocomplete="username webauthn"><input id="hidden-pass" type="password" hidden><input id="pass" type="password"><button hidden type="submit" onclick="window.hiddenClicked = true">Hidden</button><button type="submit" onclick="window.visibleClicked = true">Sign in</button></form>';
                    if ('{phase}'.endsWith('textarea')) document.getElementById('{field}').outerHTML = '<textarea id="{field}">old value</textarea>';
                    if ('{phase}'.endsWith('contenteditable')) document.getElementById('{field}').outerHTML = '<div id="{field}" contenteditable="true">old value</div>';
                    window.events = [];
                    window.submitted = false;
                    window.hiddenClicked = false;
                    window.visibleClicked = false;
                    window.nativeEdit ??= document.execCommand;
                    document.execCommand = '{phase}'.startsWith('no-native-edit') ? undefined : window.nativeEdit;
                    const decoy = document.getElementById('decoy');
                    const target = document.getElementById('{field}');
                    const replace = () => {{
                        window.detached = target;
                        target.replaceWith(target.cloneNode(true));
                        decoy.focus();
                    }};
                    window.detached = null;
                    document.querySelector('form').onsubmit = event => {{
                        event.preventDefault();
                        window.submitted = true;
                    }};
                    document.oninput = event => window.events.push({{
                        id: event.target.id, value: event.target.value ?? event.target.textContent,
                        trusted: event.isTrusted
                    }});
                    decoy.focus();
                    decoy.setSelectionRange(6, 6);
                    if ('{phase}' === 'selection') {{
                        const box = target.getBoundingClientRect.bind(target);
                        target.getBoundingClientRect = () => {{
                            const rect = box();
                            queueMicrotask(replace);
                            return rect;
                        }};
                    }}
                    if ('{phase}' === 'focus-detach') target.onfocus = replace;
                    if ('{phase}' === 'focus-redirect') target.onfocus = () => decoy.focus();
                    if ('{phase}' === 'select-redirect') target.select = () => decoy.focus();
                    if ('{phase}' === 'focus-readonly') target.onfocus = () => target.readOnly = true;
                    if ('{phase}' === 'input-detach') target.oninput = replace;
                    if ('{phase}' === 'exception') target.focus = () => {{ throw new Error('page failure'); }};
                }})()"#
            );
            assert_success(
                &execute_command(
                    &json!({ "id": "fixture", "action": "page_evaluate", "script": script }),
                    &mut state,
                )
                .await,
            );
            let mut command = json!({
                "id": "login", "action": "auth_login", "name": profile,
                "noNavigate": true, "timeout": 200
            });
            if phase.ends_with("textarea") || phase.ends_with("contenteditable") {
                command["usernameSelector"] = json!("#user");
                command["passwordSelector"] = json!("#pass");
            }
            let login = execute_command(&command, &mut state).await;
            let observation = execute_command(
                &json!({
                    "id": "observe", "action": "page_evaluate",
                    "script": "({ user: document.getElementById('user').value ?? document.getElementById('user').textContent, pass: document.getElementById('pass').value ?? document.getElementById('pass').textContent, decoy: document.getElementById('decoy').value, events: window.events, hiddenUser: document.getElementById('hidden-user').value, hiddenPass: document.getElementById('hidden-pass').value, hiddenClicked: window.hiddenClicked, visibleClicked: window.visibleClicked, submitted: window.submitted, detached: !!window.detached && !window.detached.isConnected })"
                }),
                &mut state,
            )
            .await;
            results.push((field, phase, login, observation));
        }
    }
    for command in [
        json!({ "id": "delete", "action": "auth_delete", "name": profile }),
        json!({ "id": "close", "action": "close" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    server.abort();
    for (field, phase, login, observation) in results {
        assert_success(&observation);
        let observed = &get_data(&observation)["result"];
        let normal = ["normal", "textarea", "contenteditable"].contains(&phase)
            || phase.starts_with("no-native-edit");
        assert_eq!(observed["decoy"], "decoy:", "{field}/{phase}: {observed}");
        assert_eq!(observed["hiddenUser"], "", "{field}/{phase}: {observed}");
        assert_eq!(observed["hiddenPass"], "", "{field}/{phase}: {observed}");
        assert_eq!(
            observed["hiddenClicked"], false,
            "{field}/{phase}: {observed}"
        );
        assert_eq!(
            observed["visibleClicked"], normal,
            "{field}/{phase}: {observed}"
        );
        assert_eq!(login_form_was_sent(&login), normal, "{field}/{phase}: {login}");
        assert_eq!(observed["submitted"], normal, "{field}/{phase}: {observed}");
        if phase == "selection" || phase == "focus-detach" || phase == "input-detach" {
            assert_eq!(observed["detached"], true, "{field}/{phase}: {observed}");
        }
        for event in observed["events"].as_array().unwrap() {
            let expected = match event["id"].as_str().unwrap() {
                "user" => "target@example.test",
                "pass" => "target-password",
                other => panic!("{field}/{phase}: input delivered to {other}: {event}"),
            };
            assert_eq!(event["value"], expected, "{field}/{phase}: {event}");
            assert_eq!(
                event["trusted"],
                !phase.starts_with("no-native-edit"),
                "{field}/{phase}: {event}"
            );
        }
        let expected_user = if normal || field == "pass" || phase == "input-detach" {
            "target@example.test"
        } else {
            ""
        };
        let expected_pass = if normal || (field == "pass" && phase == "input-detach") {
            "target-password"
        } else {
            ""
        };
        assert_eq!(
            observed["user"], expected_user,
            "{field}/{phase}: {observed}"
        );
        assert_eq!(
            observed["pass"], expected_pass,
            "{field}/{phase}: {observed}"
        );
    }
}

#[tokio::test]
#[ignore]
async fn e2e_auth_login_no_navigate_preserves_active_page_state() {
    let (base_url, document_requests, _server) = start_stateful_auth_login_server().await;
    let mut state = DaemonState::new();
    let profile_name = unique_auth_profile_name("no-navigate");

    assert_success(
        &execute_command(
            &json!({ "id": "1", "action": "launch", "headless": true }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "2", "action": "navigate", "url": format!("{}/flow/start?state=ready#login", base_url) }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "3", "action": "click", "selector": "#reveal" }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "4", "action": "page_evaluate", "script": "window.__marker = 'preserved'" }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({
                "id": "5",
                "action": "auth_save",
                "name": profile_name.clone(),
                "url": format!("{}/credentials/login?credential-query-sentinel#credential-fragment-sentinel", base_url),
                "username": "stateful-user@example.com",
                "password": "stateful-password-secret",
            }),
            &mut state,
        )
        .await,
    );
    let request_count_before = document_requests.load(Ordering::SeqCst);

    let login = execute_command(
        &json!({ "id": "6", "action": "auth_login", "name": profile_name.clone(), "noNavigate": true }),
        &mut state,
    )
    .await;
    assert!(login_form_was_sent(&login), "{login}");
    assert_eq!(
        document_requests.load(Ordering::SeqCst),
        request_count_before
    );

    let verify = execute_command(
        &json!({
            "id": "7",
            "action": "page_evaluate",
            "script": "({ marker: window.__marker, revealed: !!window.__revealed, submitted: !!window.__submitted, user: document.querySelector('input[type=email]').value, pass: document.querySelector('input[type=password]').value })",
        }),
        &mut state,
    )
    .await;
    assert_success(&verify);
    let result = &get_data(&verify)["result"];
    assert_eq!(result["marker"], "preserved");
    assert_eq!(result["revealed"], true);
    assert_eq!(result["submitted"], true);
    assert_eq!(result["user"], "stateful-user@example.com");
    assert_eq!(result["pass"], "stateful-password-secret");

    let _ = execute_command(
        &json!({ "id": "8", "action": "auth_delete", "name": profile_name }),
        &mut state,
    )
    .await;
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

#[cfg(unix)]
#[tokio::test]
#[ignore]
async fn e2e_auth_login_no_navigate_preserves_state_with_credential_provider() {
    use std::os::unix::fs::PermissionsExt;

    let (base_url, document_requests, _server) = start_stateful_auth_login_server().await;
    let plugin_dir = tempfile::tempdir().unwrap();
    let plugin_path = plugin_dir.path().join("stateful-credential-provider");
    std::fs::write(
        &plugin_path,
        format!(
            r#"#!/bin/sh
cat >/dev/null
printf '%s' '{{"protocol":"agent-browser.plugin.v1","success":true,"credential":{{"username":"provider-user@example.com","password":"provider-password-secret","url":"{}/provider/login"}}}}'
"#,
            base_url
        ),
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&plugin_path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&plugin_path, permissions).unwrap();

    let mut state = DaemonState::new();
    assert_success(
        &execute_command(
            &json!({ "id": "1", "action": "launch", "headless": true }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "2", "action": "navigate", "url": format!("{}/flow/provider", base_url) }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "3", "action": "click", "selector": "#reveal" }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "4", "action": "page_evaluate", "script": "window.__marker = 'provider-preserved'" }),
            &mut state,
        )
        .await,
    );
    let request_count_before = document_requests.load(Ordering::SeqCst);

    let login = execute_command(
        &json!({
            "id": "5",
            "action": "auth_login",
            "name": "provider-stateful-login",
            "noNavigate": true,
            "credentialProvider": "mock",
            "plugins": [{
                "name": "mock",
                "command": plugin_path.to_string_lossy(),
                "capabilities": ["credential.read"]
            }]
        }),
        &mut state,
    )
    .await;
    assert!(login_form_was_sent(&login), "{login}");
    let serialized_login = serde_json::to_string(&login).unwrap();
    assert!(!serialized_login.contains("provider-user@example.com"));
    assert!(!serialized_login.contains("provider-password-secret"));
    assert_eq!(
        document_requests.load(Ordering::SeqCst),
        request_count_before
    );

    let verify = execute_command(
        &json!({
            "id": "6",
            "action": "page_evaluate",
            "script": "({ marker: window.__marker, submitted: !!window.__submitted, user: document.querySelector('input[type=email]').value, pass: document.querySelector('input[type=password]').value })",
        }),
        &mut state,
    )
    .await;
    assert_success(&verify);
    let result = &get_data(&verify)["result"];
    assert_eq!(result["marker"], "provider-preserved");
    assert_eq!(result["submitted"], true);
    assert_eq!(result["user"], "provider-user@example.com");
    assert_eq!(result["pass"], "provider-password-secret");

    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

#[tokio::test]
#[ignore]
async fn e2e_auth_login_rejects_cross_origin_no_navigate() {
    let (active_origin, _, _active_server) = start_stateful_auth_login_server().await;
    let (credential_origin, credential_requests, _credential_server) =
        start_stateful_auth_login_server().await;
    let mut state = DaemonState::new();
    let profile_name = unique_auth_profile_name("origin-mismatch");

    assert_success(
        &execute_command(
            &json!({ "id": "1", "action": "launch", "headless": true }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "2", "action": "navigate", "url": format!("{}/flow/current-path-sentinel", active_origin) }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "3", "action": "click", "selector": "#reveal" }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({
                "id": "4",
                "action": "auth_save",
                "name": profile_name.clone(),
                "url": format!("{}/credential-path-sentinel?credential-query-sentinel#credential-fragment-sentinel", credential_origin),
                "username": "username-secret-sentinel",
                "password": "password-secret-sentinel",
            }),
            &mut state,
        )
        .await,
    );

    let login = execute_command(
        &json!({ "id": "5", "action": "auth_login", "name": profile_name.clone(), "noNavigate": true }),
        &mut state,
    )
    .await;
    assert_eq!(login["success"], false);
    let error = login["error"].as_str().unwrap_or_default();
    assert!(error.contains("does not match credential origin"));
    for sentinel in [
        "current-path-sentinel",
        "credential-path-sentinel",
        "credential-query-sentinel",
        "credential-fragment-sentinel",
        "username-secret-sentinel",
        "password-secret-sentinel",
    ] {
        assert!(!error.contains(sentinel));
    }
    assert_eq!(credential_requests.load(Ordering::SeqCst), 0);

    let verify = execute_command(
        &json!({
            "id": "6",
            "action": "page_evaluate",
            "script": "({ user: document.querySelector('input[type=email]').value, pass: document.querySelector('input[type=password]').value, submitted: !!window.__submitted })",
        }),
        &mut state,
    )
    .await;
    assert_success(&verify);
    let result = &get_data(&verify)["result"];
    assert_eq!(result["user"], "");
    assert_eq!(result["pass"], "");
    assert_eq!(result["submitted"], false);

    let _ = execute_command(
        &json!({ "id": "7", "action": "auth_delete", "name": profile_name }),
        &mut state,
    )
    .await;
    assert_success(&execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await);
}

#[tokio::test]
#[ignore]
async fn e2e_auth_login_no_navigate_requires_usable_active_page() {
    let mut state = DaemonState::new();
    let profile_name = unique_auth_profile_name("missing-page");

    assert_success(
        &execute_command(
            &json!({
                "id": "1",
                "action": "auth_save",
                "name": profile_name.clone(),
                "url": "https://example.com/login",
                "username": "unused-user",
                "password": "unused-password",
            }),
            &mut state,
        )
        .await,
    );
    let login = execute_command(
        &json!({ "id": "2", "action": "auth_login", "name": profile_name.clone(), "noNavigate": true }),
        &mut state,
    )
    .await;
    assert_eq!(login["success"], false);
    assert!(login["error"]
        .as_str()
        .unwrap_or_default()
        .contains("requires an existing active HTTP(S) browser page"));
    assert!(
        state.browser.is_none(),
        "no-navigation login must not launch a browser"
    );

    let _ = execute_command(
        &json!({ "id": "3", "action": "auth_delete", "name": profile_name }),
        &mut state,
    )
    .await;
}

#[tokio::test]
#[ignore]
async fn e2e_auth_login_waits_for_delayed_spa_form_render() {
    let (base_url, _server) = start_delayed_login_server(800, 100).await;
    let mut state = DaemonState::new();

    let profile_name = format!(
        "e2e-auth-login-spa-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_else(|_| std::time::Duration::from_secs(0))
            .as_millis()
    );

    let launch = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&launch);

    let save = execute_command(
        &json!({
            "id": "2",
            "action": "auth_save",
            "name": profile_name.clone(),
            "url": format!("{}/login", base_url),
            "username": "user@example.com",
            "password": "super-secret",
        }),
        &mut state,
    )
    .await;
    assert_success(&save);

    let login = execute_command(
        &json!({ "id": "3", "action": "auth_login", "name": profile_name.clone() }),
        &mut state,
    )
    .await;
    assert!(login_form_was_sent(&login), "{login}");

    let current_url = execute_command(&json!({ "id": "3b", "action": "url" }), &mut state).await;
    assert_success(&current_url);
    assert!(get_data(&current_url)["url"]
        .as_str()
        .unwrap_or_default()
        .starts_with(&format!("{}/login", base_url)));

    let verify = execute_command(
        &json!({
            "id": "4",
            "action": "page_evaluate",
            "script": "({ user: document.querySelector('input[type=email]')?.value ?? '', pass: document.querySelector('input[type=password]')?.value ?? '', search: document.querySelector('#search')?.value ?? '', submitted: !!window.__submitted })",
        }),
        &mut state,
    )
    .await;
    assert_success(&verify);
    let result = &get_data(&verify)["result"];
    assert_eq!(result["user"], "user@example.com");
    assert_eq!(result["pass"], "super-secret");
    assert_eq!(result["search"], "");
    assert_eq!(result["submitted"], true);

    let _ = execute_command(
        &json!({ "id": "5", "action": "auth_delete", "name": profile_name }),
        &mut state,
    )
    .await;

    let close = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&close);
}

// ---------------------------------------------------------------------------
// Origin-scoped --headers tests
// ---------------------------------------------------------------------------

/// A page with a link to a file the browser saves.
async fn start_download_site() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let wants_file = String::from_utf8_lossy(&buf[..n]).starts_with("GET /report.csv");
                let (head, body) = if wants_file {
                    ("Content-Type: text/csv\r\nContent-Disposition: attachment; filename=\"report.csv\"", "a,b\n")
                } else {
                    ("Content-Type: text/html", "<!doctype html><a id=\"file\" href=\"/report.csv\">report</a>")
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\n{head}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (base_url, handle)
}

/// `download` names its own file, then leaves the browser saving as the launch set it: a later download lands in the
/// launch's folder under its own name, not in `download`'s folder under a guid.
#[tokio::test]
#[ignore]
async fn e2e_a_download_leaves_later_downloads_as_they_were() {
    let (site, server) = start_download_site().await;
    let launch_folder = tempfile::tempdir().unwrap();
    let command_folder = tempfile::tempdir().unwrap();
    let mut state = DaemonState::new();
    assert_success(
        &execute_command(
            &json!({
                "id": "1",
                "action": "launch",
                "headless": true,
                "downloadPath": launch_folder.path().to_string_lossy()
            }),
            &mut state,
        )
        .await,
    );
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": format!("{site}/") }), &mut state).await);
    let named = command_folder.path().join("mine.csv");
    assert_success(
        &execute_command(
            &json!({ "id": "3", "action": "download", "selector": "#file", "path": named.to_string_lossy() }),
            &mut state,
        )
        .await,
    );
    assert!(named.exists(), "`download` must save under the name it was given");

    assert_success(&execute_command(&json!({ "id": "4", "action": "click", "selector": "#file" }), &mut state).await);

    let later = launch_folder.path().join("report.csv");
    for _ in 0..50 {
        if later.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let left: Vec<_> = std::fs::read_dir(command_folder.path()).unwrap().flatten().map(|f| f.file_name()).collect();
    assert!(later.exists(), "the later download must follow the launch; `download`'s folder holds {left:?}");

    let _ = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
    server.abort();
}

/// Headers passed via --headers on open persist for subsequent same-origin
/// navigations (the core regression from the Rust rewrite).
#[tokio::test]
#[ignore]
async fn e2e_headers_persist_same_origin_navigation() {
    let (base_url, _server) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate with --headers.
    let resp = execute_command(
        &json!({
            "id": "2", "action": "navigate",
            "url": format!("{}/first", base_url),
            "headers": { "X-Test": "scoped" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to the same origin WITHOUT --headers.
    let resp = execute_command(
        &json!({
            "id": "3", "action": "navigate",
            "url": format!("{}/second", base_url),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // The page body is the echo JSON. Read it via evaluate.
    let resp = execute_command(
        &json!({
            "id": "4", "action": "page_evaluate",
            "script": "JSON.parse(document.body.innerText)",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let result = &get_data(&resp)["result"];
    assert_eq!(
        result["headers"]["X-Test"], "scoped",
        "X-Test header should persist on same-origin navigation without --headers"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// A site that counts what it's asked. Every answer is the same empty page.
async fn start_counting_site() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let asked = Arc::new(AtomicUsize::new(0));
    let count = asked.clone();
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let count = count.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                if stream.read(&mut buf).await.unwrap_or(0) > 0 {
                    count.fetch_add(1, Ordering::SeqCst);
                }
                let body = "<!doctype html><title>site</title>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (base_url, asked, handle)
}

/// Saving reads an origin's storage on a blank page the save serves itself. The site is not asked: a save must not load a
/// page the agent left, with the session's cookies, on its own.
#[tokio::test]
#[ignore]
async fn e2e_a_save_never_asks_a_visited_site() {
    let (visited, asked, site) = start_counting_site().await;
    let (current, _, other) = start_counting_site().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json").to_string_lossy().into_owned();
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(
        &execute_command(&json!({ "id": "2", "action": "navigate", "url": format!("{visited}/") }), &mut state).await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "3", "action": "page_evaluate", "script": "localStorage.setItem('kept', 'yes')" }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(&json!({ "id": "4", "action": "navigate", "url": format!("{current}/") }), &mut state).await,
    );
    let before = asked.load(Ordering::SeqCst);

    assert_success(&execute_command(&json!({ "id": "5", "action": "state_save", "path": path }), &mut state).await);

    assert_eq!(asked.load(Ordering::SeqCst), before, "the save went to the site");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let origins = saved["origins"].as_array().unwrap();
    assert!(
        origins.iter().any(|o| o["origin"] == visited.as_str() && o["localStorage"][0]["name"] == "kept"),
        "the visited origin's storage must still be saved: {origins:?}"
    );
    let _ = execute_command(&json!({ "id": "6", "action": "close" }), &mut state).await;
    site.abort();
    other.abort();
}

/// `--headers` reaches every tab: one open before the first `--headers`, for a new origin and for one already set.
#[tokio::test]
#[ignore]
async fn e2e_headers_reach_a_tab_opened_before_them() {
    let (first_origin, _first) = start_echo_server().await;
    let (second_origin, _second) = start_echo_server().await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "tab_new" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "3", "action": "tab_switch", "tabId": "t1" }), &mut state).await);
    assert_success(
        &execute_command(
            &json!({ "id": "4", "action": "navigate", "url": format!("{first_origin}/a"), "headers": { "X-Test": "first" } }),
            &mut state,
        )
        .await,
    );
    assert_success(&execute_command(&json!({ "id": "5", "action": "tab_switch", "tabId": "t2" }), &mut state).await);

    let echoed = |id: &'static str| json!({ "id": id, "action": "page_evaluate", "script": "JSON.parse(document.body.innerText)" });
    assert_success(
        &execute_command(
            &json!({ "id": "6", "action": "navigate", "url": format!("{second_origin}/b"), "headers": { "X-Test": "second" } }),
            &mut state,
        )
        .await,
    );
    let resp = execute_command(&echoed("7"), &mut state).await;
    assert_eq!(get_data(&resp)["result"]["headers"]["X-Test"], "second", "got: {resp}");

    assert_success(
        &execute_command(&json!({ "id": "8", "action": "navigate", "url": format!("{first_origin}/c") }), &mut state).await,
    );
    let resp = execute_command(&echoed("9"), &mut state).await;
    assert_eq!(get_data(&resp)["result"]["headers"]["X-Test"], "first", "got: {resp}");

    let _ = execute_command(&json!({ "id": "10", "action": "close" }), &mut state).await;
}

/// Headers passed via --headers on open persist for in-page fetch/XHR to
/// the same origin.
#[tokio::test]
#[ignore]
async fn e2e_headers_persist_same_origin_fetch() {
    let (base_url, _server) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate with --headers.
    let resp = execute_command(
        &json!({
            "id": "2", "action": "navigate",
            "url": format!("{}/page", base_url),
            "headers": { "X-Test": "fetched" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // In-page fetch to the same origin (relative URL).
    let resp = execute_command(
        &json!({
            "id": "3", "action": "page_evaluate",
            "script": "fetch('/echo').then(r => r.json())",
            "await": true,
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let result = &get_data(&resp)["result"];
    assert_eq!(
        result["headers"]["X-Test"], "fetched",
        "X-Test header should be present on in-page fetch to same origin"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Headers set via --headers do NOT leak to a different origin.
#[tokio::test]
#[ignore]
async fn e2e_headers_do_not_leak_cross_origin() {
    let (server_a, _ha) = start_echo_server().await;
    let (server_b, _hb) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to server A with --headers.
    let resp = execute_command(
        &json!({
            "id": "2", "action": "navigate",
            "url": format!("{}/page", server_a),
            "headers": { "X-Secret": "a-only" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to server B (different origin) without --headers.
    let resp = execute_command(
        &json!({
            "id": "3", "action": "navigate",
            "url": format!("{}/page", server_b),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "4", "action": "page_evaluate",
            "script": "JSON.parse(document.body.innerText)",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let result = &get_data(&resp)["result"];
    assert!(
        result["headers"].get("X-Secret").is_none(),
        "X-Secret header must NOT leak to a different origin, got: {}",
        result["headers"],
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// In-page fetch to a cross-origin URL must NOT include the origin-scoped
/// headers (sub-resource isolation).
#[tokio::test]
#[ignore]
async fn e2e_headers_do_not_leak_cross_origin_fetch() {
    let (server_a, _ha) = start_echo_server().await;
    let (server_b, _hb) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate to server A with --headers.
    let resp = execute_command(
        &json!({
            "id": "2", "action": "navigate",
            "url": format!("{}/page", server_a),
            "headers": { "X-Secret": "a-only" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Fetch from the page to server B (cross-origin sub-resource).
    let resp = execute_command(
        &json!({
            "id": "3", "action": "page_evaluate",
            "script": format!("fetch('{}/echo').then(r => r.json())", server_b),
            "await": true,
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let result = &get_data(&resp)["result"];
    assert!(
        result["headers"].get("X-Secret").is_none(),
        "X-Secret header must NOT leak to cross-origin fetch, got: {}",
        result["headers"],
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// `set headers` (global headers via the headers action) must not be
/// regressed — they should persist across navigations without being
/// cleared by the origin-scoped header logic.
#[tokio::test]
#[ignore]
async fn e2e_set_headers_not_regressed() {
    let (base_url, _server) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set global headers via the `headers` action (not --headers on navigate).
    let resp = execute_command(
        &json!({
            "id": "2", "action": "headers",
            "headers": { "X-Global": "everywhere" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate — global headers should be present.
    let resp = execute_command(
        &json!({
            "id": "3", "action": "navigate",
            "url": format!("{}/page", base_url),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "4", "action": "page_evaluate",
            "script": "JSON.parse(document.body.innerText)",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let result = &get_data(&resp)["result"];
    assert_eq!(
        result["headers"]["X-Global"], "everywhere",
        "Global headers set via `set headers` must persist across navigations"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Multiple origins each get their own independent headers.
#[tokio::test]
#[ignore]
async fn e2e_headers_multiple_origins_independent() {
    let (server_a, _ha) = start_echo_server().await;
    let (server_b, _hb) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set headers for origin A.
    let resp = execute_command(
        &json!({
            "id": "2", "action": "navigate",
            "url": format!("{}/page", server_a),
            "headers": { "X-From": "alpha" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set different headers for origin B.
    let resp = execute_command(
        &json!({
            "id": "3", "action": "navigate",
            "url": format!("{}/page", server_b),
            "headers": { "X-From": "beta" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Verify B got its own header.
    let resp = execute_command(
        &json!({ "id": "4", "action": "page_evaluate", "script": "JSON.parse(document.body.innerText)" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"]["headers"]["X-From"], "beta");

    // Navigate back to A — should get A's header, not B's.
    let resp = execute_command(
        &json!({ "id": "5", "action": "navigate", "url": format!("{}/check", server_a) }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "page_evaluate", "script": "JSON.parse(document.body.innerText)" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"]["headers"]["X-From"], "alpha");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Headers persist when navigating away to a different origin and back.
#[tokio::test]
#[ignore]
async fn e2e_headers_persist_after_roundtrip() {
    let (server_a, _ha) = start_echo_server().await;
    let (server_b, _hb) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set headers for origin A.
    let resp = execute_command(
        &json!({
            "id": "2", "action": "navigate",
            "url": format!("{}/page", server_a),
            "headers": { "X-Persist": "roundtrip" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate away to B (no headers).
    let resp = execute_command(
        &json!({ "id": "3", "action": "navigate", "url": format!("{}/page", server_b) }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Navigate back to A without --headers.
    let resp = execute_command(
        &json!({ "id": "4", "action": "navigate", "url": format!("{}/back", server_a) }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5", "action": "page_evaluate", "script": "JSON.parse(document.body.innerText)" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["result"]["headers"]["X-Persist"],
        "roundtrip",
        "Headers should persist after navigating away and back to the same origin"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Passing --headers a second time to the same origin replaces the previous headers.
#[tokio::test]
#[ignore]
async fn e2e_headers_override_same_origin() {
    let (base_url, _server) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set initial headers.
    let resp = execute_command(
        &json!({
            "id": "2", "action": "navigate",
            "url": format!("{}/first", base_url),
            "headers": { "X-Version": "v1" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Override with new headers.
    let resp = execute_command(
        &json!({
            "id": "3", "action": "navigate",
            "url": format!("{}/second", base_url),
            "headers": { "X-Version": "v2" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "4", "action": "page_evaluate", "script": "JSON.parse(document.body.innerText)" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["result"]["headers"]["X-Version"],
        "v2",
        "Second --headers should replace the first for the same origin"
    );

    // Subsequent navigation without --headers should use v2.
    let resp = execute_command(
        &json!({ "id": "5", "action": "navigate", "url": format!("{}/third", base_url) }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "page_evaluate", "script": "JSON.parse(document.body.innerText)" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"]["headers"]["X-Version"], "v2");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// `set headers` (global) and `--headers` (origin-scoped) stack together.
#[tokio::test]
#[ignore]
async fn e2e_global_and_scoped_headers_stack() {
    let (base_url, _server) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set global headers via `set headers`.
    let resp = execute_command(
        &json!({
            "id": "2", "action": "headers",
            "headers": { "X-Global": "everywhere" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Set origin-scoped headers via --headers.
    let resp = execute_command(
        &json!({
            "id": "3", "action": "navigate",
            "url": format!("{}/page", base_url),
            "headers": { "X-Scoped": "this-origin" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "4", "action": "page_evaluate", "script": "JSON.parse(document.body.innerText)" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let headers = &get_data(&resp)["result"]["headers"];
    assert_eq!(
        headers["X-Global"], "everywhere",
        "Global header should be present alongside scoped header"
    );
    assert_eq!(
        headers["X-Scoped"], "this-origin",
        "Scoped header should be present alongside global header"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Origin-scoped headers with different casing than the browser's original
/// request headers must not produce duplicates (HTTP headers are
/// case-insensitive per RFC 7230).
#[tokio::test]
#[ignore]
async fn e2e_headers_case_insensitive_no_duplicates() {
    let (base_url, _server) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Chrome sends "Accept: ..." by default on navigations. Pass "accept"
    // (lowercase) via --headers to verify the merge is case-insensitive
    // and doesn't produce a duplicate Accept header.
    let resp = execute_command(
        &json!({
            "id": "2", "action": "navigate",
            "url": format!("{}/page", base_url),
            "headers": { "accept": "application/test" },
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3", "action": "page_evaluate",
            "script": "JSON.parse(document.body.innerText)",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let result = &get_data(&resp)["result"]["headers"];

    // The echo server stores headers keyed by name as received on the wire.
    // If deduplication works, only our custom "accept" value should appear
    // (Chrome's original "Accept: text/html,..." should be suppressed).
    let accept_val = result
        .get("accept")
        .or_else(|| result.get("Accept"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert_eq!(
        accept_val, "application/test",
        "Case-insensitive merge should replace Chrome's Accept header, got headers: {}",
        result,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Regression: externally opened tabs must appear in tab_list (#1037)
//
// When connected to Chrome (launched or via --cdp), a tab opened outside of
// agent-browser (e.g. by the user or another CDP client) should be detected
// and listed. Previously, chrome://newtab/ was filtered by
// is_internal_chrome_target, and Target.targetInfoChanged for untracked
// targets was silently ignored.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_externally_opened_tab_detected() {
    let mut state = DaemonState::new();

    // Launch headless Chrome
    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Verify initial tab count
    let resp = execute_command(&json!({ "id": "2", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let initial_count = get_data(&resp)["tabs"].as_array().unwrap().len();

    // Simulate an external client opening a new tab via the browser-level CDP
    // session (no sessionId). This mirrors what happens when a user manually
    // opens a tab while agent-browser is connected via --cdp.
    let browser = state.browser.as_ref().expect("browser should be launched");
    let _: Value = browser
        .client
        .send_command(
            "Target.createTarget",
            Some(json!({ "url": "data:text/html,<h1>External Tab</h1>" })),
            None, // browser-level session
        )
        .await
        .expect("Target.createTarget should succeed");

    // Give Chrome a moment to fire targetCreated / targetInfoChanged events
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Drain events by issuing tab_list — this triggers execute_command's
    // drain_cdp_events path which processes new and changed targets.
    let resp = execute_command(&json!({ "id": "3", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();

    assert_eq!(
        tabs.len(),
        initial_count + 1,
        "Externally opened tab should appear in tab_list, got: {:?}",
        tabs,
    );

    // Verify the new tab's URL is the data URL we navigated to
    let new_tab = tabs.iter().find(|t| {
        t["url"]
            .as_str()
            .is_some_and(|u| u.starts_with("data:text/html"))
    });
    assert!(
        new_tab.is_some(),
        "Should find the externally opened tab by URL, tabs: {:?}",
        tabs,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Regression: issue #993 — launch options change must trigger relaunch
// ---------------------------------------------------------------------------

/// When the browser is already running and a second launch command arrives with
/// different options (e.g., extensions added), the daemon must relaunch the
/// browser instead of silently reusing the old one.
///
/// Before the fix, `handle_launch` only checked connection type and liveness,
/// so changed options like extensions were ignored and the old browser was reused.
#[tokio::test]
#[ignore]
async fn e2e_relaunch_on_options_change() {
    let mut state = DaemonState::new();

    // First launch — headless, no extensions.
    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["launched"], true);
    assert!(
        get_data(&resp).get("reused").is_none(),
        "first launch must not be a reuse"
    );

    // Second launch — same options → should reuse.
    let resp = execute_command(
        &json!({ "id": "2", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["reused"],
        true,
        "identical options must reuse the browser"
    );

    // Third launch — different options (userAgent changed) → must relaunch, not reuse.
    // We use userAgent instead of extensions because extensions force headed mode,
    // which requires a display server and fails in headless CI environments.
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "launch",
            "headless": true,
            "userAgent": "agent-browser-test/1.0"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(
        get_data(&resp).get("reused").is_none(),
        "changed options must trigger a relaunch, not reuse (issue #993)"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Stream: URL events follow active main-frame navigation
// ---------------------------------------------------------------------------

async fn start_stream_navigation_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stream navigation server should bind");
    let port = listener
        .local_addr()
        .expect("stream navigation server should have an address")
        .port();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 4096];
                let Ok(size) = stream.read(&mut buffer).await else {
                    return;
                };
                let request = String::from_utf8_lossy(&buffer[..size]);
                let request_target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let path = request_target.split('?').next().unwrap_or("/");
                if let Some(destination) = path.strip_prefix("/redirect/") {
                    let location = format!("/landed/{destination}");
                    let response = format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    return;
                }
                let body = match path {
                    "/child" => {
                        "<!doctype html><title>child</title><p id=\"child\">child</p>"
                    }
                    _ => {
                        "<!doctype html><title>main</title><a id=\"anchor\" href=\"#section\">anchor</a><div id=\"section\">section</div><iframe id=\"child\" src=\"/child\"></iframe>"
                    }
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), handle)
}

async fn next_stream_url(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> String {
    loop {
        let message = tokio::time::timeout(tokio::time::Duration::from_secs(5), ws.next())
            .await
            .expect("stream should emit a URL message")
            .expect("stream should stay open")
            .expect("stream message should be valid");
        if !message.is_text() {
            continue;
        }
        let payload: Value =
            serde_json::from_str(message.to_text().expect("message should be text"))
                .expect("stream payload should be JSON");
        if payload["type"] == "url" {
            return payload["url"]
                .as_str()
                .expect("URL message should carry a URL")
                .to_string();
        }
    }
}

async fn wait_for_stream_navigation_ready(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    loop {
        let message = tokio::time::timeout(tokio::time::Duration::from_secs(10), ws.next())
            .await
            .expect("stream navigation observer should become ready")
            .expect("stream should stay open")
            .expect("stream message should be valid");
        if !message.is_text() {
            continue;
        }
        let payload: Value =
            serde_json::from_str(message.to_text().expect("message should be text"))
                .expect("stream payload should be JSON");
        if payload["type"] == "status"
            && payload["connected"] == true
            && payload["screencasting"] == true
        {
            return;
        }
    }
}

async fn expect_no_stream_url(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    duration: tokio::time::Duration,
) {
    let deadline = tokio::time::Instant::now() + duration;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let result = tokio::time::timeout(remaining, ws.next()).await;
        let Ok(Some(Ok(message))) = result else {
            return;
        };
        if !message.is_text() {
            continue;
        }
        let payload: Value =
            serde_json::from_str(message.to_text().expect("message should be text"))
                .expect("stream payload should be JSON");
        assert_ne!(
            payload["type"], "url",
            "unexpected background or child URL: {payload}"
        );
    }
}

async fn next_collected_stream_message(
    messages: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    iteration: usize,
    phase: &str,
) -> Value {
    tokio::time::timeout(tokio::time::Duration::from_secs(5), messages.recv())
        .await
        .unwrap_or_else(|_| panic!("stress iteration {iteration} timed out during {phase}"))
        .unwrap_or_else(|| {
            panic!("stress iteration {iteration} stream collector stopped during {phase}")
        })
}

async fn wait_for_active_stream_tab(
    messages: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    tab_id: &str,
    iteration: usize,
) {
    loop {
        let payload =
            next_collected_stream_message(messages, iteration, "active-tab stream rebind").await;
        if payload["type"] != "tabs" {
            continue;
        }
        let is_active = payload["tabs"].as_array().is_some_and(|tabs| {
            tabs.iter()
                .any(|tab| tab["tabId"] == tab_id && tab["active"].as_bool() == Some(true))
        });
        if is_active {
            return;
        }
    }
}

async fn wait_for_stress_stream_url(
    messages: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    expected_url: &str,
    forbidden_marker: &str,
    iteration: usize,
) {
    loop {
        let payload =
            next_collected_stream_message(messages, iteration, "active URL convergence").await;
        if payload["type"] != "url" {
            continue;
        }
        let url = payload["url"]
            .as_str()
            .expect("stress URL payload should contain a URL");
        assert!(
            !url.contains(forbidden_marker),
            "stress iteration {iteration} attributed the previous tab URL to the new active tab: {payload}"
        );
        if url == expected_url {
            return;
        }
    }
}

async fn expect_no_forbidden_stream_url(
    messages: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    forbidden_marker: &str,
    iteration: usize,
) {
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(100);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Some(payload)) = tokio::time::timeout(remaining, messages.recv()).await else {
            return;
        };
        if payload["type"] != "url" {
            continue;
        }
        let url = payload["url"]
            .as_str()
            .expect("stress URL payload should contain a URL");
        assert!(
            !url.contains(forbidden_marker),
            "stress iteration {iteration} emitted a forbidden URL after convergence: {payload}"
        );
    }
}

async fn seeded_stream_tabs(port: u64, iteration: usize) -> Vec<Value> {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
        .await
        .expect("stress probe should connect to runtime stream");
    loop {
        let message = tokio::time::timeout(tokio::time::Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| {
                panic!("stress iteration {iteration} probe timed out waiting for tabs")
            })
            .expect("stress probe stream should stay open")
            .expect("stress probe message should be valid");
        if !message.is_text() {
            continue;
        }
        let payload: Value =
            serde_json::from_str(message.to_text().expect("probe message should be text"))
                .expect("probe stream payload should be JSON");
        if payload["type"] == "tabs" {
            return payload["tabs"]
                .as_array()
                .expect("probe tabs payload should be an array")
                .clone();
        }
    }
}

#[tokio::test]
#[ignore]
async fn e2e_screencast_stop_leaves_what_stream_viewers_are_watching() {
    let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_SESSION"]);
    let dir = tempfile::tempdir().unwrap();
    guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
    guard.set("AGENT_BROWSER_SESSION", "e2e-shared-cast");

    let (base_url, server) = start_stream_navigation_server().await;
    let mut state = DaemonState::new();
    let resp = execute_command(&json!({ "id": "1", "action": "stream_enable", "port": 0 }), &mut state).await;
    assert_success(&resp);
    let port = get_data(&resp)["port"].as_u64().unwrap();
    assert_success(
        &execute_command(&json!({ "id": "2", "action": "navigate", "url": format!("{base_url}/") }), &mut state).await,
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
        .await
        .unwrap();
    wait_for_stream_navigation_ready(&mut ws).await;

    assert_success(&execute_command(&json!({ "id": "3", "action": "screencast_start" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "4", "action": "screencast_stop" }), &mut state).await);

    let status = execute_command(&json!({ "id": "5", "action": "stream_status" }), &mut state).await;
    assert_eq!(get_data(&status)["screencasting"], true, "the viewer is still watching: {status}");

    drop(ws);
    let _ = execute_command(&json!({ "id": "6", "action": "close" }), &mut state).await;
    server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_stream_url_tracks_active_main_frame_navigation_categories() {
    let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_SESSION"]);
    let socket_dir = std::env::temp_dir().join(format!(
        "agent-browser-e2e-stream-url-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&socket_dir).expect("socket dir should be created");
    guard.set(
        "AGENT_BROWSER_SOCKET_DIR",
        socket_dir.to_str().expect("socket dir should be utf-8"),
    );
    guard.set("AGENT_BROWSER_SESSION", "e2e-stream-url");

    let (base_url, server) = start_stream_navigation_server().await;
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({ "id": "1", "action": "stream_enable", "port": 0 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let port = get_data(&resp)["port"]
        .as_u64()
        .expect("stream enable should report the bound port");

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": format!("{base_url}/") }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
        .await
        .expect("websocket client should connect to runtime stream");
    wait_for_stream_navigation_ready(&mut ws).await;

    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "page_evaluate",
            "script": "history.pushState({}, '', '/spa'); location.href"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(next_stream_url(&mut ws).await, format!("{base_url}/spa"));

    let resp = execute_command(
        &json!({
            "id": "4",
            "action": "page_evaluate",
            "script": "location.hash = 'section'; location.href"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        next_stream_url(&mut ws).await,
        format!("{base_url}/spa#section")
    );

    let resp = execute_command(
        &json!({
            "id": "5",
            "action": "page_evaluate",
            "script": "document.querySelector('#child').contentWindow.history.pushState({}, '', '/child-spa'); 'done'"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    expect_no_stream_url(&mut ws, tokio::time::Duration::from_millis(500)).await;

    let resp = execute_command(
        &json!({ "id": "6", "action": "navigate", "url": format!("{base_url}/full") }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(next_stream_url(&mut ws).await, format!("{base_url}/full"));

    let resp = execute_command(
        &json!({
            "id": "7",
            "action": "tab_new",
            "url": format!("{base_url}/")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let background_session = state
        .browser
        .as_ref()
        .expect("browser should exist")
        .pages_list()
        .into_iter()
        .find(|page| page.tab_id == 2)
        .expect("background tab should exist")
        .session_id;
    let resp = execute_command(
        &json!({ "id": "8", "action": "tab_switch", "tabId": "t1" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    while tokio::time::timeout(tokio::time::Duration::from_millis(100), ws.next())
        .await
        .is_ok()
    {}

    let resp = execute_command(
        &json!({
            "id": "9",
            "action": "page_evaluate",
            "script": "history.pushState({}, '', '/after-switch'); location.href"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        next_stream_url(&mut ws).await,
        format!("{base_url}/after-switch")
    );

    state
        .browser
        .as_ref()
        .expect("browser should exist")
        .client
        .send_command(
            "Page.navigate",
            Some(json!({ "url": format!("{base_url}/background-full") })),
            Some(&background_session),
        )
        .await
        .expect("background tab should navigate");
    expect_no_stream_url(&mut ws, tokio::time::Duration::from_millis(500)).await;

    state
        .browser
        .as_ref()
        .expect("browser should exist")
        .client
        .send_command(
            "Target.createTarget",
            Some(json!({ "url": format!("{base_url}/external") })),
            None,
        )
        .await
        .expect("external tab should open");
    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

    let resp = execute_command(&json!({ "id": "10", "action": "url" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], format!("{base_url}/external"));

    let external_session = state
        .browser
        .as_ref()
        .expect("browser should exist")
        .active_session_id()
        .expect("external tab should become active")
        .to_string();
    state
        .browser
        .as_ref()
        .expect("browser should exist")
        .client
        .send_command(
            "Runtime.evaluate",
            Some(json!({
                "expression": "history.pushState({}, '', '/external-spa'); location.href"
            })),
            Some(&external_session),
        )
        .await
        .expect("external tab should navigate within its document");
    assert_eq!(
        next_stream_url(&mut ws).await,
        format!("{base_url}/external-spa")
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    server.abort();
    let _ = std::fs::remove_dir_all(&socket_dir);
}

#[tokio::test]
#[ignore]
async fn e2e_lightpanda_stream_url_tracks_active_full_navigation() {
    let lightpanda_bin = match std::env::var("LIGHTPANDA_BIN") {
        Ok(path) if !path.is_empty() => path,
        _ => return,
    };
    let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_SESSION"]);
    let socket_dir = std::env::temp_dir().join(format!(
        "agent-browser-e2e-lightpanda-stream-url-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&socket_dir).expect("socket dir should be created");
    guard.set(
        "AGENT_BROWSER_SOCKET_DIR",
        socket_dir.to_str().expect("socket dir should be utf-8"),
    );
    guard.set("AGENT_BROWSER_SESSION", "e2e-lightpanda-stream-url");

    let (base_url, server) = start_stream_navigation_server().await;
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({ "id": "lp-stream", "action": "stream_enable", "port": 0 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let port = get_data(&resp)["port"]
        .as_u64()
        .expect("stream enable should report the bound port");

    let resp = tokio::time::timeout(
        tokio::time::Duration::from_secs(20),
        execute_command(
            &json!({
                "id": "lp-launch",
                "action": "launch",
                "headless": true,
                "engine": "lightpanda",
                "executablePath": lightpanda_bin
            }),
            &mut state,
        ),
    )
    .await
    .expect("Lightpanda stream launch should not hang");
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "lp-initial",
            "action": "navigate",
            "url": format!("{base_url}/lp-initial")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
        .await
        .expect("Lightpanda stream client should connect");
    while tokio::time::timeout(tokio::time::Duration::from_millis(100), ws.next())
        .await
        .is_ok()
    {}

    let active_before_background = format!("{base_url}/lp-active-before-background");
    let resp = execute_command(
        &json!({
            "id": "lp-active-before",
            "action": "navigate",
            "url": active_before_background
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(next_stream_url(&mut ws).await, active_before_background);

    let resp = execute_command(
        &json!({
            "id": "lp-child-navigation",
            "action": "page_evaluate",
            "script": "document.querySelector('#child').src = '/lp-forbidden-child'; 'done'"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    expect_no_stream_url(&mut ws, tokio::time::Duration::from_millis(500)).await;

    let tabs = seeded_stream_tabs(port, 0).await;
    let active = tabs
        .iter()
        .find(|tab| tab["active"].as_bool() == Some(true))
        .expect("Lightpanda reconnect should seed an active tab");
    assert_eq!(active["tabId"], "t1");
    assert_eq!(active["url"], active_before_background);

    let final_url = format!("{base_url}/lp-active-final");
    let resp = execute_command(
        &json!({
            "id": "lp-active-final",
            "action": "navigate",
            "url": final_url
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(next_stream_url(&mut ws).await, final_url);

    let resp = execute_command(&json!({ "id": "lp-close", "action": "close" }), &mut state).await;
    assert_success(&resp);
    server.abort();
    let _ = std::fs::remove_dir_all(&socket_dir);
}

#[tokio::test]
#[ignore]
async fn e2e_stream_url_survives_real_world_navigation_stress() {
    let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_SESSION"]);
    let socket_dir = std::env::temp_dir().join(format!(
        "agent-browser-e2e-stream-url-stress-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&socket_dir).expect("socket dir should be created");
    guard.set(
        "AGENT_BROWSER_SOCKET_DIR",
        socket_dir.to_str().expect("socket dir should be utf-8"),
    );
    guard.set("AGENT_BROWSER_SESSION", "e2e-stream-url-stress");

    let iterations = std::env::var("AGENT_BROWSER_STRESS_ITERATIONS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(40);
    let mut seed = std::env::var("AGENT_BROWSER_STRESS_SEED")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1677);

    let (base_url, server) = start_stream_navigation_server().await;
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({ "id": "stress-stream", "action": "stream_enable", "port": 0 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let port = get_data(&resp)["port"]
        .as_u64()
        .expect("stream enable should report the bound port");

    let resp = execute_command(
        &json!({
            "id": "stress-tab-a",
            "action": "navigate",
            "url": format!("{base_url}/app-a")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({
            "id": "stress-tab-b",
            "action": "tab_new",
            "url": format!("{base_url}/app-b")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let pages = state
        .browser
        .as_ref()
        .expect("stress browser should exist")
        .pages_list();
    let session_a = pages
        .iter()
        .find(|page| page.tab_id == 1)
        .expect("stress tab A should exist")
        .session_id
        .clone();
    let session_b = pages
        .iter()
        .find(|page| page.tab_id == 2)
        .expect("stress tab B should exist")
        .session_id
        .clone();
    let client = Arc::clone(
        &state
            .browser
            .as_ref()
            .expect("stress browser should exist")
            .client,
    );

    let (fast_ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
        .await
        .expect("stress collector should connect to runtime stream");
    let (message_tx, mut messages) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let collector = tokio::spawn(async move {
        let mut ws = fast_ws;
        while let Some(Ok(message)) = ws.next().await {
            if !message.is_text() {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<Value>(
                message.to_text().expect("collector message should be text"),
            ) else {
                continue;
            };
            if message_tx.send(payload).is_err() {
                break;
            }
        }
    });
    wait_for_active_stream_tab(&mut messages, "t2", 0).await;

    let (mut slow_ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
        .await
        .expect("slow stress client should connect to runtime stream");

    let mut active_tab = "t2";
    for iteration in 0..iterations {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let delay_ms = 1 + (seed % 12);
        let target_tab = if active_tab == "t1" { "t2" } else { "t1" };
        let old_session = if active_tab == "t1" {
            session_a.clone()
        } else {
            session_b.clone()
        };
        let forbidden_marker = format!("forbidden-{iteration}");
        let same_document_path = format!("/{forbidden_marker}-old-spa");
        let redirect_url = format!("{base_url}/redirect/{forbidden_marker}-old-full");

        let late_client = Arc::clone(&client);
        let late_session = old_session.clone();
        let late_same_document_path = same_document_path.clone();
        let late_child_marker = forbidden_marker.clone();
        let late_same_document = tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
            let expression = format!(
                "history.pushState({{}}, '', {}); const child = document.querySelector('#child'); if (child?.contentWindow) child.contentWindow.history.pushState({{}}, '', '/{late_child_marker}-old-child'); location.href",
                serde_json::to_string(&late_same_document_path)
                    .expect("stress path should serialize")
            );
            late_client
                .send_command(
                    "Runtime.evaluate",
                    Some(json!({ "expression": expression })),
                    Some(&late_session),
                )
                .await
        });

        let redirect_client = Arc::clone(&client);
        let redirect_session = old_session.clone();
        let late_redirect = tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms + 1)).await;
            redirect_client
                .send_command(
                    "Page.navigate",
                    Some(json!({ "url": redirect_url })),
                    Some(&redirect_session),
                )
                .await
        });

        let resp = execute_command(
            &json!({
                "id": format!("stress-switch-{iteration}"),
                "action": "tab_switch",
                "tabId": target_tab
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        wait_for_active_stream_tab(&mut messages, target_tab, iteration).await;
        tokio::time::timeout(tokio::time::Duration::from_secs(5), late_same_document)
            .await
            .unwrap_or_else(|_| panic!("stress iteration {iteration} late SPA task timed out"))
            .expect("late SPA task should join")
            .expect("late SPA CDP command should succeed");
        tokio::time::timeout(tokio::time::Duration::from_secs(5), late_redirect)
            .await
            .unwrap_or_else(|_| panic!("stress iteration {iteration} late redirect task timed out"))
            .expect("late redirect task should join")
            .expect("late redirect CDP command should succeed");

        let resp = execute_command(
            &json!({
                "id": format!("stress-child-{iteration}"),
                "action": "page_evaluate",
                "script": format!(
                    "const child = document.querySelector('#child'); if (!child?.contentWindow) throw new Error('missing stress iframe'); child.contentWindow.history.pushState({{}}, '', '/{forbidden_marker}-active-child'); 'done'"
                )
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let expected_url = format!("{base_url}/{target_tab}-active-{iteration}");
        let resp = execute_command(
            &json!({
                "id": format!("stress-active-{iteration}"),
                "action": "page_evaluate",
                "script": format!(
                    "history.replaceState({{}}, '', {}); location.href",
                    serde_json::to_string(&expected_url).expect("stress URL should serialize")
                )
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        wait_for_stress_stream_url(&mut messages, &expected_url, &forbidden_marker, iteration)
            .await;

        let resp = execute_command(
            &json!({ "id": format!("stress-url-{iteration}"), "action": "url" }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert_eq!(
            get_data(&resp)["url"],
            expected_url,
            "stress iteration {iteration} active browser URL diverged"
        );
        expect_no_forbidden_stream_url(&mut messages, &forbidden_marker, iteration).await;

        if iteration % 5 == 0 {
            let tabs = seeded_stream_tabs(port, iteration).await;
            let active = tabs
                .iter()
                .find(|tab| tab["active"].as_bool() == Some(true))
                .unwrap_or_else(|| {
                    panic!("stress iteration {iteration} reconnect had no active tab")
                });
            assert_eq!(
                active["tabId"], target_tab,
                "stress iteration {iteration} reconnect seeded the wrong active tab"
            );
            assert_eq!(
                active["url"], expected_url,
                "stress iteration {iteration} reconnect seeded a stale URL"
            );
        }

        if iteration % 7 == 6 {
            drop(slow_ws);
            let (replacement, _) =
                tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
                    .await
                    .expect("replacement slow stress client should connect");
            slow_ws = replacement;
        }

        active_tab = target_tab;
    }

    drop(slow_ws);
    collector.abort();
    let resp = execute_command(
        &json!({ "id": "stress-close", "action": "close" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    server.abort();
    let _ = std::fs::remove_dir_all(&socket_dir);
}

// ---------------------------------------------------------------------------
// Stream: custom viewport is reflected in screencast frame metadata
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_stream_frame_metadata_respects_custom_viewport() {
    let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_SESSION"]);
    let socket_dir = std::env::temp_dir().join(format!(
        "agent-browser-e2e-stream-viewport-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&socket_dir).expect("socket dir should be created");
    guard.set(
        "AGENT_BROWSER_SOCKET_DIR",
        socket_dir.to_str().expect("socket dir should be utf-8"),
    );
    guard.set("AGENT_BROWSER_SESSION", "e2e-stream-viewport");

    let mut state = DaemonState::new();

    // Enable stream on an ephemeral port
    let resp = execute_command(
        &json!({ "id": "1", "action": "stream_enable", "port": 0 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let port = get_data(&resp)["port"]
        .as_u64()
        .expect("stream enable should report the bound port");

    // Set a custom viewport before launching the browser
    let resp = execute_command(
        &json!({ "id": "2", "action": "viewport", "width": 800, "height": 600 }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Connect a WebSocket client
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
        .await
        .expect("websocket client should connect to runtime stream");

    // Navigate to trigger browser launch and screencast
    let resp = execute_command(
        &json!({ "id": "3", "action": "navigate", "url": "data:text/html,<h1>Viewport Test</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Wait for a frame whose JPEG dimensions match the custom viewport.
    // Early frames may arrive before Chrome fully applies the viewport resize,
    // so skip frames with stale dimensions rather than failing immediately.
    let mut found_frame = false;
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        let msg = tokio::time::timeout(tokio::time::Duration::from_secs(3), ws.next()).await;
        let Some(Ok(message)) = msg.ok().flatten() else {
            continue;
        };
        if !message.is_text() {
            continue;
        }
        let parsed: Value =
            serde_json::from_str(message.to_text().expect("text message should be readable"))
                .expect("stream payload should be valid JSON");
        if parsed.get("type") == Some(&json!("frame")) {
            let meta = &parsed["metadata"];
            assert_eq!(
                meta["deviceWidth"], 800,
                "frame metadata deviceWidth should match custom viewport, got: {}",
                meta
            );
            assert_eq!(
                meta["deviceHeight"], 600,
                "frame metadata deviceHeight should match custom viewport, got: {}",
                meta
            );

            let data_str = parsed
                .get("data")
                .and_then(|v| v.as_str())
                .expect("frame message should include base64-encoded 'data' field");
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_str)
                .expect("frame data should be valid base64");
            let (img_w, img_h) =
                jpeg_dimensions(&bytes).expect("frame data should be a valid JPEG with SOF marker");
            if img_w != 800 || img_h != 600 {
                continue;
            }

            found_frame = true;
            break;
        }
    }
    assert!(
        found_frame,
        "should have received a frame with JPEG dimensions 800x600 within the deadline"
    );

    // Cleanup
    let resp = execute_command(
        &json!({ "id": "4", "action": "stream_disable" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    let _ = std::fs::remove_dir_all(&socket_dir);
}

// ---------------------------------------------------------------------------
// Stream: a click is not queued behind a mouse sweep
// ---------------------------------------------------------------------------

/// Guards the no-await dispatch. Awaiting Chrome's reply per event serialized
/// the reader, so a click arrived one CDP round trip behind every mousemove
/// ahead of it: 300 moves delayed it by ~2.5s. Measured at ~6ms with the fix,
/// so the threshold has three orders of magnitude of headroom and fails only on
/// a real regression.
#[tokio::test]
#[ignore]
async fn e2e_stream_click_is_not_queued_behind_a_mouse_sweep() {
    let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_SESSION"]);
    let socket_dir = std::env::temp_dir().join(format!(
        "agent-browser-e2e-stream-latency-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&socket_dir).expect("socket dir should be created");
    guard.set(
        "AGENT_BROWSER_SOCKET_DIR",
        socket_dir.to_str().expect("socket dir should be utf-8"),
    );
    guard.set("AGENT_BROWSER_SESSION", "e2e-stream-latency");

    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "stream_enable", "port": 0 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let port = get_data(&resp)["port"]
        .as_u64()
        .expect("stream enable should report the bound port");

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>latency</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Record the arrival time of the first mousedown inside the page.
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "page_evaluate",
            "script": "window.__down = null; document.addEventListener('mousedown', () => { if (window.__down === null) window.__down = Date.now(); }); 'armed'"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token={}", super::stream::stream_token()))
        .await
        .expect("websocket client should connect to runtime stream");
    let _ = tokio::time::timeout(tokio::time::Duration::from_secs(5), ws.next()).await;

    // A sweep of moves, then the click that must not wait for them.
    for i in 0..300 {
        let mv = json!({
            "type": "input_mouse", "eventType": "mouseMoved",
            "x": 100 + (i % 400), "y": 100 + (i % 300),
            "button": "none", "clickCount": 0
        });
        ws.send(Message::Text(mv.to_string()))
            .await
            .expect("mouse move should be accepted by the stream socket");
    }
    let sent_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock should be after unix epoch")
        .as_millis() as u64;
    for event in ["mousePressed", "mouseReleased"] {
        let click = json!({
            "type": "input_mouse", "eventType": event,
            "x": 200, "y": 200, "button": "left", "clickCount": 1
        });
        ws.send(Message::Text(click.to_string()))
            .await
            .expect("click should be accepted by the stream socket");
    }

    // Poll the page for the recorded arrival time.
    let mut latency_ms: Option<u64> = None;
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline && latency_ms.is_none() {
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        let resp = execute_command(
            &json!({ "id": "4", "action": "page_evaluate", "script": "window.__down" }),
            &mut state,
        )
        .await;
        if let Some(down) = get_data(&resp)["result"].as_u64() {
            latency_ms = Some(down.saturating_sub(sent_at_ms));
        }
    }

    let latency = latency_ms.expect("the click should reach the page within the deadline");
    assert!(
        latency < 500,
        "click landed {latency}ms after a 300-event mouse sweep; input dispatch is waiting on CDP replies again"
    );

    let resp = execute_command(
        &json!({ "id": "98", "action": "stream_disable" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    let _ = std::fs::remove_dir_all(&socket_dir);
}

/// Extract width and height from a JPEG's SOF0 (0xFFC0) or SOF2 (0xFFC2) marker.
fn jpeg_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    for i in 0..data.len().saturating_sub(8) {
        if data[i] == 0xFF && (data[i + 1] == 0xC0 || data[i + 1] == 0xC2) {
            let height = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
            let width = u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32;
            return Some((width, height));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Upload: ref-based selector support (issue #1107)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn e2e_upload_with_ref_selector() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": native_test_fixture_url("upload_probe") }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();

    // Match by label text, not by role which may vary across Chrome versions
    let file_input_ref = snapshot
        .lines()
        .filter_map(|line| {
            if line.contains("Choose file") && line.contains("ref=") {
                let start = line.find("ref=")? + 4;
                let end = line[start..].find(']')? + start;
                Some(line[start..end].to_string())
            } else {
                None
            }
        })
        .next()
        .expect("Snapshot should contain the file input with a ref");

    let tmp = crate::native::file_root::root().join(format!("ab-upload-ref-{}.txt", std::process::id()));
    std::fs::create_dir_all(crate::native::file_root::root()).unwrap();
    std::fs::write(&tmp, "test").unwrap();

    let resp = execute_command(
        &json!({ "id": "4", "action": "upload", "selector": file_input_ref, "files": [tmp.to_string_lossy()] }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["uploaded"], 1);

    let _ = std::fs::remove_file(&tmp);
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_upload_with_css_selector() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": native_test_fixture_url("upload_probe") }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let tmp = crate::native::file_root::root().join(format!("ab-upload-css-{}.txt", std::process::id()));
    std::fs::create_dir_all(crate::native::file_root::root()).unwrap();
    std::fs::write(&tmp, "test").unwrap();

    let resp = execute_command(
        &json!({ "id": "3", "action": "upload", "selector": "#fileInput", "files": [tmp.to_string_lossy()] }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["uploaded"], 1);

    let _ = std::fs::remove_file(&tmp);
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Recording: default records the current active page
// ---------------------------------------------------------------------------

/// `recording_start` attaches the recorder to the active page
/// as-is: no new browser context, no new tab, no navigation. Page state set
/// before `record start` must survive, and the viewport must be untouched.
#[tokio::test]
#[ignore]
async fn e2e_recording_default_records_active_page() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let page_url = "data:text/html,<h1>Current</h1>";
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": page_url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "viewport", "width": 800, "height": 600 }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // In-memory page state: a cold navigation or a new page would lose this.
    let resp = execute_command(
        &json!({ "id": "4", "action": "page_evaluate", "script": "window.__abMarker = 42; window.__abMarker" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], 42);

    let tmp_dir = std::env::temp_dir();
    let rec_path = tmp_dir.join(format!("ab-e2e-rec-current-{}.webm", std::process::id()));
    let resp = execute_command(
        &json!({ "id": "5", "action": "recording_start", "path": rec_path.to_string_lossy() }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    tokio::time::sleep(tokio::time::Duration::from_millis(700)).await;

    // Still exactly one tab: no recording tab was added.
    let resp = execute_command(&json!({ "id": "6", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(
        tabs.len(),
        1,
        "default record start must not open a new tab, got {tabs:?}"
    );

    // Same page, same JS heap: the marker survived and the URL is unchanged.
    let resp = execute_command(
        &json!({ "id": "7", "action": "page_evaluate", "script": "window.__abMarker" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["result"],
        42,
        "default record start must not navigate or replace the page"
    );

    let resp = execute_command(
        &json!({ "id": "8", "action": "page_evaluate", "script": "location.href" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], page_url);

    let resp = execute_command(
        &json!({ "id": "9", "action": "page_evaluate", "script": "[window.innerWidth, window.innerHeight]" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], json!([800, 600]));

    let resp = execute_command(
        &json!({ "id": "10", "action": "recording_stop" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(
        get_data(&resp)["frames"].as_u64().unwrap_or(0) > 0,
        "recorder attached to the active page should have captured frames"
    );

    let _ = std::fs::remove_file(&rec_path);
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// `recording_start` with a URL navigates the active
/// tab to that URL before recording. No new tab is created.
#[tokio::test]
#[ignore]
async fn e2e_recording_default_with_url_navigates_active_tab() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": "data:text/html,<button id='before'>Before</button>"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Refs from the page being replaced must not survive the navigation.
    let resp = execute_command(
        &json!({ "id": "2b", "action": "snapshot", "selector": "#before" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(state.ref_map.get("e1").is_some());

    let target_url = "data:text/html,<h1>Recorded</h1>";
    let tmp_dir = std::env::temp_dir();
    let rec_path = tmp_dir.join(format!("ab-e2e-rec-url-{}.webm", std::process::id()));
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "recording_start",
            "path": rec_path.to_string_lossy(),
            "url": target_url
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(
        state.ref_map.entries_sorted().is_empty(),
        "record start <url> must clear refs like navigate does"
    );

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    let resp = execute_command(&json!({ "id": "4", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(
        tabs.len(),
        1,
        "record start <url> must reuse the active tab"
    );

    let resp = execute_command(
        &json!({ "id": "5", "action": "page_evaluate", "script": "location.href" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], target_url);

    let resp = execute_command(
        &json!({ "id": "6", "action": "recording_stop" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let _ = std::fs::remove_file(&rec_path);
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// Recording: requested frame rate
// ---------------------------------------------------------------------------

/// Verify that a requested frame rate sets the timestamp resolution without
/// filling a static recording with duplicate encoded frames.
#[tokio::test]
#[ignore]
async fn e2e_recording_honors_requested_fps() {
    const FPS: u64 = 60;
    const RECORD_MS: u64 = 1000;

    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Frame rate</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let tmp_dir = std::env::temp_dir();
    let rec_path = tmp_dir.join(format!("ab-e2e-rec-fps-{}.webm", std::process::id()));
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "recording_start",
            "path": rec_path.to_string_lossy(),
            "fps": FPS,
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["fps"].as_u64(), Some(FPS));

    // The recorder screencasts on its own CDP session attached to the
    // active page. That attachment must not surface as a tab.
    let resp = execute_command(&json!({ "id": "3b", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap().len();
    assert_eq!(tabs, 1, "the recorded page only, nothing else");

    tokio::time::sleep(tokio::time::Duration::from_millis(RECORD_MS)).await;

    let resp = execute_command(
        &json!({ "id": "4", "action": "recording_stop" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["fps"].as_u64(), Some(FPS));

    let frames = data["frames"].as_u64().unwrap();
    assert!(
        (FPS * 8 / 10..FPS * 15 / 10).contains(&frames),
        "static page should repeat frames at {FPS} fps, got {frames}"
    );
    let captured = data["capturedFrames"].as_u64().unwrap();
    assert!(captured >= 1, "static page should produce an initial frame");

    let size = std::fs::metadata(&rec_path).map(|m| m.len()).unwrap_or(0);
    assert!(size > 0, "recording file should not be empty");
    let probe = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(&rec_path)
        .output()
        .expect("ffprobe should inspect the recording");
    assert!(probe.status.success());
    let duration: f64 = String::from_utf8_lossy(&probe.stdout)
        .trim()
        .parse()
        .expect("ffprobe duration should be numeric");
    assert!(
        (0.8..1.5).contains(&duration),
        "recording should retain wall-clock duration, got {duration}"
    );
    assert!(
        (duration - frames as f64 / FPS as f64).abs() < 0.03,
        "{frames} frames at {FPS} fps should match duration {duration}"
    );

    let _ = std::fs::remove_file(&rec_path);
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Verify that an output path without an extension is rejected before the
/// recording context exists: no new tab, no file, nothing to stop.
/// A stand-in for ffmpeg, so the take's lifecycle can run where ffmpeg isn't installed: it saves what it's piped.
fn fake_ffmpeg_on_path(guard: &EnvGuard<'static>) -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("ffmpeg");
    std::fs::write(&fake, "#!/bin/sh\n[ \"$1\" = -version ] && exit 0\nfor a; do out=$a; done\ncat > \"$out\"\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    guard.set("PATH", &format!("{}:/usr/bin:/bin", dir.path().display()));
    dir
}

/// `record restart` is told to go to a page that can't load: the take it would have ended is still recording.
#[tokio::test]
#[ignore]
async fn e2e_a_restart_that_cannot_navigate_keeps_the_take() {
    let guard = EnvGuard::new(&["PATH"]);
    let files = fake_ffmpeg_on_path(&guard);
    let mut state = DaemonState::new();
    assert_success(
        &execute_command(
            &json!({ "id": "1", "action": "launch", "headless": true, "args": ["--no-sandbox", "--disable-dev-shm-usage"] }),
            &mut state,
        )
        .await,
    );
    let first = files.path().join("first.webm").to_string_lossy().into_owned();
    let second = files.path().join("second.webm").to_string_lossy().into_owned();
    assert_success(&execute_command(&json!({ "id": "2", "action": "recording_start", "path": first }), &mut state).await);

    let resp = execute_command(
        &json!({ "id": "3", "action": "recording_restart", "path": second, "url": "http://127.0.0.1:1/" }),
        &mut state,
    )
    .await;

    assert_eq!(resp["success"], false, "got: {resp}");
    assert!(state.recording_state.active, "the take being kept must not stop for a restart that failed");
    assert_eq!(state.recording_state.output_path, first);
    let take = execute_command(&json!({ "id": "4", "action": "recording_stop" }), &mut state).await;
    assert_success(&take);
    assert_eq!(get_data(&take)["path"], first);
    let _ = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
}

/// `close` finishes a take and says where it went; the next `record start` isn't told one is active.
#[tokio::test]
#[ignore]
async fn e2e_close_finishes_a_take() {
    let guard = EnvGuard::new(&["PATH"]);
    let files = fake_ffmpeg_on_path(&guard);
    let mut state = DaemonState::new();
    let launch = json!({ "id": "1", "action": "launch", "headless": true, "args": ["--no-sandbox", "--disable-dev-shm-usage"] });
    assert_success(&execute_command(&launch, &mut state).await);
    let path = files.path().join("take.webm").to_string_lossy().into_owned();
    assert_success(&execute_command(&json!({ "id": "2", "action": "recording_start", "path": path }), &mut state).await);

    let closed = execute_command(&json!({ "id": "3", "action": "close" }), &mut state).await;

    assert_success(&closed);
    assert!(closed["warning"].as_str().unwrap_or_default().contains(&path), "got: {closed}");
    assert!(!std::fs::read(&path).unwrap().is_empty(), "the file must be finished");
    assert_success(&execute_command(&launch, &mut state).await);
    let next = files.path().join("next.webm").to_string_lossy().into_owned();
    assert_success(&execute_command(&json!({ "id": "4", "action": "recording_start", "path": next }), &mut state).await);
    let _ = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
}

#[tokio::test]
#[ignore]
async fn e2e_recording_rejects_extensionless_path_before_context() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let rec_path = std::env::temp_dir().join(format!("ab-e2e-rec-noext-{}", std::process::id()));
    let resp = execute_command(
        &json!({ "id": "2", "action": "recording_start", "path": rec_path.to_string_lossy() }),
        &mut state,
    )
    .await;
    assert_eq!(resp.get("success").and_then(|v| v.as_bool()), Some(false));
    let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("");
    assert!(
        err.contains("no extension"),
        "error should explain the path: {}",
        err
    );
    assert!(!rec_path.exists(), "no file should be created");
    assert!(!state.recording_state.active);

    let resp = execute_command(&json!({ "id": "3", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap().len();
    assert_eq!(
        tabs, 1,
        "a rejected path must not leave a recording tab behind"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Verify that a missing ffmpeg fails `recording_start` itself before an
/// optional navigation, and leaves the state ready for the next start.
#[tokio::test]
#[ignore]
async fn e2e_recording_fails_fast_without_ffmpeg() {
    let guard = EnvGuard::new(&["PATH"]);
    let original_path = std::env::var("PATH").unwrap_or_default();
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let before_url = "data:text/html,<h1>Before</h1>";
    let after_url = "data:text/html,<h1>After</h1>";
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": before_url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let tmp_dir = std::env::temp_dir();
    let rec_path = tmp_dir.join(format!("ab-e2e-rec-noffmpeg-{}.webm", std::process::id()));

    // A PATH with no ffmpeg on it. Chrome is already running, so nothing else
    // needs resolving.
    let empty_dir = tmp_dir.join(format!("ab-e2e-empty-path-{}", std::process::id()));
    std::fs::create_dir_all(&empty_dir).unwrap();
    guard.set("PATH", &empty_dir.to_string_lossy());

    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "recording_start",
            "path": rec_path.to_string_lossy(),
            "url": after_url
        }),
        &mut state,
    )
    .await;
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "record start must fail without ffmpeg: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );
    let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("");
    assert!(err.contains("ffmpeg"), "error should name ffmpeg: {}", err);
    assert!(
        !state.recording_state.active,
        "failed start must not leave the recording active"
    );
    let resp = execute_command(
        &json!({ "id": "4", "action": "page_evaluate", "script": "location.href" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["result"],
        before_url,
        "ffmpeg preflight must fail before the requested navigation"
    );

    // With ffmpeg back, the same start succeeds: nothing stale was left behind.
    guard.set("PATH", &original_path);
    let resp = execute_command(
        &json!({
            "id": "5",
            "action": "recording_start",
            "path": rec_path.to_string_lossy(),
            "url": after_url
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    let resp = execute_command(
        &json!({ "id": "6", "action": "recording_stop" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let _ = std::fs::remove_file(&rec_path);
    let _ = std::fs::remove_dir(&empty_dir);
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Verify that an out-of-range frame rate is rejected before the recorder
/// builds its context or attaches to the page, leaving no file and no active
/// recording behind.
#[tokio::test]
#[ignore]
async fn e2e_recording_rejects_invalid_fps() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let tmp_dir = std::env::temp_dir();
    let rec_path = tmp_dir.join(format!("ab-e2e-rec-badfps-{}.webm", std::process::id()));
    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "recording_start",
            "path": rec_path.to_string_lossy(),
            "fps": 240,
        }),
        &mut state,
    )
    .await;
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "240 fps should be rejected: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );
    let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("");
    assert!(err.contains("fps"), "error should name the field: {}", err);
    assert!(!rec_path.exists(), "no file should be created");

    // Nothing was started, so there is nothing to stop.
    let resp = execute_command(
        &json!({ "id": "3", "action": "recording_stop" }),
        &mut state,
    )
    .await;
    assert_eq!(resp.get("success").and_then(|v| v.as_bool()), Some(false));

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Verify the composited pointer and changed-frame contact sheet through the
/// full daemon pipeline.
#[tokio::test]
#[ignore]
async fn e2e_recording_cursor_and_contact_sheet() {
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = r#"data:text/html,<style>body{margin:0;background:%23f3f4f6;font-family:sans-serif}.card{margin:80px;padding:48px;background:white;border-radius:24px}button{padding:18px 28px;background:%232563eb;color:white;border:0;border-radius:12px}</style><div class=card><h1>Contact sheet demo</h1><p>Review important visual changes at a glance.</p><button>Continue</button></div>"#;
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let rec_path = std::env::temp_dir().join(format!(
        "ab-e2e-rec-contact-sheet-{}.webm",
        std::process::id()
    ));
    let sheet_path = rec_path.with_file_name(format!(
        "{}.contact-sheet.png",
        rec_path.file_stem().unwrap().to_string_lossy()
    ));
    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "recording_start",
            "path": rec_path.to_string_lossy(),
            "cursor": true,
            "contactSheet": true,
            "contactSheetThreshold": 0.01
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["cursor"], true);
    assert_eq!(get_data(&resp)["contactSheet"], true);

    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
    let resp = execute_command(
        &json!({ "id": "4", "action": "page_evaluate", "script": "Boolean(document.getElementById('__agent_browser_recording_cursor__'))" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], false);

    let resp = execute_command(
        &json!({ "id": "5", "action": "mousemove", "x": 360, "y": 260 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let cursor = state
        .recording_state
        .shared_cursor
        .lock()
        .unwrap()
        .at(super::recording::cursor_timestamp());
    assert!(cursor.visible);
    assert_eq!((cursor.x, cursor.y), (360.0, 260.0));
    let resp = execute_command(
        &json!({ "id": "6", "action": "page_evaluate", "script": "document.querySelector('.card').style.background='#dbeafe'; document.querySelector('h1').textContent='Ready to continue'; true" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(tokio::time::Duration::from_millis(350)).await;
    let resp = execute_command(
        &json!({ "id": "7", "action": "page_evaluate", "script": "document.querySelector('.card').style.background='#dcfce7'; document.querySelector('p').textContent='The important region is highlighted.'; true" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(tokio::time::Duration::from_millis(350)).await;

    let resp = execute_command(
        &json!({ "id": "8", "action": "recording_stop" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(
        data["contactSheetPath"],
        sheet_path.to_string_lossy().as_ref()
    );
    assert!(data["contactSheetFrames"].as_u64().unwrap_or(0) >= 2);
    assert!(std::fs::metadata(&rec_path).unwrap().len() > 0);
    let sheet = image::open(&sheet_path).expect("contact sheet should be a valid PNG");
    assert!(sheet.width() >= 320);
    assert!(sheet.height() >= 150);
    if let Some(example_path) = std::env::var_os("AGENT_BROWSER_CONTACT_SHEET_EXAMPLE_PATH") {
        let example_path = std::path::PathBuf::from(example_path);
        if let Some(parent) = example_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::copy(&sheet_path, example_path).unwrap();
    }

    let resp = execute_command(
        &json!({ "id": "9", "action": "page_evaluate", "script": "Boolean(document.getElementById('__agent_browser_recording_cursor__'))" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], false);

    let _ = std::fs::remove_file(&rec_path);
    let _ = std::fs::remove_file(&sheet_path);
    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// The cursor must not intercept clicks, leak into snapshots, or survive stop.
#[tokio::test]
#[ignore]
async fn e2e_recording_cursor_overlay_lifecycle() {
    let mut state = DaemonState::new();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cursor-lifecycle.mp4");
    let url =
        "data:text/html,<button id=keep onclick='window.clicks=(window.clicks||0)+1'>Keep</button>";
    for command in [
        json!({"action":"launch","headless":true}),
        json!({"action":"navigate","url":url}),
        json!({"action":"recording_start","path":path,"cursor":true}),
        json!({"action":"click","selector":"#keep"}),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let inspected = execute_command(&json!({"action": "page_evaluate","script":"(() => { const host = document.querySelector('[data-agent-browser-recording-cursor]'); return !!host && host.inert && host.getAttribute('aria-hidden') === 'true' && host.shadowRoot === null && typeof globalThis.__agentBrowserRecordingCursorCleanup === 'undefined' && window.clicks === 1; })()"}), &mut state).await;
    assert_success(&inspected);
    assert_eq!(get_data(&inspected)["result"], true);
    let snapshot = execute_command(&json!({"action":"snapshot"}), &mut state).await;
    assert_success(&snapshot);
    assert!(!get_data(&snapshot)
        .to_string()
        .contains("agent-browser-recording-cursor"));
    assert_success(
        &execute_command(
            &json!({"action":"navigate","url":"data:text/html,<button>After navigation</button>"}),
            &mut state,
        )
        .await,
    );
    let after_navigation = execute_command(&json!({"action": "page_evaluate","script":"document.querySelectorAll('[data-agent-browser-recording-cursor]').length"}), &mut state).await;
    let stopped = execute_command(&json!({"action":"recording_stop"}), &mut state).await;
    let after_stop = execute_command(&json!({"action": "page_evaluate","script":"document.querySelectorAll('[data-agent-browser-recording-cursor]').length"}), &mut state).await;
    assert_success(&execute_command(&json!({"action":"navigate","url":url}), &mut state).await);
    let after_next_navigation = execute_command(&json!({"action": "page_evaluate","script":"document.querySelectorAll('[data-agent-browser-recording-cursor]').length"}), &mut state).await;
    assert_success(&execute_command(&json!({"action":"close"}), &mut state).await);
    assert_success(&stopped);
    assert_eq!(get_data(&after_navigation)["result"], 1);
    assert_eq!(get_data(&after_stop)["result"], 0);
    assert_eq!(get_data(&after_next_navigation)["result"], 0);
}

/// Check every encoded frame while a real page control follows drag input.
#[tokio::test]
#[ignore]
async fn e2e_recording_cursor_stays_aligned_during_drag() {
    let mut state = DaemonState::new();
    for command in [
        json!({ "action": "launch", "headless": true }),
        json!({ "action": "viewport", "width": 640, "height": 480 }),
        json!({
            "action": "navigate",
            "url": "data:text/html,<style>body{margin:0;background:%23303030}div{position:fixed;left:80px;top:0;width:2px;height:100vh;background:%2300ff00}</style><div></div><script>document.addEventListener('pointermove',e=>{if(e.buttons)document.querySelector('div').style.left=e.clientX+'px'})</script>"
        }),
        json!({ "action": "mousemove", "x": 80, "y": 240 }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("drag-cursor.mp4");
    assert_success(
        &execute_command(
            &json!({ "action": "recording_start", "path": path, "cursor": true, "fps": 60 }),
            &mut state,
        )
        .await,
    );
    assert_success(&execute_command(&json!({ "action": "mousedown" }), &mut state).await);
    for x in [560, 80, 560] {
        assert_success(
            &execute_command(
                &json!({ "action": "mousemove", "x": x, "y": 240, "duration": 1000, "inputMode": "human", "seed": 42 }),
                &mut state,
            )
            .await,
        );
    }
    assert_success(&execute_command(&json!({ "action": "mouseup" }), &mut state).await);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_success(&execute_command(&json!({ "action": "recording_stop" }), &mut state).await);
    assert_success(&execute_command(&json!({ "action": "close" }), &mut state).await);

    let output = tokio::process::Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(&path)
        .args([
            "-vf",
            "crop=640:80:0:200",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let mut measured = 0;
    let mut worst = 0;
    let mut positions = std::collections::HashSet::new();
    for bytes in output.stdout.chunks_exact(640 * 80 * 3) {
        let frame = image::RgbImage::from_raw(640, 80, bytes.to_vec()).unwrap();
        let line = (0..640).find(|&x| {
            let [r, g, b] = frame.get_pixel(x, 0).0;
            g > 150 && g > r.saturating_add(60) && g > b.saturating_add(60)
        });
        let cursor = frame
            .enumerate_pixels()
            .filter_map(|(x, _, pixel)| {
                let [r, g, b] = pixel.0;
                (r > 180 && g > 180 && b > 180).then_some(x)
            })
            .min();
        if let (Some(line), Some(cursor)) = (line, cursor) {
            measured += 1;
            positions.insert(line);
            worst = worst.max(line.abs_diff(cursor));
        }
    }
    assert!(measured >= 100, "only {measured} drag frames measured");
    assert!(
        positions.len() >= 60,
        "drag must exercise moving page frames"
    );
    // The cursor's white fill starts 1-2 pixels inside its black outline.
    assert!(
        worst <= 3,
        "recorded cursor separated from the dragged control by {worst} pixels"
    );
}

/// A completed drag must not pin the recorded cursor to a stale page frame.
#[tokio::test]
#[ignore]
async fn e2e_recording_cursor_moves_after_release_without_repaint() {
    let mut state = DaemonState::new();
    assert_success(
        &execute_command(&json!({ "action": "launch", "headless": true }), &mut state).await,
    );
    assert_success(
        &execute_command(
            &json!({ "action": "viewport", "width": 640, "height": 480 }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({
                "action": "navigate",
                "url": "data:text/html,<style>body{margin:0;background:%23202020}</style>"
            }),
            &mut state,
        )
        .await,
    );
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("released-cursor.mp4");
    assert_success(
        &execute_command(
            &json!({ "action": "recording_start", "path": path, "cursor": true, "fps": 60 }),
            &mut state,
        )
        .await,
    );
    for command in [
        json!({ "action": "mousemove", "x": 80, "y": 80 }),
        json!({ "action": "mousedown" }),
        json!({ "action": "mousemove", "x": 120, "y": 100, "duration": 150, "inputMode": "human" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let captured = state
        .recording_state
        .shared_captured_count
        .as_ref()
        .unwrap()
        .clone();
    let before = captured.load(Ordering::Relaxed);
    // Paint while pressed, then leave the page completely static after release.
    assert_success(
        &execute_command(
            &json!({ "action": "page_evaluate", "script": "document.body.style.background = '#303030'" }),
            &mut state,
        )
        .await,
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while captured.load(Ordering::Relaxed) == before {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the pressed page frame should reach the recorder");
    for command in [
        json!({ "action": "mouseup" }),
        json!({ "action": "mousemove", "x": 240, "y": 180, "duration": 250, "inputMode": "human" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_success(&execute_command(&json!({ "action": "recording_stop" }), &mut state).await);
    assert_success(&execute_command(&json!({ "action": "close" }), &mut state).await);

    let output = tokio::process::Command::new("ffmpeg")
        .args(["-v", "error", "-sseof", "-0.1", "-i"])
        .arg(&path)
        .args([
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-c:v",
            "png",
            "pipe:1",
        ])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let frame = image::load_from_memory(&output.stdout).unwrap().to_rgb8();
    assert_eq!(frame.dimensions(), (640, 480));
    assert!(
        frame.get_pixel(244, 184).0.iter().all(|value| *value > 180),
        "the released cursor should reach the new position in the encoded video; got {:?}",
        frame.get_pixel(244, 184).0
    );
    assert!(
        frame.get_pixel(124, 104).0.iter().all(|value| *value < 80),
        "the old drag position should contain only the page background"
    );
}

#[tokio::test]
#[ignore]
async fn e2e_initial_recording_frame_uses_css_viewport_dimensions() {
    let mut state = DaemonState::new();
    assert_success(
        &execute_command(&json!({ "action": "launch", "headless": true }), &mut state).await,
    );
    assert_success(
        &execute_command(
            &json!({
                "action": "viewport",
                "width": 400,
                "height": 300,
                "deviceScaleFactor": 2.0
            }),
            &mut state,
        )
        .await,
    );

    let browser = state.browser.as_ref().unwrap();
    let initial = super::recording::capture_initial_image(
        &browser.client,
        browser.active_session_id().unwrap(),
    )
    .await
    .unwrap();
    let (pixel_width, pixel_height) = image::ImageReader::with_format(
        std::io::Cursor::new(&initial.image_data),
        image::ImageFormat::Png,
    )
    .into_dimensions()
    .unwrap();

    assert_eq!((pixel_width, pixel_height), (800, 600));
    assert_eq!(
        (initial.device_width, initial.device_height),
        (400.0, 300.0)
    );

    assert_success(&execute_command(&json!({ "action": "close" }), &mut state).await);
}

// ---------------------------------------------------------------------------
// tab new: session setup inheritance
// ---------------------------------------------------------------------------

/// `tab new <url>` must replay the session's setup onto the new tab before
/// its first document: an init script registered on the primary page has to
/// run on the initial load, not only after a later navigation.
#[tokio::test]
#[ignore]
async fn e2e_tab_new_inherits_init_script_on_first_load() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "addinitscript", "script": "window.__abTab = 'seeded';" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3", "action": "tab_new",
            "url": "data:text/html,<script>document.title = String(window.__abTab)</script>",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "4", "action": "page_evaluate", "script": "document.title" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["result"],
        "seeded",
        "init script should run on the new tab's first document"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Replayed init scripts receive target-specific CDP identifiers. Removing a
/// script from the new tab must translate the original user-facing identifier
/// for every tab where Chrome registered it.
#[tokio::test]
#[ignore]
async fn e2e_tab_new_removes_replayed_init_script_by_original_identifier() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let first = execute_command(
        &json!({
            "id": "2", "action": "addinitscript",
            "script": "window.__abFirstInit = true;",
        }),
        &mut state,
    )
    .await;
    assert_success(&first);
    let first_id = get_data(&first)["identifier"]
        .as_str()
        .expect("first init script should return an identifier")
        .to_string();

    let second = execute_command(
        &json!({
            "id": "3", "action": "addinitscript",
            "script": "window.__abSecondInit = true;",
        }),
        &mut state,
    )
    .await;
    assert_success(&second);
    let second_id = get_data(&second)["identifier"]
        .as_str()
        .expect("second init script should return an identifier")
        .to_string();

    let resp = execute_command(
        &json!({ "id": "4", "action": "removeinitscript", "identifier": first_id }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "5", "action": "tab_new",
            "url": "data:text/html,<title>new tab</title>",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "removeinitscript", "identifier": second_id }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "7", "action": "navigate",
            "url": "data:text/html,<title>after removal</title>",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "8", "action": "page_evaluate",
            "script": "window.__abSecondInit === true",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], false);

    let resp = execute_command(
        &json!({ "id": "9", "action": "tab_switch", "tabId": "t1" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "10", "action": "navigate",
            "url": "data:text/html,<title>original after removal</title>",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "11", "action": "page_evaluate",
            "script": "window.__abSecondInit === true",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["result"],
        false,
        "removing a replayed script should also remove its original registration"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// CDP allocates init-script identifiers independently in each target. Two
/// pre-existing tabs can therefore both return `1` for different scripts, but
/// the daemon must expose distinct handles and remove only the requested one.
#[tokio::test]
#[ignore]
async fn e2e_tab_init_script_handles_are_unique_across_preexisting_tabs() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "2", "action": "tab_new" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "tab_switch", "tabId": "t1" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let first = execute_command(
        &json!({
            "id": "4", "action": "addinitscript",
            "script": "window.__abFirstExistingTab = true;",
        }),
        &mut state,
    )
    .await;
    assert_success(&first);
    let first_id = get_data(&first)["identifier"]
        .as_str()
        .expect("first init script should return an identifier")
        .to_string();

    let resp = execute_command(
        &json!({ "id": "5", "action": "tab_switch", "tabId": "t2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let second = execute_command(
        &json!({
            "id": "6", "action": "addinitscript",
            "script": "window.__abSecondExistingTab = true;",
        }),
        &mut state,
    )
    .await;
    assert_success(&second);
    let second_id = get_data(&second)["identifier"]
        .as_str()
        .expect("second init script should return an identifier")
        .to_string();

    assert_ne!(first_id, second_id, "user-facing handles must be unique");

    let resp = execute_command(
        &json!({ "id": "7", "action": "removeinitscript", "identifier": second_id }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "8", "action": "tab_new",
            "url": "data:text/html,<title>future tab</title>",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "9", "action": "page_evaluate",
            "script": "[window.__abFirstExistingTab === true, window.__abSecondExistingTab === true]",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], json!([true, false]));

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// `click --new-tab` creates a tab through a separate handler from `tab new`,
/// but it must apply the same session setup before the first request.
#[tokio::test]
#[ignore]
async fn e2e_click_new_tab_inherits_user_agent_and_headers() {
    let (base_url, _server) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({
            "id": "1", "action": "launch", "headless": true,
            "userAgent": "ab-click-new-tab-test/1.0",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "headers", "headers": { "X-Global": "global" } }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3", "action": "navigate",
            "url": format!("data:text/html,<a id='next' href='{}/click'>next</a>", base_url),
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "4", "action": "click", "selector": "#next", "newTab": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "5", "action": "page_evaluate",
            "script": "JSON.parse(document.body.innerText)",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let headers = &get_data(&resp)["result"]["headers"];
    assert_eq!(headers["X-Global"], "global");
    assert_eq!(headers["User-Agent"], "ab-click-new-tab-test/1.0");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// Clearing headers and offline mode restores the default setup, so future
/// tabs can use the non-blocking target creation path.
#[tokio::test]
#[ignore]
async fn e2e_cleared_session_setup_is_not_pending() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "offline", "offline": false }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "headers", "headers": {} }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    assert!(state.session_setup.offline.is_none());
    assert!(state.session_setup.extra_headers.is_none());

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// The launch `--user-agent` (Emulation.setUserAgentOverride) and global
/// `set headers` (Network.setExtraHTTPHeaders) are per CDP session. A new tab
/// opened with a URL must send both on its very first document request.
#[tokio::test]
#[ignore]
async fn e2e_tab_new_inherits_user_agent_and_headers() {
    let (base_url, _server) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({
            "id": "1", "action": "launch", "headless": true,
            "userAgent": "ab-tab-new-test/1.0",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "headers", "headers": { "X-Global": "global" } }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "tab_new", "url": format!("{}/tab", base_url) }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "4", "action": "page_evaluate",
            "script": "JSON.parse(document.body.innerText)",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let headers = &get_data(&resp)["result"]["headers"];
    assert_eq!(
        headers["X-Global"], "global",
        "global `headers` should apply to the new tab's first document request, got {headers}"
    );
    assert_eq!(
        headers["User-Agent"], "ab-tab-new-test/1.0",
        "new tab's first document request should carry the launch user agent, got {headers}"
    );

    let resp = execute_command(
        &json!({ "id": "5", "action": "page_evaluate", "script": "navigator.userAgent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "ab-tab-new-test/1.0");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

/// `set credentials` uses target-scoped extra headers, so a new tab must send
/// the resulting Authorization header on its first document request.
#[tokio::test]
#[ignore]
async fn e2e_tab_new_inherits_http_credentials_on_first_load() {
    let (base_url, _server) = start_echo_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2", "action": "credentials",
            "username": "tab-user", "password": "tab-password",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "tab_new", "url": format!("{}/credentials", base_url) }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "4", "action": "page_evaluate",
            "script": "JSON.parse(document.body.innerText)",
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let expected = format!("Basic {}", STANDARD.encode("tab-user:tab-password"));
    assert_eq!(
        get_data(&resp)["result"]["headers"]["Authorization"],
        expected,
        "HTTP credentials should apply to the new tab's first document request"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

// ---------------------------------------------------------------------------
// --state / storageState flag: cookies should be loaded at launch time
// ---------------------------------------------------------------------------

/// Verify that launching with `storageState` in the launch command restores
/// cookies that were previously saved with `state_save`.
///
/// This is the e2e equivalent of `agent-browser --state ./auth.json open <url>`.
/// The launch command accepts a `storageState` field that should load the
/// state file (cookies + localStorage) before the first navigation.
#[tokio::test]
#[ignore]
async fn e2e_state_flag_restores_cookies() {
    let state_path = std::env::temp_dir()
        .join(format!(
            "agent-browser-e2e-state-flag-{}.json",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .to_string();

    // Session 1: launch, set a cookie, save state, close
    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({ "id": "1", "action": "launch", "headless": true }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "cookies_set",
                "name": "state_flag_test",
                "value": "from_state_file",
                "domain": ".example.com",
                "path": "/",
                "expires": 2000000000
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "4", "action": "state_save", "path": &state_path }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    // Session 2: launch with storageState pointing to saved file, verify
    // cookies are present before any explicit state_load call.
    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({
                "id": "10",
                "action": "launch",
                "headless": true,
                "storageState": &state_path
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "11", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp =
            execute_command(&json!({ "id": "12", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies
            .iter()
            .any(|c| c["name"] == "state_flag_test" && c["value"] == "from_state_file");
        assert!(
            found,
            "Cookie from state file should be present after launch with storageState. \
             Cookies found: {:?}",
            cookies
                .iter()
                .map(|c| c["name"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
        );

        let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    let _ = std::fs::remove_file(&state_path);
}

/// Verify that explicit `launch` surfaces storageState load failures instead
/// of reporting success with an empty browser state.
#[tokio::test]
#[ignore]
async fn e2e_state_flag_missing_file_fails_launch() {
    let guard = EnvGuard::new(&["CI"]);
    guard.set("CI", "1");

    let missing_path = std::env::temp_dir()
        .join(format!(
            "agent-browser-e2e-missing-state-{}.json",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .to_string();

    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({
            "id": "10",
            "action": "launch",
            "headless": true,
            "args": ["--no-sandbox", "--disable-dev-shm-usage"],
            "storageState": &missing_path
        }),
        &mut state,
    )
    .await;

    assert_eq!(resp["success"], false);
    let error = resp["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("Failed to read state from") || error.contains("storage state"),
        "Unexpected error for missing storageState file: {}",
        error
    );
    assert!(
        state.browser.is_none(),
        "failed storageState launch should roll back the browser"
    );
}

/// Repeated launch calls with `storageState` should relaunch a clean browser so
/// stale cookies do not survive from the previous state file.
#[tokio::test]
#[ignore]
async fn e2e_storage_state_launch_restarts_clean_browser() {
    let state_one = std::env::temp_dir()
        .join(format!(
            "agent-browser-e2e-storage-reuse-1-{}.json",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .to_string();
    let state_two = std::env::temp_dir()
        .join(format!(
            "agent-browser-e2e-storage-reuse-2-{}.json",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .to_string();

    create_storage_state_with_cookie(&state_one, "storage_reload_first", "first").await;
    create_storage_state_with_cookie(&state_two, "storage_reload_second", "second").await;

    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({
            "id": "10",
            "action": "launch",
            "headless": true,
            "args": ["--no-sandbox", "--disable-dev-shm-usage"],
            "storageState": &state_one
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(
        get_data(&resp).get("reused").is_none(),
        "first launch must create the browser"
    );

    let resp = execute_command(
        &json!({ "id": "11", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "12", "action": "cookies_get" }), &mut state).await;
    assert_success(&resp);
    let cookies = get_data(&resp)["cookies"].as_array().unwrap();
    assert!(
        cookies
            .iter()
            .any(|c| c["name"] == "storage_reload_first" && c["value"] == "first"),
        "first storageState should be applied on the initial launch"
    );

    let resp = execute_command(
        &json!({
            "id": "13",
            "action": "launch",
            "headless": true,
            "args": ["--no-sandbox", "--disable-dev-shm-usage"],
            "storageState": &state_two
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp).get("reused"),
        None,
        "storageState launch should start from a clean browser"
    );

    let resp = execute_command(
        &json!({ "id": "14", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "15", "action": "cookies_get" }), &mut state).await;
    assert_success(&resp);
    let cookies = get_data(&resp)["cookies"].as_array().unwrap();
    assert!(
        cookies
            .iter()
            .any(|c| c["name"] == "storage_reload_second" && c["value"] == "second"),
        "second storageState should be applied after relaunch"
    );
    assert!(
        !cookies
            .iter()
            .any(|c| c["name"] == "storage_reload_first" && c["value"] == "first"),
        "stale cookies from the first storageState should not survive relaunch"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);

    let _ = std::fs::remove_file(&state_one);
    let _ = std::fs::remove_file(&state_two);
}

/// Verify that AGENT_BROWSER_STATE env var restores cookies at auto-launch
/// time (when the browser is lazily launched by a command like `navigate`
/// rather than an explicit `launch` command).
/// `--state` reaches a new daemon through the environment, so the first command auto-launches. A file that won't load stops
/// that launch as it stops `launch`: going on would run the session logged out with nothing said.
#[tokio::test]
#[ignore]
async fn e2e_a_state_file_that_wont_load_stops_an_auto_launch() {
    let guard = EnvGuard::new(&["AGENT_BROWSER_STATE"]);
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("no-such-state.json");
    guard.set("AGENT_BROWSER_STATE", missing.to_str().unwrap());
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "navigate", "url": "data:text/html,opened-anyway" }),
        &mut state,
    )
    .await;

    assert_eq!(resp["success"], false, "got: {resp}");
    assert!(state.browser.is_none(), "the failed launch must not leave a browser behind");
}

#[tokio::test]
#[ignore]
async fn e2e_state_env_restores_cookies_on_auto_launch() {
    let state_path = std::env::temp_dir()
        .join(format!(
            "agent-browser-e2e-state-env-{}.json",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .to_string();

    // Session 1: launch, set a cookie, save state, close
    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({ "id": "1", "action": "launch", "headless": true }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "cookies_set",
                "name": "env_state_test",
                "value": "from_env_state",
                "domain": ".example.com",
                "path": "/",
                "expires": 2000000000
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "4", "action": "state_save", "path": &state_path }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    // Session 2: set AGENT_BROWSER_STATE env var and let auto_launch pick it
    // up. No explicit `launch` command — just navigate, which triggers
    // auto_launch internally.
    {
        let env = EnvGuard::new(&["AGENT_BROWSER_STATE"]);
        env.set("AGENT_BROWSER_STATE", &state_path);

        let mut state = DaemonState::new();

        // Navigate without explicit launch — triggers auto_launch
        let resp = execute_command(
            &json!({ "id": "10", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp =
            execute_command(&json!({ "id": "11", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies
            .iter()
            .any(|c| c["name"] == "env_state_test" && c["value"] == "from_env_state");
        assert!(
            found,
            "Cookie should be restored via AGENT_BROWSER_STATE env on auto-launch. \
             Cookies found: {:?}",
            cookies
                .iter()
                .map(|c| c["name"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
        );

        let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    let _ = std::fs::remove_file(&state_path);
}

/// A page that says `body`, for as long as the test runs.
async fn start_page_server(body: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (base_url, handle)
}

/// A restore check is about the page the session opens. A command run before that, on the blank page a launch starts
/// on, used to spend the check there, fail it, and stop every save for the session.
#[tokio::test]
#[ignore]
async fn e2e_a_restore_check_waits_for_the_page_the_session_opens() {
    let restore_key = format!("e2e-check-waits-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let (base_url, server) = start_page_server("<!doctype html><title>t</title><h1>Dashboard</h1>").await;
    {
        let mut state = DaemonState::new();
        for command in [
            json!({ "id": "1", "action": "launch", "headless": true, "restoreKey": restore_key }),
            json!({ "id": "2", "action": "navigate", "url": base_url }),
            json!({ "id": "3", "action": "page_evaluate", "script": "document.cookie = 'kept=1; path=/'" }),
        ] {
            assert_success(&execute_command(&command, &mut state).await);
        }
        let closed = execute_command(&json!({ "id": "4", "action": "close" }), &mut state).await;
        assert_eq!(get_data(&closed)["saveStatus"], "saved");
    }

    let path = super::state::find_auto_state_file(&restore_key, "default").expect("the first close saved");
    let mut state = DaemonState::new();
    let launch = json!({ "id": "5", "action": "launch", "headless": true, "restoreKey": restore_key, "restoreCheckText": "Dashboard" });
    assert_success(&execute_command(&launch, &mut state).await);
    assert_success(&execute_command(&json!({ "id": "6", "action": "tab_list" }), &mut state).await);
    assert_eq!(state.restore_status, "loaded", "{:?}", state.restore_status_detail);
    assert!(state.restore_validation_pending, "still waiting for a page");

    assert_success(&execute_command(&json!({ "id": "7", "action": "navigate", "url": base_url }), &mut state).await);
    assert_eq!(state.restore_status, "loaded", "{:?}", state.restore_status_detail);
    assert!(!state.restore_validation_pending);
    let closed = execute_command(&json!({ "id": "8", "action": "close" }), &mut state).await;
    assert_eq!(get_data(&closed)["saveStatus"], "saved");
    server.abort();
    let _ = std::fs::remove_file(path);
}

/// Verify that --session-name auto-restores cookies saved from a prior
/// session with the same name.
#[tokio::test]
#[ignore]
async fn e2e_session_name_auto_restores_cookies() {
    let session_name = format!(
        "e2e-session-name-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    );

    let env = EnvGuard::new(&["AGENT_BROWSER_SESSION_NAME"]);
    env.set("AGENT_BROWSER_SESSION_NAME", &session_name);

    // Session 1: launch, set a cookie, close (which auto-saves state)
    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({ "id": "1", "action": "launch", "headless": true }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "cookies_set",
                "name": "session_name_test",
                "value": "auto_restored",
                "domain": ".example.com",
                "path": "/",
                "expires": 2000000000
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        // close triggers auto-save when session_name is set
        let resp = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    // Session 2: fresh DaemonState with same session_name. Navigate without
    // explicit launch, which triggers auto_launch and restore.
    {
        let mut state = DaemonState::new();

        // Navigate without explicit launch — triggers auto_launch → try_auto_restore_state
        let resp = execute_command(
            &json!({ "id": "10", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp =
            execute_command(&json!({ "id": "12", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies
            .iter()
            .any(|c| c["name"] == "session_name_test" && c["value"] == "auto_restored");
        assert!(
            found,
            "Cookie should be auto-restored via --session-name. Cookies found: {:?}",
            cookies
                .iter()
                .map(|c| c["name"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
        );

        let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    // Clean up auto-saved state files
    let sessions_dir = dirs::home_dir()
        .unwrap()
        .join(".agent-browser")
        .join("sessions");
    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with(&format!("{}-", session_name)) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

#[tokio::test]
#[ignore]
async fn e2e_restore_loads_during_explicit_launch_before_navigation() {
    let restore_key = format!(
        "e2e-explicit-restore-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let env = EnvGuard::new(&[
        "AGENT_BROWSER_SESSION_NAME",
        "AGENT_BROWSER_RESTORE_SAVE",
        "AGENT_BROWSER_STATE",
        "AGENT_BROWSER_ENCRYPTION_KEY",
    ]);
    env.remove("AGENT_BROWSER_SESSION_NAME");
    env.remove("AGENT_BROWSER_RESTORE_SAVE");
    env.remove("AGENT_BROWSER_STATE");
    env.remove("AGENT_BROWSER_ENCRYPTION_KEY");

    {
        let mut state = DaemonState::new();
        let resp = execute_command(
            &json!({
                "id": "1",
                "action": "launch",
                "headless": true,
                "restoreKey": restore_key
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "cookies_set",
                "name": "explicit_restore_test",
                "value": "loaded_before_navigation",
                "domain": ".example.com",
                "path": "/",
                "expires": 2000000000
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(&json!({ "id": "4", "action": "close" }), &mut state).await;
        assert_success(&resp);
        assert_eq!(get_data(&resp)["saveStatus"], "saved");
    }

    let path = super::state::find_auto_state_file(&restore_key, "default")
        .expect("first close should create restore state");

    {
        let mut state = DaemonState::new();
        let resp = execute_command(
            &json!({
                "id": "10",
                "action": "launch",
                "headless": true,
                "restoreKey": restore_key
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert_eq!(get_data(&resp)["lifecycle"]["restoreStatus"], "loaded");

        let resp = execute_command(
            &json!({ "id": "11", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp =
            execute_command(&json!({ "id": "12", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies.iter().any(|c| {
            c["name"] == "explicit_restore_test" && c["value"] == "loaded_before_navigation"
        });
        assert!(
            found,
            "Cookie should be restored by explicit launch before first navigation. Cookies found: {:?}",
            cookies
                .iter()
                .map(|c| c["name"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
        );

        let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}.previous", path));
}

/// Verify that periodic autosave persists session state while the browser is
/// open, so state survives the browser dying WITHOUT the daemon's
/// save-on-close path running (e.g. the user closes the window by hand).
#[tokio::test]
#[ignore]
async fn e2e_periodic_autosave_survives_abrupt_browser_exit() {
    let restore_key = format!(
        "e2e-autosave-abrupt-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let env = EnvGuard::new(&[
        "AGENT_BROWSER_SESSION_NAME",
        "AGENT_BROWSER_RESTORE_SAVE",
        "AGENT_BROWSER_STATE",
        "AGENT_BROWSER_ENCRYPTION_KEY",
    ]);
    env.remove("AGENT_BROWSER_SESSION_NAME");
    env.remove("AGENT_BROWSER_RESTORE_SAVE");
    env.remove("AGENT_BROWSER_STATE");
    env.remove("AGENT_BROWSER_ENCRYPTION_KEY");

    {
        let mut state = DaemonState::new();
        let resp = execute_command(
            &json!({
                "id": "1",
                "action": "launch",
                "headless": true,
                "restoreKey": restore_key
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "cookies_set",
                "name": "autosave_test",
                "value": "saved_by_tick",
                "domain": ".example.com",
                "path": "/",
                "expires": 2000000000
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        // The command just finished, so the quiet period must block the tick.
        maybe_autosave_restore_state(&mut state, 30_000).await;
        assert_eq!(state.restore_save_status, "not_attempted");
        assert!(
            super::state::find_auto_state_file(&restore_key, "default").is_none(),
            "autosave must not fire inside the post-command quiet period"
        );

        // Simulate the quiet period having elapsed, then run the tick again.
        state.last_command_finished =
            std::time::Instant::now().checked_sub(std::time::Duration::from_secs(10));
        maybe_autosave_restore_state(&mut state, 30_000).await;
        assert_eq!(state.restore_save_status, "saved");
        assert!(
            state.last_autosave_attempt.is_some(),
            "successful save should reset the periodic interval"
        );
        assert!(
            super::state::find_auto_state_file(&restore_key, "default").is_some(),
            "periodic autosave should write the session state file"
        );

        // An idle session stays eligible: once the interval elapses again the
        // tick re-saves, capturing page-driven mutations like token refreshes.
        state.last_autosave_attempt =
            std::time::Instant::now().checked_sub(std::time::Duration::from_secs(31));
        state.restore_save_status = "not_attempted".to_string();
        maybe_autosave_restore_state(&mut state, 30_000).await;
        assert_eq!(
            state.restore_save_status, "saved",
            "idle session should be re-saved on the next interval without new commands"
        );

        // Kill the browser out from under the daemon, the way a user closing
        // the window does: the process exits and CDP dies, so no further save
        // is possible. Then mimic the daemon drain tick, which only closes.
        let mgr = state.browser.as_mut().expect("browser should be running");
        let _ = mgr
            .client
            .send_command_no_params("Browser.close", None)
            .await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !mgr.has_process_exited() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            state
                .browser
                .as_mut()
                .expect("browser manager should still be present")
                .has_process_exited(),
            "browser process should have exited after Browser.close"
        );
        let _ = close_current_browser(&mut state).await;
    }

    let path = super::state::find_auto_state_file(&restore_key, "default")
        .expect("autosaved state should survive the abrupt browser exit");

    {
        let mut state = DaemonState::new();
        let resp = execute_command(
            &json!({
                "id": "10",
                "action": "launch",
                "headless": true,
                "restoreKey": restore_key
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert_eq!(get_data(&resp)["lifecycle"]["restoreStatus"], "loaded");

        let resp = execute_command(
            &json!({ "id": "11", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp =
            execute_command(&json!({ "id": "12", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies
            .iter()
            .any(|c| c["name"] == "autosave_test" && c["value"] == "saved_by_tick");
        assert!(
            found,
            "Cookie saved only by periodic autosave should be restored after the browser was killed without a graceful close. Cookies found: {:?}",
            cookies
                .iter()
                .map(|c| c["name"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
        );

        let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}.previous", path));
}

#[tokio::test]
#[ignore]
async fn e2e_restore_preserves_cookie_login_after_close_and_reopen() {
    let restore_key = format!(
        "e2e-next-cookie-login-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let env = EnvGuard::new(&[
        "AGENT_BROWSER_SESSION_NAME",
        "AGENT_BROWSER_RESTORE_SAVE",
        "AGENT_BROWSER_STATE",
        "AGENT_BROWSER_ENCRYPTION_KEY",
    ]);
    env.remove("AGENT_BROWSER_SESSION_NAME");
    env.remove("AGENT_BROWSER_RESTORE_SAVE");
    env.remove("AGENT_BROWSER_STATE");
    env.remove("AGENT_BROWSER_ENCRYPTION_KEY");

    let (base_url, _server) = start_cookie_login_server().await;

    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({
                "id": "1",
                "action": "navigate",
                "url": base_url.clone(),
                "restoreKey": restore_key
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert_eq!(get_data(&resp)["lifecycle"]["restoreStatus"], "missing");

        let resp = execute_command(
            &json!({ "id": "2", "action": "page_evaluate", "script": "document.body.innerText" }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert!(
            get_data(&resp)["result"]
                .as_str()
                .unwrap_or_default()
                .contains("Please sign in"),
            "first homepage load should be logged out: {}",
            resp
        );

        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "navigate",
                "url": format!("{}/login", base_url),
                "restoreKey": restore_key
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "4",
                "action": "navigate",
                "url": base_url.clone(),
                "restoreKey": restore_key
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "5", "action": "page_evaluate", "script": "document.body.innerText" }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert!(
            get_data(&resp)["result"]
                .as_str()
                .unwrap_or_default()
                .contains("Welcome back"),
            "login route should set cookie for current browser: {}",
            resp
        );

        let resp = execute_command(&json!({ "id": "6", "action": "close" }), &mut state).await;
        assert_success(&resp);
        assert_eq!(get_data(&resp)["saveStatus"], "saved");
    }

    let path = super::state::find_auto_state_file(&restore_key, "default")
        .expect("close should save cookie-backed restore state");

    {
        let mut state = DaemonState::new();
        let resp = execute_command(
            &json!({
                "id": "10",
                "action": "navigate",
                "url": base_url.clone(),
                "restoreKey": restore_key
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert_eq!(get_data(&resp)["lifecycle"]["restoreStatus"], "loaded");

        let resp = execute_command(
            &json!({ "id": "11", "action": "page_evaluate", "script": "document.body.innerText" }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert!(
            get_data(&resp)["result"]
                .as_str()
                .unwrap_or_default()
                .contains("Welcome back"),
            "reopened session should keep cookie login on homepage: {}",
            resp
        );

        let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}.previous", path));
    cleanup_restore_state_files(&restore_key);
}

#[tokio::test]
#[ignore]
async fn e2e_restore_validation_failure_does_not_overwrite_state() {
    let restore_key = format!(
        "e2e-restore-validation-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    );

    {
        let mut state = DaemonState::new();
        let resp = execute_command(
            &json!({
                "id": "1",
                "action": "navigate",
                "url": "https://example.com",
                "restoreKey": restore_key
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "2",
                "action": "cookies_set",
                "name": "restore_validation_test",
                "value": "known_good",
                "domain": ".example.com",
                "path": "/",
                "expires": 2000000000
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(&json!({ "id": "3", "action": "close" }), &mut state).await;
        assert_success(&resp);
        assert_eq!(get_data(&resp)["saveStatus"], "saved");
    }

    let path = super::state::find_auto_state_file(&restore_key, "default")
        .expect("first close should create restore state");
    let before = std::fs::read_to_string(&path).expect("state file should be readable");

    {
        let mut state = DaemonState::new();
        let resp = execute_command(
            &json!({
                "id": "10",
                "action": "navigate",
                "url": "https://example.com",
                "restoreKey": restore_key,
                "restoreCheckText": "text-that-does-not-exist-in-the-page"
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);
        assert_eq!(
            get_data(&resp)["lifecycle"]["restoreStatus"],
            "loaded_but_invalid"
        );

        let resp = execute_command(&json!({ "id": "11", "action": "close" }), &mut state).await;
        assert_success(&resp);
        assert_eq!(get_data(&resp)["saveStatus"], "skipped_restore_failed");
    }

    let after = std::fs::read_to_string(&path).expect("state file should still be readable");
    assert_eq!(
        before, after,
        "failed restore validation must not overwrite previous state"
    );

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}.previous", path));
}

#[tokio::test]
#[ignore]
async fn e2e_restore_key_switch_reloads_instead_of_reusing_live_browser() {
    let restore_key_a = format!(
        "e2e-restore-switch-a-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let restore_key_b = format!(
        "e2e-restore-switch-b-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let cookie_name = "restore_switch_test";
    let env = EnvGuard::new(&[
        "AGENT_BROWSER_SESSION_NAME",
        "AGENT_BROWSER_RESTORE_SAVE",
        "AGENT_BROWSER_STATE",
        "AGENT_BROWSER_ENCRYPTION_KEY",
    ]);
    env.remove("AGENT_BROWSER_SESSION_NAME");
    env.remove("AGENT_BROWSER_RESTORE_SAVE");
    env.remove("AGENT_BROWSER_STATE");
    env.remove("AGENT_BROWSER_ENCRYPTION_KEY");

    create_restore_state_with_cookie(&restore_key_a, cookie_name, "value-a").await;
    create_restore_state_with_cookie(&restore_key_b, cookie_name, "value-b").await;

    let path_a = super::state::find_auto_state_file(&restore_key_a, "default")
        .expect("first restore key should have saved state");
    let path_b = super::state::find_auto_state_file(&restore_key_b, "default")
        .expect("second restore key should have saved state");

    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({
            "id": "10",
            "action": "navigate",
            "url": "https://example.com",
            "restoreKey": restore_key_a
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "11", "action": "cookies_get" }), &mut state).await;
    assert_success(&resp);
    let cookies = get_data(&resp)["cookies"].as_array().unwrap();
    assert!(
        cookies
            .iter()
            .any(|c| c["name"] == cookie_name && c["value"] == "value-a"),
        "first restore key should load value-a: {:?}",
        cookies
    );

    let resp = execute_command(
        &json!({
            "id": "20",
            "action": "navigate",
            "url": "https://example.com",
            "restoreKey": restore_key_b
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["lifecycle"]["relaunchedBrowser"], true);

    let resp = execute_command(&json!({ "id": "21", "action": "cookies_get" }), &mut state).await;
    assert_success(&resp);
    let cookies = get_data(&resp)["cookies"].as_array().unwrap();
    assert!(
        cookies
            .iter()
            .any(|c| c["name"] == cookie_name && c["value"] == "value-b"),
        "switching restore keys should load value-b, not reuse value-a: {:?}",
        cookies
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);

    let saved_b = std::fs::read_to_string(&path_b).expect("state file should remain readable");
    assert!(saved_b.contains("value-b"));
    assert!(!saved_b.contains("value-a"));

    let _ = std::fs::remove_file(&path_a);
    let _ = std::fs::remove_file(format!("{}.previous", path_a));
    let _ = std::fs::remove_file(&path_b);
    let _ = std::fs::remove_file(format!("{}.previous", path_b));
}

/// Verify that explicit `state_load` restores cookies into an existing
/// session (baseline sanity check — this path is known to work).
#[tokio::test]
#[ignore]
async fn e2e_explicit_state_load_restores_cookies() {
    let state_path = std::env::temp_dir()
        .join(format!(
            "agent-browser-e2e-explicit-load-{}.json",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .to_string();

    // Session 1: set cookie, save state
    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({ "id": "1", "action": "launch", "headless": true }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "cookies_set",
                "name": "explicit_load_test",
                "value": "manually_loaded",
                "domain": ".example.com",
                "path": "/",
                "expires": 2000000000
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "4", "action": "state_save", "path": &state_path }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    // Session 2: launch clean, then explicitly load state
    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({ "id": "10", "action": "launch", "headless": true }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "11", "action": "state_load", "path": &state_path }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "12", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp =
            execute_command(&json!({ "id": "13", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies
            .iter()
            .any(|c| c["name"] == "explicit_load_test" && c["value"] == "manually_loaded");
        assert!(
            found,
            "Cookie should be present after explicit state_load. Cookies found: {:?}",
            cookies
                .iter()
                .map(|c| c["name"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
        );

        let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    let _ = std::fs::remove_file(&state_path);
}

// === React / Web Vitals primitives ===

const REACT_FIXTURE_HTML: &str = r#"<!doctype html>
<html>
  <head><title>React fixture</title></head>
  <body>
    <div id="root"></div>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script>
      const { useState, createElement: h } = React;
      function Counter({ label }) {
        const [n, setN] = useState(0);
        return h("button", { onClick: () => setN(n + 1) }, label + ": " + n);
      }
      function App() {
        return h("div", {}, [
          h("h1", { key: "t" }, "Hello"),
          h(Counter, { key: "c1", label: "A" }),
          h(Counter, { key: "c2", label: "B" }),
        ]);
      }
      ReactDOM.createRoot(document.getElementById("root")).render(h(App));
    </script>
  </body>
</html>
"#;

fn react_fixture_url() -> String {
    format!(
        "data:text/html;base64,{}",
        STANDARD.encode(REACT_FIXTURE_HTML)
    )
}

#[tokio::test]
#[ignore]
async fn e2e_react_tree_errors_without_hook() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Without --enable react-devtools, the hook isn't installed and the
    // command should error.
    let resp = execute_command(&json!({ "id": "3", "action": "react_tree" }), &mut state).await;
    let err = resp
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        err.contains("React DevTools") || err.contains("renderer"),
        "Expected hook-missing error, got: {:?}",
        resp
    );

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

#[tokio::test]
#[ignore]
async fn e2e_react_tree_with_enable_hook() {
    let guard = EnvGuard::new(&["AGENT_BROWSER_ENABLE"]);
    guard.set("AGENT_BROWSER_ENABLE", "react-devtools");
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": &react_fixture_url() }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Give React a moment to boot and register with the hook.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let resp = execute_command(&json!({ "id": "3", "action": "react_tree" }), &mut state).await;
    assert_success(&resp);
    let tree = get_data(&resp)
        .get("tree")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    assert!(
        tree.contains("App"),
        "Expected tree to contain 'App': {}",
        tree
    );
    assert!(
        tree.contains("Counter"),
        "Expected tree to contain 'Counter': {}",
        tree
    );

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

#[tokio::test]
#[ignore]
async fn e2e_relaunch_when_enable_changes_installs_react_hook() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": &react_fixture_url() }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "react_tree" }), &mut state).await;
    assert!(
        resp.get("success").and_then(|v| v.as_bool()) == Some(false),
        "React tree should fail before react-devtools is enabled: {}",
        resp
    );

    let resp = execute_command(
        &json!({
            "id": "4",
            "action": "launch",
            "headless": true,
            "enable": ["react-devtools"]
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(
        get_data(&resp).get("reused").is_none(),
        "changed enable list must relaunch, not reuse: {}",
        resp
    );
    assert_eq!(
        get_data(&resp)["lifecycle"]["relaunchedBrowser"],
        true,
        "lifecycle should report browser relaunch"
    );

    let resp = execute_command(
        &json!({ "id": "5", "action": "navigate", "url": &react_fixture_url() }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let resp = execute_command(&json!({ "id": "6", "action": "react_tree" }), &mut state).await;
    assert_success(&resp);
    let tree = get_data(&resp)
        .get("tree")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        tree.contains("App"),
        "Expected tree to contain App: {}",
        tree
    );

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

#[tokio::test]
#[ignore]
async fn e2e_vitals_reports_metrics() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": &react_fixture_url() }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "vitals" }), &mut state).await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert!(data.get("url").and_then(|v| v.as_str()).is_some());
    assert!(data.get("ttfb").is_some());
    assert!(data.get("cls").and_then(|v| v.get("score")).is_some());
    assert!(data.get("phases").and_then(|v| v.as_array()).is_some());
    assert!(data
        .get("hydratedComponents")
        .and_then(|v| v.as_array())
        .is_some());

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

async fn start_a11y_frame_server() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let handle = tokio::spawn(async move {
        for _ in 0..100 {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");

                let (status, content_type, body) = match path {
                    "/top" => (
                        "200 OK",
                        "text/html",
                        format!(
                            r#"<!doctype html><html lang="en"><head><title>Top</title></head>
<body><main aria-label="Top"><h1>Top</h1>
<iframe id="outer" title="Outer" src="http://127.0.0.1:{port}/outer"></iframe>
</main></body></html>"#
                        ),
                    ),
                    "/outer" => (
                        "200 OK",
                        "text/html",
                        r#"<!doctype html><html lang="en"><head><title>Outer</title></head>
<body><main aria-label="Outer"><h1>Outer</h1><img id="outer-image" src="/missing-outer.png">
<iframe id="inner" title="Inner" src="/inner"></iframe></main></body></html>"#
                            .to_string(),
                    ),
                    "/inner" => (
                        "200 OK",
                        "text/html",
                        r#"<!doctype html><html lang="en"><head><title>Inner</title></head>
<body><main aria-label="Inner"><h1>Inner</h1><img id="inner-image" src="/missing-inner.png"></main></body></html>"#
                            .to_string(),
                    ),
                    "/siblings" => (
                        "200 OK",
                        "text/html",
                        format!(
                            r#"<!doctype html><html lang="en"><head><title>Siblings</title></head>
<body><main><h1>Siblings</h1>
<iframe id="first-frame" title="First" src="http://127.0.0.1:{port}/first-frame"></iframe>
<iframe id="second-frame" title="Second" src="http://127.0.0.1:{port}/second-frame"></iframe>
</main></body></html>"#
                        ),
                    ),
                    "/first-frame" => (
                        "200 OK",
                        "text/html",
                        r#"<!doctype html><html lang="en"><head><title>First</title></head>
<body><main><h1>First</h1><img id="first-image" src="/missing-first.png"></main></body></html>"#
                            .to_string(),
                    ),
                    "/second-frame" => (
                        "200 OK",
                        "text/html",
                        r#"<!doctype html><html lang="en"><head><title>Second</title></head>
<body><main><h1>Second</h1><img id="second-image" src="/missing-second.png"></main></body></html>"#
                            .to_string(),
                    ),
                    "/background" => (
                        "200 OK",
                        "text/html",
                        format!(
                            r#"<!doctype html><html lang="en"><head><title>Background</title></head>
<body><main><h1>Background</h1>
<iframe id="background-frame" title="Background frame" src="http://127.0.0.1:{port}/background-frame"></iframe>
</main></body></html>"#
                        ),
                    ),
                    "/background-frame" => (
                        "200 OK",
                        "text/html",
                        r#"<!doctype html><html lang="en"><head><title>Background frame</title></head>
<body><main><h1>Background frame</h1><img id="background-image" src="/missing-background.png"></main></body></html>"#
                            .to_string(),
                    ),
                    _ => ("404 Not Found", "text/plain", "not found".to_string()),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    (port, handle)
}

#[tokio::test]
#[ignore]
async fn e2e_recording_cursor_uses_page_coordinates_for_oopif() {
    let (port, server) = start_a11y_frame_server().await;
    let mut state = DaemonState::new();
    assert_success(
        &execute_command(&json!({"action": "launch", "headless": true}), &mut state).await,
    );
    assert_success(
        &execute_command(
            &json!({"action": "navigate", "url": format!("http://localhost:{port}/top")}),
            &mut state,
        )
        .await,
    );
    assert_success(&execute_command(&json!({"action": "page_evaluate", "script": "document.getElementById('outer').style.cssText = 'position:absolute;left:240px;top:160px;width:400px;height:300px;border:10px solid black'"}), &mut state).await);
    let child_session = state
        .iframe_sessions
        .values()
        .next()
        .expect("fixture must use an OOPIF")
        .clone();
    state.browser.as_ref().unwrap().client.send_command("Runtime.evaluate", Some(json!({
        "expression": "document.body.innerHTML = '<button style=\"position:absolute;left:20px;top:30px;width:80px;height:40px\">Cursor target</button>'"
    })), Some(&child_session)).await.unwrap();
    let snapshot = execute_command(&json!({"action": "snapshot"}), &mut state).await;
    assert_success(&snapshot);
    let reference = get_data(&snapshot)["refs"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, entry)| entry["name"] == "Cursor target")
        .unwrap()
        .0
        .clone();
    // Verify the input samples retain top-level coordinates for frame actions.
    super::recording::recording_start(
        &mut state.recording_state,
        "unused.webm",
        super::recording::RecordingOptions {
            cursor: true,
            ..Default::default()
        },
    )
    .unwrap();
    for action in ["hover", "click", "dblclick"] {
        assert_success(&execute_command(&json!({"action": action, "selector": format!("@{reference}"), "inputMode": "human"}), &mut state).await);
        let cursor = state
            .recording_state
            .shared_cursor
            .lock()
            .unwrap()
            .at(f64::INFINITY);
        assert!(cursor.visible);
        assert!(
            (cursor.x - 310.0).abs() < 1.0 && (cursor.y - 220.0).abs() < 1.0,
            "{action}: cursor should be at page (310, 220), got {cursor:?}"
        );
        assert!((state.mouse_state.x - cursor.x).abs() < 1.0);
        assert!((state.mouse_state.y - cursor.y).abs() < 1.0);
    }
    state.recording_state.active = false;
    state.browser.as_ref().unwrap().client.send_command("Runtime.evaluate", Some(json!({
        "expression": "document.body.style.background='#303030'; const button = document.querySelector('button'); button.style.background='#303030'; button.style.border='0'; button.textContent=''"
    })), Some(&child_session)).await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("iframe-cursor.mp4");
    assert_success(
        &execute_command(
            &json!({"action":"recording_start", "path":path,"cursor":true,"fps":60}),
            &mut state,
        )
        .await,
    );
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_success(
        &execute_command(
            &json!({"action":"hover", "selector":format!("@{reference}"), "inputMode":"human"}),
            &mut state,
        )
        .await,
    );
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let stopped = execute_command(&json!({"action":"recording_stop"}), &mut state).await;
    assert_success(&execute_command(&json!({"action": "close"}), &mut state).await);
    server.abort();
    assert_success(&stopped);
    let output = tokio::process::Command::new("ffmpeg")
        .args(["-v", "error", "-sseof", "-0.1", "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-c:v",
            "png",
            "pipe:1",
        ])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let image = image::load_from_memory(&output.stdout).unwrap().to_rgb8();
    assert!(
        image
            .get_pixel(314, 224)
            .0
            .iter()
            .all(|channel| *channel > 180),
        "the cursor should be visible inside the out-of-process iframe"
    );
}

#[tokio::test]
#[ignore]
async fn e2e_a11y_uses_vendored_engine_and_preserves_shadow_targets() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = r#"<!doctype html>
<html lang="en">
<head><title>Accessibility audit fixture</title></head>
<body>
  <main>
    <h1>Accessibility audit fixture</h1>
    <img id="light-image" src="missing.png">
    <div id="shadow-host"></div>
    <iframe id="audit-frame" title="Audit frame" tabindex="-1" srcdoc="
      <!doctype html><html lang='en'><head><title>Frame</title></head>
      <body><main><h1>Frame</h1><a href='https://example.com'>Frame link</a><img id='frame-image' src='missing.png'></main>
      <script>
        window.frameAxe = { version: 'frame-spoofed' };
        window.frameAxeSetterCalls = 0;
        Object.defineProperty(window, 'axe', {
          configurable: false,
          get() { return window.frameAxe; },
          set() {
            window.frameAxeSetterCalls += 1;
            throw new Error('frame axe setter must not run');
          }
        });
      </script></body></html>
    "></iframe>
  </main>
  <script>
    window.pageAxe = {
      version: 'spoofed',
      run: () => Promise.resolve({
        url: 'spoofed',
        testEngine: { version: 'spoofed' },
        violations: [],
        incomplete: [],
        passes: [],
        inapplicable: []
      })
    };
    window.axeSetterCalls = 0;
    Object.defineProperty(window, 'axe', {
      configurable: false,
      get() { return window.pageAxe; },
      set() {
        window.axeSetterCalls += 1;
        throw new Error('page axe setter must not run');
      }
    });
    window.amdCalls = 0;
    window.define = () => { window.amdCalls += 1; };
    window.define.amd = {};
    document.getElementById('shadow-host').attachShadow({ mode: 'open' }).innerHTML =
      '<img id="shadow-image" src="missing.png">';
  </script>
</body>
</html>"#;
    let url = format!("data:text/html;base64,{}", STANDARD.encode(html));
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "a11y" }), &mut state).await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["axeVersion"], "4.12.1");
    let image_alt = data["violations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|violation| violation["id"] == "image-alt")
        .expect("vendored axe should report missing image alternatives");
    assert_eq!(image_alt["nodeCount"], 3);
    let nodes = image_alt["nodes"].as_array().unwrap();
    assert!(nodes
        .iter()
        .any(|node| node["target"] == json!(["#light-image"])));
    assert!(nodes
        .iter()
        .any(|node| node["target"] == json!([["#shadow-host", "#shadow-image"]])));
    assert!(nodes
        .iter()
        .any(|node| node["target"] == json!(["#audit-frame", "#frame-image"])));
    let frame_focusable_content = data["violations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|violation| violation["id"] == "frame-focusable-content")
        .expect("audit should preserve the child context for non-focusable frames");
    assert!(frame_focusable_content["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["target"] == json!(["#audit-frame", "html"])));

    let resp = execute_command(
        &json!({ "id": "3-selector", "action": "a11y", "selector": "#shadow-host" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let scoped_image_alt = get_data(&resp)["violations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|violation| violation["id"] == "image-alt")
        .expect("scoped audit should report the shadow image");
    assert_eq!(scoped_image_alt["nodeCount"], 1);

    let resp = execute_command(
        &json!({
            "id": "4",
            "action": "page_evaluate",
            "script": "[window.axe.version, document.querySelector('#audit-frame').contentWindow.axe.version, window.axeSetterCalls, document.querySelector('#audit-frame').contentWindow.frameAxeSetterCalls, window.amdCalls]"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["result"],
        json!(["spoofed", "frame-spoofed", 0, 0, 0])
    );

    state
        .ref_map
        .add("e999".to_string(), Some(999), "button", "stale", None);
    state.active_frame_id = Some("stale-frame".to_string());
    state
        .iframe_sessions
        .insert("stale-frame".to_string(), "stale-session".to_string());
    let fresh_url = format!(
        "data:text/html;base64,{}",
        STANDARD.encode(
            "<!doctype html><html lang='en'><head><title>Fresh audit</title></head><body><main><h1>Fresh audit</h1></main></body></html>"
        )
    );
    let resp = execute_command(
        &json!({ "id": "5", "action": "a11y", "url": fresh_url }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(state.ref_map.get("e999").is_none());
    assert!(state.active_frame_id.is_none());
    assert!(!state.iframe_sessions.contains_key("stale-frame"));

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

#[tokio::test]
#[ignore]
async fn e2e_a11y_preserves_nested_frame_sessions_across_tab_switches() {
    let (port, server) = start_a11y_frame_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": format!("http://localhost:{port}/top")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(
        !state.iframe_sessions.is_empty(),
        "cross-origin frame should have an attached target session"
    );
    let top_iframe_sessions = state.active_iframe_sessions.clone();
    assert!(
        !top_iframe_sessions.is_empty(),
        "active frame sessions should include the top tab's cross-origin frame"
    );

    let assert_frame_violations = |resp: &Value| {
        assert_success(resp);
        let image_alt = get_data(resp)["violations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|violation| violation["id"] == "image-alt")
            .unwrap_or_else(|| {
                panic!(
                    "audit should include images in nested cross-origin frames: {}",
                    serde_json::to_string_pretty(resp).unwrap_or_default()
                )
            });
        assert_eq!(image_alt["nodeCount"], 2);
        let nodes = image_alt["nodes"].as_array().unwrap();
        assert!(nodes
            .iter()
            .any(|node| node["target"] == json!(["#outer", "#outer-image"])));
        assert!(nodes
            .iter()
            .any(|node| node["target"] == json!(["#outer", "#inner", "#inner-image"])));
    };

    let resp = execute_command(&json!({ "id": "3", "action": "a11y" }), &mut state).await;
    assert_frame_violations(&resp);

    let resp = execute_command(
        &json!({ "id": "3-selector", "action": "a11y", "selector": "main" }),
        &mut state,
    )
    .await;
    assert_frame_violations(&resp);

    // Simulate a popup created outside the tab commands. Target lifecycle
    // events must move active iframe scoping to the popup and back when it is
    // externally closed.
    let browser_client = state.browser.as_ref().unwrap().client.clone();
    let created = browser_client
        .send_command(
            "Target.createTarget",
            Some(json!({
                "url": format!("http://localhost:{port}/background")
            })),
            None,
        )
        .await
        .unwrap();
    let external_target_id = created["targetId"].as_str().unwrap().to_string();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let resp = execute_command(
        &json!({ "id": "external-open", "action": "tab_list" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let resp = execute_command(
        &json!({ "id": "external-loaded", "action": "tab_list" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let external_iframe_sessions = state.active_iframe_sessions.clone();
    assert!(!external_iframe_sessions.is_empty());
    assert!(top_iframe_sessions.is_disjoint(&external_iframe_sessions));

    browser_client
        .send_command(
            "Target.closeTarget",
            Some(json!({ "targetId": external_target_id })),
            None,
        )
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let resp = execute_command(
        &json!({ "id": "external-close", "action": "tab_list" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(state.active_iframe_sessions, top_iframe_sessions);

    let resp = execute_command(
        &json!({
            "id": "4",
            "action": "tab_new",
            "url": format!("http://localhost:{port}/background")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let background_iframe_sessions = state.active_iframe_sessions.clone();
    assert!(
        !background_iframe_sessions.is_empty(),
        "active frame sessions should follow the newly opened tab"
    );
    assert!(top_iframe_sessions.is_disjoint(&background_iframe_sessions));
    let resp = execute_command(
        &json!({ "id": "5", "action": "tab_switch", "tabId": "t1" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(state.active_iframe_sessions, top_iframe_sessions);

    let resp = execute_command(&json!({ "id": "6", "action": "a11y" }), &mut state).await;
    assert_frame_violations(&resp);

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_a11y_preserves_sibling_frame_dom_order() {
    let (port, server) = start_a11y_frame_server().await;
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "2",
            "action": "navigate",
            "url": format!("http://localhost:{port}/siblings")
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "a11y" }), &mut state).await;
    assert_success(&resp);
    let image_alt = get_data(&resp)["violations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|violation| violation["id"] == "image-alt")
        .expect("audit should report both sibling frame images");
    assert_eq!(image_alt["nodeCount"], 2);
    let targets: Vec<_> = image_alt["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["target"].clone())
        .collect();
    assert_eq!(
        targets,
        vec![
            json!(["#first-frame", "#first-image"]),
            json!(["#second-frame", "#second-image"]),
        ]
    );

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    server.abort();
}

#[tokio::test]
#[ignore]
async fn e2e_pushstate_changes_url() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com/" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "pushstate", "url": "/newpath" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let url = get_data(&resp)
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        url.ends_with("/newpath"),
        "Expected pushstate URL to end with /newpath, got: {}",
        url
    );

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

#[tokio::test]
#[ignore]
async fn e2e_removeinitscript_roundtrip() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "addinitscript",
            "script": "window.__AB_ROUNDTRIP__ = 1;"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let identifier = get_data(&resp)["identifier"]
        .as_str()
        .expect("addinitscript should return an identifier")
        .to_string();
    assert!(!identifier.is_empty());

    let resp = execute_command(
        &json!({ "id": "4", "action": "removeinitscript", "identifier": identifier }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["removed"], true);

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

// ---------------------------------------------------------------------------
// Session-to-tab binding (--pin-tab): two sessions sharing one Chrome over
// CDP must not hijack each other's tabs. A restarted daemon re-binds to its
// persisted target instead of adopting the most recently active tab, and a
// pinned session whose tab is closed gets a tab_gone error instead of
// silently acting on another session's tab.
// ---------------------------------------------------------------------------

/// A site whose page starts a worker, and the worker asks the site for something.
async fn start_worker_site() -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                seen.lock().unwrap().push(path.clone());
                let (kind, body) = match path.as_str() {
                    "/worker.js" => ("text/javascript", "fetch('/from-worker').then(r => r.text()).then(t => postMessage(t));"),
                    "/from-worker" => ("application/json", "{\"said\":\"by-the-worker\"}"),
                    _ => ("text/html", "<!doctype html><title>w</title>"),
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (base_url, asked, handle)
}

/// What a page's worker asks a site for is the page's traffic. A worker has its own session, so it reached neither the
/// request list nor the HAR, and a call a site makes from a worker was never seen.
#[tokio::test]
#[ignore]
async fn e2e_a_workers_calls_reach_the_request_log() {
    let (site, asked, server) = start_worker_site().await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": format!("{site}/") }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "3", "action": "har_start" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "4", "action": "requests" }), &mut state).await);
    assert_success(
        &execute_command(
            &json!({
                "id": "5",
                "action": "page_evaluate",
                "script": "new Promise(ok => { window.w = new Worker('/worker.js'); w.onmessage = e => ok(e.data); })"
            }),
            &mut state,
        )
        .await,
    );
    assert!(asked.lock().unwrap().iter().any(|path| path == "/from-worker"), "the fixture's worker never called");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let listed = execute_command(&json!({ "id": "6", "action": "requests", "filter": "from-worker" }), &mut state).await;
    assert_eq!(get_data(&listed)["requests"].as_array().map(Vec::len), Some(1), "got: {listed}");
    let entry = state.har_entries.iter().find(|entry| entry.url.ends_with("/from-worker")).expect("the HAR must hold the worker's call");
    assert!(entry.response_body.as_deref().unwrap_or_default().contains("by-the-worker"), "its answer too");

    let _ = execute_command(&json!({ "id": "7", "action": "close" }), &mut state).await;
    server.abort();
}

/// Environment guard for binding tests: isolated socket dir (so binding
/// files cannot leak between test runs) plus per-session env vars.
/// A forward proxy that asks nothing itself, for a site behind it that asks for a login: what `Authorization` it was sent.
async fn start_site_asking_for_login_behind_a_proxy() -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let sent = Arc::new(Mutex::new(Vec::new()));
    let seen = sent.clone();
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                if let Some(line) = request.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization:")) {
                    seen.lock().unwrap().push(line.to_string());
                }
                let body = "<!doctype html><title>asks</title>";
                let response = format!(
                    "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"site\"\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (proxy, sent, handle)
}

/// A proxy's credentials are for the proxy. A site's own login prompt is the same event with another `source`, and any
/// site could raise one to read them.
#[tokio::test]
#[ignore]
async fn e2e_a_sites_login_prompt_never_gets_the_proxys_credentials() {
    let (proxy, sent, server) = start_site_asking_for_login_behind_a_proxy().await;
    let mut state = DaemonState::new();
    let launch = json!({ "id": "1", "action": "launch", "headless": true,
        "proxy": { "server": proxy, "username": "proxy-user", "password": "proxy-pass" } });
    assert_success(&execute_command(&launch, &mut state).await);
    let open = json!({ "id": "2", "action": "navigate", "url": "http://site.example/" });
    let _ = execute_command(&open, &mut state).await;
    let _ = execute_command(&json!({ "id": "3", "action": "close" }), &mut state).await;
    server.abort();
    let sent = sent.lock().unwrap();
    assert!(sent.is_empty(), "the site was sent the proxy's login: {sent:?}");
}

/// A browser that dies comes back as the one that was launched: a session carrying on without its proxy, profile or
/// identity would send its traffic somewhere the owner never chose.
#[tokio::test]
#[ignore]
async fn e2e_a_browser_that_died_comes_back_as_it_was_launched() {
    let mut state = DaemonState::new();
    let launch = json!({ "id": "1", "action": "launch", "headless": true, "userAgent": "as-launched/1.0" });
    assert_success(&execute_command(&launch, &mut state).await);
    let client = state.browser.as_ref().unwrap().client.clone();
    let _ = client.send_command_no_params("Browser.close", None).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let open = json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>back</h1>" });
    assert_success(&execute_command(&open, &mut state).await);
    assert_evaluate(&mut state, "3", "navigator.userAgent", json!("as-launched/1.0")).await;
    assert_success(&execute_command(&json!({ "id": "4", "action": "close" }), &mut state).await);
}

fn binding_test_env() -> (EnvGuard<'static>, tempfile::TempDir) {
    let guard = EnvGuard::new(&[
        "AGENT_BROWSER_SOCKET_DIR",
        "XDG_RUNTIME_DIR",
        "AGENT_BROWSER_NAMESPACE",
        "AGENT_BROWSER_SESSION",
        "AGENT_BROWSER_PIN_TAB",
    ]);
    let dir = tempfile::tempdir().unwrap();
    guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
    guard.remove("XDG_RUNTIME_DIR");
    guard.remove("AGENT_BROWSER_NAMESPACE");
    guard.remove("AGENT_BROWSER_PIN_TAB");
    (guard, dir)
}

/// Launch a host Chrome and return (host_state, ws_url) for other sessions
/// to attach to over CDP.
/// A dialog pauses the page it opened on, whichever tab is active. That tab has to stay reachable, and an answer has to
/// reach it: untracked, it could only time out, and `dialog accept` went to the active page and cleared the slot.
#[tokio::test]
#[ignore]
async fn e2e_a_dialog_on_a_tab_not_active_is_answered_on_that_tab() {
    let mut state = DaemonState::new();
    let page = "data:text/html,<title>held</title><h1>held</h1>";
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "navigate", "url": page, "tab": "held" }),
        json!({ "id": "3", "action": "page_evaluate", "tab": "held",
            "script": "setTimeout(() => { window.answer = confirm('sure?'); }, 300); true" }),
        json!({ "id": "4", "action": "navigate", "url": "data:text/html,<h1>beside</h1>", "tab": "beside" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    let beside = json!({ "id": "5", "action": "page_evaluate", "tab": "beside", "script": "1 + 1" });
    assert_success(&execute_command(&beside, &mut state).await);
    let status = execute_command(&json!({ "id": "6", "action": "dialog", "response": "status" }), &mut state).await;
    assert_eq!(get_data(&status)["hasDialog"], true, "{status}");

    // Reaching the tab is quick, and a command that needs its page says why it can't have it.
    let started = std::time::Instant::now();
    let held = json!({ "id": "7", "action": "page_evaluate", "tab": "held", "script": "1" });
    let held = execute_command(&held, &mut state).await;
    assert!(held["error"].as_str().is_some_and(|e| e.contains("dialog is blocking")), "{held}");
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
    let accept = json!({ "id": "8", "action": "dialog", "response": "accept", "tab": "held" });
    assert_success(&execute_command(&accept, &mut state).await);
    let answered = json!({ "id": "9", "action": "page_evaluate", "tab": "held", "script": "window.answer" });
    let answered = execute_command(&answered, &mut state).await;
    assert_eq!(get_data(&answered)["result"], true, "{answered}");
    assert!(state.pending_dialogs.is_empty());
    assert_success(&execute_command(&json!({ "id": "10", "action": "close" }), &mut state).await);
}

/// A tab closed with its dialog open says no more about it: the slot must not outlive the page and stop every save.
#[tokio::test]
#[ignore]
async fn e2e_a_dialog_goes_with_its_tab() {
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>a</h1>", "tab": "stays" }),
        json!({ "id": "3", "action": "navigate", "url": "data:text/html,<h1>b</h1>", "tab": "goes" }),
        json!({ "id": "4", "action": "page_evaluate", "tab": "goes", "script": "setTimeout(() => confirm('sure?'), 100); true" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_success(&execute_command(&json!({ "id": "5", "action": "tab_close", "tab": "goes" }), &mut state).await);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let reply = execute_command(&json!({ "id": "6", "action": "page_evaluate", "tab": "stays", "script": "1" }), &mut state).await;
    assert_success(&reply);
    assert!(reply.get("warning").is_none(), "{reply}");
    assert!(state.pending_dialogs.is_empty());
    assert_success(&execute_command(&json!({ "id": "7", "action": "close" }), &mut state).await);
}

/// The daemon answers an alert by itself, so a click whose press opened one has no `dialog` command to let go of its
/// button: the next click read as a drag.
#[tokio::test]
#[ignore]
async fn e2e_an_alert_on_a_press_leaves_no_button_down() {
    let mut state = DaemonState::new();
    let page = "data:text/html,<button id=b style='width:200px;height:80px'>b</button><script>\
        window.seen = []; const b = document.getElementById('b'); let first = true;\
        b.addEventListener('mousedown', e => { seen.push('down:' + e.buttons); if (first) { first = false; alert('hi'); } });\
        b.addEventListener('mouseup', () => seen.push('up'));</script>";
    for command in [
        json!({ "id": "1", "action": "launch", "headless": true }),
        json!({ "id": "2", "action": "navigate", "url": page }),
        json!({ "id": "3", "action": "click", "selector": "#b" }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_success(&execute_command(&json!({ "id": "4", "action": "click", "selector": "#b" }), &mut state).await);
    assert_eq!(state.mouse_state.buttons, 0);
    assert_evaluate(&mut state, "5", "seen.join(',')", json!("down:1,up,down:1,up")).await;
    assert_success(&execute_command(&json!({ "id": "6", "action": "close" }), &mut state).await);
}

async fn launch_binding_host(guard: &EnvGuard<'static>) -> (DaemonState, String) {
    guard.set("AGENT_BROWSER_SESSION", "e2e-bind-host");
    let mut host = DaemonState::new();
    let resp = execute_command(
        &json!({
            "id": "host-1",
            "action": "launch",
            "headless": true,
            "args": ["--no-sandbox", "--disable-dev-shm-usage"]
        }),
        &mut host,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(&json!({ "id": "host-2", "action": "cdp_url" }), &mut host).await;
    assert_success(&resp);
    let ws_url = get_data(&resp)["cdpUrl"]
        .as_str()
        .expect("cdpUrl should be a string")
        .to_string();
    (host, ws_url)
}

/// Create a pinned session attached to the shared Chrome and navigate its
/// bound tab to `url`. Returns the session's state.
async fn attach_pinned_session(
    guard: &EnvGuard<'static>,
    session: &str,
    ws_url: &str,
    url: &str,
) -> DaemonState {
    guard.set("AGENT_BROWSER_SESSION", session);
    let mut state = DaemonState::new();
    let resp = execute_command(
        &json!({
            "id": format!("{}-launch", session),
            "action": "launch",
            "cdpUrl": ws_url,
            "pinTab": true
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": format!("{}-nav", session), "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    state
}

async fn current_url(state: &mut DaemonState, id: &str) -> Value {
    execute_command(&json!({ "id": id, "action": "url" }), state).await
}

fn load_binding(session: &str, expect: &str) -> super::tab_binding::TabBinding {
    super::tab_binding::load(session)
        .expect("binding file should be readable")
        .expect(expect)
}

/// `--pin-tab` holds on a browser the daemon launched, as on one it attached to: the bound tab closing is `tab_gone`,
/// never a quiet move to the tab beside it.
#[tokio::test]
#[ignore]
async fn e2e_a_pin_holds_on_a_browser_the_daemon_launched() {
    let (guard, _dir) = binding_test_env();
    guard.set("AGENT_BROWSER_SESSION", "e2e-pin-launched");
    let mut state = DaemonState::new();
    assert_success(
        &execute_command(
            &json!({
                "id": "1",
                "action": "launch",
                "headless": true,
                "pinTab": true,
                "args": ["--no-sandbox", "--disable-dev-shm-usage"]
            }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "data:text/html,pinned-page" }),
            &mut state,
        )
        .await,
    );
    let binding = load_binding("e2e-pin-launched", "the launched page should be bound");
    assert!(binding.pinned);

    let client = state.browser.as_ref().unwrap().client.clone();
    client
        .send_command("Target.createTarget", Some(json!({ "url": "data:text/html,neighbour" })), None)
        .await
        .unwrap();
    client
        .send_command("Target.closeTarget", Some(json!({ "targetId": binding.target_id })), None)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let resp = current_url(&mut state, "3").await;
    assert_eq!(resp["code"], "tab_gone", "got: {resp}");

    let _ = execute_command(&json!({ "id": "4", "action": "close" }), &mut state).await;
}

/// A crashed renderer says so at the next command instead of taking that command's whole timeout, and `reload` is a way
/// back.
#[tokio::test]
#[ignore]
async fn e2e_a_crashed_tab_says_so_and_a_reload_brings_it_back() {
    let (guard, _dir) = binding_test_env();
    guard.set("AGENT_BROWSER_SESSION", "e2e-crashed");
    let mut state = DaemonState::new();
    assert_success(
        &execute_command(
            &json!({
                "id": "1",
                "action": "launch",
                "headless": true,
                "args": ["--no-sandbox", "--disable-dev-shm-usage"]
            }),
            &mut state,
        )
        .await,
    );
    assert_success(
        &execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<title>alive</title>" }),
            &mut state,
        )
        .await,
    );
    let (client, session) = {
        let mgr = state.browser.as_ref().unwrap();
        (mgr.client.clone(), mgr.active_session_id().unwrap().to_string())
    };
    let _ = client.send_command_no_wait("Page.crash", None, Some(&session)).await;
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

    let asked = std::time::Instant::now();
    let resp = execute_command(&json!({ "id": "3", "action": "page_evaluate", "script": "1" }), &mut state).await;
    assert_eq!(resp["code"], "tab_crashed", "got: {resp}");
    assert!(asked.elapsed() < std::time::Duration::from_secs(2), "took {:?}", asked.elapsed());

    assert_success(&execute_command(&json!({ "id": "4", "action": "tab_list" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "5", "action": "reload" }), &mut state).await);
    assert_evaluate(&mut state, "6", "document.title", json!("alive")).await;

    let _ = execute_command(&json!({ "id": "7", "action": "close" }), &mut state).await;
}

#[tokio::test]
#[ignore]
async fn e2e_pin_tab_rebinds_after_daemon_restart() {
    let (guard, _dir) = binding_test_env();
    let (mut host, ws_url) = launch_binding_host(&guard).await;

    let url_a = "data:text/html,session-a-page";
    let url_b = "data:text/html,session-b-page";

    // Session A binds its own tab (pin mode creates a fresh tab on attach).
    let state_a = attach_pinned_session(&guard, "e2e-bind-a", &ws_url, url_a).await;
    let binding_a = load_binding("e2e-bind-a", "session A binding should persist");
    assert!(binding_a.pinned, "binding should record pinned=true");
    assert_eq!(
        binding_a.url, "",
        "opaque URL payloads must not be persisted in diagnostic state"
    );

    // Session B binds its own tab and navigates last, so B's tab is the most
    // recently active one (the tab a naive re-attach would adopt).
    let mut state_b = attach_pinned_session(&guard, "e2e-bind-b", &ws_url, url_b).await;
    let binding_b = load_binding("e2e-bind-b", "session B binding should persist");
    assert_ne!(
        binding_a.target_id, binding_b.target_id,
        "sessions must bind distinct tabs"
    );

    // Simulate session A's daemon dying (idle timeout, crash, kill): drop the
    // state without a clean close. The binding file survives.
    drop(state_a);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // A restarted daemon for session A must re-bind to A's original tab by
    // targetId, not adopt B's (most recently active) tab.
    guard.set("AGENT_BROWSER_SESSION", "e2e-bind-a");
    let mut state_a2 = DaemonState::new();
    assert!(
        state_a2.pin_tab,
        "pin-tab should be sticky via the persisted binding"
    );
    let resp = execute_command(
        &json!({ "id": "a2-launch", "action": "launch", "cdpUrl": ws_url }),
        &mut state_a2,
    )
    .await;
    assert_success(&resp);

    let resp = current_url(&mut state_a2, "a2-url").await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["url"],
        url_a,
        "restarted session A must operate on A's original tab"
    );
    let binding_a2 = load_binding("e2e-bind-a", "binding should still exist");
    assert_eq!(
        binding_a2.target_id, binding_a.target_id,
        "re-attach must keep the original bound target"
    );
    assert_eq!(
        binding_a2.url, "",
        "re-attach must not reintroduce the opaque URL payload"
    );

    // Lifecycle-dependent commands must work on the restored tab: attach
    // only enables the CDP domains on the first target, so the restore path
    // must enable them on the bound tab too or navigate hangs waiting for
    // Page lifecycle events (timeout guards against the hang regression).
    let url_a2 = "data:text/html,session-a-page-2";
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        execute_command(
            &json!({ "id": "a2-nav", "action": "navigate", "url": url_a2 }),
            &mut state_a2,
        ),
    )
    .await
    .expect("navigate on the restored tab must not hang");
    assert_success(&resp);
    assert_eq!(get_data(&resp)["targetId"], binding_a.target_id);

    // Session B is unaffected.
    let resp = current_url(&mut state_b, "b-url").await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], url_b);

    let resp = execute_command(&json!({ "id": "host-99", "action": "close" }), &mut host).await;
    assert_success(&resp);
}

// Real-Chrome smoke test: a foreign tab opened via `window.open` inside the
// pinned session's own page must never steal the active tab or overwrite the
// pin binding. NOTE: this does NOT specifically guard finding #3 (the
// `Target.attachedToTarget`-before-`Target.targetCreated` race) — empirically
// in this environment Chrome always delivers `Target.targetCreated` first for
// a `window.open()` popup, so this only exercises the `new_targets` drain
// path in actions.rs (~line 1082), which was never the buggy branch. The
// deterministic, race-independent regression coverage for finding #3 itself
// lives at the unit level: `BrowserManager::register_discovered_page` (the
// single decision point both drain handlers call) is exercised directly by
// `test_register_discovered_page_untracked_target_does_not_steal_pinned_tab`
// in browser.rs, which fails if that function's internal `add_page` vs.
// `add_page_without_activation` choice regresses. This e2e test is kept as a
// general non-regression smoke check against real Chrome, not as #3 proof.
#[tokio::test]
#[ignore]
async fn e2e_auto_attached_foreign_tab_does_not_steal_pinned_tab() {
    let (guard, _dir) = binding_test_env();
    let (mut host, ws_url) = launch_binding_host(&guard).await;

    let url_a = "data:text/html,pinned-session-a";
    let mut state_a = attach_pinned_session(&guard, "e2e-foreign-a", &ws_url, url_a).await;
    let binding_before = load_binding("e2e-foreign-a", "session A binding should persist");

    // Open a foreign tab in the shared browser. This is not an agent command
    // (`tab new`), it is a plain popup — the same shape as a human opening a
    // tab or a page calling `window.open`.
    let resp = execute_command(
        &json!({
            "id": "foreign-open",
            "action": "page_evaluate",
            "script": "window.open('data:text/html,foreign-popup'); 'opened'"
        }),
        &mut state_a,
    )
    .await;
    assert_success(&resp);

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let resp = current_url(&mut state_a, "a-url-after-foreign").await;
    assert_success(&resp);

    let mgr = state_a.browser.as_ref().expect("browser should be running");
    let page_count_before = 1; // the pinned session's own bound tab
    assert!(
        mgr.page_count() > page_count_before,
        "the foreign popup must still register in tab list (got {} pages)",
        mgr.page_count()
    );
    assert_eq!(
        get_data(&resp)["url"],
        url_a,
        "the pinned session's active tab must not be stolen by the foreign popup"
    );
    assert_eq!(
        mgr.bound_target_id(),
        Some(binding_before.target_id.as_str()),
        "the pin binding must not be overwritten by the foreign popup"
    );

    let resp = execute_command(&json!({ "id": "host-99", "action": "close" }), &mut host).await;
    assert_success(&resp);
}

// SCRATCH (finding #3): explicit agent commands must still end up active
// even under the same auto-attach shared browser, proving the fix does not
// regress `tab new`.
#[tokio::test]
#[ignore]
async fn e2e_tab_new_still_activates_under_auto_attach() {
    let (guard, _dir) = binding_test_env();
    let (mut host, ws_url) = launch_binding_host(&guard).await;

    let url_a = "data:text/html,pinned-session-a";
    let mut state_a = attach_pinned_session(&guard, "e2e-tabnew-a", &ws_url, url_a).await;

    let resp = execute_command(
        &json!({
            "id": "tab-new",
            "action": "tab_new",
            "url": "data:text/html,agent-opened-tab"
        }),
        &mut state_a,
    )
    .await;
    assert_success(&resp);

    let resp = current_url(&mut state_a, "a-url-after-tab-new").await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["url"],
        "data:text/html,agent-opened-tab",
        "an explicit `tab new` must activate the new tab it created"
    );

    let resp = execute_command(&json!({ "id": "host-99", "action": "close" }), &mut host).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_pin_tab_gone_error_and_recovery() {
    let (guard, _dir) = binding_test_env();
    let (mut host, ws_url) = launch_binding_host(&guard).await;

    let url_a = "data:text/html,gone-session-a";
    let url_b = "data:text/html,gone-session-b";

    let mut state_a = attach_pinned_session(&guard, "e2e-gone-a", &ws_url, url_a).await;
    let binding_a = load_binding("e2e-gone-a", "session A binding should persist");
    let mut state_b = attach_pinned_session(&guard, "e2e-gone-b", &ws_url, url_b).await;

    // Session B closes A's tab by targetId (targetIds are accepted anywhere a
    // tab ref is accepted and are stable across daemons).
    let resp = execute_command(
        &json!({ "id": "b-close-a", "action": "tab_close", "tabId": binding_a.target_id }),
        &mut state_b,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Session A must now fail loudly with a machine-readable tab_gone error
    // instead of silently adopting a neighboring tab.
    let resp = current_url(&mut state_a, "a-url-gone").await;
    assert_eq!(resp["success"], false);
    assert_eq!(
        resp["code"],
        "tab_gone",
        "response should carry code=tab_gone, got: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );
    let err = resp["error"].as_str().unwrap_or("");
    assert!(
        err.starts_with(super::browser::TAB_GONE_PREFIX),
        "error should start with the tab_gone prefix, got: {}",
        err
    );
    assert_eq!(resp["data"]["targetId"], binding_a.target_id);
    assert!(
        resp["data"].get("lastUrl").is_none(),
        "opaque URLs must not be exposed in structured diagnostics: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );

    // Recovery commands still work in the gone state: tab_list is allowed,
    // and tab_new binds a fresh tab.
    let resp = execute_command(
        &json!({ "id": "a-list", "action": "tab_list" }),
        &mut state_a,
    )
    .await;
    assert_success(&resp);

    let url_a2 = "data:text/html,recovered-session-a";
    let resp = execute_command(
        &json!({ "id": "a-new", "action": "tab_new", "url": url_a2 }),
        &mut state_a,
    )
    .await;
    assert_success(&resp);

    let resp = current_url(&mut state_a, "a-url-recovered").await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], url_a2);

    let binding_a2 = load_binding("e2e-gone-a", "binding should be rewritten");
    assert_ne!(
        binding_a2.target_id, binding_a.target_id,
        "recovery must bind a new target"
    );
    assert!(binding_a2.pinned, "recovered binding stays pinned");

    // Session B keeps working on its own tab throughout.
    let resp = current_url(&mut state_b, "b-url-after").await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], url_b);

    let resp = execute_command(&json!({ "id": "host-99", "action": "close" }), &mut host).await;
    assert_success(&resp);
}

/// A multiselect locator miss must surface the anchored "No element found"
/// guidance, not a raw "Evaluation error: ...". Guards the handler wiring end to
/// end: a unit test of the mapping alone stays green if the handler stops routing
/// misses through it. Force-red: drop the sentinel miss handling in
/// handle_multiselect and this assertion fails on the raw evaluate error.
#[tokio::test]
#[ignore]
async fn e2e_multiselect_miss_surfaces_anchored_error() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // about:blank has no #picker, so the selector misses.
    let resp = execute_command(
        &json!({ "id": "2", "action": "multiselect", "selector": "#picker", "values": ["a"] }),
        &mut state,
    )
    .await;
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "multiselect on a missing selector should error: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );
    let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("");
    // Assert the full anchored shape, not just the guidance suffix: the miss must
    // carry "No element found", retain the "#picker" selector detail, and end with
    // the locator-miss guidance. A generic suffix-only check would pass even if the
    // detail were dropped or a different classifier produced the guidance.
    assert!(
        err.starts_with("No element found") && err.contains("#picker"),
        "miss should keep the anchored shape and selector detail, got: {err}"
    );
    assert!(
        err.contains("Verify the selector, role, or name is correct"),
        "miss should surface the anchored locator-miss guidance, got: {err}"
    );

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

/// An earlier valid ARIA token in a multi-token role attribute is the operative
/// role, so `role="mark none"` is a mark and must not answer `find role none`.
/// Force-red: drop `mark` from the presentational VALID_ROLES set and the query
/// matches this element, so the miss assertion fails.
#[tokio::test]
#[ignore]
async fn e2e_presentational_role_respects_earlier_operative_token() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = "<html><body><span role='mark none'>marked</span></body></html>";
    let url = format!("data:text/html;base64,{}", STANDARD.encode(html));
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "getbyrole", "role": "none", "subaction": "text" }),
        &mut state,
    )
    .await;
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "operative role is `mark`, so `find role none` must not match: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

/// `find role directory` must match an explicit `role="directory"` element but
/// not an ordinary list. Chrome collapses `directory` into the `list` AX role,
/// so this goes through the DOM-attribute path, not the AX tree. Force-red:
/// route `directory` back through the AX tree and the explicit element is missed
/// (its AX role is `list`), so the found-text assertion fails.
#[tokio::test]
#[ignore]
async fn e2e_find_role_directory_matches_only_explicit_attribute() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // A plain list must not be matched by `find role directory`.
    let plain = "data:text/html;base64,".to_string()
        + &STANDARD.encode("<html><body><ul><li>item</li></ul></body></html>");
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": plain }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "3", "action": "getbyrole", "role": "directory", "subaction": "text" }),
        &mut state,
    )
    .await;
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "a plain <ul> must not match `find role directory`: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );

    // An explicit role="directory" element is found.
    let explicit = "data:text/html;base64,".to_string()
        + &STANDARD.encode("<html><body><div role='directory'>DIR</div></body></html>");
    let resp = execute_command(
        &json!({ "id": "4", "action": "navigate", "url": explicit }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "5", "action": "getbyrole", "role": "directory", "subaction": "text" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "DIR");

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

/// The presentational DOM lookup must honor the selected frame, not always the
/// top document. Force-red: revert the frame dispatch in the presentational path
/// (search the top document only) and the in-frame element is missed.
#[tokio::test]
#[ignore]
async fn e2e_presentational_role_honors_selected_frame() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Top document has no role="none"; the same-origin iframe does. `srcdoc`
    // inherits the parent origin, so the child is same-origin (the path this fix
    // targets) without needing a server; a `data:` child would be cross-origin.
    let outer = "<body><iframe id='f' srcdoc=\"<div role='none'>INSIDE</div>\"></iframe></body>";
    let url = format!("data:text/html;base64,{}", STANDARD.encode(outer));
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Before selecting the frame, the top document has no match.
    let resp = execute_command(
        &json!({ "id": "3", "action": "getbyrole", "role": "none", "subaction": "text" }),
        &mut state,
    )
    .await;
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "top document has no role=none: {}",
        serde_json::to_string_pretty(&resp).unwrap_or_default()
    );

    // Select the frame; the presentational lookup must now find the frame element.
    let resp = execute_command(
        &json!({ "id": "4", "action": "frame", "selector": "#f" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "5", "action": "getbyrole", "role": "none", "subaction": "text" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "INSIDE");

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

/// ARIA presentational-roles conflict resolution: role="none" on a focusable
/// element (or one with global ARIA props) is ignored, so `find role none` must
/// skip it but still match a truly presentational element. Force-red: drop the
/// conflict check and the `<button role="none">` is matched.
#[tokio::test]
#[ignore]
async fn e2e_presentational_role_respects_conflict_resolution() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // Each non-matching element triggers conflict resolution a different way:
    // native focusable, explicit tabindex=-1 (programmatically focusable), and a
    // global ARIA property. Only the last, truly presentational div must match.
    let html = concat!(
        "<body>",
        "<button role='none'>NativeFocusable</button>",
        "<div role='none' tabindex='-1'>TabindexFocusable</div>",
        "<div role='none' aria-label='named'>GlobalAria</div>",
        "<div role='none'>Plain</div>",
        "</body>"
    );
    let url = format!("data:text/html;base64,{}", STANDARD.encode(html));
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    // The focusable button keeps its implicit role, so the match must be the div.
    let resp = execute_command(
        &json!({ "id": "3", "action": "getbyrole", "role": "none", "subaction": "text" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["text"],
        "Plain",
        "role=none on a focusable button must be ignored (conflict resolution)"
    );

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

/// `find role document` must match the page root. Chrome exposes it as
/// `RootWebArea`; without the normalization to `document` the query misses.
/// End-to-end guard for that mapping (the unit test only checks the string).
#[tokio::test]
#[ignore]
async fn e2e_find_role_document_matches_root() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let url = format!(
        "data:text/html;base64,{}",
        STANDARD.encode("<title>T</title><body>hi</body>")
    );
    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": url }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "getbyrole", "role": "document", "subaction": "text" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let _ = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
}

#[tokio::test]
#[ignore]
async fn e2e_mouse_interpolation_starts_at_last_element_interaction() {
    let mut state = DaemonState::new();
    assert_success(
        &execute_command(
            &json!({"id": "1", "action": "launch", "headless": true}),
            &mut state,
        )
        .await,
    );
    assert_success(&execute_command(&json!({"id": "2", "action": "setcontent", "html": "<button id='b' style='position:absolute;left:400px;top:300px;width:100px;height:40px'>Target</button><input id='c' type='checkbox' style='position:absolute;left:200px;top:200px'>"}), &mut state).await);
    for action in ["click", "hover", "dblclick", "check", "uncheck"] {
        let selector = if matches!(action, "check" | "uncheck") {
            "#c"
        } else {
            "#b"
        };
        assert_success(
            &execute_command(
                &json!({"id": "3", "action": action, "selector": selector}),
                &mut state,
            )
            .await,
        );
        let start = (state.mouse_state.x, state.mouse_state.y);
        assert!(start.0 >= 200.0 && start.1 >= 200.0, "{action}: {start:?}");
        assert_success(&execute_command(&json!({"id": "4", "action": "page_evaluate", "script": "window.moves=[];document.onmousemove=e=>moves.push([e.clientX,e.clientY]);"}), &mut state).await);
        assert_success(&execute_command(&json!({"id": "5", "action": "mousemove", "x": start.0 + 100.0, "y": start.1, "steps": 2}), &mut state).await);
        let result = execute_command(
            &json!({"id": "6", "action": "page_evaluate", "script": "moves"}),
            &mut state,
        )
        .await;
        assert_success(&result);
        let moves = get_data(&result)["result"].as_array().unwrap();
        assert_eq!(moves.len(), 2, "{action}: {moves:?}");
        assert!((moves[0][0].as_f64().unwrap() - (start.0 + 50.0)).abs() <= 1.0);
        assert!((moves[1][0].as_f64().unwrap() - (start.0 + 100.0)).abs() <= 1.0);
    }
    assert_success(&execute_command(&json!({"id": "99", "action": "close"}), &mut state).await);
}

/// A site-bound value goes into the field whose origin was checked, never to whatever holds focus: with another
/// site's frame focused and the checked field unable to take focus (hidden), the frame gets nothing.
#[tokio::test]
#[ignore]
async fn a_site_bound_fill_never_reaches_a_frame_that_holds_focus() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = if head.starts_with("GET /frame") {
                    "<!doctype html><html><body style='margin:0'>\
                     <input id='b' style='width:300px;height:100px' \
                       oninput=\"parent.postMessage(this.value, '*')\"></body></html>"
                        .to_string()
                } else {
                    format!(
                        "<!doctype html><html><body style='margin:0'>\
                         <script>window.got = []; addEventListener('message', e => got.push(e.data));</script>\
                         <iframe src='http://localhost:{port}/frame' style='position:fixed;left:0;top:0;width:300px;height:100px;border:0'></iframe>\
                         <form style='margin-top:200px'><input id='pw' type='password' style='display:none'></form></body></html>"
                    )
                };
                let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = sock.write_all(reply.as_bytes()).await;
            });
        }
    });

    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": format!("http://127.0.0.1:{port}/") }), &mut state).await);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    // Give the other site's frame focus, and check it reports what is typed into it.
    for (id, action) in [("3", "mousemove"), ("4", "mousedown"), ("5", "mouseup")] {
        assert_success(&execute_command(&json!({ "id": id, "action": action, "x": 50, "y": 50 }), &mut state).await);
    }
    assert_success(&execute_command(&json!({ "id": "6", "action": "keyboard", "subaction": "insertText", "text": "x" }), &mut state).await);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_evaluate(&mut state, "7", "window.got", json!(["x"])).await;

    let resp = execute_command(&json!({ "id": "8", "action": "fill", "selector": "#pw", "value": "dummy-secret", "site": "127.0.0.1" }), &mut state).await;
    assert_success(&resp);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_evaluate(&mut state, "9", "window.got", json!(["x"])).await;
    assert_evaluate(&mut state, "10", "document.getElementById('pw').value", json!("dummy-secret")).await;

    let _ = execute_command(&json!({ "id": "11", "action": "close" }), &mut state).await;
}

/// A value bound to one site goes only into a field whose own document is on that site, and the page can't talk its
/// way past the check: it reassigns `window.origin` and redefines `ownerDocument` to claim another site, and the fill
/// is still refused, because the origin is read in an isolated world the page's script can't reach.
#[tokio::test]
#[ignore]
async fn e2e_site_bound_fill_reads_the_origin_the_page_cannot_rewrite() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let body = "<!doctype html><html><body><form><input id='pw' type='password'></form></body></html>";
                let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = sock.write_all(reply.as_bytes()).await;
            });
        }
    });

    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": format!("http://127.0.0.1:{port}/") }), &mut state).await);

    let resp = execute_command(&json!({ "id": "3", "action": "fill", "selector": "#pw", "value": "hunter2", "site": "127.0.0.1" }), &mut state).await;
    assert_success(&resp);
    assert_evaluate(&mut state, "4", "document.getElementById('pw').value", json!("hunter2")).await;

    let lie = "window.origin = 'https://bank.test'; \
               Object.defineProperty(Node.prototype, 'ownerDocument', { get() { return { defaultView: { origin: 'https://bank.test' } }; } }); \
               [window.origin, document.getElementById('pw').ownerDocument.defaultView.origin].join(' ')";
    assert_evaluate(&mut state, "5", lie, json!("https://bank.test https://bank.test")).await;
    let resp = execute_command(&json!({ "id": "6", "action": "fill", "selector": "#pw", "value": "bank-password", "site": "bank.test" }), &mut state).await;
    assert_eq!(resp["success"], json!(false), "a page that says it is another site gets nothing: {resp}");
    assert!(resp["error"].as_str().unwrap_or_default().contains(&format!("http://127.0.0.1:{port}")), "{resp}");
    assert_evaluate(&mut state, "7", "document.getElementById('pw').value", json!("hunter2")).await;

    let _ = execute_command(&json!({ "id": "8", "action": "close" }), &mut state).await;
}

/// A step is kept by a selector that finds its element on a later visit: what a person wrote about the element, passing
/// over an id a framework made, and its place on the page when nothing else tells it from its neighbours.
#[tokio::test]
#[ignore]
async fn e2e_a_step_is_found_again_by_what_lasts() {
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(
        &execute_command(
            &json!({ "id": "2", "action": "setcontent", "html": r#"<form><input id="email" name="email">
                <input id="react-88213" name="pw" type="password"><button id="ember1234" type="submit">Go</button></form>
                <a href="/help?a=1">Help</a><div class="a"><button>One</button></div><div class="b"><button>One</button></div>
                <div id="named"><span></span><span><a href="/same">Same</a></span></div><p><a href="/same">Same</a></p>
                <p><a class="country us" href="/c">United States</a></p><p><a class="country ca" href="/c">Canada</a></p>"# }),
            &mut state,
        )
        .await,
    );
    let found = |s: &'static str| s;
    for (element, expected) in [
        (found("#email"), Some("#email")),
        (found("input[type=password]"), Some(r#"input[name="pw"]"#)),
        (found("form button"), Some(r#"button[type="submit"]"#)),
        (found("a[href*=help]"), Some(r#"a[href="/help?a=1"]"#)),
        (found(".b button"), Some("body > div:nth-of-type(2) > button")),
        (found("#named a"), Some("#named > span:nth-of-type(2) > a")),
        (found("a.us"), Some("a.country.us")),
    ] {
        let got = super::capture::element_locator(&state, element).await;
        assert_eq!(got.as_deref(), expected, "{element}");
        if let Some(locator) = got {
            let resp = execute_command(&json!({ "id": "3", "action": "count", "selector": locator }), &mut state).await;
            assert_eq!(get_data(&resp)["count"], 1, "{element} is found again by its locator alone");
        }
    }
    assert_success(&execute_command(&json!({ "id": "9", "action": "close" }), &mut state).await);
}

/// A page with one sign-in form that posts, and the bodies it was sent.
async fn start_posting_login_server() -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let seen = bodies.clone();
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                if request.starts_with("POST") {
                    seen.lock().unwrap().push(request.split("\r\n\r\n").nth(1).unwrap_or_default().to_string());
                }
                let body = r#"<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
<form method="POST" action="/login">
  <input type="email" name="email"><input id="pw" type="password" name="password">
  <button type="submit">Sign in</button>
</form></body></html>"#;
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (base_url, bodies, handle)
}

/// The capture log's whole text once the session closes, which writes everything held back.
async fn close_and_read_log(state: &mut DaemonState, dir: &std::path::Path) -> String {
    assert_success(&execute_command(&json!({ "id": "close", "action": "close" }), state).await);
    std::fs::read_to_string(dir.join(format!("{}.jsonl", state.session_id))).unwrap_or_default()
}

/// A saved login's password never came through a command the log records, and it still goes out in a form's body: the log
/// has to name it where it leaves the store.
#[tokio::test]
#[ignore]
async fn e2e_a_saved_logins_password_reaches_the_log_as_its_name() {
    let env = EnvGuard::new(&["UNBROWSE_CAPTURE_DIR"]);
    let dir = tempfile::tempdir().unwrap();
    env.set("UNBROWSE_CAPTURE_DIR", dir.path().to_str().unwrap());
    let (base_url, bodies, server) = start_posting_login_server().await;
    let mut state = DaemonState::new();
    let profile = unique_auth_profile_name("capture");
    for command in [
        json!({ "id": "launch", "action": "launch", "headless": true }),
        json!({ "id": "save", "action": "auth_save", "name": profile, "url": base_url,
            "username": "me@example.test", "password": "Hunter-Two-22" }),
        json!({ "id": "login", "action": "auth_login", "name": profile }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    let _ = execute_command(&json!({ "id": "forget", "action": "auth_delete", "name": profile }), &mut state).await;
    let log = close_and_read_log(&mut state, dir.path()).await;
    server.abort();
    assert!(bodies.lock().unwrap().iter().any(|b| b.contains("Hunter-Two-22")), "the form really sent it");
    assert!(log.contains("/login"), "the sign-in is in the log: {log}");
    assert!(!log.contains("Hunter-Two-22"), "{log}");
}

/// A password typed into the focused field, or set or filled by a locator, goes out in the same body as one typed by
/// `fill`: which command typed it says nothing about what it is.
#[tokio::test]
#[ignore]
async fn e2e_a_password_typed_by_any_command_reaches_the_log_as_its_name() {
    let env = EnvGuard::new(&["UNBROWSE_CAPTURE_DIR"]);
    for (typing, secret) in [
        (json!({ "action": "keyboard", "subaction": "type", "text": "Typed-Pass-31" }), "Typed-Pass-31"),
        (json!({ "action": "keyboard", "subaction": "insertText", "text": "Insert-Pass-32" }), "Insert-Pass-32"),
        (json!({ "action": "inserttext", "text": "Bare-Insert-33" }), "Bare-Insert-33"),
        (json!({ "action": "setvalue", "selector": "#pw", "value": "Set-Value-34" }), "Set-Value-34"),
        (json!({ "action": "getbyplaceholder", "placeholder": "Password", "subaction": "fill", "value": "Locator-Pass-35" }), "Locator-Pass-35"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        env.set("UNBROWSE_CAPTURE_DIR", dir.path().to_str().unwrap());
        let (base_url, bodies, server) = start_posting_login_server().await;
        let mut state = DaemonState::new();
        for command in [
            json!({ "id": "launch", "action": "launch", "headless": true }),
            json!({ "id": "open", "action": "navigate", "url": base_url }),
            json!({ "id": "hint", "action": "page_evaluate", "script": "document.querySelector('#pw').placeholder = 'Password'; document.querySelector('#pw').focus()" }),
        ] {
            assert_success(&execute_command(&command, &mut state).await);
        }
        let mut typing = typing;
        typing["id"] = json!("typing");
        assert_success(&execute_command(&typing, &mut state).await);
        let click = json!({ "id": "send", "action": "click", "selector": "button[type=submit]" });
        assert_success(&execute_command(&click, &mut state).await);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let log = close_and_read_log(&mut state, dir.path()).await;
        server.abort();
        assert!(bodies.lock().unwrap().iter().any(|b| b.contains(secret)), "the form sent it: {typing}");
        assert!(!log.contains(secret), "{typing} left it in the log: {log}");
    }
}

/// HTTP Basic sends the password base64'd with its username in every request's headers, and the log keeps the headers.
#[tokio::test]
#[ignore]
async fn e2e_http_basic_credentials_reach_the_log_as_their_name() {
    let env = EnvGuard::new(&["UNBROWSE_CAPTURE_DIR"]);
    let dir = tempfile::tempdir().unwrap();
    env.set("UNBROWSE_CAPTURE_DIR", dir.path().to_str().unwrap());
    let (base_url, _, server) = start_posting_login_server().await;
    let mut state = DaemonState::new();
    for command in [
        json!({ "id": "launch", "action": "launch", "headless": true }),
        json!({ "id": "basic", "action": "credentials", "username": "me", "password": "Basic-Pass-41" }),
        json!({ "id": "open", "action": "navigate", "url": base_url }),
    ] {
        assert_success(&execute_command(&command, &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    let log = close_and_read_log(&mut state, dir.path()).await;
    server.abort();
    assert!(log.to_lowercase().contains("authorization"), "the log keeps the header: {log}");
    assert!(!log.contains(&STANDARD.encode("me:Basic-Pass-41")), "{log}");
}

/// A mark left on an element is what a page back from the back-forward cache holds: the clean-up after a click that
/// navigated ran on the next page. It must not pick the element of the next command.
#[tokio::test]
#[ignore]
async fn e2e_a_mark_left_on_a_page_never_picks_the_next_element() {
    let page = "data:text/html,<button data-agent-browser-located=true onclick=\"window.pressed='first'\">a</button><button onclick=\"window.pressed='second'\">b</button>";
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": page }), &mut state).await);
    let nth = json!({ "id": "3", "action": "nth", "selector": "button", "index": 1, "subaction": "click" });
    assert_success(&execute_command(&nth, &mut state).await);
    assert_evaluate(&mut state, "4", "window.pressed", json!("second")).await;
    let text = json!({ "id": "5", "action": "getbytext", "text": "b", "subaction": "click" });
    assert_success(&execute_command(&text, &mut state).await);
    assert_evaluate(&mut state, "6", "window.pressed", json!("second")).await;
    assert_success(&execute_command(&json!({ "id": "7", "action": "close" }), &mut state).await);
}

/// A click that opens a confirm leaves the page blocked: taking the mark off can't wait for it, and the command holds
/// the state lock while it does.
#[tokio::test]
#[ignore]
async fn e2e_a_located_click_that_opens_a_dialog_answers_at_once() {
    let page = "data:text/html,<button onclick=\"confirm('sure?')\">go</button>";
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": page }), &mut state).await);
    let text = json!({ "id": "3", "action": "getbytext", "text": "go", "subaction": "click" });
    let clicked = tokio::time::timeout(std::time::Duration::from_secs(8), execute_command(&text, &mut state))
        .await
        .expect("the mark's clean-up waited on a page a dialog holds");
    assert_success(&clicked);
    assert_success(&execute_command(&json!({ "id": "4", "action": "dialog", "response": "dismiss" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await);
}

/// `frame` says where commands act, so a locator finds and marks there, where its action then looks.
#[tokio::test]
#[ignore]
async fn e2e_a_locator_acts_in_the_selected_frame() {
    let page = "data:text/html,<button onclick=\"window.pressed='top'\">go</button><iframe id=f srcdoc=\"<button onclick=&quot;parent.pressed='frame'&quot;>go</button>\"></iframe>";
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": page }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "3", "action": "frame", "selector": "#f" }), &mut state).await);
    let text = json!({ "id": "4", "action": "getbytext", "text": "go", "subaction": "click" });
    assert_success(&execute_command(&text, &mut state).await);
    let nth = json!({ "id": "5", "action": "nth", "selector": "button", "index": 0, "subaction": "text" });
    assert_success(&execute_command(&nth, &mut state).await);
    assert_success(&execute_command(&json!({ "id": "6", "action": "mainframe" }), &mut state).await);
    assert_evaluate(&mut state, "7", "window.pressed", json!("frame")).await;
    assert_success(&execute_command(&json!({ "id": "8", "action": "close" }), &mut state).await);
}

/// A page that says what the pointer did, and a box on it.
const POINTER_PAGE: &str = "data:text/html,<title>p</title><div id=box style='position:fixed;left:0;top:0;width:300px;height:300px'>x</div><div id=there style='position:fixed;left:400px;top:0;width:100px;height:100px'>y</div><script>window.said=[];for(const n of ['mousedown','mouseup','mousemove'])addEventListener(n,e=>said.push(n+':'+e.buttons))</script>";

async fn launch_on_pointer_page() -> DaemonState {
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": POINTER_PAGE }), &mut state).await);
    state
}

async fn a_command_answers(cmd: Value, state: &mut DaemonState) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(8), execute_command(&cmd, state))
        .await
        .expect("a sync dialog holds the event's ack: the command has to stop at the dialog, not wait it out")
}

/// A confirm in a mousedown handler blocks the page, so Chrome never acks the press. The command says so at once.
#[tokio::test]
#[ignore]
async fn e2e_a_mousedown_that_opens_a_dialog_answers_at_once() {
    let mut state = launch_on_pointer_page().await;
    let arm = "addEventListener('mousedown',()=>confirm('sure?'))";
    assert_success(&execute_command(&json!({ "id": "3", "action": "page_evaluate", "script": arm }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "4", "action": "mousemove", "x": 50, "y": 50 }), &mut state).await);

    let pressed = a_command_answers(json!({ "id": "5", "action": "mousedown" }), &mut state).await;
    assert_success(&pressed);
    assert_eq!(pressed["data"]["dialogOpened"], json!(true), "{pressed}");
    assert_eq!(state.mouse_state.buttons, 1, "the press reached the page: its button is down until mouseup");

    assert_success(&execute_command(&json!({ "id": "6", "action": "dialog", "response": "accept" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "7", "action": "mouseup" }), &mut state).await);
    assert_eq!(state.mouse_state.buttons, 0);
    assert_success(&execute_command(&json!({ "id": "8", "action": "close" }), &mut state).await);
}

/// A dialog on a drag's press stops the drag, and the button goes up once the dialog does.
#[tokio::test]
#[ignore]
async fn e2e_a_drag_stopped_by_a_dialog_lets_go_when_it_ends() {
    let mut state = launch_on_pointer_page().await;
    let arm = "addEventListener('mousedown',()=>confirm('sure?'))";
    assert_success(&execute_command(&json!({ "id": "3", "action": "page_evaluate", "script": arm }), &mut state).await);

    let drag = json!({ "id": "4", "action": "drag", "source": "#box", "target": "#there" });
    let dragged = a_command_answers(drag, &mut state).await;
    assert_success(&dragged);
    assert_eq!(dragged["data"]["dragged"], json!(false), "{dragged}");
    assert_eq!(dragged["data"]["dialogOpened"], json!(true), "{dragged}");

    assert_success(&execute_command(&json!({ "id": "5", "action": "dialog", "response": "accept" }), &mut state).await);
    assert_evaluate(&mut state, "6", "1", json!(1)).await;
    assert_eq!(state.mouse_state.buttons, 0, "the button stayed down");
    assert_evaluate(&mut state, "7", "said.includes('mouseup:0')", json!(true)).await;
    assert_success(&execute_command(&json!({ "id": "8", "action": "close" }), &mut state).await);
}

/// A press Chrome refused pressed nothing.
#[tokio::test]
#[ignore]
async fn e2e_a_mouse_event_chrome_refused_changes_nothing_here() {
    let mut state = launch_on_pointer_page().await;
    let refused = json!({ "id": "3", "action": "input_mouse", "type": "notAnEvent", "x": 77, "y": 88, "buttons": 1 });
    let answer = execute_command(&refused, &mut state).await;
    assert_eq!(answer["success"], json!(false), "{answer}");
    assert_eq!((state.mouse_state.x, state.mouse_state.y, state.mouse_state.buttons), (0.0, 0.0, 0));
    assert_success(&execute_command(&json!({ "id": "4", "action": "close" }), &mut state).await);
}

/// Chrome keeps a pointer for each page. A button held on one tab must not make another tab's moves read as a drag, and
/// it is still held on its own tab when that tab comes back.
#[tokio::test]
#[ignore]
async fn e2e_a_button_held_on_one_tab_is_not_held_on_another() {
    let mut state = launch_on_pointer_page().await;
    assert_success(&execute_command(&json!({ "id": "3", "action": "mousemove", "x": 50, "y": 50 }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "4", "action": "mousedown" }), &mut state).await);

    assert_success(&execute_command(&json!({ "id": "5", "action": "tab_new", "url": POINTER_PAGE }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "6", "action": "mousemove", "x": 60, "y": 60 }), &mut state).await);
    assert_evaluate(&mut state, "7", "said.join()", json!("mousemove:0")).await;

    assert_success(&execute_command(&json!({ "id": "8", "action": "tab_switch", "tabId": "t1" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "9", "action": "mousemove", "x": 70, "y": 70 }), &mut state).await);
    assert_evaluate(&mut state, "10", "said.at(-1)", json!("mousemove:1")).await;
    assert_success(&execute_command(&json!({ "id": "11", "action": "mouseup" }), &mut state).await);
    assert_evaluate(&mut state, "12", "said.at(-1)", json!("mouseup:0")).await;
    assert_success(&execute_command(&json!({ "id": "13", "action": "close" }), &mut state).await);
}

/// A tab that closes itself on the press leaves the drag with nowhere to go: the failure says so, and no button stays
/// down for the next page.
#[tokio::test]
#[ignore]
async fn e2e_a_drag_that_fails_after_its_press_leaves_no_button_down() {
    let mut state = launch_on_pointer_page().await;
    assert_success(&execute_command(&json!({ "id": "3", "action": "tab_new", "url": POINTER_PAGE }), &mut state).await);
    let arm = "addEventListener('mousedown',()=>close())";
    assert_success(&execute_command(&json!({ "id": "4", "action": "page_evaluate", "script": arm }), &mut state).await);

    let drag = json!({ "id": "5", "action": "drag", "source": "#box", "target": "#there" });
    let dragged = a_command_answers(drag, &mut state).await;
    assert_eq!(dragged["success"], json!(false), "the page went: {dragged}");
    assert_eq!(state.mouse_state.buttons, 0, "the button stayed down");
    let _ = execute_command(&json!({ "id": "6", "action": "close" }), &mut state).await;
}

/// `frame` says where commands act: a wait for text, or for a condition, is answered by the selected frame, whatever the
/// top page holds.
#[tokio::test]
#[ignore]
async fn e2e_a_wait_for_text_or_a_condition_reads_the_selected_frame() {
    let page = "data:text/html,<title>t</title><iframe id=f srcdoc=\"<script>window.ready=1;document.addEventListener('DOMContentLoaded',()=>document.body.append('only here'))</script>\"></iframe>";
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": page }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "3", "action": "frame", "selector": "#f" }), &mut state).await);
    let text = json!({ "id": "4", "action": "wait", "text": "only here", "timeout": 2000 });
    assert_success(&execute_command(&text, &mut state).await);
    // A caller's condition reads the frame's document, never the page's own script (`agent_world`): the frame alone
    // holds a script element.
    let condition = json!({ "id": "5", "action": "wait", "function": "!!document.querySelector('script')", "timeout": 2000 });
    assert_success(&execute_command(&condition, &mut state).await);
    assert_success(&execute_command(&json!({ "id": "6", "action": "close" }), &mut state).await);
}

/// A page whose `/slow` answers after 2.5 s.
async fn start_slow_answer_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                if String::from_utf8_lossy(&buf[..n]).starts_with("GET /slow") {
                    tokio::time::sleep(std::time::Duration::from_millis(2_500)).await;
                }
                let body = "<!doctype html><title>t</title>";
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (base_url, handle)
}

/// The usual order: a click starts a call, then the agent waits for the network. The call was already on its way when
/// the wait began, and the network isn't idle until it answers.
#[tokio::test]
#[ignore]
async fn e2e_a_network_idle_wait_counts_what_was_already_on_its_way() {
    let (url, server) = start_slow_answer_server().await;
    let mut state = DaemonState::new();
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": url }), &mut state).await);
    let call = "fetch('/slow').then(() => { window.answered = true }); 1";
    assert_success(&execute_command(&json!({ "id": "3", "action": "page_evaluate", "script": call }), &mut state).await);
    let wait = json!({ "id": "4", "action": "waitforloadstate", "state": "networkidle" });
    assert_success(&execute_command(&wait, &mut state).await);
    assert_evaluate(&mut state, "5", "window.answered === true", json!(true)).await;
    assert_success(&execute_command(&json!({ "id": "6", "action": "close" }), &mut state).await);
    server.abort();
}

/// UNB-119. A checkout whose card fields sit in a frame of another site, as a payment provider's hosted fields do:
/// the page is on 127.0.0.1 and the frame on localhost, so Chrome gives the frame a process of its own, and the frame
/// is marked `role="presentation"` with a title, as hosted payment frames mark theirs. Confirm enables only when the
/// frame reports every field valid, the way a hosted form tells its page. `/note-only` holds a frame of the other
/// site with nothing marked for a card in it.
async fn start_hosted_card_server() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let body = match path.as_str() {
                    "/frame" => r#"<!doctype html><html><body style="margin:0">
<input name="number" autocomplete="cc-number" inputmode="numeric" placeholder="1234 1234 1234 1234" aria-label="Card number">
<input name="expiry" autocomplete="cc-exp" placeholder="MM / YY" aria-label="Expiration date">
<input name="cvc" autocomplete="cc-csc" placeholder="CVC" aria-label="Security code">
<input name="note" aria-label="Note">
<script>
function luhn(d){let s=0,a=false;for(let i=d.length-1;i>=0;i--){let n=+d[i];if(a){n*=2;if(n>9)n-=9}s+=n;a=!a}return d.length>=12&&s%10==0}
function check(){const v=n=>document.querySelector('[name='+n+']').value.replace(/\D/g,'');
 parent.postMessage({complete: luhn(v('number')) && v('expiry').length==4 && v('cvc').length>=3},'*')}
document.querySelectorAll('input').forEach(i=>i.addEventListener('input',check));
</script></body></html>"#
                        .to_string(),
                    "/note-only" => r#"<!doctype html><html><body><input name="note" aria-label="Note"></body></html>"#.to_string(),
                    other => {
                        let src = if other == "/unmarked" { "note-only" } else { "frame" };
                        format!(
                            r#"<!doctype html><html><head><title>Order summary</title></head><body>
<h1>Order summary</h1>
<iframe title="Secure payment input frame" role="presentation" src="http://localhost:{port}/{src}" style="width:700px;height:60px;border:0"></iframe>
<button id="confirm" disabled>Confirm</button>
<script>addEventListener('message', e => {{ document.getElementById('confirm').disabled = !e.data.complete; }});</script>
</body></html>"#
                        )
                    }
                };
                let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = sock.write_all(reply.as_bytes()).await;
            });
        }
    });
    port
}

/// Opens the hosted card checkout at `path` and waits for its frame's own session to attach.
async fn open_hosted_checkout(state: &mut DaemonState, port: u16, path: &str) {
    assert_success(&execute_command(&json!({ "id": "1", "action": "launch", "headless": true }), state).await);
    assert_success(&execute_command(&json!({ "id": "2", "action": "navigate", "url": format!("http://127.0.0.1:{port}{path}") }), state).await);
    for _ in 0..40 {
        if !state.iframe_sessions.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = execute_command(&json!({ "id": "w", "action": "url" }), state).await;
    }
    assert!(!state.iframe_sessions.is_empty(), "the card frame must be another site's, in a process of its own");
}

/// The ref a snapshot gave the element named `name`.
fn ref_named(snapshot: &Value, name: &str) -> String {
    get_data(snapshot)["refs"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, entry)| entry["name"] == name)
        .unwrap_or_else(|| panic!("no ref named {name}: {snapshot}"))
        .0
        .clone()
}

/// UNB-119. A snapshot goes into a frame Chrome calls presentational (a hosted card form's): the frame's fields get
/// refs, and filling them by ref completes the form, so the page's Confirm enables.
#[tokio::test]
#[ignore]
async fn e2e_a_card_form_in_another_sites_frame_is_filled_by_its_refs() {
    let port = start_hosted_card_server().await;
    let mut state = DaemonState::new();
    open_hosted_checkout(&mut state, port, "/").await;
    let snapshot = execute_command(&json!({ "id": "3", "action": "snapshot", "interactive": true }), &mut state).await;
    assert_success(&snapshot);
    let text = get_data(&snapshot)["snapshot"].as_str().unwrap_or_default().to_string();
    assert!(text.contains("Secure payment input frame"), "{text}");
    for (name, value) in [("Card number", "4242424242424242"), ("Expiration date", "1234"), ("Security code", "123")] {
        let r = ref_named(&snapshot, name);
        assert_success(&execute_command(&json!({ "id": "4", "action": "fill", "selector": format!("@{r}"), "value": value }), &mut state).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_evaluate(&mut state, "5", "document.getElementById('confirm').disabled", json!(false)).await;
    let _ = execute_command(&json!({ "id": "9", "action": "close" }), &mut state).await;
}

/// UNB-119. `frame <selector>` finds another site's frame by its element and points selectors into it: fill, type,
/// click and press all act in the frame. What the page is stays the top page's: its address, its document (which the
/// node holds secrets and script marks to), so nothing the node keeps on a page moves with the frame.
#[tokio::test]
#[ignore]
async fn e2e_frame_selection_leaves_the_page_the_top_ones() {
    let port = start_hosted_card_server().await;
    let mut state = DaemonState::new();
    open_hosted_checkout(&mut state, port, "/").await;
    let before = execute_command(&json!({ "id": "3", "action": "document" }), &mut state).await;
    assert_success(&before);
    let frame = execute_command(&json!({ "id": "4", "action": "frame", "selector": "iframe[title=\"Secure payment input frame\"]" }), &mut state).await;
    assert_success(&frame);
    assert_success(&execute_command(&json!({ "id": "5", "action": "fill", "selector": "input[name=number]", "value": "4242424242424242" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "6", "action": "click", "selector": "input[name=expiry]" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "7", "action": "type", "selector": "input[name=expiry]", "text": "1234" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "8", "action": "type", "selector": "input[name=cvc]", "text": "12" }), &mut state).await);
    assert_success(&execute_command(&json!({ "id": "9", "action": "press", "key": "3" }), &mut state).await);
    // A script given now still runs in the top page, never in the other site's frame: what the frame holds is out of
    // its reach, and the node's script marks, kept on the tab, cover it either way.
    assert_evaluate(&mut state, "10", "location.origin", json!(format!("http://127.0.0.1:{port}"))).await;
    assert_eq!(frame_value(&state, "number").await, "4242424242424242");
    assert_eq!(frame_value(&state, "expiry").await, "1234");
    assert_eq!(frame_value(&state, "cvc").await, "123", "typed, then a key pressed");
    let url = execute_command(&json!({ "id": "11", "action": "url" }), &mut state).await;
    assert_eq!(get_data(&url)["url"], json!(format!("http://127.0.0.1:{port}/")), "{url}");
    let during = execute_command(&json!({ "id": "12", "action": "document" }), &mut state).await;
    assert_eq!(get_data(&during)["document"], get_data(&before)["document"], "the page's document, not the frame's");
    assert_success(&execute_command(&json!({ "id": "13", "action": "mainframe" }), &mut state).await);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_evaluate(&mut state, "14", "document.getElementById('confirm').disabled", json!(false)).await;
    let _ = execute_command(&json!({ "id": "15", "action": "close" }), &mut state).await;
}

/// UNB-119. A card bound to the checkout's site (as the node fills one from the vault) goes into a field of another
/// site's frame only when the checkout page holds that frame and the field is marked for a card; the browser says
/// which frame it went into. A login never leaves its own site's documents, and an unmarked field in such a frame
/// takes no card.
#[tokio::test]
#[ignore]
async fn e2e_a_card_goes_into_a_hosted_field_the_checkout_holds_and_nowhere_else() {
    let port = start_hosted_card_server().await;
    let mut state = DaemonState::new();
    open_hosted_checkout(&mut state, port, "/").await;
    let snapshot = execute_command(&json!({ "id": "3", "action": "snapshot", "interactive": true }), &mut state).await;
    assert_success(&snapshot);
    let number = ref_named(&snapshot, "Card number");
    let note = ref_named(&snapshot, "Note");
    let card = |selector: &str, value: &str, field: &str| {
        json!({ "id": "4", "action": "fill", "selector": selector, "value": value, "site": "127.0.0.1", "field": field, "as": "vault:card:test:number" })
    };
    let resp = execute_command(&card(&format!("@{number}"), "4242424242424242", "card"), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["field_checked"], json!(true));
    assert_eq!(get_data(&resp)["frame_origin"], json!(format!("http://localhost:{port}")), "{resp}");
    let resp = execute_command(&card(&format!("@{note}"), "4242424242424242", "card"), &mut state).await;
    assert_eq!(resp["success"], json!(false), "an unmarked field: {resp}");
    assert!(resp["error"].as_str().unwrap_or_default().contains("marked for a card"), "{resp}");
    let resp = execute_command(&card(&format!("@{number}"), "hunter2-login", "password"), &mut state).await;
    assert_eq!(resp["success"], json!(false), "a login stays on its own site: {resp}");
    // The same through `frame` and a selector.
    assert_success(&execute_command(&json!({ "id": "5", "action": "frame", "selector": "iframe" }), &mut state).await);
    let resp = execute_command(&card("input[name=cvc]", "123", "card"), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["frame_origin"], json!(format!("http://localhost:{port}")));
    assert_success(&execute_command(&json!({ "id": "6", "action": "mainframe" }), &mut state).await);
    // A card bound to another site gets nothing here: the checkout holding the frame is not on it.
    let resp = execute_command(&json!({ "id": "7", "action": "fill", "selector": format!("@{number}"), "value": "4242424242424242", "site": "shop.example", "field": "card" }), &mut state).await;
    assert_eq!(resp["success"], json!(false), "{resp}");
    let _ = execute_command(&json!({ "id": "9", "action": "close" }), &mut state).await;
}

/// UNB-119. A frame of another site with nothing marked for a card takes no card, whatever the page around it.
#[tokio::test]
#[ignore]
async fn e2e_an_unmarked_frame_of_another_site_takes_no_card() {
    let port = start_hosted_card_server().await;
    let mut state = DaemonState::new();
    open_hosted_checkout(&mut state, port, "/unmarked").await;
    assert_success(&execute_command(&json!({ "id": "3", "action": "frame", "selector": "iframe" }), &mut state).await);
    let resp = execute_command(&json!({ "id": "4", "action": "fill", "selector": "input[name=note]", "value": "4242424242424242", "site": "127.0.0.1", "field": "card" }), &mut state).await;
    assert_eq!(resp["success"], json!(false), "{resp}");
    assert_eq!(frame_value(&state, "note").await, "");
    let _ = execute_command(&json!({ "id": "9", "action": "close" }), &mut state).await;
}

/// The value of the field named `name` in the checkout's card frame, read through the frame's own session.
async fn frame_value(state: &DaemonState, name: &str) -> String {
    let frame_session = state.iframe_sessions.values().next().expect("the card frame's session").clone();
    let said = state
        .browser
        .as_ref()
        .unwrap()
        .client
        .send_command("Runtime.evaluate", Some(json!({ "expression": format!("document.querySelector('[name={name}]').value"), "returnByValue": true })), Some(&frame_session))
        .await
        .unwrap();
    said["result"]["value"].as_str().unwrap_or_default().to_string()
}
