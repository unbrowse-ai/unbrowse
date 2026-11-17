//! A session's files belong to the daemon that owns the session: no other process may take them or remove them.
#![cfg(unix)]

use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_agent-browser");
const SESSION: &str = "owned";

/// A daemon this test started; it goes with the test, whatever the test found.
struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn isolated(cmd: &mut Command, tmp: &TempDir) {
    cmd.env("AGENT_BROWSER_SOCKET_DIR", tmp.path())
        .env("HOME", tmp.path())
        .env_remove("XDG_RUNTIME_DIR")
        .env_remove("AGENT_BROWSER_NAMESPACE")
        .env_remove("AGENT_BROWSER_DEBUG");
}

fn start_daemon(tmp: &TempDir) -> Daemon {
    let mut cmd = Command::new(BIN);
    isolated(&mut cmd, tmp);
    Daemon(
        cmd.env("AGENT_BROWSER_DAEMON", "1")
            .env("AGENT_BROWSER_SESSION", SESSION)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    )
}

fn file(tmp: &TempDir, extension: &str) -> PathBuf {
    tmp.path().join(format!("{SESSION}.{extension}"))
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(25));
    }
}

fn listening(socket: &Path) -> bool {
    UnixStream::connect(socket).is_ok()
}

fn exited(daemon: &mut Daemon) -> bool {
    matches!(daemon.0.try_wait(), Ok(Some(_)))
}

fn start_ready_daemon(tmp: &TempDir) -> Daemon {
    let daemon = start_daemon(tmp);
    wait_for("the daemon's socket", || listening(&file(tmp, "sock")));
    daemon
}

/// A daemon that starts for a session already owned goes away, and says why on the stderr its CLI is reading: that is
/// how the CLI knows to use the winner. On the way out it touches nothing.
#[test]
fn a_second_daemon_for_a_session_leaves_the_owners_files_alone() {
    let tmp = TempDir::new().unwrap();
    let owner = start_ready_daemon(&tmp);
    let owner_pid = owner.0.id().to_string();
    let stream = std::fs::read_to_string(file(&tmp, "stream")).unwrap();

    let mut second = start_daemon(&tmp);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !exited(&mut second) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }

    assert!(exited(&mut second), "the second daemon stayed, holding a session it doesn't own");
    assert_eq!(std::fs::read_to_string(file(&tmp, "pid")).unwrap(), owner_pid);
    assert_eq!(std::fs::read_to_string(file(&tmp, "stream")).unwrap(), stream);
    assert!(listening(&file(&tmp, "sock")));
    let mut said = String::new();
    std::io::Read::read_to_string(second.0.stderr.as_mut().unwrap(), &mut said).unwrap();
    assert!(said.contains("Failed to bind"), "{said:?}");
}

/// What a daemon was started with is on disk before it answers, whatever becomes of the CLI that started it: a next CLI
/// that found nothing there would stop a healthy daemon, and its browser with it.
#[test]
fn a_daemon_writes_down_what_it_was_started_with_before_it_answers() {
    let tmp = TempDir::new().unwrap();
    let mut cmd = Command::new(BIN);
    isolated(&mut cmd, &tmp);
    let _daemon = Daemon(
        cmd.env("AGENT_BROWSER_DAEMON", "1")
            .env("AGENT_BROWSER_SESSION", SESSION)
            .env("AGENT_BROWSER_DAEMON_CONFIG", "the-fingerprint")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for("the daemon's socket", || listening(&file(&tmp, "sock")));
    assert_eq!(std::fs::read_to_string(file(&tmp, "config")).ok().as_deref(), Some("the-fingerprint"));
}

/// A daemon nobody can reach (its socket was removed) still owns its session. The next command stops it instead of
/// leaving it running beside a new one, where its exit would later remove the new one's files.
#[test]
fn a_daemon_nobody_can_reach_is_stopped_before_a_new_one_starts() {
    let tmp = TempDir::new().unwrap();
    let mut unreachable = start_ready_daemon(&tmp);
    std::fs::remove_file(file(&tmp, "sock")).unwrap();

    let mut close = Command::new(BIN);
    isolated(&mut close, &tmp);
    let done = close.args(["--session", SESSION, "close"]).output().unwrap();
    assert!(done.status.success(), "{}", String::from_utf8_lossy(&done.stderr));

    wait_for("the unreachable daemon to stop", || exited(&mut unreachable));
}

/// A process of no concern to this test's sessions, standing where a reused pid would.
fn unrelated_process() -> Daemon {
    Daemon(Command::new("sleep").arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap())
}

fn run_cli(tmp: &TempDir, args: &[&str]) -> std::process::Output {
    let mut cli = Command::new(BIN);
    isolated(&mut cli, tmp);
    cli.args(args).output().unwrap()
}

/// A pid file outlives its daemon, and the number comes round again. `close --all` never signals what it names unless
/// the session's lock says that process is the daemon.
#[test]
fn close_all_leaves_alone_a_process_a_stale_pid_file_names() {
    let tmp = TempDir::new().unwrap();
    let mut unrelated = unrelated_process();
    std::fs::write(file(&tmp, "pid"), unrelated.0.id().to_string()).unwrap();

    let done = run_cli(&tmp, &["close", "--all"]);
    assert!(done.status.success(), "{}", String::from_utf8_lossy(&done.stderr));

    thread::sleep(Duration::from_millis(200));
    assert!(!exited(&mut unrelated), "close --all killed a process that isn't a daemon");
    assert!(!file(&tmp, "pid").exists(), "the stale file goes, the process stays");
}

/// The daemon itself, unreachable, is still stopped: proving what it is takes nothing from it.
#[test]
fn close_all_stops_a_daemon_nobody_can_reach() {
    let tmp = TempDir::new().unwrap();
    let mut unreachable = start_ready_daemon(&tmp);
    std::fs::remove_file(file(&tmp, "sock")).unwrap();

    let done = run_cli(&tmp, &["close", "--all"]);
    assert!(done.status.success(), "{}", String::from_utf8_lossy(&done.stderr));
    wait_for("the unreachable daemon to stop", || exited(&mut unreachable));
}

/// `dashboard stop` goes by the same proof.
#[test]
fn dashboard_stop_leaves_alone_a_process_a_stale_pid_file_names() {
    let tmp = TempDir::new().unwrap();
    let mut unrelated = unrelated_process();
    std::fs::write(tmp.path().join("dashboard.pid"), unrelated.0.id().to_string()).unwrap();

    let done = run_cli(&tmp, &["dashboard", "stop"]);
    assert!(done.status.success(), "{}", String::from_utf8_lossy(&done.stderr));

    thread::sleep(Duration::from_millis(200));
    assert!(!exited(&mut unrelated), "dashboard stop signalled a process that isn't the dashboard");
}

/// `close` with no daemon has nothing to do, and says so without starting one. A daemon writes its log as it starts, so
/// the log's absence says none did.
#[test]
fn a_close_with_nothing_to_close_starts_no_daemon() {
    let tmp = TempDir::new().unwrap();
    let mut close = Command::new(BIN);
    isolated(&mut close, &tmp);
    let done = close.args(["--session", SESSION, "--json", "close"]).env("AGENT_BROWSER_DEBUG", "1").output().unwrap();
    assert!(done.status.success(), "{}", String::from_utf8_lossy(&done.stderr));
    assert!(String::from_utf8_lossy(&done.stdout).contains("\"closed\":true"), "{}", String::from_utf8_lossy(&done.stdout));
    assert!(!file(&tmp, "log").exists(), "a daemon was started to be closed");
}
