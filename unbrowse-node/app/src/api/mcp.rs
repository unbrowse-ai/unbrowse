//! MCP over Streamable HTTP: the same primitives as tools, answered as plain JSON, or, for a tool call that asks to
//! hear its progress (`_meta.progressToken`), as an event stream: a progress event every `PROGRESS_EVERY` with what
//! the ask is doing, then the answer.

use super::*;

// ---- MCP (Streamable HTTP, answered as plain JSON) ----

/// The MCP tools: the primitives, as MCP lists them.
pub(super) fn tools() -> Value {
    Value::Array(PRIMITIVES.iter().map(|p| super::mcp_app::tool(p.tool, p.description, listed((p.schema)()))).collect())
}

/// A primitive's input as a model's tool schema takes it: without a combinator at its top level (`anyOf`, `oneOf`,
/// `allOf`), which the Anthropic API refuses there (OpenAI's strict mode too). What one said (a call has a goal or an
/// ask) is checked where the call is answered, and the SDKs and plugins read it from the manifest.
pub(crate) fn listed(mut schema: Value) -> Value {
    if let Some(o) = schema.as_object_mut() {
        for k in ["anyOf", "oneOf", "allOf"] {
            o.remove(k);
        }
    }
    schema
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

/// `POST /mcp`: a client that asked for route tools in the address it connects to (`/mcp?routes=tools`) asked as its
/// header does (`route_tools::asked`).
pub(super) async fn mcp_at(state: State<Arc<Node>>, mut headers: HeaderMap, axum::extract::RawQuery(query): axum::extract::RawQuery, msg: Json<Value>) -> axum::response::Response {
    if super::route_tools::asked_in(query.as_deref()) {
        headers.insert(super::route_tools::ASKED_IN_HEADER, axum::http::HeaderValue::from_static(super::route_tools::ASKED_IN_ADDRESS.1));
    }
    mcp(state, headers, msg).await
}

pub(super) async fn mcp(State(node): State<Arc<Node>>, headers: HeaderMap, Json(msg): Json<Value>) -> axum::response::Response {
    use axum::response::IntoResponse;
    // Every client gets its own session at `initialize`, and its browsing runs in a tab of its own (`in_mcp_session`).
    let fresh = msg.get("method").and_then(|m| m.as_str()) == Some("initialize") && msg.get("id").is_some();
    // Only a client that says it reads an event stream is sent one. Any other (no accept, `*/*`, JSON alone) is answered
    // in JSON, progress token or not: a relay that checks one signed body (`unb mcp`) can't read a stream.
    let streams = reads_streams(&headers);
    if let Some(token) = progress_token(&msg).filter(|_| streams) {
        return progress_stream(node, headers, msg, token).into_response();
    }
    let draws = fresh && super::mcp_app::declares(&msg);
    let answer = mcp_answer(node, &headers, msg).await;
    // A call that brought its session route tools is answered, for a client that reads a stream, as one: the changed
    // list first, then the answer (`tools.surfaced-by-session`).
    if streams && super::route_tools::added_by(&answer.1 .0) {
        return super::route_tools::told(answer.1 .0).into_response();
    }
    if fresh {
        let sid = new_mcp_session();
        if draws {
            super::mcp_app::remember(&sid);
        }
        return ([(axum::http::HeaderName::from_static("mcp-session-id"), sid)], answer).into_response();
    }
    answer.into_response()
}

/// Whether the client named event streams among what it accepts.
fn reads_streams(headers: &HeaderMap) -> bool {
    headers.get_all("accept").iter().filter_map(|v| v.to_str().ok()).any(|a| a.split(',').any(|t| t.split(';').next().is_some_and(|t| t.trim().eq_ignore_ascii_case("text/event-stream"))))
}

/// How often a tool call that asked to hear its progress is told it: well under any client's reset window, one small
/// event each time.
const PROGRESS_EVERY: std::time::Duration = if cfg!(test) { std::time::Duration::from_millis(40) } else { std::time::Duration::from_secs(5) };

/// The progress token a tool call carries (`params._meta.progressToken`), when it asks to hear its progress.
fn progress_token(msg: &Value) -> Option<Value> {
    let call = msg.get("method").and_then(Value::as_str) == Some("tools/call") && msg.get("id").is_some();
    msg.pointer("/params/_meta/progressToken").filter(|t| call && (t.is_string() || t.is_number())).cloned()
}

/// Aborts its tasks when dropped: a client that hangs up drops the stream, and the call it made is dropped unanswered,
/// so its ask's stop flag is set (`StopsUnlessAnswered`).
struct AbortOnDrop(Vec<tokio::task::AbortHandle>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.iter().for_each(tokio::task::AbortHandle::abort);
    }
}

/// A tool call answered as an event stream (Streamable HTTP lets a POST's reply be one): `notifications/progress` every
/// `PROGRESS_EVERY` with the call's progress token, a count that grows, and what its ask is doing (`asks::Ask::phase`),
/// then the JSON-RPC answer as the last event.
fn progress_stream(node: Arc<Node>, headers: HeaderMap, msg: Value, token: Value) -> axum::response::Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use axum::response::IntoResponse;
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let who = agent(&node, &headers).map(|a| a.address).unwrap_or_default();
    let key = ask_key(&headers, &who, &id);
    let (tx, rx) = tokio::sync::mpsc::channel::<Event>(8);
    // The answer is worked out on a task of its own, which keeps how the message arrived (`remote::arrived_via`).
    let call = tokio::spawn(crate::remote::keep_arrival(async move { mcp_answer(node, &headers, msg).await.1 .0 }));
    let aborts = call.abort_handle();
    let teller = tokio::spawn(async move {
        let mut call = call;
        let mut tick = tokio::time::interval(PROGRESS_EVERY);
        tick.tick().await;
        let mut progress = 0u64;
        loop {
            tokio::select! {
                answer = &mut call => {
                    let answer = answer.unwrap_or_else(|e| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": format!("the call stopped: {e}") } }));
                    if super::route_tools::added_by(&answer) {
                        let _ = tx.send(Event::default().data(super::route_tools::LIST_CHANGED)).await;
                    }
                    let _ = tx.send(Event::default().data(answer.to_string())).await;
                    return;
                }
                _ = tick.tick() => {
                    progress += 1;
                    let stop = ASKS.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|(k, _)| *k == key).map(|(_, s)| s.clone());
                    let phase = stop.and_then(|s| super::asks::by_stop(&s)).map(|a| a.phase_now()).unwrap_or("working");
                    let note = json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": { "progressToken": token, "progress": progress, "message": phase } });
                    if tx.send(Event::default().data(note.to_string())).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    let guard = AbortOnDrop(vec![aborts, teller.abort_handle()]);
    let events = futures_util::stream::unfold((rx, guard), |(mut rx, guard)| async move { rx.recv().await.map(|e| (Ok::<_, std::convert::Infallible>(e), (rx, guard))) });
    Sse::new(events).keep_alive(KeepAlive::default()).into_response()
}

/// A tool call being answered, as a `notifications/cancelled` names it: the client's session, the agent whose key made
/// the call (its address), and the call's id.
type AskKey = (String, String, String);

/// The tool calls being answered, by [`AskKey`], with their stop flags: what a `notifications/cancelled` names. A client
/// that sends no session is one session of its own, and only the agent that made a call can name it.
static ASKS: std::sync::Mutex<Vec<(AskKey, Arc<std::sync::atomic::AtomicBool>)>> = std::sync::Mutex::new(Vec::new());

/// The [`AskKey`] of call `id`, made by the agent at address `who` with `headers`.
fn ask_key(headers: &HeaderMap, who: &str, id: &Value) -> AskKey {
    let session = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    (session, who.to_string(), id.to_string())
}

/// The stop flag of the ask this task works for (`asks::current`): the tool call's, set when the agent cancels it
/// (`notifications/cancelled`) or its request goes (the connection dropped), and handed to every walk the call starts;
/// or, outside one, a flag of its own nobody sets.
pub(super) fn ask_stop() -> Arc<std::sync::atomic::AtomicBool> {
    super::asks::current().map(|a| a.stop.clone()).unwrap_or_default()
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

/// Sets the stop flag of the call `notifications/cancelled` names, when it is still being answered and the agent at
/// address `who` made it. True if one was.
fn cancel(headers: &HeaderMap, who: &str, params: Option<&Value>) -> bool {
    let Some(id) = params.and_then(|p| p.get("requestId")) else { return false };
    let key = ask_key(headers, who, id);
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
    // Notifications get no answer. A cancel stops the call it names, and only when the key that sent it is the key of
    // the agent that made the call: its walks end, and what they held goes back. One with no key, a wrong key or
    // another agent's key changes nothing (audit 1118 N5: any program on the machine could stop another agent's call
    // by guessing a small request id).
    let Some(id) = id else {
        if method == "notifications/cancelled" {
            if let Ok(a) = agent(&node, headers) {
                if cancel(headers, &a.address, msg.get("params")) {
                    eprintln!("mcp: a call was cancelled by its agent: its walks stop");
                }
            }
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
        "initialize" if crate::remote::arrived_public() => ok(json!({
            "protocolVersion": msg.pointer("/params/protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
            "capabilities": { "tools": {}, "resources": {} },
            "serverInfo": { "name": "unbrowse-public-peer", "version": node.info.version },
            "instructions": "Unbrowse is the universal connector: it connects to websites and calls them. This is a public Unbrowse peer: it calls routes only, with no browser and no sign-in. Say what you want with unbrowse_do, with the url of a page that does it: the peer calls a route that does it, from the network or one it keeps, straight to the site's own API. For many pages, make one unbrowse_do call with all of them in pages. A page that needs a browser or a sign-in needs the user's own Unbrowse: give them the link in the answer's person (https://unbrowse.ai/#install) to install the app and sign in there with the same Unbrowse account; it links itself to you. Never ask them to type a command."
        })),
        "initialize" => {
            // An app on this computer, or one through the owner's web address; never a peer's.
            let via = crate::remote::arrived_via();
            if via.as_deref() != Some(crate::remote::PEER_NETWORK) {
                if let Some(name) = msg.pointer("/params/clientInfo/name").and_then(Value::as_str) {
                    crate::heard::note(&node, name, via.is_some());
                }
            }
            // A client that asked for route tools hears when its session reached more (`tools.surfaced-by-session`).
            let tools_cap = if super::route_tools::asked(headers) { json!({ "listChanged": true }) } else { json!({}) };
            ok(json!({
                "protocolVersion": msg.pointer("/params/protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
                "capabilities": { "tools": tools_cap, "resources": {} },
                "serverInfo": { "name": "unbrowse-node", "version": node.info.version },
                "instructions": "Unbrowse turns websites into calls. Say what you want with unbrowse_do, with the url of a page that does it: the node calls the route that does it, or learns one from the page and calls that. Calls go straight to the site's own API, no browser. Reach for unbrowse_do before WebFetch or WebSearch whenever the answer is something a site says right now (a package's latest version on its registry, a forum's top posts, a price, a listing, a site's search results): it answers with the site's own data, and the route it keeps answers the next ask without a page. For many pages (one per item, coin or user, on one site or several), make one unbrowse_do call with all of them in pages: the node runs them side by side, and a route learned on a site's first page answers the rest. Only when unbrowse_do says the page needs hands (how: browse), drive it with unbrowse_browse, never another browser: the node learns from every step."
            }))
        }
        "ping" => ok(json!({})),
        // A public peer lists only the tools that find and call a route (`gateway.calls-only`).
        "tools/list" if crate::remote::arrived_public() => ok(json!({ "tools": tools().as_array().map(|t| t.iter().filter(|t| t["name"].as_str().is_some_and(|n| crate::remote::PUBLIC_TOOLS.contains(&n))).cloned().collect::<Vec<_>>()).unwrap_or_default() })),
        // A client that asked for them also gets the route tools its session reached (`tools.route-opt-in`).
        "tools/list" if super::route_tools::asked(headers) => {
            let mut all = tools().as_array().cloned().unwrap_or_default();
            let reached = super::route_tools::session_of(headers).map(|s| super::route_tools::surfaced(&s)).unwrap_or_default();
            all.extend(reached.iter().map(super::route_tools::listed));
            // How many route tools a session was shown, for the x-ray and a check of what a client re-listed: a count, never a name.
            eprintln!("mcp {}", json!({ "method": "tools/list", "route_tools": reached.len() }));
            ok(json!({ "tools": all }))
        }
        "tools/list" => ok(json!({ "tools": tools() })),
        // The one screen MCP Apps hosts draw answers with (`mcp_app`), for every client, public or own.
        "resources/list" => ok(json!({ "resources": super::mcp_app::listed() })),
        "resources/templates/list" => ok(json!({ "resourceTemplates": [] })),
        "resources/read" => match super::mcp_app::read(msg.pointer("/params/uri").and_then(Value::as_str).unwrap_or_default()) {
            Some(r) => ok(r),
            None => err(-32002, "no such resource".into()),
        },
        "tools/call" => {
            let a = match agent(&node, headers) {
                Ok(a) => a,
                Err((_, m)) => return err(-32001, m),
            };
            let name = msg.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or_default();
            if crate::remote::arrived_public() && !crate::remote::PUBLIC_TOOLS.contains(&name) {
                return ok(text(json!({ "outcome": "not_allowed", "why": crate::remote::NEEDS_OWN_NODE, "person": crate::remote::needs_own_node_person() }), true));
            }
            let mut args = in_mcp_session(headers, msg.pointer("/params/arguments").cloned().unwrap_or(json!({})));
            // A route tool is `unbrowse_call` with the route its name stands for now (`tools.route-is-a-call`).
            let p = match PRIMITIVES.iter().find(|p| p.tool == name) {
                Some(p) => p,
                None => match super::route_tools::route_for(name) {
                    Some(route) => {
                        args = super::route_tools::as_call(&route, &args);
                        PRIMITIVES.iter().find(|p| p.tool == "unbrowse_call").expect("unbrowse_call is a primitive")
                    }
                    None => return err(-32602, format!("no tool {name}")),
                },
            };
            if let Some(k) = missing_arg(p, &args) {
                return err(-32602, format!("{name} needs {k}"));
            }
            let ask = super::asks::Ask::begin(p.tool);
            let stop = ask.stop.clone();
            let key = ask_key(headers, &a.address, &id);
            ASKS.lock().unwrap_or_else(|p| p.into_inner()).push((key.clone(), stop.clone()));
            /// Takes the call off `ASKS` however it ends, answered or dropped.
            struct Listed(AskKey, Arc<std::sync::atomic::AtomicBool>);
            impl Drop for Listed {
                fn drop(&mut self) {
                    ASKS.lock().unwrap_or_else(|p| p.into_inner()).retain(|(k, s)| !(*k == self.0 && Arc::ptr_eq(s, &self.1)));
                }
            }
            let listed = Listed(key, stop);
            let reaching = super::route_tools::asked(headers).then(|| super::route_tools::session_of(headers)).flatten();
            let asked_with = reaching.as_ref().map(|_| args.clone());
            let r = run_as_ask(p, &node, &a, args, p.tool, ask).await;
            drop(listed);
            // The route tools this call brought its session, named in the reply and, for a client reading a stream, told
            // as a changed list (`tools.surfaced-by-session`).
            let mut added = Vec::new();
            let r = r.map(|mut v| {
                if let (Some(session), Some(args)) = (&reaching, &asked_with) {
                    added = super::route_tools::reach(session, args, &v);
                    if !added.is_empty() && v.is_object() {
                        v["tools_added"] = json!(added);
                    }
                }
                v
            });
            let ok = |mut result: Value| {
                if !added.is_empty() {
                    result["_meta"] = json!({ super::route_tools::ADDED_META: added });
                }
                ok(result)
            };
            match r {
                // A client that draws screens (`mcp_app`) also gets the answer as `structuredContent`, which its screen
                // reads; every other client's reply is what it was.
                Ok(v) if super::mcp_app::DRAWN.contains(&p.tool) && v.is_object() && super::mcp_app::draws(headers) => {
                    let mut r = shot(p.tool, v.clone());
                    r["structuredContent"] = v;
                    ok(r)
                }
                // A reply that carries a picture of a page is given to the agent as an MCP image content block beside
                // its text: the agent's own model looks at it (`unbrowse_challenge`).
                Ok(v) => ok(shot(p.tool, v)),
                // A failure keeps what it came to (`outcome`, `outcome_from`, `next`) beside its words.
                Err(f) => ok(text(answer_of(&f).1, true)),
            }
        }
        other => err(-32601, format!("method not found: {other}")),
    }
}

#[cfg(test)]
mod stop_tests {
    use super::*;

    /// An app that opens an MCP session is heard by the name it gives (`heard`), so the window can say it reached the node;
    /// Unbrowse's own check of a server it wrote is not an app, and neither is a peer reaching the node.
    #[test]
    fn an_app_that_opens_a_session_is_heard_by_its_name_and_a_peer_is_not() {
        let home = crate::store::scratch_home("heard-initialize");
        let keys = unbrowse_core::MemoryStore::default();
        let id = unbrowse_core::load_or_create(&keys).unwrap();
        let node = Arc::new(Node {
            keys: Box::new(keys),
            identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
            info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
            walks: crate::learn::Walks::default(),
            chain: crate::chain::Chain::default(),
            chain_error: std::sync::Mutex::new(None),
            events: Events::default(),
            net: std::sync::OnceLock::new(),
            share: crate::share::Share::default(),
        });
        let opens = |name: &str| json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": name, "version": "1" } } });
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let headers = HeaderMap::new();
        let answered = [
            rt.block_on(mcp_answer(node.clone(), &headers, opens("claude-code"))).0,
            rt.block_on(mcp_answer(node.clone(), &headers, opens("unbrowse-connect"))).0,
            rt.block_on(crate::remote::over_peer_network(mcp_answer(node.clone(), &headers, opens("some-peer")))).0,
        ];
        let heard: Vec<String> = crate::heard::load().apps.into_iter().map(|a| a.name).collect();
        let said = crate::store::read_activity(50).into_iter().filter(|a| a.kind == "connect").map(|a| (a.who, a.what)).collect::<Vec<_>>();
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(answered, [StatusCode::OK; 3], "each is answered, heard or not");
        assert_eq!(heard, vec!["claude-code".to_string()]);
        assert_eq!(said, vec![("Claude Code".to_string(), "Reached Unbrowse".to_string())], "said once, by the name Connect knows it as");
    }

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
            asks.push((ask_key(&mine, "0xagent", &json!(7)), a.clone()));
            asks.push((ask_key(&theirs, "0xagent", &json!(7)), b.clone()));
            asks.push((ask_key(&mine, "0xagent", &json!(8)), c.clone()));
        }
        assert!(!cancel(&mine, "0xother", Some(&json!({ "requestId": 7 }))), "another agent names the same call in the same session");
        let set = |f: &Arc<std::sync::atomic::AtomicBool>| f.load(std::sync::atomic::Ordering::Relaxed);
        assert!(!set(&a), "another agent's cancel stops nothing");
        assert!(cancel(&mine, "0xagent", Some(&json!({ "requestId": 7, "reason": "timed out" }))));
        assert!(set(&a) && !set(&b) && !set(&c), "only session a's call 7");
        assert!(!cancel(&mine, "0xagent", Some(&json!({ "requestId": 99 }))), "a call no longer answered is nothing to stop");
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

    /// A `notifications/cancelled` message is a notification: it is accepted with no body, and it stops the call it
    /// names, in the session that sent it; one naming no call changes nothing.
    #[test]
    fn a_cancel_notification_is_accepted_without_an_answer_and_stops_its_call() {
        let home = crate::store::scratch_home("mcp-cancel-notice");
        crate::store::use_home(&home);
        let keys = unbrowse_core::MemoryStore::default();
        let id = unbrowse_core::load_or_create(&keys).unwrap();
        let (caller, _) = crate::agents::create(&keys, "the-caller", 1.0, 30, 7788).unwrap();
        let token = crate::agents::token_of(&unbrowse_core::RootKey::load(&keys).unwrap(), &caller);
        let node = Arc::new(Node {
            keys: Box::new(keys),
            identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
            info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
            walks: crate::learn::Walks::default(),
            chain: crate::chain::Chain::default(),
            chain_error: std::sync::Mutex::new(None),
            events: Events::default(),
            net: std::sync::OnceLock::new(),
            share: crate::share::Share::default(),
        });
        let mut headers = HeaderMap::new();
        headers.insert("mcp-session-id", "cancel-notice-test".parse().unwrap());
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        let (stop, other) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(std::sync::atomic::AtomicBool::new(false)));
        ASKS.lock().unwrap().push((ask_key(&headers, &caller.address, &json!(41)), stop.clone()));
        ASKS.lock().unwrap().push((ask_key(&headers, &caller.address, &json!(42)), other.clone()));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let notice = |id: u64| json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": id, "reason": "the client timed out" } });
        let (status, body) = rt.block_on(mcp_answer(node.clone(), &headers, notice(41)));
        let set = |f: &Arc<std::sync::atomic::AtomicBool>| f.load(std::sync::atomic::Ordering::Relaxed);
        let (only_it, gone) = (set(&stop) && !set(&other), rt.block_on(mcp_answer(node, &headers, notice(99))).0);
        ASKS.lock().unwrap().retain(|(k, _)| k.0 != "cancel-notice-test");
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!((status, body.0), (StatusCode::ACCEPTED, Value::Null));
        assert!(only_it, "only the call it names");
        assert_eq!(gone, StatusCode::ACCEPTED, "a call that is gone is nothing to answer either");
    }

    /// Audit 1118 N5. A `notifications/cancelled` stops a call only when it comes with the key of the agent that made it:
    /// one with no key, a wrong key or another agent's key stops nothing, even when it names the call's id and the
    /// client keeps no session (the key is `(session, id)` and a sessionless client's is `("", id)`, a small guess).
    /// The control: the calling agent's own cancel still stops its call.
    #[test]
    fn a_cancel_without_the_calling_agents_key_stops_nothing() {
        let home = crate::store::scratch_home("audit-1118-n5");
        crate::store::use_home(&home);
        let keys = unbrowse_core::MemoryStore::default();
        let id = unbrowse_core::load_or_create(&keys).unwrap();
        let (caller, _) = crate::agents::create(&keys, "the-caller", 1.0, 30, 7788).unwrap();
        let (other, _) = crate::agents::create(&keys, "another-agent", 1.0, 30, 7788).unwrap();
        let root = unbrowse_core::RootKey::load(&keys).unwrap();
        let (callers_token, others_token) = (crate::agents::token_of(&root, &caller), crate::agents::token_of(&root, &other));
        let node = Arc::new(Node {
            keys: Box::new(keys),
            identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
            info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
            walks: crate::learn::Walks::default(),
            chain: crate::chain::Chain::default(),
            chain_error: std::sync::Mutex::new(None),
            events: Events::default(),
            net: std::sync::OnceLock::new(),
            share: crate::share::Share::default(),
        });
        // Sessionless clients, as `unb mcp` is not: no `mcp-session-id`, only the agent's key.
        let sent_with = |bearer: Option<&str>| {
            let mut h = HeaderMap::new();
            if let Some(b) = bearer {
                h.insert("authorization", format!("Bearer {b}").parse().unwrap());
            }
            h
        };
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        ASKS.lock().unwrap().push((ask_key(&sent_with(Some(&callers_token)), &caller.address, &json!(41)), stop.clone()));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let notice = json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 41 } });
        let set = || stop.load(std::sync::atomic::Ordering::Relaxed);
        let mut stopped_by = Vec::new();
        for (who, bearer) in [("no key", None), ("a wrong key", Some("not-a-key")), ("another agent's key", Some(others_token.as_str()))] {
            let (status, _) = rt.block_on(mcp_answer(node.clone(), &sent_with(bearer), notice.clone()));
            assert_eq!(status, StatusCode::ACCEPTED, "a notification is accepted whoever sends it");
            if set() {
                stopped_by.push(who);
                stop.store(false, std::sync::atomic::Ordering::Relaxed);
            }
        }
        let (status, _) = rt.block_on(mcp_answer(node, &sent_with(Some(&callers_token)), notice));
        let stopped_by_its_agent = set();
        ASKS.lock().unwrap().retain(|(_, s)| !Arc::ptr_eq(s, &stop));
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(status, StatusCode::ACCEPTED);
        assert!(stopped_by_its_agent, "the control: the calling agent's own cancel stops its call");
        assert!(stopped_by.is_empty(), "a call was stopped by a cancel from: {stopped_by:?}");
    }

    /// A tool call whose params carry a progress token is answered as an event stream: progress events, each with the
    /// token, a growing count and what its ask is doing, before the JSON-RPC answer as the last event. Without a token
    /// the answer is plain JSON. The handler is driven in-process, its tool a learn made slow by a test (`goal::slow`).
    #[test]
    fn a_call_with_a_progress_token_hears_progress_before_its_answer() {
        let home = crate::store::scratch_home("progress-stream");
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || crate::store::use_home(&h)).build().unwrap();
        crate::store::use_home(&home);
        crate::store::save_settings(&crate::store::Settings { fetch_browser: false, ..crate::store::Settings::default() }).unwrap();
        let keys = unbrowse_core::MemoryStore::default();
        let id = unbrowse_core::load_or_create(&keys).unwrap();
        let (a, _) = crate::agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
        let token = crate::agents::token_of(&unbrowse_core::RootKey::load(&keys).unwrap(), &a);
        let node = Arc::new(Node {
            keys: Box::new(keys),
            identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
            info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
            walks: crate::learn::Walks::default(),
            chain: crate::chain::Chain::default(),
            chain_error: std::sync::Mutex::new(None),
            events: Events::default(),
            net: std::sync::OnceLock::new(),
            share: crate::share::Share::default(),
        });
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        headers.insert("mcp-session-id", "progress-test".parse().unwrap());
        let plain = headers.clone();
        headers.insert("accept", "application/json, text/event-stream".parse().unwrap());
        let page = "https://slow.example/items?case=progress";
        super::super::goal::slow::make(page, Some(std::time::Duration::from_millis(400)));
        let ask = |id: u64, meta: Value| json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": "unbrowse_do", "arguments": { "goal": "list the items", "url": page, "wait_ms": 5000 }, "_meta": meta } });
        let answered = |n: &Arc<Node>, h: &HeaderMap, msg: Value| {
            let (n, h) = (n.clone(), h.clone());
            rt.block_on(async move {
                let r = mcp(State(n), h, Json(msg)).await;
                let kind = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
                let body = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
                (kind, String::from_utf8(body.to_vec()).unwrap())
            })
        };
        let (kind, body) = answered(&node, &headers, ask(7, json!({ "progressToken": "tok-1" })));
        assert!(kind.starts_with("text/event-stream"), "{kind}");
        let events: Vec<Value> = body.split("\n\n").filter_map(|e| e.lines().find_map(|l| l.strip_prefix("data: ")).and_then(|d| serde_json::from_str(d).ok())).collect();
        let (last, progress) = events.split_last().expect("events");
        assert!(progress.len() >= 2, "progress before the answer: {body}");
        for (n, p) in progress.iter().enumerate() {
            assert_eq!((p["method"].as_str(), p["params"]["progressToken"].as_str(), p["params"]["progress"].as_u64()), (Some("notifications/progress"), Some("tok-1"), Some(n as u64 + 1)), "{p}");
        }
        assert!(progress.iter().any(|p| p["params"]["message"] == "walk"), "it says what the ask is doing: {body}");
        assert_eq!(last["id"], 7, "the answer last: {last}");
        let said: Value = serde_json::from_str(last["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(said["outcome"], "answered", "{said}");
        // Without a token: plain JSON, as always; and so for a client that accepts no event stream.
        let (kind, body) = answered(&node, &headers, ask(8, json!({})));
        assert!(kind.starts_with("application/json"), "{kind}");
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["id"], 8);
        let mut json_only = headers.clone();
        json_only.insert("accept", "application/json".parse().unwrap());
        let (kind, _) = answered(&node, &json_only, ask(9, json!({ "progressToken": 2 })));
        assert!(kind.starts_with("application/json"), "{kind}");
        // A client that names no event stream (no accept, or anything at all) is answered in JSON too: unb's relay,
        // which checks one signed body, sends reqwest's `*/*` (UNB-221).
        let mut any = plain.clone();
        any.insert("accept", "*/*".parse().unwrap());
        for (h, n) in [(&plain, 10), (&any, 11)] {
            let (kind, body) = answered(&node, h, ask(n, json!({ "progressToken": n })));
            assert!(kind.starts_with("application/json"), "{kind}");
            assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["id"], n);
        }
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
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
