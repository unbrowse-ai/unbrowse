//! Unbrowse fork: where a script the caller hands the daemon runs (`evaluate`, and `wait --fn`): an isolated world of
//! its own, [`WORLD`], never the page's main world. The world shares the page's DOM and none of its script, and
//! [`SCRIPT`] is installed in it before any of the caller's code: `document.cookie` and the page's storage answer with
//! every value said as `{session}`, what can't be answered that way (IndexedDB, the caches, workers, the Cookie Store
//! API) is taken away, and no way to hand code to the page's own world is left open. The page's own code keeps the real
//! values in its own world, so the site works as it did.
//!
//! The script is registered for every new document of the page in that world (`Page.addScriptToEvaluateOnNewDocument`
//! with `worldName`, `runImmediately` for the frames already there), so a frame's copy of the world has it before
//! anything can reach that frame's window; and it is run again, and checked, in the frame's world before each script.
//! A world that can't be made so refuses the script: nothing runs in a world the node can't vouch for.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use super::cdp::client::CdpClient;

/// The isolated world a caller's script runs in.
pub const WORLD: &str = "unbrowse-agent";
/// What is installed in [`WORLD`] before a caller's script, in every frame.
pub const SCRIPT: &str = concat!("(", include_str!("agent_world.js"), ")(", include_str!("activation.js"), ")");

/// The sessions (pages) [`SCRIPT`] is registered for.
static REGISTERED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn refused(why: impl std::fmt::Display) -> String {
    format!("the script wasn't run: its world couldn't be made safe for the site's session ({why})")
}

async fn register(client: &CdpClient, session: &str) -> Result<(), String> {
    if REGISTERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().any(|s| s == session) {
        return Ok(());
    }
    client.send_command_no_params("Page.enable", Some(session)).await.map_err(refused)?;
    client
        .send_command(
            "Page.addScriptToEvaluateOnNewDocument",
            Some(json!({ "source": SCRIPT, "worldName": WORLD, "runImmediately": true })),
            Some(session),
        )
        .await
        .map_err(refused)?;
    REGISTERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session.to_string());
    Ok(())
}

/// The execution context of [`WORLD`] in `frame` of `session`'s page (its main frame when `None`), with [`SCRIPT`]
/// installed there and checked: an error when it can't be.
pub async fn context(client: &CdpClient, session: &str, frame: Option<&str>) -> Result<i64, String> {
    register(client, session).await?;
    let frame = match frame {
        Some(f) => f.to_string(),
        None => {
            let tree = client.send_command_no_params("Page.getFrameTree", Some(session)).await.map_err(refused)?;
            tree["frameTree"]["frame"]["id"].as_str().ok_or_else(|| refused("the page has no frame"))?.to_string()
        }
    };
    let world = client
        .send_command("Page.createIsolatedWorld", Some(json!({ "frameId": frame, "worldName": WORLD })), Some(session))
        .await
        .map_err(refused)?;
    let context = world["executionContextId"].as_i64().ok_or_else(|| refused("no isolated world"))?;
    let installed = client
        .send_command(
            "Runtime.evaluate",
            Some(json!({ "expression": SCRIPT, "contextId": context, "returnByValue": true })),
            Some(session),
        )
        .await
        .map_err(refused)?;
    if installed["result"]["value"] != json!(true) {
        let said = installed["exceptionDetails"]["exception"]["description"].as_str().unwrap_or("it didn't say it was in place");
        return Err(refused(said));
    }
    Ok(context)
}

/// Runs `script` in [`WORLD`] of `session`'s main frame, waiting up to `within`, and answers its value.
pub async fn evaluate(client: &CdpClient, session: &str, script: &str, within: Duration) -> Result<Value, String> {
    evaluate_in(client, session, None, script, within).await
}

/// [`evaluate`] in `frame`.
pub async fn evaluate_in(client: &CdpClient, session: &str, frame: Option<&str>, script: &str, within: Duration) -> Result<Value, String> {
    let context = self::context(client, session, frame).await?;
    let said = client
        .send_command_within(
            "Runtime.evaluate",
            Some(json!({ "expression": script, "contextId": context, "returnByValue": true, "awaitPromise": true })),
            Some(session),
            within,
        )
        .await?;
    if let Some(details) = said.get("exceptionDetails") {
        let msg = details["exception"]["description"].as_str().or_else(|| details["text"].as_str()).unwrap_or("the script threw");
        return Err(format!("Evaluation error: {msg}"));
    }
    Ok(said["result"]["value"].clone())
}

/// Waits, up to `timeout_ms`, for `function` (an expression) to be truthy in [`WORLD`] of `frame` of `session`'s page.
pub async fn wait_for(client: &CdpClient, session: &str, frame: Option<&str>, function: &str, timeout_ms: u64) -> Result<(), String> {
    let started = std::time::Instant::now();
    let check = format!("!!({function})");
    loop {
        match evaluate_in(client, session, frame, &check, Duration::from_millis(timeout_ms.max(1))).await {
            Ok(Value::Bool(true)) => return Ok(()),
            Err(e) if e.starts_with("the script wasn't run") => return Err(e),
            _ => {}
        }
        if started.elapsed() >= Duration::from_millis(timeout_ms) {
            return Err(format!("Timeout after {timeout_ms}ms waiting for the function to be truthy"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The world the browser's own guard reads in: no code but the guard's ever runs there, the page's least of all, so every
/// built-in it calls is as the browser made it. The page's own world is never asked: a page can replace anything there
/// (`Array.prototype.filter`, `document.activeElement`), and a guard that read through it would see what the page chose.
const GUARD_WORLD: &str = "unbrowse-guard";

/// The script addresses activating the element (`this`) could reach, as `activation.js` reads them (the platform's own
/// forwarding followed), with `asInput` for a key or a newline typed: run in [`GUARD_WORLD`], gathered by index into a
/// fresh array, never through an array's methods.
const GUARD: &str = concat!(
    "function (asInput) { const a = (",
    include_str!("activation.js"),
    "); const o = a.natives(globalThis); const t = a.addresses(this, asInput, o); const out = []; \
     for (let i = 0; i < t.length; i++) if (a.runsScript(t[i], o)) out[out.length] = '' + t[i]; return out; }"
);

/// The deepest element with the focus in a document, read in [`GUARD_WORLD`]: through open shadow roots and frames whose
/// document can be read. It stops at a frame whose document can't be read (another process's) and at a shadow host
/// whose root is closed; the caller reads those another way.
const FOCUS: &str = "(() => { let e = document.activeElement; \
    for (let i = 0; i < 64 && e; i++) { \
      if (e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; } \
      let d = null; try { d = e.contentDocument; } catch (_) { d = null; } \
      if (d && d.activeElement) { e = d.activeElement; continue; } \
      break; } \
    return e || document.body; })()";

fn refused_target(address: &str) -> String {
    let shown: String = address.chars().take(40).collect();
    format!("the element would run a script address ({shown}…) in the page's own world, which no agent's command activates: nothing was done")
}

fn cannot_tell(what: &str) -> String {
    format!("what the command would activate couldn't be told ({what}): nothing was done")
}

/// Every frame of `session`'s page, its main frame first.
async fn frames_of(client: &CdpClient, session: &str) -> Result<Vec<String>, String> {
    let tree = client.send_command_no_params("Page.getFrameTree", Some(session)).await.map_err(|e| cannot_tell(&format!("its frames: {e}")))?;
    let mut out = Vec::new();
    let mut next = vec![tree["frameTree"].clone()];
    while let Some(f) = next.pop() {
        if let Some(id) = f["frame"]["id"].as_str() {
            out.push(id.to_string());
        }
        next.extend(f["childFrames"].as_array().cloned().unwrap_or_default());
    }
    if out.is_empty() {
        return Err(cannot_tell("the page has no frame"));
    }
    Ok(out)
}

/// [`GUARD_WORLD`]'s context in `frame` of `session`.
async fn guard_context(client: &CdpClient, session: &str, frame: &str) -> Result<i64, String> {
    let world = client
        .send_command("Page.createIsolatedWorld", Some(json!({ "frameId": frame, "worldName": GUARD_WORLD })), Some(session))
        .await
        .map_err(|e| cannot_tell(&format!("its world: {e}")))?;
    world["executionContextId"].as_i64().ok_or_else(|| cannot_tell("no world"))
}

/// The node `backend` as [`GUARD_WORLD`] sees it, in whichever frame of `session` holds it.
async fn in_guard_world(client: &CdpClient, session: &str, backend: i64) -> Result<String, String> {
    for frame in frames_of(client, session).await? {
        let Ok(context) = guard_context(client, session, &frame).await else { continue };
        if let Ok(node) = client.send_command("DOM.resolveNode", Some(json!({ "backendNodeId": backend, "executionContextId": context })), Some(session)).await {
            if let Some(id) = node["object"]["objectId"].as_str() {
                return Ok(id.to_string());
            }
        }
    }
    Err(cannot_tell("the element is in no frame the guard can read"))
}

/// The script addresses activating the guard world's `object` could reach: an array of strings, or an error. Anything
/// else (an exception, another shape, no answer) is "can't tell".
async fn script_targets(client: &CdpClient, session: &str, object: &str, as_input: bool) -> Result<Vec<String>, String> {
    let said = client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({ "objectId": object, "functionDeclaration": GUARD, "arguments": [{ "value": as_input }], "returnByValue": true })),
            Some(session),
        )
        .await
        .map_err(|e| cannot_tell(&format!("the read: {e}")))?;
    script_targets_of(&said)
}

/// The guard's answer as a list of addresses: exactly an array of strings, with no exception, or "can't tell".
fn script_targets_of(said: &Value) -> Result<Vec<String>, String> {
    if said.get("exceptionDetails").is_some() {
        return Err(cannot_tell("the read threw"));
    }
    let list = said["result"]["value"].as_array().ok_or_else(|| cannot_tell("the read answered something other than a list"))?;
    list.iter().map(|v| v.as_str().map(String::from).ok_or_else(|| cannot_tell("the read's list held something other than text"))).collect()
}

/// The backend node id of the page-world object `object_id`.
async fn backend_of(client: &CdpClient, session: &str, object_id: &str) -> Result<i64, String> {
    let node = client.send_command("DOM.describeNode", Some(json!({ "objectId": object_id })), Some(session)).await.map_err(|e| cannot_tell(&format!("the element: {e}")))?;
    node["node"]["backendNodeId"].as_i64().ok_or_else(|| cannot_tell("the element has no node"))
}

/// Refuses on the first script address of `targets`.
fn none_of(targets: Vec<String>) -> Result<(), String> {
    match targets.into_iter().next() {
        Some(a) => Err(refused_target(&a)),
        None => Ok(()),
    }
}

/// Refuses, before anything is dispatched, a command that would activate `object_id` (in `session`) when anything that
/// activation could reach is a script address, read in [`GUARD_WORLD`] ([`GUARD`]). An element whose targets can't be
/// read, or whose read answers anything but a list of addresses, is refused too.
pub async fn no_script_target(client: &CdpClient, session: &str, object_id: &str, as_input: bool) -> Result<(), String> {
    let backend = backend_of(client, session, object_id).await?;
    let guarded = in_guard_world(client, session, backend).await?;
    none_of(script_targets(client, session, &guarded, as_input).await?)
}

/// Every element node under `node` (a `DOM.describeNode` / `DOM.getDocument` tree pierced through shadow roots and frame
/// documents), with its attributes.
fn elements_in(node: &Value, out: &mut Vec<(i64, Vec<String>)>) {
    if node["nodeType"].as_i64() == Some(1) {
        if let Some(id) = node["backendNodeId"].as_i64() {
            let attrs = node["attributes"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            out.push((id, attrs));
        }
    }
    for key in ["children", "shadowRoots", "pseudoElements"] {
        for child in node[key].as_array().into_iter().flatten() {
            elements_in(child, out);
        }
    }
    if let Some(doc) = node.get("contentDocument") {
        elements_in(doc, out);
    }
}

/// [`no_script_target`] for what a key pressed in `session`'s page could activate, read in [`GUARD_WORLD`]:
/// - the element with the focus, through open shadow roots and frames, read as an input (Enter submits its form); a
///   frame of another process is followed through its own session (`iframe_sessions`, by frame id), and a frame that
///   can't be followed is "can't tell";
/// - a shadow host whose root is closed may hold the focus out of sight: every element inside it is read too;
/// - with `access_keys` (a chord holding a modifier some platform uses for access keys), every element of the page with
///   an `accesskey`, closed shadow roots and frames included (`DOM.getDocument`, pierced), and of every frame of its own
///   process, since which one the chord would reach is the platform's to decide.
pub async fn no_script_target_of_press(client: &CdpClient, session: &str, iframe_sessions: &std::collections::HashMap<String, String>, access_keys: bool) -> Result<(), String> {
    if access_keys {
        let mut sessions = vec![session.to_string()];
        sessions.extend(iframe_sessions.values().cloned());
        for s in &sessions {
            let doc = client
                .send_command("DOM.getDocument", Some(json!({ "depth": -1, "pierce": true })), Some(s))
                .await
                .map_err(|e| cannot_tell(&format!("the page's access keys: {e}")))?;
            let mut all = Vec::new();
            elements_in(&doc["root"], &mut all);
            for (backend, attrs) in all {
                if attrs.chunks(2).any(|kv| kv[0].eq_ignore_ascii_case("accesskey")) {
                    let guarded = in_guard_world(client, s, backend).await?;
                    none_of(script_targets(client, s, &guarded, false).await?)?;
                }
            }
        }
    }
    focus_in(client, session, iframe_sessions, 0).await
}

fn focus_in<'a>(client: &'a CdpClient, session: &'a str, iframe_sessions: &'a std::collections::HashMap<String, String>, depth: usize) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if depth > 8 {
            return Err(cannot_tell("frames too deep"));
        }
        let main = frames_of(client, session).await?.remove(0);
        let context = guard_context(client, session, &main).await?;
        let focus = client
            .send_command("Runtime.evaluate", Some(json!({ "expression": FOCUS, "contextId": context })), Some(session))
            .await
            .map_err(|e| cannot_tell(&format!("the focus: {e}")))?;
        if focus.get("exceptionDetails").is_some() {
            return Err(cannot_tell("the focus read threw"));
        }
        let object = focus["result"]["objectId"].as_str().ok_or_else(|| cannot_tell("no focused element"))?.to_string();
        none_of(script_targets(client, session, &object, true).await?)?;
        // What the guard world couldn't look into: a frame of another process, a closed shadow root.
        let described = client
            .send_command("DOM.describeNode", Some(json!({ "objectId": object, "depth": -1, "pierce": true })), Some(session))
            .await
            .map_err(|e| cannot_tell(&format!("the focused element: {e}")))?;
        let node = &described["node"];
        let name = node["localName"].as_str().unwrap_or_default();
        if matches!(name, "iframe" | "frame") && node.get("contentDocument").is_none() {
            let frame = node["frameId"].as_str().ok_or_else(|| cannot_tell("a frame with no id"))?;
            let inner = iframe_sessions.get(frame).ok_or_else(|| cannot_tell("the focus is in a frame the guard can't read"))?;
            return focus_in(client, inner, iframe_sessions, depth + 1).await;
        }
        if node["shadowRoots"].as_array().is_some_and(|r| r.iter().any(|root| root["shadowRootType"].as_str() == Some("closed"))) {
            let mut inside = Vec::new();
            for root in node["shadowRoots"].as_array().into_iter().flatten() {
                elements_in(root, &mut inside);
            }
            for (backend, _) in inside {
                let guarded = in_guard_world(client, session, backend).await?;
                none_of(script_targets(client, session, &guarded, true).await?)?;
            }
        }
        Ok(())
    })
}

/// The check at the moment of activation, installed once in each frame's [`GUARD_WORLD`] and armed only while one of the
/// browser's commands dispatches: a capturing listener on the frame's window for the events that come before an
/// activation (`click`, `auxclick`, `dblclick`, `submit` with its submitter, and a `keydown` of Enter, Space or a chord
/// with Alt or Control). It reads the event's real target with `activation.js`, as the read before the command does,
/// and cancels the event (its default and its propagation) when anything that target reaches is a script address or
/// the read fails. The read and the cancel run in the same task as the event, so nothing scheduled (a timer, the
/// agent's or the page's) runs between them. `ARMED` is replaced by `true` or `false`; the answer is the address that
/// was refused while armed, or empty.
const ARM: &str = concat!(
    "(() => { const g = globalThis; if (!g.__unbrowseGuard) { const a = (",
    include_str!("activation.js"),
    "); const o = a.natives(g); const st = { armed: false, refused: '' }; \
     const prevent = g.Event.prototype.preventDefault, stop = g.Event.prototype.stopImmediatePropagation, apply = Reflect.apply; \
     const check = (el, asInput) => { try { const t = a.addresses(el, asInput, o); for (let i = 0; i < t.length; i++) if (a.runsScript(t[i], o)) return '' + t[i]; return ''; } catch (_) { return 'its target could not be read'; } }; \
     const on = (e) => { if (!st.armed) return; let hit = ''; \
       if (e.type === 'submit') { hit = check(e.target, false); if (!hit && e.submitter) hit = check(e.submitter, false); } \
       else if (e.type === 'keydown') { if (e.key === 'Enter' || e.key === ' ' || e.altKey || e.ctrlKey) { const p = e.composedPath(); hit = check(p.length ? p[0] : e.target, true); } } \
       else { const p = e.composedPath(); hit = check(p.length ? p[0] : e.target, false); } \
       if (hit) { apply(prevent, e, []); apply(stop, e, []); if (!st.refused) st.refused = hit; } }; \
     for (const t of ['click', 'auxclick', 'dblclick', 'submit', 'keydown']) g.addEventListener(t, on, true); \
     g.__unbrowseGuard = st; } \
     const st = g.__unbrowseGuard; const said = st.refused; st.armed = ARMED; st.refused = ''; return said; })()"
);

/// Every session a dispatch in `session`'s page can reach: the page's own and each frame of another process.
fn reachable_sessions(session: &str, iframe_sessions: &std::collections::HashMap<String, String>) -> Vec<String> {
    let mut all = vec![session.to_string()];
    all.extend(iframe_sessions.values().cloned());
    all
}

/// Arms the check at the moment of activation ([`ARM`]) in every frame a dispatch in `session`'s page can reach. A
/// frame that can't be armed refuses the command: nothing is dispatched past a check that isn't there.
pub async fn arm(client: &CdpClient, session: &str, iframe_sessions: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let script = ARM.replace("ARMED", "true");
    for s in reachable_sessions(session, iframe_sessions) {
        for frame in frames_of(client, &s).await? {
            let context = guard_context(client, &s, &frame).await?;
            let said = client
                .send_command("Runtime.evaluate", Some(json!({ "expression": script, "contextId": context, "returnByValue": true })), Some(&s))
                .await
                .map_err(|e| cannot_tell(&format!("arming the check: {e}")))?;
            if said.get("exceptionDetails").is_some() || !said["result"]["value"].is_string() {
                return Err(cannot_tell("arming the check"));
            }
        }
    }
    Ok(())
}

/// How long disarming waits on one frame. A page a dialog holds (a `confirm` the click opened) runs no script until the
/// dialog is answered; its check is left armed, which only checks more: the click's default action, which runs after the
/// dialog, is still read at its moment.
const DISARM_WAIT: Duration = Duration::from_millis(1500);

/// Disarms the check in every frame it was armed in, and says what it refused while armed: an error naming the address
/// when it cancelled an activation. A frame gone since (the page navigated) took its check with it; a frame a dialog
/// holds keeps it armed ([`DISARM_WAIT`]).
pub async fn disarm(client: &CdpClient, session: &str, iframe_sessions: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let script = ARM.replace("ARMED", "false");
    let mut refused = String::new();
    for s in reachable_sessions(session, iframe_sessions) {
        let Ok(Ok(frames)) = tokio::time::timeout(DISARM_WAIT, frames_of(client, &s)).await else { continue };
        for frame in frames {
            let Ok(Ok(context)) = tokio::time::timeout(DISARM_WAIT, guard_context(client, &s, &frame)).await else { continue };
            if let Ok(said) = client.send_command_within("Runtime.evaluate", Some(json!({ "expression": script, "contextId": context, "returnByValue": true })), Some(&s), DISARM_WAIT).await {
                if let Some(hit) = said["result"]["value"].as_str().filter(|h| !h.is_empty()) {
                    refused = hit.to_string();
                }
            }
        }
    }
    if refused.is_empty() {
        Ok(())
    } else {
        Err(format!("at the moment of activation, {}", refused_target(&refused)))
    }
}

#[cfg(test)]
mod tests {
    use super::script_targets_of;
    use serde_json::json;

    /// Only a list of text is an answer: an exception, another shape, or a list holding anything else is "can't tell".
    #[test]
    fn a_guard_answer_of_any_other_shape_is_refused() {
        assert_eq!(script_targets_of(&json!({ "result": { "value": ["javascript:x()"] } })), Ok(vec!["javascript:x()".to_string()]));
        assert_eq!(script_targets_of(&json!({ "result": { "value": [] } })), Ok(vec![]));
        for odd in [
            json!({ "result": { "value": {} } }),
            json!({ "result": { "value": null } }),
            json!({ "result": {} }),
            json!({ "result": { "value": [1] } }),
            json!({ "result": { "value": ["a", null] } }),
            json!({ "result": { "value": [] }, "exceptionDetails": { "text": "x" } }),
        ] {
            assert!(script_targets_of(&odd).is_err(), "{odd}");
        }
    }
}
