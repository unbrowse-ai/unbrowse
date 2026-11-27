//! The owner's window: its token, and the commands, frames and events behind it.

use super::*;

// ---- the owner's window ----

/// The owner's token, made fresh each start. It is written down only by the node that holds the port (`serve`, once
/// its listener is bound): a node that can't bind -- a supervisor restarting it while another node still serves --
/// must not replace the token the window is using, or every owner call fails until the two stop fighting.
pub fn owner_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
    Ok(hex::encode(bytes))
}

/// Keeps the owner's token where only this user can read it: the window on this machine reads it, nothing else is
/// told it.
pub(super) fn write_owner_token(token: &str) -> std::io::Result<()> {
    use std::io::Write;
    let path = store::home().join("owner.token");
    // The node's folder holds this token and, on a node without a keystore, the root key: only this user may list or
    // read it, or anything directly in it, whatever an older node or a copy left them as. An agent run as another OS
    // user (`unbrowse-node agent-user`) reads none of it.
    crate::agent_user::keep_folder_private(&store::home()).map_err(std::io::Error::other)?;
    let _ = std::fs::remove_file(&path);
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    // Windows keeps a file in the user's profile to that user already.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    open.open(&path)?.write_all(token.as_bytes())
}

#[derive(Clone)]
pub(super) struct Door {
    pub(super) node: Arc<Node>,
    pub(super) owner: Arc<String>,
}

pub(super) fn is_owner(door: &Door, headers: &HeaderMap) -> bool {
    let sent = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or_default();
    // Compared whole, without stopping at the first difference: an agent's token is compared the same way, in one place.
    agents::constant_time_eq(sent, &door.owner)
}

/// `POST /owner/{command}` with the command's arguments as a JSON object: everything the window does.
pub(super) async fn owner_command(State(door): State<Door>, Path(cmd): Path<String>, headers: HeaderMap, body: Option<Json<Value>>) -> Reply {
    if !is_owner(&door, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "the owner's token only");
    }
    let args = body.map(|Json(v)| v).unwrap_or(json!({}));
    match crate::owner(&door.node, &cmd, args).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(crate::OwnerError::Unknown) => refuse(StatusCode::NOT_FOUND, &format!("no command {cmd}")),
        Err(crate::OwnerError::Failed(m)) if m == crate::WAITING_FOR_KEY => refuse(StatusCode::SERVICE_UNAVAILABLE, &m),
        Err(crate::OwnerError::Failed(m)) => refuse(StatusCode::BAD_REQUEST, &m),
    }
}

#[derive(Deserialize)]
pub(super) struct FrameQuery {
    #[serde(default)]
    pub(super) walk: String,
}

/// What a picture is, read from its own first bytes: a PNG (`screencast::FORMAT` off a Mac), else a JPEG.
pub(super) fn picture_type(pic: &[u8]) -> &'static str {
    if pic.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else {
        "image/jpeg"
    }
}

/// `GET /owner/frame?walk=…`: the latest picture of a walk (the newest walk's without one), as a JPEG.
pub(super) async fn owner_frame(State(door): State<Door>, headers: HeaderMap, Query(q): Query<FrameQuery>) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !is_owner(&door, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "the owner's token only").into_response();
    }
    // The pictures of a page the owner is watching to take over (`hands:<site>`), else a walk's.
    match crate::hands::frame(&q.walk).or_else(|| door.node.walks.1.get(&q.walk)) {
        Some(pic) => ([(axum::http::header::CONTENT_TYPE, picture_type(&pic)), (axum::http::header::CACHE_CONTROL, "no-store")], pic).into_response(),
        None => refuse(StatusCode::NOT_FOUND, "no picture of that walk").into_response(),
    }
}

/// `GET /owner/events`: what happens on the node as it happens, as server-sent events.
///
/// Asked with a signed request, each event's `id` is its place in the stream and its signature (`event_id`), so a
/// process between the node and the window can't add one, drop one from the middle, or move one.
pub(super) async fn owner_events(State(door): State<Door>, headers: HeaderMap, by: Option<axum::Extension<SignedBy>>) -> axum::response::Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use axum::response::IntoResponse;
    if !is_owner(&door, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "the owner's token only").into_response();
    }
    let rx = door.node.events.0.subscribe();
    let by = by.map(|axum::Extension(by)| by);
    let pending = std::collections::VecDeque::from(crate::hands::asks());
    let replayed: std::collections::HashSet<String> = pending.iter().map(|ask| ask.id.clone()).collect();
    let stream = futures_util::stream::unfold((rx, by, 0u64, pending, replayed), |(mut rx, by, seq, mut pending, mut replayed)| async move {
        let (name, data) = if let Some(ask) = pending.pop_front() {
            ("hands".to_string(), json!({ "kind": "ask", "site": ask.site, "ask": ask }))
        } else {
            loop {
                match rx.recv().await {
                    Ok((name, data)) => {
                        // An ask added between subscribing and reading the list can also arrive on the live stream.
                        if name == "hands" && data.get("kind").and_then(Value::as_str) == Some("ask")
                            && data.pointer("/ask/id").and_then(Value::as_str).is_some_and(|id| replayed.remove(id))
                        {
                            continue;
                        }
                        break (name, data);
                    }
                    // A watcher too slow to keep up misses some; it refetches on the next event.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return None,
                }
            }
        };
        let data = data.to_string();
        let mut event = Event::default().event(&name).data(&data);
        if let Some(by) = &by {
            event = event.id(event_id(by, seq, &name, &data));
        }
        Some((Ok::<_, std::convert::Infallible>(event), (rx, by, seq + 1, pending, replayed)))
    });
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}
