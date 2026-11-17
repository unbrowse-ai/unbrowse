//! MCP over Streamable HTTP, answered as plain JSON: the same primitives as tools.

use super::*;

// ---- MCP (Streamable HTTP, answered as plain JSON) ----

/// The MCP tools: the primitives, as MCP lists them.
pub(super) fn tools() -> Value {
    Value::Array(PRIMITIVES.iter().map(|p| json!({ "name": p.tool, "description": p.description, "inputSchema": (p.schema)() })).collect())
}

/// A tool's object of values, each as a string (a number sent bare is its text).
pub(super) fn strings(v: Option<&Value>) -> HashMap<String, String> {
    decoded(v)
        .as_ref()
        .and_then(|i| i.as_object())
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect())
        .unwrap_or_default()
}

/// The MCP session a client opened (`Mcp-Session-Id`, issued at `initialize`), joined to a session the agent named:
/// the browsing session its tools run in (`browse_session`).
pub(super) fn in_mcp_session(headers: &HeaderMap, mut args: Value) -> Value {
    let Some(mcp) = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::trim).filter(|s| !s.is_empty()) else { return args };
    let named = text_arg(&args, "session");
    let session = if named.trim().is_empty() { format!("mcp:{mcp}") } else { format!("mcp:{mcp}/{}", named.trim()) };
    if let Some(o) = args.as_object_mut() {
        o.insert("session".into(), json!(session));
    }
    args
}

/// A fresh MCP session id: what each client that connects is told at `initialize` and sends on every request after.
pub(super) fn new_mcp_session() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the OS gives no randomness");
    hex::encode(bytes)
}

pub(super) async fn mcp(State(node): State<Arc<Node>>, headers: HeaderMap, Json(msg): Json<Value>) -> axum::response::Response {
    use axum::response::IntoResponse;
    // Every client gets its own session at `initialize`, and its browsing runs in a tab of its own (`in_mcp_session`).
    let fresh = msg.get("method").and_then(|m| m.as_str()) == Some("initialize") && msg.get("id").is_some();
    let answer = mcp_answer(node, &headers, msg).await;
    if fresh {
        let sid = new_mcp_session();
        return ([(axum::http::HeaderName::from_static("mcp-session-id"), sid)], answer).into_response();
    }
    answer.into_response()
}

tokio::task_local! {
    /// The stop flag of the tool call this task answers: set when the agent cancels it (`notifications/cancelled`) or
    /// its request goes (the connection dropped), and handed to every walk the call starts (`ask_stop`).
    static ASK_STOP: Arc<std::sync::atomic::AtomicBool>;
}

/// The tool calls being answered, by the client's session and the call's id, with their stop flags: what a
/// `notifications/cancelled` names. A client that sends no session is one session of its own.
static ASKS: std::sync::Mutex<Vec<((String, String), Arc<std::sync::atomic::AtomicBool>)>> = std::sync::Mutex::new(Vec::new());

fn ask_key(headers: &HeaderMap, id: &Value) -> (String, String) {
    let session = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    (session, id.to_string())
}

/// The stop flag of the ask this task works for: the tool call's, or, outside one, a flag of its own nobody sets.
pub(super) fn ask_stop() -> Arc<std::sync::atomic::AtomicBool> {
    ASK_STOP.try_with(|s| s.clone()).unwrap_or_default()
}

/// Sets an ask's stop flag when dropped unanswered: an agent that hangs up drops the request's future, and the work it
/// waited on has no one to answer.
pub(super) struct StopsUnlessAnswered(pub(super) Option<Arc<std::sync::atomic::AtomicBool>>);

impl StopsUnlessAnswered {
    pub(super) fn answered(mut self) {
        self.0 = None;
    }
}

impl Drop for StopsUnlessAnswered {
    fn drop(&mut self) {
        if let Some(stop) = self.0.take() {
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// Sets the stop flag of the call `notifications/cancelled` names, when it is still being answered. True if one was.
fn cancel(headers: &HeaderMap, params: Option<&Value>) -> bool {
    let Some(id) = params.and_then(|p| p.get("requestId")) else { return false };
    let key = ask_key(headers, id);
    let asks = ASKS.lock().unwrap_or_else(|p| p.into_inner());
    asks.iter().filter(|(k, _)| *k == key).inspect(|(_, stop)| stop.store(true, std::sync::atomic::Ordering::Relaxed)).count() > 0
}

/// The picture a tool's reply carries, as bytes for an MCP image block: only the reply of the tool that takes pictures
/// (`unbrowse_challenge`, whose `image` is the file it just wrote for this agent's own session), and only a file that
/// tool took (`challenge::picture`). Any other reply carries none, whatever its `image` says: a field a site's answer
/// or a listing could fill never reads a file, another agent's picture included, into this agent's answer. The picture
/// shows a signed-in page and has no use once handed over, so it is removed then.
fn picture_of(tool: &str, v: &Value) -> Option<Vec<u8>> {
    if tool != "unbrowse_challenge" {
        return None;
    }
    let path = v.get("image").and_then(|i| i.as_str())?;
    let bytes = crate::challenge::picture(path)?;
    let _ = std::fs::remove_file(path);
    Some(bytes)
}

pub(super) async fn mcp_answer(node: Arc<Node>, headers: &HeaderMap, msg: Value) -> (StatusCode, Json<Value>) {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or_default();
    // Notifications get no answer. A cancel stops the call it names: its walks end, and what they held goes back.
    let Some(id) = id else {
        if method == "notifications/cancelled" && cancel(headers, msg.get("params")) {
            eprintln!("mcp: a call was cancelled by its agent: its walks stop");
        }
        return (StatusCode::ACCEPTED, Json(Value::Null));
    };
    let ok = |result: Value| (StatusCode::OK, Json(json!({ "jsonrpc": "2.0", "id": id.clone(), "result": result })));
    let err = |code: i64, message: String| (StatusCode::OK, Json(json!({ "jsonrpc": "2.0", "id": id.clone(), "error": { "code": code, "message": message } })));
    // Compact: an agent pays for every character of the text, and indentation was 44% of a search's reply.
    // Each reply's size goes to the log by the tool's name (`reply {…}`), for the x-ray's cost strip: a size, never a value.
    let tool = msg.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or(method).to_string();
    let sized = |text: String| {
        eprintln!("reply {}", json!({ "tool": tool, "bytes": text.len() }));
        text
    };
    let text = |v: Value, is_error: bool| json!({ "content": [{ "type": "text", "text": sized(serde_json::to_string(&v).unwrap_or_default()) }], "isError": is_error });
    // The reply, with the page's picture as an image content block when it carries one (`image`, a path the node
    // wrote): the agent's own model sees the page as a picture, beside the JSON that names it.
    let shot = |tool: &str, v: Value| {
        let Some(bytes) = picture_of(tool, &v) else { return text(v, false) };
        let mime = v.get("mime").and_then(|m| m.as_str()).unwrap_or("image/png").to_string();
        let data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        json!({ "content": [
            { "type": "image", "data": data, "mimeType": mime },
            { "type": "text", "text": sized(serde_json::to_string(&v).unwrap_or_default()) }
        ], "isError": false })
    };

    match method {
        "initialize" => ok(json!({
            "protocolVersion": msg.pointer("/params/protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "unbrowse-node", "version": node.info.version },
            "instructions": "Unbrowse turns websites into calls. Say what you want with unbrowse_do, with the url of a page that does it: the node calls the route that does it, or learns one from the page and calls that. Calls go straight to the site's own API, no browser. For many pages (one per item, coin or user, on one site or several), make one unbrowse_do call with all of them in pages: the node runs them side by side, and a route learned on a site's first page answers the rest. Only when unbrowse_do says the page needs hands (how: browse), drive it with unbrowse_browse, never another browser: the node learns from every step."
        })),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": tools() })),
        "tools/call" => {
            let a = match agent(&node, headers) {
                Ok(a) => a,
                Err((_, m)) => return err(-32001, m),
            };
            let name = msg.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or_default();
            let args = in_mcp_session(headers, msg.pointer("/params/arguments").cloned().unwrap_or(json!({})));
            let Some(p) = PRIMITIVES.iter().find(|p| p.tool == name) else { return err(-32602, format!("no tool {name}")) };
            if let Some(k) = missing_arg(p, &args) {
                return err(-32602, format!("{name} needs {k}"));
            }
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let key = ask_key(headers, &id);
            ASKS.lock().unwrap_or_else(|p| p.into_inner()).push((key.clone(), stop.clone()));
            let unanswered = StopsUnlessAnswered(Some(stop.clone()));
            let r = ASK_STOP.scope(stop.clone(), run_primitive(p, &node, &a, args, p.tool)).await;
            unanswered.answered();
            ASKS.lock().unwrap_or_else(|p| p.into_inner()).retain(|(k, s)| !(*k == key && Arc::ptr_eq(s, &stop)));
            match r {
                // A reply that carries a picture of a page is given to the agent as an MCP image content block beside
                // its text: the agent's own model looks at it (`unbrowse_challenge`).
                Ok(v) => ok(shot(p.tool, v)),
                Err((s, m)) => ok(text(answer_of(s, &m).1, true)),
            }
        }
        other => err(-32601, format!("method not found: {other}")),
    }
}

#[cfg(test)]
mod stop_tests {
    use super::*;

    /// `notifications/cancelled` stops the call it names, in the session that sent it, and no other.
    #[test]
    fn a_cancel_stops_only_the_call_it_names() {
        let mut mine = HeaderMap::new();
        mine.insert("mcp-session-id", "cancel-test-a".parse().unwrap());
        let mut theirs = HeaderMap::new();
        theirs.insert("mcp-session-id", "cancel-test-b".parse().unwrap());
        let (a, b, c) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(std::sync::atomic::AtomicBool::new(false)));
        {
            let mut asks = ASKS.lock().unwrap();
            asks.push((ask_key(&mine, &json!(7)), a.clone()));
            asks.push((ask_key(&theirs, &json!(7)), b.clone()));
            asks.push((ask_key(&mine, &json!(8)), c.clone()));
        }
        assert!(cancel(&mine, Some(&json!({ "requestId": 7, "reason": "timed out" }))));
        let set = |f: &Arc<std::sync::atomic::AtomicBool>| f.load(std::sync::atomic::Ordering::Relaxed);
        assert!(set(&a) && !set(&b) && !set(&c), "only session a's call 7");
        assert!(!cancel(&mine, Some(&json!({ "requestId": 99 }))), "a call no longer answered is nothing to stop");
        ASKS.lock().unwrap().retain(|(k, _)| !k.0.starts_with("cancel-test-"));
    }

    /// A request dropped before it is answered (the agent hung up) stops what it started; one answered stops nothing.
    #[test]
    fn a_request_dropped_unanswered_stops_its_work() {
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        drop(StopsUnlessAnswered(Some(dropped.clone())));
        assert!(dropped.load(std::sync::atomic::Ordering::Relaxed));
        let answered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        StopsUnlessAnswered(Some(answered.clone())).answered();
        assert!(!answered.load(std::sync::atomic::Ordering::Relaxed));
        assert!(!ask_stop().load(std::sync::atomic::Ordering::Relaxed), "outside a call, a flag nobody sets");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture goes into an answer only from the reply of the tool that took it: the same `image`, naming a real
    /// picture the challenge tool took, in any other tool's reply reads nothing.
    #[test]
    fn only_the_challenge_reply_carries_its_picture() {
        let _home = crate::store::scratch_home("mcp-picture");
        let dir = crate::store::home().join("shots");
        std::fs::create_dir_all(&dir).unwrap();
        let shot = dir.join("challenge-1-a-1.png");
        std::fs::write(&shot, b"png").unwrap();
        let reply = json!({ "image": shot.to_string_lossy(), "mime": "image/png" });
        for tool in PRIMITIVES.iter().map(|p| p.tool).filter(|t| *t != "unbrowse_challenge") {
            assert!(picture_of(tool, &reply).is_none(), "{tool} carried a picture");
        }
        assert!(shot.exists(), "another tool's reply removes nothing");
        assert_eq!(picture_of("unbrowse_challenge", &reply).as_deref(), Some(&b"png"[..]));
        assert!(!shot.exists(), "the picture is still there after it was handed over");
    }
}
