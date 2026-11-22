//! Local browser regression: a walk reads the page over DevTools and adds nothing to it but its fingerprint probe
//! (`learn.record`, UNB-208 L04). Lewis, 13 Nov 2026: the walk may add a script to the page, so the probe stays; this
//! test holds the walk to exactly that probe: the four natives it wraps and the one global it keeps its sample in.
//!
//! The fixture page inspects itself a moment after it loads: which of its natives no longer read as native code, and
//! which globals its window holds. It sends what it saw to its own site. The same page is loaded three times in one
//! browser: as it is, with a script a test adds before the page's own (the control: the inspection must see that), and
//! under a walk. The walk's view must be the plain one plus the probe, and nothing else.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::cdp::client::CdpClient;
use agent_browser_core::session::{mint, MintOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

/// The page's self-inspection: every function on the prototypes a page script can patch, and the window's globals.
const INSPECT: &str = r#"
const toText = Function.prototype.toString;
setTimeout(() => {
  const owners = {
    window, EventTarget: EventTarget.prototype, Node: Node.prototype, Element: Element.prototype,
    HTMLElement: HTMLElement.prototype, Document: Document.prototype, HTMLCanvasElement: HTMLCanvasElement.prototype,
    CanvasRenderingContext2D: CanvasRenderingContext2D.prototype,
    WebGLRenderingContext: WebGLRenderingContext.prototype, WebGL2RenderingContext: WebGL2RenderingContext.prototype,
    XMLHttpRequest: XMLHttpRequest.prototype, String: String.prototype, Array: Array.prototype, Object,
    Function: Function.prototype, JSON, Math, Navigator: Navigator.prototype, Screen: Screen.prototype,
    Storage: Storage.prototype, History: History.prototype, Promise: Promise.prototype, Date: Date.prototype,
    Crypto: Crypto.prototype, SubtleCrypto: SubtleCrypto.prototype, TextEncoder: TextEncoder.prototype,
  };
  const patched = [];
  for (const [name, owner] of Object.entries(owners)) {
    for (const key of Object.getOwnPropertyNames(owner)) {
      let d;
      try { d = Object.getOwnPropertyDescriptor(owner, key); } catch (e) { continue; }
      for (const f of [d && d.value, d && d.get, d && d.set]) {
        if (typeof f !== 'function') continue;
        let text = '';
        try { text = toText.call(f); } catch (e) { text = '?'; }
        if (!/\{\s*\[native code\]\s*\}\s*$/.test(text)) {
          patched.push(name + '.' + key);
        }
      }
    }
  }
  const report = { load: location.search.slice(1), patched: patched.sort(), globals: Object.getOwnPropertyNames(window).sort() };
  fetch('/report', { method: 'POST', body: JSON.stringify(report) });
}, 1500);
"#;

fn page() -> String {
    format!("<html><head><title>A shop</title><script>{INSPECT}</script></head><body><h1>Welcome to the shop</h1></body></html>")
}

/// The fixture site: the page, and what each load of it reported.
fn site() -> (SocketAddr, Arc<AtomicBool>, Arc<Mutex<Vec<serde_json::Value>>>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let reports: Arc<Mutex<Vec<serde_json::Value>>> = Default::default();
    let (stop, kept) = (stopped.clone(), reports.clone());
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
                let mut chunk = [0; 65536];
                let mut body_at = None;
                loop {
                    if body_at.is_none() {
                        body_at = request.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4);
                    }
                    if let Some(at) = body_at {
                        let head = String::from_utf8_lossy(&request[..at]).to_ascii_lowercase();
                        let length = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if request.len() >= at + length {
                            break;
                        }
                    }
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&request).lines().next().unwrap_or_default().to_string();
                if line.starts_with("POST /report") {
                    if let Some(at) = body_at {
                        if let Ok(report) = serde_json::from_slice::<serde_json::Value>(&request[at..]) {
                            kept.lock().unwrap().push(report);
                        }
                    }
                }
                let body = if line.starts_with("GET /?") || line.starts_with("GET / ") { page() } else { String::new() };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    (address, stopped, reports, handle)
}

/// Waits for the report of the load named `load`.
fn report_of(reports: &Mutex<Vec<serde_json::Value>>, load: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(r) = reports.lock().unwrap().iter().find(|r| r["load"] == load) {
            return r.clone();
        }
        assert!(Instant::now() < deadline, "the page loaded as `{load}` reported what it saw");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Opens the page in a tab of its own, with `script` added before the page's own when given, outside any walk.
async fn open(browser: &CdpClient, url: &str, script: Option<&str>) {
    let target = browser
        .send_command("Target.createTarget", Some(serde_json::json!({ "url": "about:blank" })), None)
        .await
        .unwrap();
    let target = target["targetId"].as_str().unwrap().to_string();
    let attached = browser
        .send_command("Target.attachToTarget", Some(serde_json::json!({ "targetId": target, "flatten": true })), None)
        .await
        .unwrap();
    let session = attached["sessionId"].as_str().unwrap().to_string();
    browser.send_command("Page.enable", None, Some(&session)).await.unwrap();
    if let Some(source) = script {
        browser
            .send_command("Page.addScriptToEvaluateOnNewDocument", Some(serde_json::json!({ "source": source })), Some(&session))
            .await
            .unwrap();
    }
    browser
        .send_command("Page.navigate", Some(serde_json::json!({ "url": url })), Some(&session))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_walk_adds_nothing_to_the_page_but_its_fingerprint_probe() {
    let (address, stopped, reports, handle) = site();
    let profile = tempfile::tempdir().unwrap();
    let mut options = LaunchOptions::default();
    options.headless = true;
    options.profile = Some(profile.path().to_string_lossy().into_owned());
    let mut chrome = launch_chrome(&options).expect("a browser to load the page in");
    let browser = CdpClient::connect(&chrome.ws_url).await.unwrap();

    open(&browser, &format!("http://{address}/?plain"), None).await;
    let plain = report_of(&reports, "plain");
    // The control: a script added before the page's own, as a probe would be, is seen by the page.
    open(
        &browser,
        &format!("http://{address}/?control"),
        Some("window.__added = 1; const t = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = function () { return t.apply(this, arguments); };"),
    )
    .await;
    let control = report_of(&reports, "control");
    assert_ne!(control["patched"], plain["patched"], "the page sees a native a script replaced: {control}");
    assert_ne!(control["globals"], plain["globals"], "the page sees a global a script added");

    let capture = tempfile::tempdir().unwrap();
    let walked = mint(MintOptions {
        url: format!("http://{address}/?walked"),
        session: "passive".to_string(),
        capture_dir: Some(capture.path().to_path_buf()),
        cdp_endpoint: Some(chrome.ws_url.clone()),
        settle_ms: 4_000,
        ..Default::default()
    })
    .await;
    let seen = report_of(&reports, "walked");
    chrome.kill();
    stopped.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(address);
    handle.join().unwrap();
    assert!(walked.is_ok(), "the fixture page is an ordinary page: {walked:?}");
    let beyond = |key: &str| -> Vec<String> {
        let before = plain[key].as_array().unwrap();
        seen[key].as_array().unwrap().iter().filter(|v| !before.contains(v)).map(|v| v.as_str().unwrap().to_string()).collect()
    };
    assert_eq!(beyond("patched"), PROBE_WRAPS, "a walk replaces only the natives its fingerprint probe wraps");
    assert_eq!(beyond("globals"), [PROBE_KEEPS], "a walk adds no global but the probe's sample");
}

/// What the walk's fingerprint probe (session.rs `FINGERPRINT_PROBE`) wraps, sorted as the page reports them.
const PROBE_WRAPS: [&str; 4] = [
    "CanvasRenderingContext2D.getImageData",
    "HTMLCanvasElement.toDataURL",
    "WebGL2RenderingContext.getParameter",
    "WebGLRenderingContext.getParameter",
];
/// Where the probe keeps its sample.
const PROBE_KEEPS: &str = "__unbrowse_fp";
