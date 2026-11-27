//! `agent-browser dashboard start|stop` and the HTTP server it runs, held through the built binary.
//!
//! `dashboard start` spawns the server as a detached background process that inherits the CLI's environment, so
//! it uses the same temp socket dir and the same stand-in daemon as every other test here. Each test starts it on
//! a free port, talks plain HTTP to 127.0.0.1 with a hand-written client, and stops it. A drop guard stops (and,
//! failing that, kills) the server, so a failed assertion leaves no process behind. Every child run and every
//! socket read has a timeout.
use super::*;
use std::io::Read;
use std::net::{Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::process::Child;
use std::time::Instant;
use tokio_tungstenite::tungstenite::{self, Message};

const COOKIE: &str = "__Host-agent-browser-dashboard-token";
const FORBIDDEN: &str = "Origin, Referer, or dashboard access token is invalid.";

/// A port for a dashboard. Taken below the kernel's ephemeral range (so no other test's `bind(0)` can be handed
/// the same port between here and the dashboard's own bind), distinct per call, and probed free.
fn free_port() -> u16 {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    loop {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let port = 12_000 + ((std::process::id() * 37 + n * 13) % 18_000) as u16;
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
}

fn try_run(d: &Daemon, args: &[&str], env: &[(&str, &str)], secs: u64) -> Option<Output> {
    let mut command = d.command();
    command
        .args(args)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if child.try_wait().unwrap().is_some() {
            return Some(child.wait_with_output().unwrap());
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn run_cli(d: &Daemon, args: &[&str], env: &[(&str, &str)]) -> Output {
    try_run(d, args, env, 60).unwrap_or_else(|| panic!("timed out: {args:?}"))
}

fn is_agent_browser(pid: u32) -> bool {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .and_then(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with("agent-browser"))
        })
        .unwrap_or(false)
}

/// Whether the process is gone (a zombie that nobody has reaped yet counts as gone).
fn is_gone(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat
            .rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z')),
    }
}

fn wait_gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !is_gone(pid) {
        assert!(Instant::now() < deadline, "process {pid} still running");
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// One HTTP answer: status code, raw head, body.
struct Reply {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Reply {
    fn parse(raw: Vec<u8>) -> Reply {
        let end = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap_or_else(|| panic!("no header end in {:?}", String::from_utf8_lossy(&raw)));
        let head = String::from_utf8_lossy(&raw[..end]).to_string();
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap();
        Reply {
            status,
            head,
            body: raw[end + 4..].to_vec(),
        }
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("{e}: {}", self.dump()))
    }

    fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    fn dump(&self) -> String {
        format!("{}\n\n{}", self.head, self.body_text())
    }

    fn status_line(&self) -> &str {
        self.head.lines().next().unwrap()
    }

    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().skip(1).find_map(|line| {
            let (n, v) = line.split_once(':')?;
            n.trim()
                .eq_ignore_ascii_case(name)
                .then(|| v.trim().to_string())
        })
    }
}

/// Whether `raw` holds a whole HTTP answer (its head, and as many body bytes as its Content-Length says).
fn is_whole(raw: &[u8]) -> bool {
    let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
        return false;
    };
    let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
    let wanted = head
        .lines()
        .find_map(|l| {
            l.strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    raw.len() - end - 4 >= wanted
}

/// One request and its whole answer. The server closes without reading a request it refused at once, which can
/// reset the connection under an answer still in flight; such a cut-off answer is asked for again.
fn exchange(addr: SocketAddr, parts: &[&[u8]]) -> Reply {
    for _ in 0..10 {
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        for (n, part) in parts.iter().enumerate() {
            if n > 0 {
                std::thread::sleep(Duration::from_millis(150));
            }
            let _ = stream.write_all(part);
        }
        let mut raw = Vec::new();
        match stream.read_to_end(&mut raw) {
            Ok(_) => return Reply::parse(raw),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => {
                if is_whole(&raw) {
                    return Reply::parse(raw);
                }
            }
            Err(e) => panic!("read: {e}: {:?}", String::from_utf8_lossy(&raw)),
        }
    }
    panic!("the server kept resetting the connection");
}

fn request_text(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> String {
    let mut text = format!("{method} {path} HTTP/1.1\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        text += &format!("Host: 127.0.0.1:{port}\r\n");
    }
    for (k, v) in headers {
        text += &format!("{k}: {v}\r\n");
    }
    text + &format!("Content-Length: {}\r\n\r\n{body}", body.len())
}

fn addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

fn send(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Reply {
    exchange(
        addr(port),
        &[request_text(port, method, path, headers, body).as_bytes()],
    )
}

fn same_origin(port: u16, method: &str, path: &str, body: &str) -> Reply {
    let origin = format!("http://127.0.0.1:{port}");
    send(
        port,
        method,
        path,
        &[("Origin", &origin), ("Content-Type", "application/json")],
        body,
    )
}

fn error_body(message: &str) -> Value {
    json!({"success": false, "error": message})
}

/// A running dashboard on a free port, in the daemon's temp HOME. Dropping it stops (or kills) the process.
struct Dashboard {
    d: Daemon,
    port: u16,
    pid: u32,
}

impl Dashboard {
    fn start(d: Daemon) -> Self {
        Self::start_with(d, &[], &[])
    }

    fn start_with(d: Daemon, extra: &[&str], env: &[(&str, &str)]) -> Self {
        let port = free_port();
        let mut dash = Dashboard { d, port, pid: 0 };
        let port_arg = port.to_string();
        let mut args = vec!["--json", "dashboard", "start", "--port", &port_arg];
        args.extend_from_slice(extra);
        let out = run_cli(&dash.d, &args, env);
        let started = stdout_json(&out);
        assert!(out.status.success(), "start failed: {}", text(&out));
        dash.pid = started["data"]["pid"].as_u64().unwrap() as u32;
        dash.wait_ready();
        dash
    }

    fn wait_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if TcpStream::connect_timeout(&addr(self.port), Duration::from_secs(1)).is_ok() {
                let origin = format!("http://127.0.0.1:{}", self.port);
                let request = request_text(
                    self.port,
                    "GET",
                    "/api/chat/status",
                    &[("Origin", &origin)],
                    "",
                );
                let mut stream = TcpStream::connect(addr(self.port)).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                if stream.write_all(request.as_bytes()).is_ok() {
                    let mut raw = Vec::new();
                    let _ = stream.read_to_end(&mut raw);
                    if raw.starts_with(b"HTTP/1.1 200") {
                        return;
                    }
                }
            }
            assert!(
                Instant::now() < deadline,
                "dashboard never answered on {}",
                self.port
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn socket_dir(&self) -> PathBuf {
        self.d.home().join("s")
    }

    fn get(&self, path: &str) -> Reply {
        same_origin(self.port, "GET", path, "")
    }

    fn post(&self, path: &str, body: &str) -> Reply {
        same_origin(self.port, "POST", path, body)
    }

    /// Writes the files that make `name` look like a live session streaming on `port`.
    fn register(&self, name: &str, port: u16, pid: u32) {
        register(&self.socket_dir(), name, port, pid);
    }
}

fn register(dir: &Path, name: &str, port: u16, pid: u32) {
    std::fs::write(dir.join(format!("{name}.stream")), port.to_string()).unwrap();
    std::fs::write(dir.join(format!("{name}.pid")), pid.to_string()).unwrap();
}

impl Drop for Dashboard {
    fn drop(&mut self) {
        let from_file = std::fs::read_to_string(self.socket_dir().join("dashboard.pid"))
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok());
        let _ = try_run(&self.d, &["dashboard", "stop"], &[], 20);
        for pid in [Some(self.pid), from_file].into_iter().flatten() {
            if pid > 0 && is_agent_browser(pid) {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
        }
    }
}

/// A stand-in session server: answers every request with `answer(path)` raw bytes and records the request text.
struct Upstream {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
}

fn upstream(answer: impl Fn(&str) -> Vec<u8> + Send + 'static) -> Upstream {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&requests);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut raw = Vec::new();
            let mut chunk = [0u8; 1024];
            while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => raw.extend_from_slice(&chunk[..n]),
                }
            }
            let request = String::from_utf8_lossy(&raw).to_string();
            if request.is_empty() {
                continue;
            }
            let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
            seen.lock().unwrap().push(request);
            let _ = stream.write_all(&answer(&path));
            let _ = stream.shutdown(std::net::Shutdown::Write);
        }
    });
    Upstream { port, requests }
}

fn http_reply(status: &str, content_type: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// Kills the child on drop, so a failed assertion leaves no `sleep` behind.
struct Victim(Child);

impl Drop for Victim {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn victim() -> Victim {
    Victim(
        Command::new("sleep")
            .arg("120")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

// ---------------------------------------------------------------------------------------------------------------
// start / stop

#[test]
fn dashboard_start_runs_a_detached_server_and_stop_ends_it_and_removes_its_files() {
    let dash = Dashboard::start(Daemon::start());
    let (port, pid) = (dash.port, dash.pid);
    let dir = dash.socket_dir();

    assert!(
        is_agent_browser(pid),
        "pid {pid} is not the agent-browser binary"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("dashboard.pid")).unwrap(),
        pid.to_string()
    );
    let config: Value =
        serde_json::from_slice(&std::fs::read(dir.join("dashboard.config")).unwrap()).unwrap();
    assert_eq!(
        config,
        json!({"port": port, "allowed_origins": [], "access_token": null})
    );
    // A background server of its own: not this process's child group leader (setsid) and answering HTTP.
    assert_eq!(dash.get("/api/chat/status").status, 200);

    // A second start with the same settings joins the running server.
    let port_arg = port.to_string();
    let again = run_cli(
        &dash.d,
        &["--json", "dashboard", "start", "--port", &port_arg],
        &[],
    );
    assert_eq!(
        stdout_json(&again),
        json!({"success": true, "data": {"port": port, "pid": pid, "already_running": true, "access_urls": []}})
    );
    let again = run_cli(&dash.d, &["dashboard", "--port", &port_arg], &[]);
    assert_eq!(
        text(&again),
        format!("Dashboard already running at http://localhost:{port}\n")
    );

    // Other settings are refused while it runs.
    let other = (port ^ 1).to_string();
    let changed = run_cli(
        &dash.d,
        &["--json", "dashboard", "start", "--port", &other],
        &[],
    );
    assert_eq!(changed.status.code(), Some(1));
    assert_eq!(
        stdout_json(&changed),
        error_body(&format!(
            "Dashboard is already running with port {port} and loopback origins only. Run 'agent-browser dashboard stop' before starting it with different settings."
        ))
    );
    assert_eq!(dash.get("/api/chat/status").status, 200);

    let stopped = run_cli(&dash.d, &["--json", "dashboard", "stop"], &[]);
    assert_eq!(
        stdout_json(&stopped),
        json!({"success": true, "data": {"stopped": true}})
    );
    wait_gone(pid);
    assert!(!dir.join("dashboard.pid").exists() && !dir.join("dashboard.config").exists());
    assert!(TcpStream::connect_timeout(&addr(port), Duration::from_secs(2)).is_err());

    let nothing = run_cli(&dash.d, &["dashboard", "stop"], &[]);
    assert_eq!(text(&nothing), "Dashboard is not running\n");

    // Text mode: start prints where it listens, stop prints a check mark.
    let started = run_cli(&dash.d, &["dashboard", "start", "--port", &port_arg], &[]);
    assert_eq!(
        text(&started),
        format!("Dashboard started at http://localhost:{port}\n")
    );
    let new_pid: u32 = std::fs::read_to_string(dir.join("dashboard.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_ne!(new_pid, pid);
    dash.wait_ready();
    let stopped = run_cli(&dash.d, &["dashboard", "stop"], &[]);
    assert_eq!(text(&stopped), "✓ Dashboard stopped\n");
    wait_gone(new_pid);
}

#[test]
fn dashboard_stop_reports_why_nothing_was_stopped_and_never_signals_a_foreign_process() {
    let d = Daemon::start();
    let dir = d.home().join("s");
    let json_stop = |d: &Daemon| stdout_json(&run_cli(d, &["--json", "dashboard", "stop"], &[]));

    assert_eq!(
        json_stop(&d),
        json!({"success": true, "data": {"stopped": false, "reason": "not running"}})
    );

    std::fs::write(dir.join("dashboard.pid"), "not-a-pid").unwrap();
    std::fs::write(dir.join("dashboard.config"), "{}").unwrap();
    assert_eq!(
        json_stop(&d),
        json!({"success": true, "data": {"stopped": false, "reason": "invalid pid"}})
    );
    assert!(!dir.join("dashboard.pid").exists() && !dir.join("dashboard.config").exists());

    std::fs::write(dir.join("dashboard.pid"), "not-a-pid").unwrap();
    assert_eq!(
        text(&run_cli(&d, &["dashboard", "stop"], &[])),
        "Dashboard is not running\n"
    );

    // This test's own pid is alive but is not an agent-browser binary: it is left alone.
    std::fs::write(dir.join("dashboard.pid"), std::process::id().to_string()).unwrap();
    assert_eq!(
        json_stop(&d),
        json!({"success": true, "data": {"stopped": false, "reason": "not running"}})
    );
    assert!(!dir.join("dashboard.pid").exists());

    std::fs::write(dir.join("dashboard.pid"), "999999999").unwrap();
    assert_eq!(
        text(&run_cli(&d, &["dashboard", "stop"], &[])),
        "Dashboard is not running\n"
    );
}

#[test]
fn dashboard_start_replaces_the_files_of_a_dead_dashboard() {
    let d = Daemon::start();
    let dir = d.home().join("s");
    // A config with no pid file is dropped, and the new one is written fresh.
    std::fs::write(dir.join("dashboard.config"), "stale").unwrap();
    let dash = Dashboard::start(d);
    let config: Value =
        serde_json::from_slice(&std::fs::read(dir.join("dashboard.config")).unwrap()).unwrap();
    assert_eq!(config["port"], dash.port);
    let run_stop = run_cli(&dash.d, &["--json", "dashboard", "stop"], &[]);
    assert_eq!(stdout_json(&run_stop)["data"]["stopped"], true);

    // A pid file of a dead process, with its config, is replaced by the new server's.
    std::fs::write(dir.join("dashboard.pid"), "999999999").unwrap();
    std::fs::write(dir.join("dashboard.config"), "stale").unwrap();
    let port_arg = dash.port.to_string();
    let started = run_cli(
        &dash.d,
        &["--json", "dashboard", "start", "--port", &port_arg],
        &[],
    );
    let new_pid = stdout_json(&started)["data"]["pid"].as_u64().unwrap();
    assert_ne!(new_pid, 999999999);
    assert_eq!(
        std::fs::read_to_string(dir.join("dashboard.pid")).unwrap(),
        new_pid.to_string()
    );
    dash.wait_ready();
}

#[test]
fn running_dashboard_with_an_unverifiable_config_refuses_another_start() {
    let dash = Dashboard::start(Daemon::start());
    let config_path = dash.socket_dir().join("dashboard.config");
    let port = dash.port;
    let port_arg = port.to_string();
    let start = |dash: &Dashboard| {
        stdout_json(&run_cli(
            &dash.d,
            &["--json", "dashboard", "start", "--port", &port_arg],
            &[],
        ))
    };

    std::fs::write(&config_path, "garbage").unwrap();
    assert_eq!(
        start(&dash),
        error_body("Dashboard is already running, but its configuration could not be verified. Run 'agent-browser dashboard stop' before starting it again.")
    );

    std::fs::write(
        &config_path,
        json!({"port": port, "allowed_origins": ["https://a.example"], "access_token": "short"})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        start(&dash),
        error_body("Dashboard is already running, but its access-token configuration could not be verified. Run 'agent-browser dashboard stop' before starting it again.")
    );
}

#[test]
fn dashboard_start_rejects_bad_arguments_with_the_exact_error_and_starts_nothing() {
    let origin_error = |value: &str| {
        format!("Invalid dashboard allowed origin '{value}'. Expected an exact non-loopback HTTPS origin without a path, query, fragment, or credentials.")
    };
    let cases: Vec<(Vec<&str>, String)> = vec![
        (
            vec!["dashboard", "bogus"],
            "Unknown dashboard subcommand: bogus".into(),
        ),
        (
            vec!["dashboard", "stop", "now"],
            "Dashboard stop does not accept argument 'now'.".into(),
        ),
        (
            vec!["dashboard", "start", "--bogus"],
            "Unknown dashboard option: --bogus".into(),
        ),
        (
            vec!["dashboard", "start", "extra"],
            "Unexpected dashboard argument: extra".into(),
        ),
        (
            vec!["dashboard", "start", "--port", "0"],
            "Invalid dashboard port '0'. Expected an integer from 1 to 65535.".into(),
        ),
        (
            vec!["dashboard", "start", "--port", "abc"],
            "Invalid dashboard port 'abc'. Expected an integer from 1 to 65535.".into(),
        ),
        (
            vec!["dashboard", "start", "--port", "70000"],
            "Invalid dashboard port '70000'. Expected an integer from 1 to 65535.".into(),
        ),
        (
            vec!["dashboard", "start", "--port"],
            "Dashboard option '--port' requires a value.".into(),
        ),
        (
            vec!["dashboard", "start", "--port", "5", "--port", "6"],
            "Dashboard option '--port' was provided more than once.".into(),
        ),
        (
            vec!["dashboard", "start", "--allowed-origins"],
            "Dashboard option '--allowed-origins' requires a value.".into(),
        ),
        (
            vec![
                "dashboard",
                "start",
                "--allowed-origins",
                "https://a.example",
                "--allowed-origins",
                "https://b.example",
            ],
            "Dashboard option '--allowed-origins' was provided more than once.".into(),
        ),
        (
            vec!["dashboard", "start", "--allowed-origins", ""],
            "Dashboard allowed origins cannot be empty.".into(),
        ),
        (
            vec![
                "dashboard",
                "start",
                "--allowed-origins",
                "http://dash.example.com",
            ],
            origin_error("http://dash.example.com"),
        ),
        (
            vec![
                "dashboard",
                "start",
                "--allowed-origins",
                "https://localhost:9",
            ],
            origin_error("https://localhost:9"),
        ),
        (
            vec![
                "dashboard",
                "start",
                "--allowed-origins",
                "https://dash.example.com/x",
            ],
            origin_error("https://dash.example.com/x"),
        ),
        (
            vec![
                "dashboard",
                "start",
                "--allowed-origins",
                "https://u:p@dash.example.com",
            ],
            origin_error("https://u:p@dash.example.com"),
        ),
        (
            vec![
                "dashboard",
                "start",
                "--allowed-origins",
                "https://dash.example.com,not a url",
            ],
            origin_error("not a url"),
        ),
    ];
    let d = Daemon::start();
    for (args, error) in &cases {
        let mut full = vec!["--json"];
        full.extend(args);
        let output = run_cli(&d, &full, &[]);
        assert_eq!(output.status.code(), Some(1), "{args:?}: {}", text(&output));
        assert_eq!(stdout_json(&output), error_body(error), "{args:?}");
    }
    // Text mode writes the same message to stderr.
    let output = run_cli(&d, &["dashboard", "start", "--port", "0"], &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr)
        .trim_end()
        .ends_with("Invalid dashboard port '0'. Expected an integer from 1 to 65535."));
    // The allowlist can also come from the environment, and is checked the same way.
    let output = run_cli(
        &d,
        &["--json", "dashboard", "start", "--port", "5"],
        &[(
            "AGENT_BROWSER_DASHBOARD_ALLOWED_ORIGINS",
            "http://dash.example.com",
        )],
    );
    assert_eq!(
        stdout_json(&output),
        error_body(&origin_error("http://dash.example.com"))
    );
    let leftovers: Vec<_> = std::fs::read_dir(d.home().join("s"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("dashboard"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn dashboard_start_reports_success_even_when_the_port_is_taken_and_the_server_dies() {
    // Upstream quirk, held as it is: the CLI writes the pid file and reports success before the server binds.
    let d = Daemon::start();
    let taken = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port().to_string();
    let started = run_cli(&d, &["--json", "dashboard", "start", "--port", &port], &[]);
    let pid = stdout_json(&started)["data"]["pid"].as_u64().unwrap() as u32;
    wait_gone(pid);
    let stopped = run_cli(&d, &["--json", "dashboard", "stop"], &[]);
    assert_eq!(
        stdout_json(&stopped),
        json!({"success": true, "data": {"stopped": false, "reason": "not running"}})
    );
    assert!(!d.home().join("s/dashboard.pid").exists());
}

#[test]
fn dashboard_serves_ipv4_alone_when_the_ipv6_port_is_taken_and_ignores_empty_connections() {
    let port = free_port();
    let Ok(_v6) = TcpListener::bind((Ipv6Addr::LOCALHOST, port)) else {
        return;
    };
    let d = Daemon::start();
    let mut dash = Dashboard { d, port, pid: 0 };
    let port_arg = port.to_string();
    let started = run_cli(
        &dash.d,
        &["--json", "dashboard", "start", "--port", &port_arg],
        &[],
    );
    dash.pid = stdout_json(&started)["data"]["pid"].as_u64().unwrap() as u32;
    dash.wait_ready();

    // A client that connects and hangs up sends nothing; the server carries on.
    drop(TcpStream::connect(addr(port)).unwrap());
    assert_eq!(
        dash.get("/api/chat/status").json(),
        json!({"enabled": false})
    );
    // A request line with no headers at all is still answered (the index page).
    let bare = exchange(addr(port), &[b"GET / HTTP/1.1\r\n\r\n"]);
    assert_eq!(bare.status, 200);
    assert_eq!(
        bare.header("content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
}

// ---------------------------------------------------------------------------------------------------------------
// discovery

#[test]
fn sessions_lists_live_sessions_with_engine_provider_and_extensions() {
    let dash = Dashboard::start(Daemon::start());
    let dir = dash.socket_dir();
    let me = std::process::id();
    assert_eq!(dash.get("/api/sessions").json(), json!([]));

    let ext = dash.d.home().join("ext");
    let (full, bare, nomanifest, broken) = (
        ext.join("full"),
        ext.join("bare"),
        ext.join("nomanifest"),
        ext.join("broken"),
    );
    for p in [&full, &bare, &nomanifest, &broken] {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(
        full.join("manifest.json"),
        r#"{"name":"Ad Block","version":"1.2","description":"blocks ads"}"#,
    )
    .unwrap();
    std::fs::write(bare.join("manifest.json"), "{}").unwrap();
    std::fs::write(broken.join("manifest.json"), "not json").unwrap();

    dash.register("alpha", 4001, me);
    std::fs::write(dir.join("alpha.engine"), "lightpanda\n").unwrap();
    std::fs::write(dir.join("alpha.provider"), "browserbase\n").unwrap();
    std::fs::write(
        dir.join("alpha.extensions"),
        format!(
            "{}, {},{}, {}, ",
            full.display(),
            bare.display(),
            nomanifest.display(),
            broken.display()
        ),
    )
    .unwrap();
    dash.register("beta", 4002, me);
    std::fs::write(dir.join("beta.engine"), "  \n").unwrap();
    std::fs::write(dir.join("beta.provider"), "").unwrap();
    // Stale: the process is gone, there is no pid file, or the port file is not a port.
    dash.register("gone", 4003, 999_999_999);
    std::fs::write(dir.join("nopid.stream"), "4004").unwrap();
    std::fs::write(dir.join("junk.stream"), "not-a-port").unwrap();
    std::fs::write(dir.join("big.stream"), "70000").unwrap();
    std::fs::write(dir.join("big.pid"), me.to_string()).unwrap();
    std::fs::write(dir.join("badpid.stream"), "4005").unwrap();
    std::fs::write(dir.join("badpid.pid"), "x").unwrap();

    let reply = dash.get("/api/sessions");
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.header("content-type").as_deref(),
        Some("application/json; charset=utf-8")
    );
    let mut sessions = reply.json().as_array().unwrap().clone();
    sessions.sort_by_key(|s| s["session"].as_str().unwrap().to_string());
    assert_eq!(
        Value::Array(sessions),
        json!([
            {
                "session": "alpha", "port": 4001, "engine": "lightpanda", "provider": "browserbase",
                "extensions": [
                    {"name": "Ad Block", "version": "1.2", "path": full.to_str().unwrap(), "description": "blocks ads"},
                    {"name": "Unknown", "version": "", "path": bare.to_str().unwrap()},
                ],
            },
            {"session": "beta", "port": 4002, "engine": "chrome"},
        ])
    );
}

#[test]
fn sessions_forgets_the_port_file_of_a_dead_session_and_only_skips_unreadable_ones() {
    let dash = Dashboard::start(Daemon::start());
    let dir = dash.socket_dir();
    let me = std::process::id();
    dash.register("alpha", 4001, me);
    dash.register("beta", 4002, me);
    dash.register("gone", 4003, 999_999_999);
    std::fs::write(dir.join("nopid.stream"), "4004").unwrap();
    std::fs::write(dir.join("junk.stream"), "not-a-port").unwrap();
    std::fs::write(dir.join("big.stream"), "70000").unwrap();
    std::fs::write(dir.join("big.pid"), me.to_string()).unwrap();
    std::fs::write(dir.join("badpid.stream"), "4005").unwrap();
    std::fs::write(dir.join("badpid.pid"), "x").unwrap();

    let reply = dash.get("/api/sessions");
    let mut ports: Vec<u64> = reply
        .json()
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["port"].as_u64().unwrap())
        .collect();
    ports.sort();
    assert_eq!(ports, vec![4001, 4002]);
    // A dead session's port file is removed; the others are only skipped.
    for gone in ["gone.stream", "nopid.stream", "badpid.stream"] {
        assert!(!dir.join(gone).exists(), "{gone} should have been removed");
    }
    for kept in ["alpha.stream", "beta.stream", "junk.stream", "big.stream"] {
        assert!(dir.join(kept).exists(), "{kept} should still be there");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// chat status and models

#[test]
fn chat_status_and_models_say_chat_is_off_without_an_ai_gateway_key() {
    let dash = Dashboard::start(Daemon::start());
    assert_eq!(
        dash.get("/api/chat/status").json(),
        json!({"enabled": false})
    );
    let models = dash.get("/api/models");
    assert_eq!(models.status, 200);
    assert_eq!(models.json(), json!({"data": []}));
    assert_eq!(
        models.header("access-control-allow-origin"),
        Some(format!("http://127.0.0.1:{}", dash.port))
    );
}

#[test]
fn chat_status_and_models_follow_the_ai_gateway_settings() {
    let gateway = upstream(|path| match path {
        "/v1/models" => http_reply("200 OK", "application/json", r#"{"data":[{"id":"m1"}]}"#),
        _ => http_reply("404 Not Found", "text/plain", "no"),
    });
    let url = format!("http://127.0.0.1:{}/", gateway.port);
    let dash = Dashboard::start_with(
        Daemon::start(),
        &[],
        &[
            ("AI_GATEWAY_API_KEY", "secret-key"),
            ("AI_GATEWAY_MODEL", "acme/fast"),
            ("AI_GATEWAY_URL", &url),
        ],
    );
    assert_eq!(
        dash.get("/api/chat/status").json(),
        json!({"enabled": true, "model": "acme/fast"})
    );
    let models = dash.get("/api/models");
    assert_eq!(models.status, 200);
    assert_eq!(models.json(), json!({"data": [{"id": "m1"}]}));
    let requests = gateway.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].starts_with("GET /v1/models HTTP/1.1"),
        "{}",
        requests[0]
    );
    assert!(
        requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer secret-key"),
        "{}",
        requests[0]
    );
}

#[test]
fn models_is_empty_when_the_gateway_fails_and_status_omits_the_model_when_unset() {
    let gateway = upstream(|_| http_reply("500 Internal Server Error", "text/plain", "down"));
    let url = format!("http://127.0.0.1:{}", gateway.port);
    let dash = Dashboard::start_with(
        Daemon::start(),
        &[],
        &[("AI_GATEWAY_API_KEY", "k"), ("AI_GATEWAY_URL", &url)],
    );
    assert_eq!(
        dash.get("/api/chat/status").json(),
        json!({"enabled": true})
    );
    assert_eq!(dash.get("/api/models").json(), json!({"data": []}));
}

// ---------------------------------------------------------------------------------------------------------------
// origin checks

#[test]
fn cross_origin_and_unauthenticated_api_requests_are_refused_and_run_nothing() {
    let dash = Dashboard::start(Daemon::start());
    let me = std::process::id();
    let session = upstream(|_| http_reply("200 OK", "application/json", "[]"));
    dash.register("proxied", session.port, me);
    let target = victim();
    let target_pid = target.0.id();
    dash.register("victim", 4999, target_pid);
    let port = dash.port;
    let tabs = format!("/api/session/{}/tabs", session.port);

    let own = format!("http://127.0.0.1:{port}");
    let header_sets: Vec<Vec<(&str, &str)>> = vec![
        vec![("Origin", "https://evil.example")],
        vec![("Origin", "null")],
        vec![],
        vec![("Referer", "https://evil.example/page")],
        vec![("Origin", "https://evil.example"), ("Referer", &own)],
        vec![("Origin", "http://127.0.0.1:1")],
        vec![("Origin", "http://evil.example"), ("Host", "evil.example")],
        vec![("Origin", "http://user:pw@127.0.0.1:1")],
        vec![("Origin", "ftp://127.0.0.1")],
    ];
    let routes = [
        ("GET", "/api/sessions"),
        ("POST", "/api/sessions"),
        ("POST", "/api/exec"),
        ("POST", "/api/kill"),
        ("POST", "/api/chat"),
        ("GET", "/api/models"),
        ("GET", "/api/chat/status"),
        ("GET", tabs.as_str()),
        ("OPTIONS", "/api/exec"),
        ("GET", "/api/anything-else"),
    ];
    let body = r##"{"args":["click","#x"],"session":"victim"}"##;
    for headers in &header_sets {
        for (method, path) in routes {
            let reply = send(port, method, path, headers, body);
            let label = format!("{method} {path} {headers:?}");
            assert_eq!(reply.status, 403, "{label}: {}", reply.dump());
            assert_eq!(reply.json(), error_body(FORBIDDEN), "{label}");
            assert!(
                reply.header("access-control-allow-origin").is_none(),
                "{label}"
            );
        }
    }
    // Pages are not API: a foreign origin still gets the static page, without CORS headers.
    let page = send(port, "GET", "/", &[("Origin", "https://evil.example")], "");
    assert_eq!(page.status, 200);
    assert!(page.header("access-control-allow-origin").is_none());

    assert!(
        dash.d.seen.lock().unwrap().is_empty(),
        "a refused request reached the daemon"
    );
    assert!(
        session.requests.lock().unwrap().is_empty(),
        "a refused request reached the session"
    );
    assert!(std::path::Path::new(&format!("/proc/{target_pid}")).exists());
    assert!(dash.socket_dir().join("victim.pid").exists());
}

#[test]
fn same_origin_forms_are_accepted_and_preflight_answers_without_wildcard_cors() {
    let dash = Dashboard::start(Daemon::start());
    let port = dash.port;
    let ok = |headers: &[(&str, &str)]| {
        let reply = send(port, "GET", "/api/sessions", headers, "");
        assert_eq!(
            (reply.status, reply.json()),
            (200, json!([])),
            "{headers:?}"
        );
    };
    ok(&[("Origin", &format!("http://127.0.0.1:{port}"))]);
    // The Referer stands in for a missing Origin, with its path ignored.
    ok(&[("Referer", &format!("http://127.0.0.1:{port}/some/page?x=1"))]);
    ok(&[
        ("Origin", &format!("http://localhost:{port}")),
        ("Host", &format!("localhost:{port}")),
    ]);
    ok(&[
        ("Origin", &format!("http://localhost:{port}")),
        ("Host", &format!("LocalHost:{port}")),
    ]);
    ok(&[
        ("Origin", &format!("http://[::1]:{port}")),
        ("Host", &format!("[::1]:{port}")),
    ]);
    ok(&[("origin", &format!("http://127.0.0.1:{port}"))]);
    // The Origin wins over a good Referer, and a different loopback name than the Host is not the same origin.
    let mixed = send(
        port,
        "GET",
        "/api/sessions",
        &[
            ("Origin", "https://evil.example"),
            ("Referer", &format!("http://127.0.0.1:{port}/")),
        ],
        "",
    );
    assert_eq!(mixed.status, 403);
    let wrong_name = send(
        port,
        "GET",
        "/api/sessions",
        &[("Origin", &format!("http://localhost:{port}"))],
        "",
    );
    assert_eq!(wrong_name.status, 403);
}

#[test]
fn preflight_answers_a_same_origin_options_request_without_wildcard_cors() {
    let dash = Dashboard::start(Daemon::start());
    let port = dash.port;
    let preflight = send(
        port,
        "OPTIONS",
        "/api/exec",
        &[
            ("Origin", &format!("http://127.0.0.1:{port}")),
            ("Access-Control-Request-Method", "POST"),
        ],
        "",
    );
    assert_eq!(preflight.status_line(), "HTTP/1.1 204 No Content");
    assert_eq!(
        preflight.header("access-control-max-age").as_deref(),
        Some("86400")
    );
    assert!(preflight.header("access-control-allow-origin").is_none());
    assert!(preflight.body.is_empty());
}

#[test]
fn reverse_proxy_origins_need_the_access_token_and_loopback_needs_none() {
    let dash = Dashboard::start_with(
        Daemon::start(),
        &[
            "--allowed-origins",
            "https://Dash.Example.com:443, https://dash.example.com",
        ],
        &[],
    );
    let config: Value =
        serde_json::from_slice(&std::fs::read(dash.socket_dir().join("dashboard.config")).unwrap())
            .unwrap();
    assert_eq!(
        config["allowed_origins"],
        json!(["https://dash.example.com"])
    );
    let token = config["access_token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    let cookie = format!("{COOKIE}={token}");
    let port = dash.port;

    let call = |headers: &[(&str, &str)]| send(port, "GET", "/api/chat/status", headers, "");
    let proxied = [
        ("Host", "dash.example.com"),
        ("Origin", "https://dash.example.com"),
    ];
    fn with<'a>(base: &[(&'a str, &'a str)], extra: (&'a str, &'a str)) -> Vec<(&'a str, &'a str)> {
        let mut h = base.to_vec();
        h.push(extra);
        h
    }

    let none = call(&proxied);
    assert_eq!((none.status, none.json()), (403, error_body(FORBIDDEN)));
    let good = call(&with(&proxied, ("Cookie", &cookie)));
    assert_eq!((good.status, good.json()), (200, json!({"enabled": false})));
    let among_others = call(&with(&proxied, ("Cookie", &format!("a=b; {cookie}; c=d"))));
    assert_eq!(among_others.status, 200);
    assert_eq!(
        call(&with(
            &proxied,
            ("Cookie", &format!("{COOKIE}={}", "a".repeat(64)))
        ))
        .status,
        403
    );
    assert_eq!(
        call(&with(&proxied, ("Cookie", &format!("{COOKIE}=short")))).status,
        403
    );
    assert_eq!(
        call(&with(&proxied, ("Cookie", &format!("other={token}")))).status,
        403
    );
    // The default HTTPS port in the Host header still names the same origin; a Referer can stand in for Origin.
    let default_port = [
        ("Host", "dash.example.com:443"),
        ("Origin", "https://dash.example.com"),
        ("Cookie", &cookie),
    ];
    assert_eq!(call(&default_port).status, 200);
    let referer = [
        ("Host", "dash.example.com"),
        ("Referer", "https://dash.example.com/page"),
        ("Cookie", &cookie),
    ];
    assert_eq!(call(&referer).status, 200);
    // An origin outside the list, or an Origin that is not the Host, fails even with the right token.
    let stranger = [
        ("Host", "other.example.com"),
        ("Origin", "https://other.example.com"),
        ("Cookie", &cookie),
    ];
    assert_eq!(call(&stranger).status, 403);
    let rebind = [
        ("Host", "evil.example"),
        ("Origin", "https://dash.example.com"),
        ("Cookie", &cookie),
    ];
    assert_eq!(call(&rebind).status, 403);
    let plain_http = [
        ("Host", "dash.example.com"),
        ("Origin", "http://dash.example.com"),
        ("Cookie", &cookie),
    ];
    assert_eq!(call(&plain_http).status, 403);
    // Loopback needs no token, even with an allowlist set.
    assert_eq!(
        dash.get("/api/chat/status").json(),
        json!({"enabled": false})
    );

    // The stream route applies the same rules before it looks for the session.
    let upgrade = |headers: &[(&str, &str)]| {
        let mut h = vec![("Upgrade", "websocket"), ("Connection", "Upgrade")];
        h.extend_from_slice(headers);
        send(port, "GET", "/api/session/4999/stream", &h, "")
    };
    assert_eq!(upgrade(&proxied).status, 403);
    let granted = upgrade(&with(&proxied, ("Cookie", &cookie)));
    assert_eq!(
        (granted.status, granted.json()),
        (
            404,
            error_body("No active session is listening on port 4999.")
        )
    );

    // The same settings from the environment are the same configuration: asking again joins the server.
    let port_arg = port.to_string();
    let again = run_cli(
        &dash.d,
        &["--json", "dashboard", "start", "--port", &port_arg],
        &[(
            "AGENT_BROWSER_DASHBOARD_ALLOWED_ORIGINS",
            "https://dash.example.com",
        )],
    );
    let again = stdout_json(&again);
    assert_eq!(again["data"]["already_running"], true);
    assert_eq!(
        again["data"]["access_urls"],
        json!([format!(
            "https://dash.example.com/#dashboard-access-token={token}"
        )])
    );
    // Starting without the allowlist is a different configuration.
    let changed = stdout_json(&run_cli(
        &dash.d,
        &["--json", "dashboard", "start", "--port", &port_arg],
        &[],
    ));
    assert_eq!(
        changed,
        error_body(&format!(
            "Dashboard is already running with port {port} and https://dash.example.com. Run 'agent-browser dashboard stop' before starting it with different settings."
        ))
    );
}

// ---------------------------------------------------------------------------------------------------------------
// exec / sessions / kill

#[test]
fn exec_runs_the_command_for_the_dashboards_session_and_returns_its_output() {
    let dash = Dashboard::start(Daemon::start());
    let reply = dash.post("/api/exec", r##"{"args":["click","#go"]}"##);
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.header("content-type").as_deref(),
        Some("application/json; charset=utf-8")
    );
    assert!(reply.header("access-control-allow-origin").is_none());
    let body = reply.json();
    assert_eq!(body["success"], true, "{body}");
    assert_eq!(body["exit_code"], 0);
    assert_eq!(body["stderr"], "");
    let printed: Value = serde_json::from_str(body["stdout"].as_str().unwrap()).unwrap();
    assert_eq!(printed["success"], true);
    let seen = dash.d.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert_eq!(seen[0]["action"], "click");
    assert_eq!(seen[0]["selector"], "#go");

    // Non-string args are dropped, the rest still run.
    let reply = dash.post("/api/exec", r##"{"args":[7,"click","#two",null]}"##);
    assert_eq!(reply.json()["exit_code"], 0);
    assert_eq!(
        dash.d.seen.lock().unwrap().last().unwrap()["selector"],
        "#two"
    );
}

#[test]
fn exec_returns_the_failure_of_a_command_and_rejects_bad_bodies() {
    let dash = Dashboard::start(Daemon::start());
    dash.d
        .answer_with(|_| json!({"success": false, "error": "boom happened"}));
    let failed = dash.post("/api/exec", r##"{"args":["click","#go"]}"##);
    assert_eq!(failed.status, 200);
    let body = failed.json();
    assert_eq!(
        (body["success"].clone(), body["exit_code"].clone()),
        (json!(false), json!(1))
    );
    let printed = format!(
        "{}{}",
        body["stdout"].as_str().unwrap(),
        body["stderr"].as_str().unwrap()
    );
    assert!(printed.contains("boom happened"), "{body}");

    let bad = |body: &str, error: &str| {
        let reply = dash.post("/api/exec", body);
        assert_eq!(reply.status, 400, "{body}");
        assert_eq!(reply.json(), error_body(error), "{body}");
    };
    bad(
        "",
        "Invalid JSON: EOF while parsing a value at line 1 column 0",
    );
    bad(
        "{nope",
        "Invalid JSON: key must be a string at line 1 column 2",
    );
    bad("{}", "Missing \"args\" array");
    bad(r#"{"args":"click"}"#, "Missing \"args\" array");
    bad(r#"{"args":[]}"#, "Empty args array");
    bad(r#"{"args":[1,2]}"#, "Empty args array");

    dash.d.answer_with(|_| json!({"success": true, "data": {}}));
    // A body that arrives after its headers is read to its Content-Length.
    let body = r##"{"args":["click","#late"]}"##;
    let origin = format!("http://127.0.0.1:{}", dash.port);
    let full = request_text(dash.port, "POST", "/api/exec", &[("Origin", &origin)], body);
    let split = full.len() - body.len();
    let late = exchange(
        addr(dash.port),
        &[&full.as_bytes()[..split], &full.as_bytes()[split..]],
    );
    assert_eq!(late.json()["exit_code"], 0, "{}", late.dump());
    assert_eq!(
        dash.d.seen.lock().unwrap().last().unwrap()["selector"],
        "#late"
    );
    // Headers with no terminator carry no body.
    let headless = exchange(
        addr(dash.port),
        &[format!(
            "POST /api/exec HTTP/1.1\nHost: 127.0.0.1:{}\nOrigin: {origin}\n\n",
            dash.port
        )
        .as_bytes()],
    );
    assert_eq!(headless.status, 400);
    assert_eq!(
        headless.json(),
        error_body("Invalid JSON: EOF while parsing a value at line 1 column 0")
    );
}

#[test]
fn posting_a_session_answers_success_and_rejects_bad_names_and_bodies() {
    let dash = Dashboard::start(Daemon::start());
    let opened = dash.post("/api/sessions", r#"{"session":"surface"}"#);
    assert_eq!(opened.status, 200);
    assert_eq!(
        opened.json(),
        json!({"success": true, "session": "surface"})
    );
    // Upstream bug, pinned as it behaves: the `open` it spawns keeps AGENT_BROWSER_DASHBOARD from the server's
    // own environment (exec_cli strips it), so that process tries to become a second dashboard on the same port,
    // fails to bind and exits 0. The reply says success while no session was opened.
    assert!(dash.d.seen.lock().unwrap().is_empty());

    let bad = |body: &str, error: &str| {
        let reply = dash.post("/api/sessions", body);
        assert_eq!(
            (reply.status, reply.json()),
            (400, error_body(error)),
            "{body}"
        );
    };
    bad("nope", "Invalid JSON: expected ident at line 1 column 2");
    bad("{}", "Missing \"session\" field");
    bad(r#"{"session":7}"#, "Missing \"session\" field");
    bad(r#"{"session":""}"#, "Session name must be 1-64 UTF-8 bytes");
    bad(
        &json!({"session": "a".repeat(65)}).to_string(),
        "Session name must be 1-64 UTF-8 bytes",
    );
    bad(
        r#"{"session":"bad name"}"#,
        "Invalid session name 'bad name'. Only alphanumeric characters, hyphens, and underscores are allowed.",
    );
}

#[test]
fn kill_terminates_the_session_process_and_removes_its_daemon_files() {
    let dash = Dashboard::start(Daemon::start());
    let mut target = victim();
    let pid = target.0.id();
    let dir = dash.socket_dir();
    dash.register("doomed", 4100, pid);
    for ext in ["engine", "provider", "version"] {
        std::fs::write(dir.join(format!("doomed.{ext}")), "x").unwrap();
    }
    std::fs::write(dir.join("doomed.log"), "kept").unwrap();

    let reply = dash.post("/api/kill", r#"{"session":"doomed"}"#);
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json(), json!({"success": true, "killed_pid": pid}));
    let status = target.0.wait().unwrap();
    assert!(
        !status.success(),
        "the process was not signalled: {status:?}"
    );
    for ext in ["stream", "pid", "engine", "provider", "version"] {
        assert!(
            !dir.join(format!("doomed.{ext}")).exists(),
            "doomed.{ext} should be gone"
        );
    }
    // Files that are not the daemon's (its log) stay.
    assert_eq!(
        std::fs::read_to_string(dir.join("doomed.log")).unwrap(),
        "kept"
    );

    // A pid that no longer exists is still reported, and its files are cleaned up.
    dash.register("ghost", 4101, 999_999_999);
    let reply = dash.post("/api/kill", r#"{"session":"ghost"}"#);
    assert_eq!(
        reply.json(),
        json!({"success": true, "killed_pid": 999_999_999})
    );
    assert!(!dir.join("ghost.pid").exists());
}

#[test]
fn kill_rejects_bad_requests_without_signalling_anything() {
    let dash = Dashboard::start(Daemon::start());
    let dir = dash.socket_dir();
    std::fs::write(dir.join("broken.pid"), " nonsense \n").unwrap();
    let bad = |body: &str, error: &str| {
        let reply = dash.post("/api/kill", body);
        assert_eq!(
            (reply.status, reply.json()),
            (400, error_body(error)),
            "{body}"
        );
    };
    bad(
        "{",
        "Invalid JSON: EOF while parsing an object at line 1 column 1",
    );
    bad("{}", "Missing \"session\" field");
    bad(r#"{"session":""}"#, "Session name must be 1-64 UTF-8 bytes");
    bad(
        r#"{"session":"../etc"}"#,
        "Invalid session name '../etc'. Only alphanumeric characters, hyphens, and underscores are allowed.",
    );
    bad(
        r#"{"session":"nobody"}"#,
        "No PID file for session 'nobody'",
    );
    bad(r#"{"session":"broken"}"#, "Invalid PID in file: nonsense");
    assert!(dir.join("broken.pid").exists());
}

// ---------------------------------------------------------------------------------------------------------------
// session proxy

#[test]
fn session_tabs_and_status_are_proxied_to_the_session_port_with_its_status_and_type() {
    let session = upstream(|path| match path {
        "/api/tabs" => http_reply(
            "200 OK",
            "application/json",
            r#"[{"id":1,"url":"about:blank"}]"#,
        ),
        "/api/status" => http_reply("503 Service Unavailable", "text/plain", "busy"),
        _ => http_reply("404 Not Found", "text/plain", "?"),
    });
    let dash = Dashboard::start(Daemon::start());
    dash.register("proxied", session.port, std::process::id());

    let tabs = dash.get(&format!("/api/session/{}/tabs", session.port));
    assert_eq!(tabs.status_line(), "HTTP/1.1 200 OK");
    assert_eq!(
        tabs.header("content-type").as_deref(),
        Some("application/json")
    );
    assert_eq!(tabs.json(), json!([{"id": 1, "url": "about:blank"}]));
    assert!(tabs.header("access-control-allow-origin").is_none());

    let status = dash.get(&format!("/api/session/{}/status", session.port));
    assert_eq!(status.status_line(), "HTTP/1.1 503 Service Unavailable");
    assert_eq!(status.header("content-type").as_deref(), Some("text/plain"));
    assert_eq!(status.body_text(), "busy");

    let requests = session.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0],
        format!(
            "GET /api/tabs HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            session.port
        )
    );
    assert!(requests[1].starts_with("GET /api/status HTTP/1.1\r\n"));
}

#[test]
fn session_proxy_routes_that_are_malformed_or_unknown_get_exact_errors() {
    let dash = Dashboard::start(Daemon::start());
    let cases = [
        ("GET", "/api/session/", 400, "Missing session proxy port."),
        (
            "GET",
            "/api/session/4001",
            400,
            "Missing session proxy endpoint.",
        ),
        (
            "GET",
            "/api/session/4001/bogus",
            400,
            "Unknown session proxy endpoint.",
        ),
        (
            "GET",
            "/api/session/4001/tabs/extra",
            400,
            "Unexpected path segments in session proxy route.",
        ),
        (
            "GET",
            "/api/session/abc/tabs",
            400,
            "Session proxy port must be a valid TCP port.",
        ),
        (
            "GET",
            "/api/session/0/tabs",
            400,
            "Session proxy port must be a valid TCP port.",
        ),
        (
            "GET",
            "/api/session/70000/status",
            400,
            "Session proxy port must be a valid TCP port.",
        ),
        (
            "POST",
            "/api/session/4001/tabs",
            400,
            "Session proxy routes only support GET requests.",
        ),
        (
            "POST",
            "/api/session/4001/status",
            400,
            "Session proxy routes only support GET requests.",
        ),
        (
            "GET",
            "/api/session/4001/stream",
            400,
            "Session stream proxy requires a WebSocket upgrade request.",
        ),
        (
            "POST",
            "/api/session/4001/stream",
            400,
            "Session stream proxy only supports GET WebSocket upgrades.",
        ),
        (
            "GET",
            "/api/session/4001/tabs",
            404,
            "No active session is listening on port 4001.",
        ),
        (
            "GET",
            "/api/session/4001/status",
            404,
            "No active session is listening on port 4001.",
        ),
    ];
    for (method, path, status, error) in cases {
        let reply = dash.post_or_get(method, path);
        assert_eq!(reply.status, status, "{method} {path}: {}", reply.dump());
        assert_eq!(reply.json(), error_body(error), "{method} {path}");
    }
}

impl Dashboard {
    fn post_or_get(&self, method: &str, path: &str) -> Reply {
        same_origin(self.port, method, path, "")
    }
}

#[test]
fn session_proxy_reports_a_bad_gateway_for_unusable_upstream_answers() {
    let dash = Dashboard::start(Daemon::start());
    let me = std::process::id();
    let serve = |name: &str, raw: Vec<u8>| {
        let up = upstream(move |_| raw.clone());
        dash.register(name, up.port, me);
        up.port
    };
    let fetch = |port: u16| dash.get(&format!("/api/session/{port}/tabs"));

    let cut = serve("cut", b"HTTP/1.1 200 OK".to_vec());
    let reply = fetch(cut);
    assert_eq!(
        (reply.status, reply.json()),
        (
            502,
            error_body("Upstream response was missing an HTTP header terminator.")
        )
    );

    let no_status = serve("nostatus", b"HTTP/1.1\r\n\r\nx".to_vec());
    assert_eq!(
        fetch(no_status).json(),
        error_body("Upstream response status line was malformed.")
    );
    let empty_status = serve("emptystatus", b"HTTP/1.1 \r\nA: b\r\n\r\nx".to_vec());
    assert_eq!(
        fetch(empty_status).json(),
        error_body("Upstream response status line was malformed.")
    );

    let binary = serve(
        "binary",
        b"HTTP/1.1 200 OK\r\nX: \xff\xfe\r\n\r\n{}".to_vec(),
    );
    let reply = fetch(binary);
    assert_eq!(reply.status, 502);
    assert!(reply.json()["error"]
        .as_str()
        .unwrap()
        .starts_with("Upstream response headers were not valid UTF-8"));

    // LF-only framing is accepted, header names are case-insensitive, and a missing type defaults to JSON.
    let lf = serve(
        "lf",
        b"HTTP/1.1 200 OK\ncontent-TYPE: text/x-lf\n\nlf body".to_vec(),
    );
    let reply = fetch(lf);
    assert_eq!(
        (
            reply.status,
            reply.header("content-type").as_deref(),
            reply.body_text().as_str()
        ),
        (200, Some("text/x-lf"), "lf body")
    );
    let typeless = serve(
        "typeless",
        b"HTTP/1.1 201 Created\r\nX-Other: y\r\n\r\n{}".to_vec(),
    );
    let reply = fetch(typeless);
    assert_eq!(reply.status_line(), "HTTP/1.1 201 Created");
    assert_eq!(
        reply.header("content-type").as_deref(),
        Some("application/json; charset=utf-8")
    );

    // A registered session whose port nobody listens on.
    let closed = free_port();
    dash.register("closed", closed, me);
    let reply = fetch(closed);
    assert_eq!(reply.status, 502);
    assert!(reply.json()["error"]
        .as_str()
        .unwrap()
        .starts_with(&format!("Failed to connect to session {closed}: ")));

    // An answer over 16 MiB is refused.
    let mut huge = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
    huge.resize(16 * 1024 * 1024 + 64, b'a');
    let huge_port = serve("huge", huge);
    let reply = fetch(huge_port);
    assert_eq!(
        (reply.status, reply.json()),
        (
            502,
            error_body(&format!(
                "Session {huge_port} response exceeded 16777216 bytes."
            ))
        )
    );
}

// ---------------------------------------------------------------------------------------------------------------
// stream proxy

fn ws_request(
    port: u16,
    session_port: u16,
    origin: &str,
) -> tungstenite::handshake::client::Request {
    use tungstenite::client::IntoClientRequest;
    let mut request = format!("ws://127.0.0.1:{port}/api/session/{session_port}/stream")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", origin.parse().unwrap());
    request
}

fn read_text(
    ws: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
) -> String {
    loop {
        match ws.read().expect("websocket read") {
            Message::Text(t) => return t.to_string(),
            Message::Close(_) => panic!("closed before a text message"),
            _ => {}
        }
    }
}

#[test]
fn session_stream_is_bridged_both_ways_and_closes_from_either_side() {
    // A session stream that echoes text, and closes itself when told "bye".
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let session_port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(2) {
            let Ok(stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
            let Ok(mut ws) = tungstenite::accept(stream) else {
                continue;
            };
            loop {
                match ws.read() {
                    Ok(Message::Text(t)) if t.as_str() == "bye" => {
                        let _ = ws.close(None);
                        let _ = ws.flush();
                    }
                    Ok(Message::Text(t)) => {
                        let _ = ws.send(Message::text(format!("echo:{t}")));
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        }
    });
    let dash = Dashboard::start(Daemon::start());
    dash.register("streamer", session_port, std::process::id());
    let origin = format!("http://127.0.0.1:{}", dash.port);
    let connect = || {
        let (ws, response) = tungstenite::connect(ws_request(dash.port, session_port, &origin))
            .expect("dashboard handshake");
        assert_eq!(response.status().as_u16(), 101);
        let mut ws = ws;
        if let tungstenite::stream::MaybeTlsStream::Plain(s) = ws.get_mut() {
            s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        }
        ws
    };

    // The session closes first.
    let mut ws = connect();
    ws.send(Message::text("hi")).unwrap();
    assert_eq!(read_text(&mut ws), "echo:hi");
    ws.send(Message::text("bye")).unwrap();
    loop {
        match ws.read() {
            Ok(Message::Close(_))
            | Err(tungstenite::Error::ConnectionClosed)
            | Err(tungstenite::Error::AlreadyClosed)
            | Err(tungstenite::Error::Protocol(
                tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
            )) => break,
            Ok(_) => {}
            Err(e) => panic!("unexpected: {e}"),
        }
    }

    // The client closes first.
    let mut ws = connect();
    ws.send(Message::text("x")).unwrap();
    assert_eq!(read_text(&mut ws), "echo:x");
    ws.close(None).unwrap();
    loop {
        match ws.read() {
            Ok(_) => {}
            Err(tungstenite::Error::ConnectionClosed)
            | Err(tungstenite::Error::AlreadyClosed)
            | Err(tungstenite::Error::Protocol(
                tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
            )) => break,
            Err(e) => panic!("unexpected: {e}"),
        }
    }
}

#[test]
fn session_stream_upgrades_are_refused_for_foreign_origins_and_unusable_sessions() {
    let dash = Dashboard::start(Daemon::start());
    let port = dash.port;
    let upgrade = |path: &str, headers: &[(&str, &str)]| {
        let mut h = vec![("Upgrade", "websocket"), ("Connection", "Upgrade")];
        h.extend_from_slice(headers);
        send(port, "GET", path, &h, "")
    };
    let own = format!("http://127.0.0.1:{port}");
    let message = "Origin or dashboard access token is invalid.";

    let foreign = upgrade(
        "/api/session/4001/stream",
        &[("Origin", "https://evil.example")],
    );
    assert_eq!((foreign.status, foreign.json()), (403, error_body(message)));
    let rebound = upgrade("/api/session/4001/stream", &[("Host", "evil.example")]);
    assert_eq!((rebound.status, rebound.json()), (403, error_body(message)));

    // A client that sends no Origin is trusted only through a loopback Host.
    let no_session = upgrade("/api/session/4001/stream", &[]);
    assert_eq!(
        (no_session.status, no_session.json()),
        (
            404,
            error_body("No active session is listening on port 4001.")
        )
    );
    let with_origin = upgrade("/api/session/4001/stream", &[("Origin", &own)]);
    assert_eq!(with_origin.status, 404);

    // A session that is listed but does not speak WebSocket.
    let plain = upstream(|_| http_reply("200 OK", "text/plain", "not a websocket"));
    dash.register("plain", plain.port, std::process::id());
    let reply = upgrade(
        &format!("/api/session/{}/stream", plain.port),
        &[("Origin", &own)],
    );
    assert_eq!(reply.status, 502);
    assert!(
        reply.json()["error"]
            .as_str()
            .unwrap()
            .starts_with(&format!("Failed to connect to session {}: ", plain.port)),
        "{}",
        reply.dump()
    );
}

// ---------------------------------------------------------------------------------------------------------------
// static files

#[test]
fn static_paths_serve_the_embedded_dashboard_page_and_fall_back_to_it() {
    let dash = Dashboard::start(Daemon::start());
    let index = dash.get("/");
    assert_eq!(index.status_line(), "HTTP/1.1 200 OK");
    assert_eq!(
        index.header("content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        index.header("content-length"),
        Some(index.body.len().to_string())
    );
    assert!(
        index.body_text().contains("<html"),
        "{}",
        &index.body_text()[..80.min(index.body.len())]
    );
    for path in [
        "/index.html",
        "/?port=1",
        "/#frag",
        "/sessions/alpha",
        "/_next/static/missing.js",
        "/favicon.ico",
        "/api/not-a-route",
    ] {
        let reply = dash.get(path);
        assert_eq!(reply.status, 200, "{path}");
        assert_eq!(
            reply.header("content-type").as_deref(),
            Some("text/html; charset=utf-8"),
            "{path}"
        );
        assert_eq!(reply.body, index.body, "{path}");
    }
}
