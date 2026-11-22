//! Local browser regression: a walk attaches to the page's frames and workers and holds none of them back
//! (`learn.record`, UNB-208 L06).
//!
//! The fixture page frames a page of another site and starts a worker. Each calls as its first line, and the frame calls
//! again half a second in. Every call must reach the site: a target the walk paused and never let run would never send
//! it. The walk must record the worker's first call and the frame's later one as requests.
//!
//! A frame is never held (`the_walk_holds_only_a_worker_and_only_until_its_network_is_on`), so a call a frame of another
//! site sends as its first line goes before the walk has its network on: it reaches the site and is not recorded. That
//! is the cost of holding no frame back (a frame of a start page once took 14 s to turn on), and this test does not
//! hide it: the first call is asserted to run, not to be heard.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::session::{capture_path, mint, read_capture, MintOptions, Waits};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

/// The page at 127.0.0.1 frames its site's page at `localhost`: another site, so the frame is a target of its own that
/// the walk attaches to, as it does to the worker.
fn page(port: u16) -> String {
    format!(
        r#"<html><head><title>A shop</title></head><body><h1>Welcome to the shop</h1>
<iframe src="http://localhost:{port}/frame"></iframe>
<script>new Worker('/worker.js');</script>
</body></html>"#
    )
}
const FRAME: &str = r#"<html><body><script>fetch('/api/frame?first=1'); setTimeout(() => fetch('/api/frame?later=1'), 500);</script>A frame</body></html>"#;
const WORKER: &str = "fetch('/api/worker?first=1');\n";

/// The fixture site, and the paths it was asked for.
fn site() -> (SocketAddr, Arc<AtomicBool>, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let asked: Arc<Mutex<Vec<String>>> = Default::default();
    let (stop, kept) = (stopped.clone(), asked.clone());
    let handle = std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
            };
            let kept = kept.clone();
            std::thread::spawn(move || {
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&request).lines().next().unwrap_or_default().to_string();
                let path = line.split(' ').nth(1).unwrap_or_default().to_string();
                if path.is_empty() {
                    return;
                }
                kept.lock().unwrap().push(path.clone());
                let (kind, body) = match path.split('?').next().unwrap_or_default() {
                    "/" => ("text/html", page(address.port())),
                    "/frame" => ("text/html", FRAME.to_string()),
                    "/worker.js" => ("text/javascript", WORKER.to_string()),
                    _ => ("application/json", r#"{"ok":true}"#.to_string()),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    (address, stopped, asked, handle)
}

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_walk_attaches_to_each_frame_and_worker_and_leaves_none_paused() {
    let (address, stopped, asked, handle) = site();
    let profile = tempfile::tempdir().unwrap();
    let mut options = LaunchOptions::default();
    options.headless = true;
    options.profile = Some(profile.path().to_string_lossy().into_owned());
    let mut chrome = launch_chrome(&options).expect("a browser to walk in");
    let dir = tempfile::tempdir().unwrap();
    let walked = mint(MintOptions {
        url: format!("http://{address}/"),
        session: "attach".to_string(),
        capture_dir: Some(dir.path().to_path_buf()),
        cdp_endpoint: Some(chrome.ws_url.clone()),
        settle_ms: 3_000,
        // The browser reports no end for the frame's and the worker's calls while this walk runs (seen: the frame's
        // later call answered 0.8 s in, no `Network.loadingFinished` by 28 s), so a walk past its settle time waits
        // on them as on an answer still arriving: 25 s here. Every call this test asks about is sent within the
        // settle time, so the walk waits a second past it, not 25.
        waits: Waits { asking: Duration::from_secs(1), in_flight: Duration::from_secs(1), ..Default::default() },
        ..Default::default()
    })
    .await;
    chrome.kill();
    stopped.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(address);
    handle.join().unwrap();
    assert!(walked.is_ok(), "the fixture page is an ordinary page: {walked:?}");

    // Neither was left paused: each sent its call.
    let asked = asked.lock().unwrap().clone();
    for call in ["/api/frame?first=1", "/api/frame?later=1", "/api/worker?first=1"] {
        assert!(asked.iter().any(|p| p == call), "{call} reached the site: {asked:?}");
    }
    // The walk was attached before each sent its first call: the capture holds each as a request.
    let lines = read_capture(&capture_path(dir.path(), "attach"));
    let requests: Vec<&str> =
        lines.iter().filter(|l| l["type"] == "request").filter_map(|l| l["url"].as_str()).collect();
    for call in ["/api/frame?later=1", "/api/worker?first=1"] {
        assert!(requests.iter().any(|u| u.ends_with(call)), "the walk heard {call} as it was sent: {requests:?}");
    }
}
