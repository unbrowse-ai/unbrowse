//! Local browser regression: a frame from another site is a door only where the
//! site is refusing, and only when a person could actually meet it.
//!
//! The web is full of framed pixels — beacons, ad slots, social sign-in — that
//! are not doors. A page that served its content while framing one is not
//! holding anything back; a refusal whose frame is a hidden 1x1 gives a person
//! nothing to press. Neither is a door, and neither should send a walk to a
//! window.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::session::{mint, MintOptions, Waits};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};

/// A server that answers every request with its own tiny document: the other
/// site whose widget the walked page frames. A different port is a different
/// origin, which is what makes the frame cross-site.
fn other_site() -> (SocketAddr, Arc<AtomicBool>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let handle = std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(_) => { std::thread::sleep(std::time::Duration::from_millis(10)); continue; }
            };
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).unwrap_or(0);
            let body = "<html><title>widget</title><body>Widget</body></html>";
            // Never cacheable: a cached document opens without a network
            // answer, and the status this fixture judges is the network's.
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        }
    });
    (address, stopped, handle)
}

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_framed_widget_is_a_door_only_where_the_site_refuses() {
    let (other, other_stopped, other_handle) = other_site();

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
            let line = request.lines().next().unwrap_or_default().to_string();
            if std::env::var_os("FIXTURE_TRACE").is_some() {
                eprintln!("   [fixture] {line:?}");
            }
            // A connection that asked for nothing is answered with nothing:
            // writing a page onto it would leave a response on a socket the
            // browser is about to send its real request down.
            if line.is_empty() {
                return;
            }
            let framed = |style: &str| {
                format!("<iframe src=\"http://{other}/widget\" style=\"{style};border:0\"></iframe>")
            };
            let (status, body) = if line.starts_with("GET /ordinary") {
                // A page that is not refusing, framing someone else's pixel.
                ("200 OK", format!("<html><title>A shop</title><body><h1>Welcome to the shop</h1>{}</body></html>", framed("width:1px;height:1px")))
            } else if line.starts_with("GET /refused-with-widget") {
                // A refusal whose door is something a person can see and press.
                ("403 Forbidden", format!("<html><title>shop.example</title><body>{}</body></html>", framed("width:400px;height:300px")))
            } else if line.starts_with("GET /refused-with-pixel") {
                // A refusal whose only frame is a pixel a person cannot press.
                ("403 Forbidden", format!("<html><title>shop.example</title><body>{}</body></html>", framed("width:1px;height:1px")))
            } else {
                ("200 OK", "<html><title>widget</title><body>Widget</body></html>".to_string())
            };
            // Never cacheable: a cached document opens without a network
            // answer, and the status this fixture judges is the network's.
            let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
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
    let dir = tempfile::tempdir().unwrap();
    for (path, expected) in [
        // A framed pixel on a served page is not a door.
        ("ordinary", None),
        // A frame a person can meet, on a refusal, is a door.
        ("refused-with-widget", Some("challenge")),
        // A frame no person could meet is not a door, even on a refusal.
        ("refused-with-pixel", Some("refused")),
    ] {
        let result = mint(MintOptions {
            url: format!("http://{address}/{path}"),
            session: path.to_string(),
            capture_dir: Some(dir.path().to_path_buf()),
            cdp_endpoint: Some(chrome.ws_url.clone()),
            settle_ms: 1_500,
            // The widget's door never opens, and the pages answer from this machine: the door is given up on after a
            // second and a half, and each page settles for the 1.5 s asked here, not the walk's least.
            waits: Waits { door: std::time::Duration::from_millis(1_500), least_settle: std::time::Duration::ZERO, ..Default::default() },
            ..Default::default()
        })
        .await;
        match expected {
            None => assert!(result.is_ok(), "{path} is an ordinary page, not a door: {result:?}"),
            Some(state) => {
                let error = result.expect_err(&format!("{path} must not mint as a page"));
                assert!(error.starts_with(&format!("mint unresolved ({state})")), "{path}: {error}");
            }
        }
        assert!(!chrome.has_exited());
    }
    chrome.kill();

    stopped.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(address);
    server.join().unwrap();
    other_stopped.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(other);
    other_handle.join().unwrap();
}
