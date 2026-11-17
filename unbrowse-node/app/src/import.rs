//! Importing a site's session: its cookies, kept as the node's session for that host (`jars/<host>.json`, which calls
//! send) and put in the node's browser profile for the site (`profiles/<host>`, which browsing opens), so the first
//! call and the first page are both already signed in, instead of walking the login page. One site at a time, on the
//! owner's word, or by the node itself when a page it walks sends it to the site's sign-in ([`when_signed_out`]),
//! from one of two sources:
//!
//! - **The owner's browsers on this machine** ([`session`]). The node copies each real browser's cookie store into a
//!   throwaway profile, opens it headless in that same browser, and asks the browser (over DevTools) for the cookies it
//!   holds. The browser decrypts them, as it does for the owner; the node never reads the cookie store itself. Every
//!   browser the node can drive is tried, not only the one it browses with, so the owner's session is found whichever
//!   browser they signed in with.
//! - **A cookie file the owner exported** ([`session_from`]), for a node with no browser signed in (a server, say): a
//!   cookie extension's JSON export, a Netscape `cookies.txt`, a Playwright or Puppeteer storage state, DevTools'
//!   cookies, or a bare `Cookie:` header.
//!
//! Either way only the cookies the browser would send to the named host are kept: a cookie for another site in the
//! same store or file is dropped before anything is written. This is not a sweep of every cookie from every browser.
//! No cookie value is printed, logged or returned: callers get counts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use agent_browser_core::cdp::client::CdpClient;
use serde::Serialize;
use serde_json::{json, Value};
use unbrowse_learn::identity::site_of;

use crate::store::{self, Activity};
use crate::{browse, browsers};

/// The files a Chromium profile keeps its cookies and their key in, under the user-data-dir. Copying these alone (not
/// the whole profile, which holds history, the cache and everything else) is enough for the browser to read the
/// cookies from the copy.
const COOKIE_FILES: &[&str] = &["Local State", "Default/Cookies", "Default/Network/Cookies"];

/// One cookie, with what a browser needs to send it only where it was set for.
#[derive(Clone, Debug, PartialEq)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    /// The domain it was set for, without a leading dot.
    pub domain: String,
    /// Sent to `domain` alone, not to names under it.
    pub host_only: bool,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    /// When it expires, in seconds since the epoch; `None` for a session cookie.
    pub expires: Option<f64>,
    /// `Strict`, `Lax` or `None`, when the source said.
    pub same_site: Option<String>,
}

impl Cookie {
    /// Whether a browser sends this cookie to `host`: the host is its domain, or (unless it is host-only) a name
    /// under it. The same rule the browser and the learner hold (`agent_browser_core::session::sent_to`).
    fn sent_to(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        if self.host_only {
            return !self.domain.is_empty() && host == self.domain;
        }
        sent_to(&self.domain, &host)
    }

    /// The cookie as DevTools sets it (`Network.CookieParam`). A host-only cookie is set through a URL on its host,
    /// so the browser keeps it host-only; a domain cookie names its domain.
    fn to_cdp(&self) -> Value {
        let mut c = json!({ "name": self.name, "value": self.value, "path": self.path, "secure": self.secure, "httpOnly": self.http_only });
        if self.host_only {
            c["url"] = json!(format!("https://{}{}", self.domain, self.path));
        } else {
            c["domain"] = json!(format!(".{}", self.domain));
        }
        if let Some(e) = self.expires {
            c["expires"] = json!(e);
        }
        // A browser refuses SameSite=None on a cookie that isn't Secure; left out, it takes its default.
        if let Some(s) = self.same_site.as_deref().filter(|s| *s != "None" || self.secure) {
            c["sameSite"] = json!(s);
        }
        c
    }
}

/// What an import kept: counts, never a value.
#[derive(Debug, Serialize)]
pub struct Kept {
    /// The host the session is for.
    pub host: String,
    /// The cookies kept as the host's session.
    pub cookies: usize,
    /// The node's browser profiles for the site that took them.
    pub profiles: usize,
    /// Why the browser's profile didn't take them, when it didn't: calls still have the session.
    pub profile_error: Option<String>,
}

/// Imports the owner's browser session for `host`: the cookies any browser on this machine would send to it. Every
/// real browser the node can drive is read, not only the one it browses with, so the session is found whichever
/// browser the owner signed in with. Each browser's cookies are read by that same browser (it holds the key that
/// decrypts them), from a throwaway copy of its cookie store; another site's cookies are dropped before anything is
/// kept, as ever.
pub fn session(host: &str) -> Result<Kept, String> {
    let host = host_arg(host)?;
    let sources = cookie_sources();
    if sources.is_empty() {
        return Err(format!(
            "no ordinary browser here to read a session from (the node's own downloaded browser holds no sign-in). Sign in to {host} in a normally installed Chrome, Chromium, Brave, Edge or Vivaldi, or export the cookies and import the file (`unbrowse-node session import {host} --from cookies.json`)"
        ));
    }

    let import = store::home().join("import");
    leave_no_copies(&import, std::process::id());

    let mut held = Vec::new();
    let mut had_store: Vec<String> = Vec::new();
    let mut unread: Vec<String> = Vec::new();
    for (name, exe, profile) in &sources {
        let work = import.join(format!("{}-{}-{}", session_name(&host), session_name(name), std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        match copy_cookie_store(profile, &work.join("profile")) {
            Ok(true) => {
                had_store.push(name.clone());
                match read_cookies(exe, &work) {
                    Ok(cookies) => held.extend(cookies),
                    Err(e) => unread.push(format!("{name}: {e}")),
                }
            }
            Ok(false) => {}
            Err(e) => unread.push(format!("{name}: {e}")),
        }
        let _ = std::fs::remove_dir_all(&work);
    }

    if had_store.is_empty() {
        let tried = sources.iter().map(|(n, _, _)| n.as_str()).collect::<Vec<_>>().join(", ");
        return Err(format!("no browser here has cookies yet (looked in {tried}): open {host} in your browser and sign in, then try again"));
    }
    let mine = for_host(&host, held, store::now() as f64);
    if mine.is_empty() {
        let read = had_store.join(", ");
        let mut msg = format!(
            "no cookies for {host} in your browsers ({read}). Sign in to {host} in one of them first; if you already are, that browser may lock its cookies to itself (app-bound encryption): export them to a file and import that (`unbrowse-node session import {host} --from cookies.json`), or sign in through Unbrowse once instead"
        );
        if !unread.is_empty() {
            msg.push_str(&format!(". Couldn't read: {}", unread.join("; ")));
        }
        return Err(msg);
    }
    keep(&host, mine, &had_store.join(", "))
}

/// The owner's browsers on this machine the node can read a cookie store from: every real browser it can drive, not
/// the Chrome for Testing it downloaded (which holds no one's session), one entry per cookie-store directory so a
/// family that shows up under two names is read once. Each is (name, program, the directory it keeps its cookies in).
fn cookie_sources() -> Vec<(String, String, PathBuf)> {
    dedupe_sources(browsers::found(), browsers::profile_dir)
}

/// Drops the node's own downloaded browser and any second name for a cookie store already taken, keeping the browsers
/// to read a session from. The profile lookup is passed in so this is tested without the machine's real browsers.
fn dedupe_sources(found: Vec<browsers::Found>, profile_dir: impl Fn(&str) -> Option<PathBuf>) -> Vec<(String, String, PathBuf)> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for f in found {
        if f.downloaded {
            continue;
        }
        let Some(dir) = profile_dir(&f.path) else { continue };
        if seen.insert(dir.clone()) {
            out.push((f.name, f.path, dir));
        }
    }
    out
}

/// How long after the node last reached for the owner's browser session for a site it waits to reach for it again by
/// itself: the owner may sign in there meanwhile, but a browser that holds no session for the site isn't opened
/// headless on every page of it.
const SIGNED_OUT_AGAIN: Duration = Duration::from_secs(10 * 60);

/// The owner's browser session for `host`, imported by the node itself because a page of the site sent the node to its
/// sign-in: the owner is signed in there in their own browser, so the node is too, with no window to click. At most
/// once per site in [`SIGNED_OUT_AGAIN`] (`None` when it was reached for within that), whatever the import answered,
/// so a site the owner isn't signed in to costs one headless open of their browser, not one per page.
pub fn when_signed_out(host: &str) -> Option<Result<Kept, String>> {
    static TRIED: std::sync::Mutex<BTreeMap<String, std::time::Instant>> = std::sync::Mutex::new(BTreeMap::new());
    let mut tried = TRIED.lock().unwrap_or_else(|p| p.into_inner());
    reach_again(&mut tried, &site_of(host), std::time::Instant::now()).then(|| session(host))
}

/// Whether the node reaches for `site`'s session now, `tried` holding when it last did for each site: not within
/// [`SIGNED_OUT_AGAIN`] of the last time. A yes is noted as the last time.
fn reach_again(tried: &mut BTreeMap<String, std::time::Instant>, site: &str, now: std::time::Instant) -> bool {
    if tried.get(site).is_some_and(|at| now.saturating_duration_since(*at) < SIGNED_OUT_AGAIN) {
        return false;
    }
    tried.insert(site.to_string(), now);
    true
}

/// Takes away the copies of a cookie store an import that was killed left behind: each is named for the process that made
/// it, and holds the owner's whole cookie database. Only this process's own may still be in use, as far as one node goes.
fn leave_no_copies(import: &Path, pid: u32) {
    let Ok(dirs) = std::fs::read_dir(import) else { return };
    for dir in dirs.flatten() {
        if !dir.file_name().to_string_lossy().ends_with(&format!("-{pid}")) {
            let _ = std::fs::remove_dir_all(dir.path());
        }
    }
}

/// Imports `host`'s session from a cookie file the owner exported: only the cookies a browser would send to `host`
/// are read out of it.
pub fn session_from(host: &str, text: &str) -> Result<Kept, String> {
    let host = host_arg(host)?;
    let mine = for_host(&host, read_cookie_file(text, &host)?, store::now() as f64);
    if mine.is_empty() {
        return Err(format!("the file holds no live cookie for {host}: export the cookies while signed in there, and name the host the site's pages are on"));
    }
    keep(&host, mine, "a cookie file")
}

/// Keeps `host`'s cookies as its session for calls, and puts them in the node's browser profile for the site.
fn keep(host: &str, mine: Vec<Cookie>, from: &str) -> Result<Kept, String> {
    let before: std::collections::HashMap<String, String> = store::read_json::<BTreeMap<String, String>>(&store::jar_path(host), &unbrowse_files::JAR).into_iter().collect();
    let lines = lines_of(&mine);
    let jar: BTreeMap<String, String> = lines.iter().map(|(k, l)| (k.clone(), l.value.clone())).collect();
    store::write_json(&store::jar_path(host), &unbrowse_files::JAR, &jar)?;
    // The export says how far each cookie went (its domain, and whether it was the host's own): the reach of the
    // cookies the jar kept is rewritten beside the jar, whole, as the jar is, so calls send them where the browser
    // this came from would — down the site for a domain cookie, its host alone for a host-only one, which then has
    // no reach to keep. An import that brings no reach says so rather than leaving the last one standing.
    // Each kept value with its own line's reach, path, HttpOnly and life (`lines_of`), never another cookie's.
    let scope: BTreeMap<&String, String> = lines.iter().filter_map(|(k, l)| l.domain.clone().map(|d| (k, d))).collect();
    store::write_json(&store::jar_scope_path(host), &unbrowse_files::JAR, &scope)?;
    let facts: std::collections::HashMap<String, unbrowse_learn::mint::CookieFacts> =
        lines.iter().map(|(k, l)| (k.clone(), unbrowse_learn::mint::CookieFacts { path: l.path.clone(), http_only: l.http_only, expires: l.expires })).collect();
    unbrowse_learn::client::note_cookie_facts(&store::jars_dir(), host, &facts, &before);
    let (profiles, profile_error) = match into_profiles(host, &mine) {
        Ok(n) => (n, None),
        Err(e) => (0, Some(e)),
    };
    // No browser of the node's took them, so no walk will see them: a walk's jar would otherwise drop them as gone.
    let only = if profiles == 0 { jar_only(&mine, &jar, store::now() as f64) } else { BTreeMap::new() };
    store::write_json(&store::jar_only_path(host), &unbrowse_files::JAR, &only)?;
    store::log_activity(&Activity {
        at: store::now(),
        who: "You".into(),
        site: host.to_string(),
        what: "Imported a site's session".into(),
        kind: "vault".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(format!("{} cookies from {from}", jar.len())),
    });
    Ok(Kept { host: host.to_string(), cookies: jar.len(), profiles, profile_error })
}

/// The cookies of an import the jar kept, as cookies only the jar holds: each lasts as long as it says, a session cookie
/// as long as a profile would keep it.
fn jar_only(mine: &[Cookie], jar: &BTreeMap<String, String>, now: f64) -> BTreeMap<String, store::JarOnly> {
    mine.iter()
        .filter(|c| jar.get(&c.name).is_some_and(|v| *v == c.value))
        .map(|c| (c.name.clone(), store::JarOnly { value: c.value.clone(), until: c.expires.unwrap_or(now + SESSION_KEPT) }))
        .collect()
}

/// The host an owner named, as a session is named for one: `https://www.shop.example/login` is `www.shop.example`.
fn host_arg(given: &str) -> Result<String, String> {
    let given = given.trim();
    let host = match url::Url::parse(given) {
        Ok(u) if u.host_str().is_some() => u.host_str().unwrap_or_default().to_string(),
        _ => given.to_string(),
    }
    .to_ascii_lowercase();
    if !is_host(&host) {
        return Err(format!("not a host: {given} (name the host the site's pages are on, like github.com)"));
    }
    Ok(host)
}

/// Copies a Chromium profile's cookie files into `into` as a user-data-dir of its own. Returns whether a cookie store
/// was there to copy.
fn copy_cookie_store(profile: &Path, into: &Path) -> Result<bool, String> {
    let mut any = false;
    for rel in COOKIE_FILES {
        let from = profile.join(rel);
        if !from.is_file() {
            continue;
        }
        let to = into.join(rel);
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::copy(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
        if rel.ends_with("Cookies") {
            any = true;
        }
    }
    Ok(any)
}

/// Opens the copied profile headless and reads the cookies the browser holds. The browser decrypts them; the node
/// runs it on `work`'s copy so this never touches the browser the owner is using or the node's own sessions. It asks the
/// browser itself (`Storage.getCookies`): the browser CLI's `cookies get` asks the page, which holds only what the page
/// it shows can send, and nothing is open here.
fn read_cookies(exe: &str, work: &Path) -> Result<Vec<Cookie>, String> {
    let options = reading(exe, work, unbrowse_learn::proxy::switches()?);
    let mut chrome = agent_browser_core::cdp::chrome::launch_chrome(&options).map_err(|e| format!("the node's browser didn't open: {e}"))?;
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    let read = rt.block_on(async {
        let cdp = CdpClient::connect(&chrome.ws_url).await.map_err(|e| format!("couldn't reach the node's browser: {e}"))?;
        let held = cdp.send_command("Storage.getCookies", None, None).await.map_err(|e| format!("the node's browser couldn't read the cookies: {e}"));
        let _ = cdp.send_command("Browser.close", None, None).await;
        held
    });
    chrome.wait_or_kill(Duration::from_secs(10));
    Ok(cookies_in(&read?, ""))
}

// ---- reading cookie files ----

/// How the owner's browser is opened on the copy of its cookie store. It loads no page, but it is a browser on the
/// owner's profile all the same: it runs inside the egress rule (`switches`) like every browser the node launches. It
/// keeps the system keychain: the owner's cookies are sealed under the key their browser keeps there (on macOS, its
/// "Safe Storage" item), and a browser given a stand-in keychain can't open them, so it drops every one and the
/// import finds no session where the owner is signed in.
fn reading(exe: &str, work: &Path, switches: Vec<String>) -> agent_browser_core::cdp::chrome::LaunchOptions {
    agent_browser_core::cdp::chrome::LaunchOptions {
        headless: true,
        executable_path: Some(exe.to_string()),
        profile: Some(work.join("profile").display().to_string()),
        args: switches,
        use_real_keychain: true,
        ..Default::default()
    }
}

/// The cookies in a file the owner exported. The format is read from the text: JSON (a list of cookies, or an object
/// holding one under `cookies`), a Netscape `cookies.txt`, or a `Cookie:` header. A header's cookies have no domain of
/// their own, so they are `host`'s alone.
pub fn read_cookie_file(text: &str, host: &str) -> Result<Vec<Cookie>, String> {
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.is_empty() {
        return Err("the cookie file is empty".into());
    }
    if text.starts_with('{') || text.starts_with('[') {
        let v: Value = serde_json::from_str(text).map_err(|_| "this cookie file's JSON doesn't read".to_string())?;
        return Ok(cookies_in(&v, host));
    }
    if text.lines().any(|l| l.split('\t').count() >= 6) || text.starts_with("# Netscape HTTP Cookie File") || text.starts_with("# HTTP Cookie File") {
        return Ok(netscape(text));
    }
    let header = text.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("cookie")).map(|(_, v)| v).unwrap_or(text);
    if header.contains('\n') || !header.contains('=') {
        return Err("this isn't a cookie file: give a cookie extension's JSON export, a cookies.txt, a Playwright storage state or a Cookie header".into());
    }
    Ok(header
        .split(';')
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| Cookie {
            name: k.trim().to_string(),
            value: v.trim().to_string(),
            domain: host.to_ascii_lowercase(),
            host_only: true,
            path: "/".into(),
            secure: true,
            http_only: false,
            expires: None,
            same_site: None,
        })
        .collect())
}

/// The cookies in a JSON value: a list, or an object holding one under `cookies` (or `data.cookies`, the node
/// browser's own answer). Each is read whoever wrote it: DevTools and Playwright say `expires` (-1 for a session
/// cookie) and mark a domain cookie with a leading dot; cookie extensions say `expirationDate`, `hostOnly` and
/// `no_restriction`. A cookie with no domain is `host`'s.
fn cookies_in(v: &Value, host: &str) -> Vec<Cookie> {
    let list = v.as_array().or_else(|| v.get("cookies").and_then(Value::as_array)).or_else(|| v.pointer("/data/cookies").and_then(Value::as_array));
    list.into_iter().flatten().filter_map(|c| cookie_of(c, host)).collect()
}

fn cookie_of(c: &Value, host: &str) -> Option<Cookie> {
    let name = c.get("name")?.as_str()?.trim().to_string();
    let value = c.get("value").and_then(Value::as_str).unwrap_or_default().to_string();
    let raw = c.get("domain").and_then(Value::as_str).unwrap_or(host).trim().to_ascii_lowercase();
    let domain = raw.trim_start_matches('.').to_string();
    let host_only = c.get("hostOnly").and_then(Value::as_bool).unwrap_or(!raw.starts_with('.'));
    let flag = |k: &[&str]| k.iter().find_map(|k| c.get(*k).and_then(Value::as_bool)).unwrap_or(false);
    let session = flag(&["session"]);
    let expires = ["expires", "expirationDate", "expiry"].iter().find_map(|k| c.get(*k).and_then(Value::as_f64)).filter(|e| *e > 0.0 && !session);
    let same_site = c.get("sameSite").and_then(Value::as_str).and_then(|s| match s.to_ascii_lowercase().as_str() {
        "strict" => Some("Strict"),
        "lax" => Some("Lax"),
        "none" | "no_restriction" => Some("None"),
        _ => None,
    });
    Some(Cookie {
        name,
        value,
        domain,
        host_only,
        path: c.get("path").and_then(Value::as_str).filter(|p| p.starts_with('/')).unwrap_or("/").to_string(),
        secure: flag(&["secure"]),
        http_only: flag(&["httpOnly", "httponly", "http_only"]),
        expires,
        same_site: same_site.map(String::from),
    })
}

/// The cookies in a Netscape `cookies.txt` (curl, wget, yt-dlp and cookie extensions write it): one per line, seven
/// tab-separated fields (domain, whether names under it get it too, path, secure, expiry, name, value). A line that
/// starts `#HttpOnly_` is an HttpOnly cookie; other `#` lines are comments.
fn netscape(text: &str) -> Vec<Cookie> {
    text.lines()
        .filter_map(|line| {
            let (line, http_only) = match line.strip_prefix("#HttpOnly_") {
                Some(rest) => (rest, true),
                None if line.starts_with('#') => return None,
                None => (line, false),
            };
            let f: Vec<&str> = line.trim_end_matches('\r').split('\t').collect();
            if f.len() < 6 {
                return None;
            }
            let yes = |s: &str| s.trim().eq_ignore_ascii_case("true");
            let expires = f[4].trim().parse::<f64>().ok().filter(|e| *e > 0.0);
            Some(Cookie {
                name: f[5].trim().to_string(),
                value: f.get(6).copied().unwrap_or_default().to_string(),
                domain: f[0].trim().trim_start_matches('.').to_ascii_lowercase(),
                host_only: !yes(f[1]),
                path: Some(f[2].trim()).filter(|p| p.starts_with('/')).unwrap_or("/").to_string(),
                secure: yes(f[3]),
                http_only,
                expires,
                same_site: None,
            })
        })
        .collect()
}

// ---- keeping them ----

/// The cookies in `all` a browser would send to `host` now: named, unexpired, and set for the host or a domain above
/// it. Another site's cookie is left out here, before anything is kept. The most specific come first (the host's own
/// over a parent domain's, a longer path over a shorter), as a browser orders them.
fn for_host(host: &str, all: Vec<Cookie>, now: f64) -> Vec<Cookie> {
    let mut mine: Vec<Cookie> = all.into_iter().filter(|c| !c.name.is_empty() && c.sent_to(host) && c.expires.is_none_or(|e| e > now)).collect();
    mine.sort_by_key(|c| std::cmp::Reverse((c.domain.len(), c.host_only, c.path.len())));
    mine
}

/// The session a call sends: a name→value jar, the most specific cookie of each name.
#[cfg(test)]
fn jar_of(mine: &[Cookie]) -> BTreeMap<String, String> {
    lines_of(mine).into_iter().map(|(k, l)| (k, l.value)).collect()
}

/// The one cookie per name the jar keeps of an export, the jar's way (`mint::keep_line`): of two of one name with
/// different reaches or paths, the narrower, its value with its own line's reach, path, HttpOnly and life.
fn lines_of(mine: &[Cookie]) -> BTreeMap<String, unbrowse_learn::mint::CookieLine> {
    let mut kept: BTreeMap<String, unbrowse_learn::mint::CookieLine> = BTreeMap::new();
    for c in mine {
        let line = unbrowse_learn::mint::CookieLine {
            value: c.value.clone(),
            domain: (!c.host_only && !c.domain.is_empty()).then(|| format!(".{}", c.domain.trim_start_matches('.').to_ascii_lowercase())),
            path: Some(c.path.clone()).filter(|p| p.starts_with('/')).unwrap_or_else(|| "/".into()),
            http_only: c.http_only,
            expires: c.expires,
        };
        let held = kept.remove(&c.name);
        kept.insert(c.name.clone(), unbrowse_learn::mint::keep_line(held, line));
    }
    kept
}

/// Whether a cookie set for `domain` is sent to `host`: the host is that domain, or a name under it.
fn sent_to(domain: &str, host: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

/// The node's browser profiles a session for `host` goes into: the host's own (`profiles/<host>`, made if it isn't
/// there yet, the one browsing the host opens), and any other the node already keeps for a host on the same site.
fn profiles_for(root: &Path, host: &str) -> Vec<PathBuf> {
    let site = site_of(host);
    let mut out = vec![root.join(host)];
    if let Ok(dir) = std::fs::read_dir(root) {
        let mut others: Vec<PathBuf> = dir
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|h| h != host && is_host(h) && site_of(h) == site)
            .map(|h| root.join(h))
            .filter(|p| p.is_dir())
            .collect();
        others.sort();
        out.extend(others);
    }
    out
}

/// How long a session cookie (one with no expiry) is kept in the node's browser profile. A browser drops session
/// cookies when it closes, and the node's browser closes between uses, so one kept as a session cookie would be gone
/// by the next browse; the jar keeps it until the site replaces it, and the profile keeps it this long.
const SESSION_KEPT: f64 = 30.0 * 24.0 * 3600.0;

/// Puts the cookies in the node's browser profiles for `host`'s site. A profile the site's browser has open takes
/// them through that browser (a profile is open in one browser at a time); any other is opened headless, given them,
/// and closed, so the browser writes them into the profile. Says how many profiles took them.
fn into_profiles(host: &str, mine: &[Cookie]) -> Result<usize, String> {
    let until = store::now() as f64 + SESSION_KEPT;
    let cookies: Vec<Value> = mine.iter().map(|c| Cookie { expires: c.expires.or(Some(until)), ..c.clone() }.to_cdp()).collect();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    let site = site_of(host);
    let open = browse::profile_in_use(&site);
    let ws = open.as_ref().and_then(|_| browse::cdp_of(&site));
    let exe = browsers::current().ok_or_else(browsers::missing)?;
    each_profile(open.as_deref(), ws.is_some(), profiles_for(&store::profiles_dir(), host), |profile| match profile {
        None => rt.block_on(set_cookies(ws.as_deref().unwrap_or_default(), &cookies)),
        Some(p) => into_closed_profile(&rt, &exe, p, &cookies),
    })
}

/// Puts the session into each profile (`put`: `None` for the one a running browser has open, through that browser): one
/// that won't take it doesn't cost the others. A profile open in a browser the node can't reach is said, not skipped:
/// the session isn't in it. How many took it, or what went wrong with all of them when none did.
fn each_profile(open: Option<&Path>, reachable: bool, profiles: Vec<PathBuf>, mut put: impl FnMut(Option<&Path>) -> Result<(), String>) -> Result<usize, String> {
    let (mut done, mut failed) = (0, Vec::new());
    let mut tally = |r: Result<(), String>| match r {
        Ok(()) => done += 1,
        Err(e) => failed.push(e),
    };
    match (open, reachable) {
        (Some(_), true) => tally(put(None)),
        (Some(p), false) => tally(Err(format!("{} is open in a browser the node can't reach", p.display()))),
        (None, _) => {}
    }
    for profile in profiles.iter().filter(|p| open != Some(p.as_path())) {
        tally(put(Some(profile)));
    }
    if done == 0 && !failed.is_empty() {
        return Err(failed.join("; "));
    }
    for e in &failed {
        eprintln!("import: a profile didn't take the session: {e}");
    }
    Ok(done)
}

/// Opens `profile` headless in the browser at `exe`, as the node's browser opens it, sets the cookies, and closes the
/// browser cleanly so it writes them to disk.
fn into_closed_profile(rt: &tokio::runtime::Runtime, exe: &str, profile: &Path, cookies: &[Value]) -> Result<(), String> {
    std::fs::create_dir_all(profile).map_err(|e| format!("{}: {e}", profile.display()))?;
    let options = agent_browser_core::cdp::chrome::LaunchOptions {
        headless: true,
        executable_path: Some(exe.to_string()),
        profile: Some(profile.display().to_string()),
        // Inside the egress rule like every browser the node launches, or not at all.
        args: unbrowse_learn::proxy::switches()?,
        ..Default::default()
    };
    let mut chrome = agent_browser_core::cdp::chrome::launch_chrome(&options)
        .map_err(|e| format!("the node's browser didn't open the site's profile (is the site's browser open elsewhere?): {e}"))?;
    let set = rt.block_on(async {
        set_cookies(&chrome.ws_url, cookies).await?;
        let cdp = CdpClient::connect(&chrome.ws_url).await.map_err(|e| e.to_string())?;
        let _ = cdp.send_command("Browser.close", None, None).await;
        Ok::<(), String>(())
    });
    chrome.wait_or_kill(Duration::from_secs(10));
    set
}

/// Sets `cookies` in the browser at `ws`, all at once; when the browser refuses the batch, one by one, so one cookie
/// it won't take doesn't cost the rest.
async fn set_cookies(ws: &str, cookies: &[Value]) -> Result<(), String> {
    let cdp = CdpClient::connect(ws).await.map_err(|e| format!("couldn't reach the node's browser: {e}"))?;
    if cdp.send_command("Storage.setCookies", Some(json!({ "cookies": cookies })), None).await.is_err() {
        let mut took = 0;
        for c in cookies {
            if cdp.send_command("Storage.setCookies", Some(json!({ "cookies": [c] })), None).await.is_ok() {
                took += 1;
            }
        }
        if took == 0 {
            cdp.close().await;
            return Err("the node's browser took none of the cookies".into());
        }
    }
    cdp.close().await;
    Ok(())
}

/// A host, as a session jar is named for one: letters, digits, dots and dashes, no path parts. The same rule the
/// rest of the node holds sessions by.
fn is_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('.')
        && !host.starts_with('-')
        && host.contains('.')
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// A short, path-safe name for the work directory.
fn session_name(host: &str) -> String {
    host.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

#[cfg(test)]
mod tests {

    /// One profile that won't take a session doesn't cost the rest, and one the node couldn't reach is said: the import
    /// used to stop at the first error and pass over an open profile without a word.
    #[test]
    fn a_profile_that_wont_take_the_session_doesnt_cost_the_others() {
        let (a, b, c) = (PathBuf::from("/p/a"), PathBuf::from("/p/b"), PathBuf::from("/p/c"));
        let took = each_profile(None, false, vec![a.clone(), b.clone(), c.clone()], |p| if p == Some(b.as_path()) { Err("locked".into()) } else { Ok(()) });
        assert_eq!(took, Ok(2));
        let took = each_profile(Some(&a), false, vec![a.clone()], |_| Ok(()));
        assert!(took.unwrap_err().contains("can't reach"), "and an open profile it can't reach isn't one that took it");
        let mut through_the_browser = 0;
        let took = each_profile(Some(&a), true, vec![a.clone(), b.clone()], |p| {
            through_the_browser += usize::from(p.is_none());
            Ok(())
        });
        assert_eq!((took, through_the_browser), (Ok(2), 1));
        assert!(each_profile(None, false, vec![a.clone()], |_| Err("locked".into())).unwrap_err().contains("locked"));
    }

    /// The owner's browser reads its own cookie store with its own keychain: given a stand-in one, it can't open the
    /// sealed cookies, drops them all, and an owner signed in to the site imports no session (seen with every site on
    /// macOS, where the import said "no cookies" for a site the browser held a live sign-in for).
    #[test]
    fn the_owners_browser_reads_its_cookies_with_its_own_keychain() {
        let options = reading("/Applications/Browser.app/Contents/MacOS/Browser", Path::new("/tmp/work"), Vec::new());
        assert!(options.use_real_keychain && options.headless);
        assert_eq!(options.profile.as_deref(), Some("/tmp/work/profile"));
    }

    /// A site the node found itself signed out of is reached for in the owner's browser once, not on every page of it:
    /// a browser holding no session for the site is opened headless once in ten minutes, and another site is its own.
    #[test]
    fn a_signed_out_site_is_reached_for_once_in_a_while() {
        let (mut tried, at) = (BTreeMap::new(), std::time::Instant::now());
        assert!(reach_again(&mut tried, "x.com", at));
        assert!(!reach_again(&mut tried, "x.com", at + Duration::from_secs(60)), "not again on the next page");
        assert!(reach_again(&mut tried, "github.com", at), "another site is its own");
        assert!(reach_again(&mut tried, "x.com", at + SIGNED_OUT_AGAIN), "and again once the wait is over");
    }

    /// A copy of the owner's whole cookie store left by a killed import goes at the next one.
    #[test]
    fn a_killed_imports_copy_of_the_cookie_store_goes_at_the_next_one() {
        let dir = std::env::temp_dir().join(format!("unbrowse-import-copies-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("shop-example-111")).unwrap();
        std::fs::create_dir_all(dir.join("shop-example-222")).unwrap();
        leave_no_copies(&dir, 222);
        assert!(!dir.join("shop-example-111").exists() && dir.join("shop-example-222").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The live half of FP-02: a profile the owner's browser wrote gives back what it holds with no page open. The CLI's
    /// `cookies get` asks a page, so this read nothing. Needs a browser: `cargo test -- --ignored a_browser_import_reads`.
    #[test]
    #[ignore = "needs a browser on this machine"]
    fn a_browser_import_reads_a_profile_with_no_page_open() {
        let work = std::env::temp_dir().join(format!("unbrowse-import-live-{}", std::process::id()));
        browsers::for_this_test(browsers::on_this_machine());
        let exe = browsers::current().expect("a browser on this machine");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let cookie = json!({ "name": "sid", "value": "abc", "domain": "shop.example", "path": "/", "secure": true, "expires": store::now() as f64 + 3600.0 });
        into_closed_profile(&rt, &exe, &work.join("profile"), &[cookie]).unwrap();
        let read = read_cookies(&exe, &work).unwrap();
        let _ = std::fs::remove_dir_all(&work);
        assert!(read.iter().any(|c| c.name == "sid" && c.value == "abc"), "{}", read.len());
    }

    use super::*;

    fn cookie(name: &str, domain: &str, host_only: bool, path: &str) -> Cookie {
        Cookie {
            name: name.into(),
            value: format!("{name}@{domain}{path}"),
            domain: domain.into(),
            host_only,
            path: path.into(),
            secure: true,
            http_only: false,
            expires: None,
            same_site: None,
        }
    }

    /// An import no browser took stands in the jar alone, each cookie for as long as it says, and one the jar didn't keep
    /// isn't marked at all.
    #[test]
    fn an_import_no_browser_took_is_marked_for_as_long_as_it_lasts() {
        let (short, session, dropped) = (Cookie { expires: Some(50.0), ..cookie("short", "shop.example", true, "/") }, cookie("session", "shop.example", true, "/"), cookie("other", "shop.example", true, "/"));
        let jar = BTreeMap::from([("short".to_string(), short.value.clone()), ("session".to_string(), session.value.clone()), ("other".to_string(), "a newer one".to_string())]);
        let only = jar_only(&[short, session, dropped], &jar, 1000.0);
        assert_eq!(only.len(), 2);
        assert_eq!(only["short"].until, 50.0);
        assert_eq!(only["session"].until, 1000.0 + SESSION_KEPT);
    }

    #[test]
    fn a_host_is_a_name_not_a_path() {
        assert!(is_host("github.com"));
        assert!(is_host("www.shop.co.uk"));
        assert!(!is_host("notahost"));
        assert!(!is_host("../jars"));
        assert!(!is_host("a/b.com"));
        assert!(!is_host(".leading.dot"));
        assert!(!is_host(""));
        assert_eq!(host_arg("https://WWW.Shop.example/login?x=1").unwrap(), "www.shop.example");
        assert!(host_arg("../../etc").is_err());
    }

    /// Only the host's cookies are kept: one for the host or a parent domain, never another site's, never one set
    /// host-only on another name, never an expired one. A name seen twice keeps the most specific.
    #[test]
    fn only_this_sites_live_cookies_are_kept() {
        let mut expired = cookie("old", "shop.com", false, "/");
        expired.expires = Some(10.0);
        let held = vec![
            cookie("sid", "shop.com", false, "/"),
            cookie("sid", "app.shop.com", true, "/"),
            cookie("pref", "shop.com", false, "/"),
            cookie("apex", "shop.com", true, "/"),
            cookie("other", "tracker.net", false, "/"),
            cookie("look", "app.shop.com.evil.example", false, "/"),
            cookie("", "shop.com", false, "/"),
            expired,
        ];
        let mine = for_host("app.shop.com", held, 1000.0);
        let jar = jar_of(&mine);
        assert_eq!(jar.get("sid").map(String::as_str), Some("sid@app.shop.com/"), "the host's own wins");
        assert_eq!(jar.get("pref").map(String::as_str), Some("pref@shop.com/"));
        assert!(!jar.contains_key("apex"), "a host-only cookie of the parent isn't sent to the subdomain");
        assert!(!jar.contains_key("other") && !jar.contains_key("look"), "another site's cookie is left out");
        assert!(!jar.contains_key("old"), "an expired cookie is left out");
        assert_eq!(jar.len(), 2);
        assert!(mine.iter().all(|c| c.sent_to("app.shop.com")), "nothing else reaches the browser profile either");
    }

    /// Import reads every real browser once: the node's own downloaded Chrome for Testing is left out (it holds no
    /// one's session), a browser whose cookie-store directory the node can't place is left out, and a family that
    /// shows up under two names is read once.
    #[test]
    fn import_reads_each_real_browser_once() {
        let found = vec![
            browsers::Found { name: "Chrome for Testing".into(), path: "/opt/cft/chrome".into(), downloaded: true },
            browsers::Found { name: "Chromium".into(), path: "/usr/bin/chromium".into(), downloaded: false },
            browsers::Found { name: "Chromium (snap)".into(), path: "/snap/bin/chromium".into(), downloaded: false },
            browsers::Found { name: "Brave".into(), path: "/usr/bin/brave-browser".into(), downloaded: false },
            browsers::Found { name: "Mystery".into(), path: "/opt/mystery/browser".into(), downloaded: false },
        ];
        let home = |exe: &str| {
            if exe.contains("chromium") {
                Some(PathBuf::from("/home/me/.config/chromium"))
            } else if exe.contains("brave") {
                Some(PathBuf::from("/home/me/.config/brave"))
            } else {
                None
            }
        };
        let got = dedupe_sources(found, home);
        let names: Vec<&str> = got.iter().map(|(n, _, _)| n.as_str()).collect();
        assert_eq!(names, ["Chromium", "Brave"], "downloaded, unplaceable and same-store browsers are left out");
    }

    /// An export holding two cookies of one name keeps one, the jar's way: the narrower, its value with its own line's
    /// reach, path, HttpOnly and life, never another cookie's.
    #[test]
    fn an_imported_value_travels_with_its_own_lines_reach() {
        let mut admin = cookie("pair", "app.shop.com", true, "/barbaz");
        admin.http_only = false;
        let mut wide = cookie("pair", "shop.com", false, "/foo");
        wide.http_only = true;
        for order in [vec![wide.clone(), admin.clone()], vec![admin.clone(), wide.clone()]] {
            let kept = &lines_of(&order)["pair"];
            assert_eq!((kept.value.as_str(), kept.domain.as_deref(), kept.path.as_str(), kept.http_only), ("pair@app.shop.com/barbaz", None, "/barbaz", true));
        }
    }

    /// The files owners export, each read into the same cookies: a cookie extension's JSON, Playwright's storage state,
    /// DevTools' list, a Netscape cookies.txt and a Cookie header.
    #[test]
    fn a_cookie_file_is_read_whoever_wrote_it() {
        let extension = r#"[{"domain":".shop.example","expirationDate":4102444800.5,"hostOnly":false,"httpOnly":true,"name":"sid","path":"/","sameSite":"no_restriction","secure":true,"session":false,"storeId":"0","value":"s1"},
            {"domain":"www.shop.example","hostOnly":true,"httpOnly":false,"name":"cart","path":"/","sameSite":"lax","secure":false,"session":true,"value":"c1"}]"#;
        let state = r#"{"cookies":[{"name":"sid","value":"s1","domain":".shop.example","path":"/","expires":4102444800.5,"httpOnly":true,"secure":true,"sameSite":"None"},
            {"name":"cart","value":"c1","domain":"www.shop.example","path":"/","expires":-1,"httpOnly":false,"secure":false,"sameSite":"Lax"}],"origins":[]}"#;
        let netscape = "# Netscape HTTP Cookie File\n#HttpOnly_.shop.example\tTRUE\t/\tTRUE\t4102444800\tsid\ts1\nwww.shop.example\tFALSE\t/\tFALSE\t0\tcart\tc1\n";
        for (what, text) in [("extension", extension), ("storage state", state), ("cookies.txt", netscape)] {
            let got = read_cookie_file(text, "www.shop.example").unwrap();
            assert_eq!(got.len(), 2, "{what}");
            let sid = got.iter().find(|c| c.name == "sid").unwrap();
            assert_eq!((sid.value.as_str(), sid.domain.as_str(), sid.host_only, sid.secure, sid.http_only), ("s1", "shop.example", false, true, true), "{what}");
            assert_eq!(sid.expires.map(|e| e as u64), Some(4102444800), "{what}");
            let cart = got.iter().find(|c| c.name == "cart").unwrap();
            assert_eq!((cart.domain.as_str(), cart.host_only, cart.expires), ("www.shop.example", true, None), "{what}");
        }
        let header = read_cookie_file("Cookie: sid=s1; cart=c=1", "www.shop.example").unwrap();
        assert_eq!(header.iter().map(|c| (c.name.as_str(), c.value.as_str(), c.host_only)).collect::<Vec<_>>(), [("sid", "s1", true), ("cart", "c=1", true)]);
        assert!(read_cookie_file("", "x.example").is_err());
        assert!(read_cookie_file("just some words\nand more", "x.example").is_err());
    }

    /// A host-only cookie goes to the browser through a URL on its host, so it stays host-only; a domain cookie names
    /// its domain. SameSite=None is left out of a cookie that isn't Secure, which a browser would refuse.
    #[test]
    fn a_cookie_goes_to_the_browser_as_it_was_set() {
        let mut c = cookie("cart", "www.shop.example", true, "/cart");
        c.secure = false;
        c.same_site = Some("None".into());
        let v = c.to_cdp();
        assert_eq!(v["url"], "https://www.shop.example/cart");
        assert!(v.get("domain").is_none() && v.get("sameSite").is_none() && v.get("expires").is_none());
        let mut d = cookie("sid", "shop.example", false, "/");
        d.expires = Some(4102444800.0);
        d.same_site = Some("Lax".into());
        let v = d.to_cdp();
        assert_eq!((v["domain"].as_str(), v["sameSite"].as_str(), v["expires"].as_f64()), (Some(".shop.example"), Some("Lax"), Some(4102444800.0)));
    }

    /// The session goes into the host's own profile and the node's other profiles on the same site, never another
    /// site's or a lookalike's.
    #[test]
    fn a_session_goes_into_this_sites_profiles_only() {
        let root = std::env::temp_dir().join(format!("unbrowse-import-profiles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for h in ["www.shop.example", "shop.example.evil.test", "other.example", "scratch"] {
            std::fs::create_dir_all(root.join(h)).unwrap();
        }
        let got = profiles_for(&root, "app.shop.example");
        assert_eq!(got, [root.join("app.shop.example"), root.join("www.shop.example")]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Copying takes the cookie files, not the rest of the profile, and only when a cookie store is there.
    #[test]
    fn copying_takes_the_cookie_files_only() {
        let dir = std::env::temp_dir().join(format!("unbrowse-import-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let profile = dir.join("profile");
        std::fs::create_dir_all(profile.join("Default")).unwrap();
        // An empty profile: nothing to copy.
        assert!(!copy_cookie_store(&profile, &dir.join("empty")).unwrap());
        std::fs::write(profile.join("Local State"), "{}").unwrap();
        std::fs::write(profile.join("Default/Cookies"), "sqlite").unwrap();
        std::fs::write(profile.join("Default/History"), "big history db").unwrap();
        let into = dir.join("copy");
        assert!(copy_cookie_store(&profile, &into).unwrap());
        assert!(into.join("Local State").is_file());
        assert!(into.join("Default/Cookies").is_file());
        assert!(!into.join("Default/History").exists(), "only the cookie files are copied, not history");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
