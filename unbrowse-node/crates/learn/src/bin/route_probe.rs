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
    let target_ex = &traces[0].exchanges[target_idx];
    let is_target = |ex: &Exchange| std::ptr::eq(ex, target_ex);
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
