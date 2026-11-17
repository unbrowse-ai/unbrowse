use crate::validation::{is_valid_session_name, sanitize_session_component, session_name_error};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(windows)]
use windows_sys::Win32::Foundation::CloseHandle;
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

pub(crate) const INTERNAL_DAEMON_SHUTDOWN_ACTION: &str = "__agent_browser_internal_shutdown";

#[derive(Serialize)]
#[allow(dead_code)]
pub struct Request {
    pub id: String,
    pub action: String,
    #[serde(flatten)]
    pub extra: Value,
}

#[derive(Deserialize, Serialize, Default)]
pub struct Response {
    pub success: bool,
    pub data: Option<Value>,
    pub error: Option<String>,
    /// Machine-readable error code for select failures (e.g. `tab_gone`
    /// when a pinned session's bound tab no longer exists).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[allow(dead_code)]
pub enum Connection {
    #[cfg(unix)]
    Unix(UnixStream),
    Tcp(TcpStream),
}

impl Read for Connection {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.read(buf),
            Connection::Tcp(s) => s.read(buf),
        }
    }
}

impl Write for Connection {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.write(buf),
            Connection::Tcp(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.flush(),
            Connection::Tcp(s) => s.flush(),
        }
    }
}

impl Connection {
    pub fn set_read_timeout(&self, dur: Option<Duration>) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.set_read_timeout(dur),
            Connection::Tcp(s) => s.set_read_timeout(dur),
        }
    }

    pub fn set_write_timeout(&self, dur: Option<Duration>) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.set_write_timeout(dur),
            Connection::Tcp(s) => s.set_write_timeout(dur),
        }
    }
}

/// Get the base directory for socket/pid files.
/// Priority: AGENT_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR > ~/.agent-browser > tmpdir
pub fn get_socket_dir() -> PathBuf {
    // 1. Explicit override (ignore empty string)
    let base = if let Ok(dir) = env::var("AGENT_BROWSER_SOCKET_DIR") {
        if !dir.is_empty() {
            PathBuf::from(dir)
        } else if let Ok(runtime_dir) = env::var("XDG_RUNTIME_DIR") {
            if !runtime_dir.is_empty() {
                PathBuf::from(runtime_dir).join("agent-browser")
            } else if let Some(home) = dirs::home_dir() {
                home.join(".agent-browser")
            } else {
                env::temp_dir().join("agent-browser")
            }
        } else if let Some(home) = dirs::home_dir() {
            home.join(".agent-browser")
        } else {
            env::temp_dir().join("agent-browser")
        }
    } else if let Ok(runtime_dir) = env::var("XDG_RUNTIME_DIR") {
        if !runtime_dir.is_empty() {
            PathBuf::from(runtime_dir).join("agent-browser")
        } else if let Some(home) = dirs::home_dir() {
            home.join(".agent-browser")
        } else {
            env::temp_dir().join("agent-browser")
        }
    } else if let Some(home) = dirs::home_dir() {
        home.join(".agent-browser")
    } else {
        env::temp_dir().join("agent-browser")
    };

    if let Ok(namespace) = env::var("AGENT_BROWSER_NAMESPACE") {
        let namespace = sanitize_session_component(&namespace);
        if !namespace.is_empty() {
            return base.join("namespaces").join(namespace).join("run");
        }
    }

    base
}

#[cfg(unix)]
fn get_socket_path(session: &str) -> PathBuf {
    get_socket_dir().join(format!("{}.sock", session))
}

fn get_pid_path(session: &str) -> PathBuf {
    get_socket_dir().join(format!("{}.pid", session))
}

/// Beside a session's `.pid`: when the process that wrote it started ([`process_started`]). A pid alone names whatever
/// has that number now; the number and its start time together name one process, for as long as it lives.
fn get_started_path(session: &str) -> PathBuf {
    get_socket_dir().join(format!("{}.started", session))
}

fn get_version_path(session: &str) -> PathBuf {
    get_socket_dir().join(format!("{}.version", session))
}

fn get_config_path(session: &str) -> PathBuf {
    get_socket_dir().join(format!("{}.config", session))
}

/// Clean up stale socket and PID files for a session
/// A session name becomes a file name in the socket dir (`<session>.sock`,
/// `.pid`, `.config`, ...), so only a name that is one plain path component
/// may reach those paths.
pub fn check_session_name(session: &str) -> Result<(), String> {
    if session == DASHBOARD_CLAIM {
        return Err(format!("'{session}' is the name of the dashboard's own files: choose another session name"));
    }
    if is_valid_session_name(session) {
        Ok(())
    } else {
        Err(session_name_error(session))
    }
}

pub fn cleanup_stale_files(session: &str) {
    if check_session_name(session).is_err() {
        return;
    }
    // Held for the removing too: a daemon starting now can't write a file for this to take away.
    if let Some(_nobody_else) = claim_session(session) {
        remove_session_files(session);
    }
}

/// The files a daemon's session has in the socket dir, besides its `.lock` (see `claim_session`).
const SESSION_FILES: &[&str] = &[
    "pid",
    "started",
    "version",
    "config",
    "stream",
    "stream-token",
    "engine",
    "provider",
    "extensions",
    #[cfg(unix)]
    "sock",
    #[cfg(windows)]
    "port",
];

/// Removes a session's files. Only for whoever holds the session (`claim_session`): its daemon, or a process that
/// has found it has none.
pub fn remove_session_files(session: &str) {
    let dir = get_socket_dir();
    for extension in SESSION_FILES {
        let _ = fs::remove_file(dir.join(format!("{session}.{extension}")));
    }
}

/// A session's ownership, for as long as this is held. The operating system lets go of it when the holder dies, however
/// it dies, so unlike any file's presence it can't outlive its process, and no pid can be reused behind it.
pub struct SessionClaim {
    _lock: Option<fs::File>,
}

/// The `.lock` file stays in the socket dir: removing it would let two processes hold two different files of one name.
fn session_lock(session: &str) -> std::io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(get_socket_dir().join(format!("{session}.lock")))
}

/// Claims a session, or None while another process holds it. A socket dir that can't hold a lock (no directory yet, a
/// filesystem without locks) says nobody holds it, and each process then acts as it would with no lock at all.
pub fn claim_session(session: &str) -> Option<SessionClaim> {
    let Ok(lock) = session_lock(session) else {
        return Some(SessionClaim { _lock: None });
    };
    match lock.try_lock() {
        Ok(()) => Some(SessionClaim { _lock: Some(lock) }),
        Err(fs::TryLockError::WouldBlock) => None,
        Err(fs::TryLockError::Error(_)) => Some(SessionClaim { _lock: None }),
    }
}

/// Whether a live process holds the session: its daemon, starting, running or on its way out.
pub fn session_held(session: &str) -> bool {
    claim_session(session).is_none()
}

/// The name the standalone dashboard holds, as a daemon holds its session. It is no session's name
/// (`check_session_name`), so the two can't be taken for each other.
pub const DASHBOARD_CLAIM: &str = "dashboard";

/// Whether the process `pid` is the dashboard. A dashboard just started takes its claim a moment after its pid file is
/// written, so a process that is there is given that moment.
pub fn is_dashboard(pid: u32) -> bool {
    let started = get_socket_dir().join(format!("{DASHBOARD_CLAIM}.started"));
    let deadline = Instant::now() + Duration::from_secs(1);
    while is_pid_alive(pid) && Instant::now() < deadline {
        if session_held(DASHBOARD_CLAIM) {
            return is_recorded_process(pid, &started);
        }
        thread::sleep(Duration::from_millis(25));
    }
    session_held(DASHBOARD_CLAIM) && is_recorded_process(pid, &started)
}

/// The pid of the process known to be this session's daemon. A `.pid` file alone names whatever now has that number,
/// and the session being held proves only that *some* process holds it (a daemon starting, a CLI cleaning up) while
/// the file may still be a dead daemon's: the pid is the daemon's only when the live process with that number is the
/// very one that wrote it, started when its `.started` says.
pub fn owned_daemon_pid(session: &str) -> Option<u32> {
    let pid = session_held(session).then(|| daemon_pid(session)).flatten()?;
    is_recorded_process(pid, &get_started_path(session)).then_some(pid)
}

/// When the process `pid` started, as the system keeps it: what tells a process from a later one given the same
/// number ([`agent_browser_core::process::started`]).
pub fn process_started(pid: u32) -> Option<u64> {
    agent_browser_core::process::started(pid)
}

/// Records, at `path`, the process `pid` as the one a pid file beside it names. A system that can't say when a process
/// started records nothing, and nothing then proves the pid file's process to anyone: it is never signalled.
pub fn record_process(pid: u32, path: &std::path::Path) {
    if let Some(started) = process_started(pid) {
        let _ = fs::write(path, started.to_string());
    }
}

/// Whether the live process `pid` is the very one recorded at `path` ([`record_process`]): the same number, started at
/// the same moment. A record that is missing, unreadable or for another start says no, so a pid a file kept after its
/// process died never reaches whatever has the number now.
pub fn is_recorded_process(pid: u32, path: &std::path::Path) -> bool {
    let recorded = fs::read_to_string(path).ok().and_then(|s| s.trim().parse::<u64>().ok());
    recorded.is_some() && process_started(pid) == recorded
}

/// Returns whether a process with the given PID is currently alive.
///
/// On unix, EPERM (process exists but we can't signal it) counts as alive
/// so we don't mis-clean a live daemon owned by a different uid. Only ESRCH
/// ("no such process") is treated as dead.
pub fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        if libc::kill(pid as i32, 0) == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle != 0 {
            CloseHandle(handle);
            true
        } else {
            false
        }
    }
}

/// The pid a session's daemon wrote, while its `.pid` file is there.
pub fn daemon_pid(session: &str) -> Option<u32> {
    fs::read_to_string(get_pid_path(session)).ok()?.trim().parse().ok()
}

/// A daemon answers `close` before it exits: for a moment after the answer its
/// socket still takes a connection it then drops (the next command fails with
/// no response, and a command that may have run is never retried), and its
/// exit removes the socket a new daemon for the session would have bound.
/// So a close is done only once the daemon that answered is gone: its socket
/// refuses, its `.pid` file is removed, and the process `pid` has exited.
/// Bounded by `timeout`; false when it ran out.
pub fn wait_for_daemon_exit(session: &str, pid: Option<u32>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let gone = !daemon_ready(session)
            && !get_pid_path(session).exists()
            && pid.is_none_or(|p| !is_pid_alive(p));
        if gone {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A currently-running daemon session discovered by [`walk_daemons`].
#[derive(Debug, Clone)]
pub struct ActiveSession {
    pub name: String,
    pub pid: u32,
    /// Contents of the session's `.version` file if present and non-empty.
    pub version: Option<String>,
}

/// Why a session's sidecar files were cleaned up during a walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanReason {
    /// The `.pid` file referenced a process that no longer exists.
    ProcessGone,
    /// The `.pid` file could not be parsed as a PID.
    UnreadablePidFile,
    /// A `.sock` file had no corresponding `.pid` file (unix only).
    OrphanedSocket,
    /// The `dashboard.pid` referenced a process that no longer exists.
    DashboardGone,
}

/// A session whose sidecar files were removed as a side effect of a walk.
#[derive(Debug, Clone)]
pub struct CleanedSession {
    pub name: String,
    pub reason: CleanReason,
}

/// Information about the standalone dashboard process, if any.
#[derive(Debug, Clone, Copy)]
pub struct DashboardInfo {
    pub pid: u32,
    pub alive: bool,
}

/// Snapshot of daemon state under [`get_socket_dir()`] after a walk. Stale
/// sidecar files are cleaned up as a side effect and recorded in `cleaned`.
#[derive(Debug, Default)]
pub struct DaemonInventory {
    pub sessions: Vec<ActiveSession>,
    pub cleaned: Vec<CleanedSession>,
    pub dashboard: Option<DashboardInfo>,
}

/// Read the session's `.version` sidecar if present and non-empty.
pub fn read_session_version(session: &str) -> Option<String> {
    let path = get_socket_dir().join(format!("{}.version", session));
    fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Walk the socket directory and classify each `.pid` / `.sock` entry.
///
/// - Live daemons go into `sessions` with their `.version` file contents.
/// - Stale entries (process gone, unreadable pid, orphaned `.sock`) are
///   cleaned via [`cleanup_stale_files`] and recorded in `cleaned`.
/// - `dashboard.pid` lands in `dashboard` with liveness info; if the
///   process is gone, the pid file is removed and a `DashboardGone` entry
///   is added to `cleaned`.
///
/// If the socket directory doesn't exist, returns an empty inventory with
/// no side effects.
pub fn walk_daemons() -> DaemonInventory {
    let socket_dir = get_socket_dir();
    let mut inventory = DaemonInventory::default();

    let entries = match fs::read_dir(&socket_dir) {
        Ok(e) => e,
        Err(_) => return inventory,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        if name == "dashboard.pid" {
            if let Ok(s) = fs::read_to_string(entry.path()) {
                if let Ok(pid) = s.trim().parse::<u32>() {
                    let alive = is_pid_alive(pid);
                    inventory.dashboard = Some(DashboardInfo { pid, alive });
                    if !alive {
                        let _ = fs::remove_file(entry.path());
                        let _ = fs::remove_file(socket_dir.join("dashboard.config"));
                        inventory.cleaned.push(CleanedSession {
                            name: "dashboard".to_string(),
                            reason: CleanReason::DashboardGone,
                        });
                    }
                }
            }
            continue;
        }

        let session_name = match name.strip_suffix(".pid") {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };

        let pid = match fs::read_to_string(entry.path())
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
        {
            Some(p) => p,
            None => {
                cleanup_stale_files(&session_name);
                inventory.cleaned.push(CleanedSession {
                    name: session_name,
                    reason: CleanReason::UnreadablePidFile,
                });
                continue;
            }
        };

        if !is_pid_alive(pid) {
            cleanup_stale_files(&session_name);
            inventory.cleaned.push(CleanedSession {
                name: session_name,
                reason: CleanReason::ProcessGone,
            });
            continue;
        }

        let version = read_session_version(&session_name);
        inventory.sessions.push(ActiveSession {
            name: session_name,
            pid,
            version,
        });
    }

    // Orphaned .sock files without a corresponding .pid (unix only).
    #[cfg(unix)]
    if let Ok(entries) = fs::read_dir(&socket_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(session_name) = name.strip_suffix(".sock") {
                if session_name.is_empty() {
                    continue;
                }
                let pid_path = socket_dir.join(format!("{}.pid", session_name));
                if !pid_path.exists() {
                    cleanup_stale_files(session_name);
                    inventory.cleaned.push(CleanedSession {
                        name: session_name.to_string(),
                        reason: CleanReason::OrphanedSocket,
                    });
                }
            }
        }
    }

    inventory
}

#[cfg(windows)]
fn get_port_path(session: &str) -> PathBuf {
    get_socket_dir().join(format!("{}.port", session))
}

/// A command as the session's daemon takes it. On Windows its door is a loopback port anyone on the machine can reach,
/// so it takes a command only with the key it wrote, owner-only, beside its port file. A Unix socket is the owner's
/// already, by its folder and its mode.
pub fn for_the_door(cmd: &Value, session: &str) -> Value {
    #[cfg(windows)]
    {
        let mut cmd = cmd.clone();
        if let Some(key) = crate::owner_only::read_key(&get_socket_dir().join(format!("{}.key", session))) {
            cmd[crate::owner_only::DOOR_KEY_FIELD] = json!(key);
        }
        cmd
    }
    #[cfg(not(windows))]
    {
        let _ = session;
        cmd.clone()
    }
}

#[cfg(windows)]
fn port_identity_for_session(session: &str) -> String {
    if let Ok(namespace) = env::var("AGENT_BROWSER_NAMESPACE") {
        let namespace = sanitize_session_component(&namespace);
        if !namespace.is_empty() {
            return format!("{}:{}", namespace, session);
        }
    }
    session.to_string()
}

#[cfg(windows)]
pub fn get_port_for_session(session: &str) -> u16 {
    let mut hash: i32 = 0;
    for c in port_identity_for_session(session).chars() {
        hash = ((hash << 5).wrapping_sub(hash)).wrapping_add(c as i32);
    }
    // Correct logic: first take absolute modulo, then cast to u16
    // Using unsigned_abs() to safely handle i32::MIN
    49152 + ((hash.unsigned_abs() as u32 % 16383) as u16)
}

/// Read the actual daemon port from the `.port` file written by the daemon.
/// Falls back to the hash-derived port if the file does not exist or is
/// unreadable (e.g. daemon has not started yet).
#[cfg(windows)]
pub fn resolve_port(session: &str) -> u16 {
    let port_path = get_port_path(session);
    fs::read_to_string(&port_path)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .unwrap_or_else(|| get_port_for_session(session))
}

pub fn daemon_ready(session: &str) -> bool {
    #[cfg(unix)]
    {
        let socket_path = get_socket_path(session);
        UnixStream::connect(&socket_path).is_ok()
    }
    // Only the port the daemon wrote: the name-derived one is a number anything on the machine may be listening on.
    #[cfg(windows)]
    {
        let Some(port) = fs::read_to_string(get_port_path(session))
            .ok()
            .and_then(|s| s.trim().parse::<u16>().ok())
        else {
            return false;
        };
        TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(50),
        )
        .is_ok()
    }
}

/// Result of ensure_daemon indicating whether a new daemon was started
pub struct DaemonResult {
    /// True if we connected to an existing daemon, false if we started a new one
    pub already_running: bool,
    /// True if an existing daemon was intentionally restarted to satisfy
    /// current daemon-only configuration.
    pub restarted: bool,
}

/// Options forwarded to the daemon process as environment variables.
/// Note: `confirm_interactive` is intentionally absent -- it is a CLI-side
/// UX concern (prompting the user on stdin) and not a daemon configuration.
/// The daemon only needs `confirm_actions` to gate action categories.
pub struct DaemonOptions<'a> {
    pub headed: bool,
    pub debug: bool,
    pub executable_path: Option<&'a str>,
    pub extensions: &'a [String],
    pub init_scripts: &'a [String],
    pub enable: &'a [String],
    pub args: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub proxy: Option<&'a str>,
    pub proxy_bypass: Option<&'a str>,
    pub proxy_username: Option<&'a str>,
    pub proxy_password: Option<&'a str>,
    pub ignore_https_errors: bool,
    pub allow_file_access: bool,
    pub hide_scrollbars: bool,
    pub webgpu: bool,
    pub profile: Option<&'a str>,
    pub state: Option<&'a str>,
    pub provider: Option<&'a str>,
    pub device: Option<&'a str>,
    pub session_name: Option<&'a str>,
    pub restore_save: Option<&'a str>,
    pub restore_check_url: Option<&'a str>,
    pub restore_check_text: Option<&'a str>,
    pub restore_check_fn: Option<&'a str>,
    pub download_path: Option<&'a str>,
    pub allowed_domains: Option<&'a [String]>,
    pub action_policy: Option<&'a str>,
    pub confirm_actions: Option<&'a str>,
    pub engine: Option<&'a str>,
    pub auto_connect: bool,
    pub pin_tab: bool,
    pub idle_timeout: Option<&'a str>,
    pub default_timeout: Option<u64>,
    pub cdp: Option<&'a str>,
    pub no_auto_dialog: bool,
    pub no_console: bool,
    pub plugins: Option<&'a str>,
}

fn apply_daemon_env(cmd: &mut Command, session: &str, opts: &DaemonOptions) {
    cmd.env("AGENT_BROWSER_DAEMON", "1")
        .env("AGENT_BROWSER_SESSION", session)
        .env(DAEMON_CONFIG_ENV, daemon_config_fingerprint(opts));

    if opts.headed {
        cmd.env("AGENT_BROWSER_HEADED", "1");
    }
    if opts.debug {
        cmd.env("AGENT_BROWSER_DEBUG", "1");
    }
    if let Some(path) = opts.executable_path {
        cmd.env("AGENT_BROWSER_EXECUTABLE_PATH", path);
    }
    if !opts.extensions.is_empty() {
        cmd.env("AGENT_BROWSER_EXTENSIONS", opts.extensions.join(","));
    }
    if !opts.init_scripts.is_empty() {
        cmd.env("AGENT_BROWSER_INIT_SCRIPTS", opts.init_scripts.join(","));
    }
    if !opts.enable.is_empty() {
        cmd.env("AGENT_BROWSER_ENABLE", opts.enable.join(","));
    }
    if let Some(a) = opts.args {
        cmd.env("AGENT_BROWSER_ARGS", a);
    }
    if let Some(ua) = opts.user_agent {
        cmd.env("AGENT_BROWSER_USER_AGENT", ua);
    }
    if let Some(p) = opts.proxy {
        cmd.env("AGENT_BROWSER_PROXY", p);
    }
    if let Some(pb) = opts.proxy_bypass {
        cmd.env("AGENT_BROWSER_PROXY_BYPASS", pb);
    }
    if let Some(pu) = opts.proxy_username {
        cmd.env("AGENT_BROWSER_PROXY_USERNAME", pu);
    }
    if let Some(pp) = opts.proxy_password {
        cmd.env("AGENT_BROWSER_PROXY_PASSWORD", pp);
    }
    if opts.ignore_https_errors {
        cmd.env("AGENT_BROWSER_IGNORE_HTTPS_ERRORS", "1");
    }
    if opts.allow_file_access {
        cmd.env("AGENT_BROWSER_ALLOW_FILE_ACCESS", "1");
    }
    cmd.env(
        "AGENT_BROWSER_HIDE_SCROLLBARS",
        if opts.hide_scrollbars { "1" } else { "0" },
    );
    if opts.webgpu {
        cmd.env("AGENT_BROWSER_WEBGPU", "1");
    }
    if let Some(prof) = opts.profile {
        cmd.env("AGENT_BROWSER_PROFILE", prof);
    }
    if let Some(st) = opts.state {
        cmd.env("AGENT_BROWSER_STATE", st);
    }
    if let Some(p) = opts.provider {
        cmd.env("AGENT_BROWSER_PROVIDER", p);
    }
    if let Some(d) = opts.device {
        cmd.env("AGENT_BROWSER_IOS_DEVICE", d);
    }
    if let Some(sn) = opts.session_name {
        cmd.env("AGENT_BROWSER_SESSION_NAME", sn);
    }
    if let Some(policy) = opts.restore_save {
        cmd.env("AGENT_BROWSER_RESTORE_SAVE", policy);
    }
    if let Some(check) = opts.restore_check_url {
        cmd.env("AGENT_BROWSER_RESTORE_CHECK_URL", check);
    }
    if let Some(check) = opts.restore_check_text {
        cmd.env("AGENT_BROWSER_RESTORE_CHECK_TEXT", check);
    }
    if let Some(check) = opts.restore_check_fn {
        cmd.env("AGENT_BROWSER_RESTORE_CHECK_FN", check);
    }
    if let Some(dp) = opts.download_path {
        cmd.env("AGENT_BROWSER_DOWNLOAD_PATH", dp);
    }
    if let Some(ad) = opts.allowed_domains {
        cmd.env("AGENT_BROWSER_ALLOWED_DOMAINS", ad.join(","));
    }
    if let Some(ap) = opts.action_policy {
        cmd.env("AGENT_BROWSER_ACTION_POLICY", ap);
    }
    if let Some(ca) = opts.confirm_actions {
        cmd.env("AGENT_BROWSER_CONFIRM_ACTIONS", ca);
    }
    if let Some(engine) = opts.engine {
        cmd.env("AGENT_BROWSER_ENGINE", engine);
    }
    if opts.auto_connect {
        cmd.env("AGENT_BROWSER_AUTO_CONNECT", "1");
    }
    if opts.pin_tab {
        cmd.env("AGENT_BROWSER_PIN_TAB", "1");
    }
    if let Some(idle) = opts.idle_timeout {
        cmd.env("AGENT_BROWSER_IDLE_TIMEOUT_MS", idle);
    }
    if let Some(timeout) = opts.default_timeout {
        cmd.env("AGENT_BROWSER_DEFAULT_TIMEOUT", timeout.to_string());
    }
    if let Some(cdp) = opts.cdp {
        cmd.env("AGENT_BROWSER_CDP", cdp);
    }
    if opts.no_auto_dialog {
        cmd.env("AGENT_BROWSER_NO_AUTO_DIALOG", "1");
    }
    if opts.no_console {
        cmd.env("AGENT_BROWSER_NO_CONSOLE", "1");
    }
    if let Some(plugins) = opts.plugins {
        cmd.env("AGENT_BROWSER_PLUGINS", plugins);
    }
}

/// The fingerprint of what a daemon was started with. The daemon writes it down itself, before it listens: a CLI that
/// wrote it afterwards could die first, and the next one would read the missing file as a reason to stop a healthy
/// daemon.
pub const DAEMON_CONFIG_ENV: &str = "AGENT_BROWSER_DAEMON_CONFIG";

fn daemon_config_fingerprint(opts: &DaemonOptions) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    opts.debug.hash(&mut hasher);
    opts.action_policy.hash(&mut hasher);
    opts.confirm_actions.hash(&mut hasher);
    opts.idle_timeout.hash(&mut hasher);
    opts.default_timeout.hash(&mut hasher);
    opts.no_auto_dialog.hash(&mut hasher);
    opts.no_console.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DaemonConfigStatus {
    Matches,
    Missing,
    Different,
}

fn daemon_config_status(session: &str, opts: &DaemonOptions) -> DaemonConfigStatus {
    let expected = daemon_config_fingerprint(opts);
    match fs::read_to_string(get_config_path(session)) {
        Ok(actual) if actual.trim() == expected => DaemonConfigStatus::Matches,
        Ok(_) => DaemonConfigStatus::Different,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DaemonConfigStatus::Missing,
        // A file that can't be read says nothing about the daemon, and going on as it is costs nothing: a restart would
        // cost the session its browser and pages.
        Err(_) => DaemonConfigStatus::Matches,
    }
}

fn daemon_config_matches(session: &str, opts: &DaemonOptions) -> bool {
    daemon_config_status(session, opts) == DaemonConfigStatus::Matches
}

fn write_daemon_config(session: &str, opts: &DaemonOptions) {
    let _ = fs::write(get_config_path(session), daemon_config_fingerprint(opts));
}

fn daemon_pid_matches(session: &str, expected_pid: u32) -> bool {
    fs::read_to_string(get_pid_path(session))
        .ok()
        .and_then(|pid| pid.trim().parse::<u32>().ok())
        == Some(expected_pid)
}

fn ready_spawned_daemon_result(
    session: &str,
    opts: &DaemonOptions,
    spawned_pid: Option<u32>,
    restarted: bool,
) -> Option<DaemonResult> {
    if spawned_pid.is_some_and(|pid| daemon_pid_matches(session, pid)) {
        write_daemon_config(session, opts);
        return Some(DaemonResult {
            already_running: false,
            restarted,
        });
    }

    if daemon_config_matches(session, opts) {
        return Some(DaemonResult {
            already_running: true,
            restarted,
        });
    }

    None
}

fn ready_existing_daemon_result(
    session: &str,
    opts: &DaemonOptions,
    timeout: Duration,
) -> Option<DaemonResult> {
    match daemon_config_status(session, opts) {
        DaemonConfigStatus::Matches => Some(DaemonResult {
            already_running: true,
            restarted: false,
        }),
        DaemonConfigStatus::Missing => {
            if wait_for_matching_ready_daemon(session, opts, timeout) {
                Some(DaemonResult {
                    already_running: true,
                    restarted: false,
                })
            } else {
                None
            }
        }
        DaemonConfigStatus::Different => None,
    }
}

fn wait_for_matching_ready_daemon(session: &str, opts: &DaemonOptions, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if daemon_config_matches(session, opts) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    daemon_config_matches(session, opts)
}

fn concurrent_daemon_config_error(session: &str) -> String {
    format!(
        "A daemon for session '{}' started concurrently with different daemon configuration. Retry the command so agent-browser can restart it with the requested configuration.",
        session
    )
}

/// Check if the running daemon's version matches this CLI binary.
/// Returns false when the version file is missing — an unversioned daemon
/// is most likely a stale leftover from before version tracking was added
/// (or from the Node.js era), and silently reusing it is the exact bug
/// this check exists to prevent. The one-time cost of an unnecessary
/// restart on the first upgrade is preferable to silent failures.
fn daemon_version_matches(session: &str) -> bool {
    let version_path = get_version_path(session);
    match fs::read_to_string(&version_path) {
        Ok(v) => v.trim() == env!("CARGO_PKG_VERSION"),
        Err(_) => false,
    }
}

/// Stops a session's daemon. Only a process proved to be it is signalled (`owned_daemon_pid`): a pid file read on its
/// own may name anything by now. A daemon from before sessions were held proves nothing, and goes by `close` or not at
/// all.
pub fn kill_stale_daemon(session: &str) {
    if let Some(pid) = owned_daemon_pid(session) {
        #[cfg(unix)]
        {
            let started = get_started_path(session);
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            // Wait up to 1s for graceful shutdown, then force-kill
            for _ in 0..10 {
                thread::sleep(Duration::from_millis(100));
                if !is_recorded_process(pid, &started) {
                    break;
                }
            }
            // Forced only while the number is still the daemon's: a daemon that went has left its number to anyone,
            // and the session may be held by another process by now.
            if is_recorded_process(pid, &started) {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            thread::sleep(Duration::from_millis(500));
        }
    }

    // Leftovers go; a daemon that outlived all of the above keeps its own.
    cleanup_stale_files(session);
}

/// How long a session held by a process that doesn't answer is given to answer: past the time `ensure_daemon` gives a
/// daemon it started, so a slow start another command is waiting on isn't taken for a dead one.
const HELD_SESSION_WAIT: Duration = Duration::from_secs(10);

/// A session held by a daemon nothing can reach yet: it is starting or leaving, and answers or lets go soon. One that
/// does neither has lost its socket and can't be reached by anyone, so it is stopped: nothing else would ever end it,
/// and no new daemon can start beside it.
fn settle_held_session(session: &str) {
    let deadline = Instant::now() + HELD_SESSION_WAIT;
    while Instant::now() < deadline {
        if daemon_ready(session) || !session_held(session) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    kill_stale_daemon(session);
}

fn request_graceful_daemon_shutdown(session: &str) -> bool {
    let close_cmd = json!({
        "id": "restart-close",
        "action": INTERNAL_DAEMON_SHUTDOWN_ACTION
    });

    let pid = daemon_pid(session);
    match send_command(close_cmd, session) {
        Ok(resp) if resp.success => wait_for_daemon_exit(session, pid, Duration::from_secs(5)),
        _ => false,
    }
}

fn stop_existing_daemon_for_restart(session: &str) {
    if !request_graceful_daemon_shutdown(session) {
        kill_stale_daemon(session);
    }
}

pub fn ensure_daemon(session: &str, opts: &DaemonOptions) -> Result<DaemonResult, String> {
    check_session_name(session)?;
    let mut restarted = false;

    if !daemon_ready(session) && session_held(session) {
        settle_held_session(session);
    }

    // Socket connectivity is the sole liveness check — no PID check — so
    // callers in a different PID namespace (e.g. unshare) can still reuse
    // an existing daemon they can reach over the socket.
    //
    // No settle-sleep here: this runs on every CLI invocation, so a fixed
    // delay would tax every command (a 150ms sleep used to dominate warm
    // command latency). The rare race where the daemon exits right after
    // this check is handled at request time: callers respawn via
    // ensure_daemon when the request fails with daemon_unreachable().
    if daemon_ready(session) {
        // Check version: if the running daemon is from a different CLI
        // version (e.g. after an upgrade), kill it and start a fresh one.
        if !daemon_version_matches(session) {
            eprintln!(
                "{} Daemon version mismatch detected, restarting...",
                crate::color::warning_indicator()
            );
            stop_existing_daemon_for_restart(session);
            restarted = true;
            // Fall through to spawn a new daemon below
        } else {
            match ready_existing_daemon_result(session, opts, Duration::from_secs(1)) {
                Some(result) => return Ok(result),
                None => {
                    // The session's browser goes with it, so this isn't done without saying.
                    eprintln!(
                        "{} Session '{}' was started with different settings, restarting it...",
                        crate::color::warning_indicator(),
                        session
                    );
                    stop_existing_daemon_for_restart(session);
                    restarted = true;
                }
            }
        }
    }

    // Clean up any stale socket/pid files before starting fresh
    cleanup_stale_files(session);

    // Ensure socket directory exists
    let socket_dir = get_socket_dir();
    if !socket_dir.exists() {
        fs::create_dir_all(&socket_dir)
            .map_err(|e| format!("Failed to create socket directory: {}", e))?;
    }

    // Pre-flight check: Validate socket path length (Unix limit is 104 bytes including null terminator)
    #[cfg(unix)]
    {
        let socket_path = get_socket_path(session);
        let path_len = socket_path.as_os_str().len();
        if path_len > 103 {
            return Err(format!(
                "Session name '{}' is too long. Socket path would be {} bytes (max 103).\n\
                 Use a shorter session name or set AGENT_BROWSER_SOCKET_DIR to a shorter path.",
                session, path_len
            ));
        }
    }

    // Pre-flight check: Verify socket directory is writable
    {
        let test_file = socket_dir.join(".write_test");
        match fs::write(&test_file, b"") {
            Ok(_) => {
                let _ = fs::remove_file(&test_file);
            }
            Err(e) => {
                return Err(format!(
                    "Socket directory '{}' is not writable: {}",
                    socket_dir.display(),
                    e
                ));
            }
        }
    }

    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_path = exe_path.canonicalize().unwrap_or(exe_path);

    #[allow(unused_assignments)]
    let mut daemon_child: Option<std::process::Child> = None;

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        let mut cmd = Command::new(&exe_path);
        cmd.env("AGENT_BROWSER_DAEMON", "1");
        apply_daemon_env(&mut cmd, session, opts);

        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }

        daemon_child = Some(
            cmd.stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to start daemon: {}", e))?,
        );
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        let mut cmd = Command::new(&exe_path);
        cmd.env("AGENT_BROWSER_DAEMON", "1");
        apply_daemon_env(&mut cmd, session, opts);

        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const DETACHED_PROCESS: u32 = 0x00000008;

        daemon_child = Some(
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to start daemon: {}", e))?,
        );
    }

    let spawned_pid = daemon_child.as_ref().map(|child| child.id());

    for _ in 0..50 {
        if daemon_ready(session) {
            if let Some(result) = ready_spawned_daemon_result(session, opts, spawned_pid, restarted)
            {
                return Ok(result);
            }
            if wait_for_matching_ready_daemon(session, opts, Duration::from_secs(1)) {
                return Ok(DaemonResult {
                    already_running: true,
                    restarted,
                });
            }
            return Err(concurrent_daemon_config_error(session));
        }

        // Detect early daemon exit and surface the real error from stderr
        if let Some(ref mut child) = daemon_child {
            if let Ok(Some(_)) = child.try_wait() {
                let mut stderr_output = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut stderr_output);
                }
                let stderr_trimmed = stderr_output.trim();

                // If the daemon failed because another instance won the bind
                // race ("Address already in use"), check whether that winner is
                // now accepting connections and piggyback on it. It may still be
                // starting: it holds the session until it answers or gives up.
                if stderr_trimmed.contains("Address already in use")
                    || stderr_trimmed.contains("Failed to bind")
                {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while !daemon_ready(session) && session_held(session) && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(50));
                    }
                    if daemon_ready(session) {
                        if wait_for_matching_ready_daemon(session, opts, Duration::from_secs(1)) {
                            return Ok(DaemonResult {
                                already_running: true,
                                restarted,
                            });
                        }
                        return Err(concurrent_daemon_config_error(session));
                    }
                }

                if !stderr_trimmed.is_empty() {
                    let msg = if stderr_trimmed.len() > 500 {
                        let mut end = 500;
                        while !stderr_trimmed.is_char_boundary(end) {
                            end -= 1;
                        }
                        &stderr_trimmed[..end]
                    } else {
                        stderr_trimmed
                    };
                    return Err(format!("Daemon process exited during startup:\n{}", msg));
                }
                return Err(
                    "Daemon process exited during startup with no error output. \
                     Re-run with --debug for more details."
                        .to_string(),
                );
            }
        }

        thread::sleep(Duration::from_millis(100));
    }

    #[cfg(unix)]
    let endpoint_info = format!(
        "socket: {}",
        get_socket_dir().join(format!("{}.sock", session)).display()
    );
    #[cfg(windows)]
    let endpoint_info = format!("port: 127.0.0.1:{}", resolve_port(session));

    Err(format!("Daemon failed to start ({})", endpoint_info))
}

fn connect(session: &str) -> Result<Connection, String> {
    #[cfg(unix)]
    {
        let socket_path = get_socket_path(session);
        UnixStream::connect(&socket_path)
            .map(Connection::Unix)
            .map_err(|e| format!("Failed to connect: {}", e))
    }
    #[cfg(windows)]
    {
        let port = resolve_port(session);
        TcpStream::connect(format!("127.0.0.1:{}", port))
            .map(Connection::Tcp)
            .map_err(|e| format!("Failed to connect: {}", e))
    }
}

/// Failure of a single request attempt, split by whether the daemon may have
/// received the request.
#[derive(Debug)]
enum SendError {
    /// Connecting failed, or the write failed before any byte was accepted.
    NotSent(String),
    /// At least part of the request was written, then the write, the read, or
    /// response parsing failed. The daemon may already have executed it.
    OutcomeUnknown(String),
}

/// Actions that only read state, so re-sending one after a lost response
/// cannot change the page. Anything not listed is treated as mutating.
const READ_ONLY_ACTIONS: &[&str] = &[
    "url",
    "title",
    "snapshot",
    "gettext",
    "getattribute",
    "isvisible",
    "isenabled",
    "ischecked",
    "boundingbox",
    "innerhtml",
    "inputvalue",
    "count",
    "styles",
    "cookies_get",
    "storage_get",
    "tab_list",
    "cdp_url",
    "stream_status",
];

fn is_read_only(cmd: &Value) -> bool {
    cmd.get("action")
        .and_then(Value::as_str)
        .is_some_and(|action| READ_ONLY_ACTIONS.contains(&action))
}

pub fn send_command(cmd: Value, session: &str) -> Result<Response, String> {
    check_session_name(session)?;
    send_with_retry(is_read_only(&cmd), || send_command_once(&cmd, session))
}

/// Retry transient errors (EAGAIN/EWOULDBLOCK/connection issues). Once a
/// request was written, only read-only actions are re-sent; a mutating one
/// (click, fill, eval, navigation) could otherwise run twice, so it fails with
/// code `outcome_unknown` instead.
fn send_with_retry(
    read_only: bool,
    mut send_once: impl FnMut() -> Result<Response, SendError>,
) -> Result<Response, String> {
    const MAX_RETRIES: u32 = 5;
    const RETRY_DELAY_MS: u64 = 200;

    let mut last_error = String::new();

    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            thread::sleep(Duration::from_millis(RETRY_DELAY_MS * (attempt as u64)));
        }

        let e = match send_once() {
            Ok(response) => return Ok(response),
            Err(SendError::OutcomeUnknown(e)) if !read_only => {
                return Ok(Response {
                    success: false,
                    error: Some(format!(
                        "{} (the command reached the daemon but no response came back; \
                         it may or may not have run, so it was not retried)",
                        e
                    )),
                    code: Some("outcome_unknown".to_string()),
                    ..Default::default()
                });
            }
            Err(SendError::OutcomeUnknown(e)) | Err(SendError::NotSent(e)) => e,
        };
        if !is_transient_error(&e) {
            return Err(e);
        }
        last_error = e;
    }

    Err(format!(
        "{} (after {} retries - daemon may be busy or unresponsive)",
        last_error, MAX_RETRIES
    ))
}

/// Check if an error is transient and worth retrying against the SAME daemon.
/// Transient errors include:
/// - EAGAIN/EWOULDBLOCK (os error 35 on macOS, 11 on Linux)
/// - EOF errors (daemon closed connection before responding)
/// - Connection reset/broken pipe (daemon crashed or restarting)
///
/// Connection refused / missing socket are NOT transient: no daemon is
/// listening, so backing off cannot help. Callers use daemon_unreachable()
/// to respawn via ensure_daemon and retry once instead.
fn is_transient_error(error: &str) -> bool {
    has_os_error(error, 35) // EAGAIN on macOS
        || has_os_error(error, 11) // EAGAIN on Linux
        || error.contains("WouldBlock")
        || error.contains("Resource temporarily unavailable")
        || error.contains("EOF")
        || error.contains("line 1 column 0") // Empty JSON response
        || error.contains("Connection reset")
        || error.contains("Broken pipe")
        || has_os_error(error, 54) // Connection reset by peer (macOS)
        || has_os_error(error, 104) // Connection reset by peer (Linux)
        || has_os_error(error, 10054) // Connection reset by peer (Windows)
}

/// True when the error means no daemon is listening on the session socket
/// (exited or never started), as opposed to a live-but-busy daemon. The
/// remedy is a respawn through ensure_daemon, not a retry.
pub fn daemon_unreachable(error: &str) -> bool {
    error.contains("Failed to connect")
        || has_os_error(error, 2) // No such file or directory (socket gone)
        || has_os_error(error, 61) // Connection refused (macOS)
        || has_os_error(error, 111) // Connection refused (Linux)
        || has_os_error(error, 10061) // Connection refused (Windows)
}

/// Exact `(os error N)` match. Bare substring checks like "os error 11"
/// also matched "os error 111" (connection refused on Linux), which made
/// EAGAIN handling swallow refused connections.
fn has_os_error(error: &str, code: u32) -> bool {
    error.contains(&format!("(os error {})", code))
}

/// Socket read timeout for one request. Ordinary commands get a 30s floor.
/// Commands carrying an operation timeout (the wait family, which
/// parse_command stamps with AGENT_BROWSER_DEFAULT_TIMEOUT when no explicit
/// --timeout is given) get that timeout plus margin, so the daemon can report
/// a proper operation timeout instead of the client dying with EAGAIN at 30s
/// and a mutating command failing with outcome_unknown while it still runs.
///
/// The env var is deliberately NOT consulted here. Reading it would apply a
/// long wait budget to every command, so a genuinely hung daemon on a simple
/// `url`/`title`/`snapshot` call would take the full budget to surface
/// instead of 30s. Only commands that actually carry a `timeout` field get
/// the extended budget, and that field is set client-side per invocation,
/// avoiding the daemon's spawn-time env snapshot drifting from the client.
pub(crate) use agent_browser_core::connection::read_timeout_for;

fn send_command_once(cmd: &Value, session: &str) -> Result<Response, SendError> {
    let mut json_str = serde_json::to_string(&for_the_door(cmd, session)).map_err(|e| SendError::NotSent(e.to_string()))?;
    json_str.push('\n');

    let stream = connect(session).map_err(SendError::NotSent)?;

    let waits = read_timeout_for(cmd);
    stream.set_read_timeout(Some(waits)).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();

    exchange(stream, json_str.as_bytes(), waits)
}

/// Unbrowse fork: why reading the daemon's answer failed. A read that ran out of time comes back from
/// the socket as EAGAIN on macOS ("Resource temporarily unavailable", os error 35), which reads like a
/// fault; it is a daemon that was still working (a long command of its own, or another session's ahead
/// of it), and is said so.
fn read_failed(e: &std::io::Error, waits: Duration) -> String {
    match e.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => format!(
            "Failed to read: the browser gave no answer within {} s: it is still busy with this command or one \
             ahead of it, or the page has hung",
            waits.as_secs()
        ),
        _ => format!("Failed to read: {}", e),
    }
}

/// Write one request line and read one response line. Unlike write_all, the
/// write loop tracks whether any byte was accepted, which decides whether a
/// failure is safe to retry.
fn exchange<S: Read + Write>(mut stream: S, request: &[u8], waits: Duration) -> Result<Response, SendError> {
    let mut written = 0;
    while written < request.len() {
        let err = match stream.write(&request[written..]) {
            Ok(0) => std::io::Error::from(std::io::ErrorKind::WriteZero),
            Ok(n) => {
                written += n;
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => e,
        };
        let msg = format!("Failed to send: {}", err);
        return Err(if written == 0 {
            SendError::NotSent(msg)
        } else {
            SendError::OutcomeUnknown(msg)
        });
    }

    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    reader
        .read_line(&mut response_line)
        .map_err(|e| SendError::OutcomeUnknown(read_failed(&e, waits)))?;

    serde_json::from_str(&response_line)
        .map_err(|e| SendError::OutcomeUnknown(format!("Invalid response: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::EnvGuard;

    /// Repro for #2032: a daemon that reads the request and closes without
    /// replying must see the request once.
    #[test]
    #[cfg(unix)]
    fn send_command_does_not_resend_when_response_is_lost() {
        use std::os::unix::net::UnixListener;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("ab-lost-resp-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);
        _guard.set("AGENT_BROWSER_SOCKET_DIR", dir.to_str().unwrap());

        let session = "lost-resp";
        let socket_path = get_socket_path(session);
        let _ = fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        listener.set_nonblocking(true).unwrap();

        let requests = Arc::new(AtomicUsize::new(0));
        let seen = requests.clone();
        let daemon = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(2500);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let mut line = String::new();
                        BufReader::new(&stream).read_line(&mut line).unwrap();
                        seen.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(_) => thread::sleep(Duration::from_millis(10)),
                }
            }
        });

        let resp = send_command(json!({"id": "1", "action": "click"}), session)
            .expect("outcome_unknown is a failed response, not a send error");
        daemon.join().unwrap();
        let _ = fs::remove_file(&socket_path);
        let _ = fs::remove_dir(&dir);

        assert_eq!(requests.load(Ordering::SeqCst), 1, "request was re-sent");
        assert!(!resp.success);
        assert_eq!(resp.code.as_deref(), Some("outcome_unknown"));
    }

    /// In-memory stream: accepts at most `accept` bytes, then fails writes
    /// with `write_err`; reads return `response`.
    struct MockStream {
        accept: usize,
        write_err: std::io::ErrorKind,
        written: usize,
        response: std::io::Cursor<Vec<u8>>,
    }

    impl MockStream {
        fn new(response: &str) -> Self {
            Self {
                accept: usize::MAX,
                write_err: std::io::ErrorKind::BrokenPipe,
                written: 0,
                response: std::io::Cursor::new(response.as_bytes().to_vec()),
            }
        }
    }

    impl Read for MockStream {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.response.read(buf)
        }
    }

    impl Write for MockStream {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let room = self.accept - self.written;
            if room == 0 {
                return Err(self.write_err.into());
            }
            let n = buf.len().min(room);
            self.written += n;
            Ok(n)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn exchange_classifies_failures_by_whether_bytes_were_written() {
        let eof = exchange(MockStream::new(""), b"{}\n", Duration::from_secs(1));
        assert!(matches!(eof, Err(SendError::OutcomeUnknown(_))));

        let garbage = exchange(MockStream::new("garbage\n"), b"{}\n", Duration::from_secs(1));
        assert!(matches!(garbage, Err(SendError::OutcomeUnknown(_))));

        let mut partial = MockStream::new("");
        partial.accept = 1;
        let partial = exchange(partial, b"{}\n", Duration::from_secs(1));
        assert!(matches!(partial, Err(SendError::OutcomeUnknown(_))));

        let mut blocked = MockStream::new("");
        blocked.accept = 0;
        blocked.write_err = std::io::ErrorKind::WouldBlock;
        let blocked = exchange(blocked, b"{}\n", Duration::from_secs(1));
        assert!(matches!(blocked, Err(SendError::NotSent(_))));

        let ok = exchange(MockStream::new("{\"success\":true}\n"), b"{}\n", Duration::from_secs(1));
        assert!(ok.unwrap().success);
    }

    /// Unbrowse fork: a read that runs out of time is a browser still working, said so with how long the
    /// client waited, never as "Resource temporarily unavailable (os error 35)".
    #[test]
    fn a_read_that_runs_out_of_time_says_the_browser_is_busy() {
        struct Busy;
        impl Read for Busy {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::WouldBlock.into())
            }
        }
        impl Write for Busy {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let Err(SendError::OutcomeUnknown(e)) = exchange(Busy, b"{}\n", Duration::from_secs(40)) else {
            panic!("a timed-out read is an unknown outcome");
        };
        assert!(e.contains("no answer within 40 s"), "{e}");
        assert!(!e.contains("temporarily unavailable"), "{e}");
    }

    fn ok_response() -> Response {
        Response {
            success: true,
            ..Default::default()
        }
    }

    #[test]
    fn mutating_command_is_not_resent_after_write() {
        for err in [
            "Invalid response: EOF while parsing a value at line 1 column 0",
            "Failed to read: Connection reset by peer (os error 104)",
            "Failed to read: Resource temporarily unavailable (os error 11)",
        ] {
            assert!(is_transient_error(err));
            let mut calls = 0;
            let resp = send_with_retry(false, || {
                calls += 1;
                Err(SendError::OutcomeUnknown(err.to_string()))
            })
            .unwrap();
            assert_eq!(calls, 1, "re-sent after: {}", err);
            assert_eq!(resp.code.as_deref(), Some("outcome_unknown"));
            assert!(!daemon_unreachable(resp.error.as_deref().unwrap()));
        }
    }

    #[test]
    fn read_only_command_is_resent_after_lost_response() {
        let mut calls = 0;
        let resp = send_with_retry(true, || {
            calls += 1;
            if calls < 3 {
                Err(SendError::OutcomeUnknown(
                    "Invalid response: EOF while parsing a value at line 1 column 0".to_string(),
                ))
            } else {
                Ok(ok_response())
            }
        });
        assert!(resp.unwrap().success);
        assert_eq!(calls, 3);
    }

    #[test]
    fn unsent_request_is_retried_for_any_command() {
        let mut calls = 0;
        let resp = send_with_retry(false, || {
            calls += 1;
            if calls < 3 {
                Err(SendError::NotSent(
                    "Failed to send: Resource temporarily unavailable (os error 11)".to_string(),
                ))
            } else {
                Ok(ok_response())
            }
        });
        assert!(resp.unwrap().success);
        assert_eq!(calls, 3);

        let mut calls = 0;
        let refused = send_with_retry(false, || {
            calls += 1;
            Err(SendError::NotSent(
                "Failed to connect: Connection refused (os error 111)".to_string(),
            ))
        });
        assert_eq!(calls, 1);
        assert!(daemon_unreachable(&refused.err().unwrap()));
    }

    #[test]
    fn only_listed_actions_count_as_read_only() {
        assert!(is_read_only(&json!({"action": "snapshot"})));
        assert!(is_read_only(&json!({"action": "url"})));
        assert!(!is_read_only(&json!({"action": "click"})));
        assert!(!is_read_only(&json!({"action": "evaluate"})));
        assert!(!is_read_only(&json!({"action": "some_future_action"})));
        assert!(!is_read_only(&json!({})));
    }

    #[test]
    fn long_mouse_movement_gets_its_requested_time_budget() {
        assert_eq!(
            read_timeout_for(&json!({"action":"mousemove", "duration": 35_000})),
            Duration::from_secs(45)
        );
    }

    #[test]
    fn a_session_name_never_reaches_a_path_outside_the_socket_dir() {
        let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_NAMESPACE"]);
        let base = std::env::temp_dir().join(format!(
            "ab-session-name-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let run = base.join("run");
        fs::create_dir_all(&run).unwrap();
        fs::write(base.join("victim.pid"), "x").unwrap();
        fs::write(base.join("victim.config"), "x").unwrap();
        guard.set("AGENT_BROWSER_SOCKET_DIR", run.to_str().unwrap());
        guard.remove("AGENT_BROWSER_NAMESPACE");

        for name in ["../victim", "a/b", "", ".", "..", "x.y"] {
            assert!(check_session_name(name).is_err(), "{name:?} must be refused");
        }
        assert!(check_session_name("browse_example_com").is_ok());
        assert!(check_session_name("default").is_ok());

        cleanup_stale_files("../victim");
        assert!(send_command(json!({"action": "close"}), "../victim").is_err());
        assert!(ensure_daemon("../victim", &test_daemon_options(None, false, None)).is_err());
        assert_eq!(fs::read_to_string(base.join("victim.pid")).unwrap(), "x");
        assert!(base.join("victim.config").exists());
        assert!(!base.join("victim.sock").exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn test_get_socket_dir_explicit_override() {
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);

        _guard.set("AGENT_BROWSER_SOCKET_DIR", "/custom/socket/path");
        _guard.remove("XDG_RUNTIME_DIR");

        assert_eq!(get_socket_dir(), PathBuf::from("/custom/socket/path"));
    }

    #[test]
    fn test_get_socket_dir_ignores_empty_socket_dir() {
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);

        _guard.set("AGENT_BROWSER_SOCKET_DIR", "");
        _guard.remove("XDG_RUNTIME_DIR");

        assert!(get_socket_dir()
            .to_string_lossy()
            .ends_with(".agent-browser"));
    }

    #[test]
    fn test_get_socket_dir_xdg_runtime() {
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);

        _guard.remove("AGENT_BROWSER_SOCKET_DIR");
        _guard.set("XDG_RUNTIME_DIR", "/run/user/1000");

        assert_eq!(
            get_socket_dir(),
            PathBuf::from("/run/user/1000/agent-browser")
        );
    }

    #[test]
    fn test_get_socket_dir_ignores_empty_xdg_runtime() {
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);

        _guard.set("AGENT_BROWSER_SOCKET_DIR", "");
        _guard.set("XDG_RUNTIME_DIR", "");

        assert!(get_socket_dir()
            .to_string_lossy()
            .ends_with(".agent-browser"));
    }

    #[test]
    fn test_get_socket_dir_home_fallback() {
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);

        _guard.remove("AGENT_BROWSER_SOCKET_DIR");
        _guard.remove("XDG_RUNTIME_DIR");

        let result = get_socket_dir();
        assert!(result.to_string_lossy().ends_with(".agent-browser"));
        assert!(
            result.to_string_lossy().contains("home") || result.to_string_lossy().contains("Users")
        );
    }

    #[test]
    fn test_get_socket_dir_namespace_scopes_base_directory() {
        let _guard = EnvGuard::new(&[
            "AGENT_BROWSER_SOCKET_DIR",
            "XDG_RUNTIME_DIR",
            "AGENT_BROWSER_NAMESPACE",
        ]);

        _guard.set(
            "AGENT_BROWSER_SOCKET_DIR",
            "/tmp/agent-browser-test-sockets",
        );
        _guard.remove("XDG_RUNTIME_DIR");
        _guard.set("AGENT_BROWSER_NAMESPACE", "Worktree: One");

        assert_eq!(
            get_socket_dir(),
            PathBuf::from("/tmp/agent-browser-test-sockets")
                .join("namespaces")
                .join("worktree-one")
                .join("run")
        );
    }

    #[test]
    fn test_walk_daemons_only_lists_current_namespace() {
        let _guard = EnvGuard::new(&[
            "AGENT_BROWSER_SOCKET_DIR",
            "XDG_RUNTIME_DIR",
            "AGENT_BROWSER_NAMESPACE",
        ]);
        let dir = tempfile::tempdir().unwrap();
        _guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        _guard.remove("XDG_RUNTIME_DIR");

        let ns_one = dir.path().join("namespaces").join("one").join("run");
        let ns_two = dir.path().join("namespaces").join("two").join("run");
        fs::create_dir_all(&ns_one).unwrap();
        fs::create_dir_all(&ns_two).unwrap();
        let pid = std::process::id().to_string();
        fs::write(ns_one.join("current.pid"), &pid).unwrap();
        fs::write(ns_two.join("other.pid"), &pid).unwrap();

        _guard.set("AGENT_BROWSER_NAMESPACE", "one");
        let inventory = walk_daemons();

        assert_eq!(inventory.sessions.len(), 1);
        assert_eq!(inventory.sessions[0].name, "current");
    }

    fn test_daemon_options<'a>(
        idle_timeout: Option<&'a str>,
        no_auto_dialog: bool,
        allowed_domains: Option<&'a [String]>,
    ) -> DaemonOptions<'a> {
        DaemonOptions {
            headed: false,
            debug: false,
            executable_path: None,
            extensions: &[],
            init_scripts: &[],
            enable: &[],
            args: None,
            user_agent: None,
            proxy: None,
            proxy_bypass: None,
            proxy_username: None,
            proxy_password: None,
            ignore_https_errors: false,
            allow_file_access: false,
            hide_scrollbars: true,
            webgpu: false,
            profile: None,
            state: None,
            provider: None,
            device: None,
            session_name: None,
            restore_save: None,
            restore_check_url: None,
            restore_check_text: None,
            restore_check_fn: None,
            download_path: None,
            allowed_domains,
            action_policy: None,
            confirm_actions: None,
            engine: None,
            auto_connect: false,
            pin_tab: false,
            idle_timeout,
            default_timeout: None,
            cdp: None,
            no_auto_dialog,
            no_console: false,
            plugins: None,
        }
    }

    #[test]
    fn test_daemon_config_fingerprint_tracks_daemon_owned_options() {
        let domains = vec!["example.com".to_string()];
        let base = test_daemon_options(None, false, None);
        let idle_changed = test_daemon_options(Some("1000"), false, None);
        let dialog_changed = test_daemon_options(None, true, None);
        let domains_changed = test_daemon_options(None, false, Some(&domains));
        let mut console_changed = test_daemon_options(None, false, None);
        console_changed.no_console = true;

        assert_ne!(
            daemon_config_fingerprint(&base),
            daemon_config_fingerprint(&idle_changed)
        );
        assert_ne!(
            daemon_config_fingerprint(&base),
            daemon_config_fingerprint(&dialog_changed)
        );
        assert_ne!(
            daemon_config_fingerprint(&base),
            daemon_config_fingerprint(&console_changed),
            "capture is a session setting the daemon owns: changing it restarts"
        );
        assert_eq!(
            daemon_config_fingerprint(&base),
            daemon_config_fingerprint(&domains_changed),
            "allowed domains are browser launch state, not daemon identity"
        );
    }

    /// A file nobody can read says nothing about the daemon. Reading it as different stops a healthy daemon, and its
    /// browser and pages with it, for a fault in a file.
    #[cfg(unix)]
    #[test]
    fn a_config_nobody_can_read_leaves_the_daemon_alone() {
        use std::os::unix::fs::PermissionsExt;
        let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_NAMESPACE"]);
        let dir = tempfile::tempdir().unwrap();
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("AGENT_BROWSER_NAMESPACE");
        let session = "unread-config";
        let opts = test_daemon_options(Some("1000"), false, None);

        fs::create_dir_all(get_socket_dir()).unwrap();
        write_daemon_config(session, &opts);
        let path = get_config_path(session);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();

        // Nothing stops root reading it, and then this says nothing.
        if fs::read_to_string(&path).is_err() {
            assert_eq!(daemon_config_status(session, &opts), DaemonConfigStatus::Matches);
        }
    }

    #[test]
    fn test_spawn_race_loser_does_not_overwrite_winner_config() {
        let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_NAMESPACE"]);
        let dir = tempfile::tempdir().unwrap();
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("AGENT_BROWSER_NAMESPACE");

        let session = "race-config";
        let winner_opts = test_daemon_options(Some("1000"), false, None);
        let loser_opts = test_daemon_options(Some("2000"), false, None);

        fs::create_dir_all(get_socket_dir()).unwrap();
        fs::write(get_pid_path(session), "12345").unwrap();
        write_daemon_config(session, &winner_opts);

        let result = ready_spawned_daemon_result(session, &loser_opts, Some(67890), false);

        assert!(result.is_none());
        assert!(daemon_config_matches(session, &winner_opts));
        assert!(!daemon_config_matches(session, &loser_opts));
    }

    #[test]
    fn test_spawn_race_loser_reuses_matching_winner_config() {
        let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_NAMESPACE"]);
        let dir = tempfile::tempdir().unwrap();
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("AGENT_BROWSER_NAMESPACE");

        let session = "race-config-match";
        let opts = test_daemon_options(Some("1000"), false, None);

        fs::create_dir_all(get_socket_dir()).unwrap();
        fs::write(get_pid_path(session), "12345").unwrap();
        write_daemon_config(session, &opts);

        let result = ready_spawned_daemon_result(session, &opts, Some(67890), false)
            .expect("matching winner config should be reused");

        assert!(result.already_running);
        assert!(!result.restarted);
        assert!(daemon_config_matches(session, &opts));
    }

    #[test]
    fn test_ready_existing_daemon_waits_for_startup_config() {
        let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_NAMESPACE"]);
        let dir = tempfile::tempdir().unwrap();
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("AGENT_BROWSER_NAMESPACE");

        let session = "startup-config";
        let opts = test_daemon_options(Some("1000"), false, None);
        fs::create_dir_all(get_socket_dir()).unwrap();

        let config_path = get_config_path(session);
        let expected = daemon_config_fingerprint(&opts);
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            fs::write(config_path, expected).unwrap();
        });

        let result = ready_existing_daemon_result(session, &opts, Duration::from_secs(1))
            .expect("missing config should get a short startup settle window");
        writer.join().unwrap();

        assert!(result.already_running);
        assert!(!result.restarted);
        assert!(daemon_config_matches(session, &opts));
    }

    #[test]
    fn test_spawn_owner_writes_config() {
        let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_NAMESPACE"]);
        let dir = tempfile::tempdir().unwrap();
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("AGENT_BROWSER_NAMESPACE");

        let session = "race-config-owner";
        let opts = test_daemon_options(Some("1000"), false, None);
        let spawned_pid = 67890;

        fs::create_dir_all(get_socket_dir()).unwrap();
        fs::write(get_pid_path(session), spawned_pid.to_string()).unwrap();

        let result = ready_spawned_daemon_result(session, &opts, Some(spawned_pid), true)
            .expect("spawn owner should be accepted");

        assert!(!result.already_running);
        assert!(result.restarted);
        assert!(daemon_config_matches(session, &opts));
    }

    // === Transient Error Detection Tests ===

    #[test]
    fn test_is_transient_error_eagain_macos() {
        assert!(is_transient_error(
            "Failed to read: Resource temporarily unavailable (os error 35)"
        ));
    }

    #[test]
    fn test_is_transient_error_eagain_linux() {
        assert!(is_transient_error(
            "Failed to read: Resource temporarily unavailable (os error 11)"
        ));
    }

    #[test]
    fn test_is_transient_error_would_block() {
        assert!(is_transient_error("operation WouldBlock"));
    }

    #[test]
    fn test_is_transient_error_resource_unavailable() {
        assert!(is_transient_error("Resource temporarily unavailable"));
    }

    #[test]
    fn test_is_transient_error_eof() {
        assert!(is_transient_error(
            "Invalid response: EOF while parsing a value at line 1 column 0"
        ));
    }

    #[test]
    fn test_is_transient_error_empty_json() {
        assert!(is_transient_error(
            "Invalid response: expected value at line 1 column 0"
        ));
    }

    #[test]
    fn test_is_transient_error_connection_reset() {
        assert!(is_transient_error("Connection reset by peer"));
    }

    #[test]
    fn test_is_transient_error_broken_pipe() {
        assert!(is_transient_error("Broken pipe"));
    }

    #[test]
    fn test_is_transient_error_connection_reset_macos() {
        assert!(is_transient_error(
            "Failed to send: Connection reset by peer (os error 54)"
        ));
    }

    #[test]
    fn test_is_transient_error_connection_reset_linux() {
        assert!(is_transient_error(
            "Failed to send: Connection reset by peer (os error 104)"
        ));
    }

    // Connection refused / missing socket mean no daemon is listening:
    // not transient (retry can't help), handled by respawn via
    // daemon_unreachable instead.
    #[test]
    fn test_socket_not_found_is_unreachable_not_transient() {
        let error = "Failed to connect: No such file or directory (os error 2)";
        assert!(!is_transient_error(error));
        assert!(daemon_unreachable(error));
    }

    #[test]
    fn test_connection_refused_macos_is_unreachable_not_transient() {
        let error = "Failed to connect: Connection refused (os error 61)";
        assert!(!is_transient_error(error));
        assert!(daemon_unreachable(error));
    }

    #[test]
    fn test_connection_refused_linux_is_unreachable_not_transient() {
        let error = "Failed to connect: Connection refused (os error 111)";
        assert!(!is_transient_error(error));
        assert!(daemon_unreachable(error));
    }

    #[test]
    fn test_connection_refused_windows_is_unreachable_not_transient() {
        let error = "Failed to connect: No connection could be made because the target machine actively refused it. (os error 10061)";
        assert!(!is_transient_error(error));
        assert!(daemon_unreachable(error));
    }

    #[test]
    fn test_is_transient_error_connection_reset_windows() {
        assert!(is_transient_error(
            "Failed to send: An existing connection was forcibly closed by the remote host. (os error 10054)"
        ));
    }

    #[test]
    fn test_is_transient_error_non_transient() {
        // These should NOT be considered transient
        assert!(!is_transient_error("Unknown command: foo"));
        assert!(!is_transient_error("Invalid JSON syntax"));
        assert!(!is_transient_error("Permission denied"));
        assert!(!is_transient_error("Daemon not found"));
    }

    #[test]
    #[cfg(windows)]
    fn test_get_port_for_session() {
        let guard = EnvGuard::new(&["AGENT_BROWSER_NAMESPACE"]);
        guard.remove("AGENT_BROWSER_NAMESPACE");

        assert_eq!(get_port_for_session("default"), 50838);
        assert_eq!(get_port_for_session("my-session"), 63105);
        assert_eq!(get_port_for_session("work"), 51184);
        assert_eq!(get_port_for_session(""), 49152);
    }

    #[test]
    #[cfg(windows)]
    fn test_get_port_for_session_includes_namespace() {
        let guard = EnvGuard::new(&["AGENT_BROWSER_NAMESPACE"]);
        guard.remove("AGENT_BROWSER_NAMESPACE");
        let unnamespaced = get_port_for_session("work");

        guard.set("AGENT_BROWSER_NAMESPACE", "Worktree: One");
        let namespaced_one = get_port_for_session("work");

        guard.set("AGENT_BROWSER_NAMESPACE", "Worktree: Two");
        let namespaced_two = get_port_for_session("work");

        assert_ne!(namespaced_one, unnamespaced);
        assert_ne!(namespaced_two, unnamespaced);
        assert_ne!(namespaced_one, namespaced_two);
    }

    /// A live process holds its session, and what it holds isn't anyone else's to remove: the files go only once it
    /// has let go. Each claim here is a process's own, as a lock is on a file opened separately.
    #[test]
    fn a_held_session_keeps_its_files_until_its_holder_lets_go() {
        let dir = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR", "AGENT_BROWSER_NAMESPACE"]);
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("AGENT_BROWSER_NAMESPACE");
        let session = "held";
        let me = std::process::id();
        fs::write(get_pid_path(session), me.to_string()).unwrap();
        record_process(me, &get_started_path(session));

        let daemon = claim_session(session).expect("nobody holds it yet");
        assert!(claim_session(session).is_none(), "a held session has one holder");
        assert!(session_held(session));
        assert_eq!(owned_daemon_pid(session), Some(me));
        cleanup_stale_files(session);
        assert!(get_pid_path(session).exists(), "another process took the holder's file");

        drop(daemon);
        assert!(!session_held(session));
        assert_eq!(owned_daemon_pid(session), None, "a pid file nobody holds proves nothing");
        cleanup_stale_files(session);
        assert!(!get_pid_path(session).exists());
    }

    /// A held session proves only that some process holds it (a daemon starting, a CLI cleaning up), not that its
    /// `.pid` file is still the holder's: a file a dead daemon left names whatever has that number now. Such a process is
    /// never signalled; the daemon whose number and start the session recorded is.
    #[cfg(unix)]
    #[test]
    fn a_stale_pid_file_never_signals_the_process_that_now_has_its_number() {
        let dir = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR", "AGENT_BROWSER_NAMESPACE"]);
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("AGENT_BROWSER_NAMESPACE");
        let session = "reused";
        // A process that has nothing to do with the session, holding the number a dead daemon wrote.
        let mut bystander = Command::new("sleep").arg("30").spawn().unwrap();
        fs::write(get_pid_path(session), bystander.id().to_string()).unwrap();
        // Another process holds the session meanwhile, as a daemon starting for it does before it writes its own pid.
        let starting = claim_session(session).expect("the session is free");
        for record in [None, Some(1u64)] {
            if let Some(other) = record {
                fs::write(get_started_path(session), other.to_string()).unwrap();
            }
            assert_eq!(owned_daemon_pid(session), None, "the file names a process the session never recorded");
            kill_stale_daemon(session);
            assert!(bystander.try_wait().unwrap().is_none(), "the process now holding the number was signalled");
        }
        // The session's own daemon, recorded as it starts, is the one stopped.
        record_process(bystander.id(), &get_started_path(session));
        assert_eq!(owned_daemon_pid(session), Some(bystander.id()));
        kill_stale_daemon(session);
        let stopped = (0..50).any(|_| {
            thread::sleep(Duration::from_millis(20));
            bystander.try_wait().unwrap().is_some()
        });
        assert!(stopped, "the recorded daemon is stopped");
        drop(starting);
    }

    /// The dashboard's files sit beside the sessions', named for it, so no session may have that name.
    #[test]
    fn no_session_takes_the_dashboards_name() {
        assert!(check_session_name(DASHBOARD_CLAIM).is_err());
        assert!(check_session_name("dashboard-2").is_ok());
    }

    /// Every file a session's daemon leaves is on the one list both its exit and a stale cleanup go by.
    #[test]
    fn one_list_removes_every_file_a_session_leaves() {
        let dir = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR", "AGENT_BROWSER_NAMESPACE"]);
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("AGENT_BROWSER_NAMESPACE");
        let session = "tidy";
        for extension in ["pid", "version", "config", "stream", "stream-token", "engine", "provider", "extensions"] {
            fs::write(dir.path().join(format!("{session}.{extension}")), "x").unwrap();
        }
        cleanup_stale_files(session);
        let left: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("tidy.lock")]);
    }

    /// A daemon that has answered `close` but is still on its way out (its
    /// socket taking connections, its `.pid` file there) isn't gone yet: a
    /// command sent now would reach it. Gone is when the socket refuses and
    /// the daemon's files are removed.
    #[test]
    #[cfg(unix)]
    fn a_close_waits_until_the_daemon_is_gone() {
        use std::os::unix::net::UnixListener;

        let dir = std::env::temp_dir().join(format!("ab-close-wait-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);
        _guard.set("AGENT_BROWSER_SOCKET_DIR", dir.to_str().unwrap());

        let session = "close-wait";
        let (socket_path, pid_path) = (get_socket_path(session), get_pid_path(session));
        let _ = fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        fs::write(&pid_path, std::process::id().to_string()).unwrap();
        assert_eq!(daemon_pid(session), Some(std::process::id()));

        // Still listening, its pid file there: not gone.
        assert!(!wait_for_daemon_exit(session, None, Duration::from_millis(100)));

        // It exits a moment later, the way a daemon does after its last answer.
        let exiting = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            drop(listener);
            let _ = fs::remove_file(&socket_path);
            let _ = fs::remove_file(&pid_path);
        });
        let started = Instant::now();
        assert!(wait_for_daemon_exit(session, None, Duration::from_secs(5)));
        assert!(started.elapsed() >= Duration::from_millis(100), "returned before the daemon left");
        exiting.join().unwrap();
        assert!(!daemon_ready(session));
        let _ = fs::remove_dir_all(&dir);
    }

    // === Daemon Version Mismatch Detection Tests ===

    #[test]
    fn test_daemon_version_matches_same_version() {
        let dir = std::env::temp_dir().join("ab-test-version-match");
        let _ = fs::create_dir_all(&dir);
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);
        _guard.set("AGENT_BROWSER_SOCKET_DIR", dir.to_str().unwrap());

        let version_path = dir.join("test-session.version");
        let _ = fs::write(&version_path, env!("CARGO_PKG_VERSION"));

        assert!(daemon_version_matches("test-session"));

        let _ = fs::remove_file(&version_path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn test_daemon_version_matches_different_version() {
        let dir = std::env::temp_dir().join("ab-test-version-mismatch");
        let _ = fs::create_dir_all(&dir);
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);
        _guard.set("AGENT_BROWSER_SOCKET_DIR", dir.to_str().unwrap());

        let version_path = dir.join("test-session.version");
        let _ = fs::write(&version_path, "0.0.0-old");

        assert!(!daemon_version_matches("test-session"));

        let _ = fs::remove_file(&version_path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn test_daemon_version_matches_no_file() {
        let dir = std::env::temp_dir().join("ab-test-version-nofile");
        let _ = fs::create_dir_all(&dir);
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);
        _guard.set("AGENT_BROWSER_SOCKET_DIR", dir.to_str().unwrap());

        // No version file: treated as mismatch so stale pre-version-tracking
        // daemons (including Node.js era) are always restarted.
        assert!(!daemon_version_matches("test-session"));

        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn test_cleanup_stale_files_removes_version() {
        let dir = std::env::temp_dir().join("ab-test-cleanup-version");
        let _ = fs::create_dir_all(&dir);
        let _guard = EnvGuard::new(&["AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]);
        _guard.set("AGENT_BROWSER_SOCKET_DIR", dir.to_str().unwrap());

        let version_path = dir.join("test-session.version");
        let _ = fs::write(&version_path, "0.1.0");
        assert!(version_path.exists());

        cleanup_stale_files("test-session");
        assert!(!version_path.exists());

        let _ = fs::remove_dir(&dir);
    }
}
