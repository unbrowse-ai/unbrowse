//! Local browser regression: a headless walk reports the browser it is — the
//! brands that browser reports about itself — with only the launch mode taken
//! out of its name.
//!
//! An identity worked out from the user agent string names whatever product
//! the guess assumed. A build that is not that product then sends a brand list
//! no real browser sends, and that mismatch is itself the tell.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::cdp::client::CdpClient;
use agent_browser_core::fingerprint::own_identity;
use agent_browser_core::session::{mint, MintOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_headless_walk_sends_the_brands_the_browser_reports() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let heads = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = heads.clone();
    let server = std::thread::spawn(move || {
        let mut workers = Vec::new();
        while !stop.load(Ordering::Relaxed) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(_) => { std::thread::sleep(std::time::Duration::from_millis(10)); continue; }
            };
            let seen = seen.clone();
            workers.push(std::thread::spawn(move || {
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                let request = String::from_utf8_lossy(&request).to_string();
                // A connection that asked for nothing is answered with nothing.
                if request.is_empty() {
                    return;
                }
                if request.starts_with("GET / ") {
                    seen.lock().unwrap().push(request);
                }
                let body = "<html><title>A page</title><body><h1>The page itself</h1></body></html>";
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }));
        }
        for worker in workers {
            let _ = worker.join();
        }
    });

    let profile = tempfile::tempdir().unwrap();
    let mut options = LaunchOptions::default();
    options.headless = true;
    options.profile = Some(profile.path().to_string_lossy().into_owned());
    let mut chrome = launch_chrome(&options).unwrap();

    // What this browser says it is, asked on a page of its own.
    let client = CdpClient::connect(&chrome.ws_url).await.unwrap();
    let report = own_identity(&client).await.expect("the browser reports its own identity");
    let brands: Vec<String> = report["brands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| format!("\"{}\";v=\"{}\"", b["brand"].as_str().unwrap(), b["version"].as_str().unwrap()))
        .collect();
    assert!(!brands.is_empty(), "{report}");

    let walked = mint(MintOptions {
        url: format!("http://{address}/"),
        session: "identity".into(),
        cdp_endpoint: Some(chrome.ws_url.clone()),
        settle_ms: 1_500,
        ..Default::default()
    })
    .await;
    assert!(walked.is_ok(), "{walked:?}");
    chrome.kill();
    stopped.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(address);
    server.join().unwrap();

    let heads = heads.lock().unwrap();
    let head = heads.last().expect("the walk asked for the page");
    let header = |name: &str| {
        head.lines()
            .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()))
    };
    let ua = header("user-agent").expect("a user agent");
    assert!(!ua.contains("HeadlessChrome"), "the launch mode is in the name: {ua}");
    assert!(ua.contains("Chrome/"), "{ua}");
    // The brands on the wire are the browser's own, in its own order, and no
    // others: nothing the browser did not say about itself was added.
    let sent = header("sec-ch-ua").expect("the browser's client hints were sent");
    assert_eq!(sent, brands.join(", "), "the walk sent brands the browser does not report");
}

/// The switch that opens a browser to its driver is not part of what it says
/// it is. Chrome reads an ephemeral debugging port as being launched for
/// automation and tells every page so; a launched browser must not.
#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_launched_browser_does_not_tell_pages_it_is_automated() {
    let profile = tempfile::tempdir().unwrap();
    let mut options = LaunchOptions::default();
    options.headless = true;
    options.profile = Some(profile.path().to_string_lossy().into_owned());
    let mut chrome = launch_chrome(&options).unwrap();
    let client = CdpClient::connect(&chrome.ws_url).await.unwrap();
    let created = client
        .send_command("Target.createTarget", Some(serde_json::json!({ "url": "about:blank" })), None)
        .await
        .unwrap();
    let attached = client
        .send_command(
            "Target.attachToTarget",
            Some(serde_json::json!({ "targetId": created["targetId"], "flatten": true })),
            None,
        )
        .await
        .unwrap();
    let session = attached["sessionId"].as_str().unwrap();
    let said = client
        .send_command(
            "Runtime.evaluate",
            Some(serde_json::json!({ "expression": "navigator.webdriver", "returnByValue": true })),
            Some(session),
        )
        .await
        .unwrap();
    // The browser can still be found again the way a surviving one is.
    let remembered = std::fs::read_to_string(profile.path().join("DevToolsActivePort"));
    chrome.kill();
    assert_eq!(said.pointer("/result/value"), Some(&serde_json::json!(false)), "{said}");
    let remembered = remembered.expect("the debugger's address is written where reattach reads it");
    let mut lines = remembered.lines();
    let port = lines.next().unwrap();
    let path = lines.next().unwrap();
    assert_eq!(chrome.ws_url, format!("ws://127.0.0.1:{port}{path}"));
}
