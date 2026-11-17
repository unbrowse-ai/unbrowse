//! Local browser regression: a clearance cookie is not proof of admission.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::session::{mint, MintOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn mint_rejects_challenges_and_preserves_attached_browser() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let server = std::thread::spawn(move || {
        // A thread per connection: a browser opens sockets it never uses, and
        // one of those must not hold up the page's own request.
        let mut workers = Vec::new();
        while !stop.load(Ordering::Relaxed) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(_) => { std::thread::sleep(std::time::Duration::from_millis(10)); continue; }
            };
            workers.push(std::thread::spawn(move || {
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            // Read the whole head: a request can arrive in fragments, and a
            // truncated request line would be read as a different page.
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => request.extend_from_slice(&chunk[..n]),
                }
            }
            let request = String::from_utf8_lossy(&request);
            // A connection that asked for nothing is answered with nothing.
            if request.is_empty() {
                return;
            }
            let blocked = request.starts_with("GET /blocked ");
            let delayed = request.starts_with("GET /delayed ");
            let (status, body) = if blocked {
                ("403 Forbidden", "<html><title>Just a moment...</title><body>Verify you are human<script>window._cf_chl_opt = {};</script></body></html>")
            } else if delayed {
                ("200 OK", "<html><title>Loading</title><body>Starting<script>setTimeout(() => {document.title = 'Just a moment...'; window._cf_chl_opt = {}; document.body.innerText = 'Verify you are human';}, 500);</script></body></html>")
            } else {
                ("200 OK", "<html><title>Captcha documentation</title><body>Ordinary page about captcha APIs.</body></html>")
            };
            // Never cacheable: a cached document opens without a network
            // answer, and the status this fixture judges is the network's.
            let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nSet-Cookie: cf_clearance=fixture; Path=/\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
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
    options.args = vec!["--disable-background-timer-throttling".to_string()];
    let mut chrome = launch_chrome(&options).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for (path, expected) in [("blocked", false), ("delayed", false), ("captcha-documentation", true)] {
        let result = mint(MintOptions {
            url: format!("http://{address}/{path}"),
            session: path.to_string(),
            capture_dir: Some(dir.path().to_path_buf()),
            cdp_endpoint: Some(chrome.ws_url.clone()),
            settle_ms: 100,
            ..Default::default()
        }).await;
        if expected {
            assert_eq!(result.unwrap().cookies.get("cf_clearance").map(String::as_str), Some("fixture"));
        } else {
            let error = result.expect_err(&format!("{path} must not mint successfully"));
            assert!(error.starts_with("mint unresolved (challenge)"), "{error}");
            assert!(error.contains("attached browser left open"), "{error}");
        }
        assert!(!chrome.has_exited());
        assert!(dir.path().join(format!("{path}.jsonl")).exists());
    }
    chrome.kill();

    // A browser owned by mint must also survive an unresolved headed walk.
    let handoff_profile = tempfile::tempdir().unwrap();
    let error = mint(MintOptions {
        url: format!("http://{address}/blocked"),
        session: "handoff".to_string(),
        headed: true,
        profile: Some(handoff_profile.path().to_string_lossy().into_owned()),
        settle_ms: 100,
        ..Default::default()
    }).await.unwrap_err();
    let endpoint = error.split("reconnect at ").nth(1).expect("handoff endpoint");
    let client = agent_browser_core::cdp::client::CdpClient::connect(endpoint).await.unwrap();
    client.send_command("Target.getTargets", None, None).await.unwrap();
    let _ = client.send_command("Browser.close", None, None).await;
    stopped.store(true, Ordering::Relaxed);
    // Wake the accept loop so it can join the workers.
    let _ = std::net::TcpStream::connect(address);
    server.join().unwrap();
}
