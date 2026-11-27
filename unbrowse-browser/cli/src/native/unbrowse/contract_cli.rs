//! Unbrowse fork: the node's contract with this browser, run the way the node runs it (UNB-208).
//!
//! The Unbrowse node spawns the built `agent-browser` with its own flags and environment and reads plain stdout back
//! (`unbrowse-node/app/src/browse.rs`, `crates/learn/src/mint.rs`), and it writes JSON lines straight to the daemon's
//! socket for its own questions (`browse.rs` `send_at`). Each test here does one of those things exactly as the node
//! does and checks the part of the answer the node reads. An upstream release that renames a flag, an action, a field
//! or an error the node matches on fails one of them before a node built on it ships. What the node sends and reads,
//! with file and line, is in the programme notes (tranche2b/node-cli-contract.md, 22 Nov 2026).
//!
//! The tests drive a real browser, so they are `#[ignore]`d like upstream's e2e tests and run one at a time in CI's
//! ignored pass: `cargo test --test unbrowse_contract_cli -- --ignored --test-threads=1`. Two differences from the
//! node, both the test box's: `AGENT_BROWSER_EXECUTABLE_PATH` and `AGENT_BROWSER_NO_SANDBOX` are passed through when
//! the box sets them (the node sets the first to its own Chromium; CI's runner needs the second).
#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_agent-browser");

/// The node's switches (`browse.rs` `cli`): one `--args` value, comma-joined.
const SWITCHES: &str = "--disable-blink-features=AutomationControlled";

/// Tab labels of the node's form (`browse.rs` `tab_of`: `u` and 16 hex digits; `t<N>` is the CLI's own tab ids).
const TAB1: &str = "u0a1b2c3d4e5f6071";
const TAB2: &str = "u8899aabbccddeeff";

const PAGE: &str = r#"<!doctype html><html><head><title>Contract page</title></head><body>
<form id="login" action="/signed-in" method="post">
  <input id="user" name="username" autocomplete="username">
  <input id="pw" name="password" type="password" autocomplete="current-password">
</form>
<button id="human" onclick="document.getElementById('out').textContent='clicked'">Verify you are human</button>
<p id="out">waiting</p><p id="api">pending</p>
<script>fetch('/api/data').then(r => r.json()).then(j => { document.getElementById('api').textContent = j.ok ? 'ok' : 'no'; });</script>
</body></html>"#;

struct Site {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Site {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let thread = thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let mut request = [0u8; 8192];
                        let read = stream.read(&mut request).unwrap_or(0);
                        let request = String::from_utf8_lossy(&request[..read]);
                        let path = request.split_whitespace().nth(1).unwrap_or("/");
                        let (kind, extra, body) = match path {
                            "/" => ("text/html", "Set-Cookie: sid=abc123; Path=/; HttpOnly\r\n", PAGE.to_string()),
                            "/two" => ("text/html", "", "<!doctype html><title>Second page</title><p>two</p>".to_string()),
                            "/api/data" => ("application/json", "", r#"{"ok":true,"items":[1,2]}"#.to_string()),
                            _ => ("text/plain", "", "not found".to_string()),
                        };
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                    Err(_) => break,
                }
            }
        });
        Self { port, stop, thread: Some(thread) }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }
}

impl Drop for Site {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// What a spawn said, as the node keeps it (`browse.rs` `Said`).
struct Said {
    ok: bool,
    out: String,
    err: String,
}

impl Said {
    fn both(&self) -> String {
        format!("{}\n{}", self.out, self.err)
    }
}

/// A node's home for one site: the config file, the socket, capture and runtime folders, and a profile.
struct Node {
    home: TempDir,
    session: String,
}

impl Node {
    fn new(session: &str) -> Self {
        let home = TempDir::new().unwrap();
        for dir in ["browser", "browse", "browser-runtime", "profiles/site"] {
            std::fs::create_dir_all(home.path().join(dir)).unwrap();
        }
        // The node writes exactly this (`mint.rs` `on_its_own`).
        std::fs::write(home.path().join("browser-config.json"), "{}").unwrap();
        Self { home, session: session.to_string() }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.home.path().join(rel)
    }

    /// `<program> --config <home>/browser-config.json --session <s>` and the node's environment.
    fn bare(&self, tab: Option<&str>) -> Command {
        let mut cmd = Command::new(BIN);
        for (key, _) in std::env::vars() {
            if key.starts_with("AGENT_BROWSER_") {
                cmd.env_remove(key);
            }
        }
        cmd.env_remove("XDG_RUNTIME_DIR")
            .env("AGENT_BROWSER_IDLE_TIMEOUT_MS", "1800000")
            .env("AGENT_BROWSER_OWNER_PID", std::process::id().to_string())
            .env("AGENT_BROWSER_RUNTIME_DIR", self.path("browser-runtime"))
            .env("UNBROWSE_CAPTURE_DIR", self.path("browse"))
            .env("AGENT_BROWSER_SOCKET_DIR", self.path("browser"))
            .env("NO_COLOR", "1")
            .current_dir(self.home.path());
        for key in ["AGENT_BROWSER_EXECUTABLE_PATH", "AGENT_BROWSER_NO_SANDBOX"] {
            if let Ok(value) = std::env::var(key) {
                cmd.env(key, value);
            }
        }
        match tab {
            Some(tab) => cmd.env("AGENT_BROWSER_TAB", tab),
            None => cmd.env_remove("AGENT_BROWSER_TAB"),
        };
        cmd.arg("--config").arg(self.path("browser-config.json")).arg("--session").arg(&self.session);
        cmd
    }

    /// The full prefix the node puts before an agent's verb (`browse.rs` `cli`).
    fn command(&self, tab: Option<&str>) -> Command {
        let mut cmd = self.bare(tab);
        cmd.arg("--profile").arg(self.path("profiles/site")).arg("--args").arg(SWITCHES);
        cmd
    }

    fn said(mut cmd: Command, args: &[&str]) -> Said {
        let output = cmd.args(args).output().expect("agent-browser runs");
        Said {
            ok: output.status.success(),
            out: String::from_utf8_lossy(&output.stdout).to_string(),
            err: String::from_utf8_lossy(&output.stderr).to_string(),
        }
    }

    fn run(&self, tab: Option<&str>, args: &[&str]) -> Said {
        Self::said(self.command(tab), args)
    }

    /// A command that must answer, its stdout trimmed.
    fn answer(&self, tab: Option<&str>, args: &[&str]) -> String {
        let said = self.run(tab, args);
        assert!(said.ok, "{args:?} failed\nstdout:\n{}\nstderr:\n{}", said.out, said.err);
        said.out.trim().to_string()
    }

    /// One JSON line to the daemon's socket, as `browse.rs` `send_at` writes it (`noLaunch: true` on every one).
    fn ask(&self, mut cmd: Value) -> Value {
        cmd["noLaunch"] = json!(true);
        let door = self.path(&format!("browser/{}.sock", self.session));
        let mut stream = UnixStream::connect(&door).unwrap_or_else(|e| panic!("the daemon's socket {door:?}: {e}"));
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        stream.write_all(format!("{cmd}\n").as_bytes()).unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap_or_else(|e| panic!("the socket answered {line:?}: {e}"))
    }

    fn open(&self, tab: Option<&str>, url: &str) {
        self.answer(tab, &["open", url]);
    }

    /// Until the page's own call has answered (it writes `ok` into `#api`).
    fn wait_for_the_pages_call(&self, tab: Option<&str>) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while self.answer(tab, &["get", "text", "#api"]) != "ok" {
            assert!(Instant::now() < deadline, "the page's call to /api/data never answered");
            thread::sleep(Duration::from_millis(200));
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        let _ = self.bare(None).arg("close").output();
    }
}

/// `get url` as the node reads it: trimmed, quotes taken off, a URL with a scheme and a host.
fn read_url(out: &str) -> url::Url {
    let url = url::Url::parse(out.trim().trim_matches('"')).unwrap_or_else(|e| panic!("get url said {out:?}: {e}"));
    assert!(url.host_str().is_some(), "get url said {out:?}");
    url
}

/// `--json` output as the node reads it: from the first `{` to the last `}` (a launch line may come first).
fn read_json(out: &str) -> Value {
    let (start, end) = (out.find('{').expect("a JSON answer"), out.rfind('}').expect("a JSON answer"));
    serde_json::from_str(&out[start..=end]).unwrap_or_else(|e| panic!("not JSON: {e}\n{out}"))
}

#[test]
fn the_version_question_answers_with_exit_zero_and_starts_no_browser() {
    let node = Node::new("contract-version");
    // `browsers.rs` `runs`: `<program> --version`, nothing else; only the exit status is read.
    let said = Node::said(Command::new(BIN), &["--version"]);
    assert!(said.ok, "--version failed: {}", said.both());
    assert!(!said.out.trim().is_empty());
    assert!(!node.path(&format!("browser/{}.sock", node.session)).exists());
}

#[test]
#[ignore]
fn a_page_opened_as_the_node_opens_it_answers_url_title_and_count_in_plain_text() {
    let site = Site::start();
    let node = Node::new("contract-plain");
    node.open(Some(TAB1), &site.url("/"));
    assert_eq!(read_url(&node.answer(Some(TAB1), &["get", "url"])).as_str(), site.url("/"));
    assert_eq!(node.answer(Some(TAB1), &["get", "title"]), "Contract page");
    let count: u64 = node.answer(Some(TAB1), &["get", "count", "input[type=password]"]).parse().expect("get count is a number");
    assert_eq!(count, 1);
}

#[test]
#[ignore]
fn a_snapshot_gives_each_control_a_ref_the_node_clicks_it_by() {
    let site = Site::start();
    let node = Node::new("contract-refs");
    node.open(Some(TAB1), &site.url("/"));
    let snapshot = node.answer(Some(TAB1), &["snapshot", "-i"]);
    // `mint.rs` reads the line naming the check and the `[ref=eN]` on it, then clicks `@eN`.
    let line = snapshot.lines().find(|l| l.contains("Verify you are human")).unwrap_or_else(|| panic!("no line for the button:\n{snapshot}"));
    let at = line.find("[ref=e").unwrap_or_else(|| panic!("no [ref=eN] on {line:?}")) + "[ref=".len();
    let reference: String = line[at..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    node.answer(Some(TAB1), &["click", &format!("@{reference}")]);
    assert_eq!(node.answer(Some(TAB1), &["get", "text", "#out"]), "clicked");
}

#[test]
#[ignore]
fn a_ref_the_page_no_longer_has_is_answered_as_an_unknown_ref() {
    let site = Site::start();
    let node = Node::new("contract-stale");
    node.open(Some(TAB1), &site.url("/"));
    node.answer(Some(TAB1), &["snapshot", "-i"]);
    let said = node.run(Some(TAB1), &["click", "@e999"]);
    // `browse.rs` re-reads the page when an answer says `Unknown ref: ` (or `is covered by <`).
    assert!(!said.ok, "a click on a ref the page doesn't have succeeded: {}", said.both());
    assert!(said.both().contains("Unknown ref: "), "said: {}", said.both());
}

#[test]
#[ignore]
fn an_eval_given_the_nodes_timeout_answers_the_pages_html() {
    let site = Site::start();
    let node = Node::new("contract-eval");
    node.open(Some(TAB1), &site.url("/"));
    // `browse.rs` moves `--timeout <ms>` right after `eval` (30000 when the agent gave none); `mint.rs` reads the
    // answer as a JSON string, else as it is.
    let out = node.answer(Some(TAB1), &["eval", "--timeout", "30000", "document.documentElement.outerHTML"]);
    let html = serde_json::from_str::<String>(&out).unwrap_or(out);
    assert!(html.contains("<title>Contract page</title>"), "eval said: {html}");
}

#[test]
#[ignore]
fn cookies_read_as_json_carry_name_value_domain_path_and_flags() {
    let site = Site::start();
    let node = Node::new("contract-cookies");
    node.open(Some(TAB1), &site.url("/"));
    // `browse.rs` asks without a tab; `mint.rs` `browser_cookie_list` reads `data.cookies` (else `cookies`).
    let said = node.answer(None, &["--json", "cookies", "get"]);
    let answer = read_json(&said);
    let cookies = answer["data"]["cookies"].as_array().or(answer["cookies"].as_array()).unwrap_or_else(|| panic!("no cookie list: {answer}"));
    let sid = cookies.iter().find(|c| c["name"] == "sid").unwrap_or_else(|| panic!("no sid cookie: {answer}"));
    assert_eq!(sid["value"], "abc123");
    assert!(sid["domain"].as_str().is_some_and(|d| d.contains("127.0.0.1")), "{sid}");
    assert_eq!(sid["path"], "/");
    assert_eq!(sid["httpOnly"], true);
    assert!(sid["expires"].is_number(), "{sid}");
}

#[test]
#[ignore]
fn the_pages_calls_are_listed_with_what_the_node_learns_from_and_a_body_by_its_id() {
    let site = Site::start();
    let node = Node::new("contract-network");
    node.open(None, &site.url("/"));
    node.wait_for_the_pages_call(None);
    let answer = read_json(&node.answer(None, &["--json", "network", "requests"]));
    let requests = answer["data"]["requests"].as_array().unwrap_or_else(|| panic!("no data.requests: {answer}"));
    let call = requests.iter().find(|r| r["url"].as_str().is_some_and(|u| u.ends_with("/api/data"))).unwrap_or_else(|| panic!("no /api/data: {answer}"));
    assert_eq!(call["method"], "GET");
    assert!(call["headers"].is_object(), "{call}");
    assert_eq!(call["status"].as_i64(), Some(200), "{call}");
    assert!(call["mimeType"].as_str().is_some_and(|m| m.contains("json")), "{call}");
    let id = call["requestId"].as_str().unwrap_or_else(|| panic!("no requestId: {call}"));
    let body = read_json(&node.answer(None, &["--json", "network", "request", id]));
    assert!(body["data"]["responseBody"].as_str().is_some_and(|b| b.contains(r#""ok":true"#)), "{body}");
    node.answer(None, &["network", "requests", "--clear"]);
}

#[test]
#[ignore]
fn the_nodes_socket_questions_answer_with_the_fields_it_reads() {
    let site = Site::start();
    let node = Node::new("contract-socket");
    node.open(Some(TAB1), &site.url("/"));
    let tabs = node.ask(json!({ "id": "tabs-1", "action": "tab_list" }));
    assert_eq!(tabs["success"], true, "{tabs}");
    let mine = tabs["data"]["tabs"].as_array().and_then(|t| t.iter().find(|t| t["label"] == TAB1)).unwrap_or_else(|| panic!("no tab labelled {TAB1}: {tabs}"));
    assert!(mine["targetId"].as_str().is_some_and(|t| !t.is_empty()), "{mine}");
    assert_eq!(mine["url"], site.url("/"));
    // Upstream 0.43.0 lists a tab's title as Chrome first named it (`127.0.0.1:<port>/`), not the page's `<title>`,
    // even after `get title` (22 Nov 2026, the same in upstream's own binary). The node shows it as it comes.
    assert!(mine["title"].is_string(), "{mine}");
    let cdp = node.ask(json!({ "id": "cdp-1", "action": "cdp_url" }));
    assert!(cdp["data"]["cdpUrl"].as_str().is_some_and(|u| u.starts_with("ws")), "{cdp}");
    let document = node.ask(json!({ "id": "document-1", "action": "document", "tab": TAB1 }));
    assert!(document["data"]["document"].as_str().is_some_and(|d| !d.is_empty()), "{document}");
    let forget = node.ask(json!({ "id": "forget-1", "action": "capture_forget", "value": "hunter2-secret" }));
    assert_eq!(forget["success"], true, "{forget}");
}

#[test]
#[ignore]
fn the_nodes_socket_questions_never_launch_a_browser() {
    let node = Node::new("contract-nolaunch");
    // A daemon with no browser: the node's own questions find it this way between an agent's commands.
    let said = node.run(None, &["--json", "get", "cdp-url"]);
    assert!(!said.ok, "get cdp-url with no browser succeeded: {}", said.both());
    for action in ["cdp_url", "tab_list", "document"] {
        let answer = node.ask(json!({ "id": format!("{action}-1"), "action": action, "tab": TAB1 }));
        // `browse.rs` `NOT_LAUNCHED`: this browser is skipped, not failed.
        assert_eq!(answer["error"], "Browser not launched", "{action}: {answer}");
    }
    let tabs = node.ask(json!({ "id": "tabs-2", "action": "tab_list" }));
    assert_eq!(tabs["success"], false, "a socket question launched a browser: {tabs}");
}

#[test]
#[ignore]
fn a_vault_password_goes_only_into_a_checked_field_of_its_site() {
    let site = Site::start();
    let node = Node::new("contract-vault");
    node.open(Some(TAB1), &site.url("/"));
    let fill = |site_name: &str| {
        node.ask(json!({
            "id": "vault-1", "action": "fill", "selector": "#pw", "value": "s3cret-pass", "as": "login-1",
            "site": site_name, "field": "password", "tab": TAB1,
        }))
    };
    let elsewhere = fill("example.com");
    assert_eq!(elsewhere["success"], false, "a password went into another site's field: {elsewhere}");
    assert!(elsewhere["error"].as_str().is_some_and(|e| e.contains("nothing was filled")), "{elsewhere}");
    let filled = fill("127.0.0.1");
    assert_eq!(filled["success"], true, "{filled}");
    // `browse.rs` refuses a fill that doesn't say it checked the field ("update the browser").
    assert_eq!(filled["data"]["field_checked"], true, "{filled}");
}

#[test]
#[ignore]
fn a_command_naming_its_tab_runs_in_that_tab() {
    let site = Site::start();
    let node = Node::new("contract-tabs");
    node.open(Some(TAB1), &site.url("/"));
    node.open(Some(TAB2), &site.url("/two"));
    assert_eq!(read_url(&node.answer(Some(TAB1), &["get", "url"])).as_str(), site.url("/"));
    assert_eq!(read_url(&node.answer(Some(TAB2), &["get", "url"])).as_str(), site.url("/two"));
    assert_eq!(node.answer(Some(TAB2), &["get", "title"]), "Second page");
    // `browse.rs` closes one agent's tab alone with `tab close <tab>`, no tab named in the environment.
    node.answer(None, &["tab", "close", TAB2]);
    let tabs = node.ask(json!({ "id": "tabs-3", "action": "tab_list" }));
    let labels: Vec<&str> = tabs["data"]["tabs"].as_array().unwrap().iter().filter_map(|t| t["label"].as_str()).collect();
    assert!(labels.contains(&TAB1) && !labels.contains(&TAB2), "{tabs}");
}

#[test]
#[ignore]
fn the_capture_log_holds_the_pages_calls_for_the_node_to_learn_from() {
    let site = Site::start();
    let node = Node::new("contract-capture");
    node.open(Some(TAB1), &site.url("/"));
    node.wait_for_the_pages_call(Some(TAB1));
    // A walk ends with `close` (`mint.rs`), and closing writes every answered call (`capture::close`).
    let said = Node::said(node.bare(None), &["close"]);
    assert!(said.ok, "close failed: {}", said.both());
    // `UNBROWSE_CAPTURE_DIR/<session>.jsonl`, one JSON object a line, in the node's own format (`CaptureLog`).
    let log = std::fs::read_to_string(node.path(&format!("browse/{}.jsonl", node.session))).expect("the session's capture log");
    let lines: Vec<Value> = log.lines().map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l}"))).collect();
    assert!(lines.iter().any(|l| l.to_string().contains("/api/data")), "the page's call isn't in the log:\n{log}");
    assert!(lines.iter().any(|l| l.to_string().contains("sid=abc123")), "the Set-Cookie the page got isn't in the log:\n{log}");
}

#[test]
#[ignore]
fn closing_a_session_by_its_name_alone_ends_its_daemon() {
    let site = Site::start();
    let node = Node::new("contract-close");
    node.open(None, &site.url("/"));
    let pid = node.path(&format!("browser/{}.pid", node.session));
    assert!(pid.exists(), "no pid file at {pid:?}");
    // `mint.rs` `close_program_sessions`: `--config … --session <s> close`, no profile or switches; exit status only.
    let said = Node::said(node.bare(None), &["close"]);
    assert!(said.ok, "close failed: {}", said.both());
    let deadline = Instant::now() + Duration::from_secs(10);
    while node.path(&format!("browser/{}.sock", node.session)).exists() {
        assert!(Instant::now() < deadline, "the daemon's socket outlived close");
        thread::sleep(Duration::from_millis(100));
    }
}
