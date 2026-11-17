//! Passing a site's front door so plain calls can carry the session it mints.
//!
//! A route runs browserless with minted session values ([`crate::graph::Class::Minted`]);
//! when the site turns stale or asks a challenge, [`Mint`] is the callable interface
//! that passes the door and hands back the session. Backends:
//!
//! - [`BrowserMint`]: the fork's browser loads the page, challenge included, and
//!   the jar that came out is the session: a real browser, carrying the
//!   transport's own shape.
//! - A human handoff (the PRD's approval pattern) is the third backend an app
//!   adds; it needs UI, so it lives above this crate.

use std::process::Command;


#[derive(Debug, thiserror::Error)]
pub enum MintError {
    #[error("running the browser: {0}")]
    Browser(String),
}

/// A minted session: the cookie values a site's front door issued, and the
/// widget tokens the browser submitted while passing it (a Turnstile answer in
/// a form field, for instance). The shape is shared with the engine
/// (`agent-browser-core::session`) so the CLI, the node and the library agree
/// on what a mint produces.
pub use agent_browser_core::session::MintedSession;

/// Whether a field is a widget's answer: widgets submit it under `<widget>-response`, the rule the jar reads its
/// tokens by too (`client::Runner::with_session_cookies`), so a new widget needs no name added here.
fn is_widget_field(key: &str) -> bool {
    key.to_ascii_lowercase().ends_with("-response")
}

/// Whether the page open in the browser is a door, for a walk that asked for `asked` (`page::a_door`): read from the
/// page, since a door can sit at the site's own address, and a walk that stopped logging may be stopped at one.
fn at_a_door(ab: &dyn Fn(&[&str]) -> Result<String, MintError>, asked: &url::Url) -> Result<bool, MintError> {
    let out = ab(&["eval", "document.documentElement.outerHTML"])?;
    let html = serde_json::from_str::<String>(out.trim()).unwrap_or_else(|_| out.trim().to_string());
    Ok(crate::page::a_door(200, &html, asked))
}

/// Reads a sidecar capture log into a session: every `Set-Cookie` the site
/// issued, and every widget token the browser submitted — a form field, a JSON
/// leaf or a query parameter under a widget's name.
pub fn harvest_capture(raw: &str) -> MintedSession {
    let mut session = MintedSession::default();
    // One line per name, the jar's way (`keep_line`): the value and the reach, path and HttpOnly of the line that set it.
    let mut lines: std::collections::HashMap<String, CookieLine> = std::collections::HashMap::new();
    for line in raw.lines() {
        let Ok(o) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if o.get("type").and_then(|t| t.as_str()) != Some("exchange") {
            continue;
        }
        let set_at = o.pointer("/entry/request/url").and_then(|u| u.as_str()).and_then(|u| url::Url::parse(u).ok());
        for h in o.pointer("/entry/response/headers").and_then(|h| h.as_array()).into_iter().flatten() {
            if h.get("name").and_then(|n| n.as_str()).map(|n| n.eq_ignore_ascii_case("set-cookie")).unwrap_or(false) {
                if let Some(value) = h.get("value").and_then(|v| v.as_str()) {
                    if let Some((name, val)) = value.split_once('=') {
                        if let Some(end) = val.find(';') {
                            let name = name.trim().to_string();
                            let line = CookieLine {
                                value: val[..end].to_string(),
                                domain: agent_browser_core::session::set_cookie_domain(value),
                                path: set_at.as_ref().map(|at| crate::http::cookie_path(value, at)).unwrap_or_else(|| "/".into()),
                                http_only: crate::http::cookie_http_only(value),
                                expires: crate::http::cookie_expiry(value),
                            };
                            // A line that ends its cookie (set empty, or its life already over by Max-Age or Expires)
                            // takes out the one the session holds, when it names the same reach and path.
                            if line.value.is_empty() || crate::http::ends_the_cookie(value) {
                                if lines.get(&name).is_some_and(|held| same_scope(held.domain.as_deref(), &held.path, line.domain.as_deref(), &line.path)) {
                                    lines.remove(&name);
                                }
                                continue;
                            }
                            let kept = keep_line(lines.remove(&name), line);
                            lines.insert(name, kept);
                        }
                    }
                }
            }
        }
        // Widget tokens the browser submitted: in a form body, a JSON leaf or a
        // query parameter, under the widget's field name.
        let url = o.pointer("/entry/request/url").and_then(|u| u.as_str()).unwrap_or("");
        for (k, v) in url::form_urlencoded::parse(url.split_once('?').map(|(_, q)| q).unwrap_or("").as_bytes()) {
            if is_widget_field(&k) {
                session.tokens.insert(k.to_string(), v.to_string());
            }
        }
        let body = o.pointer("/entry/request/postData/text").and_then(|b| b.as_str()).unwrap_or("");
        if body.trim_start().starts_with('{') {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(body) {
                for (pointer, v) in crate::slots::json_leaves(&json) {
                    if let Some(key) = pointer.rsplit('/').next() {
                        if is_widget_field(key) {
                            session.tokens.insert(key.to_string(), v);
                        }
                    }
                }
            }
        } else {
            for (k, v) in url::form_urlencoded::parse(body.as_bytes()) {
                if is_widget_field(&k) {
                    session.tokens.insert(k.to_string(), v.to_string());
                }
            }
        }
    }
    for (name, line) in lines {
        line.into_session(&name, &mut session, true);
    }
    session
}

/// The browser program walks launch, any Chromium build: the node's pick (`set_chromium`), else the engine's own.
static CHROMIUM: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// Sets the browser every walk from here on launches; None: the engine's own pick.
pub fn set_chromium(path: Option<String>) {
    *CHROMIUM.write().unwrap_or_else(std::sync::PoisonError::into_inner) = path;
}

pub fn chromium() -> Option<String> {
    CHROMIUM.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}

/// Whether a walk may open a window when a headless browser can't get past a door: yes, unless the owner keeps windows
/// off (`set_windows`). A window passes doors a headless browser can't, and on a server or in a test bank it has nobody
/// to show.
static WINDOWS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Sets whether walks from here on may open a window.
pub fn set_windows(on: bool) {
    WINDOWS.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub fn windows() -> bool {
    WINDOWS.load(std::sync::atomic::Ordering::Relaxed)
}

/// What opens `url` on try `attempt` of a door: the first try is headless, and a later one shows a window so a person
/// can finish what the headless try couldn't, if windows are allowed. Every window this file opens is opened here.
fn opening<'a>(url: &'a str, attempt: usize, windows: bool, then: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec!["open", url];
    if attempt > 0 && windows {
        args.push("--headed");
    }
    args.extend_from_slice(then);
    args
}

/// How long a page gets to answer once it has been opened through the browser program, and how long the program gets to
/// let a closing browser go.
const PAGE_WAIT: std::time::Duration = std::time::Duration::from_secs(if cfg!(test) { 0 } else { 6 });
const CLOSE_WAIT: std::time::Duration = std::time::Duration::from_secs(if cfg!(test) { 0 } else { 2 });

/// Closes the browser a walk opened through the browser program when the walk ends, however it ends. Nothing comes back
/// to a walk's session, so a browser left open only holds the site's profile against the next one that needs it.
struct ClosesWithTheWalk<'a>(&'a dyn Fn(&[&str]) -> Result<String, MintError>);

impl Drop for ClosesWithTheWalk<'_> {
    fn drop(&mut self) {
        let _ = (self.0)(&["close"]);
    }
}

/// Closes the browser a signing bridge's visit launched for itself when the visit ends, however it ends. A visit in the
/// site's own browser is none of this guard's: `None` closes nothing.
struct ClosesWithTheVisit<'a>(Option<&'a dyn Fn(&[&str]) -> Option<String>>);

impl Drop for ClosesWithTheVisit<'_> {
    fn drop(&mut self) {
        if let Some(ab) = self.0 {
            ab(&["close"]);
        }
    }
}

/// The browser the engine launches on its own: the Chrome for Testing it downloaded, else a Chrome installed here.
pub fn engine_chromium() -> Option<std::path::PathBuf> {
    agent_browser_core::cdp::chrome::find_chrome()
}

/// The Chrome for Testing the engine downloaded (its `install` command), if it has.
pub fn downloaded_chromium() -> Option<std::path::PathBuf> {
    agent_browser_core::paths::find_installed_chrome()
}

/// Has `cmd` run the browser CLI on the node's settings alone: none of the agent-browser settings this process was
/// started with (its `AGENT_BROWSER_*` variables, a config file in the user's home or the folder it runs in) choose
/// which browser a session attaches to, what it goes through or what it loads. The CLI reads a config file the node
/// writes, holding nothing, runs in the node's own folder, and keeps any browser started without a profile in a
/// folder of the node's. Its daemon, and the browser under it, close after [`PROGRAM_IDLE`] without a command.
pub fn on_its_own(cmd: &mut Command, home: &std::path::Path) -> Result<(), String> {
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("AGENT_BROWSER_") {
            cmd.env_remove(&key);
        }
    }
    cmd.env("AGENT_BROWSER_IDLE_TIMEOUT_MS", PROGRAM_IDLE.as_millis().to_string());
    let _ = std::fs::create_dir_all(home);
    let config = home.join("browser-config.json");
    if std::fs::read_to_string(&config).ok().as_deref() != Some("{}") {
        let fresh = home.join(format!("browser-config.json.{}", std::process::id()));
        std::fs::write(&fresh, "{}").and_then(|_| std::fs::rename(&fresh, &config)).map_err(|e| format!("the node's browser has no settings: {e}"))?;
    }
    cmd.current_dir(home).env("AGENT_BROWSER_RUNTIME_DIR", home.join("browser-runtime")).arg("--config").arg(&config);
    Ok(())
}

/// A session of the browser program the node gave a command in: the program, the session, and the folder the program
/// keeps the session's files in (`sockets`; None: the program's own default for the node's environment). The program's
/// daemon outlives the command by design, until idle for [`PROGRAM_IDLE`], and the node's record of the browsers it
/// launched itself (`agent_browser_core::cdp::launched`) holds none of the program's: so these are noted apart, and
/// closed with the node ([`close_program_sessions`]). Kept on disk as well, beside that record, for a node that died.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
pub struct ProgramSession {
    pub program: String,
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sockets: Option<std::path::PathBuf>,
}

static PROGRAM_SESSIONS: std::sync::Mutex<std::collections::BTreeSet<ProgramSession>> = std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Where the program-session records of a home are kept: beside the record of the browsers the node launched.
fn program_sessions_dir(home: &std::path::Path) -> std::path::PathBuf {
    home.join("browsers-launched")
}

fn program_session_file(home: &std::path::Path, s: &ProgramSession) -> std::path::PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    program_sessions_dir(home).join(format!("program-{:016x}.session", h.finish()))
}

/// Notes a session of the browser program the node gives a command in (`sockets`: the folder it names for the
/// program's files, if it names one), once.
pub fn noted_program_session(program: &str, session: &str, sockets: Option<&std::path::Path>) {
    let s = ProgramSession { program: program.to_string(), session: session.to_string(), sockets: sockets.map(std::path::Path::to_path_buf) };
    let new = PROGRAM_SESSIONS.lock().map(|mut all| all.insert(s.clone())).unwrap_or(false);
    if new {
        let home = unbrowse_files::private::home();
        let _ = std::fs::create_dir_all(program_sessions_dir(&home));
        if let Ok(text) = serde_json::to_string(&s) {
            let _ = std::fs::write(program_session_file(&home, &s), text);
        }
    }
}

/// The folder the program keeps a session's files in: the one the node named, else the program's default for this
/// environment (as `connection::get_socket_dir` reads it: a runtime folder, else the home's `.agent-browser`).
fn program_files_of(s: &ProgramSession) -> Option<std::path::PathBuf> {
    s.sockets.clone().or_else(|| {
        std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()).map(|d| std::path::PathBuf::from(d).join("agent-browser")).or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".agent-browser")))
    })
}

/// Closes every session of the browser program the node noted (in this process, and on disk by a node of this home
/// that died) whose daemon is still there (its pid file in the session's folder), by the program's own `close`: it
/// reaches only the daemon listening for that session, which closes its browser and exits. A session with no daemon
/// left is not asked, so no daemon is started to be closed. Every record is removed. Answers how many it closed.
pub fn close_program_sessions(home: &std::path::Path) -> usize {
    let mut all: std::collections::BTreeSet<ProgramSession> = PROGRAM_SESSIONS.lock().map(|mut s| std::mem::take(&mut *s)).unwrap_or_default();
    let dir = program_sessions_dir(home);
    for f in std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|f| f.path()).filter(|p| p.extension().is_some_and(|x| x == "session")) {
        if let Some(s) = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str::<ProgramSession>(&t).ok()) {
            all.insert(s);
        }
        let _ = std::fs::remove_file(&f);
    }
    let mut closed = 0;
    for s in &all {
        let _ = std::fs::remove_file(program_session_file(home, s));
        if !program_files_of(s).is_some_and(|d| d.join(format!("{}.pid", s.session)).exists()) {
            continue;
        }
        let mut cmd = Command::new(&s.program);
        if on_its_own(&mut cmd, home).is_err() {
            continue;
        }
        if let Some(d) = &s.sockets {
            cmd.env("AGENT_BROWSER_SOCKET_DIR", d);
        }
        cmd.args(["--session", &s.session, "close"]);
        if ran(cmd, std::time::Duration::from_secs(10)).is_ok_and(|o| o.status.success()) {
            closed += 1;
        }
    }
    closed
}

/// How long a browser the node starts through the browser program stays open without a command before its daemon
/// closes it: the browse sessions' own idle time (a tab idle this long is closed), so a session nobody drives, or one
/// whose node ended without closing it (a test process, a crash), never holds a browser for good. Stated to the
/// program on every command; left unstated, the program's own default waited an hour and never closed one it took for
/// a person's.
pub const PROGRAM_IDLE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

thread_local! {
    /// The stop flag of the ask this thread works for ([`stops_with`]), handed to each walk it starts.
    static STOP: std::cell::RefCell<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>> = const { std::cell::RefCell::new(None) };
}

/// Runs `work` for an ask that can give up: each walk `work` starts on this thread ends when `stop` is set (the
/// engine's `MintOptions::stop`), and [`asked_to_stop`] says so to whatever waits on its behalf.
pub fn stops_with<T>(stop: std::sync::Arc<std::sync::atomic::AtomicBool>, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<std::sync::Arc<std::sync::atomic::AtomicBool>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            STOP.with(|s| *s.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(STOP.with(|s| s.borrow_mut().replace(stop)));
    work()
}

/// Whether the ask this thread works for has given up.
pub fn asked_to_stop() -> bool {
    STOP.with(|s| s.borrow().as_ref().is_some_and(|f| f.load(std::sync::atomic::Ordering::Relaxed)))
}

/// How long one bridge command may take. A browser or a daemon that has stopped answering ends the bridge's answer
/// rather than the call: a step no bridge answered is a step the browser runs, as it always was.
const CLI_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Runs a bridge command and reads its output, ending it at `wait`: a command that never returns must not hold the
/// call. `None` when it didn't finish or couldn't be started.
fn bounded(cmd: Command, wait: std::time::Duration) -> Option<String> {
    ran(cmd, wait).ok().map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The longest one command of the browser program runs, past which it is stopped. Its own waits end well inside this:
/// the browser's launch (30 s), the program's daemon starting, and the answer to the command itself (its own timeout,
/// else 40 s: `agent_browser_core::connection::read_timeout_for`). A command given a longer timeout of its own is
/// given that much more (`most_for`).
pub const PROGRAM_MOST: std::time::Duration = std::time::Duration::from_secs(180);

/// How long `args`, a command of the browser program, may run: [`PROGRAM_MOST`], and the time the command asks for
/// itself on top (an `eval --timeout <ms>`, a `wait <ms>`).
pub fn most_for<S: AsRef<std::ffi::OsStr>>(args: &[S]) -> std::time::Duration {
    let words: Vec<String> = args.iter().map(|a| a.as_ref().to_string_lossy().into_owned()).collect();
    let ms = |w: Option<&String>| w.and_then(|w| w.parse::<u64>().ok()).unwrap_or(0);
    let asked = words.iter().enumerate().map(|(i, w)| if w == "--timeout" || (w == "wait" && i == 0) { ms(words.get(i + 1)) } else { 0 }).max().unwrap_or(0);
    PROGRAM_MOST + std::time::Duration::from_millis(asked)
}

/// Runs the browser program (or any command) to its end and reads what it said, stopping it at `most`. What it says
/// goes to files, never to pipes: the program leaves processes running after it exits (its daemon, the browser), and
/// one holding a pipe's write end keeps a read of the pipe waiting until that process exits, not the command.
/// `Command::output` reads to the pipes' end, so it waited on the daemon. On Windows a process inherits every handle
/// its parent may pass on, so the daemon the program starts holds the program's output, and a command that started
/// the browser never ended (issue #545: the site's browser held "busy" for minutes after a `do`). Waiting for the
/// command's own exit, and reading files, ends with the command on every system.
pub fn ran(mut cmd: Command, most: std::time::Duration) -> Result<std::process::Output, String> {
    use std::process::Stdio;
    static RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // In the node's own scratch folder, each file made new and the owner's alone: a name someone else made first (a
    // link planted in a shared temp folder) is never written through, and what the program said is never read by
    // another user.
    let dir = unbrowse_files::private::scratch().map_err(|e| format!("the node's scratch folder: {e}"))?;
    let file = |what: &str| dir.join(format!("unbrowse-program-{}-{n}.{what}", std::process::id()));
    let (out_path, err_path) = (file("out"), file("err"));
    let fresh = |p: &std::path::Path| -> std::io::Result<std::fs::File> {
        let mut open = std::fs::OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
        open.open(p)
    };
    let made = (|| -> std::io::Result<std::process::Child> {
        let (out, err) = (fresh(&out_path)?, fresh(&err_path)?);
        cmd.stdin(Stdio::null()).stdout(Stdio::from(out)).stderr(Stdio::from(err)).spawn()
    })();
    let ended = made.map_err(|e| e.to_string()).and_then(|mut child| {
        let deadline = std::time::Instant::now() + most;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Ok(status),
                Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(25)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("it was still running after {} s, and was stopped", most.as_secs()));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    });
    let read = |p: &std::path::Path| std::fs::read(p).unwrap_or_default();
    let (stdout, stderr) = (read(&out_path), read(&err_path));
    let _ = std::fs::remove_file(&out_path);
    let _ = std::fs::remove_file(&err_path);
    Ok(std::process::Output { status: ended?, stdout, stderr })
}

/// The CLI for a session, launching the chosen browser when it has to start one. The launch (the browser and its
/// profile) goes with every command alike: a command that names a launch the browser isn't running, its profile left
/// out included, relaunches it, and the page it had open is gone.
/// It runs on the node's settings alone ([`on_its_own`]): its sessions are the node's, never those of an agent-browser
/// the user runs with their own settings.
fn cli(browser: &str, session: &str, profile: Option<&str>) -> Result<Command, MintError> {
    cli_at(browser, session, profile, None)
}

/// The CLI for a session, attached to a browser already running at `cdp` when one is: a profile is open in one browser
/// at a time, so a second launch on it would be refused (and the page it needed never load). `--cdp` puts these
/// commands in the browser the node already has, which is also the one whose cookies the jar came from.
///
/// A command that may launch a browser (any not attached with `--cdp`) carries the launch's switches, the egress
/// proxy's among them, on every command alike, so whichever command starts the browser starts it inside the rule. When
/// the proxy can't be started, no command is made: an error, and nothing is launched.
fn cli_at(browser: &str, session: &str, profile: Option<&str>, cdp: Option<&str>) -> Result<Command, MintError> {
    noted_program_session(browser, session, None);
    let mut cmd = Command::new(browser);
    cmd.args(["--session", session]);
    if cdp.is_none() {
        if let Some(p) = profile {
            cmd.args(["--profile", p]);
        }
        cmd.args(["--args", &launch_switches()?.join(",")]);
    }
    if let Err(e) = on_its_own(&mut cmd, &unbrowse_files::private::home()) {
        eprintln!("   [mint] {e}");
    }
    // The browser's address carries its debugger's secret: in the environment, which only this user can read, never on
    // the command line, which every user on the machine can (`ps`, /proc/<pid>/cmdline).
    if let Some(endpoint) = cdp {
        cmd.env("AGENT_BROWSER_CDP", endpoint);
    }
    if let Some(p) = chromium() {
        cmd.env("AGENT_BROWSER_EXECUTABLE_PATH", p);
    }
    Ok(cmd)
}

/// The switches a browser this file launches through the program runs with: the egress proxy's
/// ([`crate::proxy::switches`]), and no automation flag for a page to read. The CLI takes them as one comma-separated
/// value after `--args`.
fn launch_switches() -> Result<Vec<String>, MintError> {
    let mut switches = vec!["--disable-blink-features=AutomationControlled".to_string()];
    switches.extend(crate::proxy::switches().map_err(MintError::Browser)?);
    Ok(switches)
}

pub use agent_browser_core::session::SeedCookie;
pub use agent_browser_core::session::CookieFacts;

/// Reads the page's storages through the browser program (the fallback mint, for a machine where the engine can't
/// launch Chrome): one expression, so both come back in one round trip.
const STORAGE_JS: &str = "JSON.stringify({local:Object.fromEntries(Object.entries(localStorage).slice(0,200)),session:Object.fromEntries(Object.entries(sessionStorage).slice(0,200))})";

/// The map `which` names in what the program said. The program may say a line before its JSON, and may wrap it, so
/// the object is taken from the first `{"local"` to the last `}`; anything else is no storage rather than an error.
fn storage_map(said: &str, which: &str) -> std::collections::HashMap<String, String> {
    let Some(start) = said.find("{\"local\"").or_else(|| said.find('{')) else { return Default::default() };
    let Some(end) = said.rfind('}') else { return Default::default() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&said[start..=end]) else { return Default::default() };
    v.get(which)
        .and_then(|m| m.as_object())
        .map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
        .unwrap_or_default()
}


/// The fork's browser as the door-passer: it opens `url` (challenge included,
/// retrying if one is served), reads the cookie jar that came out, and hands it
/// back as the session. The browser must be given time; a challenge takes a few
/// seconds to clear.
pub struct BrowserMint {
    /// Path to the fork's `agent-browser` CLI.
    pub browser: String,
    /// The daemon session name to browse under.
    pub session: String,
    /// Where the sidecar writes its passive capture, which is how the jar is
    /// read back: `<dir>/<session>.jsonl` holds the exchanges.
    pub capture_dir: std::path::PathBuf,
    /// The site this mint serves; `_host` only marks the struct's intent for
    /// the caller that constructs it.
    pub _host: String,
    /// The user agent the walk presents. `None` leaves Chrome's own: a site
    /// that refuses an unknown agent is passed by presenting a browser's.
    pub user_agent: Option<String>,
    /// An existing browser to mint through, as a CDP endpoint: with it the
    /// node launches nothing at all.
    pub cdp_endpoint: Option<String>,
    /// A persistent Chrome profile for the site, so each mint runs in a
    /// browser that remembers: cookies, history and the reputation a challenge
    /// scores accumulate across runs. The difference between a fresh profile
    /// (challenged every time) and a warm one (passes without a click).
    pub profile: Option<String>,
    /// Try the page's controls once it has settled (`MintOptions::try_controls`): only in a profile with no account.
    pub try_controls: bool,
    /// Where pictures of the walk go while it runs, for whoever watches it.
    pub frames: Option<agent_browser_core::screencast::FrameSink>,
    /// The session the node keeps for the site, which the walk's browser starts with (`MintOptions::cookies`).
    pub seed: Vec<agent_browser_core::session::SeedCookie>,
}

/// Passes a site's front door, returning the session it mints.
pub trait Mint {
    fn mint(&mut self, url: &url::Url) -> Result<MintedSession, MintError>;
}

/// Waits until the capture log stops growing: poll the line count and return
/// once two consecutive checks half a second apart see no change, or the budget
/// runs out. Returns whether it settled inside the budget, so a slow page can
/// fall through to a second pass.
fn wait_settled(
    ab: &dyn Fn(&[&str]) -> Result<String, MintError>,
    dir: &std::path::Path,
    budget_secs: u64,
) -> Result<bool, MintError> {
    let _ = ab; // the daemon holds the capture open; the dir is read directly
    let mut last = 0usize;
    let mut stable = 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(budget_secs);
    loop {
        let mut count = 0usize;
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                if e.path().extension().is_some_and(|x| x == "jsonl") {
                    if let Ok(meta) = e.metadata() {
                        count += meta.len() as usize;
                    }
                }
            }
        }
        if count == last && last > 0 {
            stable += 1;
            if stable >= 2 {
                return Ok(std::time::Instant::now() < deadline);
            }
        } else {
            stable = 0;
        }
        last = count;
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// The DevTools address of the browser holding `profile` now, proven to be that browser
/// ([`agent_browser_core::cdp::chrome::proven_profile_endpoint`]): a `DevToolsActivePort` file alone names a port anyone
/// may answer on by now. None when nothing proves it, and the walk launches its own browser instead.
pub(crate) fn live_endpoint_of(profile: &str) -> Option<String> {
    let dir = std::path::PathBuf::from(profile);
    // Its own thread and runtime: a caller may be on a runtime of its own, which can't be blocked on from inside.
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
        rt.block_on(agent_browser_core::cdp::chrome::proven_profile_endpoint(&dir, std::time::Duration::from_secs(2)))
    })
    .join()
    .ok()
    .flatten()
}

/// The lock a session's page visits take, one per session name ([`BrowserMint::signed_page`]).
fn one_visit_at_a_time(session: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    static VISITS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>> = std::sync::OnceLock::new();
    let all = VISITS.get_or_init(Default::default);
    let mut all = all.lock().unwrap_or_else(|e| e.into_inner());
    all.entry(session.to_string()).or_default().clone()
}

impl BrowserMint {
    /// Closes the browser this mint's session opened through the program, once nothing more will run in it.
    pub(crate) fn close(&self) {
        if let Ok(mut cmd) = cli_at(&self.browser, &self.session, self.profile.as_deref(), self.cdp_endpoint.as_deref()) {
            cmd.arg("close");
            let _ = ran(cmd, most_for(&["close"]));
        }
    }

    /// Executes one request in the browser: the site's page is open (for
    /// same-origin context and its cookies), then a `fetch` with the request's
    /// method, headers and body runs in it. Works for POSTs, which a plain
    /// navigation can't carry. The response comes back as an [`Exchange`], and
    /// every cookie the browser picked up joins the jar.
    /// Every call the page's own code makes when opened at `page_url`, read from the browser the node runs: the
    /// page is opened with the caller's values in its address, its scripts make the calls and sign them, and each
    /// request is returned as the page made it — its address, headers and body. This is the general signing bridge:
    /// it knows no site, and a page that renders through a real DOM (a framework app) is exactly what a browser is
    /// for. A page with no call at a step's path answers nothing for that step, and the step is walled.
    pub fn signed_page(&self, page_url: &str) -> Vec<(String, crate::sandbox::Signed)> {
        // The whole visit holds the browser-visit lock, so a checkout hold can't begin while it runs (`hold::visit`).
        let Some(_visit) = url::Url::parse(page_url).ok().and_then(|u| crate::hold::visit(&u).ok()) else {
            return Vec::new();
        };
        // The browser the node already has for this site first (its profile is open in one browser at a time, and that
        // is the one whose cookies the jar came from). A browser that doesn't answer ends the attempt at once; a visit
        // that records nothing is tried once more in a browser of the bridge's own, whose profile nobody else holds.
        let first = (self.cdp_endpoint.as_deref(), self.profile.as_deref());
        let own = (None, None);
        // One visit at a time in a session: a visit clears the session's request log, opens its page and reads every
        // request logged, so two at once in one session read each other's pages, and one value's call takes another
        // value's request (two calls of a page-signed route, a value's and the route's first, ran at once live).
        let lock = one_visit_at_a_time(&self.session);
        let _visiting = lock.lock().unwrap_or_else(|e| e.into_inner());
        for (cdp, profile) in [first, own] {
            let made = self.visit(page_url, cdp, profile);
            if !made.is_empty() {
                return made;
            }
            if cdp.is_none() && profile.is_none() {
                break;
            }
        }
        Vec::new()
    }

    /// One visit of `page_url` in the browser `cdp` names, or one launched in `profile`, and the calls it makes. A
    /// browser the visit launched itself is closed when the visit ends, however it ends: nothing else works in it, and
    /// one left open holds its profile and its processes for an hour (the Eden report's leftover browsers).
    fn visit(&self, page_url: &str, cdp: Option<&str>, profile: Option<&str>) -> Vec<(String, crate::sandbox::Signed)> {
        let ab = |args: &[&str]| -> Option<String> {
            let mut cmd = cli_at(&self.browser, &self.session, profile, cdp).ok()?;
            cmd.args(args);
            bounded(cmd, CLI_WAIT)
        };
        // A visit in the site's own browser (a cdp endpoint, or the site's profile) is not this visit's to close: the
        // profile opens in one browser at a time, and the calls around it are working there.
        let mut _closes = ClosesWithTheVisit((cdp.is_none() && profile.is_none()).then_some(&ab as &dyn Fn(&[&str]) -> Option<String>));
        // The CLI records requests only once it is asked to list them, and a clear on its own returns before it turns
        // recording on: ask for the list first, so the visit after it is recorded.
        ab(&["--json", "network", "requests"]);
        // Only this visit's calls: a stale one from an earlier visit is not this call's answer.
        ab(&["network", "requests", "--clear"]);
        if ab(&["open", page_url]).is_none() {
            return Vec::new();
        }
        // The page's calls are made while it renders; read until one lands, then take them all. The CLI may say what
        // it is doing before its JSON (`[agent-browser] launched browser`): the document is the part from the first
        // brace to the last.
        let read = || -> Option<serde_json::Value> {
            let out = ab(&["--json", "network", "requests"])?;
            let start = out.find('{')?;
            let end = out.rfind('}')?;
            serde_json::from_str(out[start..=end].trim()).ok()
        };
        let calls = |said: &Option<serde_json::Value>| -> Vec<serde_json::Value> {
            said.as_ref().and_then(|v| v.pointer("/data/requests")).and_then(|r| r.as_array()).cloned().unwrap_or_default()
        };
        std::thread::sleep(PAGE_WAIT);
        let mut said = read();
        // Opening the address the page already stands on can be served from the page in front of us, which makes no
        // new calls: reload it, so its own code runs again and signs this visit's request.
        if calls(&said).is_empty() {
            ab(&["reload"]);
            std::thread::sleep(PAGE_WAIT);
            said = read();
        }
        for _ in 0..6 {
            if !calls(&said).is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
            said = read();
        }
        // A page keeps making calls after its first ones (a widget that renders late, a module that loads on idle): read
        // once more a few seconds on, when the list is what the page did since the clear, so nothing is lost by waiting.
        if !calls(&said).is_empty() {
            std::thread::sleep(std::time::Duration::from_secs(4));
            if let Some(later) = read() {
                let count = later.pointer("/data/requests").and_then(|r| r.as_array()).map_or(0, Vec::len);
                if count >= calls(&said).len() {
                    said = Some(later);
                }
            }
        }
        let requests = calls(&said);
        if requests.is_empty() {
            eprintln!("   [mint] the page at {page_url} made no calls to read");
            return Vec::new();
        }
        requests
            .iter()
            .filter_map(|r| {
                let url = r.get("url")?.as_str()?;
                let method = r.get("method")?.as_str()?.to_string();
                let headers = r.get("headers")?.as_object()?;
                let path = url::Url::parse(url).map(|u| u.path().to_string()).ok()?;
                Some((
                    format!("{method} {path}"),
                    crate::sandbox::Signed {
                        method: method.to_uppercase(),
                        url: url.to_string(),
                        headers: headers.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect(),
                        body: r.get("postData").and_then(|b| b.as_str()).map(|b| b.as_bytes().to_vec()),
                        modules: Vec::new(),
                        values: Vec::new(),
                        by: crate::rung::Rung::Page,
                    },
                ))
            })
            .collect()
    }

    /// The answer the page itself got, in the node's browser, to one of its own calls: the last request the open page
    /// made that `wanted` names (by method and address) and that the site answered 2xx, with the body the browser
    /// holds for it. A site that refuses a copy of the page's request sent from anywhere else has still answered
    /// the page, and that answer is the call's. None when the page made no such call, or its answer is not text.
    pub fn answered_on_page(&self, wanted: &dyn Fn(&str, &str, Option<&str>) -> bool) -> Option<crate::trace::Exchange> {
        let ab = |args: &[&str]| -> Option<serde_json::Value> {
            let mut cmd = cli_at(&self.browser, &self.session, self.profile.as_deref(), self.cdp_endpoint.as_deref()).ok()?;
            cmd.args(args);
            let out = bounded(cmd, CLI_WAIT)?;
            serde_json::from_str(out.get(out.find('{')?..=out.rfind('}')?)?.trim()).ok()
        };
        let listed = ab(&["--json", "network", "requests"])?;
        let made = listed.pointer("/data/requests")?.as_array()?;
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
            let named: Vec<&serde_json::Value> = made.iter().filter(|r| r.get("method").and_then(|m| m.as_str()).zip(r.get("url").and_then(|u| u.as_str())).is_some_and(|(m, u)| wanted(m, u, r.get("postData").and_then(|b| b.as_str())))).collect();
            eprintln!("   [mint] the open page lists {} requests, {} of them the call asked for, with statuses {:?}", made.len(), named.len(), named.iter().map(|r| r.get("status").cloned().unwrap_or_default()).collect::<Vec<_>>());
        }
        let (id, entry) = made.iter().rev().find_map(|r| {
            let (method, url, status) = (r.get("method")?.as_str()?, r.get("url")?.as_str()?, r.get("status")?.as_i64()?);
            // The request's own body says which operation it asked, where many share one address.
            ((200..300).contains(&status) && wanted(method, url, r.get("postData").and_then(|b| b.as_str()))).then(|| Some((r.get("requestId")?.as_str()?.to_string(), r.clone())))?
        })?;
        let detail = ab(&["--json", "network", "request", &id])?;
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
            eprintln!("   [mint] its answer as the browser holds it: {}", detail.pointer("/data/responseBody").and_then(|b| b.as_str()).map_or("none".to_string(), |b| format!("{} characters", b.len())));
        }
        let body = detail.pointer("/data/responseBody")?.as_str()?.to_string();
        if body.is_empty() || body.starts_with("[base64, ") {
            return None;
        }
        Some(crate::trace::Exchange {
            method: entry.get("method")?.as_str()?.to_string(),
            url: entry.get("url")?.as_str()?.parse().ok()?,
            request_headers: vec![],
            request_body: None,
            status: entry.get("status")?.as_i64()? as u16,
            response_headers: vec![],
            response_body: Some(body),
            response_mime: entry.get("mimeType").and_then(|m| m.as_str()).unwrap_or("application/json").to_string(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        })
    }

    pub fn execute(&mut self, req: &crate::replay::Request) -> Result<crate::trace::Exchange, MintError> {
        let _visit = crate::hold::visit(&req.url).map_err(MintError::Browser)?;
        let origin = format!("{}://{}/", req.url.scheme(), req.url.host_str().unwrap_or_default());
        let ab = |args: &[&str]| -> Result<String, MintError> {
            let mut cmd = cli_at(&self.browser, &self.session, self.profile.as_deref(), self.cdp_endpoint.as_deref())?;
            cmd.args(args);
            let out = bounded(cmd, CLI_WAIT).ok_or_else(|| MintError::Browser("the browser didn't answer".into()))?;
            Ok(out)
        };
        // Keep-alive: a page already open on this origin is a warm context —
        // the site's cookies and clearance are already in it, and a fetch from
        // it is as good as the page's own XHR. Opening costs seconds; reusing
        // costs nothing. Only a challenge (the page left the origin, or a
        // block page sits on it) re-opens.
        let current = ab(&["get", "url"]).unwrap_or_default();
        let warm = current.starts_with(&origin) && !at_a_door(&ab, &req.url)?;
        let outcome = self.fetched(req, warm);
        // A call that fails has nothing of its own left to close what it opened: the caller closes only after a step
        // was walled, and a failed step never is (the Eden report's browsers left open by failed learns). A failure
        // ends the route's call, so this session's browser goes here — what a later step would have reused is not
        // coming, and a browser left up holds the site's profile against the next walk.
        if outcome.is_err() {
            let _ = ab(&["close"]);
        }
        outcome
    }

    /// Everything [`Self::execute`] does past the keep-alive check: in the page it finds warm, or one it opens (four
    /// tries at the door, headless first), the fetch running in that page's own context.
    fn fetched(&self, req: &crate::replay::Request, warm: bool) -> Result<crate::trace::Exchange, MintError> {
        let origin = format!("{}://{}/", req.url.scheme(), req.url.host_str().unwrap_or_default());
        let ab = |args: &[&str]| -> Result<String, MintError> {
            let mut cmd = cli_at(&self.browser, &self.session, self.profile.as_deref(), self.cdp_endpoint.as_deref())?;
            cmd.args(args);
            let out = bounded(cmd, CLI_WAIT).ok_or_else(|| MintError::Browser("the browser didn't answer".into()))?;
            Ok(out)
        };
        // A step that is a page is run by going to it, as the walk did and as a person would: a door that lets a
        // browser navigate to a page refuses the same address asked for by a script on another page, so fetching it
        // from the page's context met the wall the browser had just passed.
        if navigates(req) {
            if !warm {
                ab(&["close"])?;
                std::thread::sleep(CLOSE_WAIT);
            }
            let mut page = None;
            for attempt in 0..if warm { 1 } else { 4 } {
                // A page heavy with other sites' frames may never finish loading by the browser's count, and the
                // command to open it then gives up waiting. The page is there all the same: it is read, and what it
                // holds decides, not whether its last advert arrived.
                let opened = match warm {
                    true => ab(&["open", req.url.as_str()]),
                    false => ab(&opening(req.url.as_str(), attempt, windows(), &[])),
                };
                let _ = opened;
                std::thread::sleep(PAGE_WAIT);
                // Read until the page has something on it: one still blank a moment after it was opened is on its
                // way, not a wall.
                let mut html = String::new();
                for _ in 0..4 {
                    let out = ab(&["eval", "document.documentElement.outerHTML"])?;
                    html = serde_json::from_str::<String>(out.trim()).unwrap_or_else(|_| out.trim().to_string());
                    if html.len() > 2_000 {
                        break;
                    }
                    std::thread::sleep(PAGE_WAIT / 2);
                }
                if !crate::page::a_door(200, &html, &req.url) {
                    page = Some(html);
                    break;
                }
            }
            let Some(html) = page else { return Err(MintError::Browser("the site kept challenging the browser".into())) };
            let landed = ab(&["get", "url"]).ok().and_then(|u| url::Url::parse(u.trim().trim_matches('"')).ok()).unwrap_or_else(|| req.url.clone());
            let mut response_headers = Vec::new();
            if let Ok(cookies) = ab(&["--json", "cookies", "get"]) {
                for (k, v) in cookies_sent_to(&cookies, req.url.host_str().unwrap_or_default()) {
                    response_headers.push(("set-cookie".to_string(), format!("{k}={v}; Path=/")));
                }
            }
            return Ok(crate::trace::Exchange {
                method: req.method.clone(),
                url: landed,
                request_headers: vec![],
                request_body: None,
                status: 200,
                response_headers,
                response_body: Some(html),
                response_mime: "text/html".into(),
                resource_type: Some("Document".into()),
                main_frame: Some(true),
            });
        }
        if !warm {
            ab(&["close"])?;
            std::thread::sleep(CLOSE_WAIT);
            // Headless first: the window stays hidden unless the door needs a person.
            let mut landed = false;
            for attempt in 0..4 {
                ab(&opening(origin.as_str(), attempt, windows(), &[]))?;
                std::thread::sleep(PAGE_WAIT);
                if !at_a_door(&ab, &req.url)? {
                    landed = true;
                    break;
                }
            }
            if !landed {
                return Err(MintError::Browser("the site kept challenging the browser".into()));
            }
        }
        // The fetch itself, in the page's own context (cookies, clearance).
        let mut header_map = serde_json::Map::new();
        for (k, v) in &req.headers {
            header_map.insert(k.clone(), serde_json::Value::String(v.clone()));
        }
        let headers = serde_json::to_string(&header_map).unwrap_or_default();
        // The page's fetch is given text: a file's bytes don't go through a script, so an upload is never run here.
        if req.body.is_some() && req.text().is_none() {
            return Err(MintError::Browser("a file's bytes can't be sent from the page; the upload runs over plain HTTP only".into()));
        }
        let expr = format!(
            "(async()=>{{const r=await fetch({url},{{method:{method},headers:{headers},body:{body}}});const t=await r.text();const sc=(r.headers.getSetCookie?r.headers.getSetCookie():[]).map(c=>c.split(';')[0]);return JSON.stringify([r.status,r.headers.get('content-type')||'',sc,t.slice(0,2000000),r.url]);}})()",
            url = serde_json::to_string(req.url.as_str()).unwrap_or_default(),
            method = serde_json::to_string(&req.method).unwrap_or_default(),
            body = req.text().map(|b| serde_json::to_string(b).unwrap_or_default()).unwrap_or_else(|| "null".into()),
        );
        if std::env::var("UNBROWSE_MINT_DEBUG").is_ok() {
            eprintln!("   [mint] {} {} body: {}", req.method, req.url.path(), req.text().unwrap_or(""));
        }
        let out = ab(&["eval", &expr])?;
        // The daemon prints the value as JSON: a string here, holding the array
        // we returned. Unescape once, then parse it.
        let as_string = match serde_json::from_str::<String>(out.trim()) {
            Ok(s) => s,
            Err(_) => out.trim().trim_matches('"').to_string(),
        };
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&as_string).map_err(|e| MintError::Browser(format!("fetch result: {e}: {}", &as_string[..as_string.len().min(120)])))?;
        let (status, mime, body) = (
            parsed.first().and_then(|v| v.as_u64()).unwrap_or(0) as u16,
            parsed.get(1).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            parsed.get(3).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        );
        // The cookies the response set, as Set-Cookie headers, so derived values
        // (a csrf cookie a later header wraps) extract from a browser step too.
        let mut response_headers = Vec::new();
        if let Some(cookies) = parsed.get(2).and_then(|v| v.as_array()) {
            for c in cookies {
                if let Some(c) = c.as_str() {
                    response_headers.push(("set-cookie".to_string(), format!("{c}; Path=/")));
                }
            }
        }
        // The site's whole cookie jar joins the response headers: a cookie set
        // on the page's first load (not re-issued by this fetch) is still a
        // value later steps derive from, such as a csrf cookie a header wraps.
        if let Ok(cookies) = ab(&["--json", "cookies", "get"]) {
            for (k, v) in cookies_sent_to(&cookies, req.url.host_str().unwrap_or_default()) {
                if !response_headers.iter().any(|(n, val)| n == "set-cookie" && val.starts_with(&format!("{k}="))) {
                    response_headers.push(("set-cookie".to_string(), format!("{k}={v}; Path=/")));
                }
            }
        }
        Ok(crate::trace::Exchange {
            method: req.method.clone(),
            // Where the page's fetch landed: it follows redirects and its status is the last hop's, so the ledger
            // reads the move from this.
            url: parsed.get(4).and_then(|v| v.as_str()).and_then(|u| url::Url::parse(u).ok()).unwrap_or_else(|| req.url.clone()),
            request_headers: vec![],
            request_body: None,
            status,
            response_headers,
            response_body: if body.is_empty() { None } else { Some(body) },
            response_mime: mime,
            resource_type: None,
            main_frame: None,
        })
    }
}

/// Whether a request is a browser going to a page: a GET with no body whose own headers say it navigates, as the
/// walk recorded them for a document a person opened.
fn navigates(req: &crate::replay::Request) -> bool {
    let says = |name: &str, value: &str| req.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case(name) && v.eq_ignore_ascii_case(value));
    req.method.eq_ignore_ascii_case("GET") && req.body.is_none() && (says("sec-fetch-mode", "navigate") || says("sec-fetch-dest", "document"))
}

#[cfg(test)]
mod navigates_tests {
    /// A page a person opened is gone to; a call a script made is fetched from the page, as before.
    #[test]
    fn a_step_that_is_a_page_is_one_the_browser_goes_to() {
        let req = |method: &str, headers: &[(&str, &str)]| crate::replay::Request { method: method.into(), url: "https://shop.example/sch?q=lamp".parse().unwrap(), exchange: 0, headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body: None };
        assert!(super::navigates(&req("GET", &[("Sec-Fetch-Mode", "navigate"), ("sec-fetch-dest", "document")])));
        assert!(!super::navigates(&req("GET", &[("sec-fetch-mode", "cors"), ("sec-fetch-dest", "empty")])));
        assert!(!super::navigates(&req("POST", &[("sec-fetch-mode", "navigate")])));
    }
}

/// One fresh passive walk of a page: the exchange trace it produced, plus the
/// session values (cookies, tokens) it minted. What a route heals from when
/// the site has drifted: the current truth, root to target.
pub struct Sighting {
    pub trace: crate::trace::Trace,
    pub session: MintedSession,
}

impl BrowserMint {
    /// Walks `root` in the browser with passive capture on, and returns what
    /// the visit saw: the full exchange trace and the session it minted. The
    /// warm profile opens the front door; the capture is the site's current
    /// state, which a drifted route is recomputed from.
    pub fn sight(&mut self, root: &str) -> Result<Sighting, MintError> {
        let at = url::Url::parse(root).map_err(|e| MintError::Browser(format!("{root}: {e}")))?;
        let _visit = crate::hold::visit(&at).map_err(MintError::Browser)?;
        let _ = std::fs::remove_dir_all(&self.capture_dir);
        // The linked engine first, as `mint` does: one library call walks the root with capture on. The CLI below is
        // the fallback for a machine where the engine can't launch Chrome.
        if let Ok(url) = url::Url::parse(root) {
            if let Some(session) = self.mint_or_clear(&url)? {
                if let Some(trace) = crate::walk::trace_from_walk(&self.capture_dir, &self.session) {
                    return Ok(Sighting { trace, session });
                }
            }
        }
        let profile = self.profile.clone();
        let ab = |args: &[&str]| -> Result<String, MintError> {
            let mut cmd = cli(&self.browser, &self.session, profile.as_deref())?;
            cmd.args(args).env("UNBROWSE_CAPTURE_DIR", &self.capture_dir);
            let out = ran(cmd, most_for(args)).map_err(MintError::Browser)?;
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        };
        let asked = url::Url::parse(root).map_err(|e| MintError::Browser(format!("{root}: {e}")))?;
        ab(&["close"])?;
        let _closes = ClosesWithTheWalk(&ab);
        std::thread::sleep(CLOSE_WAIT);
        // Pass one opens the front door headless. If a challenge blocks,
        // pass two escalates to headed so a person can finish it.
        ab(&opening(root, 0, windows(), &[]))?;
        if wait_settled(&ab, &self.capture_dir, 12)? && !at_a_door(&ab, &asked)? {
            // The walk settled inside the poll budget: the sidecar was attached
            // from the start, so this pass already captured the page whole and
            // no second pass is needed. A door settles too, once it stops logging: it is not the walk.
            return Ok(Self::finish_sighting(self, &ab, url::Url::parse(root).ok().and_then(|u| u.host_str().map(String::from)).as_deref().unwrap_or_default()));
        }
        if at_a_door(&ab, &asked)? {
            // Escalate to headed: a person can pass the challenge.
            ab(&opening(root, 1, windows(), &[]))?;
            wait_settled(&ab, &self.capture_dir, 10)?;
        }
        // Pass two: with the door open (session cookies set) and the sidecar
        // attached, the walk is captured whole, document and APIs included.
        ab(&["open", root])?;
        wait_settled(&ab, &self.capture_dir, 12)?;
        ab(&["get", "url"])?;
        Ok(Self::finish_sighting(self, &ab, url::Url::parse(root).ok().and_then(|u| u.host_str().map(String::from)).as_deref().unwrap_or_default()))
    }

    /// Reads the capture back as a sighting: the trace plus the session values.
    fn finish_sighting(&self, _ab: &dyn Fn(&[&str]) -> Result<String, MintError>, host: &str) -> Sighting {
        let raw = std::fs::read_to_string(self.capture_dir.join(format!("{}.jsonl", self.session)))
            .unwrap_or_default();
        let trace = crate::session::Session::from_log(&raw)
            .map_err(|e| MintError::Browser(format!("parse sighting: {e:?}")))
            .map(|s| s.trace);
        let mut session = harvest_capture(&raw);
        // The browser is the judge of the session's cookies. One that won't say leaves none of what the capture saw set:
        // a heal then changes no cookie of the jar, rather than keep one the page may have taken out since.
        if let Err(e) = ask_cookies(_ab).and_then(|jar| take_browsers(&mut session, &jar, host)) {
            eprintln!("   [mint] {e}");
            session.cookies.clear();
            session.domains.clear();
            session.facts.clear();
            session.judged = false;
        }
        match trace {
            Ok(trace) => Sighting { trace, session },
            // An unparseable capture still yields the session; the caller's
            // rebuild reports the missing target.
            Err(_) => Sighting { trace: crate::trace::Trace { exchanges: Vec::new(), inputs: Vec::new() }, session },
        }
    }
}

/// The cookies in the browser's `--json cookies get` answer: name, value and the domain each was set for.
pub fn cookies_of(answer: &str) -> Vec<(String, String, String)> {
    let v: serde_json::Value = serde_json::from_str(answer.trim()).unwrap_or_default();
    let list = v.pointer("/data/cookies").or_else(|| v.get("cookies")).and_then(|l| l.as_array()).cloned().unwrap_or_default();
    list.iter()
        .filter_map(|c| Some((c["name"].as_str()?.to_string(), c["value"].as_str()?.to_string(), c["domain"].as_str().unwrap_or_default().to_string())))
        .filter(|(k, _, _)| !k.is_empty())
        .collect()
}

/// What the browser's `--json cookies get` answer says of each cookie the jar would keep for `host` ([`browser_lines`])
/// beyond its value: the path it goes to and whether it is HttpOnly. A cookie the answer says no HttpOnly of is left
/// out: it is then one whose script access isn't known, which a page's script is never shown.
pub fn facts_of(answer: &str, host: &str) -> std::collections::HashMap<String, agent_browser_core::session::CookieFacts> {
    browser_lines(answer, host).into_iter().filter_map(|(name, line, known)| known.then_some((name, agent_browser_core::session::CookieFacts { path: line.path, http_only: line.http_only, expires: line.expires }))).collect()
}

/// One cookie line: a value with the reach (`domain`, None for the host alone), path and HttpOnly of the line that
/// set it. They travel together: a value never goes where its own line didn't send it.
#[derive(Clone, Debug, PartialEq)]
pub struct CookieLine {
    pub value: String,
    pub domain: Option<String>,
    pub path: String,
    pub http_only: bool,
    /// When it runs out, in Unix seconds, as its own line said; None for a session cookie.
    pub expires: Option<f64>,
}


impl CookieLine {
    /// Puts the line in a session as its one entry for `name`: its value, its reach (none for the host alone), and,
    /// when its HttpOnly is `known`, its path and HttpOnly; when it isn't, no facts, which read as unknown and hidden.
    fn into_session(self, name: &str, session: &mut MintedSession, known: bool) {
        session.cookies.insert(name.to_string(), self.value);
        match self.domain {
            Some(d) => {
                session.domains.insert(name.to_string(), d.to_ascii_lowercase());
            }
            None => {
                session.domains.remove(name);
            }
        }
        if known {
            session.facts.insert(name.to_string(), agent_browser_core::session::CookieFacts { path: self.path, http_only: self.http_only, expires: self.expires });
        } else {
            session.facts.remove(name);
        }
    }
}

/// Whether a cookie set for (`a_domain`, `a_path`) reaches strictly fewer addresses than one set for (`b_domain`,
/// `b_path`) by the measure the jar keeps one cookie per name by: the host alone is narrower than any domain, a longer
/// domain narrower than a shorter one, and under one reach a longer path narrower than a shorter one.
pub fn narrower_than(a_domain: Option<&str>, a_path: &str, b_domain: Option<&str>, b_path: &str) -> bool {
    let reach = |d: Option<&str>| d.map_or(usize::MAX, |d| d.trim_start_matches('.').len());
    (reach(a_domain), a_path.len()) > (reach(b_domain), b_path.len())
}

/// Whether two lines set the same cookie: the same reach and the same path. Then the later one replaces the earlier.
pub fn same_scope(a_domain: Option<&str>, a_path: &str, b_domain: Option<&str>, b_path: &str) -> bool {
    let reach = |d: Option<&str>| d.map(|d| d.trim_start_matches('.').to_ascii_lowercase());
    reach(a_domain) == reach(b_domain) && a_path == b_path
}

/// The one line the jar keeps for a name when `new` arrives after `held`. The jar holds one cookie per name, where a
/// browser can hold several of one name with different reaches or paths and sends each only where its own line said:
/// so the value it keeps carries its own line's reach and path, and is never sent anywhere that line didn't cover.
///
/// - The same reach and path: the same cookie set again, and the new line replaces it.
/// - Otherwise, the narrower of the two ([`narrower_than`]) is kept, its value with its own reach and path; on a tie
///   (two disjoint paths of one length) the one already held stays.
/// - HttpOnly is never loosened by the choice: if either line said HttpOnly, the kept one is HttpOnly.
///
/// The cost: an address only the other cookie's line covers gets no cookie of that name from the node, where a
/// browser would send it the other one.
pub fn keep_line(held: Option<CookieLine>, new: CookieLine) -> CookieLine {
    let Some(held) = held else { return new };
    if same_scope(new.domain.as_deref(), &new.path, held.domain.as_deref(), &held.path) {
        return new;
    }
    let http_only = new.http_only || held.http_only;
    let mut kept = if narrower_than(new.domain.as_deref(), &new.path, held.domain.as_deref(), &held.path) { new } else { held };
    kept.http_only = http_only;
    kept
}

/// The cookies the browser's `--json cookies get` answer holds that it would send to `host`, one per name the jar's
/// way ([`keep_line`]): each with its own line's value, reach, path and HttpOnly, and whether the browser said its
/// HttpOnly. DevTools reports a cookie set for a whole domain with the leading dot, and one for its host alone bare.
pub fn browser_lines(answer: &str, host: &str) -> Vec<(String, CookieLine, bool)> {
    let list = browser_cookie_list(answer).unwrap_or_default();
    let mut kept: Vec<(String, CookieLine, bool)> = Vec::new();
    for c in &list {
        let (Some(name), Some(value)) = (c["name"].as_str().filter(|n| !n.is_empty()), c["value"].as_str()) else { continue };
        let domain = c["domain"].as_str().unwrap_or_default();
        if !sent_to(domain, host) {
            continue;
        }
        let known = c["httpOnly"].as_bool().is_some();
        let line = CookieLine {
            value: value.to_string(),
            domain: domain.starts_with('.').then(|| domain.to_ascii_lowercase()),
            path: c["path"].as_str().filter(|p| p.starts_with('/')).unwrap_or("/").to_string(),
            http_only: c["httpOnly"].as_bool().unwrap_or(true),
            // DevTools says -1 for a cookie that lives as long as its session.
            expires: c["expires"].as_f64().filter(|e| *e > 0.0),
        };
        match kept.iter().position(|(n, _, _)| n == name) {
            Some(i) => {
                let (_, held, held_known) = kept.remove(i);
                let both = held_known && known;
                kept.insert(i, (name.to_string(), keep_line(Some(held), line), both));
            }
            None => kept.push((name.to_string(), line, known)),
        }
    }
    kept
}

/// Puts the browser's cookies for `host` into `session`, one per name, each with its own line's reach and facts
/// ([`browser_lines`]): the live jar is what the browser would send, so its word replaces what the capture said of a
/// name, value and reach and facts together, and a name the capture holds that the browser doesn't leaves.
pub fn take_browsers(session: &mut MintedSession, answer: &str, host: &str) -> Result<(), MintError> {
    if !browser_answered(answer) {
        return Err(MintError::Browser("the browser's answer about its cookies is not one: no session is kept on the capture's word alone".into()));
    }
    let held = browser_lines(answer, host);
    // The browser is the judge of what it holds: a cookie the walk saw set that it no longer holds for this host (the
    // site took it out, its life ran out, another line replaced it) is not kept, however the capture read it.
    let gone: Vec<String> = session.cookies.keys().filter(|k| !held.iter().any(|(n, _, _)| n == *k)).cloned().collect();
    for name in gone {
        session.cookies.remove(&name);
        session.domains.remove(&name);
        session.facts.remove(&name);
    }
    for (name, line, known) in held {
        line.into_session(&name, session, known);
    }
    session.judged = true;
    Ok(())
}

/// Whether a `--json cookies get` answer is one: the browser answered with its list, empty or not. An empty answer is
/// no browser asked, which says nothing of what it holds.
pub fn browser_answered(answer: &str) -> bool {
    browser_cookie_list(answer).is_some()
}

/// The cookies a browser's answer lists, when the answer is one: JSON whose `cookies` (or `data.cookies`) is a list
/// of cookies, each with a name, a value and a domain as text. An empty list is an answer; anything else (an error
/// said in text, a list of something else, a cookie without its name or value) is not, and says nothing of what the
/// browser holds. The one reader of the browser's answer: every path that is judged by it asks here.
pub fn browser_cookie_list(answer: &str) -> Option<Vec<serde_json::Value>> {
    let v: serde_json::Value = serde_json::from_str(answer.trim()).ok()?;
    let list = v.pointer("/data/cookies").or_else(|| v.get("cookies"))?.as_array()?.clone();
    let whole = |c: &serde_json::Value| ["name", "value", "domain"].iter().all(|k| c.get(*k).is_some_and(serde_json::Value::is_string));
    list.iter().all(whole).then_some(list)
}

/// The browser's answer to which cookies it holds, asked up to [`COOKIE_ASKS`] times until it gives one
/// ([`browser_cookie_list`]): a command that failed, timed out or answered in another shape is asked again. None of
/// those is a judgment, so when no answer comes the walk fails plainly rather than keep cookies on the capture's word.
pub fn ask_cookies(ab: &dyn Fn(&[&str]) -> Result<String, MintError>) -> Result<String, MintError> {
    let mut last = String::new();
    for _ in 0..COOKIE_ASKS {
        match ab(&["--json", "cookies", "get"]) {
            Ok(answer) if browser_answered(&answer) => return Ok(answer),
            Ok(answer) => last = format!("an answer in another shape ({} bytes)", answer.len()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(MintError::Browser(format!("the browser didn't say which cookies it holds, asked {COOKIE_ASKS} times ({last}): no session is kept on the capture's word alone")))
}

/// How many times a walk asks its browser which cookies it holds before it gives up.
pub const COOKIE_ASKS: usize = 3;

/// The browser's cookies for `host`, one per name ([`browser_lines`]), as (name, value, domain as DevTools reports it):
/// what the jar is made from.
pub fn held_for(answer: &str, host: &str) -> Vec<(String, String, String)> {
    browser_lines(answer, host).into_iter().map(|(name, line, _)| (name, line.value, line.domain.unwrap_or_else(|| host.to_ascii_lowercase()))).collect()
}

/// Whether the browser sends a cookie it holds under `domain` (as DevTools reports it) to `host`. A cookie set with a
/// Domain attribute is reported with a leading dot and goes to that domain and every name under it; one set without
/// (host-only) is reported bare and goes to exactly the host that set it, never to a name under it.
pub fn sent_to(domain: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let lower = domain.to_ascii_lowercase();
    match lower.strip_prefix('.') {
        Some(d) => !d.is_empty() && (host == d || host.ends_with(&format!(".{d}"))),
        None => !lower.is_empty() && host == lower,
    }
}

/// The cookies in the browser's `--json cookies get` answer that it would send to `host`, one per name the jar's way
/// ([`browser_lines`]). The browser holds every frame's and every other site's cookies too; sent along, they swell a
/// request past what the site accepts.
pub fn cookies_sent_to(answer: &str, host: &str) -> Vec<(String, String)> {
    browser_lines(answer, host).into_iter().map(|(name, line, _)| (name, line.value)).collect()
}

/// The reach of the cookies a browser holds for `host`, by name: the `Domain` of the one line per name the jar keeps
/// ([`browser_lines`]), when that line was set for a whole domain (DevTools reports it with the leading dot). A name
/// whose kept line was set for the host alone has none: its host is the whole of its reach.
pub fn scopes_of(answer: &str, host: &str) -> std::collections::HashMap<String, String> {
    browser_lines(answer, host).into_iter().filter_map(|(name, line, _)| line.domain.map(|d| (name, d))).collect()
}

/// A host's jar with the browser's cookies in it. The browser is the truth for cookies: those it would send to the
/// host are the jar's cookies, and any other name leaves (another site's, a frame's, one it has since dropped), so a
/// jar filled before cookies were scoped sheds what never belonged to it. What the host's routes mint that isn't a
/// cookie (`tokens`: header and body tokens) stays. A browser holding nothing changes nothing.
pub fn jar_with(
    jar: std::collections::BTreeMap<String, String>,
    held: &[(String, String, String)],
    host: &str,
    tokens: &std::collections::HashSet<String>,
) -> std::collections::BTreeMap<String, String> {
    if held.is_empty() {
        return jar;
    }
    let sent = |d: &str| sent_to(d, host);
    let mut out: std::collections::BTreeMap<String, String> = jar.into_iter().filter(|(k, _)| tokens.contains(k)).collect();
    out.extend(held.iter().filter(|(_, _, d)| sent(d)).map(|(k, v, _)| (k.clone(), v.clone())));
    out
}

/// Clicks through an interactive Cloudflare challenge if one is showing: a
/// Turnstile checkbox ("Verify you are human") in the page or an iframe. A
/// human would click it, so the node does too; then clearance is awaited by
/// watching the page state settle. Ok(true): a box was clicked.
fn pass_challenge(ab: &dyn Fn(&[&str]) -> Result<String, MintError>) -> Result<bool, MintError> {
    let snap = ab(&["snapshot"])?;
    // The checkbox appears as `checkbox "Verify you are human" [ref=eN]`.
    let clicked = snap
        .lines()
        .filter_map(|l| {
            let r = l.find("[ref=")?;
            let rest = &l[r + 5..];
            let end = rest.find(']')?;
            Some((l.contains("Verify you are human") || l.contains("Verify you\u{2019}re a human"), &rest[..end]))
        })
        .find(|(is_box, _)| *is_box)
        .map(|(_, r)| r.to_string());
    let Some(r#ref) = clicked else { return Ok(false) };
    let target = format!("@{ref}");
    let _ = ab(&["click", &target]);
    // Clearance takes a moment; the click is logged, the wait lets the
    // challenge resolve before the caller re-checks the landing.
    std::thread::sleep(std::time::Duration::from_secs(6));
    Ok(true)
}

/// The DevTools address of the browser holding this mint's profile, when one is running and proven to be it
/// ([`live_endpoint_of`]).
pub(crate) fn live_endpoint(opts: &agent_browser_core::session::MintOptions) -> Option<String> {
    live_endpoint_of(opts.profile.as_deref()?)
}

impl BrowserMint {
    /// The engine's own mint: one library call, no process boundary.
    /// The in-process walk, its cookies judged by the browser's own answer (`MintedSession::browser_answer`), read as every
    /// path reads it ([`take_browsers`]): one per name, each with its own reach and facts. A walk whose browser handed
    /// over no answer that reads as one keeps no session: it fails plainly.
    fn mint_in_process(&self, url: &url::Url) -> Result<Option<MintedSession>, MintError> {
        let host = url.host_str().unwrap_or_default();
        let Some(mut session) = self.mint_in_process_raw(url)? else { return Ok(None) };
        let answer = session.browser_answer.take().map(|a| a.to_string()).unwrap_or_default();
        // What the core read from the same answer is put aside: the reader here decides.
        session.cookies.clear();
        session.domains.clear();
        session.facts.clear();
        take_browsers(&mut session, &answer, host)?;
        Ok(Some(session))
    }

    fn mint_in_process_raw(&self, url: &url::Url) -> Result<Option<MintedSession>, MintError> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| MintError::Browser(format!("mint runtime: {e}")))?;
        let opts = agent_browser_core::session::MintOptions {
            url: url.to_string(),
            session: self.session.clone(),
            capture_dir: Some(self.capture_dir.clone()),
            profile: self.profile.clone(),
            adopt: None,
            headed: false,
            // A try of the page's controls has nobody waiting for it: what a site won't show an empty profile stays unshown.
            windowless: !windows() || self.try_controls,
            args: {
                // The browser presents the identity the caller chose: by
                // default the node's own, so a clearance is bound to a name
                // the stack owns; `None` leaves Chrome's, for sites that
                // refuse an unknown agent.
                let mut args = vec!["--disable-blink-features=AutomationControlled".to_string()];
                if let Some(ua) = &self.user_agent {
                    args.push(format!("--user-agent={ua}"));
                }
                // Every connection the browser makes goes through the node's egress rule, so a page can't reach this
                // machine, the owner's network or a metadata address (`learn::proxy`). The tunnel carries the
                // browser's own TLS untouched, so the door still reads the handshake the identity above claims. No
                // proxy, no launch: the walk is refused rather than run outside the rule.
                args.extend(crate::proxy::switches().map_err(MintError::Browser)?);
                args
            },
            settle_ms: 6_000,
            cdp_endpoint: self.cdp_endpoint.clone(),
            frames: self.frames.clone(),
            // Learning wants the site's data calls, and many pages make them only when the reader asks for more.
            browse: true,
            try_controls: self.try_controls,
            // The walk presents the browser's own connection. A site reads the
            // handshake it was given, and one answered from Rust is not the
            // browser the identity above claims to be. The proxy is for the
            // caller who asked for address pinning, not for every walk.
            intercept: false,
            executable_path: chromium(),
            cookies: self.seed.clone(),
            stop: STOP.with(|s| s.borrow().clone()),
        };
        // A retry needs the settings once they have been handed to the engine.
        let retry = opts.clone();
        let session = match rt.block_on(agent_browser_core::session::mint(opts)) {
            Ok(s) => s,
            Err(e) => {
                // A refusal is not a launch failure: keep the browser and
                // capture intact instead of launching a second browser through
                // the CLI and discarding the evidence. The engine has said what
                // happened, and the CLI would only ask the same question again.
                if e.starts_with("mint unresolved (") {
                    return Err(MintError::Browser(e));
                }
                // Stopped because its ask gave up: nobody waits for another walk either, so none is started.
                if e == agent_browser_core::session::STOPPED {
                    return Err(MintError::Browser(e));
                }
                // The site's profile is open in a browser already — this node's own signing browser, left open for the
                // next call, or someone browsing. No second browser can open it, and the CLI path can't either: say so
                // rather than walk nothing and answer an empty list of calls (trip.com's walk came back with none).
                if e.contains("already open in a running browser") {
                    // The profile is open in a browser the node already has — the one page signing visits, or an owner's.
                    // Its DevTools address is the way back in: ask the browser that holds the profile instead of opening a
                    // second one (a walk of a page-signed site could otherwise never mint again).
                    if let Some(endpoint) = live_endpoint(&retry) {
                        let mut again = retry.clone();
                        again.cdp_endpoint = Some(endpoint.clone());
                        match rt.block_on(agent_browser_core::session::mint(again)) {
                            Ok(s) => return Ok(Some(s)),
                            Err(e) => eprintln!("[mint] the browser at {endpoint} answered nothing: {e}"),
                        }
                    }
                    return Err(MintError::Browser(format!("the site's browser is open, so this walk can't open it: {e}")));
                }
                eprintln!("[mint] in-process engine: {e}");
                return Ok(None);
            }
        };
        // A walk that produced no cookies is still a walk: plenty of sites set
        // none, and the page loading is the proof. Only a failed launch falls
        // through to the CLI path.
        Ok(Some(session))
    }
}

/// Whether an error is the site's answer rather than a launch failure: the engine says what the page was.
fn unresolved(e: &MintError) -> bool {
    matches!(e, MintError::Browser(s) if s.starts_with("mint unresolved ("))
}

/// The challenge page the last walk met: its own main document, with the HTML it answered. A challenge can be served
/// at the site's own address (status 200 or a refusal), so the page's origin is the site's, not its status.
fn challenge_page<'a>(trace: &'a crate::trace::Trace, url: &url::Url) -> Option<&'a crate::trace::Exchange> {
    let here = url.host_str()?;
    let own = |e: &&crate::trace::Exchange| {
        e.is_main_document()
            && e.url.host_str().is_some_and(|h| crate::identity::same_site(h, here))
            && e.response_body.as_deref().is_some_and(|b| !b.trim().is_empty())
    };
    trace.exchanges.iter().rev().find(own).or_else(|| {
        trace.exchanges.iter().rev().find(|e| e.is_main_document() && e.response_body.as_deref().is_some_and(crate::page::is_html))
    })
}

/// The page's own code, as the walk captured it: inline scripts are in its HTML, and these are the external ones. A
/// challenge page's proof lives in both. Bounded, so a page whose ads are huge cannot hold the door.
fn door_scripts(trace: &crate::trace::Trace) -> Vec<(String, String)> {
    const CAP: usize = 8 * 1024 * 1024;
    let mut out = Vec::new();
    let mut bytes = 0usize;
    for e in &trace.exchanges {
        let Some(body) = e.response_body.as_deref().filter(|b| !b.trim().is_empty()) else { continue };
        let js = e.resource_type.as_deref() == Some("Script") || e.response_mime.contains("javascript") || e.response_mime.contains("ecmascript");
        if !js {
            continue;
        }
        bytes = bytes.saturating_add(body.len());
        if bytes > CAP {
            break;
        }
        out.push((e.url.to_string(), body.to_string()));
    }
    out
}

/// The browser the walk showed the page, rebuilt from what it sent: the user agent and language a challenge proof
/// hashes, and the client hints Chrome always states. The canvas and WebGL samples are the browser's own, which a
/// failed walk never read back; a page that hashes them cannot be passed here, and the site's answer says so.
fn door_fingerprint(page: &crate::trace::Exchange) -> serde_json::Value {
    let header = |name: &str| page.request_headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    let ua = header("user-agent").unwrap_or_default();
    let language = header("accept-language").unwrap_or_else(|| "en-US".into());
    let langs: Vec<String> = language.split(',').map(|p| p.split(';').next().unwrap_or("").trim().to_string()).filter(|s| !s.is_empty()).collect();
    let lang = langs.first().cloned().unwrap_or_else(|| "en-US".into());
    let platform = if ua.contains("Macintosh") { "MacIntel" } else if ua.contains("Windows") { "Win32" } else { "Linux x86_64" };
    let brands: Vec<serde_json::Value> = header("sec-ch-ua").map(|list| {
        list.split(',').filter_map(|b| {
            let (brand, rest) = b.trim().split_once(";v=")?;
            Some(serde_json::json!({ "brand": brand.trim().trim_matches('"'), "version": rest.trim().trim_matches('"') }))
        }).collect()
    }).unwrap_or_default();
    let hint_platform = header("sec-ch-ua-platform").map(|p| p.trim_matches('"').to_string()).unwrap_or_else(|| platform.to_string());
    let mobile = header("sec-ch-ua-mobile").map(|m| m.contains("?1")).unwrap_or(false);
    let mut fp = serde_json::json!({ "ua": ua, "lang": lang, "langs": langs, "platform": platform, "vendor": "Google Inc.", "cores": 8, "touch": 0 });
    if !brands.is_empty() {
        fp["uaData"] = serde_json::json!({ "brands": brands, "mobile": mobile, "platform": hint_platform });
    }
    fp
}

/// A cookie a response set: its name and value, and the domain when the site gave one (`Domain=`). A cleared cookie
/// (`Max-Age=0`) is not a clearance.
pub(crate) fn set_cookie(line: &str) -> Option<(String, String, Option<String>)> {
    let (pair, rest) = line.split_once(';').unwrap_or((line, ""));
    let (name, value) = pair.split_once('=')?;
    let name = name.trim();
    let value = value.trim();
    // A line that ends its cookie (its life already over, by Max-Age or else Expires) earns nothing.
    if name.is_empty() || crate::http::ends_the_cookie(line) {
        return None;
    }
    let domain = rest.split(';').find_map(|p| {
        let p = p.trim();
        p.strip_prefix("Domain=").or_else(|| p.strip_prefix("domain=")).map(|d| d.trim().to_ascii_lowercase())
    });
    Some((name.to_string(), value.to_string(), domain.filter(|d| !d.is_empty())))
}

/// Whether the page asks a person for an act a script cannot make (a slider, a captcha, an attestation). Such a door
/// needs the browser, the agent or the owner; running its scripts in a sandbox earns nothing and must not pretend to. A
/// person's act is shown in a frame of another site, and the walk's own traffic or the page's own markup says so: no
/// vendor is named, because the frame is the page's evidence.
pub(crate) fn asks_a_person(html: &str, trace: &crate::trace::Trace, at: &url::Url) -> bool {
    let elsewhere = |u: &url::Url| u.host_str().is_some_and(|h| at.host_str().is_some_and(|here| !crate::identity::same_site(h, here)));
    if trace.exchanges.iter().any(|e| e.main_frame == Some(false) && elsewhere(&e.url)) {
        return true;
    }
    let doc = scraper::Html::parse_document(html);
    let sel = scraper::Selector::parse("iframe[src], frame[src]").expect("static selector");
    doc.select(&sel)
        .filter_map(|f| f.value().attr("src"))
        .filter_map(|src| at.join(src).ok())
        .any(|u| elsewhere(&u))
}

/// The cookies a challenge page earns when its own scripts run, or none when it asks a person. The page is booted in
/// the sandbox with the session the walk had; its calls go through the node's Chrome-shaped transport, and every
/// `Set-Cookie` and `document.cookie` write it makes is a clearance the site issued to this client. Nothing here
/// names a site: the page's own code is the producer, and the site's next answer is the verifier.
impl BrowserMint {
    fn door_clearance(&self, url: &url::Url) -> Option<MintedSession> {
        if !crate::sandbox::available() {
            return None;
        }
        let Some(trace) = crate::walk::trace_from_walk(&self.capture_dir, &self.session) else {
            if std::env::var_os("UNBROWSE_REPLAY_DEBUG").is_some() {
                eprintln!("   [door] no capture at {}/{}.jsonl", self.capture_dir.display(), self.session);
            }
            return None;
        };
        if std::env::var_os("UNBROWSE_REPLAY_DEBUG").is_some() {
            eprintln!("   [door] the walk's trace holds {} exchange(s)", trace.exchanges.len());
        }
        self.door_clearance_from(url, &trace)
    }

    /// The door pass over a walk's own trace: the capture made portable for a test, and the same one the browser met.
    fn door_clearance_from(&self, url: &url::Url, trace: &crate::trace::Trace) -> Option<MintedSession> {
        let Some(page) = challenge_page(trace, url) else {
            if std::env::var_os("UNBROWSE_REPLAY_DEBUG").is_some() {
                eprintln!("   [door] no main document for {url} in the walk");
            }
            return None;
        };
        let html = page.response_body.clone()?;
        if asks_a_person(&html, trace, &page.url) {
            eprintln!("   [door] {} asks a person; the browser, the agent or the owner meets it", page.url);
            return None;
        }
        let at = if page.url.origin() == url.origin() { page.url.as_str().to_string() } else { url.to_string() };
        let bundle = door_scripts(trace);
        if bundle.is_empty() && !html.contains("<script") {
            return None;
        }
        let fingerprint = door_fingerprint(page);
        let site = url.host_str().unwrap_or_default().to_string();
        let seed = self.seed.clone();
        let ua = page.request_headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("user-agent")).map(|(_, v)| v.clone()).unwrap_or_default();
        // The challenge page's own calls go where a page of the site may send them and nowhere else: over a transport
        // held to the rule for code that isn't the node's (HTTPS, a public address checked where it connects, every
        // redirect hop), and the sandbox keeps them on the page's own site. The page never reaches the owner's machine
        // or network through the node.
        let mut fetch = crate::http::ChromeFetch::held_to(crate::egress::Egress::Foreign).ok()?.with_identity(&ua).with_client_hints(crate::http::ClientHints::of(&fingerprint));
        self.door_clearance_with(&page.url, &html, &bundle, &at, &fingerprint, &site, &seed, |req, until| {
            use crate::replay::Fetch;
            fetch.until(Some(until));
            fetch.fetch_unredirected(req).map_err(|e| e.to_string())
        })
    }

    /// The door pass itself, with the site's traffic handed in: a test can answer it, and the caller can carry the
    /// jar's session on every request. The cookies the page earns are the answer; the site's next response decides
    /// whether they pass.
    #[allow(clippy::too_many_arguments)]
    fn door_clearance_with(
        &self,
        page_url: &url::Url,
        html: &str,
        bundle: &crate::sandbox::Bundle,
        at: &str,
        fingerprint: &serde_json::Value,
        site: &str,
        seed: &[agent_browser_core::session::SeedCookie],
        fetch: impl FnMut(&crate::replay::Request, std::time::Instant) -> Result<crate::trace::Exchange, String>,
    ) -> Option<MintedSession> {
        let (earned, facts) = earned_at_the_door(page_url, html, bundle, at, fingerprint, site, seed, fetch)?;
        let mut session = MintedSession::default();
        for (name, value, domain) in earned {
            if let Some(old) = self.seed.iter().find(|c| c.name == name) {
                if old.value == value {
                    continue;
                }
            }
            session.cookies.insert(name.clone(), value);
            if let Some(f) = facts.get(&name) {
                session.facts.insert(name.clone(), f.clone());
            }
            if let Some(domain) = domain {
                session.domains.insert(name, domain);
            }
        }
        if session.cookies.is_empty() {
            return None;
        }
        eprintln!("   [door] {page_url} earned {} cookie(s) from its own page: {:?}", session.cookies.len(), session.cookies.keys().collect::<Vec<_>>());
        Some(session)
    }
}

/// What a door's own page earns when its scripts run: the cookies its calls' answers set and the ones it writes
/// itself, as (name, value, domain), with what each line said of its path and HttpOnly. This is the browser's renewal,
/// computed: the page is the producer, it runs in the sandbox with the session it is given (`seed`), its calls go out
/// through `fetch`, and the site's next answer is what says whether they pass. One function, for the walk that first
/// meets a door and the call that meets it again.
///
/// The seed goes as a browser sends it: a request carries the seed's cookies whose host or domain and path cover it, and
/// the page's own `document.cookie` holds only those known not to be HttpOnly. A cookie is earned only from the door's
/// own site: another host's answer sets nothing here. None when the page issued nothing: the door is not one a script
/// alone opens.
#[allow(clippy::too_many_arguments)]
pub(crate) fn earned_at_the_door(
    page_url: &url::Url,
    html: &str,
    bundle: &crate::sandbox::Bundle,
    at: &str,
    fingerprint: &serde_json::Value,
    site: &str,
    seed: &[agent_browser_core::session::SeedCookie],
    mut fetch: impl FnMut(&crate::replay::Request, std::time::Instant) -> Result<crate::trace::Exchange, String>,
) -> Option<(Vec<(String, String, Option<String>)>, std::collections::HashMap<String, agent_browser_core::session::CookieFacts>)> {
    if !crate::sandbox::door_pass_enabled() {
        eprintln!("   [door] {page_url}: its page's scripts are not run (UNBROWSE_DOOR_PASS=1 turns the door pass on)");
        return None;
    }
    // The seed's cookies that go with a request to `url`, as a browser sends them: its host, or a host its domain
    // reaches, on a path it covers.
    let goes = |c: &agent_browser_core::session::SeedCookie, url: &url::Url| {
        let host = url.host_str().unwrap_or_default();
        let reaches = match &c.domain {
            Some(d) => sent_to(d, host),
            None => host.eq_ignore_ascii_case(site),
        };
        // Never in the clear: the seed keeps no Secure flag, so every cookie of it is held to one.
        reaches && crate::http::path_matches(c.path(), url.path()) && crate::client::secure_context(url)
    };
    let cookie_header = |url: &url::Url| -> String { seed.iter().filter(|c| goes(c, url)).map(|c| format!("{}={}", c.name, c.value)).collect::<Vec<_>>().join("; ") };
    let mut earned: Vec<(String, String, Option<String>)> = Vec::new();
    let mut facts: std::collections::HashMap<String, agent_browser_core::session::CookieFacts> = std::collections::HashMap::new();
    let mut net = |req: &crate::replay::Request, until: std::time::Instant| -> Result<crate::trace::Exchange, String> {
        let mut req = req.clone();
        if !req.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("cookie")) {
            let cookies = cookie_header(&req.url);
            if !cookies.is_empty() {
                req.headers.push(("cookie".to_string(), cookies));
            }
        }
        let ex = fetch(&req, until)?;
        // A cookie is earned only from the site whose door this is: another host's answer sets nothing here.
        let own = ex.url.host_str().is_some_and(|h| crate::identity::same_site(h, site));
        for (name, value) in ex.response_headers.iter().filter(|_| own) {
            if name.eq_ignore_ascii_case("set-cookie") {
                if let Some(c) = set_cookie(value) {
                    if !earned.iter().any(|(k, _, _)| k == &c.0) {
                        facts.insert(c.0.clone(), agent_browser_core::session::CookieFacts { path: crate::http::cookie_path(value, &ex.url), http_only: crate::http::cookie_http_only(value), expires: crate::http::cookie_expiry(value) });
                        earned.push(c);
                    }
                }
            }
        }
        Ok(ex)
    };
    // The page's own `document.cookie` is what a browser shows its script there: the seed's cookies that go to the
    // page, and of those only the ones known not to be HttpOnly.
    let seed_header = url::Url::parse(at)
        .map(|at| seed.iter().filter(|c| c.shown_to_script() && goes(c, &at)).map(|c| format!("{}={}", c.name, c.value)).collect::<Vec<_>>().join("; "))
        .unwrap_or_default();
    let run = crate::sandbox::door_pass(bundle, at, &seed_header, &crate::sandbox::Storage::default(), html, fingerprint, Some(&mut net))?;
    // What the page wrote with `document.cookie` joins what its calls' answers set. Every one is the site's, and
    // none is trusted until the site's next answer accepts it.
    for (name, value) in run.cookies {
        if !earned.iter().any(|(k, _, _)| k == &name) {
            // The page's own script wrote it, so its script may read it.
            facts.insert(name.clone(), agent_browser_core::session::CookieFacts { path: "/".into(), http_only: false, expires: None });
            earned.push((name, value, None));
        }
    }
    if earned.is_empty() {
        eprintln!("   [door] {page_url} ran its page but the site issued no cookie: the door is not script-only");
        return None;
    }
    Some((earned, facts))
}

impl BrowserMint {

    /// The in-process mint, and the page's own door pass when the site challenges: a clearance the page earned is put
    /// into the browser and the jar, and the walk is asked again. The site's answer decides; a challenge it still
    /// refuses is the answer.
    fn mint_or_clear(&mut self, url: &url::Url) -> Result<Option<MintedSession>, MintError> {
        match self.mint_in_process(url) {
            Ok(landed) => Ok(landed),
            Err(first) if unresolved(&first) => {
                let Some(clearance) = self.door_clearance(url) else { return Err(first) };
                let kept = self.seed.clone();
                for (name, value) in &clearance.cookies {
                    let facts = clearance.facts.get(name);
                    self.seed.push(agent_browser_core::session::SeedCookie {
                        name: name.clone(),
                        value: value.clone(),
                        domain: clearance.domains.get(name).cloned(),
                        path: facts.map(|f| f.path.clone()),
                        http_only: facts.map(|f| f.http_only),
                    });
                }
                let retried = self.mint_in_process(url);
                self.seed = kept;
                match retried {
                    Ok(Some(mut session)) => {
                        session.absorb(clearance);
                        Ok(Some(session))
                    }
                    // The clearance was not what the site wanted; keep the walk's own report of the door.
                    _ => Err(first),
                }
            }
            Err(e) => Err(e),
        }
    }
}

impl Mint for BrowserMint {
    fn mint(&mut self, url: &url::Url) -> Result<MintedSession, MintError> {
        let _visit = crate::hold::visit(url).map_err(MintError::Browser)?;
        // In-process first: the engine is linked (agent-browser-core), so the
        // mint is a library call — launch, walk, harvest — with no daemon, no
        // socket, and no launch-frozen environment. The CLI path below stays as
        // the fallback for a machine where the engine cannot launch Chrome.
        if let Some(session) = self.mint_or_clear(url)? {
            return Ok(session);
        }
        self.mint_by_program(url)
    }
}

impl BrowserMint {
    /// The mint through the browser program, for a machine where the engine can't launch Chrome.
    fn mint_by_program(&mut self, url: &url::Url) -> Result<MintedSession, MintError> {
        if asked_to_stop() {
            return Err(MintError::Browser(agent_browser_core::session::STOPPED.to_string()));
        }
        let _ = std::fs::remove_dir_all(&self.capture_dir);
        let profile = self.profile.clone();
        let ab = |args: &[&str]| -> Result<String, MintError> {
            // A persistent profile accumulates the site's cookies, history and
            // reputation, so a later mint's front door opens easier.
            let mut cmd = cli(&self.browser, &self.session, profile.as_deref())?;
            cmd.args(args).env("UNBROWSE_CAPTURE_DIR", &self.capture_dir);
            let out = ran(cmd, most_for(args)).map_err(MintError::Browser)?;
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        };
        ab(&["close"])?;
        let _closes = ClosesWithTheWalk(&ab);
        std::thread::sleep(CLOSE_WAIT);
        let mut landed = false;
        for attempt in 0..4 {
            // Headless first; escalate to headed on the second attempt so a
            // person can finish a challenge the headless pass couldn't clear.
            ab(&opening(url.as_str(), attempt, windows(), &[]))?;
            std::thread::sleep(PAGE_WAIT);
            // A human, seeing the box, clicks it: an interactive challenge is
            // passed by clicking "Verify you are human" and waiting out the
            // clearance, which is behavior, not spoofing.
            let _ = pass_challenge(&ab);
            if !ab(&["get", "title"])?.trim().is_empty() && !at_a_door(&ab, url)? {
                landed = true;
                break;
            }
        }
        if !landed {
            return Err(MintError::Browser("the site kept challenging the browser".into()));
        }
        // Let finished requests settle and flush to the capture log.
        std::thread::sleep(CLOSE_WAIT);
        ab(&["get", "url"])?;
        let raw = std::fs::read_to_string(self.capture_dir.join(format!("{}.jsonl", self.session)))
            .unwrap_or_default();
        let mut session = harvest_capture(&raw);
        // The live jar is the session the browser would send: a cookie it
        // already held (SESSION, clearance) is not re-set by every response,
        // so the capture alone would hand plain HTTP a stale value.
        let host = url.host_str().unwrap_or_default();
        let jar = ask_cookies(&ab)?;
        take_browsers(&mut session, &jar, host)?;
        // What the page kept for its own code, as the walk left it: a signing bridge boots the page's scripts again
        // with it in front of them.
        let said = ab(&["eval", STORAGE_JS]).unwrap_or_default();
        session.local_storage = storage_map(&said, "local");
        session.session_storage = storage_map(&said, "session");
        Ok(session)
    }
}

#[cfg(test)]
mod tests {

    /// A browser's address carries its debugger's secret: it goes to the command in its environment, which only this
    /// user can read, never in its arguments, which every user on the machine can.
    #[test]
    fn a_browsers_secret_address_never_goes_on_a_command_line() {
        let secret = "ws://127.0.0.1:4100/devtools/browser/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let cmd = cli_at("agent-browser", "s1", Some("/p"), Some(secret)).unwrap();
        assert!(!cmd.get_args().any(|a| a.to_string_lossy().contains("devtools/browser")), "{cmd:?}");
        assert!(cmd.get_envs().any(|(k, v)| k == "AGENT_BROWSER_CDP" && v.is_some_and(|v| v == secret)));
    }
    use super::*;

    /// An ask's stop flag reaches what its thread does, and is gone once the ask's work ends: the next ask a pooled
    /// thread works for never inherits it.
    /// A session of the browser program the node gave a command in is closed with the node, by the program's own
    /// `close`, where its daemon is still there (its pid file): one whose daemon already went is not asked, and every
    /// record goes, in this process and on disk.
    #[test]
    #[cfg(unix)]
    fn the_programs_sessions_close_with_the_node_where_their_daemon_is_still_there() {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!("unbrowse-program-sessions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let sockets = home.join("browser");
        std::fs::create_dir_all(&sockets).unwrap();
        let said = home.join("said.txt");
        let program = home.join("program.sh");
        std::fs::write(&program, format!("#!/bin/sh\necho \"$*\" >> {}\n", said.display())).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(sockets.join("live.pid"), "4242").unwrap();
        let p = program.to_string_lossy().into_owned();
        for session in ["live", "gone"] {
            let s = ProgramSession { program: p.clone(), session: session.into(), sockets: Some(sockets.clone()) };
            std::fs::create_dir_all(program_sessions_dir(&home)).unwrap();
            std::fs::write(program_session_file(&home, &s), serde_json::to_string(&s).unwrap()).unwrap();
        }
        assert_eq!(close_program_sessions(&home), 1);
        let asked = std::fs::read_to_string(&said).unwrap_or_default();
        assert!(asked.contains("--session live close"), "{asked}");
        assert!(!asked.contains("gone"), "a session whose daemon went is not asked: {asked}");
        assert_eq!(std::fs::read_dir(program_sessions_dir(&home)).unwrap().flatten().filter(|f| f.path().extension().is_some_and(|x| x == "session")).count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_stop_flag_holds_for_its_asks_work_alone() {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        assert!(!asked_to_stop());
        stops_with(stop.clone(), || {
            assert!(!asked_to_stop());
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            assert!(asked_to_stop(), "the ask gave up");
        });
        assert!(!asked_to_stop(), "the next work on this thread is not stopped");
    }

    /// Every command of the browser program states the idle time after which its daemon closes the browser it holds,
    /// whatever this process was started with: a session nobody drives never keeps a browser for good.
    #[test]
    fn a_browser_the_program_holds_closes_once_idle() {
        let home = std::env::temp_dir().join(format!("unbrowse-idle-{}", std::process::id()));
        let mut cmd = Command::new("true");
        on_its_own(&mut cmd, &home).unwrap();
        let idle = cmd.get_envs().find(|(k, _)| *k == "AGENT_BROWSER_IDLE_TIMEOUT_MS").and_then(|(_, v)| v).map(|v| v.to_string_lossy().into_owned());
        assert_eq!(idle.as_deref(), Some(PROGRAM_IDLE.as_millis().to_string().as_str()), "the program is told when to close an idle browser");
        assert!(PROGRAM_IDLE > std::time::Duration::ZERO, "0 would mean never");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The browser program starts a daemon that outlives the command and can hold what the command writes to (on
    /// Windows, by inheriting it: issue #545). The command ends when the program does, with what it said, never when
    /// the process it left behind lets go. `Command::output`, which the node used, waited for that process instead.
    #[cfg(unix)]
    #[test]
    fn a_program_that_leaves_a_process_holding_its_output_ends_when_it_does() {
        let leaves = || {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 3 & echo opened"]);
            cmd
        };
        let started = std::time::Instant::now();
        let out = ran(leaves(), std::time::Duration::from_secs(30)).unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "ended with the program: {:?}", started.elapsed());
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "opened");
        let started = std::time::Instant::now();
        let piped = leaves().output().unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_secs(3), "output() waits for the process left behind");
        assert_eq!(String::from_utf8_lossy(&piped.stdout).trim(), "opened");
    }

    /// A program that never ends is stopped at its bound, and says so.
    #[cfg(unix)]
    #[test]
    fn a_program_that_never_ends_is_stopped_at_its_bound() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30"]);
        let started = std::time::Instant::now();
        let why = ran(cmd, std::time::Duration::from_secs(1)).unwrap_err();
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
        assert!(why.contains("still running after 1 s, and was stopped"), "{why}");
    }

    /// A command that asks for more time than the program's own waits gets it on top of the bound.
    #[test]
    fn a_command_that_asks_for_time_is_given_it_on_top_of_the_bound() {
        assert_eq!(most_for(&["open", "https://shop.example/"]), PROGRAM_MOST);
        assert_eq!(most_for(&["eval", "--timeout", "60000", "await slow()"]), PROGRAM_MOST + std::time::Duration::from_secs(60));
        assert_eq!(most_for(&["wait", "5000"]), PROGRAM_MOST + std::time::Duration::from_secs(5));
        assert_eq!(most_for(&["fill", "@e1", "wait"]), PROGRAM_MOST, "a word typed is not a wait");
    }

    /// A door at the walk's own address: its status is 200, and only the page says what it is.
    #[cfg(unix)]
    const A_DOOR: &str = "<html><head><title>One moment</title><script src=/check.js></script></head><body><p>Checking your browser.</p></body></html>";

    #[cfg(unix)]
    /// The browser program, as a script: it logs what it was told, and answers with `page` for everything.
    fn a_program(dir: &std::path::Path, page: &str) -> (String, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let (program, log) = (dir.join("program"), dir.join("said.log"));
        std::fs::write(&program, format!("#!/bin/sh\necho \"$*\" >> '{}'\necho '{page}'\n", log.display())).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        (program.to_string_lossy().into_owned(), log)
    }

    fn a_mint(browser: String, dir: &std::path::Path) -> BrowserMint {
        BrowserMint {
            browser,
            session: "learn_test".into(),
            capture_dir: dir.join("capture"),
            _host: "site.example".into(),
            user_agent: None,
            cdp_endpoint: None,
            profile: None,
            try_controls: false,
            frames: None,
            seed: Vec::new(),
        }
    }

    /// The bridge reads the browser program's own report of what the page did: every call with its address, its
    /// headers and its body, keyed by method and path, even when the CLI says a line before its JSON.
    #[cfg(unix)]
    #[test]
    fn the_page_bridge_reads_the_calls_the_browser_reports() {
        let dir = std::env::temp_dir().join(format!("unbrowse-signed-page-{}", std::process::id()));
        let said = r#"{"success":true,"data":{"requests":[{"url":"https://shop.example/api/search","method":"POST","headers":{"x-sig":"s1","accept":"text/event-stream"},"postData":"{\"q\":\"k\"}"}]}}"#;
        let (program, _log) = a_program(&dir, &format!("[agent-browser] launched browser\n{said}"));
        let mint = a_mint(program, &dir);
        let made = mint.signed_page("https://shop.example/search");
        assert_eq!(made.len(), 1, "{made:?}");
        assert_eq!(made[0].0, "POST /api/search");
        assert_eq!(made[0].1.url, "https://shop.example/api/search");
        assert_eq!(made[0].1.body.as_deref(), Some(&b"{\"q\":\"k\"}".to_vec()[..]));
        assert!(made[0].1.headers.iter().any(|(k, v)| k == "x-sig" && v == "s1"));
    }

    /// The challenge page is the site's own last document, and the scripts are the ones the walk captured: the page's
    /// inline code (in its HTML) plus every external script its own traffic brought.
    #[test]
    fn a_challenge_page_and_its_scripts_are_read_from_the_walk() {
        let exchange = |url: &str, status: u16, mime: &str, body: &str| crate::trace::Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![("user-agent".into(), "Mozilla/5.0 (Macintosh) Chrome/156.0.0.0".into()), ("accept-language".into(), "en-GB,en;q=0.9".into())],
            request_body: None,
            status,
            response_headers: vec![],
            response_body: Some(body.into()),
            response_mime: mime.into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let script = |url: &str, body: &str| crate::trace::Exchange {
            resource_type: Some("Script".into()),
            response_mime: "text/javascript".into(),
            response_body: Some(body.into()),
            ..exchange(url, 200, "text/javascript", "")
        };
        let trace = crate::trace::Trace {
            exchanges: vec![
                exchange("https://shop.example/search", 403, "text/html", "<html><title>Just a moment...</title><script>window._cf_chl_opt={cType:'managed'};</script></html>"),
                script("https://shop.example/cdn-cgi/challenge-platform/orchestrate.js", "var a = 1;"),
                exchange("https://shop.example/search", 200, "text/html", "<html><body>results</body></html>"),
            ],
            inputs: vec![],
        };
        let url = url::Url::parse("https://shop.example/search").unwrap();
        let page = challenge_page(&trace, &url).expect("the last document at the site");
        assert_eq!(page.status, 200, "the page is the last one the site served, not the door's first refusal");
        let scripts = door_scripts(&trace);
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].0, "https://shop.example/cdn-cgi/challenge-platform/orchestrate.js");
        assert!(door_fingerprint(page)["ua"].as_str().unwrap().contains("Chrome/156"));
    }

    /// A door that asks a person (a slider, a captcha) is not something the sandbox runs: it does not pretend a
    /// script can finish it, and the agent or the owner meets that door instead.
    #[test]
    fn a_door_that_asks_a_person_is_left_to_them() {
        let url = url::Url::parse("https://www.etsy.com/search").unwrap();
        let trace = crate::trace::Trace {
            exchanges: vec![crate::trace::Exchange {
                method: "GET".into(), url: "https://challenge.vendor.example/interstitial/".parse().unwrap(), request_headers: vec![],
                request_body: None, status: 200, response_headers: vec![], response_body: None, response_mime: String::new(),
                resource_type: Some("Document".into()), main_frame: Some(false),
            }],
            inputs: vec![],
        };
        assert!(asks_a_person("<html><title>shop.example</title></html>", &trace, &url), "a frame of another site asks a person");
        assert!(!asks_a_person("<html><title>Just a moment...</title><script src=/cdn-cgi/challenge-platform/x.js></script></html>", &crate::trace::Trace { exchanges: vec![], inputs: vec![] }, &url), "a page proof is script-only");
        assert!(asks_a_person("<html><iframe src=\"https://challenge.vendor.example/box\"></iframe></html>", &crate::trace::Trace { exchanges: vec![], inputs: vec![] }, &url), "the page's own markup says it too");
    }

    /// A script-only door: the challenge page's own code sends its proof, the site answers with the clearance, and the
    /// door pass hands that cookie back for the browser and the jar. The site's answer is stubbed; the page's code is
    /// the walk's.
    #[test]
    fn a_script_only_door_is_passed_with_the_cookie_its_page_earns() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        crate::sandbox::DOOR_PASS_IN_TEST.set(Some(true));
        let page = |url: &str, mime: &str, body: &str, kind: &str| crate::trace::Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![("user-agent".into(), "Mozilla/5.0 (Macintosh) Chrome/156.0.0.0".into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(body.into()),
            response_mime: mime.into(),
            resource_type: Some(kind.into()),
            main_frame: Some(true),
        };
        let trace = crate::trace::Trace {
            exchanges: vec![
                page("https://shop.example.com/search", "text/html", "<html><title>Just a moment...</title><script src=\"/check.js\"></script><body>Verifying you are human</body></html>", "Document"),
                page(
                    "https://shop.example.com/check.js",
                    "text/javascript",
                    "fetch('/verify', { method: 'POST', headers: { 'x-proof': 'p1' }, body: '{}' });",
                    "Script",
                ),
            ],
            inputs: vec![],
        };
        let url = url::Url::parse("https://shop.example.com/search").unwrap();
        let document = challenge_page(&trace, &url).expect("the challenge page");
        let html = document.response_body.clone().unwrap();
        let bundle = door_scripts(&trace);
        let fingerprint = door_fingerprint(document);
        let dir = std::env::temp_dir().join(format!("unbrowse-door-pass-{}", std::process::id()));
        let mint = a_mint("in-process".into(), &dir);
        let mut net = |r: &crate::replay::Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() != "/verify" {
                return Err("not asked".into());
            }
            Ok(crate::trace::Exchange {
                method: "POST".into(),
                url: r.url.clone(),
                request_headers: vec![],
                request_body: r.text().map(String::from),
                status: 200,
                response_headers: vec![("set-cookie".into(), "cf_clearance=earned; Path=/; HttpOnly".into())],
                response_body: Some("{}".into()),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        };
        let clearance = mint
            .door_clearance_with(&document.url, &html, &bundle, document.url.as_str(), &fingerprint, "shop.example.com", &[], &mut net)
            .expect("the page's clearance");
        assert_eq!(clearance.cookies.get("cf_clearance").map(String::as_str), Some("earned"), "{:?}", clearance.cookies);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A door is passed only with what its own site set: an answer that came from another site (a redirect the
    /// transport followed elsewhere) sets nothing in the session.
    #[test]
    fn a_door_earns_cookies_only_from_its_own_site() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let page = |url: &str, mime: &str, body: &str, kind: &str| crate::trace::Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![("user-agent".into(), "Mozilla/5.0 (Macintosh) Chrome/156.0.0.0".into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(body.into()),
            response_mime: mime.into(),
            resource_type: Some(kind.into()),
            main_frame: Some(true),
        };
        let trace = crate::trace::Trace {
            exchanges: vec![
                page("https://shop.example.com/search", "text/html", "<html><title>Just a moment...</title><script src=\"/check.js\"></script><body>Verifying you are human</body></html>", "Document"),
                page(
                    "https://shop.example.com/check.js",
                    "text/javascript",
                    "fetch('/verify', { method: 'POST', headers: { 'x-proof': 'p1' }, body: '{}' });",
                    "Script",
                ),
            ],
            inputs: vec![],
        };
        let url = url::Url::parse("https://shop.example.com/search").unwrap();
        let document = challenge_page(&trace, &url).expect("the challenge page");
        let html = document.response_body.clone().unwrap();
        let bundle = door_scripts(&trace);
        let fingerprint = door_fingerprint(document);
        let dir = std::env::temp_dir().join(format!("unbrowse-door-other-site-{}", std::process::id()));
        let mint = a_mint("in-process".into(), &dir);
        let mut net = |r: &crate::replay::Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() != "/verify" {
                return Err("not asked".into());
            }
            Ok(crate::trace::Exchange {
                method: "POST".into(),
                // The answer came from another site (a redirect the transport followed): what it sets is not this door's.
                url: "https://elsewhere.example.org/landing".parse().unwrap(),
                request_headers: vec![],
                request_body: r.text().map(String::from),
                status: 200,
                response_headers: vec![("set-cookie".into(), "planted=theirs; Path=/".into())],
                response_body: Some("{}".into()),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        };
        let clearance = mint
            .door_clearance_with(&document.url, &html, &bundle, document.url.as_str(), &fingerprint, "shop.example.com", &[], &mut net);
        assert!(clearance.as_ref().is_none_or(|c| !c.cookies.contains_key("planted")), "another site's cookie is never the door's: {:?}", clearance.map(|c| c.cookies));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A door's page is a site's code, and nobody asked for it to run here: unless the owner turned the door pass on,
    /// the page is not booted and nothing of it is sent. Turned on, the same page earns its cookie.
    #[test]
    fn a_doors_page_is_not_run_unless_the_door_pass_is_turned_on() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let url = url::Url::parse("https://shop.example/search").unwrap();
        let html = "<html><body><script>document.cookie = 'pass=42; path=/'; fetch('/verify', { method: 'POST', body: '{}' });</script></body></html>";
        let pass = |asked: &mut usize| {
            earned_at_the_door(&url, html, &Vec::new(), url.as_str(), &serde_json::Value::Null, "shop.example", &[], |_, _| {
                *asked += 1;
                Err("not answered".to_string())
            })
        };
        // What a node with no `UNBROWSE_DOOR_PASS` set decides.
        crate::sandbox::DOOR_PASS_IN_TEST.set(Some(crate::sandbox::door_pass_on(None)));
        let mut asked = 0;
        assert_eq!(pass(&mut asked), None, "the page ran with the door pass off");
        assert_eq!(asked, 0, "the page's own call was sent with the door pass off");
        crate::sandbox::DOOR_PASS_IN_TEST.set(Some(true));
        let earned = pass(&mut asked).expect("turned on, the page earns its cookie");
        assert!(earned.0.iter().any(|(k, v, _)| k == "pass" && v == "42"), "{earned:?}");
    }

    /// A response's `Set-Cookie` is a clearance by its name and value, with the domain it was set for; a cleared
    /// cookie is not.
    #[test]
    fn a_clearance_is_the_cookie_a_response_set() {
        assert_eq!(set_cookie("cf_clearance=abc; Path=/; Domain=.shop.example; HttpOnly"), Some(("cf_clearance".into(), "abc".into(), Some(".shop.example".into()))));
        assert_eq!(set_cookie("session=gone; Max-Age=0; Path=/"), None);
        assert_eq!(set_cookie("lax"), None);
    }

    #[cfg(unix)]
    /// One test holds the switch at a time: it is the whole process's.
    static SWITCH: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Every window the browser program would open goes through one rule, and that rule has a switch: with windows
    /// off, no try of a door names one, and every try is still made.
    #[test]
    fn a_window_opens_only_where_the_owner_allows_it() {
        assert_eq!(opening("https://site.example/", 0, true, &[]), ["open", "https://site.example/"]);
        assert_eq!(opening("https://site.example/", 1, true, &["--args", "x"]), ["open", "https://site.example/", "--headed", "--args", "x"]);
        assert_eq!(opening("https://site.example/", 3, false, &[]), ["open", "https://site.example/"]);
        let source = include_str!("mint.rs");
        assert_eq!(source.split(concat!("\"--he", "aded\"")).count(), 3, "one in `opening`, one in the assert above: no other place names a window");
    }

    #[cfg(unix)]
    /// A replay that fails closes this session's browser: the caller closes only after a step was walled, and a
    /// failed step never is — the Eden report's browsers left open by failed learns.
    #[test]
    fn a_replay_that_fails_closes_the_browser_it_opened() {
        let _one = SWITCH.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("mint-execute-close-{}", std::process::id()));
        let (program, log) = a_program(&dir, "Verify you are human");
        let mut mint = a_mint(program, &dir);
        let req = crate::replay::Request {
            method: "GET".into(),
            url: "https://site.example/search?q=lamp".parse().unwrap(),
            exchange: 0,
            headers: vec![],
            body: None,
        };
        let err = mint.execute(&req).expect_err("the site kept challenging the browser");
        assert!(matches!(err, MintError::Browser(_)), "{err:?}");
        let said = std::fs::read_to_string(&log).unwrap();
        assert!(said.lines().last().is_some_and(|l| l.ends_with(" close")), "the failed call closed its browser: {said}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    /// A door that never opens costs the walk its tries, and with windows off none of them shows one.
    #[test]
    fn a_walk_through_the_browser_program_opens_no_window_when_windows_are_off() {
        let _one = SWITCH.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("mint-windows-{}", std::process::id()));
        let (program, log) = a_program(&dir, A_DOOR);
        set_windows(false);
        let walked = a_mint(program, &dir).mint_by_program(&url::Url::parse("https://site.example/").unwrap());
        set_windows(true);
        assert!(walked.is_err(), "the door stayed shut");
        let said = std::fs::read_to_string(&log).unwrap();
        assert_eq!(said.lines().filter(|l| l.contains(" open https://site.example/")).count(), 4, "{said}");
        assert!(!said.contains(concat!("--he", "aded")), "{said}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    /// A walk through the browser program leaves no browser behind, landed or not: its session is its own, nothing
    /// returns to it, and a browser left open holds the site's profile against the next.
    #[test]
    fn a_walk_through_the_browser_program_closes_its_browser() {
        let _one = SWITCH.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for page in ["A page of the site", A_DOOR] {
            let dir = std::env::temp_dir().join(format!("mint-close-{}-{}", std::process::id(), page.len()));
            let (program, log) = a_program(&dir, page);
            let _ = a_mint(program, &dir).mint_by_program(&url::Url::parse("https://site.example/").unwrap());
            let said = std::fs::read_to_string(&log).unwrap();
            assert!(said.lines().last().is_some_and(|l| l.ends_with(" close")), "{page}: {said}");
            assert!(!said.contains("--all"), "another walk's browser is left open: {said}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The capture log of a passing visit: the site sets a cookie, and the
    /// browser submits a Turnstile answer in a form body and a JSON leaf.
    #[test]
    fn a_jar_keeps_only_the_cookies_sent_to_its_host() {
        let answer = r#"{"success":true,"data":{"cookies":[
            {"name":"session","value":"s2","domain":".shop.example"},
            {"name":"ad_id","value":"x","domain":".ads.example"},
            {"name":"pref","value":"p","domain":"www.shop.example"}]}}"#;
        let held = cookies_of(answer);
        assert_eq!(cookies_sent_to(answer, "www.shop.example"), vec![("session".to_string(), "s2".to_string()), ("pref".to_string(), "p".to_string())]);
        let old = std::collections::BTreeMap::from([
            ("session".to_string(), "s1".to_string()),
            ("ad_id".to_string(), "x".to_string()),
            ("gone_frame_cookie".to_string(), "y".to_string()),
            ("csrf-token".to_string(), "t".to_string()),
        ]);
        let tokens = std::collections::HashSet::from(["csrf-token".to_string()]);
        let jar = jar_with(old.clone(), &held, "www.shop.example", &tokens);
        assert_eq!(jar.keys().collect::<Vec<_>>(), ["csrf-token", "pref", "session"]);
        assert_eq!(jar["session"], "s2");
        assert_eq!(jar_with(old.clone(), &[], "www.shop.example", &tokens), old);
    }

    /// A walk keeps a bounded amount of body text in all, whatever each body's own cap allows: data-sized answers are
    /// kept whole until the walk's total is spent, the one that crosses it is cut there, and those after it are recorded
    /// with no body. (The browser core's own walk, `session::KeptBodies`, tested here because the core is built as this
    /// workspace's dependency.)
    #[test]
    fn a_walks_kept_bodies_have_a_bound_in_all() {
        use agent_browser_core::session::{KeptBodies, WALK_BODIES_CAP};
        assert_eq!(KeptBodies::default().left(), WALK_BODIES_CAP);
        let mut kept = KeptBodies::within(5_000_000);
        let data = serde_json::json!({ "mimeType": "application/json" });
        let answer = format!("[{}0]", "1,".repeat(1_000_000));
        let body = |line: &serde_json::Value| line["body"].as_str().unwrap_or_default().len();
        assert_eq!(body(&kept.line("1", &data, &answer)), answer.len(), "a data answer under the walk's total is kept whole");
        assert_eq!(body(&kept.line("2", &data, &answer)), answer.len());
        assert_eq!(body(&kept.line("3", &data, &answer)), 5_000_000 - 2 * answer.len(), "the one that crosses it is cut there");
        let after = kept.line("4", &data, &answer);
        assert_eq!((body(&after), after["requestId"].as_str()), (0, Some("4")), "after it, the answer is recorded with no body");
        assert_eq!(kept.left(), 0);
    }

    /// A seeded cookie is set as the browser that earned it had it: kept from the page's script unless it is known
    /// not to be HttpOnly, so a session cookie a walk starts with is never handed to the page's script because its
    /// record is older than HttpOnly was kept.
    #[test]
    fn a_seeded_cookie_is_kept_from_script_unless_known_otherwise() {
        let set = |http_only: Option<bool>| agent_browser_core::session::seed_params(&[SeedCookie { name: "sid".into(), value: "s".into(), http_only, ..Default::default() }], "https://shop.example/")["cookies"][0]["httpOnly"].clone();
        assert_eq!(set(None), serde_json::json!(true), "unknown is HttpOnly");
        assert_eq!(set(Some(true)), serde_json::json!(true));
        assert_eq!(set(Some(false)), serde_json::json!(false));
    }

    /// Only a well-formed answer from the browser judges a walk's cookies, an empty one included: a command that
    /// failed, an answer in another shape, or nothing at all says nothing, and is asked again a bounded number of times
    /// before the walk fails plainly. Such a non-answer never empties a session, and never lets the capture's cookies
    /// stand on its word alone.
    #[test]
    fn only_a_well_formed_answer_from_the_browser_judges_the_session() {
        assert_eq!(browser_cookie_list(r#"{"data":{"cookies":[]}}"#), Some(vec![]), "an empty list is an answer");
        for not_one in ["", "error: no browser", r#"{"success":false,"error":"timed out"}"#, r#"{"cookies":[{"name":"sid"}]}"#, r#"{"cookies":"none"}"#] {
            assert!(browser_cookie_list(not_one).is_none(), "{not_one}");
            let mut session = MintedSession::default();
            session.cookies.insert("sid".into(), "kept".into());
            assert!(take_browsers(&mut session, not_one, "shop.test").is_err(), "{not_one}");
            assert_eq!(session.cookies.get("sid").map(String::as_str), Some("kept"), "a non-answer changes nothing by itself");
        }
        let asked = std::cell::Cell::new(0);
        let flaky = |answers: Vec<Result<String, MintError>>| {
            asked.set(0);
            let answers = std::cell::RefCell::new(answers.into_iter());
            let ab = |_: &[&str]| {
                asked.set(asked.get() + 1);
                answers.borrow_mut().next().unwrap_or_else(|| Ok("no".into()))
            };
            ask_cookies(&ab)
        };
        let good = r#"{"cookies":[{"name":"sid","value":"s","domain":"shop.test","path":"/","httpOnly":true}]}"#.to_string();
        assert_eq!(flaky(vec![Err(MintError::Browser("busy".into())), Ok("garbage".into()), Ok(good.clone())]).ok(), Some(good));
        assert_eq!(asked.get(), 3);
        let gave_up = flaky(vec![Ok(String::new()), Err(MintError::Browser("timed out".into())), Ok("{}".into()), Ok(r#"{"cookies":[]}"#.into())]);
        assert!(gave_up.is_err_and(|e| e.to_string().contains("asked 3 times")), "a zero-exit empty or malformed answer is no answer");
        assert_eq!(asked.get(), COOKIE_ASKS, "asked a bounded number of times");
    }

    /// A line that ends a cookie ends it wherever the node keeps cookies: by Max-Age, or by an Expires already past however
    /// it is written (earlier this year, with dashes), Max-Age winning where a line has both. A walk's capture takes the
    /// cookie out when the ending line names its reach and path, and the walk's browser is the judge: a cookie the capture
    /// saw set that the browser no longer holds is not kept.
    #[test]
    fn a_line_that_ends_its_cookie_ends_it_wherever_the_node_keeps_cookies() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let year = 1970 + now / 31_556_952;
        let earlier = format!("Thu, 01-Jan-{year} 00:00:01 GMT");
        assert!(crate::http::ends_the_cookie(&format!("sid=old; Path=/; Expires={earlier}")), "an Expires earlier this year");
        assert!(crate::http::ends_the_cookie("sid=old; Expires=Thu, 01 Jan 1970 00:00:00 GMT"));
        assert!(crate::http::ends_the_cookie("sid=old; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT"), "Max-Age wins");
        assert!(!crate::http::ends_the_cookie(&format!("sid=new; Max-Age=3600; Expires={earlier}")), "Max-Age wins");
        assert!(crate::http::cookie_expiry("sid=new; Expires=Fri, 01 Jan 2100 00:00:00 GMT").is_some_and(|e| e > now as f64), "a future Expires is the cookie's life");
        let line = |set: &str| serde_json::json!({"type": "exchange", "entry": {"request": {"url": "https://www.shop.test/"}, "response": {"headers": [{"name": "set-cookie", "value": set}]}}}).to_string();
        let walked = |lines: &[String]| harvest_capture(&lines.iter().map(|l| line(l)).collect::<Vec<_>>().join("\n"));
        let ended = walked(&["sid=old; Domain=.shop.test; Path=/".into(), format!("sid=old; Domain=.shop.test; Path=/; Expires={earlier}")]);
        assert!(!ended.cookies.contains_key("sid") && !ended.domains.contains_key("sid"));
        let elsewhere = walked(&["sid=old; Path=/".into(), format!("sid=; Path=/other; Expires={earlier}")]);
        assert_eq!(elsewhere.cookies.get("sid").map(String::as_str), Some("old"), "a line for another path ends that cookie, not this one");
        // The browser holds none of it: what the capture kept leaves.
        let mut session = walked(&["sid=old; Path=/".into(), "pref=p; Path=/".into()]);
        take_browsers(&mut session, r#"{"data":{"cookies":[{"name":"pref","value":"p","domain":"www.shop.test","path":"/","httpOnly":false}]}}"#, "www.shop.test").unwrap();
        assert_eq!((session.cookies.contains_key("sid"), session.cookies.get("pref").map(String::as_str)), (false, Some("p")));
    }

    /// A walk's session that takes in another (a door's clearance) takes each cookie with its own reach and facts: a
    /// value set for its host alone never keeps the domain an older value of the name had.
    #[test]
    fn a_session_taken_in_keeps_each_values_own_reach() {
        let mut walk = MintedSession::default();
        walk.cookies.insert("pass".into(), "old".into());
        walk.domains.insert("pass".into(), ".shop.test".into());
        walk.facts.insert("pass".into(), CookieFacts { path: "/".into(), http_only: false, expires: None });
        let mut door = MintedSession::default();
        door.cookies.insert("pass".into(), "new".into());
        walk.absorb(door);
        assert_eq!((walk.cookies["pass"].as_str(), walk.domains.get("pass"), walk.facts.get("pass")), ("new", None, None));
    }

    /// The jar keeps one cookie per name, and its value always travels with its own line's reach and path: of two
    /// cookies of one name the narrower is kept with its own facts, on a tie the first, so a value never goes where its
    /// own line didn't send it. HttpOnly is never loosened by the choice. The capture's lines and the browser's own
    /// cookies are read alike: disjoint paths of one length, paths that don't nest and differ in length, two domains.
    #[test]
    fn a_cookie_value_travels_with_its_own_lines_reach() {
        let line = |set: &str| serde_json::json!({"type": "exchange", "entry": {"request": {"url": "https://www.shop.test/"}, "response": {"headers": [{"name": "set-cookie", "value": set}]}}}).to_string();
        let walked = |lines: &[&str]| harvest_capture(&lines.iter().map(|l| line(l)).collect::<Vec<_>>().join("\n"));
        let kept = |s: &MintedSession| (s.cookies["pair"].clone(), s.domains.get("pair").cloned(), s.facts["pair"].path.clone());
        // Disjoint paths of one length: the first stays, with its own path.
        assert_eq!(kept(&walked(&["pair=foo; Path=/foo", "pair=bar; Path=/bar"])), ("foo".into(), None, "/foo".into()));
        // Paths that don't nest: the longer is narrower, its value with its own path, whichever came first.
        for order in [["pair=long; Path=/barbaz", "pair=short; Path=/foo"], ["pair=short; Path=/foo", "pair=long; Path=/barbaz"]] {
            assert_eq!(kept(&walked(&order)), ("long".into(), None, "/barbaz".into()));
        }
        // Two domains: the longer is narrower, its value with its own domain, whichever came first.
        for order in [["pair=wide; Domain=.shop.test; Path=/", "pair=narrow; Domain=.www.shop.test; Path=/"], ["pair=narrow; Domain=.www.shop.test; Path=/", "pair=wide; Domain=.shop.test; Path=/"]] {
            assert_eq!(kept(&walked(&order)), ("narrow".into(), Some(".www.shop.test".into()), "/".into()));
        }
        // The same cookie set again replaces itself; another line's HttpOnly still holds.
        assert_eq!(walked(&["one=a; Path=/", "one=b; Path=/"]).cookies["one"], "b");
        let hidden = walked(&["pair=narrow; Path=/admin", "pair=wide; Path=/; HttpOnly"]);
        assert_eq!((hidden.cookies["pair"].as_str(), hidden.facts["pair"].http_only), ("narrow", true));
        // The browser holding both: the same choice, value, reach and facts together.
        let answer = r#"{"data":{"cookies":[
            {"name":"pair","value":"wide","domain":".shop.test","path":"/","httpOnly":true},
            {"name":"pair","value":"narrow","domain":".www.shop.test","path":"/","httpOnly":false},
            {"name":"path","value":"foo","domain":"www.shop.test","path":"/foo","httpOnly":false},
            {"name":"path","value":"bar","domain":"www.shop.test","path":"/bar","httpOnly":false}]}}"#;
        assert_eq!(cookies_sent_to(answer, "www.shop.test"), vec![("pair".to_string(), "narrow".to_string()), ("path".to_string(), "foo".to_string())]);
        assert_eq!(scopes_of(answer, "www.shop.test").get("pair").map(String::as_str), Some(".www.shop.test"));
        let facts = facts_of(answer, "www.shop.test");
        assert_eq!((facts["pair"].http_only, facts["path"].path.as_str()), (true, "/foo"));
        // A host the narrow line doesn't reach gets the wide line's own value with its own reach, never the narrow one's.
        assert_eq!(cookies_sent_to(answer, "api.shop.test"), vec![("pair".to_string(), "wide".to_string())]);
        assert_eq!(scopes_of(answer, "api.shop.test").get("pair").map(String::as_str), Some(".shop.test"));
    }

    /// What the browser knows of each cookie beyond its value is read from its own answer and from the lines the walk
    /// saw: the path, and whether a page's script may read it. A cookie the browser says nothing of HttpOnly about is
    /// left out, so it reads as unknown, which a page's script is never shown.
    #[test]
    fn a_walk_records_each_cookies_path_and_httponly() {
        let answer = r#"{"data":{"cookies":[
            {"name":"sid","value":"s","domain":"shop.test","path":"/","httpOnly":true},
            {"name":"pref","value":"p","domain":".shop.test","path":"/app","httpOnly":false},
            {"name":"vague","value":"v","domain":"shop.test"},
            {"name":"theirs","value":"t","domain":"other.test","path":"/","httpOnly":false}]}}"#;
        let facts = facts_of(answer, "shop.test");
        assert_eq!((facts["sid"].http_only, facts["pref"].http_only, facts["pref"].path.as_str()), (true, false, "/app"));
        assert!(!facts.contains_key("vague") && !facts.contains_key("theirs"));
        let line = serde_json::json!({"type": "exchange", "entry": {
            "request": {"url": "https://shop.test/account/login"},
            "response": {"headers": [{"name": "set-cookie", "value": "sess=1; Secure; HttpOnly"}, {"name": "set-cookie", "value": "flag=on; Path=/"}]}}});
        let session = harvest_capture(&line.to_string());
        assert_eq!((session.facts["sess"].http_only, session.facts["sess"].path.as_str()), (true, "/account"));
        assert_eq!((session.facts["flag"].http_only, session.facts["flag"].path.as_str()), (false, "/"));
    }

    /// A cookie a parent host set for itself alone is never a subdomain's: only a cookie set for the domain (a
    /// leading dot) goes to the names under it.
    #[test]
    fn a_host_only_cookie_goes_to_its_own_host_alone() {
        assert!(sent_to("shop.test", "shop.test"));
        assert!(!sent_to("shop.test", "help.shop.test"), "host-only: the parent's alone");
        assert!(sent_to(".shop.test", "help.shop.test"));
        assert!(sent_to(".shop.test", "shop.test"));
        assert!(!sent_to(".shop.test", "othershop.test"));
        assert!(!sent_to("", "shop.test") && !sent_to(".", "shop.test"));
        let answer = r#"{"cookies":[{"name":"sid","value":"dummy","domain":"shop.test"},{"name":"pref","value":"p","domain":".shop.test"}]}"#;
        assert_eq!(cookies_sent_to(answer, "help.shop.test"), vec![("pref".to_string(), "p".to_string())]);
        // And the reach of each is kept beside the value, for the calls that send them later: only the cookie set
        // for the whole domain has a reach to keep.
        assert_eq!(
            scopes_of(answer, "help.shop.test"),
            std::collections::HashMap::from([("pref".to_string(), ".shop.test".to_string())])
        );
        assert!(scopes_of(answer, "othershop.test").is_empty(), "a cookie's reach never leaves its site");
    }

    #[test]
    fn harvest_capture_reads_cookies_and_widget_tokens() {
        let log = [
            r#"{"type":"exchange","entry":{"request":{"url":"https://x.example/door","method":"GET","headers":[]},"response":{"status":200,"headers":[{"name":"set-cookie","value":"door=ok_123456789; Path=/"},{"name":"set-cookie","value":"site_pass=pass_99887766; Domain=x.example; Path=/"}]}}}"#,
            r#"{"type":"exchange","entry":{"request":{"url":"https://x.example/submit?cf-turnstile-response=qry_987654321","method":"GET","headers":[],"postData":{"text":"note=plain"}},"response":{"status":200,"headers":[]}}}"#,
            r#"{"type":"exchange","entry":{"request":{"url":"https://x.example/api","method":"POST","headers":[],"postData":{"text":"{\"cf-turnstile-response\":\"json_555444333\",\"keep\":\"yes\"}"}},"response":{"status":200,"headers":[]}}}"#,
        ]
        .join("\n");
        let session = harvest_capture(&log);
        assert_eq!(session.cookies.get("door").map(String::as_str), Some("ok_123456789"));
        assert_eq!(session.tokens.get("cf-turnstile-response").map(String::as_str), Some("json_555444333"));
        // A later submission in the log wins: the freshest answer is kept.
        assert_ne!(session.tokens.get("cf-turnstile-response").map(String::as_str), Some("qry_987654321"));
        // The cookie set for the site's domain keeps that domain beside its value; the host-only one has none:
        // its host is the whole of its reach.
        assert_eq!(session.domains.get("site_pass").map(String::as_str), Some(".x.example"));
        assert!(!session.domains.contains_key("door"));
    }
}
