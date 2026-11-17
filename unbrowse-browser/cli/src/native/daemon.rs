use serde_json::Value;
use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::signal;
use tokio::sync::{Notify, RwLock};

use super::actions::{
    auto_save_restore_state, close_all_browser_backends, close_current_browser, execute_command,
    maybe_autosave_restore_state, DaemonState, WhileBusy,
};
use super::cdp::client::CdpClient;
use super::state;
use super::stream::{IdleActivity, StreamServer};
use crate::connection::{claim_session, remove_session_files, SessionClaim, INTERNAL_DAEMON_SHUTDOWN_ACTION};

/// How long a starting daemon waits for a session: the other process may only be looking, or a last daemon leaving.
const CLAIM_WAIT: Duration = Duration::from_millis(1_000);

async fn wait_for_session(session: &str) -> Option<SessionClaim> {
    let deadline = tokio::time::Instant::now() + CLAIM_WAIT;
    loop {
        if let Some(claim) = claim_session(session) {
            return Some(claim);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub async fn run_daemon(session: &str) {
    let socket_dir = get_daemon_socket_dir();
    if !socket_dir.exists() {
        let _ = fs::create_dir_all(&socket_dir);
    }
    // The door, the stream secret, the capture's sidecars and the logs live here: the owner's alone.
    crate::owner_only::narrow_dir(&socket_dir);

    // Everything this process does to the session's files below, it does as the session's owner. One that doesn't own
    // it leaves before touching any of them, saying so where the CLI that started it is listening.
    let Some(_claim) = wait_for_session(session).await else {
        let _ = writeln!(std::io::stderr(), "Failed to bind: session '{}' already has a daemon", session);
        process::exit(1);
    };

    // When debug mode is on, redirect stderr to a log file so daemon
    // output can be inspected (the daemon normally has stderr piped to its
    // parent which drops the read end after startup).
    #[cfg(unix)]
    if env::var("AGENT_BROWSER_DEBUG").is_ok() {
        let log_path = socket_dir.join(format!("{}.log", session));
        if let Ok(file) = fs::File::create(&log_path) {
            use std::os::unix::io::IntoRawFd;
            let fd = file.into_raw_fd();
            unsafe {
                libc::dup2(fd, 2);
                libc::close(fd);
            }
            let _ = writeln!(
                std::io::stderr(),
                "[daemon] Debug logging started for session: {}",
                session
            );
        }
    }

    // What an earlier daemon left, now that this one owns the session.
    remove_session_files(session);

    let pid_path = socket_dir.join(format!("{}.pid", session));
    let _ = fs::write(&pid_path, process::id().to_string());
    // Which process this pid is: what lets another process stop this daemon and never a later one given its number.
    crate::connection::record_process(process::id(), &socket_dir.join(format!("{}.started", session)));

    let version_path = socket_dir.join(format!("{}.version", session));
    let _ = fs::write(&version_path, env!("CARGO_PKG_VERSION"));

    if let Ok(fingerprint) = env::var(crate::connection::DAEMON_CONFIG_ENV) {
        let _ = fs::write(socket_dir.join(format!("{}.config", session)), fingerprint);
    }

    // On Unix the daemon listens on a Unix domain socket; on Windows it uses
    // TCP, so there is no .sock file — only a .port file written by the server.
    let socket_path = socket_dir.join(format!("{}.sock", session));

    let stream_path = socket_dir.join(format!("{}.stream", session));

    if let Ok(days_str) = env::var("AGENT_BROWSER_STATE_EXPIRE_DAYS") {
        if let Ok(days) = days_str.parse::<u64>() {
            if days > 0 {
                let _ = state::state_clean(days);
            }
        }
    }

    let mut stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>> = None;
    let mut stream_server_instance: Option<Arc<StreamServer>> = None;
    let idle_activity = Arc::new(IdleActivity::new());
    let preferred_port = env::var("AGENT_BROWSER_STREAM_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    match StreamServer::start_without_client(
        preferred_port,
        session.to_string(),
        true,
        idle_activity.clone(),
    )
    .await
    {
        Ok((stream_server, client_slot)) => {
            stream_client = Some(client_slot.clone());
            // The secret goes down before the port, so whoever finds the port
            // can find the secret (the owner alone can read it).
            if let Err(e) = super::stream::write_stream_token_file(session) {
                let _ = writeln!(std::io::stderr(), "Failed to write .stream-token file: {}", e);
            }
            if let Err(e) = fs::write(&stream_path, stream_server.port().to_string()) {
                let _ = writeln!(std::io::stderr(), "Failed to write .stream file: {}", e);
            }
            stream_server_instance = Some(Arc::new(stream_server));
        }
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "Stream server failed to start: {}", e);
        }
    }

    // Auto-shutdown the daemon after this many ms of inactivity (no commands
    // or dashboard input received). Applies a default when
    // AGENT_BROWSER_IDLE_TIMEOUT_MS is unset; an explicit 0 disables idle
    // shutdown entirely.
    let idle_timeout = resolve_idle_timeout(env::var("AGENT_BROWSER_IDLE_TIMEOUT_MS").ok());

    let autosave_interval_ms = autosave_interval_ms_from_env();

    let result = run_socket_server(
        &socket_path,
        session,
        stream_client,
        stream_server_instance,
        idle_activity,
        idle_timeout,
        autosave_interval_ms,
    )
    .await;

    remove_session_files(session);
    // Unreachable now, so a new command starts a new daemon, which finds a browser this one launched and still
    // serves for another: the browser lives as long as this process, which waits until the last of them has gone.
    let _ = tokio::task::spawn_blocking(super::cdp::chrome::serve_kept_browsers).await;

    if let Err(e) = result {
        let _ = writeln!(std::io::stderr(), "Daemon error: {}", e);
        process::exit(1);
    }
}

/// Stops writing to the CLI that started this daemon, once it is listening: the CLI drops its end of the pipe then.
/// Cloud providers (AgentCore, Browserbase, etc.) may write to stderr during connection setup, and a broken pipe would
/// kill the daemon. Not before the socket is bound: what stops a daemon starting is said here, and only the CLI that
/// started it can tell the person. From here on the daemon's log hears it: a panic in a session is otherwise the one
/// thing about it nobody can ever read. In debug mode stderr is a log file already, and stays one.
#[cfg(unix)]
fn stop_talking_to_the_cli() {
    use std::os::unix::io::IntoRawFd;
    if env::var("AGENT_BROWSER_DEBUG").is_ok() {
        return;
    }
    if let Ok(sink) = crate::open_daemon_log().or_else(|_| fs::File::create("/dev/null")) {
        let fd = sink.into_raw_fd();
        unsafe {
            libc::dup2(fd, 2);
            libc::close(fd);
        }
    }
}

/// Whether a daemon can still be found: a CLI reaches it at its socket (a port on Windows), `close --all` lists it by its
/// pid file, and a pid file naming another process isn't this daemon's.
fn findable(pid_file: Option<&str>, address_there: bool, me: u32) -> bool {
    address_there && pid_file.is_some_and(|pid| pid.trim().parse() == Ok(me))
}

fn can_be_found(session: &str) -> bool {
    let dir = get_daemon_socket_dir();
    let address = if cfg!(windows) { "port" } else { "sock" };
    findable(
        fs::read_to_string(dir.join(format!("{session}.pid"))).ok().as_deref(),
        dir.join(format!("{session}.{address}")).exists(),
        process::id(),
    )
}

/// Whether the default idle timeout waits on for a browser it won't pull from under a person. A daemon whose files have
/// gone is the exception: nothing can reach it to close it, so waiting for a person to finish makes it permanent,
/// holding its session and its browser until the machine restarts. An hour without a command is the time it has had.
fn idle_daemon_waits(default_timeout: bool, browser_blocks: bool, findable: bool) -> bool {
    default_timeout && browser_blocks && findable
}

/// Idle timeout applied when AGENT_BROWSER_IDLE_TIMEOUT_MS is unset, so an
/// integration that dies without calling `close` cannot leak the daemon and
/// its Chrome tree indefinitely (issue: leaked daemons observed running for
/// days). Socket commands and dashboard input reset the timer. Unlike an
/// explicit timeout, the default never closes a headed browser (including
/// Safari and iOS WebDriver sessions) or a user-attached browser because those
/// may be in direct human use that the daemon cannot observe. Provider-owned
/// CDP browsers remain eligible for cleanup.
pub const DEFAULT_IDLE_TIMEOUT_MS: u64 = 60 * 60 * 1000;

#[derive(Clone, Copy)]
struct IdleTimeout {
    ms: u64,
    /// True when the value came from DEFAULT_IDLE_TIMEOUT_MS rather than an
    /// explicit AGENT_BROWSER_IDLE_TIMEOUT_MS. Only the default exempts
    /// headed and user-attached browsers from shutdown.
    is_default: bool,
}

/// Resolve AGENT_BROWSER_IDLE_TIMEOUT_MS into an effective idle timeout:
/// unset or unparseable → the default; explicit 0 → disabled (None);
/// any other value → that many milliseconds.
fn resolve_idle_timeout(raw: Option<String>) -> Option<IdleTimeout> {
    match raw.as_deref().map(str::trim).map(str::parse::<u64>) {
        Some(Ok(0)) => None,
        Some(Ok(ms)) => Some(IdleTimeout {
            ms,
            is_default: false,
        }),
        // Unparseable values are validated (with a warning) at the flags
        // layer; falling back to the default here keeps the leak backstop
        // in place rather than silently disabling it.
        Some(Err(_)) | None => Some(IdleTimeout {
            ms: DEFAULT_IDLE_TIMEOUT_MS,
            is_default: true,
        }),
    }
}

fn remaining_idle_timeout(activity: &IdleActivity, timeout_ms: u64) -> Option<Duration> {
    Duration::from_millis(timeout_ms).checked_sub(activity.elapsed())
}

/// Minimum ms between periodic session autosaves while the browser is open.
/// Defaults to 30s; 0 disables periodic autosave (save-on-close still runs).
fn autosave_interval_ms_from_env() -> u64 {
    env::var("AGENT_BROWSER_AUTOSAVE_INTERVAL_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30_000)
}

#[cfg(unix)]
async fn run_socket_server(
    socket_path: &PathBuf,
    session: &str,
    stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>>,
    stream_server: Option<Arc<StreamServer>>,
    idle_activity: Arc<IdleActivity>,
    idle_timeout: Option<IdleTimeout>,
    autosave_interval_ms: u64,
) -> Result<(), String> {
    use tokio::net::UnixListener;

    let idle_timeout_ms = idle_timeout.map(|t| t.ms);

    let listener =
        UnixListener::bind(socket_path).map_err(|e| format!("Failed to bind socket: {}", e))?;
    // Only the owner may connect: the socket's own mode, under a folder that is the owner's alone.
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600));
    }
    stop_talking_to_the_cli();

    let stream_file: Option<PathBuf> = if stream_server.is_some() {
        let dir = socket_path.parent().unwrap_or(std::path::Path::new("."));
        Some(dir.join(format!("{}.stream", session)))
    } else {
        None
    };
    let daemon_state = DaemonState::new_with_stream(stream_client, stream_server, idle_activity.clone());
    let while_busy = daemon_state.while_busy.clone();
    let state: std::sync::Arc<tokio::sync::Mutex<DaemonState>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(daemon_state));

    // Notifier used by handle_connection to signal the daemon loop to exit
    // after a "close" command, instead of calling process::exit() which skips
    // destructors and can leave Chrome processes orphaned (issue #1113).
    let close_notify = Arc::new(Notify::new());

    let mut drain_interval = tokio::time::interval(Duration::from_millis(100));
    drain_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let idle_sleep = idle_timeout_ms.map(|ms| tokio::time::sleep(Duration::from_millis(ms)));
    let mut idle_sleep_pin = idle_sleep.map(Box::pin);
    let mut idle_lock: Option<IdleLock> = None;

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _)) => {
                        let state = state.clone();
                        let while_busy = while_busy.clone();
                        let idle_activity = idle_activity.clone();
                        let sf = stream_file.clone();
                        let cn = close_notify.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, state, while_busy, idle_activity, sf, cn, None).await;
                        });
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "Accept error: {}", e);
                    }
                }
            }
            _ = drain_interval.tick() => {
                spawn_background_tick_if_idle(state.clone(), autosave_interval_ms);
            }
            _ = async {
                match idle_sleep_pin {
                    Some(ref mut s) => s.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            }, if idle_timeout_ms.is_some() && idle_lock.is_none() => {
                // Wait for the state lock in its own branch so a command
                // holding it does not stop the loop accepting connections.
                idle_lock = Some(Box::pin(state.clone().lock_owned()));
            }
            s = async { idle_lock.as_mut().expect("idle lock armed").await }, if idle_lock.is_some() => {
                idle_lock = None;
                let mut s = s;
                // The timer may have expired while a command held the state
                // lock. Command completion refreshes the shared activity
                // clock before releasing that lock, so re-check it here.
                if let Some(remaining) =
                    remaining_idle_timeout(&idle_activity, idle_timeout_ms.unwrap_or_default())
                {
                    idle_sleep_pin = Some(Box::pin(tokio::time::sleep(remaining)));
                    continue;
                }
                // The default timeout is a leak backstop, not a lifecycle
                // policy: never pull a headed, WebDriver, or attached browser
                // out from under a human. Re-arm and keep waiting instead.
                if idle_daemon_waits(
                    idle_timeout.is_some_and(|t| t.is_default),
                    s.blocks_default_idle_shutdown(),
                    can_be_found(session),
                ) {
                    idle_sleep_pin = idle_timeout_ms
                        .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                    continue;
                }
                if idle_timeout.is_some_and(|t| t.is_default) {
                    let _ = writeln!(
                        std::io::stderr(),
                        "Idle for {}m with no commands or dashboard input; saving configured restore state and shutting down (AGENT_BROWSER_IDLE_TIMEOUT_MS=0 disables)",
                        DEFAULT_IDLE_TIMEOUT_MS / 60_000
                    );
                }
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_all_browser_backends(&mut s).await;
                break;
            }
            _ = idle_activity.notified(), if idle_timeout_ms.is_some() => {
                idle_sleep_pin = idle_timeout_ms
                    .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                continue;
            }
            _ = close_notify.notified() => {
                // "close" command was handled; browser already closed by
                // handle_close(). Break to run cleanup and exit gracefully
                // so destructors fire.
                break;
            }
            _ = shutdown_signal() => {
                // An armed idle lock already holds a place in the lock queue;
                // await it rather than queueing behind it.
                let mut s = match idle_lock.take() {
                    Some(idle_lock) => idle_lock.await,
                    None => state.clone().lock_owned().await,
                };
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_all_browser_backends(&mut s).await;
                break;
            }
        }
    }

    Ok(())
}

#[cfg(windows)]
async fn run_socket_server(
    socket_path: &PathBuf,
    session: &str,
    stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>>,
    stream_server: Option<Arc<StreamServer>>,
    idle_activity: Arc<IdleActivity>,
    idle_timeout: Option<IdleTimeout>,
    autosave_interval_ms: u64,
) -> Result<(), String> {
    use tokio::net::TcpListener;

    let idle_timeout_ms = idle_timeout.map(|t| t.ms);

    let preferred_port = get_port_for_session(session);
    // Try the hash-derived port first; if it is blocked (e.g. Windows Hyper-V
    // excluded port range), fall back to an OS-assigned ephemeral port.
    let listener = match TcpListener::bind(format!("127.0.0.1:{}", preferred_port)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind TCP: {}", e))?,
    };
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();

    let socket_dir = socket_path.parent().unwrap_or(std::path::Path::new("."));
    // A loopback port is anyone's on the machine: the door takes a command only with this secret, which the owner alone
    // can read. Written before the port file, so a client that finds the port finds the key.
    let door_key: Arc<str> = Arc::from(crate::owner_only::new_key().as_str());
    let key_path = socket_dir.join(format!("{}.key", session));
    crate::owner_only::write(&key_path, door_key.as_bytes())
        .map_err(|e| format!("Failed to write the daemon's key: {}", e))?;
    let port_path = socket_dir.join(format!("{}.port", session));
    let _ = fs::write(&port_path, actual_port.to_string());

    let stream_file: Option<PathBuf> = if stream_server.is_some() {
        Some(socket_dir.join(format!("{}.stream", session)))
    } else {
        None
    };
    let daemon_state = DaemonState::new_with_stream(stream_client, stream_server, idle_activity.clone());
    let while_busy = daemon_state.while_busy.clone();
    let state: std::sync::Arc<tokio::sync::Mutex<DaemonState>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(daemon_state));

    let close_notify = Arc::new(Notify::new());

    let idle_sleep = idle_timeout_ms.map(|ms| tokio::time::sleep(Duration::from_millis(ms)));
    let mut idle_sleep_pin = idle_sleep.map(Box::pin);
    let mut idle_lock: Option<IdleLock> = None;

    // Mirror the unix loop's background tick: reap a browser the user closed
    // by hand, and drain CDP events (dialog state in particular) before
    // autosave so a save never runs against a dialog-blocked renderer.
    let mut drain_interval = tokio::time::interval(Duration::from_millis(100));
    drain_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _)) => {
                        let state = state.clone();
                        let while_busy = while_busy.clone();
                        let idle_activity = idle_activity.clone();
                        let sf = stream_file.clone();
                        let cn = close_notify.clone();
                        let key = door_key.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, state, while_busy, idle_activity, sf, cn, Some(key)).await;
                        });
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "Accept error: {}", e);
                    }
                }
            }
            _ = drain_interval.tick() => {
                spawn_background_tick_if_idle(state.clone(), autosave_interval_ms);
            }
            _ = async {
                match idle_sleep_pin {
                    Some(ref mut s) => s.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            }, if idle_timeout_ms.is_some() && idle_lock.is_none() => {
                // Wait for the state lock in its own branch so a command
                // holding it does not stop the loop accepting connections.
                idle_lock = Some(Box::pin(state.clone().lock_owned()));
            }
            s = async { idle_lock.as_mut().expect("idle lock armed").await }, if idle_lock.is_some() => {
                idle_lock = None;
                let mut s = s;
                if let Some(remaining) =
                    remaining_idle_timeout(&idle_activity, idle_timeout_ms.unwrap_or_default())
                {
                    idle_sleep_pin = Some(Box::pin(tokio::time::sleep(remaining)));
                    continue;
                }
                // The default timeout is a leak backstop, not a lifecycle
                // policy: never pull a headed, WebDriver, or attached browser
                // out from under a human. Re-arm and keep waiting instead.
                if idle_daemon_waits(
                    idle_timeout.is_some_and(|t| t.is_default),
                    s.blocks_default_idle_shutdown(),
                    can_be_found(session),
                ) {
                    idle_sleep_pin = idle_timeout_ms
                        .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                    continue;
                }
                if idle_timeout.is_some_and(|t| t.is_default) {
                    let _ = writeln!(
                        std::io::stderr(),
                        "Idle for {}m with no commands or dashboard input; saving configured restore state and shutting down (AGENT_BROWSER_IDLE_TIMEOUT_MS=0 disables)",
                        DEFAULT_IDLE_TIMEOUT_MS / 60_000
                    );
                }
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_all_browser_backends(&mut s).await;
                let _ = fs::remove_file(&port_path);
                let _ = fs::remove_file(&key_path);
                break;
            }
            _ = idle_activity.notified(), if idle_timeout_ms.is_some() => {
                idle_sleep_pin = idle_timeout_ms
                    .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                continue;
            }
            _ = close_notify.notified() => {
                let _ = fs::remove_file(&port_path);
                let _ = fs::remove_file(&key_path);
                break;
            }
            _ = shutdown_signal() => {
                // An armed idle lock already holds a place in the lock queue;
                // await it rather than queueing behind it.
                let mut s = match idle_lock.take() {
                    Some(idle_lock) => idle_lock.await,
                    None => state.clone().lock_owned().await,
                };
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_all_browser_backends(&mut s).await;
                let _ = fs::remove_file(&port_path);
                let _ = fs::remove_file(&key_path);
                break;
            }
        }
    }

    Ok(())
}

type IdleLock = std::pin::Pin<
    Box<dyn std::future::Future<Output = tokio::sync::OwnedMutexGuard<DaemonState>> + Send>,
>;

/// Run the periodic browser maintenance tick in the background, skipping it
/// when a command holds the state lock. A skipped tick loses nothing: CDP
/// events stay buffered and autosave is rechecked on the next tick.
fn spawn_background_tick_if_idle(
    state: Arc<tokio::sync::Mutex<DaemonState>>,
    autosave_interval_ms: u64,
) -> bool {
    let Ok(mut state) = state.try_lock_owned() else {
        return false;
    };
    tokio::spawn(async move {
        let process_exited = state
            .browser
            .as_mut()
            .map(|mgr| mgr.has_process_exited())
            .unwrap_or(false);
        if process_exited {
            let _ = close_current_browser(&mut state).await;
        } else if state.browser.is_some() {
            if let Err(error) = state.drain_cdp_events_background().await {
                let _ = writeln!(
                    std::io::stderr(),
                    "Failed to apply browser network controls: {}",
                    error
                );
            } else {
                maybe_autosave_restore_state(&mut state, autosave_interval_ms).await;
            }
            state.notice_ended_take().await;
            let while_busy = state.while_busy.clone();
            while_busy.publish(&state);
        }
    });
    true
}

/// The longest command line a keyed door (the Windows loopback port) reads before it checks the line's key. A command
/// carries a page's HTML or a file's path at most; nothing an owner sends comes near it.
const PRE_KEY_LINE_LIMIT: u64 = 64 * 1024 * 1024;

async fn handle_connection<S>(
    stream: S,
    state: std::sync::Arc<tokio::sync::Mutex<DaemonState>>,
    while_busy: Arc<WhileBusy>,
    idle_activity: Arc<IdleActivity>,
    stream_file_cleanup: Option<PathBuf>,
    close_notify: Arc<Notify>,
    door_key: Option<Arc<str>>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        // A door anyone on the machine can reach (a key's) reads a bounded line before the key is checked, so a caller
        // without it can't make the daemon hold an endless one.
        let read = if door_key.is_some() {
            let mut bounded = (&mut buf_reader).take(PRE_KEY_LINE_LIMIT);
            let got = bounded.read_line(&mut line).await;
            if matches!(got, Ok(n) if n as u64 == PRE_KEY_LINE_LIMIT && !line.ends_with('\n')) {
                break;
            }
            got
        } else {
            buf_reader.read_line(&mut line).await
        };
        match read {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if looks_like_http(trimmed) {
                    break;
                }

                let mut cmd: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    // At a keyed door, a line that isn't a command is answered with nothing: no conversation before the key.
                    Err(_) if door_key.is_some() => break,
                    Err(e) => {
                        let err = serde_json::json!({
                            "success": false,
                            "error": format!("Invalid JSON: {}", e),
                        });
                        let mut resp = serde_json::to_string(&err).unwrap_or_default();
                        resp.push('\n');
                        let _ = writer.write_all(resp.as_bytes()).await;
                        continue;
                    }
                };

                // A door anyone on the machine can reach takes only its owner's commands: no key, no answer.
                if !crate::owner_only::admit(&mut cmd, door_key.as_deref()) {
                    let refusal = serde_json::json!({
                        "id": cmd.get("id").cloned().unwrap_or(Value::Null),
                        "success": false,
                        "error": "This daemon takes commands only from its owner.",
                        "code": "not_owner",
                    });
                    let mut resp = serde_json::to_string(&refusal).unwrap_or_default();
                    resp.push('\n');
                    let _ = writer.write_all(resp.as_bytes()).await;
                    break;
                }

                idle_activity.mark();

                let action = cmd
                    .get("action")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                // Unbrowse fork: while another command holds the state (a long script, a slow
                // page), the node's own housekeeping (a secret to forget, the tab list, the
                // DevTools address) is answered without it ([`WhileBusy`]).
                let busy = match state.try_lock() {
                    Ok(guard) => Err(guard),
                    Err(_) => Ok(while_busy.answer(&cmd)),
                };
                let response = match busy {
                    Ok(Some(answer)) => answer,
                    busy => {
                        let mut s = match busy {
                            Err(guard) => guard,
                            Ok(_) => state.lock().await,
                        };
                        let response = if s.closing {
                            closing_refusal(&cmd)
                        } else {
                            execute_command(&cmd, &mut s).await
                        };
                        // Before the lock goes: a command waiting on it comes next, and the daemon is leaving.
                        s.closing |= close_completed_response(&action, &response);
                        while_busy.publish(&s);
                        // Refresh while the state lock is still held. An idle
                        // timer waiting on this command will observe the updated
                        // clock as soon as it acquires the lock.
                        idle_activity.mark();
                        response
                    }
                };

                let mut resp = serde_json::to_string(&response).unwrap_or_default();
                resp.push('\n');
                if writer.write_all(resp.as_bytes()).await.is_err() {
                    break;
                }

                if close_completed_response(&action, &response) {
                    if let Some(ref path) = stream_file_cleanup {
                        let _ = fs::remove_file(path);
                    }
                    // Signal the daemon loop to exit gracefully instead of
                    // calling process::exit(), which skips destructors and
                    // can leave Chrome processes orphaned (issue #1113).
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                    close_notify.notify_one();
                    return;
                }
            }
            Err(_) => break,
        }
    }
}

fn looks_like_http(line: &str) -> bool {
    let prefixes = [
        "GET ", "POST ", "PUT ", "DELETE ", "PATCH ", "HEAD ", "OPTIONS ", "CONNECT ", "TRACE ",
    ];
    prefixes.iter().any(|p| line.starts_with(p))
}

/// The answer to a command that came in behind a close. It is plain that nothing ran, so a caller can ask again: the next
/// daemon takes it.
fn closing_refusal(cmd: &Value) -> Value {
    serde_json::json!({
        "id": cmd.get("id").cloned().unwrap_or(Value::Null),
        "success": false,
        "error": "This session is closing: the command did not run. Run it again to start a new session.",
        "code": "session_closing",
    })
}

fn close_completed_response(action: &str, response: &Value) -> bool {
    if !matches!(
        action,
        "close" | "confirm" | INTERNAL_DAEMON_SHUTDOWN_ACTION
    ) {
        return false;
    }

    fn data_closed(data: &Value) -> bool {
        data.get("closed").and_then(|v| v.as_bool()) == Some(true)
    }

    if response.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return false;
    }

    let Some(data) = response.get("data") else {
        return false;
    };
    if data_closed(data) {
        return true;
    }

    data.get("result").is_some_and(|result| {
        result.get("success").and_then(|v| v.as_bool()) == Some(true)
            && result.get("data").is_some_and(data_closed)
    })
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut sigint = match signal::unix::signal(signal::unix::SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(std::io::stderr(), "Failed to install SIGINT handler: {}", e);
                process::exit(1);
            }
        };
        let mut sigterm = match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(
                    std::io::stderr(),
                    "Failed to install SIGTERM handler: {}",
                    e
                );
                process::exit(1);
            }
        };
        let mut sighup = match signal::unix::signal(signal::unix::SignalKind::hangup()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(std::io::stderr(), "Failed to install SIGHUP handler: {}", e);
                process::exit(1);
            }
        };

        tokio::select! {
            _ = sigint.recv() => {}
            _ = sigterm.recv() => {}
            _ = sighup.recv() => {}
        }
    }

    #[cfg(windows)]
    {
        if let Err(e) = signal::ctrl_c().await {
            let _ = writeln!(std::io::stderr(), "Failed to install Ctrl+C handler: {}", e);
            process::exit(1);
        }
    }
}

fn get_daemon_socket_dir() -> PathBuf {
    crate::connection::get_socket_dir()
}

#[cfg(windows)]
fn get_port_for_session(session: &str) -> u16 {
    crate::connection::get_port_for_session(session)
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn test_resolve_idle_timeout_unset_applies_default() {
        let t = resolve_idle_timeout(None).expect("default should apply when unset");
        assert_eq!(t.ms, DEFAULT_IDLE_TIMEOUT_MS);
        assert!(t.is_default);
    }

    #[test]
    fn test_resolve_idle_timeout_explicit_zero_disables() {
        assert!(resolve_idle_timeout(Some("0".to_string())).is_none());
        assert!(resolve_idle_timeout(Some(" 0 ".to_string())).is_none());
    }

    #[test]
    fn test_resolve_idle_timeout_explicit_value_is_not_default() {
        let t = resolve_idle_timeout(Some("5000".to_string())).expect("explicit value");
        assert_eq!(t.ms, 5000);
        assert!(!t.is_default);
    }

    #[test]
    fn test_resolve_idle_timeout_unparseable_falls_back_to_default() {
        for raw in ["banana", "", "-1", "30s"] {
            let t = resolve_idle_timeout(Some(raw.to_string()))
                .unwrap_or_else(|| panic!("{:?} should fall back to default", raw));
            assert_eq!(t.ms, DEFAULT_IDLE_TIMEOUT_MS);
            assert!(t.is_default);
        }
    }

    #[test]
    fn test_default_idle_timeout_does_not_close_webdriver_sessions() {
        let mut state = DaemonState::new();
        assert!(!state.blocks_default_idle_shutdown());

        state.backend_type = crate::native::actions::BackendType::WebDriver;
        assert!(state.blocks_default_idle_shutdown());
    }

    /// Once a close has gone through, this daemon is on its way out, and what comes in then has a moment to get in: its
    /// socket is still there. A command run now would launch a browser for a process about to exit, which leaves it
    /// running with nobody holding it.
    #[tokio::test]
    async fn a_command_after_a_close_is_refused_not_run() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let state = Arc::new(tokio::sync::Mutex::new(DaemonState::new()));
        let while_busy = state.lock().await.while_busy.clone();
        let activity = Arc::new(IdleActivity::new());
        let notify = Arc::new(Notify::new());
        let ask = |line: &'static str| {
            let (state, while_busy, activity, notify) = (state.clone(), while_busy.clone(), activity.clone(), notify.clone());
            async move {
                let (mut ours, theirs) = tokio::io::duplex(4096);
                tokio::spawn(handle_connection(theirs, state, while_busy, activity, None, notify, None));
                ours.write_all(line.as_bytes()).await.unwrap();
                let mut answer = String::new();
                BufReader::new(ours).read_line(&mut answer).await.unwrap();
                serde_json::from_str::<Value>(&answer).unwrap()
            }
        };

        let closed = ask("{\"id\":\"1\",\"action\":\"close\"}\n").await;
        assert_eq!(closed["success"], true, "{closed}");
        let late = ask("{\"id\":\"2\",\"action\":\"state_list\"}\n").await;
        assert_eq!(late["success"], false, "{late}");
        assert_eq!(late["code"], "session_closing", "{late}");
        assert_eq!(late["id"], "2", "{late}");
    }

    /// What a session daemon says once its CLI has stopped listening has to land somewhere. This test is its own
    /// daemon: run again with `HOME` in a temp dir, it panics where a daemon would, and what it said is looked for.
    #[cfg(unix)]
    #[test]
    fn a_panic_after_the_cli_has_gone_is_kept() {
        const NAME: &str = "native::daemon::tests::a_panic_after_the_cli_has_gone_is_kept";
        if env::var_os("A_DAEMON_THAT_PANICS").is_some() {
            stop_talking_to_the_cli();
            panic!("the daemon fell over");
        }
        let home = tempfile::tempdir().unwrap();
        let ran = std::process::Command::new(env::current_exe().unwrap())
            .args([NAME, "--exact", "--nocapture"])
            .env("A_DAEMON_THAT_PANICS", "1")
            .env("HOME", home.path())
            .env_remove("AGENT_BROWSER_DEBUG")
            .output()
            .unwrap();
        assert!(!ran.status.success());
        let said: String = fs::read_dir(home.path().join(".agent-browser/logs"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|log| fs::read_to_string(log.path()).ok())
            .collect();
        assert!(said.contains("the daemon fell over"), "kept: {said:?}");
    }

    #[test]
    fn a_daemon_nobody_can_find_stops_waiting_for_a_person() {
        assert!(idle_daemon_waits(true, true, true), "a window may be in use");
        assert!(!idle_daemon_waits(true, true, false), "nothing can ever close it");
        assert!(!idle_daemon_waits(true, false, true));
        assert!(!idle_daemon_waits(false, true, true), "an explicit timeout applies regardless");
    }

    #[test]
    fn a_daemon_is_found_by_its_address_and_its_own_pid_file() {
        assert!(findable(Some("41\n"), true, 41));
        assert!(!findable(None, true, 41), "close --all can't list it");
        assert!(!findable(Some("41"), false, 41), "no CLI can reach it");
        assert!(!findable(Some("42"), true, 41), "the files are another process's");
        assert!(!findable(Some("garbage"), true, 41));
    }

    #[tokio::test]
    async fn test_idle_activity_receives_dashboard_activity() {
        let activity = Arc::new(IdleActivity::new());
        activity.mark();

        tokio::time::timeout(Duration::from_millis(100), activity.notified())
            .await
            .expect("dashboard input notification should wake the idle loop");
    }

    #[tokio::test]
    async fn test_command_completion_rearms_expired_idle_timeout() {
        let activity = IdleActivity::new();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(
            remaining_idle_timeout(&activity, 1).is_none(),
            "the original idle deadline should have expired"
        );

        // A command that held the daemon state lock past the deadline marks
        // completion before releasing the lock. The timeout path must then
        // wait for a new full idle period instead of closing immediately.
        activity.mark();
        assert!(remaining_idle_timeout(&activity, 100).is_some());
    }

    #[test]
    fn test_daemon_socket_dir_matches_client_namespace() {
        let guard = crate::test_utils::EnvGuard::new(&[
            "AGENT_BROWSER_SOCKET_DIR",
            "XDG_RUNTIME_DIR",
            "AGENT_BROWSER_NAMESPACE",
        ]);
        let dir = tempfile::tempdir().unwrap();
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("XDG_RUNTIME_DIR");
        guard.set("AGENT_BROWSER_NAMESPACE", "Worktree: One");

        let socket_dir = get_daemon_socket_dir();

        assert_eq!(socket_dir, crate::connection::get_socket_dir());
        assert!(socket_dir.ends_with(
            std::path::PathBuf::from("namespaces")
                .join("worktree-one")
                .join("run")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn test_port_matches_client_algorithm() {
        let guard = crate::test_utils::EnvGuard::new(&["AGENT_BROWSER_NAMESPACE"]);
        guard.remove("AGENT_BROWSER_NAMESPACE");

        assert_eq!(get_port_for_session("default"), 50838);
        assert_eq!(get_port_for_session("my-session"), 63105);
        assert_eq!(get_port_for_session("work"), 51184);
        assert_eq!(get_port_for_session(""), 49152);
    }

    /// A keyed door (Windows' loopback port) answers a caller without its key nothing: a line that isn't a command, or
    /// one without the key, ends the connection, and a line longer than any command is never held whole.
    #[tokio::test]
    async fn a_keyed_door_talks_to_no_one_before_the_key() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let state = std::sync::Arc::new(tokio::sync::Mutex::new(DaemonState::new()));
        let while_busy = state.lock().await.while_busy.clone();
        for line in ["not json\n".to_string(), "{\"id\":\"1\",\"action\":\"url\"}\n".to_string()] {
            let (mut ours, theirs) = tokio::io::duplex(1 << 16);
            let conn = tokio::spawn(handle_connection(theirs, state.clone(), while_busy.clone(), Arc::new(IdleActivity::new()), None, Arc::new(Notify::new()), Some(Arc::from("k"))));
            ours.write_all(line.as_bytes()).await.unwrap();
            let mut said = String::new();
            let _ = tokio::time::timeout(Duration::from_secs(5), ours.read_to_string(&mut said)).await;
            assert!(!said.contains("Invalid JSON") && !said.contains("\"success\":true"), "{line}: {said}");
            tokio::time::timeout(Duration::from_secs(5), conn).await.unwrap().unwrap();
        }
        assert!(PRE_KEY_LINE_LIMIT >= 1 << 20);
    }

    #[test]
    fn test_close_completed_response_requires_actual_close_result() {
        let confirmation_response = serde_json::json!({
            "success": true,
            "data": {
                "confirmation_required": true,
                "confirmation_id": "close-1",
                "action": "close"
            }
        });

        assert!(!close_completed_response("close", &confirmation_response));
    }

    #[test]
    fn test_close_completed_response_accepts_direct_and_confirmed_close() {
        let direct = serde_json::json!({
            "success": true,
            "data": { "closed": true }
        });
        let confirmed = serde_json::json!({
            "success": true,
            "data": {
                "confirmed": true,
                "action": "close",
                "result": {
                    "success": true,
                    "data": { "closed": true }
                }
            }
        });

        assert!(close_completed_response("close", &direct));
        assert!(close_completed_response(
            crate::connection::INTERNAL_DAEMON_SHUTDOWN_ACTION,
            &direct
        ));
        assert!(close_completed_response("confirm", &confirmed));
    }

    #[tokio::test]
    async fn test_background_tick_skips_busy_state() {
        let state = Arc::new(tokio::sync::Mutex::new(DaemonState::new()));
        let held = state.lock().await;

        for _ in 0..100 {
            assert!(!spawn_background_tick_if_idle(state.clone(), 30_000));
        }
        // Skipped ticks must not leave tasks queued on the lock.
        assert_eq!(Arc::strong_count(&state), 1);

        drop(held);
        assert!(spawn_background_tick_if_idle(state.clone(), 30_000));
        let _ = tokio::time::timeout(Duration::from_secs(1), state.lock())
            .await
            .expect("background tick should release the state lock");
    }

    /// Unbrowse fork: while a command holds the daemon's state (a script given minutes), a value the
    /// node asks the capture to forget is answered at once and named before anything else is written,
    /// and the tab list and DevTools address are answered as they were after the last command.
    #[tokio::test]
    async fn a_busy_daemon_still_forgets_a_secret_and_lists_its_tabs() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let dir = std::env::temp_dir().join(format!("busy-forget-{}-{}", std::process::id(), super::super::capture::now_secs()));
        let mut daemon_state = DaemonState::new();
        let mut log = super::super::capture::CaptureLog::open_in(&dir, "s").expect("capture log");
        log.write(serde_json::json!({ "type": "exchange", "entry": { "request": { "url": "https://a.example/login", "postData": { "text": "pw=Owner-Typed-77" } } } }));
        daemon_state.capture = Some(log);
        let while_busy = daemon_state.while_busy.clone();
        while_busy.seen(Some((vec![serde_json::json!({ "label": "ua", "targetId": "T1" })], "ws://127.0.0.1:1/devtools/browser/x".into())));
        let state = Arc::new(tokio::sync::Mutex::new(daemon_state));
        let held = state.lock().await;

        let (client, server) = tokio::io::duplex(1 << 16);
        let conn = tokio::spawn(handle_connection(server, state.clone(), while_busy.clone(), Arc::new(IdleActivity::new()), None, Arc::new(Notify::new()), None));
        let (read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(read).lines();
        let mut answers = Vec::new();
        for line in [
            r#"{"id":"f1","action":"capture_forget","value":"Owner-Typed-77"}"#,
            r#"{"id":"t1","action":"tab_list"}"#,
            r#"{"id":"c1","action":"cdp_url"}"#,
        ] {
            write.write_all(format!("{line}\n").as_bytes()).await.unwrap();
            let answer = tokio::time::timeout(Duration::from_secs(2), lines.next_line()).await.expect("answered while busy").unwrap().unwrap();
            answers.push(serde_json::from_str::<Value>(&answer).unwrap());
        }
        assert_eq!(answers[0]["success"], true, "{}", answers[0]);
        assert_eq!(answers[0]["data"]["queued"], true, "{}", answers[0]);
        assert_eq!(answers[1]["data"]["tabs"][0]["label"], "ua", "{}", answers[1]);
        assert_eq!(answers[2]["data"]["cdpUrl"], "ws://127.0.0.1:1/devtools/browser/x", "{}", answers[2]);

        // The command holding the state ends; the next write names the secret, in what the log holds too.
        let mut s = held;
        super::super::capture::flush(&mut s, false);
        drop(s);
        let written = std::fs::read_to_string(dir.join("s.jsonl")).unwrap();
        assert!(!written.contains("Owner-Typed-77"), "{written}");
        assert!(written.contains("secret:"), "{written}");
        conn.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Guard against re-introducing `waitpid(-1)` in daemon code.
    ///
    /// Issue #1035: a SIGCHLD handler that called `waitpid(-1, WNOHANG)` was
    /// added in v0.22.3 to reap zombie Chrome processes. This races with
    /// Rust's `Child::try_wait()` / `Child::wait()` because `waitpid(-1)`
    /// reaps *any* child, stealing the exit status before Rust can collect
    /// it. The result is ECHILD errors in `BrowserManager::has_process_exited()`
    /// and `ChromeProcess::kill()`, which can leave the daemon in a broken
    /// state or cause hangs on certain Linux configurations.
    ///
    /// The fix uses the existing 500ms drain interval to call
    /// `has_process_exited()` (which delegates to `Child::try_wait()`)
    /// for targeted, race-free zombie detection.
    #[test]
    fn test_no_waitpid_minus_one_in_daemon() {
        let source = include_str!("daemon.rs");
        // Only check production code (everything before `#[cfg(test)]`)
        let production_code = source.split("#[cfg(test)]").next().unwrap_or(source);
        assert!(
            !production_code.contains("waitpid(-1"),
            "daemon.rs production code must not call waitpid(-1, ...). \
             Use Child::try_wait() via has_process_exited() instead. \
             See issue #1035."
        );
    }

    /// Verify that `Child::try_wait()` correctly detects a crashed child
    /// without needing a global SIGCHLD handler or `waitpid(-1)`.
    /// This is what `has_process_exited()` uses in the fixed code.
    #[cfg(unix)]
    #[test]
    fn test_child_try_wait_detects_exit_without_sigchld_handler() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 42"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn child");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if std::time::Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("child did not exit before the deadline");
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(e) => panic!("try_wait() should succeed without waitpid(-1): {}", e),
            }
        };

        assert_eq!(status.code(), Some(42));
    }

    /// Regression test for #1101: idle timeout must fire even while the
    /// drain interval ticks every 500 ms.  The bug was that `sleep_future`
    /// was created **inside** the loop, so each drain tick dropped the
    /// in-progress sleep and replaced it with a fresh one – the timer
    /// could never reach its deadline.
    #[tokio::test]
    async fn test_idle_timeout_fires_despite_drain_interval() {
        let idle_timeout_ms: u64 = 1000;
        let mut drain_interval = tokio::time::interval(Duration::from_millis(500));
        drain_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let activity = IdleActivity::new();

        let start = tokio::time::Instant::now();

        let exited = tokio::time::timeout(Duration::from_secs(5), async {
            let mut idle_sleep_pin = Some(Box::pin(tokio::time::sleep(Duration::from_millis(
                idle_timeout_ms,
            ))));

            loop {
                tokio::select! {
                    _ = drain_interval.tick() => {}
                    _ = async {
                        match idle_sleep_pin {
                            Some(ref mut s) => s.as_mut().await,
                            None => std::future::pending::<()>().await,
                        }
                    } => {
                        break;
                    }
                    _ = activity.notified() => {
                        idle_sleep_pin = Some(Box::pin(
                            tokio::time::sleep(Duration::from_millis(idle_timeout_ms)),
                        ));
                        continue;
                    }
                }
            }
        })
        .await;

        let elapsed = start.elapsed();

        assert!(
            exited.is_ok(),
            "idle timeout never fired – loop ran for >5 s (bug #1101)"
        );
        assert!(
            elapsed < Duration::from_millis(idle_timeout_ms + 500),
            "idle timeout took too long: {:?} (expected ~{} ms)",
            elapsed,
            idle_timeout_ms,
        );
    }

    /// Verify that `ChromeProcess::has_exited()` (which uses `Child::try_wait()`)
    /// correctly detects a killed child, the same way the drain interval does
    /// in the fixed daemon code. This ensures crash detection works without
    /// a SIGCHLD handler.
    #[cfg(unix)]
    #[test]
    fn test_has_exited_detects_killed_process() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn child");

        // Process should be running
        match child.try_wait() {
            Ok(None) => {} // expected
            other => panic!("expected Ok(None) for running process, got {:?}", other),
        }

        // Kill it (simulates Chrome crash)
        child.kill().expect("failed to kill child");
        std::thread::sleep(std::time::Duration::from_millis(100));

        // try_wait should detect the exit
        match child.try_wait() {
            Ok(Some(_)) => {} // expected: detected the crash
            other => panic!(
                "expected Ok(Some(_)) after kill, got {:?}. \
                 Crash detection via try_wait() must work for the drain \
                 interval fix (issue #1035) to function correctly.",
                other
            ),
        }
    }
}
