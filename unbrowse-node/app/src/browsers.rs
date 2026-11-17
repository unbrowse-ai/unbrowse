//! Which browser the node walks and browses in. The owner's choice when there is one (`browser.json`), else the
//! engine's own pick (the Chrome for Testing it downloaded, then a Chrome installed here), else any other Chromium
//! browser installed here. `UNBROWSE_SYSTEM_BROWSERS=0` keeps the node off the browsers installed here: it uses only
//! the Chrome for Testing it downloaded.
//!
//! The browser is an add-on, never a part of the install: the node runs, searches, calls routes and answers its owner
//! without one. Two parts make it: the browser program (`agent-browser`, which drives a page by hand) and a Chromium
//! (which a walk launches through the engine the node links). A walk needs a Chromium; browsing by hand needs both. A
//! node missing a part answers `browser_missing` ([`Missing`]), never a crash or a hang, and fetches the parts itself
//! when its owner lets it (`fetch_browser`, on by default); `unbrowse browser install` does the same by hand
//! ([`install`]). The program comes from the release this node is, checked against the release's signature
//! (`update::browser_package`); the Chromium is Chrome for Testing, which the program downloads (its `install`
//! command). Nothing is fetched when the node starts.
//!
//! A Chromium browser is read from the program itself, never from a list of names: it opens web links (it handles
//! `http` and `https`) and carries Chromium, the engine that speaks DevTools. Safari and Firefox open links but
//! carry no Chromium; an Electron app carries Chromium but opens no links. On a Mac that is a bundle with Chromium's
//! renderer helper (`… Helper (Renderer).app`); on Linux a desktop entry for the web's links whose program sits
//! beside Chromium's resource pack; on Windows a program Windows lists as a web browser, with that pack beside it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store;
use crate::sync::Locked;

/// A browser the node can drive.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Found {
    pub name: String,
    /// The program to launch.
    pub path: String,
    /// Chrome for Testing the engine downloaded, rather than an app installed here.
    pub downloaded: bool,
}

/// What the window shows: the browser in use, the owner's choice, the ones to choose from, and the download.
#[derive(Clone, Debug, Serialize)]
pub struct View {
    pub using: Option<String>,
    pub chosen: Option<String>,
    pub found: Vec<Found>,
    pub downloading: bool,
    pub download_error: Option<String>,
    /// The browser program the node drives pages with, when it has one.
    pub program: Option<String>,
    /// The browser as agents see it ([`state`]): `present`, `missing` or `installing`.
    pub state: &'static str,
    /// Whether the node fetches the browser itself the first time something needs it (`fetch_browser`).
    pub fetch: bool,
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Choice {
    path: Option<String>,
}

fn choice_file() -> PathBuf {
    store::home().join("browser.json")
}

/// Whether the node may use the browsers installed on this machine: unless `UNBROWSE_SYSTEM_BROWSERS` is `0`, `off`,
/// `false` or `no`, for a node that must never drive its owner's own Chrome (a server, a sandbox, a test). Off, it uses
/// only the Chrome for Testing it downloaded.
pub fn system_browsers() -> bool {
    !std::env::var("UNBROWSE_SYSTEM_BROWSERS").is_ok_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "off" | "false" | "no"))
}

/// The owner's choice, while that browser is still there (with the system's browsers off, only the Chrome for Testing
/// the node downloaded counts).
pub fn chosen() -> Option<String> {
    let c: Choice = store::read_json(&choice_file(), &unbrowse_files::BROWSER);
    let downloaded = unbrowse_learn::mint::downloaded_chromium();
    c.path.filter(|p| Path::new(p).is_file()).filter(|p| system_browsers() || downloaded.as_deref() == Some(Path::new(p)))
}

/// The browser the node uses now, if it has one. In a test, only the one the test named (`for_this_test`): a test
/// never launches the browser of the machine it happens to run on, whatever path it takes there (a call's heal, a
/// walled step, a sign-in, the agent's hands).
pub fn current() -> Option<String> {
    #[cfg(test)]
    {
        NAMED.with(|named| named.borrow().clone())
    }
    #[cfg(not(test))]
    {
        on_this_machine()
    }
}

#[cfg(test)]
thread_local! {
    /// The browser this test thread asked for by name, if it asked.
    static NAMED: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Gives this test thread `browser` as the node's browser, or none: a test that needs a browser names it, as
/// `for_this_test(on_this_machine())` does.
#[cfg(test)]
pub fn for_this_test(browser: Option<String>) {
    NAMED.with(|named| *named.borrow_mut() = browser);
}

/// The browser this machine gives the node: the owner's choice, the engine's own, or one installed here.
pub fn on_this_machine() -> Option<String> {
    if !system_browsers() {
        return chosen().or_else(|| unbrowse_learn::mint::downloaded_chromium().map(|p| p.display().to_string()));
    }
    chosen()
        .or_else(|| unbrowse_learn::mint::engine_chromium().map(|p| p.display().to_string()))
        .or_else(|| installed().into_iter().next().map(|f| f.path))
}

/// Every browser the node can drive: the downloaded Chrome for Testing first, then the apps installed here.
pub fn found() -> Vec<Found> {
    let mut out: Vec<Found> = unbrowse_learn::mint::downloaded_chromium()
        .map(|p| Found { name: "Chrome for Testing".into(), path: p.display().to_string(), downloaded: true })
        .into_iter()
        .collect();
    out.extend(installed());
    out
}

/// The Chromium browsers installed here, by name: none while the system's browsers are off.
fn installed() -> Vec<Found> {
    if !system_browsers() {
        return Vec::new();
    }
    let mut out = programs();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// The apps in /Applications and ~/Applications.
#[cfg(target_os = "macos")]
fn programs() -> Vec<Found> {
    [PathBuf::from("/Applications"), unbrowse_files::private::user_home().join("Applications")]
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|d| d.flatten().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "app"))
        .filter_map(|app| chromium_app(&app))
        .collect()
}

/// The desktop entries for the web's links, in the system's and the user's applications folders.
#[cfg(target_os = "linux")]
fn programs() -> Vec<Found> {
    let mut dirs: Vec<PathBuf> = vec![unbrowse_files::private::user_home().join(".local/share/applications")];
    let data = std::env::var("XDG_DATA_DIRS").ok().filter(|d| !d.is_empty()).unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    dirs.extend(data.split(':').map(|d| Path::new(d).join("applications")));
    dirs.iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|d| d.flatten().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "desktop"))
        .filter_map(|p| desktop_entry(&std::fs::read_to_string(p).ok()?))
        .collect()
}

/// A desktop entry's browser: it handles `http` and `https`, and its program, followed to where it lives, sits
/// beside Chromium's resource pack.
#[cfg(any(target_os = "linux", test))]
fn desktop_entry(text: &str) -> Option<Found> {
    let entry = text.split("\n[").next()?;
    let field = |k: &str| entry.lines().find_map(|l| l.strip_prefix(k)?.trim_start().strip_prefix('=').map(str::trim));
    let mime: Vec<&str> = field("MimeType").unwrap_or_default().split(';').collect();
    if !["http", "https"].iter().all(|s| mime.contains(&format!("x-scheme-handler/{s}").as_str())) {
        return None;
    }
    let exec = field("Exec")?;
    let program = match exec.strip_prefix('"') {
        Some(rest) => rest.split('"').next()?,
        None => exec.split_whitespace().next()?,
    };
    let path = on_path(program)?;
    let real = std::fs::canonicalize(&path).ok()?;
    let name = field("Name")?.to_string();
    carries_chromium(real.parent()?).then(|| Found { name, path: real.display().to_string(), downloaded: false })
}

/// `program` as named, else found on PATH.
#[cfg(any(target_os = "linux", test))]
fn on_path(program: &str) -> Option<PathBuf> {
    let p = Path::new(program);
    if p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(program)).find(|c| c.is_file())
}

/// The programs Windows lists as web browsers (`StartMenuInternet`), for this user and for everyone.
#[cfg(windows)]
fn programs() -> Vec<Found> {
    let mut out = Vec::new();
    for root in ["HKCU", "HKLM"] {
        let base = format!(r"{root}\SOFTWARE\Clients\StartMenuInternet");
        for key in reg(&["query", &base]).lines().map(str::trim).filter(|l| l.len() > base.len() && l.starts_with(&base[..4])) {
            let Some(name) = reg_value(&reg(&["query", key, "/ve"])) else { continue };
            let Some(command) = reg_value(&reg(&["query", &format!(r"{key}\shell\open\command"), "/ve"])) else { continue };
            let exe = PathBuf::from(command.trim().trim_matches('"'));
            if exe.is_file() && exe.parent().is_some_and(carries_chromium) {
                out.push(Found { name, path: exe.display().to_string(), downloaded: false });
            }
        }
    }
    out
}

/// What `reg.exe` prints for a query, empty when it fails.
#[cfg(windows)]
fn reg(args: &[&str]) -> String {
    std::process::Command::new("reg").args(args).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

/// The value in `reg query … /ve`'s answer: `    (Default)    REG_SZ    Google Chrome`.
#[cfg(any(windows, test))]
fn reg_value(out: &str) -> Option<String> {
    out.lines().find_map(|l| {
        let (_, v) = l.split_once("REG_SZ").or_else(|| l.split_once("REG_EXPAND_SZ"))?;
        Some(v.trim().to_string()).filter(|v| !v.is_empty())
    })
}

/// Chromium's resource pack and its ICU data are in `dir`, or in a version folder inside it (as Windows' installs
/// keep them).
#[cfg(any(not(target_os = "macos"), test))]
fn carries_chromium(dir: &Path) -> bool {
    let has = |d: &Path| d.join("resources.pak").is_file() && d.join("icudtl.dat").is_file();
    has(dir) || std::fs::read_dir(dir).into_iter().flatten().flatten().any(|e| e.file_type().is_ok_and(|t| t.is_dir()) && has(&e.path()))
}

/// The app at `bundle` as a browser the node can drive, if it is one.
#[cfg(target_os = "macos")]
fn chromium_app(bundle: &Path) -> Option<Found> {
    let info = plist(&bundle.join("Contents/Info.plist"))?;
    if !opens_web_links(&info) || !has_renderer_helper(&bundle.join("Contents/Frameworks")) {
        return None;
    }
    let exe = bundle.join("Contents/MacOS").join(info.get("CFBundleExecutable")?.as_str()?);
    let stem = bundle.file_stem()?.to_string_lossy().to_string();
    let name = ["CFBundleDisplayName", "CFBundleName"].iter().find_map(|k| info.get(*k)?.as_str().map(String::from)).unwrap_or(stem);
    exe.is_file().then(|| Found { name, path: exe.display().to_string(), downloaded: false })
}

/// An Info.plist as JSON, binary or XML alike.
#[cfg(target_os = "macos")]
fn plist(path: &Path) -> Option<Value> {
    let out = std::process::Command::new("plutil").args(["-convert", "json", "-o", "-"]).arg(path).output().ok()?;
    out.status.success().then(|| serde_json::from_slice(&out.stdout).ok()).flatten()
}

/// The app says it opens `http` and `https` links: a web browser.
#[cfg(target_os = "macos")]
fn opens_web_links(info: &Value) -> bool {
    let schemes: Vec<&str> = info
        .get("CFBundleURLTypes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|t| t.get("CFBundleURLSchemes")?.as_array())
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    ["http", "https"].iter().all(|s| schemes.iter().any(|x| x.eq_ignore_ascii_case(s)))
}

/// Chromium's renderer helper is somewhere in the app's frameworks (in Chromium's own framework, or beside it).
#[cfg(target_os = "macos")]
fn has_renderer_helper(frameworks: &Path) -> bool {
    fn walk(dir: &Path, depth: usize) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        entries.flatten().any(|e| {
            let Ok(kind) = e.file_type() else { return false };
            if !kind.is_dir() {
                return false;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(" Helper (Renderer).app") {
                return true;
            }
            depth > 0 && !name.ends_with(".app") && walk(&e.path(), depth - 1)
        })
    }
    walk(frameworks, 5)
}

/// Gives the walks and the browsing the browser in use now, and whether they may show a window.
pub fn apply() {
    unbrowse_learn::mint::set_chromium(current());
    unbrowse_learn::mint::set_windows(!headless_only());
}

/// What `UNBROWSE_HEADLESS` says, when it says: 1, true or on keeps the browser headless, 0, false or off lets it show a
/// window, and anything else leaves the owner's setting to decide.
fn headless_said(env: Option<&str>) -> Option<bool> {
    match env?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => Some(true),
        "0" | "false" | "off" | "no" => Some(false),
        _ => None,
    }
}

/// Whether the node keeps its browser headless: `UNBROWSE_HEADLESS` when it says, else the owner's `headless_only`.
pub fn headless_only() -> bool {
    headless_said(std::env::var("UNBROWSE_HEADLESS").ok().as_deref()).unwrap_or_else(|| store::load_settings().headless_only)
}

/// The owner picks a browser from those found, or None to let the node pick. Browsers already running keep theirs;
/// the next one the node starts is the new choice.
pub fn choose(path: Option<String>) -> Result<View, String> {
    if let Some(p) = &path {
        if !found().iter().any(|f| &f.path == p) {
            return Err(format!("{p} isn't a Chromium browser on this machine"));
        }
    }
    store::write_json(&choice_file(), &unbrowse_files::BROWSER, &Choice { path }).map_err(|e| format!("keeping the browser: {e}"))?;
    apply();
    Ok(view())
}

#[derive(Default)]
struct Download {
    running: bool,
    error: Option<String>,
}

static DOWNLOAD: Mutex<Download> = Mutex::new(Download { running: false, error: None });

pub fn view() -> View {
    let (downloading, download_error) = {
        let d = DOWNLOAD.locked();
        (d.running, d.error.clone())
    };
    View {
        using: current(),
        chosen: chosen(),
        found: found(),
        downloading,
        download_error,
        program: crate::browse::binary().ok().map(|p| p.display().to_string()),
        state: state(),
        fetch: fetch_allowed(),
    }
}

/// `work`'s result, a panic in it included: left to end the thread, `running` would stay set and no fetch would start
/// again until the node restarts.
fn unpanicked<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).unwrap_or_else(|_| Err("fetching the browser stopped on a panic: try again".into()))
}

/// Fetches what the browser lacks ([`install`]) on its own thread; the window hears `browser` when it starts and when
/// it ends. A fetch already running is left to finish.
pub fn download(node: Arc<crate::Node>) {
    {
        let mut d = DOWNLOAD.locked();
        if d.running {
            return;
        }
        *d = Download { running: true, error: None };
    }
    node.events.emit("browser", ());
    std::thread::spawn(move || {
        let result = unpanicked(|| install(None));
        match &result {
            Ok(did) => did.iter().for_each(|l| eprintln!("browser: {l}")),
            Err(e) => eprintln!("browser: fetching the browser failed: {e}"),
        }
        *DOWNLOAD.locked() = Download { running: false, error: result.err() };
        apply();
        node.events.emit("browser", ());
    });
}

// ---- the browser add-on ----

/// The browser program's file name on this machine.
pub fn program_file() -> String {
    format!("agent-browser{}", std::env::consts::EXE_SUFFIX)
}

/// Where the node keeps the browser add-on it installed: the program, and `version`, the release it came from (`local`
/// for one the owner gave it). Under the node's home, so each node has its own.
pub fn addon_dir() -> PathBuf {
    store::home().join("addons").join("browser")
}

/// The browser program the node installed, where it is when it is.
pub fn addon_program() -> PathBuf {
    addon_dir().join(program_file())
}

/// The release the installed browser program came from.
pub fn addon_version() -> Option<String> {
    std::fs::read_to_string(addon_dir().join("version")).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Puts the browser program at `src` where the node keeps its add-on, as release `version`'s: copied whole and made
/// runnable beside it, then moved into place, so a node looking meanwhile finds the one before or this one, never half
/// of one.
pub fn put_program(src: &Path, version: &str) -> Result<PathBuf, String> {
    let dir = addon_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let part = dir.join(format!("{}.partial-{}", program_file(), std::process::id()));
    std::fs::copy(src, &part).map_err(|e| format!("copying {}: {e}", src.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    let to = addon_program();
    if let Err(e) = swap_program(&part, &to, &dir.join("version"), version, |from, to| std::fs::rename(from, to)) {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{}: {e}", to.display()));
    }
    Ok(to)
}

/// Moves the program at `part` to `to`, with `version_file` saying so. The two can't change at once, so the file says
/// nothing while the program changes: a node killed in between finds a program of no known release, and an update fetches
/// it, never a release's name on another's program, which an update would take at its word and skip. The name goes in
/// whole or not at all.
fn swap_program(part: &Path, to: &Path, version_file: &Path, version: &str, put: impl FnOnce(&Path, &Path) -> std::io::Result<()>) -> Result<(), String> {
    match std::fs::remove_file(version_file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => {}
    }
    put(part, to).map_err(|e| e.to_string())?;
    let named = version_file.with_extension("partial");
    std::fs::write(&named, format!("{version}\n")).and_then(|_| std::fs::rename(&named, version_file)).map_err(|e| e.to_string())
}

/// The same from a browser package (`@unbrowse/browser-<machine>`, a tarball as npm keeps it): its `bin/agent-browser`.
pub fn put_package(tgz: &[u8], version: &str) -> Result<PathBuf, String> {
    let stage = addon_dir().with_file_name(format!("browser.unpack-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&stage);
    let r = crate::update::unpack(tgz, &stage).and_then(|_| {
        let program = [stage.join("bin").join(program_file()), stage.join(program_file())]
            .into_iter()
            .find(|p| p.is_file())
            .ok_or_else(|| format!("the package holds no {}", program_file()))?;
        put_program(&program, version)
    });
    let _ = std::fs::remove_dir_all(&stage);
    r
}

/// Whether `path` is a package tarball rather than the program itself.
fn is_package(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    name.ends_with(".tgz") || name.ends_with(".tar.gz")
}

/// That the program at `program` runs on this machine: it says its version.
fn runs(program: &Path) -> Result<(), String> {
    let out = std::process::Command::new(program).arg("--version").output().map_err(|e| format!("{} doesn't run here: {e}", program.display()))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{} doesn't run here: it said {}", program.display(), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Fetches what the browser lacks and says what it did: the browser program, from `from` (the program itself, or its
/// package's tarball) when given, else from the release this node is, checked against the release's signature
/// (`update::browser_package`); then, when the node has no Chromium, Chrome for Testing, which the program downloads.
/// A program the node has already (beside it, named by `UNBROWSE_BROWSER`, or installed before) is kept unless `from`
/// names another. Blocking: a download takes a minute or more.
pub fn install(from: Option<&Path>) -> Result<Vec<String>, String> {
    let mut did = Vec::new();
    match from {
        Some(f) => {
            let to = if is_package(f) {
                put_package(&std::fs::read(f).map_err(|e| format!("{}: {e}", f.display()))?, "local")?
            } else {
                put_program(f, "local")?
            };
            did.push(format!("the browser program from {} is {}", f.display(), to.display()));
        }
        None => match crate::browse::binary() {
            Ok(p) => did.push(format!("the browser program is here already: {}", p.display())),
            Err(_) => {
                let to = put_package(&crate::update::browser_package()?, crate::update::RUNNING)?;
                did.push(format!("fetched release {}'s browser program: {}", crate::update::RUNNING, to.display()));
            }
        },
    }
    let program = crate::browse::binary()?;
    runs(&program)?;
    if from.is_some() && program != addon_program() {
        did.push(format!("the node drives {} first (UNBROWSE_BROWSER, or the one beside it)", program.display()));
    }
    match current() {
        Some(c) => did.push(format!("Chromium is here already: {c}")),
        None => {
            let out = std::process::Command::new(&program).arg("install").output().map_err(|e| format!("downloading Chrome for Testing: {e}"))?;
            match unbrowse_learn::mint::downloaded_chromium() {
                Some(c) if out.status.success() => did.push(format!("downloaded Chrome for Testing: {}", c.display())),
                _ => {
                    let said = String::from_utf8_lossy(&out.stderr).lines().rev().find(|l| !l.trim().is_empty()).map(String::from);
                    return Err(format!("downloading Chrome for Testing: {}", said.unwrap_or_else(|| "it ended without a browser".into())));
                }
            }
        }
    }
    apply();
    Ok(did)
}

/// Takes away the browser program the node installed, and with `chromium` the Chrome for Testing it downloaded too
/// (which other programs on this machine may share), and says what it did and what stays: a program that came with
/// the install, or that `UNBROWSE_BROWSER` names, is never the node's to remove, nor a browser installed here.
pub fn remove(chromium: bool) -> Result<Vec<String>, String> {
    let mut did = Vec::new();
    let dir = addon_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        did.push(format!("removed the browser program the node installed ({})", dir.display()));
    } else {
        did.push("the node installed no browser program".into());
    }
    if let Ok(p) = crate::browse::binary() {
        did.push(format!("{} stays: it came with this install, or UNBROWSE_BROWSER names it", p.display()));
    }
    if chromium {
        let cache = agent_browser_core::paths::get_browsers_dir();
        if unbrowse_learn::mint::downloaded_chromium().is_some() && cache.exists() {
            std::fs::remove_dir_all(&cache).map_err(|e| format!("{}: {e}", cache.display()))?;
            did.push(format!("removed Chrome for Testing ({})", cache.display()));
        } else {
            did.push("the node downloaded no Chrome for Testing".into());
        }
    }
    if let Some(c) = current() {
        did.push(format!("{c} stays: a Chromium installed on this machine"));
    }
    apply();
    Ok(did)
}

// ---- what needs the browser ----

/// What needs the browser.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
    /// A walk: the engine the node links launches a Chromium, with no program of its own.
    Walk,
    /// Browsing by hand: the browser program, driving a Chromium.
    Hands,
}

/// The parts `need` lacks now: `program`, `chromium`.
pub fn lacking(need: Need) -> Vec<&'static str> {
    let mut out = Vec::new();
    if need == Need::Hands && crate::browse::binary().is_err() {
        out.push("program");
    }
    if current().is_none() {
        out.push("chromium");
    }
    out
}

/// The browser as agents see it: `installing` while the node fetches it, else `present` when it can browse by hand
/// (and so walk), else `missing`.
pub fn state() -> &'static str {
    if DOWNLOAD.locked().running {
        "installing"
    } else if lacking(Need::Hands).is_empty() {
        "present"
    } else {
        "missing"
    }
}

/// Whether the node fetches the browser itself the first time something needs it: the owner's `fetch_browser`.
pub fn fetch_allowed() -> bool {
    store::load_settings().fetch_browser
}

/// How a call may use the browser: `unbrowse_do`'s `browser`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Use {
    /// As the node does by default: the browser when the goal needs it, fetched first when it isn't here and the owner
    /// lets the node fetch it.
    Auto,
    /// The browser only when it is here already: never fetched for this call.
    IfPresent,
    /// Never the browser: a route, another contributor's route or a plain request answers, or the call says what it
    /// would have needed.
    Never,
}

impl Use {
    pub fn parse(s: &str) -> Result<Use, String> {
        match s.trim() {
            "" | "auto" => Ok(Use::Auto),
            "if_present" => Ok(Use::IfPresent),
            "never" => Ok(Use::Never),
            other => Err(format!("browser is auto, if_present or never, not {other}")),
        }
    }
}

/// How the owner gets the browser, in every `browser_missing` answer.
pub const INSTALL: &str = "unbrowse browser install";

/// Why something that needed the browser didn't run: what it lacked and what to do about it. Agents get it as
/// `{"error", "code": "browser_missing", "browser", "missing", "install", "fetch"}` (`body`), with HTTP 422, the status a
/// browser that couldn't do it has always had, so a client from before the code still reads it as that.
#[derive(Clone, Debug, PartialEq)]
pub struct Missing {
    pub message: String,
    /// The parts it lacked (`program`, `chromium`); empty when the call said `browser: never` with the browser here.
    pub lacking: Vec<&'static str>,
    /// The browser's [`state`] when it was answered.
    pub state: &'static str,
}

/// The error code `Missing` goes by.
pub const CODE: &str = "browser_missing";

impl Missing {
    /// What `need` lacks now, said with what to do.
    pub fn now(need: Need) -> Missing {
        let lacking = lacking(need);
        let (running, error) = {
            let d = DOWNLOAD.locked();
            (d.running, d.error.clone())
        };
        let what = match (lacking.contains(&"program"), lacking.contains(&"chromium")) {
            (true, true) => "the node's browser isn't installed (neither its browser program nor a Chromium)",
            (true, false) => "the node's browser program isn't installed",
            _ => "the node has no Chromium browser to walk the page in",
        };
        let how = if fetch_allowed() {
            format!("run `{INSTALL}` on the node's machine, or set UNBROWSE_BROWSER to the browser program")
        } else {
            format!("run `{INSTALL}` on the node's machine (or set UNBROWSE_BROWSER to the browser program), or let the node fetch it when it needs it: `unbrowse browser fetch on`")
        };
        let message = match (running, error) {
            (true, _) => format!("this needs the node's browser, which it is fetching now: try again in a minute ({what})"),
            (false, Some(e)) => format!("this needs the node's browser: {what}, and fetching it failed ({e}). To get it, {how}"),
            (false, None) => format!("this needs the node's browser: {what}. To get it, {how}"),
        };
        Missing { message, lacking, state: if running { "installing" } else { state() } }
    }

    /// The call said `browser: never`, and the goal needs the browser. The refusal ends with how to let this one call
    /// use it (UNB-148: agents told only "let the call use the browser" sent it again unchanged, or gave up).
    fn declined(need: Need) -> Missing {
        Missing {
            message: "this needs the node's browser, and the call said browser: never. Call a route that does it (unbrowse_search), or let this one call use the browser: send it again with browser: \"auto\" (or leave browser out)".into(),
            lacking: lacking(need),
            state: state(),
        }
    }

    /// The answer an agent gets.
    pub fn body(&self) -> Value {
        serde_json::json!({ "error": self.message, "code": CODE, "browser": self.state, "missing": self.lacking, "install": INSTALL, "fetch": fetch_allowed() })
    }
}

/// What a call that needs the browser does, given how it may use it, what the browser lacks and whether the owner lets
/// the node fetch it.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    Ready,
    Fetch,
    /// `browser_missing`: the browser lacks a part this call may not fetch.
    Missing,
    /// `browser_missing`: the call said `browser: never`.
    Declined,
}

fn step(how: Use, lacking: &[&str], fetch: bool) -> Step {
    match how {
        Use::Never => Step::Declined,
        _ if lacking.is_empty() => Step::Ready,
        Use::Auto if fetch => Step::Fetch,
        _ => Step::Missing,
    }
}

/// How long a call waits for the browser the node is fetching for it before answering `browser_missing` with
/// `installing`: inside the 330 s the SDKs wait for an answer.
const FETCH_WAIT: std::time::Duration = std::time::Duration::from_secs(240);

/// Makes the browser ready for `need`, as `how` allows: fetched first when it lacks a part, `how` is `Auto` and the
/// owner lets the node fetch it (`fetch_browser`). Blocking: run it off the async threads.
pub fn ensure(node: &Arc<crate::Node>, need: Need, how: Use) -> Result<(), Missing> {
    apply();
    match step(how, &lacking(need), fetch_allowed()) {
        Step::Ready => return Ok(()),
        Step::Declined => return Err(Missing::declined(need)),
        Step::Missing => return Err(Missing::now(need)),
        Step::Fetch => {}
    }
    {
        download(node.clone());
        let since = std::time::Instant::now();
        while DOWNLOAD.locked().running && since.elapsed() < FETCH_WAIT {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        apply();
        if lacking(need).is_empty() {
            return Ok(());
        }
    }
    Err(Missing::now(need))
}

/// The default profile directory (Chromium's `--user-data-dir`) of the browser at `exe`: where it keeps `Local State`
/// and `Default/Cookies`, the standard place for the browser's family on this OS. `None` when the family isn't one
/// whose place the node knows, or the directory isn't there. Read from the program's path, never a list of brands:
/// the path names the vendor, and the vendor names the folder.
pub fn profile_dir(exe: &str) -> Option<PathBuf> {
    let lower = exe.to_ascii_lowercase();
    let has = |name: &str| lower.contains(name);
    // The vendor's folder under the OS's base directory, as (macOS, Linux, Windows). Brave, Edge, Vivaldi and
    // Chromium name themselves in the path; Chrome is the rest, and Chrome for Testing shares its folder.
    let (mac, linux, win): (&str, &str, &str) = if has("brave") {
        ("BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser/User Data")
    } else if has("edge") || has("msedge") {
        ("Microsoft Edge", "microsoft-edge", "Microsoft/Edge/User Data")
    } else if has("vivaldi") {
        ("Vivaldi", "vivaldi", "Vivaldi/User Data")
    } else if has("chromium") {
        ("Chromium", "chromium", "Chromium/User Data")
    } else if has("chrome") || has("google") {
        ("Google/Chrome", "google-chrome", "Google/Chrome/User Data")
    } else {
        return None;
    };
    let dir = base_dir()?.join(if cfg!(target_os = "macos") {
        mac
    } else if cfg!(target_os = "windows") {
        win
    } else {
        linux
    });
    dir.is_dir().then_some(dir)
}

/// Where a browser family's folder sits: the Mac's Application Support, Windows' LocalAppData, else the XDG config
/// home.
fn base_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(unbrowse_files::private::user_home().join("Library/Application Support"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()).or_else(|| Some(unbrowse_files::private::user_home().join(".config")))
    }
}

/// Why browsing can't start, when the node has no Chromium.
pub fn missing() -> String {
    Missing::now(Need::Walk).message
}

#[cfg(test)]
mod addon_tests {
    use super::*;

    /// A call that needs the browser uses it when it's here, fetches it only when it may (auto, with the owner's
    /// leave), answers `browser_missing` otherwise, and never touches it when it said never.
    #[test]
    fn a_call_uses_fetches_or_refuses_the_browser_as_it_may() {
        let none: &[&str] = &[];
        let lacks: &[&str] = &["program", "chromium"];
        assert_eq!(step(Use::Auto, none, true), Step::Ready);
        assert_eq!(step(Use::IfPresent, none, false), Step::Ready);
        assert_eq!(step(Use::Auto, lacks, true), Step::Fetch);
        assert_eq!(step(Use::Auto, lacks, false), Step::Missing, "the owner turned fetching off");
        assert_eq!(step(Use::IfPresent, lacks, true), Step::Missing, "if_present never fetches");
        assert_eq!(step(Use::Never, none, true), Step::Declined, "never, even with the browser here");
        assert_eq!(step(Use::Never, lacks, true), Step::Declined);
        assert_eq!(Use::parse("").unwrap(), Use::Auto);
        assert_eq!(Use::parse("if_present").unwrap(), Use::IfPresent);
        assert_eq!(Use::parse("never").unwrap(), Use::Never);
        assert!(Use::parse("sometimes").unwrap_err().contains("auto, if_present or never"));
    }

    /// The answer an agent gets says what's missing and how to get it, under its own code.
    #[test]
    fn browser_missing_says_what_and_how() {
        let m = Missing { message: "no browser".into(), lacking: vec!["program", "chromium"], state: "missing" };
        let b = m.body();
        assert_eq!(b["code"], CODE);
        assert_eq!(b["browser"], "missing");
        assert_eq!(b["missing"], serde_json::json!(["program", "chromium"]));
        assert_eq!(b["install"], "unbrowse browser install");
        assert!(b["fetch"].is_boolean());
    }

    /// UNB-148: a call that said browser: never and needed it is told the one setting that lets that call use it,
    /// and that setting parses as the browser allowed.
    #[test]
    fn a_call_that_said_never_is_told_how_to_allow_the_browser_for_it() {
        let m = Missing::declined(Need::Walk);
        assert!(m.message.ends_with("send it again with browser: \"auto\" (or leave browser out)"), "{}", m.message);
        assert_eq!(Use::parse("auto").unwrap(), Use::Auto);
        assert_eq!(Use::parse("").unwrap(), Use::Auto);
    }

    /// The program the node installed is kept under its own home, whole or not at all, with the release it came from,
    /// from the program itself or its package; the node drives it, and removing it takes only what the node put there.
    #[test]
    fn the_installed_program_is_the_one_the_node_drives_until_removed() {
        let home = store::scratch_home("browser-addon");
        let src = home.join("from").join(program_file());
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, b"a browser program").unwrap();
        let to = put_program(&src, "local").unwrap();
        assert_eq!(to, addon_program());
        assert!(to.starts_with(&home));
        assert_eq!(std::fs::read(&to).unwrap(), b"a browser program");
        assert_eq!(addon_version().as_deref(), Some("local"));
        assert!(std::fs::read_dir(addon_dir()).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains(".partial")), "nothing half-written left");
        if std::env::var_os("UNBROWSE_BROWSER").is_none() && !std::env::current_exe().unwrap().with_file_name(program_file()).exists() {
            assert_eq!(crate::browse::binary().unwrap(), to, "the node drives the program it installed");
        }

        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        let body: &[u8] = b"the release's browser";
        let mut h = tar::Header::new_gnu();
        h.set_size(body.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        b.append_data(&mut h, format!("package/bin/{}", program_file()), body).unwrap();
        let tgz = b.into_inner().unwrap().finish().unwrap();
        put_package(&tgz, "13.7.0").unwrap();
        assert_eq!(std::fs::read(addon_program()).unwrap(), body);
        assert_eq!(addon_version().as_deref(), Some("13.7.0"));
        let empty = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast())).into_inner().unwrap().finish().unwrap();
        assert!(put_package(&empty, "13.8.0").unwrap_err().contains("holds no"));
        assert_eq!(addon_version().as_deref(), Some("13.7.0"), "a package without the program changes nothing");

        let said = remove(false).unwrap();
        assert!(said[0].starts_with("removed the browser program"), "{said:?}");
        assert!(!addon_dir().exists());
        assert!(src.exists(), "the program it was given stays");
        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test is given no browser unless it names one: whatever is installed on the machine it runs on, a call's heal,
    /// a walled step, a sign-in or the agent's hands find none to launch.
    #[test]
    fn a_test_is_given_no_browser_unless_it_names_one() {
        assert_eq!(current(), None);
        for_this_test(Some("/named/by/the/test/chrome".into()));
        assert_eq!(current().as_deref(), Some("/named/by/the/test/chrome"));
        for_this_test(None);
        assert_eq!(current(), None);
        // Another thread of the same test run is given none either.
        for_this_test(Some("/named/by/the/test/chrome".into()));
        assert_eq!(std::thread::spawn(current).join().unwrap(), None);
    }

    /// The variable wins in both directions, and a word it doesn't know leaves the setting to decide.
    #[test]
    fn what_the_environment_says_of_windows_wins_over_the_setting() {
        assert_eq!(headless_said(Some("1")), Some(true));
        assert_eq!(headless_said(Some(" ON ")), Some(true));
        assert_eq!(headless_said(Some("0")), Some(false));
        assert_eq!(headless_said(Some("off")), Some(false));
        assert_eq!(headless_said(Some("maybe")), None);
        assert_eq!(headless_said(None), None);
    }

    #[cfg(target_os = "macos")]
    fn app(dir: &Path, name: &str, schemes: &[&str], helper: Option<&str>) -> PathBuf {
        let bundle = dir.join(format!("{name}.app"));
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(bundle.join("Contents/MacOS").join(name), "").unwrap();
        let schemes: String = schemes.iter().map(|s| format!("<string>{s}</string>")).collect();
        std::fs::write(
            bundle.join("Contents/Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>{name}</string>
<key>CFBundleName</key><string>{name}</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array>{schemes}</array></dict></array>
</dict></plist>"#
            ),
        )
        .unwrap();
        if let Some(h) = helper {
            std::fs::create_dir_all(bundle.join("Contents/Frameworks").join(h)).unwrap();
        }
        bundle
    }

    /// A Chromium browser is told by what the app is, not what it's called: it opens web links and carries
    /// Chromium's renderer. One that only opens links (no DevTools engine) or only carries the renderer (an app
    /// built on Chromium that isn't a browser) is not one.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_browser_the_node_can_drive_opens_links_and_carries_chromium() {
        let dir = std::env::temp_dir().join(format!("unbrowse-browsers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let nested = "Some Framework.framework/Versions/1.0/Helpers/Some Helper (Renderer).app";
        let browser = app(&dir, "Browser", &["http", "https", "file"], Some(nested));
        let beside = app(&dir, "Beside", &["HTTP", "HTTPS"], Some("Beside Helper (Renderer).app"));
        let links_only = app(&dir, "LinksOnly", &["http", "https"], Some("LinksOnly.framework/Resources"));
        let renderer_only = app(&dir, "Chat", &["chat"], Some("Chat Helper (Renderer).app"));
        let https_only = app(&dir, "Half", &["https"], Some("Half Helper (Renderer).app"));

        let found = chromium_app(&browser).expect("a Chromium browser");
        assert_eq!(found.name, "Browser");
        assert!(found.path.ends_with("Browser.app/Contents/MacOS/Browser"));
        assert!(chromium_app(&beside).is_some());
        assert!(chromium_app(&links_only).is_none());
        assert!(chromium_app(&renderer_only).is_none());
        assert!(chromium_app(&https_only).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// On Linux the same two things are read from a desktop entry and the program it runs: it handles the web's
    /// links, and its program (followed through links to where it lives) sits beside Chromium's resource pack.
    #[test]
    fn a_linux_browser_is_a_desktop_entry_for_web_links_beside_chromium() {
        let dir = std::env::temp_dir().join(format!("unbrowse-desktop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let chromium = dir.join("opt/browser");
        let other = dir.join("opt/other");
        for d in [&chromium, &other] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("run"), "").unwrap();
        }
        std::fs::write(chromium.join("resources.pak"), "").unwrap();
        std::fs::write(chromium.join("icudtl.dat"), "").unwrap();
        let entry = |exec: &Path, mime: &str| {
            format!("[Desktop Entry]\nName=Browser\nExec=\"{}\" %U\nMimeType={mime}\n\n[Desktop Action new-window]\nName=New Window\n", exec.display())
        };
        let web = "text/html;x-scheme-handler/http;x-scheme-handler/https;";
        let found = desktop_entry(&entry(&chromium.join("run"), web)).expect("a Chromium browser");
        assert_eq!(found.name, "Browser");
        assert!(Path::new(&found.path).ends_with("opt/browser/run"));
        assert!(desktop_entry(&entry(&other.join("run"), web)).is_none(), "opens links, carries no Chromium");
        assert!(desktop_entry(&entry(&chromium.join("run"), "x-scheme-handler/chat;")).is_none(), "carries Chromium, opens no links");
        assert!(desktop_entry(&entry(&chromium.join("run"), "x-scheme-handler/https;")).is_none(), "only half the web");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Windows keeps Chromium's pack in a version folder beside the program; `reg query`'s value is read from its
    /// line, whatever the key's name is.
    #[test]
    fn a_windows_browser_keeps_chromium_in_a_version_folder() {
        let dir = std::env::temp_dir().join(format!("unbrowse-win-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Application/131.0.1")).unwrap();
        assert!(!carries_chromium(&dir.join("Application")));
        std::fs::write(dir.join("Application/131.0.1/resources.pak"), "").unwrap();
        std::fs::write(dir.join("Application/131.0.1/icudtl.dat"), "").unwrap();
        assert!(carries_chromium(&dir.join("Application")));
        let _ = std::fs::remove_dir_all(&dir);
        let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Browser\r\n    (Default)    REG_SZ    Some Browser\r\n";
        assert_eq!(reg_value(out).as_deref(), Some("Some Browser"));
        assert_eq!(reg_value("ERROR: The system was unable to find the specified registry key or value."), None);
    }
}

#[cfg(test)]
mod profile_tests {

    /// A panic in a fetch is a failed fetch: the window says so, and it can be tried again.
    #[test]
    fn a_fetch_that_panics_is_a_fetch_that_failed() {
        let failed = crate::browsers::unpanicked(|| -> Result<(), String> { panic!("a package made no sense") });
        assert!(failed.unwrap_err().contains("try again"));
        assert_eq!(crate::browsers::unpanicked(|| Ok::<u32, String>(1)), Ok(1));
    }



    /// A node killed between the program moving and its version being written must not leave a release's name on another
    /// release's program: an update reads that name and skips the program it should fetch.
    #[test]
    fn no_version_stands_while_the_program_changes() {
        let dir = crate::store::scratch_home("addon-swap");
        let (part, to, version) = (dir.join("part"), dir.join("program"), dir.join("version"));
        std::fs::write(&part, b"new").unwrap();
        std::fs::write(&to, b"old").unwrap();
        std::fs::write(&version, "13.7.0\n").unwrap();
        crate::browsers::swap_program(&part, &to, &version, "13.8.0", |from, to| {
            assert!(!version.exists(), "nothing names a release while it changes");
            std::fs::rename(from, to)
        })
        .unwrap();
        assert_eq!(std::fs::read_to_string(&version).unwrap(), "13.8.0\n");
        assert_eq!(std::fs::read(&to).unwrap(), b"new");
        assert!(!version.with_extension("partial").exists());
        // A move that failed leaves the old program, of no named release: an update fetches it again, and that is safe.
        let failed = crate::browsers::swap_program(&dir.join("gone"), &to, &version, "13.9.0", |_, _| Err(std::io::Error::other("no room")));
        assert!(failed.is_err());
        assert!(!version.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The vendor in the program's path names its folder; a family the node doesn't know has none.
    #[test]
    fn the_programs_path_names_the_browsers_folder() {
        // The relative folder profile_dir would use, read back from a base it is given.
        fn family(exe: &str) -> Option<&'static str> {
            let lower = exe.to_ascii_lowercase();
            let has = |n: &str| lower.contains(n);
            Some(if has("brave") { "brave" } else if has("edge") || has("msedge") { "edge" } else if has("vivaldi") { "vivaldi" } else if has("chromium") { "chromium" } else if has("chrome") || has("google") { "chrome" } else { return None })
        }
        assert_eq!(family("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"), Some("brave"));
        assert_eq!(family("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"), Some("edge"));
        assert_eq!(family("/usr/bin/google-chrome"), Some("chrome"));
        assert_eq!(family("/Applications/Chromium.app/Contents/MacOS/Chromium"), Some("chromium"));
        assert_eq!(family("C:\\\\Program Files\\\\Vivaldi\\\\Application\\\\vivaldi.exe"), Some("vivaldi"));
        assert_eq!(family("/opt/weird/safari-like"), None);
    }
}
