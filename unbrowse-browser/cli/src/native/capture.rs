//! Unbrowse fork: passive capture for route learning ("Map while browsing").
//!
//! When `UNBROWSE_CAPTURE_DIR` is set, each session appends a JSON-lines log to
//! `<dir>/<session>.jsonl` while the agent browses: one line per finished request (a HAR 1.2
//! entry, cookies included) and one per agent action, with the values it typed. Nothing has to
//! be started or stopped; the node reads the log.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::actions::{har_entry_to_json, DaemonState, HarContentMode};

// The engine's capture primitives live in agent-browser-core: the node links
// the same library instead of driving a daemon over a socket.
pub use agent_browser_core::capture::{now_secs, CaptureLog, CAPTURE_DIR_ENV, LOGGED_ACTIONS, SETTLE};

/// Opens the session's log on the first command when capture is configured, and keeps request
/// recording on, with text bodies, for as long as it is.
pub fn ensure(state: &mut DaemonState) {
    // The secrets the log names are sealed beside it with the engine's key, so a daemon that restarts goes on naming
    // them. The key is looked for only when capture is on.
    if state.capture.is_none() && CaptureLog::configured_dir().is_some() {
        state.capture = CaptureLog::open_sealed(&state.session_id, super::auth::capture_sealer());
        if state.capture.is_some() && !state.har_recording {
            state.har_content_mode = HarContentMode::Text;
        }
    }
    if state.capture.is_some() {
        state.har_recording = true;
    }
}

/// Names in the log every value the node asked it to forget while another command held the
/// daemon's state ([`super::actions::WhileBusy`]): in what it already holds, and from now on. Runs
/// before anything else is written.
pub fn apply_queued(state: &mut DaemonState) {
    let values = state.while_busy.take_forgets();
    if values.is_empty() {
        return;
    }
    ensure(state);
    if let Some(log) = state.capture.as_mut() {
        for value in values {
            log.forget(&value);
        }
    }
}

/// How long a request that has its answer waits to be called finished before it is written anyway. A body still arriving
/// that long after its headers is rare, and writing it early would cost the walk that body. Counted from the answer: a
/// slow call has told us nothing about its body when it was sent.
const UNREAD_WAIT_SECS: f64 = 8.0;

/// The requests answered but never finished. Chrome calls a request finished once the page has read its body, so a call
/// the page sent and ignored the answer of (saving a store, a preference, a choice) would never be written: yet it is the
/// call that changed something. Its answer and headers are all there is, and they are written once it has waited, or when
/// the session closes.
fn answered_but_unread<'a>(entries: impl Iterator<Item = (&'a str, Option<i64>, f64)>, now: f64, all: bool) -> Vec<String> {
    entries.filter(|(_, status, answered_at)| status.is_some() && (all || now - answered_at >= UNREAD_WAIT_SECS)).map(|(id, _, _)| id.to_string()).collect()
}

/// Writes finished requests that have settled, or all of them when `all` (the session is
/// closing). Written requests leave memory unless a HAR recording is also running.
pub fn flush(state: &mut DaemonState, all: bool) {
    apply_queued(state);
    // A recording keeps its entries, so one it has written stays beside the rest: the final flush skips those by id.
    if !state.har_explicit || all {
        let waiting = state.har_entries.iter().filter(|e| !state.har_logged.contains(&e.request_id));
        let unread = answered_but_unread(waiting.map(|e| (e.request_id.as_str(), e.status, e.answered_at())), now_secs(), all);
        if let Some(log) = state.capture.as_mut() {
            unread.iter().for_each(|id| log.queue(id));
        }
    }
    let Some(log) = state.capture.as_mut() else { return };
    let due = if all { log.drain_pending() } else { log.settled() };
    for request_id in due {
        let Some(pos) = state.har_entries.iter().rposition(|e| e.request_id == request_id) else { continue };
        let entry = if state.har_explicit {
            state.har_logged.insert(request_id);
            state.har_entries[pos].clone()
        } else {
            let entry = state.har_entries.remove(pos);
            let body = entry.response_body.as_ref().map_or(0, String::len);
            state.har_body_total_bytes = state.har_body_total_bytes.saturating_sub(body);
            entry
        };
        let t = entry.seen_at;
        let resource_type = entry.resource_type.clone();
        if let Some(log) = state.capture.as_mut() {
            log.write(json!({ "type": "exchange", "t": t, "resourceType": resource_type, "entry": har_entry_to_json(entry) }));
        }
    }
}

/// Logs a page-driving action, stamped with the moment before it runs. For typed text, also
/// whether the field is a password or one-time code; such a value is written as its name
/// (`secret:<n>`, or the vault reference the node filled it from), never as typed. A value
/// is only typed once the typing finished: for `fill`, `type` and `select` the line is handed back
/// to be written when the command succeeds ([`log_done`]), so a fill aimed at a field that wasn't
/// there never reads as typed. Every other action is written at once.
pub async fn log_action(state: &mut DaemonState, action: &str, cmd: &Value) -> Option<Value> {
    if state.capture.is_none() {
        return None;
    }
    // Before a line is held back or skipped: a command the log doesn't record still sends what it carries, and the
    // request that sends it is written like any other.
    for (value, name) in credentials_carried(action, cmd) {
        name_secret(state, &value, &name);
    }
    // A login the node fills from its vault comes with its reference (`as`), which the log says instead of the
    // password. Agents can't send one: it isn't a flag the CLI parses, only a field the node puts on the request.
    let named = cmd.get("as").and_then(Value::as_str).filter(|_| matches!(action, "fill" | "type"));
    let typing = typed_text(action, cmd);
    let secret = match typing {
        _ if named.is_some() => true,
        Some((_, field)) => field_is_secret(state, field).await,
        None => false,
    };
    // From here on the log, and every request that sends it, carries the secret's name, never the secret.
    if let (true, Some((text, _)), Some(log)) = (secret, typing, state.capture.as_mut()) {
        log.keep_secret(text, named);
    }
    if !LOGGED_ACTIONS.contains(&action) {
        return None;
    }
    let selector = cmd.get("selector").and_then(Value::as_str);
    let value = match action {
        "fill" => cmd.get("value").cloned(),
        "type" | "keyboard" => cmd.get("text").cloned(),
        // A select is logged by what it sends: the chosen options' values, which a page's label ("Savings") need
        // not say (`1`).
        "select" => match selector {
            Some(sel) => Some(option_values(state, sel, cmd.get("values").cloned().unwrap_or(Value::Null)).await),
            None => cmd.get("values").cloned(),
        },
        "press" => cmd.get("key").cloned(),
        "navigate" => cmd.get("url").cloned(),
        _ => None,
    };
    let t = now_secs();
    // The field's own name for the learner: its name attribute, id, aria-label,
    // label text or placeholder, so routes name inputs the way a person would
    // ("Search Wikipedia") instead of by CSS selector.
    let field = match (action, selector) {
        ("fill" | "type" | "select", Some(sel)) => field_name(state, sel).await,
        _ => None,
    };
    // A choice made by a click is the caller's value as much as text they typed: a radio or a box that a form sends
    // by its name and its value (`size=medium`). The step is logged with both, as a fill is, so a route learned from
    // it takes the choice as an input and does not send the first choice ever after.
    let chosen = match (action, selector) {
        ("click" | "check", Some(sel)) => chosen_control(state, sel).await,
        _ => None,
    };
    let (field, value) = match chosen {
        Some((name, sent)) => (Some(name), Some(Value::String(sent))),
        None => (field, value),
    };
    // What finds the element again on a later visit: a snapshot's ref names it for that snapshot alone.
    let locator = match selector {
        Some(sel) if STEPS_ON_AN_ELEMENT.contains(&action) => element_locator(state, sel).await,
        _ => None,
    };
    let line = json!({ "type": "action", "t": t, "action": action, "selector": selector, "field": field, "locator": locator, "value": value, "secret": secret });
    if matches!(action, "fill" | "type" | "select") {
        return Some(line);
    }
    if let Some(log) = state.capture.as_mut() {
        log.write(line);
    }
    None
}

/// The text a command types on the page, and the field it names: none means whatever has the focus.
fn typed_text<'a>(action: &str, cmd: &'a Value) -> Option<(&'a str, Option<&'a str>)> {
    let text = match action {
        "fill" | "setvalue" => cmd.get("value"),
        "type" | "keyboard" | "inserttext" => cmd.get("text"),
        _ => None,
    };
    Some((text?.as_str()?, cmd.get("selector").and_then(Value::as_str)))
}

/// The credentials a command carries, each with the name the log says instead. What makes one a secret is what it is, so
/// the rule reads the command's fields, not its action: a `password` on any command, and the form HTTP Basic sends it in,
/// which is what a request's headers then carry.
fn credentials_carried(action: &str, cmd: &Value) -> Vec<(String, String)> {
    let Some(password) = cmd.get("password").and_then(Value::as_str) else { return Vec::new() };
    let username = cmd.get("username").and_then(Value::as_str).unwrap_or_default();
    let who = cmd.get("name").and_then(Value::as_str).unwrap_or(username);
    let mut carried = vec![(password.to_string(), format!("secret:{action}:{who}"))];
    if action == "credentials" {
        let basic = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, format!("{username}:{password}"));
        carried.push((basic, format!("secret:basic:{who}")));
    }
    carried
}

/// Says `name` instead of `value` from now on, in every line the log writes. The name starts as the log's own do, so the
/// learner reads it as a value only the owner has. Any length: this is a password by what it is, not by the look of it.
pub fn name_secret(state: &mut DaemonState, value: &str, name: &str) {
    if let Some(log) = state.capture.as_mut() {
        log.keep_secret(value, Some(name));
    }
}

/// Names `text` if the field it is going to is a secret one, for a command that finds its field itself (`find`, `getby*`).
pub async fn name_if_secret(state: &mut DaemonState, field: &str, text: &str) {
    if state.capture.is_some() && field_is_secret(state, Some(field)).await {
        if let Some(log) = state.capture.as_mut() {
            log.keep_secret(text, None);
        }
    }
}

/// Writes a typed action [`log_action`] held back, once its command succeeded.
pub fn log_done(state: &mut DaemonState, line: Option<Value>) {
    if let (Some(line), Some(log)) = (line, state.capture.as_mut()) {
        log.write(line);
    }
}

/// The field's identity, in the order a person would read it: `name`, then `id`,
/// then `aria-label`, then its label's text, then its placeholder. None if the
/// element can't be resolved.
/// The steps the node can take again by themselves (`unbrowse_learn::setup`).
const STEPS_ON_AN_ELEMENT: &[&str] = &["click", "fill", "type", "select", "check", "uncheck"];

/// Finds the first selector that names only this element, from what lasts about it: an id a person wrote, its name, a
/// test id or label, where a link goes, what a button does. An id a page's code made up changes between loads and names
/// nothing: it counts its way through the page, so one holding a number or a colon is passed over for what else there is.
/// With nothing else, its place on the page stands: it holds until the page is laid out anew, and a step that misses fails.
const UNIQUE_SELECTOR: &str = r#"function() {
  const doc = this.ownerDocument, tag = this.tagName.toLowerCase();
  const one = (s) => { try { const f = doc.querySelectorAll(s); return f.length === 1 && f[0] === this; } catch (e) { return false; } };
  const quoted = (v) => '"' + String(v).replace(/["\\]/g, '\\$&') + '"';
  const made = (v) => /[\d:]/.test(v);
  const tries = [];
  if (this.id && !made(this.id)) tries.push('#' + CSS.escape(this.id));
  for (const a of ['name', 'data-testid', 'data-test', 'aria-label', 'autocomplete']) {
    const v = this.getAttribute(a);
    if (v) tries.push(tag + '[' + a + '=' + quoted(v) + ']');
  }
  const href = this.getAttribute('href');
  if (href) tries.push(tag + '[href=' + quoted(href) + ']');
  const type = this.getAttribute('type');
  if (type) tries.push(tag + '[type=' + quoted(type) + ']');
  const value = this.getAttribute('value');
  if (value && tag === 'input') tries.push(tag + '[value=' + quoted(value) + ']');
  const classes = [...this.classList].filter((c) => !made(c)).map((c) => CSS.escape(c));
  if (classes.length) tries.push(tag + '.' + classes.join('.'));
  tries.push('form ' + tag, tag);
  // Nothing about it holds: its place on the page does, from the nearest ancestor that has a name of its own.
  const path = [];
  for (let e = this; e && e !== doc.body && e.parentElement; e = e.parentElement) {
    if (e !== this && e.id && !made(e.id)) { path.unshift('#' + CSS.escape(e.id)); break; }
    const same = [...e.parentElement.children].filter((c) => c.tagName === e.tagName);
    path.unshift(e.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(e) + 1) + ')' : ''));
  }
  tries.push((path[0] && path[0][0] === '#' ? '' : 'body > ') + path.join(' > '));
  return tries.find(one) || null;
}"#;

/// A selector that names the element at `selector` alone, when the page gives one. None for an element in a frame or a
/// shadow root the document can't reach: the step stays one only an agent can take.
pub(super) async fn element_locator(state: &DaemonState, selector: &str) -> Option<String> {
    let mgr = state.browser.as_ref()?;
    let session_id = mgr.active_session_id().ok()?;
    let (object_id, sid) = super::element::resolve_element_object_id(&mgr.client, session_id, &state.ref_map, selector, &state.iframe_sessions).await.ok()?;
    mgr.client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({ "objectId": object_id, "functionDeclaration": UNIQUE_SELECTOR, "returnByValue": true })),
            Some(&sid),
        )
        .await
        .ok()
        .and_then(|r| r.get("result")?.get("value")?.as_str().map(String::from))
}

/// The name and the value a form sends for the control at `selector`, when a click on it is a choice: a radio or a
/// checkbox with a name, or the label that stands for one. None for anything else a click lands on.
async fn chosen_control(state: &DaemonState, selector: &str) -> Option<(String, String)> {
    let mgr = state.browser.as_ref()?;
    let session_id = mgr.active_session_id().ok()?;
    let (object_id, sid) = super::element::resolve_element_object_id(&mgr.client, session_id, &state.ref_map, selector, &state.iframe_sessions).await.ok()?;
    let read = "function() { \
        const of = (e) => e && e.tagName === 'INPUT' && (e.type === 'radio' || e.type === 'checkbox') && e.name ? e : null; \
        const e = of(this) || of(this.control) || (this.querySelector ? of(this.querySelector('input[type=radio], input[type=checkbox]')) : null); \
        return e ? [String(e.name).slice(0, 80), String(e.value).slice(0, 200)] : null; }";
    let said = mgr
        .client
        .send_command("Runtime.callFunctionOn", Some(json!({ "objectId": object_id, "functionDeclaration": read, "returnByValue": true })), Some(&sid))
        .await
        .ok()?;
    let pair = said.get("result")?.get("value")?.as_array()?;
    Some((pair.first()?.as_str()?.to_string(), pair.get(1)?.as_str()?.to_string())).filter(|(name, _)| !name.is_empty())
}

async fn field_name(state: &DaemonState, selector: &str) -> Option<String> {
    let mgr = state.browser.as_ref()?;
    let session_id = mgr.active_session_id().ok()?;
    let (object_id, sid) = super::element::resolve_element_object_id(
        &mgr.client,
        session_id,
        &state.ref_map,
        selector,
        &state.iframe_sessions,
    )
    .await
    .ok()?;
    let read = "function() { const read = (s) => (s || '').trim().slice(0, 80); \
        const label = (this.labels && this.labels[0]) ? this.labels[0].innerText : ''; \
        return read(this.name) || read(this.id) || read(this.getAttribute('aria-label')) || read(label) || read(this.placeholder); }";
    mgr.client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({ "objectId": object_id, "functionDeclaration": read, "returnByValue": true })),
            Some(&sid),
        )
        .await
        .ok()
        .and_then(|r| r.get("result")?.get("value")?.as_str().map(String::from))
        .filter(|s| !s.is_empty())
}

/// The values a select at `selector` sends for the options `chosen` names, each by its value or its text: a page's
/// form sends an option's value, which its label need not say. A choice no option matches stays as it was chosen.
async fn option_values(state: &DaemonState, selector: &str, chosen: Value) -> Value {
    let Some(mgr) = state.browser.as_ref() else { return chosen };
    let Ok(session_id) = mgr.active_session_id() else { return chosen };
    let Ok((object_id, sid)) = super::element::resolve_element_object_id(&mgr.client, session_id, &state.ref_map, selector, &state.iframe_sessions).await else {
        return chosen;
    };
    let map = "function(chosen) { const all = Array.isArray(chosen) ? chosen : [chosen]; \
        const opts = this.options ? Array.from(this.options) : []; \
        return all.map((c) => { const s = String(c); const o = opts.find((o) => o.value === s) || opts.find((o) => (o.text || '').trim() === s.trim() || o.label === s); return o ? o.value : s; }); }";
    mgr.client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({ "objectId": object_id, "functionDeclaration": map, "arguments": [{ "value": chosen.clone() }], "returnByValue": true })),
            Some(&sid),
        )
        .await
        .ok()
        .and_then(|r| r.get("result")?.get("value").cloned())
        .filter(Value::is_array)
        .unwrap_or(chosen)
}

/// What makes a field's value a secret, read from the field.
const SECRET_FIELD: &str = "(e) => { const a = (e.autocomplete || '').toLowerCase(); \
    return e.type === 'password' || a.includes('password') || a === 'one-time-code' || a.startsWith('cc-'); }";

/// Whether a field is the kind whose value is secret. Reads the field named, or with none the one with the focus: typing
/// with no selector goes wherever the focus is, in the page or in a frame of it.
async fn field_is_secret(state: &DaemonState, selector: Option<&str>) -> bool {
    let Some(mgr) = state.browser.as_ref() else { return false };
    let Ok(session_id) = mgr.active_session_id() else { return false };
    let Some(selector) = selector else {
        let focused = format!(
            "(() => {{ let e = document.activeElement; for (;;) {{ \
             const inner = e && (e.shadowRoot ? e.shadowRoot.activeElement : e.contentDocument ? e.contentDocument.activeElement : null); \
             if (!inner) break; e = inner; }} return !!e && ({SECRET_FIELD})(e); }})()"
        );
        for sid in std::iter::once(session_id).chain(state.active_iframe_sessions.iter().map(String::as_str)) {
            let read = mgr.client.send_command("Runtime.evaluate", Some(json!({ "expression": focused, "returnByValue": true })), Some(sid));
            if read.await.ok().and_then(|r| r.get("result")?.get("value")?.as_bool()).unwrap_or(false) {
                return true;
            }
        }
        return false;
    };
    let Ok((object_id, sid)) = super::element::resolve_element_object_id(
        &mgr.client,
        session_id,
        &state.ref_map,
        selector,
        &state.iframe_sessions,
    )
    .await
    else {
        return false;
    };
    let check = format!("function() {{ return ({SECRET_FIELD})(this); }}");
    mgr.client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({ "objectId": object_id, "functionDeclaration": check, "returnByValue": true })),
            Some(&sid),
        )
        .await
        .ok()
        .and_then(|r| r.get("result")?.get("value")?.as_bool())
        .unwrap_or(false)
}

/// The most of a frame's payload kept in the log: a socket can stream large updates, and what an agent sends is small.
const FRAME_LIMIT: usize = 64 * 1024;

/// One of a page's socket events as a capture line: the socket's address when it opens, the headers it opened
/// with and was answered with, and each frame sent or received with its text (binary frames stay base64, as
/// Chrome reports them).
pub fn socket_line(method: &str, params: &Value) -> Option<Value> {
    let id = params.get("requestId").and_then(Value::as_str)?;
    let t = now_secs();
    let headers = |v: Option<&Value>| v.cloned().unwrap_or(Value::Null);
    let frame = |dir: &str| {
        let r = params.get("response")?;
        let opcode = r.get("opcode").and_then(Value::as_u64).unwrap_or(1);
        let data = r.get("payloadData").and_then(Value::as_str).unwrap_or_default();
        let data: String = data.chars().take(FRAME_LIMIT).collect();
        Some(json!({ "type": "socket", "t": t, "id": id, "event": dir, "opcode": opcode, "data": data }))
    };
    match method {
        "Network.webSocketCreated" => {
            Some(json!({ "type": "socket", "t": t, "id": id, "event": "open", "url": params.get("url").cloned().unwrap_or(Value::Null) }))
        }
        "Network.webSocketWillSendHandshakeRequest" => Some(
            json!({ "type": "socket", "t": t, "id": id, "event": "handshake", "headers": headers(params.pointer("/request/headers")) }),
        ),
        "Network.webSocketHandshakeResponseReceived" => Some(json!({
            "type": "socket", "t": t, "id": id, "event": "accepted",
            "status": params.pointer("/response/status").cloned().unwrap_or(Value::Null),
            "headers": headers(params.pointer("/response/headers")),
        })),
        "Network.webSocketFrameSent" => frame("sent"),
        "Network.webSocketFrameReceived" => frame("received"),
        "Network.webSocketClosed" => Some(json!({ "type": "socket", "t": t, "id": id, "event": "closed" })),
        _ => None,
    }
}

#[cfg(test)]
mod unread_tests {
    use super::*;

    /// A password is a credential on whichever command brings it, and HTTP Basic's is carried in the form its header sends.
    #[test]
    fn a_password_is_named_on_any_command_that_carries_it() {
        let saved = credentials_carried("auth_save", &json!({ "name": "shop", "username": "me", "password": "pw" }));
        assert_eq!(saved, [("pw".to_string(), "secret:auth_save:shop".to_string())]);
        let basic = credentials_carried("credentials", &json!({ "username": "me", "password": "pw" }));
        assert_eq!(basic[1], ("bWU6cHc=".to_string(), "secret:basic:me".to_string()));
        assert!(credentials_carried("fill", &json!({ "value": "pw" })).is_empty(), "a typed value is judged by its field");
    }

    /// Every command that types text is read for where it goes: with no selector, that is the focused field.
    #[test]
    fn text_is_read_from_every_command_that_types() {
        assert_eq!(typed_text("setvalue", &json!({ "selector": "#a", "value": "v" })), Some(("v", Some("#a"))));
        assert_eq!(typed_text("keyboard", &json!({ "subaction": "type", "text": "v" })), Some(("v", None)));
        assert_eq!(typed_text("inserttext", &json!({ "text": "v" })), Some(("v", None)));
        assert_eq!(typed_text("click", &json!({ "selector": "#a" })), None);
    }

    /// A recording's end writes what the walk hasn't had yet, and each entry once: the recording keeps its entries, so
    /// nothing else stops the next flush writing them again.
    #[test]
    fn a_recording_ending_writes_each_of_its_entries_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = DaemonState::new();
        state.capture = CaptureLog::open_in(dir.path(), "walk");
        state.har_explicit = true;
        state.har_entries.push(crate::native::actions::test_har_entry("answered", Some(200)));
        state.har_entries.push(crate::native::actions::test_har_entry("in-flight", None));

        flush(&mut state, true);
        flush(&mut state, true);

        let log = std::fs::read_to_string(dir.path().join("walk.jsonl")).unwrap();
        assert_eq!(log.lines().count(), 1, "{log}");
        assert!(log.contains("answered"), "{log}");
    }

    /// A call whose answer nobody read is written once it has waited, or as the session closes; one with no answer yet,
    /// and one still inside its wait, are left for the page to finish.
    #[test]
    fn an_answer_nobody_read_is_still_written() {
        let entries = [("waited", Some(200), 100.0), ("recent", Some(200), 107.0), ("no-answer", None, 100.0)];
        assert_eq!(answered_but_unread(entries.iter().copied(), 110.0, false), ["waited"]);
        assert_eq!(answered_but_unread(entries.iter().copied(), 110.0, true), ["waited", "recent"]);
    }
}
