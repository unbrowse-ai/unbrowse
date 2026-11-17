//! Local browser regression: a walk asked to try a page's controls makes the calls they send, and leaves alone what isn't
//! one: a form that posts, a sign-in, a switch, the page's chrome.
use agent_browser_core::session::{mint, read_capture, MintOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};

const PAGE: &str = r#"<html><head><title>Lamps</title></head><body>
<header><input type="checkbox" id="chrome-box" onchange="ask('chrome=1')"></header>
<aside>
  <label><input type="checkbox" name="material" value="brass" onchange="ask('material=' + (this.checked ? 'brass' : ''))"> Brass</label>
  <select name="sort" onchange="ask('sort=' + this.value)"><option value="relevance">Relevance</option><option value="price">Price</option></select>
  <button role="switch" aria-checked="false" onclick="ask('switch=1')">Dark mode</button>
  <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('more').hidden=false">More filters</button>
  <div id="more" hidden><button aria-pressed="false" onclick="ask('instock=1')">In stock</button></div>
</aside>
<form method="post" action="/save"><label><input type="checkbox" name="news" onchange="ask('posted=1')"> News</label></form>
<form><input type="password" name="pw"><label><input type="checkbox" name="stay" onchange="ask('signin=1')"> Stay</label></form>
<ul id="list"></ul>
<script>
function ask(q) { return fetch('/api/search?' + q).then(r => r.json()); }
ask('');
</script></body></html>"#;

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_walk_tries_what_narrows_a_list_and_nothing_else() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = asked.clone();
    let server = std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let (mut stream, _) = match listener.accept() {
                Ok(c) => c,
                Err(_) => { std::thread::sleep(std::time::Duration::from_millis(10)); continue; }
            };
            let seen = seen.clone();
            std::thread::spawn(move || {
                let _ = stream.set_nonblocking(false);
                let mut request = [0; 8192];
                let n = stream.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..n]).to_string();
                let path = text.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (kind, body) = if path.starts_with("/api/") {
                    seen.lock().unwrap().push(path);
                    ("application/json", r#"{"items":[{"id":1}]}"#.to_string())
                } else {
                    ("text/html", PAGE.to_string())
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            });
        }
    });
    let dir = std::env::temp_dir().join(format!("mint-controls-{}", std::process::id()));
    let walked = mint(MintOptions {
        url: format!("http://{address}/"),
        session: "controls".into(),
        capture_dir: Some(dir.clone()),
        profile: Some(dir.join("profile").to_string_lossy().into_owned()),
        settle_ms: 3_000,
        browse: true,
        try_controls: true,
        ..Default::default()
    })
    .await;
    stopped.store(true, Ordering::Relaxed);
    server.join().unwrap();
    let _ = read_capture;
    let _ = std::fs::remove_dir_all(&dir);
    walked.expect("the walk ran");
    let asked = asked.lock().unwrap().clone();
    let sent = |q: &str| asked.iter().any(|a| a.contains(q));
    assert!(sent("material=brass"), "a checkbox beside the list: {asked:?}");
    assert!(sent("material="), "and put back");
    assert!(sent("sort=price"), "a select: {asked:?}");
    assert!(sent("instock=1"), "a control behind a panel it opened: {asked:?}");
    for left_alone in ["chrome=1", "switch=1", "posted=1", "signin=1"] {
        assert!(!sent(left_alone), "{left_alone}: {asked:?}");
    }
}
