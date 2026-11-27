//! Upstream agent-browser's own command surface, held through the built binary.
//!
//! The node drives only a few of agent-browser's commands (`contract_cli.rs`), but the rest ships in the same
//! binary and changes with every upstream release. These tests run the binary against a stand-in daemon on the
//! session's socket (no browser), so each one holds what a command line or an MCP tool call sends the daemon,
//! and what the CLI answers from a scripted reply. An upgrade that changes a command's wire form, drops an MCP
//! tool's argument, or breaks the MCP/CLI parity upstream promises fails here first.
#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;

mod chat_cli;
mod dashboard_cli;
mod doctor_cli;
mod features_cli;
mod help_pages;
mod printed;

const SESSION: &str = "surface";

type Reply = dyn Fn(&Value) -> Value + Send + Sync;

/// A daemon that records every command it is sent and answers each with `reply`.
struct Daemon {
    root: TempDir,
    seen: Arc<Mutex<Vec<Value>>>,
    reply: Arc<Mutex<Box<Reply>>>,
}

impl Daemon {
    fn start() -> Self {
        let root = tempfile::tempdir().unwrap();
        let sockets = root.path().join("s");
        std::fs::create_dir_all(&sockets).unwrap();
        std::fs::create_dir_all(root.path().join("work")).unwrap();
        std::fs::write(
            sockets.join(format!("{SESSION}.version")),
            env!("CARGO_PKG_VERSION"),
        )
        .unwrap();
        std::fs::write(sockets.join(format!("{SESSION}.config")), r#"{"debug":false}"#).unwrap();
        // A live pid, so the CLI's daemon inventory counts this session as running (and keeps its socket).
        std::fs::write(sockets.join(format!("{SESSION}.pid")), std::process::id().to_string()).unwrap();
        let listener = UnixListener::bind(sockets.join(format!("{SESSION}.sock"))).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let reply: Arc<Mutex<Box<Reply>>> =
            Arc::new(Mutex::new(Box::new(|_: &Value| json!({"success": true, "data": {}}))));
        let (seen2, reply2) = (Arc::clone(&seen), Arc::clone(&reply));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                if stream.set_read_timeout(Some(Duration::from_secs(5))).is_err() {
                    continue;
                }
                let mut line = String::new();
                if BufReader::new(&stream).read_line(&mut line).is_err() || line.trim().is_empty() {
                    continue; // a liveness probe
                }
                let request: Value = serde_json::from_str(&line).unwrap();
                let answer = (reply2.lock().unwrap())(&request);
                seen2.lock().unwrap().push(request);
                let _ = writeln!(stream, "{answer}");
            }
        });
        Self { root, seen, reply }
    }

    fn home(&self) -> &Path {
        self.root.path()
    }

    fn answer_with(&self, reply: impl Fn(&Value) -> Value + Send + Sync + 'static) {
        *self.reply.lock().unwrap() = Box::new(reply);
    }

    fn command(&self) -> Command {
        let root = self.root.path();
        let mut command = Command::new(env!("CARGO_BIN_EXE_agent-browser"));
        command
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", root)
            .env("USERPROFILE", root)
            .env("TMPDIR", root)
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_CACHE_HOME", root.join("cache"))
            .env("XDG_DATA_HOME", root.join("data"))
            .env("AGENT_BROWSER_SOCKET_DIR", root.join("s"))
            .env("AGENT_BROWSER_SESSION", SESSION)
            .env("NO_COLOR", "1")
            .current_dir(root.join("work"));
        // A coverage run names each process's profile file through this; keep it.
        if let Some(profile) = std::env::var_os("LLVM_PROFILE_FILE") {
            command.env("LLVM_PROFILE_FILE", profile);
        }
        command
    }

    fn run(&self, args: &[&str], stdin: &str) -> Output {
        let mut child = self
            .command()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // Most commands never read stdin, and one that exits first closes the pipe: that is the command's
        // answer, not a failure to feed it.
        let mut input = child.stdin.take().unwrap();
        if let Err(e) = input.write_all(stdin.as_bytes()) {
            assert_eq!(e.kind(), std::io::ErrorKind::BrokenPipe, "writing stdin: {e}");
        }
        drop(input);
        child.wait_with_output().unwrap()
    }

    /// The commands the daemon got while `args` ran, without their random ids, and the run's output.
    fn sent(&self, args: &[&str], stdin: &str) -> (Vec<Value>, Output) {
        self.seen.lock().unwrap().clear();
        let output = self.run(args, stdin);
        let sent = self.seen.lock().unwrap().drain(..).map(without_id).collect();
        (sent, output)
    }

    /// `agent-browser mcp call <tool> <arguments>`: what the daemon got, and the tool result printed.
    fn mcp(&self, tool: &str, arguments: &Value) -> (Vec<Value>, Value) {
        let (sent, output) = self.sent(&["mcp", "call", tool, &arguments.to_string()], "");
        let result = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|e| panic!("{tool}: {e}: {output:?}"));
        (sent, result)
    }
}

#[test]
fn a_command_that_exits_before_reading_its_stdin_still_gives_its_answer() {
    let daemon = Daemon::start();
    let unread = "x".repeat(4 << 20);
    let output = daemon.run(&["--version"], &unread);
    assert!(output.status.success(), "{output:?}");
    assert!(!output.stdout.is_empty(), "{output:?}");
}

fn without_id(mut command: Value) -> Value {
    if let Some(object) = command.as_object_mut() {
        object.remove("id");
    }
    command
}

/// Whether `actual` holds every field of `expected` (objects compared field by field, all else equal).
fn holds(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            e.iter().all(|(k, v)| a.get(k).is_some_and(|got| holds(got, v)))
        }
        _ => actual == expected,
    }
}

fn stdout_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|e| panic!("{e}: {output:?}"))
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// One MCP tool call, the command line upstream documents for it, and what the daemon must get from both.
struct Case {
    tool: &'static str,
    arguments: Value,
    cli: Vec<String>,
    stdin: &'static str,
    daemon_gets: Value,
}

fn case(tool: &'static str, arguments: Value, cli: &str, daemon_gets: Value) -> Case {
    Case {
        tool,
        arguments,
        cli: cli.split(' ').map(str::to_string).collect(),
        stdin: "",
        daemon_gets,
    }
}

fn cases(home: &Path) -> Vec<Case> {
    let curl = home.join("cookies.txt");
    std::fs::write(&curl, "curl 'https://a.test/' -H 'Cookie: sid=abc; theme=dark'").unwrap();
    let curl = curl.to_string_lossy().to_string();
    let mut cases = vec![
        case(
            "agent_browser_find",
            json!({"locator": "role", "value": "button", "name": "Save", "exact": true}),
            "find role button click --name Save --exact",
            json!({"action": "getbyrole", "role": "button", "subaction": "click", "name": "Save", "exact": true}),
        ),
        case(
            "agent_browser_find",
            json!({"locator": "nth", "index": 2, "value": ".item", "action": "hover"}),
            "find nth 2 .item hover",
            json!({"action": "nth", "selector": ".item", "index": 2, "subaction": "hover"}),
        ),
        case(
            "agent_browser_find",
            json!({"locator": "label", "value": "Email", "action": "fill", "text": "a@b.test"}),
            "find label Email fill a@b.test",
            json!({"action": "getbylabel", "label": "Email", "subaction": "fill", "value": "a@b.test"}),
        ),
        case(
            "agent_browser_diff_url",
            json!({"url1": "https://a.test/", "url2": "https://b.test/", "screenshot": true, "fullPage": true,
                   "waitUntil": "load", "selector": "main", "compact": true, "depth": 3}),
            "diff url https://a.test/ https://b.test/ --screenshot --full --wait-until load --selector main --compact --depth 3",
            json!({"action": "diff_url", "url1": "https://a.test/", "url2": "https://b.test/", "screenshot": true,
                   "fullPage": true, "waitUntil": "load", "selector": "main", "compact": true, "maxDepth": 3}),
        ),
        case(
            "agent_browser_diff_snapshot",
            json!({"baseline": "base.txt", "selector": "#m", "compact": true, "depth": 2}),
            "diff snapshot --baseline base.txt --selector #m --compact --depth 2",
            json!({"action": "diff_snapshot", "selector": "#m", "compact": true, "maxDepth": 2}),
        ),
        case(
            "agent_browser_diff_screenshot",
            json!({"baseline": "base.png", "output": "out.png", "selector": "#m", "threshold": 0.2, "fullPage": true}),
            "diff screenshot --baseline base.png --output out.png --selector #m --threshold 0.2 --full",
            json!({"action": "diff_screenshot", "output": "out.png", "selector": "#m", "threshold": 0.2, "fullPage": true}),
        ),
        case(
            "agent_browser_cookies_set",
            json!({"name": "sid", "value": "abc", "url": "https://a.test/", "domain": "a.test", "path": "/p",
                   "sameSite": "Lax", "expires": 1700000000, "httpOnly": true, "secure": true}),
            "cookies set sid abc --url https://a.test/ --domain a.test --path /p --same-site Lax --expires 1700000000 --http-only --secure",
            json!({"action": "cookies_set", "cookies": [{"name": "sid", "value": "abc", "url": "https://a.test/",
                   "domain": "a.test", "path": "/p", "sameSite": "Lax", "expires": 1700000000, "httpOnly": true, "secure": true}]}),
        ),
        Case {
            tool: "agent_browser_cookies_set_curl",
            arguments: json!({"file": curl, "domain": "a.test", "url": "https://a.test/x"}),
            cli: vec!["cookies".into(), "set".into(), "--curl".into(), curl.clone(), "--domain".into(),
                      "a.test".into(), "--url".into(), "https://a.test/x".into()],
            stdin: "",
            daemon_gets: json!({"action": "cookies_set", "cookies": [
                {"name": "sid", "value": "abc", "domain": "a.test", "path": "/", "url": "https://a.test/x"},
                {"name": "theme", "value": "dark", "domain": "a.test", "path": "/", "url": "https://a.test/x"}]}),
        },
        Case {
            tool: "agent_browser_auth_save",
            arguments: json!({"name": "acct", "url": "https://a.test/login", "username": "u", "password": "p",
                              "usernameSelector": "#u", "passwordSelector": "#p", "submitSelector": "#s"}),
            cli: "auth save acct --url https://a.test/login --username u --username-selector #u --password-selector #p --submit-selector #s --password-stdin"
                .split(' ').map(str::to_string).collect(),
            stdin: "p\n",
            daemon_gets: json!({"action": "auth_save", "name": "acct", "url": "https://a.test/login", "username": "u",
                                "password": "p", "usernameSelector": "#u", "passwordSelector": "#p", "submitSelector": "#s"}),
        },
        case(
            "agent_browser_auth_login",
            json!({"name": "acct", "noNavigate": true}),
            "auth login acct --no-navigate",
            json!({"action": "auth_login", "name": "acct", "noNavigate": true}),
        ),
        case(
            "agent_browser_network_route",
            json!({"url": "**/api/*", "abort": true, "resourceType": "xhr"}),
            "network route **/api/* --abort --resource-type xhr",
            json!({"action": "route", "url": "**/api/*", "abort": true}),
        ),
        case(
            "agent_browser_network_route",
            json!({"url": "**/data", "body": "{\"ok\":1}", "allowOrigin": "*"}),
            "network route **/data --body {\"ok\":1} --allow-origin *",
            json!({"action": "route", "url": "**/data"}),
        ),
        case(
            "agent_browser_network_requests",
            json!({"clear": true, "filter": "api", "type": "xhr", "method": "POST", "status": "200"}),
            "network requests --clear --filter api --type xhr --method POST --status 200",
            json!({"action": "requests", "clear": true, "filter": "api", "method": "POST", "status": "200"}),
        ),
        case(
            "agent_browser_network_har_start",
            json!({"content": "text"}),
            "network har start --content text",
            json!({"action": "har_start"}),
        ),
        case(
            "agent_browser_storage_set",
            json!({"storageType": "local", "key": "k", "value": "v"}),
            "storage local set k v",
            json!({"action": "storage_set", "type": "local", "key": "k", "value": "v"}),
        ),
        case(
            "agent_browser_storage_get",
            json!({"storageType": "session", "key": "k"}),
            "storage session get k",
            json!({"action": "storage_get", "type": "session", "key": "k"}),
        ),
        case(
            "agent_browser_storage_clear",
            json!({"storageType": "local"}),
            "storage local clear",
            json!({"action": "storage_clear", "type": "local"}),
        ),
        case(
            "agent_browser_set_viewport",
            json!({"width": 800, "height": 600, "scale": 2}),
            "set viewport 800 600 2",
            json!({"action": "viewport", "width": 800, "height": 600, "deviceScaleFactor": 2.0}),
        ),
        case(
            "agent_browser_set_credentials",
            json!({"username": "u", "password": "p"}),
            "set credentials u p",
            json!({"action": "credentials", "username": "u", "password": "p"}),
        ),
        case(
            "agent_browser_set_geo",
            json!({"latitude": 1.5, "longitude": -2.25}),
            "set geo 1.5 -2.25",
            json!({"action": "geolocation", "latitude": 1.5, "longitude": -2.25}),
        ),
        case(
            "agent_browser_set_offline",
            json!({"enabled": false}),
            "set offline off",
            json!({"action": "offline", "offline": false}),
        ),
        case(
            "agent_browser_set_headers",
            json!({"headers": {"X-A": "1"}}),
            "set headers {\"X-A\":\"1\"}",
            json!({"action": "headers", "headers": {"X-A": "1"}}),
        ),
        case(
            "agent_browser_set_media",
            json!({"colorScheme": "dark", "reducedMotion": "reduce"}),
            "set media dark reduced-motion",
            json!({"action": "emulatemedia", "colorScheme": "dark", "reducedMotion": "reduce"}),
        ),
        case(
            "agent_browser_set_device",
            json!({"device": "Pixel"}),
            "set device Pixel",
            json!({"action": "device", "device": "Pixel"}),
        ),
        case(
            "agent_browser_mouse_move",
            json!({"x": 10, "y": 20, "durationMs": 100, "steps": 5, "seed": 7, "human": true}),
            "mouse move 10 20 --duration 100 --steps 5 --seed 7 --human",
            json!({"action": "mousemove", "x": 10.0, "y": 20.0}),
        ),
        case(
            "agent_browser_mouse_down",
            json!({"button": "right"}),
            "mouse down right",
            json!({"action": "mousedown", "button": "right"}),
        ),
        case(
            "agent_browser_mouse_up",
            json!({}),
            "mouse up",
            json!({"action": "mouseup"}),
        ),
        case(
            "agent_browser_mouse_wheel",
            json!({"dy": 100, "dx": 5}),
            "mouse wheel 100 5",
            json!({"action": "wheel", "deltaY": 100.0, "deltaX": 5.0}),
        ),
        case(
            "agent_browser_keyboard_type",
            json!({"text": "hi there"}),
            "keyboard type hi there",
            json!({"action": "keyboard", "subaction": "type", "text": "hi there"}),
        ),
        case(
            "agent_browser_keyboard_insert_text",
            json!({"text": "hi"}),
            "keyboard inserttext hi",
            json!({"action": "keyboard", "subaction": "insertText", "text": "hi"}),
        ),
        case("agent_browser_keydown", json!({"key": "Shift"}), "keydown Shift", json!({"action": "keydown", "key": "Shift"})),
        case("agent_browser_keyup", json!({"key": "Shift"}), "keyup Shift", json!({"action": "keyup", "key": "Shift"})),
        case(
            "agent_browser_drag",
            json!({"source": "#a", "target": "#b", "human": true}),
            "drag #a #b --human",
            json!({"action": "drag", "source": "#a", "target": "#b", "inputMode": "human"}),
        ),
        case(
            "agent_browser_upload",
            json!({"selector": "#f", "files": ["a.txt", "b.txt"]}),
            "upload #f a.txt b.txt",
            json!({"action": "upload", "selector": "#f", "files": ["a.txt", "b.txt"]}),
        ),
        case(
            "agent_browser_download",
            json!({"selector": "#d", "path": "out.bin"}),
            "download #d out.bin",
            json!({"action": "download", "selector": "#d", "path": "out.bin"}),
        ),
        case(
            "agent_browser_select",
            json!({"selector": "#s", "values": ["a", "b"]}),
            "select #s a b",
            json!({"action": "select", "selector": "#s", "values": ["a", "b"]}),
        ),
        case(
            "agent_browser_scroll",
            json!({"direction": "left", "amount": 50, "selector": "#list"}),
            "scroll left 50 --selector #list",
            json!({"action": "scroll", "direction": "left", "amount": 50, "selector": "#list"}),
        ),
        case(
            "agent_browser_type",
            json!({"selector": "#q", "text": "hello", "clear": true, "delayMs": 20}),
            "type #q --clear --delay 20 -- hello",
            json!({"action": "type", "selector": "#q", "text": "hello", "clear": true, "delay": 20}),
        ),
        case(
            "agent_browser_screenshot",
            json!({"selector": "#m", "path": "shot.png", "fullPage": true, "ifChanged": true, "threshold": 0.1}),
            "screenshot #m shot.png --full --if-changed --threshold 0.1",
            json!({"action": "screenshot", "selector": "#m", "fullPage": true}),
        ),
        case(
            "agent_browser_wait_for_text",
            json!({"text": "Done", "waitTimeoutMs": 900}),
            "wait --text Done --timeout 900",
            json!({"action": "wait", "text": "Done", "timeout": 900}),
        ),
        case(
            "agent_browser_wait_for_url",
            json!({"url": "**/done", "waitTimeoutMs": 900}),
            "wait --url **/done --timeout 900",
            json!({"action": "waitforurl", "url": "**/done", "timeout": 900}),
        ),
        case(
            "agent_browser_wait_for_load",
            json!({"state": "networkidle"}),
            "wait --load networkidle",
            json!({"action": "waitforloadstate", "state": "networkidle"}),
        ),
        case(
            "agent_browser_wait_for_function",
            json!({"expression": "window.ready", "waitTimeoutMs": 900}),
            "wait --fn window.ready --timeout 900",
            json!({"action": "waitforfunction", "expression": "window.ready", "timeout": 900}),
        ),
        case(
            "agent_browser_wait_for_download",
            json!({"path": "file.zip", "waitTimeoutMs": 900}),
            "wait --download file.zip --timeout 900",
            json!({"action": "waitfordownload", "path": "file.zip", "timeout": 900}),
        ),
        case(
            "agent_browser_wait_for_selector",
            json!({"selector": "#spinner", "state": "hidden", "waitTimeoutMs": 900}),
            "wait #spinner --state hidden --timeout 900",
            json!({"action": "wait", "selector": "#spinner", "state": "hidden", "timeout": 900}),
        ),
        case(
            "agent_browser_tab_new",
            json!({"url": "https://a.test/", "label": "docs"}),
            "tab new https://a.test/ --label docs",
            json!({"action": "tab_new", "url": "https://a.test/", "label": "docs"}),
        ),
        case(
            "agent_browser_profiler_start",
            json!({"categories": "devtools.timeline"}),
            "profiler start --categories devtools.timeline",
            json!({"action": "profiler_start", "categories": ["devtools.timeline"]}),
        ),
        case(
            "agent_browser_profiler_stop",
            json!({"path": "p.json"}),
            "profiler stop p.json",
            json!({"action": "profiler_stop", "path": "p.json"}),
        ),
        case(
            "agent_browser_record_start",
            json!({"path": "r.webm", "url": "https://a.test/", "fps": 10, "cursor": true, "contactSheet": true,
                   "contactSheetThreshold": 0.3}),
            "record start r.webm https://a.test/ --fps 10 --cursor --contact-sheet --contact-sheet-threshold 0.3",
            json!({"action": "recording_start", "path": "r.webm", "url": "https://a.test/"}),
        ),
        case(
            "agent_browser_record_restart",
            json!({"path": "r2.webm"}),
            "record restart r2.webm",
            json!({"action": "recording_restart", "path": "r2.webm"}),
        ),
        case("agent_browser_console", json!({"clear": true}), "console --clear", json!({"action": "console", "clear": true})),
        case("agent_browser_errors", json!({"clear": true}), "errors --clear", json!({"action": "errors", "clear": true})),
        case(
            "agent_browser_swipe",
            json!({"direction": "up", "amount": 200}),
            "swipe up 200",
            json!({"action": "swipe", "direction": "up", "distance": 200}),
        ),
        case("agent_browser_device", json!({"action": "list"}), "device list", json!({"action": "device_list"})),
        case("agent_browser_tap", json!({"selector": "#b"}), "tap #b", json!({"action": "tap", "selector": "#b"})),
        case("agent_browser_react_tree", json!({"json": true}), "react tree --raw-json", json!({"action": "react_tree", "json": true})),
        case("agent_browser_react_inspect", json!({"id": 3}), "react inspect 3", json!({"action": "react_inspect", "fiberId": 3})),
        case("agent_browser_react_renders_start", json!({}), "react renders start", json!({"action": "react_renders_start"})),
        case("agent_browser_react_renders_stop", json!({}), "react renders stop", json!({"action": "react_renders_stop"})),
        case(
            "agent_browser_react_suspense",
            json!({"onlyDynamic": true}),
            "react suspense --only-dynamic",
            json!({"action": "react_suspense", "onlyDynamic": true}),
        ),
        case("agent_browser_vitals", json!({"url": "https://a.test/"}), "vitals https://a.test/", json!({"action": "vitals", "url": "https://a.test/"})),
        case(
            "agent_browser_a11y",
            json!({"tags": "wcag2a", "selector": "main"}),
            "a11y --tags wcag2a --selector main",
            json!({"action": "a11y", "selector": "main"}),
        ),
        case("agent_browser_stream_enable", json!({"port": 9333}), "stream enable --port 9333", json!({"action": "stream_enable", "port": 9333})),
        case(
            "agent_browser_webmcp_invoke",
            json!({"tool": "search", "params": {"q": "x"}, "frameId": "f1", "detach": true, "waitTimeoutMs": 100}),
            "webmcp invoke search --params {\"q\":\"x\"} --frame f1 --detach --timeout 100",
            json!({"action": "webmcp_invoke", "tool": "search", "params": {"q": "x"}, "frameId": "f1", "detach": true}),
        ),
        case(
            "agent_browser_webmcp_result",
            json!({"invocationId": "inv1", "waitTimeoutMs": 50}),
            "webmcp result inv1 --timeout 50",
            json!({"action": "webmcp_result", "invocationId": "inv1"}),
        ),
        case(
            "agent_browser_webmcp_cancel",
            json!({"invocationId": "inv1"}),
            "webmcp cancel inv1",
            json!({"action": "webmcp_cancel", "invocationId": "inv1"}),
        ),
        case(
            "agent_browser_webmcp_list",
            json!({"tool": "search", "frameId": "f1"}),
            "webmcp list search --frame f1",
            json!({"action": "webmcp_list"}),
        ),
        case("agent_browser_dialog_accept", json!({"text": "yes"}), "dialog accept yes", json!({"action": "dialog", "response": "accept", "promptText": "yes"})),
        case("agent_browser_dialog_dismiss", json!({}), "dialog dismiss", json!({"action": "dialog", "response": "dismiss"})),
        case("agent_browser_dialog_status", json!({}), "dialog status", json!({"action": "dialog", "response": "status"})),
        case("agent_browser_frame_switch", json!({"frame": "#f"}), "frame #f", json!({"action": "frame", "selector": "#f"})),
        case("agent_browser_frame_main", json!({}), "frame main", json!({"action": "mainframe"})),
        case("agent_browser_window_new", json!({}), "window new", json!({"action": "window_new"})),
        case("agent_browser_trace_start", json!({}), "trace start", json!({"action": "trace_start"})),
        case("agent_browser_trace_stop", json!({"path": "t.zip"}), "trace stop t.zip", json!({"action": "trace_stop", "path": "t.zip"})),
        case("agent_browser_clipboard_write", json!({"text": "copied"}), "clipboard write copied", json!({"action": "clipboard"})),
        case("agent_browser_pushstate", json!({"url": "/next"}), "pushstate /next", json!({"action": "pushstate", "url": "/next"})),
        case("agent_browser_remove_init_script", json!({"id": "s1"}), "removeinitscript s1", json!({"action": "removeinitscript"})),
        case("agent_browser_confirm", json!({"id": "c1"}), "confirm c1", json!({"action": "confirm", "confirmationId": "c1"})),
        case("agent_browser_deny", json!({"id": "c1"}), "deny c1", json!({"action": "deny", "confirmationId": "c1"})),
        case("agent_browser_get_attr", json!({"selector": "a", "name": "href"}), "get attr a href", json!({"action": "getattribute", "selector": "a", "attribute": "href"})),
        case("agent_browser_get_box", json!({"selector": "#b"}), "get box #b", json!({"action": "boundingbox", "selector": "#b"})),
        case("agent_browser_get_styles", json!({"selector": "#b"}), "get styles #b", json!({"action": "styles", "selector": "#b"})),
        case("agent_browser_is_enabled", json!({"selector": "#b"}), "is enabled #b", json!({"action": "isenabled", "selector": "#b"})),
        case("agent_browser_is_checked", json!({"selector": "#b"}), "is checked #b", json!({"action": "ischecked", "selector": "#b"})),
        case("agent_browser_highlight", json!({"selector": "#b"}), "highlight #b", json!({"action": "highlight", "selector": "#b"})),
        case("agent_browser_pdf", json!({"path": "page.pdf"}), "pdf page.pdf", json!({"action": "pdf", "path": "page.pdf"})),
        case(
            "agent_browser_eval",
            json!({"script": "document.title"}),
            "eval --stdin",
            json!({"action": "evaluate", "script": "document.title"}),
        ),
    ];
    // `eval --stdin` reads the script the MCP tool pipes in.
    cases.last_mut().unwrap().stdin = "document.title";
    cases
}

/// Every typed MCP tool sends the daemon the command its documented command line sends: MCP is upstream's
/// "full typed CLI parity surface", and both forms carry the fields the tool's arguments name.
#[test]
fn each_mcp_tool_sends_the_daemon_what_its_command_line_sends() {
    let daemon = Daemon::start();
    let mut wrong = Vec::new();
    for case in cases(daemon.home()) {
        let label = format!("{} {}", case.tool, case.arguments);
        let (by_mcp, result) = daemon.mcp(case.tool, &case.arguments);
        let mut argv = vec!["--json"];
        argv.extend(case.cli.iter().map(String::as_str));
        let (by_cli, output) = daemon.sent(&argv, case.stdin);
        if std::env::var_os("SURFACE_PRINT").is_some() {
            eprintln!("{label}\n  mcp {by_mcp:?}\n  cli {by_cli:?}\n  out {}", text(&output).trim());
        }
        if result["isError"] != false {
            wrong.push(format!("{label}: the tool answered an error: {result}"));
            continue;
        }
        if !output.status.success() {
            wrong.push(format!("{label}: `{}` failed: {}", case.cli.join(" "), text(&output)));
            continue;
        }
        match (by_mcp.last(), by_cli.last()) {
            (Some(mcp), Some(cli)) => {
                if mcp != cli {
                    wrong.push(format!("{label}: MCP sent {mcp}, the command line sent {cli}"));
                }
                if !holds(mcp, &case.daemon_gets) {
                    wrong.push(format!("{label}: daemon got {mcp}, wanted at least {}", case.daemon_gets));
                }
            }
            _ => wrong.push(format!("{label}: the daemon got nothing (mcp {by_mcp:?}, cli {by_cli:?})")),
        }
    }
    assert!(wrong.is_empty(), "{} wrong:\n{}", wrong.len(), wrong.join("\n"));
}

/// An MCP tool call whose arguments are wrong is refused with the reason before anything is run: the daemon
/// never hears of it.
#[test]
fn an_mcp_call_with_wrong_arguments_is_refused_with_its_reason_and_runs_nothing() {
    let daemon = Daemon::start();
    let refused = [
        ("agent_browser_set_media", json!({"colorScheme": "blue"}), "colorScheme must be dark, light, or no-preference"),
        ("agent_browser_set_media", json!({"reducedMotion": "always"}), "reducedMotion must be reduce or no-preference"),
        ("agent_browser_set_headers", json!({}), "headers must be an object"),
        ("agent_browser_wait_for_selector", json!({"selector": "500"}), "Bare integer selectors are rejected"),
        ("agent_browser_wait_for_selector", json!({"selector": "#a", "state": "gone"}), "state expects visible, hidden, attached, or detached, got 'gone'"),
        ("agent_browser_batch", json!({"commands": "get url"}), "commands must be an array"),
        ("agent_browser_batch", json!({"commands": ["get url"]}), "commands[0] must be an array"),
        ("agent_browser_batch", json!({"commands": [["get", 1]]}), "commands[0][1] must be a string"),
        ("agent_browser_flow_run", json!({"name": "f", "params": [1]}), "params must be an object"),
        ("agent_browser_flow_run", json!({"name": "f", "params": {"a": 1}}), "params.a must be a string"),
        ("agent_browser_get_url", json!({"restore": 5}), "restore must be a boolean or string"),
        ("agent_browser_get_url", json!({"caCert": "ca.pem", "clearCaCert": true}), "Cannot use caCert with clearCaCert"),
        ("agent_browser_get_url", json!({"timeoutMs": 0}), "timeoutMs must be a positive integer"),
        ("agent_browser_find", json!({"locator": "role"}), "value"),
        ("agent_browser_cookies_set", json!({"name": "a"}), "value"),
        ("agent_browser_state_clean", json!({}), "olderThanDays"),
    ];
    let mut wrong = Vec::new();
    for (tool, arguments, reason) in refused {
        let (sent, result) = daemon.mcp(tool, &arguments);
        let said = result["error"]["message"].as_str().unwrap_or_default();
        if !said.contains(reason) || !sent.is_empty() {
            wrong.push(format!("{tool} {arguments}: answered {result}, daemon got {sent:?}; wanted '{reason}'"));
        }
    }
    assert!(wrong.is_empty(), "{} wrong:\n{}", wrong.len(), wrong.join("\n"));
}

/// MCP's session-wide arguments (restore, its checks and policy, allowed domains, system CA) reach the daemon
/// as the command line's global flags do.
#[test]
fn mcp_session_arguments_reach_the_daemon_as_the_global_flags_do() {
    let daemon = Daemon::start();
    let (by_mcp, result) = daemon.mcp(
        "agent_browser_get_url",
        &json!({"restore": "acct", "restoreSave": "never", "restoreCheckUrl": "**/home", "restoreCheckText": "Hi",
                "restoreCheckFn": "() => true", "allowedDomains": ["a.test", "b.test"], "useSystemCa": true}),
    );
    assert_eq!(result["isError"], false, "{result}");
    let (by_cli, output) = daemon.sent(
        &["--json", "--restore=acct", "--restore-save", "never", "--restore-check-url", "**/home",
          "--restore-check-text", "Hi", "--restore-check-fn", "() => true", "--allowed-domains", "a.test,b.test",
          "--use-system-ca", "true", "get", "url"],
        "",
    );
    assert!(output.status.success(), "{}", text(&output));
    assert_eq!(by_mcp.last(), by_cli.last());
    let sent = by_mcp.last().unwrap();
    assert_eq!(sent["action"], "url", "{sent}");
    let wire = sent.to_string();
    for word in ["acct", "never", "**/home", "() => true", "a.test"] {
        assert!(wire.contains(word), "{word} missing from {sent}");
    }
}

/// `session id` names a folder: an optional cleaned prefix, then 12 hex of the folder's SHA-256, the same by
/// command line and MCP. Outside git, `worktree` falls back to the folder and `git-root` is an error that says
/// so; a scope it doesn't know is refused by name.
#[test]
fn session_id_names_the_folder_by_its_hash_and_refuses_a_scope_it_cannot_find() {
    use sha2::{Digest, Sha256};
    let daemon = Daemon::start();
    let work = daemon.home().join("work").canonicalize().unwrap();
    let path = work.to_string_lossy().to_string();
    let hash = format!("{:x}", Sha256::digest(path.as_bytes()))[..12].to_string();

    let id = stdout_json(&daemon.run(&["session", "id", "--scope", "cwd", "--prefix", "Agent One", "--json"], ""));
    let want = json!({"success": true, "data": {"session": format!("agent-one-{hash}"), "scope": "cwd", "path": path, "hash": hash}});
    assert_eq!(id, want);
    let (sent, result) = daemon.mcp("agent_browser_session_id", &json!({"scope": "cwd", "prefix": "Agent One"}));
    assert!(sent.is_empty(), "{sent:?}");
    assert_eq!(result["structuredContent"]["response"]["data"], want["data"], "{result}");

    let plain = daemon.run(&["session", "id", "--scope", "cwd"], "");
    assert_eq!(String::from_utf8_lossy(&plain.stdout).trim(), hash);
    let worktree = stdout_json(&daemon.run(&["--json", "session", "id"], ""));
    assert_eq!(worktree["data"]["scope"], "worktree");
    assert_eq!(worktree["data"]["path"], path, "outside git, a worktree is the folder itself");

    let git_root = daemon.run(&["--json", "session", "id", "--scope", "git-root"], "");
    assert_eq!(git_root.status.code(), Some(1));
    assert_eq!(stdout_json(&git_root)["error"], "Not inside a Git working tree");
    let unknown = daemon.run(&["session", "id", "--scope", "planet"], "");
    assert_eq!(unknown.status.code(), Some(1));
    assert!(text(&unknown).contains("Unknown session id scope 'planet'. Use worktree, cwd, or git-root."), "{}", text(&unknown));
}

/// `session info` reports the running daemon (pid, version) and what it says of itself; `session list` names
/// the running sessions; a session with no daemon is reported as not running.
#[test]
fn session_info_and_list_report_the_running_daemon_and_what_it_says() {
    let daemon = Daemon::start();
    let runtime = json!({"restoreStatus": "restored", "saveStatus": "saved", "engine": "chrome", "browserLaunched": true});
    let answer = runtime.clone();
    daemon.answer_with(move |request| match request["action"].as_str() {
        Some("session_info") => json!({"success": true, "data": answer}),
        _ => json!({"success": true, "data": {}}),
    });
    let info = stdout_json(&daemon.run(&["--json", "session", "info"], ""));
    assert_eq!(info["data"]["session"], SESSION);
    assert_eq!(info["data"]["active"], true);
    assert_eq!(info["data"]["pid"], std::process::id());
    assert_eq!(info["data"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["data"]["runtime"], runtime);
    assert_eq!(info["data"]["runtimeError"], Value::Null);

    let shown = text(&daemon.run(&["session", "info"], ""));
    for line in [
        "Session: surface".to_string(),
        format!("Daemon: running (pid {})", std::process::id()),
        format!("Version: {}", env!("CARGO_PKG_VERSION")),
        "Restore status: restored".to_string(),
        "Save status: saved".to_string(),
        "Engine: chrome".to_string(),
        "Browser launched: true".to_string(),
    ] {
        assert!(shown.contains(&line), "{line:?} missing from:\n{shown}");
    }

    daemon.answer_with(|_| json!({"success": false, "error": "no browser yet"}));
    let failing = text(&daemon.run(&["session", "info"], ""));
    assert!(failing.contains("Runtime info unavailable: no browser yet"), "{failing}");
    let other = text(&daemon.run(&["--session", "other", "session", "info"], ""));
    assert!(other.contains("Session: other") && other.contains("Daemon: not running"), "{other}");

    let list = stdout_json(&daemon.run(&["--json", "session", "list"], ""));
    assert_eq!(list["data"]["sessions"], json!([SESSION]));
    let listed = text(&daemon.run(&["session", "list"], ""));
    assert!(listed.contains("Active sessions:") && listed.contains("→ surface"), "{listed}");
    let current = stdout_json(&daemon.run(&["--json", "session"], ""));
    assert_eq!(current["data"]["session"], SESSION);
}

/// `profiles` lists the Chrome profiles `Local State` names, by command line and MCP; with no Chrome data it
/// says so and fails, and with no profiles it says that.
#[test]
fn profiles_lists_the_chrome_profiles_that_local_state_names() {
    let daemon = Daemon::start();
    let missing = daemon.run(&["--json", "profiles"], "");
    assert_eq!(missing.status.code(), Some(1));
    assert_eq!(stdout_json(&missing)["error"], "No Chrome user data directory found");
    assert!(text(&daemon.run(&["profiles"], "")).contains("No Chrome user data directory found"));

    let chrome = daemon.home().join(".config/google-chrome");
    std::fs::create_dir_all(&chrome).unwrap();
    std::fs::write(chrome.join("Local State"), r#"{"profile": {"info_cache": {}}}"#).unwrap();
    assert_eq!(stdout_json(&daemon.run(&["--json", "profiles"], "")), json!({"success": true, "data": []}));
    assert!(text(&daemon.run(&["profiles"], "")).contains("No Chrome profiles found"));

    std::fs::write(
        chrome.join("Local State"),
        r#"{"profile": {"info_cache": {"Default": {"name": "Person 1"}, "Profile 2": {"name": "Work"}}}}"#,
    )
    .unwrap();
    let listed = stdout_json(&daemon.run(&["--json", "profiles"], ""));
    let want = json!([{"directory": "Default", "name": "Person 1"}, {"directory": "Profile 2", "name": "Work"}]);
    assert_eq!(listed["data"], want);
    let shown = text(&daemon.run(&["profiles"], ""));
    assert!(shown.contains("Chrome profiles") && shown.contains("Profile 2") && shown.contains("(Work)"), "{shown}");
    let (_, result) = daemon.mcp("agent_browser_profiles", &json!({}));
    assert_eq!(result["structuredContent"]["response"]["data"], want, "{result}");
}

/// With `--confirm-interactive` and no terminal to ask, an action the daemon holds for confirmation is
/// denied: the CLI shows what was asked, sends `deny` with the confirmation's id, and fails.
#[test]
fn an_action_held_for_confirmation_is_denied_when_no_one_can_answer() {
    let daemon = Daemon::start();
    daemon.answer_with(|request| match request["action"].as_str() {
        Some("click") => json!({"success": true, "data": {"confirmation_required": true, "action": "click",
                                "category": "interact", "description": "Click #buy", "confirmation_id": "c-1"}}),
        _ => json!({"success": true, "data": {}}),
    });
    let (sent, output) = daemon.sent(&["--confirm-interactive", "click", "#buy"], "");
    assert_eq!(output.status.code(), Some(1), "{}", text(&output));
    let said = text(&output);
    for line in ["Action requires confirmation:", "interact: Click #buy", "Action denied"] {
        assert!(said.contains(line), "{line:?} missing from:\n{said}");
    }
    let deny = sent.last().unwrap();
    assert_eq!((&deny["action"], &deny["confirmationId"]), (&json!("deny"), &json!("c-1")), "{sent:?}");
}

/// `close --all` sends `close` to every running session and reports which closed and which refused.
#[test]
fn close_all_closes_each_running_session_and_names_one_that_refused() {
    let daemon = Daemon::start();
    daemon.answer_with(|_| json!({"success": true, "data": {"closed": true}}));
    let (sent, output) = daemon.sent(&["--json", "close", "--all"], "");
    assert!(output.status.success(), "{}", text(&output));
    assert_eq!(sent, vec![json!({"action": "close"})]);
    let closed = stdout_json(&output);
    assert_eq!(closed["data"]["closed"], 1, "{closed}");
    assert_eq!(closed["data"]["sessions"], json!([SESSION]), "{closed}");

    let refusing = Daemon::start();
    refusing.answer_with(|_| json!({"success": false, "error": "policy denies close"}));
    let output = refusing.run(&["close", "--all"], "");
    assert!(text(&output).contains("policy denies close"), "{}", text(&output));
    let output = refusing.run(&["--json", "close", "--all"], "");
    assert!(stdout_json(&output).to_string().contains("policy denies close"), "{}", text(&output));
}

/// A command line the parser can't take fails before the daemon is asked: `--json` names the kind of error, the
/// text form prints its usage; a bad `--restore-save` or `--restore` name is refused the same way.
#[test]
fn a_command_line_that_does_not_parse_names_its_error_and_asks_no_daemon() {
    let daemon = Daemon::start();
    for (argv, kind, words) in [
        (vec!["drag", "#a"], "missing_arguments", "drag <source> <target>"),
        (vec!["window", "open"], "unknown_subcommand", "open"),
        (vec!["swipe", "sideways"], "invalid_value", "Invalid swipe direction: sideways"),
        (vec!["state", "clear", "bad name"], "invalid_session_name", "bad name"),
        (vec!["--restore-save", "sometimes", "get", "url"], "invalid_value", "Invalid --restore-save value 'sometimes'. Use auto, always, or never."),
        (vec!["--restore=bad name", "get", "url"], "invalid_session_name", "bad name"),
    ] {
        let mut json_argv = vec!["--json"];
        json_argv.extend(&argv);
        let (sent, output) = daemon.sent(&json_argv, "");
        assert_eq!(output.status.code(), Some(1), "{argv:?}: {}", text(&output));
        let error = stdout_json(&output);
        assert_eq!(error["type"], kind, "{argv:?}: {error}");
        assert!(error["error"].as_str().unwrap_or_default().contains(words), "{argv:?}: {error}");
        assert!(sent.is_empty(), "{argv:?} reached the daemon: {sent:?}");
        let plain = daemon.run(&argv, "");
        assert_eq!(plain.status.code(), Some(1));
        assert!(text(&plain).contains(words), "{argv:?}: {}", text(&plain));
    }
}

/// `auth save` warns that a password on the command line can be seen, and with `--password-stdin` refuses an
/// empty stdin before the daemon hears of it.
#[test]
fn auth_save_warns_of_a_visible_password_and_refuses_an_empty_one() {
    let daemon = Daemon::start();
    let (sent, output) = daemon.sent(&["auth", "save", "a", "--url", "https://a.test/", "--username", "u", "--password", "p"], "");
    assert!(output.status.success(), "{}", text(&output));
    assert!(text(&output).contains("Passwords on the command line may be visible"), "{}", text(&output));
    assert_eq!(sent.last().unwrap()["password"], "p");
    for (stdin, words) in [("", "Failed to read password from stdin"), ("\n", "Password from stdin is empty")] {
        let (sent, output) = daemon.sent(&["auth", "save", "a", "--url", "https://a.test/", "--username", "u", "--password-stdin"], stdin);
        assert_eq!(output.status.code(), Some(1));
        assert!(text(&output).contains(words), "{stdin:?}: {}", text(&output));
        assert!(sent.is_empty());
    }
}

/// `batch` reads its commands as JSON from stdin: bad JSON is refused with the expected shape, `[]` answers `[]`,
/// the text form prints each answer, and `--bail` stops at the first command that fails, in both forms.
#[test]
fn batch_from_stdin_refuses_bad_json_and_bail_stops_at_the_first_failure() {
    let daemon = Daemon::start();
    daemon.answer_with(|request| match request["action"].as_str() {
        Some("title") => json!({"success": false, "error": "no page", "code": "tab_gone", "warning": "stale"}),
        _ => json!({"success": true, "data": {"url": "https://a.test/"}}),
    });
    let bad = daemon.run(&["--json", "batch"], "not json");
    assert_eq!(bad.status.code(), Some(1));
    assert!(stdout_json(&bad)["error"].as_str().unwrap().contains("Invalid JSON input"), "{}", text(&bad));
    let bad = daemon.run(&["batch"], "not json");
    assert!(text(&bad).contains("Invalid JSON input") && bad.status.code() == Some(1));
    let empty = daemon.run(&["--json", "batch"], "[]");
    assert_eq!(String::from_utf8_lossy(&empty.stdout).trim(), "[]");

    let both = r#"[["get","url"],["get","title"],["get","url"]]"#;
    let rows = stdout_json(&daemon.run(&["--json", "batch"], both));
    assert_eq!(rows.as_array().unwrap().len(), 3, "{rows}");
    assert_eq!((&rows[1]["code"], &rows[1]["warning"]), (&json!("tab_gone"), &json!("stale")), "{rows}");
    let (sent, bailed) = daemon.sent(&["--json", "batch", "--bail"], both);
    assert_eq!(stdout_json(&bailed).as_array().unwrap().len(), 2);
    assert_eq!(sent.len(), 2, "{sent:?}");
    let (sent, bailed) = daemon.sent(&["batch", "--bail"], r#"[["drag"],["get","url"]]"#);
    assert_eq!(bailed.status.code(), Some(1));
    assert!(text(&bailed).contains("Command 1:"), "{}", text(&bailed));
    assert!(sent.is_empty(), "{sent:?}");
    let shown = daemon.run(&["batch"], r#"[["get","url"],["get","url"]]"#);
    assert_eq!(String::from_utf8_lossy(&shown.stdout).matches("https://a.test/").count(), 2, "{}", text(&shown));
}

/// Saved states are named as `state --help` says: `state clear <session>` deletes that session's saved states and
/// no other, `state rename <old> <new>` renames one, and `state show <file>` reads one by its file name, all in the
/// states folder and without a daemon. (Upstream 0.43.0 cleared every saved state for `clear <session>`, failed
/// every `rename` with "Missing 'path' parameter", and read `show`'s file from the working folder.)
#[test]
fn saved_states_are_cleared_renamed_and_shown_by_their_names() {
    let daemon = Daemon::start();
    let states = daemon.home().join(".agent-browser/sessions");
    std::fs::create_dir_all(&states).unwrap();
    let state = r#"{"cookies": [], "origins": [{"origin": "https://a.test", "localStorage": []}]}"#;
    for name in ["myapp-default.json", "myapp-work.json", "other-default.json", "mine-default.json"] {
        std::fs::write(states.join(name), state).unwrap();
    }
    let left = || {
        let mut names: Vec<String> = std::fs::read_dir(&states).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(".json")).collect();
        names.sort();
        names
    };

    let (sent, cleared) = daemon.sent(&["--json", "state", "clear", "myapp"], "");
    assert!(cleared.status.success(), "{}", text(&cleared));
    assert!(sent.is_empty(), "state commands ask no daemon: {sent:?}");
    assert_eq!(left(), ["mine-default.json", "other-default.json"], "{}", text(&cleared));
    assert_eq!(stdout_json(&cleared)["data"]["deleted"], 2, "{}", text(&cleared));

    let renamed = daemon.run(&["--json", "state", "rename", "other-default", "kept"], "");
    assert!(renamed.status.success(), "{}", text(&renamed));
    assert_eq!(left(), ["kept.json", "mine-default.json"]);

    let shown = daemon.run(&["--json", "state", "show", "kept.json"], "");
    assert!(shown.status.success(), "{}", text(&shown));
    assert!(stdout_json(&shown).to_string().contains("a.test"), "{}", text(&shown));

    let (_, result) = daemon.mcp("agent_browser_state_rename", &json!({"oldName": "kept", "newName": "kept-again"}));
    assert_eq!(result["isError"], false, "{result}");
    let (_, result) = daemon.mcp("agent_browser_state_clear", &json!({"name": "mine"}));
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(left(), ["kept-again.json"]);

    let listed = stdout_json(&daemon.run(&["--json", "state", "list"], ""));
    assert!(listed.to_string().contains("kept-again.json"), "{listed}");
    let cleaned = stdout_json(&daemon.run(&["--json", "state", "clean", "--older-than", "30"], ""));
    assert_eq!(cleaned["data"], json!({"cleaned": 0, "keptCount": 1, "days": 30}), "{cleaned}");
    let all = stdout_json(&daemon.run(&["--json", "state", "clear", "--all"], ""));
    assert_eq!(all["data"]["deleted"], 1, "{all}");
    assert!(left().is_empty());
    let gone = daemon.run(&["--json", "state", "rename", "nothing", "x"], "");
    assert_eq!(gone.status.code(), Some(1));
    assert!(stdout_json(&gone)["error"].as_str().unwrap_or_default().contains("State file not found"), "{}", text(&gone));
}
