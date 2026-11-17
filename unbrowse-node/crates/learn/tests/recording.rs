//! Local browser regression for branch 1.2 (`learn.record`, `learn.reference`): one walk of a page that signs its data
//! call yields a recording that holds the signer's script, by hash, and the stack that sent the signed call, so the
//! lab can find the function that made the value without walking the page again.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::session::{mint, MintOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use unbrowse_learn::blobs::{sha256_hex, Blobs};
use unbrowse_learn::recording::{Language, Recording};

/// The page's signer: a header made from the call's path and the time, hashed by the browser's own digest, sent after
/// an `await`.
const SIGNER: &str = r#"async function signRequest(path, ts) {
  const bytes = new TextEncoder().encode(path + '|' + ts + '|shop-secret');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function signedFetch(path) {
  const ts = String(Date.now());
  const signature = await signRequest(path, ts);
  return fetch(path, { headers: { 'x-signature': signature, 'x-ts': ts } });
}
signedFetch('/api/search?q=lamp').then((r) => r.json()).then((d) => { document.getElementById('out').textContent = d.items.join(', '); });
"#;

const PAGE: &str = r#"<!doctype html><html><head><title>Search</title><script src="/signer.js"></script></head><body><p id="out"></p></body></html>"#;

fn site() -> (SocketAddr, Arc<AtomicBool>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let handle = std::thread::spawn(move || {
        let mut workers = Vec::new();
        while !stop.load(Ordering::Relaxed) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
            };
            workers.push(std::thread::spawn(move || {
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
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
                if line.is_empty() {
                    return;
                }
                let signed = request.to_ascii_lowercase().contains("\r\nx-signature: ");
                let (status, kind, body) = if line.starts_with("GET /signer.js") {
                    ("200 OK", "text/javascript", SIGNER.to_string())
                } else if line.starts_with("GET /api/search") && signed {
                    ("200 OK", "application/json", r#"{"items":["a desk lamp","a floor lamp"]}"#.to_string())
                } else if line.starts_with("GET /api/search") {
                    ("401 Unauthorized", "application/json", r#"{"error":"unsigned"}"#.to_string())
                } else if line.starts_with("GET / ") {
                    ("200 OK", "text/html", PAGE.to_string())
                } else {
                    ("404 Not Found", "text/plain", String::new())
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }));
        }
        for worker in workers {
            let _ = worker.join();
        }
    });
    (address, stopped, handle)
}

fn scratch(name: &str) -> std::path::PathBuf {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
    let dir = std::env::temp_dir().join(format!("{name}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn one_walk_of_a_signing_page_yields_a_recording_with_the_signers_script_and_stack() {
    let (address, stopped, handle) = site();
    let profile = scratch("recording-profile");
    let options = LaunchOptions { headless: true, profile: Some(profile.to_string_lossy().into_owned()), ..Default::default() };
    let mut chrome = launch_chrome(&options).unwrap();
    let capture = scratch("recording-capture");
    let url = format!("http://{address}/");
    let walked = mint(MintOptions {
        url: url.clone(),
        session: "signing".into(),
        capture_dir: Some(capture.clone()),
        cdp_endpoint: Some(chrome.ws_url.clone()),
        settle_ms: 3_000,
        ..Default::default()
    })
    .await;
    chrome.kill();
    stopped.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(address);
    handle.join().unwrap();
    assert!(walked.is_ok(), "{walked:?}");

    let recording = Recording::read(&capture, "signing").expect("the walk's recording reads");
    // The signed call, as the site answered it.
    let call = recording
        .trace
        .exchanges
        .iter()
        .find(|e| e.url.path() == "/api/search" && e.status == 200)
        .expect("the page's signed call was answered");
    assert!(call.request_headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("x-signature") && v.len() == 64), "{:?}", call.request_headers);

    // The stack that sent it, into the signer's script.
    let (script, frame) = recording.sent_by(call).expect("the signed call names the script that sent it");
    assert_eq!(script.url, format!("{url}signer.js"));
    assert_eq!(script.language, Language::Js);
    let initiator = recording.initiator_of(call).unwrap();
    let functions: Vec<&str> = initiator.all_frames().map(|f| f.function.as_str()).collect();
    assert!(functions.contains(&"signedFetch"), "the function that sent the call is on its stack: {functions:?}");
    assert_eq!(frame.url, script.url);

    // The signer's code, by hash: the body the site served, kept once in the blob store.
    let sha = script.sha256.as_deref().expect("the script has its hash");
    assert_eq!(sha, sha256_hex(SIGNER.as_bytes()));
    let body = recording.body(sha).expect("the walk kept the signer's body");
    assert!(std::str::from_utf8(body).unwrap().contains("async function signRequest(path, ts)"));
    let store = scratch("recording-blobs");
    let blobs = Blobs::at(&store);
    assert!(recording.keep_scripts(&blobs).unwrap() >= 1);
    assert_eq!(blobs.get(sha).unwrap().as_deref(), Some(SIGNER.as_bytes()));

    for dir in [profile, capture, store] {
        let _ = std::fs::remove_dir_all(dir);
    }
}
