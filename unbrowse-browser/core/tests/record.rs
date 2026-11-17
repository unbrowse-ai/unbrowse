//! Local browser regression: a walk records the page's code, read over DevTools (`learn.record`).
//!
//! The capture says which code sent each request (the initiator's stack, by script id), lists every script the page
//! parsed with the sha256 of its body (a wasm module's body kept as its bytes), and holds the page's storage when it
//! settled and when the walk ended. The fixture page signs its data call in a script of its own after an `await`,
//! compiles a wasm module from bytes it carries, and writes to its storage once at load and once later.
use agent_browser_core::cdp::chrome::{launch_chrome, LaunchOptions};
use agent_browser_core::session::{capture_path, mint, read_capture, MintOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// The page's own script: the function that signs and the one that sends the call.
const APP_JS: &str = r#"function sign(text) {
  let h = 7;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(16);
}
async function askForData() {
  await new Promise((done) => setTimeout(done, 50));
  const q = 'shoes';
  return fetch('/api/data?q=' + q + '&sig=' + sign(q));
}
askForData();
"#;

/// The smallest module with an export: `add(a, b)`.
const WASM: &[u8] = &[
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // type: (i32, i32) -> i32
    0x03, 0x02, 0x01, 0x00, // function 0 has type 0
    0x07, 0x07, 0x01, 0x03, b'a', b'd', b'd', 0x00, 0x00, // export "add"
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, // body: a + b
];

fn page() -> String {
    let bytes: Vec<String> = WASM.iter().map(|b| b.to_string()).collect();
    format!(
        r#"<html><head><title>A shop</title>
<script>
localStorage.setItem('early', 'at-load');
sessionStorage.setItem('tab', 'one');
setTimeout(() => localStorage.setItem('late', 'after-settle'), 4000);
WebAssembly.instantiate(new Uint8Array([{}])).then((m) => {{ window.added = m.instance.exports.add(2, 3); }});
</script>
<script src="/app.js"></script>
</head><body><h1>Welcome to the shop</h1></body></html>"#,
        bytes.join(",")
    )
}

/// The fixture site: the page, its script and its data call. Never cacheable: a cached script is parsed without a
/// network answer, and the test compares the parsed body with the one served.
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
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                }
            };
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
                let request = String::from_utf8_lossy(&request);
                let line = request.lines().next().unwrap_or_default().to_string();
                if line.is_empty() {
                    return;
                }
                let (kind, body) = if line.starts_with("GET /app.js") {
                    ("text/javascript", APP_JS.to_string())
                } else if line.starts_with("GET /api/data") {
                    ("application/json", r#"{"items":[{"name":"red shoes"}]}"#.to_string())
                } else if line.starts_with("GET / ") {
                    ("text/html", page())
                } else {
                    ("text/plain", String::new())
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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

/// Walks the fixture page once and returns its capture's lines and the page's address.
async fn walk(session: &str) -> (Vec<serde_json::Value>, String) {
    let (address, stopped, handle) = site();
    let profile = tempfile::tempdir().unwrap();
    let mut options = LaunchOptions::default();
    options.headless = true;
    options.profile = Some(profile.path().to_string_lossy().into_owned());
    let mut chrome = launch_chrome(&options).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let url = format!("http://{address}/");
    let result = mint(MintOptions {
        url: url.clone(),
        session: session.to_string(),
        capture_dir: Some(dir.path().to_path_buf()),
        cdp_endpoint: Some(chrome.ws_url.clone()),
        // Long enough that what the page writes four seconds in is before the walk's end, and well after the walk
        // has found the page ready: the two snapshots are then seconds either side of it, not a race with it.
        settle_ms: 6_000,
        ..Default::default()
    })
    .await;
    chrome.kill();
    stopped.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(address);
    handle.join().unwrap();
    assert!(result.is_ok(), "the fixture page is an ordinary page: {result:?}");
    (read_capture(&capture_path(dir.path(), session)), url)
}

fn of_type<'a>(lines: &'a [serde_json::Value], kind: &str) -> Vec<&'a serde_json::Value> {
    lines.iter().filter(|l| l["type"] == kind).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_request_carries_the_stack_that_sent_it() {
    let (lines, url) = walk("stack").await;
    let call = of_type(&lines, "request")
        .into_iter()
        .find(|r| r["url"].as_str().is_some_and(|u| u.contains("/api/data")))
        .expect("the page's data call is in the capture");
    let initiator = &call["initiator"];
    assert_eq!(initiator["type"], "script", "a call a script made says so: {initiator}");
    // The function that sent it, in its own frames or a hop back, with the script it is in and where.
    let mut frames: Vec<&serde_json::Value> = initiator["frames"].as_array().into_iter().flatten().collect();
    for hop in initiator["parents"].as_array().into_iter().flatten() {
        frames.extend(hop["frames"].as_array().into_iter().flatten());
    }
    let sender = frames
        .iter()
        .find(|f| f["function"] == "askForData")
        .unwrap_or_else(|| panic!("the stack names the function that sent the call: {initiator}"));
    assert_eq!(sender["url"], format!("{url}app.js"));
    assert!(sender["line"].as_u64().is_some() && sender["column"].as_u64().is_some(), "{sender}");
    // Every script a stack names is one the capture lists.
    let listed: Vec<&str> = of_type(&lines, "script").iter().filter_map(|s| s["scriptId"].as_str()).collect();
    for frame in &frames {
        let id = frame["scriptId"].as_str().unwrap_or_default();
        assert!(listed.contains(&id), "script {id} sent a call and isn't listed: {frame}");
    }
    // The page itself was sent by nobody's script: its initiator says so.
    let document = of_type(&lines, "request").into_iter().find(|r| r["url"] == url.as_str()).expect("the page");
    assert_ne!(document["initiator"]["type"], "script", "{}", document["initiator"]);
}

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn every_script_the_page_parsed_is_listed_with_its_hash() {
    let (lines, url) = walk("scripts").await;
    let scripts = of_type(&lines, "script");
    let app = scripts
        .iter()
        .find(|s| s["url"] == format!("{url}app.js"))
        .unwrap_or_else(|| panic!("the page's script is listed: {scripts:?}"));
    assert_eq!(app["language"], "js");
    assert_eq!(app["sha256"], sha256_hex(APP_JS.as_bytes()), "the hash is the served body's");
    assert_eq!(app["length"], APP_JS.len());
    assert_eq!(app["source"], APP_JS, "the body is kept the first time its hash is met");
    // The inline script is listed under the page's own address, with a body that hashes to what is listed.
    let inline = scripts
        .iter()
        .find(|s| s["url"] == url.as_str() && s["source"].as_str().is_some_and(|b| b.contains("localStorage.setItem('early'")))
        .unwrap_or_else(|| panic!("the inline script is listed: {scripts:?}"));
    assert_eq!(inline["sha256"], sha256_hex(inline["source"].as_str().unwrap().as_bytes()));
    // Every listed script has an id and a hash, and a hash's body is written once.
    let mut bodies = std::collections::HashMap::new();
    for s in &scripts {
        assert!(s["scriptId"].as_str().is_some_and(|i| !i.is_empty()), "{s}");
        let sha = s["sha256"].as_str().unwrap_or_else(|| panic!("a listed script has its hash: {s}"));
        if s.get("source").is_some() || s.get("bytes").is_some() {
            *bodies.entry(sha.to_string()).or_insert(0) += 1;
        }
    }
    assert!(bodies.values().all(|n| *n == 1), "a body is kept once per hash: {bodies:?}");
    // The walk's own reads of the page are not the page's code.
    assert!(
        scripts.iter().all(|s| !s["source"].as_str().is_some_and(|b| b.contains("readyState"))),
        "the walk's own expressions are not listed as the page's scripts"
    );
}

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_wasm_module_is_kept_as_its_bytes() {
    use base64::Engine;
    let (lines, _) = walk("wasm").await;
    let modules: Vec<&serde_json::Value> = of_type(&lines, "script").into_iter().filter(|s| s["language"] == "wasm").collect();
    assert_eq!(modules.len(), 1, "the one module the page compiled is listed: {modules:?}");
    let module = modules[0];
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(module["bytes"].as_str().expect("the module's body is kept"))
        .unwrap();
    assert_eq!(bytes, WASM, "the module's bytes are the ones the page compiled");
    assert_eq!(module["sha256"], sha256_hex(WASM));
    assert_eq!(module["length"], WASM.len());
    assert!(module.get("source").is_none(), "a module is kept as bytes, not text");
}

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn the_pages_storage_is_recorded_at_settle_and_at_the_end() {
    let (lines, url) = walk("storage").await;
    let origin = url.trim_end_matches('/');
    let at = |when: &str| {
        of_type(&lines, "origin_storage")
            .into_iter()
            .find(|s| s["at"] == when && s["origin"] == origin)
            .unwrap_or_else(|| panic!("the page's storage at {when}: {:?}", of_type(&lines, "origin_storage")))
            .clone()
    };
    let settle = at("settle");
    let end = at("end");
    assert_eq!(settle["local"]["early"], "at-load");
    assert_eq!(settle["session"]["tab"], "one");
    assert!(settle["local"].get("late").is_none(), "written after the page settled: {settle}");
    assert_eq!(end["local"]["early"], "at-load");
    assert_eq!(end["local"]["late"], "after-settle", "what the page wrote while it ran: {end}");
    // Settle comes first in the log.
    let place = |when: &str| lines.iter().position(|l| l["type"] == "origin_storage" && l["at"] == when).unwrap();
    assert!(place("settle") < place("end"));
}
