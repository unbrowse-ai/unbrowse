//! Local browser regression: the engine reaches the debugger of the machine's own Chrome, quickly, and the browser goes
//! when the launch is dropped.
//!
//! Windows 11, 22 Nov 2026 (staging c772f210): the system Chrome 157.0.8103.79 never answered the engine's debugger
//! pipe, three launches of 30 s each, while agent-browser drove the same Chrome on a port in about a second. CI's
//! Windows job runs this against the runner's own Chrome.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use futures_util::{SinkExt, StreamExt};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn the_machines_chrome_answers_the_engines_debugger_in_seconds() {
    let root = tempfile::tempdir().unwrap();
    let options = LaunchOptions {
        headless: true,
        profile: Some(root.path().join("system-chrome").to_string_lossy().into_owned()),
        ..Default::default()
    };
    let started = Instant::now();
    let chrome = tokio::task::spawn_blocking(move || launch_chrome(&options)).await.unwrap().expect("the engine launches the machine's Chrome");
    let took = started.elapsed();
    let (mut ws, _) = tokio_tungstenite::connect_async(chrome.ws_url.as_str()).await.expect("its debugger takes a connection");
    ws.send(Message::Text(r#"{"id":1,"method":"Browser.getVersion"}"#.into())).await.unwrap();
    let answer = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(message)) = ws.next().await {
            if let Message::Text(text) = message {
                if text.contains("\"id\":1") {
                    return text.to_string();
                }
            }
        }
        String::new()
    })
    .await
    .expect("its debugger answers");
    eprintln!("launched in {took:?} at {}: {answer}", chrome.ws_url.split("/devtools").next().unwrap_or_default());
    assert!(answer.contains("\"product\""), "{answer}");
    // A pipe that stays silent costs one short wait before the port, never three full ones.
    assert!(took < Duration::from_secs(25), "the launch took {took:?}");
    let pid = chrome.id();
    let when = agent_browser_core::process::started(pid);
    assert!(when.is_some(), "the system can say when the browser started");
    drop(ws);
    drop(chrome);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!agent_browser_core::process::is_still(pid, when), "the browser outlived its launch");
}
