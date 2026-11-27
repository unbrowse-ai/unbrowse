//! A diagnostic for "can this captured API call be made directly?".
//!
//! Reads one or two passively captured session logs (the browser sidecar's
//! `<session>.jsonl`), builds the dependency graph for the last request whose URL
//! matches `--target`, and tries the clean replay. Nothing is published; the probe
//! reports which values the chain can re-fetch, which the page computes, and whether
//! the direct call answers. A second log of the same flow settles values that a
//! single sighting leaves unconfirmed.
//!
//! Usage:
//!   route-probe <log1.jsonl> [<log2.jsonl>] --target <url-substring>
//!     [--input name=value]... [--browser <agent-browser>] [--browser-step <n>]...
//!
//! Inputs default to the values the agent typed during the first capture, and
//! browser-minted cookies (a session value the node's browsing created, such as a
//! cookie set before the capture) default to their recorded values. With
//! `--browser-step n` (1-based), step n runs in the fork's browser instead of plain
//! HTTP — for a site whose front door challenges plain clients — and the live cookie
//! jar then supplies the minted values.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::process::ExitCode;

use unbrowse_learn::graph::{self, Class, Graph};
use unbrowse_learn::replay::{replay_reseeded, Fetch, HttpFetch, ReplayError, Request};
use unbrowse_learn::trace::Exchange;
use unbrowse_learn::session::Session;
use unbrowse_learn::trace::{Input, Trace};

fn main() -> ExitCode {
    let mut logs: Vec<String> = Vec::new();
    let mut target = String::new();
    let mut inputs: Vec<(String, String)> = Vec::new();
    let mut browser: Option<String> = std::env::var("UNBROWSE_BROWSER").ok();
    let mut browser_steps: Vec<usize> = Vec::new();
    let mut jar: Option<String> = None;
    let mut args = std::env::args().skip(1).peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--target" => match args.next() {
                Some(v) => target = v,
                None => return usage("--target needs a URL substring"),
            },
            "--input" => match args.next() {
                Some(v) => match v.split_once('=') {
                    Some((k, val)) => inputs.push((k.to_string(), val.to_string())),
                    None => return usage("--input needs name=value"),
                },
                None => return usage("--input needs name=value"),
            },
            "--browser" => match args.next() {
                Some(v) => browser = Some(v),
                None => return usage("--browser needs the agent-browser path"),
            },
            "--browser-step" => match args.next().and_then(|v| v.parse().ok()) {
                Some(v) => browser_steps.push(v),
                None => return usage("--browser-step needs a 1-based step number"),
            },
            "--jar" => match args.next() {
                Some(v) => jar = Some(v),
                None => return usage("--jar needs a directory path"),
            },
            other if other.starts_with("--") => return usage(&format!("unknown flag {other}")),
            other => logs.push(other.to_string()),
        }
    }
    if logs.is_empty() || target.is_empty() {
        return usage("a capture log and --target are required");
    }

    let mut sessions = Vec::new();
    for path in &logs {
        let log = match std::fs::read_to_string(path) {
            Ok(log) => log,
            Err(e) => return fail(&format!("reading {path}: {e}")),
        };
        match Session::from_log(&log) {
            Ok(s) => sessions.push(s),
            Err(e) => return fail(&format!("parsing {path}: {e}")),
        }
    }
    let first = &sessions[0];
    let Some(target_idx) = first
        .candidates()
        .into_iter()
        .rev()
        .find(|&i| first.trace.exchanges[i].url.as_str().contains(&target))
    else {
        return fail(&format!("no captured API request (Fetch/XHR) matches {target}"));
    };
    let traces: Vec<Trace> = sessions.iter().map(|s| s.trace.clone()).collect();
    // By what the request is, not where it sits in memory: `graph::build` reads copies of the traces.
    let target_ex = &traces[0].exchanges[target_idx];
    let is_target = |ex: &Exchange| {
        ex.method == target_ex.method && ex.url == target_ex.url && ex.request_body == target_ex.request_body && ex.resource_type == target_ex.resource_type
    };
    let g = match graph::build(&traces, is_target) {
        Ok(g) => g,
        Err(e) => return fail(&format!("building the graph: {e}")),
    };

    println!("== route: {} (from {})", target, logs[0]);
    if let Some(second) = logs.get(1) {
        println!("   second sighting: {second}");
    }
    println!("{}", g.describe());
    for (n, step) in g.steps.iter().enumerate() {
        if let Some(unbrowse_learn::graph::Body::Json { template, types }) = &step.body {
            println!("   step {} body template: {} types: {:?}", n + 1, template, types);
        }
    }
    if g.provisional {
        println!("provisional: some value is unconfirmed; a second sighting settles it\n");
    }
    let browser_exchanges: HashSet<usize> =
        browser_steps.iter().filter_map(|n| g.steps.get(n - 1).map(|s| s.exchange)).collect();
    let root = browser_steps.first().copied().unwrap_or(1);

    let mut values: HashMap<String, String> = recorded_inputs(first).map(|i| (i.name, i.value)).collect();
    for (k, v) in inputs {
        values.insert(k, v);
    }
    let http = match HttpFetch::new() {
        Ok(h) => h,
        Err(e) => return fail(&format!("building the HTTP client: {e}")),
    };
    // The node's session store: browser-minted values from a live mint (the jar)
    // outrank the capture's recorded ones, which may be stale by days.
    let host = g.steps.last().map(|s| s.url.split('/').nth(2).unwrap_or("site").to_string());
    let jar_file = jar.as_ref().and_then(|dir| host.as_ref().map(|h| std::path::Path::new(dir).join(format!("{h}.json"))));
    let stored: HashMap<String, String> = jar_file
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if !stored.is_empty() {
        println!("== minted session loaded from {}", jar_file.as_ref().unwrap().display());
    }
    let mut jar_all = recorded_minted(&g, first);
    jar_all.extend(stored);
    let mut runner = Runner {
        http,
        jar: jar_all,
        browser,
        browser_exchanges,
        seeded: None,
        session: "route-probe".into(),
    };
    match replay_reseeded(&g, &values, &mut runner, root) {
        Ok(r) => {
            println!("== direct call works");
            for (n, (url, status)) in r.steps.iter().enumerate() {
                println!("  {}. {} -> {}", n + 1, url, status);
            }
            let body = r.target.response_body.as_deref().unwrap_or("");
            println!("   target answered {} bytes", body.len());
            save_jar(jar_file.as_ref(), &runner.jar);
            ExitCode::SUCCESS
        }
        Err(ReplayError::NeedsBrowser { step, url, loc }) => {
            println!("== direct call refused: step {step} ({url}) needs a browser for {loc}");
            ExitCode::FAILURE
        }
        Err(e) => {
            println!("== direct call failed: {e}");
            if let ReplayError::ShapeMismatch { expected, got } = &e {
                println!("   expected: {}", serde_json::to_string(expected).unwrap_or_default());
                println!("   got     : {}", serde_json::to_string(got).unwrap_or_default());
            }
            save_jar(jar_file.as_ref(), &runner.jar);
            ExitCode::FAILURE
        }
    }
}

/// Persists the node's browser-minted session values, so later calls run
/// browserless from them: click once, then never again.
fn save_jar(path: Option<&std::path::PathBuf>, jar: &HashMap<String, String>) {
    let Some(path) = path else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(jar) {
        let _ = std::fs::write(path, json);
        println!("== minted session saved to {} ({} values)", path.display(), jar.len());
    }
}

/// The recorded values for every minted field, from the first trace: the capture's
/// own session, which the node's browsing minted. Fresh until the site rotates them.
fn recorded_minted(g: &Graph, first: &Session) -> HashMap<String, String> {
    let mut jar = HashMap::new();
    for step in &g.steps {
        for f in &step.fields {
            if let Class::Minted { name } = &f.class {
                if !jar.contains_key(name) {
                    for ex in &first.trace.exchanges {
                        if let Some((_, v)) = ex.cookies().into_iter().find(|(k, _)| *k == *name) {
                            jar.insert(name.clone(), v);
                            break;
                        }
                    }
                }
            }
        }
    }
    jar
}

/// Every input of the first capture, in order, deduplicated by name.
fn recorded_inputs(first: &Session) -> impl Iterator<Item = Input> {
    let mut seen = HashSet::new();
    first
        .trace
        .inputs
        .iter()
        .filter(move |i| seen.insert(i.name.clone()))
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
}

/// Plain HTTP for everything; a stale session re-runs the route's root step in the
/// fork's browser once, whose raw response and live cookie jar then serve the retry.
struct Runner {
    http: HttpFetch,
    jar: HashMap<String, String>,
    browser: Option<String>,
    browser_exchanges: HashSet<usize>,
    /// The root step's browser response, cached for the retry after a reseed.
    seeded: Option<(usize, Exchange)>,
    session: String,
}

impl Fetch for Runner {
    /// This runner follows no redirect itself: its plain fetch is the unredirected one.
    fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        self.fetch(req)
    }

    fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        if let Some((exchange, ex)) = &self.seeded {
            if *exchange == req.exchange {
                println!("   step {} {} {} -> (browser, cached)", req.exchange, req.method, req.url);
                return Ok(ex.clone());
            }
        }
        // A step marked `--browser-step` always runs in the browser, whose raw
        // response is then cached for retries.
        if self.browser.is_some() && self.browser_exchanges.contains(&req.exchange) {
            let ex = self.run_in_browser(req)?;
            self.seeded = Some((req.exchange, ex.clone()));
            return Ok(ex);
        }
        let ex = self.http.fetch(req)?;
        println!("   step {} {} {} -> {}", req.exchange, req.method, req.url, ex.status);
        // A text body is shown as its start; a file's bytes only by their length.
        match (req.text(), &req.body) {
            (Some(text), _) => println!("      body: {}", text.chars().take(220).collect::<String>()),
            (None, Some(bytes)) => println!("      body: {} bytes", bytes.len()),
            (None, None) => {}
        }
        Ok(ex)
    }

    fn minted(&self, name: &str) -> Option<String> {
        self.jar.get(name).cloned()
    }

    fn reseed(&mut self, root: &Request) -> Result<(), ReplayError> {
        if self.browser.is_none() {
            return Ok(());
        }
        let ex = self.run_in_browser(root)?;
        self.seeded = Some((root.exchange, ex));
        Ok(())
    }
}

impl Runner {
    /// Opens the step's URL in the browser (retrying if the site challenges), reads
    /// back the raw response from the sidecar's passive capture — the DOM that
    /// `get html` returns would break the markers derived values use — and keeps the
    /// cookie jar for later steps' minted values.
    fn run_in_browser(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        let browser = self.browser.clone().expect("checked by the caller");
        let url = req.url.to_string();
        let cap_dir = std::env::temp_dir().join("route-probe-capture");
        let _ = std::fs::remove_dir_all(&cap_dir);
        let ab = |args: &[&str]| -> String {
            let out = Command::new(&browser)
                .args(["--session", &self.session])
                .args(args)
                .env("UNBROWSE_CAPTURE_DIR", &cap_dir)
                .output()
                .expect("running the browser");
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr).to_string();
            if !err.trim().is_empty() {
                println!("   [browser {}] {}", args.first().unwrap_or(&""), err.trim());
            }
            text
        };
        // The daemon reads the capture directory from its own start-up environment,
        // so recycle it: this run's browser session then records its raw responses.
        ab(&["close", "--all"]);
        std::thread::sleep(std::time::Duration::from_secs(2));
        let mut landed = None;
        for attempt in 0..4 {
            // Headed: the site's front door challenges headless clients far more readily.
            if attempt == 0 {
                ab(&["open", &url, "--headed"]);
            } else {
                ab(&["open", &url]);
            }
            std::thread::sleep(std::time::Duration::from_secs(6));
            let now = ab(&["get", "url"]);
            println!("   [browser] landed on {}", now.trim());
            if !now.contains("captcha") && !now.contains("chrome-error") && !now.trim().is_empty() {
                landed = Some(now.trim().to_string());
                break;
            }
        }
        let Some(_landed) = landed else {
            return Err(ReplayError::Failed {
                step: 0,
                url,
                status: 403,
                body: "the site kept challenging the browser, or the page never loaded".into(),
            });
        };
        // Let finished requests settle and flush to the capture log.
        std::thread::sleep(std::time::Duration::from_secs(2));
        ab(&["get", "url"]);
        let raw = std::fs::read_to_string(cap_dir.join(format!("{}.jsonl", self.session)))
            .unwrap_or_default();
        // Prefer the entry for this exact URL (a step that varies, such as a fresh
        // ?chal_t, must read its own response); fall back to the first entry with
        // the same address, for sites that normalize the URL on redirect.
        let address = |u: &str| u.split('?').next().unwrap_or(u).to_string();
        for exact in [true, false] {
            for line in raw.lines() {
                let Ok(o) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                if o.get("type").and_then(|t| t.as_str()) != Some("exchange") {
                    continue;
                }
                let entry_url = o.pointer("/entry/request/url").and_then(|u| u.as_str()).unwrap_or("");
                let hit = if exact { entry_url == url } else { address(entry_url) == address(&url) };
                if !hit {
                    continue;
                }
                let har = serde_json::json!({ "log": { "entries": [o["entry"].clone()] } });
                if let Ok(t) = Trace::from_har(&har.to_string(), vec![]) {
                    if let Some(ex) = t.exchanges.into_iter().next() {
                        for (name, value) in ex.set_cookies() {
                            self.jar.insert(name, value);
                        }
                        return Ok(ex);
                    }
                }
            }
        }
        Err(ReplayError::Failed {
            step: 0,
            url,
            status: 0,
            body: format!("the browser loaded the page but the raw response for it was not captured; see {}", cap_dir.display()),
        })
    }
}

/// The cookie jar from `agent-browser cookies get`, as name -> value. Accepts the
/// CLI's JSON output or plain `name=value` lines.
#[allow(dead_code)]
fn parse_cookie_jar(out: &str) -> HashMap<String, String> {
    let mut jar = HashMap::new();
    let trimmed = out.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let list = match &v {
                serde_json::Value::Object(m) => m.get("cookies").cloned().unwrap_or(v.clone()),
                _ => v.clone(),
            };
            if let Some(items) = list.as_array() {
                for item in items {
                    if let (Some(n), Some(val)) =
                        (item.get("name").and_then(|x| x.as_str()), item.get("value").and_then(|x| x.as_str()))
                    {
                        jar.insert(n.to_string(), val.to_string());
                    }
                }
                return jar;
            }
        }
    }
    for line in trimmed.lines() {
        if let Some((k, v)) = line.split_once('=') {
            jar.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    jar
}

fn usage(note: &str) -> ExitCode {
    eprintln!("{note}\nusage: route-probe <log1.jsonl> [<log2.jsonl>] --target <url-substring> [--input name=value]... [--browser <agent-browser>] [--browser-step <n>]...");
    ExitCode::FAILURE
}

fn fail(note: &str) -> ExitCode {
    eprintln!("{note}");
    ExitCode::FAILURE
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// A site on 127.0.0.1 answering every request `200` with `body`; the head of each request it saw is kept.
    fn site(body: &'static str) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let kept = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                kept.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).replace("\r\n", " | "));
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("route-probe-unit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn runner(browser: Option<String>, jar: &[(&str, &str)]) -> Runner {
        Runner {
            http: HttpFetch::new().expect("the plain client builds"),
            jar: jar.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            browser,
            browser_exchanges: HashSet::new(),
            seeded: None,
            session: "route-probe-unit".into(),
        }
    }

    fn request(url: &str, exchange: usize) -> Request {
        Request { method: "GET".into(), url: url.parse().unwrap(), exchange, headers: vec![("x-token".into(), "t-1".into())], body: None }
    }

    /// The cookie jar of `agent-browser cookies get` is read as the CLI says it (an object holding `cookies`, or the
    /// list itself) or as plain `name=value` lines; an entry without both a name and a value is not a cookie.
    #[test]
    fn a_cookie_jar_is_read_from_the_clis_json_or_from_plain_lines() {
        let object = parse_cookie_jar(r#"{"cookies":[{"name":"sid","value":"a1"},{"name":"theme","value":"dark"},{"name":"lonely"}]}"#);
        assert_eq!(object, HashMap::from([("sid".to_string(), "a1".to_string()), ("theme".to_string(), "dark".to_string())]));
        let list = parse_cookie_jar(r#"[{"name":"sid","value":"b2"}]"#);
        assert_eq!(list, HashMap::from([("sid".to_string(), "b2".to_string())]));
        let lines = parse_cookie_jar("sid = c3\nnot a cookie\ntheme=light=1\n");
        assert_eq!(lines, HashMap::from([("sid".to_string(), "c3".to_string()), ("theme".to_string(), "light=1".to_string())]));
        // JSON that is not a list of cookies falls back to lines, which hold none.
        assert!(parse_cookie_jar(r#"{"cookies":"none"}"#).is_empty());
        assert!(parse_cookie_jar("").is_empty());
    }

    /// The first capture's inputs are what the probe asks with, each name once (the first value typed).
    #[test]
    fn the_inputs_of_a_capture_are_each_name_once_in_the_order_they_were_typed() {
        let log = [
            serde_json::json!({"type": "action", "t": 0.1, "action": "fill", "selector": "#q", "field": "q", "value": "lamp"}),
            serde_json::json!({"type": "action", "t": 0.2, "action": "fill", "selector": "#zip", "field": "zip", "value": "0123"}),
            serde_json::json!({"type": "action", "t": 0.3, "action": "fill", "selector": "#q", "field": "q", "value": "sofa"}),
        ];
        let text: String = log.iter().map(|l| format!("{l}\n")).collect();
        let session = Session::from_log(&text).expect("the log reads");
        let names: Vec<(String, String)> = recorded_inputs(&session).map(|i| (i.name, i.value)).collect();
        assert_eq!(names.len(), session.trace.inputs.iter().map(|i| i.name.clone()).collect::<HashSet<_>>().len(), "{names:?}");
        let q = names.iter().filter(|(n, _)| n == "q").count();
        assert!(q <= 1, "a name is given once: {names:?}");
    }

    /// A session the capture's own browser made (a cookie the call sends that no response set) is what the probe
    /// replays with until a live mint outranks it.
    #[test]
    fn a_cookie_the_browser_made_is_taken_from_the_capture_as_the_session() {
        let entry = |t: f64, url: &str, cookie: &str, text: &str| {
            serde_json::json!({"type": "exchange", "t": t, "resourceType": "Fetch", "entry": {
                "request": {"method": "GET", "url": url, "headers": [{"name": "cookie", "value": cookie}]},
                "response": {"status": 200, "headers": [], "content": {"mimeType": "application/json", "text": text}}}})
        };
        let walk = |word: &str, sid: &str| -> String {
            let lines = [
                serde_json::json!({"type": "action", "t": 0.5, "action": "fill", "selector": "#q", "field": "q", "value": word}),
                entry(1.0, &format!("https://shop.example/api/search?q={word}"), &format!("sid={sid}; theme=dark"), &format!(r#"{{"found":"{word} number one"}}"#)),
            ];
            lines.iter().map(|l| format!("{l}\n")).collect()
        };
        let sessions = [Session::from_log(&walk("lamp", "b9f8e7d6c5a4-1")).unwrap(), Session::from_log(&walk("sofa", "c1d2e3f4a5b6-2")).unwrap()];
        let traces: Vec<Trace> = sessions.iter().map(|s| s.trace.clone()).collect();
        let g = graph::build(&traces, |ex| ex.url.path() == "/api/search").expect("the graph builds");
        let jar = recorded_minted(&g, &sessions[0]);
        assert_eq!(jar.get("sid").map(String::as_str), Some("b9f8e7d6c5a4-1"), "a cookie nothing set is the browser's, as the first capture had it: {jar:?}");
        // A graph that has no minted field takes nothing.
        let plain = Session::from_log(&format!("{}\n", serde_json::json!({"type": "exchange", "t": 1.0, "resourceType": "Fetch", "entry": {
            "request": {"method": "GET", "url": "https://shop.example/api/plain", "headers": []},
            "response": {"status": 200, "headers": [], "content": {"mimeType": "application/json", "text": "{}"}}}}))).unwrap();
        let g = graph::build(std::slice::from_ref(&plain.trace), |ex| ex.url.path() == "/api/plain").expect("the graph builds");
        assert!(recorded_minted(&g, &plain).is_empty());
    }

    /// The minted session is saved where the jar was named, one file per host, and read back whole; with no jar
    /// named nothing is written.
    #[test]
    fn a_minted_session_is_saved_whole_beside_the_jar_that_was_named() {
        let dir = scratch("save");
        let file = dir.join("deep").join("shop.example.json");
        let jar = HashMap::from([("sid".to_string(), "s-1".to_string())]);
        save_jar(None, &jar);
        assert!(!dir.join("deep").exists(), "no jar named, nothing written");
        save_jar(Some(&file), &jar);
        let back: HashMap<String, String> = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back, jar);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A plain step goes over HTTP with the headers it carries; a step whose answer the browser already cached is
    /// answered from it and never sent; a session value is the jar's.
    #[test]
    fn a_plain_step_is_sent_and_a_step_the_browser_answered_is_not() {
        let (base, seen) = site(r#"{"token":"t-9"}"#);
        let mut probe = runner(None, &[("sid", "jar-1")]);
        let got = probe.fetch(&request(&format!("{base}/api/token"), 1)).expect("the site answers");
        assert_eq!((got.status, got.response_body.as_deref()), (200, Some(r#"{"token":"t-9"}"#)));
        let head = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(head.contains("get /api/token") && head.contains("x-token: t-1"), "{head}");
        // A body that is text is shown as its start, a file's bytes by length; both are still sent.
        let mut post = request(&format!("{base}/api/token"), 2);
        post.method = "POST".into();
        post.body = Some(b"q=lamp".to_vec());
        probe.fetch(&post).expect("a text body is sent");
        post.body = Some(vec![0xff, 0xfe, 0x00]);
        probe.fetch(&post).expect("a file's bytes are sent");
        assert!(seen.lock().unwrap()[2].contains("content-length: 3") || seen.lock().unwrap()[2].to_ascii_lowercase().contains("content-length: 3"), "{:?}", seen.lock().unwrap());
        assert_eq!((probe.minted("sid").as_deref(), probe.minted("other")), (Some("jar-1"), None));
        // The browser's cached answer for the root step.
        let mut cached = got.clone();
        cached.response_body = Some("from the browser".into());
        probe.seeded = Some((1, cached));
        let before = seen.lock().unwrap().len();
        let again = probe.fetch(&request(&format!("{base}/api/token"), 1)).unwrap();
        assert_eq!(again.response_body.as_deref(), Some("from the browser"));
        assert_eq!(seen.lock().unwrap().len(), before, "a cached step sends nothing");
        let other = probe.fetch(&request(&format!("{base}/api/other"), 2)).unwrap();
        assert_eq!(other.response_body.as_deref(), Some(r#"{"token":"t-9"}"#), "another step is still the site's");
        assert_eq!(probe.fetch_unredirected(&request(&format!("{base}/api/token"), 3)).unwrap().status, 200);
        // No browser to reseed with: the root is left as it was.
        let mut none = runner(None, &[]);
        none.reseed(&request(&format!("{base}/api/token"), 1)).expect("nothing to reseed");
        assert!(none.seeded.is_none());
    }

    /// A shell script that stands for the agent-browser: it appends `capture` to the session's capture file on
    /// `open`, and says `lands` for `get url`.
    fn browser(dir: &std::path::Path, capture: &str, lands: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("agent-browser.sh");
        let script = format!(
            "#!/bin/sh\nsess=$2\ncmd=$3\ncase \"$cmd\" in\n  open) mkdir -p \"$UNBROWSE_CAPTURE_DIR\"; printf '%s\\n' '{capture}' >> \"$UNBROWSE_CAPTURE_DIR/$sess.jsonl\"; echo 'opened' >&2 ;;\n  get) [ \"$4\" = url ] && echo '{lands}' ;;\nesac\nexit 0\n"
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// The browser's own capture is the raw response of the step it opened: found by the exact address first, with
    /// the cookies it set taken as the session; kept as the answer for the retry after a reseed. A page the browser
    /// never recorded, and a site that keeps challenging it, are failures said as such.
    #[test]
    fn a_step_the_browser_opened_is_answered_from_its_own_capture_or_fails_saying_why() {
        // These runs share the probe's capture folder in the temp dir.
        static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let dir = scratch("browser");
        let url = "https://shop.example/api/token?chal_t=7";
        let line = |u: &str, cookie: &str| {
            serde_json::json!({"type": "exchange", "t": 1.0, "entry": {
                "request": {"method": "GET", "url": u, "headers": []},
                "response": {"status": 200, "headers": [{"name": "set-cookie", "value": cookie}], "content": {"mimeType": "application/json", "text": r#"{"token":"t-live"}"#}}}})
            .to_string()
        };
        // The exact address is preferred over another with the same path.
        // Lines of the capture that are no exchange, or no line at all, are passed over.
        let noise = r#"{"type":"action","t":0.1,"action":"navigate"}"#;
        let both = format!("{noise}\nnot json at all\n{}\n{}", line("https://shop.example/api/token?chal_t=1", "sid=stale"), line(url, "sid=fresh; Path=/"));
        let mut probe = runner(Some(browser(&dir, &both, "https://shop.example/landed")), &[]);
        probe.reseed(&request(url, 1)).expect("the browser answers");
        let (at, ex) = probe.seeded.clone().expect("the root's answer is kept");
        assert_eq!((at, ex.response_body.as_deref()), (1, Some(r#"{"token":"t-live"}"#)));
        assert_eq!(probe.minted("sid").as_deref(), Some("fresh"), "the cookie the browser was given is the session's");
        // A step marked for the browser is the browser's, once; the answer is cached for the retry.
        probe.browser_exchanges.insert(1);
        probe.seeded = None;
        let got = probe.fetch(&request(url, 1)).expect("a step for the browser");
        assert_eq!(got.response_body.as_deref(), Some(r#"{"token":"t-live"}"#));
        assert!(probe.seeded.is_some());
        // Same path, another query: the browser normalised the address, so the first with the address is the answer.
        let mut normal = runner(Some(browser(&dir, &line("https://shop.example/api/token", "sid=norm"), "https://shop.example/landed")), &[]);
        normal.reseed(&request("https://shop.example/api/token?chal_t=99", 1)).expect("the same address answers");
        assert_eq!(normal.minted("sid").as_deref(), Some("norm"));
        // Loaded, but nothing was recorded for the address.
        let mut empty = runner(Some(browser(&dir, &line("https://elsewhere.example/other", "x=1"), "https://shop.example/landed")), &[]);
        let err = empty.reseed(&request(url, 1)).expect_err("nothing recorded");
        assert!(matches!(&err, ReplayError::Failed { status: 0, body, .. } if body.contains("raw response for it was not captured")), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A site that keeps answering the browser with a challenge page is a failure that says so, after the browser
    /// has been tried again (the probe does not loop on it).
    #[test]
    fn a_browser_that_keeps_landing_on_a_challenge_is_a_failure_that_says_so() {
        static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let dir = scratch("challenge");
        let mut probe = runner(Some(browser(&dir, "{}", "https://shop.example/captcha?x=1")), &[]);
        let err = probe.reseed(&request("https://shop.example/api/token", 1)).expect_err("the site never lets the browser through");
        assert!(matches!(&err, ReplayError::Failed { status: 403, body, .. } if body.contains("kept challenging")), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
