//! The route probe, run as a program over captures it is handed and a shop the test starts on this machine.
//! The probe's own answer is its exit code and what it prints: whether the direct call works, and why not.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const PROBE: &str = env!("CARGO_BIN_EXE_route_probe");

/// A folder of the test's own, gone when it drops.
struct Dir(PathBuf);
impl Dir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("route-probe-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A shop on 127.0.0.1: `/api/token` hands out the token it was last told to, `/api/search` answers 200 with the
/// word it was asked for when it is sent the token, 403 when it is not. Every request line it saw is kept.
struct Shop {
    port: u16,
    seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}
impl Shop {
    fn start(token: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let kept = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = text.lines().next().unwrap_or_default().to_string();
                kept.lock().unwrap().push(text.replace("\r\n", " | "));
                let (status, body) = if line.starts_with("GET /api/token") {
                    ("200 OK", format!(r#"{{"token":"{token}"}}"#))
                } else if line.starts_with("GET /api/search") {
                    let word = line.split("q=").nth(1).and_then(|r| r.split([' ', '&']).next()).unwrap_or_default();
                    if text.to_ascii_lowercase().contains(&format!("x-token: {token}")) {
                        ("200 OK", format!(r#"{{"found":"{word} number one"}}"#))
                    } else {
                        ("403 Forbidden", r#"{"error":"no token"}"#.to_string())
                    }
                } else {
                    ("404 Not Found", "{}".to_string())
                };
                let _ = write!(stream, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        Self { port, seen }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// The sidecar's log of one walk of the page: the word typed, the token fetched, the search made with it.
    fn log(&self, word: &str, token: &str) -> String {
        let exchange = |t: f64, url: String, headers: serde_json::Value, body: String| {
            serde_json::json!({"type": "exchange", "t": t, "resourceType": "Fetch", "entry": {
                "request": {"method": "GET", "url": url, "headers": headers},
                "response": {"status": 200, "headers": [], "content": {"mimeType": "application/json", "text": body}}}})
        };
        let lines = [
            serde_json::json!({"type": "action", "t": 0.5, "action": "fill", "selector": "#q", "field": "q", "value": word}),
            exchange(1.0, self.url("/api/token"), serde_json::json!([]), format!(r#"{{"token":"{token}"}}"#)),
            exchange(2.0, self.url(&format!("/api/search?q={word}")), serde_json::json!([{"name": "x-token", "value": token}]), format!(r#"{{"found":"{word} number one"}}"#)),
        ];
        lines.iter().map(|l| format!("{l}\n")).collect()
    }
}

fn probe(args: &[&str], tmp: &Path) -> Output {
    Command::new(PROBE).args(args).env("TMPDIR", tmp).env_remove("UNBROWSE_BROWSER").output().expect("the probe runs")
}

fn said(out: &Output) -> (String, String) {
    (String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
}

fn write(dir: &Dir, name: &str, text: &str) -> String {
    let path = dir.0.join(name);
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().to_string()
}

#[test]
fn a_probe_asked_for_nothing_says_how_it_is_used_and_fails() {
    let dir = Dir::new("usage");
    for (args, why) in [
        (vec![], "a capture log and --target are required"),
        (vec!["log.jsonl"], "a capture log and --target are required"),
        (vec!["--target"], "--target needs a URL substring"),
        (vec!["--input"], "--input needs name=value"),
        (vec!["--input", "novalue"], "--input needs name=value"),
        (vec!["--browser"], "--browser needs the agent-browser path"),
        (vec!["--browser-step", "first"], "--browser-step needs a 1-based step number"),
        (vec!["--jar"], "--jar needs a directory path"),
        (vec!["--nonsense"], "unknown flag --nonsense"),
        // Every flag given its value, and still no log to read.
        (vec!["--target", "/api/search", "--input", "q=lamp", "--browser", "/no/such/browser", "--browser-step", "1", "--jar", "/no/such/jar"], "a capture log and --target are required"),
    ] {
        let out = probe(&args, &dir.0);
        let (stdout, stderr) = said(&out);
        assert!(!out.status.success(), "{args:?}");
        assert!(stderr.starts_with(why) && stderr.contains("usage: route-probe"), "{args:?}: {stderr}");
        assert!(stdout.is_empty(), "{args:?}: {stdout}");
    }
}

#[test]
fn a_capture_that_cannot_be_read_or_holds_no_such_call_is_said_before_anything_is_sent() {
    let dir = Dir::new("capture");
    let shop = Shop::start("tok_a");
    let missing = dir.0.join("missing.jsonl");
    let out = probe(&[missing.to_str().unwrap(), "--target", "/api/search"], &dir.0);
    assert!(!out.status.success());
    assert!(said(&out).1.starts_with("reading ") && said(&out).1.contains("missing.jsonl"), "{:?}", said(&out));
    let broken = write(&dir, "broken.jsonl", "this is not a log\n");
    let out = probe(&[&broken, "--target", "/api/search"], &dir.0);
    assert!(!out.status.success());
    assert!(said(&out).1.starts_with("parsing "), "{:?}", said(&out));
    let log = write(&dir, "one.jsonl", &shop.log("lamp", "tok_a"));
    let out = probe(&[&log, "--target", "/api/nowhere"], &dir.0);
    assert!(!out.status.success());
    assert!(said(&out).1.contains("no captured API request (Fetch/XHR) matches /api/nowhere"), "{:?}", said(&out));
    assert!(shop.seen.lock().unwrap().is_empty(), "nothing was sent to the shop");
    // A capture that does hold the call is not said to hold none, whatever the probe goes on to do with it.
    let out = probe(&[&log, "--target", "/api/search"], &dir.0);
    assert!(!said(&out).1.contains("no captured API request"), "{:?}", said(&out));
    // The latest call that matches is the target: a substring of an address names it.
    let out = probe(&[&log, "--target", "/api/tok"], &dir.0);
    assert!(!said(&out).1.contains("no captured API request"), "{:?}", said(&out));
}


/// Two captures of one flow, a token then a search with it: the probe reads which values it can re-fetch, makes
/// the calls itself, and the search answers for the word it was handed (an input given on the command line outranks
/// the one the capture typed).
#[test]
fn a_probe_over_two_captures_makes_the_calls_itself_with_the_word_it_is_given() {
    let dir = Dir::new("direct");
    let shop = Shop::start("tok_live");
    let one = write(&dir, "one.jsonl", &shop.log("lamp", "tok_old1"));
    let two = write(&dir, "two.jsonl", &shop.log("sofa", "tok_old2"));
    let out = probe(&[&one, &two, "--target", "/api/search", "--input", "q=chair"], &dir.0);
    let (stdout, stderr) = said(&out);
    assert!(out.status.success(), "{stdout}\n{stderr}");
    assert!(stdout.contains("== route: /api/search (from "), "{stdout}");
    assert!(stdout.contains("second sighting: "), "{stdout}");
    assert!(stdout.contains("== direct call works"), "{stdout}");
    assert!(stdout.contains("target answered ") && stdout.contains("bytes"), "{stdout}");
    let seen = shop.seen.lock().unwrap().join("\n");
    assert!(seen.contains("GET /api/token"), "the token is fetched again: {seen}");
    assert!(seen.contains("GET /api/search?q=chair"), "the word given is the word asked: {seen}");
    assert!(seen.to_ascii_lowercase().contains("x-token: tok_live"), "the search carries the token the shop just gave: {seen}");
    assert!(seen.contains("unbrowse-node/"), "the call says who it is: {seen}");
}

/// A search the shop refuses (it is sent no token the shop knows) is a direct call that failed, said with the
/// status; a session kept in `--jar` is loaded the next time and written back after a run.
#[test]
fn a_probe_whose_call_the_shop_refuses_says_so_and_keeps_the_session_it_was_handed() {
    let dir = Dir::new("refused");
    let shop = Shop::start("tok_live");
    // The capture's search carries a header the replay will not rebuild from the token's call, because the walk
    // saw the same value twice on both captures: it stays a fixed value, which this shop refuses.
    let bad = |word: &str| {
        let text = shop.log(word, "tok_same");
        text.replace("\"x-token\"", "\"x-other\"")
    };
    let one = write(&dir, "one.jsonl", &bad("lamp"));
    let two = write(&dir, "two.jsonl", &bad("sofa"));
    let jar = dir.0.join("jar");
    std::fs::create_dir_all(&jar).unwrap();
    let host_file = jar.join(format!("127.0.0.1:{}.json", shop.port));
    std::fs::write(&host_file, r#"{"session":"abc"}"#).unwrap();
    let out = probe(&[&one, &two, "--target", "/api/search", "--jar", jar.to_str().unwrap()], &dir.0);
    let (stdout, stderr) = said(&out);
    assert!(!out.status.success(), "{stdout}\n{stderr}");
    assert!(stdout.contains("== minted session loaded from "), "{stdout}");
    assert!(stdout.contains("== direct call failed: ") || stdout.contains("== direct call refused: "), "{stdout}");
    assert!(stdout.contains("== minted session saved to ") || stdout.contains("== direct call refused: "), "{stdout}");
    let written = std::fs::read_to_string(&host_file).unwrap();
    assert!(written.contains("session"), "the jar kept what it held: {written}");
}

/// A step marked for the browser is read from what the browser's capture holds for its address, and the live
/// jar's cookies are the minted values: the probe drives the browser it is handed (here a script) and never the
/// plain transport for that step.
#[cfg(unix)]
#[test]
fn a_step_marked_for_the_browser_is_read_from_the_browsers_own_capture() {
    let dir = Dir::new("browser");
    let shop = Shop::start("tok_live");
    let one = write(&dir, "one.jsonl", &shop.log("lamp", "tok_old1"));
    let two = write(&dir, "two.jsonl", &shop.log("sofa", "tok_old2"));
    let token_url = shop.url("/api/token");
    let entry = serde_json::json!({"type": "exchange", "t": 1.0, "entry": {
        "request": {"method": "GET", "url": token_url, "headers": []},
        "response": {"status": 200, "headers": [{"name": "set-cookie", "value": "sid=browser1; Path=/"}], "content": {"mimeType": "application/json", "text": r#"{"token":"tok_live"}"#}}}});
    let script = write(
        &dir,
        "browser.sh",
        &format!(
            "#!/bin/sh\nsess=$2\ncmd=$3\ncase \"$cmd\" in\n  open) mkdir -p \"$UNBROWSE_CAPTURE_DIR\"; printf '%s\\n' '{entry}' >> \"$UNBROWSE_CAPTURE_DIR/$sess.jsonl\" ;;\n  get) [ \"$4\" = url ] && echo 'https://shop.example/landed' ;;\nesac\nexit 0\n"
        ),
    );
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let out = probe(&[&one, &two, "--target", "/api/search", "--browser", &script, "--browser-step", "1"], &dir.0);
    let (stdout, stderr) = said(&out);
    assert!(out.status.success(), "{stdout}\n{stderr}");
    assert!(stdout.contains("[browser] landed on https://shop.example/landed"), "{stdout}");
    assert!(stdout.contains("(browser, cached)") || stdout.contains("== direct call works"), "{stdout}");
    let seen = shop.seen.lock().unwrap().join("\n");
    assert!(!seen.contains("GET /api/token"), "the token's call was the browser's, not the plain transport's: {seen}");
    assert!(seen.contains("GET /api/search"), "{seen}");
}
