//! A walk that asked for interception never opens its page without it.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_browser_core::session::{mint, MintOptions};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

/// A browser on a local socket that answers every command, refuses `Fetch.enable`, and notes whether a page was opened.
async fn browser_refusing_interception() -> (String, Arc<AtomicBool>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/devtools/browser/refusing", listener.local_addr().unwrap());
    let opened = Arc::new(AtomicBool::new(false));
    let seen = opened.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        while let Some(Ok(msg)) = ws.next().await {
            let Message::Text(text) = msg else { continue };
            let Ok(cmd) = serde_json::from_str::<Value>(&text) else { continue };
            let id = cmd["id"].clone();
            let reply = match cmd["method"].as_str().unwrap_or_default() {
                "Fetch.enable" => json!({ "id": id, "error": { "code": -32000, "message": "Fetch domain refused" } }),
                "Target.createTarget" => json!({ "id": id, "result": { "targetId": "T1" } }),
                "Target.attachToTarget" => json!({ "id": id, "result": { "sessionId": "S1" } }),
                "Page.navigate" => {
                    seen.store(true, Ordering::SeqCst);
                    json!({ "id": id, "result": { "frameId": "F1" } })
                }
                _ => json!({ "id": id, "result": {} }),
            };
            if ws.send(Message::Text(reply.to_string())).await.is_err() {
                break;
            }
        }
    });
    (url, opened)
}

/// Interception is what keeps a browser from connecting out on its own: each request is checked to resolve to a public
/// address and pinned there. A browser that refused it used to get a line on stderr and the walk went on, the page
/// loading over the browser's own connections, which the caller had asked to have checked.
#[tokio::test]
async fn a_walk_that_asked_for_interception_never_opens_its_page_without_it() {
    let (endpoint, opened) = browser_refusing_interception().await;
    let walk = mint(MintOptions {
        url: "https://shop.example/".into(),
        session: "intercept-refused".into(),
        cdp_endpoint: Some(endpoint),
        intercept: true,
        settle_ms: 500,
        ..Default::default()
    });
    let walked = tokio::time::timeout(Duration::from_secs(15), walk).await;
    assert!(!opened.load(Ordering::SeqCst), "the page was opened with interception refused");
    let e = walked.expect("a refused interception ends the walk").expect_err("a walk without its interception is no walk");
    assert!(e.contains("intercept"), "{e}");
}
