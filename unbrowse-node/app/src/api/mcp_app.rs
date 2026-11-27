//! The screen an MCP Apps host draws an answer with (UNB-234; the open MCP Apps standard, `io.modelcontextprotocol/ui`):
//! one `ui://` resource, linked from the tools whose answers it draws, that picks its layout from the answer's shape
//! (`mcp_app.html`): cards when the items carry pictures, a table for rows without, text otherwise. Never a screen per
//! site. ChatGPT and Claude render it; a client that ignores screens gets the same answer as before, byte for byte.
//!
//! It lives in the node's MCP handler, not the gateway: the gateway stays a forwarder that reads nothing it carries
//! (`gateway.peer`), and the screen ships with the answers it draws, so a node's own remote URL, the peer network and
//! a local `unb mcp` client get it too.
//!
//! Each tool also carries a title and its hints (`readOnlyHint`, `destructiveHint`, `openWorldHint`), which ChatGPT
//! and Claude read to decide what to confirm with the user, and their directories' reviews ask for.

use std::collections::VecDeque;
use std::sync::Mutex;

use axum::http::HeaderMap;
use serde_json::{json, Value};

/// The one screen, and its MIME type under the standard.
pub(super) const URI: &str = "ui://unbrowse/answer.html";
pub(super) const MIME: &str = "text/html;profile=mcp-app";
const HTML: &str = include_str!("mcp_app.html");
/// The client capability that says a host draws MCP Apps.
const EXTENSION: &str = "io.modelcontextprotocol/ui";
/// The tools whose answers the screen draws: those that answer with a site's data, or a list of routes.
pub(super) const DRAWN: [&str; 3] = ["unbrowse_do", "unbrowse_call", "unbrowse_search"];
/// The sessions remembered as drawing screens: enough for every client of a busy public peer at once.
const SESSIONS_HELD: usize = 10_000;

/// A tool's title and hints: (title, read only, destructive, open world). None for a tool this table doesn't know,
/// which a test refuses.
pub(super) fn hints(tool: &str) -> Option<(&'static str, bool, bool, bool)> {
    Some(match tool {
        "unbrowse_search" => ("Find routes", true, false, true),
        "unbrowse_do" => ("Connect to a site", false, false, true),
        "unbrowse_walk" => ("List a page's calls", false, false, true),
        "unbrowse_browse" => ("Use the node's browser", false, true, true),
        "unbrowse_challenge" => ("Pass a person check", false, false, true),
        "unbrowse_observe" => ("Read the open page", true, false, true),
        "unbrowse_logins" => ("List vault logins", true, false, false),
        "unbrowse_open" => ("Preview a route link", true, false, true),
        "unbrowse_call" => ("Call a route", false, false, true),
        "unbrowse_inspect" => ("Inspect a route", true, false, false),
        "unbrowse_judge" => ("Judge an answer", false, false, false),
        "unbrowse_whoami" => ("Check this connection", true, false, false),
        "unbrowse_setup" => ("Setup", false, false, false),
        "unbrowse_report" => ("Report a problem", false, false, true),
        _ => return None,
    })
}

/// A tool as `tools/list` gives it: name, title, description, input, hints, and the screen when it draws one.
pub(super) fn tool(name: &str, description: &str, input: Value) -> Value {
    let (title, read_only, destructive, open_world) = hints(name).unwrap_or((name, false, true, true));
    let mut t = json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input,
        "annotations": { "title": title, "readOnlyHint": read_only, "destructiveHint": destructive, "openWorldHint": open_world },
    });
    if DRAWN.contains(&name) {
        t["_meta"] = json!({
            "ui": { "resourceUri": URI },
            // The standard's flat key from before `ui.resourceUri`, which hosts still read until it goes.
            "ui/resourceUri": URI,
            "openai/toolInvocation/invoking": "Connecting to the site",
            "openai/toolInvocation/invoked": "Connected",
        });
    }
    t
}

/// The screen as `resources/list` names it.
pub(super) fn listed() -> Value {
    json!([{ "uri": URI, "name": "answer", "title": "Unbrowse answer", "description": "Unbrowse, the universal connector: draws what a site answered as cards when its items have pictures, a table for rows, text otherwise.", "mimeType": MIME }])
}

/// `resources/read` of `uri`: the screen, with what it may load. None for any other address.
pub(super) fn read(uri: &str) -> Option<Value> {
    if uri != URI {
        return None;
    }
    // Pictures come from whichever site answered, so any https origin may serve an image; the screen fetches nothing
    // else (no connect, no frames), and a picture a host blocks falls back to the item's initial.
    Some(json!({ "contents": [{
        "uri": URI,
        "mimeType": MIME,
        "text": HTML,
        "_meta": {
            "ui": { "csp": { "resourceDomains": ["https:"], "connectDomains": [] }, "prefersBorder": false },
            "openai/widgetCSP": { "resource_domains": ["https:"], "connect_domains": [] },
            "openai/widgetPrefersBorder": false,
            "openai/widgetDescription": "Shows the site's answer the user asked for: cards with pictures, a table, or text. The answer's data is in the tool result; describe it in a sentence rather than repeating every item.",
        },
    }] }))
}

static SESSIONS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// The clients that draw MCP Apps screens without always saying so at `initialize`: ChatGPT and Claude.
const DRAWING_CLIENTS: [&str; 3] = ["openai-mcp", "claude-ai", "claude.ai"];

/// Whether an `initialize` says its client draws MCP Apps screens: by the standard's capability, or by being a host
/// known to draw them.
pub(super) fn declares(msg: &Value) -> bool {
    msg.pointer("/params/capabilities/extensions").and_then(|e| e.get(EXTENSION)).is_some_and(|u| u.is_object())
        || msg.pointer("/params/clientInfo/name").and_then(Value::as_str).is_some_and(|n| DRAWING_CLIENTS.contains(&n.to_ascii_lowercase().as_str()))
}

/// Remembers that session `sid` draws screens.
pub(super) fn remember(sid: &str) {
    let mut s = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    s.push_back(sid.to_string());
    while s.len() > SESSIONS_HELD {
        s.pop_front();
    }
}

/// Whether the client sending `headers` said at `initialize` that it draws screens. Only those get the answer again
/// as `structuredContent`: every other client's answer stays what it was, and no model reads it twice.
pub(super) fn draws(headers: &HeaderMap) -> bool {
    let Some(sid) = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::trim).filter(|s| !s.is_empty()) else { return false };
    SESSIONS.lock().unwrap_or_else(|p| p.into_inner()).iter().any(|s| s == sid)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every tool has a title and its hints (Anthropic's and OpenAI's reviews ask for them).
    #[test]
    fn every_tool_has_a_title_and_hints() {
        for p in super::super::PRIMITIVES {
            assert!(hints(p.tool).is_some(), "{} has no title or hints", p.tool);
        }
        for t in super::super::mcp::tools().as_array().unwrap() {
            assert!(t["title"].as_str().is_some_and(|s| !s.is_empty()), "{t}");
            let a = &t["annotations"];
            assert!(a["readOnlyHint"].is_boolean() && a["destructiveHint"].is_boolean(), "{t}");
        }
    }

    /// The drawn tools link the screen, the others don't, and the screen reads back as the standard asks.
    #[test]
    fn the_drawn_tools_link_the_one_screen() {
        for t in super::super::mcp::tools().as_array().unwrap() {
            let name = t["name"].as_str().unwrap();
            assert_eq!(t.pointer("/_meta/ui/resourceUri").and_then(Value::as_str) == Some(URI), DRAWN.contains(&name), "{name}");
        }
        let r = read(URI).unwrap();
        let c = &r["contents"][0];
        assert_eq!(c["mimeType"], MIME);
        assert!(c["text"].as_str().unwrap().contains("ui/initialize"));
        assert!(c.pointer("/_meta/ui/csp/resourceDomains").is_some_and(Value::is_array));
        assert!(read("ui://unbrowse/other.html").is_none());
        assert_eq!(listed()[0]["uri"], URI);
    }

    /// Only a session whose client said it draws screens is remembered as drawing them.
    #[test]
    fn only_a_client_that_draws_gets_the_answer_twice() {
        let ui = json!({ "method": "initialize", "params": { "capabilities": { "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } } } });
        let plain = json!({ "method": "initialize", "params": { "capabilities": {} } });
        assert!(declares(&ui));
        assert!(!declares(&plain));
        assert!(declares(&json!({ "method": "initialize", "params": { "clientInfo": { "name": "openai-mcp" } } })));
        assert!(!declares(&json!({ "method": "initialize", "params": { "clientInfo": { "name": "claude-code" } } })));
        remember("draws-1");
        let mut h = HeaderMap::new();
        h.insert("mcp-session-id", "draws-1".parse().unwrap());
        assert!(draws(&h));
        h.insert("mcp-session-id", "plain-1".parse().unwrap());
        assert!(!draws(&h));
        assert!(!draws(&HeaderMap::new()));
    }
}
