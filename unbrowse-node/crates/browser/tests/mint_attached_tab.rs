//! Local browser regression: a walk in someone's browser leaves a tab only where a person has something to do on it.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::cdp::client::CdpClient;
use agent_browser_core::session::{mint, MintOptions};
use std::io::{Read, Write};
use std::net::TcpListener;

/// How many pages the browser at `ws_url` has open, by its own list.
async fn pages(ws_url: &str) -> usize {
    let client = CdpClient::connect(ws_url).await.unwrap();
    let targets = client.send_command("Target.getTargets", None, None).await.unwrap();
    let count = targets["targetInfos"].as_array().unwrap().iter().filter(|t| t["type"] == "page").count();
    client.close().await;
    count
}

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_refusal_in_someones_browser_leaves_no_tab_behind() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut stream = stream;
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                if request.is_empty() {
                    return;
                }
                // The site's plain answer: nothing on it for a person to press.
                let body = "<html><title>Access denied</title><body></body></html>";
                let _ = write!(
                    stream,
                    "HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });

    let profile = tempfile::tempdir().unwrap();
    let options = LaunchOptions {
        headless: true,
        profile: Some(profile.path().to_string_lossy().into_owned()),
        ..Default::default()
    };
    let chrome = launch_chrome(&options).expect("a browser to attach to");
    let before = pages(&chrome.ws_url).await;
    assert!(before > 0, "the count must see the browser's own page");

    let walked = mint(MintOptions {
        url: format!("http://{address}/"),
        session: "attached".into(),
        cdp_endpoint: Some(chrome.ws_url.clone()),
        settle_ms: 1_000,
        ..Default::default()
    })
    .await;

    let error = walked.expect_err("a refusal is not a page");
    assert!(error.starts_with("mint unresolved (refused)"), "{error}");
    assert_eq!(pages(&chrome.ws_url).await, before, "the walk left its tab: {error}");
}
